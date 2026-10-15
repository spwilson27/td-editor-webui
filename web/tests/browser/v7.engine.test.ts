import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { AdjustmentSpec, DocSpec, Effect } from '../../src/engine/types';
import { brightnessContrastLut, hsvAdjust, levelsLut, luminance } from '../../src/engine/adjustments';
import { hashString } from '../../src/engine/historyBlob';
import { newEngine, near, px, solidLayer, type Px } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const W = 24;
const H = 16;
function gradient(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    d[o] = x * 10; d[o + 1] = y * 15 + 5; d[o + 2] = (x * 7 + y * 3) % 256; d[o + 3] = 255;
  }
  return d;
}
function withBase(): Engine {
  const x = newEngine(W, H);
  x.writeBase({ x: 0, y: 0, w: W, h: H }, gradient());
  x.commitBase();
  return x;
}
/** v6 maths of one classic adjustment (the reference of adjustments.ts) applied to the gradient. */
function reference(s: AdjustmentSpec): Uint8ClampedArray {
  const d = gradient();
  for (let i = 0; i < d.length; i += 4) {
    if (s.type === 'levels') { const l = levelsLut(s); d[i] = l[d[i]]; d[i + 1] = l[d[i + 1]]; d[i + 2] = l[d[i + 2]]; }
    else if (s.type === 'brightnessContrast') { const l = brightnessContrastLut(s); d[i] = l[d[i]]; d[i + 1] = l[d[i + 1]]; d[i + 2] = l[d[i + 2]]; }
    else if (s.type === 'hueSaturation') hsvAdjust(d[i], d[i + 1], d[i + 2], s.hue, s.saturation, s.value, d, i);
    else if (s.type === 'invert') { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    else if (s.type === 'threshold') { const v = luminance(d[i], d[i + 1], d[i + 2]) >= s.level * 255 ? 255 : 0; d[i] = v; d[i + 1] = v; d[i + 2] = v; }
  }
  return d;
}
const readAll = (x: Engine) => x.readComposite({ x: 0, y: 0, w: W, h: H });

/** A v6 document: the gradient base plus one adjustment layer holding a legacy `adjustment` spec. */
function legacyDoc(adj: AdjustmentSpec, effects: Effect[] = []): DocSpec {
  const src = withBase();
  const id = src.addAdjustmentLayer([]);
  const spec = src.docSpec();
  src.dispose();
  const l = spec.layers.find((x) => x.id === id)!;
  l.adjustment = adj;
  l.effects = effects;
  return spec;
}
function loadLegacy(adj: AdjustmentSpec, effects: Effect[] = []): Engine {
  const x = newEngine(W, H);
  x.loadDocument(legacyDoc(adj, effects));
  x.writeBase({ x: 0, y: 0, w: W, h: H }, gradient());
  x.commitBase();
  x.flush();
  return x;
}

const CLASSIC: AdjustmentSpec[] = [
  { type: 'levels', inLow: 0.1, inHigh: 0.9, gamma: 1.8, outLow: 0.05, outHigh: 0.95 },
  { type: 'brightnessContrast', brightness: 0.25, contrast: -0.3 },
  { type: 'hueSaturation', hue: 70, saturation: 1.4, value: 0.8 },
  { type: 'invert' },
  { type: 'threshold', level: 0.45 },
];

describe('v7 unified adjustments: migration of legacy specs', () => {
  for (const spec of CLASSIC) {
    it(`${spec.type}: migrated legacy adjustment renders like the v6 maths (<= 1/255)`, () => {
      e = loadLegacy(spec);
      const l = e.layers()[0];
      expect(l.kind).toBe('adjustment');
      expect(l.adjustment).toBeNull();
      expect(l.effects).toHaveLength(1);
      const { type, ...params } = spec;
      expect(l.effects[0]).toMatchObject({ type, enabled: true, ...params });
      const got = readAll(e);
      const want = reference(spec);
      let worst = 0;
      for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
      expect(worst).toBeLessThanOrEqual(1);
    });

    it(`${spec.type}: the new path (addAdjustmentLayer) equals the legacy path`, () => {
      e = loadLegacy(spec);
      const legacy = Array.from(readAll(e));
      e.dispose();
      e = withBase();
      const { type, ...params } = spec;
      e.addAdjustmentLayer([{ enabled: true, type, ...params } as unknown as Effect]);
      expect(near(Array.from(readAll(e)), legacy, 1)).toBe(true);
    });
  }

  it('a filter adjustment migrates to its effect; the old effects[] follow it', () => {
    const overlay = { enabled: true, type: 'colorOverlay', color: { r: 0, g: 255, b: 0, a: 255 }, opacity: 0.5 } as Effect;
    const old = { enabled: true, type: 'invert' } as unknown as Effect;
    e = loadLegacy({ type: 'filter', effect: overlay }, [old]);
    const fx = e.layers()[0].effects;
    expect(fx.map((f) => f.type)).toEqual(['colorOverlay', 'invert']);
    const got = Array.from(readAll(e));
    e.dispose();
    e = withBase();
    e.addAdjustmentLayer([overlay, old]);
    expect(near(got, Array.from(readAll(e)), 1)).toBe(true);
  });

  it('a blur adjustment becomes the canonical blur filter (legacyBlurToFilter)', () => {
    e = loadLegacy({ type: 'blur', radius: 3 });
    expect(e.layers()[0].effects[0]).toMatchObject({ type: 'blur', enabled: true, sigma: 3, edge: 'hold' });
  });

  // v6 parity of blur: the old adjustment path (renderAdjusted: gaussian sigma = radius, edge hold) vs the migrated filter in the engine.
  for (const [r, tol] of [[2, 1], [4, 1], [10, 2], [16, 2]] as const) {
    it(`blur radius ${r}: old path vs migrated filter, including the border rows (<= ${tol}/255)`, () => {
      const BW = 48;
      const BH = 40;
      const src = new Uint8ClampedArray(BW * BH * 4);
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
        const o = (y * BW + x) * 4;
        const on = (Math.floor(x / 6) + Math.floor(y / 5)) % 2 === 0;
        src[o] = on ? 240 : 20; src[o + 1] = (x * 5) % 256; src[o + 2] = (y * 6) % 256; src[o + 3] = 255;
      }
      // old path: the v6 blur adjustment = gaussian, sigma = radius, outside the document repeats the edge pixels (opaque source: premultiplication is moot).
      // Computed exactly in float (Chromium's canvas blur is a Skia approximation of it, 10+ levels off on this pattern).
      const R = Math.ceil(5 * r);
      const kern = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * r * r)));
      const ksum = kern.reduce((x, y) => x + y, 0);
      const pass = (inp: Float64Array, horizontal: boolean): Float64Array => {
        const out = new Float64Array(inp.length);
        for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let k = -R; k <= R; k++) {
            const xx = horizontal ? Math.min(BW - 1, Math.max(0, x + k)) : x;
            const yy = horizontal ? y : Math.min(BH - 1, Math.max(0, y + k));
            acc += inp[(yy * BW + xx) * 4 + c] * kern[k + R];
          }
          out[(y * BW + x) * 4 + c] = acc / ksum;
        }
        return out;
      };
      const f = pass(pass(Float64Array.from(src), true), false);
      const want = new Uint8ClampedArray(src.length);
      for (let i = 0; i < want.length; i++) want[i] = i % 4 === 3 ? 255 : Math.round(f[i]);
      // new path: the migrated legacy document
      e = newEngine(BW, BH);
      const base = newEngine(BW, BH);
      base.addAdjustmentLayer([]);
      const spec = base.docSpec();
      base.dispose();
      spec.layers.find((l) => l.kind === 'adjustment')!.adjustment = { type: 'blur', radius: r };
      e.loadDocument(spec);
      e.writeBase({ x: 0, y: 0, w: BW, h: BH }, src);
      e.commitBase();
      e.flush();
      const got = e.readComposite({ x: 0, y: 0, w: BW, h: BH });
      let worst = 0;
      for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
      expect(worst).toBeLessThanOrEqual(tol);
    });
  }

  it('migration is idempotent: docSpec round trips without a legacy adjustment', () => {
    e = loadLegacy(CLASSIC[0]);
    const ds = e.docSpec();
    expect(ds.layers.find((l) => l.kind === 'adjustment')?.adjustment).toBeNull();
    const e2 = newEngine(W, H);
    e2.loadDocument(ds);
    expect(e2.docSpec().layers.find((l) => l.kind === 'adjustment')?.effects).toEqual(ds.layers.find((l) => l.kind === 'adjustment')?.effects);
    e2.dispose();
  });

  it('wrappers: addAdjustment / setAdjustment operate on effects[]', () => {
    e = withBase();
    const id = e.addAdjustment('invert');
    expect(e.layers()[0].effects).toMatchObject([{ type: 'invert', enabled: true }]);
    e.setAdjustment(id, { type: 'threshold', level: 0.3 });
    expect(e.layers()[0].effects).toMatchObject([{ type: 'threshold', level: 0.3 }]);
    expect(e.layers()[0].effects).toHaveLength(1);
    const f = e.addFilterAdjustment!({ enabled: true, type: 'colorOverlay', color: { r: 1, g: 2, b: 3, a: 255 }, opacity: 1 }, 'Tint');
    expect(e.layers().find((l) => l.id === f)).toMatchObject({ name: 'Tint', adjustment: null });
  });

  it('a blob written for the pre-migration (legacy-shaped) document is still accepted', () => {
    e = withBase();
    const id = e.addAdjustment('invert');
    e.setAdjustment(id, { type: 'threshold', level: 0.6 });
    e.flush();
    // the document as a v6 file had it: `adjustment: {...}` and no migrated effect
    const legacy = e.docSpec();
    const l = legacy.layers.find((x) => x.id === id)!;
    l.adjustment = { type: 'threshold', level: 0.6 };
    l.effects = [];
    const legacySig = hashString(JSON.stringify([legacy.width, legacy.height, legacy.layers, legacy.guides, legacy.canvas]));
    (e as unknown as { layoutSig: () => string }).layoutSig = () => legacySig; // what a v6 engine wrote into the blob
    const blob = e.serializeHistory(50, 1 << 24);
    const rev = e.docSpec().rev;
    const afterEdit = Array.from(readAll(e));
    const e2 = newEngine(W, H);
    e2.loadDocument(JSON.parse(JSON.stringify(legacy)) as DocSpec);
    e2.writeBase({ x: 0, y: 0, w: W, h: H }, gradient());
    e2.commitBase();
    expect(e2.restoreHistory(blob, rev)).toBe(true);
    expect(e2.history().entries.map((x) => x.label)).toEqual(e.history().entries.map((x) => x.label));
    e2.flush();
    expect(near(Array.from(readAll(e2)), afterEdit, 1)).toBe(true);
    e2.undo();
    e2.undo();
    e2.flush();
    expect(Array.from(readAll(e2))).toEqual(Array.from(gradient())); // back to the plain base
    e2.dispose();
    // a blob of another layout is refused, history untouched
    const e3 = newEngine(W, H);
    e3.loadDocument(JSON.parse(JSON.stringify(e.docSpec())) as DocSpec);
    expect(e3.restoreHistory(blob, rev)).toBe(false);
    expect(e3.history().entries).toHaveLength(0);
    e3.dispose();
  });
});

