import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { EngineEvent } from '../../src/engine/types';
import { brushCtx, collect, layerPx, maskAt, near, newEngine, px, rgba, setBase, slotOf, slotPx, solidLayer, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

/** 40x40 doc, grey base 100, red layer on top with a mask; mask is the paint target. */
function setup(maskTarget = true): { id: string; slot: number } {
  e = newEngine(40, 40);
  setBase(e, [100, 100, 100, 255]);
  const id = solidLayer(e, 'rgb(255,0,0)');
  const slot = e.addMask(id);
  if (maskTarget) e.setPaintTarget(id, 'mask');
  return { id, slot };
}

describe('masks: creation and bookkeeping', () => {
  it('addMask makes a fully visible mask with a fresh slot and records history', () => {
    const { id, slot } = setup(false);
    expect(slot).toBeGreaterThan(0);
    expect(slot).not.toBe(slotOf(e, id));
    expect(slotPx(e, slot, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(e.layers()[0].mask).toEqual({ slot, enabled: true });
    expect(px(e, 3, 3)).toEqual([255, 0, 0, 255]);
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Add mask');
    expect(e.addMask(id)).toBe(slot); // idempotent
  });

  it('allows masks on the input; refuses groups and unknown layers', () => {
    e = newEngine(10, 10);
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    const g = e.addGroup();
    expect(e.addMask('base')).toBeGreaterThanOrEqual(0);
    expect(e.addMask(g)).toBe(-1);
    expect(e.addMask('nope')).toBe(-1);
    expect(notices).toHaveLength(2);
  });

  it('setPaintTarget makes the layer active; unknown masks fall back to pixels with a notice', () => {
    const { id } = setup(false);
    const other = e.addPixelLayer();
    expect(e.paintTarget()).toEqual({ layerId: other, target: 'pixels' });
    e.setPaintTarget(id, 'mask');
    expect(e.paintTarget()).toEqual({ layerId: id, target: 'mask' });
    expect(e.activeLayerId()).toBe(id);
    e.setActiveLayer(other);
    expect(e.paintTarget()).toEqual({ layerId: other, target: 'pixels' });
    e.setActiveLayer(id);
    expect(e.paintTarget().target).toBe('mask'); // the target sticks to its layer
    e.setPaintTarget(id, 'pixels');
    expect(e.paintTarget().target).toBe('pixels');
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    e.setPaintTarget(other, 'mask');
    expect(notices).toEqual(['Layer has no mask']);
    expect(e.paintTarget()).toEqual({ layerId: other, target: 'pixels' });
    e.setPaintTarget('nope', 'mask');
    e.setPaintTarget('base', 'pixels');
    expect(e.activeLayerId()).toBe('base');
  });

  it('deleteMask removes it (undo restores painted content and the same slot)', () => {
    const { id, slot } = setup();
    e.setToolContext(brushCtx({ size: 20 }));
    stroke(e, 'brush', [[20, 20]]);
    expect(maskAt(e, slot, 20, 20)).toBe(0);
    e.deleteMask(id);
    expect(e.layers()[0].mask).toBeNull();
    expect(px(e, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(e.paintTarget().target).toBe('pixels');
    e.undo();
    expect(e.layers()[0].mask).toEqual({ slot, enabled: true });
    expect(maskAt(e, slot, 20, 20)).toBe(0);
    expect(px(e, 20, 20)).toEqual([100, 100, 100, 255]);
    e.redo();
    expect(e.layers()[0].mask).toBeNull();
    e.deleteMask(id); // no-op
    e.deleteMask('nope');
  });

  it('enable / disable', () => {
    const { id, slot } = setup();
    e.setToolContext(brushCtx({ size: 20 }));
    stroke(e, 'brush', [[20, 20]]);
    e.setMaskEnabled(id, false);
    expect(e.layers()[0].mask).toEqual({ slot, enabled: false });
    expect(px(e, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(maskAt(e, slot, 20, 20)).toBe(0); // data kept
    e.setMaskEnabled(id, false); // no-op
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Disable mask');
    e.setMaskEnabled(id, true);
    expect(px(e, 20, 20)).toEqual([100, 100, 100, 255]);
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Enable mask');
    e.undo();
    expect(px(e, 20, 20)).toEqual([255, 0, 0, 255]);
  });
});

describe('masks: painting', () => {
  it('a black brush hides, a white brush reveals again', () => {
    const { slot } = setup();
    e.setToolContext(brushCtx({ size: 12 }));
    stroke(e, 'brush', [[10, 10], [30, 10]]);
    expect(maskAt(e, slot, 20, 10)).toBe(0);
    expect(px(e, 20, 10)).toEqual([100, 100, 100, 255]);
    expect(px(e, 20, 30)).toEqual([255, 0, 0, 255]);
    e.setToolContext(brushCtx({ size: 12 }, { primary: rgba(255, 255, 255) }));
    stroke(e, 'brush', [[10, 10], [30, 10]]);
    expect(maskAt(e, slot, 20, 10)).toBe(255);
    expect(px(e, 20, 10)).toEqual([255, 0, 0, 255]);
    expect(layerPx(e, e.activeLayerId() as string, 20, 10)).toEqual([255, 0, 0, 255]); // the pixels were never touched
  });

  it('grey paints the colour luminance (Rec.709), opacity lerps towards it', () => {
    const { slot } = setup();
    e.setToolContext(brushCtx({ size: 10 }, { primary: rgba(128, 128, 128) }));
    stroke(e, 'brush', [[10, 10]]);
    expect(Math.abs(maskAt(e, slot, 10, 10) - 128)).toBeLessThanOrEqual(1);
    // pure red has luminance 0.2126 * 255 = 54
    e.setToolContext(brushCtx({ size: 10 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'brush', [[30, 30]]);
    expect(Math.abs(maskAt(e, slot, 30, 30) - 54)).toBeLessThanOrEqual(1);
    // half opacity black over white -> ~128
    e.setToolContext(brushCtx({ size: 10, opacity: 0.5 }));
    stroke(e, 'brush', [[10, 30]]);
    expect(Math.abs(maskAt(e, slot, 10, 30) - 128)).toBeLessThanOrEqual(2);
    // and again over that: 128 * 0.5 = 64
    stroke(e, 'brush', [[10, 30]]);
    expect(Math.abs(maskAt(e, slot, 10, 30) - 64)).toBeLessThanOrEqual(3);
  });

  it('pencil and a soft brush work on masks', () => {
    const { slot } = setup();
    e.setToolContext(brushCtx({ size: 3 }));
    stroke(e, 'pencil', [[5, 5], [15, 5]]);
    expect(maskAt(e, slot, 10, 5)).toBe(0);
    expect(maskAt(e, slot, 10, 9)).toBe(255);
    e.setToolContext(brushCtx({ size: 20, hardness: 0 }));
    stroke(e, 'brush', [[30, 30]]);
    const centre = maskAt(e, slot, 30, 30);
    const edge = maskAt(e, slot, 38, 30);
    expect(centre).toBeLessThan(30);
    expect(edge).toBeGreaterThan(centre);
  });

  it('the eraser paints black (hides) on a mask and never touches the pixels', () => {
    const { id, slot } = setup();
    e.setToolContext(brushCtx({ size: 12 }, { primary: rgba(255, 255, 255) }));
    stroke(e, 'eraser', [[20, 20]]);
    expect(maskAt(e, slot, 20, 20)).toBe(0);
    expect(layerPx(e, id, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(px(e, 20, 20)).toEqual([100, 100, 100, 255]);
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Eraser');
  });

  it('fill uses the luminance of the colour inside the flood region', () => {
    const { slot } = setup();
    e.setToolContext(brushCtx({ size: 8 }));
    stroke(e, 'pencil', [[0, 20], [39, 20]]); // black line splits the mask
    e.setToolContext(brushCtx({}, { primary: rgba(128, 128, 128) }));
    stroke(e, 'fill', [[5, 5]]);
    expect(Math.abs(maskAt(e, slot, 5, 5) - 128)).toBeLessThanOrEqual(1);
    expect(maskAt(e, slot, 39, 0)).toBeGreaterThanOrEqual(127);
    expect(maskAt(e, slot, 5, 35)).toBe(255); // other side untouched
    expect(maskAt(e, slot, 5, 20)).toBe(0);
    expect(near(px(e, 5, 5).slice(0, 3), [100 + (255 - 100) * 0.5 | 0, 100 * 0.5 | 0 + 50, 50], 60)).toBe(true);
    e.undo();
    expect(maskAt(e, slot, 5, 5)).toBe(255);
    e.redo();
    expect(Math.abs(maskAt(e, slot, 5, 5) - 128)).toBeLessThanOrEqual(1);
  });

  it('fill with black hides, with a colour alpha lerps', () => {
    const { slot } = setup();
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 0, 128) }));
    stroke(e, 'fill', [[5, 5]]);
    expect(Math.abs(maskAt(e, slot, 5, 5) - 127)).toBeLessThanOrEqual(2);
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 0), fillTolerance: 255 }));
    stroke(e, 'fill', [[5, 5]]);
    expect(maskAt(e, slot, 39, 39)).toBe(0);
  });

  it('gradient maps primary -> secondary luminance onto the mask', () => {
    const { slot } = setup();
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 0), secondary: rgba(255, 255, 255) }));
    stroke(e, 'gradient', [[0, 20], [39, 20]]);
    expect(maskAt(e, slot, 0, 20)).toBeLessThanOrEqual(8);
    expect(maskAt(e, slot, 39, 20)).toBeGreaterThanOrEqual(247);
    expect(Math.abs(maskAt(e, slot, 20, 20) - 128)).toBeLessThanOrEqual(10);
    e.undo();
    expect(maskAt(e, slot, 0, 20)).toBe(255);
  });

  it('respects the selection and undo/redo', () => {
    const { slot } = setup();
    e.setToolContext(brushCtx({ size: 40 }));
    e.setSelection({ x: 0, y: 0, w: 20, h: 40 });
    stroke(e, 'brush', [[20, 20]]);
    expect(maskAt(e, slot, 10, 20)).toBe(0);
    expect(maskAt(e, slot, 30, 20)).toBe(255);
    e.undo();
    expect(maskAt(e, slot, 10, 20)).toBe(255);
    e.redo();
    expect(maskAt(e, slot, 10, 20)).toBe(0);
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Brush');
  });

  it('masks follow the layer when it is moved, and painting honours the offset', () => {
    const { id, slot } = setup(false);
    e.setPaintTarget(id, 'pixels');
    e.setTool('move');
    e.pointerDown({ x: 5, y: 5, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerMove({ x: 15, y: 5, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerUp({ x: 15, y: 5, pressure: 1, shift: false, alt: false, ctrl: false });
    expect(e.docSpec().layers.find((l) => l.id === id)).toMatchObject({ x: 10, y: 0 });
    e.setPaintTarget(id, 'mask');
    e.setToolContext(brushCtx({ size: 10 }));
    stroke(e, 'brush', [[30, 20]]); // document (30,20) = mask (20,20)
    expect(maskAt(e, slot, 20, 20)).toBe(0);
    expect(maskAt(e, slot, 30, 20)).toBe(255);
    expect(px(e, 30, 20)).toEqual([100, 100, 100, 255]);
    expect(px(e, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(px(e, 5, 20)).toEqual([100, 100, 100, 255]); // outside the moved layer
  });

  it('refuses locked, hidden and group targets and adjustment pixels', () => {
    const { id } = setup();
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    e.setToolContext(brushCtx());
    e.setLayerProps(id, { locked: true });
    stroke(e, 'brush', [[10, 10]]);
    e.setLayerProps(id, { locked: false, visible: false });
    stroke(e, 'brush', [[10, 10]]);
    e.setLayerProps(id, { visible: true });
    const a = e.addAdjustment('invert');
    stroke(e, 'brush', [[10, 10]]);
    e.setActiveLayer(e.addGroup());
    stroke(e, 'brush', [[10, 10]]);
    expect(notices).toEqual(['Layer is locked', 'Layer is hidden', 'Select a pixel layer or a mask', 'Select a pixel layer']);
    expect(a).toBeTruthy();
  });

  it('adjustment layers can be painted through their mask', () => {
    e = newEngine(30, 30);
    setBase(e, [200, 50, 0, 255]);
    const a = e.addAdjustment('invert');
    const slot = e.addMask(a);
    e.setPaintTarget(a, 'mask');
    expect(px(e, 5, 5)).toEqual([55, 205, 255, 255]);
    e.setToolContext(brushCtx({ size: 10 }));
    stroke(e, 'brush', [[15, 15]]);
    expect(maskAt(e, slot, 15, 15)).toBe(0);
    expect(px(e, 15, 15)).toEqual([200, 50, 0, 255]); // invert masked out
    expect(px(e, 2, 2)).toEqual([55, 205, 255, 255]);
  });
});

describe('masks: compositing', () => {
  it('opacity and mask multiply', () => {
    const { id, slot } = setup();
    e.setToolContext(brushCtx({ size: 20 }, { primary: rgba(128, 128, 128) }));
    stroke(e, 'brush', [[20, 20]]); // mask ~128 in the middle
    e.setLayerProps(id, { opacity: 0.5 });
    const m = maskAt(e, slot, 20, 20) / 255;
    const k = 0.5 * m;
    const got = px(e, 20, 20);
    expect(near(got, [Math.round(100 + 155 * k), Math.round(100 - 100 * k), Math.round(100 - 100 * k), 255], 3)).toBe(true);
  });

  it('a disabled mask has no effect and masks work inside groups with blend modes', () => {
    e = newEngine(30, 30);
    setBase(e, [100, 100, 100, 255]);
    const g = e.addGroup();
    e.setActiveLayer(g);
    const l = solidLayer(e, 'rgb(200,200,200)');
    e.moveLayer(l, g, 0);
    const slot = e.addMask(l);
    e.setLayerProps(l, { blend: 'multiply' });
    e.setPaintTarget(l, 'mask');
    e.setToolContext(brushCtx({ size: 30 }));
    stroke(e, 'brush', [[15, 15]]);
    expect(maskAt(e, slot, 15, 15)).toBe(0);
    expect(px(e, 15, 15)).toEqual([100, 100, 100, 255]);
    e.setMaskEnabled(l, false);
    expect(px(e, 15, 15)).toEqual([200, 200, 200, 255]); // groups are isolated: multiply against nothing
    const top = solidLayer(e, 'rgb(200,200,200)');
    e.setLayerProps(top, { blend: 'multiply' });
    e.addMask(top);
    expect(near(px(e, 15, 15), [78, 78, 78, 255], 2)).toBe(false); // group (200) x layer (200)
    expect(near(px(e, 15, 15), [157, 157, 157, 255], 2)).toBe(true);
  });

  it('only the changed rect is redrawn when painting a mask', () => {
    setup();
    e.flush();
    const ev: EngineEvent[] = collect(e);
    e.setToolContext(brushCtx({ size: 6 }));
    stroke(e, 'brush', [[20, 20]]);
    e.flush();
    const c = ev.filter((x) => x.type === 'composite');
    expect(c.length).toBeGreaterThan(0);
    for (const x of c) if (x.type === 'composite') expect(x.rect.w * x.rect.h).toBeLessThan(15 * 15);
  });

  it('drawMaskThumbnail draws the grey mask on black', () => {
    const { id } = setup();
    e.setToolContext(brushCtx({ size: 40 }));
    stroke(e, 'brush', [[0, 20]]);
    const cv = document.createElement('canvas');
    cv.width = 20;
    cv.height = 20;
    e.drawMaskThumbnail(id, cv);
    const d = cv.getContext('2d')?.getImageData(0, 0, 20, 20).data as Uint8ClampedArray;
    expect(d[(10 * 20 + 19) * 4]).toBeGreaterThan(200); // white on the right
    expect(d[(10 * 20 + 0) * 4]).toBeLessThan(40); // painted black on the left
    expect(d[3]).toBe(255);
    e.drawMaskThumbnail('nope', cv);
    e.drawMaskThumbnail('base', cv); // no mask: cleared
    expect(cv.getContext('2d')?.getImageData(5, 5, 1, 1).data[3]).toBe(0);
  });
});

describe('masks: resize', () => {
  it('a pixel layer mask keeps its size when the document grows; adjustment masks follow the document', () => {
    const { id, slot } = setup();
    e.setToolContext(brushCtx({ size: 40 }));
    stroke(e, 'brush', [[20, 20]]);
    const ev = collect(e);
    e.resize(60, 60);
    expect(e.docSpec().layers.find((l) => l.id === id)).toMatchObject({ surfaceW: 40, surfaceH: 40 });
    expect(maskAt(e, slot, 20, 20)).toBe(0);
    expect(e.readSurface(slot, { x: 0, y: 0, w: 60, h: 60 }).length).toBe(60 * 60 * 4);
    const adj = e.addAdjustment('invert');
    const aslot = e.addMask(adj);
    e.setPaintTarget(adj, 'mask');
    stroke(e, 'brush', [[20, 20]]);
    expect(maskAt(e, aslot, 20, 20)).toBe(0);
    e.setCanvasSize(80, 80, 'tl');
    expect(maskAt(e, aslot, 20, 20)).toBe(0); // old content stays top-left
    expect(maskAt(e, aslot, 70, 70)).toBe(255); // the new area is fully visible
    expect(ev.some((x) => x.type === 'surface' && x.slot === aslot)).toBe(true);
    e.undo();
    expect(slotPx(e, aslot, 59, 59)).toEqual([255, 255, 255, 255]);
  });
});
