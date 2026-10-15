// Text and shape rendering (docs/DESIGN_V3.md section 2.2).
//
// RENDERING CONVENTIONS (the TouchDesigner side - Text TOP and a GLSL SDF - must match these)
// =============================================================================================
// All coordinates are document pixels, origin top-left, y down. Angles are DEGREES, positive = clockwise on
// screen. Colours are straight RGBA 0..255 (alpha 0..255); `fill`/`stroke` have `enabled` flags.
//
// TEXT  (TextSpec)
//   * Font: CSS font `[italic ][bold ]<size>px "<family>", sans-serif` (family quoted unless it already contains a
//     comma). Bold = weight 700. `size` is the CSS pixel size (the em size).
//   * Lines: `text` is split on "\n" into paragraphs. With `boxWidth === null` every paragraph is one line.
//     With a `boxWidth` each paragraph is wrapped greedily at single spaces: words = paragraph.split(' ');
//     a word is appended (" " + word) while the measured line width is <= boxWidth, otherwise it starts a new
//     line. A single word wider than boxWidth is NOT broken (it overflows). An empty paragraph is an empty line.
//   * Line pitch = size * lineHeight. The text block's top-left is (x, y). The block is as wide as `boxWidth`, or,
//     without a box, as the widest line; `x` is always the LEFT edge of the block (so growing text with align
//     centre/right keeps the block anchored at x).
//   * Vertical placement: the alphabetic baseline of line i is
//         y + i * size * lineHeight + (size * lineHeight - size) / 2 + 0.8 * size
//     i.e. the em box (height `size`) is centred in the line box and the baseline sits 0.8 em below the em-box
//     top (ASCENT = 0.8, a fixed constant independent of the font).
//   * Horizontal placement per line: align 'left' -> the line starts at x; 'center' -> the line is centred on
//     x + blockWidth / 2; 'right' -> the line ends at x + blockWidth. Canvas textAlign is used, no letter spacing,
//     no kerning overrides. Fill only (no stroke), colour = spec.color incl. alpha.
//   * Hit-test / layout box (textBox): { x, y, w: blockWidth (min 0.5 em), h: lines * size * lineHeight }.
//
// SHAPES  (ShapeSpec)  - fill is painted first, then the stroke on top of it.
//   * Stroke: centred on the outline (half the width inside, half outside), width in px, lineJoin = round (an SDF
//     band |d| <= width/2), 'enabled: false' draws nothing. Stroke colour alpha applies to the whole stroke.
//   * rect: box (x, y, w, h), corner `radius` clamped to min(w, h) / 2, circular corners. rotation about the box
//     centre (x + w/2, y + h/2).
//   * ellipse: inscribed in the box (x, y, w, h); rotation about the box centre.
//   * polygon: centre (cx, cy), `radius` = circumradius, `sides` (3..64, integer). Vertex k (k = 0..sides-1) lies at
//     angle theta_k = rotation - 90 deg + k * 360 / sides (screen coords, so vertex 0 points UP at rotation 0 and the
//     order is clockwise). innerRatio >= 1 -> regular polygon. innerRatio < 1 (min 0.05) -> a star with 2 * sides
//     vertices: vertex j (j = 0..2*sides-1) at angle rotation - 90 deg + j * 180 / sides, radius = radius for even
//     j (outer points, the same as the polygon vertices) and radius * innerRatio for odd j. Rotation is about
//     (cx, cy).
//   * line: from (x1, y1) to (x2, y2), stroke only (fill is ignored; it needs stroke.enabled). Butt ends, width =
//     stroke.width. Arrowheads (arrowStart at (x1,y1), arrowEnd at (x2,y2)) are filled isosceles triangles in the
//     stroke colour with the tip exactly on the end point: head length H = max(8, 4 * width) (shortened to
//     length / 2 when both ends have heads, or to the length when one does), half base width = 0.4 * H. The shaft
//     stops H / 2 inside the head (so there is no seam); shaft + heads are ONE union drawn with a single alpha.
//     A zero-length line draws nothing.
//   * Antialiasing: Canvas 2D default (about 1 px edge ramp).
//
// COMPOSITING: a text/shape layer renders to its own transparent layer first, then masks / opacity / blend apply
// exactly as for pixel layers.

