import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { PixelLayer } from '../../src/engine/model';
import type { EngineEvent, Rect } from '../../src/engine/types';
import { brushCtx, collect, layerPx, maskAt, near, newEngine, ptr, px, rgba, setBase, slotOf, slotPx, stroke, type Px } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const BLUE: Px = [0, 0, 255, 255];
const RED: Px = [255, 0, 0, 255];
const BLACK: Px = [0, 0, 0, 255];

/** RGBA image from a per-pixel function. */
function img(w: number, h: number, f: (x: number, y: number) => Px): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(f(x, y), (y * w + x) * 4);
  return a;
}
const info = (id: string) => e.layers().find((l) => l.id === id)!;
const layer = (id: string) => e.doc.find(id) as PixelLayer;
const docRect = (): Rect => ({ x: 0, y: 0, w: e.width, h: e.height });
/** Bounding box of pixels with alpha > 100 in a doc area of the composite. */
function ink(area: Rect = docRect()): Rect | null {
  const d = e.readComposite(area);
  let x0 = area.w, y0 = area.h, x1 = -1, y1 = -1;
  for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) {
    if (d[(y * area.w + x) * 4 + 3] > 100) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return x1 < 0 ? null : { x: x0 + area.x, y: y0 + area.y, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/** Live list of notice messages. */
function noticesOf(en: Engine): string[] {
  const out: string[] = [];
  en.on((ev) => { if (ev.type === 'notice') out.push(ev.message); });
  return out;
}
const closeRect = (a: Rect | null, b: Rect, tol = 1): boolean =>
  !!a && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= 2 * tol && Math.abs(a.h - b.h) <= 2 * tol;
const types = <T extends EngineEvent['type']>(ev: EngineEvent[], t: T) => ev.filter((x): x is Extract<EngineEvent, { type: T }> => x.type === t);

describe('transforms: compositing', () => {
  it('scales up: interior pixels are exact, edges land on the mapped bounds', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(10, 10, (x) => (x < 5 ? BLUE : RED)), 10, 10, 'two');
    expect(info(id).transform).toEqual({ x: 45, y: 45, sx: 1, sy: 1 });
    e.setTransform(id, { x: 20, y: 10, sx: 4, sy: 4 });
    expect(info(id).transform).toEqual({ x: 20, y: 10, sx: 4, sy: 4 });
    expect(info(id)).toMatchObject({ surfaceW: 10, surfaceH: 10 });
    expect(px(e, 30, 20)).toEqual(BLUE);
    expect(px(e, 50, 20)).toEqual(RED);
    expect(px(e, 20, 10)).toEqual(BLUE);
    expect(px(e, 59, 49)).toEqual(RED);
    expect(px(e, 19, 20)[3]).toBe(0);
    expect(px(e, 60, 20)[3]).toBe(0);
    expect(px(e, 30, 9)[3]).toBe(0);
    expect(px(e, 30, 50)[3]).toBe(0);
    expect(ink()).toEqual({ x: 20, y: 10, w: 40, h: 40 });
    // the colour boundary sits at 20 + 4 * 5 = 40, softened by bilinear sampling only
    expect(px(e, 36, 20)).toEqual(BLUE);
    expect(px(e, 44, 20)).toEqual(RED);
  });

  it('non-uniform scale maps each axis separately', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(10, 10, (_x, y) => (y < 5 ? BLUE : RED)), 10, 10, 'rows');
    e.setTransform(id, { x: 0, y: 0, sx: 2, sy: 6 });
    expect(ink()).toEqual({ x: 0, y: 0, w: 20, h: 60 });
    expect(px(e, 10, 10)).toEqual(BLUE);
    expect(px(e, 10, 50)).toEqual(RED);
  });

  it('scales down with smoothing (checkerboard averages to grey)', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(64, 64, (x, y) => (((x + y) & 1) === 0 ? [255, 255, 255, 255] : BLACK)), 64, 64, 'cb');
    e.setTransform(id, { x: 0, y: 0, sx: 0.25, sy: 0.25 });
    const v = px(e, 8, 8);
    expect(v[0]).toBeGreaterThan(100);
    expect(v[0]).toBeLessThan(155);
    expect(v[3]).toBe(255);
    expect(ink()).toEqual({ x: 0, y: 0, w: 16, h: 16 });
  });

  it('fractional positions blend the edge pixels', () => {
    e = newEngine(40, 40);
    const id = e.importImage(img(10, 10, () => RED), 10, 10, 'r');
    e.setTransform(id, { x: 2.5, y: 4.25, sx: 1.5, sy: 1 }); // positions are whole pixels, scale is not
    expect(info(id).transform).toEqual({ x: 3, y: 4, sx: 1.5, sy: 1 });
    expect(px(e, 6, 8)).toEqual(RED);
    expect(px(e, 2, 8)[3]).toBe(0);
    expect(px(e, 3, 8)[3]).toBe(255);
    expect(ink()).toEqual({ x: 3, y: 4, w: 15, h: 10 });
  });

  it('masks follow the layer transform', () => {
    e = newEngine(80, 80);
    const id = e.importImage(img(20, 10, () => RED), 20, 10, 'm');
    const m = e.addMask(id);
    expect(e.docSpec().layers.find((l) => l.id === id)).toMatchObject({ surfaceW: 20, surfaceH: 10 });
    // mask in layer space: left half hidden
    const grey = new Uint8Array(20 * 10 * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) grey.set([x < 10 ? 0 : 255, 0, 0, 255], (y * 20 + x) * 4);
    e.writeSurface(m, { x: 0, y: 0, w: 20, h: 10 }, grey);
    e.commitSurfaces();
    e.setTransform(id, { x: 5, y: 5, sx: 3, sy: 3 });
    expect(px(e, 20, 20)[3]).toBe(0); // left half (doc x 5..34)
    expect(px(e, 33, 20)[3]).toBe(0);
    expect(px(e, 38, 20)).toEqual(RED);
    expect(px(e, 62, 33)).toEqual(RED);
    expect(px(e, 66, 20)[3]).toBe(0);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 16;
    e.drawMaskThumbnail(id, cv);
    const d = cv.getContext('2d')!.getImageData(0, 0, 16, 16).data;
    expect(d[(4 * 16 + 10) * 4]).toBeGreaterThan(200); // right half white at doc (55, 25)
    expect(d[(4 * 16 + 3) * 4]).toBeLessThan(40); // left half black
  });

  it('the base (TD Input) has its own surface size and transform, and stays locked', () => {
    e = newEngine(100, 100);
    e.setBaseSize(10, 10);
    expect(e.docSpec().layers[0]).toMatchObject({ kind: 'base', surfaceW: 10, surfaceH: 10, sx: 1, sy: 1 });
    e.writeBase({ x: 0, y: 0, w: 10, h: 10 }, img(10, 10, () => BLUE));
    e.commitBase();
    expect(px(e, 5, 5)).toEqual(BLUE);
    expect(px(e, 15, 5)[3]).toBe(0);
    e.setTransform('base', { x: 20, y: 20, sx: 3, sy: 3 });
    expect(px(e, 30, 30)).toEqual(BLUE);
    expect(px(e, 10, 10)[3]).toBe(0);
    expect(px(e, 51, 51)[3]).toBe(0);
    expect(info('base')).toMatchObject({ locked: true, transform: { x: 20, y: 20, sx: 3, sy: 3 } });
    expect(e.layerBounds('base')).toEqual({ x: 20, y: 20, w: 30, h: 30 });
    // new BASE frames land in base-surface space
    e.writeBase({ x: 5, y: 0, w: 5, h: 10 }, img(5, 10, () => RED));
    e.commitBase();
    expect(px(e, 40, 30)).toEqual(RED);
    expect(px(e, 25, 30)).toEqual(BLUE);
    // painting stays locked, history records the transform
    const notices = noticesOf(e);
    e.setToolContext(brushCtx());
    stroke(e, 'brush', [[30, 30]]);
    expect(notices.some((n) => /locked/i.test(n))).toBe(true);
    e.undo();
    expect(info('base').transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
  });

  it('a base resolution change reallocates the base surface; writeBase clips to it', () => {
    e = newEngine(50, 50);
    setBase(e, BLUE);
    expect(px(e, 40, 40)).toEqual(BLUE);
    e.setBaseSize(20, 10);
    expect(e.docSpec().layers[0]).toMatchObject({ surfaceW: 20, surfaceH: 10 });
    expect(px(e, 5, 5)[3]).toBe(0); // empty until new BASE frames arrive
    e.writeBase({ x: 0, y: 0, w: 30, h: 30 }, img(30, 30, () => RED)); // clipped to 20x10
    e.commitBase();
    expect(px(e, 19, 9)).toEqual(RED);
    expect(px(e, 20, 5)[3]).toBe(0);
    expect(px(e, 5, 10)[3]).toBe(0);
    e.setBaseSize(0, 0);
    expect(px(e, 5, 5)[3]).toBe(0);
  });

  it('the first base size places the input: identity when following, fit + centre when fixed', () => {
    e = newEngine(100, 100);
    e.setBaseSize(50, 50);
    expect(info('base').transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
    e.dispose();
    e = newEngine(100, 100);
    e.setCanvasSize(100, 50, 'tl');
    e.setBaseSize(400, 100);
    expect(info('base').transform).toEqual({ x: 0, y: 13, sx: 0.25, sy: 0.25 });
    e.setBaseSize(200, 100); // only the first connection places it; later resolution changes keep the displayed box (100 x 25)
    expect(info('base').transform).toEqual({ x: 0, y: 13, sx: 0.5, sy: 0.25 });
    expect(e.layerBounds('base')).toEqual({ x: 0, y: 13, w: 100, h: 25 });
  });

  it('transformed layers work in groups, with blend modes, opacity and hidden state', () => {
    e = newEngine(60, 60);
    setBase(e, [200, 200, 200, 255]);
    const g = e.addGroup();
    const id = e.importImage(img(10, 10, () => BLUE), 10, 10, 'b');
    e.moveLayer(id, g, 0);
    e.setTransform(id, { x: 10, y: 10, sx: 3, sy: 3 });
    expect(px(e, 20, 20)).toEqual(BLUE);
    e.setLayerProps(id, { opacity: 0.5 });
    expect(near(px(e, 20, 20), [100, 100, 228, 255], 3)).toBe(true);
    e.setLayerProps(id, { opacity: 1 });
    e.setLayerProps(g, { blend: 'multiply' });
    expect(near(px(e, 20, 20), [0, 0, 200, 255], 3)).toBe(true);
    e.setLayerProps(g, { blend: 'normal' });
    e.setLayerProps(id, { visible: false });
    expect(px(e, 20, 20)).toEqual([200, 200, 200, 255]);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 12;
    e.setLayerProps(id, { visible: true });
    e.drawThumbnail(g, cv);
    expect(cv.getContext('2d')!.getImageData(5, 5, 1, 1).data[2]).toBe(255);
  });

  it('thumbnails show the transformed layer inside the document frame', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(10, 10, () => RED), 10, 10, 'r');
    e.setTransform(id, { x: 50, y: 50, sx: 5, sy: 5 });
    const cv = document.createElement('canvas');
    cv.width = cv.height = 20;
    e.drawThumbnail(id, cv);
    const d = cv.getContext('2d')!.getImageData(0, 0, 20, 20).data;
    expect(d[(15 * 20 + 15) * 4 + 3]).toBe(255);
    expect(d[(2 * 20 + 2) * 4 + 3]).toBe(0);
    expect(d[(8 * 20 + 8) * 4 + 3]).toBe(0); // the layer starts at document 50 = thumbnail pixel 10
  });
});

