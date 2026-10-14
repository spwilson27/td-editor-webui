import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { ToolPointer } from '../engine/types';
import { capture } from './capture';
import { store } from '../state/store';
import { Backdrop, drawDocument, drawOverlay, type CursorShape } from './viewportDraw';

const mouseCursor: Record<string, string> = { move: 'move', marquee: 'crosshair', gradient: 'crosshair', fill: 'crosshair', picker: 'crosshair', zoom: 'zoom-in', hand: 'grab' };

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
    let mode: 'pan' | 'draw' | null = null;
    let panFrom = { x: 0, y: 0 };
    let lastTool: ToolPointer | null = null;

    // Backing store is rounded to whole device pixels; the transform maps CSS px onto it exactly.
    const setScale = (ctx: CanvasRenderingContext2D) => ctx.setTransform(ctx.canvas.width / vw, 0, 0, ctx.canvas.height / vh, 0, 0);

    const paintMain = () => {
      mainQueued = false;
      if (!vw || !store.hasEngine()) return;
      const e = store.engine;
      setScale(mainCtx);
      drawDocument(mainCtx, backdrop, vw, vh, store.view.peek(), e.width, e.height, e.compositeSource());
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
      drawOverlay(overCtx, vw, vh, store.view.peek(), store.engine.selection(), dash, cursor);
    };
    const queueMain = () => { if (!mainQueued) { mainQueued = true; requestAnimationFrame(paintMain); } };
    const queueOver = () => { if (!overQueued) { overQueued = true; requestAnimationFrame(paintOver); } };

    const resize = () => {
      const r = el.getBoundingClientRect();
      vw = r.width; vh = r.height;
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

    const off = store.engine.on((ev) => {
      if (ev.type === 'composite' || ev.type === 'resize') queueMain();
      if (ev.type === 'selection') queueOver();
    });
    const stopFx = effect(() => {
      store.view.value; store.tool.value; store.brush.value; store.spaceHeld.value; store.selectionVersion.value;
      queueMain(); queueOver();
    });
    const ants = setInterval(() => { if (store.engine.selection()) { dash = (dash + 1) % 8; queueOver(); } }, 120);

    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const toolPointer = (e: PointerEvent): ToolPointer => {
      const p = local(e), d = store.toDoc(p.x, p.y);
      return { x: d.x, y: d.y, pressure: e.pointerType === 'pen' ? e.pressure || 1 : 1, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    };

    const finish = (up: ToolPointer | null) => {
      if (mode === 'draw') { const p = up ?? lastTool; if (p) store.engine.pointerUp(p); }
      mode = null; activeId = null; lastTool = null;
      updateCursor();
      queueOver();
    };
    /** Pointer cancelled, capture lost or window blurred: end the stroke at the last known position. */
    const abort = () => { if (mode) finish(null); };

    const onDown = (e: PointerEvent) => {
      if (activeId !== null || e.button === 2) return;
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
      mode = 'draw'; activeId = e.pointerId;
      capture(el, e.pointerId);
      lastTool = toolPointer(e);
      store.engine.pointerDown(lastTool);
    };
    const onMove = (e: PointerEvent) => {
      if (activeId !== null && e.pointerId !== activeId) return;
      const p = local(e);
      hover = p;
      if (mode === 'pan') {
        store.panBy(p.x - panFrom.x, p.y - panFrom.y);
        panFrom = p;
      } else if (mode === 'draw') {
        const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        for (const c of list.length ? list : [e]) {
          lastTool = toolPointer(c);
          store.engine.pointerMove(lastTool);
        }
      }
      const t = store.tool.peek();
      if (t === 'brush' || t === 'eraser' || t === 'pencil') queueOver();
    };
    const onUp = (e: PointerEvent) => { if (e.pointerId === activeId) finish(toolPointer(e)); };
    const onCancel = (e: PointerEvent) => { if (e.pointerId === activeId) abort(); };
    const onLeave = () => { hover = null; queueOver(); };
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
      el.style.cursor = store.spaceHeld.peek() || t === 'hand' ? 'grab' : t === 'brush' || t === 'eraser' || t === 'pencil' ? 'none' : mouseCursor[t] || 'default';
    };
    const stopCursor = effect(() => { store.tool.value; store.spaceHeld.value; updateCursor(); });

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
      ro.disconnect(); off(); stopFx(); stopCursor(); clearInterval(ants);
      dprQuery?.removeEventListener('change', onDprChange);
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
  return (
    <div ref={host} data-viewport style="flex:1 1 auto;min-height:0;position:relative;overflow:hidden;background:#1c1c1c;touch-action:none">
      <canvas ref={main} style={layer} />
      <canvas ref={over} style={layer + ';pointer-events:none'} />
    </div>
  );
}