describe('v7 persisted history of batch operations (with surface pixels)', () => {
  const engines: Engine[] = [];
  afterEach(() => { while (engines.length) engines.pop()?.dispose(); });
  const mk = (): Engine => { const x = newEngine(24, 18); engines.push(x); return x; };
  const comp = (x: Engine) => Array.from(x.readComposite({ x: 0, y: 0, w: 24, h: 18 }));
  const names2 = (x: Engine) => x.layers().map((l) => `${l.name}:${l.parentId ?? '-'}:${l.visible ? 1 : 0}${l.locked ? 'L' : ''}`).join('|');
  function reload(src: Engine): Engine {
    const x = mk();
    const spec = src.docSpec();
    x.loadDocument(spec);
    for (const slot of src.surfaceSlots()) {
      const sp = spec.layers.find((l) => l.slot === slot || l.mask?.slot === slot);
      const w = sp?.slot === slot ? sp.surfaceW ?? spec.width : sp?.surfaceW ?? spec.width;
      const h = sp?.slot === slot ? sp.surfaceH ?? spec.height : sp?.surfaceH ?? spec.height;
      x.writeSurface(slot, { x: 0, y: 0, w, h }, src.readSurface(slot, { x: 0, y: 0, w, h }));
    }
    x.commitSurfaces();
    x.flush();
    return x;
  }

  it('undo / redo of group, move, props, delete, merge and adjustment steps match across save and reload', () => {
    const a = mk();
    const A = solidLayer(a, 'red', 'A');
    const B = solidLayer(a, 'rgb(0,200,0)', 'B');
    const C = solidLayer(a, 'blue', 'C');
    a.setLayerProps(C, { opacity: 0.5, blend: 'multiply' });
    const g = a.groupLayers([A, C], 'G');
    a.moveLayers([B], g, 0);
    a.setLayersProps([A, B], { visible: false });
    a.setLayersProps([A], { locked: true });
    a.addAdjustmentLayer([{ enabled: true, type: 'invert' } as unknown as Effect]);
    const px24 = new Uint8ClampedArray(24 * 18 * 4);
    for (let i = 0; i < px24.length; i += 4) { px24[i] = 10; px24[i + 1] = 90; px24[i + 2] = 200; px24[i + 3] = 255; }
    a.replaceLayersWithPixels([C], px24, 24, 18, 'Merged');
    a.deleteLayers([B]);
    a.flush();
    const n = a.history().entries.length;
    const rev = a.docSpec().rev;
    const blob = a.serializeHistory(100, 1 << 28);
    const b = reload(a);
    expect(b.restoreHistory(blob, rev)).toBe(true);
    expect(b.history().entries.map((x) => x.label)).toEqual(a.history().entries.map((x) => x.label));
    for (let i = 0; i < n; i++) {
      a.undo(); b.undo(); a.flush(); b.flush();
      expect(names2(b), `undo ${i + 1}`).toBe(names2(a));
      expect(comp(b), `undo ${i + 1}`).toEqual(comp(a));
    }
    for (let i = 0; i < n; i++) {
      a.redo(); b.redo(); a.flush(); b.flush();
      expect(names2(b), `redo ${i + 1}`).toBe(names2(a));
      expect(comp(b), `redo ${i + 1}`).toEqual(comp(a));
    }
  });
});

