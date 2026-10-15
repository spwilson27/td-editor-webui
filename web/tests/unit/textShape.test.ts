import { describe, expect, it } from 'vitest';
import { textBaselineOffset, textLinePitch, linePolys, polygonPoints, sanitizeText, shapeBounds, translateShape, translateText } from '../../src/engine/textShape';
import type { ShapeSpec } from '../../src/engine/types';

const C = { r: 1, g: 2, b: 3, a: 255 };
const S = { enabled: true, color: C, width: 2 };
type Poly = Extract<ShapeSpec, { type: 'polygon' }>;
type Line = Extract<ShapeSpec, { type: 'line' }>;
const poly = (o: Partial<Poly> = {}): Poly => ({ type: 'polygon', cx: 50, cy: 50, radius: 10, sides: 4, innerRatio: 1, fill: { enabled: true, color: C }, stroke: S, rotation: 0, ...o });
const line = (o: Partial<Line> = {}): Line => ({ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, stroke: S, arrowStart: false, arrowEnd: false, ...o });

describe('polygonPoints', () => {
  it('vertex 0 points up and vertices go clockwise on screen', () => {
    const p = polygonPoints(poly());
    expect(p).toHaveLength(4);
    expect(p[0].x).toBeCloseTo(50);
    expect(p[0].y).toBeCloseTo(40);
    expect(p[1].x).toBeCloseTo(60); // next vertex is to the right (clockwise)
    expect(p[1].y).toBeCloseTo(50);
  });
  it('rotation is clockwise degrees about the centre', () => {
    const p = polygonPoints(poly({ rotation: 90 }));
    expect(p[0].x).toBeCloseTo(60);
    expect(p[0].y).toBeCloseTo(50);
  });
  it('stars have 2n vertices alternating outer / inner radius, outer vertices equal the polygon', () => {
    const star = polygonPoints(poly({ sides: 5, innerRatio: 0.4, radius: 20 }));
    const pg = polygonPoints(poly({ sides: 5, radius: 20 }));
    expect(star).toHaveLength(10);
    star.forEach((p, i) => {
      const r = Math.hypot(p.x - 50, p.y - 50);
      expect(r).toBeCloseTo(i % 2 === 0 ? 20 : 8);
    });
    pg.forEach((p, i) => { expect(star[i * 2].x).toBeCloseTo(p.x); expect(star[i * 2].y).toBeCloseTo(p.y); });
  });
});

describe('linePolys', () => {
  it('plain line is one quad of the stroke width; zero length is empty', () => {
    const p = linePolys(line());
    expect(p).toHaveLength(1);
    const ys = p[0].map((q) => q.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2);
    expect(linePolys(line({ x2: 0 }))).toEqual([]);
  });
  it('arrow heads: tip on the end point, length max(8, 4w), half base 0.4 * length, all polygons positively oriented', () => {
    const polys = linePolys(line({ arrowEnd: true, stroke: { ...S, width: 5 } }));
    expect(polys).toHaveLength(2);
    const tri = polys[1];
    expect(tri).toContainEqual({ x: 100, y: 0 });
    const base = tri.filter((q) => q.x < 99);
    expect(base).toHaveLength(2);
    base.forEach((q) => { expect(q.x).toBeCloseTo(80); expect(Math.abs(q.y)).toBeCloseTo(8); });
    for (const q of polys) {
      let a = 0;
      q.forEach((p, i) => { const n = q[(i + 1) % q.length]; a += p.x * n.y - n.x * p.y; });
      expect(a).toBeGreaterThan(0);
    }
  });
  it('heads shrink to fit short lines', () => {
    const polys = linePolys(line({ x2: 10, arrowStart: true, arrowEnd: true }));
    expect(polys.length).toBeGreaterThanOrEqual(2);
    const tri = polys[polys.length - 2];
    expect(Math.abs(tri[1].x - tri[0].x)).toBeLessThanOrEqual(5.0001);
  });
});

describe('bounds / sanitise / translate', () => {
  it('shapeBounds includes stroke and antialiasing margin and rotation', () => {
    const b = shapeBounds({ type: 'rect', x: 10, y: 10, w: 20, h: 10, radius: 0, fill: { enabled: true, color: C }, stroke: { ...S, width: 4 }, rotation: 0 });
    expect(b).toEqual({ x: 6, y: 6, w: 28, h: 18 });
    const r = shapeBounds({ type: 'rect', x: 0, y: 0, w: 40, h: 0, radius: 0, fill: { enabled: true, color: C }, stroke: { ...S, enabled: false }, rotation: 90 });
    expect(r.h).toBeGreaterThanOrEqual(40);
    expect(r.w).toBeLessThanOrEqual(5);
  });
  it('sanitizeText clamps and defaults', () => {
    const t = sanitizeText({ text: 'x', font: '', size: -3, color: { r: 999, g: -1, b: NaN, a: 300 } as never, align: 'bad' as never, bold: 1 as never, italic: 0 as never, lineHeight: 0, x: NaN, y: 4, boxWidth: 0 });
    expect(t).toMatchObject({ font: 'sans-serif', size: 1, align: 'left', bold: true, italic: false, x: 0, y: 4, boxWidth: 1 });
    expect(t.color).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(t.lineHeight).toBeGreaterThan(0);
  });
  it('translate moves positions only', () => {
    expect(translateShape(line(), 3, 4)).toMatchObject({ x1: 3, y1: 4, x2: 103, y2: 4 });
    expect(translateShape(poly(), 1, 2)).toMatchObject({ cx: 51, cy: 52, radius: 10 });
    const t = sanitizeText({ text: 'a', font: 'f', size: 10, color: C, align: 'left', bold: false, italic: false, lineHeight: 1, x: 1, y: 2, boxWidth: null });
    expect(translateText(t, 5, 6)).toMatchObject({ x: 6, y: 8, text: 'a' });
    expect(t.x).toBe(1);
  });
});

describe('baseline helper', () => {
  it('matches the documented formula', () => {
    expect(textBaselineOffset({ size: 40, lineHeight: 1.2 })).toBeCloseTo(4 + 32);
    expect(textBaselineOffset({ size: 40, lineHeight: 1 })).toBeCloseTo(32);
    expect(textLinePitch({ size: 40, lineHeight: 1.5 })).toBe(60);
  });
  it('a star is innerRatio < 1', () => {
    expect(polygonPoints(poly({ sides: 5, innerRatio: 0.9995 }))).toHaveLength(10);
    expect(polygonPoints(poly({ sides: 5, innerRatio: 1 }))).toHaveLength(5);
  });
});