describe('transforms: setTransform, bounds, history, events', () => {
  it('layerBounds maps the surface; groups union their children; adjustments have none', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(20, 10, () => RED), 20, 10, 'r');
    e.setTransform(id, { x: 5.5, y: 6, sx: 2, sy: 0.5 });
    expect(e.layerBounds(id)).toEqual({ x: 6, y: 6, w: 40, h: 5 });
    const g = e.addGroup();
    e.moveLayer(id, g, 0);
    expect(e.layerBounds(g)).toEqual({ x: 6, y: 6, w: 40, h: 5 });
    const adj = e.addAdjustment('invert');
    expect(e.layerBounds(adj)).toBeNull();
    expect(e.layerBounds('nope')).toBeNull();
    expect(e.layerBounds('base')).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('coalesces a drag into one history entry; undo / redo restore the transform and docspec', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    const n = e.history().entries.length;
    const ev = collect(e);
    const rev0 = e.docSpec().rev;
    for (let i = 1; i <= 5; i++) e.setTransform(id, { x: i * 3, y: 0, sx: 1 + i / 10, sy: 1 });
    expect(e.history().entries).toHaveLength(n + 1);
    expect(e.history().entries.slice(-1)[0].label).toBe('Transform');
    expect(types(ev, 'docspec').length).toBeGreaterThan(0);
    expect(e.docSpec().rev).toBeGreaterThan(rev0);
    expect(e.docSpec().layers.find((l) => l.id === id)).toMatchObject({ x: 15, sx: 1.5, surfaceW: 100 });
    expect(ev.some((x) => x.type === 'surface')).toBe(false); // pixels did not change
    e.undo();
    expect(info(id).transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
    e.redo();
    expect(info(id).transform).toEqual({ x: 15, y: 0, sx: 1.5, sy: 1 });
  });

  it('dirty rects cover the old and new mapped bounds only', () => {
    e = newEngine(200, 200);
    const id = e.importImage(img(10, 10, () => RED), 10, 10, 'r');
    e.setTransform(id, { x: 10, y: 10, sx: 2, sy: 2 });
    e.flush();
    const ev = collect(e);
    e.setTransform(id, { x: 100, y: 100, sx: 4, sy: 4 });
    e.flush();
    const comp = types(ev, 'composite').map((c) => c.rect);
    expect(comp.length).toBeGreaterThan(0);
    const u = comp.reduce((a, b) => {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
    });
    expect(u.x).toBeLessThanOrEqual(10);
    expect(u.x + u.w).toBeGreaterThanOrEqual(140);
    expect(u.w * u.h).toBeLessThan(140 * 140 + 1);
    expect(px(e, 20, 20)[3]).toBe(0); // no ghost at the old place
    expect(px(e, 120, 120)).toEqual(RED);
  });

  it('refuses locked layers and bad numbers; the lock does not stop the base', () => {
    e = newEngine(50, 50);
    const id = e.addPixelLayer();
    e.setLayerProps(id, { locked: true });
    const notices = noticesOf(e);
    e.setTransform(id, { x: 5, y: 5, sx: 1, sy: 1 });
    expect(info(id).transform.x).toBe(0);
    expect(notices.some((n) => /locked/i.test(n))).toBe(true);
    e.setLayerProps(id, { locked: false });
    const n = e.history().entries.length;
    e.setTransform(id, { x: NaN, y: 0, sx: 1, sy: 1 });
    e.setTransform(id, { x: 0, y: 0, sx: 1, sy: 1 }); // unchanged
    e.setTransform('nope', { x: 0, y: 0, sx: 2, sy: 2 });
    e.setTransform(e.addGroup(), { x: 1, y: 1, sx: 2, sy: 2 });
    expect(e.history().entries.length).toBe(n + 1); // only the group add
    e.setTransform(id, { x: 0, y: 0, sx: -3, sy: 0 }); // scale is clamped to a positive range
    expect(info(id).transform.sx).toBeGreaterThan(0);
    expect(info(id).transform.sy).toBeGreaterThan(0);
    e.setTransform('base', { x: 1, y: 2, sx: 1, sy: 1 });
    expect(info('base').transform.x).toBe(1);
  });

  it('setLayerBox fits pixel layers; text and shapes scale their geometry from the drag start', () => {
    e = newEngine(200, 200);
    const id = e.importImage(img(10, 10, () => RED), 10, 10, 'r');
    e.setLayerBox(id, { x: 5, y: 5, w: 40, h: 20 });
    expect(info(id).transform).toEqual({ x: 5, y: 5, sx: 4, sy: 2 });
    const t = e.addTextLayer({ text: 'Hi', font: 'sans-serif', size: 20, color: rgba(0, 0, 0), align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 10, y: 10, boxWidth: null });
    const b0 = e.layerBounds(t) as Rect;
    const n = e.history().entries.length;
    e.setLayerBox(t, { x: 10, y: 10, w: b0.w * 2, h: b0.h * 2 });
    e.setLayerBox(t, { x: 20, y: 30, w: b0.w * 3, h: b0.h * 3 }); // same drag: scaled from the original, not from the 2x
    expect(info(t).text).toMatchObject({ size: 60, x: 20, y: 30 });
    expect(e.history().entries).toHaveLength(n + 1);
    e.undo();
    expect(info(t).text).toMatchObject({ size: 20, x: 10, y: 10 });
    const s = e.addShapeLayer({ type: 'rect', x: 10, y: 10, w: 40, h: 20, radius: 6, fill: { enabled: true, color: rgba(255, 0, 0) }, stroke: { enabled: true, color: rgba(0, 0, 0), width: 4 }, rotation: 0 });
    e.setLayerBox(s, { x: 20, y: 20, w: 80, h: 80 });
    expect(info(s).shape).toMatchObject({ type: 'rect', x: 20, y: 20, w: 80, h: 80 });
    const sh = info(s).shape as { radius: number; stroke: { width: number } };
    expect(sh.radius).toBeCloseTo(6 * Math.sqrt(2 * 4), 5);
    expect(sh.stroke.width).toBeCloseTo(4 * Math.sqrt(8), 5);
    expect(e.layerBounds(s)).toEqual({ x: 20, y: 20, w: 80, h: 80 });
    const l = e.addShapeLayer({ type: 'line', x1: 0, y1: 0, x2: 20, y2: 10, stroke: { enabled: true, color: rgba(0, 0, 0), width: 2 }, arrowStart: false, arrowEnd: false });
    e.setLayerBox(l, { x: 100, y: 100, w: 40, h: 20 });
    expect(info(l).shape).toMatchObject({ x1: 100, y1: 100, x2: 140, y2: 120 });
    const p = e.addShapeLayer({ type: 'polygon', cx: 50, cy: 50, radius: 10, sides: 5, innerRatio: 1, fill: { enabled: true, color: rgba(255, 0, 0) }, stroke: { enabled: false, color: rgba(0, 0, 0), width: 1 }, rotation: 0 });
    e.setLayerBox(p, { x: 0, y: 0, w: 80, h: 80 });
    expect(info(p).shape).toMatchObject({ cx: 40, cy: 40, radius: 40 });
    e.setLayerBox(p, { x: 0, y: 0, w: 0, h: 5 }); // degenerate: ignored
    expect(info(p).shape).toMatchObject({ radius: 40 });
  });
});

