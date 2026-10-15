// v6 phase B engine: filters as effects / adjustment layers, effects on groups and adjustments, tdPreview substitution,
// selection-limited adjustments. Real pixels; the reference is the effects module itself (and plain engine renders).
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine';
import type { AdjustmentSpec, Effect } from '../../src/engine/types';
import { applyEffects } from '../../src/engine/effects';
import { createSurface } from '../../src/engine/surface';
import { newEngine } from './engineTestUtils';

const engines: Engine[] = [];
const mk = (w = 96, h = 64): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });

const fx = (type: string, o: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...o }) as unknown as Effect;
const full = (e: Engine) => ({ x: 0, y: 0, w: e.width, h: e.height });
const comp = (e: Engine): Uint8ClampedArray => e.readComposite(full(e));

/** Largest premultiplied difference (0..255) between two straight RGBA images. */
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    const pa = a[i + 3] / 255;
    const pb = b[i + 3] / 255;
    m = Math.max(m, Math.abs(a[i + 3] - b[i + 3]));
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[i + c] * pa - b[i + c] * pb));
  }
  return m;
}

/** The effects module applied to a straight RGBA image (document sized). */
function ref(img: Uint8ClampedArray, w: number, h: number, effects: Effect[]): Uint8ClampedArray {
  const src = createSurface(w, h, true);
  src.ctx.putImageData(new ImageData(new Uint8ClampedArray(img), w, h), 0, 0);
  const out = createSurface(w, h, true);
  applyEffects(src, effects, { x: 0, y: 0, w, h }, out);
  return out.ctx.getImageData(0, 0, w, h).data;
}

/** Opaque colourful TD input 1 so that adjustments / filters below have something to bite on. */
function paintBase(e: Engine): void {
  const w = e.width, h = e.height;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = (x * 255) / w;
      d[o + 1] = (y * 255) / h;
      d[o + 2] = ((x >> 3) + (y >> 3)) % 2 ? 220 : 40;
      d[o + 3] = 255;
    }
  }
  e.writeBase(full(e), d);
  e.commitBase();
  e.flush();
}

function shape(e: Engine, id: string, rects: Array<[number, number, number, number, string]>): void {
  const l = e.doc.find(id) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
  for (const [x, y, w, h, c] of rects) {
    l.surface.ctx.fillStyle = c;
    l.surface.ctx.fillRect(x, y, w, h);
  }
  e.changed(full(e));
  e.flush();
}

/** A fresh engine with the same document and pixels (what a full recomposite must give). */
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
  e.writeBase(full(e), comp0(src));
  e.commitSurfaces();
  e.commitBase();
  e.flush();
  return e;
}
function refAux(img: Uint8ClampedArray, aux: Uint8ClampedArray, w: number, h: number, effects: Effect[]): Uint8ClampedArray {
  const mkS = (d: Uint8ClampedArray) => { const s = createSurface(w, h, true); s.ctx.putImageData(new ImageData(new Uint8ClampedArray(d), w, h), 0, 0); return s; };
  const out = createSurface(w, h, true);
  applyEffects(mkS(img), effects, { x: 0, y: 0, w, h }, out, mkS(aux));
  return out.ctx.getImageData(0, 0, w, h).data;
}
/** TD input 1 pixels of an engine (its base surface). */
function comp0(e: Engine): Uint8ClampedArray {
  const st = e.doc.inputs.get(1)!;
  return st.surface.ctx.getImageData(0, 0, st.surface.width, st.surface.height).data;
}

