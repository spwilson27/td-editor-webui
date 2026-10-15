/*
 * Adjustment layers: defaults, validation and the Local-mode PREVIEW implementation.
 *
 * TouchDesigner is the truth (td/raster_editor/network.py documents its TOP mapping); the preview computes the same
 * maths in JS. All colour maths is on sRGB-encoded values in 0..1 (no linearisation) on STRAIGHT (unpremultiplied)
 * colour; alpha is preserved (TD merges the result with the alpha of the image below) except by blur.
 *
 *  levels {inLow,inHigh,gamma,outLow,outHigh}   (JS 8-bit LUT, per channel R,G,B)
 *      t   = clamp((c - inLow) / max(inHigh - inLow, 1e-4))
 *      out = outLow + (outHigh - outLow) * t ^ (1 / gamma)     (gamma > 1 brightens mid-tones)
 *      (clampAdjustment keeps inHigh >= inLow + 1e-4, as TD does)
 *
 *  brightnessContrast {brightness,contrast}     (JS 8-bit LUT, per channel; == TD Level brightness1 then contrast)
 *      c1  = clamp(c * (1 + brightness))                        (brightness MULTIPLIES)
 *      out = clamp((c1 - 0.5) * (1 + contrast) + 0.5)           (contrast pivots at 0.5)
 *
 *  hueSaturation {hue(deg),saturation,value}    (JS, true HSV edit == TD HSV Adjust TOP)
 *      V = max(R,G,B), S = (V - min) / V (0 when V = 0), H in degrees (0..360, grey: 0)
 *      H' = H + hue, S' = min(1, S * saturation), V' = V * value
 *      convert back to RGB (standard HSV hexcone), then clamp each channel to 0..1 (value > 1 saturates channels;
 *      hue is not kept). Positive hue rotates in the CSS hue-rotate direction (red -> green -> blue).
 *
 *  blur {radius}                                (the only ctx.filter user: blur(radius px))
 *      Gaussian, standard deviation = radius px, on premultiplied RGBA; radius < 0.05 is the identity.
 *      Edge mode: pixels outside the document REPEAT THE EDGE PIXELS (TD Blur TOP 'hold'); the preview pads the
 *      source with the edge rows / columns before blurring, so it matches TD at the document border.
 *
 *  invert {}                                    out = 1 - c   (RGB; alpha untouched)
 *
 *  threshold {level}
 *      lum = 0.2126 R + 0.7152 G + 0.0722 B  (straight, 0..1, Rec.709)
 *      out = lum >= level ? white : black      (alpha untouched)
 *
 *  filter {effect}                              (v6) a filter-library Effect run by the effects module on the accumulated result below (document
 *      space, compositor.ts); like every adjustment layer it may carry effects[] (run on the adjusted result, before the mix).
 *
 * Mixing (all types): result = mix(below, adjusted, opacity * mask) in premultiplied RGBA, where `below` is the
 * accumulated result under the adjustment within its parent, and mask = 1 without an (enabled) mask.
 * Mask values from a paint colour use the same Rec.709 luminance.
 * Known 8-bit differences: the preview rounds to 8 bits after each adjustment, TD stays in 16-bit float.
 */
import type { AdjustmentSpec, AdjustmentType, Effect, Rect } from './types';
import type { Ctx2D, Surface } from './surface';
import { sanitizeEffect } from './effectsSanitize';
import { effectsReach, hasEffects } from './effectsAdapter';

/** A drawing surface with the document position (ox, oy) of its top-left pixel. */
export interface AdjTarget {
  ctx: Ctx2D;
  canvas: Surface['canvas'];
  ox: number;
  oy: number;
  k: number; // canvas pixels per document pixel (1 except thumbnails)
}

export const ADJUSTMENT_TYPES: AdjustmentType[] = ['levels', 'brightnessContrast', 'hueSaturation', 'blur', 'invert', 'threshold', 'filter'];

