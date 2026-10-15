import { computed, effect, signal } from '@preact/signals';
import type { AdjustmentSpec, AdjustmentType, BrushSettings, EditorEngine, LayerInfo, RGBA, SelectionOptions, ToolId } from '../engine/types';
import { NO_LATENCY, type Bridge, type LatencyStats } from '../bridge/tdBridge';
import { decodeImage } from './importImage';
import { DEFAULT_SHAPE_OPTIONS, DEFAULT_TEXT_OPTIONS, newTextSpec, type ShapeOptions, type TextOptions } from './specs';
import { hsvToRgb, parseHex, rgbToHsl, rgbToHsv, toHex, type Hsv, type Rgb } from './colour';
import { BRUSHES, FALLBACK_FONTS, RECENT_DEFAULT, toolInfo } from './tools';
import { fitView, screenToDoc, zoomAbout, clampZoom, type View } from './view';

export const SHAPE_RENDERER_KEY = 'raster-editor.shapeRenderer';
export type ShapeRenderer = 'sdf' | 'canvas';

function loadShapeRenderer(): ShapeRenderer {
  try { return localStorage.getItem(SHAPE_RENDERER_KEY) === 'canvas' ? 'canvas' : 'sdf'; } catch { return 'sdf'; }
}

export type Connection = 'linked' | 'standalone' | 'reconnecting';

const DEFAULT_PRIMARY: Hsv = rgbToHsv(parseHex('#e2683c')!);

