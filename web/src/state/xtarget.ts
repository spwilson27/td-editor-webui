// The Move tool's oriented transform target: the active pixel / input layer, or the floating selection (Transform Selection).
import type { LayerInfo, LayerTransform } from '../engine/types';
import type { Store } from './store';

export interface OTarget {
  floating: boolean;
  layer: LayerInfo | null;
  /** Current transform (surface → doc) and the unscaled surface size it applies to. */
  t: LayerTransform;
  w: number;
  h: number;
  set(t: LayerTransform): void;
}

export function orientedTarget(store: Store): OTarget | null {
  if (!store.hasEngine()) return null;
  const e = store.engine, f = e.floating();
  if (f) {
    // the engine's bounds is the bbox under the current transform; the buffer size comes from floatingSize() when present
    const sz = (e as { floatingSize?: () => { w: number; h: number } | null }).floatingSize?.() ?? f.bounds;
    return { floating: true, layer: null, t: f.transform, w: sz.w, h: sz.h, set: (t) => e.setFloatingTransform(t) };
  }
  const l = store.activeLayer();
  if (!l || (l.kind !== 'pixel' && l.kind !== 'input') || !store.canEditTransform(l)) return null;
  return { floating: false, layer: l, t: l.transform, w: l.surfaceW ?? e.width, h: l.surfaceH ?? e.height, set: (t) => e.setTransform(l.id, t) };
}
