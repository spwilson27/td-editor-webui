import type {
  AdjustmentSpec, AdjustmentType, Anchor, BlendMode, BrushDynamics, BrushPreset, BrushSettings, TipShape, CanvasMode, CloneOptions, DocSpec, Effect, EditorEngine, EngineEvent,
  Guides, HistoryEntry, LayerClip, LayerInfo, LayerTransform, PaintTarget, Rect, RGBA, SelectionOptions, ShapeSpec, ShapeType, SnapOptions, TextSpec,
  ToolContext, ToolId, ToolPointer,
} from './types';
import { ADJUSTMENT_NAMES, clampAdjustment, defaultAdjustmentEffect, effectFromAdjustment, effectLabel, migrateAdjustmentEffects, stackIsIdentity } from './adjustments';
import { CLASSIC_EFFECT_TYPES } from './adjustmentTypes';
import { Compositor } from './compositor';
import { sanitizeEffects, sameEffects } from './effectsSanitize';
import { tdPreviewFlag } from './effectsAdapter';
export { sanitizeEffect } from './effectsSanitize';
import { History, type HistoryItem } from './history';
import {
  BASE_ID, cloneEffect, Document, floatingBounds, isPixel, isVector, layerBox, layerExtent, layerXf, MAX_INPUTS, snapshotSurfaces, specBounds,
  specSame, surfaceDocBounds,
  type AdjustmentLayer, type EditTarget, type GroupLayer, type InputState, type Layer, type Mask, type PixelLayer,
  type ShapeLayer, type StructureSnapshot, type TextLayer, type VectorLayer,
} from './model';
import {
  boundsOfAlpha, invert as invertSel, materialize, NO_SEL, rectSel, reframeSel, selectAllState, tracePath, type SelState,
} from './selection';
import { modifySel, type SelOp } from './selectionOps';
import {
  drawText, sameSpec, sanitizeShape, sanitizeText, scaleSpec, shapeBounds, textBounds, textBox, translateShape, translateText,
} from './textShape';
import { clearShapeCache, drawShapeWith, setShapeCacheBudget } from './shapeSdf';
import type { Patch } from './tiles';
import { hashString, readBlob, surfaceHash, writeBlob, type CanvasState, type Ser, type SerEntry } from './historyBlob';
import { clipToSize, equal, intersect, isEmpty, union } from './rect';
import { createSurface, releaseSurface, resampled, type Surface } from './surface';
import { cloneShape, cloneText } from './textShape';

const copyXfLayer = (l: Xf): Xf => ({ x: l.x, y: l.y, sx: l.sx, sy: l.sy, rot: l.rot, kx: l.kx, ky: l.ky });
import {
  anchorOffset, applyMat, cleanXf, decompose, dirtyDoc, docRectPolygon, drawMapped, IDENT, innerLayerRect, invMat, isAligned, isAxis, matOf,
  mulMat, outerRect, sameXf, toDoc, type Xf,
} from './xform';
import type { Host, Scratch, Tool } from './tools/host';
import { DEFAULT_DYNAMICS, sanitizeBrushPresets, sanitizeCustomTip, sanitizeDynamics, BUILTIN_TIPS, type CustomTip } from './tools/tips';
import { StrokeTool } from './tools/paint';
import { FillTool, GradientTool, MoveTool, PickerTool } from './tools/others';
import { BlurTool, CloneTool, DEFAULT_RETOUCH, DodgeTool, SmudgeTool, type RetouchOptions } from './tools/retouch';
import { TileBackup } from './tiles';
import { LassoTool, MarqueeTool, WandTool } from './tools/select';

const MAX_BRUSH = 1000;
const MAX_TIP_SIZE = 512;
const MAX_DIM = 16384;
const MAX_IMPORT = 8192; // longest side of an imported image kept at native resolution
const MAX_PIXELS = 8192 * 8192; // largest surface a bake (applyTransform) may produce
const MAX_GUIDES = 512;
const FX_THUMB_MS = 250; // per layer: at most 4 effect thumbnail renders a second
const FX_THUMB_HELD_MS = 100; // a layer a stroke is painting waits (polled) until the stroke ends: a full-document effect render must never delay a dab
const sameSig = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const PAINT_TOOLS: ToolId[] = ['brush', 'pencil', 'eraser', 'fill', 'gradient'];
const SELECT_TOOLS: ToolId[] = ['marquee', 'lasso', 'wand'];
const STROKE_TOOLS: ToolId[] = ['brush', 'pencil', 'eraser', 'smudge', 'blur', 'dodge', 'clone']; // dab tools: the composite below the layer is cached while they stroke
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

/** v7.1: one copied layer (pixel data deep-copied) of a layer clip. */
interface ClipNode {
  src: string; kind: Layer['kind']; name: string; visible: boolean; locked: boolean; opacity: number; blend: BlendMode; effects: Effect[]; expanded: boolean;
  tf: { x: number; y: number; sx: number; sy: number; rot: number; kx: number; ky: number } | null;
  surface: Surface | null; mask: { surface: Surface; enabled: boolean } | null; spec: TextSpec | ShapeSpec | null; children: ClipNode[] | null;
}

class LayerClipImpl implements LayerClip {
  readonly kind = 'layer-clip' as const;
  released = false;
  /** `epoch`: which loaded document the snapshot came from (aux layer references mean nothing in another one); `asCut`: pasted without " copy". */
  constructor(readonly nodes: ClipNode[], readonly epoch: number, readonly asCut: boolean) {}
  get count(): number { return this.released ? 0 : this.nodes.length; }
  get bytes(): number {
    let n = 0;
    const walk = (ns: ClipNode[]): void => { for (const c of ns) { if (c.surface) n += c.surface.width * c.surface.height * 4; if (c.mask) n += c.mask.surface.width * c.mask.surface.height * 4; if (c.children) walk(c.children); } };
    if (!this.released) walk(this.nodes);
    return n;
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    const walk = (ns: ClipNode[]): void => { for (const c of ns) { if (c.surface) releaseSurface(c.surface); if (c.mask) releaseSurface(c.mask.surface); if (c.children) walk(c.children); } };
    walk(this.nodes);
  }
}

/** Exact pixel copy of a surface (a source-over draw onto transparent keeps the stored values). */
function copySurface(s: Surface): Surface {
  const c = createSurface(s.width, s.height);
  c.ctx.drawImage(s.canvas as CanvasImageSource, 0, 0);
  return c;
}

/** Effects cloned with `layer:<id>` aux references to copied layers pointed at their copies (references to layers that were not copied stay). */
function remapAux(effects: Effect[], idMap: Map<string, string>, foreign: boolean): Effect[] {
  return effects.map((e) => {
    const c = structuredClone(e) as unknown as Record<string, unknown>;
    const s = c.auxSource;
    // foreign = pasted into another document: layer ids there mean other layers, so a reference to a layer that was not copied is dropped
    // (an aux filter without a source renders with no displacement)
    if (typeof s === 'string' && s.startsWith('layer:')) { const to = idMap.get(s.slice(6)); if (to) c.auxSource = `layer:${to}`; else if (foreign) delete c.auxSource; }
    else if (s && typeof s === 'object') {
      const t = s as { kind?: unknown; id?: unknown };
      if (t.kind === 'layer' && typeof t.id === 'string') { const to = idMap.get(t.id); if (to) c.auxSource = { ...t, id: to }; else if (foreign) delete c.auxSource; }
    }
    return c as unknown as Effect;
  });
}

/** A pixel layer with every v5 field at its default. */
function newPixelLayer(id: string, name: string, surface: Surface, over: Partial<PixelLayer> = {}): PixelLayer {
  return {
    id, kind: 'pixel', name, visible: true, locked: false, opacity: 1, blend: 'normal', effects: [], surface,
    x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, slot: null, mask: null, ...over,
  };
}

function newInputLayer(id: string, input: number, surface: Surface): PixelLayer {
  return newPixelLayer(id, `TD Input ${input}`, surface, { kind: 'input', input, locked: true });
}


/** Content equality of two selection states of a document `w` wide (alpha arrays are compared by value, a rect-only state is full coverage). */
function selEqual(a: SelState, b: SelState, w: number): boolean {
  if (a === b) return true;
  if (!equal(a.rect, b.rect)) return false;
  const r = a.rect;
  if (!r) return true;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if ((a.alpha ? a.alpha[y * w + x] : 255) !== (b.alpha ? b.alpha[y * w + x] : 255)) return false;
    }
  }
  return true;
}

const copyGuides = (g: Guides): Guides => ({ h: g.h.slice(), v: g.v.slice() });
const sameGuides = (a: Guides, b: Guides): boolean =>
  a.h.length === b.h.length && a.v.length === b.v.length && a.h.every((n, i) => n === b.h[i]) && a.v.every((n, i) => n === b.v[i]);


export class Engine implements EditorEngine, Host {
  readonly doc: Document;
  scratch: Scratch;
  private compositor: Compositor;
  private hist = new History();
  /** Mask surfaces replaced by an input resolution change: patches that target them can no longer be applied (skipped, then pruned). */
  private staleSurfaces = new WeakSet<Surface>();
  private staleDirty = false;
  private listeners = new Set<(e: EngineEvent) => void>();
  private ctx = defaultContext();
  private tip: { shape: TipShape; dynamics: BrushDynamics; custom: CustomTip | null } = { shape: 'round', dynamics: { ...DEFAULT_DYNAMICS }, custom: null }; // v6
  private presets: BrushPreset[] = []; // v6 document brush presets
  private presetVer = 0;
  private tipStrokes = 0; // textured strokes since setBrushTip (mixed into the seed)
  private presetCache: { v: number; list: BrushPreset[] } | null = null;
  private toolId: ToolId = 'brush';
  private tools: Partial<Record<ToolId, Tool>>;
  private active: Tool | null = null;
  private last: ToolPointer | null = null;
  private inputDirty = new Map<number, Rect>(); // writeInput areas (input surface space) waiting for commitInput
  private layerCount = 0;
  private groupCount = 0;
  private version = 0; // bumped on every visible change; keys the group thumbnail cache
  private thumbs = new Map<string, { version: number; canvas: HTMLCanvasElement }>();
  /** Thumbnails of layers with effects: layer id -> the effect-rendered thumb (thumb-size canvas) and the signature it was made for. */
  private fxThumbs = new Map<string, { sig: unknown[]; canvas: HTMLCanvasElement }>();
  private fxQueue = new Map<string, { w: number; h: number }>();
  /** Per layer: when its last effect thumbnail render ended and how long it took (back-off), and the signature that failed (not retried until it changes). */
  private fxMeta = new Map<string, { at: number; dur: number; failed: unknown[] | null }>();
  private fxTimer: ReturnType<typeof setTimeout> | null = null;
  private fxWaiters: Array<() => void> = [];
  /** Test / perf counters: effect-thumbnail renders. */
  thumbStats = { fx: 0, ms: 0 };
  private rev = 0;
  private liveSpec = false; // a move drag already announced its offsets
  private docEpoch = 0; // bumped by loadDocument: layer clips remember the document they came from
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
  private announced = new Set<number>(); // inputs TD has listed as connected since the document was (re)loaded
  private placePending = new Set<number>([1]); // inputs whose first real size may still place their (initial) layer
  private cloneOpts: CloneOptions = { aligned: true, sampleAll: false };
  private retouchOpts: RetouchOptions = { ...DEFAULT_RETOUCH };
  private cloneTool: CloneTool;
  private qm: { surface: Surface; layer: PixelLayer; selBefore: SelState } | null = null; // quick mask session
  private qmVersion = 0;
  private qmMaskCache: { version: number; mask: { rect: Rect; alpha: Uint8Array } | null } | null = null;

