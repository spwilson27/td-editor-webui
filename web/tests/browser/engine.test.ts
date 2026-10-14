import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, Engine } from '../../src/engine';
import { setForceDomCanvas } from '../../src/engine/surface';
import { brushCtx, collect, drawRect, layerPx, near, newEngine, px, setBase, solid, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => {
  e?.dispose();
  setForceDomCanvas(false);
});

const names = (en: Engine) => en.layers().map((l) => `${'-'.repeat(l.depth)}${l.name}`);

describe('layers', () => {
  it('starts with a locked base layer that is active', () => {
    e = newEngine(10, 10);
    expect(e.layers()).toEqual([
      { id: 'base', name: 'TD Input', kind: 'base', visible: true, locked: true, opacity: 1, blend: 'normal', depth: 0, parentId: null, slot: null, mask: null, adjustment: null },
    ]);
    expect(e.activeLayerId()).toBe('base');
  });

  it('createEngine returns an EditorEngine of the requested size', () => {
    const c = createEngine(30, 20);
    expect([c.width, c.height]).toEqual([30, 20]);
    c.dispose();
  });

  it('adds layers above the active layer and activates them', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer();
    const b = e.addPixelLayer('B');
    expect(names(e)).toEqual(['B', 'Layer 1', 'TD Input']);
    expect(e.activeLayerId()).toBe(b);
    e.setActiveLayer(a);
    e.addPixelLayer('mid');
    expect(names(e)).toEqual(['B', 'mid', 'Layer 1', 'TD Input']);
    e.setActiveLayer('base');
    e.addPixelLayer('above-base');
    expect(names(e)).toEqual(['B', 'mid', 'Layer 1', 'above-base', 'TD Input']);
  });

  it('groups: children are listed after their expanded group with depth and parentId', () => {
    e = newEngine(10, 10);
    const g = e.addGroup();
    const l = e.addPixelLayer('child');
    e.moveLayer(l, g, 0);
    const info = e.layers();
    expect(info.map((x) => [x.name, x.depth, x.parentId])).toEqual([['Group 1', 0, null], ['child', 1, g], ['TD Input', 0, null]]);
    expect(info[0].expanded).toBe(true);
    e.setLayerProps(g, { expanded: false });
    expect(names(e)).toEqual(['Group 1', 'TD Input']);
    expect(e.layers()[0].expanded).toBe(false);
  });

  it('expanding a group is view state: no history', () => {
    e = newEngine(10, 10);
    const g = e.addGroup();
    const n = e.history().entries.length;
    const ev = collect(e);
    e.setLayerProps(g, { expanded: false });
    expect(e.history().entries.length).toBe(n);
    expect(ev).toEqual([{ type: 'structure' }]);
  });

  it('new layer is added into the active layer\'s group', () => {
    e = newEngine(10, 10);
    const g = e.addGroup();
    const c1 = e.addPixelLayer('c1');
    e.moveLayer(c1, g, 0);
    e.setActiveLayer(c1);
    e.addPixelLayer('c2');
    expect(names(e)).toEqual(['Group 1', '-c2', '-c1', 'TD Input']);
  });

  it('moveLayer reorders, nests, and respects invariants', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer('a');
    const b = e.addPixelLayer('b');
    const c = e.addPixelLayer('c');
    expect(names(e)).toEqual(['c', 'b', 'a', 'TD Input']);
    e.moveLayer(c, null, 2);
    expect(names(e)).toEqual(['b', 'a', 'c', 'TD Input']);
    e.moveLayer(c, null, 99); // cannot go below the base layer
    expect(names(e)).toEqual(['b', 'a', 'c', 'TD Input']);
    e.moveLayer(a, null, -5);
    expect(names(e)).toEqual(['a', 'b', 'c', 'TD Input']);
    e.moveLayer('base', null, 0); // base is immovable
    expect(names(e)).toEqual(['a', 'b', 'c', 'TD Input']);
    const g = e.addGroup('G');
    e.moveLayer(b, g, 0);
    expect(names(e)).toEqual(['a', 'G', '-b', 'c', 'TD Input']);
    e.moveLayer(g, g, 0); // into itself
    const inner = e.addGroup('inner');
    e.moveLayer(inner, g, 0);
    e.moveLayer(g, inner, 0); // into own descendant
    expect(names(e)).toEqual(['a', 'G', '-inner', '-b', 'c', 'TD Input']);
    e.moveLayer(a, 'nope', 0);
    e.moveLayer('nope', null, 0);
    e.moveLayer(a, c, 0); // target is not a group
    expect(names(e)).toEqual(['a', 'G', '-inner', '-b', 'c', 'TD Input']);
  });

  it('moveLayer to the same place records nothing', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer();
    const n = e.history().entries.length;
    e.moveLayer(a, null, 0);
    expect(e.history().entries.length).toBe(n);
  });

  it('deleteLayer removes layers and groups with children, and moves the active layer to a neighbour', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer('a');
    const g = e.addGroup('g');
    const c = e.addPixelLayer('c');
    e.moveLayer(c, g, 0);
    e.setActiveLayer(c);
    e.deleteLayer(g);
    expect(names(e)).toEqual(['a', 'TD Input']);
    expect(e.activeLayerId()).not.toBeNull();
    expect(e.layers().some((l) => l.id === e.activeLayerId())).toBe(true);
    e.deleteLayer(a);
    expect(e.activeLayerId()).toBe('base');
    e.deleteLayer('missing');
    expect(names(e)).toEqual(['TD Input']);
  });

  it('the base layer cannot be deleted', () => {
    e = newEngine(10, 10);
    const ev = collect(e);
    e.deleteLayer('base');
    expect(names(e)).toEqual(['TD Input']);
    expect(ev).toEqual([{ type: 'notice', message: 'The base layer cannot be deleted' }]);
  });

  it('setLayerProps validates, clamps, and ignores no-ops and unknown ids', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer();
    const n = e.history().entries.length;
    e.setLayerProps(a, { opacity: 5 });
    expect(e.layers()[0].opacity).toBe(1);
    expect(e.history().entries.length).toBe(n);
    e.setLayerProps(a, { opacity: -1 });
    expect(e.layers()[0].opacity).toBe(0);
    e.setLayerProps(a, { name: 'x', locked: true, blend: 'screen' });
    expect(e.layers()[0]).toMatchObject({ name: 'x', locked: true, blend: 'screen' });
    e.setLayerProps('zzz', { name: 'q' });
    e.setLayerProps(a, { expanded: true }); // not a group
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add layer', 'Layer opacity', 'Layer properties']);
  });

  it('flattenToNewLayer stamps the visible composite on top', () => {
    e = newEngine(10, 10);
    setBase(e, [10, 20, 30, 255]);
    const a = e.addPixelLayer();
    drawRect(e, a, { x: 0, y: 0, w: 5, h: 10 }, '#f00');
    const hidden = e.addPixelLayer();
    drawRect(e, hidden, { x: 0, y: 0, w: 10, h: 10 }, '#0f0');
    e.setLayerProps(hidden, { visible: false });
    const f = e.flattenToNewLayer();
    expect(e.layers()[0].id).toBe(f);
    expect(e.activeLayerId()).toBe(f);
    expect(layerPx(e, f, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(layerPx(e, f, 8, 2)).toEqual([10, 20, 30, 255]);
    e.undo();
    expect(e.layers().some((l) => l.id === f)).toBe(false);
    e.redo();
    expect(layerPx(e, f, 2, 2)).toEqual([255, 0, 0, 255]);
  });
});

