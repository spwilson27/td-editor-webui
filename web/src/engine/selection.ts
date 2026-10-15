// Selection masks (docs/DESIGN_V3.md section 2.1). Pure typed-array code: no DOM, testable in node.
//
// A selection is `SelState`: its bounding rect plus an optional document-sized coverage mask (Uint8, 0..255).
//   * rect === null            -> nothing selected.
//   * rect !== null, alpha null -> the rect is fully selected (coverage 255 inside, 0 outside); the fast path for
//                                  marquee selections and select-all.
//   * alpha !== null           -> alpha[y * width + x] is the coverage; `rect` is the exact bounding box of the
//                                  non-zero coverage.
// SelState values are immutable: operations return new arrays, so history can keep references.
//
// Conventions (documented for tests and the UI):
//   * Combining (fuzzy logic on coverage):  add = max(a, b), subtract = min(a, 255 - b), intersect = min(a, b).
//     With no current selection: add = new, intersect = new, subtract = nothing.
//   * Feather: gaussian blur of the shape mask with sigma = radius / 3 px (true kernel for sigma < 2, three box
//     blurs otherwise; kernel reach <= radius + 1 px, so every radius gives a distinct, monotonic softness). A hard edge becomes ~50 % at the original edge and ~0 / ~255 one
//     radius away. The window is bounded to rect + radius; document borders replicate the edge value.
//     The new shape is feathered first, then combined with the existing selection.
//   * Lasso polygons use the NON-ZERO winding rule (like Canvas 2D `fill()`); with antialias on, coverage is the
//     exact horizontal span overlap averaged over 16 sub-scanlines per pixel row, off = pixel-centre sampling.
//   * Outline (`tracePath`): the 50 % contour (coverage >= 128) as pixel-edge loops, clockwise for outer boundaries
//     (screen coordinates), collinear points removed, staircases simplified with Douglas-Peucker (epsilon 0.75 px)
//     for loops over 256 points.

import type { Rect, SelectionMode } from './types';

export interface SelState {
  rect: Rect | null;
  alpha: Uint8Array | null;
}
export const NO_SEL: SelState = { rect: null, alpha: null };

export interface Pt { x: number; y: number }

const containsRect = (a: Rect, b: Rect): boolean => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const interRect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
};
const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export function rectSel(r: Rect | null): SelState {
  return r && r.w > 0 && r.h > 0 ? { rect: { ...r }, alpha: null } : NO_SEL;
}

/** Document-sized coverage for a state (a fresh array when the state is rect-only). */
export function materialize(s: SelState, w: number, h: number): Uint8Array {
  if (s.alpha) return s.alpha;
  const out = new Uint8Array(w * h);
  if (s.rect) fillRect(out, w, s.rect);
  return out;
}

function fillRect(a: Uint8Array, w: number, r: Rect): void {
  for (let y = r.y; y < r.y + r.h; y++) a.fill(255, y * w + r.x, y * w + r.x + r.w);
}

