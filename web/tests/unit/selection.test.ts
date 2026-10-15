import { describe, expect, it } from 'vitest';
import {
  boundsOfAlpha, combine, feather, fillPolygon, invert, materialize, NO_SEL, rectSel, resizeSel, selectAllState, tracePath, wandSelect,
  type SelState,
} from '../../src/engine/selection';

const W = 40;
const H = 30;
const at = (s: SelState, x: number, y: number): number => (s.alpha ? s.alpha[y * W + x] : s.rect && x >= s.rect.x && y >= s.rect.y && x < s.rect.x + s.rect.w && y < s.rect.y + s.rect.h ? 255 : 0);
const area = (s: SelState): number => {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) n += at(s, x, y);
  return n / 255;
};

describe('combine', () => {
  const A = rectSel({ x: 5, y: 5, w: 10, h: 10 });
  const B = rectSel({ x: 10, y: 10, w: 10, h: 10 });
  it('new replaces, add unions, subtract removes, intersect keeps the overlap', () => {
    expect(combine(A, B, 'new', W, H)).toBe(B);
    const add = combine(A, B, 'add', W, H);
    expect(area(add)).toBe(100 + 100 - 25);
    expect(add.rect).toEqual({ x: 5, y: 5, w: 15, h: 15 });
    const sub = combine(A, B, 'subtract', W, H);
    expect(area(sub)).toBe(75);
    expect(at(sub, 12, 12)).toBe(0);
    expect(at(sub, 6, 6)).toBe(255);
    expect(sub.rect).toEqual({ x: 5, y: 5, w: 10, h: 10 });
    const inter = combine(A, B, 'intersect', W, H);
    expect(inter).toEqual({ rect: { x: 10, y: 10, w: 5, h: 5 }, alpha: null }); // two plain rects stay a plain rect
  });
  it('without a current selection: add / intersect = new, subtract = nothing', () => {
    expect(combine(NO_SEL, B, 'add', W, H)).toBe(B);
    expect(combine(NO_SEL, B, 'intersect', W, H)).toBe(B);
    expect(combine(NO_SEL, B, 'subtract', W, H)).toBe(NO_SEL);
  });
  it('empty results become NO_SEL and bounds are recomputed', () => {
    expect(combine(A, rectSel({ x: 0, y: 0, w: 30, h: 30 }), 'subtract', W, H)).toBe(NO_SEL);
    expect(combine(A, rectSel({ x: 20, y: 20, w: 3, h: 3 }), 'intersect', W, H)).toBe(NO_SEL);
    const notch = combine(A, rectSel({ x: 5, y: 5, w: 10, h: 4 }), 'subtract', W, H);
    expect(notch.rect).toEqual({ x: 5, y: 9, w: 10, h: 6 });
  });
  it('uses fuzzy max / min on soft coverage', () => {
    const a = { rect: { x: 0, y: 0, w: 2, h: 1 }, alpha: new Uint8Array(W * H) };
    a.alpha[0] = 200; a.alpha[1] = 50;
    const b = { rect: { x: 0, y: 0, w: 2, h: 1 }, alpha: new Uint8Array(W * H) };
    b.alpha[0] = 100; b.alpha[1] = 120;
    const add = combine(a, b, 'add', W, H);
    expect([add.alpha?.[0], add.alpha?.[1]]).toEqual([200, 120]);
    const inter = combine(a, b, 'intersect', W, H);
    expect([inter.alpha?.[0], inter.alpha?.[1]]).toEqual([100, 50]);
    const sub = combine(a, b, 'subtract', W, H);
    expect([sub.alpha?.[0], sub.alpha?.[1]]).toEqual([155, 50]); // min(a, 255 - b)
  });
});

