import type { LayerInfo } from '../engine/types';

export type DropZone = 'before' | 'after' | 'into';
export interface Drop { parentId: string | null; index: number }

/**
 * Where dragged layer(s) land when dropped on `targetId`. `index` counts siblings excluding every dragged layer (0 = top).
 * Null when the drop is meaningless: onto a dragged layer or into one of its descendants.
 * `copy` (v7.1, Cmd/Ctrl-drag): the originals stay where they are, so every sibling counts and any target is legal (a copy may land
 * inside its own source group).
 */
export function computeDrop(layers: LayerInfo[], dragIds: string | string[], targetId: string, zone: DropZone, copy = false): Drop | null {
  const drags = new Set(typeof dragIds === 'string' ? [dragIds] : dragIds);
  const byId = new Map(layers.map((l) => [l.id, l]));
  const target = byId.get(targetId);
  if (!drags.size || !target || [...drags].some((d) => !byId.has(d))) return null;
  if (!copy) for (let p: LayerInfo | undefined = target; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
    if (drags.has(p.id)) return null;
  }
  if (zone === 'into' && target.kind === 'group') return { parentId: target.id, index: 0 };
  const sibs = layers.filter((l) => l.parentId === target.parentId && (copy || !drags.has(l.id)));
  const at = sibs.findIndex((l) => l.id === targetId);
  return { parentId: target.parentId, index: zone === 'before' ? at : at + 1 };
}

export function dropZone(target: LayerInfo, relY: number): DropZone {
  if (target.kind === 'group' && relY > 0.25 && relY < 0.75) return 'into';
  return relY < 0.5 ? 'before' : 'after';
}

/** The layers of `ids` that are not inside another layer of `ids` (a group carries its children), in display order. */
export function topLevelOf(layers: LayerInfo[], ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const byId = new Map(layers.map((l) => [l.id, l]));
  return layers.filter((l) => {
    if (!set.has(l.id)) return false;
    for (let p = l.parentId ? byId.get(l.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) if (set.has(p.id)) return false;
    return true;
  }).map((l) => l.id);
}

/** The sibling directly below `id` (same parent, next lower in the stack) among the visible rows, if any. */
export function layerBelow(layers: LayerInfo[], id: string): LayerInfo | undefined {
  const i = layers.findIndex((l) => l.id === id);
  if (i < 0) return undefined;
  const me = layers[i];
  for (let j = i + 1; j < layers.length; j++) {
    if (layers[j].parentId === me.parentId) return layers[j];
    if (layers[j].depth < me.depth) return undefined;
  }
  return undefined;
}
