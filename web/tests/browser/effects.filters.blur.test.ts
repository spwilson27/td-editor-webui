// v6 filters, group "blur": motionBlur, radialBlur, zoomBlur, lensBlur semantic tests (the generic checks live in effects.filters.test.ts).
import { afterAll, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import { createSurface } from '../../src/engine/surface';
import { disposeEffects, effectsAvailable } from '../../src/engine/effects';
import { allPremult, makeSurface, pm, run, square, straight, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const fx = (type: string, params: Record<string, unknown>): Effect => ({ enabled: true, type, ...params }) as unknown as Effect;
const dot = (w: number, h: number, x: number, y: number) => makeSurface(w, h, (px, py): Px => (px === x && py === y ? [255, 255, 255, 255] : [0, 0, 0, 0]));
const maxDiff = (a: Float32Array, b: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

describe.skipIf(!effectsAvailable())('motionBlur', () => {
  it('length 0 is the identity', () => {
    const src = square(64, 48, 10, 10, 30, 30);
    const { out } = run(src, [fx('motionBlur', { length: 0, angle: 30 })]);
    expect(maxDiff(allPremult(out), allPremult(src))).toBeLessThanOrEqual(1);
  });
  it('horizontal box of a 1 px column: 1/length per pixel inside, half at the edge, zero outside', () => {
    const src = makeSurface(64, 16, (x): Px => (x === 30 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const { out } = run(src, [fx('motionBlur', { length: 8, angle: 0 })]);
    for (const x of [27, 30, 33]) expect(Math.abs(pm(out, x, 8)[3] - 32)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(pm(out, 34, 8)[3] - 16)).toBeLessThanOrEqual(1.5);
    expect(pm(out, 36, 8)[3]).toBe(0);
    expect(pm(out, 30, 8)[3]).toBe(pm(out, 30, 3)[3]);
  });
  it('long streaks stay flat (two-pass box), angle 90 smears vertically only', () => {
    const src = makeSurface(240, 8, (x): Px => (x === 120 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const { out } = run(src, [fx('motionBlur', { length: 100, angle: 0 })]);
    let lo = 999, hi = 0;
    for (let x = 75; x <= 165; x++) { const a = pm(out, x, 4)[3]; lo = Math.min(lo, a); hi = Math.max(hi, a); }
    expect(hi - lo).toBeLessThanOrEqual(1.01);
    expect(pm(out, 175, 4)[3]).toBe(0);
    const v = run(dot(32, 32, 16, 16), [fx('motionBlur', { length: 10, angle: 90 })]).out;
    expect(pm(v, 16, 19)[3]).toBeGreaterThan(15);
    expect(pm(v, 19, 16)[3]).toBe(0);
  });
  it('no colour fringing on a semi-transparent edge', () => {
    const { out } = run(square(48, 32, 10, 8, 30, 24, [255, 0, 0, 255]), [fx('motionBlur', { length: 12, angle: 0 })]);
    const s = straight(out, 33, 16);
    expect(s[3]).toBeGreaterThan(0);
    expect(s[0]).toBeGreaterThanOrEqual(250);
    expect(s[1]).toBeLessThanOrEqual(2);
  });
});

describe.skipIf(!effectsAvailable())('radialBlur', () => {
  it('amount 0 is the identity; centred disc is invariant', () => {
    const src = makeSurface(64, 48, (x, y): Px => ((x - 31.5) ** 2 + (y - 23.5) ** 2 < 100 ? [255, 120, 0, 255] : [0, 0, 0, 0]));
    expect(maxDiff(allPremult(run(src, [fx('radialBlur', { amount: 0 })]).out), allPremult(src))).toBeLessThanOrEqual(1);
    const o = run(src, [fx('radialBlur', { amount: 90, centerX: 0.5, centerY: 0.5 })]).out;
    for (const [x, y] of [[31, 23], [28, 23], [31, 20]]) expect(Math.abs(pm(o, x, y)[3] - 255)).toBeLessThanOrEqual(3);
    expect(pm(o, 31, 23)[0]).toBeGreaterThan(250);
  });
  it('a dot spreads along the tangent, not the radius', () => {
    const o = run(dot(64, 48, 52, 24), [fx('radialBlur', { amount: 40, centerX: 0.5, centerY: 0.5 })]).out;
    expect(pm(o, 52, 20)[3]).toBeGreaterThan(5);
    expect(pm(o, 52, 28)[3]).toBeGreaterThan(5);
    expect(pm(o, 58, 24)[3]).toBe(0);
    expect(pm(o, 45, 24)[3]).toBe(0);
  });
  it('extreme parameters give finite, non-empty output', () => {
    const src = square(64, 48, 8, 8, 50, 40);
    const o = allPremult(run(src, [fx('radialBlur', { amount: 1e9, centerX: -4, centerY: 9 })]).out);
    expect(o.every(Number.isFinite)).toBe(true);
    expect(o.some((v) => v > 0)).toBe(true);
  });
});

describe.skipIf(!effectsAvailable())('zoomBlur', () => {
  it('amount 0 is the identity; the centre pixel is unchanged', () => {
    const src = square(64, 48, 10, 10, 50, 40, [10, 200, 90, 255]);
    expect(maxDiff(allPremult(run(src, [fx('zoomBlur', { amount: 0 })]).out), allPremult(src))).toBeLessThanOrEqual(1);
    const o = run(src, [fx('zoomBlur', { amount: 80 })]).out;
    expect(pm(o, 32, 24)[3]).toBe(255);
  });
  it('streaks point away from the centre: pixels outside the dot see it, pixels inside do not', () => {
    const o = run(dot(64, 48, 52, 24), [fx('zoomBlur', { amount: 50, centerX: 0.5, centerY: 0.5 })]).out;
    expect(pm(o, 58, 24)[3]).toBeGreaterThan(5);
    expect(pm(o, 52, 24)[3]).toBeGreaterThan(5);
    expect(pm(o, 45, 24)[3]).toBe(0);
    expect(pm(o, 52, 10)[3]).toBe(0);
  });
  it('monotonic: a larger amount spreads the dot further', () => {
    const reach = (amount: number) => {
      const o = run(dot(64, 48, 40, 24), [fx('zoomBlur', { amount, centerX: 0.5, centerY: 0.5 })]).out;
      let m = 0;
      for (let x = 40; x < 64; x++) if (pm(o, x, 24)[3] > 0) m = x;
      return m;
    };
    expect(reach(60)).toBeGreaterThan(reach(20));
  });
});

describe.skipIf(!effectsAvailable())('lensBlur', () => {
  it('radius 0 is the identity', () => {
    const src = square(64, 48, 10, 10, 30, 30);
    expect(maxDiff(allPremult(run(src, [fx('lensBlur', { radius: 0, blades: 6, brightness: 80 })]).out), allPremult(src))).toBeLessThanOrEqual(1);
  });
  it('a flat colour field is preserved at every radius (normalisation, pyramid levels)', () => {
    const src = makeSurface(360, 300, (): Px => [120, 60, 30, 255]);
    for (const radius of [3, 12, 24, 50, 100]) {
      const o = run(src, [fx('lensBlur', { radius, blades: radius === 24 ? 5 : 0 })]).out;
      const p = pm(o, 180, 150);
      expect(Math.abs(p[0] - 120)).toBeLessThanOrEqual(2);
      expect(Math.abs(p[1] - 60)).toBeLessThanOrEqual(2);
      expect(Math.abs(p[3] - 255)).toBeLessThanOrEqual(1);
    }
  });
  it('disc keeps the energy of an object inside the layer, polygon kernel has corners, circle does not', () => {
    const src = dot(64, 48, 32, 24);
    const sum = (s: ReturnType<typeof run>['out']) => { const a = allPremult(s); let t = 0; for (let i = 3; i < a.length; i += 4) t += a[i]; return t; };
    const circle = run(src, [fx('lensBlur', { radius: 8, blades: 0, seed: 1 })]).out;
    expect(Math.abs(sum(circle) - 255)).toBeLessThan(30);
    const box = (s: typeof circle) => { let t = 0; for (let y = 29; y <= 31; y++) for (let x = 37; x <= 39; x++) t += pm(s, x, y)[3]; return t; };
    const poly = run(src, [fx('lensBlur', { radius: 8, blades: 4, rotation: 0, seed: 1 })]).out;
    expect(box(poly)).toBeLessThanOrEqual(2);                  // offsets 5..7 lie beyond the square's edge (inradius 5.66 along the diagonal)
    expect(box(circle)).toBeGreaterThanOrEqual(4);
    expect(pm(circle, 32 + 12, 24)[3]).toBe(0);  // nothing beyond radius + 1
  });
  it('brightness boosts highlights, none leaves the plain average; deterministic seed', () => {
    const src = makeSurface(64, 48, (x, y): Px => (x === 32 && y === 24 ? [255, 255, 255, 255] : [60, 60, 60, 255]));
    const plain = run(src, [fx('lensBlur', { radius: 6, brightness: 0 })]).out;
    const boost = run(src, [fx('lensBlur', { radius: 6, brightness: 100, threshold: 0.6 })]).out;
    let sp = 0, sb = 0;
    for (let y = 20; y <= 28; y++) for (let x = 28; x <= 36; x++) { sp += pm(plain, x, y)[0]; sb += pm(boost, x, y)[0]; }
    expect(sb).toBeGreaterThan(sp + 100);
    const tex = makeSurface(64, 48, (x, y): Px => [(x * 37 + y * 11) % 256, (x * 5) % 256, (y * 13) % 256, 255]);
    const a = allPremult(run(tex, [fx('lensBlur', { radius: 5, seed: 4 })]).out);
    const b = allPremult(run(tex, [fx('lensBlur', { radius: 5, seed: 4 })]).out);
    const c = allPremult(run(tex, [fx('lensBlur', { radius: 5, seed: 5 })]).out);
    expect(maxDiff(a, b)).toBe(0);
    expect(maxDiff(a, c)).toBeGreaterThan(1);
  });
  it('extreme parameters give finite, non-black output', () => {
    const src = square(96, 72, 20, 14, 70, 56, [255, 200, 40, 255]);
    const o = allPremult(run(src, [fx('lensBlur', { radius: 1e9, blades: 99, brightness: 1e9, rotation: 1e9, threshold: 5 })]).out);
    expect(o.every(Number.isFinite)).toBe(true);
    expect(o.some((v) => v > 10)).toBe(true);
    const o2 = createSurface(96, 72, true);
    run(src, [fx('lensBlur', { radius: 100, blades: 8, brightness: 100 })], undefined, o2);
    expect(pm(o2, 45, 35)[3]).toBeGreaterThan(5);
  });
});