export const ADJUSTMENT_NAMES: Record<AdjustmentType, string> = {
  levels: 'Levels', brightnessContrast: 'Brightness/Contrast', hueSaturation: 'Hue/Saturation',
  blur: 'Blur', invert: 'Invert', threshold: 'Threshold', filter: 'Filter',
};

export const DEFAULT_BLUR_RADIUS = 4;

export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** Rec.709 luminance of an 8-bit colour, 0..255 (float). */
export function luminance(r: number, g: number, b: number): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

export function defaultAdjustment(type: AdjustmentType): AdjustmentSpec {
  switch (type) {
    case 'levels': return { type, inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 };
    case 'brightnessContrast': return { type, brightness: 0, contrast: 0 };
    case 'hueSaturation': return { type, hue: 0, saturation: 1, value: 1 };
    case 'blur': return { type, radius: DEFAULT_BLUR_RADIUS };
    case 'invert': return { type };
    case 'threshold': return { type, level: 0.5 };
    case 'filter': return { type, effect: { enabled: true, type: 'blur', radius: 10 } as unknown as Effect };
  }
}

const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Clamp every parameter into its documented range (also repairs missing fields from the defaults). */
export function clampAdjustment(s: AdjustmentSpec): AdjustmentSpec {
  const d = defaultAdjustment(s.type) as Record<string, number | string>;
  const v = { ...d, ...(s as unknown as Record<string, number>) } as unknown as AdjustmentSpec;
  switch (v.type) {
    case 'levels': {
      const inLow = clamp(v.inLow, 0, 1);
      const inHigh = clamp(v.inHigh, 0, 1);
      return {
        type: 'levels', inLow, inHigh: Math.max(inHigh, Math.min(1, inLow + 1e-4)), gamma: clamp(v.gamma, 0.1, 10),
        outLow: clamp(v.outLow, 0, 1), outHigh: clamp(v.outHigh, 0, 1),
      };
    }
    case 'brightnessContrast': return { type: 'brightnessContrast', brightness: clamp(v.brightness, -1, 1), contrast: clamp(v.contrast, -1, 1) };
    case 'hueSaturation': return { type: 'hueSaturation', hue: clamp(v.hue, -180, 180), saturation: clamp(v.saturation, 0, 2), value: clamp(v.value, 0, 2) };
    case 'blur': return { type: 'blur', radius: clamp(v.radius, 0, 200) };
    case 'invert': return { type: 'invert' };
    case 'threshold': return { type: 'threshold', level: clamp(v.level, 0, 1) };
    case 'filter': return { type: 'filter', effect: sanitizeEffect(v.effect) ?? (d.effect as unknown as Effect) };
  }
}

export function sameAdjustment(a: AdjustmentSpec, b: AdjustmentSpec): boolean {
  if (a.type === 'filter' || b.type === 'filter') return a.type === b.type && JSON.stringify(a) === JSON.stringify(b);
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  const kx = Object.keys(x);
  return kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k]);
}

/** True when applying the adjustment changes nothing (skipped by the compositor). */
export function isIdentity(s: AdjustmentSpec): boolean {
  switch (s.type) {
    case 'levels': return s.inLow === 0 && s.inHigh === 1 && s.gamma === 1 && s.outLow === 0 && s.outHigh === 1;
    case 'brightnessContrast': return s.brightness === 0 && s.contrast === 0;
    case 'hueSaturation': return s.hue === 0 && s.saturation === 1 && s.value === 1;
    case 'blur': return s.radius < 0.05;
    case 'filter': return !hasEffects([s.effect]);
    default: return false;
  }
}

/** Extra pixels around a changed rect that an adjustment can influence (blur only). */
export function adjustmentReach(s: AdjustmentSpec): number {
  if (s.type === 'filter') return effectsReach([s.effect]);
  return s.type === 'blur' && !isIdentity(s) ? Math.ceil(3 * s.radius) : 0;
}