  constructor(width: number, height: number) {
    const w = clampDim(width);
    const h = clampDim(height);
    const surface = createSurface(w, h);
    const base = newInputLayer(BASE_ID, 1, surface);
    base.name = 'TD Input';
    this.doc = new Document(w, h, base);
    this.doc.inputs.set(1, { w, h, connected: true, surface });
    this.doc.inputLayers.add(base);
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
      smudge: new SmudgeTool(this, () => this.retouchOpts),
      blur: new BlurTool(this, () => this.retouchOpts),
      dodge: new DodgeTool(this, () => this.retouchOpts),
    };
    this.cloneTool = new CloneTool(this, () => this.cloneOpts);
    this.tools.clone = this.cloneTool;
  }

  get width(): number { return this.doc.width; }
  get height(): number { return this.doc.height; }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(e: EngineEvent): void {
    if (e.type === 'structure' && this.fxThumbs.size + this.fxMeta.size + this.fxQueue.size) this.pruneFxThumbs();
    for (const l of Array.from(this.listeners)) {
      try { l(e); } catch (err) { console.error('engine listener failed', err); }
    }
  }

  // ---- Host (used by tools) ----

  context(): ToolContext { return this.ctx; }

  brushTip(): { shape: TipShape; dynamics: BrushDynamics; custom: CustomTip | null; stroke: number } { return { ...this.tip, stroke: this.tipStrokes++ }; }

  editableLayer(): EditTarget | null {
    if (this.qm) return this.qmTarget(this.qm);
    const l = this.doc.active();
    const toMask = l !== null && l.mask !== null && this.paintTarget().target === 'mask';
    const why = !l ? 'Select a pixel layer'
      : l.kind === 'group' && !toMask ? 'Select a pixel layer'
      : isVector(l) && !toMask ? 'Flatten the layer to paint on it'
        : l.kind === 'adjustment' && !toMask ? 'Select a pixel layer or a mask'
          : l.kind === 'input' && !toMask ? 'The TD Input cannot be painted on (its mask can)'
            : !l.visible ? 'Layer is hidden' : l.locked && !(l.kind === 'input' && toMask) ? 'Layer is locked' : null;
    if (why || !l) {
      this.emit({ type: 'notice', message: why ?? 'Select a pixel layer' });
      return null;
    }
    return this.makeTarget(l, toMask);
  }

  movableLayer(): PixelLayer | VectorLayer | null {
    const l = this.doc.active();
    // The lock protects the pixels; the TD Input is always locked but may be moved and scaled like any layer.
    const why = !l || l.kind === 'group' || l.kind === 'adjustment' ? 'Select a pixel layer to move' : !l.visible ? 'Layer is hidden' : l.locked && l.kind !== 'input' ? 'Layer is locked' : null;
    if (why || !l || l.kind === 'group' || l.kind === 'adjustment') {
      this.emit({ type: 'notice', message: why ?? 'Select a pixel layer to move' });
      return null;
    }
    return l;
  }

  private qmTarget(q: NonNullable<Engine['qm']>): EditTarget {
    return { layer: q.layer, isMask: true, quick: true, surface: q.surface, slot: null, tf: IDENT };
  }

  private makeTarget(layer: PixelLayer | AdjustmentLayer | VectorLayer | GroupLayer, mask: boolean): EditTarget {
    const m = layer.mask as Mask;
    const tf = layerXf(layer); // the live layer for pixel layers (a mask shares its layer's mapping), identity otherwise
    return {
      layer, isMask: mask,
      surface: mask ? m.surface : (layer as PixelLayer).surface,
      slot: mask ? m.slot : (layer as PixelLayer).slot,
      tf,
    };
  }

  changed(r: Rect, activeOnly = false): void {
    this.version++;
    this.compositor.invalidate(r, false, activeOnly);
    const c = clipToSize(r, this.doc.width, this.doc.height);
    if (c) this.emit({ type: 'pixels', rect: c });
  }

  paintChanged(target: EditTarget, layerRect: Rect): void {
    if (target.quick) {
      // quick mask: nothing to composite; the viewport redraws its overlay from quickMaskSource()
      this.qmVersion++;
      this.emit({ type: 'selection' });
      return;
    }
    if (target.layer.kind === 'pixel') target.layer.pristine = false;
    this.changed(dirtyDoc(target.tf, layerRect), target.layer.id === this.compositor.held); // (a stroke on the held layer keeps the below cache)
    if (target.slot === null) return;
    const lr = clipToSize(layerRect, target.surface.width, target.surface.height);
    if (lr) this.emit({ type: 'surface', slot: target.slot, rect: lr });
  }

  docMoved(): void {
    this.liveSpec = true;
    this.syncSpec(true);
  }

  pushPatch(label: string, target: EditTarget, patches: Patch[]): void {
    this.hist.push(this.item(label, { k: 'patch', target, patches }, { tag: target.quick ? 'qm' : undefined }));
    this.emit({ type: 'history' });
  }

  compositeCanvas(rect: Rect): CanvasImageSource {
    this.compositor.ensure(rect);
    return this.compositor.surface.canvas as CanvasImageSource;
  }

  /**
   * Record a structural edit already applied since `before`. `dirty` is the document area to recomposite
   * (null = all, false = nothing visible changed).
   */
  commitStructure(label: string, before: StructureSnapshot, coalesceKey?: string, dirty: Rect | null | false = null): void {
    const after = this.doc.snapshot();
    this.hist.push(this.item(label, { k: 'struct', before, after }, { coalesceKey }));
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
    this.settleForCanvas();
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
      if (this.doc.canvasMode === 'input') { // following the input: it fills the canvas again (as setCanvasMode('input'))
        this.resetPrimary();
        this.compositor.invalidate(null);
      }
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
      if (l.kind === 'group') { // v7.3: a group mask is document sized like an adjustment's
        if (l.mask && (dx || dy || nw !== ow || nh !== oh)) l.mask = { slot: l.mask.slot, enabled: l.mask.enabled, surface: shiftedMask(l.mask.surface, nw, nh, dx, dy) };
        continue;
      }
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
    this.inputDirty.clear();
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
    this.hist.push(this.item(label, { k: 'canvas', sBefore, sAfter, cBefore, cAfter }));
    this.emit({ type: 'history' });
  }

  setCanvasSize(w: number, h: number, anchor: Anchor): void {
    const nw = clampDim(w);
    const nh = clampDim(h);
    const ow = this.doc.width;
    const oh = this.doc.height;
    if (nw === ow && nh === oh && this.doc.canvasMode === 'fixed') return;
    this.settleForCanvas();
    const { dx, dy } = anchorOffset(anchor, ow, oh, nw, nh);
    this.reframeEntry('Canvas size', nw, nh, dx, dy);
  }

  /** The canvas becomes `rect` (integer, may reach outside the old canvas): everything shifts by -rect.xy, nothing is resampled. Fixed canvas mode; history. */
  cropTo(rect: Rect): void {
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return;
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const nw = clampDim(rect.w);
    const nh = clampDim(rect.h);
    if (x === 0 && y === 0 && nw === this.doc.width && nh === this.doc.height && this.doc.canvasMode === 'fixed') return;
    this.settleForCanvas();
    this.reframeEntry('Crop', nw, nh, -x, -y);
  }

  private settleForCanvas(): void {
    this.finishStroke();
    if (this.qm) this.setQuickMask(false);
  }

  private reframeEntry(label: string, nw: number, nh: number, dx: number, dy: number): void {
    const sBefore = this.doc.snapshot();
    const cBefore = this.canvasState();
    const prev = { w: this.doc.width, h: this.doc.height, sel: this.sel };
    this.doc.canvasMode = 'fixed';
    this.reframe(nw, nh, dx, dy);
    this.announceCanvas(prev);
    this.canvasEntry(label, sBefore, cBefore);
  }

  setCanvasMode(mode: CanvasMode): void {
    if (mode === this.doc.canvasMode) return;
    this.settleForCanvas();
    const sBefore = this.doc.snapshot();
    const cBefore = this.canvasState();
    const prev = { w: this.doc.width, h: this.doc.height, sel: this.sel };
    if (mode === 'input') {
      this.doc.canvasMode = 'input';
      const st = this.doc.inputs.get(1);
      this.resetPrimary();
      const w = st && st.connected ? st.w : this.doc.width;
      const h = st && st.connected ? st.h : this.doc.height;
      this.reframe(clampDim(w), clampDim(h), 0, 0);
    } else {
      this.doc.canvasMode = 'fixed';
      this.compositor.invalidate(null);
    }
    this.announceCanvas(prev);
    this.canvasEntry(mode === 'input' ? 'Follow input size' : 'Fixed canvas size', sBefore, cBefore);
  }

  canvasMode(): CanvasMode { return this.doc.canvasMode; }

  // ---- TD inputs (v5) ----

  /** The layer that follows input 1 in Follow Input mode: the lowest input layer referencing input 1. */
  private primaryInput(): PixelLayer | null {
    let out: PixelLayer | null = null;
    for (const l of this.doc.all()) if (l.kind === 'input' && l.input === 1) out = l;
    return out;
  }

  /** Follow Input: input 1 fills the canvas again. */
  private resetPrimary(): void {
    const p = this.primaryInput();
    if (!p) return;
    p.x = p.y = 0;
    p.sx = p.sy = 1;
    p.rot = p.kx = p.ky = 0;
  }

  /** Where a freshly created / first-sized input layer goes: identity (Follow Input + input 1, or same size), otherwise fit (contain) and centre. */
  private placeInput(l: PixelLayer): void {
    const nw = l.surface.width;
    const nh = l.surface.height;
    const { width: dw, height: dh } = this.doc;
    l.rot = l.kx = l.ky = 0;
    if ((this.doc.canvasMode === 'input' && l.input === 1) || (nw === dw && nh === dh)) {
      l.x = l.y = 0;
      l.sx = l.sy = 1;
      return;
    }
    const k = Math.min(dw / nw, dh / nh);
    l.sx = l.sy = k;
    l.x = Math.round((dw - nw * k) / 2);
    l.y = Math.round((dh - nh * k) / 2);
  }

  private inputState(n: number, connected: boolean): InputState {
    let st = this.doc.inputs.get(n);
    if (!st) {
      st = { w: 1, h: 1, connected, surface: createSurface(1, 1) };
      this.doc.inputs.set(n, st);
    }
    return st;
  }

  /** Give input `n` a new surface size: every layer referencing it (also deleted ones kept by history) gets the new surface; masks are resampled. */
  private resizeInput(n: number, nw: number, nh: number, keepBox: boolean): void {
    const st = this.inputState(n, true);
    const old = st.surface;
    const surface = createSurface(nw, nh);
    const oldMasks: Surface[] = [];
    for (const l of this.doc.inputLayers) {
      if (l.input !== n) continue;
      if (keepBox) { // the input changed resolution, not its size on the canvas
        l.sx = (l.sx * old.width) / nw;
        l.sy = (l.sy * old.height) / nh;
      }
      l.surface = surface;
      if (l.mask && (l.mask.surface.width !== nw || l.mask.surface.height !== nh)) {
        oldMasks.push(l.mask.surface);
        l.mask.surface = resampled(l.mask.surface, nw, nh, true);
      }
    }
    // Pixel patches recorded against the old mask surfaces cannot be applied to the new size: they are dropped from the history (the
    // structural steps stay; an undo of Delete mask / redo of Add mask re-stretches the mask in Document.restore). Old surfaces are not
    // released: other history data may still hold them.
    oldMasks.forEach((s) => this.staleSurfaces.add(s));
    if (oldMasks.length) { this.pruneStale(); this.emit({ type: 'history' }); }
    releaseSurface(old);
    st.surface = surface;
    st.w = nw;
    st.h = nh;
    this.inputDirty.delete(n);
  }

  private markStale(list: Surface[]): void {
    if (!list.length) return;
    list.forEach((s) => this.staleSurfaces.add(s));
    this.staleDirty = true;
  }

  /** Drop the history entries (paint patches, floating-selection steps) whose target surface was replaced by an input resize. */
  private pruneStale(): void {
    this.staleDirty = false;
    const n = this.hist.discardWhere((it) => !!it.ser && (it.ser.k === 'patch' || it.ser.k === 'fsel') && this.staleSurfaces.has(it.ser.target.surface));
    if (n) this.emit({ type: 'history' });
  }

  /** Is any input layer in the stack referencing input `n`? */
  private inputReferenced(n: number): boolean {
    return this.doc.all().some((l) => l.kind === 'input' && l.input === n);
  }

  /**
   * TD told us which inputs exist (`items` is the full list; inputs not listed count as disconnected), no history.
   *  - a newly connected input nothing references gets a locked "TD Input N" layer (placeInput), above the topmost input layer
   *    (or at the bottom when there is none); that layer is not in history, snapshots taken earlier keep it (Document.restore);
   *  - a size change reallocates the shared surface of the input (empty until its frames arrive) and, in a fixed canvas, keeps the
   *    box the layers showed (a Follow Input canvas puts input 1 back to identity);
   *  - a disconnected input keeps its layers (and placement); they render nothing and report inputConnected = false.
   */
  setInputs(items: Array<{ input: number; w: number; h: number; connected: boolean }>): void {
    const incoming = new Map<number, { w: number; h: number; connected: boolean }>();
    for (const it of items ?? []) {
      const n = Math.trunc(it.input);
      if (!(n >= 1 && n <= MAX_INPUTS)) continue;
      incoming.set(n, { w: Number(it.w) || 0, h: Number(it.h) || 0, connected: !!it.connected && it.w >= 1 && it.h >= 1 });
    }
    let layersChanged = false;
    let touched = false;
    const created: PixelLayer[] = [];
    for (let n = 1; n <= MAX_INPUTS; n++) {
      const it = incoming.get(n) ?? { w: 0, h: 0, connected: false };
      const known = this.doc.inputs.get(n);
      if (!known && !it.connected) continue;
      const st = this.inputState(n, false);
      const wasConnected = known ? known.connected : false;
      if (it.connected) {
        const nw = clampDim(it.w);
        const nh = clampDim(it.h);
        const sized = known ? nw !== st.surface.width || nh !== st.surface.height : false;
        if (!known) {
          releaseSurface(st.surface);
          st.surface = createSurface(nw, nh); // replaces the 1 x 1 placeholder
          st.w = nw;
          st.h = nh;
        } else if (sized) {
          const place = this.placePending.has(n);
          const keepBox = !place; // the box on the canvas is kept (Follow Input puts input 1 back to identity below)
          this.resizeInput(n, nw, nh, keepBox);
          if (place) {
            for (const l of this.doc.inputLayers) if (l.input === n) this.placeInput(l);
          } else if (this.doc.canvasMode === 'input') this.resetPrimary();
          layersChanged = true;
          touched = true;
        } else if (this.placePending.has(n) && !wasConnected) {
          for (const l of this.doc.inputLayers) if (l.input === n) this.placeInput(l);
        }
        this.placePending.delete(n);
        st.connected = true;
        const first = !this.announced.has(n);
        this.announced.add(n);
        if (!wasConnected || first) {
          touched = true;
          layersChanged = true;
          if (!this.inputReferenced(n)) {
            const layer = newInputLayer(this.doc.newId(), n, st.surface);
            this.doc.inputLayers.add(layer);
            this.placeInput(layer);
            created.push(layer);
          }
        }
      } else if (st.connected) {
        this.announced.delete(n);
        st.connected = false;
        touched = true;
        layersChanged = true;
      }
    }
    for (const layer of created) this.insertAutoLayer(layer);
    if (!touched && !layersChanged) return;
    this.version++;
    this.thumbs.clear();
    this.compositor.invalidate(null);
    this.emit({ type: 'pixels', rect: this.docRect() });
    this.emit({ type: 'structure' });
    this.syncSpec(true);
  }

  /** Put a layer created from a TD input into the root stack without a history entry. */
  private insertAutoLayer(layer: PixelLayer): void {
    const kids = this.doc.root.children;
    let at = kids.length; // bottom
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].kind === 'input') { at = i; break; } // topmost input layer: go above it
    }
    kids.splice(at, 0, layer);
    this.doc.autoLayers.push({ layer, stamp: this.doc.nextStamp(), fromBottom: kids.length - at });
    if (!this.doc.activeId) this.doc.activeId = layer.id;
  }

  /** Add (again) a layer showing TD input `n` (1..8) above the active layer; history entry. Returns its id. */
  addInputLayer(input: number): string {
    const n = Math.min(MAX_INPUTS, Math.max(1, Math.trunc(Number(input)) || 1));
    const st = this.inputState(n, false);
    const layer = newInputLayer(this.doc.newId(), n, st.surface);
    this.doc.inputLayers.add(layer);
    this.placeInput(layer);
    this.insertAboveActive('Add input layer', layer, outerRect(surfaceDocBounds(layer)));
    return layer.id;
  }

  /** @deprecated v4 shim: the size of input 1 (0 x 0 = disconnected). Use setInputs. */
  setBaseSize(w: number, h: number): void {
    const items = [...this.doc.inputs].filter(([n]) => n !== 1).map(([n, st]) => ({ input: n, w: st.w, h: st.h, connected: st.connected }));
    this.setInputs([{ input: 1, w, h, connected: w >= 1 && h >= 1 }, ...items]);
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
    this.hist.push(this.item(label, { k: 'guides', before, after }, { coalesceKey: key }));
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

  layers(): LayerInfo[] {
    const list = this.doc.list();
    const flagged = this.tdPreviewLayers();
    if (flagged.length) {
      const f = new Set(flagged);
      for (const i of list) if (f.has(i.id) && !this.compositor.hasPreview(i.id)) i.previewPending = true;
    }
    return list;
  }
  activeLayerId(): string | null { return this.doc.activeId; }

  setActiveLayer(id: string): void {
    if (!this.doc.find(id) || this.doc.activeId === id) return;
    this.finishStroke();
    this.doc.activeId = id;
    this.emit({ type: 'structure' });
  }

  addPixelLayer(name?: string): string {
    const layer = newPixelLayer(this.doc.newId(), name ?? `Layer ${++this.layerCount}`, createSurface(this.doc.width, this.doc.height), {
      slot: this.doc.newSlot(), pristine: true,
    });
    this.freshSlots.add(layer.slot as number);
    this.insertAboveActive('Add layer', layer, false);
    return layer.id;
  }

  addAdjustment(type: AdjustmentType): string {
    return this.addAdjustmentLayer([defaultAdjustmentEffect(type)], ADJUSTMENT_NAMES[type]);
  }

  /** v6 wrapper: a filter adjustment layer whose stack is [effect]. */
  addFilterAdjustment(effect: Effect, name?: string): string {
    return this.addAdjustmentLayer([effect], name ?? ADJUSTMENT_NAMES.filter);
  }

  /** v7: an adjustment layer = FX stack over everything below (selection-limited mask as before), one history entry. */
  addAdjustmentLayer(effects: Effect[], name?: string): string {
    const stack = sanitizeEffects(effects);
    // v6: with a selection the layer starts with a mask holding its coverage (document sized, feathered as the selection is); the selection stays
    const sel = this.sel.rect ? this.sel : null;
    let mask: Mask | null = null;
    if (sel && sel.rect) {
      const surface = createSurface(this.doc.width, this.doc.height, true);
      surface.ctx.putImageData(this.coverageImage(sel), sel.rect.x, sel.rect.y);
      mask = { slot: this.doc.newSlot(), surface, enabled: true };
    }
    const layer: AdjustmentLayer = {
      id: this.doc.newId(), kind: 'adjustment', name: name ?? (stack.length === 1 ? effectLabel(stack[0]) : 'Adjustment'), visible: true, locked: false,
      opacity: 1, blend: 'normal', adjustment: null, mask, effects: stack,
    };
    this.insertAboveActive('Add adjustment', layer, stackIsIdentity(stack) ? false : sel ? sel.rect : null);
    return layer.id;
  }

  /** v7 wrapper: sets the layer's primary (first) effect from a legacy spec (prepends it when the stack is empty). */
  setAdjustment(id: string, spec: AdjustmentSpec): void {
    const l = this.doc.find(id);
    if (!l || l.kind !== 'adjustment') return;
    const e = effectFromAdjustment(clampAdjustment(spec));
    if (!e) return;
    const next = l.effects.slice();
    const head = next[0];
    // replace the primary effect only when it is what a legacy spec means: a classic adjustment / blur, or the same filter type; else prepend
    const owns = head && (CLASSIC_EFFECT_TYPES.has(head.type) || (head.type as string) === 'blur' || (spec.type === 'filter' && head.type === e.type));
    if (owns) next[0] = { ...e, enabled: head.enabled };
    else next.unshift(e);
    this.setEffectsAs(id, next, 'Adjustment', `adj:${id}`);
  }

  addMask(layerId: string): number {
    const l = this.doc.find(layerId);
    if (!l || l.id === 'root') {
      this.emit({ type: 'notice', message: 'Masks need a layer' });
      return -1;
    }
    if (l.mask) return l.mask.slot;
    // A pixel / input layer's mask has the size of its surface (layer space); other layers' (and groups') masks are document sized.
    const mask: Mask = { slot: this.doc.newSlot(), surface: isPixel(l) ? whiteMask(l.surface.width, l.surface.height) : whiteMask(this.doc.width, this.doc.height), enabled: true };
    this.structural('Add mask', () => { l.mask = mask; }, false); // white: nothing visible changes
    return mask.slot;
  }

  deleteMask(layerId: string): void {
    const l = this.doc.find(layerId);
    if (!l || !l.mask) return;
    const visible = l.mask.enabled ? layerExtent(l, this.docRect()) : false;
    this.structural('Delete mask', () => { l.mask = null; }, visible);
    if (this.maskTargetLayer === layerId) this.maskTargetLayer = null; // re-adding a mask must not drop into mask edit
  }

  setMaskEnabled(layerId: string, enabled: boolean): void {
    const l = this.doc.find(layerId);
    if (!l || !l.mask || l.mask.enabled === enabled) return;
    const mask = l.mask;
    this.structural(enabled ? 'Enable mask' : 'Disable mask', () => { mask.enabled = enabled; }, layerExtent(l, this.docRect()));
  }

  setPaintTarget(layerId: string, target: PaintTarget): void {
    const l = this.doc.find(layerId);
    if (!l || (l.kind === 'group' && !l.mask)) return;
    let t = target;
    if (t === 'mask' && !l.mask) {
      this.emit({ type: 'notice', message: 'Layer has no mask' });
      t = 'pixels';
    }
    this.finishStroke(this.doc.activeId !== layerId);
    const was = this.paintTarget();
    this.doc.activeId = layerId;
    this.maskTargetLayer = t === 'mask' ? layerId : null;
    const now = this.paintTarget();
    if (was.layerId !== now.layerId || was.target !== now.target) this.emit({ type: 'structure' });
  }

  paintTarget(): { layerId: string | null; target: PaintTarget } {
    const l = this.doc.active();
    const mask = l !== null && l.mask !== null && this.maskTargetLayer === l.id;
    return { layerId: this.doc.activeId, target: mask ? 'mask' : 'pixels' };
  }

  addGroup(name?: string): string {
    const group: GroupLayer = {
      id: this.doc.newId(), kind: 'group', name: name ?? `Group ${++this.groupCount}`, visible: true, locked: false,
      opacity: 1, blend: 'normal', children: [], expanded: true, effects: [], mask: null,
    };
    this.insertAboveActive('Add group', group, false);
    return group.id;
  }

  deleteLayer(id: string): void {
    const loc = this.doc.locate(id);
    if (!loc) return;
    this.structural('Delete layer', () => {
      loc.parent.children.splice(loc.index, 1);
      if (!this.doc.find(this.doc.activeId)) {
        const next = loc.parent.children[loc.index] ?? loc.parent.children[loc.index - 1] ?? (loc.parent === this.doc.root ? null : loc.parent);
        this.doc.activeId = (next ?? this.doc.root.children[0])?.id ?? null;
      }
    });
    this.thumbs.forEach((_, k) => { if (!this.doc.find(k)) this.thumbs.delete(k); });
  }

  moveLayer(id: string, targetParentId: string | null, index: number): void {
    const loc = this.doc.locate(id);
    const layer = this.doc.find(id);
    if (!loc || !layer) return;
    const target = targetParentId === null ? this.doc.root : this.doc.find(targetParentId);
    if (!target || target.kind !== 'group') return;
    if (layer.kind === 'group' && (target === layer || this.isInside(layer, target))) return;
    const others = target.children.length - (target === loc.parent ? 1 : 0);
    const at = Math.max(0, Math.min(Math.trunc(index) || 0, others));
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
    if (l.kind === 'input') delete next.locked; // an input layer stays locked: its pixels are TouchDesigner's
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

  // ---- v7: batch layer operations (each is one history entry) ----

  /** Existing layers of `ids` in display order (top first, depth first), without any layer whose ancestor is also listed; `all` keeps the nested ones. */
  private pickLayers(ids: readonly string[], all = false): Layer[] {
    const want = new Set(ids);
    const out: Layer[] = [];
    const walk = (g: GroupLayer, covered: boolean): void => {
      for (const c of g.children) {
        const hit = want.has(c.id);
        if (hit && (all || !covered)) out.push(c);
        if (c.kind === 'group') walk(c, covered || hit);
      }
    };
    walk(this.doc.root, false);
    return out;
  }

  /** Like structural(), but `mutate` returns false when it changed nothing: then no history entry is made. */
  private structuralIf(label: string, mutate: () => boolean, dirty: Rect | null | false = null): boolean {
    this.finishStroke();
    const before = this.doc.snapshot();
    if (!mutate()) return false;
    this.commitStructure(label, before, undefined, dirty);
    return true;
  }

  /** Layout signature (ids and parents in order), to detect a move that changed nothing. */
  private layoutKey(): string {
    const walk = (g: GroupLayer): string => `${g.id}(${g.children.map((c) => (c.kind === 'group' ? walk(c) : c.id)).join(',')})`;
    return walk(this.doc.root);
  }

  deleteLayers(ids: string[]): void {
    this.finishStroke(); // first: it may commit a floating selection; handles below are located afterwards
    const sel = this.pickLayers(ids);
    if (!sel.length) return;
    const first = this.doc.locate(sel[0].id) as { parent: GroupLayer; index: number };
    const gone = new Set<Layer>(sel);
    const above = first.parent.children.slice(0, first.index).filter((c) => !gone.has(c)).length;
    this.structuralIf(sel.length === 1 ? 'Delete layer' : 'Delete layers', () => {
      for (const l of sel) {
        const loc = this.doc.locate(l.id);
        if (loc) loc.parent.children.splice(loc.index, 1);
      }
      if (!this.doc.find(this.doc.activeId)) {
        const sibs = first.parent.children;
        const next = sibs[above] ?? sibs[above - 1] ?? (first.parent === this.doc.root ? null : first.parent);
        this.doc.activeId = (next ?? this.doc.root.children[0])?.id ?? null;
      }
      return true;
    });
    this.thumbs.forEach((_, k) => { if (!this.doc.find(k)) this.thumbs.delete(k); });
  }

  setLayersProps(ids: string[], props: Partial<Pick<LayerInfo, 'visible' | 'locked'>>): void {
    this.finishStroke();
    const todo: Array<[Layer, Partial<Record<'visible' | 'locked', boolean>>]> = [];
    for (const l of this.pickLayers(ids, true)) {
      const ch: Partial<Record<'visible' | 'locked', boolean>> = {};
      if (props.visible !== undefined && l.visible !== !!props.visible) ch.visible = !!props.visible;
      if (props.locked !== undefined && l.kind !== 'input' && l.locked !== !!props.locked) ch.locked = !!props.locked;
      if (Object.keys(ch).length) todo.push([l, ch]);
    }
    if (!todo.length) return;
    this.finishStroke();
    const before = this.doc.snapshot();
    let area: Rect | null = null;
    let pixels = false;
    for (const [l, ch] of todo) {
      if (ch.visible !== undefined) {
        pixels = true;
        const ext = layerExtent(l, this.docRect());
        area = area ? union(area, ext) : ext;
        l.visible = ch.visible;
      }
      if (ch.locked !== undefined) l.locked = ch.locked;
    }
    const keys = new Set(todo.flatMap(([, ch]) => Object.keys(ch)));
    const label = keys.size === 1 ? (keys.has('visible') ? PROP_LABELS.visible : PROP_LABELS.locked) : 'Layer properties';
    const vis = area && intersect(area, this.docRect());
    this.commitStructure(label, before, undefined, pixels ? vis ?? false : false);
  }

  moveLayers(ids: string[], targetParentId: string | null, index: number): void {
    this.finishStroke();
    const sel = this.pickLayers(ids);
    if (!sel.length) return;
    const target = targetParentId === null ? this.doc.root : this.doc.find(targetParentId);
    if (!target || target.kind !== 'group') return;
    for (const l of sel) if (l === target || (l.kind === 'group' && this.isInside(l, target))) return; // a group cannot enter itself
    const key = this.layoutKey();
    this.structuralIf(sel.length === 1 ? 'Move layer' : 'Move layers', () => {
      for (const l of sel) {
        const loc = this.doc.locate(l.id);
        if (loc) loc.parent.children.splice(loc.index, 1);
      }
      const at = Math.max(0, Math.min(Math.trunc(index) || 0, target.children.length));
      target.children.splice(at, 0, ...sel);
      return this.layoutKey() !== key;
    });
  }

  groupLayers(ids: string[], name?: string): string {
    this.finishStroke();
    const sel = this.pickLayers(ids);
    if (!sel.length) return '';
    const top = this.doc.locate(sel[0].id) as { parent: GroupLayer; index: number };
    // The composite stays exactly as it is only for a contiguous run of plain blended layers; anything else (a blend mode or adjustment inside
    // the new isolated group, a different stacking order) changes it.
    const contiguous = sel.every((l, i) => { const lo = this.doc.locate(l.id); return !!lo && lo.parent === top.parent && lo.index === top.index + i; });
    const plain = sel.every((l) => l.blend === 'normal' && l.kind !== 'adjustment' && (l.kind !== 'group' || (this.isPlainGroup(l))));
    const unchanged = contiguous && plain;
    const group: GroupLayer = {
      id: this.doc.newId(), kind: 'group', name: name ?? `Group ${++this.groupCount}`, visible: true, locked: false,
      opacity: 1, blend: 'normal', children: sel.slice(), expanded: true, effects: [], mask: null,
    };
    this.structuralIf('Group layers', () => {
      for (const l of sel) {
        const loc = this.doc.locate(l.id);
        if (loc) loc.parent.children.splice(loc.index, 1);
      }
      top.parent.children.splice(top.index, 0, group); // the topmost's index is unaffected: every other removed sibling lies below it
      this.doc.activeId = group.id;
      return true;
    }, unchanged ? false : null);
    return group.id;
  }

  // ---- v7.1: layer clipboard (docs/DESIGN_V7.md section 6) ----

  private snapNode(l: Layer, deep: boolean, made: Surface[] = []): ClipNode | null {
    if (l.kind === 'input') return null; // one layer per TD input
    const copy = (s: Surface): Surface => { if (!deep) return s; const c = copySurface(s); made.push(c); return c; };
    const n: ClipNode = {
      src: l.id, kind: l.kind, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend,
      effects: l.effects.map(cloneEffect), expanded: l.kind === 'group' ? l.expanded : true,
      tf: isPixel(l) ? { x: l.x, y: l.y, sx: l.sx, sy: l.sy, rot: l.rot, kx: l.kx, ky: l.ky } : null,
      surface: l.kind === 'pixel' ? copy(l.surface) : null,
      mask: l.mask ? { surface: copy(l.mask.surface), enabled: l.mask.enabled } : null,
      spec: l.kind === 'text' ? cloneText(l.spec) : l.kind === 'shape' ? cloneShape(l.spec) : null,
      children: l.kind === 'group' ? l.children.map((c) => this.snapNode(c, deep, made)).filter((c): c is ClipNode => !!c) : null,
    };
    return n;
  }

  copyLayers(ids: string[], asCut = false): LayerClip {
    this.finishStroke(false);
    const made: Surface[] = [];
    try {
      const nodes = this.pickLayers(ids).map((l) => this.snapNode(l, true, made)).filter((n): n is ClipNode => !!n);
      return new LayerClipImpl(nodes, this.docEpoch, asCut);
    } catch (err) {
      made.forEach(releaseSurface); // no partial snapshot is left behind; nothing else was touched
      this.emit({ type: 'notice', message: `Cannot copy: ${err instanceof Error ? err.message : String(err)}` });
      return new LayerClipImpl([], this.docEpoch, asCut);
    }
  }

  /** A paste / duplicate that pushed a history entry: tell the user when its size (pasted pixels) evicted older steps. */
  private noteEviction(expected: number): void {
    if (this.hist.entries().length < expected) this.emit({ type: 'notice', message: 'Large paste: older undo steps dropped' });
  }

  releaseClip(clip: LayerClip): void {
    if (clip instanceof LayerClipImpl) clip.release();
  }

  /** Fresh layers (new ids, slots, deep-copied pixels) from clip nodes, or null (after a notice) when they do not fit. Touches no document state. */
  private instantiate(nodes: ClipNode[], foreign = false, keepNames = false): { layers: Layer[]; idMap: Map<string, string> } | null {
    let need = 0;
    const count = (ns: ClipNode[]): void => {
      for (const n of ns) {
        if (n.surface) need++;
        if (n.mask) need++;
        if (n.children) count(n.children);
      }
    };
    count(nodes);
    if (need > this.doc.slotsLeft()) {
      this.emit({ type: 'notice', message: 'Cannot paste: the document has no free surface slots left' });
      return null;
    }
    const idMap = new Map<string, string>();
    const assign = (ns: ClipNode[]): void => { for (const n of ns) { idMap.set(n.src, this.doc.newId()); if (n.children) assign(n.children); } };
    assign(nodes);
    const made: Surface[] = [];
    const mk = (s: Surface): Surface => { const c = copySurface(s); made.push(c); return c; };
    const dw = this.doc.width;
    const dh = this.doc.height;
    const build = (n: ClipNode, top: boolean): Layer => {
      const common = {
        id: idMap.get(n.src) as string, name: top && !keepNames ? `${n.name} copy` : n.name, visible: n.visible, locked: n.locked, opacity: n.opacity, blend: n.blend,
        effects: remapAux(n.effects, idMap, foreign),
      };
      const docSpace = n.kind !== 'pixel';
      let mask: Mask | null = null;
      if (n.mask) {
        let surface: Surface;
        if (docSpace && (n.mask.surface.width !== dw || n.mask.surface.height !== dh)) { surface = shiftedMask(n.mask.surface, dw, dh, 0, 0); made.push(surface); } // the canvas was resized since
        else surface = mk(n.mask.surface);
        mask = { slot: this.doc.newSlot(), surface, enabled: n.mask.enabled };
      }
      switch (n.kind) {
        case 'group':
          return { ...common, kind: 'group', children: (n.children as ClipNode[]).map((c) => build(c, false)), expanded: n.expanded, mask };
        case 'pixel':
          return newPixelLayer(common.id, common.name, mk(n.surface as Surface), { ...common, ...(n.tf as NonNullable<ClipNode['tf']>), slot: this.doc.newSlot(), mask });
        case 'text':
          return { ...common, kind: 'text', spec: cloneText(n.spec as TextSpec), mask };
        case 'shape':
          return { ...common, kind: 'shape', spec: cloneShape(n.spec as ShapeSpec), mask };
        default:
          return { ...common, kind: 'adjustment', adjustment: null, mask };
      }
    };
    try {
      return { layers: nodes.map((n) => build(n, true)), idMap };
    } catch (err) {
      made.forEach(releaseSurface);
      this.emit({ type: 'notice', message: `Cannot paste: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    }
  }

  /** Document area the new layers repaint (null = everything, false = nothing visible). */
  private pasteDirty(layers: Layer[]): Rect | null | false {
    let area: Rect | null = null;
    for (const l of layers) if (l.visible) area = union(area, layerExtent(l, this.docRect()));
    return area ? intersect(area, this.docRect()) ?? false : false;
  }

  pasteLayers(clip: LayerClip, parentId: string | null, index: number): string[] {
    this.finishStroke();
    if (!(clip instanceof LayerClipImpl) || clip.released || !clip.nodes.length) return [];
    const parent = parentId === null ? this.doc.root : this.doc.find(parentId);
    if (!parent || parent.kind !== 'group') return [];
    const made = this.instantiate(clip.nodes, clip.epoch !== this.docEpoch, clip.asCut);
    if (!made) return [];
    const at = Math.max(0, Math.min(Math.trunc(index) || 0, parent.children.length));
    const n = made.layers.length;
    const expected = this.hist.index + 2;
    this.structural(n === 1 ? 'Paste layer' : 'Paste layers', () => {
      parent.children.splice(at, 0, ...made.layers);
      this.doc.activeId = made.layers[0].id;
    }, this.pasteDirty(made.layers));
    this.noteEviction(expected);
    return made.layers.map((l) => l.id);
  }

  duplicateLayers(ids: string[]): string[] {
    this.finishStroke();
    const sel = this.pickLayers(ids).filter((l) => l.kind !== 'input');
    if (!sel.length) return [];
    const nodes = sel.map((l) => this.snapNode(l, false) as ClipNode); // live surfaces: instantiate() copies them
    const made = this.instantiate(nodes);
    if (!made) return [];
    // runs of adjacent selected siblings keep their block together; each copy block lands above its run
    const runs: Array<{ first: Layer; copies: Layer[] }> = [];
    let prev: { parent: GroupLayer; index: number } | null = null;
    sel.forEach((l, i) => {
      const loc = this.doc.locate(l.id) as { parent: GroupLayer; index: number };
      if (prev && loc.parent === prev.parent && loc.index === prev.index + 1) runs[runs.length - 1].copies.push(made.layers[i]);
      else runs.push({ first: l, copies: [made.layers[i]] });
      prev = loc;
    });
    const expected = this.hist.index + 2;
    this.structural(sel.length === 1 ? 'Duplicate layer' : 'Duplicate layers', () => {
      for (const r of runs) {
        const loc = this.doc.locate(r.first.id) as { parent: GroupLayer; index: number };
        loc.parent.children.splice(loc.index, 0, ...r.copies);
      }
      this.doc.activeId = made.layers[0].id;
    }, this.pasteDirty(made.layers));
    this.noteEviction(expected);
    return made.layers.map((l) => l.id);
  }

  flattenToNewLayer(): string {
    this.compositor.ensure(null);
    const layer = newPixelLayer(this.doc.newId(), 'Flattened', createSurface(this.doc.width, this.doc.height), { slot: this.doc.newSlot() });
    layer.surface.ctx.drawImage(this.compositor.surface.canvas as CanvasImageSource, 0, 0);
    this.structural('Flatten', () => {
      this.doc.root.children.unshift(layer);
      this.doc.activeId = layer.id;
    });
    return layer.id;
  }

  /** Render the effect thumbnail of `id` now (full-res effects once, or the TD image) into its cache entry. A throwing render marks the layer failed until its signature changes. */
  private renderFxThumb(id: string, w: number, h: number): void {
    const l = this.doc.find(id);
    if (!l) return;
    const sig = this.compositor.thumbFxSig(l);
    if (!sig) { this.fxThumbs.delete(id); return; }
    const prev = this.fxThumbs.get(id);
    const canvas = prev && prev.canvas.width === w && prev.canvas.height === h ? prev.canvas : document.createElement('canvas');
    canvas.width = w; // (also clears)
    canvas.height = h;
    const t0 = performance.now();
    const meta = this.fxMeta.get(id) ?? { at: Number.NEGATIVE_INFINITY, dur: 0, failed: null };
    this.fxMeta.set(id, meta);
    try {
      if (!this.compositor.renderFxThumb(l, canvas)) return;
    } catch (err) {
      if (!meta.failed) console.error('layer thumbnail failed', err);
      meta.failed = sig;
      meta.at = performance.now();
      return;
    }
    meta.failed = null;
    meta.dur = performance.now() - t0;
    meta.at = performance.now();
    this.thumbStats.fx++;
    this.thumbStats.ms += meta.dur;
    this.fxThumbs.set(id, { sig, canvas });
  }

  /** Has rendering this layer's current thumbnail failed (until something changes, do not retry)? */
  private fxFailed(id: string, sig: unknown[]): boolean {
    const f = this.fxMeta.get(id)?.failed;
    return !!f && sameSig(f, sig);
  }

  /** Forget thumbnails of layers that are gone. */
  private pruneFxThumbs(): void {
    for (const k of Array.from(this.fxThumbs.keys())) if (!this.doc.find(k)) this.fxThumbs.delete(k);
    for (const k of Array.from(this.fxMeta.keys())) if (!this.doc.find(k)) this.fxMeta.delete(k);
    for (const k of Array.from(this.fxQueue.keys())) if (!this.doc.find(k)) this.fxQueue.delete(k);
  }

  private clearFxThumbs(): void {
    this.fxThumbs.clear();
    this.fxMeta.clear();
    this.fxQueue.clear();
    this.pumpFxThumbs(false); // settles waiters
  }

  private queueFxThumb(id: string, w: number, h: number): void {
    this.fxQueue.set(id, { w, h });
    this.pumpFxThumbs(false);
  }

  /**
   * Effect thumbnails are rendered one per idle slot. A layer's next render is allowed max(250 ms, 4 x its last render time) after the last one
   * (input layers, whose content streams: max(1 s, 8 x)); among the due layers the one rendered longest ago goes first. Nothing renders while a
   * stroke is held or a gesture (effect scrub) is open: the queue is polled and resumes afterwards.
   */
  private pumpFxThumbs(run: boolean): void {
    if (!run && this.fxTimer !== null) return;
    if (run) this.fxTimer = null;
    const now = performance.now();
    const busy = this.compositor.held !== null || this.hist.groupOpen;
    let wait = Infinity;
    let pick: string | null = null;
    let oldest = Infinity;
    for (const id of Array.from(this.fxQueue.keys())) {
      const l = this.doc.find(id);
      const sig = l ? this.compositor.thumbFxSig(l) : null;
      const cur = this.fxThumbs.get(id);
      if (!l || !sig || (cur && sameSig(cur.sig, sig)) || this.fxFailed(id, sig)) { this.fxQueue.delete(id); continue; }
      if (busy) { wait = Math.min(wait, FX_THUMB_HELD_MS); continue; }
      const m = this.fxMeta.get(id);
      const gap = l.kind === 'input' ? Math.max(4 * FX_THUMB_MS, 8 * (m?.dur ?? 0)) : Math.max(FX_THUMB_MS, 4 * (m?.dur ?? 0));
      const at = m?.at ?? Number.NEGATIVE_INFINITY;
      const due = at + gap - now;
      if (due <= 0) { if (at < oldest) { oldest = at; pick = id; } } else wait = Math.min(wait, due);
    }
    if (run && pick !== null) {
      const q = this.fxQueue.get(pick) as { w: number; h: number };
      this.renderFxThumb(pick, q.w, q.h);
      this.fxQueue.delete(pick);
      this.emit({ type: 'thumbs' });
      if (this.fxQueue.size) wait = Math.min(wait, 0);
    } else if (pick !== null) wait = 0;
    if (!this.fxQueue.size) {
      const ws = this.fxWaiters;
      this.fxWaiters = [];
      ws.forEach((f) => f());
      return;
    }
    if (wait === Infinity) wait = FX_THUMB_MS;
    this.fxTimer = setTimeout(() => {
      const ric = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(() => this.pumpFxThumbs(true), { timeout: 100 }); else this.pumpFxThumbs(true);
    }, Math.max(0, wait));
  }

  /** Resolves when every pending effect thumbnail has been rendered (tests / perf probes). */
  thumbnailsSettled(): Promise<void> {
    if (!this.fxQueue.size) return Promise.resolve();
    return new Promise((res) => { this.fxWaiters.push(res); });
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
    if (l.kind === 'pixel' || l.kind === 'input') {
      const sig = this.compositor.thumbFxSig(l);
      if (sig) { // the layer as rendered with its effects
        const ok = (e: { sig: unknown[]; canvas: HTMLCanvasElement } | undefined) => !!e && e.canvas.width === target.width && e.canvas.height === target.height;
        let cur = this.fxThumbs.get(id);
        if ((!ok(cur) || !sameSig(cur!.sig, sig)) && this.compositor.thumbFromPreview(l)) { // TD's image: a downscale, no effect render
          this.renderFxThumb(id, target.width, target.height);
          cur = this.fxThumbs.get(id);
        }
        if (ok(cur) && sameSig(cur!.sig, sig)) {
          c.drawImage(cur!.canvas, 0, 0);
          return;
        }
        if (!this.fxFailed(id, sig)) this.queueFxThumb(id, target.width, target.height);
        if (ok(cur)) { // out of date: the last one stays until the new one is ready
          c.drawImage(cur!.canvas, 0, 0);
          return;
        }
      }
    }
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
    const m = matOf(px);
    c.transform(k * m.a, k * m.b, k * m.c, k * m.d, ox + k * m.e, oy + k * m.f);
    c.drawImage(px.surface.canvas as CanvasImageSource, 0, 0);
    c.restore();
  }

  drawMaskThumbnail(id: string, target: HTMLCanvasElement): void {
    const l = this.doc.find(id);
    const c = target.getContext('2d');
    if (!l || !c) return;
    c.clearRect(0, 0, target.width, target.height);
    if (!l.mask) return;
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
    const mt = matOf(t);
    c.transform(k * mt.a, k * mt.b, k * mt.c, k * mt.d, ox + k * mt.e, oy + k * mt.f);
    c.drawImage(m.canvas as CanvasImageSource, 0, 0); // white with alpha = grey on black
    c.restore();
  }

  // ---- Document I/O (v2) ----

  docSpec(): DocSpec {
    return {
      rev: this.rev, width: this.doc.width, height: this.doc.height, layers: this.doc.layerSpecs(),
      guides: copyGuides(this.doc.guides), canvas: { mode: this.doc.canvasMode },
      brushPresets: this.presetClone(), // always present: an empty list tells TD the last preset was deleted
    };
  }

  surfaceSlots(): number[] { return this.doc.slots(); }

  /** Cheap change counter: equals docSpec().rev without building the spec. */
  docRev(): number { return this.rev; }

  /** Surface behind a slot (its own size), or null when no layer or mask of the current stack owns it. */
  private surfaceOf(slot: number): { surface: Surface; isMask: boolean; tf: Xf; layer: Layer } | null {
    for (const l of this.doc.all()) {
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

  /**
   * Replace the whole document. Surfaces start empty (masks fully visible); pixels arrive through writeSurface. A v5 `base` layer
   * is read as input 1 (id kept); missing rot / kx / ky / input / effects take their defaults. Input surfaces (TouchDesigner's
   * live frames) are kept when their size matches.
   */
  loadDocument(spec: DocSpec): void {
    this.docEpoch++;
    const plan = this.validateSpec(spec);
    // v7: history blobs written for a v2-v7 document carry the layout hash of its legacy-shaped spec (`adjustment: {...}`); remember it
    // (before the migration into effects[]) so restoreHistory still accepts them.
    this.legacySig = spec.layers.some((l) => l.kind === 'adjustment' && l.adjustment != null)
      ? hashString(JSON.stringify([spec.width, spec.height, spec.layers, spec.guides, spec.canvas]))
      : null;
    this.finishStroke();
    this.cancelFloating();
    if (this.qm) this.setQuickMask(false);
    const w = clampDim(spec.width);
    const h = clampDim(spec.height);
    const resized = w !== this.doc.width || h !== this.doc.height;
    for (const l of this.doc.pixelLayers()) if (l.kind === 'pixel') releaseSurface(l.surface);
    for (const m of this.doc.masks()) releaseSurface(m.surface);
    for (const l of this.doc.inputLayers) if (l.mask) releaseSurface(l.mask.surface); // (also those of deleted layers)
    this.doc.inputLayers.clear();
    this.doc.autoLayers.length = 0;
    // input surfaces: one per referenced input, sized as the document says
    const wanted = new Map<number, { w: number; h: number }>();
    for (const sp of plan) {
      if (sp.kind === 'base' as string || sp.kind === 'input') {
        const n = sp.kind === 'input' ? (sp.input as number) : 1;
        if (!wanted.has(n)) wanted.set(n, { w: sp.surfaceW as number, h: sp.surfaceH as number });
      }
    }
    wanted.forEach((sz, n) => {
      const st = this.doc.inputs.get(n);
      if (st && st.surface.width === sz.w && st.surface.height === sz.h) return;
      if (st) {
        releaseSurface(st.surface);
        st.surface = createSurface(sz.w, sz.h);
        st.w = sz.w;
        st.h = sz.h;
      } else {
        this.doc.inputs.set(n, { w: sz.w, h: sz.h, connected: true, surface: createSurface(sz.w, sz.h) });
      }
    });
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
      const isInput = sp.kind === 'input' || (sp.kind as string) === 'base';
      const common = {
        id: sp.id, name: String(sp.name), visible: !!sp.visible, locked: isInput,
        opacity: clamp01(Number(sp.opacity)), blend: (BLENDS.has(sp.blend) ? sp.blend : 'normal') as BlendMode,
        effects: sanitizeEffects(sp.effects),
      };
      const xf = cleanXf({ x: sp.x, y: sp.y, sx: sp.sx ?? 1, sy: sp.sy ?? 1, rot: sp.rot ?? 0, kx: sp.kx ?? 0, ky: sp.ky ?? 0 }) as Xf;
      let layer: Layer;
      if (sp.kind === 'group') {
        layer = { ...common, kind: 'group', children: [], expanded: true, mask: mk(sp.mask, w, h) };
        kids.set(sp.id, []);
      } else if (sp.kind === 'adjustment') {
        layer = { ...common, effects: migrateAdjustmentEffects(sp.adjustment as AdjustmentSpec | null, common.effects), blend: 'normal', kind: 'adjustment', adjustment: null, mask: mk(sp.mask, w, h) };
      } else if (sp.kind === 'text' || sp.kind === 'shape') {
        const v = { ...common, mask: mk(sp.mask, w, h) };
        layer = sp.kind === 'text'
          ? ({ ...v, kind: 'text', spec: sanitizeText(sp.text as TextSpec) } as TextLayer)
          : ({ ...v, kind: 'shape', spec: sanitizeShape(sp.shape as ShapeSpec) } as ShapeLayer);
      } else if (isInput) {
        const n = sp.kind === 'input' ? (sp.input as number) : 1;
        const st = this.doc.inputs.get(n) as InputState;
        const il = { ...common, ...xf, kind: 'input' as const, input: n, surface: st.surface, slot: null, mask: mk(sp.mask, st.surface.width, st.surface.height) } as PixelLayer;
        this.doc.inputLayers.add(il);
        layer = il;
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
    this.presets = sanitizeBrushPresets(spec.brushPresets);
    this.presetVer++;
    this.doc.canvasMode = spec.canvas?.mode === 'fixed' ? 'fixed' : 'input';
    this.announced.clear(); // TD's next inputs list creates layers for connected inputs the document lacks
    this.placePending.clear(); // the document says where the TD Inputs sit
    if (!this.doc.find(this.doc.activeId)) this.doc.activeId = this.doc.root.children[0]?.id ?? null;
    this.maskTargetLayer = null;
    if (resized) this.compositor.resize();
    else this.compositor.invalidate(null);
    this.version++;
    this.thumbs.clear();
    this.clearFxThumbs();
    const hadSel = this.sel.rect !== null;
    this.dropSelCaches();
    this.sel = NO_SEL;
    this.doc.selection = null;
    this.inputDirty.clear();
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
    if (!spec || !Array.isArray(spec.layers)) bad('no layers');
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
    const fin = (n: unknown): boolean => n === undefined || n === null || (typeof n === 'number' && Number.isFinite(n));
    // the input number a layer shows (a legacy `base` layer is input 1)
    const inputOf = (l: DocSpec['layers'][number]): number => (l.kind === 'input' ? (l.input as number) : 1);
    spec.layers.forEach((l) => {
      if (ids.has(l.id)) bad(`duplicate id ${l.id}`);
      ids.add(l.id);
      if (l.parentId !== null && l.parentId !== undefined && !groups.has(l.parentId)) bad(`bad parent of ${l.id}`);
      if (l.parentId === undefined) (l as { parentId: string | null }).parentId = null;
      const legacyBase = (l.kind as string) === 'base';
      if (l.kind === 'pixel' || l.kind === 'input' || legacyBase) {
        if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) bad(`bad position of ${l.id}`);
        if (!cleanXf({ x: l.x, y: l.y, sx: l.sx > 0 ? l.sx : 1, sy: l.sy > 0 ? l.sy : 1, rot: l.rot ?? 0, kx: l.kx ?? 0, ky: l.ky ?? 0 })) bad(`bad (singular) transform of ${l.id}`);
        if (!(Number.isFinite(l.sx) && Number.isFinite(l.sy) && l.sx > 0 && l.sy > 0)) bad(`bad scale of ${l.id}`);
        if (!fin(l.rot) || !fin(l.kx) || !fin(l.ky)) bad(`bad rotation / skew of ${l.id}`);
        if (!dim(l.surfaceW) || !dim(l.surfaceH)) bad(`bad surface size of ${l.id}`);
        if (!area(l)) bad(`surface of ${l.id} is too large`);
      }
      if (l.effects !== undefined && !Array.isArray(l.effects)) bad(`bad effects of ${l.id}`);
      if (l.kind === 'group') groups.add(l.id);
      else if (l.kind === 'pixel') take(l.slot);
      else if (l.kind === 'input' || legacyBase) {
        const n = inputOf(l);
        if (!Number.isInteger(n) || n < 1 || n > MAX_INPUTS) bad(`bad input number of ${l.id}`);
      } else if (l.kind === 'adjustment') { if (l.adjustment != null && !(l.adjustment.type in ADJUSTMENT_NAMES)) bad(`adjustment ${l.id}`); }
      else if (l.kind === 'text' || l.kind === 'shape') {
        const sp = l.kind === 'text' ? l.text : l.shape;
        if (!sp || typeof sp !== 'object') bad(`${l.kind} spec of ${l.id}`);
        try { if (l.kind === 'text') sanitizeText(l.text as TextSpec); else sanitizeShape(l.shape as ShapeSpec); } catch { bad(`${l.kind} spec of ${l.id}`); }
        if (l.slot !== null && l.slot !== undefined) bad(`${l.kind} layer ${l.id} cannot own a surface`);
      } else bad(`unknown kind ${String(l.kind)}`);
      if (l.mask) take(l.mask.slot);
    });
    return spec.layers;
  }

  // ---- TD input frames ----

  /** Straight RGBA rows of TD input `input` in its own pixel space (rects lie inside its surface, see setInputs). Records no history. */
  writeInput(input: number, rect: Rect, rgba: Uint8Array | Uint8ClampedArray): void {
    const ints = [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
    if (!ints || rect.w < 0 || rect.h < 0) throw new RangeError('writeInput: rect must be integers with non-negative size');
    const need = rect.w * rect.h * 4;
    if (rgba.length < need) throw new RangeError(`writeInput: need ${need} bytes, got ${rgba.length}`);
    const st = this.doc.inputs.get(input);
    if (!st) return;
    const clip = clipToSize(rect, st.surface.width, st.surface.height);
    if (!clip) return;
    const view = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need);
    st.surface.ctx.putImageData(new ImageData(view, rect.w, rect.h), rect.x, rect.y, clip.x - rect.x, clip.y - rect.y, clip.w, clip.h);
    this.inputDirty.set(input, union(this.inputDirty.get(input) ?? null, clip) as Rect);
  }

  /** Publish the frames written to input `input` (after FRAME_END): recomposite everywhere a layer shows it. */
  commitInput(input: number): void {
    const r = this.inputDirty.get(input);
    if (!r) return;
    this.inputDirty.delete(input);
    let d: Rect | null = null;
    for (const l of this.doc.all()) {
      if (l.kind === 'input' && l.input === input) d = union(d, dirtyDoc(l, r));
    }
    if (d) {
      this.compositor.streamFrom(input); // a streamed frame is not a content change of the other layers (their thumbnails stay valid)
      try { this.changed(d); } finally { this.compositor.streamFrom(null); }
    }
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

  /** Quick mask edits the selection through painting: the selection commands wait. */
  private selectionBusy(): boolean {
    if (!this.qm) return false;
    this.emit({ type: 'notice', message: 'Leave Quick Mask first' });
    return true;
  }

  setSelection(rect: Rect | null): void {
    this.finishStroke();
    if (this.selectionBusy()) return;
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
    if (this.qm) { // the quick mask's current coverage (cached until the next paint merge)
      if (this.qmMaskCache?.version === this.qmVersion) return this.qmMaskCache.mask;
      const W = this.doc.width;
      const d = this.qm.surface.ctx.getImageData(0, 0, W, this.doc.height).data;
      const alpha = new Uint8Array(W * this.doc.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
      const rect = boundsOfAlpha(alpha, W, this.docRect());
      const mask = rect ? { rect, alpha } : null;
      this.qmMaskCache = { version: this.qmVersion, mask };
      return mask;
    }
    const s = this.sel;
    if (!s.rect) return null;
    if (s.alpha) return { rect: { ...s.rect }, alpha: s.alpha };
    this.selMaskCache ??= materialize(s, this.doc.width, this.doc.height);
    return { rect: { ...s.rect }, alpha: this.selMaskCache };
  }

  selectionPath(): Array<Array<{ x: number; y: number }>> {
    if (this.qm) return []; // no marching ants while the selection is edited as a mask
    const f = this.doc.floating;
    if (f) { // a floating selection's outline is its (transformed) buffer rect
      const m = matOf(f.t);
      return [[applyMat(m, 0, 0), applyMat(m, f.buf.width, 0), applyMat(m, f.buf.width, f.buf.height), applyMat(m, 0, f.buf.height)]];
    }
    this.selPathCache ??= tracePath(this.sel, this.doc.width);
    return this.selPathCache.map((l) => l.map((p) => ({ ...p })));
  }

  selectAll(): void {
    this.finishStroke();
    if (this.selectionBusy()) return;
    this.changeSelection('Select all', selectAllState(this.doc.width, this.doc.height));
  }

  deselect(): void {
    this.finishStroke();
    if (this.selectionBusy()) return;
    this.changeSelection('Deselect', NO_SEL);
  }

  invertSelection(): void {
    this.finishStroke();
    if (this.selectionBusy()) return;
    if (!this.sel.rect) return;
    this.changeSelection('Invert selection', invertSel(this.sel, this.doc.width, this.doc.height));
  }

  maskFromSelection(layerId: string): void {
    const l = this.doc.find(layerId);
    if (!l || l.id === 'root') {
      this.emit({ type: 'notice', message: 'Masks need a layer' });
      return;
    }
    const s = this.sel;
    if (!s.rect) {
      this.emit({ type: 'notice', message: 'Make a selection first' });
      return;
    }
    const px = isPixel(l) ? l : null;
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
      const inv = invMat(matOf(px));
      c.setTransform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
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
    this.hist.push(this.item(label, { k: 'sel', before, after }));
    this.emit({ type: 'history' });
  }

  selectionAlpha(): Uint8Array | null { return this.qm ? null : this.sel.alpha; }

  /** Canvas whose alpha is the coverage (rgb white); built on first use after a selection change, only for non-rect selections. */
  selectionCanvas(): Surface | null {
    if (this.qm) return null;
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
    const toMask = !!l && !!l.mask && this.paintTarget().target === 'mask';
    if (sampleAll || !l || (!toMask && (l.kind === 'group' || l.kind === 'adjustment'))) return composite();
    if (toMask && l.mask) {
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
      opacity: 1, blend: 'normal', spec: clean, mask: null, effects: [],
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
      opacity: 1, blend: 'normal', spec, mask: null, effects: [],
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
    const px = newPixelLayer(l.id, l.name, surface, { visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend, effects: l.effects, slot: this.doc.newSlot(), mask });
    const area = union(specBounds(l), { x: 0, y: 0, w, h }) as Rect;
    this.structural('Flatten layer', () => { loc.parent.children[loc.index] = px; }, l.visible && l.opacity > 0 ? area : false);
  }

  /**
   * v7: TD rendered ids (flatten of one layer / group / adjustment-with-below, or Merge Selected): remove them and insert ONE pixel layer
   * holding `rgba` (doc-sized straight RGBA, identity transform, no mask, no effects, normal / 100%) at the topmost removed layer's position;
   * it becomes active. Ids nested in a listed group go with it. One history entry. Returns the new layer's id ('' if no id exists).
   */
  replaceLayersWithPixels(ids: string[], rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, name?: string): string {
    this.finishStroke();
    const sel = this.pickLayers(ids);
    if (!sel.length) return '';
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) throw new RangeError('replaceLayersWithPixels: bad size');
    const need = w * h * 4;
    if (rgba.length < need) throw new RangeError(`replaceLayersWithPixels: need ${need} bytes, got ${rgba.length}`);
    this.finishStroke();
    const surface = createSurface(w, h);
    surface.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need), w, h), 0, 0);
    const layer = newPixelLayer(this.doc.newId(), name ?? (sel.length === 1 ? sel[0].name : 'Merged'), surface, { slot: this.doc.newSlot() });
    const top = this.doc.locate(sel[0].id) as { parent: GroupLayer; index: number };
    this.structuralIf(sel.length === 1 ? 'Flatten layer' : 'Merge layers', () => {
      for (const l of sel) {
        const loc = this.doc.locate(l.id);
        if (loc) loc.parent.children.splice(loc.index, 1);
      }
      top.parent.children.splice(top.index, 0, layer);
      this.doc.activeId = layer.id;
      return true;
    }, union(this.docRect(), { x: 0, y: 0, w, h }) as Rect);
    this.thumbs.forEach((_, k) => { if (!this.doc.find(k)) this.thumbs.delete(k); });
    return layer.id;
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
    const layer = newPixelLayer(this.doc.newId(), String(name || 'Image'), surface, { x, y, sx: k, sy: k, slot: this.doc.newSlot() });
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
    if (l.locked && l.kind !== 'input') return this.emit({ type: 'notice', message: 'Layer is locked' });
    this.finishStroke();
    const before = this.doc.snapshot();
    const old = outerRect(surfaceDocBounds(l));
    l.x = c.x; l.y = c.y; l.sx = c.sx; l.sy = c.sy; l.rot = c.rot; l.kx = c.kx; l.ky = c.ky;
    const now = outerRect(surfaceDocBounds(l));
    this.commitStructure('Transform', before, `xform:${id}`, l.visible && l.opacity > 0 ? (union(old, now) as Rect) : false);
  }

  /**
   * Fit a layer's box to `box` (document px): pixel / input layers get the transform that maps their surface onto it;
   * text / shape layers scale their geometry (scaleSpec) from where they were when the drag began. Calls within a second
   * on the same layer form one drag (the scale always starts from the original geometry, so nothing accumulates) and one
   * history entry.
   *
   * Rotated / skewed pixel layers: `box` is their document-space bounding box (layerBounds). A pure move translates x, y;
   * a uniform resize scales sx, sy (rotation and skew are kept); a non-uniform resize applies the document-space scale to
   * the affine and re-expresses it as rot + kx (ky = 0, see decompose): the shape on screen is exact.
   */
  setLayerBox(id: string, box: Rect): void {
    const l = this.doc.find(id);
    if (!l || ![box.x, box.y, box.w, box.h].every(Number.isFinite) || !(box.w > 0) || !(box.h > 0)) return;
    if (isPixel(l)) {
      if (isAxis(l)) {
        // A pure move keeps sx / sy exactly (no ulp churn); other scales are rounded to 1e-9.
        const fit = (b: number, n: number, cur: number): number => (Math.abs(b - cur * n) < 1e-6 ? cur : Math.round((b / n) * 1e9) / 1e9);
        this.setTransform(id, { x: box.x, y: box.y, sx: fit(box.w, l.surface.width, l.sx), sy: fit(box.h, l.surface.height, l.sy), rot: 0, kx: 0, ky: 0 });
        return;
      }
      const b0 = surfaceDocBounds(l);
      if (!(b0.w > 0 && b0.h > 0)) return;
      const fx = box.w / b0.w;
      const fy = box.h / b0.h;
      const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a));
      // new translation: the layer origin keeps its place relative to the bounding box
      const x = box.x + (l.x - b0.x) * fx;
      const y = box.y + (l.y - b0.y) * fy;
      if (same(fx, 1) && same(fy, 1)) return this.setTransform(id, { ...copyXfLayer(l), x: l.x + (box.x - b0.x), y: l.y + (box.y - b0.y) });
      if (same(fx, fy)) return this.setTransform(id, { ...copyXfLayer(l), x, y, sx: l.sx * fx, sy: l.sy * fy });
      const m = matOf(l);
      const d = decompose({ a: m.a * fx, b: m.b * fy, c: m.c * fx, d: m.d * fy, e: x, f: y });
      return this.setTransform(id, d);
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

  /**
   * Bake the transform of a pixel layer (and its mask): resample into a surface covering the layer's document-space bounding
   * box at identity scale / rotation / skew; one history entry. Scale-only layers keep the v4 result (surface of
   * round(w * sx) x round(h * sy) at the same position). Rotation / skew: the surface is first scaled, then drawn under
   * R . K into the bounding box (whole pixels, anchored at floor of the box origin).
   */
  applyTransform(id: string): void {
    const l = this.doc.find(id);
    if (!l || l.kind === 'group') return;
    if (l.kind !== 'pixel') {
      this.emit({ type: 'notice', message: l.kind === 'input' ? 'The TD Input cannot be baked' : 'Only pixel layers can be baked' });
      return;
    }
    if (l.locked) return this.emit({ type: 'notice', message: 'Layer is locked' });
    if (l.sx === 1 && l.sy === 1 && isAxis(l)) return;
    const old = outerRect(surfaceDocBounds(l));
    let surface: Surface;
    let mask: Mask | null = null;
    let x = l.x;
    let y = l.y;
    if (isAxis(l)) {
      const nw = Math.max(1, Math.round(l.surface.width * l.sx));
      const nh = Math.max(1, Math.round(l.surface.height * l.sy));
      if (nw > MAX_DIM || nh > MAX_DIM || nw * nh > MAX_PIXELS) {
        this.emit({ type: 'notice', message: 'The transformed layer would be too large' });
        return;
      }
      this.finishStroke();
      surface = resampled(l.surface, nw, nh);
      mask = l.mask ? { slot: l.mask.slot, enabled: l.mask.enabled, surface: resampled(l.mask.surface, nw, nh, true) } : null;
    } else {
      const bb = surfaceDocBounds(l);
      const ox = Math.floor(bb.x);
      const oy = Math.floor(bb.y);
      const nw = Math.ceil(bb.x + bb.w) - ox;
      const nh = Math.ceil(bb.y + bb.h) - oy;
      if (nw < 1 || nh < 1 || nw > MAX_DIM || nh > MAX_DIM || nw * nh > MAX_PIXELS) {
        this.emit({ type: 'notice', message: 'The transformed layer would be too large' });
        return;
      }
      this.finishStroke();
      surface = this.bakeAffine(l.surface, l, nw, nh, ox, oy, false);
      mask = l.mask ? { slot: l.mask.slot, enabled: l.mask.enabled, surface: this.bakeAffine(l.mask.surface, l, nw, nh, ox, oy, true) } : null;
      x = ox;
      y = oy;
    }
    this.structural('Apply transform', () => {
      l.surface = surface;
      l.mask = mask;
      l.x = x;
      l.y = y;
      l.sx = 1;
      l.sy = 1;
      l.rot = l.kx = l.ky = 0;
    }, l.visible && l.opacity > 0 ? (union(old, outerRect(surfaceDocBounds(l))) as Rect) : false);
  }

  /** `src` drawn under the layer's affine into a new nw x nh surface whose top-left is document pixel (ox, oy). */
  private bakeAffine(src: Surface, t: Xf, nw: number, nh: number, ox: number, oy: number, readback: boolean): Surface {
    // scale first (staged downscale keeps quality), then rotate / skew the scaled copy: remaining mapping = T . R . K . diag(fx, fy)
    const sw = Math.max(1, Math.round(src.width * t.sx));
    const sh = Math.max(1, Math.round(src.height * t.sy));
    const scaled = sw === src.width && sh === src.height ? src : resampled(src, sw, sh);
    const m = matOf({ ...t, sx: (src.width * t.sx) / sw, sy: (src.height * t.sy) / sh });
    const out = createSurface(nw, nh, readback);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = 'high';
    out.ctx.transform(m.a, m.b, m.c, m.d, m.e - ox, m.f - oy);
    out.ctx.drawImage(scaled.canvas as CanvasImageSource, 0, 0);
    if (scaled !== src) releaseSurface(scaled);
    return out;
  }

  // ---- Tools ----

  setTool(id: ToolId): void {
    this.finishStroke(false); // the UI switches to the move tool to transform a floating selection
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

  // ---- v6 brush tips and presets ----

  setBrushTip(tip: TipShape, dynamics: BrushDynamics, customTip?: { w: number; h: number; alpha: Uint8Array }): void {
    const custom = tip === 'custom' ? sanitizeCustomTip(customTip) : null;
    const shape: TipShape = tip === 'custom' ? (custom ? 'custom' : 'round') : BUILTIN_TIPS.includes(tip) ? tip : 'round';
    this.finishStroke(false);
    this.tip = { shape, dynamics: sanitizeDynamics(dynamics), custom };
    this.tipStrokes = 0; // setting the tip restarts the stroke sequence
  }

  /** Active pixel layer luminance (Rec.709) x alpha x selection coverage inside the selection bounds, <= 512 x 512 (area-averaged down). */
  tipFromSelection(): { w: number; h: number; alpha: Uint8Array } | null {
    const l = this.doc.active();
    const sel = this.selectionMask();
    const why = !sel ? 'Make a selection first' : !l || l.kind !== 'pixel' ? 'Select a pixel layer to define a brush tip' : null;
    if (why || !sel || !l || l.kind !== 'pixel') {
      this.emit({ type: 'notice', message: why ?? 'Select a pixel layer to define a brush tip' });
      return null;
    }
    const W = this.doc.width;
    const r = intersect(sel.rect, this.docRect());
    const px = l.surface.ctx.getImageData(0, 0, l.surface.width, l.surface.height).data;
    const d = r ? this.inDocSpace(px, l.surface.width, l.surface.height, layerXf(l)) : null;
    if (!r || !d) {
      this.emit({ type: 'notice', message: 'The selection is empty' });
      return null;
    }
    if (r.w * r.h > 4096 * 4096) {
      this.emit({ type: 'notice', message: 'The selection is too large for a brush tip' });
      return null;
    }
    const v = new Float32Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = (( r.y + y) * W + r.x + x);
        v[y * r.w + x] = ((0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255) * (d[i * 4 + 3] / 255) * (sel.alpha[i] / 255);
      }
    }
    const f = Math.max(1, Math.max(r.w, r.h) / MAX_TIP_SIZE);
    const w = Math.max(1, Math.min(MAX_TIP_SIZE, Math.round(r.w / f)));
    const h = Math.max(1, Math.min(MAX_TIP_SIZE, Math.round(r.h / f)));
    const alpha = new Uint8Array(w * h);
    let any = false;
    for (let y = 0; y < h; y++) {
      const y0 = (y * r.h) / h;
      const y1 = ((y + 1) * r.h) / h;
      for (let x = 0; x < w; x++) {
        const x0 = (x * r.w) / w;
        const x1 = ((x + 1) * r.w) / w;
        let sum = 0;
        for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
          const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
          for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) sum += v[sy * r.w + sx] * wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
        }
        const a = Math.round((255 * sum) / ((x1 - x0) * (y1 - y0)));
        if (a > 0) any = true;
        alpha[y * w + x] = Math.min(255, a);
      }
    }
    if (!any) {
      this.emit({ type: 'notice', message: 'The selected pixels are empty or black' });
      return null;
    }
    return { w, h, alpha };
  }

  brushPresets(): BrushPreset[] { return structuredClone(this.presets); }

  /** Shared read-only copy of the presets for docSpec(), rebuilt only when they changed. */
  private presetClone(): BrushPreset[] {
    if (!this.presetCache || this.presetCache.v !== this.presetVer) this.presetCache = { v: this.presetVer, list: structuredClone(this.presets) };
    return this.presetCache.list;
  }

  setBrushPresets(presets: BrushPreset[]): void {
    const next = sanitizeBrushPresets(presets);
    if (JSON.stringify(next) === JSON.stringify(this.presets)) return;
    this.presets = next;
    this.presetVer++;
    this.bumpSpec();
  }

  pointerDown(p: ToolPointer): void {
    this.finishStroke();
    this.last = p;
    if (this.qm && SELECT_TOOLS.includes(this.toolId)) {
      this.active = null;
      this.emit({ type: 'notice', message: 'Leave Quick Mask to use the selection tools' });
      return;
    }
    this.active = (p.alt && PAINT_TOOLS.includes(this.toolId) ? this.tools.picker : this.tools[this.toolId]) ?? null;
    const al = this.doc.active();
    if (this.active && this.active !== this.tools.picker && STROKE_TOOLS.includes(this.toolId) && al) this.compositor.holdBelow(al.id); // v6: cache the composite below the stroke's layer
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
    this.compositor.holdBelow(null);
    this.liveSpec = false;
  }

  // ---- History ----

  /** v7.2: a scrub drag starts -- every edit until `endGesture` is ONE undo step. */
  beginGesture(): void {
    this.hist.beginGroup();
  }

  /** The drag ended; `cancel` (Escape) drops the gesture's step again (the caller already reverted its value). */
  endGesture(cancel = false): 'dropped' | 'kept' | 'none' {
    const r = this.hist.endGroup(cancel);
    if (r === 'dropped') this.emit({ type: 'history' });
    if (this.fxQueue.size) this.pumpFxThumbs(false); // effect thumbnails deferred during the gesture
    return r;
  }

  undo(): void {
    if (this.doc.floating) return this.cancelFloating(); // undo while floating = cancel (Esc)
    this.finishStroke();
    if (this.hist.undo()) this.emit({ type: 'history' });
    if (this.staleDirty) this.pruneStale();
  }

  redo(): void {
    if (this.doc.floating) return this.cancelFloating();
    this.finishStroke();
    if (this.hist.redo()) this.emit({ type: 'history' });
    if (this.staleDirty) this.pruneStale();
  }

  history(): { entries: HistoryEntry[]; index: number } {
    return { entries: this.hist.entries(), index: this.hist.index };
  }

  jumpTo(index: number): void {
    if (this.doc.floating) this.cancelFloating();
    this.finishStroke();
    const before = this.hist.index;
    this.hist.jumpTo(index);
    if (this.hist.index !== before) this.emit({ type: 'history' });
    if (this.staleDirty) this.pruneStale();
  }

  clearHistory(): void {
    this.finishStroke();
    this.hist.clear();
    this.emit({ type: 'history' });
  }

  dispose(): void {
    if (this.fxTimer !== null) clearTimeout(this.fxTimer);
    this.fxTimer = null;
    this.fxQueue.clear();
    this.fxThumbs.clear();
    this.fxMeta.clear();
    this.fxWaiters.splice(0).forEach((f) => f());
    this.cancelFloating();
    if (this.qm) releaseSurface(this.qm.surface);
    this.qm = null;
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

  // ---- v5: base aliases (the contract still lists them) ----

  /** @deprecated use writeInput(1, ...). */
  writeBase(rect: Rect, rgba: Uint8Array | Uint8ClampedArray): void { this.writeInput(1, rect, rgba); }
  /** @deprecated use commitInput(1). */
  commitBase(): void { this.commitInput(1); }

  // ---- v5: effects ----

  setEffects(id: string, effects: Effect[]): void {
    this.setEffectsAs(id, effects, 'Layer effects', `fx:${id}`);
  }

  private setEffectsAs(id: string, effects: Effect[], label: string, key: string): void {
    const l = this.doc.find(id);
    if (!l) return;
    const next = sanitizeEffects(effects);
    if (sameEffects(next, l.effects)) return;
    this.finishStroke();
    const before = this.doc.snapshot();
    const old = layerExtent(l, this.docRect());
    l.effects = next;
    const ext = union(old, layerExtent(l, this.docRect()));
    this.commitStructure(label, before, key, l.visible && l.opacity > 0 ? ext : false);
  }

  // ---- v6: layers shown from TouchDesigner's render (tdPreview) ----

  tdPreviewLayers(): string[] {
    const out: string[] = [];
    for (const l of this.doc.all()) {
      if (tdPreviewFlag(l.effects)) out.push(l.id);
    }
    return out;
  }

  /**
   * TD's render of a tdPreview layer after its effects (doc sized, straight RGBA; masked for pixel / input / text / shape layers, the masked group composite
   * (mask first, then effects, before opacity / blend) for groups, the adjusted + filtered result before the opacity x mask mix for adjustment layers). null clears it. Images of other layers or
   * of the wrong size are ignored.
   */
  setLayerPreview(layerId: string, rgba: Uint8Array | Uint8ClampedArray | null): void {
    const l = this.doc.find(layerId);
    if (!l) return;
    const had = this.compositor.hasPreview(layerId);
    if (rgba === null) {
      if (!had) return;
      this.compositor.setPreview(layerId, null);
    } else {
      const W = this.doc.width;
      const H = this.doc.height;
      const need = W * H * 4;
      if (rgba.length !== need || !this.tdPreviewLayers().includes(layerId)) return;
      const surface = createSurface(W, H, true);
      surface.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, need), W, H), 0, 0);
      this.compositor.setPreview(layerId, surface);
    }
    this.version++;
    this.thumbs.clear();
    this.emit({ type: 'pixels', rect: this.docRect() });
    this.emit({ type: 'structure' });
  }

  // ---- v5: retouch options ----

  setCloneOptions(o: CloneOptions): void {
    this.cloneOpts = { aligned: !!o.aligned, sampleAll: !!o.sampleAll };
  }

  setRetouchOptions(o: { strength: number; sharpen: boolean; burn: boolean; range: 'shadows' | 'midtones' | 'highlights'; exposure: number }): void {
    this.retouchOpts = {
      strength: clamp01(Number(o.strength)), sharpen: !!o.sharpen, burn: !!o.burn,
      range: o.range === 'shadows' || o.range === 'highlights' ? o.range : 'midtones', exposure: clamp01(Number(o.exposure)),
    };
  }

  /** The point the clone tool samples now (while stroking) or was last Alt-clicked at (document px); null before the first Alt-click. */
  cloneSource(): { x: number; y: number } | null {
    return this.cloneTool.sourcePoint();
  }

  // ---- v5: floating selection ----

  private floatEvents(): void {
    this.version++;
    this.emit({ type: 'selection' });
    this.emit({ type: 'structure' });
  }

  /**
   * Cut the selected pixels (weighted by the selection coverage) of the active pixel layer into a floating selection that
   * starts where the pixels were, under the layer's own transform. While it floats the layer shows a hole, the compositor draws
   * the buffer above the layer, TouchDesigner is not told (no 'surface' events) and any other edit commits it; undo / redo
   * cancel it. Returns false (with a notice) when there is nothing to lift.
   */
  liftSelection(): boolean {
    if (this.doc.floating) this.commitFloating();
    this.finishStroke();
    const l = this.doc.active();
    const why = this.qm ? 'Leave Quick Mask first'
      : !l || l.kind !== 'pixel' ? 'Select a pixel layer to transform its selection'
        : this.paintTarget().target === 'mask' ? 'Select the layer pixels, not the mask'
          : !l.visible ? 'Layer is hidden' : l.locked ? 'Layer is locked' : !this.sel.rect ? 'Make a selection first' : null;
    if (why || !l || l.kind !== 'pixel') {
      this.emit({ type: 'notice', message: why ?? 'Nothing to lift' });
      return false;
    }
    const sel = this.sel.rect as Rect;
    const lr = intersect({ x: 0, y: 0, w: l.surface.width, h: l.surface.height }, innerLayerRect(l, sel));
    if (!lr) return false;
    // coverage in layer pixels: the selection mapped into the layer's space
    const cov = createSurface(lr.w, lr.h, true);
    const cc = cov.ctx;
    cc.imageSmoothingEnabled = true;
    const selCanvas = this.selectionCanvas();
    if (selCanvas) {
      cc.imageSmoothingQuality = 'low';
      const m = invMat(matOf(l));
      cc.transform(m.a, m.b, m.c, m.d, m.e - lr.x, m.f - lr.y);
      cc.drawImage(selCanvas.canvas as CanvasImageSource, 0, 0);
    } else {
      const poly = docRectPolygon(l, sel);
      cc.fillStyle = '#fff';
      cc.beginPath();
      cc.moveTo(poly[0].x - lr.x, poly[0].y - lr.y);
      for (let i = 1; i < 4; i++) cc.lineTo(poly[i].x - lr.x, poly[i].y - lr.y);
      cc.closePath();
      cc.fill();
    }
    cc.setTransform(1, 0, 0, 1, 0, 0);
    // outside the canvas nothing is selected (axis-aligned layers: the AABB is exact; rotated: clip to the canvas)
    if (!isAxis(l)) {
      cc.globalCompositeOperation = 'destination-in';
      cc.beginPath();
      const poly = docRectPolygon(l, this.docRect());
      cc.moveTo(poly[0].x - lr.x, poly[0].y - lr.y);
      for (let i = 1; i < 4; i++) cc.lineTo(poly[i].x - lr.x, poly[i].y - lr.y);
      cc.closePath();
      cc.fillStyle = '#fff';
      cc.fill();
      cc.globalCompositeOperation = 'source-over';
    }
    const any = cc.getImageData(0, 0, lr.w, lr.h).data;
    let has = false;
    for (let i = 3; i < any.length; i += 4) if (any[i] > 0) { has = true; break; }
    if (!has) {
      releaseSurface(cov);
      this.emit({ type: 'notice', message: 'Nothing to lift' });
      return false;
    }
    const buf = createSurface(lr.w, lr.h, true);
    buf.ctx.drawImage(l.surface.canvas as CanvasImageSource, lr.x, lr.y, lr.w, lr.h, 0, 0, lr.w, lr.h);
    buf.ctx.globalCompositeOperation = 'destination-in';
    buf.ctx.drawImage(cov.canvas as CanvasImageSource, 0, 0);
    buf.ctx.globalCompositeOperation = 'source-over';
    const tb = new TileBackup(l);
    tb.cover(lr);
    const sc = l.surface.ctx;
    sc.save();
    sc.globalCompositeOperation = 'destination-out';
    sc.drawImage(cov.canvas as CanvasImageSource, lr.x, lr.y);
    sc.restore();
    const o = toDoc(l, lr.x, lr.y);
    const t0: Xf = { x: o.x, y: o.y, sx: l.sx, sy: l.sy, rot: l.rot, kx: l.kx, ky: l.ky };
    this.doc.floating = { layer: l, buf, cov, rect: lr, t0, t: { ...t0 }, tb, selBefore: this.sel };
    this.changed(dirtyDoc(l, lr));
    this.floatEvents();
    return true;
  }

  /** The floating selection: `bounds` = document-space bounding box under the current transform, `transform` maps the buffer (see floatingSize) to the document. */
  floating(): { bounds: Rect; transform: LayerTransform } | null {
    const f = this.doc.floating;
    return f ? { bounds: floatingBounds(f), transform: { ...f.t } } : null;
  }

  /** Size of the floating buffer in its own pixels (the transform box is this rect under `floating().transform`). */
  floatingSize(): { w: number; h: number } | null {
    const f = this.doc.floating;
    return f ? { w: f.buf.width, h: f.buf.height } : null;
  }

  setFloatingTransform(t: LayerTransform): void {
    const f = this.doc.floating;
    if (!f) return;
    const rot = t.rot ?? 0;
    const kx = t.kx ?? 0;
    const ky = t.ky ?? 0;
    if (![t.x, t.y, t.sx, t.sy, rot, kx, ky].every(Number.isFinite)) return;
    const c = cleanXf(t);
    if (!c) return; // singular skew
    const next: Xf = { ...c, x: t.x, y: t.y }; // the position of a floating selection is not snapped to whole pixels
    if (sameXf(f.t, next)) return;
    const old = outerRect(floatingBounds(f));
    f.t = next;
    this.changed(union(old, outerRect(floatingBounds(f))) as Rect);
    this.floatEvents();
  }

  /** Resample the floating buffer into its layer (source-over; the hole stays where it was cut) and select its footprint; one history entry. */
  commitFloating(): void {
    const f = this.doc.floating;
    if (!f) return;
    this.doc.floating = null;
    const l = f.layer;
    if (sameXf(f.t, f.t0)) {
      // unmoved: put the cut pixels back exactly (a feathered cut is not undone by drawing the buffer over the hole); nothing to record
      f.tb.restore(f.rect);
      f.tb.dispose();
      releaseSurface(f.buf);
      releaseSurface(f.cov);
      this.changed(dirtyDoc(l, f.rect));
      this.floatEvents();
      return;
    }
    const X = mulMat(invMat(matOf(l)), matOf(f.t)); // buffer -> layer pixels
    const box = (() => {
      const pts = [applyMat(X, 0, 0), applyMat(X, f.buf.width, 0), applyMat(X, f.buf.width, f.buf.height), applyMat(X, 0, f.buf.height)];
      const x0 = Math.floor(Math.min(...pts.map((p) => p.x))) - 1;
      const y0 = Math.floor(Math.min(...pts.map((p) => p.y))) - 1;
      const x1 = Math.ceil(Math.max(...pts.map((p) => p.x))) + 1;
      const y1 = Math.ceil(Math.max(...pts.map((p) => p.y))) + 1;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    })();
    const area = intersect(box, { x: 0, y: 0, w: l.surface.width, h: l.surface.height });
    if (area) f.tb.cover(area);
    const unmoved = sameXf(f.t, f.t0);
    const c = l.surface.ctx;
    c.save();
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.transform(X.a, X.b, X.c, X.d, X.e, X.f);
    c.drawImage(f.buf.canvas as CanvasImageSource, 0, 0);
    c.restore();
    // the selection follows the floating pixels
    let selAfter = f.selBefore;
    if (!unmoved) {
      const win = createSurface(this.doc.width, this.doc.height, true);
      const m = matOf(f.t);
      win.ctx.imageSmoothingEnabled = true;
      win.ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      win.ctx.drawImage(f.cov.canvas as CanvasImageSource, 0, 0);
      const d = win.ctx.getImageData(0, 0, win.width, win.height).data;
      const alpha = new Uint8Array(win.width * win.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
      releaseSurface(win);
      const rect = boundsOfAlpha(alpha, this.doc.width, this.docRect());
      selAfter = rect ? { rect, alpha } : NO_SEL;
    }
    const patches = f.tb.patches();
    releaseSurface(f.buf);
    releaseSurface(f.cov);
    const target = this.makeTarget(l, false);
    this.hist.push(this.item('Transform selection', { k: 'fsel', target, patches, before: f.selBefore, after: selAfter }));
    for (const p of patches) this.paintChanged(target, p.rect);
    this.changed(union(outerRect(floatingBounds(f)), dirtyDoc(l, f.rect)) as Rect);
    if (!selEqual(selAfter, this.sel, this.doc.width)) this.setSel(selAfter);
    this.floatEvents();
    this.emit({ type: 'history' });
  }

  /** Put the cut pixels back and drop the floating selection (no history). */
  cancelFloating(): void {
    const f = this.doc.floating;
    if (!f) return;
    this.doc.floating = null;
    f.tb.restore(f.rect);
    f.tb.dispose();
    releaseSurface(f.buf);
    releaseSurface(f.cov);
    this.changed(union(outerRect(floatingBounds(f)), dirtyDoc(f.layer, f.rect)) as Rect);
    this.floatEvents();
  }

  // ---- v5: quick mask ----

  /**
   * Quick mask on: the selection becomes a document-sized mask (alpha = coverage) that every paint tool edits (white adds, black
   * removes, the eraser removes). The viewport draws it red from quickMaskSource(). Off: the mask becomes the selection (one
   * history entry when it changed). While it is on 'selection' events follow every paint merge, selectionPath() is empty,
   * the selection tools and selection commands are disabled (a notice) and the strokes are not kept in history afterwards.
   */
  setQuickMask(on: boolean): void {
    if (on === !!this.qm) return;
    this.finishStroke();
    if (on) {
      const surface = createSurface(this.doc.width, this.doc.height, true);
      if (this.sel.rect) surface.ctx.putImageData(this.coverageImage(this.sel), this.sel.rect.x, this.sel.rect.y);
      const layer = newPixelLayer('quickmask', 'Quick Mask', surface);
      this.qm = { surface, layer, selBefore: this.sel };
      this.qmVersion++;
      this.doc.selection = null; // paint tools are not clipped by the selection while it is being edited
      this.dropSelCaches();
      this.emit({ type: 'selection' });
      return;
    }
    const q = this.qm as NonNullable<Engine['qm']>;
    const W = this.doc.width;
    const H = this.doc.height;
    const d = q.surface.ctx.getImageData(0, 0, W, H).data;
    const alpha = new Uint8Array(W * H);
    for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
    const rect = boundsOfAlpha(alpha, W, this.docRect());
    const next: SelState = rect ? { rect, alpha } : NO_SEL;
    this.qm = null;
    this.qmMaskCache = null;
    releaseSurface(q.surface);
    const dropped = this.hist.discardTagged('qm'); // the strokes of this session; redo history stays unless the selection changed
    const before = q.selBefore;
    this.sel = before;
    this.doc.selection = before.rect;
    this.dropSelCaches();
    if (!selEqual(before, next, W)) {
      this.setSel(next);
      this.commitSelection('Quick mask', before);
    } else {
      this.emit({ type: 'selection' });
    }
    if (dropped) this.emit({ type: 'history' });
  }

  quickMask(): boolean { return this.qm !== null; }

  /** The quick mask as a document-sized canvas (rgb white, alpha = coverage) for the viewport's red overlay; null when quick mask is off. Changes are announced by 'selection' events. */
  quickMaskSource(): CanvasImageSource | null {
    return this.qm ? (this.qm.surface.canvas as CanvasImageSource) : null;
  }

  // ---- v5: selection modifiers ----

  modifySelection(op: 'grow' | 'shrink' | 'smooth' | 'feather' | 'border', px: number): void {
    this.finishStroke();
    if (this.qm) return this.emit({ type: 'notice', message: 'Leave Quick Mask first' });
    if (!this.sel.rect) return this.emit({ type: 'notice', message: 'Make a selection first' });
    if (!Number.isFinite(px) || px <= 0) return;
    this.changeSelection(`${op[0].toUpperCase()}${op.slice(1)} selection`, modifySel(this.sel, op as SelOp, px, this.doc.width, this.doc.height));
  }

  // ---- v6: history steps as data, persistence ----

  /** The undo / redo closures of a step described as data (the same ones are rebuilt after restoreHistory). */
  private item(label: string, ser: Ser, o: { coalesceKey?: string; tag?: string } = {}): HistoryItem {
    const pair = (bytes: number, undo: () => void, redo: () => void, persist = true): HistoryItem =>
      ({ label, bytes, undo, redo, coalesceKey: o.coalesceKey, tag: o.tag, ser: persist ? ser : undefined });
    const surfDiff = (a: StructureSnapshot, b: StructureSnapshot): number => {
      // Surfaces only history keeps alive (deleted layers, replaced by a bake / flatten) are held in memory.
      const x = snapshotSurfaces(a);
      const y = snapshotSurfaces(b);
      let n = 0;
      x.forEach((sf) => { if (!y.has(sf)) n += sf.width * sf.height * 4; });
      y.forEach((sf) => { if (!x.has(sf)) n += sf.width * sf.height * 4; });
      return n;
    };
    const patchBytes = (ps: Patch[]): number => ps.reduce((n, p) => n + p.before.data.length + p.after.data.length, 0);
    const selBytes = (...ss: SelState[]): number => ss.reduce((n, x) => n + (x.alpha?.length ?? 0), 0);
    switch (ser.k) {
      case 'patch': {
        const { target, patches } = ser;
        const apply = (which: 'before' | 'after') => () => {
          if (target.quick && this.qm?.layer !== target.layer) return; // that quick mask session is over
          if (this.staleSurfaces.has(target.surface)) return; // its input changed resolution since
          for (const p of patches) {
            target.surface.ctx.putImageData(p[which], p.rect.x, p.rect.y);
            this.paintChanged(target, p.rect);
          }
        };
        return pair(patchBytes(patches), apply('before'), apply('after'), !target.quick);
      }
      case 'struct': {
        const apply = (sn: StructureSnapshot) => () => {
          const prev = this.doc.snapshot();
          this.markStale(this.doc.restore(sn));
          this.structureChanged(null, !specSame(prev, this.doc.snapshot()));
        };
        return pair(256 + surfDiff(ser.before, ser.after), apply(ser.before), apply(ser.after));
      }
      case 'guides': {
        const go = (g: Guides) => () => {
          this.doc.guides = copyGuides(g);
          this.bumpSpec();
        };
        const { before, after } = ser;
        return pair(64 + 8 * (before.h.length + before.v.length + after.h.length + after.v.length), go(before), go(after));
      }
      case 'sel': {
        const go = (s: SelState) => () => { this.setSel(s); };
        return pair(64 + selBytes(ser.before, ser.after), go(ser.before), go(ser.after));
      }
      case 'fsel': {
        const { target, patches } = ser;
        const apply = (which: 'before' | 'after') => () => {
          if (!this.staleSurfaces.has(target.surface)) {
            for (const p of patches) {
              target.surface.ctx.putImageData(p[which], p.rect.x, p.rect.y);
              this.paintChanged(target, p.rect);
            }
          }
          this.setSel(ser[which]);
        };
        return pair(patchBytes(patches) + selBytes(ser.before, ser.after), apply('before'), apply('after'));
      }
      case 'canvas': {
        const go = (snap: StructureSnapshot, cs: CanvasState) => () => {
          const prev = { w: this.doc.width, h: this.doc.height, sel: this.sel };
          this.markStale(this.doc.restore(snap));
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
        return pair(256 + selBytes(ser.cBefore.sel, ser.cAfter.sel) + surfDiff(ser.sBefore, ser.sAfter), go(ser.sBefore, ser.cBefore), go(ser.sAfter, ser.cAfter));
      }
    }
  }

  /** Content hash of every pixel and mask surface (by slot): a history only restores over the very pixels it was saved with (strokes do not bump the revision). */
  private surfaceHashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [slot, s] of this.slotSurfaces()) out[String(slot)] = surfaceHash(s);
    return out;
  }

  /** Changes whenever the undo / redo stacks change (push, undo, redo, jump, clear, restore): cheap trigger for persistence. */
  historyVersion(): number { return this.hist.version; }

  /** Hash of everything docSpec() says except the revision: identifies the document a persisted history belongs to. */
  private legacySig: string | null = null;

  private layoutSig(): string {
    const d = this.docSpec();
    return hashString(JSON.stringify([d.width, d.height, d.layers, d.guides, d.canvas]));
  }

  /**
   * The undo / redo stacks as a versioned binary blob (see historyBlob.ts): the last `maxSteps` applied steps (plus up to as many redo
   * steps) whose size stays within `maxBytes`; oldest steps go first. A step the format cannot express (a quick mask stroke) ends the window.
   * Does not touch the document. A floating selection or a history too large for even one step gives a blob without steps.
   */
  serializeHistory(maxSteps: number, maxBytes: number): Uint8Array {
    const steps = Math.max(0, Math.min(1000, Math.trunc(Number(maxSteps)) || 0));
    const cap = Math.max(1024, Number(maxBytes) || 0);
    const st = this.hist.stored();
    const cur = this.hist.index;
    const rev = this.rev;
    const sig = this.layoutSig();
    const hashes = this.surfaceHashes();
    if (this.doc.floating || this.qm || !steps) return writeBlob(this.doc, rev, sig, [], -1, hashes);
    let lo = cur + 1;
    let hi = cur;
    let bytes = 0;
    for (let i = cur; i >= 0 && cur - i < steps; i--) {
      if (!st[i].ser || bytes + st[i].bytes > cap) break;
      bytes += st[i].bytes;
      lo = i;
    }
    for (let i = cur + 1; i < st.length && i - cur <= steps; i++) {
      if (!st[i].ser || bytes + st[i].bytes > cap) break;
      bytes += st[i].bytes;
      hi = i;
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      const entries: SerEntry[] = [];
      for (let i = lo; i <= hi; i++) entries.push({ label: st[i].label, ser: st[i].ser as Ser });
      const blob = writeBlob(this.doc, rev, sig, entries, cur - lo, hashes);
      if (blob.length <= cap || lo > hi) return blob;
      // too big (orphan surfaces, selections, header): drop the oldest quarter, then the redo tail
      if (lo <= cur) lo = Math.min(cur + 1, lo + Math.max(1, Math.ceil((cur + 1 - lo) / 4)));
      else hi = Math.max(cur, hi - Math.max(1, Math.ceil((hi - cur) / 4)));
    }
    return writeBlob(this.doc, rev, sig, [], -1, hashes);
  }

  /**
   * Restore a serializeHistory blob into an EMPTY history after the matching document was loaded (same `rev`, same layout, surfaces
   * written): undo / redo then work as before the save. Returns false (document and history untouched) for another revision or layout,
   * an unknown version, a corrupt blob, or when history already has steps / a floating selection or quick mask is active. Never throws.
   */
  restoreHistory(blob: Uint8Array, rev: number): boolean {
    try {
      if (this.doc.floating || this.qm || this.hist.stored().length || !(blob instanceof Uint8Array)) return false;
      let r: ReturnType<typeof readBlob>;
      try {
        r = readBlob(blob, this.doc, rev, this.layoutSig(), this.surfaceHashes());
      } catch (err) {
        if (!this.legacySig) throw err;
        r = readBlob(blob, this.doc, rev, this.legacySig, this.surfaceHashes()); // blob of the pre-migration document
      }
      let items: HistoryItem[];
      try {
        items = r.entries.map((e) => this.item(e.label, e.ser));
      } catch (err) {
        r.created.forEach(releaseSurface);
        throw err;
      }
      r.deadInputLayers.forEach((l) => this.doc.inputLayers.add(l));
      this.hist.load(items, r.cur);
      this.emit({ type: 'history' });
      return true;
    } catch {
      return false;
    }
  }

  // ---- internals ----

  /** Tool scratch: stroke / backup start tiny and grow to the surface being edited (reserveScratch); the tip is fixed size. */
  private makeScratch(): Scratch {
    return {
      stamp: createSurface(MAX_BRUSH + 2, MAX_BRUSH + 2),
    };
  }

  /** End the stroke in progress; `commit`: also commit a floating selection (edits do, tool / view changes and read-only calls never do). */
  private finishStroke(commit = true): void {
    if (commit && this.doc.floating) this.commitFloating(); // any other edit commits a floating selection
    const t = this.active;
    const p = this.last;
    this.active = null;
    this.last = null;
    if (t && p) t.up(p);
    this.compositor.holdBelow(null);
    this.liveSpec = false;
  }

  private structureChanged(dirty: Rect | null | false, specChanged: boolean): void {
    this.version++;
    if (dirty === false && this.compositor.hasAux()) dirty = null; // an edit of a hidden layer may change a layer that displaces by it
    if (dirty !== false) this.compositor.invalidate(dirty, true); // layer properties / transforms: layer contents are unchanged
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

  /** A group whose subtree is all normal-blend, no adjustment layers: compositing it isolated equals compositing its children in place. */
  private isPlainGroup(g: GroupLayer): boolean {
    return g.effects.length === 0 && g.opacity === 1 && !g.mask && g.children.every((c) => c.blend === 'normal' && c.kind !== 'adjustment' && (c.kind !== 'group' || this.isPlainGroup(c)));
  }

  private isInside(group: GroupLayer, maybeDescendant: Layer): boolean {
    return group.children.some((c) => c === maybeDescendant || (c.kind === 'group' && this.isInside(c, maybeDescendant)));
  }
}