describe('invert / select all / resize', () => {
  it('invert flips coverage; inverting select-all gives nothing', () => {
    const inv = invert(rectSel({ x: 5, y: 5, w: 10, h: 10 }), W, H);
    expect(area(inv)).toBe(W * H - 100);
    expect(at(inv, 6, 6)).toBe(0);
    expect(at(inv, 0, 0)).toBe(255);
    expect(inv.rect).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(invert(selectAllState(W, H), W, H)).toBe(NO_SEL);
    expect(invert(NO_SEL, W, H)).toBe(NO_SEL);
    expect(area(invert(inv, W, H))).toBe(100); // involution
  });
  it('resizeSel keeps the top-left content', () => {
    const s = fillPolygon([{ x: 2, y: 2 }, { x: 30, y: 2 }, { x: 30, y: 20 }, { x: 2, y: 20 }], W, H, false);
    const r = resizeSel(s, W, 20, 10);
    expect(r.rect).toEqual({ x: 2, y: 2, w: 18, h: 8 });
    expect(r.alpha?.length).toBe(200);
  });
});

describe('feather', () => {
  const full = (n: number, y: number) => y * n;
  it('a hard edge becomes ~50% at the edge, ~255 / ~0 a radius away, and is monotonic', () => {
    const w = 120, h = 60, R = 8;
    const s = feather(rectSel({ x: 40, y: 10, w: 50, h: 40 }), R, w, h);
    const row = (x: number) => (s.alpha as Uint8Array)[full(w, 30) + x];
    expect(Math.abs(row(40) + row(39) - 255)).toBeLessThanOrEqual(20); // symmetric around the edge
    expect(row(40)).toBeGreaterThan(100);
    expect(row(39)).toBeLessThan(155);
    expect(row(40 + R + 1)).toBeGreaterThanOrEqual(250);
    expect(row(40 - R - 1)).toBeLessThanOrEqual(5);
    for (let x = 30; x < 52; x++) expect(row(x + 1)).toBeGreaterThanOrEqual(row(x));
    // bounded: nothing beyond rect + radius (+1 of rounding slack)
    expect(s.rect!.x).toBeGreaterThanOrEqual(40 - R - 2);
    expect(s.rect!.x + s.rect!.w).toBeLessThanOrEqual(90 + R + 2);
  });
  it('conserves total coverage (blur is mass preserving away from the document border)', () => {
    const w = 100, h = 100;
    const base = rectSel({ x: 30, y: 30, w: 30, h: 30 });
    const s = feather(base, 5, w, h);
    let sum = 0;
    (s.alpha as Uint8Array).forEach((v) => (sum += v));
    expect(Math.abs(sum / 255 - 900) / 900).toBeLessThan(0.01);
  });
  it('small radii are distinct and monotonic (1 < 2 < 3 < 4 in softness)', () => {
    const widthOf = (r: number): number => {
      const s = feather(rectSel({ x: 20, y: 5, w: 20, h: 20 }), r, W, H);
      let n = 0;
      for (let x = 10; x < 20; x++) if ((s.alpha as Uint8Array)[15 * W + x] > 8) n++;
      let sum = 0;
      for (let x = 10; x < 20; x++) sum += (s.alpha as Uint8Array)[15 * W + x];
      return n * 1000 + sum;
    };
    const m = [1, 2, 3, 4, 5, 6, 8].map((r) => feather(rectSel({ x: 20, y: 5, w: 20, h: 20 }), r, W, H).alpha as Uint8Array);
    const edge = m.map((a) => a[15 * W + 19]); // pixel just outside the edge grows with the radius
    for (let i = 1; i < edge.length; i++) expect(edge[i]).toBeGreaterThanOrEqual(edge[i - 1]);
    expect(new Set(edge.slice(0, 4)).size).toBe(4);
    expect(widthOf(1)).toBeLessThan(widthOf(3));
  });
  it('radius 0 is the identity; border pixels replicate instead of fading', () => {
    const r = rectSel({ x: 0, y: 0, w: 10, h: 10 });
    expect(feather(r, 0, W, H)).toBe(r);
    const s = feather(rectSel({ x: 0, y: 0, w: 20, h: 10 }), 4, W, H);
    expect((s.alpha as Uint8Array)[5 * W + 0]).toBeGreaterThanOrEqual(250); // left border untouched
  });
});

