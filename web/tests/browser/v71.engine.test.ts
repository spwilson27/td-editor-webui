import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../src/engine';
import type { Effect, EngineEvent, ShapeSpec, TextSpec } from '../../src/engine/types';
import { brushCtx, collect, drawRect, newEngine, slotOf, stroke, type Px } from './engineTestUtils';

const engines: Engine[] = [];
const mk = (w = 32, h = 24): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });

const fx = (type: string, o: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...o }) as unknown as Effect;
const full = (e: Engine) => ({ x: 0, y: 0, w: e.width, h: e.height });
const surf = (e: Engine, slot: number): number[] => Array.from(e.readSurface(slot, full(e)));
const ids = (e: Engine): string[] => e.layers().map((l) => l.id);
const topAll = (e: Engine): string[] => e.layers().filter((l) => l.parentId === null).map((l) => l.id);
const top = (e: Engine): string[] => e.layers().filter((l) => l.parentId === null && l.kind !== 'input').map((l) => l.id);
const info = (e: Engine, id: string) => e.layers().find((l) => l.id === id)!;
const kids = (e: Engine, id: string): string[] => e.layers().filter((l) => l.parentId === id).map((l) => l.id);
const comp = (e: Engine): number[] => Array.from(e.readComposite(full(e)));
const spec = (e: Engine): string => JSON.stringify(e.docSpec().layers);
const RED: Px = [200, 30, 30, 255];
void RED;
const TEXT: TextSpec = { text: 'Hi', font: 'sans-serif', size: 12, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 2, y: 2, boxWidth: null };
const SHAPE: ShapeSpec = {
  type: 'rect', x: 3, y: 3, w: 10, h: 8, radius: 2, rotation: 0,
  fill: { enabled: true, color: { r: 10, g: 200, b: 20, a: 255 } }, stroke: { enabled: true, color: { r: 0, g: 0, b: 0, a: 255 }, width: 2 },
};

/** A pixel layer with a distinctive (semi-transparent too) pattern. */
function patterned(e: Engine, name: string, seed = 1): string {
  const id = e.addPixelLayer(name);
  drawRect(e, id, { x: 2, y: 2, w: 12, h: 10 }, `rgba(${40 * seed}, 90, 200, 0.5)`);
  drawRect(e, id, { x: 6, y: 5, w: 5, h: 4 }, `rgb(250, ${30 * seed}, 20)`);
  drawRect(e, id, { x: 20, y: 15, w: 4, h: 4 }, 'rgba(10, 220, 90, 0.37)');
  return id;
}

