import type { AdjustmentSpec, BlendMode, CanvasMode, Effect, Guides, LayerInfo, LayerSpec, Rect, ShapeSpec, TextSpec } from './types';
import { resampled, type Surface } from './surface';
import type { SelState } from './selection';
import type { TileBackup } from './tiles';
import { union } from './rect';
import { cloneShape, cloneText, shapeBounds, shapeBox, textBounds, textBox } from './textShape';
import { IDENT, layerRectToDoc, outerRect, type Xf } from './xform';
import { effectsReach } from './effectsAdapter';

interface LayerCommon {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  effects: Effect[]; // v5: replaced wholesale, never mutated (empty for groups / adjustments)
}
/**
 * Layer mask, stored as rgb = 255, alpha = mask value. On a pixel layer it has the size of the layer's surface and lives
 * in layer space (same transform). On adjustment / text / shape layers it is document sized and lives in document space.
 */
export interface Mask {
  slot: number;
  surface: Surface;
  enabled: boolean;
}
export interface PixelLayer extends LayerCommon {
  kind: 'pixel' | 'input';
  surface: Surface; // own size; doc = T(x,y) . R(rot) . K(kx,ky) . S(sx,sy) . layer. Input layers share one surface per TD input
  x: number;
  y: number;
  sx: number;
  sy: number;
  rot: number; // v5: degrees, clockwise on screen
  kx: number; // v5: skew degrees
  ky: number;
  input?: number; // v5: input layers: 1..8
  slot: number | null; // surface slot (null for input layers)
  mask: Mask | null;
  /** Created empty by addPixelLayer and not written to since (paint, writeSurface): may follow a canvas size adopted from TD. */
  pristine?: boolean;
}
/** v4: text / shape layers never own a surface: the compositor draws the spec directly, TouchDesigner renders it. */
interface VectorCommon extends LayerCommon {
  mask: Mask | null; // document sized, document space (like an adjustment mask)
}
export interface TextLayer extends VectorCommon { kind: 'text'; spec: TextSpec }
export interface ShapeLayer extends VectorCommon { kind: 'shape'; spec: ShapeSpec }
export type VectorLayer = TextLayer | ShapeLayer;
/** Any layer that owns a surface (pixel, input). */
export type SurfaceLayer = PixelLayer;

export interface AdjustmentLayer extends LayerCommon {
  kind: 'adjustment';
  adjustment: null; // v7: legacy slot, always null (migrated into effects[], the FX stack applied to everything below)
  mask: Mask | null;
}

/** Document-space bounding box of a floating selection under its current transform. */
export function floatingBounds(f: Floating): Rect {
  return layerRectToDoc(f.t, { x: 0, y: 0, w: f.buf.width, h: f.buf.height });
}

/** v5: a TD input: its shared surface and last known state. */
export interface InputState { w: number; h: number; connected: boolean; surface: Surface }

/** What a paint tool edits: a pixel layer's surface or a mask surface (layer space, offset by the layer). */
export interface EditTarget {
  readonly layer: PixelLayer | AdjustmentLayer | VectorLayer | GroupLayer;
  readonly quick?: boolean; // v5: the quick mask (document sized, alpha = selection coverage)
  readonly surface: Surface;
  readonly isMask: boolean;
  readonly slot: number | null;
  /** layer -> document mapping of `surface` (identity for masks of document-space layers) */
  readonly tf: Xf;
}
export interface GroupLayer extends LayerCommon {
  kind: 'group';
  mask: Mask | null; // v7.3: document sized, document space; applied to the group's composite before its effects
  children: Layer[]; // display order, index 0 = top
  expanded: boolean;
}
export type Layer = PixelLayer | GroupLayer | AdjustmentLayer | VectorLayer;

/** v5: a floating selection (lifted pixels with their own transform), see Engine.liftSelection. */
export interface Floating {
  layer: PixelLayer;
  buf: Surface; // lifted pixels (coverage applied), w x h, layer pixel scale
  cov: Surface; // coverage as alpha (white), same size
  rect: Rect; // where it was lifted from (layer space)
  t0: Xf; // initial transform of the buffer (layer transform . translate(rect.x, rect.y))
  t: Xf; // current transform: doc = T(x,y) . R . K . S . buffer
  tb: TileBackup; // pre-cut pixels of the layer
  selBefore: SelState;
}

export function cloneEffect(e: Effect): Effect {
  return structuredClone(e);
}

export const BASE_ID = 'base'; // id of the default TD Input 1 layer (v5 migrates a 'base' layer to input 1 and keeps this id)
export const MAX_INPUTS = 8;

