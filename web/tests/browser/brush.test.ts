import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import { decodeTipPng, encodeTipPng } from '../../src/engine';
import type { PixelLayer } from '../../src/engine/model';
import type { BrushDynamics, BrushPreset, TipShape } from '../../src/engine/types';
import { DEFAULT_DYNAMICS } from '../../src/engine/tools/tips';
import { brushCtx, collect, drawRect, maskAt, newEngine, px, rgba, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const dyn = (o: Partial<BrushDynamics> = {}): BrushDynamics => ({ ...DEFAULT_DYNAMICS, ...o });
const data = (id: string): Uint8ClampedArray => { const l = e.doc.find(id) as PixelLayer; return l.surface.ctx.getImageData(0, 0, l.surface.width, l.surface.height).data; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
function bbox(d: Uint8ClampedArray, w: number, min = 1): { x0: number; y0: number; x1: number; y1: number; n: number } | null {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < min) continue;
    const x = (i / 4) % w, y = Math.floor(i / 4 / w);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); n++;
  }
  return n ? { x0, y0, x1, y1, n } : null;
}
function setup(over = {}, extra = {}, w = 100, h = 100): string {
  e = newEngine(w, h);
  const id = e.addPixelLayer();
  e.setToolContext(brushCtx({ size: 40, hardness: 1, ...over }, { primary: rgba(255, 0, 0), ...extra }));
  return id;
}
const DYN = dyn({ scatter: 1, scatterCount: 3, sizeJitter: 0.5, angleJitter: 90, hueJitter: 0.5, satJitter: 0.2, valJitter: 0.2, seed: 7 });
const PATH: [number, number][] = [[15, 30], [80, 40], [30, 70]];

