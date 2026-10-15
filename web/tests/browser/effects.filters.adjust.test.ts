// v7 classic adjustments as filters: levels, brightnessContrast, hueSaturation, invert, threshold reproduce the v2 adjustment maths
// (web/src/engine/adjustments.ts) within 1/255 on straight colour with alpha preserved; the blur filter vs the v6 adjustment blur.
import { afterAll, describe, expect, it } from 'vitest';
import type { AdjustmentSpec, Effect } from '../../src/engine/types';
import { brightnessContrastLut, hsvAdjust, levelsLut, luminance } from '../../src/engine/adjustments';
import { disposeEffects, effectsAvailable, legacyBlurToFilter, planChain } from '../../src/engine/effects';
import { effectReads } from '../../src/engine/effects';
import { makeSurface, run, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const W = 64;
const H = 48;
const fx = (type: string, params: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...params }) as unknown as Effect;
/** opaque colour ramps + a semi transparent band (alpha must survive) */
const img = () => makeSurface(W, H, (x, y): Px => [Math.floor((x / W) * 255), Math.floor((y / H) * 255), (x * 7 + y * 13) % 256, y < 8 ? 255 : y < 16 ? 128 : 255]);
const read = (s: ReturnType<typeof img>) => s.ctx.getImageData(0, 0, W, H).data;

/** reference of the v2 adjustment on one straight 8-bit pixel */
function ref(a: AdjustmentSpec, p: Px): Px {
  const o: Px = [p[0], p[1], p[2], p[3]];
  if (a.type === 'levels') { const l = levelsLut(a); for (let i = 0; i < 3; i++) o[i] = l[p[i]]; }
  else if (a.type === 'brightnessContrast') { const l = brightnessContrastLut(a); for (let i = 0; i < 3; i++) o[i] = l[p[i]]; }
  else if (a.type === 'invert') { for (let i = 0; i < 3; i++) o[i] = 255 - p[i]; }
  else if (a.type === 'hueSaturation') { const t = [0, 0, 0]; hsvAdjust(p[0], p[1], p[2], a.hue, a.saturation, a.value, t); o[0] = t[0]; o[1] = t[1]; o[2] = t[2]; }
  else if (a.type === 'threshold') { const v = luminance(p[0], p[1], p[2]) >= a.level * 255 ? 255 : 0; o[0] = v; o[1] = v; o[2] = v; }
  return o;
}

const CASES: { name: string; a: AdjustmentSpec }[] = [
  { name: 'levels in/out', a: { type: 'levels', inLow: 0.1, inHigh: 0.9, gamma: 1, outLow: 0.05, outHigh: 0.95 } },
  { name: 'levels gamma 2.2', a: { type: 'levels', inLow: 0, inHigh: 1, gamma: 2.2, outLow: 0, outHigh: 1 } },
  { name: 'levels inverted out', a: { type: 'levels', inLow: 0.2, inHigh: 0.8, gamma: 0.6, outLow: 1, outHigh: 0 } },
  { name: 'b/c', a: { type: 'brightnessContrast', brightness: 0.3, contrast: 0.4 } },
  { name: 'b/c negative', a: { type: 'brightnessContrast', brightness: -0.4, contrast: -0.5 } },
  { name: 'b/c extreme', a: { type: 'brightnessContrast', brightness: 1, contrast: 1 } },
  { name: 'hue +90', a: { type: 'hueSaturation', hue: 90, saturation: 1, value: 1 } },
  { name: 'hue -140 sat .5 val 1.5', a: { type: 'hueSaturation', hue: -140, saturation: 0.5, value: 1.5 } },
  { name: 'sat 1.7 val .7', a: { type: 'hueSaturation', hue: 0, saturation: 1.7, value: 0.7 } },
  { name: 'invert', a: { type: 'invert' } },
  { name: 'threshold .45', a: { type: 'threshold', level: 0.45 } },
];

