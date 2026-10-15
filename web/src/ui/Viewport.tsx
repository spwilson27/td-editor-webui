import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { LayerInfo, Rect, ToolId, ToolPointer } from '../engine/types';
import { capture } from './capture';
import { store } from '../state/store';
import { hasFiles, imageFiles } from '../state/importImage';
import { shapeFromDrag, shapePreviewPath } from '../state/specs';
import { HANDLE_CURSOR, hitBox, hitGuide, moveRect, scaleRect, handleSigns, type BoxHit, type Handle } from '../state/transform';
import { TextEditor } from './TextEditor';
import { Backdrop, drawDocument, drawOverlay, type CursorShape, type Pt } from './viewportDraw';

/** Tools whose points snap to guides / canvas / layers (v4). */
const SNAP_TOOLS = new Set<ToolId>(['marquee', 'shape', 'text', 'crop']);

const mouseCursor: Record<string, string> = { move: 'move', marquee: 'crosshair', lasso: 'crosshair', wand: 'crosshair', shape: 'crosshair', text: 'text', gradient: 'crosshair', fill: 'crosshair', picker: 'crosshair', zoom: 'zoom-in', hand: 'grab' };

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = host.current!, mainEl = main.current!, overEl = over.current!;
    const mainCtx = mainEl.getContext('2d')!, overCtx = overEl.getContext('2d')!;
    const backdrop = new Backdrop();
    let vw = 0, vh = 0, dpr = 1;
    let mainQueued = false, overQueued = false, dash = 0;
    let hover: { x: number; y: number } | null = null;
    let activeId: number | null = null;
    let mode: 'pan' | 'draw' | 'shape' | 'xform' | 'guide' | null = null;
    let xf: { layer: LayerInfo; from: Rect; hit: BoxHit; sx: number; sy: number } | null = null;
    let guideGrab: { axis: 'h' | 'v'; index: number } | null = null;
    let selPaths: Pt[][] = [];
    let hasSel = false;
    let selDirty = true;
    let lasso: Pt[] | null = null;
    let shapeDrag: { x0: number; y0: number; x1: number; y1: number; shift: boolean } | null = null;
    let panFrom = { x: 0, y: 0 };
    let lastTool: ToolPointer | null = null;

    // Backing store is rounded to whole device pixels; the transform maps CSS px onto it exactly.
    const setScale = (ctx: CanvasRenderingContext2D) => ctx.setTransform(ctx.canvas.width / vw, 0, 0, ctx.canvas.height / vh, 0, 0);

    const paintMain = () => {
      mainQueued = false;
      if (!vw || !store.hasEngine()) return;
      const e = store.engine;
      setScale(mainCtx);
      const td = store.viewMode.peek() === 'td';
      // Local: the engine's preview. TD + panel: transparent document rect (TD draws underneath). TD + external: TD's image.
      const source = !td ? e.compositeSource() : store.clientKind.peek() === 'external' ? store.tdViewSource() : null;
      drawDocument(mainCtx, backdrop, vw, vh, store.view.peek(), e.width, e.height, source, td && store.clientKind.peek() === 'panel');
    };
    const paintOver = () => {
      overQueued = false;
      if (!vw || !store.hasEngine()) return;
      const t = store.tool.peek(), b = store.brush.peek(), z = store.view.peek().zoom;
      let cursor: CursorShape | null = null;
      if (hover && mode !== 'pan' && !store.spaceHeld.peek() && (t === 'brush' || t === 'eraser' || t === 'pencil')) {
        cursor = { x: hover.x, y: hover.y, diameter: b.size * z, square: t === 'pencil' };
      }
      setScale(overCtx);
      let preview: { paths: Pt[][]; closed: boolean } | null = null;
      if (lasso && lasso.length > 1) preview = { paths: [lasso], closed: false };
      else if (shapeDrag) {
        const spec = shapeFromDrag(store.shapeOpts.peek(), store.primaryRgba(), store.secondaryRgba(), shapeDrag, shapeDrag.shift);
        if (spec) preview = { paths: shapePreviewPath(spec), closed: spec.type !== 'line' };
      }
      // Tracing a contour is not free: recompute at most once per frame and not while a stroke is still adding to the selection.
      if (selDirty && mode !== 'draw') refreshSel();
      const view = store.view.peek();
      const gd = store.guideDrag.peek();
      let guides = null;
      if (store.showGuides.peek() || gd) {
        const g = store.engine.guides();
        guides = {
          h: store.showGuides.peek() ? g.h : [], v: store.showGuides.peek() ? g.v : [],
          skip: gd && gd.index !== null ? { axis: gd.axis, index: gd.index } : null,
          drag: gd && !gd.remove ? { axis: gd.axis, pos: gd.pos } : null,
        };
      }
      let box: Rect | null = null;
      if (t === 'move') {
        const l = store.activeLayer();
        if (l && store.canEditTransform(l)) box = store.engine.layerBounds(l.id);
      }
      drawOverlay(overCtx, vw, vh, view, store.engine.selection(), dash, cursor, { paths: mode === 'draw' ? null : selPaths, preview, guides, box, snap: store.snapLines.peek() });
    };
    const queueMain = () => { if (!mainQueued) { mainQueued = true; requestAnimationFrame(paintMain); } };
    const queueOver = () => { if (!overQueued) { overQueued = true; requestAnimationFrame(paintOver); } };

    const resize = () => {
      const r = el.getBoundingClientRect();
      vw = r.width; vh = r.height;
      store.viewRect.value = { x: r.left, y: r.top, w: r.width, h: r.height };
      dpr = window.devicePixelRatio || 1;
      for (const c of [mainEl, overEl]) {
        c.width = Math.max(1, Math.round(vw * dpr));
        c.height = Math.max(1, Math.round(vh * dpr));
      }
      store.setViewSize(vw, vh);
      queueMain(); queueOver();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // A different devicePixelRatio (monitor change, browser zoom) does not resize the element.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => { resize(); watchDpr(); };
    const watchDpr = () => {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
      dprQuery?.addEventListener('change', onDprChange);
    };
    watchDpr();

    function refreshSel() {
      selDirty = false;
      hasSel = store.engine.selection() !== null;
      selPaths = hasSel ? store.engine.selectionPath() : [];
    };
    refreshSel();
    const off = store.engine.on((ev) => {
      if (ev.type === 'composite' || ev.type === 'resize') queueMain();
      if (ev.type === 'selection') { selDirty = true; hasSel = store.engine.selection() !== null; queueOver(); }
    });
    const stopFx = effect(() => {
      store.view.value; store.viewMode.value; store.clientKind.value; store.tdViewTick.value; store.tool.value; store.brush.value; store.spaceHeld.value; store.selectionVersion.value;
      queueMain(); queueOver();
    });
    // v4 overlay-only inputs: guides, snap lines, the transform box follows the document spec
    const stopOverFx = effect(() => {
      store.docspecVersion.value; store.showGuides.value; store.guideDrag.value; store.snapLines.value; store.docVersion.value;
      queueOver();
    });
    const ants = setInterval(() => { if (hasSel) { dash = (dash + 1) % 8; queueOver(); } }, 120);

    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const toolPointer = (e: PointerEvent): ToolPointer => {
      const p = local(e), d = store.toDoc(p.x, p.y);
      return { x: d.x, y: d.y, pressure: e.pointerType === 'pen' ? e.pressure || 1 : 1, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    };
    /** v4: a tool point pulled onto guides / canvas / layer bounds (when Snap is on); records the lines for feedback. */
    const snapped = <T extends { x: number; y: number }>(d: T, record: boolean): T => {
      if (!store.snapOn.peek() || !SNAP_TOOLS.has(store.tool.peek())) return d;
      const s = store.engine.snapPoint(d.x, d.y, store.view.peek().zoom);
      if (record) store.snapLines.value = { x: s.guideX, y: s.guideY };
      return { ...d, x: s.x, y: s.y };
    };
    const clearSnap = () => { const s = store.snapLines.peek(); if (s.x !== null || s.y !== null) store.snapLines.value = { x: null, y: null }; };

    /** Move tool drag: the box's body moves, its handles scale; edges snap. Absolute from the pointer-down state. */
    const dragTransform = (e: PointerEvent) => {
      if (!xf) return;
      const d = toolPointer(e), z = store.view.peek().zoom;
      let dx = d.x - xf.sx, dy = d.y - xf.sy;
      const eng = store.engine, snapOn = store.snapOn.peek();
      let lines = { x: null as number | null, y: null as number | null };
      if (xf.hit === 'move') {
        const s = snapOn ? eng.snapRect(moveRect(xf.from, dx, dy), z) : { dx: 0, dy: 0, guideX: null, guideY: null };
        dx += s.dx; dy += s.dy;
        lines = { x: s.guideX, y: s.guideY };
        const moved = moveRect(xf.from, dx, dy);
        if (xf.layer.kind === 'text' || xf.layer.kind === 'shape') { moved.x = Math.round(moved.x); moved.y = Math.round(moved.y); } // whole-pixel positions
        store.setLayerBounds(xf.layer, xf.from, moved);
      } else {
        const h = xf.hit as Handle, { hx, hy } = handleSigns(h);
        if (snapOn && !d.shift) {
          const ex = (hx > 0 ? xf.from.x + xf.from.w : xf.from.x) + dx, ey = (hy > 0 ? xf.from.y + xf.from.h : xf.from.y) + dy;
          const s = eng.snapPoint(hx ? ex : xf.from.x, hy ? ey : xf.from.y, z);
          if (hx) { dx += s.x - ex; lines.x = s.guideX; }
          if (hy) { dy += s.y - ey; lines.y = s.guideY; }
        }
        store.setLayerBounds(xf.layer, xf.from, scaleRect(xf.from, h, dx, dy, { shift: d.shift, alt: d.alt }));
      }
      store.snapLines.value = lines;
      queueOver();
    };

    const finish = (up: ToolPointer | null, cancel = false) => {
      if (mode === 'draw') { const p = up ? snapped(up, false) : lastTool; if (p) store.engine.pointerUp(p); }
      if (mode === 'shape' && shapeDrag && !cancel) {
        if (up) { const u = snapped(up, false); shapeDrag.x1 = u.x; shapeDrag.y1 = u.y; shapeDrag.shift = up.shift; }
        const spec = shapeFromDrag(store.shapeOpts.peek(), store.primaryRgba(), store.secondaryRgba(), shapeDrag, shapeDrag.shift);
        if (spec) store.engine.addShapeLayer(spec);
      }
      if (mode === 'guide' || (mode === null && store.guideDrag.peek())) store.guideDragEnd(!cancel);
      mode = null; activeId = null; lastTool = null; lasso = null; shapeDrag = null; xf = null; guideGrab = null;
      clearSnap();
      updateCursor();
      queueOver();
    };
    /** Pointer cancelled, capture lost or window blurred: end the stroke at the last known position. */
    const abort = () => { if (mode) finish(null, true); };

    const onDown = (e: PointerEvent) => {
      if (activeId !== null || e.button === 2 || store.loadingDoc.peek()) return;
      store.releaseStaleSpace();
      const p = local(e), tool = store.tool.peek();
      if (e.button === 1 || store.spaceHeld.peek() || tool === 'hand') {
        mode = 'pan'; activeId = e.pointerId; panFrom = p;
        capture(el, e.pointerId);
        el.style.cursor = 'grabbing';
        return;
      }
      if (tool === 'zoom') { store.zoomStep(e.altKey ? -1 : 1, p.x, p.y); return; }
      if (e.button !== 0) return;
      if (tool === 'move') {
        const l = store.activeLayer();
        const gridGuide = store.showGuides.peek() ? hitGuide(store.view.peek(), store.engine.guides(), p.x, p.y) : null;
        const b = l && store.canEditTransform(l) ? store.engine.layerBounds(l.id) : null;
        const hit = b ? hitBox(store.view.peek(), b, p.x, p.y) : null;
        // a guide wins over the box body, a handle wins over a guide
        if (gridGuide && (!hit || hit === 'move')) {
          mode = 'guide'; activeId = e.pointerId; guideGrab = gridGuide;
          capture(el, e.pointerId);
          store.guideDragMove(gridGuide.axis, gridGuide.index, e.clientX, e.clientY);
          queueOver();
          return;
        }
        if (l && !store.canEditTransform(l)) { if (l.locked) store.setNotice('Layer is locked'); return; }
        if (!l || !b || !hit) return;
        const d = toolPointer(e);
        mode = 'xform'; activeId = e.pointerId;
        capture(el, e.pointerId);
        xf = { layer: l, from: b, hit, sx: d.x, sy: d.y };
        return;
      }
      if (tool === 'text') {
        const d = toolPointer(e);
        const ds = snapped(d, false);
        if (store.textEdit.peek()) {
          // click-away commits; a click on another text layer moves the editor there
          const ed = store.textEdit.peek()!;
          store.commitText();
          const hit = store.engine.textLayerAt(d.x, d.y);
          if (hit && hit !== ed.id) store.beginText(d.x, d.y);
        } else store.beginText(store.engine.textLayerAt(d.x, d.y) ? d.x : ds.x, store.engine.textLayerAt(d.x, d.y) ? d.y : ds.y);
        e.preventDefault(); // keep the new editor's focus
        return;
      }
      if (tool === 'shape') {
        const d = snapped(toolPointer(e), true);
        mode = 'shape'; activeId = e.pointerId;
        capture(el, e.pointerId);
        shapeDrag = { x0: d.x, y0: d.y, x1: d.x, y1: d.y, shift: d.shift };
        return;
      }
      mode = 'draw'; activeId = e.pointerId;
      capture(el, e.pointerId);
      lastTool = snapped(toolPointer(e), true);
      if (tool === 'lasso') lasso = [{ x: lastTool.x, y: lastTool.y }];
      store.engine.pointerDown(lastTool);
    };
    const onMove = (e: PointerEvent) => {
      if (activeId !== null && e.pointerId !== activeId) return;
      const p = local(e);
      hover = p;
      store.cursorPos.value = p;
      if (mode === 'xform') {
        dragTransform(e);
      } else if (mode === 'guide' && guideGrab) {
        store.guideDragMove(guideGrab.axis, guideGrab.index, e.clientX, e.clientY);
        queueOver();
      } else if (mode === 'pan') {
        store.panBy(p.x - panFrom.x, p.y - panFrom.y);
        panFrom = p;
      } else if (mode === 'shape' && shapeDrag) {
        const d = snapped(toolPointer(e), true);
        shapeDrag.x1 = d.x; shapeDrag.y1 = d.y; shapeDrag.shift = e.shiftKey;
        queueOver();
      } else if (mode === 'draw') {
        const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        for (const c of list.length ? list : [e]) {
          lastTool = snapped(toolPointer(c), true);
          if (lasso) lasso.push({ x: lastTool.x, y: lastTool.y });
          store.engine.pointerMove(lastTool);
        }
        if (lasso) queueOver();
      }
      const t = store.tool.peek();
      if (t === 'brush' || t === 'eraser' || t === 'pencil') queueOver();
      if (!mode && t === 'move') hoverCursor(p);
    };
    /** Move tool, nothing pressed: show what a drag would do. */
    const hoverCursor = (p: { x: number; y: number }) => {
      if (store.spaceHeld.peek() || !store.hasEngine()) return;
      const view = store.view.peek();
      const g = store.showGuides.peek() ? hitGuide(view, store.engine.guides(), p.x, p.y) : null;
      const l = store.activeLayer();
      const b = l && store.canEditTransform(l) ? store.engine.layerBounds(l.id) : null;
      const hit = b ? hitBox(view, b, p.x, p.y) : null;
      if (hit && hit !== 'move') el.style.cursor = HANDLE_CURSOR[hit as Handle];
      else if (g) el.style.cursor = g.axis === 'h' ? 'row-resize' : 'col-resize';
      else el.style.cursor = hit ? 'move' : 'default';
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return;
      if (mode === 'guide' && guideGrab) store.guideDragMove(guideGrab.axis, guideGrab.index, e.clientX, e.clientY);
      finish(toolPointer(e));
    };
    const onCancel = (e: PointerEvent) => { if (e.pointerId === activeId) abort(); };
    const onLeave = () => { hover = null; store.cursorPos.value = null; queueOver(); };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      // ctrl+wheel is how browsers report trackpad pinch: tiny deltas, so scale them up (capped per event).
      const exponent = e.ctrlKey ? Math.max(-0.25, Math.min(0.25, -px * 0.01)) : (-px / 100) * Math.log(1.1);
      store.zoomBy(Math.exp(exponent), p.x, p.y);
    };

    const updateCursor = () => {
      const t = store.tool.peek();
      el.style.cursor = store.spaceHeld.peek() || t === 'hand' ? 'grab' : t === 'brush' || t === 'eraser' || t === 'pencil' ? 'none' : t === 'move' ? 'default' : mouseCursor[t] || 'default';
    };
    const stopCursor = effect(() => { store.tool.value; store.spaceHeld.value; updateCursor(); });

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      const files = imageFiles(e.dataTransfer);
      if (!files.length && !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      void store.importFiles(files);
    };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onCancel);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', abort);
    resize();

    return () => {
      ro.disconnect(); off(); stopFx(); stopOverFx(); stopCursor(); clearInterval(ants);
      dprQuery?.removeEventListener('change', onDprChange);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onCancel);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', abort);
    };
  }, []);

  const layer = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
  const clear = store.tdPanel.value;
  return (
    <div ref={host} data-viewport data-td-panel={clear} style={`flex:1 1 auto;min-height:0;position:relative;overflow:hidden;background:${clear ? 'transparent' : '#1c1c1c'};touch-action:none`}>
      <canvas ref={main} style={layer} />
      <canvas ref={over} style={layer + ';pointer-events:none'} />
      {store.textEdit.value && <TextEditor />}
    </div>
  );
}