export function createStore() {
  let engine: EditorEngine | null = null;
  let offEngine: (() => void) | null = null;
  let stopContextSync: (() => void) | null = null;
  let stopSelSync: (() => void) | null = null;
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

  // v3: selection / text / shape options, fonts, inline text editor, TOP import dialog
  const selOpts = signal<SelectionOptions>({ mode: 'new', feather: 0, antialias: true, wandTolerance: 32, wandContiguous: true, wandSampleAll: false });
  const textOpts = signal<TextOptions>(DEFAULT_TEXT_OPTIONS);
  const shapeOpts = signal<ShapeOptions>(DEFAULT_SHAPE_OPTIONS);
  const fonts = signal<string[]>(FALLBACK_FONTS);
  const shapeRenderer = signal<ShapeRenderer>(loadShapeRenderer());
  const textEdit = signal<{ id: string; isNew: boolean; baseIndex?: number } | null>(null);
  const topDialog = signal(false);
  let bridgeApi: Pick<Bridge, 'listTops' | 'importTop'> | null = null;

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
    selOpts, textOpts, shapeOpts, fonts, textEdit, topDialog, shapeRenderer,
    /** Shape antialiasing: 'sdf' = same maths as TouchDesigner, 'canvas' = browser Canvas 2D. Persisted per viewer. */
    setShapeRenderer(mode: ShapeRenderer) {
      shapeRenderer.value = mode;
      engine?.setShapeRenderer(mode);
      try { localStorage.setItem(SHAPE_RENDERER_KEY, mode); } catch { /* storage may be blocked */ }
    },
    /** The bridge's TOP import API (null in standalone mode). */
    get bridge() { return bridgeApi; },
    set bridge(b: Pick<Bridge, 'listTops' | 'importTop'> | null) { bridgeApi = b; },
    /** Set by the App: opens the Place Image file chooser. */
    openPlace: null as (() => void) | null,
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
              const layer = e.layers().find((l) => l.id === id);
              const kind = layer?.kind;
              if (layer) store.syncOptionsFrom(layer);
              if (textEdit.peek() && textEdit.peek()!.id !== id) store.commitText();
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
      e.setShapeTool(shapeOpts.peek().type);
      e.setShapeRenderer(shapeRenderer.peek());
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
      stopSelSync = effect(() => { e.setSelectionOptions(selOpts.value); });
      docVersion.value++;
      store.fit();
    },

    detach() {
      if (offEngine) offEngine();
      if (stopContextSync) stopContextSync();
      if (stopSelSync) stopSelSync();
      stopSelSync = null;
      textEdit.value = null;
      if (thumbTimer) clearTimeout(thumbTimer);
      offEngine = stopContextSync = thumbTimer = null;
      engine = null;
    },

    // Tools
    setTool(id: ToolId) {
      if (!toolInfo(id).enabled) return;
      if (id !== 'text') store.commitText();
      tool.value = id;
      engine?.setTool(id);
      if (id === 'shape') engine?.setShapeTool(shapeOpts.peek().type);
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
      return !!l && (l.kind === 'pixel' || l.kind === 'adjustment' || l.kind === 'text' || l.kind === 'shape') && !l.mask;
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
    deselect: () => engine?.deselect(),
    selectAll: () => engine?.selectAll(),
    invertSelection: () => engine?.invertSelection(),
    canMaskFromSelection() {
      const l = engine ? store.activeLayer() : undefined;
      return !!l && !!engine?.selection() && (l.kind === 'pixel' || l.kind === 'adjustment' || l.kind === 'text' || l.kind === 'shape');
    },
    maskFromSelection() {
      const l = store.activeLayer();
      if (l && store.canMaskFromSelection()) store.engine.maskFromSelection(l.id);
    },

    // v3: selection options, text / shape options and editing
    setSelOpts(p: Partial<SelectionOptions>) { selOpts.value = { ...selOpts.peek(), ...p }; },
    setFonts(families: string[]) {
      if (!families.length) return;
      fonts.value = families;
      const cur = textOpts.peek().font;
      if (!families.includes(cur)) {
        const pick = ['Arial', 'Helvetica'].find((f) => families.includes(f)) ?? families[0];
        textOpts.value = { ...textOpts.peek(), font: pick };
      }
    },
    rgbaOf: (hex: string, a = 100) => toRgba(hex, a),
    primaryRgba: () => toRgba(primary.peek(), alpha.peek()),
    secondaryRgba: () => toRgba(secondary.peek(), 100),
    /** The active layer when it is a text layer (the context bar edits it). */
    boundText(): LayerInfo | undefined {
      const l = engine ? store.activeLayer() : undefined;
      return l?.kind === 'text' && l.text ? l : undefined;
    },
    /** The active layer when it is a shape layer of the shape type currently chosen (the context bar edits it). */
    boundShape(): LayerInfo | undefined {
      const l = engine ? store.activeLayer() : undefined;
      return l?.kind === 'shape' && l.shape && l.shape.type === shapeOpts.peek().type ? l : undefined;
    },
    /** Selecting a text / shape layer loads its settings into the tool options so new layers inherit them. */
    syncOptionsFrom(l: LayerInfo) {
      if (l.kind === 'text' && l.text) {
        const t = l.text;
        textOpts.value = { font: t.font, size: t.size, bold: t.bold, italic: t.italic, align: t.align, lineHeight: t.lineHeight };
      } else if (l.kind === 'shape' && l.shape) {
        const sp = l.shape, o = shapeOpts.peek();
        const n: ShapeOptions = { ...o, type: sp.type };
        if (sp.type === 'line') { n.strokeWidth = sp.stroke.width; n.arrowStart = sp.arrowStart; n.arrowEnd = sp.arrowEnd; }
        else {
          n.fillOn = sp.fill.enabled; n.strokeOn = sp.stroke.enabled; n.strokeWidth = sp.stroke.width;
          if (sp.type === 'rect') n.radius = sp.radius;
          if (sp.type === 'polygon') { n.sides = sp.sides; n.innerRatio = sp.innerRatio; }
        }
        shapeOpts.value = n;
        engine?.setShapeTool(n.type);
      }
    },
    setTextOpt(p: Partial<TextOptions>) {
      textOpts.value = { ...textOpts.peek(), ...p };
      const l = store.boundText();
      if (l) engine!.setText(l.id, { ...l.text!, ...p });
    },
    setTextColor(hex: string) {
      store.setPrimaryHex(hex, false);
      const l = store.boundText();
      if (l) engine!.setText(l.id, { ...l.text!, color: toRgba(hex, alpha.peek()) });
    },
    setShapeOpt(p: Partial<ShapeOptions>) {
      const prev = shapeOpts.peek();
      const l = p.type && p.type !== prev.type ? undefined : store.boundShape();
      shapeOpts.value = { ...prev, ...p };
      if (p.type && p.type !== prev.type) { engine?.setShapeTool(p.type); return; }
      if (!l) return;
      const sp = l.shape!;
      const patch = (fill: boolean) => ({
        ...(fill && 'fill' in sp && p.fillOn !== undefined ? { fill: { ...sp.fill, enabled: p.fillOn } } : {}),
      });
      let next = sp;
      if (sp.type === 'line') {
        next = { ...sp, stroke: { ...sp.stroke, width: p.strokeWidth ?? sp.stroke.width }, arrowStart: p.arrowStart ?? sp.arrowStart, arrowEnd: p.arrowEnd ?? sp.arrowEnd };
      } else {
        next = { ...sp, ...patch(true), stroke: { ...sp.stroke, enabled: p.strokeOn ?? sp.stroke.enabled, width: p.strokeWidth ?? sp.stroke.width } } as typeof sp;
        if (sp.type === 'rect' && p.radius !== undefined) next = { ...(next as typeof sp), radius: p.radius } as typeof sp;
        if (sp.type === 'polygon') next = { ...(next as typeof sp), sides: p.sides ?? sp.sides, innerRatio: p.innerRatio ?? sp.innerRatio } as typeof sp;
      }
      engine!.setShape(l.id, next);
    },
    setShapeFill(hex: string) {
      store.setPrimaryHex(hex, false);
      const l = store.boundShape();
      if (l && l.shape && l.shape.type !== 'line') engine!.setShape(l.id, { ...l.shape, fill: { ...l.shape.fill, color: toRgba(hex, alpha.peek()) } });
    },
    /** A line has a single colour, the primary. */
    setLineColor(hex: string) {
      store.setPrimaryHex(hex, false);
      const l = store.boundShape();
      if (l?.shape?.type === 'line') engine!.setShape(l.id, { ...l.shape, stroke: { ...l.shape.stroke, color: toRgba(hex, alpha.peek()) } });
    },
    setShapeStroke(hex: string) {
      secondary.value = hex;
      const l = store.boundShape();
      if (l && l.shape) engine!.setShape(l.id, { ...l.shape, stroke: { ...l.shape.stroke, color: toRgba(hex, 100) } } as typeof l.shape);
    },
    setRasterize(id: string, on: boolean) { engine?.setRasterize(id, on); },
    flattenLayer(id: string) { engine?.flattenLayer(id); },

    /** Text tool click: edit the text layer under the point, else add a new one there, and open the inline editor. */
    beginText(x: number, y: number) {
      const e = store.engine;
      store.commitText();
      const hit = e.textLayerAt(x, y);
      if (hit) {
        e.setActiveLayer(hit);
        textEdit.value = { id: hit, isNew: false };
        return hit;
      }
      const baseIndex = e.history().index;
      const id = e.addTextLayer(newTextSpec(textOpts.peek(), toRgba(primary.peek(), alpha.peek()), x, y));
      textEdit.value = { id, isNew: true, baseIndex };
      return id;
    },
    /** Live text edits from the inline editor. */
    updateEditedText(text: string) {
      const ed = textEdit.peek();
      if (!ed || !engine) return;
      const l = engine.layers().find((x) => x.id === ed.id);
      if (l?.text && l.text.text !== text) engine.setText(ed.id, { ...l.text, text });
    },
    /** Esc / click-away: close the editor; a new text layer left empty is removed. */
    commitText() {
      const ed = textEdit.peek();
      if (!ed) return;
      textEdit.value = null;
      if (!engine || !ed.isNew) return;
      const l = engine.layers().find((x) => x.id === ed.id);
      if (l && l.text && l.text.text.trim() === '') {
        // Only the add happened: undo it so the abandoned click leaves no new history entry (the redo tail is the add).
        if (ed.baseIndex !== undefined && engine.history().index === ed.baseIndex + 1) engine.undo();
        else engine.deleteLayer(ed.id);
      }
    },

    // v3 import
    /** Decode an image file / clipboard blob and add it as a pixel layer. */
    async importBlob(blob: Blob, name: string): Promise<string | null> {
      if (!engine) return null;
      try {
        const img = await decodeImage(blob);
        return store.engine.importImage(img.rgba, img.w, img.h, name.replace(/\.[a-z0-9]+$/i, '') || 'Image');
      } catch {
        setNotice(`Could not read "${name}" as an image`);
        return null;
      }
    },
    async importFiles(files: Iterable<File>): Promise<void> {
      for (const f of files) if (f.type.startsWith('image/')) await store.importBlob(f, f.name || 'Image');
    },
    placeImage() { store.openPlace?.(); },
    /** Edit > Paste: reads image items from the async clipboard (Ctrl+V uses the paste event instead). */
    async pasteFromClipboard() {
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) { await store.importBlob(await item.getType(type), 'Pasted image'); return; }
        }
        setNotice('No image on the clipboard');
      } catch {
        setNotice('Press Ctrl+V to paste an image');
      }
    },


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