const names = (x: Engine) => x.layers().map((l) => l.name);

describe('v7 batch layer operations', () => {
  function stack(): { a: string; b: string; c: string; d: string } {
    e = newEngine(20, 20);
    const a = solidLayer(e, 'red', 'A');
    const b = solidLayer(e, 'green', 'B');
    const c = solidLayer(e, 'blue', 'C');
    const d = solidLayer(e, 'white', 'D');
    return { a, b, c, d }; // top to bottom: D C B A TD Input
  }

  it('deleteLayers: one history entry, undo restores', () => {
    const { a, c } = stack();
    const n = e.history().entries.length;
    e.deleteLayers([a, c]);
    expect(names(e)).toEqual(['D', 'B', 'TD Input']);
    expect(e.history().entries).toHaveLength(n + 1);
    expect(e.layers().some((l) => l.id === e.activeLayerId())).toBe(true);
    e.undo();
    expect(names(e)).toEqual(['D', 'C', 'B', 'A', 'TD Input']);
    e.redo();
    expect(names(e)).toEqual(['D', 'B', 'TD Input']);
  });

  it('deleteLayers: a selected child of a selected group goes with the group; unknown ids are ignored', () => {
    const { a } = stack();
    const g = e.addGroup('G');
    e.moveLayer(a, g, 0);
    e.deleteLayers([a, g, 'nope']);
    expect(names(e)).not.toContain('G');
    expect(names(e)).not.toContain('A');
    e.undo();
    expect(names(e)).toContain('A');
    const n = e.history().entries.length;
    e.deleteLayers(['nope']);
    expect(e.history().entries).toHaveLength(n);
  });

  it('setLayersProps: visibility and lock of several layers, one entry, composite updated', () => {
    const { b, c, d } = stack();
    const n = e.history().entries.length;
    e.setLayersProps([c, d], { visible: false });
    expect(e.history().entries).toHaveLength(n + 1);
    expect(px(e, 3, 3)).toEqual([0, 128, 0, 255]); // B (green) shows
    e.setLayersProps([b, c], { locked: true });
    expect(e.layers().filter((l) => l.locked).map((l) => l.name).sort()).toEqual(['B', 'C', 'TD Input']);
    e.setLayersProps([b, c], { locked: true }); // no change, no entry
    expect(e.history().entries).toHaveLength(n + 2);
    e.undo();
    e.undo();
    expect(px(e, 3, 3)).toEqual([255, 255, 255, 255]);
  });

  it('moveLayers keeps relative order, into and out of groups', () => {
    const { a, b, c } = stack();
    const g = e.addGroup('G');
    const n = e.history().entries.length;
    e.moveLayers([a, c], g, 0);
    expect(e.history().entries).toHaveLength(n + 1);
    const info = e.layers();
    const gi = info.findIndex((l) => l.name === 'G');
    expect(info.slice(gi + 1, gi + 3).map((l) => l.name)).toEqual(['C', 'A']); // stack order kept (C was above A)
    expect(info[gi + 1].parentId).toBe(g);
    e.moveLayers([a, c, b], null, 0);
    expect(names(e).slice(0, 3)).toEqual(['C', 'A', 'B']); // current display order (C, A were in the group above B)
    expect(e.layers().every((l) => l.parentId === null)).toBe(true);
  });

  it('moveLayers rejects a group into itself or a descendant, and no-op moves make no entry', () => {
    const { a } = stack();
    const g = e.addGroup('G');
    const h = e.addGroup('H');
    e.moveLayer(h, g, 0);
    e.moveLayer(a, h, 0);
    const n = e.history().entries.length;
    e.moveLayers([g], h, 0);
    e.moveLayers([g], g, 0);
    e.moveLayers([g, a], h, 0);
    expect(e.history().entries).toHaveLength(n);
    const top = e.layers()[0].id;
    e.moveLayers([top], null, 0);
    expect(e.history().entries).toHaveLength(n);
  });

  it('groupLayers wraps in a group at the topmost position, stack order kept, one entry', () => {
    const { a, b, c } = stack();
    const n = e.history().entries.length;
    const g = e.groupLayers([a, c], 'Pair');
    expect(e.history().entries).toHaveLength(n + 1);
    expect(names(e)).toEqual(['D', 'Pair', 'C', 'A', 'B', 'TD Input']);
    expect(e.layers().find((l) => l.id === g)).toMatchObject({ kind: 'group', depth: 0 });
    expect(e.activeLayerId()).toBe(g);
    expect(px(e, 3, 3)).toEqual([255, 255, 255, 255]);
    e.undo();
    expect(names(e)).toEqual(['D', 'C', 'B', 'A', 'TD Input']);
    expect(b).toBeTruthy();
  });

  it('groupLayers across different parents moves them into the new group at the topmost parent', () => {
    const { a, b, c } = stack();
    const g = e.addGroup('G');
    e.moveLayer(b, g, 0);
    const ng = e.groupLayers([c, b, a]);
    const info = e.layers();
    const gi = info.find((l) => l.id === ng)!;
    expect(gi.parentId).toBe(g); // the topmost selected layer (B) lives in G
    expect(info.filter((l) => l.parentId === ng).map((l) => l.name)).toEqual(['B', 'C', 'A']);
  });

  it('groupLayers composite equals the ungrouped one (effects, opacity, masks)', () => {
    const { b, c } = stack();
    e.setLayerProps(c, { opacity: 0.5 });
    e.flush();
    const before = Array.from(e.readComposite({ x: 0, y: 0, w: 20, h: 20 }));
    e.groupLayers([b, c]);
    e.flush();
    expect(near(Array.from(e.readComposite({ x: 0, y: 0, w: 20, h: 20 })), before, 1)).toBe(true);
  });
});

