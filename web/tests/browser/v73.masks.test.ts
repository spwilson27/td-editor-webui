import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine';
import type { Effect } from '../../src/engine/types';
import { brushCtx, drawRect, newEngine, px, setBase, solid, stroke } from './engineTestUtils';

// v7.3: layer masks on groups (document sized) and on TD input layers (input surface size, layer space).
const engines: Engine[] = [];
const mk = (w = 40, h = 40): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });

const fx = (type: string, o: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...o }) as unknown as Effect;
const info = (e: Engine, id: string) => e.layers().find((l) => l.id === id)!;
const maskOf = (e: Engine, id: string): number => info(e, id).mask!.slot;
const mval = (e: Engine, slot: number, x: number, y: number): number => e.readSurface(slot, { x, y, w: 1, h: 1 })[0];
const near = (a: number[], b: number[], tol = 3): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Write a grey mask: value `f(x, y)` over the whole w x h surface. */
function paintMask(e: Engine, slot: number, w: number, h: number, f: (x: number, y: number) => number): void {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y); d.set([v, v, v, 255], (y * w + x) * 4); }
  e.writeSurface(slot, { x: 0, y: 0, w, h }, d);
  e.commitSurfaces();
}

/** Doc 40x40 with a grey (100) pixel layer at the bottom; returns a group above it holding `kids` (bottom first). */
function groupOver(e: Engine, kids: string[]): string {
  const g = e.groupLayers(kids, 'G');
  return g;
}