describe('v7.1 copy / paste', () => {
  it('the clip is a snapshot: painting the source afterwards does not change what is pasted (pixels and mask)', () => {
    const e = mk();
    const a = patterned(e, 'A');
    e.addMask(a);
    e.setPaintTarget(a, 'mask');
    e.setToolContext(brushCtx({ size: 6 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    stroke(e, 'brush', [[5, 5], [20, 12]]);
    e.setPaintTarget(a, 'pixels');
    const pix0 = surf(e, slotOf(e, a));
    const mask0 = surf(e, info(e, a).mask!.slot);
    const clip = e.copyLayers([a]);
    expect(clip.count).toBe(1);
    expect(clip.bytes).toBeGreaterThan(0);
    drawRect(e, a, full(e), '#ffffff');
    e.setPaintTarget(a, 'mask');
    e.setToolContext(brushCtx({ size: 20 }, { primary: { r: 255, g: 255, b: 255, a: 255 } }));
    stroke(e, 'brush', [[0, 0], [30, 20]]);
    expect(surf(e, info(e, a).mask!.slot)).not.toEqual(mask0);
    const [n] = e.pasteLayers(clip, null, 0);
    const ni = info(e, n);
    expect(ni.slot).not.toBe(info(e, a).slot);
    expect(surf(e, ni.slot as number)).toEqual(pix0); // semi-transparent pixels exactly
    expect(ni.mask).not.toBeNull();
    expect(ni.mask!.slot).not.toBe(info(e, a).mask!.slot);
    expect(surf(e, ni.mask!.slot)).toEqual(mask0);
    expect(ni.name).toBe('A copy');
  });

  it('pastes after the source was deleted, and after the delete was undone; the clip survives repeated pastes', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const pix0 = surf(e, slotOf(e, a));
    const clip = e.copyLayers([a]);
    e.deleteLayers([a]);
    const [n1] = e.pasteLayers(clip, null, 0);
    expect(surf(e, slotOf(e, n1))).toEqual(pix0);
    e.undo(); // paste
    e.undo(); // delete
    expect(top(e)).toEqual([a]);
    const [n2] = e.pasteLayers(clip, null, 0);
    const [n3] = e.pasteLayers(clip, null, 0);
    expect(new Set([a, n1, n2, n3]).size).toBe(4);
    expect(new Set([slotOf(e, a), slotOf(e, n2), slotOf(e, n3)]).size).toBe(3);
    expect(surf(e, slotOf(e, n3))).toEqual(pix0);
  });

  it('pastes into a group at index 0, below a layer, into an empty document and at the root top', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    const g = e.groupLayers([a], 'G');
    const clip = e.copyLayers([b]);
    const [inG] = e.pasteLayers(clip, g, 0);
    expect(kids(e, g)).toEqual([inG, a]);
    expect(info(e, inG).parentId).toBe(g);
    const [below] = e.pasteLayers(clip, null, top(e).indexOf(b) + 1);
    expect(top(e)).toEqual([b, below, g]);
    const [rootTop] = e.pasteLayers(clip, null, 0);
    expect(top(e)[0]).toBe(rootTop);
    expect(e.activeLayerId()).toBe(rootTop);
    // out-of-range index clamps
    const [last] = e.pasteLayers(clip, null, 999);
    expect(topAll(e).at(-1)).toBe(last);
    // invalid parent: nothing happens
    const len = e.history().entries.length;
    expect(e.pasteLayers(clip, 'nope', 0)).toEqual([]);
    expect(e.pasteLayers(clip, b, 0)).toEqual([]); // not a group
    expect(e.history().entries.length).toBe(len);

    const e2 = mk();
    expect(e2.layers().length).toBeLessThanOrEqual(1);
    for (const l of e2.layers()) e2.deleteLayers([l.id]);
    const c2 = e2.copyLayers([]);
    expect(c2.count).toBe(0);
    expect(e2.pasteLayers(c2, null, 0)).toEqual([]);
    const src = patterned(e2, 'S');
    const c3 = e2.copyLayers([src]);
    e2.deleteLayers([src]);
    expect(top(e2).filter((x) => info(e2, x).kind !== 'input')).toEqual([]);
    const [p] = e2.pasteLayers(c3, null, 0);
    expect(top(e2)).toContain(p);
  });

  it('copies a group subtree: nested group, child order, unique new ids and slots', () => {
    const e = mk();
    const c1 = patterned(e, 'c1');
    const c2 = patterned(e, 'c2', 2);
    const inner = e.groupLayers([c2], 'inner');
    const outer = e.groupLayers([c1, inner], 'outer');
    e.addMask(c1);
    const before = e.layers().map((l) => l.id);
    const srcSlots = new Set(e.surfaceSlots());
    const orderNames = (g: string): string[] => kids(e, g).map((k) => info(e, k).name);
    const outerKids = orderNames(outer);
    const clip = e.copyLayers([outer]);
    expect(clip.count).toBe(1);
    const [g2] = e.pasteLayers(clip, null, 0);
    expect(info(e, g2).name).toBe('outer copy');
    expect(orderNames(g2)).toEqual(outerKids); // children keep their names, in order
    const newIds = e.layers().map((l) => l.id).filter((i) => !before.includes(i));
    expect(newIds).toHaveLength(4); // outer, c1, inner, c2
    expect(new Set([...before, ...newIds]).size).toBe(before.length + 4);
    const newSlots = e.layers().filter((l) => newIds.includes(l.id)).flatMap((l) => [l.slot, l.mask?.slot]).filter((s): s is number => typeof s === 'number');
    expect(newSlots).toHaveLength(3); // two pixel layers + one mask
    expect(new Set(newSlots).size).toBe(3);
    for (const s of newSlots) expect(srcSlots.has(s)).toBe(false);
    const nInner = kids(e, g2).find((k) => info(e, k).kind === 'group')!;
    expect(kids(e, nInner)).toHaveLength(1);
    expect(info(e, kids(e, nInner)[0]).name).toBe('c2');
  });

  it('multi-select keeps stack order and returns ids top-first; a group plus its child copies once; inputs are skipped', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    const c = patterned(e, 'C', 3);
    // pass the ids in a scrambled order
    const clip = e.copyLayers([a, c, b]);
    expect(clip.count).toBe(3);
    const out = e.pasteLayers(clip, null, 0);
    expect(out).toHaveLength(3);
    expect(top(e).slice(0, 3)).toEqual(out);
    expect(out.map((i) => info(e, i).name)).toEqual(['C copy', 'B copy', 'A copy']);
    expect(e.history().entries.at(-1)!.label).toBe('Paste layers');

    const g = e.groupLayers([b], 'G');
    const n = e.layers().length;
    const gc = e.copyLayers([g, b]);
    expect(gc.count).toBe(1);
    const [pg] = e.pasteLayers(gc, null, 0);
    expect(e.layers().length).toBe(n + 2); // group + one child
    expect(kids(e, pg)).toHaveLength(1);

    const inp = e.addInputLayer(2);
    expect(e.copyLayers([inp]).count).toBe(0);
    const mixed = e.copyLayers([inp, a]);
    expect(mixed.count).toBe(1);
    const len = e.history().entries.length;
    expect(e.pasteLayers(e.copyLayers([inp]), null, 0)).toEqual([]);
    expect(e.history().entries.length).toBe(len);
    expect(e.duplicateLayers([inp])).toEqual([]);
    expect(e.history().entries.length).toBe(len);
  });

  it('cut = copy + delete: undo restores the originals, the clip still pastes', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    const state0 = spec(e);
    const c0 = comp(e);
    const pixA = surf(e, slotOf(e, a));
    const clip = e.copyLayers([a, b]);
    e.deleteLayers([a, b]);
    expect(top(e)).not.toContain(a);
    e.undo();
    expect(spec(e)).toBe(state0);
    expect(comp(e)).toEqual(c0);
    expect(surf(e, slotOf(e, a))).toEqual(pixA);
    const out = e.pasteLayers(clip, null, 0);
    expect(out).toHaveLength(2);
  });

  it('copies layer properties: transform, blend, opacity, visibility, lock, mask enabled flag, effects', () => {
    const e = mk();
    const a = patterned(e, 'A');
    e.setTransform(a, { x: 3, y: 2, sx: 1.5, sy: 0.75, rot: 20, kx: 5, ky: 0 });
    e.setLayerProps(a, { opacity: 0.4, blend: 'multiply', visible: false, locked: true });
    e.addMask(a);
    e.setEffects(a, [fx('invert')]);
    const clip = e.copyLayers([a]);
    const [n] = e.pasteLayers(clip, null, 0);
    const s = info(e, a);
    const t = info(e, n);
    expect(t.transform).toEqual(s.transform);
    expect(t).toMatchObject({ opacity: 0.4, blend: 'multiply', visible: false, locked: true, surfaceW: s.surfaceW, surfaceH: s.surfaceH });
    expect(t.effects).toEqual(s.effects);
    expect(t.effects).not.toBe(s.effects);
    expect(t.mask?.enabled).toBe(s.mask?.enabled);
  });

  it('text, shape and adjustment layers copy (specs, effects, masks incl. a doc-sized mask on an adjustment)', () => {
    const e = mk(40, 30);
    const t = e.addTextLayer(TEXT);
    const s = e.addShapeLayer(SHAPE);
    const adj = e.addAdjustmentLayer([fx('invert'), fx('blur', { sigma: 2, edge: 'hold' })], 'Adj');
    e.addMask(adj);
    e.addMask(t);
    e.setEffects(s, [fx('invert')]);
    e.setPaintTarget(adj, 'mask');
    e.setToolContext(brushCtx({ size: 10 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    stroke(e, 'brush', [[5, 5], [30, 20]]);
    const maskSrc = surf(e, info(e, adj).mask!.slot);
    expect(maskSrc.some((v, i) => i % 4 === 0 && v < 255)).toBe(true);
    const clip = e.copyLayers([t, s, adj]);
    expect(clip.count).toBe(3);
    const out = e.pasteLayers(clip, null, 0);
    expect(out.map((i) => info(e, i).kind)).toEqual(['adjustment', 'shape', 'text']);
    const [na, ns, nt] = out;
    expect(info(e, nt).text).toEqual(TEXT);
    expect(info(e, ns).shape).toEqual(SHAPE);
    expect(info(e, ns).effects).toEqual(info(e, s).effects);
    expect(info(e, na).effects).toEqual(info(e, adj).effects);
    expect(info(e, na).name).toBe('Adj copy');
    expect(info(e, na).mask).not.toBeNull();
    expect(surf(e, info(e, na).mask!.slot)).toEqual(maskSrc);
    expect(info(e, nt).mask).not.toBeNull();
    expect(info(e, nt).mask!.slot).not.toBe(info(e, t).mask!.slot);
    const clip2 = e.copyLayers([adj]);
    expect(e.pasteLayers(clip2, null, 0)).toHaveLength(1);
  });

  it('undo / redo of a paste restore pixels and the layer list', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    e.flush();
    const spec0 = spec(e);
    const comp0 = comp(e);
    const clip = e.copyLayers([a, b]);
    const out = e.pasteLayers(clip, null, 0);
    e.flush();
    const spec1 = spec(e);
    const comp1 = comp(e);
    const slotsAfter = e.surfaceSlots();
    e.undo();
    e.flush();
    expect(spec(e)).toBe(spec0);
    expect(comp(e)).toEqual(comp0);
    expect(ids(e)).not.toContain(out[0]);
    e.redo();
    e.flush();
    expect(spec(e)).toBe(spec1);
    expect(comp(e)).toEqual(comp1);
    expect(e.surfaceSlots()).toEqual(slotsAfter);
    expect(surf(e, slotOf(e, out[0]))).toEqual(surf(e, slotOf(e, b)));
  });

  it('history persistence round trip after a paste: restore, then undo removes the pasted layers', () => {
    const e1 = mk();
    const a = patterned(e1, 'A');
    const b = patterned(e1, 'B', 2);
    e1.addMask(b);
    const before = spec(e1);
    const clip = e1.copyLayers([a, b]);
    const out = e1.pasteLayers(clip, null, 0);
    e1.flush();
    const rev = e1.docSpec().rev;
    const blob = e1.serializeHistory(50, 256 * 1024 * 1024);
    const e2 = mk(e1.width, e1.height);
    const ds = e1.docSpec();
    e2.loadDocument(ds);
    for (const slot of e1.surfaceSlots()) {
      const sp = ds.layers.find((l) => l.slot === slot || l.mask?.slot === slot)!;
      const w = sp.slot === slot ? sp.surfaceW ?? ds.width : sp.surfaceW ?? ds.width;
      const h = sp.slot === slot ? sp.surfaceH ?? ds.height : sp.surfaceH ?? ds.height;
      e2.writeSurface(slot, { x: 0, y: 0, w, h }, e1.readSurface(slot, { x: 0, y: 0, w, h }));
    }
    e2.commitSurfaces();
    e2.flush();
    expect(e2.restoreHistory(blob, rev)).toBe(true);
    expect(e2.history().entries.map((x) => x.label)).toEqual(e1.history().entries.map((x) => x.label));
    e2.undo();
    e1.undo();
    e1.flush(); e2.flush();
    for (const o of out) expect(ids(e2)).not.toContain(o);
    expect(spec(e2)).toBe(before);
    expect(comp(e2)).toEqual(comp(e1));
    e2.redo();
    e2.flush();
    expect(ids(e2)).toContain(out[0]);
    expect(surf(e2, slotOf(e2, out[0]))).toEqual(surf(e2, slotOf(e2, b)));
  });

  it('syncing: a surface event with a full rect per new slot, rev increments, one history entry', () => {
    const e = mk();
    const a = patterned(e, 'A');
    e.addMask(a);
    const clip = e.copyLayers([a]);
    e.flush();
    const evs = collect(e);
    const rev0 = e.docSpec().rev;
    const n0 = e.history().entries.length;
    const [n] = e.pasteLayers(clip, null, 0);
    const li = info(e, n);
    const surfaceEvs = evs.filter((x): x is Extract<EngineEvent, { type: 'surface' }> => x.type === 'surface');
    for (const slot of [li.slot as number, li.mask!.slot]) {
      const ev = surfaceEvs.find((x) => x.slot === slot);
      expect(ev, `slot ${slot}`).toBeDefined();
      expect(ev!.rect).toEqual({ x: 0, y: 0, w: e.width, h: e.height });
    }
    expect(e.docSpec().rev).toBeGreaterThan(rev0);
    expect(e.history().entries.length).toBe(n0 + 1);
    expect(e.history().entries.at(-1)!.label).toBe('Paste layer');
  });

  it('a released clip pastes nothing', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const clip = e.copyLayers([a]);
    e.releaseClip(clip);
    const n0 = e.history().entries.length;
    expect(e.pasteLayers(clip, null, 0)).toEqual([]);
    expect(e.history().entries.length).toBe(n0);
    e.releaseClip(clip); // idempotent
  });

  it('one history entry per paste, even for a large clip (3 pixel layers 512x512)', () => {
    const e = mk(512, 512);
    const l = [1, 2, 3].map((i) => patterned(e, `P${i}`, i));
    const clip = e.copyLayers(l);
    expect(clip.bytes).toBeGreaterThanOrEqual(3 * 512 * 512 * 4);
    const n0 = e.history().entries.length;
    const out = e.pasteLayers(clip, null, 0);
    expect(out).toHaveLength(3);
    expect(e.history().entries.length).toBe(n0 + 1);
    out.forEach((o, i) => expect(surf(e, slotOf(e, o))).toEqual(surf(e, slotOf(e, l[2 - i]))));
  });
});