describe('v7 replaceLayersWithPixels', () => {
  function rgbaFill(w: number, h: number, c: Px): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i += 4) d.set(c, i);
    return d;
  }

  it('merge selected: removes ids, inserts one doc-sized pixel layer at the topmost position, one entry, pixels shown', () => {
    e = newEngine(20, 20);
    const a = solidLayer(e, 'red', 'A');
    const b = solidLayer(e, 'green', 'B');
    const c = solidLayer(e, 'blue', 'C');
    const n = e.history().entries.length;
    const id = e.replaceLayersWithPixels([a, c], rgbaFill(20, 20, [10, 20, 30, 255]), 20, 20, 'Merged');
    expect(e.history().entries).toHaveLength(n + 1);
    expect(names(e)).toEqual(['Merged', 'B', 'TD Input']);
    expect(e.layers()[0]).toMatchObject({ id, kind: 'pixel', opacity: 1, blend: 'normal', mask: null, transform: { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 }, surfaceW: 20, surfaceH: 20 });
    expect(e.activeLayerId()).toBe(id);
    e.flush();
    expect(px(e, 5, 5)).toEqual([10, 20, 30, 255]);
    expect(b).toBeTruthy();
    e.undo();
    expect(names(e)).toEqual(['C', 'B', 'A', 'TD Input']);
    expect(px(e, 5, 5)).toEqual([0, 0, 255, 255]);
    e.redo();
    e.flush();
    expect(px(e, 5, 5)).toEqual([10, 20, 30, 255]);
  });

  it('flatten of a group in a group and mergeDown [adjustment, below] keep positions', () => {
    e = newEngine(20, 20);
    const a = solidLayer(e, 'red', 'A');
    const g = e.addGroup('G');
    e.moveLayer(a, g, 0);
    const above = solidLayer(e, 'green', 'Top');
    const id = e.replaceLayersWithPixels([g], rgbaFill(20, 20, [1, 2, 3, 255]), 20, 20);
    expect(names(e)).toEqual(['Top', 'G', 'TD Input']); // single id: keeps the name
    expect(e.layers()[1].id).toBe(id);
    expect(above).toBeTruthy();
    const adj = e.addAdjustment('invert');
    e.setActiveLayer(adj);
    expect(e.layers()[0].id).toBeTruthy();
    const ls = e.layers();
    const below = ls[ls.findIndex((l) => l.id === adj) + 1].id;
    e.replaceLayersWithPixels([adj, below], rgbaFill(20, 20, [9, 9, 9, 255]), 20, 20, 'Top');
    expect(e.layers().some((l) => l.kind === 'adjustment')).toBe(false);
    e.flush();
    expect(names(e)).toEqual(['Top', 'Top', 'TD Input']);
    expect(e.layers()[1].kind).toBe('pixel');
    expect(px(e, 2, 2)).toEqual([0, 128, 0, 255]); // 'Top' (green) still covers
  });

  it('validates the buffer and ignores unknown ids', () => {
    e = newEngine(8, 8);
    const a = solidLayer(e, 'red');
    expect(() => e.replaceLayersWithPixels([a], new Uint8Array(4), 8, 8)).toThrow(RangeError);
    expect(() => e.replaceLayersWithPixels([a], new Uint8Array(0), 0, 8)).toThrow(RangeError);
    expect(e.replaceLayersWithPixels(['nope'], new Uint8Array(8 * 8 * 4), 8, 8)).toBe('');
  });

  it('caches stay right: effects/tdPreview layers removed leave no stale preview', () => {
    e = newEngine(12, 12);
    const a = solidLayer(e, 'red', 'A');
    e.setEffects(a, [{ enabled: true, type: 'colorOverlay', color: { r: 0, g: 0, b: 255, a: 255 }, opacity: 1 }]);
    e.flush();
    e.replaceLayersWithPixels([a], rgbaFill(12, 12, [5, 6, 7, 255]), 12, 12);
    e.flush();
    expect(px(e, 3, 3)).toEqual([5, 6, 7, 255]);
    expect(e.tdPreviewLayers()).toEqual([]);
    e.undo();
    e.flush();
    expect(px(e, 3, 3)).toEqual([0, 0, 255, 255]);
  });
});

