import type { Rect, RGBA } from './types';

export interface FillResult {
  rect: Rect; // bounding box of the filled region
  mask: Uint8Array; // w*h, 1 where filled
}

/** Contiguous scanline fill from (sx,sy). A pixel matches when every channel (incl. alpha) is within `tolerance` of the seed. */
export function floodFill(data: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tolerance: number): FillResult | null {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const si = (sy * w + sx) * 4;
  const r0 = data[si], g0 = data[si + 1], b0 = data[si + 2], a0 = data[si + 3];
  const mask = new Uint8Array(w * h);
  const matches = (p: number): boolean => {
    const i = p * 4;
    return mask[p] === 0
      && Math.abs(data[i] - r0) <= tolerance && Math.abs(data[i + 1] - g0) <= tolerance
      && Math.abs(data[i + 2] - b0) <= tolerance && Math.abs(data[i + 3] - a0) <= tolerance;
  };
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    if (!matches(y * w + x)) continue;
    let l = x;
    while (l > 0 && matches(y * w + l - 1)) l--;
    let r = x;
    while (r < w - 1 && matches(y * w + r + 1)) r++;
    for (let i = l; i <= r; i++) mask[y * w + i] = 1;
    if (l < minX) minX = l;
    if (r > maxX) maxX = r;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inSpan = false;
      for (let i = l; i <= r; i++) {
        const m = matches(ny * w + i);
        if (m && !inSpan) stack.push(i, ny);
        inSpan = m;
      }
    }
  }
  return { rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, mask };
}

/** Copy `rect` out of a w-wide RGBA buffer. */
export function cropData(data: Uint8ClampedArray, w: number, rect: Rect): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const s = ((rect.y + y) * w + rect.x) * 4;
    out.set(data.subarray(s, s + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

/** Paint `color` into `crop` (the rect-sized crop of a w-wide buffer) wherever `mask` is set. */
export function paintMasked(crop: Uint8ClampedArray, w: number, rect: Rect, mask: Uint8Array, color: RGBA): void {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (!mask[(rect.y + y) * w + rect.x + x]) continue;
      const i = (y * rect.w + x) * 4;
      crop[i] = color.r;
      crop[i + 1] = color.g;
      crop[i + 2] = color.b;
      crop[i + 3] = color.a;
    }
  }
}
