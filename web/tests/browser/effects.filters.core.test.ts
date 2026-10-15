// v6 filters library core: blur family, posterize, curves, displace (+ the aux input and adjustment-layer usage).
import { afterAll, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import { createSurface } from '../../src/engine/surface';
import { FILTER_SPECS, parseCube, CUBE_MAX_CHARS } from '../../src/engine/effects/filters';
import { applyEffects, disposeEffects, effectNeedsNeighbourhood, effectReads, effectTdPreview, effectsAvailable, planChain } from '../../src/engine/effects';
import { allPremult, makeSurface, pm, run, straight, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const F = (type: string, params: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...params }) as unknown as Effect;
const W = 64;
const H = 48;
const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const patch = () => makeSurface(W, H, (x, y): Px => (x >= 24 && x < 40 && y >= 16 && y < 32 ? [255, 0, 0, 255] : [0, 0, 0, 0]));

if (!effectsAvailable()) console.warn('[effects tests] WebGL2 unavailable: filters core tests are SKIPPED');

describe.skipIf(!effectsAvailable())('filters core (WebGL2 preview)', () => {
  it('blur: radius 0 is a no-op (no passes), alpha mass is conserved away from the border, symmetric', () => {
    expect(planChain([F('blur', { radius: 0 })])).toHaveLength(0);
    const { out } = run(patch(), [F('blur', { radius: 5 })]);
    const a = allPremult(out);
    let mass = 0;
    for (let i = 0; i < W * H; i++) mass += a[i * 4 + 3];
    near(mass / 255, 16 * 16, 4);
    near(pm(out, 23, 24)[3], pm(out, 40, 24)[3], 2); // mirror symmetric about the patch centre (x = 32)
    near(pm(out, 32, 15)[3], pm(out, 32, 32)[3], 2);
    expect(pm(out, 32, 24)[3]).toBeGreaterThan(200);
    expect(pm(out, 5, 5)[3]).toBe(0);
  });

  it('blur threshold only blurs the bright part', () => {
    const img = makeSurface(W, H, (x): Px => (x < 32 ? [40, 40, 40, 255] : [250, 250, 250, 255]));
    const { out } = run(img, [F('blur', { radius: 4, threshold: 0.5, knee: 0.1 })]);
    expect(pm(out, 8, 24)[0]).toBeLessThan(2); // dark half contributes nothing
    expect(pm(out, 52, 24)[0]).toBeGreaterThan(200);
    expect(pm(out, 30, 24)[0]).toBeLessThan(pm(out, 40, 24)[0]);
  });

  it('unsharp / high-pass: neutral settings, flat areas, edge overshoot', () => {
    expect(planChain([F('unsharp', { amount: 0, radius: 3 })])).toHaveLength(0);
    const step = makeSurface(W, H, (x): Px => (x < 32 ? [100, 100, 100, 255] : [160, 160, 160, 255]));
    const { out } = run(step, [F('unsharp', { amount: 200, radius: 3, threshold: 0 })]);
    expect(pm(out, 31, 24)[0]).toBeLessThan(100); // undershoot on the dark side of the edge
    expect(pm(out, 32, 24)[0]).toBeGreaterThan(160);
    near(pm(out, 4, 24)[0], 100, 1);
    near(pm(out, 60, 24)[0], 160, 1);
    const hp = run(step, [F('highPass', { radius: 4 })]).out;
    near(pm(hp, 4, 24)[0], 128, 2); // flat -> mid grey
    near(pm(hp, 60, 24)[0], 128, 2);
    expect(pm(hp, 33, 24)[0]).toBeGreaterThan(128);
    expect(pm(hp, 30, 24)[0]).toBeLessThan(128);
    near(pm(run(step, [F('highPass', { radius: 0 })]).out, 20, 20)[0], 128, 1);
  });

  it('threshold of unsharp keeps small differences', () => {
    const faint = makeSurface(W, H, (x): Px => (x < 32 ? [100, 100, 100, 255] : [104, 104, 104, 255]));
    const { out } = run(faint, [F('unsharp', { amount: 500, radius: 3, threshold: 20 })]);
    near(pm(out, 31, 24)[0], 100, 1);
    near(pm(out, 32, 24)[0], 104, 1);
  });

  it('posterize: levels, endpoints, alpha', () => {
    const ramp = makeSurface(W, H, (x): Px => [Math.floor((x / (W - 1)) * 255), 0, 0, 255]);
    const two = run(ramp, [F('posterize', { levels: 2 })]).out;
    expect(straight(two, 3, 5)[0]).toBe(0);
    expect(straight(two, 60, 5)[0]).toBe(255);
    const four = run(ramp, [F('posterize', { levels: 4 })]).out;
    const vals = new Set<number>();
    for (let x = 0; x < W; x++) vals.add(straight(four, x, 5)[0]);
    expect([...vals].sort((a, b) => a - b)).toEqual([0, 85, 170, 255]);
    const half = makeSurface(W, H, (): Px => [200, 100, 50, 128]);
    near(straight(run(half, [F('posterize', { levels: 2 })]).out, 1, 1)[3], 128, 0);
  });

  it('curves: identity, invert, per-channel, interpolation passes through the control points', () => {
    const g = makeSurface(W, H, (x): Px => [x * 4, x * 4, x * 4, 255]);
    const id = run(g, [F('curves')]).out;
    for (const x of [0, 13, 40, 63]) near(straight(id, x, 3)[0], x * 4, 1);
    const inv = run(g, [F('curves', { master: [[0, 1], [1, 0]] })]).out;
    near(straight(inv, 0, 3)[0], 255, 1);
    near(straight(inv, 25, 3)[0], 255 - 100, 2);
    const red = run(g, [F('curves', { red: [[0, 0], [0.5, 1], [1, 1]] })]).out;
    near(straight(red, 32, 3)[0], 255, 2); // x = 128 -> 0.5 -> 1
    near(straight(red, 32, 3)[1], 128, 1); // green untouched
    const pts = run(g, [F('curves', { master: [[0, 0], [0.25, 0.5], [1, 1]] })]).out;
    near(straight(pts, 16, 3)[0], 128, 3); // x = 64 -> 0.25 -> ~0.5
    near(straight(pts, 63, 3)[0], 254, 2); // flat-ish top: the curve is monotone and ends at 1
  });

  it('curves keeps alpha and works on translucent pixels (straight colour)', () => {
    const t = makeSurface(W, H, (): Px => [100, 100, 100, 128]);
    const { out } = run(t, [F('curves', { master: [[0, 1], [1, 0]] })]);
    const s = straight(out, 3, 3);
    near(s[3], 128, 0);
    near(s[0], 155, 2);
  });

  it('displace: zero strength is a no-op, noise is deterministic per seed, aux drives the shift', () => {
    expect(planChain([F('displace', { strengthX: 0, strengthY: 0 })])).toHaveLength(0);
    const src = patch();
    const fx = (seed: number) => F('displace', { source: 'noise', strengthX: 6, strengthY: 6, scale: 12, seed });
    const a = allPremult(run(src, [fx(1)]).out);
    const b = allPremult(run(src, [fx(1)]).out);
    const c = allPremult(run(src, [fx(2)]).out);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.some((v, i) => Math.abs(v - c[i]) > 2)).toBe(true);
    // aux image: constant 0.5 grey = no displacement (bilinear at pixel centres is exact)
    const neutral = makeSurface(W, H, (): Px => [128, 128, 128, 255]);
    const outN = createSurface(W, H, true);
    applyEffects(src, [F('displace', { source: 'aux', strengthX: 1, strengthY: 1 })], { x: 0, y: 0, w: W, h: H }, outN, neutral);
    const n = allPremult(outN);
    const s0 = allPremult(src);
    let worst = 0;
    for (let i = 0; i < n.length; i++) worst = Math.max(worst, Math.abs(n[i] - s0[i]));
    expect(worst).toBeLessThanOrEqual(3); // 128/255 is 0.002 off neutral: offset 0.008 px on a hard edge = 2 levels
    // aux red = 1 -> offset +strengthX: out(p) = in(p + 10): the patch (x 24..39) appears shifted LEFT by 10
    const right = makeSurface(W, H, (): Px => [255, 128, 128, 255]);
    const outR = createSurface(W, H, true);
    applyEffects(src, [F('displace', { source: 'aux', strengthX: 10, strengthY: 10 })], { x: 0, y: 0, w: W, h: H }, outR, right);
    expect(pm(outR, 16, 24)[3]).toBeGreaterThan(250); // x = 16 reads x = 26
    expect(pm(outR, 36, 24)[3]).toBe(0); // x = 36 reads x = 46
    // no aux supplied: the displace is a no-op
    const outM = createSurface(W, H, true);
    applyEffects(src, [F('displace', { source: 'aux', strengthX: 10, strengthY: 10 })], { x: 0, y: 0, w: W, h: H }, outM);
    expect(Array.from(allPremult(outM))).toEqual(Array.from(s0));
  });

  it('displace edge modes: transparent / clamp / wrap', () => {
    const edge = makeSurface(W, H, (x): Px => (x < 4 ? [255, 0, 0, 255] : x >= W - 4 ? [0, 0, 255, 255] : [0, 255, 0, 255]));
    const right = makeSurface(W, H, (): Px => [255, 128, 128, 255]);
    const go = (e: string) => {
      const o = createSurface(W, H, true);
      applyEffects(edge, [F('displace', { source: 'aux', strengthX: 8, strengthY: 8, edge: e })], { x: 0, y: 0, w: W, h: H }, o, right);
      return o;
    };
    expect(pm(go('transparent'), W - 2, 5)[3]).toBe(0); // reads beyond the right border
    expect(straight(go('clamp'), W - 2, 5)).toEqual([0, 0, 255, 255]);
    expect(straight(go('wrap'), 57, 5)[0]).toBeGreaterThan(200); // x = 57 reads 65 -> wraps to x = 1, the red left border
  });

  it('adjustment-layer usage: the filter runs on the composite below (a plain document sized surface)', () => {
    const below = makeSurface(W, H, (x): Px => [x * 4, 100, 50, 255]);
    const { out } = run(below, [F('curves', { master: [[0, 1], [1, 0]] })]);
    near(straight(out, 10, 5)[0], 255 - 40, 2);
    near(straight(out, 10, 5)[2], 205, 2);
  });

  it('planner flags: reads / neighbourhood / tdPreview', () => {
    expect(effectNeedsNeighbourhood(F('posterize'))).toBe(false);
    expect(effectReads(F('curves'))).toBe('point');
    expect(effectNeedsNeighbourhood(F('blur', { radius: 5 }))).toBe(true);
    expect(effectReads(F('blur', { radius: 0 }))).toBe('none');
    expect(effectReads(F('displace', { strengthX: 3, strengthY: 3 }))).toBe('neighbourhood');
    expect(effectReads(F('displace', { strengthX: 3, strengthY: 3, edge: 'wrap' }))).toBe('global');
    expect(effectTdPreview(F('blur', { radius: 5 }))).toBe(false);
    expect(effectTdPreview(F('pixelSort', { direction: 'h', low: 0, high: 1, key: 'luma' }))).toBe(true); // hue / luma key ties differ across GPUs
    for (const sp of Object.values(FILTER_SPECS)) expect(['point', 'neighbourhood', 'global']).toContain(sp.reads);
    expect(Object.keys(FILTER_SPECS).length).toBeGreaterThan(5);
  });
});

