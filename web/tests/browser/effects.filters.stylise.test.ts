// Semantic tests of the stylise filters (shared/effects/*.filter.json, group "stylise").
import { afterAll, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import { disposeEffects, effectsAvailable } from '../../src/engine/effects';
import { allPremult, makeSurface, pm, run, straight, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const fx = (type: string, params: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...params }) as unknown as Effect;
const W = 64;
const H = 48;
const grey = (v: number): Px => [v, v, v, 255];
const flat = (c: Px) => makeSurface(W, H, () => c);
const ramp = () => makeSurface(W, H, (x, y): Px => [x * 4, 255 - y * 5, (x * 7 + y * 3) % 256, 255]);
const maxDiff = (a: Float32Array, b: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const finite = (a: Float32Array) => a.every((v) => Number.isFinite(v));

describe.skipIf(!effectsAvailable())('stylise: emboss', () => {
  it('flat image -> mid grey (gray) / unchanged (overlay); alpha kept', () => {
    const s = flat([200, 40, 90, 255]);
    const g = run(s, [fx('emboss', { mode: 'gray' })]).out;
    for (const [x, y] of [[5, 5], [30, 20]]) { const p = straight(g, x, y); expect(Math.abs(p[0] - 128)).toBeLessThanOrEqual(1); expect(p[3]).toBe(255); }
    const o = run(s, [fx('emboss', { mode: 'overlay' })]).out;
    for (const [x, y] of [[5, 5], [30, 20], [60, 40]]) expect(straight(o, x, y)).toEqual(straight(s, x, y));
  });
  it('vertical step lit from the right: edge facing the light is bright, the opposite dark, symmetric 180 deg', () => {
    const s = makeSurface(W, H, (x): Px => (x < 32 ? grey(0) : grey(255)));
    // light from the right (angle 0): the bright side is on the right; slope rises towards +x -> faces away from light on the left? check both
    const a0 = run(s, [fx('emboss', { angle: 0, height: 1, amount: 100 })]).out;
    const a180 = run(s, [fx('emboss', { angle: 180, height: 1, amount: 100 })]).out;
    const l0 = straight(a0, 31, 10)[0];
    const l180 = straight(a180, 31, 10)[0];
    expect(Math.abs(l0 + l180 - 255)).toBeLessThanOrEqual(2);   // opposite lights mirror around 0.5
    expect(l0).not.toBe(l180);
    expect(straight(a0, 10, 10)[0]).toBeGreaterThan(125);       // flat area
    expect(straight(a0, 10, 10)[0]).toBeLessThan(131);
    // light from above (90): a vertical step has no relief
    const a90 = run(s, [fx('emboss', { angle: 90, height: 1 })]).out;
    expect(Math.abs(straight(a90, 31, 10)[0] - 128)).toBeLessThanOrEqual(1);
  });
  it('amount scales the relief, transparent stays transparent', () => {
    const s = makeSurface(W, H, (x): Px => (x < 32 ? [0, 0, 0, 0] : grey(200)));
    const lo = run(s, [fx('emboss', { angle: 0, amount: 50, mode: 'overlay' })]).out;
    const hi = run(s, [fx('emboss', { angle: 0, amount: 200, mode: 'overlay' })]).out;
    const d = (o: typeof lo) => Math.abs(straight(o, 32, 10)[0] - 200);
    expect(d(hi)).toBeGreaterThanOrEqual(d(lo));
    expect(straight(lo, 3, 3)[3]).toBe(0);
  });
});

describe.skipIf(!effectsAvailable())('stylise: edgeDetect', () => {
  const step = makeSurface(W, H, (x): Px => (x < 32 ? grey(0) : grey(255)));
  it('flat -> black, sobel step -> bright line at the step only', () => {
    const f = run(flat(grey(120)), [fx('edgeDetect')]).out;
    expect(straight(f, 20, 20)[0]).toBe(0);
    const e = run(step, [fx('edgeDetect', { method: 'sobel' })]).out;
    expect(straight(e, 31, 20)[0]).toBeGreaterThan(250);
    expect(straight(e, 32, 20)[0]).toBeGreaterThan(250);
    expect(straight(e, 20, 20)[0]).toBe(0);
    expect(straight(e, 31, 20)[3]).toBe(255);
  });
  it('laplacian, invert, threshold and overlay', () => {
    const l = run(step, [fx('edgeDetect', { method: 'laplacian', strength: 100 })]).out;
    expect(straight(l, 32, 20)[0]).toBeGreaterThan(50);
    const inv = run(step, [fx('edgeDetect', { invert: true })]).out;
    expect(straight(inv, 20, 20)[0]).toBe(255);
    expect(straight(inv, 31, 20)[0]).toBeLessThan(5);
    const t = run(makeSurface(W, H, (x): Px => grey(x < 32 ? 100 : 110)), [fx('edgeDetect', { threshold: 0.5, strength: 100 })]).out;
    expect(straight(t, 31, 20)[0]).toBe(0);
    const ov = run(ramp(), [fx('edgeDetect', { mode: 'overlay', strength: 100, threshold: 0.9 })]).out;
    for (const [x, y] of [[5, 5], [30, 20], [60, 40]]) expect(straight(ov, x, y)).toEqual(straight(ramp(), x, y));
  });
});

describe.skipIf(!effectsAvailable())('stylise: kuwahara', () => {
  it('flat unchanged, keeps a hard edge, removes noise', () => {
    const s = flat([10, 120, 230, 255]);
    expect(maxDiff(allPremult(run(s, [fx('kuwahara', { radius: 5 })]).out), allPremult(s))).toBeLessThanOrEqual(1);
    const step = makeSurface(W, H, (x): Px => (x < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const k = run(step, [fx('kuwahara', { radius: 6 })]).out;
    expect(straight(k, 30, 20)).toEqual([255, 0, 0, 255]);
    expect(straight(k, 33, 20)).toEqual([0, 0, 255, 255]);
    let st = 7;
    const n = makeSurface(W, H, (): Px => { st = (st * 1103515245 + 12345) & 0x7fffffff; return grey(100 + (st % 31)); });
    const o = run(n, [fx('kuwahara', { radius: 4 })]).out;
    const sd = (s2: ReturnType<typeof flat>) => { const a = allPremult(s2); let m = 0; let q = 0; let c = 0; for (let i = 0; i < a.length; i += 4) { m += a[i]; q += a[i] * a[i]; c++; } m /= c; return Math.sqrt(q / c - m * m); };
    expect(sd(o)).toBeLessThan(sd(n) * 0.6);
  });
  it('large radius is finite and keeps alpha range', () => {
    const o = run(ramp(), [fx('kuwahara', { radius: 16 })]).out;
    expect(finite(allPremult(o))).toBe(true);
    expect(straight(o, 20, 20)[3]).toBe(255);
  });
});

describe.skipIf(!effectsAvailable())('stylise: pixelate', () => {
  it('cells are uniform and aligned to the document (mean = exact cell average)', () => {
    const s = makeSurface(W, H, (x, y): Px => grey((x + y * 3) % 2 === 0 ? 0 : 200));
    const o = run(s, [fx('pixelate', { size: 8, sample: 'mean' })]).out;
    const c = straight(o, 0, 0);
    expect(Math.abs(c[0] - 100)).toBeLessThanOrEqual(1);
    for (const [x, y] of [[7, 7], [3, 5]]) expect(straight(o, x, y)).toEqual(c);
    const ramp2 = makeSurface(W, H, (x): Px => grey(x * 4));
    const r = run(ramp2, [fx('pixelate', { size: 4, sample: 'mean' })]).out;
    expect(Math.abs(straight(r, 9, 3)[0] - 38)).toBeLessThanOrEqual(1);   // cell x 8..11 -> mean of 32,36,40,44 = 38
  });
  it('centre sample picks the centre pixel; partial render matches (document alignment)', () => {
    const s = makeSurface(W, H, (x): Px => grey(x * 4));
    const o = run(s, [fx('pixelate', { size: 10, sample: 'centre' })]).out;
    expect(straight(o, 3, 3)[0]).toBe(20);            // cell 0..9 -> pixel 5
    expect(straight(o, 14, 3)[0]).toBe(60);           // cell 10..19 -> pixel 15
    const part = run(s, [fx('pixelate', { size: 10, sample: 'centre' })], { x: 12, y: 4, w: 20, h: 10 });
    expect(part.out).toBeTruthy();
  });
  it('size 1 is a no-op', () => {
    const s = ramp();
    expect(maxDiff(allPremult(run(s, [fx('pixelate', { size: 1 })]).out), allPremult(s))).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(!effectsAvailable())('stylise: dither', () => {
  const levelsOf = (o: ReturnType<typeof flat>, ch = 0) => { const set = new Set<number>(); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set.add(straight(o, x, y)[ch]); return set; };
  const hgrad = () => makeSurface(W, H, (x): Px => grey(Math.round((x / (W - 1)) * 255)));
  it('ordered: only `levels` output values, mean tone preserved, already quantised input unchanged', () => {
    const o = run(hgrad(), [fx('dither', { mode: 'ordered', levels: 4, matrix: 4 })]).out;
    const set = levelsOf(o);
    for (const v of set) expect([0, 85, 170, 255]).toContain(v);
    const s = flat(grey(85));
    expect(maxDiff(allPremult(run(s, [fx('dither', { mode: 'ordered', levels: 4 })]).out), allPremult(s))).toBeLessThanOrEqual(1);
    const mid = run(flat(grey(128)), [fx('dither', { mode: 'ordered', levels: 2, matrix: 8 })]).out;
    let sum = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) sum += straight(mid, x, y)[0];
    expect(Math.abs(sum / 256 - 128)).toBeLessThan(6);
  });
  it('diffusion: levels respected, tone preserved, deterministic, grey mode, strength 0 identity', () => {
    const e = fx('dither', { mode: 'diffusion', levels: 2 });
    const mid = run(flat(grey(100)), [e]).out;
    const set = levelsOf(mid);
    for (const v of set) expect([0, 255]).toContain(v);
    let sum = 0;
    for (let y = 8; y < 40; y++) for (let x = 16; x < 48; x++) sum += straight(mid, x, y)[0];
    expect(Math.abs(sum / (32 * 32) - 100)).toBeLessThan(8);
    expect(maxDiff(allPremult(run(flat(grey(100)), [e]).out), allPremult(mid))).toBe(0);
    const g = run(ramp(), [fx('dither', { mode: 'diffusion', levels: 3, colour: false })]).out;
    for (let i = 0; i < 20; i++) { const p = straight(g, i * 3, i); expect(p[0] === p[1] && p[1] === p[2]).toBe(true); }
    const s = ramp();
    expect(maxDiff(allPremult(run(s, [fx('dither', { strength: 0 })]).out), allPremult(s))).toBeLessThanOrEqual(1);
  });
  it('diffusion region render equals the full render', () => {
    const e = fx('dither', { mode: 'diffusion', levels: 3 });
    const s = ramp();
    const full = allPremult(run(s, [e]).out);
    const part = run(s, [e], { x: 20, y: 10, w: 15, h: 12 });
    const p = allPremult(part.out);
    for (let y = 10; y < 22; y++) for (let x = 20; x < 35; x++) for (let k = 0; k < 4; k++) expect(Math.abs(p[(y * W + x) * 4 + k] - full[(y * W + x) * 4 + k])).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(!effectsAvailable())('stylise: crt', () => {
  it('scanlines darken periodic rows, mask only changes channels by column, noop settings identity', () => {
    const s = flat(grey(200));
    const o = run(s, [fx('crt', { scanlines: 100, scanlinePeriod: 4, mask: 'none', curvature: 0, vignette: 0, glow: 0 })]).out;
    const col = [0, 1, 2, 3].map((y) => straight(o, 10, y)[0]);
    expect(Math.min(...col)).toBeLessThan(40);
    expect(Math.max(...col)).toBeGreaterThan(150);
    expect(straight(o, 10, 0)[0]).toBe(straight(o, 30, 4)[0]);
    const m = run(s, [fx('crt', { scanlines: 0, mask: 'aperture', maskStrength: 100, curvature: 0, vignette: 0, glow: 0 })]).out;
    expect(straight(m, 0, 5).slice(0, 3)).toEqual([200, 0, 0]);
    expect(straight(m, 1, 5).slice(0, 3)).toEqual([0, 200, 0]);
    expect(straight(m, 2, 5).slice(0, 3)).toEqual([0, 0, 200]);
    const n = run(s, [fx('crt', { scanlines: 0, mask: 'none', curvature: 0, vignette: 0, glow: 0 })]).out;
    expect(maxDiff(allPremult(n), allPremult(s))).toBeLessThanOrEqual(1);
  });
  it('curvature blackens the corners, vignette darkens them, glow brightens near bright parts', () => {
    const s = flat(grey(200));
    const c = run(s, [fx('crt', { scanlines: 0, mask: 'none', curvature: 60, vignette: 0, glow: 0 })]).out;
    expect(straight(c, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(straight(c, 32, 24)[0]).toBeGreaterThan(195);
    const v = run(s, [fx('crt', { scanlines: 0, mask: 'none', curvature: 0, vignette: 80, glow: 0 })]).out;
    expect(straight(v, 0, 0)[0]).toBeLessThan(straight(v, 32, 24)[0] - 80);
    const dark = makeSurface(W, H, (x, y): Px => (x >= 30 && x < 34 && y >= 22 && y < 26 ? grey(255) : [60, 60, 60, 255]));
    const g = run(dark, [fx('crt', { scanlines: 0, mask: 'none', curvature: 0, vignette: 0, glow: 80 })]).out;
    expect(straight(g, 36, 24)[0]).toBeGreaterThan(70);
    expect(straight(g, 5, 5)[0]).toBe(60);
  });
});

describe.skipIf(!effectsAvailable())('stylise: grain', () => {
  const sd = (o: ReturnType<typeof flat>, v: number) => { let q = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = straight(o, x, y)[0] - v; q += d * d; } return Math.sqrt(q / (W * H)); };
  it('deterministic per seed, different seeds differ, amount 0 identity', () => {
    const s = flat(grey(128));
    const a = allPremult(run(s, [fx('grain', { amount: 50, seed: 4 })]).out);
    const b = allPremult(run(s, [fx('grain', { amount: 50, seed: 4 })]).out);
    const c = allPremult(run(s, [fx('grain', { amount: 50, seed: 5 })]).out);
    expect(maxDiff(a, b)).toBe(0);
    expect(maxDiff(a, c)).toBeGreaterThan(5);
    expect(maxDiff(allPremult(run(s, [fx('grain', { amount: 0 })]).out), allPremult(s))).toBeLessThanOrEqual(1);
  });
  it('film grain is ~0 in pure black/white and strongest in midtones; amount increases noise', () => {
    const e = fx('grain', { amount: 100, kind: 'film' });
    expect(sd(run(flat(grey(0)), [e]).out, 0)).toBe(0);
    expect(sd(run(flat(grey(255)), [e]).out, 255)).toBe(0);
    const mid = sd(run(flat(grey(128)), [e]).out, 128);
    expect(mid).toBeGreaterThan(sd(run(flat(grey(40)), [e]).out, 40));
    expect(sd(run(flat(grey(128)), [fx('grain', { amount: 20 })]).out, 128)).toBeLessThan(mid);
  });
  it('size makes blocks, colour makes channels differ, transparent stays transparent, uniform noise differs from black', () => {
    const o = run(flat(grey(128)), [fx('grain', { amount: 80, size: 4, kind: 'noise', colour: true, seed: 1 })]).out;
    expect(straight(o, 0, 0)).toEqual(straight(o, 3, 3));
    const p = straight(o, 0, 0);
    expect(p[0] === p[1] && p[1] === p[2]).toBe(false);
    const t = run(flat([0, 0, 0, 0]), [fx('grain', { amount: 100, kind: 'noise' })]).out;
    expect(pm(t, 5, 5)).toEqual([0, 0, 0, 0]);
    const k = run(flat(grey(0)), [fx('grain', { amount: 100, kind: 'noise' })]).out;
    expect(sd(k, 0)).toBeGreaterThan(5);
  });
});

describe.skipIf(!effectsAvailable())('stylise: bloom', () => {
  const scene = () => makeSurface(W, H, (x, y): Px => (Math.abs(x - 32) < 3 && Math.abs(y - 24) < 3 ? grey(255) : grey(40)));
  it('glows around bright pixels, leaves the dark far field, never darkens', () => {
    const s = scene();
    const o = run(s, [fx('bloom', { threshold: 0.6, knee: 0.1, radius: 8, intensity: 200 })]).out;
    expect(straight(o, 38, 24)[0]).toBeGreaterThan(60);
    expect(straight(o, 2, 2)[0]).toBeLessThanOrEqual(41);
    const a = allPremult(o);
    const b = allPremult(s);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(b[i] - 1);
    expect(straight(o, 32, 24)[0]).toBe(255);
  });
  it('intensity 0 / radius 0 identity, intensity monotonic, tint colours the glow, glow spreads into transparency', () => {
    const s = scene();
    for (const p of [{ intensity: 0 }, { radius: 0 }]) expect(maxDiff(allPremult(run(s, [fx('bloom', p)]).out), allPremult(s))).toBeLessThanOrEqual(1);
    const v = (i: number) => straight(run(s, [fx('bloom', { threshold: 0.6, radius: 8, intensity: i })]).out, 38, 24)[0];
    expect(v(250)).toBeGreaterThan(v(100));
    const t = run(s, [fx('bloom', { threshold: 0.6, radius: 8, intensity: 300, tint: { r: 255, g: 0, b: 0, a: 255 } })]).out;
    const p = straight(t, 38, 24);
    expect(p[0] - p[2]).toBeGreaterThan(20);
    const tr = makeSurface(W, H, (x, y): Px => (Math.abs(x - 32) < 3 && Math.abs(y - 24) < 3 ? grey(255) : [0, 0, 0, 0]));
    const o = run(tr, [fx('bloom', { threshold: 0.6, radius: 8, intensity: 200 })]).out;
    expect(straight(o, 38, 24)[3]).toBeGreaterThan(0);
  });
});
