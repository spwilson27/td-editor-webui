import { describe, expect, it } from 'vitest';
import { cropData, floodFill, paintMasked } from '../../src/engine/floodFill';

function img(rows: string[], palette: Record<string, number[]>) {
  const h = rows.length, w = rows[0].length;
  const d = new Uint8ClampedArray(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((c, x) => d.set(palette[c], (y * w + x) * 4)));
  return { d, w, h };
}
const P = { '.': [0, 0, 0, 0], '#': [255, 255, 255, 255], g: [10, 10, 10, 255], r: [200, 0, 0, 255] };
const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);

describe('floodFill', () => {
  it('fills a fully transparent layer entirely (any tolerance)', () => {
    const { d, w, h } = img(['....', '....', '....'], P);
    for (const tol of [0, 255]) {
      const r = floodFill(d, w, h, 1, 1, tol)!;
      expect(count(r.mask)).toBe(12);
      expect(r.rect).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    }
  });

  it('stays inside a closed outline (4-connected, no diagonal leaks)', () => {
    const { d, w, h } = img([
      '#####',
      '#...#',
      '#.#.#',
      '#...#',
      '#####',
    ], P);
    const r = floodFill(d, w, h, 1, 1, 0)!;
    expect(count(r.mask)).toBe(8);
    expect(r.mask[2 * w + 2]).toBe(0);
    expect(r.rect).toEqual({ x: 1, y: 1, w: 3, h: 3 });
    // diagonal gap does not leak
    const diag = img(['.#.', '#..', '...'], P);
    expect(count(floodFill(diag.d, 3, 3, 0, 0, 0)!.mask)).toBe(1);
  });

  it('tolerance 0 is exact, higher tolerance accepts near colours, 255 accepts all', () => {
    const { d, w, h } = img(['#g#', '#g#'], P); // g is 245 away from #
    expect(count(floodFill(d, w, h, 0, 0, 0)!.mask)).toBe(2);
    expect(count(floodFill(d, w, h, 0, 0, 244)!.mask)).toBe(2);
    expect(count(floodFill(d, w, h, 0, 0, 245)!.mask)).toBe(6);
    expect(count(floodFill(d, w, h, 0, 0, 255)!.mask)).toBe(6);
  });

  it('alpha participates in the comparison', () => {
    const { d, w, h } = img(['.#'], P);
    expect(count(floodFill(d, w, h, 0, 0, 100)!.mask)).toBe(1);
  });

  it('fills a snake-shaped (non-convex) region', () => {
    const { d, w, h } = img([
      '...##',
      '##.##',
      '##...',
      '####.',
    ], P);
    const r = floodFill(d, w, h, 0, 0, 0)!;
    expect(count(r.mask)).toBe(8);
  });

  it('seed outside the image returns null', () => {
    const { d, w, h } = img(['..'], P);
    expect(floodFill(d, w, h, -1, 0, 0)).toBeNull();
    expect(floodFill(d, w, h, 2, 0, 0)).toBeNull();
    expect(floodFill(d, w, h, 0, 1, 0)).toBeNull();
  });

  it('crop + paint write only masked pixels', () => {
    const { d, w, h } = img(['#..', '#.#'], P);
    const r = floodFill(d, w, h, 1, 0, 0)!;
    const crop = cropData(d, w, r.rect);
    expect(r.rect).toEqual({ x: 1, y: 0, w: 2, h: 2 });
    paintMasked(crop, w, r.rect, r.mask, { r: 9, g: 8, b: 7, a: 6 });
    expect(Array.from(crop)).toEqual([9, 8, 7, 6, 9, 8, 7, 6, 9, 8, 7, 6, 255, 255, 255, 255]);
  });

  it('handles a large region without recursion trouble', () => {
    const d = new Uint8ClampedArray(1000 * 1000 * 4);
    const t0 = performance.now();
    const r = floodFill(d, 1000, 1000, 500, 500, 0)!;
    expect(count(r.mask)).toBe(1_000_000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
