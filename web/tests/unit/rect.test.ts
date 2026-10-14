import { describe, expect, it } from 'vitest';
import { clipToSize, equal, fromPoints, intersect, isEmpty, translate, union } from '../../src/engine/rect';

describe('rect math', () => {
  it('isEmpty', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty({ x: 0, y: 0, w: 0, h: 5 })).toBe(true);
    expect(isEmpty({ x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });
  it('intersect', () => {
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 5, h: 5 });
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBeNull(); // touching edges
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: -9, y: -9, w: 10, h: 10 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it('union', () => {
    expect(union(null, null)).toBeNull();
    expect(union({ x: 1, y: 1, w: 1, h: 1 }, null)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(union(null, { x: 1, y: 1, w: 1, h: 1 })).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(union({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 6, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 6, h: 7 });
  });
  it('fromPoints snaps outwards and normalises', () => {
    expect(fromPoints(10.5, 20.2, 2.1, 3.9)).toEqual({ x: 2, y: 3, w: 9, h: 18 });
  });
  it('clipToSize', () => {
    expect(clipToSize({ x: -5, y: -5, w: 10, h: 10 }, 100, 100)).toEqual({ x: 0, y: 0, w: 5, h: 5 });
    expect(clipToSize({ x: 95, y: 0, w: 10, h: 1 }, 100, 100)).toEqual({ x: 95, y: 0, w: 5, h: 1 });
    expect(clipToSize({ x: 100, y: 0, w: 10, h: 1 }, 100, 100)).toBeNull();
    expect(clipToSize({ x: 0, y: 0, w: 0, h: 5 }, 100, 100)).toBeNull();
    expect(clipToSize({ x: NaN, y: 0, w: 5, h: 5 }, 100, 100)).toBeNull();
    expect(clipToSize({ x: 0, y: 0, w: Infinity, h: 5 }, 100, 100)).toBeNull();
    expect(clipToSize({ x: 0.5, y: 0.5, w: 1, h: 1 }, 100, 100)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it('translate / equal', () => {
    expect(translate({ x: 1, y: 2, w: 3, h: 4 }, 10, 20)).toEqual({ x: 11, y: 22, w: 3, h: 4 });
    expect(equal(null, null)).toBe(true);
    expect(equal(null, { x: 0, y: 0, w: 1, h: 1 })).toBe(false);
    expect(equal({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });
});