/** CSS filter string for the filter-based type (blur only), null for the JS ones. */
export function filterFor(s: AdjustmentSpec): string | null {
  return s.type === 'blur' ? `blur(${s.radius}px)` : null;
}

/** 256-entry LUT of the levels formula. */
export function levelsLut(s: Extract<AdjustmentSpec, { type: 'levels' }>): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const span = Math.max(s.inHigh - s.inLow, 1e-4);
  const inv = 1 / s.gamma;
  for (let i = 0; i < 256; i++) {
    const t = Math.pow(Math.min(1, Math.max(0, (i / 255 - s.inLow) / span)), inv);
    lut[i] = Math.round(255 * (s.outLow + t * (s.outHigh - s.outLow)));
  }
  return lut;
}

/** 256-entry LUT of the brightness / contrast formula. */
export function brightnessContrastLut(s: Extract<AdjustmentSpec, { type: 'brightnessContrast' }>): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, Math.max(0, (i / 255) * (1 + s.brightness)));
    lut[i] = Math.round(255 * ((v - 0.5) * (1 + s.contrast) + 0.5));
  }
  return lut;
}

/** HSV edit of one straight 8-bit colour (see header); writes the clamped result into out[0..2]. */
export function hsvAdjust(r: number, g: number, b: number, hue: number, sat: number, val: number, out: Uint8ClampedArray | number[], o = 0): void {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  h = (((h + hue) % 360) + 360) % 360;
  const s = mx > 0 ? Math.min(1, (d / mx) * sat) : 0;
  const v = (mx / 255) * val;
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  let R: number, G: number, B: number;
  if (hp < 1) [R, G, B] = [c, x, 0];
  else if (hp < 2) [R, G, B] = [x, c, 0];
  else if (hp < 3) [R, G, B] = [0, c, x];
  else if (hp < 4) [R, G, B] = [0, x, c];
  else if (hp < 5) [R, G, B] = [x, 0, c];
  else [R, G, B] = [c, 0, x];
  const q = (n: number): number => Math.min(255, Math.max(0, Math.round(255 * n)));
  out[o] = q(R + m);
  out[o + 1] = q(G + m);
  out[o + 2] = q(B + m);
}

/** Per-spec LUT cache for the LUT based types (one slot: the spec being edited / drawn). */
let lutKey = '';
let lutVal: Uint8ClampedArray | null = null;
function lutFor(s: AdjustmentSpec): Uint8ClampedArray {
  const key = JSON.stringify(s);
  if (key === lutKey && lutVal) return lutVal;
  let lut: Uint8ClampedArray;
  if (s.type === 'levels') lut = levelsLut(s);
  else if (s.type === 'brightnessContrast') lut = brightnessContrastLut(s);
  else {
    lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = 255 - i;
  }
  lutKey = key;
  lutVal = lut;
  return lut;
}

/** Rows processed per getImageData: bounds the transient allocation (about 1 MB) of a full-document edit. */
const BAND_PIXELS = 256 * 1024;

/**
 * Pixel rect (canvas pixels) of document rect `r` on a target (document position ox/oy, scale k).
 */
export function pixRect(t: { ox: number; oy: number; k: number }, r: Rect): Rect {
  return { x: Math.round((r.x - t.ox) * t.k), y: Math.round((r.y - t.oy) * t.k), w: Math.max(1, Math.round(r.w * t.k)), h: Math.max(1, Math.round(r.h * t.k)) };
}

/**
 * Write the adjusted version of `from` (over document rect `r`) into `to` (over `r`). Only pixels inside `r` of `to`
 * are defined afterwards. `to`'s context maps document coordinates onto its canvas (a transform of scale k);
 * (ox, oy) is the document position of a target's top-left pixel. `pad(P)` supplies a scratch target covering the
 * document rect P (blur edge hold); docW/docH locate the document border.
 */
