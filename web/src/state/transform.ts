// Pure geometry for the Move tool's transform box (docs/DESIGN_V4.md §3). Document px throughout.
import type { LayerTransform, Rect, ShapeSpec, TextSpec } from '../engine/types';

export type Handle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
export const HANDLE_CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize' };

const sx = (h: Handle) => (h.includes('w') ? -1 : h.includes('e') ? 1 : 0);
const sy = (h: Handle) => (h.includes('n') ? -1 : h.includes('s') ? 1 : 0);
export const handleSigns = (h: Handle) => ({ hx: sx(h), hy: sy(h) });

export function handlePoint(r: Rect, h: Handle): { x: number; y: number } {
  const { hx, hy } = handleSigns(h);
  return { x: r.x + r.w / 2 + (hx * r.w) / 2, y: r.y + r.h / 2 + (hy * r.h) / 2 };
}

export const centreOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const moveRect = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });

export interface ScaleOpts { shift: boolean; alt: boolean; minSize?: number }

/** `r` with handle `h` dragged by (dx, dy). Shift keeps the aspect ratio, Alt scales about the centre. */
export function scaleRect(r: Rect, h: Handle, dx: number, dy: number, o: ScaleOpts): Rect {
  const min = o.minSize ?? 1;
  const { hx, hy } = handleSigns(h);
  const c = centreOf(r);
  const axis = (h1: number, lo: number, len: number, d: number, mid: number) => {
    if (!h1) return len;
    const moving = (h1 > 0 ? lo + len : lo) + d;
    const fixed = o.alt ? mid : h1 > 0 ? lo : lo + len;
    return Math.max(min, (h1 * (moving - fixed)) * (o.alt ? 2 : 1));
  };
  let w = axis(hx, r.x, r.w, dx, c.x), hgt = axis(hy, r.y, r.h, dy, c.y);
  if (o.shift && r.w > 0 && r.h > 0) {
    const k = hx && hy ? Math.max(w / r.w, hgt / r.h) : hx ? w / r.w : hgt / r.h;
    w = Math.max(min, r.w * k);
    hgt = Math.max(min, r.h * k);
  }
  const x = o.alt || !hx ? c.x - w / 2 : hx > 0 ? r.x : r.x + r.w - w;
  const y = o.alt || !hy ? c.y - hgt / 2 : hy > 0 ? r.y : r.y + r.h - hgt;
  return { x, y, w, h: hgt };
}

/** The transform that maps a layer currently occupying `from` onto `to`. */
export function transformFor(t: LayerTransform, from: Rect, to: Rect): LayerTransform {
  if (from.w <= 0 || from.h <= 0) return t;
  const kx = to.w / from.w, ky = to.h / from.h;
  return { ...t, x: to.x + (t.x - from.x) * kx, y: to.y + (t.y - from.y) * ky, sx: t.sx * kx, sy: t.sy * ky };
}

const kOf = (kx: number, ky: number) => (Math.abs(kx - 1) < 1e-9 ? ky : Math.abs(ky - 1) < 1e-9 ? kx : Math.sqrt(kx * ky));

/** Text scales by editing its geometry (font size, position, box width), staying sharp. */
export function remapText(t: TextSpec, from: Rect, to: Rect): TextSpec {
  if (from.w <= 0 || from.h <= 0) return t;
  const kx = to.w / from.w, ky = to.h / from.h, k = kOf(kx, ky);
  return {
    ...t, x: to.x + (t.x - from.x) * kx, y: to.y + (t.y - from.y) * ky,
    size: Math.max(1, Math.round(t.size * k * 100) / 100), boxWidth: t.boxWidth === null ? null : Math.max(1, t.boxWidth * kx),
  };
}

export function remapShape(s: ShapeSpec, from: Rect, to: Rect): ShapeSpec {
  if (from.w <= 0 || from.h <= 0) return s;
  const kx = to.w / from.w, ky = to.h / from.h, k = kOf(kx, ky);
  const px = (x: number) => to.x + (x - from.x) * kx, py = (y: number) => to.y + (y - from.y) * ky;
  switch (s.type) {
    case 'rect':
    case 'ellipse': {
      // map the centre so rotated shapes scale about where they are
      const cx = px(s.x + s.w / 2), cy = py(s.y + s.h / 2), w = s.w * kx, h = s.h * ky;
      return { ...s, x: cx - w / 2, y: cy - h / 2, w, h, ...(s.type === 'rect' ? { radius: s.radius * k } : {}) } as ShapeSpec;
    }
    case 'line':
      return { ...s, x1: px(s.x1), y1: py(s.y1), x2: px(s.x2), y2: py(s.y2) };
    case 'polygon':
      return { ...s, cx: px(s.cx), cy: py(s.cy), radius: Math.max(1, s.radius * k) };
  }
}

