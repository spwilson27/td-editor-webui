import { remapShape, remapText, transformFor } from '../../src/state/transform';
import type {
  BrushDynamics, BrushPreset, CloneOptions, DodgeBurnRange, Effect, TipShape,
  AdjustmentSpec, AdjustmentType, Anchor, BlendMode, CanvasMode, DocSpec, EditorEngine, EngineEvent, Guides, HistoryEntry, LayerInfo, LayerSpec, LayerTransform,
  PaintTarget, Rect, SelectionOptions, ShapeSpec, ShapeType, SnapOptions, TextSpec, ToolContext, ToolId, ToolPointer,
} from '../../src/engine/types';

interface FakeLayer {
  id: string; name: string; kind: 'pixel' | 'group' | 'input' | 'adjustment' | 'text' | 'shape'; visible: boolean; locked: boolean;
  opacity: number; blend: BlendMode; expanded: boolean; parent: string | null; colour: string;
  slot: number | null; mask: { slot: number; enabled: boolean } | null; adjustment: AdjustmentSpec | null;
  text?: TextSpec | null; shape?: ShapeSpec | null;
  x: number; y: number; sx: number; sy: number; rot: number; kx: number; ky: number;
  input: number | null; effects: Effect[]; surfaceW: number | null; surfaceH: number | null;
}

export const DEFAULT_ADJUSTMENTS: Record<AdjustmentType, AdjustmentSpec> = {
  levels: { type: 'levels', inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 },
  brightnessContrast: { type: 'brightnessContrast', brightness: 0, contrast: 0 },
  hueSaturation: { type: 'hueSaturation', hue: 0, saturation: 1, value: 1 },
  blur: { type: 'blur', radius: 8 },
  invert: { type: 'invert' },
  threshold: { type: 'threshold', level: 0.5 },
  filter: { type: 'filter', effect: { type: 'blur', enabled: true, radius: 8 } as unknown as Effect },
};

/** Minimal in-memory EditorEngine for UI tests. Records calls; paints dabs into a lazily created canvas. */
export class FakeEngine implements EditorEngine {
  width: number;
  height: number;
  calls: string[] = [];
  pointers: { kind: 'down' | 'move' | 'up'; p: ToolPointer }[] = [];
  tool: ToolId = 'brush';
  context: ToolContext | null = null;
  baseWrites: { rect: Rect; len: number }[] = [];
  surfaceWrites: { slot: number; rect: Rect; len: number }[] = [];
  surfaceCommits = 0;
  loaded: DocSpec[] = [];
  previewEnabled = true;
  rev = 0;
  target: { layerId: string | null; target: PaintTarget } = { layerId: null, target: 'pixels' };
  surfaces = new Map<number, Uint8ClampedArray>();
  private nextSlot = 1;
  commits = 0;
  private listeners = new Set<(e: EngineEvent) => void>();
  private store: FakeLayer[];
  private active: string;
  private nextId = 1;
  private undoers = new Map<number, () => void>();
  private entries: HistoryEntry[] = [{ id: 0, label: 'Open' }];
  private index = 0;
  private selectionRect: Rect | null = null;
  selectionOptions: SelectionOptions | null = null;
  shapeTool: ShapeType = 'rect';
  imported: { w: number; h: number; name: string; len: number }[] = [];
  private canvas: HTMLCanvasElement | null = null;
  // v4
  guideLists: Guides = { h: [], v: [] };
  mode: CanvasMode = 'input';
  snapOpts: SnapOptions = { enabled: true, guides: true, canvas: true, layers: false, threshold: 6 };
  replaced: { id: string; w: number; h: number; len: number }[] = [];
  baseSizes: { w: number; h: number }[] = [];
  canvasCalls: { w: number; h: number; anchor: Anchor }[] = [];

  constructor(width = 64, height = 48) {
    this.width = width;
    this.height = height;
    this.store = [{ id: 'base', name: 'TD Input 1', kind: 'input', visible: true, locked: true, opacity: 1, blend: 'normal', expanded: false, parent: null, colour: '#9cc3e4', slot: null, mask: null, adjustment: null, x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input: 1, effects: [], surfaceW: width, surfaceH: height }];
    this.active = 'base';
  }

