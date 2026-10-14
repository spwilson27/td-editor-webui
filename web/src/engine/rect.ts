import type { Rect } from './types';

export function isEmpty(r: Rect | null): boolean {
  return r === null || !(r.w > 0 && r.h > 0);
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Rect spanning two points, snapped outwards to integers. */
export function fromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.floor(Math.min(x0, x1));
  const y = Math.floor(Math.min(y0, y1));
  return { x, y, w: Math.ceil(Math.max(x0, x1)) - x, h: Math.ceil(Math.max(y0, y1)) - y };
}

/** Clip to [0,w)×[0,h); null when nothing is left or the input is not finite. */
export function clipToSize(r: Rect, w: number, h: number): Rect | null {
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) return null;
  return intersect({ x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.w), h: Math.ceil(r.h) }, { x: 0, y: 0, w, h });
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

export function equal(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
