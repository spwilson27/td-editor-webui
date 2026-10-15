import { afterAll, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import { disposeEffects, effectsAvailable } from '../../src/engine/effects';
import { allPremult, makeSurface, pm, run, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const W = 64;
const H = 48;
const fx = (o: Record<string, unknown>) => ({ enabled: true, ...o }) as unknown as Effect;
const grad = () => makeSurface(W, H, (x, y) => [Math.round((x / (W - 1)) * 255), Math.round((y / (H - 1)) * 255), 90, 255]);
const halves = () => makeSurface(W, H, (x): Px => (x < W / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
const maxDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe.skipIf(!effectsAvailable())('distort filters (WebGL2 preview)', () => {
  it('identity parameter sets reproduce the input', () => {
    const src = grad();
    const ref = allPremult(src);
    const ids = [
      { type: 'twirl', angle: 0 },
      { type: 'ripple', amplitude: 0 },
      { type: 'lensDistortion', k1: 0, k2: 0, scale: 100 },
      { type: 'tileMirror', tilesX: 1, tilesY: 1 },
    ];
    for (const id of ids) expect(maxDiff(allPremult(run(src, [fx(id)]).out), ref)).toBeLessThanOrEqual(1);
    // non-noop but numerically neutral: twirl with a tiny angle, lens with tiny k
    expect(maxDiff(allPremult(run(src, [fx({ type: 'twirl', angle: 0.01, radius: 1 })]).out), ref)).toBeLessThanOrEqual(2);
  });

  it('twirl: centre pixel fixed, a point inside the radius rotates clockwise, outside radius untouched', () => {
    const src = grad();
    const out = run(src, [fx({ type: 'twirl', angle: 180, radius: 20, edge: 'clamp' })]).out;
    // outside radius: identical
    expect(pm(out, 2, 2)).toEqual(pm(src, 2, 2));
    // near the centre the 180 degree turn swaps left/right of the centre: pixel (W/2+3) takes the colour of ~ (W/2-3)
    const l = pm(src, W / 2 - 4, H / 2)[0];
    const r = pm(src, W / 2 + 3, H / 2)[0];
    const o = pm(out, W / 2 + 3, H / 2)[0];
    expect(r).toBeGreaterThan(l);
    expect(o).toBeLessThan(r);
  });

  it('ripple: wave with amplitude displaces rows, ripple keeps the centre', () => {
    const src = grad();
    const w = run(src, [fx({ type: 'ripple', kind: 'wave', amplitude: 5, wavelength: 32, angle: 0, edge: 'clamp' })]).out;
    // angle 0: displacement is vertical, so the red (x) channel of a row is unchanged
    expect(Math.abs(pm(w, 10, 20)[0] - pm(src, 10, 20)[0])).toBeLessThanOrEqual(2);
    expect(maxDiff(allPremult(w), allPremult(src))).toBeGreaterThan(8);
    const rp = run(src, [fx({ type: 'ripple', kind: 'ripple', amplitude: 6, wavelength: 20, edge: 'clamp' })]).out;
    expect(Math.abs(pm(rp, W / 2, H / 2)[0] - pm(src, W / 2, H / 2)[0])).toBeLessThanOrEqual(12);
  });

  it('lens distortion: barrel pulls the centre content outwards, k=0 keeps the centre', () => {
    const src = grad();
    const out = run(src, [fx({ type: 'lensDistortion', k1: 60, edge: 'clamp' })]).out;
    // centre unchanged
    expect(Math.abs(pm(out, W / 2, H / 2)[0] - pm(src, W / 2, H / 2)[0])).toBeLessThanOrEqual(5);
    // barrel (inverse: sample further out): the right half reads larger x than the pixel itself
    expect(pm(out, 50, H / 2)[0]).toBeGreaterThan(pm(src, 50, H / 2)[0]);
    expect(pm(out, 14, H / 2)[0]).toBeLessThan(pm(src, 14, H / 2)[0]);
    // zoom in by 200 % with k=0: pixel at the centre column + 8 reads centre + 4
    const z = run(src, [fx({ type: 'lensDistortion', k1: 0, k2: 0, scale: 200 })]).out;
    expect(Math.abs(pm(z, W / 2 + 8, H / 2)[0] - pm(src, W / 2 + 4, H / 2)[0])).toBeLessThanOrEqual(4);
  });

  it('polar: round trip rectToPolar -> polarToRect approximates the identity inside the disc', () => {
    const src = makeSurface(128, 96, (x, y) => [Math.round((x / 127) * 255), Math.round((y / 95) * 255), 0, 255]);
    const out = run(src, [fx({ type: 'polar', mode: 'rectToPolar', edge: 'clamp' }), fx({ type: 'polar', mode: 'polarToRect', edge: 'clamp' })]).out;
    // away from the x seam and the very top (pole), compare
    let worst = 0;
    for (const [x, y] of [[30, 30], [64, 50], [90, 40], [40, 60], [100, 70], [20, 80]]) {
      const a = pm(out, x, y);
      const b = pm(src, x, y);
      worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
    expect(worst).toBeLessThan(22);
    // rectToPolar: top row at the centre, so the centre pixel shows the top row colour (g ~ 0)
    const p = run(src, [fx({ type: 'polar', mode: 'rectToPolar', edge: 'clamp' })]).out;
    expect(pm(p, 64, 48)[1]).toBeLessThan(10);
    expect(pm(p, 64, 8)[1]).toBeGreaterThan(pm(p, 64, 30)[1]); // moving away from the centre samples lower rows
  });

  it('kaleidoscope: segments=2 gives mirror symmetry about the centre lines', () => {
    const src = makeSurface(W, H, (x, y): Px => [x * 4, y * 5, (x * 7 + y * 3) % 256, 255]);
    const out = run(src, [fx({ type: 'kaleidoscope', segments: 2, angle: 0, edge: 'clamp' })]).out;
    // mirror about the horizontal centre line (pixel centres: y and H-1-y), and the vertical one
    for (const [x, y] of [[40, 30], [50, 10], [33, 27]]) {
      const a = pm(out, x, y);
      const b = pm(out, x, H - 1 - y);
      const c = pm(out, W - 1 - x, y);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(12);
        expect(Math.abs(a[k] - c[k])).toBeLessThanOrEqual(12);
      }
    }
  });

  it('tileMirror 2x1: the full image appears in each half; mirror flips the second', () => {
    const src = halves();
    const plain = run(src, [fx({ type: 'tileMirror', tilesX: 2, tilesY: 1, mirror: false })]).out;
    expect(pm(plain, 8, 20)[0]).toBeGreaterThan(240); // tile 0: red then blue
    expect(pm(plain, 24, 20)[2]).toBeGreaterThan(240);
    expect(pm(plain, 40, 20)[0]).toBeGreaterThan(240); // tile 1 starts red again
    expect(pm(plain, 56, 20)[2]).toBeGreaterThan(240);
    const mir = run(src, [fx({ type: 'tileMirror', tilesX: 2, tilesY: 1, mirror: true })]).out;
    expect(pm(mir, 8, 20)[0]).toBeGreaterThan(240);
    expect(pm(mir, 24, 20)[2]).toBeGreaterThan(240);
    expect(pm(mir, 40, 20)[2]).toBeGreaterThan(240); // flipped: blue first
    expect(pm(mir, 56, 20)[0]).toBeGreaterThan(240);
  });

  it('edge modes: transparent leaves holes, clamp does not; output stays finite for extreme parameters', () => {
    const src = grad();
    const t = run(src, [fx({ type: 'lensDistortion', k1: 0, k2: 0, scale: 50, edge: 'transparent' })]).out;
    const c = run(src, [fx({ type: 'lensDistortion', k1: 0, k2: 0, scale: 50, edge: 'clamp' })]).out;
    expect(pm(t, 1, 1)[3]).toBe(0);
    expect(pm(c, 1, 1)[3]).toBe(255);
    for (const e of [{ type: 'twirl', angle: 1e9, radius: 0 }, { type: 'kaleidoscope', segments: 1e9, zoom: 0 }, { type: 'tileMirror', tilesX: 0, tilesY: 1e9, rotation: 1e9 }]) {
      const o = allPremult(run(src, [fx(e)]).out);
      expect(o.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});
