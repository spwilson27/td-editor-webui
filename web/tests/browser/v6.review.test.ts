// Regression tests for the engine review findings (hidden aux sources, blob validation, preview staleness, stroke seeds, caps).
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine';
import type { BrushDynamics, Effect } from '../../src/engine/types';
import { sanitizeEffect } from '../../src/engine/effectsSanitize';
import { brushCtx, newEngine, stroke } from './engineTestUtils';

const engines: Engine[] = [];
const mk = (w = 96, h = 64): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });
const fx = (type: string, o: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...o }) as unknown as Effect;
const full = (e: Engine) => ({ x: 0, y: 0, w: e.width, h: e.height });
const comp = (e: Engine) => e.readComposite(full(e));
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    m = Math.max(m, Math.abs(a[i + 3] - b[i + 3]));
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs((a[i + c] * a[i + 3]) / 255 - (b[i + c] * b[i + 3]) / 255));
  }
  return m;
}
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
  const st = src.doc.inputs.get(1)!;
  e.writeBase(full(e), st.surface.ctx.getImageData(0, 0, st.surface.width, st.surface.height).data);
  e.commitSurfaces();
  e.commitBase();
  e.flush();
  return e;
}
function rects(e: Engine, id: string, rs: Array<[number, number, number, number, string]>): void {
  const l = e.doc.find(id) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
  for (const [x, y, w, h, c] of rs) { l.surface.ctx.fillStyle = c; l.surface.ctx.fillRect(x, y, w, h); }
  e.changed(full(e));
  e.flush();
}
const disp = (src: string) => fx('displace', { source: 'aux', auxSource: src, strengthX: 14, strengthY: 6, edge: 'clamp' });

function gradient(e: Engine, id: string): void {
  const l = e.doc.find(id) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
  const g = l.surface.ctx.createLinearGradient(0, 0, e.width, 0);
  g.addColorStop(0, '#000');
  g.addColorStop(1, '#fff');
  l.surface.ctx.fillStyle = g;
  l.surface.ctx.fillRect(0, 0, e.width, e.height);
  e.changed(full(e));
  e.flush();
}

describe('aux sources', () => {
  it('edits of a HIDDEN aux layer (transform, effects, mask) update the dependant', () => {
    const e = mk();
    const a = e.addPixelLayer();
    rects(e, a, [[15, 10, 40, 30, '#e03030']]);
    const b = e.addPixelLayer();
    gradient(e, b);
    e.setLayerProps(b, { visible: false });
    e.setEffects(a, [disp(`layer:${b}`)]);
    e.flush();
    const before = comp(e);
    e.setTransform(b, { x: 20, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
    e.flush();
    expect(maxDiff(comp(e), before)).toBeGreaterThan(10);
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
    e.setEffects(b, [fx('posterize', { levels: 2 })]);
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
    e.addMask(b);
    e.setSelection({ x: 0, y: 0, w: 30, h: 64 });
    e.maskFromSelection(b);
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });

  it('a group whose child displaces by a layer outside the group stays exact mid-stroke', () => {
    const e = mk();
    const src = e.addPixelLayer();
    gradient(e, src);
    e.setLayerProps(src, { visible: false });
    const g = e.addGroup();
    const a = e.addPixelLayer();
    e.moveLayer(a, g, 0);
    rects(e, a, [[15, 10, 40, 30, '#e03030']]);
    e.setEffects(a, [disp(`layer:${src}`)]);
    e.setEffects(g, [fx('blur', { radius: 2 })]);
    e.flush();
    e.setActiveLayer(src);
    e.setLayerProps(src, { visible: true });
    e.setToolContext(brushCtx({ size: 12 }, { primary: { r: 255, g: 255, b: 255, a: 255 } }));
    e.setTool('brush');
    e.pointerDown({ x: 5, y: 5, pressure: 1, shift: false, alt: false, ctrl: false });
    for (const x of [20, 40, 60]) { e.pointerMove({ x, y: 20, pressure: 1, shift: false, alt: false, ctrl: false }); e.flush(); }
    e.pointerUp({ x: 60, y: 20, pressure: 1, shift: false, alt: false, ctrl: false });
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e)))).toBeLessThanOrEqual(1);
  });
});

