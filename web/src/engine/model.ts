import type { AdjustmentSpec, BlendMode, LayerInfo, LayerSpec, Rect } from './types';
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
/** Layer mask: a document-sized surface stored as rgb = 255, alpha = mask value; follows the layer's (x, y). */
export interface Mask {
  slot: number;
  surface: Surface;
  enabled: boolean;
}
export interface PixelLayer extends LayerCommon {
  kind: 'pixel' | 'base';
  surface: Surface; // document sized; content is drawn at (x, y)
  x: number;
  y: number;
  slot: number | null; // surface slot (null for the base layer)
  mask: Mask | null;
}
export interface AdjustmentLayer extends LayerCommon {
  kind: 'adjustment';
  adjustment: AdjustmentSpec; // replaced wholesale, never mutated
  mask: Mask | null;
}

/** What a paint tool edits: a pixel layer's surface or a mask surface (layer space, offset by the layer). */
export interface EditTarget {
  readonly layer: PixelLayer | AdjustmentLayer;
  readonly surface: Surface;
  readonly isMask: boolean;
  readonly slot: number | null;
  readonly x: number;
  readonly y: number;
}
export interface GroupLayer extends LayerCommon {
  kind: 'group';
  children: Layer[]; // display order, index 0 = top
  expanded: boolean;
}
export type Layer = PixelLayer | GroupLayer | AdjustmentLayer;

export const BASE_ID = 'base';

export function isPixel(l: Layer): l is PixelLayer {
  return l.kind === 'pixel' || l.kind === 'base';
}

export function layerBounds(l: PixelLayer): Rect {
  return { x: l.x, y: l.y, w: l.surface.width, h: l.surface.height };
}