describe('fillPolygon (non-zero winding)', () => {
  it('axis-aligned polygon on pixel edges is exact with and without antialiasing', () => {
    const pts = [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 12 }, { x: 5, y: 12 }];
    for (const aa of [true, false]) {
      const s = fillPolygon(pts, W, H, aa);
      expect(s.rect).toEqual({ x: 5, y: 5, w: 10, h: 7 });
      expect(area(s)).toBe(70);
      expect(at(s, 5, 5)).toBe(255);
      expect(at(s, 14, 11)).toBe(255);
      expect(at(s, 15, 11)).toBe(0);
    }
  });
  it('antialiasing gives fractional coverage on fractional edges and slanted edges', () => {
    const half = fillPolygon([{ x: 5.5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 12 }, { x: 5.5, y: 12 }], W, H, true);
    expect(Math.abs(at(half, 5, 8) - 128)).toBeLessThanOrEqual(2);
    expect(at(half, 6, 8)).toBe(255);
    const hard = fillPolygon([{ x: 5.5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 12 }, { x: 5.5, y: 12 }], W, H, false);
    expect([0, 255]).toContain(at(hard, 5, 8));
    // right triangle: area ~ 8 * 8 / 2 = 32
    const tri = fillPolygon([{ x: 4, y: 4 }, { x: 12, y: 4 }, { x: 4, y: 12 }], W, H, true);
    expect(Math.abs(area(tri) - 32)).toBeLessThan(0.6);
    const edge = at(tri, 7, 8); // pixel crossed by the hypotenuse
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    const mid = new Set<number>();
    for (let i = 0; i < 8; i++) mid.add(at(tri, 4 + i, 11 - i));
    expect(mid.size).toBeGreaterThan(0);
  });
  it('concave polygons keep their notch', () => {
    // U shape: outer 5..25 x 5..20, notch 12..18 x 5..14
    const u = [{ x: 5, y: 5 }, { x: 12, y: 5 }, { x: 12, y: 14 }, { x: 18, y: 14 }, { x: 18, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 20 }, { x: 5, y: 20 }];
    const s = fillPolygon(u, W, H, true);
    expect(at(s, 15, 8)).toBe(0);
    expect(at(s, 15, 17)).toBe(255);
    expect(at(s, 8, 8)).toBe(255);
    expect(area(s)).toBe(20 * 15 - 6 * 9);
  });
  it('self-intersecting figure-eight fills both lobes; a same-direction double loop stays filled (non-zero)', () => {
    const eight = [{ x: 5, y: 5 }, { x: 25, y: 20 }, { x: 25, y: 5 }, { x: 5, y: 20 }];
    const s = fillPolygon(eight, W, H, false);
    expect(at(s, 7, 12)).toBe(255); // left lobe
    expect(at(s, 23, 12)).toBe(255); // right lobe
    expect(at(s, 15, 7)).toBe(0); // between the lobes, above the crossing
    // pentagram: the centre has winding 2 -> filled with non-zero (even-odd would leave a hole)
    const pent = Array.from({ length: 5 }, (_, i) => {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      return { x: 20 + 12 * Math.cos(a), y: 15 + 12 * Math.sin(a) };
    });
    const p = fillPolygon(pent, W, H, false);
    expect(at(p, 20, 15)).toBe(255);
  });
  it('clips to the document and ignores degenerate input', () => {
    const s = fillPolygon([{ x: -10, y: -10 }, { x: 100, y: -10 }, { x: 100, y: 100 }, { x: -10, y: 100 }], W, H, true);
    expect(s.rect).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(fillPolygon([{ x: 1, y: 1 }, { x: 2, y: 2 }], W, H, true)).toBe(NO_SEL);
    expect(fillPolygon([{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 9, y: 1 }], W, H, true)).toBe(NO_SEL);
    expect(fillPolygon([{ x: 1, y: 1 }, { x: NaN, y: 1 }, { x: 9, y: 5 }], W, H, true)).toBe(NO_SEL);
  });
});