describe('history blob validation', () => {
  function frame(blob: Uint8Array): { head: any; bin: Uint8Array } {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const jl = dv.getUint32(8, true);
    return { head: JSON.parse(new TextDecoder().decode(blob.subarray(16, 16 + jl))), bin: blob.subarray(16 + jl) };
  }
  function build(head: unknown, bin: Uint8Array): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(head));
    const out = new Uint8Array(16 + json.length + bin.length);
    out.set([0x52, 0x44, 0x48, 0x42], 0);
    const dv = new DataView(out.buffer);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, json.length, true);
    dv.setUint32(12, bin.length, true);
    out.set(json, 16);
    out.set(bin, 16 + json.length);
    return out;
  }
  function setup() {
    const e1 = mk(80, 60);
    e1.addPixelLayer();
    e1.setToolContext(brushCtx({ size: 12 }, { primary: { r: 255, g: 0, b: 0, a: 255 } }));
    stroke(e1, 'brush', [[10, 10], [60, 40]]);
    e1.setSelection({ x: 5, y: 5, w: 40, h: 30 });
    e1.modifySelection('feather', 4);
    e1.deselect();
    const rev = e1.docSpec().rev;
    const blob = e1.serializeHistory(50, 1 << 28);
    return { e1, rev, blob, e2: fresh(e1) };
  }

  it('many references to the same bytes are refused (no memory amplification)', () => {
    const { rev, blob, e2 } = setup();
    const { head, bin } = frame(blob);
    const ent = head.entries.find((x: any) => x.k === 'patch');
    ent.patches = Array.from({ length: 2000 }, () => ent.patches[0]);
    const t0 = performance.now();
    expect(e2.restoreHistory(build(head, bin), rev)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(e2.history().entries.length).toBe(0);
    expect(e2.restoreHistory(blob, rev)).toBe(true);
  });

  it('the over-claim guard stops allocating long before every duplicate surface is built', () => {
    const e1 = mk(64, 64);
    const l = e1.addPixelLayer();
    e1.setToolContext(brushCtx({ size: 10 }, { primary: { r: 9, g: 9, b: 9, a: 255 } }));
    stroke(e1, 'brush', [[10, 10], [40, 40]]);
    e1.deleteLayer(l); // its surface now lives only in history: dumped into the blob
    const rev = e1.docSpec().rev;
    const { head, bin } = frame(e1.serializeHistory(50, 1 << 28));
    const d = head.surfaces.find((x: any) => x.t === 'D');
    expect(d).toBeTruthy();
    head.surfaces = Array.from({ length: 3000 }, () => ({ ...d }));
    const blob = build(head, bin);
    const e2 = fresh(e1);
    const Orig = globalThis.OffscreenCanvas;
    let made = 0;
    globalThis.OffscreenCanvas = class extends Orig { constructor(w: number, h: number) { super(w, h); made++; } } as typeof OffscreenCanvas;
    try {
      expect(e2.restoreHistory(blob, rev)).toBe(false);
    } finally {
      globalThis.OffscreenCanvas = Orig;
    }
    expect(made).toBeLessThan(Math.ceil(bin.length / (64 * 64 * 4)) + 5); // bounded by the blob's own size, not by the table
  });

  it('overlapping ranges and wrong selection coverage sizes are refused', () => {
    const { rev, blob, e2 } = setup();
    let f = frame(blob);
    const sels = f.head.entries.filter((x: any) => x.k === 'sel');
    expect(sels.length).toBeGreaterThan(0);
    const withAlpha = sels.map((s: any) => s.before ?? s.after).find((s: any) => s && s.len) ?? sels.map((s: any) => s.after).find((s: any) => s && s.len);
    expect(withAlpha).toBeTruthy();
    withAlpha.len -= 1;
    expect(e2.restoreHistory(build(f.head, f.bin), rev)).toBe(false);
    f = frame(blob);
    const p = f.head.entries.find((x: any) => x.k === 'patch').patches[0];
    const q = f.head.entries.find((x: any) => x.k === 'patch');
    q.patches = [p, { ...p, x: 0, y: 0, off: p.off + 4 }];
    expect(e2.restoreHistory(build(f.head, f.bin), rev)).toBe(false);
  });

  it('a layer twice in one snapshot is refused', () => {
    const e1 = mk();
    const g = e1.addGroup();
    e1.addPixelLayer();
    expect(g).toBeTruthy();
    const rev = e1.docSpec().rev;
    const { head, bin } = frame(e1.serializeHistory(50, 1 << 28));
    const st = head.entries.find((x: any) => x.k === 'struct');
    st.after.root.kids.push(st.after.root.kids[0]);
    expect(fresh(e1).restoreHistory(build(head, bin), rev)).toBe(false);
  });
});

