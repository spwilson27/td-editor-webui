import type { Anchor, LayerTransform, Rect } from './types';

/**
 * Layer -> document mapping (docs/DESIGN_V4.md §2): doc = (x, y) + (sx, sy) · layer, with layer pixel (0, 0) at the
 * surface's top-left corner. A PixelLayer satisfies this interface itself.
 */
export type Xf = LayerTransform;

export const IDENT: Xf = Object.freeze({ x: 0, y: 0, sx: 1, sy: 1 });
export const MIN_SCALE = 1 / 1024;
export const MAX_SCALE = 1024;

export const isIdent = (t: Xf): boolean => t.x === 0 && t.y === 0 && t.sx === 1 && t.sy === 1;
/** Scale 1 and whole-pixel position: surface pixels land exactly on document pixels (no resampling needed). */
export const isAligned = (t: Xf): boolean => t.sx === 1 && t.sy === 1 && Number.isInteger(t.x) && Number.isInteger(t.y);
export const sameXf = (a: Xf, b: Xf): boolean => a.x === b.x && a.y === b.y && a.sx === b.sx && a.sy === b.sy;
export const copyXf = (t: Xf): Xf => ({ x: t.x, y: t.y, sx: t.sx, sy: t.sy });

/** Finite position, scale clamped to a sane positive range. Returns null when it cannot be repaired. */
export function cleanXf(t: Xf): Xf | null {
  if (![t.x, t.y, t.sx, t.sy].every(Number.isFinite)) return null;
  const c = (n: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
  return { x: Math.round(t.x), y: Math.round(t.y), sx: c(t.sx), sy: c(t.sy) }; // positions are whole pixels (canvas snaps rects, TD would show a fringe); scale stays fractional
}

export const toDoc = (t: Xf, u: number, v: number): { x: number; y: number } => ({ x: t.x + t.sx * u, y: t.y + t.sy * v });
export const toLayer = (t: Xf, x: number, y: number): { x: number; y: number } => ({ x: (x - t.x) / t.sx, y: (y - t.y) / t.sy });

/** Exact (float) document-space image of a layer-space rect. */
export function layerRectToDoc(t: Xf, r: Rect): Rect {
  return { x: t.x + t.sx * r.x, y: t.y + t.sy * r.y, w: t.sx * r.w, h: t.sy * r.h };
}
export function docRectToLayer(t: Xf, r: Rect): Rect {
  return { x: (r.x - t.x) / t.sx, y: (r.y - t.y) / t.sy, w: r.w / t.sx, h: r.h / t.sy };
}

/** Round a float rect outwards to whole pixels. */
export function outerRect(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}

/**
 * Document rect (whole pixels) that may differ after layer pixels `lr` changed: the mapped rect grown by one layer
 * pixel (bilinear footprint) and two document pixels (minification kernels), rounded outwards.
 */
export function dirtyDoc(t: Xf, lr: Rect): Rect {
  if (isAligned(t)) return { x: lr.x + t.x, y: lr.y + t.y, w: lr.w, h: lr.h }; // pixels map 1:1: nothing bleeds
  const m = layerRectToDoc(t, { x: lr.x - 1, y: lr.y - 1, w: lr.w + 2, h: lr.h + 2 });
  return outerRect({ x: m.x - 2, y: m.y - 2, w: m.w + 4, h: m.h + 4 });
}

/** Integer layer rect of the layer pixels whose centres lie inside the document rect `d` (may be empty: w or h 0). */
export function innerLayerRect(t: Xf, d: Rect): Rect {
  const x0 = Math.ceil((d.x - t.x) / t.sx - 0.5);
  const y0 = Math.ceil((d.y - t.y) / t.sy - 0.5);
  const x1 = Math.ceil((d.x + d.w - t.x) / t.sx - 0.5);
  const y1 = Math.ceil((d.y + d.h - t.y) / t.sy - 0.5);
  return { x: x0 || 0, y: y0 || 0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }; // `|| 0`: never -0
}

/**
 * Draw `img` (w x h) under `t`, restricted to the integer document rect `vis` (callers clip to `vis`).
 * Positions are whole pixels, so Chrome's snapping of drawImage destination rects is exact; the source window is grown by a
 * pixel so interpolation near the edge of `vis` sees real neighbours. Smoothing quality is 'medium'.
 */
export function drawMapped(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, t: Xf, vis: Rect,
): void {
  ctx.imageSmoothingEnabled = true;
  const u0 = Math.max(0, Math.floor((vis.x - t.x) / t.sx) - 1);
  const v0 = Math.max(0, Math.floor((vis.y - t.y) / t.sy) - 1);
  const u1 = Math.min(w, Math.ceil((vis.x + vis.w - t.x) / t.sx) + 1);
  const v1 = Math.min(h, Math.ceil((vis.y + vis.h - t.y) / t.sy) + 1);
  if (u1 <= u0 || v1 <= v0) return;
  ctx.imageSmoothingQuality = 'medium'; // matches TD's mip/linear sampling best (measured)
  ctx.drawImage(img, u0, v0, u1 - u0, v1 - v0, t.x + t.sx * u0, t.y + t.sy * v0, t.sx * (u1 - u0), t.sy * (v1 - v0));
}

/** Position of the old canvas inside the new one for an anchor (whole pixels). */
export function anchorOffset(a: Anchor, ow: number, oh: number, nw: number, nh: number): { dx: number; dy: number } {
  const fx = a === 'tl' || a === 'l' || a === 'bl' ? 0 : a === 't' || a === 'c' || a === 'b' ? 0.5 : 1;
  const fy = a === 'tl' || a === 't' || a === 'tr' ? 0 : a === 'l' || a === 'c' || a === 'r' ? 0.5 : 1;
  return { dx: Math.round((nw - ow) * fx) || 0, dy: Math.round((nh - oh) * fy) || 0 }; // `|| 0`: never -0
}

