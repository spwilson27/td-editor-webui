// v5 layer effects UI state.
import { signal } from '@preact/signals';
import type { Effect } from '../engine/types';
import type { SliceCtx } from './slice';

export function createEffectsSlice(ctx: SliceCtx) {
  /** Layer whose Effects panel is open (the panel follows the active layer; kept for explicit opens). */
  const effectsFor = signal<string | null>(null);
  /** The pending (not yet sent) edit; a signal so the panel shows it instantly. */
  const draftSig = signal<Map<string, Effect[]>>(new Map());
  let flush: number | null = null;
  return {
    effectsFor,
    /** Layer ▸ Layer Effects… / the fx button: select the layer and show the Effects tab. */
    openEffects(layerId?: string) {
      if (!ctx.hasEngine()) return;
      const id = layerId ?? ctx.engine().activeLayerId();
      if (!id) return;
      if (ctx.engine().activeLayerId() !== id) ctx.engine().setActiveLayer(id);
      effectsFor.value = id;
      ctx.setLayerTab('fx');
    },
    canHaveEffects(kind?: string): boolean { return kind === 'pixel' || kind === 'text' || kind === 'shape' || kind === 'input'; },
    /** Live effect edits: latest wins, at most one engine.setEffects per animation frame. */
    editEffects(id: string, effects: Effect[]) {
      draftSig.value = new Map(draftSig.peek()).set(id, effects);
      if (flush !== null) return;
      flush = requestAnimationFrame(() => {
        flush = null;
        const d = draftSig.peek();
        draftSig.value = new Map();
        if (ctx.hasEngine()) for (const [lid, fx] of d) ctx.engine().setEffects(lid, fx);
      });
    },
    /** The effects shown by the panel: the pending draft when one exists, else the engine's. */
    pendingEffects(id: string): Effect[] | null { return draftSig.value.get(id) ?? null; },
    effectsDraft: draftSig,
  };
}