describe('tdPreview flag mechanism', () => {
  it('constant or expression, only when something is drawn', () => {
    const specs = FILTER_SPECS as Record<string, unknown>;
    specs._tdp = { type: '_tdp', glsl: false, reads: 'point', tdPreview: 'mode == 1', params: { mode: { kind: 'num', default: 0, min: 0, max: 1 } }, passes: [{ shader: 'posterize', pass: 0, u: ['2'] }] };
    specs._tdq = { type: '_tdq', glsl: false, reads: 'point', tdPreview: true, passes: [{ shader: 'posterize', pass: 0, u: ['2'] }] };
    try {
      expect(effectTdPreview(F('_tdp', { mode: 0 }))).toBe(false);
      expect(effectTdPreview(F('_tdp', { mode: 1 }))).toBe(true);
      expect(effectTdPreview(F('_tdq'))).toBe(true);
      expect(effectTdPreview(F('_tdq', { enabled: false }))).toBe(false);
    } finally {
      delete specs._tdp;
      delete specs._tdq;
    }
  });
});

describe.skipIf(!effectsAvailable())('review regressions', () => {
  it('innerGlow hugs all four borders alike, sizes 16 (exact path) and 17 (pyramid) agree', () => {
    const full = makeSurface(96, 80, (): Px => [200, 100, 50, 255]); // content touches all four borders
    const glow = (size: number) => run(full, [F('innerGlow', { size, color: { r: 0, g: 0, b: 255, a: 255 }, opacity: 1 })]).out;
    for (const size of [16, 17, 33]) {
      const o = glow(size);
      const left = pm(o, 0, 40)[2];
      const right = pm(o, 95, 40)[2];
      const top = pm(o, 48, 0)[2];
      const bottom = pm(o, 48, 79)[2];
      expect(left).toBeGreaterThan(150);
      for (const v of [right, top, bottom]) near(v, left, 8);
    }
    const a = allPremult(glow(16));
    const b = allPremult(glow(17));
    let mx = 0;
    for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
    expect(mx).toBeLessThanOrEqual(12);
  });

  for (const type of ['displace', 'twirl']) {
    for (const edge of ['clamp', 'mirror', 'wrap']) {
      it(`${type} edge '${edge}' keeps an opaque image opaque (no transparency leaks at the seams)`, () => {
        const img = makeSurface(W, H, (x, y): Px => [x * 3, y * 4, 90, 255]);
        const aux = makeSurface(W, H, (x): Px => [x % 2 ? 255 : 0, 255, 128, 255]);
        const fx = type === 'displace' ? F('displace', { source: 'aux', strengthX: 9, strengthY: 9, edge }) : F('twirl', { angle: 90, radius: 4000, edge });
        const out = createSurface(W, H, true);
        applyEffects(img, [fx], { x: 0, y: 0, w: W, h: H }, out, aux);
        const d = allPremult(out);
        let minA = 255;
        for (let i = 0; i < W * H; i++) minA = Math.min(minA, d[i * 4 + 3]);
        expect(minA).toBe(255);
      });
    }
  }
});

