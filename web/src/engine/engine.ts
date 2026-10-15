import type {
  AdjustmentSpec, AdjustmentType, Anchor, BlendMode, BrushSettings, CanvasMode, DocSpec, EditorEngine, EngineEvent, Guides, HistoryEntry,
  LayerInfo, LayerTransform, PaintTarget, Rect, RGBA, SelectionOptions, ShapeSpec, ShapeType, SnapOptions, TextSpec, ToolContext, ToolId,
  ToolPointer,
} from './types';
import { ADJUSTMENT_NAMES, clampAdjustment, defaultAdjustment, isIdentity, sameAdjustment } from './adjustments';
import { Compositor } from './compositor';
import { History } from './history';
import {
  BASE_ID, Document, isPixel, isVector, layerBox, layerExtent, layerXf, snapshotSurfaces, specBounds, specSame, surfaceDocBounds,
  type AdjustmentLayer, type EditTarget, type GroupLayer, type Layer, type Mask, type PixelLayer, type ShapeLayer, type StructureSnapshot,
  type TextLayer, type VectorLayer,
} from './model';
import {
  invert as invertSel, materialize, NO_SEL, rectSel, reframeSel, selectAllState, tracePath, type SelState,
} from './selection';
import {
  drawText, sameSpec, sanitizeShape, sanitizeText, scaleSpec, shapeBounds, textBounds, textBox, translateShape, translateText,
} from './textShape';
import { clearShapeCache, drawShapeWith, setShapeCacheBudget } from './shapeSdf';
import type { Patch } from './tiles';
import { clipToSize, equal, intersect, isEmpty, union } from './rect';
import { createSurface, releaseSurface, resampled, type Surface } from './surface';
import {
  anchorOffset, cleanXf, dirtyDoc, drawMapped, IDENT, isAligned, outerRect, sameXf, type Xf,
} from './xform';
import type { Host, Scratch, Tool } from './tools/host';
import { StrokeTool } from './tools/paint';
import { FillTool, GradientTool, MoveTool, PickerTool } from './tools/others';
import { LassoTool, MarqueeTool, WandTool } from './tools/select';

const MAX_BRUSH = 1000;
const MAX_DIM = 16384;
const MAX_IMPORT = 8192; // longest side of an imported image kept at native resolution
const MAX_PIXELS = 8192 * 8192; // largest surface a bake (applyTransform) may produce
const MAX_GUIDES = 512;
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

const sameSel = (a: SelState, b: SelState): boolean => a.alpha === b.alpha && equal(a.rect, b.rect);

/** A fully visible (white) mask surface. */
function whiteMask(w: number, h: number): Surface {
  const s = createSurface(w, h, true);
  s.ctx.fillStyle = '#fff';
  s.ctx.fillRect(0, 0, w, h);
  return s;
}

/** Copy of a mask in a w x h frame: old content drawn at (dx, dy), the new area fully visible (no resampling). */
function shiftedMask(old: Surface, w: number, h: number, dx: number, dy: number): Surface {
  const s = whiteMask(w, h);
  s.ctx.clearRect(dx, dy, old.width, old.height);
  s.ctx.drawImage(old.canvas as CanvasImageSource, dx, dy);
  return s;
}

const copyGuides = (g: Guides): Guides => ({ h: g.h.slice(), v: g.v.slice() });
const sameGuides = (a: Guides, b: Guides): boolean =>
  a.h.length === b.h.length && a.v.length === b.v.length && a.h.every((n, i) => n === b.h[i]) && a.v.every((n, i) => n === b.v[i]);

