import type {
  BlendMode, EditorEngine, EngineEvent, HistoryEntry, LayerInfo, Rect, ToolContext, ToolId, ToolPointer,
} from '../../src/engine/types';

interface FakeLayer {
  id: string; name: string; kind: 'pixel' | 'group' | 'base'; visible: boolean; locked: boolean;
  opacity: number; blend: BlendMode; expanded: boolean; parent: string | null; colour: string;
}

/** Minimal in-memory EditorEngine for UI tests. Records calls; paints dabs into a lazily created canvas. */
export class FakeEngine implements EditorEngine {
  width: number;
  height: number;
  calls: string[] = [];
  pointers: { kind: 'down' | 'move' | 'up'; p: ToolPointer }[] = [];
  tool: ToolId = 'brush';
  context: ToolContext | null = null;
  baseWrites: { rect: Rect; len: number }[] = [];
  commits = 0;
  private listeners = new Set<(e: EngineEvent) => void>();
  private store: FakeLayer[];
  private active: string;
  private nextId = 1;
  private entries: HistoryEntry[] = [{ id: 0, label: 'Open' }];
  private index = 0;
  private selectionRect: Rect | null = null;
  private canvas: HTMLCanvasElement | null = null;

  constructor(width = 64, height = 48) {
    this.width = width;
    this.height = height;
    this.store = [{ id: 'base', name: 'TD Input', kind: 'base', visible: true, locked: true, opacity: 1, blend: 'normal', expanded: false, parent: null, colour: '#9cc3e4' }];
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
    }));
  }
  activeLayerId() { return this.active; }
  setActiveLayer(id: string) { this.active = id; this.calls.push(`setActive:${id}`); this.emit({ type: 'structure' }); }

  private add(kind: 'pixel' | 'group', name: string): string {
    const id = `L${this.nextId++}`;
    const above = this.store.find((l) => l.id === this.active)!;
    const idx = this.store.indexOf(above) + 1;
    this.store.splice(idx, 0, { id, name, kind, visible: true, locked: false, opacity: 1, blend: 'normal', expanded: true, parent: above.parent, colour: '#' + ((this.nextId * 5000011) & 0xffffff).toString(16).padStart(6, '0') });
    this.active = id;
    this.push(kind === 'group' ? 'New group' : 'New pixel layer');
    this.emit({ type: 'structure' });
    return id;
  }
  addPixelLayer(name = `Layer ${this.nextId}`) { return this.add('pixel', name); }
  addGroup(name = `Group ${this.nextId}`) { return this.add('group', name); }
  deleteLayer(id: string) {
    const l = this.store.find((x) => x.id === id);
    if (!l || l.kind === 'base') return;
    this.store = this.store.filter((x) => x.id !== id && x.parent !== id);
    if (this.active === id) this.active = this.store[this.store.length - 1].id;
    this.calls.push(`delete:${id}`);
    this.push('Delete layer');
    this.emit({ type: 'structure' });
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
    this.emit({ type: 'structure' });
  }
  setLayerProps(id: string, props: Partial<Pick<LayerInfo, 'name' | 'visible' | 'locked' | 'opacity' | 'blend' | 'expanded'>>) {
    Object.assign(this.store.find((x) => x.id === id)!, props);
    this.calls.push(`props:${id}:${JSON.stringify(props)}`);
    this.emit({ type: 'structure' });
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
  undo() { this.calls.push('undo'); if (this.index > 0) { this.index--; this.emit({ type: 'history' }); } }
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
