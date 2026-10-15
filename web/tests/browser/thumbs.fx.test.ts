// Layer thumbnails show the layer as rendered with its (enabled) effects: engine.drawThumbnail + the throttled effect-thumbnail queue.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../src/engine';
import type { Compositor } from '../../src/engine/compositor';
import type { Effect } from '../../src/engine/types';
import { effectsAvailable } from '../../src/engine/effects';
import { brushCtx, newEngine, perfEnabled, ptr } from './engineTestUtils';

const engines: Engine[] = [];
const mk = (w = 200, h = 150): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });

const fx = (type: string, o: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...o }) as unknown as Effect;
const cc = (e: Engine) => (e as unknown as { compositor: Compositor }).compositor;
const shadow = (o: Record<string, unknown> = {}) => fx('dropShadow', { dx: 40, dy: 40, blur: 0, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 1, ...o });
const overlay = (o: Record<string, unknown> = {}) => fx('colorOverlay', { color: { r: 0, g: 0, b: 255, a: 255 }, opacity: 1, ...o });

function rect(e: Engine, id: string, x: number, y: number, w: number, h: number, css = '#ff0000'): void {
  const l = e.doc.find(id) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
  l.surface.ctx.fillStyle = css;
  l.surface.ctx.fillRect(x, y, w, h);
  e.changed({ x, y, w, h });
}

const thumb = (e: Engine, id: string): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = 68;
  c.height = 48;
  e.drawThumbnail(id, c);
  return c;
};
/** Thumbnail pixel at document coordinates. */
function at(e: Engine, c: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const k = Math.min(c.width / e.width, c.height / e.height);
  const px = Math.round((c.width - e.width * k) / 2 + x * k);
  const py = Math.round((c.height - e.height * k) / 2 + y * k);
  const d = c.getContext('2d')!.getImageData(px, py, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
async function settled(e: Engine, id: string): Promise<HTMLCanvasElement> {
  thumb(e, id); // queues the render
  await (e as unknown as { thumbnailsSettled(): Promise<void> }).thumbnailsSettled();
  return thumb(e, id);
}

describe.skipIf(!effectsAvailable())('layer thumbnails with effects', () => {
  it('colour overlay recolours the thumbnail', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    expect(at(e, thumb(e, a), 40, 40)).toEqual([255, 0, 0, 255]);
    e.setEffects(a, [overlay()]);
    const t = await settled(e, a);
    const p = at(e, t, 40, 40);
    expect(p[2]).toBeGreaterThan(220);
    expect(p[0]).toBeLessThan(40);
  });

  it('drop shadow shows outside the layer content', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    expect(at(e, thumb(e, a), 90, 90)[3]).toBe(0);
    e.setEffects(a, [shadow()]);
    const t = await settled(e, a);
    const p = at(e, t, 90, 90); // inside the shifted copy, outside the content
    expect(p[3]).toBeGreaterThan(200);
    expect(p[0]).toBeLessThan(40);
    expect(at(e, t, 40, 40)).toEqual([255, 0, 0, 255]);
    expect(at(e, t, 150, 20)[3]).toBe(0);
  });

  it('a disabled effect is ignored; enabling it brings it back; param changes update', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    e.setEffects(a, [shadow({ enabled: false })]);
    const t0 = thumb(e, a);
    expect(at(e, t0, 90, 90)[3]).toBe(0);
    expect(cc(e).thumbFxSig(e.doc.find(a)!)).toBeNull();
    e.setEffects(a, [shadow()]);
    expect(at(e, await settled(e, a), 90, 90)[3]).toBeGreaterThan(200);
    e.setEffects(a, [shadow({ dx: 100, dy: 0 })]); // moves the shadow away from (90, 90)
    const t = await settled(e, a);
    expect(at(e, t, 90, 90)[3]).toBe(0);
    expect(at(e, t, 150, 40)[3]).toBeGreaterThan(200);
  });

  it('the mask is applied before the effects', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    e.setEffects(a, [overlay()]);
    e.addMask(a);
    const m = (e.doc.find(a) as unknown as { mask: { surface: { ctx: CanvasRenderingContext2D } } }).mask;
    m.surface.ctx.clearRect(0, 0, 50, 150); // hide the left part (masks are alpha)
    e.changed({ x: 0, y: 0, w: 200, h: 150 });
    const t = await settled(e, a);
    expect(at(e, t, 30, 40)[3]).toBe(0);
    expect(at(e, t, 70, 40)[2]).toBeGreaterThan(220);
  });

  it('undo reverts the thumbnail', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    e.setEffects(a, [shadow()]);
    expect(at(e, await settled(e, a), 90, 90)[3]).toBeGreaterThan(200);
    e.undo();
    const t = await settled(e, a);
    expect(at(e, t, 90, 90)[3]).toBe(0);
    e.redo();
    expect(at(e, await settled(e, a), 90, 90)[3]).toBeGreaterThan(200);
  });

  it('a TD image is what the thumbnail shows (no effect render)', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    e.setEffects(a, [fx('pixelSort', { direction: 'h', low: 0.2, high: 0.8, key: 'luma' })]);
    const rgba = new Uint8ClampedArray(e.width * e.height * 4);
    for (let y = 100; y < 140; y++) for (let x = 120; x < 180; x++) rgba.set([0, 255, 0, 255], (y * e.width + x) * 4); // green, elsewhere than the content
    e.setLayerPreview(a, rgba);
    const spy = vi.spyOn(cc(e), 'renderFxThumb');
    const t = thumb(e, a); // synchronous: a downscale of TD's image
    expect(at(e, t, 150, 120)).toEqual([0, 255, 0, 255]);
    expect(at(e, t, 40, 40)[3]).toBe(0);
    expect((e as unknown as { fxQueue: Map<string, unknown> }).fxQueue.size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('painting one layer recomputes only that layer\'s thumbnail, once, after the stroke', async () => {
    const e = mk();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = e.addPixelLayer();
      rect(e, id, 10 + i * 10, 10, 30, 30, '#00ff00');
      e.setEffects(id, [shadow({ dx: 10, dy: 10 }), overlay({ opacity: 0.3 })]);
      ids.push(id);
    }
    for (const id of ids) thumb(e, id);
    await (e as unknown as { thumbnailsSettled(): Promise<void> }).thumbnailsSettled();
    e.flush();
    const painted: string[] = [];
    const orig = cc(e).renderFxThumb.bind(cc(e));
    vi.spyOn(cc(e), 'renderFxThumb').mockImplementation((l, c) => { painted.push(l.id); return orig(l, c); });
    const target = ids[2];
    e.setActiveLayer(target);
    e.setTool('brush');
    e.setToolContext(brushCtx({ size: 12 }));
    e.pointerDown(ptr(100, 100));
    const t0 = performance.now();
    let x = 100;
    while (performance.now() - t0 < 1300) {
      x += 2;
      e.pointerMove(ptr(x % 190, 100 + (x % 40)));
      e.flush();
      for (const id of ids) thumb(e, id); // the panel redraws every thumbnail on each tick
      await new Promise((r) => setTimeout(r, 30));
    }
    e.pointerUp(ptr(x % 190, 100));
    e.flush();
    for (const id of ids) thumb(e, id);
    await (e as unknown as { thumbnailsSettled(): Promise<void> }).thumbnailsSettled();
    expect(painted.length).toBeGreaterThan(0);
    expect(new Set(painted)).toEqual(new Set([target]));
    expect(painted).toHaveLength(1); // none while the stroke runs, one when it ends
  });

  it('memory: the cache holds thumbnail-size canvases only and forgets deleted layers', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    e.setEffects(a, [overlay()]);
    await settled(e, a);
    const cache = (e as unknown as { fxThumbs: Map<string, { canvas: HTMLCanvasElement }> }).fxThumbs;
    expect(cache.get(a)!.canvas.width * cache.get(a)!.canvas.height).toBe(68 * 48);
  });
});