describe('transforms: painting lands under the cursor', () => {
  function scaledLayer(t = { x: 10, y: 20, sx: 2, sy: 2 }): string {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    e.setTransform(id, t);
    return id;
  }

  it('a brush dab on a 2x layer: pixel under the cursor, circle of `size` document px', () => {
    const id = scaledLayer();
    e.setToolContext(brushCtx({ size: 8, hardness: 1 }));
    stroke(e, 'brush', [[50, 60]]);
    expect(px(e, 50, 60)).toEqual(BLACK);
    expect(layerPx(e, id, 20, 20)).toEqual(BLACK); // (50 - 10) / 2, (60 - 20) / 2
    const b = ink() as Rect;
    expect(b.w).toBeGreaterThanOrEqual(7);
    expect(b.w).toBeLessThanOrEqual(10);
    expect(b.h).toBeGreaterThanOrEqual(7);
    expect(b.h).toBeLessThanOrEqual(10);
    expect(Math.abs(b.x + b.w / 2 - 50.5)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.y + b.h / 2 - 60.5)).toBeLessThanOrEqual(1.5);
    // the surface holds a small circle: 4 layer px across, not 8
    let n = 0;
    const s = layer(id).surface.ctx.getImageData(0, 0, 100, 100).data;
    for (let i = 3; i < s.length; i += 4) if (s[i] > 128) n++;
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(24);
    expect(e.history().entries.slice(-1)[0].label).toBe('Brush');
    e.undo();
    expect(px(e, 50, 60)[3]).toBe(0);
    expect(ink()).toBeNull();
  });

  it('non-uniform scale: the tip is an ellipse in the layer, a circle on screen', () => {
    scaledLayer({ x: 0, y: 0, sx: 2, sy: 0.5 });
    e.setToolContext(brushCtx({ size: 20, hardness: 1 }));
    stroke(e, 'brush', [[50, 40]]);
    const b = ink() as Rect;
    expect(Math.abs(b.w - b.h)).toBeLessThanOrEqual(2);
    expect(b.w).toBeGreaterThanOrEqual(17);
    expect(b.w).toBeLessThanOrEqual(22);
  });

  it('a stroke is continuous on screen with spacing measured in document pixels', () => {
    scaledLayer({ x: 5, y: 5, sx: 0.5, sy: 0.5 }); // covers document 5..55
    e.setToolContext(brushCtx({ size: 8, hardness: 1 }));
    stroke(e, 'brush', [[15, 20], [45, 20], [45, 45]]);
    for (let x = 15; x <= 45; x += 3) expect(px(e, x, 20)[3]).toBeGreaterThan(200);
    for (let y = 20; y <= 45; y += 3) expect(px(e, 45, y)[3]).toBeGreaterThan(200);
    expect(px(e, 30, 35)[3]).toBe(0);
  });

  it('a smaller brush of another colour leaves no stale-tip lines (fractional dabs sample just outside the stamp)', () => {
    // Regression: the stamp canvas was only cleared over the new tip size, so a previous bigger / differently coloured tip
    // bled into the dab edges as 1 px rows and columns of the old colour (visible in a scaled, soft-brushed layer).
    e = newEngine(500, 500);
    const id = e.importImage(new Uint8ClampedArray(256 * 256 * 4), 256, 256, 'L');
    e.setTransform(id, { x: 0, y: 0, sx: 1.953125, sy: 1.953125 });
    e.setToolContext(brushCtx({ size: 60, hardness: 0.4 }, { primary: rgba(230, 100, 50) }));
    stroke(e, 'brush', [[400, 400], [420, 410]]);
    e.setToolContext(brushCtx({ size: 24, hardness: 1 }, { primary: rgba(0, 0, 0) }));
    stroke(e, 'brush', [[100, 100], [130.5, 112.3], [150.7, 160.2], [120.1, 170.9]]);
    const l = layer(id);
    const d = l.surface.ctx.getImageData(0, 0, 150, 150).data; // layer px around the black stroke (document ~40..290)
    let bad = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] > 8) bad++;
    expect(bad).toBe(0);
  });

  it('pencil paints whole layer pixels: a 4x4 document block on a 4x layer', () => {
    const id = scaledLayer({ x: 0, y: 0, sx: 4, sy: 4 });
    e.setToolContext(brushCtx({ size: 1 }));
    stroke(e, 'pencil', [[10.5, 10.5]]);
    expect(layerPx(e, id, 2, 2)).toEqual(BLACK); // layer pixel 10.5 / 4
    expect(layerPx(e, id, 1, 2)[3]).toBe(0);
    expect(layerPx(e, id, 3, 2)[3]).toBe(0);
    expect(layerPx(e, id, 2, 1)[3]).toBe(0);
    expect(px(e, 10, 10)[3]).toBeGreaterThan(150); // the preview interpolates (bilinear) between layer pixels
    expect(closeRect(ink(), { x: 8, y: 8, w: 4, h: 4 }, 1)).toBe(true);
    stroke(e, 'pencil', [[2, 30], [30, 30]]);
    for (let x = 2; x <= 30; x += 4) expect(layerPx(e, id, Math.floor(x / 4), 7)).toEqual(BLACK);
  });

  it('eraser removes what was painted under the same mapping', () => {
    scaledLayer();
    e.setToolContext(brushCtx({ size: 30, hardness: 1 }));
    stroke(e, 'brush', [[50, 50]]);
    expect(px(e, 50, 50)).toEqual(BLACK);
    stroke(e, 'eraser', [[50, 50]]);
    expect(px(e, 50, 50)[3]).toBe(0);
    expect(px(e, 40, 50)[3]).toBe(0);
  });

  it('paints a layer that is larger than the document and moved out of it', () => {
    e = newEngine(50, 50);
    const id = e.importImage(img(200, 200, () => [255, 255, 255, 255]), 200, 200, 'big');
    expect(info(id).transform.sx).toBeCloseTo(0.25, 6);
    e.setToolContext(brushCtx({ size: 16, hardness: 1 }));
    stroke(e, 'brush', [[25, 25]]);
    expect(px(e, 25, 25)).toEqual(BLACK);
    expect(layerPx(e, id, 100, 100)).toEqual(BLACK); // native resolution surface, hit at 25 / 0.25
    expect(layerPx(e, id, 60, 100)[0]).toBe(255);
  });

  it('flood fill works in layer pixels from the clicked pixel', () => {
    const id = scaledLayer({ x: 0, y: 0, sx: 2, sy: 2 });
    const s = layer(id).surface.ctx;
    s.fillStyle = 'rgb(255,0,0)';
    s.fillRect(0, 0, 25, 100); // red left quarter of the layer (doc x 0..49)
    e.changed(docRect());
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 255), fillTolerance: 0 }));
    stroke(e, 'fill', [[80, 30]]);
    expect(px(e, 80, 30)).toEqual(BLUE);
    expect(px(e, 95, 95)).toEqual(BLUE);
    expect(px(e, 52, 0)).toEqual(BLUE);
    expect(px(e, 20, 30)).toEqual(RED);
    expect(layerPx(e, id, 30, 10)).toEqual(BLUE);
    expect(layerPx(e, id, 10, 10)).toEqual(RED);
    expect(e.history().entries.slice(-1)[0].label).toBe('Fill');
    e.undo();
    expect(px(e, 80, 30)[3]).toBe(0);
    expect(px(e, 20, 30)).toEqual(RED);
  });

  it('gradient is defined in document space (iso-lines perpendicular on screen) even for non-uniform scale', () => {
    scaledLayer({ x: 0, y: 0, sx: 2, sy: 0.5 }); // covers document 0..200 x 0..50
    e.setToolContext(brushCtx({}, { primary: rgba(255, 0, 0), secondary: rgba(0, 0, 255) }));
    e.setTool('gradient');
    e.pointerDown(ptr(20, 25));
    e.pointerMove(ptr(80, 25));
    e.pointerUp(ptr(80, 25));
    const r = (x: number, y = 25) => px(e, x, y)[0];
    expect(r(22)).toBeGreaterThan(220);
    expect(r(78)).toBeLessThan(40);
    expect(r(35)).toBeGreaterThan(r(50));
    expect(r(50)).toBeGreaterThan(r(65));
    expect(Math.abs(r(50) - 128)).toBeLessThan(12);
    expect(Math.abs(r(50, 8) - r(50, 40))).toBeLessThan(3); // constant along the iso-line
    expect(e.history().entries.slice(-1)[0].label).toBe('Gradient');
  });

  it('mask painting uses the layer mapping', () => {
    const id = scaledLayer();
    e.drawMaskThumbnail(id, document.createElement('canvas'));
    const m = e.addMask(id);
    e.setPaintTarget(id, 'mask');
    e.setToolContext(brushCtx({ size: 10, hardness: 1 }));
    stroke(e, 'brush', [[40, 40]]);
    expect(px(e, 40, 40)[3]).toBe(0);
    expect(e.readSurface(m, { x: 0, y: 0, w: 1, h: 1 }).length).toBe(4);
    expect(maskAt(e, m, 15, 10)).toBe(0); // (40 - 10) / 2, (40 - 20) / 2
    expect(maskAt(e, m, 40, 40)).toBe(255);
  });
});

