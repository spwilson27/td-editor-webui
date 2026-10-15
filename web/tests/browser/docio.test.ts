import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { DocSpec, EngineEvent, Rect } from '../../src/engine/types';
import { brushCtx, collect, maskAt, newEngine, px, rgba, setBase, slotOf, slotPx, solid, solidLayer, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const types = (ev: EngineEvent[], t: EngineEvent['type']) => ev.filter((x) => x.type === t);
const surf = (ev: EngineEvent[], slot?: number) => ev.filter((x): x is Extract<EngineEvent, { type: 'surface' }> => x.type === 'surface' && (slot === undefined || x.slot === slot));

describe('docSpec', () => {
  it('lists bottom-first depth-first with all fields', () => {
    e = newEngine(30, 20);
    const a = e.addPixelLayer('A');
    const g = e.addGroup('G');
    e.setActiveLayer(g);
    const b = e.addPixelLayer('B');
    e.moveLayer(b, g, 0);
    const adj = e.addAdjustment('levels'); // above B inside G
    e.setActiveLayer(g);
    const top = e.addPixelLayer('Top');
    e.setActiveLayer(a);
    const m = e.addMask(a);
    e.setLayerProps(b, { opacity: 0.4, blend: 'screen', visible: false });
    const spec = e.docSpec();
    expect(spec.width).toBe(30);
    expect(spec.height).toBe(20);
    expect(spec.layers.map((l) => l.id)).toEqual(['base', a, g, b, adj, top]);
    expect(spec.layers.map((l) => l.parentId)).toEqual([null, null, null, g, g, null]);
    expect(spec.layers[0]).toEqual({
      id: 'base', kind: 'base', parentId: null, name: 'TD Input', visible: true, opacity: 1, blend: 'normal',
      x: 0, y: 0, slot: null, mask: null, adjustment: null, text: null, shape: null, rasterize: false,
    });
    expect(spec.layers[1]).toMatchObject({ kind: 'pixel', name: 'A', slot: slotOf(e, a), mask: { slot: m, enabled: true }, adjustment: null });
    expect(spec.layers[2]).toMatchObject({ kind: 'group', slot: null, mask: null, adjustment: null });
    expect(spec.layers[3]).toMatchObject({ kind: 'pixel', visible: false, opacity: 0.4, blend: 'screen' });
    expect(spec.layers[4]).toMatchObject({ kind: 'adjustment', slot: null, blend: 'normal', adjustment: { type: 'levels', inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 } });
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
    expect(e.surfaceSlots().sort()).toEqual([slotOf(e, a), m, slotOf(e, b), slotOf(e, top)].sort());
  });

  it('rev increments with every docspec event and only then', () => {
    e = newEngine(30, 20);
    const ev = collect(e);
    const rev0 = e.docSpec().rev;
    const id = e.addPixelLayer();
    expect(e.docSpec().rev).toBe(rev0 + 1);
    const seen = () => types(ev, 'docspec').length;
    expect(seen()).toBe(1);
    // not part of the spec
    e.setLayerProps(id, { locked: true });
    e.setLayerProps(id, { locked: false });
    e.setActiveLayer('base');
    e.setSelection({ x: 0, y: 0, w: 5, h: 5 });
    e.setToolContext(brushCtx());
    stroke(e, 'brush', [[10, 10], [12, 12]]); // base is locked: nothing
    expect(seen()).toBe(1);
    const steps: (() => void)[] = [
      () => e.setLayerProps(id, { name: 'n' }),
      () => e.setLayerProps(id, { visible: false }),
      () => e.setLayerProps(id, { opacity: 0.5 }),
      () => e.setLayerProps(id, { blend: 'multiply' }),
      () => e.addGroup(),
      () => e.moveLayer(id, null, 1),
      () => e.addAdjustment('invert'),
      () => e.deleteLayer(e.activeLayerId() as string),
      () => e.addMask(id),
      () => e.setMaskEnabled(id, false),
      () => e.deleteMask(id),
      () => e.resize(31, 20),
    ];
    let n = seen();
    for (const s of steps) {
      s();
      expect(seen()).toBe(n + 1);
      expect(e.docSpec().rev).toBe(rev0 + 1 + (n + 1 - 1));
      n++;
    }
    // undo / redo that change the spec emit; ones that do not, do not
    e.setLayerProps(id, { locked: true }); // history entry, no spec change
    const before = seen();
    e.undo();
    expect(seen()).toBe(before);
    e.undo(); // undo resize? history was cleared by resize: nothing to undo
    e.setLayerProps(id, { name: 'again' });
    n = seen();
    e.undo();
    expect(seen()).toBe(n + 1);
    e.redo();
    expect(seen()).toBe(n + 2);
  });

  it('adjustment params, mask toggles and offsets show up as docspec events', () => {
    e = newEngine(30, 20);
    const a = e.addAdjustment('blur');
    const ev = collect(e);
    e.setAdjustment(a, { type: 'blur', radius: 9 });
    expect(types(ev, 'docspec')).toHaveLength(1);
    expect(e.docSpec().layers[1].adjustment).toEqual({ type: 'blur', radius: 9 });
    const l = solidLayer(e, 'red');
    e.setTool('move');
    const p = (x: number) => ({ x, y: 5, pressure: 1, shift: false, alt: false, ctrl: false });
    ev.length = 0;
    e.pointerDown(p(5));
    e.pointerMove(p(8));
    e.pointerMove(p(12));
    expect(types(ev, 'docspec')).toHaveLength(2); // live while dragging
    e.pointerUp(p(12));
    expect(types(ev, 'docspec')).toHaveLength(2); // the commit adds nothing new
    expect(e.docSpec().layers.find((x) => x.id === l)).toMatchObject({ x: 7, y: 0 });
    e.undo();
    expect(e.docSpec().layers.find((x) => x.id === l)).toMatchObject({ x: 0, y: 0 });
    expect(types(ev, 'docspec')).toHaveLength(3);
  });
});

describe('slots', () => {
  it('are unique, never reused, and survive delete / undo', () => {
    e = newEngine(20, 20);
    const a = e.addPixelLayer();
    const b = e.addPixelLayer();
    const ma = e.addMask(a);
    const all = [slotOf(e, a), slotOf(e, b), ma];
    expect(new Set(all).size).toBe(3);
    expect(all.every((s) => s > 0 && s <= 65535)).toBe(true);
    e.deleteLayer(a);
    const c = e.addPixelLayer();
    const mc = e.addMask(c);
    expect(all).not.toContain(slotOf(e, c));
    expect(all).not.toContain(mc);
    e.deleteMask(c);
    const md = e.addMask(c);
    expect(md).not.toBe(mc);
    e.undo(); // add mask
    e.undo(); // delete mask
    expect(e.layers().find((l) => l.id === c)?.mask?.slot).toBe(mc);
    e.undo(); // add mask c
    e.undo(); // add layer c
    e.undo(); // delete a
    expect(e.layers().find((l) => l.id === a)?.slot).toBe(slotOf(e, a));
    expect(e.layers().find((l) => l.id === a)?.mask?.slot).toBe(ma);
    const d = e.addPixelLayer();
    const used = [...all, slotOf(e, c), mc, md];
    expect(used).not.toContain(slotOf(e, d));
    const flat = e.flattenToNewLayer();
    expect(used).not.toContain(slotOf(e, flat));
    expect(slotOf(e, flat)).not.toBe(slotOf(e, d));
  });

  it('readSurface of an unknown slot is zeros and writeSurface ignores it', () => {
    e = newEngine(10, 10);
    const out = e.readSurface(77, { x: 0, y: 0, w: 2, h: 2 });
    expect(Array.from(out)).toEqual(new Array(16).fill(0));
    e.writeSurface(77, { x: 0, y: 0, w: 1, h: 1 }, new Uint8Array(4).fill(9));
    const base = e.readSurface(0, { x: 0, y: 0, w: 1, h: 1 });
    expect(Array.from(base)).toEqual([0, 0, 0, 0]);
  });
});

describe('surface I/O', () => {
  it('readSurface: straight RGBA, clipping, out buffer reuse; masks grey', () => {
    e = newEngine(8, 8);
    const l = solidLayer(e, 'rgba(200,100,50,0.5)');
    const s = slotOf(e, l);
    const px1 = slotPx(e, s, 3, 3);
    expect(Math.abs(px1[0] - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(px1[3] - 128)).toBeLessThanOrEqual(1);
    const out = new Uint8ClampedArray(100).fill(7);
    const r = e.readSurface(s, { x: 6, y: 6, w: 4, h: 4 }, out);
    expect(r).toBe(out);
    expect(r[0]).toBeGreaterThan(0); // (6,6) inside
    expect(Array.from(r.subarray(2 * 4, 3 * 4))).toEqual([0, 0, 0, 0]); // x = 8 is outside
    expect(Array.from(r.subarray(2 * 16, 2 * 16 + 4))).toEqual([0, 0, 0, 0]); // y = 8 is outside
    expect(e.readSurface(s, { x: 0, y: 0, w: 0, h: 3 }).length).toBe(0);
    expect(e.readSurface(s, { x: NaN, y: 0, w: 1, h: 1 }).length).toBe(4);
    const m = e.addMask(l);
    const mp = slotPx(e, m, 1, 1);
    expect(mp).toEqual([255, 255, 255, 255]);
  });

  it('writeSurface: pixels, masks (grey -> alpha), clipping, no history, deferred recomposite', () => {
    e = newEngine(8, 8);
    setBase(e, [0, 0, 0, 255]);
    const l = e.addPixelLayer();
    const s = slotOf(e, l);
    const m = e.addMask(l);
    const n = e.history().entries.length;
    const ev = collect(e);
    e.writeSurface(s, { x: 2, y: 2, w: 2, h: 2 }, solid(2, 2, [10, 20, 30, 255]));
    e.writeSurface(s, { x: 6, y: 6, w: 4, h: 4 }, solid(4, 4, [200, 0, 0, 255]));
    e.writeSurface(m, { x: 0, y: 0, w: 2, h: 1 }, new Uint8Array([0, 0, 0, 255, 128, 128, 128, 255]));
    e.writeSurface(m, { x: 20, y: 20, w: 1, h: 1 }, new Uint8Array(4)); // off surface
    expect(e.history().entries).toHaveLength(n);
    expect(surf(ev).map((x) => [x.slot, x.rect])).toEqual([
      [s, { x: 2, y: 2, w: 2, h: 2 }], [s, { x: 6, y: 6, w: 2, h: 2 }], [m, { x: 0, y: 0, w: 2, h: 1 }],
    ]);
    expect(types(ev, 'pixels')).toHaveLength(0); // nothing published until commit
    e.commitSurfaces();
    e.commitSurfaces();
    expect(types(ev, 'pixels')).toHaveLength(1);
    expect(slotPx(e, s, 2, 2)).toEqual([10, 20, 30, 255]);
    expect(slotPx(e, s, 7, 7)).toEqual([200, 0, 0, 255]);
    expect(maskAt(e, m, 0, 0)).toBe(0);
    expect(maskAt(e, m, 1, 0)).toBe(128);
    expect(maskAt(e, m, 2, 0)).toBe(255);
    expect(px(e, 2, 2)).toEqual([10, 20, 30, 255]);
    expect(px(e, 0, 0)).toEqual([0, 0, 0, 255]); // mask 0 hides (layer there is empty anyway)
    expect(() => e.writeSurface(s, { x: 0.5, y: 0, w: 1, h: 1 }, new Uint8Array(4))).toThrow(RangeError);
    expect(() => e.writeSurface(s, { x: 0, y: 0, w: 2, h: 2 }, new Uint8Array(4))).toThrow(RangeError);
    e.writeSurface(s, { x: 0, y: 0, w: 0, h: 0 }, new Uint8Array(0));
  });

  it('writeSurface on a layer with an offset marks the shifted document area dirty', () => {
    e = newEngine(20, 20);
    const l = e.addPixelLayer();
    e.setTool('move');
    const p = (x: number) => ({ x, y: 0, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerDown(p(0));
    e.pointerUp(p(5));
    e.flush();
    const ev = collect(e);
    e.writeSurface(slotOf(e, l), { x: 0, y: 0, w: 4, h: 4 }, solid(4, 4, [255, 0, 0, 255]));
    e.commitSurfaces();
    const pix = types(ev, 'pixels')[0] as { rect: Rect };
    expect(pix.rect).toEqual({ x: 5, y: 0, w: 4, h: 4 });
    expect(px(e, 6, 1)).toEqual([255, 0, 0, 255]);
  });
});

describe('loadDocument', () => {
  function build(): Engine {
    const s = newEngine(40, 30);
    setBase(s, [50, 60, 70, 255]);
    const a = solidLayer(s, 'rgb(255,0,0)', 'Red');
    const m = s.addMask(a);
    s.setPaintTarget(a, 'mask');
    s.setToolContext(brushCtx({ size: 10 }));
    stroke(s, 'brush', [[10, 10]]);
    const g = s.addGroup('Grp');
    s.setActiveLayer(g);
    const b = s.addPixelLayer('Inner');
    s.moveLayer(b, g, 0);
    drawInner(s, b);
    s.setLayerProps(b, { opacity: 0.5, blend: 'multiply' });
    const adj = s.addAdjustment('hueSaturation');
    s.setAdjustment(adj, { type: 'hueSaturation', hue: 30, saturation: 1.5, value: 0.9 });
    s.addMask(adj);
    s.setLayerProps(g, { name: 'Grp2', visible: true });
    expect(m).toBeGreaterThan(0);
    return s;
  }
  function drawInner(s: Engine, id: string): void {
    s.writeSurface(slotOf(s, id), { x: 5, y: 5, w: 10, h: 10 }, solid(10, 10, [0, 0, 255, 255]));
    s.commitSurfaces();
  }

  function copyDoc(src: Engine, dst: Engine): void {
    const spec = src.docSpec();
    dst.loadDocument(JSON.parse(JSON.stringify(spec)) as DocSpec);
    for (const slot of src.surfaceSlots()) {
      dst.writeSurface(slot, { x: 0, y: 0, w: src.width, h: src.height }, src.readSurface(slot, { x: 0, y: 0, w: src.width, h: src.height }));
    }
    dst.commitSurfaces();
  }

  it('round trips stack, surfaces (including masks) and composite', () => {
    const src = build();
    e = newEngine(5, 5);
    setBase(e, [1, 2, 3, 255]);
    const ev = collect(e);
    e.addPixelLayer();
    ev.length = 0;
    copyDoc(src, e);
    expect(e.width).toBe(40);
    expect(e.height).toBe(30);
    expect(e.docSpec().layers).toEqual(src.docSpec().layers);
    expect(e.layers()).toEqual(src.layers());
    for (const slot of src.surfaceSlots()) {
      const w = src.readSurface(slot, { x: 0, y: 0, w: 40, h: 30 });
      expect(Array.from(e.readSurface(slot, { x: 0, y: 0, w: 40, h: 30 }))).toEqual(Array.from(w));
    }
    // base pixels come from TouchDesigner, not from the document
    e.writeBase({ x: 0, y: 0, w: 40, h: 30 }, solid(40, 30, [50, 60, 70, 255]));
    e.commitBase();
    const a = Array.from(src.readComposite({ x: 0, y: 0, w: 40, h: 30 }));
    const b = Array.from(e.readComposite({ x: 0, y: 0, w: 40, h: 30 }));
    let worst = 0;
    a.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - b[i])); });
    expect(worst).toBeLessThanOrEqual(2);
    expect(types(ev, 'resize')).toHaveLength(1);
    expect(e.history().entries).toHaveLength(0);
    expect(e.selection()).toBeNull();
    // new layers continue the numbering and never collide
    const n = e.addPixelLayer();
    expect(e.layers().filter((l) => l.id === n)).toHaveLength(1);
    expect(src.surfaceSlots()).not.toContain(slotOf(e, n));
    src.dispose();
  });

  it('emits structure + docspec (rev++) and a surface event per slot, clears history and selection', () => {
    const src = build();
    e = newEngine(40, 30);
    e.addPixelLayer();
    e.setSelection({ x: 0, y: 0, w: 3, h: 3 });
    const rev = e.docSpec().rev;
    const ev = collect(e);
    e.loadDocument(src.docSpec());
    const kinds = ev.map((x) => x.type);
    expect(kinds).toContain('structure');
    expect(kinds).toContain('selection');
    expect(kinds).toContain('history');
    expect(types(ev, 'docspec')).toHaveLength(1);
    expect(kinds.indexOf('docspec')).toBeLessThan(kinds.indexOf('surface'));
    expect(e.docSpec().rev).toBe(rev + 1);
    expect(types(ev, 'resize')).toHaveLength(0);
    expect(surf(ev).map((x) => x.slot).sort()).toEqual(src.surfaceSlots().sort());
    expect(surf(ev)[0].rect).toEqual({ x: 0, y: 0, w: 40, h: 30 });
    expect(e.history().entries).toHaveLength(0);
    // loading the same spec again still announces itself
    e.loadDocument(src.docSpec());
    expect(types(ev, 'docspec')).toHaveLength(2);
    src.dispose();
  });

  it('allocates empty pixel surfaces, white masks, keeps the base pixels, and rebuilds nesting order', () => {
    const src = build();
    e = newEngine(40, 30);
    setBase(e, [9, 9, 9, 255]);
    e.loadDocument(src.docSpec());
    for (const l of e.docSpec().layers) {
      if (l.kind === 'pixel' && l.slot !== null) expect(slotPx(e, l.slot, 10, 10)).toEqual([0, 0, 0, 0]);
      if (l.mask) expect(slotPx(e, l.mask.slot, 10, 10)).toEqual([255, 255, 255, 255]);
    }
    expect(px(e, 3, 3)).toEqual([9, 9, 9, 255]);
    expect(e.layers().map((l) => [l.name, l.depth])).toEqual(src.layers().map((l) => [l.name, l.depth]));
    expect(e.activeLayerId()).not.toBeNull();
    src.dispose();
  });

  it('rejects malformed documents without changing anything', () => {
    e = newEngine(10, 10);
    e.addPixelLayer();
    const good = e.docSpec();
    const before = JSON.stringify(e.docSpec());
    const bad = (mut: (s: DocSpec) => void): void => {
      const s = JSON.parse(JSON.stringify(good)) as DocSpec;
      mut(s);
      expect(() => e.loadDocument(s)).toThrow(RangeError);
    };
    bad((s) => { s.layers = []; });
    bad((s) => { s.width = 0; });
    bad((s) => { s.layers.reverse(); });
    bad((s) => { s.layers[1].id = 'base'; });
    bad((s) => { s.layers[1].parentId = 'nope'; });
    bad((s) => { s.layers[1].slot = 0; });
    bad((s) => { s.layers[1].slot = 1.5; });
    bad((s) => { s.layers.push({ ...s.layers[1], id: 'dup' }); });
    bad((s) => { s.layers.push({ ...s.layers[1], id: 'adj', kind: 'adjustment', slot: null, adjustment: null }); });
    bad((s) => { s.layers.push({ ...s.layers[1], id: 'adj', kind: 'adjustment', slot: null, adjustment: { type: 'nope' } as never }); });
    bad((s) => { s.layers.push({ ...s.layers[1], id: 'zz', kind: 'weird' as never, slot: null }); });
    bad((s) => { s.layers[0].mask = { slot: 9, enabled: true }; });
    expect(JSON.stringify(e.docSpec())).toBe(before);
  });

  it('sanitises values: opacity, blend, offsets, adjustment params, base id', () => {
    e = newEngine(10, 10);
    const spec: DocSpec = {
      rev: 5, width: 12, height: 8,
      layers: [
        { id: 'whatever', kind: 'base', parentId: null, name: 'In', visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, slot: null, mask: null, adjustment: null, text: null, shape: null, rasterize: false },
        { id: 'L7', kind: 'pixel', parentId: null, name: 'P', visible: true, opacity: 3, blend: 'bogus' as never, x: 2.4, y: -1, slot: 40, mask: null, adjustment: null, text: null, shape: null, rasterize: false },
        { id: 'A', kind: 'adjustment', parentId: null, name: 'Adj', visible: true, opacity: 1, blend: 'multiply', x: 0, y: 0, slot: null, mask: { slot: 41, enabled: false }, adjustment: { type: 'threshold', level: 5 }, text: null, shape: null, rasterize: false },
      ],
    };
    e.loadDocument(spec);
    const out = e.docSpec();
    expect(out.layers[0].id).toBe('base');
    expect(out.layers[1]).toMatchObject({ opacity: 1, blend: 'normal', x: 2, y: -1, slot: 40 });
    expect(out.layers[2]).toMatchObject({ blend: 'normal', mask: { slot: 41, enabled: false }, adjustment: { type: 'threshold', level: 1 } });
    const n = e.addPixelLayer();
    expect(n).toBe('L8');
    expect(e.layers().find((l) => l.id === n)?.slot).toBe(42);
    e.addMask(n);
    expect(e.layers().find((l) => l.id === n)?.mask?.slot).toBe(43);
  });

  it('works after a stroke is in flight and after the document size changes', () => {
    e = newEngine(10, 10);
    e.addPixelLayer();
    e.setToolContext(brushCtx());
    e.setTool('brush');
    e.pointerDown({ x: 3, y: 3, pressure: 1, shift: false, alt: false, ctrl: false });
    const small = newEngine(6, 6);
    small.addPixelLayer();
    e.loadDocument(small.docSpec());
    expect(e.width).toBe(6);
    expect(px(e, 3, 3)).toEqual([0, 0, 0, 0]);
    e.pointerUp({ x: 3, y: 3, pressure: 1, shift: false, alt: false, ctrl: false });
    small.dispose();
  });
});