describe('v7.1 duplicate', () => {
  it('a single layer: the copy sits directly above the original, one entry, clipboard untouched', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    const clip = e.copyLayers([a]);
    const n0 = e.history().entries.length;
    const pix = surf(e, slotOf(e, a));
    const [d] = e.duplicateLayers([a]);
    expect(top(e)).toEqual([b, d, a]);
    expect(e.history().entries.length).toBe(n0 + 1);
    expect(e.history().entries.at(-1)!.label).toBe('Duplicate layer');
    expect(surf(e, slotOf(e, d))).toEqual(pix);
    expect(e.activeLayerId()).toBe(d);
    // the clip is unchanged and still pastes the original content
    const [p] = e.pasteLayers(clip, null, 0);
    expect(surf(e, slotOf(e, p))).toEqual(pix);
    // duplicate is a separate snapshot: painting the original does not affect the copy
    drawRect(e, a, full(e), '#fff');
    expect(surf(e, slotOf(e, d))).toEqual(pix);
  });

  it('adjacent multi-selection stays a block above the originals; non-adjacent runs each get their own block', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    const c = patterned(e, 'C', 3);
    const d = patterned(e, 'D', 4); // top -> bottom: D C B A
    const adj = e.duplicateLayers([b, c]);
    expect(adj).toHaveLength(2);
    expect(top(e)).toEqual([d, adj[0], adj[1], c, b, a]);
    expect(adj.map((i) => info(e, i).name)).toEqual(['C copy', 'B copy']);
    expect(e.history().entries.at(-1)!.label).toBe('Duplicate layers');

    const e2 = mk();
    const a2 = patterned(e2, 'A');
    const b2 = patterned(e2, 'B', 2);
    const c2 = patterned(e2, 'C', 3);
    const d2 = patterned(e2, 'D', 4);
    const out = e2.duplicateLayers([a2, d2]); // not adjacent
    expect(out).toHaveLength(2);
    expect(top(e2)).toEqual([out[0], d2, c2, b2, out[1], a2]);
    expect(e2.history().entries.length).toBeGreaterThan(0);
    e2.undo();
    expect(top(e2)).toEqual([d2, c2, b2, a2]);
  });

  it('duplicates inside a group and keeps the group intact', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    const g = e.groupLayers([a, b], 'G');
    const [d] = e.duplicateLayers([a]);
    expect(kids(e, g)).toEqual([b, d, a]);
    expect(info(e, d).parentId).toBe(g);
    const [dg] = e.duplicateLayers([g]);
    expect(kids(e, dg)).toHaveLength(3);
    expect(top(e)).toEqual([dg, g]);
  });

  it('slot exhaustion on duplicate changes nothing too', () => {
    const e = nearlyFull();
    const [a, b] = top(e);
    const n0 = e.history().entries.length;
    const sp = spec(e);
    expect(e.duplicateLayers([a, b])).toEqual([]);
    expect(spec(e)).toBe(sp);
    expect(e.history().entries.length).toBe(n0);
  });
});