import type { Rect, RGBA, ShapeFill, ShapeSpec, ShapeStroke, TextSpec } from './types';
import { createSurface, type Ctx2D, type Surface } from './surface';

export const ASCENT = 0.8;
export const MAX_TEXT = 20000;

export interface Pt { x: number; y: number }

const rgba = (c: RGBA): string => `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;
const fin = (n: unknown, d: number): number => (typeof n === 'number' && Number.isFinite(n) ? n : d);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// ---- sanitising / copying ----

function colour(c: unknown, d: RGBA): RGBA {
  const o = (c ?? {}) as Partial<RGBA>;
  return {
    r: Math.round(clamp(fin(o.r, d.r), 0, 255)), g: Math.round(clamp(fin(o.g, d.g), 0, 255)),
    b: Math.round(clamp(fin(o.b, d.b), 0, 255)), a: Math.round(clamp(fin(o.a, d.a), 0, 255)),
  };
}
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };

export function sanitizeText(s: TextSpec): TextSpec {
  return {
    text: String(s.text ?? '').slice(0, MAX_TEXT),
    font: String(s.font || 'sans-serif'),
    size: clamp(fin(s.size, 32), 1, 4000),
    color: colour(s.color, BLACK),
    align: s.align === 'center' || s.align === 'right' ? s.align : 'left',
    bold: !!s.bold,
    italic: !!s.italic,
    lineHeight: clamp(fin(s.lineHeight, 1.2), 0.2, 10),
    x: fin(s.x, 0),
    y: fin(s.y, 0),
    boxWidth: s.boxWidth === null || s.boxWidth === undefined ? null : Math.max(1, fin(s.boxWidth, 1)),
  };
}

function fill(f: unknown): ShapeFill {
  const o = (f ?? {}) as Partial<ShapeFill>;
  return { enabled: !!o.enabled, color: colour(o.color, BLACK) };
}
function stroke(s: unknown): ShapeStroke {
  const o = (s ?? {}) as Partial<ShapeStroke>;
  return { enabled: !!o.enabled, color: colour(o.color, BLACK), width: clamp(fin(o.width, 1), 0, 1000) };
}

export function sanitizeShape(s: ShapeSpec): ShapeSpec {
  const rot = fin((s as { rotation?: number }).rotation, 0);
  switch (s.type) {
    case 'rect':
    case 'ellipse': {
      let { x, y, w, h } = { x: fin(s.x, 0), y: fin(s.y, 0), w: fin(s.w, 0), h: fin(s.h, 0) };
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      if (s.type === 'rect') return { type: 'rect', x, y, w, h, radius: Math.max(0, fin(s.radius, 0)), fill: fill(s.fill), stroke: stroke(s.stroke), rotation: rot };
      return { type: 'ellipse', x, y, w, h, fill: fill(s.fill), stroke: stroke(s.stroke), rotation: rot };
    }
    case 'line':
      return { type: 'line', x1: fin(s.x1, 0), y1: fin(s.y1, 0), x2: fin(s.x2, 0), y2: fin(s.y2, 0), stroke: stroke(s.stroke), arrowStart: !!s.arrowStart, arrowEnd: !!s.arrowEnd };
    case 'polygon':
      return {
        type: 'polygon', cx: fin(s.cx, 0), cy: fin(s.cy, 0), radius: Math.max(0, fin(s.radius, 0)),
        sides: clamp(Math.round(fin(s.sides, 5)), 3, 64), innerRatio: clamp(fin(s.innerRatio, 1), 0.05, 1),
        fill: fill(s.fill), stroke: stroke(s.stroke), rotation: rot,
      };
    default:
      throw new RangeError(`unknown shape type ${String((s as { type?: unknown }).type)}`);
  }
}

export const cloneText = (s: TextSpec): TextSpec => ({ ...s, color: { ...s.color } });
export function cloneShape(s: ShapeSpec): ShapeSpec {
  return JSON.parse(JSON.stringify(s)) as ShapeSpec;
}
export const sameSpec = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Move a spec by (dx, dy) document pixels. */
export function translateText(s: TextSpec, dx: number, dy: number): TextSpec {
  return { ...s, color: { ...s.color }, x: s.x + dx, y: s.y + dy };
}
export function translateShape(s: ShapeSpec, dx: number, dy: number): ShapeSpec {
  const c = cloneShape(s);
  if (c.type === 'rect' || c.type === 'ellipse') { c.x += dx; c.y += dy; }
  else if (c.type === 'line') { c.x1 += dx; c.x2 += dx; c.y1 += dy; c.y2 += dy; }
  else { c.cx += dx; c.cy += dy; }
  return c;
}

// ---- text ----

let meter: Surface | null = null;
function measureCtx(): Ctx2D {
  if (!meter) meter = createSurface(1, 1);
  return meter.ctx;
}

export function fontString(s: TextSpec): string {
  const fam = s.font.includes(',') ? s.font : `"${s.font.replace(/"/g, '')}", sans-serif`;
  return `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${s.size}px ${fam}`;
}