describe.skipIf(!effectsAvailable())('classic adjustments as filters match the v2 adjustment maths', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const src = img();
      const s = read(src);
      const out = read(run(src, [fx(c.a.type, c.a as unknown as Record<string, unknown>)]).out);
      let worst = 0, bad = 0;
      for (let i = 0; i < W * H; i++) {
        const p: Px = [s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]];
        const e = ref(c.a, p);
        // output is read back straight; the engine stores premultiplied 8 bit, so compare premultiplied (tolerance 1/255 + the alpha rounding of the readback)
        const al = p[3] / 255;
        let m = Math.abs(out[i * 4 + 3] - e[3]);
        for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(out[i * 4 + k] - e[k]) * al);
        worst = Math.max(worst, m);
        if (m > 1.01) bad++;
      }
      // threshold and hue are discontinuous: allow the rare pixel whose step lands differently (premultiplied 8 bit quantises the straight colour of the semi transparent band)
      expect(bad, `worst ${worst}`).toBeLessThanOrEqual(c.a.type === 'threshold' || c.a.type === 'hueSaturation' ? 3 : 0);
    });
  }
  it('identity settings plan no passes; invert / threshold always run', () => {
    for (const t of ['levels', 'brightnessContrast', 'hueSaturation']) expect(planChain([fx(t)])).toHaveLength(0);
    expect(planChain([fx('invert')])).toHaveLength(1);
    expect(planChain([fx('threshold')])).toHaveLength(1);
  });
  it('are point ops (cheap region rendering)', () => {
    for (const [t, p] of [['levels', { gamma: 2 }], ['brightnessContrast', { contrast: 0.2 }], ['hueSaturation', { hue: 20 }], ['invert', {}], ['threshold', {}]] as [string, Record<string, unknown>][]) expect(effectReads(fx(t, p))).toBe('point');
  });
  it('alpha is preserved (fully transparent stays transparent)', () => {
    const src = makeSurface(8, 8, (): Px => [200, 10, 90, 0]);
    for (const t of ['invert', 'threshold', 'levels']) {
      const o = read2(run(src, [fx(t, t === 'levels' ? { gamma: 2 } : {})]).out);
      expect(o[3]).toBe(0);
    }
  });
});

const read2 = (s: ReturnType<typeof img>) => s.ctx.getImageData(0, 0, 1, 1).data;

// ---- blur: the v6 adjustment blur has sigma = radius px and repeats the edge pixels outside the document = {radius: 3r, sigma: r, edge: 'hold'}.
function gaussHold(s: Uint8ClampedArray, w: number, h: number, sigma: number): Float64Array {
  const n = Math.ceil(4 * sigma);
  const k = Array.from({ length: 2 * n + 1 }, (_, i) => Math.exp(-0.5 * ((i - n) / sigma) ** 2));
  const sum = k.reduce((a, b) => a + b, 0);
  let cur = Float64Array.from(s);
  for (const axis of [0, 1]) {
    const nxt = new Float64Array(cur.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
      let a = 0;
      for (let i = -n; i <= n; i++) {
        const xx = axis === 0 ? Math.min(w - 1, Math.max(0, x + i)) : x;
        const yy = axis === 1 ? Math.min(h - 1, Math.max(0, y + i)) : y;
        a += k[i + n] * cur[(yy * w + xx) * 4 + c];
      }
      nxt[(y * w + x) * 4 + c] = a / sum;
    }
    cur = nxt;
  }
  return cur;
}

describe.skipIf(!effectsAvailable())('legacy v6 Blur adjustment == legacyBlurToFilter(r) (opaque content, whole image incl. the border)', () => {
  it('mapping', () => {
    expect(legacyBlurToFilter(4)).toEqual({ enabled: true, type: 'blur', radius: 16, sigma: 4, edge: 'hold' });
    expect(legacyBlurToFilter(200)).toEqual({ enabled: true, type: 'blur', radius: 200, sigma: 200, edge: 'hold' });
    expect(legacyBlurToFilter(0.01)).toEqual({ enabled: true, type: 'blur', radius: 0, sigma: 0, edge: 'hold' });
    expect(planChain([legacyBlurToFilter(0.01) as unknown as Effect])).toHaveLength(0);
    expect(legacyBlurToFilter(1e9).sigma).toBe(200);
  });
  for (const r of [2, 4, 10, 16, 40, 200]) {
    it(`adjustment radius ${r}`, () => {
      const w = 128, h = 96;
      const src = makeSurface(w, h, (x, y): Px => [Math.floor((x / w) * 255), Math.floor((y / h) * 255), (x * 7 + y * 13) % 256, 255]);
      const s = src.ctx.getImageData(0, 0, w, h).data;
      const o = run(src, [legacyBlurToFilter(r) as unknown as Effect]).out.ctx.getImageData(0, 0, w, h).data;
      const ref = gaussHold(s, w, h, r);
      let worst = 0;
      for (let i = 0; i < w * h * 4; i++) worst = Math.max(worst, Math.abs(o[i] - ref[i]));
      expect(worst).toBeLessThanOrEqual(2);
    });
  }
});
