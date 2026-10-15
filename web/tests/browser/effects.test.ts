import { afterAll, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import type { AnyEffect } from '../../src/engine/effects';
import { createSurface } from '../../src/engine/surface';
import vectors from '../../../shared/effects/vectors.json';
import fuzz from '../../../shared/effects/fuzz_vectors.json';
import { applyEffects, disposeEffects, effectExtent, effectReads, effectsAvailable, effectsReach, effectTdPreview, expandRect, planChain } from '../../src/engine/effects';
import { allPremult, black, makeSurface, pm, red, run, square, straight, white, type Px } from './effectsTestUtils';

afterAll(() => disposeEffects());

const W = 96;
const H = 72;
const sq = () => square(W, H, 36, 26, 60, 46); // red 24 x 20 square
const near = (a: number, b: number, tol = 2) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const E = <T extends Effect>(e: T): T => e;

describe.skipIf(!effectsAvailable())('effects (WebGL2 preview)', () => {
  it('no effects / disabled effects copy the source', () => {
    const { out } = run(sq(), [E({ type: 'colorOverlay', enabled: false, color: black, opacity: 1 })]);
    expect(pm(out, 40, 30)).toEqual([255, 0, 0, 255]);
    expect(pm(out, 10, 10)[3]).toBe(0);
  });

  it('colour overlay keeps alpha and replaces colour by opacity', () => {
    const half = makeSurface(W, H, (x) => (x < 48 ? [255, 0, 0, 128] : [0, 0, 0, 0]));
    const { out } = run(half, [E({ type: 'colorOverlay', enabled: true, color: { r: 0, g: 0, b: 255, a: 255 }, opacity: 0.5 })]);
    const p = pm(out, 10, 10); // premult: A*(0.5*red + 0.5*blue) with A = 128/255
    near(p[3], 128, 1);
    near(p[0], 64, 2);
    near(p[2], 64, 2);
    expect(pm(out, 80, 10)[3]).toBe(0);
  });

  it('drop shadow: hard offset copy below the content, soft with blur', () => {
    const fx = E({ type: 'dropShadow', enabled: true, dx: 10, dy: 6, blur: 0, color: black, opacity: 1 });
    const { out } = run(sq(), [fx]);
    expect(pm(out, 40, 30)).toEqual([255, 0, 0, 255]); // content on top
    const s = pm(out, 64, 48); // inside the shifted square, outside the content
    near(s[3], 255, 1);
    near(s[0], 0, 1);
    expect(pm(out, 70, 60)[3]).toBe(0);
    const soft = run(sq(), [{ ...fx, blur: 8 }]).out;
    const a = [58, 64, 70].map((x) => pm(soft, x, 48)[3]); // across the shifted right edge (x = 70)
    expect(a[0]).toBeGreaterThan(a[1]);
    expect(a[1]).toBeGreaterThan(a[2]);
    expect(a[1]).toBeGreaterThan(5);
  });

  it('outer glow lights the outside, strongest at the edge, content untouched', () => {
    const { out } = run(sq(), [E({ type: 'outerGlow', enabled: true, size: 9, color: { r: 0, g: 255, b: 0, a: 255 }, opacity: 1 })]);
    expect(pm(out, 40, 30)).toEqual([255, 0, 0, 255]);
    const e1 = pm(out, 60, 36)[3]; // 1px outside
    const e6 = pm(out, 65, 36)[3];
    const far = pm(out, 80, 36)[3];
    expect(e1).toBeGreaterThan(200);
    expect(e6).toBeLessThan(e1);
    expect(far).toBe(0);
    expect(pm(out, 61, 36)[1]).toBeGreaterThan(0);
  });

  it('inner glow tints the inside near the edge only, alpha unchanged', () => {
    const { out } = run(sq(), [E({ type: 'innerGlow', enabled: true, size: 8, color: { r: 0, g: 0, b: 255, a: 255 }, opacity: 1 })]);
    const edge = pm(out, 37, 36);
    const centre = pm(out, 48, 36);
    expect(edge[2]).toBeGreaterThan(120);
    expect(edge[3]).toBe(255);
    near(centre[0], 255, 4);
    expect(pm(out, 20, 20)[3]).toBe(0);
    expect(pm(out, 34, 36)[3]).toBe(0);
  });

  it('stroke inside / centre / outside bands', () => {
    const c = { r: 0, g: 0, b: 255, a: 255 };
    const mk = (position: 'inside' | 'center' | 'outside') => run(sq(), [E({ type: 'stroke', enabled: true, width: 4, color: c, position, opacity: 1 })]).out;
    const o = mk('outside'); // left edge of the square at x = 36
    expect(pm(o, 38, 36)).toEqual([255, 0, 0, 255]); // inside untouched
    near(pm(o, 34, 36)[2], 255, 3); // 2 px out -> stroke
    expect(pm(o, 34, 36)[3]).toBeGreaterThan(250);
    expect(pm(o, 30, 36)[3]).toBe(0); // 6 px out -> nothing
    const i = mk('inside');
    expect(pm(i, 34, 36)[3]).toBe(0);
    near(pm(i, 37, 36)[2], 255, 3);
    near(pm(i, 44, 36)[0], 255, 2); // further in: red
    const m = mk('center');
    near(pm(m, 35, 36)[2], 255, 3);
    near(pm(m, 37, 36)[2], 255, 3);
    expect(pm(m, 33, 36)[3]).toBe(0);
    near(pm(m, 41, 36)[0], 255, 2);
  });

  it('stroke width accuracy on a round shape (anti-aliased distance)', () => {
    const disc = makeSurface(W, H, (x, y) => (Math.hypot(x + 0.5 - 48, y + 0.5 - 36) <= 14 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const { out } = run(disc, [E({ type: 'stroke', enabled: true, width: 6, color: red, position: 'outside', opacity: 1 })]);
    // coverage along +x: 14 -> 20 px from the centre
    const alphaAt = (x: number) => pm(out, x, 36)[3];
    expect(alphaAt(48 + 17)).toBeGreaterThan(250);
    expect(alphaAt(48 + 22)).toBe(0);
    // total ring area ~ pi (20^2 - 14^2)
    let area = 0;
    const d = allPremult(out);
    for (let i = 0; i < W * H; i++) area += d[i * 4 + 3] / 255;
    const expected = Math.PI * 20 * 20;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.03);
  });

  it('bevel: highlight on the lit edge, shadow on the opposite one, alpha unchanged', () => {
    const fx = E({ type: 'bevel', enabled: true, depth: 100, size: 6, angle: 180, highlight: white, shadow: black });
    const { out } = run(square(W, H, 30, 20, 66, 52, [128, 128, 128, 255]), [fx]);
    const l = pm(out, 31, 36); // left edge: light comes from the left (angle 180)
    const r = pm(out, 64, 36);
    const c = pm(out, 48, 36);
    expect(l[0]).toBeGreaterThan(160);
    expect(r[0]).toBeLessThan(90);
    near(c[0], 128, 3);
    expect(l[3]).toBe(255);
    expect(pm(out, 10, 10)[3]).toBe(0);
  });

  it('pixel sort: sorted ascending by luma within spans, pixels preserved, thresholds respected', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const noise = makeSurface(64, 8, () => {
      const v = Math.floor(rnd() * 256);
      return [v, v, v, 255];
    });
    const before = allPremult(noise);
    const { out } = run(noise, [E({ type: 'pixelSort', enabled: true, direction: 'h', low: 0, high: 1, key: 'luma' })]);
    const after = allPremult(out);
    for (let y = 0; y < 8; y++) {
      const row: number[] = [];
      const row0: number[] = [];
      for (let x = 0; x < 64; x++) {
        row.push(after[(y * 64 + x) * 4]);
        row0.push(before[(y * 64 + x) * 4]);
      }
      for (let x = 1; x < 64; x++) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1] - 1);
      expect([...row0].sort((a, b) => a - b).map((v) => Math.round(v))).toEqual([...row].sort((a, b) => a - b).map((v) => Math.round(v)));
    }
    // thresholded: pixels outside [low, high] keep their place and split spans
    const th = run(noise, [E({ type: 'pixelSort', enabled: true, direction: 'h', low: 0.25, high: 0.75, key: 'luma' })]).out;
    const t = allPremult(th);
    for (let i = 0; i < 64 * 8; i++) {
      const v = before[i * 4] / 255;
      if (v < 0.24 || v > 0.76) expect(t[i * 4]).toBeCloseTo(before[i * 4], 0);
    }
    // vertical: columns sorted
    const v = allPremult(run(noise, [E({ type: 'pixelSort', enabled: true, direction: 'v', low: 0, high: 1, key: 'luma' })]).out);
    for (let x = 0; x < 64; x++) for (let y = 1; y < 8; y++) expect(v[(y * 64 + x) * 4]).toBeGreaterThanOrEqual(v[((y - 1) * 64 + x) * 4] - 1);
  });

  it('pixel sort: a span longer than 256 px is sorted in aligned 256 px chunks', () => {
    const w = 600;
    const s = makeSurface(w, 2, (x) => {
      const v = (x * 37) % 256;
      return [v, v, v, 255];
    });
    const a = allPremult(run(s, [E({ type: 'pixelSort', enabled: true, direction: 'h', low: 0, high: 1, key: 'luma' })]).out);
    for (const [c0, c1] of [[0, 255], [256, 511], [512, 599]]) for (let x = c0 + 1; x <= c1; x++) expect(a[x * 4]).toBeGreaterThanOrEqual(a[(x - 1) * 4] - 1);
  });

  it('glitch is deterministic, seed dependent, and a no-op at amount 0', () => {
    const base = makeSurface(W, H, (x, y) => [(x * 5) & 255, (y * 7) & 255, ((x + y) * 3) & 255, 255]);
    const g = (seed: number, amount: number): Effect => ({ type: 'glitch', enabled: true, amount, blockSize: 8, seed, rgbShift: 3 });
    const a = allPremult(run(base, [g(1, 60)]).out);
    const b = allPremult(run(base, [g(1, 60)]).out);
    const c = allPremult(run(base, [g(2, 60)]).out);
    const z = allPremult(run(base, [g(1, 0)]).out);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(Array.from(z)).toEqual(Array.from(allPremult(base)));
    expect(Array.from(a)).not.toEqual(Array.from(z));
  });

  it('chromatic aberration shifts red and blue in opposite directions', () => {
    const { out } = run(square(W, H, 36, 26, 60, 46, [255, 255, 255, 255]), [E({ type: 'chromaticAberration', enabled: true, amount: 3, angle: 0 })]);
    const left = pm(out, 34, 36); // 2 px left of the square: red is sampled 3px to the right -> inside
    const right = pm(out, 61, 36); // 1 px right: blue sampled 3 px to the left -> inside
    expect(left[0]).toBeGreaterThan(200);
    near(left[1], 0, 2);
    expect(right[2]).toBeGreaterThan(150);
    near(right[0], 0, 2);
    near(pm(out, 48, 36)[0], 255, 1);
    near(pm(out, 48, 36)[2], 255, 1);
  });

  it('halftone: dark areas get big dots, light areas small, transparency stays transparent', () => {
    const mk = (v: number) => makeSurface(64, 64, (x) => (x < 56 ? [v, v, v, 255] : [0, 0, 0, 0]));
    const cov = (s: ReturnType<typeof mk>) => {
      const o = run(s, [E({ type: 'halftone', enabled: true, cellSize: 8, angle: 0, shape: 'dot' })]).out;
      const d = allPremult(o);
      let a = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 48; x++) a += d[(y * 64 + x) * 4 + 3] / 255;
      return { a: a / (64 * 48), o };
    };
    const dark = cov(mk(20));
    const mid = cov(mk(128));
    const light = cov(mk(235));
    expect(dark.a).toBeGreaterThan(0.8);
    expect(mid.a).toBeGreaterThan(0.3);
    expect(mid.a).toBeLessThan(0.65);
    expect(light.a).toBeLessThan(0.12);
    expect(pm(dark.o, 62, 10)[3]).toBe(0);
    // mid-grey dot: area ~ 1 - luma
    near(mid.a, 1 - 128 / 255, 0.08);
    const line = run(mk(128), [E({ type: 'halftone', enabled: true, cellSize: 8, angle: 0, shape: 'line' })]).out;
    // stripes parallel to x: a row of the stripe centre is opaque, the row between is empty
    const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((y) => pm(line, 20, y)[3]);
    expect(Math.max(...rows)).toBeGreaterThan(200);
    expect(Math.min(...rows)).toBeLessThan(10);
  });

  it('halftone draws nothing on pure white (odd cell sizes, both shapes, angles)', () => {
    for (const shape of ['dot', 'line'] as const) {
      for (const cellSize of [7, 5, 9]) {
        for (const angle of [0, 33]) {
          const o = run(makeSurface(48, 48, () => [255, 255, 255, 255]), [E({ type: 'halftone', enabled: true, cellSize, angle, shape })]).out;
          const d = allPremult(o);
          let m = 0;
          for (let i = 0; i < 48 * 48; i++) m = Math.max(m, d[i * 4 + 3]);
          expect(m).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  const BW = 300;
  const BH = 120;
  const base = () => makeSurface(BW, BH, (x, y) => (Math.hypot(x - 150, y - 60) < 45 || (x < 8 && y < 30) || (x > BW - 10 && y > BH - 20) ? [(x * 9) & 255, (y * 5) & 255, 200, 255] : [0, 0, 0, 0]));
  const stacks: Record<string, Effect[]> = {
    dropShadow: [{ type: 'dropShadow', enabled: true, dx: -5, dy: 6, blur: 7, color: black, opacity: 0.8 }],
    stroke: [{ type: 'stroke', enabled: true, width: 5, color: red, position: 'center', opacity: 1 }],
    'stroke w30 (jump flood radius)': [{ type: 'stroke', enabled: true, width: 30, color: red, position: 'outside', opacity: 1 }],
    'stroke w21 inside': [{ type: 'stroke', enabled: true, width: 21, color: red, position: 'inside', opacity: 1 }],
    bevel: [{ type: 'bevel', enabled: true, depth: 80, size: 5, angle: 120, highlight: white, shadow: black }],
    innerGlow: [{ type: 'innerGlow', enabled: true, size: 9, color: white, opacity: 1 }],
    colorOverlay: [{ type: 'colorOverlay', enabled: true, color: red, opacity: 0.4 }],
    glitch: [{ type: 'glitch', enabled: true, amount: 50, blockSize: 6, seed: 3, rgbShift: 2 }],
    halftone: [{ type: 'halftone', enabled: true, cellSize: 7, angle: 25, shape: 'dot' }],
    chromaticAberration: [{ type: 'chromaticAberration', enabled: true, amount: 4, angle: 30 }],
    'pixelSort h': [{ type: 'pixelSort', enabled: true, direction: 'h', low: 0.1, high: 0.95, key: 'luma' }],
    'pixelSort v hue': [{ type: 'pixelSort', enabled: true, direction: 'v', low: 0, high: 1, key: 'hue' }],
    'glow+stroke': [{ type: 'outerGlow', enabled: true, size: 6, color: white, opacity: 1 }, { type: 'stroke', enabled: true, width: 3, color: red, position: 'outside', opacity: 1 }],
    'sort+shadow': [{ type: 'pixelSort', enabled: true, direction: 'h', low: 0, high: 1, key: 'luma' }, { type: 'dropShadow', enabled: true, dx: 3, dy: 3, blur: 4, color: black, opacity: 1 }],
  };
  const dirties = [
    { x: 140, y: 55, w: 6, h: 5 }, // interior
    { x: 0, y: 0, w: 4, h: 4 }, // top-left corner
    { x: BW - 3, y: BH - 3, w: 3, h: 3 }, // bottom-right corner
    { x: 270, y: 20, w: 5, h: 5 }, // second sort chunk
  ];
  for (const [name, effects] of Object.entries(stacks)) {
    it(`regions: partial rect == full render, ${name} (interior, document edges, chunk borders)`, () => {
      const b = base();
      const full = allPremult(run(b, effects).out);
      for (const dirty of dirties) {
        const part = createSurface(BW, BH, true);
        const r = applyEffects(b, effects, dirty, part);
        expect(r).toEqual(expandRect(dirty, effects, true, BW, BH));
        const p = allPremult(part);
        for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
          const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
          for (let k = 0; k < 4; k++) {
            const q = p[(y * BW + x) * 4 + k];
            if (inside) expect(Math.abs(full[(y * BW + x) * 4 + k] - q)).toBeLessThanOrEqual(1);
            else expect(q).toBe(0); // out is untouched outside the returned rect
          }
        }
      }
    });
  }

  it('pixel sort regions widen along the axis only, to whole 256 px chunks', () => {
    const sortH: Effect[] = [{ type: 'pixelSort', enabled: true, direction: 'h', low: 0, high: 1, key: 'luma' }];
    expect(expandRect({ x: 10, y: 20, w: 3, h: 2 }, sortH, true, 600, 100)).toEqual({ x: 0, y: 20, w: 256, h: 2 });
    const v = expandRect({ x: 270, y: 300, w: 3, h: 2 }, [{ type: 'pixelSort', enabled: true, direction: 'v', low: 0, high: 1, key: 'luma' }], true, 600, 700);
    expect(v).toEqual({ x: 270, y: 256, w: 3, h: 256 });
    expect(expandRect({ x: 590, y: 0, w: 10, h: 1 }, sortH, true, 600, 100)).toEqual({ x: 512, y: 0, w: 88, h: 1 });
  });

  it('effect stacks compose in order', () => {
    const both = run(sq(), [
      E({ type: 'colorOverlay', enabled: true, color: { r: 0, g: 255, b: 0, a: 255 }, opacity: 1 }),
      E({ type: 'dropShadow', enabled: true, dx: 8, dy: 0, blur: 0, color: black, opacity: 1 }),
    ]).out;
    expect(straight(both, 40, 30)).toEqual([0, 255, 0, 255]);
    expect(pm(both, 64, 30)[3]).toBe(255); // shadow of the overlaid content
    expect(effectsReach([E({ type: 'dropShadow', enabled: true, dx: 8, dy: 0, blur: 0, color: black, opacity: 1 })])).toBe(8);
  });

  it('pixel sort: stable ties, hue key, spans split by transparent pixels', () => {
    const row = (px: Px[]) => makeSurface(px.length, 1, (x) => px[x]);
    const fx = (key: 'luma' | 'hue', low = 0, high = 1): Effect[] => [{ type: 'pixelSort', enabled: true, direction: 'h', low, high, key }];
    // all greys have hue 0: every key ties, so a stable sort leaves the span untouched
    const ties = row([[200, 200, 200, 255], [50, 50, 50, 255], [120, 120, 120, 255], [90, 90, 90, 255], [10, 10, 10, 255]]);
    expect(Array.from(allPremult(run(ties, fx('hue')).out))).toEqual(Array.from(allPremult(ties)));
    const hues = row([[0, 0, 255, 255], [255, 0, 0, 255], [0, 255, 0, 255]]);
    const h = allPremult(run(hues, fx('hue')).out);
    expect([h[0], h[5], h[10]]).toEqual([255, 255, 255]); // red, green, blue
    const g = (v: number): Px => [v, v, v, 255];
    const split = allPremult(run(row([g(200), g(50), [0, 0, 0, 0], g(90), g(10)]), fx('luma')).out);
    expect([split[0], split[4], split[11], split[12], split[16]]).toEqual([50, 200, 0, 10, 90]);
    const th = allPremult(run(row([g(200), g(30), g(120), g(100), g(250), g(20)]), fx('luma', 0.3, 0.7)).out);
    expect([th[0], th[4], th[8], th[12], th[16], th[20]]).toEqual([200, 30, 100, 120, 250, 20]);
  });

  it('effectsReach is finite for pixel sort (use expandRect for the exact region)', () => {
    expect(effectsReach([E({ type: 'pixelSort', enabled: true, direction: 'h', low: 0, high: 1, key: 'luma' })])).toBe(255);
  });

});


type Ref = { effect: number; shader: string; pass: number; u: number[]; fmt: string; level?: number; aux?: boolean; data?: { w: number; h: number; digest: string } };
type VecCase = { effects: AnyEffect[]; chain: Ref[]; reach: number; extent: number[][]; tdPreview: boolean[]; reads: string[] };
function checkVectors(cases: VecCase[]): void {
  for (const c of cases) {
    const label = JSON.stringify(c.effects).slice(0, 200);
    const got = planChain(c.effects);
    expect(got.length, label).toBe(c.chain.length);
    got.forEach((g, i) => {
      const ref = c.chain[i];
      expect([g.effect, g.pass.shader, g.pass.pid], label).toEqual([ref.effect, ref.shader, ref.pass]);
      expect(g.pass.fmt).toBe({ rgba8fixed: 'u8', rgba16float: 'f16', rgba32float: 'f32' }[ref.fmt]);
      expect([g.pass.level ?? 0, g.pass.aux ?? false], label).toEqual([ref.level ?? 0, ref.aux ?? false]);
      expect(g.pass.data ? { w: g.pass.data.w, h: g.pass.data.h, digest: g.pass.data.digest } : undefined, label).toEqual(ref.data);
      g.pass.u.forEach((v, k) => expect(Math.abs(v - ref.u[k]), label + ' u' + k).toBeLessThanOrEqual(1e-6 + 1e-9 * Math.abs(ref.u[k])));
    });
    expect(effectsReach(c.effects), label).toBe(c.reach);
    expect(c.effects.map((e) => { const x = effectExtent(e); return [x.rx, x.ry, x.ax, x.ay]; }), label).toEqual(c.extent);
    expect(c.effects.map((e) => effectTdPreview(e)), label).toEqual(c.tdPreview);
    expect(c.effects.map((e) => effectReads(e)), label).toEqual(c.reads);
  }
}

describe('effect planner == td/raster_editor/effects.py', () => {
  it('matches shared/effects/vectors.json', () => checkVectors(vectors.cases as unknown as VecCase[]));
  it('matches the seeded fuzz vectors (shared/effects/fuzz_vectors.json: random + hostile parameter sets)', () => {
    expect((fuzz.cases as unknown[]).length).toBeGreaterThan(300);
    checkVectors(fuzz.cases as unknown as VecCase[]);
  });
});