describe('thumbnails', () => {
  it('draws a layer scaled and letterboxed into the target', () => {
    e = newEngine(100, 50);
    const a = e.addPixelLayer();
    drawRect(e, a, { x: 0, y: 0, w: 100, h: 50 }, '#f00');
    const t = document.createElement('canvas');
    t.width = 40;
    t.height = 40;
    e.drawThumbnail(a, t);
    const c = t.getContext('2d')!;
    expect(Array.from(c.getImageData(20, 20, 1, 1).data)).toEqual([255, 0, 0, 255]);
    expect(c.getImageData(20, 2, 1, 1).data[3]).toBe(0); // letterbox bars
    expect(c.getImageData(20, 38, 1, 1).data[3]).toBe(0);
  });

  it('groups render their children; unknown ids do nothing', () => {
    e = newEngine(10, 10);
    const g = e.addGroup();
    const l = e.addPixelLayer();
    e.moveLayer(l, g, 0);
    drawRect(e, l, { x: 0, y: 0, w: 10, h: 10 }, '#00f');
    const t = document.createElement('canvas');
    t.width = 10;
    t.height = 10;
    e.drawThumbnail(g, t);
    expect(Array.from(t.getContext('2d')!.getImageData(5, 5, 1, 1).data)).toEqual([0, 0, 255, 255]);
    t.getContext('2d')!.clearRect(0, 0, 10, 10);
    e.drawThumbnail('nope', t);
    expect(t.getContext('2d')!.getImageData(5, 5, 1, 1).data[3]).toBe(0);
  });
});

