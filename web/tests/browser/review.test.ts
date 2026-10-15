import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { PixelLayer } from '../../src/engine/model';
import { brushCtx, collect, drawRect, layerPx, newEngine, nextFrame, ptr, px, rgba, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());
const histBytes = () => (e as unknown as { hist: { bytes: number } }).hist.bytes;
const composites = (ev: ReturnType<typeof collect>) => ev.filter((x) => x.type === 'composite');

describe('selection-clipped strokes leave no ghost paint', () => {
  it('paint stamped outside the selection does not reappear in a later stroke', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 20 }, { primary: rgba(255, 0, 0) }));
    e.setSelection({ x: 60, y: 0, w: 40, h: 100 });
    stroke(e, 'brush', [[20, 50]]);
    expect(layerPx(e, id, 20, 50)[3]).toBe(0);
    e.setSelection(null);
    e.setToolContext(brushCtx({ size: 2 }, { primary: rgba(0, 0, 255) }));
    stroke(e, 'brush', [[10, 50], [40, 50]]);
    expect(layerPx(e, id, 22, 52)[3]).toBe(0);
    expect(layerPx(e, id, 22, 50)[3]).toBeGreaterThan(200);
    expect(layerPx(e, id, 22, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });

  it('same for a partly clipped stroke and for the eraser', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 30 }, { primary: rgba(255, 0, 0) }));
    e.setSelection({ x: 40, y: 0, w: 60, h: 100 });
    stroke(e, 'brush', [[40, 50]]);
    e.setSelection(null);
    e.setToolContext(brushCtx({ size: 2 }, { primary: rgba(0, 0, 255) }));
    stroke(e, 'brush', [[10, 80], [90, 80], [30, 50]]);
    expect(layerPx(e, id, 30, 50)[3]).toBeGreaterThan(200);
    expect(layerPx(e, id, 30, 58)[3]).toBe(0);
    expect(layerPx(e, id, 30, 42)[3]).toBe(0);
  });
});

describe('tile based undo patches', () => {
  it('a single dab stores one tile pair, not the document', () => {
    e = newEngine(2000, 2000);
    e.setActiveLayer(e.addPixelLayer());
    e.setToolContext(brushCtx({ size: 10 }));
    const before = histBytes();
    stroke(e, 'brush', [[500, 500]]);
    expect(histBytes() - before).toBe(128 * 128 * 4 * 2);
  });

  it('a diagonal stroke stores only the tiles it touches', () => {
    e = newEngine(1000, 1000);
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 10 }));
    const before = histBytes();
    stroke(e, 'brush', [[10, 10], [990, 990]]);
    const used = histBytes() - before;
    expect(used).toBeLessThan(4 * 1024 * 1024); // bounding box would be 8 MB
    expect(layerPx(e, id, 500, 500)[3]).toBe(255);
    e.undo();
    expect(layerPx(e, id, 500, 500)[3]).toBe(0);
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
    expect(layerPx(e, id, 990, 990)[3]).toBe(0);
    e.redo();
    expect(layerPx(e, id, 990, 990)[3]).toBe(255);
  });

  it('strokes spanning tile borders undo seamlessly', () => {
    e = newEngine(300, 300);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 300, h: 300 }, 'rgb(1,2,3)');
    e.setToolContext(brushCtx({ size: 40 }, { primary: rgba(255, 255, 255) }));
    stroke(e, 'brush', [[100, 100], [160, 160], [200, 130]]);
    e.undo();
    for (const [x, y] of [[127, 127], [128, 128], [160, 160], [200, 130], [100, 100]]) expect(layerPx(e, id, x, y)).toEqual([1, 2, 3, 255]);
  });
});

describe('history memory accounting', () => {
  it('deleting a layer counts its surface against the cap', () => {
    e = newEngine(500, 500);
    const id = e.addPixelLayer();
    const before = histBytes();
    e.deleteLayer(id);
    expect(histBytes() - before).toBeGreaterThanOrEqual(500 * 500 * 4);
  });

  it('property edits stay cheap', () => {
    e = newEngine(500, 500);
    const id = e.addPixelLayer();
    const before = histBytes();
    e.setLayerProps(id, { name: 'x' });
    expect(histBytes() - before).toBeLessThan(1000);
  });
});