describe('transforms: selection clipping and the wand', () => {
  function scaled(): string {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    e.setTransform(id, { x: 10, y: 10, sx: 2, sy: 2 });
    e.setToolContext(brushCtx({ size: 60, hardness: 1 }));
    return id;
  }
  const setOpts = (): void => e.setSelectionOptions({ mode: 'new', feather: 0, antialias: false, wandTolerance: 32, wandContiguous: true, wandSampleAll: false });

  it('a rectangular selection clips the stroke on the document grid', () => {
    const id = scaled();
    e.setSelection({ x: 40, y: 40, w: 20, h: 20 });
    stroke(e, 'brush', [[50, 50]]);
    expect(ink()).toEqual({ x: 40, y: 40, w: 20, h: 20 });
    expect(px(e, 38, 50)[3]).toBe(0);
    expect(px(e, 39, 50)[3]).toBeLessThan(100); // bilinear preview: at most a quarter bleeds across the clip edge
    expect(px(e, 61, 50)[3]).toBe(0);
    expect(px(e, 45, 45)).toEqual(BLACK);
    expect(layerPx(e, id, 14, 20)[3]).toBe(0); // doc x 38, outside
    expect(layerPx(e, id, 15, 20)[3]).toBe(255); // doc x 40..41, inside
    expect(layerPx(e, id, 24, 20)[3]).toBe(255); // doc x 58..59
    expect(layerPx(e, id, 25, 20)[3]).toBe(0);
    expect(layerPx(e, id, 20, 25)[3]).toBe(0); // doc y 60, outside
  });

  it('a lasso selection clips through the mapped coverage', () => {
    scaled();
    setOpts();
    stroke(e, 'lasso', [[20, 20], [80, 20], [50, 80]]);
    e.setToolContext(brushCtx({ size: 12, hardness: 1 }));
    stroke(e, 'brush', [[10, 30], [90, 30]]);
    expect(px(e, 40, 30)).toEqual(BLACK);
    expect(px(e, 22, 30)[3]).toBe(0); // left of the triangle edge (x = 25 at y = 30)
    expect(px(e, 78, 30)[3]).toBe(0);
    expect(px(e, 40, 26)[3]).toBeGreaterThan(200);
    expect(px(e, 40, 10)[3]).toBe(0); // above the triangle
  });

  it('gradient and fill respect the selection on a transformed layer', () => {
    scaled();
    setOpts();
    e.setSelection({ x: 20, y: 20, w: 40, h: 40 });
    e.setToolContext(brushCtx({}, { primary: rgba(255, 0, 0), secondary: rgba(0, 0, 255), fillTolerance: 0 }));
    e.setTool('gradient');
    e.pointerDown(ptr(20, 40));
    e.pointerUp(ptr(60, 40));
    expect(ink()).toEqual({ x: 20, y: 20, w: 40, h: 40 });
    expect(px(e, 21, 40)[0]).toBeGreaterThan(200);
    expect(px(e, 58, 40)[2]).toBeGreaterThan(200);
    e.undo();
    expect(ink()).toBeNull();
    stroke(e, 'fill', [[30, 30]]);
    expect(ink()).toEqual({ x: 20, y: 20, w: 40, h: 40 });
    // clicking an unselected pixel does nothing
    const n = e.history().entries.length;
    stroke(e, 'fill', [[80, 80]]);
    expect(e.history().entries.length).toBe(n);
  });

  it('a feathered selection scales the stroke through its coverage', () => {
    scaled();
    e.setSelectionOptions({ mode: 'new', feather: 12, antialias: true, wandTolerance: 32, wandContiguous: true, wandSampleAll: false });
    stroke(e, 'lasso', [[30, 30], [70, 30], [70, 70], [30, 70]]);
    e.setToolContext(brushCtx({ size: 80, hardness: 1 }));
    stroke(e, 'brush', [[50, 50]]);
    const centre = px(e, 50, 50)[3];
    const edge = px(e, 32, 50)[3];
    expect(centre).toBeGreaterThan(240);
    expect(edge).toBeGreaterThan(20);
    expect(edge).toBeLessThan(200);
    expect(px(e, 10, 50)[3]).toBe(0);
  });

  it('the magic wand samples the layer as it looks in the document', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? BLUE : RED)), 20, 20, 'w');
    e.setTransform(id, { x: 10, y: 10, sx: 4, sy: 4 });
    setOpts();
    e.setTool('wand');
    e.pointerDown(ptr(50, 50));
    e.pointerUp(ptr(50, 50));
    expect(closeRect(e.selection(), { x: 30, y: 30, w: 40, h: 40 }, 2)).toBe(true);
    e.deselect();
    e.pointerDown(ptr(15, 15)); // the red frame
    e.pointerUp(ptr(15, 15));
    expect(closeRect(e.selection(), { x: 10, y: 10, w: 80, h: 80 }, 1)).toBe(true);
    // mask target: the wand reads the mask in document space
    const m = e.addMask(id);
    e.writeSurface(m, { x: 0, y: 0, w: 10, h: 20 }, img(10, 20, () => [0, 0, 0, 255]));
    e.commitSurfaces();
    e.setPaintTarget(id, 'mask');
    e.deselect();
    e.pointerDown(ptr(15, 15));
    e.pointerUp(ptr(15, 15));
    expect(closeRect(e.selection(), { x: 10, y: 10, w: 40, h: 80 }, 2)).toBe(true);
  });

  it('maskFromSelection resamples the document selection into the layer pixels', () => {
    const id = scaled();
    e.setSelection({ x: 30, y: 30, w: 40, h: 40 });
    e.maskFromSelection(id);
    const m = info(id).mask!.slot;
    expect(maskAt(e, m, 15, 15)).toBe(255); // doc (40, 40)
    expect(maskAt(e, m, 5, 5)).toBe(0); // doc (20, 20)
    expect(maskAt(e, m, 40, 40)).toBe(0); // doc (90, 90)
    e.setLayerProps(id, { visible: true });
    e.setPaintTarget(id, 'pixels');
    e.setToolContext(brushCtx({ size: 100, hardness: 1 }));
    stroke(e, 'brush', [[50, 50]]);
    expect(ink()).toEqual({ x: 30, y: 30, w: 40, h: 40 });
  });
});

