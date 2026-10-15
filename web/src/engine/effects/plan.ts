// Effect -> shader pass list. MIRRORS td/raster_editor/effects.py plan_effect() / effect_reach() (shared/effects/vectors.json
// is checked against both). Units and shader contracts: shared/effects/*.glsl headers and effects.py's module docstring.

import type { Effect, RGBA, Rect } from '../types';

export type PassFormat = 'u8' | 'f16' | 'f32';

export interface EffectPass {
  shader: Effect['type'];
  pid: number;
  /** uP0..uP3, 16 floats */
  u: number[];
  fmt: PassFormat;
}

export const MAX_RADIUS = 128;
export const MAX_STROKE = 128;

const round = (x: number): number => Math.floor(x + 0.5);
const off = (v: unknown): number => Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, round(num(v))));
/** Only finite JS numbers count (numeric strings, booleans, null -> default); effects.py `_num` does the same. */
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const SEED_MOD = 1 << 24; // seeds are reduced to 0..2^24-1 so the float uniform holds them exactly
const MAX_OFFSET = 8192;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function col(c: RGBA | undefined, opacity = 1): number[] {
  const o = c ?? { r: 0, g: 0, b: 0, a: 255 };
  return [o.r / 255, o.g / 255, o.b / 255, (o.a / 255) * clamp01(opacity)];
}

/** `size` is the kernel half width in px; sigma = size / 3. */
function blurSize(px: number): [number, number] {
  const p = Math.min(MAX_RADIUS, Math.max(0, px));
  return [p / 3, Math.ceil(p)];
}

function jfaSteps(d: number): number[] {
  let s0 = 1;
  const half = Math.ceil(d / 2);
  while (s0 < half) s0 *= 2;
  const steps: number[] = [];
  for (let s = s0; s >= 1; s = Math.floor(s / 2)) steps.push(s);
  steps.push(1);
  return steps;
}

const pad = (u: number[]): number[] => u.concat(new Array(16 - u.length).fill(0));
const P = (shader: Effect['type'], pid: number, u: number[], fmt: PassFormat): EffectPass => ({ shader, pid, u: pad(u), fmt });

export function planEffect(e: Effect): EffectPass[] {
  if (!e || e.enabled === false) return []; // only a literal false disables (a missing flag = enabled)
  const op = clamp01(num((e as { opacity?: number }).opacity, 1));
  switch (e.type) {
    case 'dropShadow': {
      const [sg, r] = blurSize(num(e.blur));
      const u = [sg, r, off(e.dx), off(e.dy), ...col(e.color, op)];
      return [P(e.type, 0, u, 'f16'), P(e.type, 1, u, 'f16')];
    }
    case 'outerGlow':
    case 'innerGlow': {
      const [sg, r] = blurSize(num(e.size));
      const u = [sg, r, 0, 0, ...col(e.color, op)];
      return [P(e.type, 0, u, 'f16'), P(e.type, 1, u, 'f16')];
    }
    case 'stroke': {
      const w = Math.min(MAX_STROKE, num(e.width));
      if (w <= 0) return [];
      const pos = e.position === 'inside' ? 0 : e.position === 'center' ? 1 : 2;
      const d = pos === 1 ? w / 2 + 1 : w + 1;
      const out = jfaSteps(d).map((k, i) => P(e.type, 0, [k, i === 0 ? 1 : 0], 'f32'));
      out.push(P(e.type, 1, [pos, w, 0, 0, ...col(e.color, op)], 'f16'));
      return out;
    }
    case 'bevel': {
      const [sg, r] = blurSize(num(e.size));
      const a = (num(e.angle, 120) * Math.PI) / 180;
      const depth = clamp01(num(e.depth, 100) / 100);
      const head = [sg, r, depth, 0, Math.cos(a), -Math.sin(a), 0, 0];
      return [P(e.type, 0, head, 'f16'), P(e.type, 1, [...head, ...col(e.highlight), ...col(e.shadow)], 'f16')];
    }
    case 'colorOverlay':
      return [P(e.type, 0, col(e.color, op), 'f16')];
    case 'pixelSort': {
      const u = [e.direction === 'v' ? 1 : 0, clamp01(num(e.low, 0)), clamp01(num(e.high, 1)), e.key === 'hue' ? 1 : 0];
      return [P(e.type, 0, u, 'f32'), P(e.type, 1, u, 'f32'), P(e.type, 2, u, 'f16')];
    }
    case 'glitch': {
      const amount = Math.min(100, Math.max(0, num(e.amount)));
      return [P(e.type, 0, [amount / 100, amount, Math.max(1, round(num(e.blockSize, 16))), ((round(num(e.seed)) % SEED_MOD) + SEED_MOD) % SEED_MOD, Math.min(256, Math.max(0, num(e.rgbShift)))], 'f16')];
    }
    case 'chromaticAberration': {
      const a = (num(e.angle) * Math.PI) / 180;
      const amt = num(e.amount);
      return [P(e.type, 0, [amt * Math.cos(a), -amt * Math.sin(a)], 'f16')];
    }
    case 'halftone': {
      const a = (num(e.angle) * Math.PI) / 180;
      return [P(e.type, 0, [Math.max(1, num(e.cellSize, 8)), Math.cos(a), Math.sin(a), e.shape === 'line' ? 1 : 0], 'f16')];
    }
    default:
      return [];
  }
}

