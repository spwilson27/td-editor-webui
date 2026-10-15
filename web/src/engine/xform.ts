import type { Anchor, LayerTransform, Rect } from './types';

/**
 * Layer -> document mapping (docs/DESIGN_V4.md §2): doc = (x, y) + (sx, sy) · layer, with layer pixel (0, 0) at the
 * surface's top-left corner. A PixelLayer satisfies this interface itself.
 */
export type Xf = LayerTransform;

export const IDENT: Xf = Object.freeze({ x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
export const MIN_SCALE = 1 / 1024;
export const MAX_SCALE = 1024;
export const MAX_SKEW = 85; // degrees
export const MIN_SKEW_DET = 0.05; // 1 - tan(kx) tan(ky) must stay above this (the UI uses the same rule)

const RAD = Math.PI / 180;

/** Canvas-style affine: x' = a x + c y + e, y' = b x + d y + f. */
export interface Mat { a: number; b: number; c: number; d: number; e: number; f: number }

/** No rotation and no skew: the mapping is a scale and a translation (every v4 fast path applies). */
export const isAxis = (t: Xf): boolean => !t.rot && !t.kx && !t.ky;
export const isIdent = (t: Xf): boolean => t.x === 0 && t.y === 0 && t.sx === 1 && t.sy === 1 && isAxis(t);
/** Scale 1, no rotation / skew and whole-pixel position: surface pixels land exactly on document pixels (no resampling needed). */
export const isAligned = (t: Xf): boolean => t.sx === 1 && t.sy === 1 && isAxis(t) && Number.isInteger(t.x) && Number.isInteger(t.y);
export const sameXf = (a: Xf, b: Xf): boolean =>
  a.x === b.x && a.y === b.y && a.sx === b.sx && a.sy === b.sy && (a.rot || 0) === (b.rot || 0) && (a.kx || 0) === (b.kx || 0) && (a.ky || 0) === (b.ky || 0);
export const copyXf = (t: Xf): Xf => ({ x: t.x, y: t.y, sx: t.sx, sy: t.sy, rot: t.rot || 0, kx: t.kx || 0, ky: t.ky || 0 });

/** doc = T(x,y) . R(rot) . K(kx,ky) . S(sx,sy) . layer, R clockwise on screen (y down), K = [[1, tan kx], [tan ky, 1]]. */
export function matOf(t: Xf): Mat {
  if (isAxis(t)) return { a: t.sx, b: 0, c: 0, d: t.sy, e: t.x, f: t.y };
  const r = (t.rot || 0) * RAD;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  const tx = Math.tan((t.kx || 0) * RAD);
  const ty = Math.tan((t.ky || 0) * RAD);
  // K . S = [[sx, tx sy], [ty sx, sy]]
  const k00 = t.sx;
  const k01 = tx * t.sy;
  const k10 = ty * t.sx;
  const k11 = t.sy;
  return { a: cs * k00 - sn * k10, b: sn * k00 + cs * k10, c: cs * k01 - sn * k11, d: sn * k01 + cs * k11, e: t.x, f: t.y };
}

export function invMat(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** Matrix product m1 . m2 (m2 applies first). */
export function mulMat(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b, b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d, d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e, f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export const applyMat = (m: Mat, u: number, v: number): { x: number; y: number } => ({ x: m.a * u + m.c * v + m.e, y: m.b * u + m.d * v + m.f });

/**
 * Transform parameters for a matrix: rot . K(kx, 0) . S(sx, sy) (QR form, ky = 0), the canonical re-expression used when a
 * non-uniform document-space scale is applied to a rotated / skewed layer. Requires a positive determinant.
 */
export function decompose(m: Mat): Xf {
  const sx = Math.hypot(m.a, m.b);
  const rot = Math.atan2(m.b, m.a);
  const cs = m.a / sx;
  const sn = m.b / sx;
  // R^-1 . M = [[sx, tan(kx) sy], [0, sy]]
  const u01 = cs * m.c + sn * m.d;
  const sy = -sn * m.c + cs * m.d;
  return { x: m.e, y: m.f, sx, sy, rot: rot / RAD, kx: Math.atan2(u01, sy) / RAD, ky: 0 };
}

/** Finite position, scale clamped to a sane positive range, skew clamped. Returns null when it cannot be repaired. */
export function cleanXf(t: Xf): Xf | null {
  const rot = t.rot ?? 0;
  const kx = t.kx ?? 0;
  const ky = t.ky ?? 0;
  if (![t.x, t.y, t.sx, t.sy, rot, kx, ky].every(Number.isFinite)) return null;
  const c = (n: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
  const k = (n: number): number => Math.min(MAX_SKEW, Math.max(-MAX_SKEW, n));
  if (1 - Math.tan(k(kx) * RAD) * Math.tan(k(ky) * RAD) < MIN_SKEW_DET) return null; // (nearly) singular or mirrored: det = (1 - tan kx tan ky) sx sy
  // positions are whole pixels (canvas snaps rects, TD would show a fringe); scale, rotation and skew stay fractional
  return { x: Math.round(t.x), y: Math.round(t.y), sx: c(t.sx), sy: c(t.sy), rot, kx: k(kx), ky: k(ky) };
}

export const toDoc = (t: Xf, u: number, v: number): { x: number; y: number } =>
  isAxis(t) ? { x: t.x + t.sx * u, y: t.y + t.sy * v } : applyMat(matOf(t), u, v);
export const toLayer = (t: Xf, x: number, y: number): { x: number; y: number } =>
  isAxis(t) ? { x: (x - t.x) / t.sx, y: (y - t.y) / t.sy } : applyMat(invMat(matOf(t)), x, y);

/** Corners (tl, tr, br, bl) of a rect mapped through an affine. */
export function mapCorners(m: Mat, r: Rect): Array<{ x: number; y: number }> {
  return [applyMat(m, r.x, r.y), applyMat(m, r.x + r.w, r.y), applyMat(m, r.x + r.w, r.y + r.h), applyMat(m, r.x, r.y + r.h)];
}

function aabb(pts: Array<{ x: number; y: number }>): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Exact (float) document-space image of a layer-space rect; rotated / skewed layers give the bounding box of the parallelogram. */
export function layerRectToDoc(t: Xf, r: Rect): Rect {
  if (isAxis(t)) return { x: t.x + t.sx * r.x, y: t.y + t.sy * r.y, w: t.sx * r.w, h: t.sy * r.h };
  return aabb(mapCorners(matOf(t), r));
}
/** Layer-space bounding box of a document rect. */
export function docRectToLayer(t: Xf, r: Rect): Rect {
  if (isAxis(t)) return { x: (r.x - t.x) / t.sx, y: (r.y - t.y) / t.sy, w: r.w / t.sx, h: r.h / t.sy };
  return aabb(mapCorners(invMat(matOf(t)), r));
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

/**
 * Integer layer rect of the layer pixels whose centres lie inside the document rect `d` (may be empty: w or h 0). For
 * rotated / skewed layers this is the (conservative) bounding box of the preimage: use `docRectPolygon` for the exact clip.
 */
export function innerLayerRect(t: Xf, d: Rect): Rect {
  if (!isAxis(t)) {
    const b = docRectToLayer(t, d);
    const x0 = Math.floor(b.x);
    const y0 = Math.floor(b.y);
    return { x: x0, y: y0, w: Math.max(0, Math.ceil(b.x + b.w) - x0), h: Math.max(0, Math.ceil(b.y + b.h) - y0) };
  }
  const x0 = Math.ceil((d.x - t.x) / t.sx - 0.5);
  const y0 = Math.ceil((d.y - t.y) / t.sy - 0.5);
  const x1 = Math.ceil((d.x + d.w - t.x) / t.sx - 0.5);
  const y1 = Math.ceil((d.y + d.h - t.y) / t.sy - 0.5);
  return { x: x0 || 0, y: y0 || 0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }; // `|| 0`: never -0
}

/** The document rect `d` as a polygon in layer space (exact preimage; for clipping edits on rotated / skewed layers). */
export function docRectPolygon(t: Xf, d: Rect): Array<{ x: number; y: number }> {
  return mapCorners(invMat(matOf(t)), d);
}

/** Add the layer-space polygon of the document rect `d` (or, for axis-aligned layers, the exact pixel-centre rect) to the current clip. */
export function clipDocRect(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, t: Xf, d: Rect): void {
  ctx.beginPath();
  if (isAxis(t)) {
    const q = innerLayerRect(t, d);
    ctx.rect(q.x, q.y, q.w, q.h);
  } else {
    const p = docRectPolygon(t, d);
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath();
  }
  ctx.clip();
}

/**
 * Draw `img` (w x h) under `t`, restricted to the integer document rect `vis` (callers clip to `vis`).
 * Axis-aligned: positions are whole pixels, so Chrome's snapping of drawImage destination rects is exact; the source window
 * is grown by a pixel so interpolation near the edge of `vis` sees real neighbours. Rotated / skewed layers draw the source
 * window under the full affine (composed with the context's current transform). Smoothing quality is 'medium'.
 */
export function drawMapped(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, t: Xf, vis: Rect,
): void {
  ctx.imageSmoothingEnabled = true;
  if (!isAxis(t)) {
    const b = docRectToLayer(t, vis);
    const u0 = Math.max(0, Math.floor(b.x) - 1);
    const v0 = Math.max(0, Math.floor(b.y) - 1);
    const u1 = Math.min(w, Math.ceil(b.x + b.w) + 1);
    const v1 = Math.min(h, Math.ceil(b.y + b.h) + 1);
    if (u1 <= u0 || v1 <= v0) return;
    const m = matOf(t);
    ctx.imageSmoothingQuality = 'medium';
    ctx.save();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(img, u0, v0, u1 - u0, v1 - v0, u0, v0, u1 - u0, v1 - v0);
    ctx.restore();
    return;
  }
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