/** Exact bounding box of the non-zero coverage inside `win` (null = empty). */
export function boundsOfAlpha(alpha: Uint8Array, w: number, win: Rect): Rect | null {
  let minX = win.x + win.w;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  for (let y = win.y; y < win.y + win.h; y++) {
    const row = y * w;
    let l = win.x;
    const end = win.x + win.w;
    while (l < end && alpha[row + l] === 0) l++;
    if (l === end) continue;
    let r = end - 1;
    while (alpha[row + r] === 0) r--;
    if (minY < 0) minY = y;
    maxY = y;
    if (l < minX) minX = l;
    if (r > maxX) maxX = r;
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Combine the current selection with a new shape. See the header for the rules. */
export function combine(base: SelState, shape: SelState, mode: SelectionMode, w: number, h: number): SelState {
  if (!shape.rect) return mode === 'new' || mode === 'intersect' ? NO_SEL : base;
  if (mode === 'new' || !base.rect) return mode === 'subtract' ? NO_SEL : shape;
  const A = base.rect;
  const B = shape.rect;
  const bothRect = !base.alpha && !shape.alpha;
  if (mode === 'add') {
    if (bothRect && containsRect(A, B)) return base;
    if (bothRect && containsRect(B, A)) return shape;
    const out = base.alpha ? base.alpha.slice() : materialize(base, w, h);
    for (let y = B.y; y < B.y + B.h; y++) {
      const o = y * w;
      if (shape.alpha) {
        const sa = shape.alpha;
        for (let x = B.x; x < B.x + B.w; x++) if (sa[o + x] > out[o + x]) out[o + x] = sa[o + x];
      } else out.fill(255, o + B.x, o + B.x + B.w);
    }
    return { rect: unionRect(A, B), alpha: out };
  }
  const I = interRect(A, B);
  if (mode === 'subtract') {
    if (!I) return base;
    if (bothRect && containsRect(B, A)) return NO_SEL;
    const out = base.alpha ? base.alpha.slice() : materialize(base, w, h);
    for (let y = I.y; y < I.y + I.h; y++) {
      const o = y * w;
      for (let x = I.x; x < I.x + I.w; x++) {
        const inv = 255 - (shape.alpha ? shape.alpha[o + x] : 255);
        if (inv < out[o + x]) out[o + x] = inv;
      }
    }
    const rect = boundsOfAlpha(out, w, A);
    return rect ? { rect, alpha: out } : NO_SEL;
  }
  // intersect
  if (!I) return NO_SEL;
  if (bothRect) return { rect: I, alpha: null };
  const out = new Uint8Array(w * h);
  for (let y = I.y; y < I.y + I.h; y++) {
    const o = y * w;
    for (let x = I.x; x < I.x + I.w; x++) {
      const a = base.alpha ? base.alpha[o + x] : 255;
      const b = shape.alpha ? shape.alpha[o + x] : 255;
      out[o + x] = a < b ? a : b;
    }
  }
  const rect = boundsOfAlpha(out, w, I);
  return rect ? { rect, alpha: out } : NO_SEL;
}

/** 255 - coverage over the whole document (null when everything ends up unselected). */
export function invert(s: SelState, w: number, h: number): SelState {
  if (!s.rect) return NO_SEL;
  if (!s.alpha && s.rect.x === 0 && s.rect.y === 0 && s.rect.w === w && s.rect.h === h) return NO_SEL;
  const src = materialize(s, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 255 - src[i];
  const rect = boundsOfAlpha(out, w, { x: 0, y: 0, w, h });
  return rect ? { rect, alpha: out } : NO_SEL;
}

export function selectAllState(w: number, h: number): SelState {
  return { rect: { x: 0, y: 0, w, h }, alpha: null };
}

/** Keep the old content top-left in a new w2 x h2 document. */
export function resizeSel(s: SelState, w: number, w2: number, h2: number): SelState {
  if (!s.rect) return s;
  const win = interRect(s.rect, { x: 0, y: 0, w: w2, h: h2 });
  if (!win) return NO_SEL;
  if (!s.alpha) return { rect: win, alpha: null };
  const out = new Uint8Array(w2 * h2);
  for (let y = win.y; y < win.y + win.h; y++) out.set(s.alpha.subarray(y * w + win.x, y * w + win.x + win.w), y * w2 + win.x);
  const rect = boundsOfAlpha(out, w2, win);
  return rect ? { rect, alpha: out } : NO_SEL;
}

// ---- feather ----

function boxSizes(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => (i < m ? wl : wu));
}

/** Gaussian-ish feather of the shape, bounded to rect + radius. */
export function feather(s: SelState, radius: number, w: number, h: number): SelState {
  if (!s.rect || !(radius > 0)) return s;
  const sigma = radius / 3;
  // small radii: a true gaussian kernel (box approximations cannot resolve sigma < 1 and made radii 1..3 identical)
  const kernel = sigma < 2 ? gaussKernel(sigma) : null;
  const sizes = kernel ? [] : boxSizes(sigma);
  const reach = kernel ? (kernel.length - 1) / 2 : sizes.reduce((a, b) => a + (b - 1) / 2, 0);
  const grow = Math.ceil(reach) + 1;
  const win = interRect({ x: s.rect.x - grow, y: s.rect.y - grow, w: s.rect.w + 2 * grow, h: s.rect.h + 2 * grow }, { x: 0, y: 0, w, h }) as Rect;
  const ww = win.w;
  const wh = win.h;
  let a = new Float32Array(ww * wh);
  let b = new Float32Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    const o = (win.y + y) * w + win.x;
    for (let x = 0; x < ww; x++) {
      const inRect = x + win.x >= s.rect.x && x + win.x < s.rect.x + s.rect.w && y + win.y >= s.rect.y && y + win.y < s.rect.y + s.rect.h;
      a[y * ww + x] = s.alpha ? s.alpha[o + x] : inRect ? 255 : 0;
    }
  }
  const edgeL = win.x === 0;
  const edgeR = win.x + win.w === w;
  const edgeT = win.y === 0;
  const edgeB = win.y + win.h === h;
  if (kernel) {
    convRows(a, b, ww, wh, kernel, edgeL, edgeR);
    convCols(b, a, ww, wh, kernel, edgeT, edgeB);
  }
  for (const size of sizes) {
    const half = (size - 1) / 2;
    if (half < 1) continue;
    boxRows(a, b, ww, wh, half, edgeL, edgeR);
    boxCols(b, a, ww, wh, half, edgeT, edgeB);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < wh; y++) {
    const o = (win.y + y) * w + win.x;
    for (let x = 0; x < ww; x++) out[o + x] = Math.round(a[y * ww + x]);
  }
  const rect = boundsOfAlpha(out, w, win);
  return rect ? { rect, alpha: out } : NO_SEL;
}

function gaussKernel(sigma: number): Float32Array {
  const half = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * half + 1);
  let sum = 0;
  for (let i = -half; i <= half; i++) sum += (k[i + half] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function convRows(src: Float32Array, dst: Float32Array, ww: number, wh: number, k: Float32Array, edgeL: boolean, edgeR: boolean): void {
  const half = (k.length - 1) / 2;
  for (let y = 0; y < wh; y++) {
    const o = y * ww;
    for (let x = 0; x < ww; x++) {
      let acc = 0;
      for (let j = -half; j <= half; j++) {
        const i = x + j;
        const v = i < 0 ? (edgeL ? src[o] : 0) : i >= ww ? (edgeR ? src[o + ww - 1] : 0) : src[o + i];
        acc += k[j + half] * v;
      }
      dst[o + x] = acc;
    }
  }
}

function convCols(src: Float32Array, dst: Float32Array, ww: number, wh: number, k: Float32Array, edgeT: boolean, edgeB: boolean): void {
  const half = (k.length - 1) / 2;
  for (let y = 0; y < wh; y++) {
    const o = y * ww;
    dst.fill(0, o, o + ww);
    for (let j = -half; j <= half; j++) {
      const r = y + j;
      const row = r < 0 ? (edgeT ? 0 : -1) : r >= wh ? (edgeB ? wh - 1 : -1) : r;
      if (row < 0) continue;
      const w = k[j + half];
      const p = row * ww;
      for (let x = 0; x < ww; x++) dst[o + x] += w * src[p + x];
    }
  }
}

function boxRows(src: Float32Array, dst: Float32Array, ww: number, wh: number, half: number, edgeL: boolean, edgeR: boolean): void {
  const size = 2 * half + 1;
  for (let y = 0; y < wh; y++) {
    const o = y * ww;
    const first = src[o];
    const last = src[o + ww - 1];
    const get = (i: number): number => (i < 0 ? (edgeL ? first : 0) : i >= ww ? (edgeR ? last : 0) : src[o + i]);
    let sum = 0;
    for (let j = -half; j <= half; j++) sum += get(j);
    for (let x = 0; x < ww; x++) {
      dst[o + x] = sum / size;
      sum += get(x + half + 1) - get(x - half);
    }
  }
}

function boxCols(src: Float32Array, dst: Float32Array, ww: number, wh: number, half: number, edgeT: boolean, edgeB: boolean): void {
  const size = 2 * half + 1;
  const sum = new Float64Array(ww);
  const row = (y: number): number => (y < 0 ? (edgeT ? 0 : -1) : y >= wh ? (edgeB ? wh - 1 : -1) : y) ;
  for (let j = -half; j <= half; j++) {
    const r = row(j);
    if (r < 0) continue;
    const o = r * ww;
    for (let x = 0; x < ww; x++) sum[x] += src[o + x];
  }
  for (let y = 0; y < wh; y++) {
    const o = y * ww;
    for (let x = 0; x < ww; x++) dst[o + x] = sum[x] / size;
    const add = row(y + half + 1);
    const sub = row(y - half);
    if (add >= 0) for (let x = 0, p = add * ww; x < ww; x++) sum[x] += src[p + x];
    if (sub >= 0) for (let x = 0, p = sub * ww; x < ww; x++) sum[x] -= src[p + x];
  }
}

// ---- lasso polygon ----

const SUB = 16;

/** Fill a polygon (non-zero winding), clipped to the document. */
export function fillPolygon(pts: ReadonlyArray<Pt>, w: number, h: number, antialias: boolean): SelState {
  const n = pts.length;
  if (n < 3) return NO_SEL;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return NO_SEL;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h, Math.ceil(maxY));
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(w, Math.ceil(maxX));
  if (y1 <= y0 || x1 <= x0) return NO_SEL;
  const S = antialias ? SUB : 1;
  const nsub = (y1 - y0) * S;
  const subY = (j: number): number => y0 + (j + 0.5) / S;
  const first = (y: number): number => Math.ceil((y - y0) * S - 0.5);
  const counts = new Int32Array(nsub + 1);
  const spans: Array<[number, number, number, number]> = []; // [jStart, jEnd, edge index, dir]
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    if (p.y === q.y) continue;
    const lo = p.y < q.y ? p.y : q.y;
    const hi = p.y < q.y ? q.y : p.y;
    const j0 = Math.max(0, first(lo));
    const j1 = Math.min(nsub - 1, first(hi) - 1);
    if (j1 < j0) continue;
    spans.push([j0, j1, i, q.y > p.y ? 1 : -1]);
    for (let j = j0; j <= j1; j++) counts[j + 1]++;
  }
  for (let j = 0; j < nsub; j++) counts[j + 1] += counts[j];
  const total = counts[nsub];
  const xs = new Float32Array(total);
  const ds = new Int8Array(total);
  const fillPos = counts.slice(0, nsub);
  for (const [j0, j1, i, dir] of spans) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const slope = (q.x - p.x) / (q.y - p.y);
    for (let j = j0; j <= j1; j++) {
      const k = fillPos[j]++;
      xs[k] = p.x + (subY(j) - p.y) * slope;
      ds[k] = dir;
    }
  }
  const alpha = new Uint8Array(w * h);
  const acc = new Float32Array(w + 2);
  const diff = new Float32Array(w + 2);
  const wt = 1 / S;
  const addSpan = (xa: number, xb: number): void => {
    if (xa < 0) xa = 0;
    if (xb > w) xb = w;
    if (xb <= xa) return;
    if (!antialias) {
      const ia = Math.ceil(xa - 0.5);
      const ib = Math.ceil(xb - 0.5);
      if (ib > ia) { diff[ia] += 1; diff[ib] -= 1; }
      return;
    }
    const ia = Math.floor(xa);
    const ib = Math.floor(xb);
    if (ia === ib) acc[ia] += (xb - xa) * wt;
    else {
      acc[ia] += (ia + 1 - xa) * wt;
      acc[ib] += (xb - ib) * wt;
      diff[ia + 1] += wt;
      diff[ib] -= wt;
    }
  };
  for (let row = 0; row < y1 - y0; row++) {
    let any = false;
    for (let s = 0; s < S; s++) {
      const j = row * S + s;
      const a = counts[j];
      const b = counts[j + 1];
      if (b - a < 2) continue;
      // insertion sort by x (crossing counts per scanline are small)
      for (let i = a + 1; i < b; i++) {
        const x = xs[i];
        const d = ds[i];
        let k = i - 1;
        while (k >= a && xs[k] > x) { xs[k + 1] = xs[k]; ds[k + 1] = ds[k]; k--; }
        xs[k + 1] = x;
        ds[k + 1] = d;
      }
      let wind = 0;
      for (let i = a; i < b - 1; i++) {
        wind += ds[i];
        if (wind !== 0) { addSpan(xs[i], xs[i + 1]); any = true; }
      }
    }
    if (!any) continue;
    const o = (y0 + row) * w;
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += diff[x];
      const c = acc[x] + run;
      if (c > 0.0005) alpha[o + x] = c >= 0.9995 ? 255 : Math.round(c * 255);
      acc[x] = 0;
      diff[x] = 0;
    }
    acc[w] = acc[w + 1] = diff[w] = diff[w + 1] = 0;
  }
  const rect = boundsOfAlpha(alpha, w, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  return rect ? { rect, alpha } : NO_SEL;
}