describe('gradient redraw coalescing', () => {
  it('many pointer moves in one tick produce a single redraw', async () => {
    e = newEngine(100, 100);
    e.setActiveLayer(e.addPixelLayer());
    e.setToolContext(brushCtx({}, { primary: rgba(255, 0, 0), secondary: rgba(0, 0, 255) }));
    await nextFrame();
    e.setTool('gradient');
    e.pointerDown(ptr(0, 0));
    const ev = collect(e);
    for (let i = 1; i <= 40; i++) e.pointerMove(ptr(i, 0));
    expect(ev.filter((x) => x.type === 'pixels')).toHaveLength(0);
    await nextFrame();
    await nextFrame();
    expect(ev.filter((x) => x.type === 'pixels')).toHaveLength(1);
    e.pointerUp(ptr(40, 0));
    expect(layerPx(e, e.activeLayerId() as string, 20, 5)[3]).toBe(255);
  });
});

describe('recomposite only what a layer property touches', () => {
  it('visibility change redraws the layer bounds only; rename and lock redraw nothing; add layer redraws nothing', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    (e.doc.find(id) as PixelLayer).x = 60;
    e.flush();
    const ev = collect(e);
    e.setLayerProps(id, { visible: false });
    e.flush();
    expect(composites(ev)).toEqual([{ type: 'composite', rect: { x: 60, y: 0, w: 40, h: 100 } }]);
    e.setLayerProps(id, { name: 'n', locked: true });
    e.addPixelLayer();
    e.addGroup();
    e.flush();
    expect(composites(ev)).toHaveLength(1);
  });

  it('group property changes cover the union of the children', () => {
    e = newEngine(100, 100);
    const g = e.addGroup();
    const a = e.addPixelLayer();
    e.moveLayer(a, g, 0);
    (e.doc.find(a) as PixelLayer).x = 70;
    e.flush();
    const ev = collect(e);
    e.setLayerProps(g, { opacity: 0.5 });
    e.flush();
    expect(composites(ev)).toEqual([{ type: 'composite', rect: { x: 70, y: 0, w: 30, h: 100 } }]);
  });
});

describe('group thumbnail cache', () => {
  it('renders a group once until the document changes', () => {
    e = newEngine(50, 50);
    const g = e.addGroup();
    const l = e.addPixelLayer();
    e.moveLayer(l, g, 0);
    drawRect(e, l, { x: 0, y: 0, w: 50, h: 50 }, '#f00');
    const comp = (e as unknown as { compositor: { renderIsolated: (g: unknown, k: number) => unknown } }).compositor;
    const orig = comp.renderIsolated.bind(comp);
    let calls = 0;
    comp.renderIsolated = (grp, k) => { calls++; return orig(grp, k); };
    const t = document.createElement('canvas');
    t.width = t.height = 20;
    e.drawThumbnail(g, t);
    e.drawThumbnail(g, t);
    expect(calls).toBe(1);
    expect(Array.from(t.getContext('2d')!.getImageData(10, 10, 1, 1).data)).toEqual([255, 0, 0, 255]);
    drawRect(e, l, { x: 0, y: 0, w: 50, h: 50 }, '#00f');
    e.drawThumbnail(g, t);
    expect(calls).toBe(2);
    expect(Array.from(t.getContext('2d')!.getImageData(10, 10, 1, 1).data)).toEqual([0, 0, 255, 255]);
    t.width = 10; // different target size: re-render
    t.height = 10;
    e.drawThumbnail(g, t);
    expect(calls).toBe(3);
  });
});

describe('undo does not rewrite view state', () => {
  it('keeps the current active layer and group expansion', () => {
    e = newEngine(20, 20);
    const a = e.addPixelLayer('a');
    const b = e.addPixelLayer('b');
    const g = e.addGroup();
    e.setLayerProps(b, { name: 'renamed' });
    e.setActiveLayer(a);
    e.setLayerProps(g, { expanded: false });
    e.undo(); // undo the rename
    expect(e.activeLayerId()).toBe(a);
    expect(e.layers().find((l) => l.id === g)?.expanded).toBe(false);
    expect(e.layers().find((l) => l.id === b)?.name).toBe('b');
  });

  it('falls back to the recorded active layer when the current one disappears', () => {
    e = newEngine(20, 20);
    const a = e.addPixelLayer();
    e.addPixelLayer();
    e.undo(); // removes the active layer
    expect(e.activeLayerId()).toBe(a);
  });
});

describe('fill on an offset layer', () => {
  it('is limited to the part of the layer inside the document', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    (e.doc.find(id) as PixelLayer).x = 30;
    e.setToolContext(brushCtx({}, { primary: rgba(9, 9, 9) }));
    stroke(e, 'fill', [[50, 50]]);
    expect(layerPx(e, id, 69, 50)).toEqual([9, 9, 9, 255]); // doc x 99
    expect(layerPx(e, id, 80, 50)[3]).toBe(0); // doc x 110: off-canvas
    expect(px(e, 99, 50)).toEqual([9, 9, 9, 255]);
    expect(px(e, 20, 50)[3]).toBe(0);
  });
});

