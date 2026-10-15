import { describe, expect, it } from 'vitest';
import { materialize, rectSel } from '../../src/engine/selection';
import { modifySel } from '../../src/engine/selectionOps';

const W = 40;
const H = 30;
const count = (a: Uint8Array): number => a.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);

/** Brute-force disc dilation / erosion of a binary mask (outside the document: 0 for grow, 1 for shrink). */
function ref(a: Uint8Array, r: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = grow ? 0 : 255;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const xx = x + dx;
          const yy = y + dy;
          const s = xx < 0 || yy < 0 || xx >= W || yy >= H ? (grow ? 0 : 255) : a[yy * W + xx];
          v = grow ? Math.max(v, s) : Math.min(v, s);
        }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

const sel = rectSel({ x: 10, y: 8, w: 12, h: 9 });

describe('selection modifiers', () => {
  it('grow = disc dilation, exact against brute force; bounds grow by r', () => {
    for (const r of [1, 2, 3, 5]) {
      const g = modifySel(sel, 'grow', r, W, H);
      expect(Array.from(g.alpha as Uint8Array)).toEqual(Array.from(ref(materialize(sel, W, H), r, true)));
      expect(g.rect).toEqual({ x: 10 - r, y: 8 - r, w: 12 + 2 * r, h: 9 + 2 * r });
    }
  });

  it('shrink = disc erosion, exact; a rect shrinks by r on each side; vanishes when too small', () => {
    const s = modifySel(sel, 'shrink', 2, W, H);
    expect(Array.from(s.alpha as Uint8Array)).toEqual(Array.from(ref(materialize(sel, W, H), 2, false)));
    expect(s.rect).toEqual({ x: 12, y: 10, w: 8, h: 5 });
    expect(modifySel(sel, 'shrink', 5, W, H).rect).toBeNull();
  });

  it('the canvas edge does not erode, and grow clips at the canvas', () => {
    const edge = rectSel({ x: 0, y: 0, w: 10, h: 10 });
    expect(modifySel(edge, 'shrink', 2, W, H).rect).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    expect(modifySel(edge, 'grow', 3, W, H).rect).toEqual({ x: 0, y: 0, w: 13, h: 13 });
  });

  it('grow then shrink by the same radius restores a rectangle', () => {
    const back = modifySel(modifySel(sel, 'grow', 3, W, H), 'shrink', 3, W, H);
    expect(back.rect).toEqual(sel.rect);
    expect(count(back.alpha as Uint8Array)).toBe(12 * 9);
  });

  it('border(w) = band of total width w straddling the edge', () => {
    const b = modifySel(sel, 'border', 4, W, H);
    const a = b.alpha as Uint8Array;
    const grown = ref(materialize(sel, W, H), 2, true);
    const eroded = ref(materialize(sel, W, H), 2, false);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(Math.min(grown[i], 255 - eroded[i]));
    expect(a[12 * W + 16]).toBe(0); // centre
    expect(a[12 * W + 10]).toBe(255); // on the edge
    expect(a[12 * W + 8]).toBe(255); // 2 px outside
    expect(a[12 * W + 7]).toBe(0);
    expect(b.rect).toEqual({ x: 8, y: 6, w: 16, h: 13 });
  });

  it('smooth rounds corners, keeps straight edges and the area roughly', () => {
    const big = rectSel({ x: 10, y: 8, w: 20, h: 14 });
    const s = modifySel(big, 'smooth', 4, W, H);
    const a = s.alpha as Uint8Array;
    expect(a[8 * W + 10]).toBeLessThan(60); // corner pixel cut away
    expect(a[8 * W + 20]).toBeGreaterThan(240); // edge midpoint stays
    expect(a[15 * W + 20]).toBe(255);
    expect(Math.abs(count(a) - 20 * 14)).toBeLessThan(25);
  });

  it('feather widens the rect and softens the edge; no-ops for empty selections / zero radius', () => {
    const f = modifySel(sel, 'feather', 4, W, H);
    const a = f.alpha as Uint8Array;
    expect(a[12 * W + 10]).toBeGreaterThan(60);
    expect(a[12 * W + 10]).toBeLessThan(200);
    expect(f.rect!.w).toBeGreaterThan(12);
    expect(modifySel(sel, 'grow', 0, W, H)).toBe(sel);
    expect(modifySel({ rect: null, alpha: null }, 'grow', 3, W, H).rect).toBeNull();
  });
});
