import type { Store } from './store';
import type { AdjustmentSpec, AdjustmentType, PaintTarget, ToolId } from '../engine/types';

/** `window.__editorTest`, installed only with ?test=1; used by automated TouchDesigner validation. */
export function installTestHook(store: Store, win: Window = window): void {
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
      doc: store.docSize.peek(), activeLayer: store.engine.activeLayerId(), selection: store.engine.selection(),
    }),
  };
}
