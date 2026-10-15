// Pure maths for the v5 free transform (docs/DESIGN_V5.md §1). Document px / degrees throughout.
// Model: doc = T(x,y) · R(rot) · K(kx,ky) · S(sx,sy) · surface, K = [[1, tan kx], [tan ky, 1]],
// rot clockwise on screen (y down), all about the surface's top-left corner.
import type { LayerTransform, Rect } from '../engine/types';
import { HANDLES, handlePoint, handleSigns, scaleRect, type Handle } from './transform';

export type Pt = { x: number; y: number };
/** doc.x = a·u + c·v + e, doc.y = b·u + d·v + f */
export interface Aff { a: number; b: number; c: number; d: number; e: number; f: number }

export const RAD = Math.PI / 180;
export const MAX_SKEW = 85; // degrees; same limit as the engine (src/engine/xform.ts) and the TD network

export function matrixOf(t: LayerTransform): Aff {
  const r = (t.rot || 0) * RAD, cr = Math.cos(r), sr = Math.sin(r);
  const tx = Math.tan((t.kx || 0) * RAD), ty = Math.tan((t.ky || 0) * RAD);
  return {
    a: (cr - sr * ty) * t.sx, b: (sr + cr * ty) * t.sx,
    c: (cr * tx - sr) * t.sy, d: (sr * tx + cr) * t.sy,
    e: t.x, f: t.y,
  };
}
export const applyAff = (m: Aff, u: number, v: number): Pt => ({ x: m.a * u + m.c * v + m.e, y: m.b * u + m.d * v + m.f });
export function invertAff(m: Aff): Aff | null {
  const det = m.a * m.d - m.b * m.c;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}
export const surfaceToDoc = (t: LayerTransform, u: number, v: number): Pt => applyAff(matrixOf(t), u, v);
export function docToSurface(t: LayerTransform, x: number, y: number): Pt | null {
  const i = invertAff(matrixOf(t));
  return i ? applyAff(i, x, y) : null;
}

