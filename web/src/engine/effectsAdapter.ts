// Adapter between the engine and the effects module (./effects/index.ts).
// Called interface: applyEffects(src: Surface, effects, rect, out: Surface): Rect (surface pixel coords, same size/space for src and out)
// and effectsReach(effects): number (may be Infinity: clamped here to 16384 so dirty rects clip to the document).
import type { Effect, Rect } from './types';
import type { Surface } from './surface';
import * as fx from './effects';
import { expandRect } from './effects/plan';

export const hasEffects = (effects: readonly Effect[]): boolean => effects.length > 0 && effects.some((e) => e.enabled);

export function effectsReach(effects: readonly Effect[]): number {
  if (!hasEffects(effects)) return 0;
  try {
    const n = fx.effectsReach(effects.filter((e) => e.enabled));
    return Number.isNaN(n) || n <= 0 ? 0 : Math.min(16384, Math.ceil(n));
  } catch {
    return 0;
  }
}

/** Run the enabled effects over `rect` (document space; src / out are document-sized); returns the rewritten rect of `out`, or null on failure (caller draws src). */
export function applyEffectsSafe(src: Surface, effects: readonly Effect[], rect: Rect, out: Surface, aux?: Surface | null): Rect | null {
  if (!hasEffects(effects)) return null;
  try {
    return fx.applyEffects(src, effects.filter((e) => e.enabled), rect, out, aux);
  } catch (err) {
    console.error('applyEffects failed', err);
    return null;
  }
}

/**
 * The region of `src` (document space) the effects read to produce the output over `rect`: the module's own backward expansion
 * (reach per effect, pixel sort widened to whole 256 px chunks). The compositor must paint the layer content over all of it,
 * because everything outside is stale.
 */
export function effectsSourceRect(effects: readonly Effect[], rect: Rect, w: number, h: number): Rect | null {
  const on = effects.filter((e) => e.enabled);
  const out = expandRect(rect, on, true, w, h);
  return out ? expandRect(out, on, false, w, h) : null;
}

const flagMemo = new WeakMap<object, boolean>();
const restMemo = new WeakMap<object, Effect[]>();

/** Does the effect stack hold an enabled effect the browser cannot match (planner `effectTdPreview`)? Effect arrays are replaced, never mutated: memoised per array. */
export function tdPreviewFlag(effects: readonly Effect[]): boolean {
  let v = flagMemo.get(effects);
  if (v === undefined) {
    try { v = effects.some((e) => fx.effectTdPreview(e)); } catch { v = false; }
    flagMemo.set(effects, v);
  }
  return v;
}

/** The stack without the planner-flagged effects (what the Local preview can compute while TD's render is pending). Same array when nothing is flagged. */
export function withoutTdPreview(effects: readonly Effect[]): readonly Effect[] {
  if (!tdPreviewFlag(effects)) return effects;
  let v = restMemo.get(effects);
  if (!v) {
    v = effects.filter((e) => { try { return !fx.effectTdPreview(e); } catch { return true; } });
    restMemo.set(effects, v);
  }
  return v;
}

export const effectIsTdPreview = (e: Effect): boolean => { try { return fx.effectTdPreview(e); } catch { return false; } };

export type AuxRef = { kind: 'layer'; id: string } | { kind: 'input'; input: number };
const auxMemo = new WeakMap<object, AuxRef | null>();

/**
 * The aux image reference of an effect list (same rule as td/raster_editor/network.py effect_aux_ref): the first enabled effect with
 * `source: 'aux'` and `auxSource` = 'layer:<layerId>' | 'input:<n>' (n 1..8) or the object forms {kind:'layer', id} | {kind:'input', input}.
 * One aux image per chain.
 */
export function auxRef(effects: readonly Effect[]): AuxRef | null {
  let v = auxMemo.get(effects);
  if (v !== undefined) return v;
  v = null;
  const input = (n: unknown): AuxRef | null => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 8 ? { kind: 'input', input: n } : null);
  for (const e of effects) {
    const o = e as unknown as Record<string, unknown>;
    if (!o || o.enabled === false || o.source !== 'aux') continue;
    const s = o.auxSource;
    let r: AuxRef | null = null;
    if (typeof s === 'string') {
      const i = s.indexOf(':');
      const kind = s.slice(0, i);
      const rest = s.slice(i + 1);
      if (kind === 'layer' && rest) r = { kind: 'layer', id: rest };
      else if (kind === 'input' && /^\d+$/.test(rest)) r = input(+rest);
    } else if (s && typeof s === 'object') {
      const t = s as Record<string, unknown>;
      if (t.kind === 'layer' && typeof t.id === 'string' && t.id) r = { kind: 'layer', id: t.id };
      else if (t.kind === 'input') r = input(t.input);
    }
    if (r) { v = r; break; }
  }
  auxMemo.set(effects, v);
  return v;
}
