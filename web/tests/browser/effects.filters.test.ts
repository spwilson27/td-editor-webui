// v6 filters library: generic checks over EVERY filter spec (compile + run, finite output, partial == full region, noop identity) plus the
// blur pyramid quality numbers.  Per-filter semantic tests live in effects.filters.<group>.test.ts.
import { afterAll, describe, expect, it } from 'vitest';
import { createSurface } from '../../src/engine/surface';
import { FILTER_SPECS } from '../../src/engine/effects/filters';
import { applyEffects, disposeEffects, effectsAvailable, expandRect, planChain, type AnyEffect } from '../../src/engine/effects';
import { allPremult, makeSurface, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const W = 160;
const H = 120;
/** gradient ellipse + hard rectangle + noise patch + thin line, straight RGBA */
export function testImage(w = W, h = H) {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const noise = Array.from({ length: 24 * 24 }, () => Math.floor(rnd() * 256));
  return makeSurface(w, h, (x, y): Px => {
    const e = ((x - w * 0.4) / (w * 0.3)) ** 2 + ((y - h * 0.5) / (h * 0.35)) ** 2;
    if (e <= 1) return [Math.floor((x / w) * 255), Math.floor((1 - y / h) * 255), 200, 255];
    if (x >= w * 0.65 && x < w * 0.9 && y >= h * 0.6 && y < h * 0.9) return [180, 60, 200, 128];
    if (x >= w * 0.7 && x < w * 0.7 + 24 && y >= 6 && y < 30) { const v = noise[(y - 6) * 24 + (x - Math.floor(w * 0.7))]; return [v, v, v, 255]; }
    if (Math.abs(x - y - 20) < 1) return [255, 255, 0, 255];
    return [0, 0, 0, 0];
  });
}

const fx = (type: string, params: Record<string, unknown>): AnyEffect => ({ enabled: true, type, ...params }) as unknown as AnyEffect;

if (!effectsAvailable()) console.warn('[effects tests] WebGL2 / EXT_color_buffer_float unavailable: the filter render tests are SKIPPED');

describe.skipIf(!effectsAvailable())('filters: every spec renders', () => {
  const src = testImage();
  const aux = makeSurface(W, H, (x, y): Px => [Math.floor((x / W) * 255), Math.floor((y / H) * 255), 128, 255]);
  const base = allPremult(src);
  for (const t of Object.keys(FILTER_SPECS).sort()) {
    const spec = FILTER_SPECS[t];
    spec.samples!.forEach((s, si) => {
      it(`${t} sample ${si}: finite output, changes the image unless a no-op`, () => {
        const e = fx(t, s);
        const out = createSurface(W, H, true);
        applyEffects(src, [e], { x: 0, y: 0, w: W, h: H }, out, aux);
        const d = allPremult(out);
        let diff = 0;
        for (let i = 0; i < d.length; i++) {
          expect(Number.isFinite(d[i])).toBe(true);
          diff += Math.abs(d[i] - base[i]);
        }
        if (planChain([e]).length) expect(diff, 'filter had no visible effect on the test image').toBeGreaterThan(50);
      });
    });
    spec.samples!.forEach((smp, si) => {
      it(`${t} sample ${si}: partial regions (middle, corners, 1x1, edges) == full render`, () => {
        const e = fx(t, smp);
        if (!planChain([e]).length) return;
        const full = createSurface(W, H, true);
        applyEffects(src, [e], { x: 0, y: 0, w: W, h: H }, full, aux);
        const f = allPremult(full);
        const rects = [{ x: 37, y: 29, w: 23, h: 17 }, { x: 101, y: 3, w: 31, h: 40 }, { x: 0, y: 0, w: 1, h: 1 }, { x: W - 1, y: H - 1, w: 1, h: 1 },
          { x: 0, y: H - 9, w: 13, h: 9 }, { x: W - 20, y: 0, w: 20, h: 11 }, { x: 70, y: 60, w: 1, h: 1 }];
        for (const dirty of rects) {
          const part = createSurface(W, H, true);
          const r = applyEffects(src, [e], dirty, part, aux);
          expect(r).toEqual(expandRect(dirty, [e], true, W, H));
          const p = allPremult(part);
          let bad = 0;
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) for (let k = 0; k < 4; k++) {
            if (Math.abs(f[(y * W + x) * 4 + k] - p[(y * W + x) * 4 + k]) > 1) bad++;
          }
          expect(bad, `${t}#${si} rect ${JSON.stringify(dirty)}: ${bad} channel values differ between the partial and the full render`).toBe(0);
        }
      });
    });
  }
});