  emit(e: EngineEvent) { for (const l of [...this.listeners]) l(e); }
  on(l: (e: EngineEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  private order(): FakeLayer[] {
    // top first; children after their (expanded) group; base last
    const out: FakeLayer[] = [];
    const walk = (parent: string | null) => {
      const kids = this.store.filter((l) => l.parent === parent).reverse();
      for (const l of kids) {
        out.push(l);
        if (l.kind === 'group' && l.expanded) walk(l.id);
      }
    };
    walk(null);
    return out;
  }
  private depth(l: FakeLayer): number { return l.parent ? 1 + this.depth(this.store.find((x) => x.id === l.parent)!) : 0; }

  layers(): LayerInfo[] {
    return this.order().map((l) => ({
      id: l.id, name: l.name, kind: l.kind, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend,
      depth: this.depth(l), expanded: l.kind === 'group' ? l.expanded : undefined, parentId: l.parent,
      slot: l.slot, mask: l.mask ? { ...l.mask } : null, adjustment: l.adjustment,
      text: l.text ?? null, shape: l.shape ?? null,
      transform: { x: l.x, y: l.y, sx: l.sx, sy: l.sy, rot: l.rot, kx: l.kx, ky: l.ky },
      input: l.input, inputConnected: l.kind === 'input' ? (this.inputState.get(l.input ?? 0)?.connected ?? true) : null,
      effects: l.effects.map((e) => ({ ...e })), surfaceW: l.surfaceW, surfaceH: l.surfaceH,
    }));
  }
  activeLayerId() { return this.active; }
  setActiveLayer(id: string) { this.active = id; this.calls.push(`setActive:${id}`); this.emit({ type: 'structure' }); }

  private add(kind: FakeLayer['kind'], name: string, adjustment: AdjustmentSpec | null = null, extra: Partial<FakeLayer> = {}): string {
    const id = `L${this.nextId++}`;
    const above = this.store.find((l) => l.id === this.active)!;
    const idx = this.store.indexOf(above) + 1;
    const slot = kind === 'pixel' ? this.nextSlot++ : null;
    this.store.splice(idx, 0, { id, name, kind, visible: true, locked: false, opacity: 1, blend: 'normal', expanded: true, parent: above.parent, colour: '#' + ((this.nextId * 5000011) & 0xffffff).toString(16).padStart(6, '0'), slot, mask: null, adjustment, x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input: null, effects: [], surfaceW: kind === 'pixel' ? this.width : null, surfaceH: kind === 'pixel' ? this.height : null, ...extra });
    this.active = id;
    this.push(kind === 'group' ? 'New group' : kind === 'adjustment' ? 'New adjustment' : 'New pixel layer');
    const prevActive = above.id;
    this.undoers.set(this.entries[this.index].id, () => {
      this.store = this.store.filter((x) => x.id !== id);
      this.active = this.store.some((x) => x.id === prevActive) ? prevActive : this.store[this.store.length - 1].id;
    });
    this.changed();
    return id;
  }
  /** structure + docspec, like the real engine for any stack change */
  changed() { this.rev++; this.emit({ type: 'structure' }); this.emit({ type: 'docspec' }); }
  addAdjustment(type: AdjustmentType) { this.calls.push(`addAdjustment:${type}`); return this.add('adjustment', type[0].toUpperCase() + type.slice(1), DEFAULT_ADJUSTMENTS[type]); }
  setAdjustment(id: string, spec: AdjustmentSpec) {
    this.store.find((x) => x.id === id)!.adjustment = spec;
    this.calls.push(`setAdjustment:${id}:${JSON.stringify(spec)}`);
    this.changed();
  }
  addMask(layerId: string) {
    const l = this.store.find((x) => x.id === layerId)!;
    const slot = this.nextSlot++;
    l.mask = { slot, enabled: true };
    this.calls.push(`addMask:${layerId}`);
    this.push('Add mask');
    this.changed();
    return slot;
  }
  deleteMask(layerId: string) {
    this.store.find((x) => x.id === layerId)!.mask = null;
    this.calls.push(`deleteMask:${layerId}`);
    this.changed();
  }
  setMaskEnabled(layerId: string, enabled: boolean) {
    const l = this.store.find((x) => x.id === layerId)!;
    if (l.mask) l.mask.enabled = enabled;
    this.calls.push(`maskEnabled:${layerId}:${enabled}`);
    this.changed();
  }
  setPaintTarget(layerId: string, target: PaintTarget) {
    this.active = layerId;
    this.target = { layerId, target };
    this.calls.push(`paintTarget:${layerId}:${target}`);
    this.changed();
  }
  paintTarget() { return this.target; }
  drawMaskThumbnail(id: string, target: HTMLCanvasElement) {
    const c = target.getContext('2d')!;
    c.fillStyle = '#dddddd';
    c.fillRect(0, 0, target.width, target.height);
    this.calls.push(`maskThumb:${id}`);
  }
  docSpec(): DocSpec {
    const layers: LayerSpec[] = [];
    const walk = (parent: string | null) => {
      for (const l of this.store.filter((x) => x.parent === parent)) {
        layers.push({
          id: l.id, kind: l.kind, parentId: l.parent, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
          x: l.x, y: l.y, sx: l.sx, sy: l.sy, rot: l.rot, kx: l.kx, ky: l.ky, input: l.input, effects: l.effects.map((e) => ({ ...e })), slot: l.slot, mask: l.mask ? { ...l.mask } : null, adjustment: l.adjustment,
          text: l.text ?? null, shape: l.shape ?? null, surfaceW: l.surfaceW, surfaceH: l.surfaceH,
        });
        if (l.kind === 'group') walk(l.id);
      }
    };
    walk(null);
    return { rev: this.rev, width: this.width, height: this.height, layers, guides: { h: [...this.guideLists.h], v: [...this.guideLists.v] }, canvas: { mode: this.mode }, brushPresets: this.presets.map((p) => JSON.parse(JSON.stringify(p)) as BrushPreset) };
  }
  surfaceSlots() { return this.store.flatMap((l) => [...(l.slot !== null ? [l.slot] : []), ...(l.mask ? [l.mask.slot] : [])]); }
  /** Surface size of a slot: its layer's surface; a mask has its layer's surface size; document size otherwise. */
  slotSize(slot: number): { w: number; h: number } {
    const l = this.store.find((x) => x.slot === slot || x.mask?.slot === slot);
    return { w: l?.surfaceW ?? this.width, h: l?.surfaceH ?? this.height };
  }
  /** Fills a slot with a deterministic pattern so tests can compare the bytes sent. */
  fillSurface(slot: number, rect: Rect, rgba: [number, number, number, number]) {
    const buf = this.surfaceBuf(slot), sw = this.slotSize(slot).w;
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) buf.set(rgba, (y * sw + x) * 4);
    this.emit({ type: 'surface', slot, rect });
  }
  private surfaceBuf(slot: number) {
    const { w, h } = this.slotSize(slot);
    let b = this.surfaces.get(slot);
    if (!b || b.length !== w * h * 4) { b = new Uint8ClampedArray(w * h * 4); this.surfaces.set(slot, b); }
    return b;
  }
  readSurface(slot: number, rect: Rect, out?: Uint8ClampedArray) {
    const n = rect.w * rect.h * 4, buf = out ?? new Uint8ClampedArray(n), src = this.surfaceBuf(slot), sw = this.slotSize(slot).w;
    for (let row = 0; row < rect.h; row++) buf.set(src.subarray(((rect.y + row) * sw + rect.x) * 4, ((rect.y + row) * sw + rect.x + rect.w) * 4), row * rect.w * 4);
    return buf;
  }
  loadDocument(spec: DocSpec) {
    this.loaded.push(spec);
    this.width = spec.width; this.height = spec.height; this.canvas = null;
    this.guideLists = { h: [...spec.guides.h], v: [...spec.guides.v] };
    this.mode = spec.canvas.mode;
    this.surfaces.clear();
    const kids = new Map<string, FakeLayer>();
    this.store = spec.layers.map((l) => {
      const f: FakeLayer = { id: l.id, name: l.name, kind: l.kind as FakeLayer['kind'], visible: l.visible, locked: l.kind === 'input', opacity: l.opacity, blend: l.blend, expanded: true, parent: l.parentId, colour: '#778899', slot: l.slot, mask: l.mask ? { ...l.mask } : null, adjustment: l.adjustment, text: l.text, shape: l.shape, x: l.x, y: l.y, sx: l.sx, sy: l.sy, rot: l.rot ?? 0, kx: l.kx ?? 0, ky: l.ky ?? 0, input: l.input ?? (l.kind === 'input' ? 1 : null), effects: (l.effects ?? []).map((e) => ({ ...e })), surfaceW: l.surfaceW, surfaceH: l.surfaceH };
      kids.set(l.id, f);
      return f;
    });
    this.nextSlot = Math.max(0, ...this.surfaceSlots()) + 1;
    this.active = this.store[this.store.length - 1]?.id ?? 'base';
    this.rev = spec.rev;
    this.presets = (spec.brushPresets ?? []).map((p) => JSON.parse(JSON.stringify(p)) as BrushPreset);
    this.entries = []; this.index = -1;
    this.calls.push('loadDocument');
    this.emit({ type: 'structure' }); this.emit({ type: 'docspec' }); this.emit({ type: 'history' });
  }
  writeSurface(slot: number, rect: Rect, rgba: Uint8Array | Uint8ClampedArray) {
    this.surfaceWrites.push({ slot, rect, len: rgba.length });
    const buf = this.surfaceBuf(slot), sw = this.slotSize(slot).w;
    for (let row = 0; row < rect.h; row++) buf.set(rgba.subarray(row * rect.w * 4, (row + 1) * rect.w * 4), ((rect.y + row) * sw + rect.x) * 4);
    this.emit({ type: 'surface', slot, rect });
  }
  commitSurfaces() { this.surfaceCommits++; }
  setPreviewEnabled(enabled: boolean) { this.previewEnabled = enabled; this.calls.push(`preview:${enabled}`); }
  addPixelLayer(name = `Layer ${this.nextId}`) { return this.add('pixel', name); }
  addGroup(name = `Group ${this.nextId}`) { return this.add('group', name); }
  deleteLayer(id: string) {
    const l = this.store.find((x) => x.id === id);
    if (!l) return;
    this.store = this.store.filter((x) => x.id !== id && x.parent !== id);
    if (this.active === id) this.active = this.store[this.store.length - 1]?.id ?? '';
    this.calls.push(`delete:${id}`);
    this.push('Delete layer');
    this.changed();
  }
  moveLayer(id: string, parent: string | null, index: number) {
    this.calls.push(`move:${id}:${parent}:${index}`);
    const l = this.store.find((x) => x.id === id)!;
    this.store = this.store.filter((x) => x !== l);
    l.parent = parent;
    const sibs = this.store.filter((x) => x.parent === parent); // bottom-first
    const topFirst = [...sibs].reverse();
    const before = topFirst[index]; // layer that should end up directly below
    const at = before ? this.store.indexOf(before) + 1 : sibs.length ? this.store.indexOf(sibs[0]) : this.store.length;
    this.store.splice(at, 0, l);
    this.push('Move layer');
    this.changed();
  }
  setLayerProps(id: string, props: Partial<Pick<LayerInfo, 'name' | 'visible' | 'locked' | 'opacity' | 'blend' | 'expanded'>>) {
    Object.assign(this.store.find((x) => x.id === id)!, props);
    this.calls.push(`props:${id}:${JSON.stringify(props)}`);
    this.changed();
  }
  flattenToNewLayer() { return this.add('pixel', 'Flattened'); }

  drawThumbnail(id: string, target: HTMLCanvasElement) {
    const c = target.getContext('2d')!;
    c.fillStyle = this.store.find((x) => x.id === id)?.colour || '#888';
    c.fillRect(0, 0, target.width, target.height);
    this.calls.push(`thumb:${id}`);
  }

  writeBase(rect: Rect, rgba: Uint8Array | Uint8ClampedArray) { this.baseWrites.push({ rect, len: rgba.length }); }
  /** Not in the v4 contract (needs report): resize the base (TD Input) surface when the input resolution changes. */
  setBaseSize(w: number, h: number) {
    this.baseSizes.push({ w, h });
    const b = this.store.find((x) => x.kind === 'input')!;
    b.surfaceW = w; b.surfaceH = h;
    this.changed();
  }
  commitBase() { this.commits++; }
  readComposite(rect: Rect, out?: Uint8ClampedArray) {
    const n = rect.w * rect.h * 4;
    const buf = out ?? new Uint8ClampedArray(n);
    for (let i = 0; i < n; i += 4) { buf[i] = 10; buf[i + 1] = 20; buf[i + 2] = 30; buf[i + 3] = 255; }
    return buf;
  }
  compositeSource(): CanvasImageSource {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      const c = this.canvas.getContext('2d')!;
      c.fillStyle = '#336699';
      c.fillRect(0, 0, this.width, this.height);
    }
    return this.canvas;
  }