describe('transforms: applyTransform', () => {
  it('bakes scale into a bigger surface at identity scale; mask resampled; one history entry; undo restores', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(10, 10, (x) => (x < 5 ? BLUE : RED)), 10, 10, 'b');
    const slot = info(id).slot!;
    e.setTransform(id, { x: 5, y: 7, sx: 3, sy: 3 });
    const m = e.addMask(id);
    const grey = new Uint8Array(10 * 10 * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) grey.set([y < 5 ? 0 : 255, 0, 0, 255], (y * 10 + x) * 4);
    e.writeSurface(m, { x: 0, y: 0, w: 10, h: 10 }, grey);
    e.commitSurfaces();
    e.setToolContext(brushCtx({ size: 6, hardness: 1 }, { primary: rgba(0, 255, 0) }));
    e.setPaintTarget(id, 'pixels');
    stroke(e, 'brush', [[20, 30]]); // painted before the bake
    const before = Array.from(e.readComposite(docRect()));
    const ev = collect(e);
    const n = e.history().entries.length;
    e.applyTransform(id);
    expect(info(id)).toMatchObject({ surfaceW: 30, surfaceH: 30, transform: { x: 5, y: 7, sx: 1, sy: 1 }, slot, mask: { slot: m, enabled: true } });
    expect(e.history().entries).toHaveLength(n + 1);
    expect(e.history().entries.slice(-1)[0].label).toBe('Apply transform');
    expect(e.readSurface(slot, { x: 0, y: 0, w: 30, h: 30 }).length).toBe(30 * 30 * 4);
    expect(slotPx(e, slot, 5, 5)).toEqual(BLUE);
    expect(slotPx(e, slot, 25, 5)).toEqual(RED);
    expect(maskAt(e, m, 5, 5)).toBe(0); // mask resampled with the layer: top half hidden
    expect(maskAt(e, m, 5, 25)).toBe(255);
    expect(types(ev, 'surface').some((x) => x.slot === slot && x.rect.w === 30 && x.rect.h === 30)).toBe(true);
    expect(types(ev, 'surface').some((x) => x.slot === m && x.rect.w === 30)).toBe(true);
    expect(types(ev, 'docspec').length).toBeGreaterThan(0);
    // the picture is the same (up to resampling at edges)
    const after = e.readComposite(docRect());
    let bad = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const i = (y * 100 + x) * 4;
      if (Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2]) + Math.abs(after[i + 3] - before[i + 3]) > 90) bad++;
    }
    expect(bad).toBeLessThan(120);
    // further painting happens at the baked resolution
    stroke(e, 'brush', [[25, 25]]);
    expect(layerPx(e, id, 20, 18)).toEqual([0, 255, 0, 255]);
    e.undo();
    e.undo();
    expect(info(id)).toMatchObject({ surfaceW: 10, surfaceH: 10, transform: { x: 5, y: 7, sx: 3, sy: 3 } });
    expect(Array.from(e.readComposite(docRect()))).toEqual(before);
    e.undo(); // the stroke made before the bake
    expect(layerPx(e, id, 5, 8)).toEqual(RED); // layer pixel (20 - 5) / 3, (30 - 7) / 3
    expect(px(e, 12, 30)).toEqual(BLUE);
    e.redo();
    e.redo();
    expect(info(id)).toMatchObject({ surfaceW: 30, surfaceH: 30 });
  });

  it('bakes a down-scale and rounds positions to whole pixels; unit scale is a no-op', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(64, 64, () => RED), 64, 64, 'd');
    e.setTransform(id, { x: 10.5, y: 3.25, sx: 0.5, sy: 0.25 });
    e.applyTransform(id);
    expect(info(id)).toMatchObject({ surfaceW: 32, surfaceH: 16, transform: { x: 11, y: 3, sx: 1, sy: 1 } });
    expect(layerPx(e, id, 16, 8)).toEqual(RED);
    const n = e.history().entries.length;
    e.applyTransform(id);
    expect(e.history().entries.length).toBe(n);
  });

  it('refuses the TD Input, text / shape layers and locked layers', () => {
    e = newEngine(50, 50);
    const notices = noticesOf(e);
    const s = e.addShapeLayer({ type: 'ellipse', x: 0, y: 0, w: 10, h: 10, fill: { enabled: true, color: rgba(1, 2, 3) }, stroke: { enabled: false, color: rgba(0, 0, 0), width: 1 }, rotation: 0 });
    const id = e.addPixelLayer();
    e.setTransform(id, { x: 0, y: 0, sx: 2, sy: 2 });
    e.setLayerProps(id, { locked: true });
    const n = e.history().entries.length;
    e.applyTransform('base');
    e.applyTransform(s);
    e.applyTransform(id);
    e.applyTransform('nope');
    expect(e.history().entries.length).toBe(n);
    expect(notices.length).toBe(3);
    expect(info(id).transform.sx).toBe(2);
  });
});