export function isPixel(l: Layer): l is PixelLayer {
  return l.kind === 'pixel' || l.kind === 'input';
}

export function isVector(l: Layer): l is VectorLayer {
  return l.kind === 'text' || l.kind === 'shape';
}

export function hasSurface(l: Layer): l is PixelLayer {
  return l.kind === 'pixel' || l.kind === 'input';
}

export function isInput(l: Layer): l is PixelLayer {
  return l.kind === 'input';
}

/** Mapping of a layer's own surface and mask into the document. */
export function layerXf(l: Layer): Xf {
  return isPixel(l) ? l : IDENT;
}

/** Exact (float) document-space bounds of a pixel layer's surface. */
export function surfaceDocBounds(l: PixelLayer): Rect {
  return layerRectToDoc(l, { x: 0, y: 0, w: l.surface.width, h: l.surface.height });
}

/** Document-space bounds of what a text / shape spec paints (conservative). */
export function specBounds(l: VectorLayer): Rect {
  return l.kind === 'text' ? textBounds(l.spec) : shapeBounds(l.spec);
}

const textBoxCache = new WeakMap<TextSpec, Rect>();

/** The box a transform box surrounds (float, document space): surface bounds, text layout box, shape geometry; null for groups / adjustments. */
export function layerBox(l: Layer): Rect | null {
  if (isPixel(l)) return surfaceDocBounds(l);
  if (l.kind === 'text') {
    let b = textBoxCache.get(l.spec);
    if (!b) textBoxCache.set(l.spec, (b = textBox(l.spec))); // text layout measures fonts: once per spec object
    return b;
  }
  if (l.kind === 'shape') return shapeBox(l.spec);
  return null;
}

export function grow(r: Rect, n: number): Rect {
  return n > 0 ? { x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n } : r;
}

/** Everything a layer draws (whole pixels): its own bounds, the union of its descendants for a group, the whole document for an adjustment. */
export function layerExtent(l: Layer, docRect: Rect): Rect | null {
  if (l.kind === 'adjustment') return docRect;
  if (isVector(l)) return grow(specBounds(l), effectsReach(l.effects));
  if (l.kind !== 'group') return grow(outerRect(surfaceDocBounds(l)), effectsReach(l.effects));
  const u = l.children.reduce<Rect | null>((acc, c) => union(acc, layerExtent(c, docRect)), null);
  return u && grow(u, effectsReach(l.effects)); // v6: a group's effects paint beyond its children
}

export interface NodeSnap {
  layer: Layer;
  rot: number;
  kx: number;
  ky: number;
  effects: Effect[];
  sw: number; // surface size when the snapshot was taken (input layers: restore keeps the displayed box if the input was resized since)
  sh: number;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  x: number;
  y: number;
  sx: number;
  sy: number;
  surface: Surface | null; // pixel layers: applyTransform / replaceWithPixels swap it
  mask: Mask | null;
  maskEnabled: boolean;
  adjustment: AdjustmentSpec | null;
  children: NodeSnap[] | null;
  spec: TextSpec | ShapeSpec | null;
}
export interface StructureSnapshot {
  stamp: number; // monotonic: layers auto-created from TD inputs after this stamp are re-added on restore
  active: string | null;
  root: NodeSnap;
}

export class Document {
  width: number;
  height: number;
  readonly root: GroupLayer;
  activeId: string | null = null;
  selection: Rect | null = null;
  shapeRenderer: 'sdf' | 'canvas' = 'sdf'; // how shape layers are drawn (not part of the document)
  guides: Guides = { h: [], v: [] };
  canvasMode: CanvasMode = 'input';
  private seq = 0;
  private slotSeq = 0;

  /** v5: TD inputs. One shared surface per input number (the layers referencing it share it); state as last told by TD. */
  readonly inputs = new Map<number, InputState>();
  /** v5: every input layer object ever created for this document (also deleted ones kept alive by history). */
  readonly inputLayers = new Set<PixelLayer>();
  /** v5: layers created from TD inputs without history: re-added when an older snapshot is restored. */
  readonly autoLayers: Array<{ layer: Layer; stamp: number; fromBottom: number }> = [];
  floating: Floating | null = null;
  private stampSeq = 0;

  constructor(width: number, height: number, first: Layer | null) {
    this.width = width;
    this.height = height;
    this.root = { id: 'root', kind: 'group', name: 'root', visible: true, locked: false, opacity: 1, blend: 'normal', effects: [], mask: null, children: first ? [first] : [], expanded: true };
    this.activeId = first ? first.id : null;
  }