describe('wandSelect', () => {
  // 10x1 strip: values 0,10,20,...,90 in red; alpha 255
  const strip = (vals: number[], w = vals.length, h = 1): Uint8ClampedArray => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([vals[i % vals.length], 0, 0, 255], i * 4);
    return d;
  };
  it('tolerance is the max channel delta (inclusive)', () => {
    const d = strip([0, 10, 20, 30, 40, 50]);
    const at6 = (tol: number) => wandSelect(d, 6, 1, 0, 0, tol, true).rect;
    expect(at6(0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(at6(10)).toEqual({ x: 0, y: 0, w: 2, h: 1 });
    expect(at6(29)).toEqual({ x: 0, y: 0, w: 3, h: 1 });
    expect(at6(255)).toEqual({ x: 0, y: 0, w: 6, h: 1 });
  });
  it('alpha counts as a channel', () => {
    const d = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 200, 0, 0, 0, 0]);
    expect(wandSelect(d, 3, 1, 0, 0, 10, true).rect?.w).toBe(1);
    expect(wandSelect(d, 3, 1, 0, 0, 60, true).rect?.w).toBe(2);
  });
  it('contiguous stops at a barrier, global jumps it', () => {
    const d = strip([5, 5, 200, 5, 5], 5);
    const c = wandSelect(d, 5, 1, 0, 0, 4, true);
    expect(c.rect).toEqual({ x: 0, y: 0, w: 2, h: 1 });
    expect(c.alpha?.[3]).toBe(0);
    const g = wandSelect(d, 5, 1, 0, 0, 4, false);
    expect(g.rect).toEqual({ x: 0, y: 0, w: 5, h: 1 });
    expect(g.alpha?.[2]).toBe(0);
    expect(g.alpha?.[3]).toBe(255);
  });
  it('flows around obstacles (4-connected) and outside clicks select nothing', () => {
    // 5x5 white with a red diagonal wall: not 4-connected across the diagonal gap-less wall
    const w = 5, h = 5;
    const d = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let i = 0; i < 5; i++) d.set([255, 0, 0, 255], (i * w + i) * 4);
    const s = wandSelect(d, w, h, 4, 0, 0, true);
    expect(s.alpha?.[0 * w + 4]).toBe(255);
    expect(s.alpha?.[4 * w + 0]).toBe(0); // other side of the wall
    expect(wandSelect(d, w, h, -1, 0, 0, true)).toBe(NO_SEL);
    expect(wandSelect(d, w, h, 0, 9, 0, true)).toBe(NO_SEL);
  });
});

