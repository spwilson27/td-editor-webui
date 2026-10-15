// Colour grading filters: semantic tests (gradientMap, colorBalance, vibrance, channelMixer, selectiveColor, duotone, lut + parseCube).
import { afterAll, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import { disposeEffects, effectsAvailable, planChain } from '../../src/engine/effects';
import { cubeAtlas, parseCube } from '../../src/engine/effects/filters';
import { allPremult, makeSurface, run, straight, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const fx = (type: string, params: Record<string, unknown> = {}): Effect => ({ enabled: true, type, ...params }) as unknown as Effect;
const W = 64;
const H = 48;
/** one pixel colour everywhere (straight, opaque) */
const flat = (c: Px) => makeSurface(W, H, () => c);
const one = (c: Px, e: Effect): Px => straight(run(flat(c), [e]).out, 5, 5);
const near = (a: Px, b: Px, tol = 1.5) => a.forEach((v, i) => expect(Math.abs(v - b[i]), `${a} vs ${b}`).toBeLessThanOrEqual(tol));
const luma = (c: Px) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const rampImg = () => makeSurface(W, H, (x, y): Px => [Math.floor((x / W) * 255), Math.floor((y / H) * 255), (x * 7 + y * 13) % 256, x % 5 === 0 ? 128 : 255]);

describe.skipIf(!effectsAvailable())('colour filters: identity settings are no-ops', () => {
  const ids: [string, Record<string, unknown>][] = [
    ['gradientMap', { amount: 0 }], ['colorBalance', {}], ['vibrance', {}], ['channelMixer', {}], ['duotone', { amount: 0 }],
    ['lut', {}], ['lut', { cube: 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n', intensity: 0 }],
  ];
  for (const [t, p] of ids) {
    it(`${t} ${JSON.stringify(p).slice(0, 30)} plans no passes`, () => expect(planChain([fx(t, p)])).toHaveLength(0));
  }
  it('selectiveColor with all zeros leaves the image unchanged (+-1)', () => {
    const src = rampImg();
    const a = allPremult(src);
    const b = allPremult(run(src, [fx('selectiveColor', { adjust: new Array(36).fill(0) })]).out);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(1.01);
  });
});

describe.skipIf(!effectsAvailable())('gradientMap', () => {
  it('default black->white gives the Rec.709 luma grey', () => {
    for (const c of [[255, 0, 0, 255], [30, 200, 90, 255], [10, 20, 250, 255]] as Px[]) {
      const l = luma(c);
      near(one(c, fx('gradientMap')), [l, l, l, 255], 2);
    }
  });
  it('reverse inverts the luma; amount mixes with the original; alpha kept', () => {
    const c: Px = [200, 100, 50, 255];
    const l = 255 - luma(c);
    near(one(c, fx('gradientMap', { reverse: true })), [l, l, l, 255], 2);
    const half = one(c, fx('gradientMap', { amount: 50 }));
    near(half, [(c[0] + luma(c)) / 2, (c[1] + luma(c)) / 2, (c[2] + luma(c)) / 2, 255], 2);
    const s = makeSurface(W, H, () => [200, 100, 50, 128]);
    expect(straight(run(s, [fx('gradientMap')]).out, 3, 3)[3]).toBe(128);
  });
  it('colour stops map the extremes; stop alpha is ignored', () => {
    const stops = [{ pos: 0, color: { r: 255, g: 0, b: 0, a: 0 } }, { pos: 1, color: { r: 0, g: 0, b: 255, a: 10 } }];
    near(one([0, 0, 0, 255], fx('gradientMap', { stops })), [255, 0, 0, 255], 1);
    near(one([255, 255, 255, 255], fx('gradientMap', { stops })), [0, 0, 255, 255], 1);
  });
});

describe.skipIf(!effectsAvailable())('colorBalance', () => {
  it('positive red in the midtones raises red, lowers nothing else (no preserve)', () => {
    const o = one([128, 128, 128, 255], fx('colorBalance', { midtonesCyanRed: 100, preserveLuminosity: false }));
    near(o, [128 + 0.25 * 255 * 1.0, 128, 128, 255], 3); // wm ~= 0.5, shift 0.5 * wm = 0.25
    expect(o[0]).toBeGreaterThan(180);
  });
  it('shadows affect dark, not bright pixels; highlights the opposite', () => {
    const dark = one([20, 20, 20, 255], fx('colorBalance', { shadowsYellowBlue: 100, preserveLuminosity: false }));
    const bright = one([235, 235, 235, 255], fx('colorBalance', { shadowsYellowBlue: 100, preserveLuminosity: false }));
    expect(dark[2] - 20).toBeGreaterThan(90);
    expect(bright[2]).toBeLessThanOrEqual(238);
    const hi = one([235, 235, 235, 255], fx('colorBalance', { highlightsMagentaGreen: -100, preserveLuminosity: false }));
    expect(hi[1]).toBeLessThan(235 - 90);
  });
  it('preserveLuminosity keeps luma', () => {
    const c: Px = [100, 110, 120, 255];
    const o = one(c, fx('colorBalance', { midtonesCyanRed: 60, midtonesYellowBlue: -40, preserveLuminosity: true }));
    expect(Math.abs(luma(o) - luma(c))).toBeLessThan(2);
    expect(o[0]).toBeGreaterThan(c[0]);
  });
});

describe.skipIf(!effectsAvailable())('vibrance', () => {
  it('saturation -100 -> luma grey; +100 doubles distance from grey', () => {
    const c: Px = [180, 120, 100, 255];
    const l = luma(c);
    near(one(c, fx('vibrance', { saturation: -100 })), [l, l, l, 255], 1.5);
    near(one(c, fx('vibrance', { saturation: 100 })), [l + 2 * (180 - l), l + 2 * (120 - l), l + 2 * (100 - l), 255], 2);
  });
  it('vibrance boosts dull colours more than vivid ones; greys untouched', () => {
    const dull: Px = [140, 120, 110, 255];
    const vivid: Px = [250, 20, 10, 255];
    const dd = (c: Px) => Math.hypot(c[0] - luma(c), c[1] - luma(c), c[2] - luma(c));
    const dullRatio = dd(one(dull, fx('vibrance', { vibrance: 100 }))) / dd(dull);
    const vividRatio = dd(one(vivid, fx('vibrance', { vibrance: 100 }))) / dd(vivid);
    expect(dullRatio).toBeGreaterThan(1.5);
    expect(vividRatio).toBeLessThan(1.1);
    near(one([90, 90, 90, 255], fx('vibrance', { vibrance: 100, saturation: 100 })), [90, 90, 90, 255], 1);
  });
});

describe.skipIf(!effectsAvailable())('channelMixer', () => {
  it('swap red/blue rows', () => {
    near(one([200, 100, 30, 255], fx('channelMixer', { rr: 0, rb: 100, br: 100, bb: 0 })), [30, 100, 200, 255], 1);
  });
  it('constants, clamping and coefficients', () => {
    near(one([100, 100, 100, 255], fx('channelMixer', { r: 10, g: -10 })), [125.5, 74.5, 100, 255], 1.5);
    near(one([200, 0, 0, 255], fx('channelMixer', { rr: 200 })), [255, 0, 0, 255], 1);
    near(one([100, 100, 100, 255], fx('channelMixer', { rg: 50, gg: 0 })), [150, 0, 100, 255], 1.5);
  });
  it('monochrome uses the gray row (default 30/59/11)', () => {
    const c: Px = [200, 100, 50, 255];
    const g = 0.3 * 200 + 0.59 * 100 + 0.11 * 50;
    near(one(c, fx('channelMixer', { monochrome: true })), [g, g, g, 255], 1.5);
    near(one(c, fx('channelMixer', { monochrome: true, grayRed: 100, grayGreen: 0, grayBlue: 0 })), [200, 200, 200, 255], 1);
  });
});

describe.skipIf(!effectsAvailable())('selectiveColor', () => {
  const adj = (idx: number, v: number) => { const a = new Array(36).fill(0); a[idx] = v; return a; };
  it('reds cyan +100 absolute darkens the red channel of a pure red only', () => {
    const e = fx('selectiveColor', { adjust: adj(0, 1), relative: false });
    near(one([255, 0, 0, 255], e), [0, 0, 0, 255], 3);      // cyan ink 0 -> 1: red channel 0
    near(one([0, 0, 255, 255], e), [0, 0, 255, 255], 1);    // blue unaffected
    near(one([128, 128, 128, 255], e), [128, 128, 128, 255], 1);
  });
  it('relative method does nothing on an ink amount of 0, absolute does', () => {
    const rel = one([255, 0, 0, 255], fx('selectiveColor', { adjust: adj(0, 1), relative: true }));
    near(rel, [255, 0, 0, 255], 1);
    // yellow ink of pure yellow = 1: relative -50 % -> 0.5 -> blue channel 127.5 (absolute would do the same here, ink = 1)
    near(one([255, 255, 0, 255], fx('selectiveColor', { adjust: adj(6, -0.5), relative: true })), [255, 255, 127.5, 255], 3);
    // blue 128 -> chroma weight 0.5, yellow ink 0.5: ink' = 0.5 - 0.5 * 0.5 * 1 = 0.25 -> blue 191
    near(one([255, 255, 128, 255], fx('selectiveColor', { adjust: adj(6, -1), relative: true })), [255, 255, 191, 255], 3);
  });
  it('blacks black +100 darkens dark pixels, leaves bright', () => {
    const e = fx('selectiveColor', { adjust: adj(35, 1), relative: false });
    expect(one([10, 10, 10, 255], e)[0]).toBeLessThan(3);
    near(one([240, 240, 240, 255], e), [240, 240, 240, 255], 1);
    expect(one([60, 60, 60, 255], e)[0]).toBeLessThan(40);
  });
  it('whites cyan -100 absolute leaves colours alone, lifts nothing below 255 weight', () => {
    near(one([255, 0, 0, 255], fx('selectiveColor', { adjust: adj(24, 1), relative: false })), [255, 0, 0, 255], 1);
    expect(one([255, 255, 255, 255], fx('selectiveColor', { adjust: adj(24, 1), relative: false }))[0]).toBeLessThan(5);
  });
  it('alpha unchanged', () => {
    const s = makeSurface(W, H, () => [200, 60, 30, 100]);
    expect(straight(run(s, [fx('selectiveColor', { adjust: adj(0, 1), relative: false })]).out, 2, 2)[3]).toBe(100);
  });
});

describe.skipIf(!effectsAvailable())('duotone', () => {
  const sh = { r: 10, g: 20, b: 30, a: 0 };
  const hi = { r: 250, g: 200, b: 100, a: 0 };
  it('black -> shadow, white -> highlight, grey -> mix', () => {
    near(one([0, 0, 0, 255], fx('duotone', { shadow: sh, highlight: hi })), [10, 20, 30, 255], 1);
    near(one([255, 255, 255, 255], fx('duotone', { shadow: sh, highlight: hi })), [250, 200, 100, 255], 1);
    const t = 128 / 255;
    near(one([128, 128, 128, 255], fx('duotone', { shadow: sh, highlight: hi })), [10 + 240 * t, 20 + 180 * t, 30 + 70 * t, 255], 1.5);
  });
  it('three colours hit the midpoint colour at mid grey; contrast pushes values away', () => {
    const mid = { r: 200, g: 0, b: 0, a: 255 };
    near(one([127.5, 127.5, 127.5, 255], fx('duotone', { shadow: sh, highlight: hi, mid, useMid: true })), [200, 0, 0, 255], 4);
    const lo = one([100, 100, 100, 255], fx('duotone', { shadow: { r: 0, g: 0, b: 0, a: 255 }, highlight: { r: 255, g: 255, b: 255, a: 255 } }));
    const hc = one([100, 100, 100, 255], fx('duotone', { shadow: { r: 0, g: 0, b: 0, a: 255 }, highlight: { r: 255, g: 255, b: 255, a: 255 }, contrast: 100 }));
    expect(hc[0]).toBeLessThan(lo[0] - 20);
  });
  it('amount mixes with the original', () => {
    near(one([200, 200, 200, 255], fx('duotone', { shadow: { r: 0, g: 0, b: 0, a: 255 }, highlight: { r: 0, g: 0, b: 0, a: 255 }, amount: 50 })), [100, 100, 100, 255], 1.5);
  });
});

/** identity (or per-node function) .cube of size n, red fastest */
function cubeText(n: number, f: (r: number, g: number, b: number) => [number, number, number] = (r, g, b) => [r, g, b], head = ''): string {
  const L = [head, `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const o = f(r / (n - 1), g / (n - 1), b / (n - 1));
    L.push(o.map((x) => x.toFixed(6)).join(' '));
  }
  return L.join('\n') + '\n';
}

describe.skipIf(!effectsAvailable())('lut', () => {
  it('identity 17^3 cube reproduces the image within 1/255 (also a 5^3 cube, g = 3)', () => {
    const src = rampImg();
    const a = allPremult(src);
    for (const n of [17, 5, 2]) {
      const b = allPremult(run(src, [fx('lut', { cube: cubeText(n) })]).out);
      let mx = 0;
      for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
      expect(mx, `n=${n}`).toBeLessThanOrEqual(1.6);
    }
  });
  it('red<->blue swap cube proves red-fastest / blue-slowest ordering', () => {
    const text = cubeText(5, (r, g, b) => [b, g, r]);
    near(one([255, 0, 0, 255], fx('lut', { cube: text })), [0, 0, 255, 255], 1);
    near(one([0, 0, 255, 255], fx('lut', { cube: text })), [255, 0, 0, 255], 1);
    near(one([200, 100, 20, 255], fx('lut', { cube: text })), [20, 100, 200, 255], 2.5);
    near(one([0, 255, 0, 255], fx('lut', { cube: text })), [0, 255, 0, 255], 1);
    // a size with several tile rows (n = 10 -> g = 4, 3 tile rows)
    const t10 = cubeText(10, (r, g, b) => [g, b, r]);
    near(one([255, 0, 0, 255], fx('lut', { cube: t10 })), [0, 0, 255, 255], 1);
    near(one([0, 255, 0, 255], fx('lut', { cube: t10 })), [255, 0, 0, 255], 1);
    near(one([0, 0, 255, 255], fx('lut', { cube: t10 })), [0, 255, 0, 255], 1);
  });
  it('domain, intensity and alpha', () => {
    const inv = cubeText(2, (r, g, b) => [1 - r, 1 - g, 1 - b]);
    near(one([60, 120, 240, 255], fx('lut', { cube: inv })), [195, 135, 15, 255], 1.5);
    near(one([60, 120, 240, 255], fx('lut', { cube: inv, intensity: 50 })), [127.5, 127.5, 127.5, 255], 1.5);
    const dom = cubeText(2, (r, g, b) => [r, g, b], 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 0.5 0.5 0.5');
    near(one([200, 20, 100, 255], fx('lut', { cube: dom })), [255, 41, 200, 255], 2);     // c / 0.5 clamped
    const s = makeSurface(W, H, () => [60, 120, 240, 90]);
    expect(straight(run(s, [fx('lut', { cube: inv })]).out, 1, 1)[3]).toBe(90);
  });
  it('invalid cube is a no-op', () => {
    const src = rampImg();
    const a = allPremult(src);
    for (const cube of ['', 'junk', 'LUT_3D_SIZE 2\n0 0 0\n', 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n']) {
      expect(planChain([fx('lut', { cube })])).toHaveLength(0);
      const b = allPremult(run(src, [fx('lut', { cube })]).out);
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });
});

describe('parseCube', () => {
  const id2 = '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  it('reads header lines, comments, TITLE and DOMAIN', () => {
    const c = parseCube(`# comment\nTITLE "x y"\n\nLUT_3D_SIZE 2 # trailing\nDOMAIN_MIN -1 0 0.25\nDOMAIN_MAX 2 1 1\n${id2}`)!;
    expect(c.size).toBe(2);
    expect(c.dmin).toEqual([-1, 0, 0.25]);
    expect(c.dmax).toEqual([2, 1, 1]);
    expect(c.data).toHaveLength(24);
    expect(c.data.slice(3, 6)).toEqual([1, 0, 0]);
  });
  it('defaults the domain and accepts CRLF', () => {
    const c = parseCube(('LUT_3D_SIZE 2\n' + id2).replace(/\n/g, '\r\n'))!;
    expect(c.dmin).toEqual([0, 0, 0]);
    expect(c.dmax).toEqual([1, 1, 1]);
    expect(c.data).toHaveLength(24);
  });
  it('rejects wrong counts, 1D LUTs, size 65 / 1, bad numbers and degenerate domains', () => {
    expect(parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toBeNull();
    expect(parseCube('LUT_3D_SIZE 2\n' + id2 + '0 0 0\n')).toBeNull();
    expect(parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')).toBeNull();
    expect(parseCube('LUT_3D_SIZE 65\n')).toBeNull();
    expect(parseCube('LUT_3D_SIZE 1\n0 0 0\n')).toBeNull();
    expect(parseCube(id2)).toBeNull();
    expect(parseCube('LUT_3D_SIZE 2\n' + id2.replace('1 1 1', '1 x 1'))).toBeNull();
    expect(parseCube('LUT_3D_SIZE 2\n' + id2.replace('1 1 1', '1 1'))).toBeNull();
    expect(parseCube('LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 1 1 1\n' + id2)).toBeNull();
    expect(parseCube('')).toBeNull();
  });
  it('accepts size 64 and builds the atlas layout (g x g tiles)', () => {
    const n = 64;
    const body = 'LUT_3D_SIZE 64\n' + '0.5 0.5 0.5\n'.repeat(n ** 3);
    expect(parseCube(body)?.size).toBe(64);
    const a = cubeAtlas(cubeText(5, (r, g, b) => [r, g, b]))!;
    expect([a.size, a.g, a.tex.w, a.tex.h]).toEqual([5, 3, 15, 15]);
    // blue slice 4 is tile (column 1, row 1); texel (red 3, green 2) -> x = 5 + 3, y = 5 + 2
    const o = ((5 + 2) * 15 + 5 + 3) * 4;
    expect(Array.from(a.tex.data.slice(o, o + 4))).toEqual([Math.round(0.75 * 255), Math.round(0.5 * 255), 255, 255]);
  });
});