/** Corners of a w×h surface in doc space: TL, TR, BR, BL. */
export function boxCorners(t: LayerTransform, w: number, h: number): [Pt, Pt, Pt, Pt] {
  const m = matrixOf(t);
  return [applyAff(m, 0, 0), applyAff(m, w, 0), applyAff(m, w, h), applyAff(m, 0, h)];
}
/** The 8 handle positions in doc space. */
export function handlePoints(t: LayerTransform, w: number, h: number): Record<Handle, Pt> {
  const m = matrixOf(t), out = {} as Record<Handle, Pt>;
  for (const hd of HANDLES) { const p = handlePoint({ x: 0, y: 0, w, h }, hd); out[hd] = applyAff(m, p.x, p.y); }
  return out;
}
export const centreOfBox = (t: LayerTransform, w: number, h: number): Pt => surfaceToDoc(t, w / 2, h / 2);
export function aabbOf(pts: Pt[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export const boxAabb = (t: LayerTransform, w: number, h: number): Rect => aabbOf(boxCorners(t, w, h));
export const isAxisAligned = (t: LayerTransform) => !t.rot && !t.kx && !t.ky;

/** `t` patched, then x/y adjusted so the visual centre of the w×h box stays where it was in `t`. */
export function keepCentre(t: LayerTransform, w: number, h: number, patch: Partial<LayerTransform>): LayerTransform {
  const c = centreOfBox(t, w, h);
  const n = { ...t, ...patch };
  const c2 = centreOfBox(n, w, h);
  return { ...n, x: n.x + (c.x - c2.x), y: n.y + (c.y - c2.y) };
}

export function normDeg(d: number): number {
  let r = ((d + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}
export const angleOf = (c: Pt, p: Pt) => Math.atan2(p.y - c.y, p.x - c.x) / RAD;

/** Rotate drag: the box turns by the pointer's angle change about its centre; Shift snaps the absolute angle to 15°. */
export function rotateDrag(t0: LayerTransform, w: number, h: number, p0: Pt, p1: Pt, snap: boolean): LayerTransform {
  const c = centreOfBox(t0, w, h);
  let rot = (t0.rot || 0) + (angleOf(c, p1) - angleOf(c, p0));
  if (snap) rot = Math.round(rot / 15) * 15;
  return keepCentre(t0, w, h, { rot: normDeg(Math.round(rot * 1e6) / 1e6) });
}

/** The rotate+skew part (scale 1) of a transform: layer-space → doc-space direction map. */
const rk = (t: LayerTransform): Aff => matrixOf({ ...t, x: 0, y: 0, sx: 1, sy: 1 });

/** Scale-handle drag in layer space so it works on rotated / skewed boxes. (dx, dy) = pointer delta in doc px. */
export function scaleDrag(t0: LayerTransform, w: number, h: number, hd: Handle, dx: number, dy: number, o: { shift: boolean; alt: boolean }): LayerTransform {
  const n = rk(t0), inv = invertAff(n);
  if (!inv || w <= 0 || h <= 0) return t0;
  const dq = { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy };
  const r = scaleRect({ x: 0, y: 0, w: w * t0.sx, h: h * t0.sy }, hd, dq.x, dq.y, { shift: o.shift, alt: o.alt, minSize: 1 });
  return { ...t0, sx: r.w / w, sy: r.h / h, x: t0.x + n.a * r.x + n.c * r.y, y: t0.y + n.b * r.x + n.d * r.y };
}

/** Skew drag on an edge handle (n/s → kx, e/w → ky); corners do nothing. Skews about the centre. */
export function skewDrag(t0: LayerTransform, w: number, h: number, hd: Handle, dx: number, dy: number): LayerTransform {
  const { hx, hy } = handleSigns(hd);
  if ((hx && hy) || (!hx && !hy)) return t0;
  const r = (t0.rot || 0) * RAD, cr = Math.cos(r), sr = Math.sin(r);
  const rx = cr * dx + sr * dy, ry = -sr * dx + cr * dy; // pointer delta in the rotated (un-skewed) frame
  const W = w * t0.sx, H = h * t0.sy;
  if (W <= 0 || H <= 0) return t0;
  let tx = Math.tan((t0.kx || 0) * RAD), ty = Math.tan((t0.ky || 0) * RAD);
  if (hy) tx += rx / ((hy * H) / 2); else ty += ry / ((hx * W) / 2);
  const lim = Math.tan(MAX_SKEW * RAD);
  tx = Math.max(-lim, Math.min(lim, tx)); ty = Math.max(-lim, Math.min(lim, ty));
  if (1 - tx * ty < 0.05) return t0; // would collapse the box
  return keepCentre(t0, w, h, { kx: Math.atan(tx) / RAD, ky: Math.atan(ty) / RAD });
}

export type OHit = Handle | 'move' | 'rotate';
export const ROTATE_ZONE = 18;
export interface ViewLike { zoom: number; x: number; y: number }

/** What is under screen point (sx, sy): a handle (within `tol` px), the body, the rotate zone just outside a corner, or nothing. */
export function hitOriented(view: ViewLike, t: LayerTransform, w: number, h: number, sx: number, sy: number, tol = 7): OHit | null {
  const scr = (p: Pt): Pt => ({ x: view.x + p.x * view.zoom, y: view.y + p.y * view.zoom });
  const c = boxCorners(t, w, h).map(scr);
  const edge = Math.min(Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y), Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y));
  const s = docToSurface(t, (sx - view.x) / view.zoom, (sy - view.y) / view.zoom);
  const inside = !!s && s.x >= 0 && s.x <= w && s.y >= 0 && s.y <= h;
  if (inside && edge < tol * 2 * 3) return 'move'; // too small for handles: the body wins
  const hp = handlePoints(t, w, h);
  let best: Handle | null = null, bd = Infinity;
  for (const hd of HANDLES) {
    const p = scr(hp[hd]), d = Math.max(Math.abs(p.x - sx), Math.abs(p.y - sy));
    if (d <= tol && d < bd) { best = hd; bd = d; }
  }
  if (best) return best;
  if (inside) return 'move';
  for (const hd of ['nw', 'ne', 'se', 'sw'] as Handle[]) {
    const p = scr(hp[hd]);
    if (Math.hypot(p.x - sx, p.y - sy) <= tol + ROTATE_ZONE) return 'rotate';
  }
  return null;
}

const svgCursor = (svg: string, hot: string, fallback: string) => `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hot}, ${fallback}`;
export const ROTATE_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 14a7 7 0 0 1 11-6M18 4v5h-5" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 14a7 7 0 0 1 11-6M18 4v5h-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  '12 12', 'crosshair');

const bucket = (deg: number) => {
  const a = ((deg % 180) + 180) % 180;
  const i = Math.round(a / 45) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][i];
};
/** CSS cursor for hovering `hit` on a box with transform `t`; Ctrl over an edge handle = skew. */
export function cursorFor(hit: OHit | null, t: LayerTransform, w: number, h: number, ctrl = false): string {
  if (!hit) return 'default';
  if (hit === 'move') return 'move';
  if (hit === 'rotate') return ROTATE_CURSOR;
  const { hx, hy } = handleSigns(hit);
  if (ctrl && (hx === 0) !== (hy === 0)) return bucket((t.rot || 0) + (hy ? 0 : 90)); // along the edge
  const hp = handlePoints(t, w, h)[hit], c = centreOfBox(t, w, h);
  return bucket(angleOf(c, hp));
}