describe('tdPreview freshness and limits', () => {
  const flagged = fx('pixelSort', { direction: 'h', low: 0.2, high: 0.8, key: 'luma' });
  const solid = (e: Engine, v: number) => new Uint8ClampedArray(e.width * e.height * 4).fill(v);

  it('edits make the TD image stale (local render until a newer image), new image restores it', () => {
    const e = mk();
    const a = e.addPixelLayer();
    rects(e, a, [[10, 10, 20, 20, '#ff0000']]);
    e.setEffects(a, [flagged]);
    e.setLayerPreview(a, solid(e, 255));
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBeFalsy();
    rects(e, a, [[40, 30, 10, 10, '#00ff00']]);
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBe(true);
    e.flush();
    expect(comp(e)[3]).toBe(0); // the stale full-white image is not shown any more
    e.setLayerPreview(a, solid(e, 255));
    e.flush();
    expect(comp(e)[3]).toBe(255);
    // opacity changes do not stale it; effect changes do
    e.setLayerProps(a, { opacity: 0.5 });
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBeFalsy();
    e.setEffects(a, [flagged, fx('blur', { radius: 2 })]);
    expect(e.layers().find((l) => l.id === a)?.previewPending).toBe(true);
  });

  it('removing the flag drops the image; wrong lengths are ignored; at most 16 are kept', () => {
    const e = mk(32, 24);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const l = e.addPixelLayer();
      e.setEffects(l, [flagged]);
      ids.push(l);
    }
    for (const id of ids) e.setLayerPreview(id, solid(e, 9));
    expect(ids.filter((id) => !e.layers().find((l) => l.id === id)?.previewPending)).toHaveLength(16);
    e.setLayerPreview(ids[19], new Uint8ClampedArray(32 * 24 * 4 + 4));
    e.setEffects(ids[19], []);
    e.flush();
    expect(e.tdPreviewLayers()).not.toContain(ids[19]);
  });
});

describe('brush strokes and caps', () => {
  const dyn: BrushDynamics = { scatter: 1.5, scatterCount: 3, sizeJitter: 0.4, angleJitter: 90, hueJitter: 0.3, satJitter: 0, valJitter: 0, angle: 0, roundness: 1, seed: 7 };
  const pts = (y: number): [number, number][] => [[10, y], [70, y]];
  const layerPx = (e: Engine, id: string) => (e.doc.find(id) as unknown as { surface: { ctx: CanvasRenderingContext2D } }).surface.ctx.getImageData(0, 0, e.width, e.height).data;

  it('strokes differ from each other but each is reproducible from seed + position in the sequence', () => {
    const run = (): [Uint8ClampedArray, Uint8ClampedArray] => {
      const e = mk(100, 60);
      const a = e.addPixelLayer();
      e.setToolContext(brushCtx({ size: 14, spacing: 0.3 }, { primary: { r: 200, g: 50, b: 50, a: 255 } }));
      e.setBrushTip('chalk', dyn);
      stroke(e, 'brush', pts(15));
      const s1 = new Uint8ClampedArray(layerPx(e, a));
      stroke(e, 'brush', pts(15)); // same path again, over the first
      return [s1, new Uint8ClampedArray(layerPx(e, a))];
    };
    const [a1, a2] = run();
    const [b1, b2] = run();
    expect(Array.from(a1)).toEqual(Array.from(b1));
    expect(Array.from(a2)).toEqual(Array.from(b2));
    expect(Array.from(a2)).not.toEqual(Array.from(a1));
  });

  it('refuses huge opaque effect parameters and huge tip selections', () => {
    expect(sanitizeEffect({ enabled: true, type: 'lut', cube: 'x'.repeat(1_100_000) })).toBeNull();
    expect(sanitizeEffect({ enabled: true, type: 'blur', radius: 4 })).not.toBeNull();
  });
});

