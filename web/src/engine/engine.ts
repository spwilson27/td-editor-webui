import type {
  BrushSettings, EditorEngine, EngineEvent, HistoryEntry, LayerInfo, Rect, RGBA, ToolContext, ToolId, ToolPointer,
} from './types';
import { Compositor } from './compositor';
import { History } from './history';
import { BASE_ID, Document, layerExtent, snapshotPixelLayers, type GroupLayer, type Layer, type PixelLayer, type StructureSnapshot } from './model';
import type { Patch } from './tiles';
import { clipToSize, equal, intersect, isEmpty, translate, union } from './rect';
import { createSurface, releaseSurface, resizedCopy } from './surface';
import type { Host, Scratch, Tool } from './tools/host';
import { StrokeTool } from './tools/paint';
import { FillTool, GradientTool, MarqueeTool, MoveTool, PickerTool } from './tools/others';

const MAX_BRUSH = 1000;
const MAX_DIM = 16384;
const PAINT_TOOLS: ToolId[] = ['brush', 'pencil', 'eraser', 'fill', 'gradient'];
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

  constructor(width: number, height: number) {
    const w = clampDim(width);
    const h = clampDim(height);
    const base: PixelLayer = {
      id: BASE_ID, kind: 'base', name: 'TD Input', visible: true, locked: true, opacity: 1, blend: 'normal',
      surface: createSurface(w, h), x: 0, y: 0,
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

  editableLayer(): PixelLayer | null {
    const l = this.doc.active();
    const why = !l || l.kind === 'group' ? 'Select a pixel layer' : !l.visible ? 'Layer is hidden' : l.locked ? 'Layer is locked' : null;
    if (why) {
      this.emit({ type: 'notice', message: why });
      return null;
    }
    return l as PixelLayer;
  }

  changed(r: Rect): void {
    this.version++;
    this.compositor.invalidate(r);
    const c = clipToSize(r, this.doc.width, this.doc.height);
    if (c) this.emit({ type: 'pixels', rect: c });
  }

  pushPatch(label: string, layer: PixelLayer, patches: Patch[]): void {
    const apply = (which: 'before' | 'after') => () => {
      for (const p of patches) {
        layer.surface.ctx.putImageData(p[which], p.rect.x, p.rect.y);
        this.changed(translate(p.rect, layer.x, layer.y));
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
      this.doc.restore(s);
      this.structureChanged();
    };
    // Layers only history keeps alive (deleted / not yet re-added) hold whole surfaces.
    const a = snapshotPixelLayers(before);
    const b = snapshotPixelLayers(after);
    let held = 0;
    a.forEach((l) => { if (!b.has(l)) held++; });
    b.forEach((l) => { if (!a.has(l)) held++; });
    const bytes = 256 + held * this.doc.width * this.doc.height * 4;
    this.hist.push({ label, bytes, undo: apply(before), redo: apply(after), coalesceKey });
    this.structureChanged(dirty);
    this.emit({ type: 'history' });
  }

  sample(x: number, y: number): RGBA | null {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (!(px >= 0 && py >= 0 && px < this.doc.width && py < this.doc.height)) return null;
    this.compositor.flush();
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
    Object.values(this.scratch).forEach(releaseSurface);
    this.scratch = this.makeScratch();
    this.compositor.resize();
    this.version++;
    this.thumbs.clear();
    const oldSel = this.doc.selection;
    this.doc.selection = oldSel && clipToSize(oldSel, w, h);
    this.baseDirty = null;
    this.hist.clear();
    this.emit({ type: 'resize', width: w, height: h });
    if (!equal(oldSel, this.doc.selection)) this.emit({ type: 'selection' });
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
    };
    this.insertAboveActive('Add layer', layer, false);
    return layer.id;
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
    const ext = layerExtent(l);
    const visible = ext && intersect(ext, { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
    const affectsPixels = keys.some((k) => k !== 'name' && k !== 'locked');
    this.commitStructure(single ? PROP_LABELS[single] : 'Layer properties', before, single === 'opacity' ? `opacity:${id}` : undefined, affectsPixels ? visible ?? false : false);
  }

  flattenToNewLayer(): string {
    this.compositor.flush();
    const layer: PixelLayer = {
      id: this.doc.newId(), kind: 'pixel', name: 'Flattened', visible: true, locked: false, opacity: 1, blend: 'normal',
      surface: createSurface(this.doc.width, this.doc.height), x: 0, y: 0,
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
    const src = l.kind === 'group' ? this.compositor.renderIsolated(l) : l.surface;
    const ox = l.kind === 'group' ? 0 : l.x;
    const oy = l.kind === 'group' ? 0 : l.y;
    c.imageSmoothingQuality = 'high';
    c.drawImage(src.canvas as CanvasImageSource, (target.width - w) / 2 + ox * k, (target.height - h) / 2 + oy * k, w, h);
    if (l.kind === 'group') {
      if (this.thumbs.size > 64) this.thumbs.clear();
      const copy = document.createElement('canvas');
      copy.width = target.width;
      copy.height = target.height;
      (copy.getContext('2d') as CanvasRenderingContext2D).drawImage(target, 0, 0);
      this.thumbs.set(id, { version: this.version, canvas: copy });
    }
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
    this.compositor.flush();
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
  }

  private structureChanged(dirty: Rect | null | false = null): void {
    this.version++;
    if (dirty !== false) this.compositor.invalidate(dirty);
    this.emit({ type: 'structure' });
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
