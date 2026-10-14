import type {
  AdjustmentSpec, AdjustmentType, BlendMode, BrushSettings, DocSpec, EditorEngine, EngineEvent, HistoryEntry, LayerInfo, PaintTarget,
  Rect, RGBA, ToolContext, ToolId, ToolPointer,
} from './types';
import { ADJUSTMENT_NAMES, clampAdjustment, defaultAdjustment, isIdentity, sameAdjustment } from './adjustments';
import { Compositor } from './compositor';
import { History } from './history';
import { BASE_ID, Document, layerExtent, snapshotSurfaces, specSame, type AdjustmentLayer, type EditTarget, type GroupLayer, type Layer, type Mask, type PixelLayer, type StructureSnapshot } from './model';
import type { Patch } from './tiles';
import { clipToSize, equal, intersect, isEmpty, translate, union } from './rect';
import { createSurface, releaseSurface, resizedCopy, type Surface } from './surface';
import type { Host, Scratch, Tool } from './tools/host';
import { StrokeTool } from './tools/paint';
import { FillTool, GradientTool, MarqueeTool, MoveTool, PickerTool } from './tools/others';

const MAX_BRUSH = 1000;
const MAX_DIM = 16384;
const PAINT_TOOLS: ToolId[] = ['brush', 'pencil', 'eraser', 'fill', 'gradient'];
const BLENDS: ReadonlySet<string> = new Set<BlendMode>([
  'normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);
const PROP_LABELS = { name: 'Rename layer', visible: 'Toggle visibility', locked: 'Toggle lock', opacity: 'Layer opacity', blend: 'Blend mode', expanded: 'Expand group' };

type LayerProps = Partial<Pick<LayerInfo, 'name' | 'visible' | 'locked' | 'opacity' | 'blend' | 'expanded'>>;

function defaultContext(): ToolContext {
  const brush: BrushSettings = { size: 20, opacity: 1, flow: 1, hardness: 0.8, spacing: 0.15 };
  return { primary: { r: 0, g: 0, b: 0, a: 255 }, secondary: { r: 255, g: 255, b: 255, a: 255 }, brush, fillTolerance: 32 };
}

function clampDim(n: number): number {
  return Math.min(MAX_DIM, Math.max(1, Math.round(n) || 1));
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** A document-sized mask surface, fully visible (white). */
function whiteMask(w: number, h: number): Surface {
  const s = createSurface(w, h, true);
  s.ctx.fillStyle = '#fff';
  s.ctx.fillRect(0, 0, w, h);
  return s;
}

/** Resized copy of a mask: old content top-left, new area fully visible. */
function resizedMask(old: Surface, w: number, h: number): Surface {
  const s = whiteMask(w, h);
  s.ctx.clearRect(0, 0, Math.min(w, old.width), Math.min(h, old.height));
  s.ctx.drawImage(old.canvas as CanvasImageSource, 0, 0);
  return s;
}

export class Engine implements EditorEngine, Host {
  readonly doc: Document;
  scratch: Scratch;
  private compositor: Compositor;
  private hist = new History();
  private listeners = new Set<(e: EngineEvent) => void>();
  private ctx = defaultContext();
  private toolId: ToolId = 'brush';
  private tools: Partial<Record<ToolId, Tool>>;
  private active: Tool | null = null;
  private last: ToolPointer | null = null;
  private baseDirty: Rect | null = null;
  private layerCount = 0;
  private groupCount = 0;
  private version = 0; // bumped on every visible change; keys the group thumbnail cache
  private thumbs = new Map<string, { version: number; canvas: HTMLCanvasElement }>();
  private rev = 0;
  private liveSpec = false; // a move drag already announced its offsets
  private knownSlots = new Set<number>();
  private freshSlots = new Set<number>(); // slots of just-created empty layers: no 'surface' event needed
  private maskTargetLayer: string | null = null; // layer whose mask is the paint target
  private surfaceDirty: Rect | null = null; // writeSurface area (document space) waiting for commitSurfaces
  private conv = new Uint8ClampedArray(0);

  constructor(width: number, height: number) {
    const w = clampDim(width);
    const h = clampDim(height);
    const base: PixelLayer = {
      id: BASE_ID, kind: 'base', name: 'TD Input', visible: true, locked: true, opacity: 1, blend: 'normal',
      surface: createSurface(w, h), x: 0, y: 0, slot: null, mask: null,
    };
    this.doc = new Document(w, h, base);
    this.scratch = this.makeScratch();
    this.compositor = new Compositor(this.doc, (rect) => this.emit({ type: 'composite', rect }));
    this.tools = {
      move: new MoveTool(this),
      marquee: new MarqueeTool((r) => this.setSelection(r)),
      brush: new StrokeTool(this, 'brush'),
      pencil: new StrokeTool(this, 'pencil'),
      eraser: new StrokeTool(this, 'eraser'),
      fill: new FillTool(this),
      gradient: new GradientTool(this),
      picker: new PickerTool(this),
    };
  }

  get width(): number { return this.doc.width; }
  get height(): number { return this.doc.height; }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(e: EngineEvent): void {
    for (const l of Array.from(this.listeners)) {
      try { l(e); } catch (err) { console.error('engine listener failed', err); }
    }
  }

  // ---- Host (used by tools) ----

  context(): ToolContext { return this.ctx; }

  editableLayer(): EditTarget | null {
    const l = this.doc.active();
    const toMask = l !== null && l.kind !== 'group' && l.mask !== null && this.paintTarget().target === 'mask';
    const why = !l || l.kind === 'group' ? 'Select a pixel layer'
      : l.kind === 'adjustment' && !toMask ? 'Select a pixel layer or a mask'
        : !l.visible ? 'Layer is hidden' : l.locked ? 'Layer is locked' : null;
    if (why || !l || l.kind === 'group') {
      this.emit({ type: 'notice', message: why ?? 'Select a pixel layer' });
      return null;
    }
    return this.makeTarget(l, toMask);
  }

  movableLayer(): PixelLayer | null {
    const l = this.doc.active();
    const why = !l || l.kind === 'group' || l.kind === 'adjustment' ? 'Select a pixel layer to move' : !l.visible ? 'Layer is hidden' : l.locked ? 'Layer is locked' : null;
    if (why || !l || l.kind === 'group' || l.kind === 'adjustment') {
      this.emit({ type: 'notice', message: why ?? 'Select a pixel layer to move' });
      return null;
    }
    return l;
  }

  private makeTarget(layer: PixelLayer | AdjustmentLayer, mask: boolean): EditTarget {
    const m = layer.mask as Mask;
    return {
      layer, isMask: mask,
      surface: mask ? m.surface : (layer as PixelLayer).surface,
      slot: mask ? m.slot : (layer as PixelLayer).slot,
      get x() { return layer.kind === 'adjustment' ? 0 : layer.x; },
      get y() { return layer.kind === 'adjustment' ? 0 : layer.y; },
    };
  }

  changed(r: Rect): void {
    this.version++;
    this.compositor.invalidate(r);
    const c = clipToSize(r, this.doc.width, this.doc.height);
    if (c) this.emit({ type: 'pixels', rect: c });
  }

  paintChanged(target: EditTarget, docRect: Rect): void {
    this.changed(docRect);
    if (target.slot === null) return;
    const lr = clipToSize(translate(docRect, -target.x, -target.y), target.surface.width, target.surface.height);
    if (lr) this.emit({ type: 'surface', slot: target.slot, rect: lr });
  }

  docMoved(): void {
    this.liveSpec = true;
    this.syncSpec(true);
  }

  pushPatch(label: string, target: EditTarget, patches: Patch[]): void {
    const apply = (which: 'before' | 'after') => () => {
      for (const p of patches) {
        target.surface.ctx.putImageData(p[which], p.rect.x, p.rect.y);
        this.paintChanged(target, translate(p.rect, target.x, target.y));
      }
    };
    const bytes = patches.reduce((n, p) => n + p.before.data.length + p.after.data.length, 0);
    this.hist.push({ label, bytes, undo: apply('before'), redo: apply('after') });
    this.emit({ type: 'history' });
  }

  /**
   * Record a structural edit already applied since `before`. `dirty` is the document area to recomposite
   * (null = all, false = nothing visible changed).
   */
  commitStructure(label: string, before: StructureSnapshot, coalesceKey?: string, dirty: Rect | null | false = null): void {
    const after = this.doc.snapshot();
    const apply = (s: StructureSnapshot) => () => {
      const prev = this.doc.snapshot();
      this.doc.restore(s);
      this.structureChanged(null, !specSame(prev, this.doc.snapshot()));
    };
    // Layers only history keeps alive (deleted / not yet re-added) hold whole surfaces.
    const a = snapshotSurfaces(before);
    const b = snapshotSurfaces(after);
    let held = 0;
    a.forEach((l) => { if (!b.has(l)) held++; });
    b.forEach((l) => { if (!a.has(l)) held++; });
    const bytes = 256 + held * this.doc.width * this.doc.height * 4;
    this.hist.push({ label, bytes, undo: apply(before), redo: apply(after), coalesceKey });
    const announced = this.liveSpec; // a move drag sent these offsets already
    this.liveSpec = false;
    this.structureChanged(dirty, !announced && !specSame(before, after));
    this.emit({ type: 'history' });
  }

  sample(x: number, y: number): RGBA | null {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (!(px >= 0 && py >= 0 && px < this.doc.width && py < this.doc.height)) return null;
    this.compositor.ensure({ x: px, y: py, w: 1, h: 1 });
    const d = this.compositor.surface.ctx.getImageData(px, py, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  }

  // ---- Document ----

  resize(width: number, height: number): void {
    this.finishStroke();
    const w = clampDim(width);
    const h = clampDim(height);
    if (w === this.doc.width && h === this.doc.height) return;
    this.doc.width = w;
    this.doc.height = h;
    for (const l of this.doc.pixelLayers()) {
      const old = l.surface;
      l.surface = resizedCopy(old, w, h);
      releaseSurface(old);
    }
    for (const m of this.doc.masks()) {
      const old = m.surface;
      m.surface = resizedMask(old, w, h);
      releaseSurface(old);
    }
    Object.values(this.scratch).forEach(releaseSurface);
    this.scratch = this.makeScratch();
    this.compositor.resize();
    this.version++;
    this.thumbs.clear();
    const oldSel = this.doc.selection;
    this.doc.selection = oldSel && clipToSize(oldSel, w, h);
    this.baseDirty = null;
    this.hist.clear();
    this.surfaceDirty = null;
    this.emit({ type: 'resize', width: w, height: h });
    if (!equal(oldSel, this.doc.selection)) this.emit({ type: 'selection' });
    this.syncSpec(true);
    for (const m of this.doc.masks()) this.emit({ type: 'surface', slot: m.slot, rect: { x: 0, y: 0, w, h } }); // new area is visible
    this.emit({ type: 'history' });
  }

  layers(): LayerInfo[] { return this.doc.list(); }
  activeLayerId(): string | null { return this.doc.activeId; }

  setActiveLayer(id: string): void {
    if (!this.doc.find(id) || this.doc.activeId === id) return;
    this.finishStroke();
    this.doc.activeId = id;
    this.emit({ type: 'structure' });
  }

  addPixelLayer(name?: string): string {
    const layer: PixelLayer = {
      id: this.doc.newId(), kind: 'pixel', name: name ?? `Layer ${++this.layerCount}`, visible: true, locked: false,
      opacity: 1, blend: 'normal', surface: createSurface(this.doc.width, this.doc.height), x: 0, y: 0,
      slot: this.doc.newSlot(), mask: null,
    };
    this.freshSlots.add(layer.slot as number);
    this.insertAboveActive('Add layer', layer, false);
    return layer.id;
  }

  addAdjustment(type: AdjustmentType): string {
    const adjustment = defaultAdjustment(type);
    const layer: AdjustmentLayer = {
      id: this.doc.newId(), kind: 'adjustment', name: ADJUSTMENT_NAMES[type], visible: true, locked: false,
      opacity: 1, blend: 'normal', adjustment, mask: null,
    };
    this.insertAboveActive('Add adjustment', layer, isIdentity(adjustment) ? false : null);
    return layer.id;
  }

  setAdjustment(id: string, spec: AdjustmentSpec): void {
    const l = this.doc.find(id);
    if (!l || l.kind !== 'adjustment') return;
    const next = clampAdjustment(spec);
    if (sameAdjustment(next, l.adjustment)) return;
    this.finishStroke();
    const before = this.doc.snapshot();
    l.adjustment = next;
    this.commitStructure('Adjustment', before, `adj:${id}`, l.visible && l.opacity > 0 ? null : false);
  }

  addMask(layerId: string): number {
    const l = this.doc.find(layerId);
    if (!l || l.kind === 'group' || l.kind === 'base') {
      this.emit({ type: 'notice', message: 'Masks need a pixel or adjustment layer' });
      return -1;
    }
    if (l.mask) return l.mask.slot;
    const mask: Mask = { slot: this.doc.newSlot(), surface: whiteMask(this.doc.width, this.doc.height), enabled: true };
    this.structural('Add mask', () => { l.mask = mask; }, false); // white: nothing visible changes
    return mask.slot;
  }

  deleteMask(layerId: string): void {
    const l = this.doc.find(layerId);
    if (!l || l.kind === 'group' || !l.mask) return;
    const visible = l.mask.enabled ? layerExtent(l, this.docRect()) : false;
    this.structural('Delete mask', () => { l.mask = null; }, visible);
  }

  setMaskEnabled(layerId: string, enabled: boolean): void {
    const l = this.doc.find(layerId);
    if (!l || l.kind === 'group' || !l.mask || l.mask.enabled === enabled) return;
    const mask = l.mask;
    this.structural(enabled ? 'Enable mask' : 'Disable mask', () => { mask.enabled = enabled; }, layerExtent(l, this.docRect()));
  }

  setPaintTarget(layerId: string, target: PaintTarget): void {
    const l = this.doc.find(layerId);
    if (!l || l.kind === 'group') return;
    let t = target;
    if (t === 'mask' && !l.mask) {
      this.emit({ type: 'notice', message: 'Layer has no mask' });
      t = 'pixels';
    }
    this.finishStroke();
    const was = this.paintTarget();
    this.doc.activeId = layerId;
    this.maskTargetLayer = t === 'mask' ? layerId : null;
    const now = this.paintTarget();
    if (was.layerId !== now.layerId || was.target !== now.target) this.emit({ type: 'structure' });
  }

  paintTarget(): { layerId: string | null; target: PaintTarget } {
    const l = this.doc.active();
    const mask = l !== null && l.kind !== 'group' && l.mask !== null && this.maskTargetLayer === l.id;
    return { layerId: this.doc.activeId, target: mask ? 'mask' : 'pixels' };
  }

  addGroup(name?: string): string {
    const group: GroupLayer = {
      id: this.doc.newId(), kind: 'group', name: name ?? `Group ${++this.groupCount}`, visible: true, locked: false,
      opacity: 1, blend: 'normal', children: [], expanded: true,
    };
    this.insertAboveActive('Add group', group, false);
    return group.id;
  }

  deleteLayer(id: string): void {
    if (id === BASE_ID) return this.emit({ type: 'notice', message: 'The base layer cannot be deleted' });
    const loc = this.doc.locate(id);
    if (!loc) return;
    this.structural('Delete layer', () => {
      loc.parent.children.splice(loc.index, 1);
      if (!this.doc.find(this.doc.activeId)) {
        const next = loc.parent.children[loc.index] ?? loc.parent.children[loc.index - 1] ?? (loc.parent === this.doc.root ? null : loc.parent);
        this.doc.activeId = (next ?? this.doc.root.children[0]).id;
      }
    });
    this.thumbs.forEach((_, k) => { if (!this.doc.find(k)) this.thumbs.delete(k); });
  }

  moveLayer(id: string, targetParentId: string | null, index: number): void {
    const loc = this.doc.locate(id);
    const layer = this.doc.find(id);
    if (!loc || !layer || id === BASE_ID) return;
    const target = targetParentId === null ? this.doc.root : this.doc.find(targetParentId);
    if (!target || target.kind !== 'group') return;
    if (layer.kind === 'group' && (target === layer || this.isInside(layer, target))) return;
    const others = target.children.length - (target === loc.parent ? 1 : 0);
    const max = others - (target === this.doc.root ? 1 : 0); // the base layer stays at the bottom of the root
    const at = Math.max(0, Math.min(Math.trunc(index) || 0, max));
    if (target === loc.parent && at === loc.index) return;
    this.structural('Move layer', () => {
      loc.parent.children.splice(loc.index, 1);
      target.children.splice(at, 0, layer);
    });
  }

  setLayerProps(id: string, props: LayerProps): void {
    const l = this.doc.find(id);
    if (!l) return;
    const next: LayerProps = { ...props };
    if (next.opacity !== undefined) next.opacity = clamp01(next.opacity);
    if (next.name !== undefined) next.name = String(next.name);
    if (l.kind === 'base') delete next.locked; // the base layer stays locked: it is TouchDesigner's input
    if (l.kind === 'adjustment') delete next.blend; // adjustments have no blend mode
    const keys = (Object.keys(next) as (keyof LayerProps)[]).filter((k) => {
      if (next[k] === undefined) return false;
      return k === 'expanded' ? l.kind === 'group' && l.expanded !== next[k] : l[k as 'name'] !== next[k];
    });
    if (!keys.length) return;
    this.finishStroke();
    const before = this.doc.snapshot();
    for (const k of keys) (l as unknown as Record<string, unknown>)[k] = next[k];
    if (keys.every((k) => k === 'expanded')) {
      this.emit({ type: 'structure' }); // view state only: no history, no recomposite
      return;
    }
    const single = keys.length === 1 ? keys[0] : null;
    const ext = layerExtent(l, this.docRect());
    const visible = ext && intersect(ext, { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
    const affectsPixels = keys.some((k) => k !== 'name' && k !== 'locked');
    this.commitStructure(single ? PROP_LABELS[single] : 'Layer properties', before, single === 'opacity' ? `opacity:${id}` : undefined, affectsPixels ? visible ?? false : false);
  }

  flattenToNewLayer(): string {
    this.compositor.ensure(null);
    const layer: PixelLayer = {
      id: this.doc.newId(), kind: 'pixel', name: 'Flattened', visible: true, locked: false, opacity: 1, blend: 'normal',
      surface: createSurface(this.doc.width, this.doc.height), x: 0, y: 0, slot: this.doc.newSlot(), mask: null,
    };
    layer.surface.ctx.drawImage(this.compositor.surface.canvas as CanvasImageSource, 0, 0);
    this.structural('Flatten', () => {
      this.doc.root.children.unshift(layer);
      this.doc.activeId = layer.id;
    });
    return layer.id;
  }

  drawThumbnail(id: string, target: HTMLCanvasElement): void {
    const l = this.doc.find(id);
    const c = target.getContext('2d');
    if (!l || !c) return;
    c.clearRect(0, 0, target.width, target.height);
    if (l.kind === 'adjustment') return; // the UI shows an icon
    if (l.kind === 'group') {
      // Rendering a group means compositing it at document size; reuse the result until something changes.
      const hit = this.thumbs.get(id);
      if (hit && hit.version === this.version && hit.canvas.width === target.width && hit.canvas.height === target.height) {
        c.drawImage(hit.canvas, 0, 0);
        return;
      }
    }
    const k = Math.min(target.width / this.doc.width, target.height / this.doc.height);
    const w = this.doc.width * k;
    const h = this.doc.height * k;
    const group = l.kind === 'group';
    const src = group ? this.compositor.renderIsolated(l, k) : l.surface; // groups render at thumbnail scale
    const sw = group ? Math.max(1, Math.round(this.doc.width * k)) : this.doc.width;
    const sh = group ? Math.max(1, Math.round(this.doc.height * k)) : this.doc.height;
    const ox = group ? 0 : l.x;
    const oy = group ? 0 : l.y;
    c.imageSmoothingQuality = 'high';
    c.drawImage(src.canvas as CanvasImageSource, 0, 0, sw, sh, (target.width - w) / 2 + ox * k, (target.height - h) / 2 + oy * k, w, h);
    if (l.kind === 'group') {
      if (this.thumbs.size > 64) this.thumbs.clear();
      const copy = document.createElement('canvas');
      copy.width = target.width;
      copy.height = target.height;
      (copy.getContext('2d') as CanvasRenderingContext2D).drawImage(target, 0, 0);
      this.thumbs.set(id, { version: this.version, canvas: copy });
    }
  }

  drawMaskThumbnail(id: string, target: HTMLCanvasElement): void {
    const l = this.doc.find(id);
    const c = target.getContext('2d');
    if (!l || !c) return;
    c.clearRect(0, 0, target.width, target.height);
    if (l.kind === 'group' || !l.mask) return;
    const k = Math.min(target.width / this.doc.width, target.height / this.doc.height);
    const w = this.doc.width * k;
    const h = this.doc.height * k;
    const ox = (target.width - w) / 2;
    const oy = (target.height - h) / 2;
    c.fillStyle = '#000';
    c.fillRect(ox, oy, w, h);
    c.imageSmoothingQuality = 'high';
    const lx = l.kind === 'adjustment' ? 0 : l.x;
    const ly = l.kind === 'adjustment' ? 0 : l.y;
    c.save();
    c.beginPath();
    c.rect(ox, oy, w, h);
    c.clip();
    c.drawImage(l.mask.surface.canvas as CanvasImageSource, ox + lx * k, oy + ly * k, w, h); // white with alpha = grey on black
    c.restore();
  }

  // ---- Document I/O (v2) ----

  docSpec(): DocSpec {
    return { rev: this.rev, width: this.doc.width, height: this.doc.height, layers: this.doc.layerSpecs() };
  }

  surfaceSlots(): number[] { return this.doc.slots(); }

  /** Surface behind a slot, or null when no layer or mask of the current stack owns it. */
  private surfaceOf(slot: number): { surface: Surface; isMask: boolean; ox: number; oy: number } | null {
    for (const l of this.doc.all()) {
      if (l.kind === 'group') continue;
      const ox = l.kind === 'adjustment' ? 0 : l.x;
      const oy = l.kind === 'adjustment' ? 0 : l.y;
      if (l.kind === 'pixel' && l.slot === slot) return { surface: l.surface, isMask: false, ox, oy };
      if (l.mask && l.mask.slot === slot) return { surface: l.mask.surface, isMask: true, ox, oy };
    }
    return null;
  }

  readSurface(slot: number, request: Rect, out?: Uint8ClampedArray): Uint8ClampedArray {
    const fin = (n: number) => (Number.isFinite(n) ? Math.floor(n) : 0);
    const rect = { x: fin(request.x), y: fin(request.y), w: Math.max(0, fin(request.w)), h: Math.max(0, fin(request.h)) };
    const n = rect.w * rect.h * 4;
    const res = out && out.length >= n ? out : new Uint8ClampedArray(n);
    res.fill(0, 0, n);
    const t = this.surfaceOf(slot);
    const clip = t && n ? clipToSize(rect, t.surface.width, t.surface.height) : null;
    if (!t || !clip) return res;
    const data = t.surface.ctx.getImageData(clip.x, clip.y, clip.w, clip.h).data;
    for (let y = 0; y < clip.h; y++) {
      const src = y * clip.w * 4;
      const dst = ((clip.y - rect.y + y) * rect.w + clip.x - rect.x) * 4;
      if (!t.isMask) {
        res.set(data.subarray(src, src + clip.w * 4), dst);
        continue;
      }
      for (let x = 0; x < clip.w; x++) {
        const v = data[src + x * 4 + 3];
        const o = dst + x * 4;
        res[o] = v;
        res[o + 1] = v;
        res[o + 2] = v;
        res[o + 3] = 255;
      }
    }
    return res;
  }

  writeSurface(slot: number, rect: Rect, rgba: Uint8Array | Uint8ClampedArray): void {
    const ints = [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
    if (!ints || rect.w < 0 || rect.h < 0) throw new RangeError('writeSurface: rect must be integers with non-negative size');
    const need = rect.w * rect.h * 4;
    if (rgba.length < need) throw new RangeError(`writeSurface: need ${need} bytes, got ${rgba.length}`);
    const t = this.surfaceOf(slot);
    if (!t) return; // slot removed meanwhile
    const clip = clipToSize(rect, t.surface.width, t.surface.height);
    if (!clip) return;
    let view: Uint8ClampedArray<ArrayBuffer>;
    if (t.isMask) {
      if (this.conv.length < need) this.conv = new Uint8ClampedArray(need);
      view = this.conv.subarray(0, need) as Uint8ClampedArray<ArrayBuffer>;
      for (let i = 0; i < need; i += 4) {
        view[i] = 255;
        view[i + 1] = 255;
        view[i + 2] = 255;
        view[i + 3] = rgba[i]; // grey on the wire: r = mask value
      }
    } else {
      view = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need);
    }
    t.surface.ctx.putImageData(new ImageData(view, rect.w, rect.h), rect.x, rect.y, clip.x - rect.x, clip.y - rect.y, clip.w, clip.h);
    this.surfaceDirty = union(this.surfaceDirty, translate(clip, t.ox, t.oy));
    this.emit({ type: 'surface', slot, rect: clip });
  }

  commitSurfaces(): void {
    if (!this.surfaceDirty) return;
    const r = this.surfaceDirty;
    this.surfaceDirty = null;
    this.changed(r);
  }

  setPreviewEnabled(enabled: boolean): void { this.compositor.setEnabled(enabled); }

  /** Replace the whole document. Surfaces start empty (masks fully visible); pixels arrive through writeSurface. */
  loadDocument(spec: DocSpec): void {
    const plan = this.validateSpec(spec);
    this.finishStroke();
    const w = clampDim(spec.width);
    const h = clampDim(spec.height);
    const resized = w !== this.doc.width || h !== this.doc.height;
    const oldBase = this.doc.find(BASE_ID) as PixelLayer;
    const keep = new Set<Surface>([oldBase.surface]);
    if (resized) keep.clear();
    for (const l of this.doc.pixelLayers()) if (!keep.has(l.surface)) releaseSurface(l.surface);
    for (const m of this.doc.masks()) releaseSurface(m.surface);
    this.doc.width = w;
    this.doc.height = h;
    const kids = new Map<string | null, Layer[]>([[null, []]]);
    let maxId = 0;
    let maxSlot = 0;
    const mk = (m: { slot: number; enabled: boolean } | null): Mask | null => {
      if (!m) return null;
      maxSlot = Math.max(maxSlot, m.slot);
      return { slot: m.slot, enabled: m.enabled, surface: whiteMask(w, h) };
    };
    for (const sp of plan) {
      const num = /^L(\d+)$/.exec(sp.id);
      if (num) maxId = Math.max(maxId, Number(num[1]));
      const common = {
        id: sp.kind === 'base' ? BASE_ID : sp.id, name: String(sp.name), visible: !!sp.visible, locked: sp.kind === 'base',
        opacity: clamp01(Number(sp.opacity)), blend: (BLENDS.has(sp.blend) ? sp.blend : 'normal') as BlendMode,
      };
      let layer: Layer;
      if (sp.kind === 'group') {
        layer = { ...common, kind: 'group', children: [], expanded: true };
        kids.set(sp.id, []);
      } else if (sp.kind === 'adjustment') {
        layer = { ...common, blend: 'normal', kind: 'adjustment', adjustment: clampAdjustment(sp.adjustment as AdjustmentSpec), mask: mk(sp.mask) };
      } else if (sp.kind === 'base') {
        layer = oldBase;
        Object.assign(oldBase, common, { x: 0, y: 0, slot: null, mask: null, surface: resized ? createSurface(w, h) : oldBase.surface });
      } else {
        maxSlot = Math.max(maxSlot, sp.slot as number);
        layer = { ...common, kind: 'pixel', surface: createSurface(w, h), x: Math.round(sp.x) || 0, y: Math.round(sp.y) || 0, slot: sp.slot as number, mask: mk(sp.mask) };
      }
      (kids.get(sp.parentId) as Layer[]).push(layer);
    }
    kids.forEach((list) => list.reverse()); // engine order: index 0 = top
    const attach = (list: Layer[]): void => {
      for (const l of list) if (l.kind === 'group') { l.children = kids.get(l.id) as Layer[]; attach(l.children); }
    };
    this.doc.root.children = kids.get(null) as Layer[];
    attach(this.doc.root.children);
    this.doc.reseed(maxId, maxSlot);
    if (!this.doc.find(this.doc.activeId)) this.doc.activeId = this.doc.root.children[0]?.id ?? BASE_ID;
    this.maskTargetLayer = null;
    if (resized) {
      Object.values(this.scratch).forEach(releaseSurface);
      this.scratch = this.makeScratch();
      this.compositor.resize();
    } else {
      this.compositor.invalidate(null);
    }
    this.version++;
    this.thumbs.clear();
    const hadSel = this.doc.selection !== null;
    this.doc.selection = null;
    this.baseDirty = null;
    this.surfaceDirty = null;
    this.freshSlots.clear();
    this.knownSlots.clear(); // every slot counts as new: a 'surface' event for each
    this.hist.clear();
    if (resized) this.emit({ type: 'resize', width: w, height: h });
    if (hadSel) this.emit({ type: 'selection' });
    this.emit({ type: 'structure' });
    this.syncSpec(true);
    this.emit({ type: 'history' });
  }

  private validateSpec(spec: DocSpec): DocSpec['layers'] {
    const bad = (m: string): never => { throw new RangeError(`loadDocument: ${m}`); };
    if (!spec || !Array.isArray(spec.layers) || !spec.layers.length) bad('no layers');
    if (!(spec.width >= 1 && spec.height >= 1)) bad('bad size');
    const ids = new Set<string>();
    const groups = new Set<string>();
    const slots = new Set<number>();
    const take = (n: unknown): void => {
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 65535 || slots.has(n as number)) bad(`bad or duplicate slot ${String(n)}`);
      slots.add(n as number);
    };
    spec.layers.forEach((l, i) => {
      if ((l.kind === 'base') !== (i === 0)) bad('exactly one base layer, first');
      if (ids.has(l.id)) bad(`duplicate id ${l.id}`);
      ids.add(l.id);
      if (i === 0 ? l.parentId !== null : l.parentId !== null && !groups.has(l.parentId)) bad(`bad parent of ${l.id}`);
      if (l.kind === 'group') groups.add(l.id);
      else if (l.kind === 'pixel') take(l.slot);
      else if (l.kind === 'adjustment') { if (!l.adjustment || !(l.adjustment.type in ADJUSTMENT_NAMES)) bad(`adjustment ${l.id}`); }
      else if (l.kind !== 'base') bad(`unknown kind ${String(l.kind)}`);
      if (l.mask && l.kind !== 'group' && l.kind !== 'base') take(l.mask.slot);
      else if (l.mask) bad(`${l.kind} layers cannot have masks`);
    });
    return spec.layers;
  }

  // ---- Base layer ----

  writeBase(rect: Rect, rgba: Uint8Array | Uint8ClampedArray): void {
    const ints = [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
    if (!ints || rect.w < 0 || rect.h < 0) throw new RangeError('writeBase: rect must be integers with non-negative size');
    const need = rect.w * rect.h * 4;
    if (rgba.length < need) throw new RangeError(`writeBase: need ${need} bytes, got ${rgba.length}`);
    const clip = clipToSize(rect, this.doc.width, this.doc.height);
    if (!clip) return;
    const base = this.doc.find(BASE_ID) as PixelLayer;
    const view = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need);
    base.surface.ctx.putImageData(new ImageData(view, rect.w, rect.h), rect.x, rect.y, clip.x - rect.x, clip.y - rect.y, clip.w, clip.h);
    this.baseDirty = union(this.baseDirty, translate(clip, base.x, base.y));
  }

  commitBase(): void {
    if (!this.baseDirty) return;
    const r = this.baseDirty;
    this.baseDirty = null;
    this.changed(r);
  }

  // ---- Output ----

  readComposite(request: Rect, out?: Uint8ClampedArray): Uint8ClampedArray {
    const fin = (n: number) => (Number.isFinite(n) ? Math.floor(n) : 0);
    const rect = { x: fin(request.x), y: fin(request.y), w: Math.max(0, fin(request.w)), h: Math.max(0, fin(request.h)) };
    const n = rect.w * rect.h * 4;
    const res = out && out.length >= n ? out : new Uint8ClampedArray(n);
    const clip = clipToSize(rect, this.doc.width, this.doc.height);
    if (!clip || !n) return res;
    this.compositor.ensure(clip);
    const data = this.compositor.surface.ctx.getImageData(clip.x, clip.y, clip.w, clip.h).data;
    if (clip.w === rect.w && clip.h === rect.h) {
      res.set(data);
      return res;
    }
    res.fill(0, 0, n);
    for (let y = 0; y < clip.h; y++) {
      res.set(data.subarray(y * clip.w * 4, (y + 1) * clip.w * 4), ((clip.y - rect.y + y) * rect.w + clip.x - rect.x) * 4);
    }
    return res;
  }

  compositeSource(): CanvasImageSource { return this.compositor.surface.canvas as CanvasImageSource; }

  /** Composite any pending dirty area now (otherwise it happens on the next animation frame). */
  flush(): void { this.compositor.flush(); }

  // ---- Selection ----

  selection(): Rect | null { return this.doc.selection && { ...this.doc.selection }; }

  setSelection(rect: Rect | null): void {
    const r = rect && clipToSize(rect, this.doc.width, this.doc.height);
    const next = r && !isEmpty(r) ? r : null;
    if (equal(next, this.doc.selection)) return;
    this.doc.selection = next;
    this.emit({ type: 'selection' });
  }

  // ---- Tools ----

  setTool(id: ToolId): void {
    this.finishStroke();
    this.toolId = id;
  }

  setToolContext(ctx: ToolContext): void {
    const b = ctx.brush;
    this.ctx = {
      primary: { ...ctx.primary },
      secondary: { ...ctx.secondary },
      brush: { ...b, size: Math.min(MAX_BRUSH, Math.max(1, b.size)), opacity: clamp01(b.opacity), flow: clamp01(b.flow), hardness: clamp01(b.hardness) },
      fillTolerance: ctx.fillTolerance,
    };
  }

  pointerDown(p: ToolPointer): void {
    this.finishStroke();
    this.last = p;
    this.active = (p.alt && PAINT_TOOLS.includes(this.toolId) ? this.tools.picker : this.tools[this.toolId]) ?? null;
    this.active?.down(p);
  }

  pointerMove(p: ToolPointer): void {
    this.last = p;
    this.active?.move(p);
  }

  pointerUp(p: ToolPointer): void {
    const t = this.active;
    this.active = null;
    this.last = null;
    t?.up(p);
    this.liveSpec = false;
  }

  // ---- History ----

  undo(): void {
    this.finishStroke();
    if (this.hist.undo()) this.emit({ type: 'history' });
  }

  redo(): void {
    this.finishStroke();
    if (this.hist.redo()) this.emit({ type: 'history' });
  }

  history(): { entries: HistoryEntry[]; index: number } {
    return { entries: this.hist.entries(), index: this.hist.index };
  }

  jumpTo(index: number): void {
    this.finishStroke();
    const before = this.hist.index;
    this.hist.jumpTo(index);
    if (this.hist.index !== before) this.emit({ type: 'history' });
  }

  clearHistory(): void {
    this.finishStroke();
    this.hist.clear();
    this.emit({ type: 'history' });
  }

  dispose(): void {
    this.finishStroke();
    this.compositor.dispose();
    Object.values(this.scratch).forEach(releaseSurface);
    this.doc.pixelLayers().forEach((l) => releaseSurface(l.surface));
    this.doc.masks().forEach((m) => releaseSurface(m.surface));
    this.listeners.clear();
  }

  // ---- internals ----

  private makeScratch(): Scratch {
    return {
      stroke: createSurface(this.doc.width, this.doc.height),
      backup: createSurface(this.doc.width, this.doc.height),
      stamp: createSurface(MAX_BRUSH + 2, MAX_BRUSH + 2),
    };
  }

  private finishStroke(): void {
    const t = this.active;
    const p = this.last;
    this.active = null;
    this.last = null;
    if (t && p) t.up(p);
    this.liveSpec = false;
  }

  private structureChanged(dirty: Rect | null | false, specChanged: boolean): void {
    this.version++;
    if (dirty !== false) this.compositor.invalidate(dirty);
    this.emit({ type: 'structure' });
    this.syncSpec(specChanged);
  }

  private docRect(): Rect { return { x: 0, y: 0, w: this.doc.width, h: this.doc.height }; }

  /**
   * Emit 'docspec' (rev++) when what docSpec() returns changed, then a full-surface 'surface' event for every slot
   * that newly exists (undo of a delete, redo of an add mask, ...): TouchDesigner may have dropped it.
   */
  private syncSpec(specChanged: boolean): void {
    const slots = this.doc.slots();
    const added: number[] = [];
    for (const s of slots) {
      if (this.knownSlots.has(s)) continue;
      if (!this.freshSlots.delete(s)) added.push(s);
    }
    this.knownSlots = new Set(slots);
    if (specChanged) {
      this.rev++;
      this.emit({ type: 'docspec' });
    }
    for (const s of added) {
      const t = this.surfaceOf(s);
      if (t) this.emit({ type: 'surface', slot: s, rect: { x: 0, y: 0, w: t.surface.width, h: t.surface.height } });
    }
  }

  private structural(label: string, mutate: () => void, dirty: Rect | null | false = null): void {
    this.finishStroke();
    const before = this.doc.snapshot();
    mutate();
    this.commitStructure(label, before, undefined, dirty);
  }

  private insertAboveActive(label: string, layer: Layer, dirty: Rect | null | false): void {
    this.structural(label, () => {
      const loc = this.doc.activeId ? this.doc.locate(this.doc.activeId) : null;
      (loc ? loc.parent : this.doc.root).children.splice(loc ? loc.index : 0, 0, layer);
      this.doc.activeId = layer.id;
    }, dirty);
  }

  private isInside(group: GroupLayer, maybeDescendant: Layer): boolean {
    return group.children.some((c) => c === maybeDescendant || (c.kind === 'group' && this.isInside(c, maybeDescendant)));
  }
}