// ---- magic wand ----

/**
 * Select pixels whose every channel (incl. alpha) is within `tol` of the seed pixel. `data` is document-sized
 * straight RGBA. Contiguous = 4-connected flood from the seed. Coverage is 0 / 255.
 */
export function wandSelect(data: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tol: number, contiguous: boolean): SelState {
  if (!(sx >= 0 && sy >= 0 && sx < w && sy < h)) return NO_SEL;
  const t = Math.max(0, Math.min(255, Math.round(tol)));
  const si = (sy * w + sx) * 4;
  const r0 = data[si], g0 = data[si + 1], b0 = data[si + 2], a0 = data[si + 3];
  const rl = r0 - t, rh = r0 + t, gl = g0 - t, gh = g0 + t, bl = b0 - t, bh = b0 + t, al = a0 - t, ah = a0 + t;
  const out = new Uint8Array(w * h);
  let minX = w, maxX = -1, minY = h, maxY = -1;
  if (!contiguous) {
    for (let y = 0; y < h; y++) {
      let i = y * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (r >= rl && r <= rh && g >= gl && g <= gh && b >= bl && b <= bh && a >= al && a <= ah) {
          out[y * w + x] = 255;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  } else {
    let stack = new Int32Array(1024);
    let sp = 0;
    const push = (x: number, y: number): void => {
      if (sp + 2 > stack.length) { const n = new Int32Array(stack.length * 2); n.set(stack); stack = n; }
      stack[sp++] = x;
      stack[sp++] = y;
    };
    const ok = (p: number): boolean => {
      if (out[p] !== 0) return false;
      const i = p * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      return r >= rl && r <= rh && g >= gl && g <= gh && b >= bl && b <= bh && a >= al && a <= ah;
    };
    push(sx, sy);
    while (sp > 0) {
      const y = stack[--sp];
      const x = stack[--sp];
      if (!ok(y * w + x)) continue;
      let l = x;
      while (l > 0 && ok(y * w + l - 1)) l--;
      let r = x;
      while (r < w - 1 && ok(y * w + r + 1)) r++;
      out.fill(255, y * w + l, y * w + r + 1);
      if (l < minX) minX = l;
      if (r > maxX) maxX = r;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let k = 0; k < 2; k++) {
        const ny = k === 0 ? y - 1 : y + 1;
        if (ny < 0 || ny >= h) continue;
        let inSpan = false;
        const base = ny * w;
        for (let i = l; i <= r; i++) {
          const m = ok(base + i);
          if (m && !inSpan) push(i, ny);
          inSpan = m;
        }
      }
    }
  }
  return maxX < 0 ? NO_SEL : { rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, alpha: out };
}

// ---- outline ----

const TURNS = [1, 0, 3]; // right, straight, left
const DX = [1, 0, -1, 0]; // E S W N
const DY = [0, 1, 0, -1];

/** Marching-ants outline: closed loops of corner points in document pixel-edge coordinates. */
export function tracePath(s: SelState, w: number): Pt[][] {
  const r = s.rect;
  if (!r) return [];
  if (!s.alpha) return [[{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]];
  const alpha = s.alpha;
  const rw = r.w;
  const rh = r.h;
  const vw = rw + 1;
  const V = new Uint8Array(vw * (rh + 1)); // bit d set: an edge leaves this vertex in direction d
  let prev = new Uint8Array(rw + 2);
  let cur = new Uint8Array(rw + 2);
  for (let y = 0; y <= rh; y++) {
    if (y < rh) {
      const o = (r.y + y) * w + r.x;
      for (let x = 0; x < rw; x++) cur[x + 1] = alpha[o + x] >= 128 ? 1 : 0;
      cur[0] = 0;
      cur[rw + 1] = 0;
    } else cur.fill(0);
    for (let x = 0; x <= rw; x++) {
      const b = cur[x + 1];
      if (b !== prev[x + 1]) {
        if (b) V[y * vw + x] |= 1; // top edge of an inside cell: east
        else V[y * vw + x + 1] |= 4; // bottom edge of the inside cell above: west
      }
      if (b !== cur[x]) {
        if (b) V[(y + 1) * vw + x] |= 8; // left edge of an inside cell: north (the last row has no cells below)
        else V[y * vw + x] |= 2; // right edge of the inside cell to the left: south
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  const loops: Pt[][] = [];
  for (let v0 = 0; v0 < V.length; v0++) {
    while (V[v0] !== 0) {
      const bits = V[v0];
      let d0 = 0;
      while (!(bits & (1 << d0))) d0++;
      const pts: Pt[] = [];
      let v = v0;
      let d = d0;
      let steps = 0;
      for (;;) {
        if (steps > 0 && v === v0 && d === d0) break;
        V[v] &= ~(1 << d);
        const vx = v % vw;
        const vy = (v - vx) / vw;
        const nv = (vy + DY[d]) * vw + vx + DX[d];
        steps++;
        const nb = V[nv];
        // choose the next direction: right turn, straight, left turn
        let nd = -1;
        for (const turn of TURNS) {
          const c = (d + turn) & 3;
          if (nb & (1 << c) || (nv === v0 && c === d0)) { nd = c; break; }
        }
        if (nd < 0) { v = nv; break; } // cannot happen for closed boundaries
        if (nd !== d) pts.push({ x: r.x + (nv % vw), y: r.y + (nv - (nv % vw)) / vw });
        v = nv;
        d = nd;
      }
      if (pts.length >= 3) loops.push(pts.length > 256 ? simplifyClosed(pts, 0.75) : pts);
    }
  }
  return loops;
}

/** Douglas-Peucker on a closed loop, anchored at point 0 and the point farthest from it. */
function simplifyClosed(p: Pt[], eps: number): Pt[] {
  const n = p.length;
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[i].x - p[0].x) ** 2 + (p[i].y - p[0].y) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const stack: Array<[number, number]> = [[0, far], [far, n]]; // second chain wraps to index 0 (== n)
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    if (b - a < 2) continue;
    const pa = p[a % n];
    const pb = p[b % n];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let md = -1;
    let mi = -1;
    for (let i = a + 1; i < b; i++) {
      const q = p[i % n];
      const d = Math.abs((q.x - pa.x) * dy - (q.y - pa.y) * dx) / len;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) {
      keep[mi % n] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i]);
  return out;
}