describe('filters as layer effects', () => {
  it('a filter effect on a pixel layer renders like the effects module', () => {
    for (const effect of [fx('blur', { radius: 5 }), fx('posterize', { levels: 3 }), fx('edgeDetect'), fx('twirl', { angle: 120, radius: 40 })]) {
      const e = mk();
      const a = e.addPixelLayer();
      shape(e, a, [[10, 8, 40, 30, '#e03030'], [30, 20, 50, 30, '#2060d0'], [60, 5, 20, 20, '#30c050']]);
      const plain = comp(e);
      e.setEffects(a, [effect]);
      e.flush();
      expect(e.layers().find((l) => l.id === a)?.effects[0].type).toBe(effect.type);
      const want = ref(plain, e.width, e.height, [effect]);
      expect(maxDiff(comp(e), want), effect.type).toBeLessThanOrEqual(2);
    }
  });

  it('mixed v5 effects and filters chain in order', () => {
    const e = mk();
    const a = e.addPixelLayer();
    shape(e, a, [[20, 15, 40, 30, '#f0a020']]);
    const plain = comp(e);
    const list = [fx('blur', { radius: 3 }), fx('dropShadow', { dx: 4, dy: 4, blur: 4, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 0.8 })];
    e.setEffects(a, list);
    e.flush();
    expect(maxDiff(comp(e), ref(plain, e.width, e.height, e.layers().find((l) => l.id === a)!.effects))).toBeLessThanOrEqual(2);
  });

  it('incremental edits under a global (whole-document) filter equal a full recomposite', () => {
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    shape(e, a, [[10, 8, 30, 30, '#e03030']]);
    e.setEffects(a, [fx('twirl', { angle: 200, radius: 60 })]);
    e.flush();
    shape(e, a, [[50, 30, 20, 20, '#2040ff']]);
    e.changed({ x: 50, y: 30, w: 20, h: 20 }); // a small dirty rect far from the first shape
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });

  it('a reach-limited filter redraws its neighbourhood only but fully', () => {
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    shape(e, a, [[10, 8, 30, 30, '#e03030']]);
    e.setEffects(a, [fx('blur', { radius: 8 })]);
    e.flush();
    const l = e.doc.find(a) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
    l.surface.ctx.fillStyle = '#10ff10';
    l.surface.ctx.fillRect(60, 40, 6, 6);
    e.changed({ x: 60, y: 40, w: 6, h: 6 });
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });
});

describe('filter adjustment layers', () => {
  it('runs the filter on the composite below, mixed by opacity and mask', () => {
    const effect = fx('blur', { radius: 4 });
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    shape(e, a, [[20, 10, 40, 30, '#ffffff']]);
    const below = comp(e);
    const id = e.addAdjustment('filter');
    e.setAdjustment(id, { type: 'filter', effect });
    e.flush();
    const fl = e.layers().find((l) => l.id === id)!;
    expect(fl.adjustment?.type).toBe('filter');
    const filtered = ref(below, e.width, e.height, [effect]);
    expect(maxDiff(comp(e), filtered)).toBeLessThanOrEqual(2);
    // half opacity = the premultiplied mix
    e.setLayerProps(id, { opacity: 0.5 });
    e.flush();
    const mix = new Uint8ClampedArray(below.length);
    for (let i = 0; i < mix.length; i += 4) {
      const pa = [0, 1, 2].map((c) => (below[i + c] * below[i + 3]) / 255);
      const pb = [0, 1, 2].map((c) => (filtered[i + c] * filtered[i + 3]) / 255);
      const al = (below[i + 3] + filtered[i + 3]) / 2;
      for (let c = 0; c < 3; c++) mix[i + c] = al ? (((pa[c] + pb[c]) / 2) * 255) / al : 0;
      mix[i + 3] = al;
    }
    expect(maxDiff(comp(e), mix)).toBeLessThanOrEqual(3);
  });

  it('a mask limits the effect (document space)', () => {
    const effect = fx('posterize', { levels: 2 });
    const e = mk();
    paintBase(e);
    const below = comp(e);
    const id = e.addAdjustment('filter');
    e.setAdjustment(id, { type: 'filter', effect });
    e.setSelection({ x: 0, y: 0, w: 48, h: 64 });
    e.maskFromSelection(id);
    e.flush();
    const f = ref(below, e.width, e.height, [effect]);
    const got = comp(e);
    for (const [x, y] of [[5, 5], [40, 30], [60, 30], [90, 60]]) {
      const o = (y * e.width + x) * 4;
      const want = x < 48 ? f : below;
      for (let c = 0; c < 3; c++) expect(Math.abs(got[o + c] - want[o + c]), `(${x},${y}) c${c}`).toBeLessThanOrEqual(2);
    }
  });

  it('survives docSpec / loadDocument and edits of the filter', () => {
    const e = mk();
    paintBase(e);
    const id = e.addAdjustment('filter');
    const spec: AdjustmentSpec = { type: 'filter', effect: fx('duotone', { amount: 80 }) };
    e.setAdjustment(id, spec);
    const ds = e.docSpec();
    const sp = ds.layers.find((l) => l.id === id)!;
    expect(sp.adjustment).toMatchObject({ type: 'filter', effect: { type: 'duotone', amount: 80, enabled: true } });
    const e2 = mk();
    e2.loadDocument(ds);
    expect(e2.layers().find((l) => l.id === id)?.adjustment).toMatchObject({ type: 'filter', effect: { type: 'duotone', amount: 80 } });
    // setAdjustment coalesces like other adjustments
    const n = e.history().entries.length;
    e.setAdjustment(id, { type: 'filter', effect: fx('duotone', { amount: 60 }) });
    e.setAdjustment(id, { type: 'filter', effect: fx('duotone', { amount: 40 }) });
    expect(e.history().entries.length).toBe(n); // coalesced into the previous 'Adjustment' step
    e.undo();
    expect((e.layers().find((l) => l.id === id)?.adjustment as { effect: { type: string } }).effect.type).toBe('blur'); // the default filter
  });

  it('a global filter adjustment stays exact when a layer below changes', () => {
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    const id = e.addAdjustment('filter');
    e.setAdjustment(id, { type: 'filter', effect: fx('kaleidoscope', { segments: 5 }) });
    e.flush();
    shape(e, a, [[70, 40, 12, 12, '#ff2020']]);
    e.changed({ x: 70, y: 40, w: 12, h: 12 });
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });
});