describe('importImage: native resolution and fit transform', () => {
  it('a larger image keeps its pixels and gets a uniform fit-to-canvas scale, centred', () => {
    e = newEngine(100, 50);
    const notices = noticesOf(e);
    const id = e.importImage(img(400, 200, (x) => (x < 200 ? BLUE : RED)), 400, 200, 'big');
    expect(info(id)).toMatchObject({ surfaceW: 400, surfaceH: 200, transform: { x: 0, y: 0, sx: 0.25, sy: 0.25 } });
    expect(layerPx(e, id, 399, 199)).toEqual(RED); // no resampling: every source pixel is there
    expect(layerPx(e, id, 199, 0)).toEqual(BLUE);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/scaled/i);
    expect(px(e, 10, 25)).toEqual(BLUE);
    expect(px(e, 90, 25)).toEqual(RED);
    const tall = e.importImage(img(100, 200, () => [0, 255, 0, 255]), 100, 200, 'tall');
    expect(info(tall).transform).toEqual({ x: 38, y: 0, sx: 0.25, sy: 0.25 });
    expect(px(e, 50, 25)).toEqual([0, 255, 0, 255]);
    expect(px(e, 36, 25)[1]).not.toBe(255);
  });

  it('a smaller image stays 1:1 and centred on whole pixels', () => {
    e = newEngine(100, 80);
    const notices = noticesOf(e);
    const id = e.importImage(img(21, 10, () => RED), 21, 10, 'small');
    expect(info(id).transform).toEqual({ x: 40, y: 35, sx: 1, sy: 1 });
    expect(notices).toHaveLength(0);
    expect(px(e, 40, 35)).toEqual(RED);
    expect(px(e, 60, 44)).toEqual(RED);
    expect(px(e, 61, 44)[3]).toBe(0);
  });

  it('sides above 8192 are downscaled to 8192 with a notice', () => {
    e = newEngine(100, 100);
    const notices = noticesOf(e);
    const id = e.importImage(new Uint8ClampedArray(9000 * 4 * 4).fill(255), 9000, 4, 'wide');
    expect(info(id)).toMatchObject({ surfaceW: 8192, surfaceH: 4 });
    expect(notices.some((n) => /downscaled/i.test(n))).toBe(true);
    expect(info(id).transform.sx).toBeCloseTo(100 / 8192, 8);
  });
});