/** A document whose slot counter stands at 65534 (one slot left) with two pixel layers. */
function nearlyFull(): Engine {
  const src = mk();
  const a = src.addPixelLayer('A');
  src.addPixelLayer('B');
  const ds = src.docSpec();
  const la = ds.layers.find((l) => l.id === a)!;
  la.slot = 65534;
  const e = mk(src.width, src.height);
  e.loadDocument(ds);
  return e;
}

describe('v7.1 slot exhaustion and aux remap', () => {
  it('pasting 2 pixel layers into a document with one free slot returns [] with a notice and changes nothing', () => {
    const e = nearlyFull();
    const [x, y] = top(e);
    drawRect(e, x, { x: 1, y: 1, w: 5, h: 5 }, '#f00');
    const clip = e.copyLayers([x, y]);
    const evs = collect(e);
    const before = spec(e);
    const slots = e.surfaceSlots();
    const n0 = e.history().entries.length;
    const rev0 = e.docSpec().rev;
    const act = e.activeLayerId();
    expect(e.pasteLayers(clip, null, 0)).toEqual([]);
    expect(evs.some((v) => v.type === 'notice')).toBe(true);
    expect(spec(e)).toBe(before);
    expect(e.surfaceSlots()).toEqual(slots);
    expect(e.history().entries.length).toBe(n0);
    expect(e.docSpec().rev).toBe(rev0);
    expect(e.activeLayerId()).toBe(act);
    // a single pixel layer still fits
    const one = e.copyLayers([y]);
    expect(e.pasteLayers(one, null, 0)).toHaveLength(1);
    expect(e.surfaceSlots()).toContain(65535);
  });

  const setup = () => {
    const e = mk(40, 30);
    const src = e.addPixelLayer('Src');
    drawRect(e, src, { x: 0, y: 0, w: 40, h: 30 }, 'rgb(120,120,120)');
    drawRect(e, src, { x: 5, y: 5, w: 20, h: 10 }, 'rgb(250,250,250)');
    const tgt = e.addPixelLayer('Tgt');
    drawRect(e, tgt, { x: 4, y: 4, w: 20, h: 16 }, '#e03030');
    return { e, src, tgt };
  };
  const aux = (e: Engine, id: string) => (info(e, id).effects[0] as unknown as { auxSource: unknown }).auxSource;

  it('copying both layers points the copied displace at the copied source (string form)', () => {
    const { e, src, tgt } = setup();
    e.setEffects(tgt, [fx('displace', { source: 'aux', auxSource: `layer:${src}`, strengthX: 8, strengthY: 4, edge: 'clamp' })]);
    const out = e.pasteLayers(e.copyLayers([src, tgt]), null, 0);
    const [ntgt, nsrc] = out;
    expect(aux(e, ntgt)).toBe(`layer:${nsrc}`);
    expect(aux(e, tgt)).toBe(`layer:${src}`); // original untouched
  });

  it('object form is remapped as well; duplicate remaps like paste', () => {
    const { e, src, tgt } = setup();
    e.setEffects(tgt, [fx('displace', { source: 'aux', auxSource: { kind: 'layer', id: src }, strengthX: 8, strengthY: 4, edge: 'clamp' })]);
    const [ntgt, nsrc] = e.duplicateLayers([src, tgt]);
    expect(aux(e, ntgt)).toEqual({ kind: 'layer', id: nsrc });
    expect(aux(e, tgt)).toEqual({ kind: 'layer', id: src });
  });

  it('copying only the effect layer keeps the reference to the original; inputs references are kept', () => {
    const { e, src, tgt } = setup();
    e.setEffects(tgt, [fx('displace', { source: 'aux', auxSource: `layer:${src}`, strengthX: 8, strengthY: 4, edge: 'clamp' })]);
    const [n] = e.pasteLayers(e.copyLayers([tgt]), null, 0);
    expect(aux(e, n)).toBe(`layer:${src}`);
    e.setEffects(tgt, [fx('displace', { source: 'aux', auxSource: 'input:2', strengthX: 8, strengthY: 4, edge: 'clamp' })]);
    const [m] = e.duplicateLayers([tgt]);
    expect(aux(e, m)).toBe('input:2');
  });
});