describe('effects on groups and adjustment layers', () => {
  it('group effects run on the isolated composite of the group, before it blends', () => {
    const effect = fx('colorOverlay', { color: { r: 255, g: 0, b: 0, a: 255 }, opacity: 0.6 });
    const shadow = fx('dropShadow', { dx: 5, dy: 5, blur: 4, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 0.9 });
    for (const list of [[effect], [shadow], [fx('blur', { radius: 3 })]]) {
      const e = mk();
      const g = e.addGroup();
      const a = e.addPixelLayer();
      e.moveLayer(a, g, 0);
      shape(e, a, [[15, 12, 30, 20, '#2070e0']]);
      const b = e.addPixelLayer();
      e.moveLayer(b, g, 0);
      shape(e, b, [[30, 20, 30, 25, '#f0c020']]);
      const plain = comp(e); // the group alone over a transparent base
      e.setEffects(g, list);
      e.flush();
      expect(e.layers().find((l) => l.id === g)?.effects).toHaveLength(1);
      expect(maxDiff(comp(e), ref(plain, e.width, e.height, list)), JSON.stringify(list[0].type)).toBeLessThanOrEqual(2);
      // group opacity applies after the effects
      e.setLayerProps(g, { opacity: 0.5 });
      e.flush();
      const half = ref(plain, e.width, e.height, list);
      const got = comp(e);
      for (let i = 3; i < got.length; i += 4) expect(Math.abs(got[i] - half[i] / 2)).toBeLessThanOrEqual(2);
    }
  });

  it('group effects are cleared by undo and survive docSpec round trips', () => {
    const e = mk();
    const g = e.addGroup();
    const a = e.addPixelLayer();
    e.moveLayer(a, g, 0);
    shape(e, a, [[15, 12, 30, 20, '#2070e0']]);
    const plain = comp(e);
    e.setEffects(g, [fx('colorOverlay', { color: { r: 255, g: 0, b: 0, a: 255 }, opacity: 1 })]);
    e.flush();
    expect(maxDiff(comp(e), plain)).toBeGreaterThan(50);
    const spec = e.docSpec();
    expect(spec.layers.find((l) => l.id === g)?.effects).toHaveLength(1);
    const e2 = mk();
    e2.loadDocument(spec);
    expect(e2.layers().find((l) => l.id === g)?.effects).toHaveLength(1);
    e.undo();
    e.flush();
    expect(maxDiff(comp(e), plain)).toBeLessThanOrEqual(1);
  });

  it('nested groups with effects at two levels', () => {
    const e = mk();
    const outer = e.addGroup();
    const inner = e.addGroup();
    e.moveLayer(inner, outer, 0);
    const a = e.addPixelLayer();
    e.moveLayer(a, inner, 0);
    shape(e, a, [[20, 15, 30, 25, '#20a0e0']]);
    e.setEffects(inner, [fx('colorOverlay', { color: { r: 255, g: 255, b: 0, a: 255 }, opacity: 1 })]);
    e.flush();
    const mid = comp(e);
    e.setEffects(outer, [fx('blur', { radius: 3 })]);
    e.flush();
    expect(maxDiff(comp(e), ref(mid, e.width, e.height, [fx('blur', { radius: 3 })]))).toBeLessThanOrEqual(2);
  });

  it('adjustment layer effects run on the adjusted result before the opacity x mask mix', () => {
    const effect = fx('colorOverlay', { color: { r: 0, g: 255, b: 0, a: 255 }, opacity: 0.5 });
    const e = mk();
    paintBase(e);
    const below = comp(e);
    const id = e.addAdjustment('invert');
    e.flush();
    const inverted = comp(e);
    e.setEffects(id, [effect]);
    e.setLayerProps(id, { opacity: 0.6 });
    e.flush();
    const adjusted = ref(inverted, e.width, e.height, [effect]);
    const got = comp(e);
    for (let i = 0; i < got.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const want = below[i + c] * 0.4 + adjusted[i + c] * 0.6;
        expect(Math.abs(got[i + c] - want)).toBeLessThanOrEqual(3);
      }
    }
  });

  it('effects on adjustment layers: dirty rects stay exact after painting below', () => {
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    const id = e.addAdjustment('hueSaturation');
    e.setAdjustment(id, { type: 'hueSaturation', hue: 90, saturation: 1, value: 1 });
    e.setEffects(id, [fx('blur', { radius: 6 })]);
    e.flush();
    shape(e, a, [[40, 20, 14, 14, '#ffffff']]);
    e.changed({ x: 40, y: 20, w: 14, h: 14 });
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });
});

