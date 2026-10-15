import type { Effect, RGBA, Rect } from '../../src/engine/types';
import { applyEffects as applyFx } from '../../src/engine/effects';
import { createSurface, type Surface } from '../../src/engine/surface';

export const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
export const black: RGBA = { r: 0, g: 0, b: 0, a: 255 };
export const white: RGBA = { r: 255, g: 255, b: 255, a: 255 };

export type Px = [number, number, number, number];

/** Surface filled by f(x, y) -> straight rgba 0..255. */
export function makeSurface(w: number, h: number, f: (x: number, y: number) => Px): Surface {
  const s = createSurface(w, h, true);
  const img = s.ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = f(x, y);
      img.data.set(p, (y * w + x) * 4);
    }
  }
  s.ctx.putImageData(img, 0, 0);
  return s;
}

export function square(w: number, h: number, x0: number, y0: number, x1: number, y1: number, c: Px = [255, 0, 0, 255]): Surface {
  return makeSurface(w, h, (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? c : [0, 0, 0, 0]));
}

/** Premultiplied 0..255 floats (straight getImageData converted back). */
export function pm(s: Surface, x: number, y: number): Px {
  const d = s.ctx.getImageData(x, y, 1, 1).data;
  return [(d[0] * d[3]) / 255, (d[1] * d[3]) / 255, (d[2] * d[3]) / 255, d[3]];
}

export function straight(s: Surface, x: number, y: number): Px {
  const d = s.ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

export function allPremult(s: Surface): Float32Array {
  const d = s.ctx.getImageData(0, 0, s.width, s.height).data;
  const o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    o[i] = (d[i] * a) / 255;
    o[i + 1] = (d[i + 1] * a) / 255;
    o[i + 2] = (d[i + 2] * a) / 255;
    o[i + 3] = a;
  }
  return o;
}

export function run(src: Surface, effects: Effect[], rect?: Rect, out?: Surface): { out: Surface; rect: Rect } {
  const o = out ?? createSurface(src.width, src.height, true);
  const r = applyFx(src, effects, rect ?? { x: 0, y: 0, w: src.width, h: src.height }, o);
  return { out: o, rect: r };
}