interface CanvasState { w: number; h: number; mode: CanvasMode; guides: Guides; sel: SelState }

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
  private knownSlots = new Map<number, Surface>(); // slot -> surface last announced
  private freshSlots = new Set<number>(); // slots of just-created empty layers: no 'surface' event needed
  private maskTargetLayer: string | null = null; // layer whose mask is the paint target
  private surfaceDirty: Rect | null = null; // writeSurface area (document space) waiting for commitSurfaces
  private conv = new Uint8ClampedArray(0);
  private sel: SelState = NO_SEL;
  private selOpts: SelectionOptions = { mode: 'new', feather: 0, antialias: true, wandTolerance: 32, wandContiguous: true, wandSampleAll: false };
  private selCanvas: Surface | null = null; // doc-sized canvas, alpha = coverage (lazy, non-rect selections only)
  private selCanvasFor: SelState | null = null; // the selection selCanvas currently shows
  private selCanvasRect: Rect | null = null; // area of selCanvas that holds pixels
  private selMaskCache: Uint8Array | null = null;
  private selPathCache: Array<Array<{ x: number; y: number }>> | null = null;
  private tmp: Surface | null = null;
  private shapeType: ShapeType = 'rect';
  private textCount = 0;
  private shapeCount = 0;
  private snap: SnapOptions = { enabled: false, guides: true, canvas: true, layers: true, threshold: 6 };
  private zoom = 1; // viewport zoom, for the move tool's snapping threshold (setViewZoom)
  private boxSession: { id: string; spec0: TextSpec | ShapeSpec; box0: Rect; last: TextSpec | ShapeSpec } | null = null;
  private baseHasInput = true; // false after setBaseSize(0, 0): the TD Input surface is an empty placeholder
  private baseFitPending = true; // the next setBaseSize may place the TD Input (fixed canvas: fit + centre)

  constructor(width: number, height: number) {
    const w = clampDim(width);
    const h = clampDim(height);
    const base: PixelLayer = {
      id: BASE_ID, kind: 'base', name: 'TD Input', visible: true, locked: true, opacity: 1, blend: 'normal',
      surface: createSurface(w, h), x: 0, y: 0, sx: 1, sy: 1, slot: null, mask: null,
    };
    this.doc = new Document(w, h, base);
    this.scratch = this.makeScratch();
    this.compositor = new Compositor(this.doc, (rect) => this.emit({ type: 'composite', rect }));
    this.tools = {
      move: new MoveTool(this),
      marquee: new MarqueeTool(this),
      lasso: new LassoTool(this),
      wand: new WandTool(this),
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
      : isVector(l) && !toMask ? 'Flatten the layer to paint on it'
        : l.kind === 'adjustment' && !toMask ? 'Select a pixel layer or a mask'
          : !l.visible ? 'Layer is hidden' : l.locked ? 'Layer is locked' : null;
    if (why || !l || l.kind === 'group') {
      this.emit({ type: 'notice', message: why ?? 'Select a pixel layer' });
      return null;
    }
    return this.makeTarget(l, toMask);
  }

  movableLayer(): PixelLayer | VectorLayer | null {
    const l = this.doc.active();
    // The lock protects the pixels; the TD Input is always locked but may be moved and scaled like any layer.
    const why = !l || l.kind === 'group' || l.kind === 'adjustment' ? 'Select a pixel layer to move' : !l.visible ? 'Layer is hidden' : l.locked && l.kind !== 'base' ? 'Layer is locked' : null;
    if (why || !l || l.kind === 'group' || l.kind === 'adjustment') {
      this.emit({ type: 'notice', message: why ?? 'Select a pixel layer to move' });
      return null;
    }
    return l;
  }

  private makeTarget(layer: PixelLayer | AdjustmentLayer | VectorLayer, mask: boolean): EditTarget {
    const m = layer.mask as Mask;
    const tf = layerXf(layer); // the live layer for pixel layers (a mask shares its layer's mapping), identity otherwise
    return {
      layer, isMask: mask,
      surface: mask ? m.surface : (layer as PixelLayer).surface,
      slot: mask ? m.slot : (layer as PixelLayer).slot,
      tf,
    };
  }

  changed(r: Rect): void {
    this.version++;
    this.compositor.invalidate(r);
    const c = clipToSize(r, this.doc.width, this.doc.height);
    if (c) this.emit({ type: 'pixels', rect: c });
  }

  paintChanged(target: EditTarget, layerRect: Rect): void {
    if (target.layer.kind === 'pixel') target.layer.pristine = false;
    this.changed(dirtyDoc(target.tf, layerRect));
    if (target.slot === null) return;
    const lr = clipToSize(layerRect, target.surface.width, target.surface.height);
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
        this.paintChanged(target, p.rect);
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
    // Surfaces only history keeps alive (deleted layers, replaced by a bake / flatten) are held in memory.
    const a = snapshotSurfaces(before);
    const b = snapshotSurfaces(after);
    let bytes = 256;
    a.forEach((sf) => { if (!b.has(sf)) bytes += sf.width * sf.height * 4; });
    b.forEach((sf) => { if (!a.has(sf)) bytes += sf.width * sf.height * 4; });
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

  /**
   * Set the document size from outside (TouchDesigner's docSize): the canvas grows / shrinks at the bottom right, no
   * surface is touched or resampled, history is cleared. The canvas mode is not changed (see adoptCanvas).
   */
  resize(width: number, height: number): void {
    this.finishStroke();
    const w = clampDim(width);
    const h = clampDim(height);
    if (w === this.doc.width && h === this.doc.height) return;
    const prev = { w: this.doc.width, h: this.doc.height, sel: this.sel };
    this.reframe(w, h, 0, 0);
    this.hist.clear();
    this.announceCanvas(prev);
    this.emit({ type: 'history' });
  }

  /** Bridge entry for TD's `docSize {w, h, mode}`: size and mode without history entries (history is cleared when the size changes). */
  adoptCanvas(width: number, height: number, mode: CanvasMode): void {
    const ow = this.doc.width;
    const oh = this.doc.height;
    this.resize(width, height);
    const nw = this.doc.width;
    const nh = this.doc.height;
    if (nw !== ow || nh !== oh) {
      // Untouched layers (created empty and never written to: `pristine`; document sized, identity, no mask) follow the new size; no history.
      let changed = false;
      for (const l of this.doc.pixelLayers()) {
        const sf = l.surface;
        if (l.kind !== 'pixel' || !l.pristine || l.mask || sf.width !== ow || sf.height !== oh || l.x !== 0 || l.y !== 0 || l.sx !== 1 || l.sy !== 1) continue;
        l.surface = createSurface(nw, nh);
        releaseSurface(sf);
        changed = true;
      }
      if (changed) this.syncSpec(true);
    }
    if (this.doc.canvasMode !== mode) {
      this.doc.canvasMode = mode === 'fixed' ? 'fixed' : 'input';
      this.bumpSpec();
    }
  }

  // ---- Canvas (v4) ----

  private canvasState(): CanvasState {
    return { w: this.doc.width, h: this.doc.height, mode: this.doc.canvasMode, guides: copyGuides(this.doc.guides), sel: this.sel };
  }

  /**
   * Change the document size, moving everything by (dx, dy): pixel / base layers and their masks keep their surfaces and
   * only their transform position changes (no reallocation, no resampling); text / shape geometry, guides and the
   * selection move; document-space masks (adjustment / text / shape layers) are reallocated at the new size.
   */
  private reframe(nw: number, nh: number, dx: number, dy: number): void {
    const ow = this.doc.width;
    const oh = this.doc.height;
    this.doc.width = nw;
    this.doc.height = nh;
    for (const l of this.doc.all()) {
      if (l.kind === 'group') continue;
      if (isPixel(l)) {
        l.x += dx;
        l.y += dy;
      } else {
        if (isVector(l) && (dx || dy)) {
          (l as { spec: unknown }).spec = l.kind === 'text' ? translateText(l.spec, dx, dy) : translateShape(l.spec, dx, dy);
        }
        if (l.mask && (dx || dy || nw !== ow || nh !== oh)) l.mask = { slot: l.mask.slot, enabled: l.mask.enabled, surface: shiftedMask(l.mask.surface, nw, nh, dx, dy) };
      }
    }
    if (dx || dy) this.doc.guides = { h: this.doc.guides.h.map((n) => n + dy), v: this.doc.guides.v.map((n) => n + dx) };
    const newSel = reframeSel(this.sel, ow, nw, nh, dx, dy);
    this.dropSelCaches();
    this.sel = newSel;
    this.doc.selection = newSel.rect;
    this.baseDirty = null;
    this.surfaceDirty = null;
    if (nw !== ow || nh !== oh) this.compositor.resize();
    else this.compositor.invalidate(null);
  }

  private announceCanvas(prev: { w: number; h: number; sel: SelState }): void {
    this.version++;
    this.thumbs.clear();
    if (prev.w !== this.doc.width || prev.h !== this.doc.height) this.emit({ type: 'resize', width: this.doc.width, height: this.doc.height });
    if (!sameSel(prev.sel, this.sel)) this.emit({ type: 'selection' });
    this.emit({ type: 'structure' });
    this.syncSpec(true);
  }

  private canvasEntry(label: string, sBefore: StructureSnapshot, cBefore: CanvasState): void {
    const sAfter = this.doc.snapshot();
    const cAfter = this.canvasState();
    const go = (snap: StructureSnapshot, cs: CanvasState) => () => {
      const prev = { w: this.doc.width, h: this.doc.height, sel: this.sel };
      this.doc.restore(snap);
      this.doc.width = cs.w;
      this.doc.height = cs.h;
      this.doc.canvasMode = cs.mode;
      this.doc.guides = copyGuides(cs.guides);
      this.dropSelCaches();
      this.sel = cs.sel;
      this.doc.selection = cs.sel.rect;
      if (prev.w !== cs.w || prev.h !== cs.h) this.compositor.resize();
      else this.compositor.invalidate(null);
      this.announceCanvas(prev);
    };
    let bytes = 256 + (cBefore.sel.alpha?.length ?? 0) + (cAfter.sel.alpha?.length ?? 0);
    const a = snapshotSurfaces(sBefore);
    const b = snapshotSurfaces(sAfter);
    a.forEach((sf) => { if (!b.has(sf)) bytes += sf.width * sf.height * 4; });
    b.forEach((sf) => { if (!a.has(sf)) bytes += sf.width * sf.height * 4; });
    this.hist.push({ label, bytes, undo: go(sBefore, cBefore), redo: go(sAfter, cAfter) });
    this.emit({ type: 'history' });
  }

  setCanvasSize(w: number, h: number, anchor: Anchor): void {
    const nw = clampDim(w);
    const nh = clampDim(h);
    const ow = this.doc.width;
    const oh = this.doc.height;
    if (nw === ow && nh === oh && this.doc.canvasMode === 'fixed') return;
    this.finishStroke();
    const { dx, dy } = anchorOffset(anchor, ow, oh, nw, nh);
    const sBefore = this.doc.snapshot();
    const cBefore = this.canvasState();
    const prev = { w: ow, h: oh, sel: this.sel };
    this.doc.canvasMode = 'fixed';
    this.reframe(nw, nh, dx, dy);
    this.announceCanvas(prev);
    this.canvasEntry('Canvas size', sBefore, cBefore);
  }

  setCanvasMode(mode: CanvasMode): void {
    if (mode === this.doc.canvasMode) return;
    this.finishStroke();
    const sBefore = this.doc.snapshot();
    const cBefore = this.canvasState();
    const prev = { w: this.doc.width, h: this.doc.height, sel: this.sel };
    if (mode === 'input') {
      this.doc.canvasMode = 'input';
      const base = this.doc.find(BASE_ID) as PixelLayer;
      base.x = base.y = 0;
      base.sx = base.sy = 1;
      const w = this.baseHasInput ? base.surface.width : this.doc.width;
      const h = this.baseHasInput ? base.surface.height : this.doc.height;
      this.reframe(clampDim(w), clampDim(h), 0, 0);
    } else {
      this.doc.canvasMode = 'fixed';
      this.compositor.invalidate(null);
    }
    this.announceCanvas(prev);
    this.canvasEntry(mode === 'input' ? 'Follow input size' : 'Fixed canvas size', sBefore, cBefore);
  }

  canvasMode(): CanvasMode { return this.doc.canvasMode; }

  /**
   * The TD Input resolution changed (BASE frames with a new docW/docH, or 0 x 0 = no input). The base surface is reallocated
   * (empty until its BASE frames arrive), no history. The very first time an input appears the base is placed: identity when
   * the canvas follows the input, otherwise fitted (contain) and centred in the canvas.
   */
  setBaseSize(w: number, h: number): void {
    const base = this.doc.find(BASE_ID) as PixelLayer;
    const has = w >= 1 && h >= 1;
    const nw = has ? clampDim(w) : 1;
    const nh = has ? clampDim(h) : 1;
    if (nw === base.surface.width && nh === base.surface.height && has === this.baseHasInput) return;
    const old = base.surface;
    if (has && this.baseHasInput && !this.baseFitPending && this.doc.canvasMode === 'fixed') {
      // fixed canvas: the input keeps the document-space box it showed (its resolution changed, not its size on the canvas)
      base.sx = (base.sx * old.width) / nw;
      base.sy = (base.sy * old.height) / nh;
    }
    base.surface = createSurface(nw, nh);
    releaseSurface(old);
    this.baseHasInput = has;
    this.baseDirty = null;
    if (has && this.baseFitPending) {
      this.baseFitPending = false;
      if (this.doc.canvasMode === 'fixed' && (nw !== this.doc.width || nh !== this.doc.height)) {
        const k = Math.min(this.doc.width / nw, this.doc.height / nh);
        base.sx = base.sy = k;
        base.x = Math.round((this.doc.width - nw * k) / 2);
        base.y = Math.round((this.doc.height - nh * k) / 2);
      } else {
        base.x = base.y = 0;
        base.sx = base.sy = 1;
      }
    }
    this.version++;
    this.compositor.invalidate(null);
    this.emit({ type: 'pixels', rect: this.docRect() });
    this.emit({ type: 'structure' });
    this.syncSpec(true);
  }

  /** Viewport zoom (screen px per document px), used by the move tool's snapping threshold. Default 1. */
  setViewZoom(zoom: number): void {
    if (Number.isFinite(zoom) && zoom > 0) this.zoom = zoom;
  }

  // ---- Guides and snapping (v4) ----

  guides(): Guides { return copyGuides(this.doc.guides); }

  private bumpSpec(): void {
    this.rev++;
    this.emit({ type: 'docspec' });
  }

  private commitGuides(label: string, before: Guides, key?: string): void {
    const after = copyGuides(this.doc.guides);
    if (sameGuides(before, after)) return;
    const go = (g: Guides) => () => {
      this.doc.guides = copyGuides(g);
      this.bumpSpec();
    };
    this.hist.push({ label, bytes: 64 + 8 * (before.h.length + before.v.length + after.h.length + after.v.length), undo: go(before), redo: go(after), coalesceKey: key });
    this.bumpSpec();
    this.emit({ type: 'history' });
  }

  addGuide(axis: 'h' | 'v', pos: number): void {
    if (!Number.isFinite(pos) || this.doc.guides[axis].length >= MAX_GUIDES) return;
    this.finishStroke();
    const before = copyGuides(this.doc.guides);
    this.doc.guides[axis].push(pos);
    this.commitGuides('Add guide', before);
  }

  moveGuide(axis: 'h' | 'v', index: number, pos: number): void {
    const list = this.doc.guides[axis];
    if (!Number.isFinite(pos) || !Number.isInteger(index) || index < 0 || index >= list.length || list[index] === pos) return;
    const before = copyGuides(this.doc.guides);
    list[index] = pos;
    this.commitGuides('Move guide', before, `guide:${axis}:${index}`);
  }

  removeGuide(axis: 'h' | 'v', index: number): void {
    const list = this.doc.guides[axis];
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
    const before = copyGuides(this.doc.guides);
    list.splice(index, 1);
    this.commitGuides('Remove guide', before);
  }

  setSnap(opts: SnapOptions): void {
    this.snap = { enabled: !!opts.enabled, guides: !!opts.guides, canvas: !!opts.canvas, layers: !!opts.layers, threshold: Math.max(0, Number(opts.threshold) || 0) };
  }

  /** Lines (document px) things can snap to: guides, canvas edges + centre, other layers' box edges + centres. */
  private snapLines(exclude: string | null): { xs: number[]; ys: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    if (this.snap.guides) {
      xs.push(...this.doc.guides.v);
      ys.push(...this.doc.guides.h);
    }
    if (this.snap.canvas) {
      xs.push(0, this.doc.width / 2, this.doc.width);
      ys.push(0, this.doc.height / 2, this.doc.height);
    }
    if (this.snap.layers) {
      for (const l of this.doc.all()) {
        if (l.id === exclude || !l.visible || l.kind === 'group' || l.kind === 'adjustment') continue;
        const b = layerBox(l);
        if (!b || !(b.w > 0 || b.h > 0)) continue;
        xs.push(b.x, b.x + b.w / 2, b.x + b.w);
        ys.push(b.y, b.y + b.h / 2, b.y + b.h);
      }
    }
    return { xs, ys };
  }

  /** Best snap of any of `points` onto any of `lines` within `thr`: the offset to add and the line hit. */
  private snapAxis(points: number[], lines: number[], thr: number): { d: number; line: number } | null {
    let best: { d: number; line: number } | null = null;
    for (const p of points) {
      for (const c of lines) {
        const d = c - p;
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: c };
      }
    }
    return best;
  }

  snapPoint(x: number, y: number, zoom: number): { x: number; y: number; guideX: number | null; guideY: number | null } {
    if (!this.snap.enabled || !(zoom > 0)) return { x, y, guideX: null, guideY: null };
    const thr = this.snap.threshold / zoom;
    const { xs, ys } = this.snapLines(this.doc.activeId);
    const sx = this.snapAxis([x], xs, thr);
    const sy = this.snapAxis([y], ys, thr);
    return { x: sx ? sx.line : x, y: sy ? sy.line : y, guideX: sx ? sx.line : null, guideY: sy ? sy.line : null };
  }

  snapRect(r: Rect, zoom: number): { dx: number; dy: number; guideX: number | null; guideY: number | null } {
    return this.snapRectFor(r, zoom, this.doc.activeId);
  }

  private snapRectFor(r: Rect, zoom: number, exclude: string | null): { dx: number; dy: number; guideX: number | null; guideY: number | null } {
    if (!this.snap.enabled || !(zoom > 0)) return { dx: 0, dy: 0, guideX: null, guideY: null };
    const thr = this.snap.threshold / zoom;
    const { xs, ys } = this.snapLines(exclude);
    const sx = this.snapAxis([r.x, r.x + r.w / 2, r.x + r.w], xs, thr);
    const sy = this.snapAxis([r.y, r.y + r.h / 2, r.y + r.h], ys, thr);
    return { dx: sx ? sx.d : 0, dy: sy ? sy.d : 0, guideX: sx ? sx.line : null, guideY: sy ? sy.line : null };
  }

  snapMove(r: Rect, exclude: string): { dx: number; dy: number } {
    const s = this.snapRectFor(r, this.zoom, exclude);
    return { dx: s.dx, dy: s.dy };
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
      opacity: 1, blend: 'normal', surface: createSurface(this.doc.width, this.doc.height), x: 0, y: 0, sx: 1, sy: 1,
      slot: this.doc.newSlot(), mask: null, pristine: true,
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
    // A pixel layer's mask has the size of its surface (layer space); other layers' masks are document sized.
    const mask: Mask = { slot: this.doc.newSlot(), surface: l.kind === 'pixel' ? whiteMask(l.surface.width, l.surface.height) : whiteMask(this.doc.width, this.doc.height), enabled: true };
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
      surface: createSurface(this.doc.width, this.doc.height), x: 0, y: 0, sx: 1, sy: 1, slot: this.doc.newSlot(), mask: null,
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
    const ox = (target.width - w) / 2;
    const oy = (target.height - h) / 2;
    if (isVector(l)) {
      c.save();
      c.translate(ox, oy);
      c.scale(k, k);
      c.beginPath();
      c.rect(0, 0, this.doc.width, this.doc.height);
      c.clip();
      if (l.kind === 'text') drawText(c, l.spec);
      else this.drawShapeSpec(c, l.spec);
      c.restore();
      return;
    }
    c.imageSmoothingQuality = 'high';
    if (l.kind === 'group') {
      const src = this.compositor.renderIsolated(l, k); // groups render at thumbnail scale
      const sw = Math.max(1, Math.round(this.doc.width * k));
      const sh = Math.max(1, Math.round(this.doc.height * k));
      c.drawImage(src.canvas as CanvasImageSource, 0, 0, sw, sh, ox, oy, w, h);
      if (this.thumbs.size > 64) this.thumbs.clear();
      const copy = document.createElement('canvas');
      copy.width = target.width;
      copy.height = target.height;
      (copy.getContext('2d') as CanvasRenderingContext2D).drawImage(target, 0, 0);
      this.thumbs.set(id, { version: this.version, canvas: copy });
      return;
    }
    // Pixel layers show the transformed surface inside the document frame.
    const px = l as PixelLayer;
    c.save();
    c.beginPath();
    c.rect(ox, oy, w, h);
    c.clip();
    c.drawImage(px.surface.canvas as CanvasImageSource, ox + px.x * k, oy + px.y * k, px.surface.width * px.sx * k, px.surface.height * px.sy * k);
    c.restore();
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
    const t = layerXf(l);
    const m = l.mask.surface;
    c.save();
    c.beginPath();
    c.rect(ox, oy, w, h);
    c.clip();
    c.drawImage(m.canvas as CanvasImageSource, ox + t.x * k, oy + t.y * k, m.width * t.sx * k, m.height * t.sy * k); // white with alpha = grey on black
    c.restore();
  }

  // ---- Document I/O (v2) ----

  docSpec(): DocSpec {
    return {
      rev: this.rev, width: this.doc.width, height: this.doc.height, layers: this.doc.layerSpecs(),
      guides: copyGuides(this.doc.guides), canvas: { mode: this.doc.canvasMode },
    };
  }

  surfaceSlots(): number[] { return this.doc.slots(); }

  /** Cheap change counter: equals docSpec().rev without building the spec. */
  docRev(): number { return this.rev; }

  /** Surface behind a slot (its own size), or null when no layer or mask of the current stack owns it. */
  private surfaceOf(slot: number): { surface: Surface; isMask: boolean; tf: Xf; layer: Layer } | null {
    for (const l of this.doc.all()) {
      if (l.kind === 'group') continue;
      const tf = layerXf(l);
      if (l.kind === 'pixel' && l.slot === slot) return { surface: l.surface, isMask: false, tf, layer: l };
      if (l.mask && l.mask.slot === slot) return { surface: l.mask.surface, isMask: true, tf, layer: l };
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
    if (t.layer.kind === 'pixel') t.layer.pristine = false;
    this.surfaceDirty = union(this.surfaceDirty, dirtyDoc(t.tf, clip));
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
    const baseSpec = plan[0];
    const bw = baseSpec.surfaceW as number;
    const bh = baseSpec.surfaceH as number;
    const keepBase = oldBase.surface.width === bw && oldBase.surface.height === bh;
    for (const l of this.doc.pixelLayers()) if (l !== oldBase) releaseSurface(l.surface);
    if (!keepBase) releaseSurface(oldBase.surface);
    for (const m of this.doc.masks()) releaseSurface(m.surface);
    this.doc.width = w;
    this.doc.height = h;
    const kids = new Map<string | null, Layer[]>([[null, []]]);
    let maxId = 0;
    let maxSlot = 0;
    const mk = (m: { slot: number; enabled: boolean } | null, mw: number, mh: number): Mask | null => {
      if (!m) return null;
      maxSlot = Math.max(maxSlot, m.slot);
      return { slot: m.slot, enabled: m.enabled, surface: whiteMask(mw, mh) };
    };
    for (const sp of plan) {
      const num = /^L(\d+)$/.exec(sp.id);
      if (num) maxId = Math.max(maxId, Number(num[1]));
      const common = {
        id: sp.kind === 'base' ? BASE_ID : sp.id, name: String(sp.name), visible: !!sp.visible, locked: sp.kind === 'base',
        opacity: clamp01(Number(sp.opacity)), blend: (BLENDS.has(sp.blend) ? sp.blend : 'normal') as BlendMode,
      };
      const xf = cleanXf({ x: sp.x, y: sp.y, sx: sp.sx ?? 1, sy: sp.sy ?? 1 }) as Xf;
      let layer: Layer;
      if (sp.kind === 'group') {
        layer = { ...common, kind: 'group', children: [], expanded: true };
        kids.set(sp.id, []);
      } else if (sp.kind === 'adjustment') {
        layer = { ...common, blend: 'normal', kind: 'adjustment', adjustment: clampAdjustment(sp.adjustment as AdjustmentSpec), mask: mk(sp.mask, w, h) };
      } else if (sp.kind === 'text' || sp.kind === 'shape') {
        const v = { ...common, mask: mk(sp.mask, w, h) };
        layer = sp.kind === 'text'
          ? ({ ...v, kind: 'text', spec: sanitizeText(sp.text as TextSpec) } as TextLayer)
          : ({ ...v, kind: 'shape', spec: sanitizeShape(sp.shape as ShapeSpec) } as ShapeLayer);
      } else if (sp.kind === 'base') {
        layer = oldBase;
        Object.assign(oldBase, common, xf, { slot: null, mask: null, surface: keepBase ? oldBase.surface : createSurface(bw, bh) });
        this.baseHasInput = true;
      } else {
        maxSlot = Math.max(maxSlot, sp.slot as number);
        const sw = sp.surfaceW as number;
        const sh = sp.surfaceH as number;
        layer = { ...common, ...xf, kind: 'pixel', surface: createSurface(sw, sh), slot: sp.slot as number, mask: mk(sp.mask, sw, sh) };
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
    this.doc.guides = copyGuides(spec.guides ?? { h: [], v: [] });
    this.doc.canvasMode = spec.canvas?.mode === 'fixed' ? 'fixed' : 'input';
    this.baseFitPending = false; // the document says where the TD Input sits
    if (!this.doc.find(this.doc.activeId)) this.doc.activeId = this.doc.root.children[0]?.id ?? BASE_ID;
    this.maskTargetLayer = null;
    if (resized) this.compositor.resize();
    else this.compositor.invalidate(null);
    this.version++;
    this.thumbs.clear();
    const hadSel = this.sel.rect !== null;
    this.dropSelCaches();
    this.sel = NO_SEL;
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
    const g = spec.guides;
    if (g !== undefined) {
      const ok = (a: unknown): boolean => Array.isArray(a) && a.length <= MAX_GUIDES && a.every((n) => typeof n === 'number' && Number.isFinite(n));
      if (!g || !ok(g.h) || !ok(g.v)) bad('bad guides');
    }
    if (spec.canvas !== undefined && (!spec.canvas || (spec.canvas.mode !== 'input' && spec.canvas.mode !== 'fixed'))) bad('bad canvas mode');
    const ids = new Set<string>();
    const groups = new Set<string>();
    const slots = new Set<number>();
    const take = (n: unknown): void => {
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 65535 || slots.has(n as number)) bad(`bad or duplicate slot ${String(n)}`);
      slots.add(n as number);
    };
    const dim = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_DIM;
    const area = (l: { surfaceW: number | null; surfaceH: number | null }): boolean => (l.surfaceW as number) * (l.surfaceH as number) <= MAX_PIXELS;
    spec.layers.forEach((l, i) => {
      if ((l.kind === 'base') !== (i === 0)) bad('exactly one base layer, first');
      if (ids.has(l.id)) bad(`duplicate id ${l.id}`);
      ids.add(l.id);
      if (i === 0 ? l.parentId !== null : l.parentId !== null && !groups.has(l.parentId)) bad(`bad parent of ${l.id}`);
      if (l.kind === 'pixel' || l.kind === 'base') {
        if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) bad(`bad position of ${l.id}`);
        if (!(Number.isFinite(l.sx) && Number.isFinite(l.sy) && l.sx > 0 && l.sy > 0)) bad(`bad scale of ${l.id}`);
        if (!dim(l.surfaceW) || !dim(l.surfaceH)) bad(`bad surface size of ${l.id}`);
        if (!area(l)) bad(`surface of ${l.id} is too large`);
      }
      if (l.kind === 'group') groups.add(l.id);
      else if (l.kind === 'pixel') take(l.slot);
      else if (l.kind === 'adjustment') { if (!l.adjustment || !(l.adjustment.type in ADJUSTMENT_NAMES)) bad(`adjustment ${l.id}`); }
      else if (l.kind === 'text' || l.kind === 'shape') {
        const sp = l.kind === 'text' ? l.text : l.shape;
        if (!sp || typeof sp !== 'object') bad(`${l.kind} spec of ${l.id}`);
        try { if (l.kind === 'text') sanitizeText(l.text as TextSpec); else sanitizeShape(l.shape as ShapeSpec); } catch { bad(`${l.kind} spec of ${l.id}`); }
        if (l.slot !== null && l.slot !== undefined) bad(`${l.kind} layer ${l.id} cannot own a surface`);
      } else if (l.kind !== 'base') bad(`unknown kind ${String(l.kind)}`);
      if (l.mask && l.kind !== 'group' && l.kind !== 'base') take(l.mask.slot);
      else if (l.mask) bad(`${l.kind} layers cannot have masks`);
    });
    return spec.layers;
  }

  // ---- Base layer ----

  /** Straight RGBA rows of the TD Input in its own pixel space (rects lie inside the base surface, see setBaseSize). */
  writeBase(rect: Rect, rgba: Uint8Array | Uint8ClampedArray): void {
    const ints = [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
    if (!ints || rect.w < 0 || rect.h < 0) throw new RangeError('writeBase: rect must be integers with non-negative size');
    const need = rect.w * rect.h * 4;
    if (rgba.length < need) throw new RangeError(`writeBase: need ${need} bytes, got ${rgba.length}`);
    const base = this.doc.find(BASE_ID) as PixelLayer;
    const clip = clipToSize(rect, base.surface.width, base.surface.height);
    if (!clip) return;
    const view = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need);
    base.surface.ctx.putImageData(new ImageData(view, rect.w, rect.h), rect.x, rect.y, clip.x - rect.x, clip.y - rect.y, clip.w, clip.h);
    this.baseDirty = union(this.baseDirty, dirtyDoc(base, clip));
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

  selection(): Rect | null { return this.sel.rect && { ...this.sel.rect }; }

  setSelection(rect: Rect | null): void {
    this.finishStroke();
    const r = rect && clipToSize(rect, this.doc.width, this.doc.height);
    const next = r && !isEmpty(r) ? rectSel(r) : NO_SEL;
    if (sameSel(next, this.sel)) return;
    const before = this.sel;
    this.setSel(next);
    this.commitSelection('Select', before);
  }

  setSelectionOptions(opts: SelectionOptions): void {
    this.selOpts = {
      mode: opts.mode, feather: Math.min(500, Math.max(0, Number(opts.feather) || 0)), antialias: !!opts.antialias,
      wandTolerance: Math.min(255, Math.max(0, Math.round(Number(opts.wandTolerance) || 0))),
      wandContiguous: !!opts.wandContiguous, wandSampleAll: !!opts.wandSampleAll,
    };
  }

  /** Coverage of the selection, document sized (a shared array: do not modify). */
  selectionMask(): { rect: Rect; alpha: Uint8Array } | null {
    const s = this.sel;
    if (!s.rect) return null;
    if (s.alpha) return { rect: { ...s.rect }, alpha: s.alpha };
    this.selMaskCache ??= materialize(s, this.doc.width, this.doc.height);
    return { rect: { ...s.rect }, alpha: this.selMaskCache };
  }

  selectionPath(): Array<Array<{ x: number; y: number }>> {
    this.selPathCache ??= tracePath(this.sel, this.doc.width);
    return this.selPathCache.map((l) => l.map((p) => ({ ...p })));
  }

  selectAll(): void {
    this.finishStroke();
    this.changeSelection('Select all', selectAllState(this.doc.width, this.doc.height));
  }

  deselect(): void {
    this.finishStroke();
    this.changeSelection('Deselect', NO_SEL);
  }

  invertSelection(): void {
    this.finishStroke();
    if (!this.sel.rect) return;
    this.changeSelection('Invert selection', invertSel(this.sel, this.doc.width, this.doc.height));
  }

  maskFromSelection(layerId: string): void {
    const l = this.doc.find(layerId);
    if (!l || l.kind === 'group' || l.kind === 'base') {
      this.emit({ type: 'notice', message: 'Masks need a pixel or adjustment layer' });
      return;
    }
    const s = this.sel;
    if (!s.rect) {
      this.emit({ type: 'notice', message: 'Make a selection first' });
      return;
    }
    const px = l.kind === 'pixel' ? l : null;
    const surface = px ? createSurface(px.surface.width, px.surface.height, true) : createSurface(this.doc.width, this.doc.height, true);
    if (!px || isAligned(px)) {
      const o = px ? px : IDENT;
      surface.ctx.putImageData(this.coverageImage(s), s.rect.x - o.x, s.rect.y - o.y);
    } else {
      // Resample the document-space coverage into the layer's own pixels (bilinear).
      const r = s.rect;
      const cov = createSurface(r.w, r.h);
      cov.ctx.putImageData(this.coverageImage(s), 0, 0);
      const c = surface.ctx;
      c.imageSmoothingEnabled = true;
      c.setTransform(1 / px.sx, 0, 0, 1 / px.sy, -px.x / px.sx, -px.y / px.sy);
      c.drawImage(cov.canvas as CanvasImageSource, r.x, r.y);
      c.setTransform(1, 0, 0, 1, 0, 0);
      releaseSurface(cov);
    }
    const mask: Mask = { slot: this.doc.newSlot(), surface, enabled: true };
    this.structural('Mask from selection', () => { l.mask = mask; }, layerExtent(l, this.docRect()));
  }

  // Host: selection
  selectionOptions(): SelectionOptions { return this.selOpts; }
  selectionState(): SelState { return this.sel; }

  previewSelection(s: SelState): void {
    if (!sameSel(s, this.sel)) this.setSel(s);
  }

  commitSelection(label: string, before: SelState): void {
    const after = this.sel;
    if (sameSel(before, after)) return;
    const go = (s: SelState) => () => { this.setSel(s); };
    this.hist.push({ label, bytes: 64 + (before.alpha?.length ?? 0) + (after.alpha?.length ?? 0), undo: go(before), redo: go(after) });
    this.emit({ type: 'history' });
  }

  selectionAlpha(): Uint8Array | null { return this.sel.alpha; }

  /** Canvas whose alpha is the coverage (rgb white); built on first use after a selection change, only for non-rect selections. */
  selectionCanvas(): Surface | null {
    const s = this.sel;
    if (!s.rect || !s.alpha) return null;
    if (this.selCanvasFor === s && this.selCanvas) return this.selCanvas;
    if (!this.selCanvas) this.selCanvas = createSurface(this.doc.width, this.doc.height);
    const c = this.selCanvas.ctx;
    if (this.selCanvasRect) c.clearRect(this.selCanvasRect.x, this.selCanvasRect.y, this.selCanvasRect.w, this.selCanvasRect.h);
    c.putImageData(this.coverageImage(s), s.rect.x, s.rect.y);
    this.selCanvasFor = s;
    this.selCanvasRect = s.rect;
    return this.selCanvas;
  }

  tempWindow(w: number, h: number): Surface {
    const nw = Math.ceil(w);
    const nh = Math.ceil(h);
    if (!this.tmp || this.tmp.width < nw || this.tmp.height < nh) {
      const old = this.tmp;
      this.tmp = createSurface(Math.ceil(Math.max(nw, old?.width ?? 0, 64) / 64) * 64, Math.ceil(Math.max(nh, old?.height ?? 0, 64) / 64) * 64);
      if (old) releaseSurface(old);
    }
    this.tmp.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.tmp.ctx.globalCompositeOperation = 'source-over';
    this.tmp.ctx.globalAlpha = 1;
    return this.tmp;
  }

  wandSource(sampleAll: boolean): Uint8ClampedArray | null {
    const W = this.doc.width;
    const H = this.doc.height;
    const l = this.doc.active();
    const composite = (): Uint8ClampedArray => {
      this.compositor.ensure(null);
      return this.compositor.surface.ctx.getImageData(0, 0, W, H).data;
    };
    if (sampleAll || !l || l.kind === 'group' || l.kind === 'adjustment') return composite();
    if (this.paintTarget().target === 'mask' && l.mask) {
      const m = l.mask.surface;
      const d = m.ctx.getImageData(0, 0, m.width, m.height).data; // alpha-stored: expose the value as grey
      const grey = new Uint8ClampedArray(d.length);
      for (let i = 0; i < d.length; i += 4) grey.fill(d[i + 3], i, i + 3), (grey[i + 3] = 255);
      return this.inDocSpace(grey, m.width, m.height, layerXf(l));
    }
    if (isVector(l)) {
      const t = this.tempWindow(W, H);
      t.ctx.clearRect(0, 0, W, H);
      if (l.kind === 'text') drawText(t.ctx, l.spec);
      else this.drawShapeSpec(t.ctx, l.spec);
      return t.ctx.getImageData(0, 0, W, H).data;
    }
    const sl = l as PixelLayer;
    return this.inDocSpace(sl.surface.ctx.getImageData(0, 0, sl.surface.width, sl.surface.height).data, sl.surface.width, sl.surface.height, sl);
  }

  /**
   * Surface pixels (w x h straight RGBA) as a document-sized image under the mapping `t`. Pixel-aligned layers are copied
   * exactly; other mappings are drawn through the compositor's resampling (so the wand sees what the layer looks like).
   */
  private inDocSpace(data: Uint8ClampedArray, w: number, h: number, t: Xf): Uint8ClampedArray {
    const W = this.doc.width;
    const H = this.doc.height;
    if (!isAligned(t)) {
      const src = createSurface(w, h);
      src.ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
      const win = this.tempWindow(W, H);
      win.ctx.clearRect(0, 0, W, H);
      win.ctx.save();
      win.ctx.beginPath();
      win.ctx.rect(0, 0, W, H);
      win.ctx.clip();
      drawMapped(win.ctx, src.canvas as CanvasImageSource, w, h, t, { x: 0, y: 0, w: W, h: H });
      win.ctx.restore();
      releaseSurface(src);
      return win.ctx.getImageData(0, 0, W, H).data;
    }
    if (t.x === 0 && t.y === 0 && w === W && h === H) return data;
    const out = new Uint8ClampedArray(W * H * 4);
    const x0 = Math.max(0, t.x);
    const x1 = Math.min(W, t.x + w);
    if (x1 <= x0) return out;
    for (let y = Math.max(0, t.y); y < Math.min(H, t.y + h); y++) {
      const sy = y - t.y;
      out.set(data.subarray((sy * w + x0 - t.x) * 4, (sy * w + x1 - t.x) * 4), (y * W + x0) * 4);
    }
    return out;
  }

  private coverageImage(s: SelState): ImageData {
    const r = s.rect as Rect;
    const img = new ImageData(r.w, r.h);
    const d = img.data;
    const a = s.alpha;
    const W = this.doc.width;
    for (let y = 0; y < r.h; y++) {
      let o = y * r.w * 4;
      const src = (r.y + y) * W + r.x;
      for (let x = 0; x < r.w; x++, o += 4) {
        d[o] = 255;
        d[o + 1] = 255;
        d[o + 2] = 255;
        d[o + 3] = a ? a[src + x] : 255;
      }
    }
    return img;
  }

  private changeSelection(label: string, next: SelState): void {
    if (sameSel(next, this.sel)) return;
    const before = this.sel;
    this.setSel(next);
    this.commitSelection(label, before);
  }

  private setSel(s: SelState): void {
    this.dropSelCaches();
    this.sel = s;
    this.doc.selection = s.rect;
    this.emit({ type: 'selection' });
  }

  private dropSelCaches(): void {
    this.selMaskCache = null;
    this.selPathCache = null;
    this.selCanvasFor = null;
    if (this.selCanvas && (this.selCanvas.width !== this.doc.width || this.selCanvas.height !== this.doc.height)) {
      releaseSurface(this.selCanvas);
      this.selCanvas = null;
      this.selCanvasRect = null;
    }
  }

  // ---- Text and shape layers (v3) ----

  addTextLayer(spec: TextSpec): string {
    const clean = sanitizeText(spec);
    const first = clean.text.split('\n')[0].trim();
    const layer: TextLayer = {
      id: this.doc.newId(), kind: 'text', name: first ? first.slice(0, 24) : `Text ${++this.textCount}`, visible: true, locked: false,
      opacity: 1, blend: 'normal', spec: clean, mask: null,
    };
    this.insertAboveActive('Add text', layer, textBounds(clean));
    return layer.id;
  }

  addShapeLayer(spec: ShapeSpec): string {
    const clean = sanitizeShape(spec);
    const layer = this.makeShapeLayer(clean);
    this.insertAboveActive('Add shape', layer, shapeBounds(clean));
    return layer.id;
  }

  private makeShapeLayer(spec: ShapeSpec): ShapeLayer {
    const names = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: spec.type === 'polygon' && spec.innerRatio < 1 ? 'Star' : 'Polygon' };
    return {
      id: this.doc.newId(), kind: 'shape', name: `${names[spec.type]} ${++this.shapeCount}`, visible: true, locked: false,
      opacity: 1, blend: 'normal', spec, mask: null,
    };
  }

  setText(id: string, spec: TextSpec): void {
    const l = this.doc.find(id);
    if (!l || l.kind !== 'text') return;
    const next = sanitizeText(spec);
    if (sameSpec(next, l.spec)) return;
    this.editSpec(l, next, 'Edit text');
  }

  setShape(id: string, spec: ShapeSpec): void {
    const l = this.doc.find(id);
    if (!l || l.kind !== 'shape') return;
    const next = sanitizeShape(spec);
    if (sameSpec(next, l.spec)) return;
    this.editSpec(l, next, 'Edit shape');
  }

  private editSpec(l: VectorLayer, next: TextSpec | ShapeSpec, label: string, key = `${l.kind}:${l.id}`): void {
    this.finishStroke();
    const before = this.doc.snapshot();
    const area = union(specBounds(l), l.kind === 'text' ? textBounds(next as TextSpec) : shapeBounds(next as ShapeSpec)) as Rect;
    (l as { spec: unknown }).spec = next;
    this.commitStructure(label, before, key, l.visible && l.opacity > 0 ? area : false);
  }

  /**
   * v4: TD rendered the layer (Flatten): replace a text / shape layer by a pixel layer holding `rgba` (straight RGBA, w x h,
   * placed at the document origin with an identity transform). Name, visibility, opacity, blend, lock and a mask
   * (document sized: it is cropped / extended to w x h, never resampled) are kept; the layer id stays. One history entry.
   */
  replaceWithPixels(id: string, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): void {
    const l = this.doc.find(id);
    const loc = this.doc.locate(id);
    if (!l || !loc || !isVector(l)) return;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) throw new RangeError('replaceWithPixels: bad size');
    const need = w * h * 4;
    if (rgba.length < need) throw new RangeError(`replaceWithPixels: need ${need} bytes, got ${rgba.length}`);
    this.finishStroke();
    const surface = createSurface(w, h);
    surface.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need), w, h), 0, 0);
    const mask: Mask | null = !l.mask ? null
      : l.mask.surface.width === w && l.mask.surface.height === h ? l.mask
        : { slot: l.mask.slot, enabled: l.mask.enabled, surface: shiftedMask(l.mask.surface, w, h, 0, 0) };
    const px: PixelLayer = {
      id: l.id, kind: 'pixel', name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend,
      surface, x: 0, y: 0, sx: 1, sy: 1, slot: this.doc.newSlot(), mask,
    };
    const area = union(specBounds(l), { x: 0, y: 0, w, h }) as Rect;
    this.structural('Flatten layer', () => { loc.parent.children[loc.index] = px; }, l.visible && l.opacity > 0 ? area : false);
  }

  /** Stored only: the UI creates shape layers itself (addShapeLayer); the engine's 'shape' / 'text' tools are no-ops. */
  private drawShapeSpec(ctx: Parameters<typeof drawText>[0], spec: ShapeSpec): void {
    drawShapeWith(this.doc.shapeRenderer, ctx, spec, this.doc.width, this.doc.height);
  }

  /** 'sdf' (default): the same maths as TD's shape.glsl; 'canvas': Canvas 2D paths. Not part of the document. */
  setShapeRenderer(mode: 'sdf' | 'canvas'): void {
    const m = mode === 'canvas' ? 'canvas' : 'sdf';
    if (m === this.doc.shapeRenderer) return;
    this.finishStroke();
    this.doc.shapeRenderer = m;
    this.version++;
    this.thumbs.clear();
    this.compositor.invalidate(null);
    this.emit({ type: 'pixels', rect: this.docRect() });
    this.emit({ type: 'structure' });
  }

  shapeRenderer(): 'sdf' | 'canvas' { return this.doc.shapeRenderer; }

  setShapeTool(type: ShapeType): void { this.shapeType = type; }
  shapeTool(): ShapeType { return this.shapeType; }
  /** Topmost visible text layer whose layout box contains the point (document px). */
  textLayerAt(x: number, y: number): string | null {
    const walk = (g: GroupLayer): string | null => {
      for (const c of g.children) {
        if (!c.visible) continue;
        if (c.kind === 'group') {
          const h = walk(c);
          if (h) return h;
        } else if (c.kind === 'text') {
          const b = textBox(c.spec);
          if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return c.id;
        }
      }
      return null;
    };
    return walk(this.doc.root);
  }

  /** Set a text / shape spec without history (live drags): recomposite and announce. */
  respec(l: VectorLayer, spec: TextSpec | ShapeSpec): void {
    const area = union(specBounds(l), l.kind === 'text' ? textBounds(spec as TextSpec) : shapeBounds(spec as ShapeSpec)) as Rect;
    (l as { spec: unknown }).spec = spec;
    if (l.kind === 'shape') this.updateShapeBudget();
    this.changed(area);
  }

  // ---- Image import (v3) ----

  /**
   * v4: the image keeps its native resolution (sides above 8192 are downscaled to 8192 with a notice) and is placed with a
   * transform instead of being resampled: an image larger than the canvas gets a uniform fit-to-canvas scale, smaller ones
   * stay 1:1; either way it is centred.
   */
  importImage(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, name: string): string {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new RangeError('importImage: size must be positive integers');
    const need = w * h * 4;
    if (rgba.length < need) throw new RangeError(`importImage: need ${need} bytes, got ${rgba.length}`);
    this.finishStroke();
    let surface = createSurface(w, h);
    surface.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need), w, h), 0, 0);
    let iw = w;
    let ih = h;
    if (w > MAX_IMPORT || h > MAX_IMPORT) {
      const k0 = MAX_IMPORT / Math.max(w, h);
      iw = Math.max(1, Math.round(w * k0));
      ih = Math.max(1, Math.round(h * k0));
      const small = resampled(surface, iw, ih);
      releaseSurface(surface);
      surface = small;
      this.emit({ type: 'notice', message: `Image downscaled to ${iw}\u00d7${ih} (limit ${MAX_IMPORT})` });
    }
    const dw = this.doc.width;
    const dh = this.doc.height;
    const k = iw > dw || ih > dh ? Math.min(dw / iw, dh / ih) : 1;
    const x = Math.round((dw - iw * k) / 2); // whole pixels (see cleanXf)
    const y = Math.round((dh - ih * k) / 2);
    const layer: PixelLayer = {
      id: this.doc.newId(), kind: 'pixel', name: String(name || 'Image'), visible: true, locked: false, opacity: 1, blend: 'normal',
      surface, x, y, sx: k, sy: k, slot: this.doc.newSlot(), mask: null,
    };
    this.insertAboveActive('Import image', layer, outerRect(surfaceDocBounds(layer)));
    if (k < 1) this.emit({ type: 'notice', message: `Image scaled to fit (${w}\u00d7${h} \u2192 ${Math.round(iw * k)}\u00d7${Math.round(ih * k)})` });
    return layer.id;
  }

  // ---- Transforms (v4) ----

  /** Box of a layer in document space (float): surface bounds, text layout box, tight shape geometry; groups = union of children. */
  layerBounds(id: string): Rect | null {
    const l = this.doc.find(id);
    if (!l) return null;
    if (l.kind === 'group') {
      return l.children.reduce<Rect | null>((acc, c) => union(acc, c.visible ? this.layerBounds(c.id) : null), null);
    }
    return layerBox(l);
  }

  setTransform(id: string, t: LayerTransform): void {
    const l = this.doc.find(id);
    if (!l || !isPixel(l)) return;
    const c = cleanXf(t);
    if (!c || sameXf(l, c)) return;
    if (l.locked && l.kind !== 'base') return this.emit({ type: 'notice', message: 'Layer is locked' });
    this.finishStroke();
    const before = this.doc.snapshot();
    const old = outerRect(surfaceDocBounds(l));
    l.x = c.x; l.y = c.y; l.sx = c.sx; l.sy = c.sy;
    const now = outerRect(surfaceDocBounds(l));
    this.commitStructure('Transform', before, `xform:${id}`, l.visible && l.opacity > 0 ? (union(old, now) as Rect) : false);
  }

  /**
   * Fit a layer's box to `box` (document px): pixel / base layers get the transform that maps their surface onto it;
   * text / shape layers scale their geometry (scaleSpec) from where they were when the drag began. Calls within a second
   * on the same layer form one drag (the scale always starts from the original geometry, so nothing accumulates) and one
   * history entry.
   */
  setLayerBox(id: string, box: Rect): void {
    const l = this.doc.find(id);
    if (!l || ![box.x, box.y, box.w, box.h].every(Number.isFinite) || !(box.w > 0) || !(box.h > 0)) return;
    if (isPixel(l)) {
      // A pure move keeps sx / sy exactly (no ulp churn); other scales are rounded to 1e-9.
      const fit = (b: number, n: number, cur: number): number => (Math.abs(b - cur * n) < 1e-6 ? cur : Math.round((b / n) * 1e9) / 1e9);
      this.setTransform(id, { x: box.x, y: box.y, sx: fit(box.w, l.surface.width, l.sx), sy: fit(box.h, l.surface.height, l.sy) });
      return;
    }
    if (!isVector(l)) return;
    if (l.locked) return this.emit({ type: 'notice', message: 'Layer is locked' });
    const sess = this.boxSession;
    if (!sess || sess.id !== id || sess.last !== l.spec) {
      this.boxSession = { id, spec0: l.spec, box0: layerBox(l) as Rect, last: l.spec };
    }
    const s0 = this.boxSession as NonNullable<Engine['boxSession']>;
    const next = l.kind === 'text' ? sanitizeText(scaleSpec(s0.spec0 as TextSpec, s0.box0, box)) : sanitizeShape(scaleSpec(s0.spec0 as ShapeSpec, s0.box0, box));
    if (sameSpec(next, l.spec)) return;
    this.editSpec(l, next, 'Transform', `xbox:${id}`);
    s0.last = l.spec;
  }

  /** Bake the transform of a pixel layer (and its mask): resample into a surface of the transformed size, identity scale; one history entry. */
  applyTransform(id: string): void {
    const l = this.doc.find(id);
    if (!l || l.kind === 'group') return;
    if (l.kind !== 'pixel') {
      this.emit({ type: 'notice', message: l.kind === 'base' ? 'The TD Input cannot be baked' : 'Only pixel layers can be baked' });
      return;
    }
    if (l.locked) return this.emit({ type: 'notice', message: 'Layer is locked' });
    if (l.sx === 1 && l.sy === 1) return;
    const nw = Math.max(1, Math.round(l.surface.width * l.sx));
    const nh = Math.max(1, Math.round(l.surface.height * l.sy));
    if (nw > MAX_DIM || nh > MAX_DIM || nw * nh > MAX_PIXELS) {
      this.emit({ type: 'notice', message: 'The transformed layer would be too large' });
      return;
    }
    this.finishStroke();
    const surface = resampled(l.surface, nw, nh);
    const mask: Mask | null = l.mask ? { slot: l.mask.slot, enabled: l.mask.enabled, surface: resampled(l.mask.surface, nw, nh, true) } : null;
    const old = outerRect(surfaceDocBounds(l));
    this.structural('Apply transform', () => {
      l.surface = surface;
      l.mask = mask;
      l.sx = 1;
      l.sy = 1;
    }, l.visible && l.opacity > 0 ? (union(old, outerRect(surfaceDocBounds(l))) as Rect) : false);
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
    clearShapeCache();
    if (this.selCanvas) releaseSurface(this.selCanvas);
    if (this.tmp) releaseSurface(this.tmp);
    this.listeners.clear();
  }

  // ---- internals ----

  /** Tool scratch: stroke / backup start tiny and grow to the surface being edited (reserveScratch); the tip is fixed size. */
  private makeScratch(): Scratch {
    return {
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
  /** Tell the shape raster cache how much the shape layers need (so its cap never cycles a fitting working set). */
  private updateShapeBudget(): void {
    let bytes = 0;
    for (const l of this.doc.all()) {
      if (l.kind !== 'shape') continue;
      const b = clipToSize(shapeBounds(l.spec), this.doc.width, this.doc.height);
      if (b) bytes += b.w * b.h * 4;
    }
    setShapeCacheBudget(bytes);
  }

  /** Every slot with the surface that backs it (pixel layers and masks). */
  private slotSurfaces(): Map<number, Surface> {
    const out = new Map<number, Surface>();
    for (const l of this.doc.all()) {
      if (l.kind === 'group') continue;
      if (l.kind === 'pixel' && l.slot !== null) out.set(l.slot, l.surface);
      if (l.mask) out.set(l.mask.slot, l.mask.surface);
    }
    return out;
  }

  private syncSpec(specChanged: boolean): void {
    this.updateShapeBudget();
    const now = this.slotSurfaces();
    const added: number[] = [];
    for (const [slot, surface] of now) {
      if (this.knownSlots.get(slot) === surface) continue;
      // A slot is announced when it is new or when its surface was replaced (bake, canvas change, undo of either).
      if (this.knownSlots.has(slot) || !this.freshSlots.delete(slot)) added.push(slot);
    }
    this.knownSlots = now;
    if (specChanged) this.bumpSpec();
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
