import type { Store } from './store';
import type { Anchor, AdjustmentSpec, AdjustmentType, CanvasMode, LayerTransform, PaintTarget, SnapOptions, SelectionOptions, ShapeSpec, ShapeType, TextSpec, ToolId, ToolPointer } from '../engine/types';
import { completeShapeSpec, completeTextSpec } from './specs';

/** `window.__editorTest`, installed only with ?test=1; used by automated TouchDesigner validation. */
export function installTestHook(store: Store, win: Window = window): void {
  const ptr = (x: number, y: number, o: Partial<ToolPointer> = {}): ToolPointer => ({ x, y, pressure: 1, shift: false, alt: false, ctrl: false, ...o });
  /** Drives the engine's pointer API with `tool`, then restores the previous tool. */
  const drive = (tool: ToolId, pts: Array<[number, number]>, mods: Partial<ToolPointer> = {}) => {
    const e = store.engine, prev = store.tool.peek();
    e.setTool(tool);
    e.pointerDown(ptr(pts[0][0], pts[0][1], mods));
    for (const [x, y] of pts.slice(1)) e.pointerMove(ptr(x, y, mods));
    const [lx, ly] = pts[pts.length - 1];
    e.pointerUp(ptr(lx, ly, mods));
    e.setTool(prev);
  };
  (win as unknown as { __editorTest: unknown }).__editorTest = {
    setPrimary: (hex: string) => store.setPrimaryHex(hex),
    setTool: (id: ToolId) => store.setTool(id),
    addLayer: () => store.addLayer(),
    setLayerVisible: (id: string, visible: boolean) => store.engine.setLayerProps(id, { visible }),
    layers: () => store.engine.layers(),
    addAdjustment: (type: AdjustmentType, params?: Partial<AdjustmentSpec>) => {
      const id = store.engine.addAdjustment(type);
      if (params && Object.keys(params).length) {
        const cur = store.engine.layers().find((l) => l.id === id)?.adjustment;
        if (cur) store.engine.setAdjustment(id, { ...cur, ...params } as AdjustmentSpec);
      }
      return id;
    },
    addMask: (layerId: string) => store.engine.addMask(layerId),
    setPaintTarget: (layerId: string, target: PaintTarget) => store.engine.setPaintTarget(layerId, target),
    setViewMode: (m: 'local' | 'td') => { store.setViewMode(m); return store.viewMode.peek(); },
    latency: () => ({ strokeToTd: store.latency.peek(), strokeToView: store.viewLatency.peek(), viewAgeMs: store.viewAge.peek(), mode: store.viewMode.peek() }),
    docSpec: () => store.engine.docSpec(),
    loadState: () => ({ docSpec: store.engine.docSpec(), slots: store.engine.surfaceSlots(), paintTarget: store.engine.paintTarget(), connection: store.connection.peek(), active: store.active.peek(), viewMode: store.viewMode.peek(), loadingDoc: store.loadingDoc.peek() }),
    // v3: selections, text / shape layers, import
    setSelectionOptions: (o: Partial<SelectionOptions>) => { store.setSelOpts(o); return store.selOpts.peek(); },
    selectRect: (x: number, y: number, w: number, h: number, mods: Partial<ToolPointer> = {}) => drive('marquee', [[x, y], [x + w / 2, y + h / 2], [x + w, y + h]], mods),
    selectPolygon: (points: Array<[number, number]>, mods: Partial<ToolPointer> = {}) => drive('lasso', points, mods),
    selectWand: (x: number, y: number, mods: Partial<ToolPointer> = {}) => drive('wand', [[x, y]], mods),
    selectAll: () => store.selectAll(),
    deselect: () => store.deselect(),
    invertSelection: () => store.invertSelection(),
    maskFromSelection: (layerId: string) => store.engine.maskFromSelection(layerId),
    selectionMask: () => { const m = store.engine.selectionMask(); return m ? { rect: m.rect, alpha: Array.from(m.alpha) } : null; },
    selectionPath: () => store.engine.selectionPath(),
    addTextLayer: (spec: Partial<TextSpec> = {}) => store.engine.addTextLayer(completeTextSpec(spec)),
    setText: (id: string, spec: Partial<TextSpec>) => {
      const cur = store.engine.layers().find((l) => l.id === id)?.text;
      if (cur) store.engine.setText(id, { ...cur, ...spec });
    },
    addShapeLayer: (spec: Partial<ShapeSpec> & { type: ShapeType }) => store.engine.addShapeLayer(completeShapeSpec(spec)),
    setShape: (id: string, spec: Partial<ShapeSpec>) => {
      const cur = store.engine.layers().find((l) => l.id === id)?.shape;
      if (cur) store.engine.setShape(id, { ...cur, ...spec } as ShapeSpec);
    },
    // v4: transforms, canvas, guides, snapping, Flatten (via TouchDesigner)
    setTransform: (id: string, t: Partial<LayerTransform>) => {
      const cur = store.engine.layers().find((l) => l.id === id)?.transform;
      if (cur) store.engine.setTransform(id, { ...cur, ...t });
    },
    applyTransform: (id: string) => store.engine.applyTransform(id),
    layerBounds: (id: string) => store.engine.layerBounds(id),
    setCanvasSize: (w: number, h: number, anchor: Anchor = 'c') => store.setCanvasSize(w, h, anchor),
    setCanvasMode: (mode: CanvasMode) => { if (mode === 'input') store.followInput(); else store.setCanvasSize(store.docSize.peek().w, store.docSize.peek().h, 'c'); return store.engine.canvasMode(); },
    canvasMode: () => store.engine.canvasMode(),
    addGuide: (axis: 'h' | 'v', pos: number) => store.engine.addGuide(axis, pos),
    moveGuide: (axis: 'h' | 'v', index: number, pos: number) => store.engine.moveGuide(axis, index, pos),
    removeGuide: (axis: 'h' | 'v', index: number) => store.engine.removeGuide(axis, index),
    guides: () => store.engine.guides(),
    setSnap: (o: Partial<SnapOptions>) => {
      if (o.enabled !== undefined) store.setSnapOn(o.enabled);
      store.engine.setSnap({ ...store.snapOptions(), ...o });
      return store.snapOptions();
    },
    /** Flatten a text / shape layer: TD renders it, the pixels replace the layer. Resolves true when done. */
    flatten: (id: string) => store.flattenLayer(id),
    fonts: () => store.fonts.peek(),
    setShapeRenderer: (m: 'sdf' | 'canvas') => { store.setShapeRenderer(m); return store.engine.shapeRenderer(); },
    listTops: () => (store.bridge ? store.bridge.listTops() : Promise.reject(new Error('standalone'))),
    importImageFromTop: (path: string) => (store.bridge ? store.bridge.importTop(path) : Promise.reject(new Error('standalone'))),
    readPixel: (x: number, y: number) => Array.from(store.engine.readComposite({ x, y, w: 1, h: 1 })),
    /** Screen (client) coordinates of a document point, for synthesising mouse drags. */
    docToScreen: (x: number, y: number) => {
      const r = win.document.querySelector('[data-viewport]')!.getBoundingClientRect();
      const v = store.view.peek();
      return { x: r.left + v.x + x * v.zoom, y: r.top + v.y + y * v.zoom };
    },
    state: () => ({
      tool: store.tool.peek(), primary: store.primary.peek(), secondary: store.secondary.peek(), alpha: store.alpha.peek(),
      brush: store.brush.peek(), view: store.view.peek(), connection: store.connection.peek(), active: store.active.peek(),
      doc: store.docSize.peek(), selOpts: store.selOpts.peek(), textEdit: store.textEdit.peek(), activeLayer: store.engine.activeLayerId(), selection: store.engine.selection(),
    }),
  };
}