export const sameRect = (a: Rect, b: Rect, eps = 1e-6) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;
export const isIdentity = (t: LayerTransform) => t.x === 0 && t.y === 0 && t.sx === 1 && t.sy === 1 && !t.rot && !t.kx && !t.ky;
export const IDENTITY: LayerTransform = { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 };

export type BoundsField = 'x' | 'y' | 'w' | 'h';
/** Context-bar field edit: the new bounds. Width / height keep the top-left corner; `lock` keeps the aspect ratio. */
export function editBounds(cur: Rect, field: BoundsField, value: number, lock: boolean): Rect {
  const r = { ...cur };
  if (field === 'x' || field === 'y') { r[field] = value; return r; }
  const v = Math.max(1, value);
  if (field === 'w') { r.w = v; if (lock && cur.w > 0) r.h = Math.max(1, (cur.h * v) / cur.w); }
  else { r.h = v; if (lock && cur.h > 0) r.w = Math.max(1, (cur.w * v) / cur.h); }
  return r;
}

/** Nice ruler tick spacing (doc px): the smallest step 1/2/5·10^n whose on-screen size is at least `minPx`. */
export function rulerStep(zoom: number, minPx = 60): number {
  const raw = minPx / zoom;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

export type BoxHit = Handle | 'move';
/** What is under screen point (sx, sy) for a transform box: a handle (within `tol` px), the inside (move), or nothing. */
export function hitBox(view: { zoom: number; x: number; y: number }, r: Rect, sx: number, sy: number, tol = 7): BoxHit | null {
  const x0 = view.x + r.x * view.zoom, y0 = view.y + r.y * view.zoom;
  const inside = sx >= x0 && sx <= x0 + r.w * view.zoom && sy >= y0 && sy <= y0 + r.h * view.zoom;
  // a small box (< ~3 handles across): its handles would cover the whole body, so the body wins inside it
  const small = Math.min(r.w, r.h) * view.zoom < tol * 2 * 3;
  if (inside && small) return 'move';
  for (const h of HANDLES) {
    const p = handlePoint(r, h);
    if (Math.abs(view.x + p.x * view.zoom - sx) <= tol && Math.abs(view.y + p.y * view.zoom - sy) <= tol) return h;
  }
  return inside ? 'move' : null;
}

/** A guide within `tol` screen px of (sx, sy), nearest first. */
export function hitGuide(view: { zoom: number; x: number; y: number }, g: { h: number[]; v: number[] }, sx: number, sy: number, tol = 4): { axis: 'h' | 'v'; index: number } | null {
  let best: { axis: 'h' | 'v'; index: number; d: number } | null = null;
  g.h.forEach((pos, index) => { const d = Math.abs(view.y + pos * view.zoom - sy); if (d <= tol && (!best || d < best.d)) best = { axis: 'h', index, d }; });
  g.v.forEach((pos, index) => { const d = Math.abs(view.x + pos * view.zoom - sx); if (d <= tol && (!best || d < best.d)) best = { axis: 'v', index, d }; });
  return best ? { axis: (best as { axis: 'h' | 'v' }).axis, index: (best as { index: number }).index } : null;
}

/** Ruler ticks: majors labelled in doc px, minors where they stay at least 6 px apart. */
export function rulerTicks(zoom: number, origin: number, length: number): { step: number; ticks: { pos: number; screen: number; level: 0 | 1 | 2 }[] } {
  const step = rulerStep(zoom);
  const divs = [10, 5, 2, 1].find((d) => (step / d) * zoom >= 6 && Number.isInteger(step / d)) ?? 1;
  const minor = step / divs;
  const first = Math.floor(-origin / zoom / minor) * minor, last = (length - origin) / zoom;
  const ticks: { pos: number; screen: number; level: 0 | 1 | 2 }[] = [];
  for (let n = 0, p = first; p <= last + minor; n++, p = first + n * minor) {
    const isMajor = Math.abs(p / step - Math.round(p / step)) < 1e-6;
    const isMid = divs % 2 === 0 && Math.abs(p / (step / 2) - Math.round(p / (step / 2))) < 1e-6;
    ticks.push({ pos: Math.round(p * 1000) / 1000, screen: origin + p * zoom, level: isMajor ? 0 : isMid ? 1 : 2 });
  }
  return { step, ticks };
}