describe('base layer', () => {
  it('writeBase stays invisible until commitBase', () => {
    e = newEngine(8, 8);
    const ev = collect(e);
    e.flush();
    e.writeBase({ x: 2, y: 3, w: 2, h: 2 }, solid(2, 2, [9, 8, 7, 255]));
    expect(px(e, 2, 3)).toEqual([0, 0, 0, 0]);
    e.commitBase();
    expect(px(e, 2, 3)).toEqual([9, 8, 7, 255]);
    expect(px(e, 3, 4)).toEqual([9, 8, 7, 255]);
    expect(px(e, 4, 4)).toEqual([0, 0, 0, 0]);
    expect(ev.filter((x) => x.type === 'pixels')).toEqual([{ type: 'pixels', rect: { x: 2, y: 3, w: 2, h: 2 } }]);
    e.commitBase(); // nothing pending
    expect(ev.filter((x) => x.type === 'pixels')).toHaveLength(1);
  });

  it('records no history and does not clear it', () => {
    e = newEngine(8, 8);
    e.addPixelLayer();
    setBase(e, [1, 2, 3, 255]);
    expect(e.history().entries).toHaveLength(1);
  });

  it('bands accumulate into one published region', () => {
    e = newEngine(8, 8);
    e.writeBase({ x: 0, y: 0, w: 8, h: 4 }, solid(8, 4, [255, 0, 0, 255]));
    e.writeBase({ x: 0, y: 4, w: 8, h: 4 }, solid(8, 4, [0, 0, 255, 255]));
    e.commitBase();
    expect(px(e, 3, 1)).toEqual([255, 0, 0, 255]);
    expect(px(e, 3, 6)).toEqual([0, 0, 255, 255]);
  });

  it('clips rects that overhang the document and ignores rects outside or empty', () => {
    e = newEngine(8, 8);
    e.writeBase({ x: 6, y: 6, w: 4, h: 4 }, solid(4, 4, [5, 5, 5, 255]));
    e.writeBase({ x: -2, y: -2, w: 4, h: 4 }, solid(4, 4, [6, 6, 6, 255]));
    e.writeBase({ x: 20, y: 20, w: 2, h: 2 }, solid(2, 2, [7, 7, 7, 255]));
    e.writeBase({ x: 0, y: 0, w: 0, h: 3 }, new Uint8Array(0));
    e.commitBase();
    expect(px(e, 7, 7)).toEqual([5, 5, 5, 255]);
    expect(px(e, 0, 0)).toEqual([6, 6, 6, 255]);
    expect(px(e, 1, 1)).toEqual([6, 6, 6, 255]);
    expect(px(e, 2, 2)).toEqual([0, 0, 0, 0]);
  });

  it('overhang uses the right source pixels', () => {
    e = newEngine(4, 4);
    const src = new Uint8ClampedArray(16);
    for (let i = 0; i < 4; i++) src.set([i * 10, 0, 0, 255], i * 4); // 2x2: values 0,10 / 20,30
    e.writeBase({ x: -1, y: -1, w: 2, h: 2 }, src);
    e.commitBase();
    expect(px(e, 0, 0)).toEqual([30, 0, 0, 255]); // bottom-right source pixel
  });

  it('accepts Uint8Array views with an offset, and rejects short buffers', () => {
    e = newEngine(4, 4);
    const big = new Uint8Array(100);
    big.fill(77, 20, 20 + 16);
    big.fill(255, 3, 3);
    const view = big.subarray(20, 36);
    for (let i = 3; i < 16; i += 4) view[i] = 255;
    e.writeBase({ x: 0, y: 0, w: 2, h: 2 }, view);
    e.commitBase();
    expect(px(e, 1, 1)).toEqual([77, 77, 77, 255]);
    expect(() => e.writeBase({ x: 0, y: 0, w: 4, h: 4 }, new Uint8Array(10))).toThrow(RangeError);
    expect(() => e.writeBase({ x: 0.5, y: 0, w: 1, h: 1 }, new Uint8Array(4))).toThrow(RangeError);
    expect(() => e.writeBase({ x: 0, y: 0, w: -1, h: 1 }, new Uint8Array(4))).toThrow(RangeError);
  });

  it('preserves straight alpha in the composite', () => {
    e = newEngine(2, 2);
    e.writeBase({ x: 0, y: 0, w: 2, h: 2 }, solid(2, 2, [200, 100, 50, 128]));
    e.commitBase();
    expect(near(px(e, 0, 0), [200, 100, 50, 128], 2)).toBe(true);
    e.writeBase({ x: 0, y: 0, w: 1, h: 1 }, solid(1, 1, [0, 0, 0, 0]));
    e.commitBase();
    expect(px(e, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('readComposite', () => {
  it('reads sub-rects and reuses a supplied buffer', () => {
    e = newEngine(4, 4);
    setBase(e, [1, 2, 3, 255]);
    const out = new Uint8ClampedArray(2 * 2 * 4);
    const r = e.readComposite({ x: 1, y: 1, w: 2, h: 2 }, out);
    expect(r).toBe(out);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 2, 3, 255]);
  });

  it('zero-size and fully outside rects return empty/zero data', () => {
    e = newEngine(4, 4);
    setBase(e, [1, 2, 3, 255]);
    expect(e.readComposite({ x: 0, y: 0, w: 0, h: 3 }).length).toBe(0);
    expect(Array.from(e.readComposite({ x: 10, y: 10, w: 1, h: 1 }))).toEqual([0, 0, 0, 0]);
  });

  it('partially outside rects are zero-padded', () => {
    e = newEngine(2, 2);
    setBase(e, [9, 9, 9, 255]);
    const d = e.readComposite({ x: 1, y: 1, w: 2, h: 2 });
    expect(Array.from(d)).toEqual([9, 9, 9, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('reflects edits made in the same tick (flushes pending composite)', () => {
    e = newEngine(4, 4);
    e.setToolContext(brushCtx({ size: 4 }));
    e.setActiveLayer(e.addPixelLayer());
    stroke(e, 'brush', [[2, 2]]);
    expect(px(e, 2, 2)).toEqual([0, 0, 0, 255]);
  });

  it('compositeSource is drawable', () => {
    e = newEngine(4, 4);
    setBase(e, [1, 2, 3, 255]);
    e.flush();
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    c.getContext('2d')!.drawImage(e.compositeSource(), 0, 0);
    expect(Array.from(c.getContext('2d')!.getImageData(1, 1, 1, 1).data)).toEqual([1, 2, 3, 255]);
  });
});

describe('resize', () => {
  it('anchors top-left: keeps content, new area transparent, shrink crops', () => {
    e = newEngine(10, 10);
    setBase(e, [50, 60, 70, 255]);
    const a = e.addPixelLayer();
    drawRect(e, a, { x: 8, y: 8, w: 2, h: 2 }, '#f00');
    e.resize(20, 15);
    expect([e.width, e.height]).toEqual([20, 15]);
    expect(px(e, 9, 9)).toEqual([255, 0, 0, 255]);
    expect(px(e, 0, 0)).toEqual([50, 60, 70, 255]);
    expect(px(e, 15, 5)).toEqual([0, 0, 0, 0]);
    expect(px(e, 5, 12)).toEqual([0, 0, 0, 0]);
    e.resize(4, 4);
    expect(px(e, 3, 3)).toEqual([50, 60, 70, 255]);
    expect(layerPx(e, a, 3, 3)).toEqual([0, 0, 0, 0]);
    const c = document.createElement('canvas');
    e.drawThumbnail(a, c);
  });

  it('emits resize, clears history, clips the selection, and painting still works', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 4 }));
    stroke(e, 'brush', [[5, 5]]);
    e.setSelection({ x: 5, y: 5, w: 10, h: 10 });
    const ev = collect(e);
    e.resize(8, 8);
    expect(ev).toContainEqual({ type: 'resize', width: 8, height: 8 });
    expect(e.history()).toEqual({ entries: [], index: -1 });
    expect(e.selection()).toEqual({ x: 5, y: 5, w: 3, h: 3 });
    e.resize(8, 8); // same size: no-op
    e.setSelection(null);
    stroke(e, 'brush', [[2, 2]]);
    expect(layerPx(e, a, 2, 2)).toEqual([0, 0, 0, 255]);
  });

  it('undo after resize does nothing and does not corrupt the document', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 4 }));
    stroke(e, 'brush', [[5, 5]]);
    e.resize(12, 12);
    e.undo();
    e.redo();
    expect(layerPx(e, a, 5, 5)).toEqual([0, 0, 0, 255]);
    expect(e.layers().map((l) => l.id)).toContain(a);
  });

  it('clamps nonsense sizes', () => {
    e = newEngine(0, -5);
    expect([e.width, e.height]).toEqual([1, 1]);
    e.resize(1e9, NaN);
    expect([e.width, e.height]).toEqual([16384, 1]);
  });

  it('resizing mid-stroke finishes the stroke without throwing', () => {
    e = newEngine(10, 10);
    e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 4 }));
    e.setTool('brush');
    e.pointerDown({ x: 3, y: 3, pressure: 1, shift: false, alt: false, ctrl: false });
    e.resize(20, 20);
    e.pointerMove({ x: 5, y: 5, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerUp({ x: 5, y: 5, pressure: 1, shift: false, alt: false, ctrl: false });
    expect(e.history().entries).toHaveLength(0);
  });
});