describe('move tool with transforms', () => {
  it('moves the position only, keeping the scale; one history entry; docspec announced while dragging', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(10, 10, () => RED), 10, 10, 'r');
    e.setTransform(id, { x: 10, y: 10, sx: 2, sy: 3 });
    e.setTool('move');
    const ev = collect(e);
    const n = e.history().entries.length;
    e.pointerDown(ptr(20, 20));
    e.pointerMove(ptr(30, 25));
    expect(types(ev, 'docspec').length).toBeGreaterThan(0);
    e.pointerUp(ptr(32, 27));
    expect(info(id).transform).toEqual({ x: 22, y: 17, sx: 2, sy: 3 });
    expect(e.history().entries).toHaveLength(n + 1);
    expect(e.history().entries.slice(-1)[0].label).toBe('Move');
    expect(px(e, 30, 30)).toEqual(RED);
    expect(px(e, 15, 20)[3]).toBe(0);
    e.undo();
    expect(info(id).transform).toEqual({ x: 10, y: 10, sx: 2, sy: 3 });
  });

  it('moves the TD Input although it is locked', () => {
    e = newEngine(60, 60);
    setBase(e, BLUE);
    e.setTool('move');
    e.pointerDown(ptr(5, 5));
    e.pointerUp(ptr(15, 25));
    expect(info('base').transform).toEqual({ x: 10, y: 20, sx: 1, sy: 1 });
    expect(px(e, 5, 5)[3]).toBe(0);
    expect(px(e, 20, 30)).toEqual(BLUE);
    expect(info('base').locked).toBe(true);
  });

  it('snaps the dragged bounds to guides and canvas edges within threshold / zoom', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(20, 20, () => RED), 20, 20, 'r');
    e.setTransform(id, { x: 0, y: 0, sx: 1, sy: 1 });
    e.addGuide('v', 60);
    e.setSnap({ enabled: true, guides: true, canvas: true, layers: false, threshold: 6 });
    e.setTool('move');
    e.pointerDown(ptr(5, 5));
    e.pointerUp(ptr(48, 5)); // x = 43: right edge 63 snaps to the guide at 60 -> x = 40
    expect(info(id).transform.x).toBe(40);
    e.pointerDown(ptr(5, 5));
    e.pointerUp(ptr(8, 5)); // -> x = 43 would not snap (centre 53, right 63 -> 60: dx -3)
    expect(info(id).transform.x).toBe(40);
    e.setViewZoom(4); // threshold 1.5 document px
    e.pointerDown(ptr(5, 5));
    e.pointerUp(ptr(8, 5)); // right edge 63 is 3 px from the guide: no snap
    expect(info(id).transform.x).toBe(43);
    e.setSnap({ enabled: false, guides: true, canvas: true, layers: true, threshold: 6 });
    e.setViewZoom(1);
    e.pointerDown(ptr(5, 5));
    e.pointerUp(ptr(7, 5));
    expect(info(id).transform.x).toBe(45);
  });

  it('moves text and shapes by geometry', () => {
    e = newEngine(100, 100);
    const s = e.addShapeLayer({ type: 'rect', x: 10, y: 10, w: 20, h: 20, radius: 0, fill: { enabled: true, color: rgba(255, 0, 0) }, stroke: { enabled: false, color: rgba(0, 0, 0), width: 1 }, rotation: 0 });
    e.setTool('move');
    e.pointerDown(ptr(15, 15));
    e.pointerUp(ptr(35, 25));
    expect(info(s).shape).toMatchObject({ x: 30, y: 20 });
    expect(info(s).transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
    expect(px(e, 40, 30)).toEqual(RED);
  });
});

