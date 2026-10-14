// The only place canvases are created, so the OffscreenCanvas / HTMLCanvasElement choice lives here.
export type Canvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Surface {
  readonly canvas: Canvas;
  readonly ctx: Ctx2D;
  readonly width: number;
  readonly height: number;
}

let forceDom = false;
/** Test hook: force the HTMLCanvasElement fallback. */
export function setForceDomCanvas(v: boolean): void {
  forceDom = v;
}

/** `readback` marks surfaces that are read with getImageData often (software-backed canvas). */
export function createSurface(width: number, height: number, readback = false): Surface {
  let canvas: Canvas;
  if (!forceDom && typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: readback }) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  return { canvas, ctx, width, height };
}

/** New surface of the given size with the old content drawn at the top-left. */
export function resizedCopy(old: Surface, width: number, height: number, readback = false): Surface {
  const s = createSurface(width, height, readback);
  s.ctx.drawImage(old.canvas as CanvasImageSource, 0, 0);
  return s;
}

export function releaseSurface(s: Surface): void {
  s.canvas.width = 0;
  s.canvas.height = 0;
}

export function clearRect(s: Surface, r: { x: number; y: number; w: number; h: number }): void {
  s.ctx.clearRect(r.x, r.y, r.w, r.h);
}