describe('textured tips', () => {
  it('same seed and path give identical pixels, other seeds differ', () => {
    const run = (seed: number): Uint8ClampedArray => {
      const id = setup({ size: 14 });
      e.setBrushTip('chalk', { ...DYN, seed });
      stroke(e, 'brush', PATH);
      return data(id);
    };
    const a = run(7), b = run(7), c = run(8);
    expect(bbox(a, 100)).not.toBeNull();
    expect(same(a, b)).toBe(true);
    expect(same(a, c)).toBe(false);
  });

  it('default tip and dynamics are byte-identical to never setting a tip', () => {
    const run = (set: boolean): Uint8ClampedArray => {
      const id = setup({ size: 25, hardness: 0.5 });
      if (set) e.setBrushTip('round', dyn());
      stroke(e, 'brush', PATH);
      return data(id);
    };
    expect(same(run(false), run(true))).toBe(true);
  });

  for (const shape of ['round', 'chalk', 'bristle', 'spatter', 'noise', 'square', 'star'] as TipShape[]) {
    it(`${shape} draws the primary colour inside its radius`, () => {
      const id = setup({ size: 40 });
      e.setBrushTip(shape, dyn({ roundness: 0.99 })); // forces the textured path for 'round'
      stroke(e, 'brush', [[50, 50]]);
      const d = data(id);
      const b = bbox(d, 100) as NonNullable<ReturnType<typeof bbox>>;
      expect(b.n).toBeGreaterThan(40);
      expect(b.x0).toBeGreaterThanOrEqual(28);
      expect(b.x1).toBeLessThanOrEqual(72);
      expect(b.y0).toBeGreaterThanOrEqual(28);
      expect(b.y1).toBeLessThanOrEqual(72);
      let strong = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 150) { strong++; expect([d[i], d[i + 1], d[i + 2]]).toEqual([255, 0, 0]); }
      expect(strong).toBeGreaterThan(10);
    });
  }

  it('angle and roundness change the footprint', () => {
    const foot = (d: Partial<BrushDynamics>): { w: number; h: number } => {
      const id = setup({ size: 40 });
      e.setBrushTip('square', dyn(d));
      stroke(e, 'brush', [[50, 50]]);
      const b = bbox(data(id), 100, 128) as NonNullable<ReturnType<typeof bbox>>;
      return { w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 };
    };
    const flat = foot({ roundness: 0.25 });
    expect(flat.w).toBeGreaterThanOrEqual(38);
    expect(flat.h).toBeGreaterThanOrEqual(9);
    expect(flat.h).toBeLessThanOrEqual(12);
    const turned = foot({ roundness: 0.25, angle: 90 });
    expect(turned.h).toBeGreaterThanOrEqual(38);
    expect(turned.w).toBeLessThanOrEqual(12);
    const diamond = foot({ angle: 45 });
    expect(diamond.w).toBeGreaterThanOrEqual(54);
  });

  it('scatter spreads dabs beyond the size', () => {
    const id = setup({ size: 10 });
    e.setBrushTip('round', dyn({ scatter: 2, scatterCount: 8, seed: 3 }));
    stroke(e, 'brush', [[50, 50]]);
    const b = bbox(data(id), 100) as NonNullable<ReturnType<typeof bbox>>;
    expect(b.x1 - b.x0).toBeGreaterThan(20);
    expect(b.x0).toBeGreaterThanOrEqual(50 - 5 - 20 - 1);
    expect(b.x1).toBeLessThanOrEqual(50 + 5 + 20 + 1);
  });

  it('size jitter varies the line thickness', () => {
    const thick = (j: number): number => {
      const id = setup({ size: 16, spacing: 0.5 });
      e.setBrushTip('round', dyn({ sizeJitter: j, roundness: 0.999, seed: 5 }));
      stroke(e, 'brush', [[10, 50], [90, 50]]);
      const d = data(id);
      const hs: number[] = [];
      for (let x = 20; x < 80; x++) { let n = 0; for (let y = 30; y < 70; y++) if (d[(y * 100 + x) * 4 + 3] > 128) n++; hs.push(n); }
      const m = hs.reduce((s, v) => s + v, 0) / hs.length;
      return hs.reduce((s, v) => s + (v - m) ** 2, 0) / hs.length;
    };
    expect(thick(0)).toBeLessThan(1);
    expect(thick(0.9)).toBeGreaterThan(thick(0) + 2);
  });

  it('colour jitter yields several hues', () => {
    const id = setup({ size: 30, spacing: 0.5 });
    e.setBrushTip('square', dyn({ hueJitter: 1, seed: 2 }));
    stroke(e, 'brush', [[10, 50], [90, 50]]);
    const d = data(id);
    const hues = new Set<number>();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) hues.add(Math.round(Math.atan2(Math.sqrt(3) * (d[i + 1] - d[i + 2]), 2 * d[i] - d[i + 1] - d[i + 2]) / (Math.PI / 6)));
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });

  it('keeps the document size on scaled and rotated layers', () => {
    const id = setup({ size: 30 });
    e.setTransform(id, { x: -24.1, y: -21.65, sx: 2, sy: 0.5, rot: 30, kx: 0, ky: 0 });
    e.setBrushTip('square', dyn({ roundness: 0.999 }));
    stroke(e, 'brush', [[50, 50]]);
    for (const [x, y] of [[50, 50], [38, 38], [62, 62], [62, 38], [38, 62]]) expect(px(e, x, y).slice(0, 3)).toEqual([255, 0, 0]);
    for (const [x, y] of [[50, 50], [38, 38], [62, 62], [62, 38], [38, 62]]) expect(px(e, x, y)[3]).toBeGreaterThan(245);
    for (const [x, y] of [[70, 50], [30, 50], [50, 70], [50, 30], [70, 70]]) expect(px(e, x, y)[3]).toBe(0);
  });

  it('paints masks with coverage and the eraser removes alpha', () => {
    const id = setup({ size: 20 }, { primary: rgba(0, 0, 0) });
    e.setBrushTip('square', dyn({ roundness: 0.999 }));
    const slot = e.addMask(id);
    e.setPaintTarget(id, 'mask');
    stroke(e, 'brush', [[50, 50]]);
    expect(maskAt(e, slot, 50, 50)).toBe(0);
    expect(maskAt(e, slot, 43, 43)).toBe(0);
    expect(maskAt(e, slot, 70, 50)).toBe(255);
    e.setPaintTarget(id, 'pixels');
    drawRect(e, id, { x: 0, y: 0, w: 100, h: 100 }, 'rgb(0,200,0)');
    e.setBrushTip('chalk', dyn({ roundness: 0.999 }));
    stroke(e, 'eraser', [[50, 50]]);
    const d = data(id);
    expect(d[(50 * 100 + 50) * 4 + 3]).toBeLessThan(255);
    expect(d[(50 * 100 + 80) * 4 + 3]).toBe(255);
    let cleared = 0;
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) if (d[(y * 100 + x) * 4 + 3] < 128) cleared++;
    expect(cleared).toBeGreaterThan(30);
  });

  it('undo restores the pixels exactly', () => {
    const id = setup({ size: 30 });
    drawRect(e, id, { x: 0, y: 0, w: 100, h: 100 }, 'rgba(10,20,30,0.5)');
    const before = data(id).slice();
    e.setBrushTip('spatter', DYN);
    stroke(e, 'brush', PATH);
    expect(same(before, data(id))).toBe(false);
    e.undo();
    expect(same(before, data(id))).toBe(true);
  });

  it('respects the selection and sanitises unknown tips', () => {
    const id = setup({ size: 60 });
    e.setSelection({ x: 40, y: 0, w: 60, h: 100 });
    e.setBrushTip('bogus' as TipShape, dyn({ roundness: 0.5 }));
    expect(e.brushPresets()).toEqual([]);
    stroke(e, 'brush', [[50, 50]]);
    const b = bbox(data(id), 100) as NonNullable<ReturnType<typeof bbox>>;
    expect(b.x0).toBeGreaterThanOrEqual(40);
    e.setBrushTip('custom', dyn()); // no custom tip: round
    expect(e.brushTip().shape).toBe('round');
  });
});

