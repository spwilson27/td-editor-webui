import type { BrushDynamics, BrushPreset, BrushSettings, TipShape } from '../types';
import { createSurface, type Surface } from '../surface';

/** v6 brush tips and dynamics (docs/DESIGN_V6.md section 5): deterministic procedural tip masks, seeded dab sampler, preset validation, tip PNG codec. */

export const TIP_RES = 128; // procedural tips are TIP_RES x TIP_RES alpha masks
export const MAX_TIP = 512;
export const BUILTIN_TIPS: TipShape[] = ['round', 'chalk', 'bristle', 'spatter', 'noise', 'square', 'star'];
export const DEFAULT_DYNAMICS: BrushDynamics = {
  scatter: 0, scatterCount: 1, sizeJitter: 0, angleJitter: 0, hueJitter: 0, satJitter: 0, valJitter: 0, angle: 0, roundness: 1, seed: 1,
};
export interface CustomTip { w: number; h: number; alpha: Uint8Array }

// ---- deterministic randomness ----

/** Integer hash of a lattice point: a uint32. */
export function hash2(x: number, y: number, s = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const unit = (h: number): number => h / 4294967296;

/** mulberry32: a seeded uniform generator in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vnoise(x: number, y: number, s: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const n = (i: number, j: number): number => unit(hash2(ix + i, iy + j, s));
  const a = n(0, 0) + (n(1, 0) - n(0, 0)) * u;
  const b = n(0, 1) + (n(1, 1) - n(0, 1)) * u;
  return a + (b - a) * v;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// ---- procedural tips ----

const STAR = (() => {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < 10; k++) {
    const a = (k * Math.PI) / 5 - Math.PI / 2;
    const r = k % 2 ? 0.45 : 1;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
})();

/** Signed distance to the star outline (positive inside), in disc-radius units. */
function starDepth(x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [x1, y1] = STAR[j];
    const [x2, y2] = STAR[i];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy), 0, 1);
    best = Math.min(best, Math.hypot(x - x1 - t * dx, y - y1 - t * dy));
  }
  return inside ? best : -best;
}

/** Edge falloff for a depth below the outline (disc-radius units): hardness 1 = antialiased edge, below it a linear ramp like the round tip's gradient. */
function edge(depth: number, hardness: number, scale: number): number {
  const soft = (1 - hardness) * scale;
  return clamp(soft > 1 / TIP_RES ? depth / soft : depth * (TIP_RES / 2) + 0.5, 0, 1);
}

function spatter(i: number, j: number): number {
  const C = 14;
  const cx = Math.floor(i / C);
  const cy = Math.floor(j / C);
  let a = 0;
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (unit(hash2(x, y, 11)) < 0.3) continue;
      const bx = (x + unit(hash2(x, y, 12))) * C;
      const by = (y + unit(hash2(x, y, 13))) * C;
      const r = 1.5 + unit(hash2(x, y, 14)) * 4.5;
      a = Math.max(a, clamp(r - Math.hypot(i + 0.5 - bx, j + 0.5 - by) + 0.5, 0, 1));
    }
  }
  return a;
}

function texture(shape: TipShape, i: number, j: number): number {
  switch (shape) {
    case 'chalk': return clamp((vnoise(i / 3, j / 3, 1) * 0.65 + vnoise(i / 1.3, j / 1.3, 2) * 0.35 - 0.38) * 3.5, 0, 1);
    case 'bristle': return clamp(vnoise(i / 2.2, j / 70, 3) * 1.7 - 0.35, 0, 1) * (0.75 + 0.25 * vnoise(i, j / 12, 4));
    case 'spatter': return spatter(i, j);
    case 'noise': return clamp((unit(hash2(i >> 1, j >> 1, 5)) - 0.15) * 2, 0, 1);
    default: return 1;
  }
}

const tipCache = new Map<string, Uint8Array>();

/** Alpha mask (TIP_RES x TIP_RES) of a built-in tip; unknown shapes give 'round'. Deterministic and cached per shape + hardness (1/64 steps). */
export function tipAlpha(shape: TipShape, hardness: number): Uint8Array {
  const sh: TipShape = BUILTIN_TIPS.includes(shape) ? shape : 'round';
  const hq = Math.round(clamp(Number.isFinite(hardness) ? hardness : 1, 0, 1) * 64);
  const key = `${sh}:${hq}`;
  const hit = tipCache.get(key);
  if (hit) return hit;
  const h = hq / 64;
  const out = new Uint8Array(TIP_RES * TIP_RES);
  for (let j = 0; j < TIP_RES; j++) {
    for (let i = 0; i < TIP_RES; i++) {
      const x = ((i + 0.5) / TIP_RES) * 2 - 1;
      const y = ((j + 0.5) / TIP_RES) * 2 - 1;
      const e = sh === 'square' ? edge(1 - Math.max(Math.abs(x), Math.abs(y)), h, 1) : sh === 'star' ? edge(starDepth(x, y), h, 0.45) : edge(1 - Math.hypot(x, y), h, 1);
      out[j * TIP_RES + i] = Math.round(255 * e * (e > 0 ? texture(sh, i, j) : 0));
    }
  }
  if (tipCache.size > 96) tipCache.clear();
  tipCache.set(key, out);
  return out;
}

