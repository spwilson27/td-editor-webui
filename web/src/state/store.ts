import { computed, effect, signal } from '@preact/signals';
import type { AdjustmentSpec, AdjustmentType, BrushSettings, EditorEngine, RGBA, ToolId } from '../engine/types';
import { NO_LATENCY, type LatencyStats } from '../bridge/tdBridge';
import { hsvToRgb, parseHex, rgbToHsl, rgbToHsv, toHex, type Hsv, type Rgb } from './colour';
import { BRUSHES, RECENT_DEFAULT, toolInfo } from './tools';
import { fitView, screenToDoc, zoomAbout, clampZoom, type View } from './view';

export type Connection = 'linked' | 'standalone' | 'reconnecting';

const DEFAULT_PRIMARY: Hsv = rgbToHsv(parseHex('#e2683c')!);

export function createStore() {
  let engine: EditorEngine | null = null;
  let offEngine: (() => void) | null = null;
  let stopContextSync: (() => void) | null = null;
  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const tool = signal<ToolId>('brush');
  const hsv = signal<Hsv>(DEFAULT_PRIMARY);
  const primary = signal('#e2683c');
  const secondary = signal('#ffffff');
  const alpha = signal(100); // percent
  const recent = signal<string[]>(RECENT_DEFAULT);
  const customSwatches = signal<string[]>([]);
  const brush = signal<BrushSettings>({ size: 64, opacity: 1, flow: 0.72, hardness: 0.4, spacing: 0.15 });
  const brushPreset = signal('round');
  const fillTolerance = signal(32);

  const colorTab = signal<'color' | 'swatches' | 'brushes'>('color');
  const layerTab = signal<'layers' | 'history' | 'adjust'>('layers');

  // v2: view mode (Local preview vs TouchDesigner output), client kind, latency readouts
  const viewMode = signal<'local' | 'td'>('local');
  const clientKind = signal<'panel' | 'external'>('external');
  const viewRect = signal({ x: 0, y: 0, w: 0, h: 0 });
  const latency = signal<LatencyStats>(NO_LATENCY);
  const viewLatency = signal<LatencyStats>(NO_LATENCY);
  const viewAge = signal<number | null>(null);
  const tdViewTick = signal(0);
  const loadingDoc = signal(false);
  const adjDraft = signal<{ id: string; spec: AdjustmentSpec } | null>(null);
  let tdViewSource: HTMLCanvasElement | null = null;
  let lastActiveId: string | null = null;
  let adjFlush: number | null = null;

  const view = signal<View>({ zoom: 1, x: 0, y: 0 });
  const zoom = computed(() => view.value.zoom);
  const spaceHeld = signal(false);
  const docSize = signal({ w: 0, h: 0 });
  const docName = signal('Untitled');

  const connection = signal<Connection>('reconnecting');
  const active = signal(true);
  const notice = signal('');
  const fatal = signal('');

  // Counters bumped by engine events; components read them to re-render engine-backed lists.
  const docVersion = signal(0);
  const historyVersion = signal(0);
  const selectionVersion = signal(0);
  const thumbTick = signal(0);

  let viewSize = { w: 0, h: 0 };
  let fitMode = true;

  const toRgba = (hex: string, a: number): RGBA => {
    const c = parseHex(hex) || { r: 0, g: 0, b: 0 };
    return { ...c, a: Math.round((a / 100) * 255) };
  };

  function setNotice(msg: string) {
    notice.value = msg;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = msg ? setTimeout(() => { notice.value = ''; }, 4000) : null;
  }

  const store = {
    tool, hsv, primary, secondary, alpha, recent, customSwatches, brush, brushPreset, fillTolerance,
    colorTab, layerTab, viewMode, clientKind, viewRect, latency, viewLatency, viewAge, tdViewTick, adjDraft, loadingDoc,
    view, zoom, spaceHeld, docSize, docName, connection, active, notice, fatal,
    docVersion, historyVersion, selectionVersion, thumbTick,
    takeover: null as (() => void) | null,
    /** TD view is only possible while linked to TouchDesigner. */
    tdAvailable: computed(() => connection.value === 'linked'),
    /** Panel client in TD view: the page leaves the document rect transparent so TD's overlay shows through. */
    tdPanel: computed(() => viewMode.value === 'td' && clientKind.value === 'panel'),
    tdViewSource: () => tdViewSource,
    /** Time of the last Space keydown (incl. auto-repeat); lets a missing keyup be detected. */
    spaceSeenAt: 0,

    get engine(): EditorEngine {
      if (!engine) throw new Error('engine not attached');
      return engine;
    },
    hasEngine: () => engine !== null,

    attach(e: EditorEngine) {
      store.detach();
      engine = e;
      docSize.value = { w: e.width, h: e.height };
      offEngine = e.on((ev) => {
        switch (ev.type) {
          case 'structure': {
            docVersion.value++; thumbTick.value++;
            const id = e.activeLayerId();
            if (id !== lastActiveId) {
              lastActiveId = id;
              const kind = e.layers().find((l) => l.id === id)?.kind;
              if (kind === 'adjustment') layerTab.value = 'adjust';
              else if (layerTab.peek() === 'adjust') layerTab.value = 'layers';
            }
            break;
          }
          case 'surface':
          case 'pixels':
            if (!thumbTimer) thumbTimer = setTimeout(() => { thumbTimer = null; thumbTick.value++; }, 250);
            break;
          case 'selection': selectionVersion.value++; break;
          case 'history': historyVersion.value++; break;
          case 'resize':
            docSize.value = { w: ev.width, h: ev.height };
            docVersion.value++; historyVersion.value++; thumbTick.value++;
            store.fit();
            break;
          case 'pick': store.setPrimaryHex(toHex(ev.color)); break;
          case 'notice': setNotice(ev.message); break;
          default: break;
        }
      });
      e.setTool(tool.value);
      e.setPreviewEnabled(viewMode.peek() === 'local');
      lastActiveId = e.activeLayerId();
      stopContextSync = effect(() => {
        e.setToolContext({
          primary: toRgba(primary.value, alpha.value),
          secondary: toRgba(secondary.value, 100),
          brush: brush.value,
          fillTolerance: fillTolerance.value,
        });
      });
      docVersion.value++;
      store.fit();
    },

    detach() {
      if (offEngine) offEngine();
      if (stopContextSync) stopContextSync();
      if (thumbTimer) clearTimeout(thumbTimer);
      offEngine = stopContextSync = thumbTimer = null;
      engine = null;
    },

    // Tools
    setTool(id: ToolId) {
      if (!toolInfo(id).enabled) return;
      tool.value = id;
      engine?.setTool(id);
    },

    // Colour
    applyRgb(c: Rgb) {
      const old = hsv.peek();
      let n = rgbToHsv(c);
      if (n.v === 0) n = { h: old.h, s: old.s, v: 0 };
      else if (n.s === 0) n = { ...n, h: old.h };
      hsv.value = n;
      primary.value = toHex(c);
    },
    setHsv(n: Hsv) {
      hsv.value = n;
      primary.value = toHex(hsvToRgb(n));
    },
    setPrimaryHex(hex: string, remember = true): boolean {
      const c = parseHex(hex);
      if (!c) return false;
      store.applyRgb(c);
      if (remember) store.pushRecent(primary.peek());
      return true;
    },
    pushRecent(hex: string) {
      recent.value = [hex, ...recent.peek().filter((x) => x !== hex)].slice(0, 12);
    },
    addCustomSwatch() {
      const h = primary.peek();
      if (!customSwatches.peek().includes(h)) customSwatches.value = [...customSwatches.peek(), h];
    },
    swapColours() {
      const p = primary.peek();
      store.applyRgb(parseHex(secondary.peek())!);
      secondary.value = p;
    },
    defaultColours() {
      store.applyRgb({ r: 0, g: 0, b: 0 });
      secondary.value = '#ffffff';
    },
    hsl: computed(() => {
      const c = rgbToHsl(parseHex(primary.value)!);
      return { ...c, h: hsv.value.h };
    }),

    // Brush
    setBrush(p: Partial<BrushSettings>) {
      const b = { ...brush.peek(), ...p };
      b.size = Math.round(Math.min(1000, Math.max(1, b.size)));
      brush.value = b;
    },
    applyPreset(id: string) {
      const p = BRUSHES.find((x) => x.id === id);
      if (!p) return;
      brushPreset.value = id;
      store.setBrush({ size: p.size, opacity: p.opacity, flow: p.flow, hardness: p.hardness });
    },
    nudgeSize(dir: 1 | -1) {
      const s = brush.peek().size;
      const step = s >= 100 ? 10 : s >= 20 ? 5 : s >= 10 ? 2 : 1;
      store.setBrush({ size: s + dir * step });
    },

    // View
    setViewSize(w: number, h: number) {
      viewSize = { w, h };
      if (fitMode) store.fit();
    },
    fit() {
      fitMode = true;
      const { w, h } = docSize.peek();
      if (!w || !viewSize.w) return;
      view.value = fitView(w, h, viewSize.w, viewSize.h);
    },
    zoomTo(z: number, ax = viewSize.w / 2, ay = viewSize.h / 2) {
      fitMode = false;
      view.value = zoomAbout(view.peek(), clampZoom(z), ax, ay);
    },
    zoomBy(factor: number, ax?: number, ay?: number) {
      store.zoomTo(view.peek().zoom * factor, ax, ay);
    },
    zoomStep(dir: 1 | -1, ax?: number, ay?: number) {
      store.zoomBy(dir > 0 ? 1.25 : 0.8, ax, ay);
    },
    panBy(dx: number, dy: number) {
      fitMode = false;
      const v = view.peek();
      view.value = { ...v, x: v.x + dx, y: v.y + dy };
    },
    toDoc: (sx: number, sy: number) => screenToDoc(view.peek(), sx, sy),

    // v2 view mode, masks, adjustments
    setViewMode(m: 'local' | 'td') {
      if (m === 'td' && connection.peek() !== 'linked') return;
      viewMode.value = m;
      engine?.setPreviewEnabled(m === 'local');
    },
    toggleViewMode: () => store.setViewMode(viewMode.peek() === 'local' ? 'td' : 'local'),
    /** Image of TD's output for the external TD view (straight RGBA, document sized). */
    setViewFrame(w: number, h: number, rgba: Uint8ClampedArray, ageMs: number) {
      if (!tdViewSource) tdViewSource = document.createElement('canvas');
      if (tdViewSource.width !== w || tdViewSource.height !== h) { tdViewSource.width = w; tdViewSource.height = h; }
      tdViewSource.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
      viewAge.value = Math.round(ageMs);
      tdViewTick.value++;
    },
    setLoading: (b: boolean) => { loadingDoc.value = b; },
    setLatency: (s: LatencyStats) => { latency.value = s; },
    setViewLatency: (s: LatencyStats) => { viewLatency.value = s; },
    addAdjustment: (type: AdjustmentType) => store.engine.addAdjustment(type),
    activeLayer() {
      const e = store.engine, id = e.activeLayerId();
      return e.layers().find((l) => l.id === id);
    },
    canAddMask() {
      const l = store.activeLayer();
      return !!l && (l.kind === 'pixel' || l.kind === 'adjustment') && !l.mask;
    },
    addMask() {
      const l = store.activeLayer();
      if (l && store.canAddMask()) store.engine.addMask(l.id);
    },
    deleteMask() {
      const l = store.activeLayer();
      if (l?.mask) store.engine.deleteMask(l.id);
    },
    /** Live adjustment edits: latest spec wins, applied at most once per animation frame. */
    editAdjustment(id: string, spec: AdjustmentSpec) {
      adjDraft.value = { id, spec };
      if (adjFlush !== null) return;
      adjFlush = requestAnimationFrame(() => {
        adjFlush = null;
        const d = adjDraft.peek();
        adjDraft.value = null;
        if (d && engine) engine.setAdjustment(d.id, d.spec);
      });
    },

    // Document actions
    addLayer: () => store.engine.addPixelLayer(),
    addGroup: () => store.engine.addGroup(),
    flatten: () => store.engine.flattenToNewLayer(),
    deleteActive() {
      const e = store.engine, id = e.activeLayerId();
      if (id) e.deleteLayer(id);
    },
    undo: () => engine?.undo(),
    redo: () => engine?.redo(),
    deselect: () => engine?.setSelection(null),

    /** A forwarded key press may never send its keyup; a held Space repeats, so silence for >1 s means it is stuck. */
    releaseStaleSpace(now = performance.now()) {
      if (spaceHeld.peek() && now - store.spaceSeenAt > 1000) spaceHeld.value = false;
    },

    // Status
    setConnection: (c: Connection) => {
      connection.value = c;
      if (c !== 'linked' && viewMode.peek() === 'td') store.setViewMode('local'); // TD output is unavailable
    },
    setActive: (a: boolean) => { active.value = a; },
    setNotice,
    setFatal: (msg: string) => { fatal.value = msg; },
  };
  return store;
}

export type Store = ReturnType<typeof createStore>;
export const store = createStore();