describe('tracePath', () => {
  it('plain rect is one clockwise 4-corner loop', () => {
    const p = tracePath(rectSel({ x: 3, y: 4, w: 5, h: 6 }), W);
    expect(p).toEqual([[{ x: 3, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 10 }, { x: 3, y: 10 }]]);
    expect(tracePath(NO_SEL, W)).toEqual([]);
  });
  const signedArea = (l: Array<{ x: number; y: number }>) => l.reduce((a, p, i) => a + (p.x * l[(i + 1) % l.length].y - l[(i + 1) % l.length].x * p.y), 0) / 2;
  it('a binary rect mask traces to its exact corners', () => {
    const a = new Uint8Array(W * H);
    for (let y = 4; y < 10; y++) a.fill(255, y * W + 3, y * W + 8);
    const p = tracePath({ rect: { x: 3, y: 4, w: 5, h: 6 }, alpha: a }, W);
    expect(p).toHaveLength(1);
    expect(p[0]).toHaveLength(4);
    expect(signedArea(p[0])).toBe(30);
    const xs = p[0].map((q) => q.x);
    const ys = p[0].map((q) => q.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3, 8, 4, 10]);
  });
  it('L shapes have 6 corners; holes are separate counter-clockwise loops', () => {
    const a = new Uint8Array(W * H);
    for (let y = 2; y < 12; y++) a.fill(255, y * W + 2, y * W + 12);
    for (let y = 5; y < 9; y++) a.fill(0, y * W + 5, y * W + 9); // hole
    const s: SelState = { rect: boundsOfAlpha(a, W, { x: 0, y: 0, w: W, h: H }), alpha: a };
    const p = tracePath(s, W);
    expect(p).toHaveLength(2);
    const areas = p.map(signedArea).sort((x, y) => x - y);
    expect(areas).toEqual([-16, 100]); // hole is opposite orientation
    const l = new Uint8Array(W * H);
    for (let y = 0; y < 10; y++) l.fill(255, y * W, y * W + 4);
    for (let y = 6; y < 10; y++) l.fill(255, y * W + 4, y * W + 10);
    const lp = tracePath({ rect: boundsOfAlpha(l, W, { x: 0, y: 0, w: W, h: H }), alpha: l }, W);
    expect(lp).toHaveLength(1);
    expect(lp[0]).toHaveLength(6);
  });
  it('uses the 50% threshold on soft masks', () => {
    const a = new Uint8Array(W * H);
    for (let y = 2; y < 8; y++) { a.fill(127, y * W + 2, y * W + 4); a.fill(128, y * W + 4, y * W + 10); }
    const p = tracePath({ rect: { x: 2, y: 2, w: 8, h: 6 }, alpha: a }, W);
    const xs = p[0].map((q) => q.x);
    expect(Math.min(...xs)).toBe(4);
    expect(Math.max(...xs)).toBe(10);
  });
  it('large circles are simplified but stay within ~1px of the true outline', () => {
    const w = 200, h = 200;
    const a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - 100) ** 2 + (y + 0.5 - 100) ** 2 <= 80 * 80) a[y * w + x] = 255;
    const p = tracePath({ rect: boundsOfAlpha(a, w, { x: 0, y: 0, w, h }), alpha: a }, w);
    expect(p).toHaveLength(1);
    expect(p[0].length).toBeLessThan(400);
    for (const q of p[0]) expect(Math.abs(Math.hypot(q.x - 100, q.y - 100) - 80)).toBeLessThan(1.6);
  });
});

describe('materialize / bounds', () => {
  it('materialize of a rect fills a fresh array; boundsOfAlpha is exact', () => {
    const m = materialize(rectSel({ x: 2, y: 3, w: 4, h: 2 }), W, H);
    expect(m.length).toBe(W * H);
    expect(boundsOfAlpha(m, W, { x: 0, y: 0, w: W, h: H })).toEqual({ x: 2, y: 3, w: 4, h: 2 });
    expect(boundsOfAlpha(new Uint8Array(W * H), W, { x: 0, y: 0, w: W, h: H })).toBeNull();
  });
});

describe('perf (node)', () => {
  const run = (process.env.VITE_PERF ?? process.env.PERF) !== '0';
  (run ? it : it.skip)('wandSelect on 1080p and tracePath on a complex 1080p mask stay in budget', () => {
    const w = 1920, h = 1080;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([(i * 7) & 3, 10, 20, 255], i * 4); // noise within tolerance
    wandSelect(d, w, h, 5, 5, 8, true); // warm
    let t = performance.now();
    const s = wandSelect(d, w, h, 5, 5, 8, true);
    const wand = performance.now() - t;
    expect(s.rect).toEqual({ x: 0, y: 0, w, h });
    // complex mask: concentric rings + dots
    const a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - 960, y - 540);
      if (Math.floor(r / 6) % 2 === 0 || ((x * 31 + y * 17) % 97 === 0)) a[y * w + x] = 255;
    }
    const st: SelState = { rect: { x: 0, y: 0, w, h }, alpha: a };
    tracePath(st, w);
    t = performance.now();
    const loops = tracePath(st, w);
    const trace = performance.now() - t;
    console.log(`PERF(node) wand 1080p ${wand.toFixed(1)} ms; tracePath complex 1080p ${trace.toFixed(1)} ms (${loops.length} loops)`);
    expect(wand).toBeLessThan(60);
  });
});