const d = perfEnabled && effectsAvailable() ? describe : describe.skip;
d('layer thumbnail perf (30 layers, 3840x2160, 2 effects each)', () => {
  it('first panel draw and per-tick cost while painting', async () => {
    const e = mk(3840, 2160);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = e.addPixelLayer(`l${i}`);
      rect(e, id, 200 + i * 80, 300 + (i % 5) * 200, 600, 500, `hsl(${i * 12} 80% 50%)`);
      e.setEffects(id, [shadow({ dx: 30, dy: 30, blur: 20 }), overlay({ opacity: 0.2 })]);
      ids.push(id);
    }
    e.flush();
    const nT = () => (e as unknown as { thumbStats: { fx: number; ms: number } }).thumbStats.fx;
    const settleAll = () => (e as unknown as { thumbnailsSettled(): Promise<void> }).thumbnailsSettled();
    const canvases = ids.map(() => Object.assign(document.createElement('canvas'), { width: 68, height: 48 }));
    let t = performance.now();
    ids.forEach((id, i) => e.drawThumbnail(id, canvases[i]));
    const firstSync = performance.now() - t;
    t = performance.now();
    await settleAll();
    const firstAll = performance.now() - t;
    console.log(`PERF thumbs first panel draw: sync ${firstSync.toFixed(1)} ms, all 30 effect thumbs ready after ${firstAll.toFixed(0)} ms (${nT()} renders)`);
    // painting one layer: the redraw of all 30 thumbnails per tick
    const target = ids[10];
    e.setActiveLayer(target);
    e.setTool('brush');
    e.setToolContext(brushCtx({ size: 40 }));
    e.pointerDown(ptr(500, 500));
    const idle: number[] = [];
    const before = nT();
    for (let tick = 0; tick < 12; tick++) {
      e.pointerMove(ptr(500 + tick * 30, 500 + tick * 10));
      e.flush();
      t = performance.now();
      ids.forEach((id, i) => e.drawThumbnail(id, canvases[i]));
      idle.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 250));
    }
    const during = nT() - before;
    e.pointerUp(ptr(900, 600));
    expect(during).toBe(0);
    const per = [...idle].sort((a, b) => a - b);
    console.log(`PERF thumbs per tick (30 thumbs redrawn while painting): median ${per[6].toFixed(2)} ms, max ${per[11].toFixed(2)} ms; effect renders during the stroke: ${during}`);
    ids.forEach((id, i) => e.drawThumbnail(id, canvases[i]));
    t = performance.now();
    const n0 = nT();
    await settleAll();
    console.log(`PERF thumbs after stroke: ${(performance.now() - t).toFixed(0)} ms to settle, ${nT() - n0} effect renders, render cost ${(e as unknown as { thumbStats: { ms: number } }).thumbStats.ms.toFixed(0)} ms total over ${nT()} renders`);
    expect(per[6]).toBeLessThan(8);
  }, 120000);
});