describe('parseCube rules (same as effects.py parse_cube)', () => {
  const body = '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  it('BOM, CRLF, LUT_3D_INPUT_RANGE, ascii numbers only, size caps', () => {
    expect(parseCube('\ufeffLUT_3D_SIZE 2\r\n' + body.replace(/\n/g, '\r\n'))?.size).toBe(2);
    const r = parseCube('LUT_3D_INPUT_RANGE -1 2\nLUT_3D_SIZE 2\n' + body)!;
    expect([r.dmin[0], r.dmax[2]]).toEqual([-1, 2]);
    expect(parseCube('LUT_3D_SIZE 2\n' + body.replace('1 1 1', 'nan 1 1'))).toBeNull();
    expect(parseCube('LUT_3D_SIZE 2\n' + body.replace('1 1 1', '1_0 1 1'))).toBeNull();
    expect(parseCube('LUT_3D_SIZE \u0662\n' + body)).toBeNull();
    expect(parseCube('LUT_3D_SIZE 65\n' + '0 0 0\n'.repeat(10))).toBeNull();
    expect(parseCube('x'.repeat(CUBE_MAX_CHARS + 1))).toBeNull();
    expect(parseCube('LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(64 ** 3 + 5))).toBeNull(); // stops early beyond 64^3 values
  });
});