  nextStamp(): number { return ++this.stampSeq; }

  inputConnected(l: PixelLayer): boolean {
    return l.kind !== 'input' || (this.inputs.get(l.input ?? 1)?.connected ?? true);
  }

  newId(): string {
    return `L${++this.seq}`;
  }

  /** Next surface slot: unique within the document, never reused (slot 0 is reserved for BASE/VIEW frames). */
  newSlot(): number {
    if (this.slotSeq >= 65535) throw new RangeError('surface slots exhausted');
    return ++this.slotSeq;
  }

  /** How many more slots can be allocated. */
  slotsLeft(): number { return 65535 - this.slotSeq; }

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

  /** All layers that own a surface (pixel, base), order not guaranteed. */
  pixelLayers(): SurfaceLayer[] {
    const out: SurfaceLayer[] = [];
    const walk = (g: GroupLayer): void => {
      for (const c of g.children) {
        if (c.kind === 'group') walk(c);
        else if (hasSurface(c)) out.push(c);
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
    for (const l of this.all()) if (l.mask) out.push(l.mask);
    return out;
  }

  /** Wire form of the stack: bottom first, depth-first, group before its children (PROTOCOL §3). */
  layerSpecs(): LayerSpec[] {
    const out: LayerSpec[] = [];
    const walk = (g: GroupLayer, parentId: string | null): void => {
      for (let i = g.children.length - 1; i >= 0; i--) {
        const c = g.children[i];
        const px = c.kind === 'pixel' || c.kind === 'input' ? c : null;
        out.push({
          id: c.id, kind: c.kind, parentId, name: c.name, visible: c.visible, opacity: c.opacity,
          blend: c.kind === 'adjustment' ? 'normal' : c.blend,
          x: px ? px.x : 0, y: px ? px.y : 0, sx: px ? px.sx : 1, sy: px ? px.sy : 1,
          rot: px ? px.rot : 0, kx: px ? px.kx : 0, ky: px ? px.ky : 0,
          input: c.kind === 'input' ? c.input ?? 1 : null,
          effects: c.effects.map(cloneEffect),
          slot: c.kind === 'pixel' ? c.slot : null,
          mask: c.mask ? { slot: c.mask.slot, enabled: c.mask.enabled } : null,
          adjustment: null,
          text: c.kind === 'text' ? cloneText(c.spec) : null,
          shape: c.kind === 'shape' ? cloneShape(c.spec) : null,
          surfaceW: px ? px.surface.width : null, surfaceH: px ? px.surface.height : null,
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
      if (l.mask) out.push(l.mask.slot);
    }
    return out;
  }

  list(): LayerInfo[] {
    const out: LayerInfo[] = [];
    const walk = (g: GroupLayer, depth: number): void => {
      for (const c of g.children) {
        const px = c.kind === 'pixel' || c.kind === 'input' ? c : null;
        const info: LayerInfo = {
          id: c.id, name: c.name, kind: c.kind, visible: c.visible, locked: c.locked,
          opacity: c.opacity, blend: c.blend, depth, parentId: g === this.root ? null : g.id,
          slot: c.kind === 'pixel' ? c.slot : null,
          mask: c.mask ? { slot: c.mask.slot, enabled: c.mask.enabled } : null,
          adjustment: null,
          text: c.kind === 'text' ? cloneText(c.spec) : null,
          shape: c.kind === 'shape' ? cloneShape(c.spec) : null,
          transform: px ? { x: px.x, y: px.y, sx: px.sx, sy: px.sy, rot: px.rot, kx: px.kx, ky: px.ky } : { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 },
          input: c.kind === 'input' ? c.input ?? 1 : null,
          inputConnected: c.kind === 'input' ? this.inputConnected(c) : null,
          effects: c.effects.map(cloneEffect),
          surfaceW: px ? px.surface.width : null, surfaceH: px ? px.surface.height : null,
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
      x: isPixel(l) ? l.x : 0, y: isPixel(l) ? l.y : 0, sx: isPixel(l) ? l.sx : 1, sy: isPixel(l) ? l.sy : 1,
      rot: isPixel(l) ? l.rot : 0, kx: isPixel(l) ? l.kx : 0, ky: isPixel(l) ? l.ky : 0, effects: l.effects,
      sw: isPixel(l) ? l.surface.width : 0, sh: isPixel(l) ? l.surface.height : 0,
      surface: l.kind === 'pixel' ? l.surface : null, // an input surface is TouchDesigner's: never part of history
      mask: l.mask, maskEnabled: l.mask ? l.mask.enabled : true,
      adjustment: null,
      children: l.kind === 'group' ? l.children.map(snap) : null,
      spec: isVector(l) ? l.spec : null,
    });
    return { stamp: this.nextStamp(), active: this.activeId, root: snap(this.root) };
  }

  /**
   * Put a snapshot back. Returns the mask surfaces of TD input layers that were replaced because the input changed resolution since the
   * snapshot was taken (v7.3: the mask is stretched to the layer's surface in normalised UVs, as resizeInput does); they are not released.
   */
  restore(s: StructureSnapshot): Surface[] {
    const replaced: Surface[] = [];
    const apply = (n: NodeSnap): void => {
      const l = n.layer;
      l.name = n.name; l.visible = n.visible; l.locked = n.locked; l.opacity = n.opacity; l.blend = n.blend;
      l.effects = n.effects;
      if (l.kind === 'group' && n.children) {
        l.mask = n.mask;
        if (l.mask) l.mask.enabled = n.maskEnabled;
        l.children = n.children.map((c) => c.layer);
        n.children.forEach(apply);
      } else if (l.kind !== 'group') {
        l.mask = n.mask;
        if (l.mask) l.mask.enabled = n.maskEnabled;
        if (l.kind === 'input' && l.mask && (l.mask.surface.width !== l.surface.width || l.mask.surface.height !== l.surface.height)) {
          replaced.push(l.mask.surface);
          l.mask.surface = resampled(l.mask.surface, l.surface.width, l.surface.height, true);
        }
        if (isVector(l)) (l as { spec: unknown }).spec = n.spec;
        else if (l.kind !== 'adjustment') { // adjustment layers: effects[] (restored above) is everything
          l.x = n.x;
          l.y = n.y;
          l.sx = n.sx;
          l.sy = n.sy;
          l.rot = n.rot;
          l.kx = n.kx;
          l.ky = n.ky;
          if (n.surface && l.kind === 'pixel') l.surface = n.surface;
          else if (l.kind === 'input' && !(this.canvasMode === 'input' && l.input === 1) && n.sw > 0 && (n.sw !== l.surface.width || n.sh !== l.surface.height)) {
            // the input was resized since: keep the box it showed (as setInputs does in a fixed canvas)
            l.sx = (n.sx * n.sw) / l.surface.width;
            l.sy = (n.sy * n.sh) / l.surface.height;
          }
        }
      }
    };
    apply(s.root);
    // Layers created from TD inputs after this snapshot was taken are not in it: keep them (they have no history entry).
    for (const a of this.autoLayers) {
      if (a.stamp > s.stamp && !this.locate(a.layer.id)) {
        const at = Math.max(0, this.root.children.length - a.fromBottom);
        this.root.children.splice(at, 0, a.layer);
      }
    }
    // View state is not history: keep the current active layer when it still exists; group expansion is never touched.
    if (!this.find(this.activeId)) this.activeId = this.find(s.active) ? s.active : this.root.children[0]?.id ?? null;
    return replaced;
  }
}

/** Surfaces (pixel layers and masks) referenced by a snapshot: history memory accounting. */
export function snapshotSurfaces(s: StructureSnapshot): Set<Surface> {
  const out = new Set<Surface>();
  const walk = (n: NodeSnap): void => {
    if (n.surface) out.add(n.surface);
    if (n.mask) out.add(n.mask.surface);
    n.children?.forEach(walk);
  };
  walk(s.root);
  return out;
}

/** Do two snapshots describe the same docSpec()? (locked / expanded / active layer are not part of it.) */
export function specSame(a: StructureSnapshot, b: StructureSnapshot): boolean {
  const same = (x: NodeSnap, y: NodeSnap): boolean => {
    if (x.layer !== y.layer || x.name !== y.name || x.visible !== y.visible || x.opacity !== y.opacity || x.blend !== y.blend) return false;
    if (x.x !== y.x || x.y !== y.y || x.sx !== y.sx || x.sy !== y.sy || x.rot !== y.rot || x.kx !== y.kx || x.ky !== y.ky || x.effects !== y.effects || x.mask !== y.mask || x.maskEnabled !== y.maskEnabled || x.adjustment !== y.adjustment) return false;
    if (x.spec !== y.spec) return false;
    if ((x.surface?.width ?? 0) !== (y.surface?.width ?? 0) || (x.surface?.height ?? 0) !== (y.surface?.height ?? 0)) return false;
    if (!x.children || !y.children) return x.children === y.children;
    return x.children.length === y.children.length && x.children.every((c, i) => same(c, (y.children as NodeSnap[])[i]));
  };
  return same(a.root, b.root);
}