/** exact separable gaussian (sigma = px / 3, kernel half width ceil(px)) of premultiplied 0..255 rgba */
function refGauss(a: Float32Array, w: number, h: number, px: number): Float32Array {
  const R = Math.ceil(px);
  const sg = px / 3;
  const k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp((-0.5 * (i - R) * (i - R)) / (sg * sg)));
  const ws = k.reduce((x, y) => x + y, 0);
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let acc = 0;
    for (let i = -R; i <= R; i++) { const xx = x + i; if (xx >= 0 && xx < w) acc += k[i + R] * a[(y * w + xx) * 4 + c]; }
    tmp[(y * w + x) * 4 + c] = acc / ws;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let acc = 0;
    for (let i = -R; i <= R; i++) { const yy = y + i; if (yy >= 0 && yy < h) acc += k[i + R] * tmp[(yy * w + x) * 4 + c]; }
    out[(y * w + x) * 4 + c] = acc / ws;
  }
  return out;
}

describe.skipIf(!effectsAvailable())('pyramid quality (blur radius vs an exact gaussian)', () => {
  const w = 256;
  const h = 192;
  const img = makeSurface(w, h, (x, y): Px => (x > 70 && x < 190 && y > 50 && y < 150 ? [255, 120, 30, 255] : (x + y) % 37 === 0 ? [30, 200, 255, 160] : [0, 0, 0, 0]));
  const base = allPremult(img);
  const stats: string[] = [];
  for (const px of [12, 16, 17, 24, 32, 33, 48, 64, 65, 100, 130, 200]) {
    it(`radius ${px}: max / mean error vs exact gaussian`, () => {
      const out = createSurface(w, h, true);
      applyEffects(img, [fx('blur', { radius: px })], { x: 0, y: 0, w, h }, out);
      const got = allPremult(out);
      const ref = refGauss(base, w, h, px);
      let mx = 0;
      let sum = 0;
      for (let i = 0; i < got.length; i++) { const d = Math.abs(got[i] - ref[i]); mx = Math.max(mx, d); sum += d; }
      const mean = sum / got.length;
      stats.push(`radius ${px}: max ${mx.toFixed(2)}/255  mean ${mean.toFixed(3)}/255`);
      // exact path (<= 32 px): 8-bit rounding only; pyramid: documented tolerance
      if (px <= 16) expect(mx).toBeLessThanOrEqual(1.5);
      else { expect(mx).toBeLessThanOrEqual(2.5); expect(mean).toBeLessThanOrEqual(0.4); } // measured: max <= 2.4/255, mean 0.26-0.30
    });
  }
  afterAll(() => console.log('PYRAMID QUALITY\n' + stats.join('\n')));
});

describe.skipIf(!effectsAvailable())('v5 blur-type effects: pyramid is continuous with the exact path at the 16 px threshold', () => {
  const w = 200;
  const h = 150;
  const img = makeSurface(w, h, (x, y): Px => (x > 60 && x < 140 && y > 40 && y < 110 ? [255, 120, 30, 255] : [0, 0, 0, 0]));
  const col = { r: 20, g: 220, b: 90, a: 255 };
  const mk = (type: string, size: number): AnyEffect => {
    const base = { enabled: true, type } as Record<string, unknown>;
    if (type === 'dropShadow') Object.assign(base, { dx: 6, dy: 4, blur: size, color: col, opacity: 1 });
    else if (type === 'bevel') Object.assign(base, { depth: 100, size, angle: 120, highlight: { r: 255, g: 255, b: 255, a: 255 }, shadow: { r: 0, g: 0, b: 0, a: 255 } });
    else Object.assign(base, { size, color: col, opacity: 1 });
    return base as unknown as AnyEffect;
  };
  const lines: string[] = [];
  for (const t of ['dropShadow', 'outerGlow', 'innerGlow', 'bevel']) {
    it(`${t}: size 16 (exact) vs 17 (pyramid) is no bigger a step than 15 vs 16 (both exact)`, () => {
      const render = (size: number) => {
        const o = createSurface(w, h, true);
        applyEffects(img, [mk(t, size)], { x: 0, y: 0, w, h }, o);
        return allPremult(o);
      };
      const diff = (a: Float32Array, b: Float32Array) => {
        let mx = 0;
        let sum = 0;
        for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); mx = Math.max(mx, d); sum += d; }
        return { mx, mean: sum / a.length };
      };
      const p15 = render(15);
      const p16 = render(16);
      const p17 = render(17);
      const exactStep = diff(p15, p16);
      const crossStep = diff(p16, p17);
      lines.push(`${t}: 15->16 (exact) max ${exactStep.mx.toFixed(1)} mean ${exactStep.mean.toFixed(3)} | 16->17 (exact -> pyramid) max ${crossStep.mx.toFixed(1)} mean ${crossStep.mean.toFixed(3)}  /255`);
      expect(crossStep.mx).toBeLessThanOrEqual(exactStep.mx * 1.5 + 3);
      expect(crossStep.mean).toBeLessThanOrEqual(exactStep.mean * 1.5 + 0.1);
    });
  }
  afterAll(() => console.log('LEGACY PYRAMID CONTINUITY\n' + lines.join('\n')));
});