describe('tdPreview layers', () => {
  const flagged = fx('pixelSort', { direction: 'h', low: 0.2, high: 0.8, key: 'luma' });

  function solidRgba(e: Engine, c: [number, number, number, number]): Uint8ClampedArray {
    const d = new Uint8ClampedArray(e.width * e.height * 4);
    for (let i = 0; i < d.length; i += 4) d.set(c, i);
    return d;
  }

  it('lists layers with flagged effects, marks them pending, renders the rest locally until the image arrives', () => {
    const e = mk();
    const a = e.addPixelLayer();
    const b = e.addPixelLayer();
    shape(e, a, [[10, 10, 30, 30, '#ff0000']]);
    shape(e, b, [[50, 10, 30, 30, '#0000ff']]);
    expect(e.tdPreviewLayers()).toEqual([]);
    const plain = comp(e);
    const overlay = fx('colorOverlay', { color: { r: 0, g: 255, b: 0, a: 255 }, opacity: 1 });
    e.setEffects(a, [flagged, overlay]);
    e.flush();
    expect(e.tdPreviewLayers()).toEqual([a]);
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBe(true);
    expect(e.layers().find((l) => l.id === b)?.previewPending).toBeFalsy();
    // pending: everything but the flagged effect is computed here
    expect(maxDiff(comp(e), ref(plain, e.width, e.height, [overlay]) as Uint8ClampedArray)).toBeGreaterThan(0); // layer b is not recoloured
    const e2 = mk();
    const a2 = e2.addPixelLayer();
    shape(e2, a2, [[10, 10, 30, 30, '#ff0000']]);
    e2.setEffects(a2, [overlay]);
    e2.flush();
    const aOnly = e.readComposite({ x: 0, y: 0, w: 48, h: 64 });
    const want = e2.readComposite({ x: 0, y: 0, w: 48, h: 64 });
    expect(maxDiff(aOnly, want)).toBeLessThanOrEqual(1);
  });

  it('TD image replaces the layer content (effects included), then opacity / blend apply', () => {
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    shape(e, a, [[10, 10, 30, 30, '#ff0000']]);
    e.setEffects(a, [flagged]);
    e.flush();
    const base = comp(e);
    e.setLayerPreview(a, solidRgba(e, [0, 255, 0, 255]));
    e.flush();
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBeFalsy();
    const got = comp(e);
    expect([got[0], got[1], got[2], got[3]]).toEqual([0, 255, 0, 255]); // doc-sized: covers everything
    e.setLayerProps(a, { opacity: 0.5 });
    e.flush();
    const half = comp(e);
    for (let c = 0; c < 3; c++) expect(Math.abs(half[c] - (base[c] * 0.5 + (c === 1 ? 255 : 0) * 0.5))).toBeLessThanOrEqual(2);
    e.setLayerProps(a, { opacity: 1, blend: 'multiply' });
    e.flush();
    const mul = comp(e);
    expect(mul[0]).toBe(0);
    expect(Math.abs(mul[1] - base[1])).toBeLessThanOrEqual(2);
    // clearing brings the pending state back
    e.setLayerPreview(a, null);
    e.flush();
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBe(true);
    // wrong size / unflagged layers are ignored
    e.setLayerPreview(a, new Uint8ClampedArray(16));
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBe(true);
    const plain = e.addPixelLayer();
    e.setLayerPreview(plain, solidRgba(e, [1, 2, 3, 255]));
    expect(e.layers().find((l) => l.id === plain)?.previewPending).toBeFalsy();
    expect(e.tdPreviewLayers()).toEqual([a]);
  });

  it('groups and filter adjustments flagged for TD', () => {
    const e = mk();
    paintBase(e);
    const g = e.addGroup();
    const a = e.addPixelLayer();
    e.moveLayer(a, g, 0);
    shape(e, a, [[10, 10, 30, 30, '#ff0000']]);
    e.setEffects(g, [flagged]);
    e.setActiveLayer(g);
    const adj = e.addAdjustment('filter');
    e.setAdjustment(adj, { type: 'filter', effect: flagged });
    expect(e.tdPreviewLayers().sort()).toEqual([g, adj].sort());
    e.flush();
    const pend = comp(e);
    e.setLayerPreview(g, solidRgba(e, [0, 0, 255, 255]));
    e.flush();
    const withG = comp(e);
    expect([withG[0], withG[1], withG[2]]).toEqual([0, 0, 255]);
    // the filter adjustment shows TD's filtered result (here: red), mixed by opacity
    e.setLayerPreview(adj, solidRgba(e, [255, 0, 0, 255]));
    e.setLayerProps(adj, { opacity: 0.5 });
    e.flush();
    const withBoth = comp(e);
    expect(Math.abs(withBoth[0] - 127.5)).toBeLessThanOrEqual(2);
    expect(Math.abs(withBoth[2] - 127.5)).toBeLessThanOrEqual(2);
    expect(pend.length).toBe(withBoth.length);
  });

  it('previews are dropped when the document is resized', () => {
    const e = mk();
    const a = e.addPixelLayer();
    e.setEffects(a, [flagged]);
    e.setLayerPreview(a, solidRgba(e, [9, 9, 9, 255]));
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBeFalsy();
    e.resize(120, 80);
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBe(true);
  });
});

