import type { BlendMode, LayerInfo, Rect } from './types';
import type { Surface } from './surface';
import { union } from './rect';

interface LayerCommon {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
}
export interface PixelLayer extends LayerCommon {
  kind: 'pixel' | 'base';
  surface: Surface; // document sized; content is drawn at (x, y)
  x: number;
  y: number;
}
export interface GroupLayer extends LayerCommon {
  kind: 'group';
  children: Layer[]; // display order, index 0 = top
  expanded: boolean;
}
export type Layer = PixelLayer | GroupLayer;

export const BASE_ID = 'base';

export function isPixel(l: Layer): l is PixelLayer {
  return l.kind !== 'group';
}

export function layerBounds(l: PixelLayer): Rect {
  return { x: l.x, y: l.y, w: l.surface.width, h: l.surface.height };
}

/** Everything a layer draws: its own bounds, or the union of its descendants for a group. */
export function layerExtent(l: Layer): Rect | null {
  if (l.kind !== 'group') return layerBounds(l);
  return l.children.reduce<Rect | null>((acc, c) => union(acc, layerExtent(c)), null);
}

interface NodeSnap {
  layer: Layer;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  x: number;
  y: number;
  children: NodeSnap[] | null;
}
export interface StructureSnapshot {
  active: string | null;
  root: NodeSnap;
}

export class Document {
  width: number;
  height: number;
  readonly root: GroupLayer;
  activeId: string | null = null;
  selection: Rect | null = null;
  private seq = 0;

  constructor(width: number, height: number, base: PixelLayer) {
    this.width = width;
    this.height = height;
    this.root = { id: 'root', kind: 'group', name: 'root', visible: true, locked: false, opacity: 1, blend: 'normal', children: [base], expanded: true };
    this.activeId = base.id;
  }

  newId(): string {
    return `L${++this.seq}`;
  }

  find(id: string | null): Layer | null {
    if (id === null) return null;
    const walk = (g: GroupLayer): Layer | null => {
      for (const c of g.children) {
        if (c.id === id) return c;
        if (c.kind === 'group') {
          const f = walk(c);
          if (f) return f;
        }
      }
      return null;
    };
    return walk(this.root);
  }

  locate(id: string): { parent: GroupLayer; index: number } | null {
    const walk = (g: GroupLayer): { parent: GroupLayer; index: number } | null => {
      for (let i = 0; i < g.children.length; i++) {
        const c = g.children[i];
        if (c.id === id) return { parent: g, index: i };
        if (c.kind === 'group') {
          const f = walk(c);
          if (f) return f;
        }
      }
      return null;
    };
    return walk(this.root);
  }

  active(): Layer | null {
    return this.find(this.activeId);
  }

  /** All pixel layers, bottom-up order not guaranteed. */
  pixelLayers(): PixelLayer[] {
    const out: PixelLayer[] = [];
    const walk = (g: GroupLayer): void => {
      for (const c of g.children) {
        if (c.kind === 'group') walk(c);
        else out.push(c);
      }
    };
    walk(this.root);
    return out;
  }

  list(): LayerInfo[] {
    const out: LayerInfo[] = [];
    const walk = (g: GroupLayer, depth: number): void => {
      for (const c of g.children) {
        const info: LayerInfo = {
          id: c.id, name: c.name, kind: c.kind, visible: c.visible, locked: c.locked,
          opacity: c.opacity, blend: c.blend, depth, parentId: g === this.root ? null : g.id,
        };
        if (c.kind === 'group') {
          info.expanded = c.expanded;
          out.push(info);
          if (c.expanded) walk(c, depth + 1);
        } else out.push(info);
      }
    };
    walk(this.root, 0);
    return out;
  }

  snapshot(): StructureSnapshot {
    const snap = (l: Layer): NodeSnap => ({
      layer: l, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend,
      x: l.kind === 'group' ? 0 : l.x, y: l.kind === 'group' ? 0 : l.y,
      children: l.kind === 'group' ? l.children.map(snap) : null,
    });
    return { active: this.activeId, root: snap(this.root) };
  }

  restore(s: StructureSnapshot): void {
    const apply = (n: NodeSnap): void => {
      const l = n.layer;
      l.name = n.name; l.visible = n.visible; l.locked = n.locked; l.opacity = n.opacity; l.blend = n.blend;
      if (l.kind === 'group' && n.children) {
        l.children = n.children.map((c) => c.layer);
        n.children.forEach(apply);
      } else if (l.kind !== 'group') {
        l.x = n.x;
        l.y = n.y;
      }
    };
    apply(s.root);
    // View state is not history: keep the current active layer when it still exists; group expansion is never touched.
    if (!this.find(this.activeId)) this.activeId = this.find(s.active) ? s.active : this.root.children[0]?.id ?? null;
  }
}

/** Pixel layers referenced by a snapshot. */
export function snapshotPixelLayers(s: StructureSnapshot): Set<PixelLayer> {
  const out = new Set<PixelLayer>();
  const walk = (n: NodeSnap): void => {
    if (n.layer.kind !== 'group') out.add(n.layer);
    n.children?.forEach(walk);
  };
  walk(s.root);
  return out;
}