export function renderAdjusted(
  s: AdjustmentSpec, from: AdjTarget, to: AdjTarget, r: Rect, doc: { w: number; h: number }, pad: (p: Rect) => AdjTarget,
): void {
  const c = to.ctx;
  const fp = pixRect(from, r);
  if (s.type === 'blur') {
    const reach = Math.ceil(3 * s.radius);
    const P = { x: r.x - reach, y: r.y - reach, w: r.w + 2 * reach, h: r.h + 2 * reach };
    const t = pad(P);
    t.ctx.clearRect(P.x, P.y, P.w, P.h);
    const src = from.canvas as CanvasImageSource;
    t.ctx.drawImage(src, fp.x, fp.y, fp.w, fp.h, r.x, r.y, r.w, r.h);
    const left = r.x <= 0, right = r.x + r.w >= doc.w, top = r.y <= 0, bottom = r.y + r.h >= doc.h;
    const R = r.x + r.w, B = r.y + r.h;
    if (left) t.ctx.drawImage(src, fp.x, fp.y, 1, fp.h, P.x, r.y, r.x - P.x, r.h);
    if (right) t.ctx.drawImage(src, fp.x + fp.w - 1, fp.y, 1, fp.h, R, r.y, P.x + P.w - R, r.h);
    if (top) t.ctx.drawImage(src, fp.x, fp.y, fp.w, 1, r.x, P.y, r.w, r.y - P.y);
    if (bottom) t.ctx.drawImage(src, fp.x, fp.y + fp.h - 1, fp.w, 1, r.x, B, r.w, P.y + P.h - B);
    if (left && top) t.ctx.drawImage(src, fp.x, fp.y, 1, 1, P.x, P.y, r.x - P.x, r.y - P.y);
    if (right && top) t.ctx.drawImage(src, fp.x + fp.w - 1, fp.y, 1, 1, R, P.y, P.x + P.w - R, r.y - P.y);
    if (left && bottom) t.ctx.drawImage(src, fp.x, fp.y + fp.h - 1, 1, 1, P.x, B, r.x - P.x, P.y + P.h - B);
    if (right && bottom) t.ctx.drawImage(src, fp.x + fp.w - 1, fp.y + fp.h - 1, 1, 1, R, B, P.x + P.w - R, P.y + P.h - B);
    c.clearRect(r.x, r.y, r.w, r.h);
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    c.filter = `blur(${s.radius * to.k}px)`;
    c.drawImage(t.canvas as CanvasImageSource, 0, 0, Math.round(P.w * t.k), Math.round(P.h * t.k), P.x, P.y, P.w, P.h);
    c.restore();
    return;
  }
  const tp = pixRect(to, r);
  const lut = s.type === 'levels' || s.type === 'brightnessContrast' || s.type === 'invert' ? lutFor(s) : null;
  const m = s.type === 'hueSaturation' ? s : null;
  const th = s.type === 'threshold' ? s.level * 255 : 0;
  const rowsPerBand = Math.max(1, Math.floor(BAND_PIXELS / fp.w));
  for (let y0 = 0; y0 < fp.h; y0 += rowsPerBand) {
    const h = Math.min(rowsPerBand, fp.h - y0);
    const img = from.ctx.getImageData(fp.x, fp.y + y0, fp.w, h);
    const d = img.data;
    if (lut) {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = lut[d[i]];
        d[i + 1] = lut[d[i + 1]];
        d[i + 2] = lut[d[i + 2]];
      }
    } else if (m) {
      for (let i = 0; i < d.length; i += 4) hsvAdjust(d[i], d[i + 1], d[i + 2], m.hue, m.saturation, m.value, d, i);
    } else {
      for (let i = 0; i < d.length; i += 4) {
        const v = luminance(d[i], d[i + 1], d[i + 2]) >= th ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
    }
    c.putImageData(img, tp.x, tp.y + y0);
  }
}