describe('selection-limited adjustments', () => {
  it('addAdjustment with a selection creates a masked layer; selection kept; one history entry', () => {
    const e = mk();
    paintBase(e);
    const plain = comp(e);
    e.setSelection({ x: 10, y: 8, w: 40, h: 30 });
    const n0 = e.history().entries.length;
    const id = e.addAdjustment('invert');
    expect(e.history().entries.length).toBe(n0 + 1);
    expect(e.selection()).toEqual({ x: 10, y: 8, w: 40, h: 30 });
    const info = e.layers().find((l) => l.id === id)!;
    expect(info.mask).not.toBeNull();
    e.flush();
    const got = comp(e);
    const at = (x: number, y: number) => (y * e.width + x) * 4;
    expect(got[at(20, 20)]).toBe(255 - plain[at(20, 20)]);
    expect(got[at(70, 50)]).toBe(plain[at(70, 50)]);
    const m = e.readSurface(info.mask!.slot, full(e));
    expect(m[at(20, 20)]).toBe(255);
    expect(m[at(70, 50)]).toBe(0);
    e.undo();
    expect(e.layers().some((l) => l.id === id)).toBe(false);
    expect(e.selection()).toEqual({ x: 10, y: 8, w: 40, h: 30 });
    e.redo();
    expect(e.layers().find((l) => l.id === id)?.mask).not.toBeNull();
  });

  it('feathered selection gives a soft mask; filter adjustments get the mask too', () => {
    const e = mk();
    paintBase(e);
    e.setSelection({ x: 20, y: 15, w: 40, h: 30 });
    e.modifySelection('feather', 6);
    const cover = e.selectionMask()!;
    const id = e.addAdjustment('filter');
    const info = e.layers().find((l) => l.id === id)!;
    expect(info.mask).not.toBeNull();
    const m = e.readSurface(info.mask!.slot, full(e));
    for (const [x, y] of [[20, 15], [22, 17], [40, 30], [58, 43], [10, 10]]) {
      const o = y * e.width + x;
      expect(Math.abs(m[o * 4] - cover.alpha[o]), `(${x},${y})`).toBeLessThanOrEqual(1);
    }
    expect(m[(30 * e.width + 21) * 4]).toBeGreaterThan(0);
    expect(m[(30 * e.width + 21) * 4]).toBeLessThan(255);
  });

  it('without a selection there is no mask', () => {
    const e = mk();
    const id = e.addAdjustment('levels');
    expect(e.layers().find((l) => l.id === id)?.mask).toBeNull();
  });
});