describe('docSpec / loadDocument with transforms', () => {
  it('round-trips transforms, per-surface sizes, masks, guides and canvas mode', () => {
    e = newEngine(120, 90);
    const a = e.importImage(img(30, 20, () => RED), 30, 20, 'a');
    e.setTransform(a, { x: 7.5, y: -3, sx: 2.5, sy: 0.5 });
    const am = e.addMask(a);
    const b = e.addPixelLayer();
    e.setTransform(b, { x: 1, y: 2, sx: 1, sy: 1 });
    e.addGuide('h', 33);
    e.addGuide('v', 44.5);
    e.setCanvasSize(120, 90, 'tl');
    e.setBaseSize(40, 30);
    e.setTransform('base', { x: 5, y: 6, sx: 3, sy: 3 });
    const spec = JSON.parse(JSON.stringify(e.docSpec()));
    expect(spec.layers.find((l: { id: string }) => l.id === a)).toMatchObject({ x: 8, y: -3, sx: 2.5, sy: 0.5, surfaceW: 30, surfaceH: 20 });
    expect(spec.layers[0]).toMatchObject({ surfaceW: 40, surfaceH: 30, x: 5, sx: 3 });
    expect(spec.guides).toEqual({ h: [33], v: [44.5] });
    expect(spec.canvas).toEqual({ mode: 'fixed' });
    const e2 = newEngine(10, 10);
    e2.loadDocument(spec);
    expect(e2.docSpec().layers).toEqual(spec.layers);
    expect(e2.docSpec().guides).toEqual(spec.guides);
    expect(e2.docSpec().canvas).toEqual(spec.canvas);
    expect(e2.guides()).toEqual({ h: [33], v: [44.5] });
    expect(e2.canvasMode()).toBe('fixed');
    expect(e2.surfaceSlots().sort()).toEqual(e.surfaceSlots().sort());
    expect(e2.readSurface(am, { x: 0, y: 0, w: 30, h: 20 }).length).toBe(30 * 20 * 4);
    expect(e2.readSurface(am, { x: 29, y: 19, w: 1, h: 1 })[0]).toBe(255); // masks start fully visible
    // pixel data arrives through writeSurface at the surface size, then the picture matches
    e2.writeSurface(slotOf(e, a), { x: 0, y: 0, w: 30, h: 20 }, e.readSurface(slotOf(e, a), { x: 0, y: 0, w: 30, h: 20 }));
    e2.commitSurfaces();
    expect(Array.from(e2.readComposite({ x: 0, y: 0, w: 120, h: 90 }))).toEqual(Array.from(e.readComposite({ x: 0, y: 0, w: 120, h: 90 })));
    e2.dispose();
  });

  it('keeps the TD Input surface when its size is unchanged and does not refit it afterwards', () => {
    e = newEngine(100, 100);
    setBase(e, BLUE);
    const spec = e.docSpec();
    e.loadDocument(spec);
    expect(px(e, 50, 50)).toEqual(BLUE);
    e.setCanvasSize(50, 50, 'tl');
    e.loadDocument({ ...spec, width: 50, height: 50 });
    e.setBaseSize(300, 300); // base placement comes from the document after a load
    expect(info('base').transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
  });

  it('validates scales, surface sizes, guides and the canvas mode', () => {
    e = newEngine(30, 30);
    e.addPixelLayer();
    const good = JSON.parse(JSON.stringify(e.docSpec()));
    const bad = (f: (s: typeof good) => void): void => {
      const s = JSON.parse(JSON.stringify(good));
      f(s);
      expect(() => e.loadDocument(s)).toThrow(RangeError);
    };
    bad((s) => { s.layers[1].sx = 0; });
    bad((s) => { s.layers[1].sy = -2; });
    bad((s) => { s.layers[1].sx = null; });
    bad((s) => { s.layers[1].x = Infinity; });
    bad((s) => { s.layers[1].surfaceW = null; });
    bad((s) => { s.layers[1].surfaceH = 0; });
    bad((s) => { s.layers[1].surfaceW = 12.5; });
    bad((s) => { s.layers[1].surfaceW = 20000; });
    bad((s) => { s.layers[0].surfaceW = null; });
    bad((s) => { s.guides = { h: ['a'], v: [] }; });
    bad((s) => { s.guides = { h: [], v: [NaN] }; });
    bad((s) => { s.guides = null; });
    bad((s) => { s.canvas = { mode: 'weird' }; });
    expect(e.layers()).toHaveLength(2); // a rejected load changes nothing
    const ok = JSON.parse(JSON.stringify(good));
    delete ok.guides;
    delete ok.canvas;
    e.loadDocument(ok); // guides / canvas are optional on load
    expect(e.guides()).toEqual({ h: [], v: [] });
    expect(e.canvasMode()).toBe('input');
  });

  it('writeSurface / readSurface use each surface\'s own size', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(8, 4, () => RED), 8, 4, 'r');
    const slot = info(id).slot!;
    e.setTransform(id, { x: 10, y: 10, sx: 5, sy: 5 });
    expect(e.readSurface(slot, { x: 0, y: 0, w: 8, h: 4 }).length).toBe(8 * 4 * 4);
    expect(e.readSurface(slot, { x: 6, y: 3, w: 4, h: 4 }).slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
    expect(e.readSurface(slot, { x: 8, y: 0, w: 1, h: 1 })[3]).toBe(0); // outside the surface
    const ev = collect(e);
    e.writeSurface(slot, { x: 0, y: 0, w: 2, h: 1 }, img(2, 1, () => BLUE));
    e.writeSurface(slot, { x: 7, y: 3, w: 4, h: 4 }, img(4, 4, () => BLUE)); // clipped to the surface
    e.commitSurfaces();
    expect(types(ev, 'surface').map((x) => x.rect)).toEqual([{ x: 0, y: 0, w: 2, h: 1 }, { x: 7, y: 3, w: 1, h: 1 }]);
    expect(px(e, 12, 12)).toEqual(BLUE); // layer (0,0) lands at doc (10..14)
    expect(px(e, 47, 27)).toEqual(BLUE);
    const pix = types(ev, 'pixels').map((x) => x.rect);
    expect(pix.length).toBeGreaterThan(0);
    for (const r of pix) expect(r.w * r.h).toBeLessThan(60 * 40);
  });
});

describe('review regressions', () => {
  it('history never restores a stale base surface (the TD Input resolution is not history)', () => {
    e = newEngine(100, 100);
    e.setTransform('base', { x: 5, y: 5, sx: 2, sy: 2 });
    e.setBaseSize(50, 40);
    e.writeBase({ x: 0, y: 0, w: 50, h: 40 }, img(50, 40, () => BLUE));
    e.commitBase();
    e.setTransform('base', { x: 6, y: 6, sx: 2, sy: 2 });
    e.undo();
    e.undo();
    expect(e.docSpec().layers[0]).toMatchObject({ surfaceW: 50, surfaceH: 40, x: 0, sx: 1 });
    expect(px(e, 10, 10)).toEqual(BLUE);
    e.redo();
    e.redo();
    expect(e.docSpec().layers[0]).toMatchObject({ surfaceW: 50, surfaceH: 40, x: 6 });
    // and a layer deletion undo does not touch it either
    const id = e.addPixelLayer();
    e.deleteLayer(id);
    e.undo();
    expect(e.docSpec().layers[0]).toMatchObject({ surfaceW: 50, surfaceH: 40 });
  });

  it('setLayerBox on a pure move keeps sx / sy exactly; load rejects oversized surfaces', () => {
    e = newEngine(100, 100);
    const id = e.importImage(img(30, 30, () => RED), 30, 30, 'r');
    e.setTransform(id, { x: 0, y: 0, sx: 1 / 3, sy: 0.7 });
    for (let i = 1; i < 6; i++) {
      const b = e.layerBounds(id) as Rect;
      e.setLayerBox(id, { x: b.x + 1, y: b.y, w: b.w, h: b.h });
    }
    expect(info(id).transform).toEqual({ x: 5, y: 0, sx: 1 / 3, sy: 0.7 });
    const spec = JSON.parse(JSON.stringify(e.docSpec()));
    spec.layers[1].surfaceW = 16000;
    spec.layers[1].surfaceH = 16000;
    expect(() => e.loadDocument(spec)).toThrow(RangeError);
  });

  it('strokes on a large layer use a window, not a layer-sized buffer; undo and redo are exact', () => {
    e = newEngine(100, 100);
    const id = e.importImage(new Uint8ClampedArray(4096 * 4096 * 4).fill(255), 4096, 4096, 'huge');
    e.setToolContext(brushCtx({ size: 40, hardness: 1 }));
    stroke(e, 'brush', [[10, 10], [90, 60], [20, 90]]);
    expect(px(e, 50, 35)[0]).toBeLessThan(40);
    expect(layerPx(e, id, 4000, 200)).toEqual([255, 255, 255, 255]); // far from the stroke
    expect(layerPx(e, id, 2048, 1433)[0]).toBeLessThan(40);
    e.undo();
    expect(px(e, 50, 35)).toEqual([255, 255, 255, 255]);
    e.redo();
    expect(px(e, 50, 35)[0]).toBeLessThan(40);
  });
});
