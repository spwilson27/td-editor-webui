// Validation of effect / filter parameters (shared by layers, adjustments and the document loader).
import type { Effect, RGBA } from './types';

export const MAX_EFFECTS = 32;

const EFFECT_NAME = /^[A-Za-z][A-Za-z0-9]{0,47}$/;
const fnum = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const fint = (v: unknown, lo: number, hi: number, def: number): number => Math.round(fnum(v, lo, hi, def));
const fpick = <T extends string>(v: unknown, ok: readonly T[], def: T): T => (ok.includes(v as T) ? (v as T) : def);
function frgba(c: unknown, def: RGBA): RGBA {
  const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
  return { r: fnum(o.r, 0, 255, def.r), g: fnum(o.g, 0, 255, def.g), b: fnum(o.b, 0, 255, def.b), a: fnum(o.a, 0, 255, def.a) };
}
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };

/**
 * One effect with every field present and inside the ranges TouchDesigner accepts (td/raster_editor/protocol.py _EFFECT_FIELDS):
 * missing / non-finite values take defaults, numbers are clamped. A type outside the ten v5 effects (a v6 filter) is kept verbatim
 * (opaque parameters, deep copy, `enabled` as a boolean): TD owns its parameters. null = not an effect (no valid type name).
 */
export function sanitizeEffect(e: unknown): Effect | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !EFFECT_NAME.test(type)) return null;
  const enabled = o.enabled !== false;
  switch (type) {
    case 'dropShadow':
      return { enabled, type, dx: fnum(o.dx, -4096, 4096, 4), dy: fnum(o.dy, -4096, 4096, 4), blur: fnum(o.blur, 0, 512, 6), color: frgba(o.color, BLACK), opacity: fnum(o.opacity, 0, 1, 0.75) };
    case 'outerGlow':
    case 'innerGlow':
      return { enabled, type, size: fnum(o.size, 0, 512, 8), color: frgba(o.color, WHITE), opacity: fnum(o.opacity, 0, 1, 0.75) };
    case 'stroke':
      return { enabled, type, width: fnum(o.width, 0, 512, 2), color: frgba(o.color, BLACK), position: fpick(o.position, ['inside', 'center', 'outside'] as const, 'outside'), opacity: fnum(o.opacity, 0, 1, 1) };
    case 'bevel':
      return { enabled, type, depth: fnum(o.depth, 0, 100, 50), size: fnum(o.size, 0, 512, 4), angle: fnum(o.angle, -3600, 3600, 120), highlight: frgba(o.highlight, WHITE), shadow: frgba(o.shadow, BLACK) };
    case 'colorOverlay':
      return { enabled, type, color: frgba(o.color, { r: 255, g: 0, b: 0, a: 255 }), opacity: fnum(o.opacity, 0, 1, 1) };
    case 'pixelSort':
      return { enabled, type, direction: fpick(o.direction, ['h', 'v'] as const, 'h'), low: fnum(o.low, 0, 1, 0.25), high: fnum(o.high, 0, 1, 0.75), key: fpick(o.key, ['luma', 'hue'] as const, 'luma') };
    case 'glitch':
      return { enabled, type, amount: fnum(o.amount, 0, 100, 30), blockSize: fnum(o.blockSize, 1, 4096, 16), seed: fint(o.seed, 0, 2 ** 31, 1), rgbShift: fnum(o.rgbShift, -1000, 1000, 4) };
    case 'chromaticAberration':
      return { enabled, type, amount: fnum(o.amount, -1000, 1000, 4), angle: fnum(o.angle, -3600, 3600, 0) };
    case 'halftone':
      return { enabled, type, cellSize: fnum(o.cellSize, 1, 512, 8), angle: fnum(o.angle, -3600, 3600, 45), shape: fpick(o.shape, ['dot', 'line'] as const, 'dot') };
    default: {
      try { if (JSON.stringify(o).length > 1_000_000) return null; } catch { return null; } // opaque parameters: bounded
      let c: Record<string, unknown>;
      try { c = structuredClone(o) as Record<string, unknown>; } catch { return null; }
      c.enabled = enabled;
      return c as unknown as Effect;
    }
  }
}

/** Validated copy of an effect stack (entries without a valid type name are dropped, see sanitizeEffect). */
export function sanitizeEffects(list: unknown): Effect[] {
  if (!Array.isArray(list)) return [];
  const out: Effect[] = [];
  for (const e of list.slice(0, MAX_EFFECTS)) {
    const c = sanitizeEffect(e);
    if (c) out.push(c);
  }
  return out;
}
export const sameEffects = (a: Effect[], b: Effect[]): boolean => a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
