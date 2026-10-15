import type { LayerInfo } from '../engine/types';

export type DropZone = 'before' | 'after' | 'into';
export interface Drop { parentId: string | null; index: number }

/** Where a dragged layer lands when dropped on `targetId`. `index` counts siblings excluding the dragged layer (0 = top). */
export function computeDrop(layers: LayerInfo[], dragId: string, targetId: string, zone: DropZone): Drop | null {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const drag = byId.get(dragId), target = byId.get(targetId);
  if (!drag || !target || dragId === targetId) return null;
  for (let p: LayerInfo | undefined = target; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
    if (p.id === dragId) return null;
  }
  if (zone === 'into' && target.kind === 'group') return { parentId: target.id, index: 0 };
  const sibs = layers.filter((l) => l.parentId === target.parentId && l.id !== dragId);
  const at = sibs.findIndex((l) => l.id === targetId);
  return { parentId: target.parentId, index: zone === 'before' ? at : at + 1 };
}

export function dropZone(target: LayerInfo, relY: number): DropZone {
  if (target.kind === 'group' && relY > 0.25 && relY < 0.75) return 'into';
  return relY < 0.5 ? 'before' : 'after';
}