/** Everything a layer draws: its own bounds, the union of its descendants for a group, the whole document for an adjustment. */
export function layerExtent(l: Layer, docRect: Rect): Rect | null {
  if (l.kind === 'adjustment') return docRect;
  if (l.kind !== 'group') return layerBounds(l);
  return l.children.reduce<Rect | null>((acc, c) => union(acc, layerExtent(c, docRect)), null);
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
  mask: Mask | null;
  maskEnabled: boolean;
  adjustment: AdjustmentSpec | null;
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
  private slotSeq = 0;

  constructor(width: number, height: number, base: PixelLayer) {
    this.width = width;
    this.height = height;
    this.root = { id: 'root', kind: 'group', name: 'root', visible: true, locked: false, opacity: 1, blend: 'normal', children: [base], expanded: true };
    this.activeId = base.id;
  }

  newId(): string {
    return `L${++this.seq}`;
  }

  /** Next surface slot: unique within the document, never reused (slot 0 is reserved for BASE/VIEW frames). */
  newSlot(): number {
    if (this.slotSeq >= 65535) throw new RangeError('surface slots exhausted');
    return ++this.slotSeq;
  }

  /** After loading a document: continue numbering after the given ids and slots. */
  reseed(maxIdNumber: number, maxSlot: number): void {
    this.seq = Math.max(this.seq, maxIdNumber);
    this.slotSeq = Math.max(this.slotSeq, maxSlot);
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
        else if (c.kind !== 'adjustment') out.push(c);
      }
    };
    walk(this.root);
    return out;
  }

  /** Every layer in the tree (no root), top-first depth-first. */
  all(): Layer[] {
    const out: Layer[] = [];
    const walk = (g: GroupLayer): void => {
      for (const c of g.children) {
        out.push(c);
        if (c.kind === 'group') walk(c);
      }
    };
    walk(this.root);
    return out;
  }

  /** Every mask surface owner. */
  masks(): Mask[] {
    const out: Mask[] = [];
    for (const l of this.all()) if (l.kind !== 'group' && l.mask) out.push(l.mask);
    return out;
  }

  /** Wire form of the stack: bottom first, depth-first, group before its children (PROTOCOL §3). */
  layerSpecs(): LayerSpec[] {
    const out: LayerSpec[] = [];
    const walk = (g: GroupLayer, parentId: string | null): void => {
      for (let i = g.children.length - 1; i >= 0; i--) {
        const c = g.children[i];
        const hasPix = c.kind === 'pixel' || c.kind === 'base';
        out.push({
          id: c.id, kind: c.kind, parentId, name: c.name, visible: c.visible, opacity: c.opacity,
          blend: c.kind === 'adjustment' ? 'normal' : c.blend,
          x: hasPix ? c.x : 0, y: hasPix ? c.y : 0,
          slot: hasPix ? c.slot : null,
          mask: c.kind !== 'group' && c.mask ? { slot: c.mask.slot, enabled: c.mask.enabled } : null,
          adjustment: c.kind === 'adjustment' ? { ...c.adjustment } : null,
        });
        if (c.kind === 'group') walk(c, c.id);
      }
    };
    walk(this.root, null);
    return out;
  }

  /** Slots of all surfaces (pixel layers and masks) currently in the stack. */
  slots(): number[] {
    const out: number[] = [];
    for (const l of this.all()) {
      if (l.kind === 'pixel' && l.slot !== null) out.push(l.slot);
      if (l.kind !== 'group' && l.mask) out.push(l.mask.slot);
    }
    return out;
  }

  list(): LayerInfo[] {
    const out: LayerInfo[] = [];
    const walk = (g: GroupLayer, depth: number): void => {
      for (const c of g.children) {
        const info: LayerInfo = {
          id: c.id, name: c.name, kind: c.kind, visible: c.visible, locked: c.locked,
          opacity: c.opacity, blend: c.blend, depth, parentId: g === this.root ? null : g.id,
          slot: c.kind === 'pixel' ? c.slot : null,
          mask: c.kind !== 'group' && c.mask ? { slot: c.mask.slot, enabled: c.mask.enabled } : null,
          adjustment: c.kind === 'adjustment' ? { ...c.adjustment } : null,
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
      x: isPixel(l) ? l.x : 0, y: isPixel(l) ? l.y : 0,
      mask: l.kind === 'group' ? null : l.mask, maskEnabled: l.kind !== 'group' && l.mask ? l.mask.enabled : true,
      adjustment: l.kind === 'adjustment' ? l.adjustment : null,
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
        l.mask = n.mask;
        if (l.mask) l.mask.enabled = n.maskEnabled;
        if (l.kind === 'adjustment' && n.adjustment) l.adjustment = n.adjustment;
        else if (l.kind !== 'adjustment') {
          l.x = n.x;
          l.y = n.y;
        }
      }
    };
    apply(s.root);
    // View state is not history: keep the current active layer when it still exists; group expansion is never touched.
    if (!this.find(this.activeId)) this.activeId = this.find(s.active) ? s.active : this.root.children[0]?.id ?? null;
  }
}

/** Surface owners (pixel layers and masks) referenced by a snapshot. */
export function snapshotSurfaces(s: StructureSnapshot): Set<object> {
  const out = new Set<object>();
  const walk = (n: NodeSnap): void => {
    if (isPixel(n.layer)) out.add(n.layer);
    if (n.mask) out.add(n.mask);
    n.children?.forEach(walk);
  };
  walk(s.root);
  return out;
}

/** Do two snapshots describe the same docSpec()? (locked / expanded / active layer are not part of it.) */
export function specSame(a: StructureSnapshot, b: StructureSnapshot): boolean {
  const same = (x: NodeSnap, y: NodeSnap): boolean => {
    if (x.layer !== y.layer || x.name !== y.name || x.visible !== y.visible || x.opacity !== y.opacity || x.blend !== y.blend) return false;
    if (x.x !== y.x || x.y !== y.y || x.mask !== y.mask || x.maskEnabled !== y.maskEnabled || x.adjustment !== y.adjustment) return false;
    if (!x.children || !y.children) return x.children === y.children;
    return x.children.length === y.children.length && x.children.every((c, i) => same(c, (y.children as NodeSnap[])[i]));
  };
  return same(a.root, b.root);
}