describe('v7.3 group masks', () => {
  it('addMask on a group makes a doc-sized white mask; it masks the composite before opacity / blend', () => {
    const e = mk();
    const bg = e.addPixelLayer('bg');
    drawRect(e, bg, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(100,100,100)');
    const red = e.addPixelLayer('red');
    drawRect(e, red, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(255,0,0)');
    const g = groupOver(e, [red]);
    const slot = e.addMask(g);
    expect(slot).toBeGreaterThan(0);
    expect(info(e, g).mask).toEqual({ slot, enabled: true });
    expect(e.docSpec().layers.find((l) => l.id === g)!.mask).toEqual({ slot, enabled: true });
    expect(e.surfaceSlots()).toContain(slot);
    expect(px(e, 5, 5)).toEqual([255, 0, 0, 255]);
    paintMask(e, slot, 40, 40, (x) => (x < 20 ? 0 : x < 30 ? 128 : 255));
    expect(px(e, 5, 5)).toEqual([100, 100, 100, 255]);
    expect(near(px(e, 25, 5), [178, 50, 50, 255], 3)).toBe(true); // 50% red over grey
    expect(px(e, 35, 5)).toEqual([255, 0, 0, 255]);
    e.setLayerProps(g, { opacity: 0.5 }); // mask first, then opacity
    expect(near(px(e, 35, 5), [178, 50, 50, 255], 3)).toBe(true);
    e.setMaskEnabled(g, false);
    expect(near(px(e, 5, 5), [178, 50, 50, 255], 3)).toBe(true);
    e.setMaskEnabled(g, true);
    expect(px(e, 5, 5)).toEqual([100, 100, 100, 255]);
    e.deleteMask(g);
    expect(info(e, g).mask).toBeNull();
    expect(near(px(e, 5, 5), [178, 50, 50, 255], 3)).toBe(true);
  });

  it('a blend-mode child blends inside the (isolated) masked group, not against the layers below', () => {
    const e = mk();
    const bg = e.addPixelLayer('bg');
    drawRect(e, bg, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(100,100,100)');
    const a = e.addPixelLayer('a');
    drawRect(e, a, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(200,200,200)');
    const m = e.addPixelLayer('m');
    drawRect(e, m, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(128,128,255)');
    e.setLayerProps(m, { blend: 'multiply' });
    const g = e.groupLayers([a, m], 'G');
    const before = px(e, 30, 5);
    paintMask(e, e.addMask(g), 40, 40, (x) => (x < 20 ? 0 : 255));
    expect(px(e, 5, 5)).toEqual([100, 100, 100, 255]);
    expect(near(px(e, 30, 5), before, 1)).toBe(true); // inside the visible part the result equals the unmasked group
    expect(near(px(e, 30, 5), [100, 100, 200, 255], 3)).toBe(true); // 200 * (128,128,255): multiply against the group content only
  });

  it('mask comes before group effects (the effect sees the masked content)', () => {
    const e = mk();
    const bg = e.addPixelLayer('bg');
    drawRect(e, bg, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(200,200,200)');
    const red = e.addPixelLayer('red');
    drawRect(e, red, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(255,0,0)');
    const g = e.groupLayers([red], 'G');
    paintMask(e, e.addMask(g), 40, 40, (x) => (x < 20 ? 0 : 255));
    e.setEffects(g, [fx('dropShadow', { dx: -8, dy: 0, blur: 0, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 1 })]);
    // The shadow of the masked content (x >= 20) lands at x in [12, 20): visible only if the mask came before the effect.
    expect(near(px(e, 14, 20), [0, 0, 0, 255], 8)).toBe(true);
    expect(px(e, 5, 20)).toEqual([200, 200, 200, 255]);
    expect(px(e, 30, 20)).toEqual([255, 0, 0, 255]);
  });

  it('paints, fills (selection to mask) and undoes on a group mask in mask edit mode', () => {
    const e = mk();
    const bg = e.addPixelLayer('bg');
    drawRect(e, bg, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(100,100,100)');
    const red = e.addPixelLayer('red');
    drawRect(e, red, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(255,0,0)');
    const g = e.groupLayers([red], 'G');
    const slot = e.addMask(g);
    e.setPaintTarget(g, 'mask');
    expect(e.paintTarget()).toEqual({ layerId: g, target: 'mask' });
    e.setToolContext(brushCtx({ size: 12 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    stroke(e, 'brush', [[20, 20]]);
    expect(mval(e, slot, 20, 20)).toBe(0);
    expect(px(e, 20, 20)).toEqual([100, 100, 100, 255]);
    expect(px(e, 2, 2)).toEqual([255, 0, 0, 255]);
    e.undo();
    expect(mval(e, slot, 20, 20)).toBe(255);
    expect(px(e, 20, 20)).toEqual([255, 0, 0, 255]);
    e.redo();
    expect(mval(e, slot, 20, 20)).toBe(0);
    // fill bucket on the mask (white) restores visibility
    e.setToolContext(brushCtx({}, { primary: { r: 255, g: 255, b: 255, a: 255 }, fillTolerance: 255 }));
    stroke(e, 'fill', [[2, 2]]);
    expect(mval(e, slot, 20, 20)).toBe(255);
    expect(px(e, 20, 20)).toEqual([255, 0, 0, 255]);
    // selection -> mask on a group without a mask
    const g2 = e.groupLayers([bg], 'G2');
    stroke(e, 'marquee', [[0, 0], [10, 10]]);
    e.maskFromSelection(g2);
    const s2 = maskOf(e, g2);
    expect(mval(e, s2, 5, 5)).toBe(255);
    expect(mval(e, s2, 30, 30)).toBe(0);
    e.undo();
    expect(info(e, g2).mask).toBeNull();
  });

  it('copy / paste / duplicate carry a group mask (an independent copy)', () => {
    const e = mk();
    const red = e.addPixelLayer('red');
    drawRect(e, red, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(255,0,0)');
    const g = e.groupLayers([red], 'G');
    const slot = e.addMask(g);
    paintMask(e, slot, 40, 40, (x) => (x < 20 ? 0 : 255));
    const clip = e.copyLayers([g]);
    const [n] = e.pasteLayers(clip, null, 0);
    const m = info(e, n).mask!;
    expect(m.slot).not.toBe(slot);
    expect(mval(e, m.slot, 5, 5)).toBe(0);
    expect(mval(e, m.slot, 30, 5)).toBe(255);
    paintMask(e, m.slot, 40, 40, () => 255);
    expect(mval(e, slot, 5, 5)).toBe(0);
    const [d] = e.duplicateLayers([g]);
    const dm = info(e, d).mask!;
    expect(dm.slot).not.toBe(slot);
    expect(mval(e, dm.slot, 5, 5)).toBe(0);
  });

  it('survives docSpec -> loadDocument and history serialisation round trips', () => {
    const e = mk();
    const bg = e.addPixelLayer('bg');
    drawRect(e, bg, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(100,100,100)');
    const red = e.addPixelLayer('red');
    drawRect(e, red, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(255,0,0)');
    const g = e.groupLayers([red], 'G');
    const slot = e.addMask(g);
    e.setPaintTarget(g, 'mask');
    e.setToolContext(brushCtx({ size: 12 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    stroke(e, 'brush', [[10, 10], [30, 30]]);
    const want = Array.from(e.readComposite({ x: 0, y: 0, w: 40, h: 40 }));
    e.undo(); e.undo(); e.redo(); e.redo(); // direct undo / redo first
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: 40, h: 40 }))).toEqual(want);
    const blob = e.serializeHistory(100, 64 << 20);
    const spec = e.docSpec();
    const f = mk();
    f.loadDocument(spec);
    for (const s of e.surfaceSlots()) {
      const sp = spec.layers.find((l) => l.slot === s || l.mask?.slot === s)!;
      const w = sp.slot === s ? sp.surfaceW ?? 40 : sp.surfaceW ?? 40;
      const h = sp.slot === s ? sp.surfaceH ?? 40 : sp.surfaceH ?? 40;
      f.writeSurface(s, { x: 0, y: 0, w, h }, e.readSurface(s, { x: 0, y: 0, w, h }));
    }
    f.commitSurfaces();
    f.flush();
    expect(f.layers().find((l) => l.id === g)!.mask).toEqual({ slot, enabled: true });
    expect(Array.from(f.readComposite({ x: 0, y: 0, w: 40, h: 40 }))).toEqual(want);
    expect(f.restoreHistory(blob, spec.rev)).toBe(true);
    f.undo(); // the stroke
    expect(mval(f, slot, 20, 20)).toBe(255);
    f.undo(); // add mask
    expect(f.layers().find((l) => l.id === g)!.mask).toBeNull();
    f.redo();
    f.redo();
    expect(mval(f, slot, 20, 20)).toBe(0);
    expect(Array.from(f.readComposite({ x: 0, y: 0, w: 40, h: 40 }))).toEqual(want);
  });

  it('a canvas resize reframes the group mask', () => {
    const e = mk();
    const red = e.addPixelLayer('red');
    drawRect(e, red, { x: 0, y: 0, w: 40, h: 40 }, 'rgb(255,0,0)');
    const g = e.groupLayers([red], 'G');
    const slot = e.addMask(g);
    paintMask(e, slot, 40, 40, (x) => (x < 20 ? 0 : 255));
    e.setCanvasSize(60, 40, 'tr'); // content moves +20 in x
    expect(mval(e, slot, 5, 5)).toBe(255); // new area is fully visible
    expect(mval(e, slot, 30, 5)).toBe(0);
    expect(mval(e, slot, 50, 5)).toBe(255);
  });
});

describe('v7.3 input masks', () => {
  const info1 = (w: number, h: number) => [{ input: 1, w, h, connected: true }];

  it('masks an input layer in its own space and follows its transform', () => {
    const e = mk();
    e.writeInput(1, { x: 0, y: 0, w: 40, h: 40 }, solid(40, 40, [10, 200, 30, 255]));
    e.commitInput(1);
    const slot = e.addMask('base');
    expect(slot).toBeGreaterThan(0);
    expect(e.docSpec().layers.find((l) => l.id === 'base')!.mask).toEqual({ slot, enabled: true });
    expect(e.docSpec().layers.find((l) => l.id === 'base')!.surfaceW).toBe(40);
    paintMask(e, slot, 40, 40, (x) => (x < 20 ? 0 : 255));
    expect(px(e, 5, 20)[3]).toBe(0);
    expect(px(e, 30, 20)).toEqual([10, 200, 30, 255]);
    e.setTransform('base', { x: 10, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 }); // mask follows the move
    expect(px(e, 25, 20)[3]).toBe(0);
    expect(px(e, 35, 20)).toEqual([10, 200, 30, 255]);
    e.setTransform('base', { x: 0, y: 0, sx: 0.5, sy: 0.5, rot: 0, kx: 0, ky: 0 }); // and scale
    expect(px(e, 5, 5)[3]).toBe(0); // surface x in [0, 20) -> doc [0, 10)
    expect(px(e, 15, 5)).toEqual([10, 200, 30, 255]);
    e.setMaskEnabled('base', false);
    expect(px(e, 5, 5)).toEqual([10, 200, 30, 255]);
    e.deleteMask('base');
    expect(info(e, 'base').mask).toBeNull();
  });

  it('the input stays unpaintable, its mask is paintable; undo/redo', () => {
    const e = mk();
    e.writeInput(1, { x: 0, y: 0, w: 40, h: 40 }, solid(40, 40, [10, 200, 30, 255]));
    e.commitInput(1);
    const slot = e.addMask('base');
    e.setToolContext(brushCtx({ size: 10 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    stroke(e, 'brush', [[20, 20]]);
    expect(px(e, 20, 20)).toEqual([10, 200, 30, 255]); // the pixels were not painted
    e.setPaintTarget('base', 'mask');
    stroke(e, 'brush', [[20, 20]]);
    expect(mval(e, slot, 20, 20)).toBe(0);
    expect(px(e, 20, 20)[3]).toBe(0);
    e.undo();
    expect(mval(e, slot, 20, 20)).toBe(255);
    expect(px(e, 20, 20)).toEqual([10, 200, 30, 255]);
    e.redo();
    expect(px(e, 20, 20)[3]).toBe(0);
    stroke(e, 'marquee', [[0, 0], [8, 8]]);
    e.deleteMask('base');
    e.maskFromSelection('base');
    expect(mval(e, maskOf(e, 'base'), 4, 4)).toBe(255);
    expect(mval(e, maskOf(e, 'base'), 30, 30)).toBe(0);
  });

  it('when the input changes resolution the mask keeps its pixels, stretched to the new size', () => {
    const e = mk();
    e.setCanvasMode('fixed');
    e.setInputs(info1(40, 40));
    e.writeInput(1, { x: 0, y: 0, w: 40, h: 40 }, solid(40, 40, [10, 200, 30, 255]));
    e.commitInput(1);
    const slot = e.addMask('base');
    paintMask(e, slot, 40, 40, (x) => (x < 20 ? 0 : 255));
    e.setInputs(info1(80, 60));
    expect(info(e, 'base').surfaceW).toBe(80);
    expect(info(e, 'base').surfaceH).toBe(60);
    expect(e.readSurface(slot, { x: 0, y: 0, w: 80, h: 60 }).length).toBe(80 * 60 * 4);
    expect(mval(e, slot, 10, 30)).toBe(0);
    expect(mval(e, slot, 70, 30)).toBe(255);
    expect(Math.abs(mval(e, slot, 38, 5) - 0)).toBeLessThan(40); // the edge stays at the same normalised position
    expect(Math.abs(mval(e, slot, 42, 5) - 255)).toBeLessThan(40);
    // a disconnected input keeps its mask
    e.setInputs([{ input: 1, w: 80, h: 60, connected: false }]);
    expect(info(e, 'base').mask).toEqual({ slot, enabled: true });
  });

  it('effects see the masked input; the fx thumbnail applies the mask', async () => {
    const e = mk();
    setBase(e, [10, 200, 30, 255]);
    const slot = e.addMask('base');
    paintMask(e, slot, 40, 40, (x) => (x < 20 ? 0 : 255));
    e.setEffects('base', [fx('dropShadow', { dx: -8, dy: 0, blur: 0, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 1 })]);
    expect(near(px(e, 14, 20), [0, 0, 0, 255], 8)).toBe(true); // shadow of the masked content
    expect(px(e, 5, 20)[3]).toBe(0);
    const c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    e.drawThumbnail('base', c);
    await (e as unknown as { thumbnailsSettled(): Promise<void> }).thumbnailsSettled();
    e.drawThumbnail('base', c);
    const d = c.getContext('2d')!.getImageData(0, 0, 40, 40).data;
    const a = (x: number, y: number) => d[(y * 40 + x) * 4 + 3];
    expect(a(3, 20)).toBe(0);
    expect(a(35, 20)).toBe(255);
  });
});
