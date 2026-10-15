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
export function applyEffectsSafe(src: Surface, effects: readonly Effect[], rect: Rect, out: Surface): Rect | null {
  if (!hasEffects(effects)) return null;
  try {
    return fx.applyEffects(src, effects.filter((e) => e.enabled), rect, out);
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