describe('clearHistory', () => {
  it('drops all entries, resets the index and emits history', () => {
    e = newEngine(4, 4);
    e.addPixelLayer();
    e.addPixelLayer();
    expect(e.history().entries.length).toBe(2);
    const seen = collect(e);
    e.clearHistory();
    expect(e.history()).toEqual({ entries: [], index: -1 });
    expect(seen.some((x) => x.type === 'history')).toBe(true);
    e.undo();
    expect(e.layers().length).toBe(3);
  });
});

describe('events and lifecycle', () => {
  it('on() returns an unsubscribe; a throwing listener does not break others', () => {
    e = newEngine(4, 4);
    const seen: string[] = [];
    const off = e.on((x) => seen.push(x.type));
    const err = console.error;
    console.error = () => {};
    e.on(() => { throw new Error('boom'); });
    e.addPixelLayer();
    console.error = err;
    expect(seen).toContain('structure');
    off();
    const n = seen.length;
    console.error = () => {};
    e.addPixelLayer();
    console.error = err;
    expect(seen.length).toBe(n);
  });

  it('structure / history events fire on layer edits', () => {
    e = newEngine(4, 4);
    const ev = collect(e);
    e.addPixelLayer();
    expect(ev.map((x) => x.type)).toEqual(['structure', 'docspec', 'history']);
  });

  it('setActiveLayer ignores unknown ids and repeated ids', () => {
    e = newEngine(4, 4);
    const ev = collect(e);
    e.setActiveLayer('nope');
    e.setActiveLayer('base');
    expect(ev).toEqual([]);
  });

  it('dispose is safe, silences listeners and can be called twice', () => {
    e = newEngine(4, 4);
    const ev = collect(e);
    e.dispose();
    e.dispose();
    expect(ev).toEqual([]);
  });

  it('setToolContext clamps out-of-range values', () => {
    e = newEngine(20, 20);
    e.setActiveLayer(e.addPixelLayer());
    e.setToolContext(brushCtx({ size: 8, opacity: 7, flow: 9, hardness: 5 }));
    stroke(e, 'brush', [[10, 10]]);
    expect(px(e, 10, 10)[3]).toBe(255);
    expect(px(e, 12, 10)[3]).toBe(255);
  });
});

describe('HTMLCanvasElement fallback', () => {
  it('the whole engine works without OffscreenCanvas', () => {
    setForceDomCanvas(true);
    e = newEngine(20, 20);
    expect(e.compositeSource()).toBeInstanceOf(HTMLCanvasElement);
    setBase(e, [255, 255, 255, 255]);
    const a = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 6 }));
    stroke(e, 'brush', [[10, 10]]);
    e.setLayerProps(a, { blend: 'multiply' });
    expect(px(e, 10, 10)).toEqual([0, 0, 0, 255]);
    e.resize(30, 30);
    e.undo();
    expect(px(e, 10, 10)).toEqual([0, 0, 0, 255]);
  });

  it('uses OffscreenCanvas by default when available', () => {
    e = newEngine(4, 4);
    if (typeof OffscreenCanvas !== 'undefined') expect(e.compositeSource()).toBeInstanceOf(OffscreenCanvas);
  });
});
