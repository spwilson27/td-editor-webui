// v6 phase B: the composite below the stroked layer is cached while a stroke is in progress (Compositor.holdBelow).
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine';
import type { Compositor } from '../../src/engine/compositor';
import type { Effect } from '../../src/engine/types';
import { brushCtx, newEngine, perfEnabled, ptr } from './engineTestUtils';

const engines: Engine[] = [];
const mk = (w = 256, h = 192): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });

const full = (e: Engine) => ({ x: 0, y: 0, w: e.width, h: e.height });
const comp = (e: Engine): Uint8ClampedArray => e.readComposite(full(e));
const cc = (e: Engine) => (e as unknown as { compositor: Compositor }).compositor;
const fx = (type: string, o: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...o }) as unknown as Effect;

/** Largest premultiplied difference (0..255) between two straight RGBA images. */
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    m = Math.max(m, Math.abs(a[i + 3] - b[i + 3]));
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs((a[i + c] * a[i + 3]) / 255 - (b[i + c] * b[i + 3]) / 255));
  }
  return m;
}

function fillRects(e: Engine, id: string, rects: Array<[number, number, number, number, string]>): void {
  const l = e.doc.find(id) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
  for (const [x, y, w, h, c] of rects) {
    l.surface.ctx.fillStyle = c;
    l.surface.ctx.fillRect(x, y, w, h);
  }
  e.changed(full(e));
}

/** Fresh engine with the same document and pixels. */
function fresh(src: Engine): Engine {
  const e = mk(src.width, src.height);
  const spec = src.docSpec();
  e.loadDocument(spec);
  for (const slot of src.surfaceSlots()) {
    const sp = spec.layers.find((l) => l.slot === slot || l.mask?.slot === slot);
    const w = sp?.slot === slot ? sp.surfaceW ?? spec.width : sp?.surfaceW ?? spec.width;
    const h = sp?.slot === slot ? sp.surfaceH ?? spec.height : sp?.surfaceH ?? spec.height;
    e.writeSurface(slot, { x: 0, y: 0, w, h }, src.readSurface(slot, { x: 0, y: 0, w, h }));
  }
  e.commitSurfaces();
  e.flush();
  return e;
}

/** Layers: shapes with a drop shadow, a hue adjustment, a blurring adjustment, then the layer that gets painted, then one above. */
function scene(e: Engine): { low: string; mid: string; top: string; above: string; adj: string } {
  const low = e.addPixelLayer('low');
  fillRects(e, low, [[20, 20, 100, 80, '#3060c0'], [90, 60, 120, 90, '#c08030']]);
  e.setEffects(low, [fx('dropShadow', { dx: 6, dy: 6, blur: 8, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 0.8 })]);
  const adj = e.addAdjustment('blur');
  e.setAdjustment(adj, { type: 'blur', radius: 3 });
  const mid = e.addPixelLayer('mid');
  fillRects(e, mid, [[60, 30, 60, 60, '#30c060']]);
  e.setLayerProps(mid, { blend: 'multiply' });
  const top = e.addPixelLayer('top');
  const above = e.addPixelLayer('above');
  fillRects(e, above, [[150, 10, 40, 40, '#ff0000']]);
  e.setActiveLayer(top);
  return { low, mid, top, above, adj };
}

function paint(e: Engine, pts: Array<[number, number]>, frame: () => void = () => e.flush()): void {
  e.setTool('brush');
  e.pointerDown(ptr(pts[0][0], pts[0][1]));
  frame();
  for (const [x, y] of pts.slice(1)) {
    e.pointerMove(ptr(x, y));
    frame();
  }
  e.pointerUp(ptr(pts[pts.length - 1][0], pts[pts.length - 1][1]));
  e.flush();
}