export interface TextLayout {
  lines: string[];
  widths: number[];
  blockW: number;
  lineH: number;
}

export function layoutText(s: TextSpec): TextLayout {
  const c = measureCtx();
  c.font = fontString(s);
  const width = (t: string): number => c.measureText(t).width;
  const lines: string[] = [];
  for (const para of s.text.split('\n')) {
    if (s.boxWidth === null || para === '') { lines.push(para); continue; }
    const words = para.split(' ');
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
      const cand = `${cur} ${words[i]}`;
      if (width(cand) <= s.boxWidth) cur = cand;
      else { lines.push(cur); cur = words[i]; }
    }
    lines.push(cur);
  }
  const widths = lines.map(width);
  const widest = widths.reduce((a, b) => Math.max(a, b), 0);
  return { lines, widths, blockW: s.boxWidth ?? widest, lineH: s.size * s.lineHeight };
}

/** Distance from the top of a line box to its alphabetic baseline, in px (the convention in the header). */
export function textBaselineOffset(s: Pick<TextSpec, 'size' | 'lineHeight'>): number {
  return (s.size * s.lineHeight - s.size) / 2 + ASCENT * s.size;
}

/** Line pitch in px. */
export function textLinePitch(s: Pick<TextSpec, 'size' | 'lineHeight'>): number {
  return s.size * s.lineHeight;
}

/** The layout box of a text layer (hit testing, move). Min width half an em so empty text can still be clicked. */
export function textBox(s: TextSpec): Rect {
  const l = layoutText(s);
  return { x: s.x, y: s.y, w: Math.max(l.blockW, s.size * 0.5), h: l.lines.length * l.lineH };
}

/** Conservative integer bounds of everything the text can paint (ink may overhang the box). */
export function textBounds(s: TextSpec): Rect {
  const l = layoutText(s);
  const w = Math.max(l.blockW, ...l.widths, s.size * 0.5);
  const m = Math.ceil(s.size * 0.6 + Math.max(0, (s.size - l.lineH) / 2) + 2);
  const x = Math.floor(s.x - m);
  const y = Math.floor(s.y - m);
  return { x, y, w: Math.ceil(s.x + w + m) - x, h: Math.ceil(s.y + l.lines.length * l.lineH + m) - y };
}

export function drawText(ctx: Ctx2D, s: TextSpec): void {
  const l = layoutText(s);
  ctx.save();
  ctx.font = fontString(s);
  ctx.fillStyle = rgba(s.color);
  ctx.textAlign = s.align;
  ctx.textBaseline = 'alphabetic';
  const ax = s.align === 'left' ? s.x : s.align === 'center' ? s.x + l.blockW / 2 : s.x + l.blockW;
  const base = textBaselineOffset(s);
  for (let i = 0; i < l.lines.length; i++) {
    if (l.lines[i] !== '') ctx.fillText(l.lines[i], ax, s.y + i * l.lineH + base);
  }
  ctx.restore();
}