describe('aux dependants need no widening, group images follow their children', () => {
  it.each(['clamp', 'transparent'])('small edits of the source or of the displaced layer with a strong displacement stay exact (edge %s)', (edge) => {
    const e = mk(128, 80);
    paintBaseLike(e);
    const a = e.addPixelLayer();
    rects(e, a, [[20, 10, 60, 40, '#e03030'], [70, 30, 40, 30, '#2060d0']]);
    const b = e.addPixelLayer();
    gradient(e, b);
    e.setLayerProps(b, { visible: false });
    e.setEffects(a, [fx('displace', { source: 'aux', auxSource: `layer:${b}`, strengthX: 120, strengthY: 60, edge })]);
    e.flush();
    expect(maxDiff(comp(e), comp(fresh(e))), 'baseline').toBeLessThanOrEqual(1);
    for (const [layer, r] of [[b, [100, 60, 8, 8]], [a, [30, 20, 6, 6]], [b, [2, 2, 5, 5]]] as const) {
      const l = e.doc.find(layer) as unknown as { surface: { ctx: CanvasRenderingContext2D } };
      l.surface.ctx.fillStyle = '#ffffff';
      l.surface.ctx.fillRect(r[0], r[1], r[2], r[3]);
      e.changed({ x: r[0], y: r[1], w: r[2], h: r[3] });
      e.flush();
      const ca = comp(e), cb = comp(fresh(e));
      let bi = -1; let bm = 0; for (let i = 0; i < ca.length; i += 4) { const d = Math.abs(ca[i + 3] - cb[i + 3]) + Math.abs(ca[i] - cb[i]); if (d > bm) { bm = d; bi = i; } }
      expect(maxDiff(ca, cb), `layer ${layer === b ? 'b' : 'a'} rect ${r} at ${(bi >> 2) % 128},${Math.floor(bi / 4 / 128)}`).toBeLessThanOrEqual(1);
    }
  });

  it('a child property edit stales the group\'s TD image', () => {
    const flagged = fx('pixelSort', { direction: 'h', low: 0.2, high: 0.8, key: 'luma' });
    const e = mk();
    const g = e.addGroup();
    const a = e.addPixelLayer();
    e.moveLayer(a, g, 0);
    const b = e.addPixelLayer();
    e.moveLayer(b, g, 0);
    e.setEffects(g, [flagged]);
    e.setLayerPreview(g, new Uint8ClampedArray(96 * 64 * 4).fill(200));
    const pending = () => e.layers().find((l) => l.id === g)?.previewPending;
    expect(pending()).toBeFalsy();
    e.setLayerProps(b, { opacity: 0.5 });
    expect(pending()).toBe(true);
    e.setLayerPreview(g, new Uint8ClampedArray(96 * 64 * 4).fill(200));
    expect(pending()).toBeFalsy();
    e.setLayerProps(a, { visible: false });
    expect(pending()).toBe(true);
    e.setLayerPreview(g, new Uint8ClampedArray(96 * 64 * 4).fill(200));
    e.moveLayer(b, g, 1); // order
    expect(pending()).toBe(true);
    e.setLayerPreview(g, new Uint8ClampedArray(96 * 64 * 4).fill(200));
    e.setLayerProps(g, { opacity: 0.4 }); // the group's own opacity is not part of the image
    expect(pending()).toBeFalsy();
  });
});

function paintBaseLike(e: Engine): void {
  const d = new Uint8ClampedArray(e.width * e.height * 4);
  for (let i = 0; i < d.length; i += 4) d.set([(i >> 2) % 255, 90, 160, 255], i);
  e.writeBase(full(e), d);
  e.commitBase();
  e.flush();
}