/** White canvas whose alpha is `alpha`; cached for the procedural tips by the array identity. */
const canvasCache = new WeakMap<Uint8Array, Surface>();
export function alphaSurface(alpha: Uint8Array, w: number, h: number): Surface {
  const hit = canvasCache.get(alpha);
  if (hit && hit.width === w && hit.height === h) return hit;
  const s = createSurface(w, h);
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < alpha.length; i++) px.set([255, 255, 255, alpha[i]], i * 4);
  s.ctx.putImageData(new ImageData(px, w, h), 0, 0);
  canvasCache.set(alpha, s);
  return s;
}

// ---- dynamics ----

const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);

export function sanitizeDynamics(d: unknown): BrushDynamics {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const D = DEFAULT_DYNAMICS;
  return {
    scatter: num(o.scatter, 0, 4, D.scatter), scatterCount: Math.round(num(o.scatterCount, 1, 16, 1)),
    sizeJitter: num(o.sizeJitter, 0, 1, 0), angleJitter: num(o.angleJitter, 0, 360, 0),
    hueJitter: num(o.hueJitter, 0, 1, 0), satJitter: num(o.satJitter, 0, 1, 0), valJitter: num(o.valJitter, 0, 1, 0),
    angle: typeof o.angle === 'number' && Number.isFinite(o.angle) ? ((((o.angle + 180) % 360) + 360) % 360) - 180 : 0,
    roundness: num(o.roundness, 0.05, 1, 1),
    seed: typeof o.seed === 'number' && Number.isFinite(o.seed) ? Math.floor(o.seed) >>> 0 : D.seed,
  };
}

/** True for the round tip with default dynamics: the legacy circle stamp path is used. */
export function isPlainTip(shape: TipShape, d: BrushDynamics): boolean {
  return shape === 'round' && d.scatter === 0 && d.scatterCount === 1 && d.sizeJitter === 0 && d.angleJitter === 0
    && d.hueJitter === 0 && d.satJitter === 0 && d.valJitter === 0 && d.angle === 0 && d.roundness === 1;
}

export interface DabSample { ox: number; oy: number; size: number; angle: number; dh: number; ds: number; dv: number }

/**
 * Per-stroke dynamics sampler: seeded from `dynamics.seed`; every dab consumes exactly 7 random numbers in a fixed order
 * (independent of clipping, tip and colour), so a seed + pointer path always gives the same dabs.
 */
export class DabSampler {
  private rnd: () => number;
  /** `stroke`: index of the stroke since the tip was set; strokes differ from each other, each is reproducible from seed + index. */
  constructor(private d: BrushDynamics, stroke = 0) { this.rnd = mulberry32((d.seed + Math.imul(stroke, 0x9e3779b1)) >>> 0); }

  /** One dab for a brush of `size` document px: offset (doc px), size (doc px), total angle (deg), colour jitter deltas (hue in turns). */
  next(size: number): DabSample {
    const { d, rnd } = this;
    const sa = rnd() * Math.PI * 2;
    const sr = Math.sqrt(rnd()) * d.scatter * size;
    const sz = size * (1 - d.sizeJitter * rnd());
    const an = d.angle + (rnd() * 2 - 1) * d.angleJitter;
    const dh = (rnd() * 2 - 1) * d.hueJitter * 0.5;
    const ds = (rnd() * 2 - 1) * d.satJitter;
    const dv = (rnd() * 2 - 1) * d.valJitter;
    return { ox: Math.cos(sa) * sr + 0, oy: Math.sin(sa) * sr + 0, size: Math.max(0.5, sz), angle: an, dh, ds, dv };
  }
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const dl = mx - mn;
  const h = dl === 0 ? 0 : mx === r ? (((g - b) / dl) % 6 + 6) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
  return [h / 6, mx === 0 ? 0 : dl / mx, mx / 255];
}
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}
/** Primary colour shifted by hue (turns, wraps), saturation and value deltas (clamped). */
export function jitterColor(r: number, g: number, b: number, dh: number, ds: number, dv: number): [number, number, number] {
  const [h, s, v] = rgbToHsv(r, g, b);
  return hsvToRgb((((h + dh) % 1) + 1) % 1, clamp(s + ds, 0, 1), clamp(v + dv, 0, 1));
}