// ---- shapes ----

const rad = (d: number): number => (d * Math.PI) / 180;

/** Absolute (rotated) polygon / star vertices, clockwise on screen. */
export function polygonPoints(s: Extract<ShapeSpec, { type: 'polygon' }>): Pt[] {
  const pts: Pt[] = [];
  const star = s.innerRatio < 1;
  const count = star ? s.sides * 2 : s.sides;
  const step = star ? 180 / s.sides : 360 / s.sides;
  for (let j = 0; j < count; j++) {
    const a = rad(s.rotation - 90 + j * step);
    const r = star && j % 2 === 1 ? s.radius * s.innerRatio : s.radius;
    pts.push({ x: s.cx + Math.cos(a) * r, y: s.cy + Math.sin(a) * r });
  }
  return pts;
}

/** Line geometry: the shaft quad and the arrowhead triangles (all with positive orientation) for one nonzero fill. */
export function linePolys(s: Extract<ShapeSpec, { type: 'line' }>): Pt[][] {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return [];
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const w = s.stroke.width;
  const both = s.arrowStart && s.arrowEnd;
  const H = Math.min(Math.max(8, 4 * w), both ? len / 2 : len);
  const hw = 0.4 * H;
  const polys: Pt[][] = [];
  const startAt = s.arrowStart ? H / 2 : 0; // shaft begins/ends H/2 inside the head
  const endAt = len - (s.arrowEnd ? H / 2 : 0);
  if (w > 0 && endAt > startAt) {
    const a = { x: s.x1 + ux * startAt, y: s.y1 + uy * startAt };
    const b = { x: s.x1 + ux * endAt, y: s.y1 + uy * endAt };
    polys.push([
      { x: a.x + nx * w / 2, y: a.y + ny * w / 2 }, { x: b.x + nx * w / 2, y: b.y + ny * w / 2 },
      { x: b.x - nx * w / 2, y: b.y - ny * w / 2 }, { x: a.x - nx * w / 2, y: a.y - ny * w / 2 },
    ]);
  }
  const head = (tx: number, ty: number, sx: number, sy: number): void => {
    // tip (tx,ty); (sx,sy) is the unit vector from the tip back along the line
    const bx = tx + sx * H;
    const by = ty + sy * H;
    polys.push([{ x: tx, y: ty }, { x: bx - sy * hw, y: by + sx * hw }, { x: bx + sy * hw, y: by - sx * hw }]);
  };
  if (s.arrowEnd) head(s.x2, s.y2, -ux, -uy);
  if (s.arrowStart) head(s.x1, s.y1, ux, uy);
  // make every polygon the same orientation so the union fills under the nonzero rule
  return polys.map((p) => (area(p) < 0 ? p.slice().reverse() : p));
}

function area(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return a / 2;
}

function boxPath(ctx: Ctx2D, s: Extract<ShapeSpec, { type: 'rect' | 'ellipse' }>): void {
  ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
  ctx.rotate(rad(s.rotation));
  const hw = s.w / 2;
  const hh = s.h / 2;
  ctx.beginPath();
  if (s.type === 'ellipse') {
    ctx.ellipse(0, 0, Math.max(0, hw), Math.max(0, hh), 0, 0, Math.PI * 2);
    return;
  }
  const r = Math.min(s.radius, hw, hh);
  if (r <= 0) { ctx.rect(-hw, -hh, s.w, s.h); return; }
  ctx.moveTo(-hw + r, -hh);
  ctx.arcTo(hw, -hh, hw, hh, r);
  ctx.arcTo(hw, hh, -hw, hh, r);
  ctx.arcTo(-hw, hh, -hw, -hh, r);
  ctx.arcTo(-hw, -hh, hw, -hh, r);
  ctx.closePath();
}