export interface Extent {
  /** pixels an edit spreads along x / y */
  rx: number;
  ry: number;
  /** >0: the output region must be widened to multiples of this many px along x / y (pixel sort chunks) */
  ax: number;
  ay: number;
}
export const SORT_CHUNK = 256; // pixelSort.glsl MAXSPAN

/** Exact extent of an effect (see expandRect). */
export function effectExtent(e: Effect): Extent {
  const z: Extent = { rx: 0, ry: 0, ax: 0, ay: 0 };
  if (!e || e.enabled === false || planEffect(e).length === 0) return z;
  const iso = (r: number): Extent => ({ rx: r, ry: r, ax: 0, ay: 0 });
  switch (e.type) {
    case 'dropShadow': {
      const r = blurSize(num(e.blur))[1];
      return { rx: Math.abs(off(e.dx)) + r, ry: Math.abs(off(e.dy)) + r, ax: 0, ay: 0 };
    }
    case 'outerGlow':
    case 'innerGlow': return iso(blurSize(num(e.size))[1]);
    // jump flood: the result at a pixel depends on the source within the SUM of the jump sizes (+1 for the edge test, +1 slack)
    case 'stroke': return iso(planEffect(e).reduce((a, p) => (p.fmt === 'f32' ? a + p.u[0] : a), 0) + 2);
    case 'bevel': return iso(blurSize(num(e.size))[1] + 1);
    case 'pixelSort': return e.direction === 'v' ? { ...z, ay: SORT_CHUNK } : { ...z, ax: SORT_CHUNK };
    case 'glitch': return iso(Math.ceil(Math.min(100, Math.max(0, num(e.amount)))) + 2 * Math.ceil(Math.min(256, Math.max(0, num(e.rgbShift))) * 1.5) + 2);
    case 'chromaticAberration': return iso(Math.ceil(Math.abs(num(e.amount))) + 2);
    case 'halftone': return iso(Math.ceil(1.5 * Math.max(1, num(e.cellSize, 8))) + 2);
    default: return z;
  }
}

/** Conservative isotropic reach in px (pixel sort: 255 = the largest widening to a 256 px chunk). Prefer expandRect. */
export function effectReach(e: Effect): number {
  const x = effectExtent(e);
  return Math.max(x.rx, x.ry, x.ax ? x.ax - 1 : 0, x.ay ? x.ay - 1 : 0);
}

export function effectsReach(effects: readonly Effect[]): number {
  let r = 0;
  for (const e of effects) r += effectReach(e);
  return r;
}

/**
 * Grows `r` through the effect stack. forward = region of the OUTPUT touched by a change in `r` of the input (effects in order);
 * backward = region of the INPUT needed to compute the output in `r` (effects in reverse). Each effect adds its (rx, ry) and
 * pixel sort widens along its axis to whole 256 px chunks in surface (= document) coordinates. Clipped to w x h after every step.
 */
export function expandRect(r: Rect, effects: readonly Effect[], forward: boolean, w: number, h: number): Rect | null {
  const list = effects.map(effectExtent);
  if (!forward) list.reverse();
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  for (const x of list) {
    x0 -= x.rx; x1 += x.rx; y0 -= x.ry; y1 += x.ry;
    if (x.ax) { x0 = Math.floor(x0 / x.ax) * x.ax; x1 = Math.ceil(x1 / x.ax) * x.ax; }
    if (x.ay) { y0 = Math.floor(y0 / x.ay) * x.ay; y1 = Math.ceil(y1 / x.ay) * x.ay; }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Flat pass list of the enabled effects; the chain's last pass is 'u8', the last pass of an earlier effect 'f16'. */
export function planChain(effects: readonly Effect[]): { effect: number; pass: EffectPass }[] {
  const groups: { i: number; ps: EffectPass[] }[] = [];
  effects.forEach((e, i) => {
    const ps = planEffect(e);
    if (ps.length) groups.push({ i, ps });
  });
  const out: { effect: number; pass: EffectPass }[] = [];
  groups.forEach((g, gi) => {
    g.ps.forEach((p, pj) => {
      out.push({ effect: g.i, pass: pj === g.ps.length - 1 ? { ...p, fmt: gi === groups.length - 1 ? 'u8' : 'f16' } : p });
    });
  });
  return out;
}