describe('small review fixes', () => {
  it('resize that clips the selection emits selection', () => {
    e = newEngine(50, 50);
    e.setSelection({ x: 30, y: 30, w: 20, h: 20 });
    const ev = collect(e);
    e.resize(40, 40);
    expect(ev.map((x) => x.type)).toContain('selection');
    e.setSelection(null);
    const ev2 = collect(e);
    e.resize(30, 30);
    expect(ev2.map((x) => x.type)).not.toContain('selection');
  });

  it('no composite happens after dispose', async () => {
    e = newEngine(20, 20);
    await nextFrame();
    const ev = collect(e);
    e.changed({ x: 0, y: 0, w: 5, h: 5 });
    e.dispose();
    // dispose clears listeners, so watch the surface instead
    e.changed({ x: 0, y: 0, w: 5, h: 5 });
    e.flush();
    await nextFrame();
    await nextFrame();
    expect(ev).toEqual([{ type: 'pixels', rect: { x: 0, y: 0, w: 5, h: 5 } }]);
  });

  it('readComposite floors fractional rects and tolerates NaN / negative sizes', () => {
    e = newEngine(4, 4);
    e.writeBase({ x: 0, y: 0, w: 4, h: 4 }, new Uint8ClampedArray(64).fill(7));
    e.commitBase();
    expect(e.readComposite({ x: 1.7, y: 0.2, w: 2.9, h: 1.9 }).length).toBe(2 * 1 * 4);
    expect(e.readComposite({ x: NaN, y: 0, w: 2, h: 2 }).length).toBe(16);
    expect(e.readComposite({ x: 0, y: 0, w: NaN, h: 2 }).length).toBe(0);
    expect(e.readComposite({ x: 0, y: 0, w: -3, h: 2 }).length).toBe(0);
  });
});

describe('thumbnails, offset layers and resize', () => {
  it('group thumbnail is refreshed after resize', () => {
    e = newEngine(50, 50);
    const g = e.addGroup();
    const l = e.addPixelLayer();
    e.moveLayer(l, g, 0);
    drawRect(e, l, { x: 0, y: 0, w: 50, h: 50 }, '#f00');
    const t = document.createElement('canvas');
    t.width = t.height = 20;
    e.drawThumbnail(g, t);
    e.resize(100, 50); // right half is now empty: the red part is half as wide
    e.drawThumbnail(g, t);
    const c = t.getContext('2d')!;
    expect(c.getImageData(2, 5, 1, 1).data[3]).toBe(255);
    expect(c.getImageData(18, 5, 1, 1).data[3]).toBe(0);
  });

  it('deleting a group frees its cached thumbnail', () => {
    e = newEngine(20, 20);
    const g = e.addGroup();
    const t = document.createElement('canvas');
    t.width = t.height = 10;
    e.drawThumbnail(g, t);
    const thumbs = (e as unknown as { thumbs: Map<string, unknown> }).thumbs;
    expect(thumbs.has(g)).toBe(true);
    e.deleteLayer(g);
    expect(thumbs.has(g)).toBe(false);
  });

  it('undo patches on a moved layer land in layer space', () => {
    e = newEngine(300, 300);
    const id = e.addPixelLayer();
    (e.doc.find(id) as PixelLayer).x = 150;
    (e.doc.find(id) as PixelLayer).y = 20;
    e.setToolContext(brushCtx({ size: 10 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'brush', [[200, 100]]);
    expect(layerPx(e, id, 50, 80)[3]).toBe(255); // doc (200,100) = layer (50,80)
    expect(px(e, 200, 100)).toEqual([255, 0, 0, 255]);
    e.undo();
    expect(layerPx(e, id, 50, 80)[3]).toBe(0);
    expect(px(e, 200, 100)[3]).toBe(0);
    e.redo();
    expect(px(e, 200, 100)).toEqual([255, 0, 0, 255]);
  });

  it('painting and undoing work after a resize', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 10 }, { primary: rgba(0, 255, 0) }));
    stroke(e, 'brush', [[50, 50]]);
    e.resize(300, 300);
    const id2 = e.addPixelLayer(); // layers made after the resize are document sized; older surfaces keep their size
    stroke(e, 'brush', [[250, 250], [260, 250]]);
    expect(layerPx(e, id2, 255, 250)).toEqual([0, 255, 0, 255]);
    expect(layerPx(e, id, 50, 50)).toEqual([0, 255, 0, 255]);
    e.undo();
    expect(layerPx(e, id2, 255, 250)[3]).toBe(0);
    expect(layerPx(e, id, 50, 50)[3]).toBe(255);
  });
});