describe('v7 review fixes', () => {
  const all = (x: Engine) => Array.from(x.readComposite({ x: 0, y: 0, w: 20, h: 20 }));

  it('groupLayers invalidates when the composite changes: non-contiguous ids with a translucent child', () => {
    e = newEngine(20, 20);
    const A = solidLayer(e, 'red', 'A');
    const B = solidLayer(e, 'rgb(0,200,0)', 'B');
    const C = solidLayer(e, 'blue', 'C');
    e.setLayerProps(C, { opacity: 0.5 });
    e.flush();
    e.groupLayers([A, C]); // A moves up over B: the picture changes
    e.flush();
    const incremental = all(e);
    e.changed({ x: 0, y: 0, w: 20, h: 20 });
    e.flush();
    expect(incremental).toEqual(all(e));
    expect(B).toBeTruthy();
    expect(px(e, 3, 3)[1]).toBeLessThan(100); // green B no longer shows through: A (red) is under the half-blue C, above B
  });

  it('groupLayers invalidates for a lone multiply child (isolated group changes the blend backdrop)', () => {
    e = newEngine(20, 20);
    solidLayer(e, 'rgb(0,200,0)', 'B');
    const C = solidLayer(e, 'rgb(200,100,50)', 'C');
    e.setLayerProps(C, { blend: 'multiply' });
    e.flush();
    const before = px(e, 3, 3);
    e.groupLayers([C]);
    e.flush();
    const after = px(e, 3, 3);
    expect(after).not.toEqual(before); // multiply now has nothing to multiply with inside the group
    const incremental = all(e);
    e.changed({ x: 0, y: 0, w: 20, h: 20 });
    e.flush();
    expect(incremental).toEqual(all(e));
  });

  it('groupLayers of a contiguous plain run keeps the picture', () => {
    e = newEngine(20, 20);
    const A = solidLayer(e, 'red', 'A');
    const B = solidLayer(e, 'rgb(0,200,0)', 'B');
    e.flush();
    const before = all(e);
    e.groupLayers([A, B]);
    e.flush();
    expect(all(e)).toEqual(before);
  });

  it('setAdjustment replaces only a classic / blur head, otherwise prepends', () => {
    e = newEngine(10, 10);
    const id = e.addAdjustmentLayer([{ enabled: true, type: 'colorOverlay', color: { r: 1, g: 2, b: 3, a: 255 }, opacity: 1 } as Effect]);
    e.setAdjustment(id, { type: 'invert' });
    expect(e.layers()[0].effects.map((f) => f.type)).toEqual(['invert', 'colorOverlay']);
    e.setAdjustment(id, { type: 'threshold', level: 0.4 });
    expect(e.layers()[0].effects.map((f) => f.type)).toEqual(['threshold', 'colorOverlay']);
    e.setAdjustment(id, { type: 'blur', radius: 3 });
    expect(e.layers()[0].effects.map((f) => f.type)).toEqual(['blur', 'colorOverlay']);
  });

  it('stackIsIdentity: blur with sigma > 0 is not an identity', async () => {
    const { stackIsIdentity } = await import('../../src/engine/adjustments');
    const blur = (o: object) => ({ enabled: true, type: 'blur', ...o }) as unknown as Effect;
    expect(stackIsIdentity([blur({ radius: 0, sigma: 0 })])).toBe(true);
    expect(stackIsIdentity([blur({ radius: 0, sigma: 2 })])).toBe(false);
    expect(stackIsIdentity([blur({ radius: 6 })])).toBe(false);
    expect(stackIsIdentity([{ enabled: false, type: 'invert' } as unknown as Effect])).toBe(true);
  });

  it('classic adjustment maths on translucent pixels: JS path vs effects module within ~1 premultiplied unit', () => {
    const specs: Effect[] = [
      { enabled: true, type: 'levels', inLow: 0.1, inHigh: 0.9, gamma: 1.8, outLow: 0.05, outHigh: 0.95 },
      { enabled: true, type: 'brightnessContrast', brightness: 0.25, contrast: -0.3 },
      { enabled: true, type: 'hueSaturation', hue: 70, saturation: 1.4, value: 0.8 },
      { enabled: true, type: 'invert' },
      { enabled: true, type: 'threshold', level: 0.45 },
    ] as unknown as Effect[];
    for (const fx of specs) {
      for (const alpha of [8, 40, 128, 255]) {
        e = newEngine(16, 16);
        const d = new Uint8ClampedArray(16 * 16 * 4);
        for (let i = 0; i < d.length; i += 4) { const k = i >> 2; d[i] = (k * 17) % 256; d[i + 1] = (k * 29) % 256; d[i + 2] = (k * 5) % 256; d[i + 3] = alpha; }
        const lay = e.addPixelLayer('T');
        const slot = e.docSpec().layers.find((l) => l.id === lay)!.slot as number;
        e.writeSurface(slot, { x: 0, y: 0, w: 16, h: 16 }, d);
        e.commitSurfaces();
        // module path: the same effect as a layer effect of the pixel layer
        e.setEffects(lay, [fx]);
        e.flush();
        const viaModule = Array.from(e.readComposite({ x: 0, y: 0, w: 16, h: 16 }));
        // JS path: an adjustment layer over the (effect-free) layer
        e.setEffects(lay, []);
        e.addAdjustmentLayer([fx]);
        e.setActiveLayer(lay);
        e.flush();
        const viaJs = Array.from(e.readComposite({ x: 0, y: 0, w: 16, h: 16 }));
        for (let i = 0; i < viaJs.length; i += 4) {
          // composite includes the (transparent-ish) TD Input below: compare premultiplied channels of the straight result
          for (let c = 0; c < 3; c++) {
            const pj = (viaJs[i + c] * viaJs[i + 3]) / 255;
            const pm = (viaModule[i + c] * viaModule[i + 3]) / 255;
            expect(Math.abs(pj - pm), `${(fx as { type: string }).type} alpha ${alpha} px ${i / 4} ch ${c}`).toBeLessThanOrEqual(1.5); // 1 premultiplied unit + the straight readout rounding
          }
        }
        e.dispose();
      }
    }
  });

  it('batch ops: move into a collapsed group, ids across several parents (delete, props), active inside a deleted nested group', () => {
    e = newEngine(20, 20);
    const A = solidLayer(e, 'red', 'A');
    const B = solidLayer(e, 'green', 'B');
    const C = solidLayer(e, 'blue', 'C');
    const G = e.addGroup('G');
    e.setLayerProps(G, { expanded: false });
    e.moveLayers([A, C], G, 0); // into a collapsed group: not listed in layers(), still moved
    expect(e.layers().some((l) => l.id === A)).toBe(false);
    e.setLayerProps(G, { expanded: true });
    expect(e.layers().filter((l) => l.parentId === G).map((l) => l.id)).toEqual([C, A]);
    // ids across several parents
    e.setLayersProps([A, B, C], { visible: false });
    expect([A, B, C].every((id) => !e.layers().find((l) => l.id === id)!.visible)).toBe(true);
    e.undo();
    expect([A, B, C].every((id) => e.layers().find((l) => l.id === id)!.visible)).toBe(true);
    // active layer inside a deleted nested group
    const H = e.addGroup('H');
    e.moveLayers([H], G, 0);
    const D = solidLayer(e, 'white', 'D');
    e.moveLayers([D], H, 0);
    e.setActiveLayer(D);
    const n = e.history().entries.length;
    e.deleteLayers([A, B, H]); // A in G, B at the root, H nested in G (with D inside)
    expect(e.history().entries).toHaveLength(n + 1);
    const ids = e.layers().map((l) => l.id);
    expect([A, B, H, D].some((id) => ids.includes(id))).toBe(false);
    expect(ids).toContain(e.activeLayerId());
    e.undo();
    expect(e.layers().map((l) => l.id)).toEqual(expect.arrayContaining([A, B, H, D]));
  });
});