describe('tip from selection', () => {
  it('returns the selected luminance and paints that shape', () => {
    const id = setup({ size: 40 });
    drawRect(e, id, { x: 10, y: 10, w: 20, h: 10 }, 'rgb(255,255,255)');
    drawRect(e, id, { x: 10, y: 20, w: 20, h: 10 }, 'rgb(128,128,128)');
    const ev = collect(e);
    expect(e.tipFromSelection()).toBeNull();
    expect(ev.some((x) => x.type === 'notice')).toBe(true);
    e.setSelection({ x: 5, y: 5, w: 40, h: 30 });
    const tip = e.tipFromSelection();
    expect(tip).not.toBeNull();
    const t = tip as NonNullable<typeof tip>;
    expect([t.w, t.h]).toEqual([40, 30]);
    expect(t.alpha[7 * 40 + 10]).toBe(255);
    expect(Math.abs(t.alpha[17 * 40 + 10] - 128)).toBeLessThanOrEqual(1);
    expect(t.alpha[1 * 40 + 1]).toBe(0);
    e.deselect();
    const id2 = e.addPixelLayer();
    e.setBrushTip('custom', dyn(), t);
    stroke(e, 'brush', [[50, 50]]);
    const d = data(id2);
    const at = (x: number, y: number) => d[(y * 100 + x) * 4 + 3];
    expect(at(45, 45)).toBe(255);
    expect(Math.abs(at(45, 55) - 128)).toBeLessThanOrEqual(4);
    expect(at(60, 45)).toBe(0);
    expect(at(45, 38)).toBe(0);
    expect(at(45, 66)).toBe(0);
  });

  it('downsizes large selections to 512 and needs a pixel layer', () => {
    setup({}, {}, 1200, 800);
    const ev = collect(e);
    const id = e.doc.active()?.id as string;
    drawRect(e, id, { x: 0, y: 0, w: 1200, h: 800 }, 'rgb(255,255,255)');
    e.setSelection({ x: 0, y: 0, w: 1100, h: 550 });
    const t = e.tipFromSelection() as NonNullable<ReturnType<Engine['tipFromSelection']>>;
    expect([t.w, t.h]).toEqual([512, 256]);
    expect(t.alpha[100 * 512 + 100]).toBe(255);
    const g = e.addGroup?.();
    if (g) { e.setActiveLayer(g); expect(e.tipFromSelection()).toBeNull(); expect(ev.some((x) => x.type === 'notice')).toBe(true); }
  });
});

describe('document presets', () => {
  it('round trip through docSpec / loadDocument with a custom tip, docspec only on change', async () => {
    e = newEngine(50, 50);
    const alpha = new Uint8Array(6 * 4).map((_, i) => i * 10);
    const png = encodeTipPng(6, 4, alpha);
    expect(png.startsWith('data:image/png;base64,')).toBe(true);
    const p: BrushPreset = { id: 'p1', name: 'Mine', settings: { size: 30, opacity: 0.5, flow: 0.7, hardness: 0.2, spacing: 0.3 }, tip: 'custom', dynamics: dyn({ scatter: 1.5, seed: 4 }), customTip: { w: 6, h: 4, png } };
    const ev = collect(e);
    const hist = e.history().entries.length;
    expect(e.docSpec().brushPresets).toEqual([]);
    e.setBrushPresets([p]);
    expect(ev.filter((x) => x.type === 'docspec')).toHaveLength(1);
    e.setBrushPresets([JSON.parse(JSON.stringify(p))]);
    expect(ev.filter((x) => x.type === 'docspec')).toHaveLength(1);
    expect(e.history().entries.length).toBe(hist);
    const spec = e.docSpec();
    expect(spec.brushPresets).toEqual([p]);
    spec.brushPresets?.push(null as unknown as BrushPreset, { id: 'x' } as unknown as BrushPreset);
    const e2 = newEngine(50, 50);
    e2.loadDocument(spec);
    expect(e2.brushPresets()).toHaveLength(2); // the junk object becomes a default preset, null is dropped
    expect(e2.brushPresets()[0]).toEqual(p);
    const t = await decodeTipPng(png);
    expect([t.w, t.h]).toEqual([6, 4]);
    expect(same(t.alpha, alpha)).toBe(true);
    e2.loadDocument({ ...e2.docSpec(), brushPresets: undefined });
    expect(e2.brushPresets()).toEqual([]);
    e2.dispose();
  });

  it('validates sizes of the encode / decode helpers', async () => {
    expect(() => encodeTipPng(0, 4, new Uint8Array(0))).toThrow();
    expect(() => encodeTipPng(513, 1, new Uint8Array(513))).toThrow();
    await expect(decodeTipPng('data:text/plain;base64,AAAA')).rejects.toThrow();
  });
});
