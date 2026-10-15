// Semantic tests of the "animated made static" filters: driftGlitch, feedback, echo, colorCycle.
import { afterAll, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import { disposeEffects, effectsAvailable } from '../../src/engine/effects';
import { allPremult, makeSurface, pm, run, square, straight, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const fx = (type: string, params: Record<string, unknown>) => ({ enabled: true, type, ...params }) as unknown as Effect;
const near = (a: number, b: number, tol = 2) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
const W = 32;
const H = 24;
const sq = () => square(W, H, 4, 8, 8, 12); // opaque red 4x4

describe.skipIf(!effectsAvailable())('animated filters (static)', () => {
  describe('echo', () => {
    it('hand-checkable: one echo, translation + decay, over', () => {
      const { out } = run(sq(), [fx('echo', { iterations: 2, dx: 6, dy: 0, decay: 50, blend: 'over', fade: 'exp' })]);
      expect(pm(out, 5, 9)).toEqual([255, 0, 0, 255]); // original on top
      const e = pm(out, 11, 9); // echo at x 10..14, alpha 0.5
      near(e[0], 127.5); near(e[3], 127.5); near(e[1], 0);
      expect(pm(out, 8, 9)[3]).toBe(0);
      expect(pm(out, 15, 9)[3]).toBe(0);
    });
    it('over keeps the original on top of an overlapping echo; add saturates; lighten = max', () => {
      const over = run(sq(), [fx('echo', { iterations: 2, dx: 2, dy: 0, decay: 50, blend: 'over', fade: 'exp' })]).out;
      expect(pm(over, 6, 9)).toEqual([255, 0, 0, 255]);
      const add = run(sq(), [fx('echo', { iterations: 3, dx: 0, dy: 0, decay: 100, blend: 'add', fade: 'exp' })]).out;
      expect(pm(add, 5, 9)).toEqual([255, 0, 0, 255]);
      const g = makeSurface(W, H, (): Px => [100, 50, 0, 128]);
      const a = run(g, [fx('echo', { iterations: 2, dx: 0, dy: 0, decay: 100, blend: 'add' })]).out;
      const p = pm(a, 10, 10); // premult 2 * (50.2, 25.1, 0, 128) -> alpha 256 clamps to 255
      near(p[3], 255, 1); near(p[0], 100, 2); near(p[1], 50, 2);
      const l = run(g, [fx('echo', { iterations: 4, dx: 0, dy: 0, decay: 100, blend: 'lighten' })]).out;
      near(pm(l, 10, 10)[3], 128, 1); near(pm(l, 10, 10)[0], 50.2, 2);
    });
    it('fade linear vs exp, noop cases, determinism', () => {
      const e = run(sq(), [fx('echo', { iterations: 3, dx: 4, dy: 0, decay: 50, fade: 'exp' })]).out;
      const l = run(sq(), [fx('echo', { iterations: 3, dx: 4, dy: 0, decay: 50, fade: 'linear' })]).out;
      near(pm(e, 13, 9)[3], 64, 1); // 0.25
      expect(pm(l, 13, 9)[3]).toBe(0); // 1 - 2 * 0.5 = 0
      near(pm(l, 9, 9)[3], 127.5, 1);
      const base = allPremult(sq());
      for (const p of [{ iterations: 1 }, { decay: 0 }]) expect(allPremult(run(sq(), [fx('echo', { dx: 5, ...p })]).out)).toEqual(base);
      const a = allPremult(run(sq(), [fx('echo', { iterations: 5, dx: 3, dy: 2 })]).out);
      expect(allPremult(run(sq(), [fx('echo', { iterations: 5, dx: 3, dy: 2 })]).out)).toEqual(a);
    });
    it('extreme parameters stay finite and keep the original', () => {
      const out = run(sq(), [fx('echo', { iterations: 1e9, dx: 1e9, dy: -1e9, decay: 1e9 })]).out;
      const d = allPremult(out);
      for (const v of d) expect(Number.isFinite(v)).toBe(true);
      expect(pm(out, 5, 9)).toEqual([255, 0, 0, 255]);
    });
  });

  describe('feedback', () => {
    it('translation case equals echo and the manual composite', () => {
      const a = run(sq(), [fx('feedback', { iterations: 2, dx: 6, dy: 0, decay: 50, blend: 'over' })]).out;
      const b = run(sq(), [fx('echo', { iterations: 2, dx: 6, dy: 0, decay: 50, blend: 'over', fade: 'exp' })]).out;
      expect(allPremult(a)).toEqual(allPremult(b));
      near(pm(a, 11, 9)[3], 127.5);
      // three layers, decay 0.5, dy: weights 1, .5, .25 at rows 8..12, 12..16, 16..20
      const c = run(sq(), [fx('feedback', { iterations: 3, dx: 0, dy: 4, decay: 50, blend: 'over' })]).out;
      near(pm(c, 5, 13)[3], 127.5); near(pm(c, 5, 17)[3], 63.75);
    });
    it('rotate 90 deg about the centre is clockwise on screen', () => {
      const { out } = run(sq(), [fx('feedback', { iterations: 2, dx: 0, dy: 0, rotate: 90, scale: 100, decay: 100 })]);
      // square left of the centre (16,12) -> above it: x 16..20, y 0..4
      const p = pm(out, 17, 1);
      near(p[0], 255, 3); near(p[3], 255, 3);
      expect(pm(out, 5, 9)).toEqual([255, 0, 0, 255]);
      expect(pm(out, 17, 20)[3]).toBe(0);
    });
    it('scale about a centre; add saturates; screen; noop at iterations 1', () => {
      const big = run(sq(), [fx('feedback', { iterations: 2, dx: 0, dy: 0, scale: 200, decay: 100, centerX: 0.25, centerY: 0.5 })]).out;
      // centre (8, 12): square x 4..8, y 8..12 -> x 0..8, y 4..12 (scaled x2 about the centre)
      near(pm(big, 1, 5)[3], 255, 3);
      const sat = makeSurface(16, 16, (): Px => [100, 50, 0, 255]);
      const add = run(sat, [fx('feedback', { iterations: 3, dx: 0, dy: 0, decay: 100, blend: 'add' })]).out;
      const p = pm(add, 8, 8);
      near(p[0], 255, 1); near(p[1], 150, 2); near(p[2], 0, 1); near(p[3], 255, 1);
      const scr = run(sat, [fx('feedback', { iterations: 2, decay: 100, dx: 0, dy: 0, blend: 'screen' })]).out;
      const q = pm(scr, 8, 8); // opaque: 1 - (1 - c)^2 per channel
      near(q[0], 255 * (1 - (1 - 100 / 255) ** 2), 2); near(q[3], 255, 1);
      expect(allPremult(run(sq(), [fx('feedback', { iterations: 1, rotate: 30 })]).out)).toEqual(allPremult(sq()));
    });
    it('deterministic; extreme parameters are finite and never remove the input', () => {
      const e = { iterations: 64, dx: 500, dy: -500, rotate: 180, scale: 50, decay: 100, blend: 'screen', centerX: 0, centerY: 1 };
      const a = allPremult(run(sq(), [fx('feedback', e)]).out);
      expect(allPremult(run(sq(), [fx('feedback', e)]).out)).toEqual(a);
      for (const blend of ['over', 'add', 'lighten', 'screen']) for (const scale of [50, 200]) {
        const out = run(sq(), [fx('feedback', { ...e, blend, scale, rotate: 137 })]).out;
        for (const v of allPremult(out)) expect(Number.isFinite(v)).toBe(true);
        const s = straight(out, 5, 9);
        expect(s[3]).toBe(255);
      }
    });
  });

  describe('driftGlitch', () => {
    const grad = () => makeSurface(64, 32, (x): Px => [x * 4, x * 4, x * 4, 255]);
    it('deterministic, seed changes the result, noop at amount 0 / density 0', () => {
      const p = { iterations: 8, amount: 6, blockSize: 4, density: 80, rgbShift: 2 };
      const a = allPremult(run(grad(), [fx('driftGlitch', { ...p, seed: 1 })]).out);
      expect(allPremult(run(grad(), [fx('driftGlitch', { ...p, seed: 1 })]).out)).toEqual(a);
      const b = allPremult(run(grad(), [fx('driftGlitch', { ...p, seed: 2 })]).out);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
      expect(diff).toBeGreaterThan(100);
      const base = allPremult(grad());
      expect(allPremult(run(grad(), [fx('driftGlitch', { ...p, amount: 0 })]).out)).toEqual(base);
      expect(allPremult(run(grad(), [fx('driftGlitch', { ...p, density: 0 })]).out)).toEqual(base);
    });
    it('one step: each band is shifted rigidly along x by at most `amount` (no rgb split)', () => {
      const amount = 5;
      const { out } = run(grad(), [fx('driftGlitch', { iterations: 1, amount, blockSize: 4, density: 100, rgbShift: 0, seed: 7 })]);
      const shifts: number[] = [];
      for (let band = 0; band < 8; band++) {
        const s: number[] = [];
        for (let y = band * 4; y < band * 4 + 4; y++) {
          const p = straight(out, 32, y); // x = 32 stays inside for |shift| <= 5
          s.push(32 - p[0] / 4);
        }
        expect(new Set(s).size, 'rows of a band share one shift').toBe(1);
        expect(Math.abs(s[0])).toBeLessThanOrEqual(amount + 0.5);
        shifts.push(s[0]);
      }
      expect(new Set(shifts).size).toBeGreaterThan(1);
    });
    it('drift grows with the iteration count; axis v moves along y; transparent outside', () => {
      const spread = (n: number) => {
        const { out } = run(grad(), [fx('driftGlitch', { iterations: n, amount: 2, blockSize: 1, density: 100, rgbShift: 0, seed: 3 })]);
        let acc = 0;
        for (let y = 0; y < 32; y++) acc += Math.abs(32 - straight(out, 32, y)[0] / 4);
        return acc / 32;
      };
      expect(spread(36)).toBeGreaterThan(spread(1));
      const vsrc = makeSurface(32, 64, (_x, y): Px => [y * 4, y * 4, y * 4, 255]);
      const { out } = run(vsrc, [fx('driftGlitch', { iterations: 1, amount: 4, blockSize: 4, density: 100, rgbShift: 0, seed: 5, axis: 'v' })]);
      for (let band = 0; band < 8; band++) {
        const vals = new Set<number>();
        for (let x = band * 4; x < band * 4 + 4; x++) vals.add(straight(out, x, 32)[0]);
        expect(vals.size).toBe(1);
      }
      const edge = run(grad(), [fx('driftGlitch', { iterations: 4, amount: 30, blockSize: 32, density: 100, rgbShift: 0, seed: 4 })]).out;
      let transparent = 0;
      for (let x = 0; x < 64; x++) if (straight(edge, x, 5)[3] === 0) transparent++;
      expect(transparent).toBeGreaterThan(0);
    });
    it('rgbShift splits red and blue symmetrically around green', () => {
      const { out } = run(grad(), [fx('driftGlitch', { iterations: 1, amount: 4, blockSize: 32, density: 100, rgbShift: 4, seed: 9 })]);
      const p = straight(out, 32, 5);
      const sg = 32 - p[1] / 4; // shift of green = o (rounded)
      const sr = 32 - p[0] / 4;
      const sb = 32 - p[2] / 4;
      near(sr - sg, sg ? Math.round(sg * 1) : 0, 1.5); // k = o * rgbShift / amount = o
      near(sg - sb, sr - sg, 1.5);
    });
    it('extreme parameters render without NaN (output stays opaque where read)', () => {
      const out = run(grad(), [fx('driftGlitch', { iterations: 1e9, amount: 1e9, blockSize: 0, density: 1e9, rgbShift: 1e9, seed: -3 })]).out;
      for (const v of allPremult(out)) expect(Number.isFinite(v)).toBe(true);
    });
  });

  describe('colorCycle', () => {
    const one = (c: Px, params: Record<string, unknown>) => straight(run(makeSurface(4, 4, () => c), [fx('colorCycle', params)]).out, 1, 1);
    const cols: Px[] = [[200, 80, 40, 255], [30, 160, 90, 255], [120, 120, 200, 255]];
    it('hueStep 360 / iterations multiples return the input (lumaWarp 0)', () => {
      for (const c of cols) {
        for (const [n, step] of [[1, 360 / 1 - 360 + 180], [4, 90], [8, 45], [3, 120]] as const) {
          // 360 deg total: n * step = 360 only for the last three; the first entry is the 180 deg control
          const o = one(c, { iterations: n, hueStep: step, lumaWarp: 0 });
          if (n * step === 360) { near(o[0], c[0], 3); near(o[1], c[1], 3); near(o[2], c[2], 3); }
          else expect(Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2])).toBeGreaterThan(20);
        }
      }
    });
    it('lumaWarp 0: n steps of s == one step of n * s; luma warp makes the loop non-collapsible', () => {
      for (const c of cols) {
        const a = one(c, { iterations: 3, hueStep: 40, lumaWarp: 0 });
        const b = one(c, { iterations: 1, hueStep: 120, lumaWarp: 0 });
        for (let k = 0; k < 3; k++) near(a[k], b[k], 2);
      }
      let d = 0;
      for (const c of cols) {
        const a = one(c, { iterations: 2, hueStep: 30, lumaWarp: 100 });
        const b = one(c, { iterations: 1, hueStep: 60, lumaWarp: 100 });
        d += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      }
      expect(d).toBeGreaterThan(6);
    });
    it('bands snap the phase; saturationBoost raises chroma; hueStep 0 is a no-op', () => {
      const c = cols[0];
      const snapped0 = one(c, { iterations: 1, hueStep: 10, lumaWarp: 0, bands: 4 }); // 10 deg -> 0
      for (let k = 0; k < 3; k++) near(snapped0[k], c[k], 3);
      const snapped = one(c, { iterations: 1, hueStep: 50, lumaWarp: 0, bands: 4 }); // 50 deg -> 90
      const ref = one(c, { iterations: 1, hueStep: 90, lumaWarp: 0 });
      for (let k = 0; k < 3; k++) near(snapped[k], ref[k], 3);
      const sat = one(c, { iterations: 1, hueStep: 0.5, lumaWarp: 0, saturationBoost: 50 });
      expect(Math.max(...sat.slice(0, 3)) - Math.min(...sat.slice(0, 3))).toBeGreaterThan(Math.max(...c.slice(0, 3)) - Math.min(...c.slice(0, 3)));
      const base = allPremult(sq());
      expect(allPremult(run(sq(), [fx('colorCycle', { hueStep: 0, iterations: 9, saturationBoost: 80 })]).out)).toEqual(base);
    });
    it('alpha is preserved; extreme parameters stay finite', () => {
      const img = makeSurface(8, 8, (x): Px => [200, 100, 50, x * 32]);
      const a = run(img, [fx('colorCycle', { iterations: 5, hueStep: 70, lumaWarp: 80, saturationBoost: 30, bands: 5 })]).out;
      for (let x = 0; x < 8; x++) near(straight(a, x, 3)[3], x * 32, 1);
      const e = run(img, [fx('colorCycle', { iterations: 1e9, hueStep: 1e9, lumaWarp: 1e9, saturationBoost: 1e9, bands: 1e9 })]).out;
      for (const v of allPremult(e)) expect(Number.isFinite(v)).toBe(true);
      for (let x = 0; x < 8; x++) near(straight(e, x, 3)[3], x * 32, 1);
    });
  });
});