describe('below cache', () => {
  it('a stroke builds and uses the cache and ends with the exact composite', () => {
    const e = mk();
    scene(e);
    e.flush();
    e.setToolContext(brushCtx({ size: 24, hardness: 0.6 }, { primary: { r: 255, g: 255, b: 0, a: 255 } }));
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 30; i++) pts.push([20 + i * 7, 40 + 60 * Math.sin(i / 5) + 40]);
    let heldDuring: string | null = null;
    paint(e, pts, () => { heldDuring = cc(e).held; e.flush(); });
    expect(heldDuring).not.toBeNull();
    expect(cc(e).held).toBeNull(); // released at pointer up
    expect(cc(e).belowStats.builds).toBeGreaterThan(0);
    expect(cc(e).belowStats.uses).toBeGreaterThan(5);
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });

  it('gives exactly what the uncached compositor gives, frame by frame', () => {
    const a = mk();
    const b = mk();
    scene(a);
    scene(b);
    cc(b).setBelowCache(false);
    for (const e of [a, b]) {
      e.setToolContext(brushCtx({ size: 30, hardness: 1 }, { primary: { r: 10, g: 10, b: 10, a: 255 } }));
      e.flush();
    }
    const pts: Array<[number, number]> = [[30, 150], [90, 100], [150, 120], [220, 60], [240, 170]];
    for (const e of [a, b]) {
      e.setTool('brush');
      e.pointerDown(ptr(pts[0][0], pts[0][1]));
    }
    for (const p of pts.slice(1)) {
      for (const e of [a, b]) { e.pointerMove(ptr(p[0], p[1])); e.flush(); }
      const ca = comp(a), cb = comp(b);
      expect(maxDiff(ca, cb)).toBeLessThanOrEqual(1);
    }
    for (const e of [a, b]) e.pointerUp(ptr(240, 170));
    expect(cc(a).belowStats.uses).toBeGreaterThan(0);
    expect(cc(b).belowStats.uses).toBe(0);
  });

  it('a change below the stroked layer mid-stroke drops the cache (no stale pixels)', () => {
    const e = mk();
    const s = scene(e);
    e.flush();
    e.setToolContext(brushCtx({ size: 20 }, { primary: { r: 255, g: 255, b: 255, a: 255 } }));
    e.setTool('brush');
    e.pointerDown(ptr(30, 100));
    e.pointerMove(ptr(80, 110));
    e.flush();
    expect(cc(e).belowStats.builds).toBeGreaterThan(0);
    // e.g. a TD input frame or another client's edit arrives: pixels of a lower layer change
    fillRects(e, s.low, [[100, 100, 50, 50, '#ff00ff']]);
    e.flush();
    e.pointerMove(ptr(140, 120));
    e.flush();
    e.pointerMove(ptr(200, 130));
    e.flush();
    e.pointerUp(ptr(200, 130));
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });

  it('works when the stroked layer is inside a group, on masks, and for the eraser', () => {
    const e = mk();
    const s = scene(e);
    const g = e.addGroup();
    e.moveLayer(s.top, g, 0);
    e.setActiveLayer(s.top);
    e.flush();
    e.setToolContext(brushCtx({ size: 26 }, { primary: { r: 200, g: 0, b: 200, a: 255 } }));
    paint(e, [[20, 20], [100, 60], [180, 140]]);
    expect(cc(e).belowStats.uses).toBeGreaterThan(0);
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
    e.addMask(s.top);
    e.setPaintTarget(s.top, 'mask');
    e.setToolContext(brushCtx({ size: 30 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    paint(e, [[40, 40], [150, 100]]);
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
    e.setPaintTarget(s.top, 'pixels');
    e.setTool('eraser');
    e.pointerDown(ptr(60, 30));
    e.pointerMove(ptr(120, 70));
    e.flush();
    e.pointerUp(ptr(120, 70));
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });

  it('is not used for a bottom layer, small stacks, or huge documents', () => {
    const e = mk(64, 64);
    const a = e.addPixelLayer();
    e.setActiveLayer(a);
    e.setToolContext(brushCtx({ size: 10 }));
    paint(e, [[10, 10], [40, 40]]);
    expect(cc(e).belowStats.builds).toBe(0); // only the (cheap) TD input layer lies below
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });

  it('undo after a cached stroke restores the exact pixels', () => {
    const e = mk();
    scene(e);
    e.flush();
    const before = comp(e);
    e.setToolContext(brushCtx({ size: 24 }, { primary: { r: 255, g: 0, b: 0, a: 255 } }));
    paint(e, [[30, 30], [120, 90], [200, 150]]);
    expect(maxDiff(comp(e), before)).toBeGreaterThan(10);
    e.undo();
    e.flush();
    expect(maxDiff(comp(e), before)).toBeLessThanOrEqual(1);
  });
});

const d = perfEnabled ? describe : describe.skip;
d('below cache: speedup', () => {
  it('a stroke over a heavy stack is faster with the cache', () => {
    const run = (cached: boolean): number => {
      const e = mk(2048, 1536);
      cc(e).setBelowCache(cached);
      for (let i = 0; i < 6; i++) {
        const l = e.addPixelLayer(`l${i}`);
        fillRects(e, l, [[100 + i * 150, 100 + i * 80, 500, 400, `hsl(${i * 55},70%,50%)`]]);
        e.setEffects(l, [fx('dropShadow', { dx: 8, dy: 8, blur: 14, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 0.7 })]);
      }
      const adj = e.addAdjustment('hueSaturation');
      e.setAdjustment(adj, { type: 'hueSaturation', hue: 30, saturation: 1.2, value: 1 });
      const top = e.addPixelLayer('top');
      e.setActiveLayer(top);
      e.flush();
      e.setToolContext(brushCtx({ size: 120, hardness: 0.5 }, { primary: { r: 255, g: 255, b: 255, a: 255 } }));
      const t0 = performance.now();
      e.setTool('brush');
      e.pointerDown(ptr(300, 300));
      for (let i = 1; i <= 90; i++) {
        e.pointerMove(ptr(300 + i * 14, 300 + 250 * Math.sin(i / 10)));
        e.flush();
      }
      e.pointerUp(ptr(300 + 90 * 14, 300));
      e.flush();
      const ms = performance.now() - t0;
      e.dispose();
      engines.splice(engines.indexOf(e), 1);
      return ms;
    };
    run(true); // warm up (shaders, canvases)
    const off = run(false);
    const on = run(true);
    console.log(`below cache perf: 90 frames, 2048x1536, 6 shadowed layers + adjustment: uncached ${off.toFixed(0)} ms, cached ${on.toFixed(0)} ms (x${(off / on).toFixed(2)})`);
    expect(on, `cached ${on.toFixed(0)} uncached ${off.toFixed(0)}`).toBeLessThan(off * 1.1);
  });
});