  selection() { return this.selectionRect; }
  setSelection(r: Rect | null) { this.selectionRect = r; this.emit({ type: 'selection' }); }

  // v3
  setSelectionOptions(o: SelectionOptions) { this.selectionOptions = o; this.calls.push(`selOpts:${JSON.stringify(o)}`); }
  selectionMask() {
    const r = this.selectionRect;
    if (!r) return null;
    const alpha = new Uint8Array(this.width * this.height);
    for (let y = r.y; y < r.y + r.h; y++) alpha.fill(255, y * this.width + r.x, y * this.width + r.x + r.w);
    return { rect: r, alpha };
  }
  selectionPath() {
    const r = this.selectionRect;
    return r ? [[{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]] : [];
  }
  selectAll() { this.calls.push('selectAll'); this.setSelection({ x: 0, y: 0, w: this.width, h: this.height }); }
  deselect() { this.calls.push('deselect'); this.setSelection(null); }
  invertSelection() { this.calls.push('invertSelection'); this.emit({ type: 'selection' }); }
  maskFromSelection(layerId: string) { this.calls.push(`maskFromSelection:${layerId}`); if (!this.store.find((x) => x.id === layerId)?.mask) this.addMask(layerId); }
  private addSpecLayer(kind: 'text' | 'shape', name: string, text: TextSpec | null, shape: ShapeSpec | null): string {
    return this.add(kind, name, null, { text, shape });
  }
  addTextLayer(spec: TextSpec) { this.calls.push(`addText:${JSON.stringify(spec)}`); return this.addSpecLayer('text', spec.text || 'Text', spec, null); }
  addShapeLayer(spec: ShapeSpec) { this.calls.push(`addShape:${JSON.stringify(spec)}`); return this.addSpecLayer('shape', spec.type, null, spec); }
  setText(id: string, spec: TextSpec) {
    const l = this.store.find((x) => x.id === id)!;
    l.text = spec;
    if (l.name === 'Text' || l.name === l.text?.text) l.name = spec.text || 'Text';
    this.calls.push(`setText:${id}:${JSON.stringify(spec)}`);
    this.changed();
  }
  setShape(id: string, spec: ShapeSpec) { this.store.find((x) => x.id === id)!.shape = spec; this.calls.push(`setShape:${id}:${JSON.stringify(spec)}`); this.changed(); }
  /** v4: text/shape → pixel layer from TD's pixels (doc-space at 0,0). */
  replaceWithPixels(id: string, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number) {
    const l = this.store.find((x) => x.id === id)!;
    l.kind = 'pixel'; l.text = null; l.shape = null; l.slot = this.nextSlot++;
    l.surfaceW = w; l.surfaceH = h; l.x = 0; l.y = 0; l.sx = 1; l.sy = 1;
    this.surfaces.set(l.slot, new Uint8ClampedArray(rgba));
    this.replaced.push({ id, w, h, len: rgba.length });
    this.calls.push(`replaceWithPixels:${id}:${w}x${h}`);
    this.push('Flatten layer');
    this.changed();
  }
  renderer: 'sdf' | 'canvas' = 'sdf';
  setShapeRenderer(mode: 'sdf' | 'canvas') { this.renderer = mode; this.calls.push(`shapeRenderer:${mode}`); }
  shapeRenderer() { return this.renderer; }
  setShapeTool(type: ShapeType) { this.shapeTool = type; this.calls.push(`shapeTool:${type}`); }
  /** Rough hit test: the text box is `size * 0.6` px per character wide and `size * lineHeight` per line tall. */
  textLayerAt(x: number, y: number) {
    for (const l of this.order()) {
      const t = l.text;
      if (l.kind !== 'text' || !t) continue;
      const lines = t.text.split('\n');
      const w = Math.max(...lines.map((s) => s.length), 1) * t.size * 0.6, h = lines.length * t.size * t.lineHeight;
      if (x >= t.x && x <= t.x + w && y >= t.y && y <= t.y + h) return l.id;
    }
    return null;
  }
  importImage(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, name: string) {
    this.imported.push({ w, h, name, len: rgba.length });
    this.calls.push(`importImage:${name}:${w}x${h}`);
    return this.add('pixel', name, null, { surfaceW: w, surfaceH: h });
  }

  setTool(id: ToolId) { this.tool = id; this.calls.push(`tool:${id}`); }
  setToolContext(c: ToolContext) { this.context = c; }
  pointerDown(p: ToolPointer) { this.pointers.push({ kind: 'down', p }); }
  pointerMove(p: ToolPointer) { this.pointers.push({ kind: 'move', p }); }
  pointerUp(p: ToolPointer) { this.pointers.push({ kind: 'up', p }); this.push(this.tool); }

  private push(label: string) {
    this.entries = [...this.entries.slice(0, this.index + 1), { id: this.entries.length, label }];
    this.index = this.entries.length - 1;
    this.emit({ type: 'history' });
  }
  undo() {
    this.calls.push('undo');
    if (this.index > 0) {
      this.undoers.get(this.entries[this.index].id)?.();
      this.index--;
      this.emit({ type: 'history' });
      this.changed();
    }
  }
  redo() { this.calls.push('redo'); if (this.index < this.entries.length - 1) { this.index++; this.emit({ type: 'history' }); } }
  history() { return { entries: this.entries, index: this.index }; }
  jumpTo(i: number) { this.calls.push(`jump:${i}`); this.index = i; this.emit({ type: 'history' }); }

  clearHistory() { this.calls.push('clearHistory'); this.entries = []; this.index = -1; this.emit({ type: 'history' }); }
  listenerCount() { return this.listeners.size; }

  resize(w: number, h: number) {
    this.width = w; this.height = h; this.canvas = null;
    this.calls.push(`resize:${w}x${h}`);
    this.emit({ type: 'resize', width: w, height: h });
    this.rev++; this.emit({ type: 'docspec' });
  }

  // ---- v4: transforms, canvas, guides, snapping ----
  setTransform(id: string, t: LayerTransform) {
    const l = this.store.find((x) => x.id === id)!;
    l.x = t.x; l.y = t.y; l.sx = t.sx; l.sy = t.sy; l.rot = t.rot; l.kx = t.kx; l.ky = t.ky;
    this.calls.push(`setTransform:${id}:${JSON.stringify(t)}`);
    this.push('Transform');
    this.changed();
  }
  applyTransform(id: string) {
    const l = this.store.find((x) => x.id === id)!;
    l.surfaceW = Math.round((l.surfaceW ?? 0) * l.sx); l.surfaceH = Math.round((l.surfaceH ?? 0) * l.sy);
    l.sx = 1; l.sy = 1; l.rot = 0; l.kx = 0; l.ky = 0;
    this.calls.push(`applyTransform:${id}`);
    this.push('Apply transform');
    this.changed();
  }
  layerBounds(id: string): Rect | null {
    const l = this.store.find((x) => x.id === id);
    if (!l) return null;
    if (l.kind === 'pixel' || l.kind === 'input') return { x: l.x, y: l.y, w: (l.surfaceW ?? this.width) * l.sx, h: (l.surfaceH ?? this.height) * l.sy };
    if (l.kind === 'text' && l.text) {
      const t = l.text, lines = t.text.split('\n');
      return { x: t.x, y: t.y, w: Math.max(...lines.map((q) => q.length), 1) * t.size * 0.6, h: lines.length * t.size * t.lineHeight };
    }
    const sp = l.shape;
    if (l.kind === 'shape' && sp) {
      if (sp.type === 'rect' || sp.type === 'ellipse') return { x: sp.x, y: sp.y, w: sp.w, h: sp.h };
      if (sp.type === 'line') return { x: Math.min(sp.x1, sp.x2), y: Math.min(sp.y1, sp.y2), w: Math.abs(sp.x2 - sp.x1), h: Math.abs(sp.y2 - sp.y1) };
      return { x: sp.cx - sp.radius, y: sp.cy - sp.radius, w: sp.radius * 2, h: sp.radius * 2 };
    }
    return null;
  }
  setCanvasSize(w: number, h: number, anchor: Anchor) {
    this.canvasCalls.push({ w, h, anchor });
    const ax = anchor.includes('l') ? 0 : anchor.includes('r') ? 1 : 0.5, ay = anchor.startsWith('t') ? 0 : anchor.startsWith('b') ? 1 : 0.5;
    const dx = (w - this.width) * ax, dy = (h - this.height) * ay;
    const prev = { w: this.width, h: this.height, mode: this.mode };
    this.canvasUndo(prev, dx, dy);
    for (const l of this.store) if (l.kind === 'pixel' || l.kind === 'input') { l.x += dx; l.y += dy; }
    this.width = w; this.height = h; this.canvas = null; this.mode = 'fixed';
    this.calls.push(`setCanvasSize:${w}x${h}:${anchor}`);
    this.push('Canvas size');
    this.registerCanvasUndo();
    this.emit({ type: 'resize', width: w, height: h });
    this.changed();
  }
  private pendingCanvasUndo: (() => void) | null = null;
  private canvasUndo(prev: { w: number; h: number; mode: CanvasMode }, dx: number, dy: number) {
    this.pendingCanvasUndo = () => {
      for (const l of this.store) if (l.kind === 'pixel' || l.kind === 'input') { l.x -= dx; l.y -= dy; }
      this.width = prev.w; this.height = prev.h; this.mode = prev.mode; this.canvas = null;
      this.emit({ type: 'resize', width: prev.w, height: prev.h });
    };
  }
  private registerCanvasUndo() { if (this.pendingCanvasUndo) this.undoers.set(this.entries[this.index].id, this.pendingCanvasUndo); this.pendingCanvasUndo = null; }
  /** v4 optional engine API: fit the layer's box to `box` (pixel/base → transform, text/shape → geometry). Set to undefined to test the UI's fallback. */
  setLayerBox: ((id: string, box: Rect) => void) | undefined = (id, box) => {
    const l = this.store.find((x) => x.id === id)!, from = this.layerBounds(id);
    if (!from) return;
    this.calls.push(`setLayerBox:${id}:${JSON.stringify(box)}`);
    if (l.kind === 'text' && l.text) this.setText(id, remapText(l.text, from, box));
    else if (l.kind === 'shape' && l.shape) this.setShape(id, remapShape(l.shape, from, box));
    else this.setTransform(id, transformFor({ x: l.x, y: l.y, sx: l.sx, sy: l.sy, rot: l.rot, kx: l.kx, ky: l.ky }, from, box));
  };
  adoptCanvas(w: number, h: number, mode: CanvasMode) {
    this.width = w; this.height = h; this.canvas = null; this.mode = mode;
    this.calls.push(`adoptCanvas:${w}x${h}:${mode}`);
    this.emit({ type: 'resize', width: w, height: h });
    this.changed();
  }
  viewZoom = 1;
  setViewZoom(z: number) { this.viewZoom = z; }
  setCanvasMode(mode: CanvasMode) {
    const prev = this.mode;
    this.mode = mode;
    this.calls.push(`setCanvasMode:${mode}`);
    this.push('Canvas mode');
    this.undoers.set(this.entries[this.index].id, () => { this.mode = prev; });
    this.changed();
  }
  canvasMode() { return this.mode; }
  guides(): Guides { return { h: [...this.guideLists.h], v: [...this.guideLists.v] }; }
  addGuide(axis: 'h' | 'v', pos: number) { this.guideLists[axis].push(pos); this.calls.push(`addGuide:${axis}:${pos}`); this.push('Add guide'); this.changed(); }
  moveGuide(axis: 'h' | 'v', index: number, pos: number) { this.guideLists[axis][index] = pos; this.calls.push(`moveGuide:${axis}:${index}:${pos}`); this.push('Move guide'); this.changed(); }
  removeGuide(axis: 'h' | 'v', index: number) { this.guideLists[axis].splice(index, 1); this.calls.push(`removeGuide:${axis}:${index}`); this.push('Remove guide'); this.changed(); }
  setSnap(opts: SnapOptions) { this.snapOpts = opts; this.calls.push(`setSnap:${JSON.stringify(opts)}`); }
  /** Snap lines (doc px) in one axis: guides, canvas edges / centre, other layers' edges when enabled. */
  private snapLines(axis: 'x' | 'y'): number[] {
    const o = this.snapOpts, out: number[] = [];
    if (o.guides) out.push(...(axis === 'x' ? this.guideLists.v : this.guideLists.h));
    if (o.canvas) { const n = axis === 'x' ? this.width : this.height; out.push(0, n / 2, n); }
    return out;
  }
  private nearest(v: number, lines: number[], tol: number): number | null {
    let best: number | null = null;
    for (const l of lines) if (Math.abs(l - v) <= tol && (best === null || Math.abs(l - v) < Math.abs(best - v))) best = l;
    return best;
  }
  snapPoint(x: number, y: number, zoom: number) {
    this.calls.push('snapPoint');
    if (!this.snapOpts.enabled) return { x, y, guideX: null, guideY: null };
    const tol = this.snapOpts.threshold / zoom;
    const gx = this.nearest(x, this.snapLines('x'), tol), gy = this.nearest(y, this.snapLines('y'), tol);
    return { x: gx ?? x, y: gy ?? y, guideX: gx, guideY: gy };
  }
  snapRect(r: Rect, zoom: number) {
    this.calls.push('snapRect');
    if (!this.snapOpts.enabled) return { dx: 0, dy: 0, guideX: null, guideY: null };
    const tol = this.snapOpts.threshold / zoom;
    const best = (vals: number[], lines: number[]) => {
      let d: number | null = null, g: number | null = null;
      for (const v of vals) for (const l of lines) if (Math.abs(l - v) <= tol && (d === null || Math.abs(l - v) < Math.abs(d))) { d = l - v; g = l; }
      return { d: d ?? 0, g };
    };
    const bx = best([r.x, r.x + r.w / 2, r.x + r.w], this.snapLines('x')), by = best([r.y, r.y + r.h / 2, r.y + r.h], this.snapLines('y'));
    return { dx: bx.d, dy: by.d, guideX: bx.g, guideY: by.g };
  }

  // ---- v5: retouch tools, crop, floating selection, quick mask, selection ops, effects, inputs ----
  cloneOpts: CloneOptions = { aligned: true, sampleAll: false };
  retouchOpts: { strength: number; sharpen: boolean; burn: boolean; range: DodgeBurnRange; exposure: number } = { strength: 0.5, sharpen: false, burn: false, range: 'midtones', exposure: 0.5 };
  cropped: Rect[] = [];
  floatingState: { bounds: Rect; transform: LayerTransform } | null = null;
  quickMaskOn = false;
  inputState = new Map<number, { w: number; h: number; connected: boolean }>([[1, { w: 0, h: 0, connected: true }]]);
  inputWrites: { input: number; rect: Rect; len: number }[] = [];
  inputCommits: number[] = [];
  liftable = true;
  setCloneOptions(o: CloneOptions) { this.cloneOpts = o; this.calls.push(`cloneOptions:${JSON.stringify(o)}`); }
  setRetouchOptions(o: FakeEngine['retouchOpts']) { this.retouchOpts = o; this.calls.push(`retouchOptions:${JSON.stringify(o)}`); }
  cropTo(rect: Rect) {
    this.cropped.push(rect);
    this.calls.push(`cropTo:${JSON.stringify(rect)}`);
    this.width = rect.w; this.height = rect.h; this.canvas = null;
    this.push('Crop');
    this.emit({ type: 'resize', width: rect.w, height: rect.h });
    this.changed();
  }
  liftSelection() {
    this.calls.push('liftSelection');
    const r = this.selectionRect;
    if (!r || !this.liftable) return false;
    this.floatingState = { bounds: { ...r }, transform: { x: r.x, y: r.y, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 } };
    this.emit({ type: 'selection' });
    return true;
  }
  floating() { return this.floatingState ? { bounds: { ...this.floatingState.bounds }, transform: { ...this.floatingState.transform } } : null; }
  floatingSize() { return this.floatingState ? { w: this.floatingState.bounds.w, h: this.floatingState.bounds.h } : null; }
  setFloatingTransform(t: LayerTransform) {
    if (!this.floatingState) return;
    this.floatingState.transform = { ...t };
    this.calls.push(`setFloatingTransform:${JSON.stringify(t)}`);
    this.emit({ type: 'selection' });
  }
  commitFloating() { this.calls.push('commitFloating'); if (this.floatingState) { this.floatingState = null; this.push('Transform selection'); this.emit({ type: 'selection' }); this.changed(); } }
  cancelFloating() { this.calls.push('cancelFloating'); this.floatingState = null; this.emit({ type: 'selection' }); }
  setQuickMask(on: boolean) { this.quickMaskOn = on; this.calls.push(`quickMask:${on}`); this.emit({ type: 'selection' }); }
  quickMask() { return this.quickMaskOn; }
  modifySelection(op: 'grow' | 'shrink' | 'smooth' | 'feather' | 'border', px: number) {
    this.calls.push(`modifySelection:${op}:${px}`);
    const r = this.selectionRect;
    if (r && (op === 'grow' || op === 'shrink')) {
      const d = op === 'grow' ? px : -px;
      this.selectionRect = { x: r.x - d, y: r.y - d, w: Math.max(0, r.w + 2 * d), h: Math.max(0, r.h + 2 * d) };
    }
    this.push(`Selection ${op}`);
    this.emit({ type: 'selection' });
  }
  setEffects(id: string, effects: Effect[]) {
    this.store.find((x) => x.id === id)!.effects = effects.map((e) => ({ ...e }));
    this.calls.push(`setEffects:${id}:${JSON.stringify(effects)}`);
    this.push('Layer effects');
    this.changed();
  }
  setInputs(items: Array<{ input: number; w: number; h: number; connected: boolean }>) {
    this.calls.push(`setInputs:${JSON.stringify(items)}`);
    this.inputState = new Map(items.map((i) => [i.input, { w: i.w, h: i.h, connected: i.connected }]));
    for (const it of items) {
      if (it.connected && !this.store.some((l) => l.kind === 'input' && l.input === it.input)) {
        this.store.unshift({ id: `in${it.input}`, name: `TD Input ${it.input}`, kind: 'input', visible: true, locked: true, opacity: 1, blend: 'normal', expanded: false, parent: null, colour: '#9cc3e4', slot: null, mask: null, adjustment: null, x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input: it.input, effects: [], surfaceW: it.w, surfaceH: it.h });
      }
      const l = this.store.find((x) => x.kind === 'input' && x.input === it.input);
      if (l && it.connected) { l.surfaceW = it.w; l.surfaceH = it.h; }
    }
    this.changed();
  }
  addInputLayer(input: number) {
    this.calls.push(`addInputLayer:${input}`);
    const id = `in${input}`;
    const st = this.inputState.get(input) ?? { w: this.width, h: this.height, connected: true };
    this.store.push({ id, name: `TD Input ${input}`, kind: 'input', visible: true, locked: true, opacity: 1, blend: 'normal', expanded: false, parent: null, colour: '#9cc3e4', slot: null, mask: null, adjustment: null, x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input, effects: [], surfaceW: st.w || this.width, surfaceH: st.h || this.height });
    this.push('Add input layer');
    this.changed();
    return id;
  }
  writeInput(input: number, rect: Rect, rgba: Uint8Array | Uint8ClampedArray) { this.inputWrites.push({ input, rect, len: rgba.length }); }
  commitInput(input: number) { this.inputCommits.push(input); }

  // ---- v6 (phase B): brushes, history persistence, tdPreview layers ----
  tip: TipShape = 'round';
  dynamics: BrushDynamics | null = null;
  customTip: { w: number; h: number; alpha: Uint8Array } | null = null;
  /** What tipFromSelection() answers (null = no selection). */
  selectionTip: { w: number; h: number; alpha: Uint8Array } | null = { w: 4, h: 4, alpha: new Uint8Array(16).fill(255) };
  presets: BrushPreset[] = [];
  /** Effect / filter types that need TD's render (tdPreviewLayers()). */
  previewTypes = new Set<string>();
  /** Layer ids that always need TD's render (tests that do not care which filter causes it). */
  previewIds = new Set<string>();
  /** historyVersion() answer (null = the engine has none: the method is absent). */
  historyVer: number | null = null;
  /** Make serializeHistory throw. */
  serializeFails = false;
  layerPreviews = new Map<string, Uint8Array | null>();
  /** serializeHistory / restoreHistory bookkeeping. */
  serialized: { maxSteps: number; maxBytes: number }[] = [];
  restored: { rev: number; len: number }[] = [];
  /** Make restoreHistory refuse (corrupt blob) or throw. */
  restoreResult: 'ok' | 'refuse' | 'throw' = 'ok';
  setBrushTip(tip: TipShape, dynamics: BrushDynamics, customTip?: { w: number; h: number; alpha: Uint8Array }) {
    this.tip = tip; this.dynamics = { ...dynamics }; this.customTip = customTip ?? null;
    this.calls.push(`setBrushTip:${tip}:${JSON.stringify(dynamics)}${customTip ? `:custom${customTip.w}x${customTip.h}` : ''}`);
  }
  tipFromSelection() { return this.selectionTip; }
  brushPresets(): BrushPreset[] { return this.presets.map((p) => JSON.parse(JSON.stringify(p)) as BrushPreset); }
  setBrushPresets(presets: BrushPreset[]) {
    this.presets = presets.map((p) => JSON.parse(JSON.stringify(p)) as BrushPreset);
    this.calls.push(`setBrushPresets:${presets.length}`);
    this.rev++;
    this.emit({ type: 'docspec' });
  }
  /** Versioned blob: magic "FHST", u8 version, then JSON {rev, entries, index}. */
  serializeHistory(maxSteps: number, maxBytes: number): Uint8Array {
    this.serialized.push({ maxSteps, maxBytes });
    if (this.serializeFails) throw new Error('cannot serialise');
    const body = new TextEncoder().encode(JSON.stringify({ rev: this.rev, entries: this.entries.slice(-maxSteps), index: this.index }));
    const out = new Uint8Array(5 + body.length);
    out.set([0x46, 0x48, 0x53, 0x54, 1], 0);
    out.set(body, 5);
    return out;
  }
  restoreHistory(blob: Uint8Array, rev: number): boolean {
    this.restored.push({ rev, len: blob.length });
    this.calls.push(`restoreHistory:${rev}`);
    if (this.restoreResult === 'throw') throw new Error('corrupt history');
    if (this.restoreResult === 'refuse' || rev !== this.rev || blob.length < 5 || blob[0] !== 0x46 || blob[4] !== 1) return false;
    try {
      const j = JSON.parse(new TextDecoder().decode(blob.subarray(5))) as { entries: HistoryEntry[]; index: number };
      this.entries = j.entries; this.index = j.index;
    } catch { return false; }
    this.emit({ type: 'history' });
    return true;
  }
  /** v6: single-call creation (a test can delete the method to exercise the add + set + rename fallback). */
  addFilterAdjustment(effect: Effect, name?: string): string {
    this.calls.push(`addFilterAdjustment:${effect.type}`);
    const id = this.add('adjustment', name ?? 'Filter', { type: 'filter', effect: JSON.parse(JSON.stringify(effect)) as Effect });
    this.changed();
    return id;
  }
  historyVersion(): number { return this.historyVer ?? this.entries.length * 1000 + this.index; }
  tdPreviewLayers(): string[] {
    const hit = (e: Effect) => this.previewTypes.has(e.type);
    return this.store.filter((l) => this.previewIds.has(l.id) || l.effects.some(hit) || (l.adjustment?.type === 'filter' && hit(l.adjustment.effect))).map((l) => l.id);
  }
  setLayerPreview(layerId: string, rgba: Uint8Array | Uint8ClampedArray | null) {
    this.layerPreviews.set(layerId, rgba ? new Uint8Array(rgba) : null);
    this.calls.push(`setLayerPreview:${layerId}:${rgba ? rgba.length : 'null'}`);
  }

  // ---- v7: unified adjustments, batch layer ops, merge (docs/DESIGN_V7.md) ----
  replacedMany: { ids: string[]; id: string; w: number; h: number; len: number }[] = [];
  /** Run a stack change as one history entry whose undo restores the previous layer list and active layer. */
  private structural(label: string, fn: () => void) {
    const snap = this.store.map((l) => ({ ...l, effects: l.effects.map((e) => ({ ...e })), mask: l.mask ? { ...l.mask } : null }));
    const active = this.active;
    fn();
    this.push(label);
    this.undoers.set(this.entries[this.index].id, () => { this.store = snap; this.active = active; });
    this.changed();
  }
  private subtree(ids: string[]): Set<string> {
    const out = new Set(ids);
    for (let grew = true; grew;) { grew = false; for (const l of this.store) if (l.parent && out.has(l.parent) && !out.has(l.id)) { out.add(l.id); grew = true; } }
    return out;
  }
  addAdjustmentLayer(effects: Effect[], name?: string): string {
    this.calls.push(`addAdjustmentLayer:${effects.map((e) => e.type).join(',')}`);
    return this.add('adjustment', name ?? 'Adjustment', null, { effects: effects.map((e) => JSON.parse(JSON.stringify(e)) as Effect) });
  }
  deleteLayers(ids: string[]) {
    this.calls.push(`deleteLayers:${ids.join(',')}`);
    const gone = this.subtree(ids);
    this.structural('Delete layers', () => {
      const keep = this.store.filter((l) => !gone.has(l.id));
      if (gone.has(this.active)) this.active = keep[keep.length - 1]?.id ?? '';
      this.store = keep;
    });
  }
  setLayersProps(ids: string[], props: Partial<Pick<LayerInfo, 'visible' | 'locked'>>) {
    this.calls.push(`setLayersProps:${ids.join(',')}:${JSON.stringify(props)}`);
    this.structural('Layer properties', () => { for (const l of this.store) if (ids.includes(l.id)) Object.assign(l, props); });
  }
  moveLayers(ids: string[], parent: string | null, index: number) {
    this.calls.push(`moveLayers:${ids.join(',')}:${parent}:${index}`);
    this.structural('Move layers', () => {
      const moved = this.store.filter((l) => ids.includes(l.id));
      this.store = this.store.filter((l) => !ids.includes(l.id));
      for (const l of moved) l.parent = parent;
      const sibs = this.store.filter((x) => x.parent === parent);
      const below = [...sibs].reverse()[index];
      const at = below ? this.store.indexOf(below) + 1 : sibs.length ? this.store.indexOf(sibs[0]) : this.store.length;
      this.store.splice(at, 0, ...moved);
    });
  }
  groupLayers(ids: string[], name?: string): string {
    this.calls.push(`groupLayers:${ids.join(',')}`);
    const id = `L${this.nextId++}`;
    this.structural('Group layers', () => {
      const members = this.store.filter((l) => ids.includes(l.id));
      const top = members[members.length - 1];
      const g: FakeLayer = { id, name: name ?? `Group ${this.nextId}`, kind: 'group', visible: true, locked: false, opacity: 1, blend: 'normal', expanded: true, parent: top.parent, colour: '#777777', slot: null, mask: null, adjustment: null, x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input: null, effects: [], surfaceW: null, surfaceH: null };
      this.store.splice(this.store.indexOf(top) + 1, 0, g);
      for (const m of members) m.parent = id;
      this.active = id;
    });
    return id;
  }
  replaceLayersWithPixels(ids: string[], rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, name?: string): string {
    this.calls.push(`replaceLayersWithPixels:${ids.join(',')}:${w}x${h}`);
    const id = `L${this.nextId++}`;
    this.structural('Merge layers', () => {
      const gone = this.subtree(ids);
      const top = [...this.store].reverse().find((l) => ids.includes(l.id))!;
      const slot = this.nextSlot++;
      this.surfaces.set(slot, new Uint8ClampedArray(rgba));
      const n: FakeLayer = { id, name: name ?? 'Merged', kind: 'pixel', visible: true, locked: false, opacity: 1, blend: 'normal', expanded: true, parent: top.parent, colour: '#aa7744', slot, mask: null, adjustment: null, x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input: null, effects: [], surfaceW: w, surfaceH: h };
      this.store.splice(this.store.indexOf(top) + 1, 0, n);
      this.store = this.store.filter((l) => !gone.has(l.id));
      this.active = id;
    });
    this.replacedMany.push({ ids: [...ids], id, w, h, len: rgba.length });
    return id;
  }
  dispose() { this.listeners.clear(); }
}