describe('v7.1 copy / paste: review follow-ups', () => {
  const notices = (evs: EngineEvent[]): string[] => evs.filter((v) => v.type === 'notice').map((v) => (v as { message: string }).message);
  const dispFx = (aux: unknown): Effect => fx('displace', { source: 'aux', auxSource: aux, strengthX: 8, strengthY: 4, edge: 'clamp' });
  const auxOf = (e: Engine, id: string) => (info(e, id).effects[0] as unknown as { auxSource?: unknown }).auxSource;
  const names = (e: Engine) => e.layers().map((l) => l.name);

  it('(a) a failing surface allocation mid-copy gives an empty clip, a notice, no change; other clips still paste', () => {
    const e = mk();
    const a = patterned(e, 'A');
    const b = patterned(e, 'B', 2);
    const c = patterned(e, 'C', 3);
    const good = e.copyLayers([a]);
    expect(good.count).toBe(1);
    const evs = collect(e);
    const before = spec(e);
    const hist0 = e.history().entries.length;
    const rev0 = e.docSpec().rev;
    const Orig = globalThis.OffscreenCanvas;
    let n = 0;
    vi.stubGlobal('OffscreenCanvas', class extends Orig {
      constructor(w: number, h: number) {
        if (++n === 2) throw new Error('out of memory');
        super(w, h);
      }
    });
    let bad;
    try {
      bad = e.copyLayers([b, c]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(n).toBeGreaterThanOrEqual(2);
    expect(bad.count).toBe(0);
    const msgs = notices(evs);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].startsWith('Cannot copy')).toBe(true);
    expect(spec(e)).toBe(before);
    expect(e.history().entries.length).toBe(hist0);
    expect(e.docSpec().rev).toBe(rev0);
    expect(e.pasteLayers(bad, null, 0)).toEqual([]);
    const out = e.pasteLayers(good, null, 0);
    expect(out).toHaveLength(1);
    expect(info(e, out[0]).name).toBe('A copy');
  });

  it('(b) cut clips keep the original names, copies add " copy"', () => {
    const e = mk();
    const a = patterned(e, 'Alpha');
    const g = e.addGroup?.('Grp') ?? null;
    void g;
    const cut = e.copyLayers([a], true);
    const [n1] = e.pasteLayers(cut, null, 0);
    expect(info(e, n1).name).toBe('Alpha');
    const [n2] = e.pasteLayers(e.copyLayers([a]), null, 0);
    expect(info(e, n2).name).toBe('Alpha copy');
    expect(names(e).filter((x) => x === 'Alpha')).toHaveLength(2);
  });

  it('(c) canvas resize between copy and paste', () => {
    const e = mk(32, 24);
    const adj = e.addAdjustmentLayer([fx('invert')], 'Adj');
    e.addMask(adj);
    e.setPaintTarget(adj, 'mask');
    e.setToolContext(brushCtx({ size: 8 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    stroke(e, 'brush', [[6, 6], [14, 10]]);
    const px = patterned(e, 'P');
    const spec0 = e.docSpec().layers.find((l) => l.id === px) as unknown as { x: number; y: number };
    const pix0 = Array.from(e.readSurface(slotOf(e, px), { x: 0, y: 0, w: 32, h: 24 }));
    const maskOld = surf(e, info(e, adj).mask!.slot);
    const clip = e.copyLayers([adj, px]);
    expect(clip.count).toBe(2);
    e.setCanvasSize(48, 40, 'tl');
    const out = e.pasteLayers(clip, null, 0);
    expect(out).toHaveLength(2);
    const outAdj = out.find((i) => info(e, i).kind === 'adjustment') as string;
    const outPx = out.find((i) => info(e, i).kind === 'pixel') as string;
    const nAdj = info(e, outAdj);
    const nPx = info(e, outPx);
    expect(nAdj.kind).toBe('adjustment');
    const m = e.readSurface(nAdj.mask!.slot, { x: 0, y: 0, w: 48, h: 40 });
    expect(m.length).toBe(48 * 40 * 4);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 48; x++) {
        const v = m[(y * 48 + x) * 4];
        if (x < 32 && y < 24) expect(v).toBe(maskOld[(y * 32 + x) * 4]);
        else expect(v).toBe(255);
      }
    }
    const ps = e.docSpec().layers.find((l) => l.id === outPx) as unknown as { x: number; y: number };
    expect([ps.x, ps.y]).toEqual([spec0.x, spec0.y]);
    expect(Array.from(e.readSurface(nPx.slot as number, { x: 0, y: 0, w: 32, h: 24 }))).toEqual(pix0);
    // a smaller canvas does not throw either
    const clip2 = e.copyLayers([outAdj]);
    e.setCanvasSize(10, 8, 'tl');
    expect(() => e.pasteLayers(clip2, null, 0)).not.toThrow();
    const [r] = e.pasteLayers(clip2, null, 0);
    expect(e.readSurface(info(e, r).mask!.slot, { x: 0, y: 0, w: 10, h: 8 }).length).toBe(10 * 8 * 4);
  });

  it('(d) paste into another document: foreign layer refs are dropped, input refs and copied refs survive', () => {
    const e = mk(40, 30);
    const src = e.addPixelLayer('Src');
    const tgt = e.addPixelLayer('Tgt');
    const tgt2 = e.addPixelLayer('Tgt2');
    e.setEffects(tgt, [dispFx(`layer:${src}`)]);
    e.setEffects(tgt2, [dispFx('input:2')]);
    const lone = e.copyLayers([tgt, tgt2]);
    const both = e.copyLayers([src, tgt]);
    const byName = (ids2: string[], n: string) => ids2.find((i) => info(e, i).name === `${n} copy`) as string;
    const sameIds = e.pasteLayers(lone, null, 0); // same document
    const s1 = byName(sameIds, 'Tgt');
    const s2 = byName(sameIds, 'Tgt2');
    expect(auxOf(e, s1)).toBe(`layer:${src}`);
    expect(auxOf(e, s2)).toBe('input:2');
    const other = newEngineSpec();
    e.loadDocument(other);
    const pIds = e.pasteLayers(lone, null, 0);
    const p1 = byName(pIds, 'Tgt');
    const p2 = byName(pIds, 'Tgt2');
    expect(info(e, p1).effects[0]).toMatchObject({ type: 'displace', source: 'aux' });
    expect(auxOf(e, p1)).toBeUndefined();
    expect(auxOf(e, p2)).toBe('input:2');
    const qIds = e.pasteLayers(both, null, 0);
    expect(auxOf(e, byName(qIds, 'Tgt'))).toBe(`layer:${byName(qIds, 'Src')}`);
  });

  function newEngineSpec() {
    const o = mk(20, 20);
    o.addPixelLayer('Other');
    return o.docSpec();
  }

  it('(e) eviction notice only when a paste evicts older undo steps; over-cap entries are not serialized', () => {
    const e = mk(256, 256);
    const a = e.addPixelLayer('Big');
    drawRect(e, a, { x: 0, y: 0, w: 256, h: 256 }, 'rgba(10,20,30,0.7)');
    const clip = e.copyLayers([a]);
    // a small history budget (the engine has no constructor option; the History is replaced for the test)
    (e as unknown as { hist: unknown }).hist = new (e as unknown as { hist: { constructor: new (o: object) => unknown } }).hist.constructor({ maxBytes: 3 * 1024 * 1024 });
    const evs = collect(e);
    e.pasteLayers(clip, null, 0);
    expect(notices(evs).some((m) => m === 'Large paste: older undo steps dropped')).toBe(false);
    let dropped = false;
    for (let i = 0; i < 40 && !dropped; i++) {
      e.pasteLayers(clip, null, 0);
      dropped = notices(evs).includes('Large paste: older undo steps dropped');
    }
    expect(dropped).toBe(true);
    // serialize with a cap smaller than one paste entry
    const blob = e.serializeHistory(50, 1024);
    expect(blob.length).toBeGreaterThan(0);
    const bigCap = e.serializeHistory(50, 64 * 1024 * 1024);
    expect(bigCap.length).toBeGreaterThan(blob.length);
    const e2 = mk(256, 256);
    e2.loadDocument(e.docSpec());
    for (const l of e.docSpec().layers) {
      if (l.kind === 'pixel' && l.slot != null) e2.writeSurface(l.slot, full(e), e.readSurface(l.slot, full(e)));
    }
    expect(e2.restoreHistory(blob, e.docSpec().rev)).toBe(true);
    expect(e2.history().entries.length).toBe(0);
  });
});

describe('v10: layer clipboard across editor tabs', () => {
  it('a clip outlives its engine and pastes into another engine as a foreign document (aux refs to layers that were not copied are dropped, pixels kept)', () => {
    const e1 = mk();
    const src = patterned(e1, 'Src');
    const tgt = patterned(e1, 'Tgt', 2);
    e1.setEffects(tgt, [fx('displace', { source: 'aux', auxSource: `layer:${src}`, strengthX: 8, strengthY: 4, edge: 'clamp' })]);
    const before = surf(e1, slotOf(e1, tgt));
    const clip = e1.copyLayers([tgt]);
    expect(clip.count).toBe(1);
    engines.splice(engines.indexOf(e1), 1);
    e1.dispose(); // the tab switch ends the engine
    const e2 = mk();
    const own = patterned(e2, 'Own'); // ids in two engines collide: the dropped ref must not point at this one
    void own;
    const [n] = e2.pasteLayers(clip, null, 0);
    expect(info(e2, n).name).toBe('Tgt copy');
    expect((info(e2, n).effects[0] as unknown as { auxSource?: unknown }).auxSource).toBeUndefined();
    expect(surf(e2, slotOf(e2, n))).toEqual(before);
    e2.releaseClip(clip);
    expect(clip.count).toBe(0);
  });
});