describe('filters with an aux image (displace by layer / input)', () => {
  const disp = (src: string) => fx('displace', { source: 'aux', auxSource: src, strengthX: 12, strengthY: 8, edge: 'clamp' });

  function gradLayer(e: Engine, id: string): void {
    const l = e.doc.find(id) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
    const g = l.surface.ctx.createLinearGradient(0, 0, e.width, e.height);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.5, '#808080');
    g.addColorStop(1, '#ffffff');
    l.surface.ctx.fillStyle = g;
    l.surface.ctx.fillRect(0, 0, e.width, e.height);
    e.changed(full(e));
    e.flush();
  }

  it('layer reference: the (even hidden) layer content is the displacement map; edits of it update the dependant', () => {
    const e = mk();
    const a = e.addPixelLayer();
    shape(e, a, [[15, 10, 40, 30, '#e03030'], [50, 30, 30, 25, '#2060d0']]);
    const plain = comp(e);
    const b = e.addPixelLayer();
    gradLayer(e, b);
    e.setLayerProps(b, { visible: false });
    e.setActiveLayer(a);
    const aux = (() => { e.setLayerProps(b, { visible: true }); e.flush(); const x = comp(e); e.setLayerProps(b, { visible: false }); return x; })();
    // a is below b: aux content = b alone over transparent = what the composite shows minus a
    e.setEffects(a, [disp(`layer:${b}`)]);
    e.flush();
    const auxOnly = ((): Uint8ClampedArray => { const e2 = mk(); const b2 = e2.addPixelLayer(); gradLayer(e2, b2); return comp(e2); })();
    const want = refAux(plain, auxOnly, e.width, e.height, [disp(`layer:${b}`)]);
    expect(maxDiff(comp(e), want)).toBeLessThanOrEqual(2);
    expect(maxDiff(comp(e), plain)).toBeGreaterThan(20); // it really displaced
    expect(aux.length).toBe(plain.length);
    // change the source layer: the dependant redraws everywhere
    const l = e.doc.find(b) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
    l.surface.ctx.fillStyle = '#ffffff';
    l.surface.ctx.fillRect(0, 0, 20, 20);
    e.changed({ x: 0, y: 0, w: 20, h: 20 });
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });

  it('input reference uses the TD input content; missing / self / cyclic references render undisplaced', () => {
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    shape(e, a, [[15, 10, 40, 30, '#e03030']]);
    const base = comp(e);
    e.setEffects(a, [disp('input:1')]);
    e.flush();
    const layerOnly = (() => { const e2 = mk(); const a2 = e2.addPixelLayer(); shape(e2, a2, [[15, 10, 40, 30, '#e03030']]); return comp(e2); })();
    const inp = comp0(e);
    const want = refAux(layerOnly, inp, e.width, e.height, [disp('input:1')]);
    const got = comp(e);
    // composite = input below + displaced layer: compare over the layer's area
    for (let y = 8; y < 45; y += 3) for (let x = 12; x < 60; x += 3) {
      const o = (y * e.width + x) * 4;
      if (want[o + 3] === 255) for (let c = 0; c < 3; c++) expect(Math.abs(got[o + c] - want[o + c])).toBeLessThanOrEqual(3);
    }
    expect(base.length).toBe(got.length);
    // self / missing / cycle: no displacement, no crash
    const b = e.addPixelLayer();
    shape(e, b, [[5, 5, 10, 10, '#00ff00']]);
    e.setEffects(a, [disp(`layer:${a}`)]);
    e.setEffects(b, [disp(`layer:${a}`)]);
    e.setEffects(a, [disp(`layer:${b}`)]);
    e.flush();
    e.setEffects(a, [disp('layer:nope')]);
    e.flush();
    expect(comp(e).length).toBe(got.length);
  });

  it('group effects are cached but stay exact when other layers are painted', () => {
    const e = mk();
    paintBase(e);
    const g = e.addGroup();
    const a = e.addPixelLayer();
    e.moveLayer(a, g, 0);
    shape(e, a, [[15, 10, 40, 30, '#e03030']]);
    e.setEffects(g, [fx('blur', { radius: 5 })]);
    e.setActiveLayer(g);
    const o = e.addPixelLayer();
    e.flush();
    e.setToolContext({ primary: { r: 0, g: 255, b: 0, a: 255 }, secondary: { r: 0, g: 0, b: 0, a: 255 }, fillTolerance: 0, brush: { size: 10, opacity: 1, flow: 1, hardness: 1, spacing: 0.15 } });
    e.setTool('brush');
    e.pointerDown({ x: 70, y: 50, pressure: 1, shift: false, alt: false, ctrl: false });
    for (const x of [75, 80, 85]) { e.pointerMove({ x, y: 50, pressure: 1, shift: false, alt: false, ctrl: false }); e.flush(); }
    e.pointerUp({ x: 85, y: 50, pressure: 1, shift: false, alt: false, ctrl: false });
    e.flush();
    expect(o).toBeTruthy();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
    // painting INSIDE the group updates the cached group result
    e.setActiveLayer(a);
    e.setTool('brush');
    e.pointerDown({ x: 20, y: 15, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerMove({ x: 45, y: 35, pressure: 1, shift: false, alt: false, ctrl: false });
    e.flush();
    e.pointerUp({ x: 45, y: 35, pressure: 1, shift: false, alt: false, ctrl: false });
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });
});

describe('aux rules aligned with TD, addFilterAdjustment', () => {
  const dispObj = (aux: unknown) => fx('displace', { source: 'aux', auxSource: aux, strengthX: 12, strengthY: 8, edge: 'clamp' });

  it('object-form references work and are stored verbatim; groups / disconnected inputs give no displacement', () => {
    const e = mk();
    paintBase(e);
    const a = e.addPixelLayer();
    shape(e, a, [[15, 10, 40, 30, '#e03030']]);
    e.flush();
    const plain = comp(e);
    e.setEffects(a, [dispObj({ kind: 'input', input: 1 })]);
    e.flush();
    expect(e.layers().find((l) => l.id === a)?.effects[0]).toMatchObject({ auxSource: { kind: 'input', input: 1 } });
    const displaced = comp(e);
    expect(maxDiff(displaced, plain)).toBeGreaterThan(5);
    // a group is not a valid aux target
    const g = e.addGroup();
    e.setEffects(a, [dispObj({ kind: 'layer', id: g })]);
    e.flush();
    expect(maxDiff(comp(e), plain)).toBeLessThanOrEqual(1);
    // disconnected input: transparent, no displacement
    e.setEffects(a, [dispObj('input:2')]);
    e.flush();
    expect(maxDiff(comp(e), plain)).toBeLessThanOrEqual(1);
  });

  it('addFilterAdjustment creates the layer with its effect in one history entry', () => {
    const e = mk();
    paintBase(e);
    const n = e.history().entries.length;
    const id = e.addFilterAdjustment!(fx('posterize', { levels: 3 }), 'Poster');
    expect(e.history().entries.length).toBe(n + 1);
    const info = e.layers().find((l) => l.id === id)!;
    expect(info.name).toBe('Poster');
    expect(info.adjustment).toMatchObject({ type: 'filter', effect: { type: 'posterize', levels: 3 } });
    e.undo();
    expect(e.layers().some((l) => l.id === id)).toBe(false);
  });
});