// ---- tip PNG codec (alpha in the alpha channel, rgb white) ----

const validDim = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_TIP;

export function encodeTipPng(w: number, h: number, alpha: Uint8Array): string {
  if (!validDim(w) || !validDim(h)) throw new RangeError('encodeTipPng: size must be integers 1..512');
  if (alpha.length !== w * h) throw new RangeError('encodeTipPng: alpha length must be w * h');
  const c = document.createElement('canvas'); // a DOM canvas: toDataURL is synchronous
  c.width = w;
  c.height = h;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < alpha.length; i++) px.set([255, 255, 255, alpha[i]], i * 4);
  (c.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(px, w, h), 0, 0);
  return c.toDataURL('image/png');
}

export async function decodeTipPng(dataUrl: string): Promise<CustomTip> {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('decodeTipPng: not a PNG data URL');
  if (dataUrl.length > 2_000_000) throw new RangeError('decodeTipPng: data URL too long');
  // the size is checked in the IHDR chunk BEFORE the browser decodes anything
  let head: string;
  try { head = atob(dataUrl.slice(22, 22 + 44)); } catch { throw new Error('decodeTipPng: bad base64'); }
  if (head.length < 24 || head.slice(1, 4) !== 'PNG' || head.slice(12, 16) !== 'IHDR') throw new Error('decodeTipPng: not a PNG');
  const u32 = (o: number): number => ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
  if (!validDim(u32(16)) || !validDim(u32(20))) throw new RangeError('decodeTipPng: size must be 1..512');
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!validDim(w) || !validDim(h)) throw new RangeError('decodeTipPng: size must be 1..512');
  const s = createSurface(w, h, true);
  s.ctx.drawImage(img, 0, 0);
  const d = s.ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
  s.canvas.width = 0;
  return { w, h, alpha };
}

// ---- presets ----

const PNG_PREFIX = 'data:image/png;base64,';
export const MAX_PRESETS = 64; // TD's MAX_BRUSH_PRESETS
export const MAX_CUSTOM_PRESETS = 16;
const MAX_PNG = 2_000_000;

export function sanitizeBrushPresets(list: unknown): BrushPreset[] {
  if (!Array.isArray(list)) return [];
  const out: BrushPreset[] = [];
  const ids = new Set<string>();
  let customs = 0;
  for (const p of list.slice(0, MAX_PRESETS)) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const s = (o.settings && typeof o.settings === 'object' ? o.settings : {}) as Partial<BrushSettings>;
    let id = typeof o.id === 'string' && o.id.length > 0 ? o.id.slice(0, 64) : '';
    if (!id || ids.has(id)) {
      const base = (id || 'preset').slice(0, 56);
      let n = ids.size + 1;
      while (ids.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
    }
    ids.add(id);
    let tip: TipShape = typeof o.tip === 'string' && (BUILTIN_TIPS.includes(o.tip as TipShape) || o.tip === 'custom') ? (o.tip as TipShape) : 'round';
    let customTip: BrushPreset['customTip'];
    const c = o.customTip as { w?: unknown; h?: unknown; png?: unknown } | undefined;
    if (tip === 'custom' && c && typeof c === 'object' && validDim(c.w) && validDim(c.h) && typeof c.png === 'string' && c.png.startsWith(PNG_PREFIX) && c.png.length <= MAX_PNG && customs < MAX_CUSTOM_PRESETS) {
      customTip = { w: c.w as number, h: c.h as number, png: c.png };
      customs++;
    } else if (tip === 'custom') tip = 'round';
    out.push({
      id, name: typeof o.name === 'string' ? o.name.slice(0, 64) : '',
      settings: {
        size: num(s.size, 1, 1000, 20), opacity: num(s.opacity, 0, 1, 1), flow: num(s.flow, 0, 1, 1),
        hardness: num(s.hardness, 0, 1, 0.8), spacing: num(s.spacing, 0.01, 4, 0.15),
      },
      tip, dynamics: sanitizeDynamics(o.dynamics), ...(customTip ? { customTip } : {}),
    });
  }
  return out;
}

/** Validate a custom tip as `setBrushTip` needs it; a copy, or null. */
export function sanitizeCustomTip(c: unknown): CustomTip | null {
  const o = c as Partial<CustomTip> | null | undefined;
  if (!o || typeof o !== 'object' || !validDim(o.w) || !validDim(o.h) || !(o.alpha instanceof Uint8Array) || o.alpha.length !== (o.w as number) * (o.h as number)) return null;
  return { w: o.w as number, h: o.h as number, alpha: new Uint8Array(o.alpha) };
}
