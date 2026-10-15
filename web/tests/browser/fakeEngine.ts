import type {
  AdjustmentSpec, AdjustmentType, BlendMode, DocSpec, EditorEngine, EngineEvent, HistoryEntry, LayerInfo, LayerSpec, PaintTarget, Rect,
  SelectionOptions, ShapeSpec, ShapeType, TextSpec, ToolContext, ToolId, ToolPointer,
} from '../../src/engine/types';

interface FakeLayer {
  id: string; name: string; kind: 'pixel' | 'group' | 'base' | 'adjustment' | 'text' | 'shape'; visible: boolean; locked: boolean;
  opacity: number; blend: BlendMode; expanded: boolean; parent: string | null; colour: string;
  slot: number | null; mask: { slot: number; enabled: boolean } | null; adjustment: AdjustmentSpec | null;
  text?: TextSpec | null; shape?: ShapeSpec | null; rasterize?: boolean;
}

export const DEFAULT_ADJUSTMENTS: Record<AdjustmentType, AdjustmentSpec> = {
  levels: { type: 'levels', inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 },
  brightnessContrast: { type: 'brightnessContrast', brightness: 0, contrast: 0 },
  hueSaturation: { type: 'hueSaturation', hue: 0, saturation: 1, value: 1 },
  blur: { type: 'blur', radius: 8 },
  invert: { type: 'invert' },
  threshold: { type: 'threshold', level: 0.5 },
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

  constructor(width = 64, height = 48) {
    this.width = width;
    this.height = height;
    this.store = [{ id: 'base', name: 'TD Input', kind: 'base', visible: true, locked: true, opacity: 1, blend: 'normal', expanded: false, parent: null, colour: '#9cc3e4', slot: null, mask: null, adjustment: null }];
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
      text: l.text ?? null, shape: l.shape ?? null, rasterize: l.rasterize ?? false,
    }));
  }
  activeLayerId() { return this.active; }
  setActiveLayer(id: string) { this.active = id; this.calls.push(`setActive:${id}`); this.emit({ type: 'structure' }); }

  private add(kind: FakeLayer['kind'], name: string, adjustment: AdjustmentSpec | null = null, extra: Partial<FakeLayer> = {}): string {
    const id = `L${this.nextId++}`;
    const above = this.store.find((l) => l.id === this.active)!;
    const idx = this.store.indexOf(above) + 1;
    const slot = kind === 'pixel' ? this.nextSlot++ : null;
    this.store.splice(idx, 0, { id, name, kind, visible: true, locked: false, opacity: 1, blend: 'normal', expanded: true, parent: above.parent, colour: '#' + ((this.nextId * 5000011) & 0xffffff).toString(16).padStart(6, '0'), slot, mask: null, adjustment, ...extra });
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
          x: 0, y: 0, slot: l.slot, mask: l.mask ? { ...l.mask } : null, adjustment: l.adjustment,
          text: l.text ?? null, shape: l.shape ?? null, rasterize: l.rasterize ?? false,
        });
        if (l.kind === 'group') walk(l.id);
      }
    };
    walk(null);
    return { rev: this.rev, width: this.width, height: this.height, layers };
  }
  surfaceSlots() { return this.store.flatMap((l) => [...(l.slot !== null ? [l.slot] : []), ...(l.mask ? [l.mask.slot] : [])]); }
  /** Fills a slot with a deterministic pattern so tests can compare the bytes sent. */
  fillSurface(slot: number, rect: Rect, rgba: [number, number, number, number]) {
    const buf = this.surfaceBuf(slot);
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) buf.set(rgba, (y * this.width + x) * 4);
    this.emit({ type: 'surface', slot, rect });
  }
  private surfaceBuf(slot: number) {
    let b = this.surfaces.get(slot);
    if (!b || b.length !== this.width * this.height * 4) { b = new Uint8ClampedArray(this.width * this.height * 4); this.surfaces.set(slot, b); }
    return b;
  }
  readSurface(slot: number, rect: Rect, out?: Uint8ClampedArray) {
    const n = rect.w * rect.h * 4, buf = out ?? new Uint8ClampedArray(n), src = this.surfaceBuf(slot);
    for (let row = 0; row < rect.h; row++) buf.set(src.subarray(((rect.y + row) * this.width + rect.x) * 4, ((rect.y + row) * this.width + rect.x + rect.w) * 4), row * rect.w * 4);
    return buf;
  }
  loadDocument(spec: DocSpec) {
    this.loaded.push(spec);
    this.width = spec.width; this.height = spec.height; this.canvas = null;
    this.surfaces.clear();
    const kids = new Map<string, FakeLayer>();
    this.store = spec.layers.map((l) => {
      const f: FakeLayer = { id: l.id, name: l.name, kind: l.kind as FakeLayer['kind'], visible: l.visible, locked: l.kind === 'base', opacity: l.opacity, blend: l.blend, expanded: true, parent: l.parentId, colour: '#778899', slot: l.slot, mask: l.mask ? { ...l.mask } : null, adjustment: l.adjustment, text: l.text, shape: l.shape, rasterize: l.rasterize };
      kids.set(l.id, f);
      return f;
    });
    this.nextSlot = Math.max(0, ...this.surfaceSlots()) + 1;
    this.active = this.store[this.store.length - 1]?.id ?? 'base';
    this.rev = spec.rev;
    this.entries = []; this.index = -1;
    this.calls.push('loadDocument');
    this.emit({ type: 'structure' }); this.emit({ type: 'docspec' }); this.emit({ type: 'history' });
  }
  writeSurface(slot: number, rect: Rect, rgba: Uint8Array | Uint8ClampedArray) {
    this.surfaceWrites.push({ slot, rect, len: rgba.length });
    const buf = this.surfaceBuf(slot);
    for (let row = 0; row < rect.h; row++) buf.set(rgba.subarray(row * rect.w * 4, (row + 1) * rect.w * 4), ((rect.y + row) * this.width + rect.x) * 4);
    this.emit({ type: 'surface', slot, rect });
  }
  commitSurfaces() { this.surfaceCommits++; }
  setPreviewEnabled(enabled: boolean) { this.previewEnabled = enabled; this.calls.push(`preview:${enabled}`); }
  addPixelLayer(name = `Layer ${this.nextId}`) { return this.add('pixel', name); }
  addGroup(name = `Group ${this.nextId}`) { return this.add('group', name); }
  deleteLayer(id: string) {
    const l = this.store.find((x) => x.id === id);
    if (!l || l.kind === 'base') return;
    this.store = this.store.filter((x) => x.id !== id && x.parent !== id);
    if (this.active === id) this.active = this.store[this.store.length - 1].id;
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
    return this.add(kind, name, null, { text, shape, rasterize: false });
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
  setRasterize(id: string, rasterize: boolean) {
    const l = this.store.find((x) => x.id === id)!;
    l.rasterize = rasterize;
    l.slot = rasterize ? this.nextSlot++ : null;
    this.calls.push(`rasterize:${id}:${rasterize}`);
    this.changed();
  }
  flattenLayer(id: string) {
    const l = this.store.find((x) => x.id === id)!;
    l.kind = 'pixel'; l.text = null; l.shape = null; l.rasterize = false;
    if (l.slot === null) l.slot = this.nextSlot++;
    this.calls.push(`flattenLayer:${id}`);
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
    return this.add('pixel', name);
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
    this.emit({ type: 'resize', width: w, height: h });
  }
  dispose() { this.listeners.clear(); }
}
