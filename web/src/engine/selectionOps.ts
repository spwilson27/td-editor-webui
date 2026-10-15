// Select > Grow / Shrink / Smooth / Feather / Border (docs/DESIGN_V5.md §1). Pure functions on SelState.
//
//  grow(r)    grayscale dilation by the disc of radius r (pixel centres: dx^2 + dy^2 <= r^2); outside the document counts as 0
//  shrink(r)  grayscale erosion by the same disc; outside the document counts as selected (the canvas edge does not erode)
//  smooth(r)  gaussian blur (sigma = r / 3, the feather kernel) followed by a steep ramp about 50 % (x4): corners round off with
//             radius ~r, straight edges and half-covered boundary pixels stay put, the edge stays antialiased
//  border(w)  band of total width w straddling the old edge: min(grow(ceil(w/2)), 1 - shrink(floor(w/2)))
//  feather(r) selection.feather
import type { Rect } from './types';
import { boundsOfAlpha, feather, materialize, NO_SEL, type SelState } from './selection';

export type SelOp = 'grow' | 'shrink' | 'smooth' | 'feather' | 'border';

export const MAX_SEL_PX = 200;

/** Sliding-window extreme (max or min) of the row segment src[off .. off+n), half width `hw`; reads src[off-hw .. off+n+hw) (the caller pads). */
function slide(src: Uint8Array, off: number, n: number, hw: number, isMax: boolean, dst: Uint8Array, dq: Int32Array): void {
  let head = 0;
  let tail = 0;
  for (let i = -hw; i < n + hw; i++) {
    const v = src[off + i];
    if (isMax) while (tail > head && v >= src[off + dq[tail - 1]]) tail--;
    else while (tail > head && v <= src[off + dq[tail - 1]]) tail--;
    dq[tail++] = i;
    const x = i - hw; // output index whose window [x-hw, x+hw] ends at i
    if (x >= 0 && x < n) {
      while (dq[head] < x - hw) head++;
      dst[x] = src[off + dq[head]];
    }
  }
}

/** Disc max / min filter of the window `win` of the w x h array `a` (which must extend r beyond the window on every side). */
function morph(a: Uint8Array, w: number, h: number, win: Rect, r: number, isMax: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const hws = new Int32Array(2 * r + 1);
  for (let dy = -r; dy <= r; dy++) hws[dy + r] = Math.floor(Math.sqrt(r * r - dy * dy) + 1e-9);
  const row = new Uint8Array(win.w);
  const acc = new Uint8Array(win.w);
  const dq = new Int32Array(win.w + 2 * r + 2);
  for (let y = win.y; y < win.y + win.h; y++) {
    acc.fill(isMax ? 0 : 255);
    for (let dy = -r; dy <= r; dy++) {
      slide(a, (y + dy) * w + win.x, win.w, hws[dy + r], isMax, row, dq);
      if (isMax) for (let x = 0; x < win.w; x++) { if (row[x] > acc[x]) acc[x] = row[x]; }
      else for (let x = 0; x < win.w; x++) { if (row[x] < acc[x]) acc[x] = row[x]; }
    }
    out.set(acc, y * w + win.x);
  }
  return out;
}

function windowOf(s: SelState, r: number, w: number, h: number, grow: boolean): Rect {
  const b = s.rect as Rect;
  const m = grow ? r : 0;
  const x0 = Math.max(0, b.x - m);
  const y0 = Math.max(0, b.y - m);
  const x1 = Math.min(w, b.x + b.w + m);
  const y1 = Math.min(h, b.y + b.h + m);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function finish(out: Uint8Array, w: number, h: number): SelState {
  const rect = boundsOfAlpha(out, w, { x: 0, y: 0, w, h });
  return rect ? { rect, alpha: out } : NO_SEL;
}

function growSel(s: SelState, r: number, w: number, h: number): SelState {
  if (!s.rect) return s;
  // note: the window clips at the document; the window is padded by r on each side, so a sliding window never needs data beyond it
  const a = materialize(s, w, h);
  const win = windowOf(s, r, w, h, true);
  return finish(morphPadded(a, w, h, win, r, true), w, h);
}

function shrinkSel(s: SelState, r: number, w: number, h: number): SelState {
  if (!s.rect) return s;
  const a = materialize(s, w, h);
  const win = windowOf(s, r, w, h, false);
  const eroded = morphPadded(a, w, h, win, r, false);
  // pixels outside the old bounds were 0 and stay 0: `morph` only wrote the window
  return finish(eroded, w, h);
}

/**
 * `morph` reads source rows inside the window only; a disc reaching past the window must still see the real neighbours. Run it
 * on a copy of the data padded by r on all sides (real data where it exists in the document, the outside value elsewhere).
 */
function morphPadded(a: Uint8Array, w: number, h: number, win: Rect, r: number, isMax: boolean): Uint8Array {
  const pw = win.w + 2 * r;
  const ph = win.h + 2 * r;
  const pad = isMax ? 0 : 255;
  const p = new Uint8Array(pw * ph).fill(pad);
  for (let y = 0; y < ph; y++) {
    const sy = win.y - r + y;
    if (sy < 0 || sy >= h) continue;
    const x0 = Math.max(0, win.x - r);
    const x1 = Math.min(w, win.x + win.w + r);
    p.set(a.subarray(sy * w + x0, sy * w + x1), y * pw + (x0 - (win.x - r)));
  }
  const res = morph(p, pw, ph, { x: r, y: r, w: win.w, h: win.h }, r, isMax);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < win.h; y++) out.set(res.subarray((y + r) * pw + r, (y + r) * pw + r + win.w), (win.y + y) * w + win.x);
  return out;
}

export function modifySel(s: SelState, op: SelOp, px: number, w: number, h: number): SelState {
  if (!s.rect) return s;
  const r = Math.min(MAX_SEL_PX, Math.max(0, Math.round(px)));
  if (op === 'feather') return feather(s, Math.min(500, Math.max(0, px)), w, h);
  if (r < 1) return s;
  if (op === 'grow') return growSel(s, r, w, h);
  if (op === 'shrink') return shrinkSel(s, r, w, h);
  if (op === 'smooth') {
    const f = feather(s, r, w, h);
    if (!f.rect || !f.alpha) return NO_SEL;
    const a = f.alpha;
    const out = new Uint8Array(w * h);
    const b = f.rect;
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const v = a[y * w + x];
        if (v) out[y * w + x] = Math.min(255, Math.max(0, Math.round((v - 127.5) * 4 + 127.5)));
      }
    }
    return finish(out, w, h);
  }
  // border
  const outer = Math.ceil(r / 2);
  const inner = Math.floor(r / 2);
  const dil = growSel(s, outer, w, h);
  if (!dil.rect) return NO_SEL;
  const ero = inner > 0 ? shrinkSel(s, inner, w, h) : s;
  const da = materialize(dil, w, h);
  const ea = ero.rect ? materialize(ero, w, h) : null;
  const out = new Uint8Array(w * h);
  const b = dil.rect;
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const i = y * w + x;
      out[i] = Math.min(da[i], ea ? 255 - ea[i] : 255);
    }
  }
  return finish(out, w, h);
}