describe('surface events', () => {
  function setup(): { id: string; slot: number; ev: EngineEvent[] } {
    e = newEngine(60, 60);
    e.setToolContext(brushCtx({ size: 10 }, { primary: rgba(255, 0, 0) }));
    const id = e.addPixelLayer();
    const slot = slotOf(e, id);
    return { id, slot, ev: collect(e) };
  }
  const inside = (r: Rect, outer: Rect) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

  it.each(['brush', 'pencil', 'eraser'] as const)('%s emits dirty rects around the dabs, and undo/redo emit the patch rects', (tool) => {
    const { slot, ev } = setup();
    stroke(e, tool, [[20, 20], [40, 20]]);
    const r = surf(ev, slot);
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) expect(inside(x.rect, { x: 10, y: 10, w: 40, h: 22 })).toBe(true);
    const union = r.reduce((a, b) => ({ x: Math.min(a.x, b.rect.x), y: Math.min(a.y, b.rect.y), w: 0, h: 0, x2: Math.max(a.x2, b.rect.x + b.rect.w), y2: Math.max(a.y2, b.rect.y + b.rect.h) }), { x: 1e9, y: 1e9, w: 0, h: 0, x2: -1, y2: -1 });
    expect(union.x).toBeLessThanOrEqual(15);
    expect(union.x2).toBeGreaterThanOrEqual(45);
    ev.length = 0;
    e.undo();
    expect(surf(ev, slot)).toHaveLength(1);
    expect(surf(ev, slot)[0].rect).toEqual({ x: 0, y: 0, w: 60, h: 60 }); // the 128 px tile, clipped to the surface
    ev.length = 0;
    e.redo();
    expect(surf(ev, slot)).toHaveLength(1);
  });

  it('fill and gradient emit; a refused paint emits nothing; other layers emit their own slot', () => {
    const { slot, ev } = setup();
    stroke(e, 'fill', [[5, 5]]);
    expect(surf(ev, slot).slice(-1)[0]?.rect).toEqual({ x: 0, y: 0, w: 60, h: 60 });
    ev.length = 0;
    e.setToolContext(brushCtx({}, { primary: rgba(255, 0, 0), secondary: rgba(0, 0, 255) }));
    stroke(e, 'gradient', [[0, 0], [60, 0]]);
    expect(surf(ev, slot).length).toBeGreaterThan(0);
    ev.length = 0;
    e.setActiveLayer('base');
    stroke(e, 'brush', [[10, 10]]);
    expect(surf(ev)).toHaveLength(0);
    const other = e.addPixelLayer();
    ev.length = 0;
    stroke(e, 'brush', [[10, 10]]);
    expect(new Set(surf(ev).map((x) => x.slot))).toEqual(new Set([slotOf(e, other)]));
  });

  it('mask paint, fill, undo and redo emit the mask slot', () => {
    const { id, ev } = setup();
    const m = e.addMask(id);
    e.setPaintTarget(id, 'mask');
    ev.length = 0;
    stroke(e, 'brush', [[30, 30]]);
    expect(surf(ev).every((x) => x.slot === m)).toBe(true);
    expect(surf(ev).length).toBeGreaterThan(0);
    ev.length = 0;
    stroke(e, 'fill', [[2, 2]]);
    expect(surf(ev).map((x) => x.slot)).toEqual([m]);
    ev.length = 0;
    e.undo();
    e.undo();
    e.redo();
    expect(surf(ev).every((x) => x.slot === m)).toBe(true);
    expect(surf(ev).length).toBe(3);
  });

  it('offset layers report surface-space rects', () => {
    const { slot, ev } = setup();
    e.setTool('move');
    const p = (x: number) => ({ x, y: 0, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerDown(p(0));
    e.pointerUp(p(20));
    ev.length = 0;
    stroke(e, 'pencil', [[30, 30]]);
    const r = surf(ev, slot)[0].rect;
    expect(r.x).toBeLessThanOrEqual(10);
    expect(r.x).toBeGreaterThanOrEqual(5);
  });

  it('a newly existing slot announces its whole surface (undo of delete, redo of add mask), new empty layers do not', () => {
    e = newEngine(30, 30);
    const ev = collect(e);
    const a = e.addPixelLayer();
    expect(surf(ev)).toHaveLength(0);
    solidLayerPaint(a);
    e.deleteLayer(a);
    ev.length = 0;
    e.undo();
    expect(surf(ev)).toEqual([{ type: 'surface', slot: slotOf(e, a), rect: { x: 0, y: 0, w: 30, h: 30 } }]);
    const m = e.addMask(a);
    expect(surf(ev, m)).toHaveLength(1); // new mask: white must reach TD
    ev.length = 0;
    e.undo();
    expect(surf(ev)).toHaveLength(0);
    e.redo();
    expect(surf(ev, m)).toHaveLength(1);
    ev.length = 0;
    const f = e.flattenToNewLayer();
    expect(surf(ev, slotOf(e, f))).toHaveLength(1);
  });

  function solidLayerPaint(id: string): void {
    e.setActiveLayer(id);
    e.setTool('fill');
    stroke(e, 'fill', [[3, 3]]);
  }

  it('surface events still flow with the preview disabled', () => {
    const { slot, ev } = setup();
    e.setPreviewEnabled(false);
    stroke(e, 'brush', [[20, 20]]);
    expect(surf(ev, slot).length).toBeGreaterThan(0);
    expect(types(ev, 'composite')).toHaveLength(0);
  });
});
