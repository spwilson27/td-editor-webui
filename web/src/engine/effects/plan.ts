// Effect / filter -> shader pass list. MIRRORS td/raster_editor/effects.py plan_effect() / effect_reach() (shared/effects/vectors.json
// is checked against both). Units and shader contracts: shared/effects/*.glsl headers and effects.py's module docstring.
// v6 filters are planned from shared/effects/<type>.filter.json by ./filters.ts (the spec engine).

import type { Effect, RGBA, Rect } from '../types';
import type { Filter } from '../../../../shared/effects/filters';
import {
  FILTER_SPECS, MAX_RADIUS, SEED_MOD, blurPlan, blurReach, clamp01, filterExtent, filterReads, filterTdPreview, isFilterType, num, planFilter, round,
  type EffectPass, type PassFormat,
} from './filters';

export type { EffectPass, PassFormat };
export { MAX_RADIUS };
/** Anything the planner accepts: a v5 layer effect or a v6 filter (same chain, same API). */
export type AnyEffect = Effect | Filter;

export const MAX_STROKE = 128;

const off = (v: unknown): number => Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, round(num(v))));
const MAX_OFFSET = 8192;

function col(c: RGBA | undefined, opacity = 1): number[] {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const k = (n: string, d: number): number => { const v = o[n]; return typeof v === 'number' && Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : d; };
  return [k('r', 0) / 255, k('g', 0) / 255, k('b', 0) / 255, (k('a', 255) / 255) * clamp01(opacity)];
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
const P = (shader: string, pid: number, u: number[], fmt: PassFormat, level = 0): EffectPass =>
  level ? { shader, pid, u: pad(u), fmt, level } : { shader, pid, u: pad(u), fmt };

/** The four passes of a pyramid blur effect: down, H, V (level lv), up + composite (level 0). */
const pyr = (t: string, u: number[], lv: number): EffectPass[] => [P(t, 2, u, 'f16', lv), P(t, 3, u, 'f16', lv), P(t, 4, u, 'f16', lv), P(t, 5, u, 'f16')];

export function planEffect(e: AnyEffect): EffectPass[] {
  if (!e || e.enabled === false) return []; // only a literal false disables (a missing flag = enabled)
  if (isFilterType(e.type)) return planFilter(e as unknown as Record<string, unknown>);
  const x = e as Effect;
  const op = clamp01(num((x as { opacity?: number }).opacity, 1));
  switch (x.type) {
    case 'dropShadow': {
      const [sg, r, lv] = blurPlan(num(x.blur));
      const u = [sg, r, off(x.dx), off(x.dy), ...col(x.color, op)];
      if (lv) return pyr(x.type, [...u, lv], lv); // pyramid: down, H, V at level lv, up + composite (blurlib.glsl)
      return [P(x.type, 0, u, 'f16'), P(x.type, 1, u, 'f16')];
    }
    case 'outerGlow':
    case 'innerGlow': {
      const [sg, r, lv] = blurPlan(num(x.size));
      const u = [sg, r, 0, 0, ...col(x.color, op)];
      if (lv) return pyr(x.type, [...u, lv], lv);
      return [P(x.type, 0, u, 'f16'), P(x.type, 1, u, 'f16')];
    }
    case 'stroke': {
      const w = Math.min(MAX_STROKE, num(x.width));
      if (w <= 0) return [];
      const pos = x.position === 'inside' ? 0 : x.position === 'center' ? 1 : 2;
      const d = pos === 1 ? w / 2 + 1 : w + 1;
      const out = jfaSteps(d).map((k, i) => P(x.type, 0, [k, i === 0 ? 1 : 0], 'f32'));
      out.push(P(x.type, 1, [pos, w, 0, 0, ...col(x.color, op)], 'f16'));
      return out;
    }
    case 'bevel': {
      const size = num(x.size);
      const [sg, r, lv] = blurPlan(size);
      const a = ((num(x.angle, 120) % 360) * Math.PI) / 180;
      const depth = clamp01(num(x.depth, 100) / 100);
      if (lv) {
        const head = [sg, r, depth, lv, Math.cos(a), -Math.sin(a), Math.min(MAX_RADIUS, Math.max(0, size)) / 3, 0];
        const full = [...head, ...col(x.highlight), ...col(x.shadow)];
        return [P(x.type, 2, head, 'f16', lv), P(x.type, 3, head, 'f16', lv), P(x.type, 4, head, 'f16', lv), P(x.type, 5, full, 'f16')];
      }
      const head = [sg, r, depth, 0, Math.cos(a), -Math.sin(a), 0, 0];
      return [P(x.type, 0, head, 'f16'), P(x.type, 1, [...head, ...col(x.highlight), ...col(x.shadow)], 'f16')];
    }
    case 'colorOverlay':
      return [P(x.type, 0, col(x.color, op), 'f16')];
    case 'pixelSort': {
      const u = [x.direction === 'v' ? 1 : 0, clamp01(num(x.low, 0)), clamp01(num(x.high, 1)), x.key === 'hue' ? 1 : 0];
      return [P(x.type, 0, u, 'f32'), P(x.type, 1, u, 'f32'), P(x.type, 2, u, 'f16')];
    }
    case 'glitch': {
      const amount = Math.min(100, Math.max(0, num(x.amount)));
      return [P(x.type, 0, [amount / 100, amount, Math.max(1, round(num(x.blockSize, 16))), ((round(num(x.seed)) % SEED_MOD) + SEED_MOD) % SEED_MOD, Math.min(256, Math.max(0, num(x.rgbShift)))], 'f16')];
    }
    case 'chromaticAberration': {
      const a = ((num(x.angle) % 360) * Math.PI) / 180;
      const amt = num(x.amount);
      return [P(x.type, 0, [amt * Math.cos(a), -amt * Math.sin(a)], 'f16')];
    }
    case 'halftone': {
      const a = ((num(x.angle) % 360) * Math.PI) / 180;
      return [P(x.type, 0, [Math.max(1, num(x.cellSize, 8)), Math.cos(a), Math.sin(a), x.shape === 'line' ? 1 : 0], 'f16')];
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
export function effectExtent(e: AnyEffect): Extent {
  const z: Extent = { rx: 0, ry: 0, ax: 0, ay: 0 };
  if (!e || e.enabled === false || planEffect(e).length === 0) return z;
  if (isFilterType(e.type)) {
    const [rx, ry, ax, ay] = filterExtent(e as unknown as Record<string, unknown>);
    return { rx, ry, ax, ay };
  }
  const x = e as Effect;
  const iso = (r: number): Extent => ({ rx: r, ry: r, ax: 0, ay: 0 });
  switch (x.type) {
    case 'dropShadow': {
      const r = blurReach(num(x.blur));
      return { rx: Math.abs(off(x.dx)) + r, ry: Math.abs(off(x.dy)) + r, ax: 0, ay: 0 };
    }
    case 'outerGlow':
    case 'innerGlow': return iso(blurReach(num(x.size)));
    // jump flood: the result at a pixel depends on the source within the SUM of the jump sizes (+1 for the edge test, +1 slack)
    case 'stroke': return iso(planEffect(x).reduce((a, p) => (p.fmt === 'f32' ? a + p.u[0] : a), 0) + 2);
    case 'bevel': return iso(blurReach(num(x.size)) + 1);
    case 'pixelSort': return x.direction === 'v' ? { ...z, ay: SORT_CHUNK } : { ...z, ax: SORT_CHUNK };
    case 'glitch': return iso(Math.ceil(Math.min(100, Math.max(0, num(x.amount)))) + 2 * Math.ceil(Math.min(256, Math.max(0, num(x.rgbShift))) * 1.5) + 2);
    case 'chromaticAberration': return iso(Math.ceil(Math.abs(num(x.amount))) + 2);
    case 'halftone': return iso(Math.ceil(1.5 * Math.max(1, num(x.cellSize, 8))) + 2);
    default: return z;
  }
}

/** Conservative isotropic reach in px (pixel sort: 255 = the largest widening to a 256 px chunk). Prefer expandRect. */
export function effectReach(e: AnyEffect): number {
  const x = effectExtent(e);
  return Math.max(x.rx, x.ry, x.ax ? x.ax - 1 : 0, x.ay ? x.ay - 1 : 0);
}

export function effectsReach(effects: readonly AnyEffect[]): number {
  let r = 0;
  for (const e of effects) r += effectReach(e);
  return r;
}

/**
 * Grows `r` through the effect stack. forward = region of the OUTPUT touched by a change in `r` of the input (effects in order);
 * backward = region of the INPUT needed to compute the output in `r` (effects in reverse). Each effect adds its (rx, ry) and
 * pixel sort widens along its axis to whole 256 px chunks in surface (= document) coordinates. Clipped to w x h after every step.
 */
export function expandRect(r: Rect, effects: readonly AnyEffect[], forward: boolean, w: number, h: number): Rect | null {
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
export function planChain(effects: readonly AnyEffect[]): { effect: number; pass: EffectPass }[] {
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

/** 'none' (nothing to draw) | 'point' (an output pixel depends on the same input pixel only) | 'neighbourhood' | 'global' (any pixel). */
export function effectReads(e: AnyEffect): 'none' | 'point' | 'neighbourhood' | 'global' {
  if (!e || planEffect(e).length === 0) return 'none';
  if (isFilterType(e.type)) return filterReads(e as unknown as Record<string, unknown>);
  return e.type === 'pixelSort' ? 'global' : effectReach(e) > 0 ? 'neighbourhood' : 'point';
}

/** True when the output at a pixel reads other input pixels, i.e. a changed input region spreads (bbox / cache planning for adjustment layers). */
export function effectNeedsNeighbourhood(e: AnyEffect): boolean {
  const r = effectReads(e);
  return r === 'neighbourhood' || r === 'global';
}

/** v5 effects that fail the 3/255 parity on another GPU implementation (pixel sort ties): see docs/FILTERS.md. */
const TD_PREVIEW_V5 = new Set(['pixelSort']);

/** True when the browser preview cannot match TouchDesigner within 3/255 for this effect: the UI shows TD's render of the layer instead. */
export function effectTdPreview(e: AnyEffect): boolean {
  if (!e || e.enabled === false) return false;
  if (TD_PREVIEW_V5.has(e.type as string)) return planEffect(e).length > 0;
  return isFilterType(e.type) && filterTdPreview(e as unknown as Record<string, unknown>, planEffect(e).length > 0);
}

/** Every known filter type (spec files). */
export const filterTypes = (): string[] => Object.keys(FILTER_SPECS).sort();