export function drawShape(ctx: Ctx2D, s: ShapeSpec): void {
  ctx.save();
  if (s.type === 'line') {
    if (s.stroke.enabled) {
      ctx.fillStyle = rgba(s.stroke.color);
      ctx.beginPath();
      for (const p of linePolys(s)) {
        ctx.moveTo(p[0].x, p[0].y);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
        ctx.closePath();
      }
      ctx.fill('nonzero');
    }
    ctx.restore();
    return;
  }
  if (s.type === 'polygon') {
    ctx.beginPath();
    const pts = polygonPoints(s);
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  } else boxPath(ctx, s);
  if (s.fill.enabled) {
    ctx.fillStyle = rgba(s.fill.color);
    ctx.fill();
  }
  if (s.stroke.enabled && s.stroke.width > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = s.stroke.width;
    ctx.strokeStyle = rgba(s.stroke.color);
    ctx.stroke();
  }
  ctx.restore();
}

/** Conservative integer bounds of everything the shape can paint (stroke + antialiasing margin). */
export function shapeBounds(s: ShapeSpec): Rect {
  let pts: Pt[];
  let pad = 1.5;
  if (s.type === 'line') {
    pts = linePolys(s).flat();
    if (!pts.length) pts = [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
  } else {
    if (s.stroke.enabled) pad += s.stroke.width / 2;
    if (s.type === 'polygon') pts = polygonPoints(s);
    else {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const a = rad(s.rotation);
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => {
        const px = (i * s.w) / 2;
        const py = (j * s.h) / 2;
        return { x: cx + px * c - py * sn, y: cy + px * sn + py * c };
      });
    }
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.floor(Math.min(...xs) - pad);
  const y = Math.floor(Math.min(...ys) - pad);
  return { x, y, w: Math.ceil(Math.max(...xs) + pad) - x, h: Math.ceil(Math.max(...ys) + pad) - y };
}

/** Tight geometric box of a shape (ignores stroke width and rotation): what the transform box of the layer surrounds. */
export function shapeBox(s: ShapeSpec): Rect {
  switch (s.type) {
    case 'rect':
    case 'ellipse':
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    case 'line': {
      const x = Math.min(s.x1, s.x2);
      const y = Math.min(s.y1, s.y2);
      return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    }
    case 'polygon':
      return { x: s.cx - s.radius, y: s.cy - s.radius, w: 2 * s.radius, h: 2 * s.radius };
  }
}

/**
 * Scale a text / shape spec so that its box (textBox / shapeBox) goes from `from` to `to`.
 * Text: the position follows the box, the font size scales by the vertical factor (rounded to 0.01) and a wrap width by the
 * horizontal factor. Shapes: all coordinates map linearly; radius, polygon radius and stroke width scale by the geometric
 * mean of the two factors (a stroke has one width); ellipse / rect corner radius likewise. Degenerate source boxes (zero
 * width or height) keep their size on that axis and only move.
 */
export function scaleSpec<T extends TextSpec | ShapeSpec>(spec: T, from: Rect, to: Rect): T {
  const fx = from.w > 1e-9 ? to.w / from.w : 1;
  const fy = from.h > 1e-9 ? to.h / from.h : 1;
  const g = Math.sqrt(Math.abs(fx * fy));
  const mx = (x: number): number => to.x + (x - from.x) * fx;
  const my = (y: number): number => to.y + (y - from.y) * fy;
  if (!('type' in spec)) {
    const t = spec as TextSpec;
    return { ...t, color: { ...t.color }, x: mx(t.x), y: my(t.y), size: Math.min(4000, Math.max(1, Math.round(t.size * fy * 100) / 100)), boxWidth: t.boxWidth === null ? null : Math.max(1, t.boxWidth * fx) } as T;
  }
  const c = cloneShape(spec as ShapeSpec);
  if (c.type === 'rect' || c.type === 'ellipse') {
    c.x = mx(c.x); c.y = my(c.y); c.w *= fx; c.h *= fy;
    if (c.type === 'rect') c.radius *= g;
  } else if (c.type === 'line') {
    c.x1 = mx(c.x1); c.x2 = mx(c.x2); c.y1 = my(c.y1); c.y2 = my(c.y2);
  } else {
    c.cx = mx(c.cx); c.cy = my(c.cy); c.radius *= g;
  }
  c.stroke.width *= g;
  return c as T;
}