type Probe = { thumbnailsSettled(): Promise<void>; thumbStats: { fx: number }; fxThumbs: Map<string, unknown>; fxMeta: Map<string, unknown>; fxQueue: Map<string, unknown> };
const probe = (e: Engine) => e as unknown as Probe;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!effectsAvailable())('layer thumbnails with effects: scheduling', () => {
  it('a streaming TD input does not re-render other layers\' thumbnails, and its own is throttled', async () => {
    const e = mk(64, 48);
    const base = 'base'; // the locked input-1 layer
    e.setEffects(base, [overlay()]);
    const a = e.addPixelLayer();
    rect(e, a, 5, 5, 20, 20);
    e.setEffects(a, [shadow({ dx: 5, dy: 5 })]);
    const ids = [base, a];
    const draw = () => ids.forEach((id) => thumb(e, id));
    draw();
    await probe(e).thumbnailsSettled();
    const painted: string[] = [];
    const orig = cc(e).renderFxThumb.bind(cc(e));
    vi.spyOn(cc(e), 'renderFxThumb').mockImplementation((l, c) => { painted.push(l.id); return orig(l, c); });
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 1500) {
      const px = new Uint8ClampedArray(64 * 48 * 4).fill(n++ % 250);
      e.writeInput(1, { x: 0, y: 0, w: 64, h: 48 }, px);
      e.commitInput(1);
      e.flush();
      draw();
      await sleep(30);
    }
    await probe(e).thumbnailsSettled();
    expect(painted.filter((id) => id === a)).toHaveLength(0);
    const inputRenders = painted.filter((id) => id === base).length;
    expect(inputRenders).toBeGreaterThan(0);
    expect(inputRenders).toBeLessThanOrEqual(3); // ~ one per second, not one per frame
  });

  it('nothing renders while a gesture is open; the thumbnail follows when it ends', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    e.setEffects(a, [shadow()]);
    await settled(e, a);
    const n0 = probe(e).thumbStats.fx;
    e.beginGesture();
    e.setEffects(a, [shadow({ dx: 100, dy: 0 })]);
    thumb(e, a);
    await sleep(700);
    thumb(e, a);
    expect(probe(e).thumbStats.fx).toBe(n0);
    e.endGesture();
    const t = await settled(e, a);
    expect(probe(e).thumbStats.fx).toBe(n0 + 1);
    expect(at(e, t, 150, 40)[3]).toBeGreaterThan(200);
  });

  it('loadDocument clears the cache; deleting a layer drops its entry', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    const b = e.addPixelLayer();
    for (const id of [a, b]) { rect(e, id, 20, 20, 60, 60); e.setEffects(id, [overlay()]); }
    await settled(e, a);
    await settled(e, b);
    expect(probe(e).fxThumbs.size).toBe(2);
    e.deleteLayer(b);
    expect(probe(e).fxThumbs.has(b)).toBe(false);
    expect(probe(e).fxMeta.has(b)).toBe(false);
    e.loadDocument(e.docSpec());
    expect(probe(e).fxThumbs.size).toBe(0);
    expect(probe(e).fxMeta.size).toBe(0);
  });

  it('a throwing render is logged once and not retried until the layer changes', async () => {
    const e = mk();
    const a = e.addPixelLayer();
    rect(e, a, 20, 20, 60, 60);
    e.setEffects(a, [overlay()]);
    const orig = cc(e).renderFxThumb.bind(cc(e));
    const fail = vi.spyOn(cc(e), 'renderFxThumb').mockImplementation(() => { throw new Error('boom'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    thumb(e, a);
    await probe(e).thumbnailsSettled();
    for (let i = 0; i < 5; i++) { await sleep(200); thumb(e, a); }
    await probe(e).thumbnailsSettled();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter((c) => String(c[0]).includes('thumbnail'))).toHaveLength(1);
    expect(at(e, thumb(e, a), 40, 40)).toEqual([255, 0, 0, 255]); // falls back to the plain content
    fail.mockImplementation(orig); // a change retries
    e.setEffects(a, [overlay({ opacity: 0.9 })]);
    const t = await settled(e, a);
    expect(fail).toHaveBeenCalledTimes(2);
    expect(at(e, t, 40, 40)[2]).toBeGreaterThan(200);
    log.mockRestore();
  });
});
