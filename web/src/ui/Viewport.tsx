import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { LayerInfo, Rect, ToolId, ToolPointer } from '../engine/types';
import { capture } from './capture';
import { store } from '../state/store';
import { hasFiles, imageFiles } from '../state/importImage';
import { shapeFromDrag, shapePreviewPath } from '../state/specs';
import { HANDLE_CURSOR, hitBox, hitGuide, moveRect, scaleRect, handleSigns, type BoxHit, type Handle } from '../state/transform';
import { PAINT_TOOLS } from '../state/tools';
import { clampCrop } from '../state/toolsSlice';
import { boxAabb, cursorFor, hitOriented, isAxisAligned, rotateDrag, scaleDrag, skewDrag, type OHit } from '../state/affine';
import { orientedTarget, type OTarget } from '../state/xtarget';
import { TextEditor } from './TextEditor';
import { peekTdViewGl } from './tdViewGl';
import { Backdrop, drawDocument, drawOverlay, type CursorShape, type Pt } from './viewportDraw';

/** Tools whose points snap to guides / canvas / layers (v4). */
const SNAP_TOOLS = new Set<ToolId>(['marquee', 'shape', 'text', 'crop']);

const mouseCursor: Record<string, string> = { move: 'move', crop: 'crosshair', marquee: 'crosshair', lasso: 'crosshair', wand: 'crosshair', shape: 'crosshair', text: 'text', gradient: 'crosshair', fill: 'crosshair', picker: 'crosshair', zoom: 'zoom-in', hand: 'grab' };

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
    let shownGl: HTMLCanvasElement | null = null; // the TD view's WebGL canvas while it is attached to this viewport
    let hover: { x: number; y: number } | null = null;
    let activeId: number | null = null;
    let mode: 'pan' | 'draw' | 'shape' | 'xform' | 'guide' | 'crop' | null = null;
    let xf: { layer: LayerInfo; from: Rect; hit: BoxHit; sx: number; sy: number } | null = null;
    /** v5: free-transform drag of an oriented target (pixel / input layer or floating selection). */
    let xo: { tg: OTarget; t0: import('../engine/types').LayerTransform; hit: OHit; kind: 'move' | 'scale' | 'rotate' | 'skew'; sx: number; sy: number; info: { pointer: Pt; text: string } | null } | null = null;
    let cropDrag: { kind: 'new'; x0: number; y0: number } | { kind: 'edit'; hit: BoxHit; from: Rect; sx: number; sy: number } | null = null;
    let cloneSrc: Pt | null = null;
    let cloneOff: { dx: number; dy: number } | null = null;
    let qmCanvas: HTMLCanvasElement | null = null;
    let qmDirty = true;
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
      // Local: the engine's preview. TD (v11): the WebGL composite of TD's fast / exact frame, a canvas layered above the backdrop (no copy).
      const gl = td ? peekTdViewGl() : null;
      const showGl = !!(gl && gl.available && gl.hasContent);
      const glEl = gl?.canvas ?? shownGl;
      if (glEl) {
        if (showGl && glEl.parentElement !== el) { glEl.style.cssText = layer + ';pointer-events:none'; el.insertBefore(glEl, overEl); }
        glEl.style.display = showGl ? 'block' : 'none';
        shownGl = glEl;
      }
      if (showGl) gl.draw({ vw, vh, cw: mainEl.width, ch: mainEl.height, view: store.view.peek(), docW: e.width, docH: e.height });
      drawDocument(mainCtx, backdrop, vw, vh, store.view.peek(), e.width, e.height, !td ? e.compositeSource() : null, false);
    };
    const paintOver = () => {
      overQueued = false;
      if (!vw || !store.hasEngine()) return;
      const t = store.tool.peek(), b = store.brush.peek(), z = store.view.peek().zoom;
      let cursor: CursorShape | null = null;
      if (hover && mode !== 'pan' && !store.spaceHeld.peek() && PAINT_TOOLS.has(t)) {
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
      let box: Rect | null = null, obox: NonNullable<Parameters<typeof drawOverlay>[7]>['obox'] = null;
      const floating = store.engine.floating() !== null;
      const qmOn = store.engine.quickMask();
      if (t === 'move') {
        const tg = orientedTarget(store);
        if (tg) obox = { t: tg.t, w: tg.w, h: tg.h, rotating: xo?.kind === 'rotate' ? xo.info : null };
        else {
          const l = store.activeLayer();
          if (l && store.canEditTransform(l) && l.kind !== 'pixel' && l.kind !== 'input') box = store.engine.layerBounds(l.id);
        }
      }
      let quickMask = null;
      if (qmOn) {
        if (qmDirty) buildQm();
        if (qmCanvas) quickMask = { src: qmCanvas as CanvasImageSource, w: store.engine.width, h: store.engine.height };
      }
      let clone: Pt | null = null;
      const engineSrc = t === 'clone' ? (store.engine as { cloneSource?: () => Pt | null }).cloneSource?.() : null;
      if (engineSrc) clone = engineSrc;
      else if (t === 'clone' && cloneSrc) {
        if (cloneOff && hover) { const d = store.toDoc(hover.x, hover.y); clone = { x: d.x + cloneOff.dx, y: d.y + cloneOff.dy }; } else clone = cloneSrc;
      }
      const hideAnts = floating || qmOn;
      drawOverlay(overCtx, vw, vh, view, hideAnts ? null : store.engine.selection(), dash, cursor, {
        paths: mode === 'draw' || hideAnts ? null : selPaths, preview, guides, box, obox, quickMask, clone,
        crop: t === 'crop' ? store.cropBox.peek() : null, docW: store.engine.width, docH: store.engine.height, snap: store.snapLines.peek(),
      });
    };
    const buildQm = () => {
      qmDirty = false;
      const e = store.engine;
      const src = (e as { quickMaskSource?: () => CanvasImageSource | null }).quickMaskSource?.();
      if (src) { // the engine's doc-sized coverage canvas: tint it red at 50%
        if (!qmCanvas) qmCanvas = document.createElement('canvas');
        if (qmCanvas.width !== e.width || qmCanvas.height !== e.height) { qmCanvas.width = e.width; qmCanvas.height = e.height; }
        const c = qmCanvas.getContext('2d')!;
        c.globalCompositeOperation = 'source-over';
        c.clearRect(0, 0, e.width, e.height);
        c.drawImage(src, 0, 0);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = 'rgba(235,30,30,0.5)';
        c.fillRect(0, 0, e.width, e.height);
        c.globalCompositeOperation = 'source-over';
        return;
      }
      const m = e.selectionMask();
      if (!m) { qmCanvas = null; return; }
      const w = e.width, h = e.height;
      if (!qmCanvas) qmCanvas = document.createElement('canvas');
      if (qmCanvas.width !== w || qmCanvas.height !== h) { qmCanvas.width = w; qmCanvas.height = h; }
      const c = qmCanvas.getContext('2d')!;
      const img = c.createImageData(w, h), px = img.data;
      const full = m.alpha.length === w * h; // doc-sized coverage; a rect-sized array is tolerated
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let a = 0;
          if (full) a = m.alpha[y * w + x];
          else if (x >= m.rect.x && y >= m.rect.y && x < m.rect.x + m.rect.w && y < m.rect.y + m.rect.h) a = m.alpha[(y - m.rect.y) * m.rect.w + (x - m.rect.x)];
          const i = (y * w + x) * 4;
          px[i] = 235; px[i + 1] = 30; px[i + 2] = 30; px[i + 3] = a * 0.5;
        }
      }
      c.putImageData(img, 0, 0);
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
      if (ev.type === 'selection') { selDirty = true; qmDirty = true; hasSel = store.engine.selection() !== null; queueOver(); }
      if ((ev.type === 'pixels' || ev.type === 'surface') && store.engine.quickMask()) { qmDirty = true; queueOver(); }
      if (ev.type === 'structure') { store.syncTool(store.tool.peek()); queueOver(); }
      if (ev.type === 'resize') { store.cropBox.value = null; qmDirty = true; }
    });
    const stopWant = effect(() => { if (store.wantMove.value) { store.setTool('move'); store.wantMove.value = false; } });
    const stopSync = effect(() => { store.syncTool(store.tool.value); });
    const stopFx = effect(() => {
      store.view.value; store.viewMode.value; store.tdViewTick.value; store.tool.value; store.brush.value; store.spaceHeld.value; store.selectionVersion.value; store.cropBox.value; store.floatVersion.value;
      queueMain(); queueOver();
    });
    // v4 overlay-only inputs: guides, snap lines, the transform box follows the document spec
    const stopOverFx = effect(() => {
      store.docspecVersion.value; store.showGuides.value; store.guideDrag.value; store.snapLines.value; store.docVersion.value;
      queueOver();
    });
    // Marching ants only animate while visible: no timer while a floating selection or Quick Mask hides them.
    let ants: ReturnType<typeof setInterval> | null = null;
    const syncAnts = () => {
      const want = hasSel && store.engine.floating() === null && !store.engine.quickMask();
      if (want && !ants) ants = setInterval(() => { dash = (dash + 1) % 8; queueOver(); }, 120);
      else if (!want && ants) { clearInterval(ants); ants = null; }
    };
    syncAnts();
    const offAnts = store.engine.on((ev) => { if (ev.type === 'selection' || ev.type === 'structure') syncAnts(); });
    const stopAntsFx = effect(() => { store.floatVersion.value; store.selectionVersion.value; syncAnts(); });
    const onContext = (e: Event) => { if (mode === 'xform' && xo?.kind === 'skew') e.preventDefault(); }; // macOS: Ctrl+click would open the menu

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

    /** Free-transform drag (v5): move / scale / rotate / skew of a pixel layer, input layer or floating selection. */
    const dragOriented = (e: PointerEvent) => {
      if (!xo) return;
      const d = toolPointer(e), z = store.view.peek().zoom, eng = store.engine, snapOn = store.snapOn.peek();
      const { tg, t0 } = xo;
      let dx = d.x - xo.sx, dy = d.y - xo.sy, t = t0;
      const lines = { x: null as number | null, y: null as number | null };
      const r0 = boxAabb(t0, tg.w, tg.h);
      if (xo.kind === 'move') {
        const s = snapOn ? eng.snapRect(moveRect(r0, dx, dy), z) : { dx: 0, dy: 0, guideX: null, guideY: null };
        dx += s.dx; dy += s.dy; lines.x = s.guideX; lines.y = s.guideY;
        t = { ...t0, x: t0.x + dx, y: t0.y + dy };
      } else if (xo.kind === 'scale') {
        const h = xo.hit as Handle, { hx, hy } = handleSigns(h);
        if (snapOn && !d.shift && isAxisAligned(t0)) { // edges snap while the box is axis aligned
          const ex = (hx > 0 ? r0.x + r0.w : r0.x) + dx, ey = (hy > 0 ? r0.y + r0.h : r0.y) + dy;
          const s = eng.snapPoint(hx ? ex : r0.x, hy ? ey : r0.y, z);
          if (hx) { dx += s.x - ex; lines.x = s.guideX; }
          if (hy) { dy += s.y - ey; lines.y = s.guideY; }
        }
        t = scaleDrag(t0, tg.w, tg.h, h, dx, dy, { shift: d.shift, alt: d.alt });
      } else if (xo.kind === 'rotate') {
        t = rotateDrag(t0, tg.w, tg.h, { x: xo.sx, y: xo.sy }, { x: d.x, y: d.y }, d.shift);
        xo.info = { pointer: { x: d.x, y: d.y }, text: `${Math.round(t.rot * 10) / 10}\u00b0` };
      } else {
        t = skewDrag(t0, tg.w, tg.h, xo.hit as Handle, dx, dy);
      }
      tg.set(t);
      store.snapLines.value = lines;
      queueOver();
    };

    const dragCrop = (e: PointerEvent) => {
      if (!cropDrag) return;
      const d = toolPointer(e), cw = store.engine.width, ch = store.engine.height;
      if (cropDrag.kind === 'new') {
        const u = snapped(d, true);
        store.cropBox.value = clampCrop({ x: cropDrag.x0, y: cropDrag.y0, w: u.x - cropDrag.x0, h: u.y - cropDrag.y0 }, cw, ch);
      } else {
        const dx = d.x - cropDrag.sx, dy = d.y - cropDrag.sy, f = cropDrag.from;
        if (cropDrag.hit === 'move') {
          store.cropBox.value = { x: Math.min(cw - f.w, Math.max(0, f.x + dx)), y: Math.min(ch - f.h, Math.max(0, f.y + dy)), w: f.w, h: f.h };
        } else store.cropBox.value = clampCrop(scaleRect(f, cropDrag.hit as Handle, dx, dy, { shift: d.shift, alt: d.alt }), cw, ch);
      }
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
      if (mode === 'crop') {
        const b = store.cropBox.peek();
        if (cropDrag?.kind === 'new' && b && (b.w < 2 || b.h < 2)) store.cropBox.value = null; // a click, not a drag
      }
      if (mode === 'draw' && store.tool.peek() === 'clone' && !store.cloneOpts.peek().aligned) cloneOff = null;
      mode = null; activeId = null; lastTool = null; lasso = null; shapeDrag = null; xf = null; xo = null; cropDrag = null; guideGrab = null;
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
        const tg = orientedTarget(store);
        const gridGuide = store.showGuides.peek() ? hitGuide(store.view.peek(), store.engine.guides(), p.x, p.y) : null;
        const b = !tg && l && store.canEditTransform(l) ? store.engine.layerBounds(l.id) : null;
        const hit: BoxHit | OHit | null = tg ? hitOriented(store.view.peek(), tg.t, tg.w, tg.h, p.x, p.y) : b ? hitBox(store.view.peek(), b, p.x, p.y) : null;
        // a guide wins over the box body (and the rotate zone), a handle wins over a guide
        if (gridGuide && (!hit || hit === 'move' || hit === 'rotate')) {
          mode = 'guide'; activeId = e.pointerId; guideGrab = gridGuide;
          capture(el, e.pointerId);
          store.guideDragMove(gridGuide.axis, gridGuide.index, e.clientX, e.clientY);
          queueOver();
          return;
        }
        if (tg) {
          if (!hit) return;
          const d = toolPointer(e), edge = hit !== 'move' && hit !== 'rotate' && (handleSigns(hit).hx === 0) !== (handleSigns(hit).hy === 0);
          mode = 'xform'; activeId = e.pointerId;
          capture(el, e.pointerId);
          xo = { tg, t0: { ...tg.t }, hit, kind: hit === 'move' ? 'move' : hit === 'rotate' ? 'rotate' : d.ctrl && edge ? 'skew' : 'scale', sx: d.x, sy: d.y, info: null };
          return;
        }
        if (l && !store.canEditTransform(l)) { if (l.locked) store.setNotice('Layer is locked'); return; }
        if (!l || !b || !hit || hit === 'rotate') return;
        const d = toolPointer(e);
        mode = 'xform'; activeId = e.pointerId;
        capture(el, e.pointerId);
        xf = { layer: l, from: b, hit, sx: d.x, sy: d.y };
        return;
      }
      if (tool === 'crop') {
        const d = snapped(toolPointer(e), true), box = store.cropBox.peek();
        const hit = box ? hitBox(store.view.peek(), box, p.x, p.y) : null;
        mode = 'crop'; activeId = e.pointerId;
        capture(el, e.pointerId);
        if (box && hit) cropDrag = { kind: 'edit', hit, from: box, sx: d.x, sy: d.y };
        else {
          const cw = store.engine.width, ch = store.engine.height;
          cropDrag = { kind: 'new', x0: Math.min(cw, Math.max(0, d.x)), y0: Math.min(ch, Math.max(0, d.y)) };
          store.cropBox.value = null;
        }
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
      if (tool === 'clone') {
        if (lastTool.alt) { cloneSrc = { x: lastTool.x, y: lastTool.y }; cloneOff = null; }
        else if (cloneSrc && (!store.cloneOpts.peek().aligned || !cloneOff)) cloneOff = { dx: cloneSrc.x - lastTool.x, dy: cloneSrc.y - lastTool.y };
        queueOver();
      }
      if (tool === 'lasso') lasso = [{ x: lastTool.x, y: lastTool.y }];
      store.engine.pointerDown(lastTool);
    };
    const onMove = (e: PointerEvent) => {
      if (activeId !== null && e.pointerId !== activeId) return;
      const p = local(e);
      hover = p;
      store.cursorPos.value = p;
      if (mode === 'xform') {
        if (xo) dragOriented(e); else dragTransform(e);
      } else if (mode === 'crop') {
        dragCrop(e);
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
      if (PAINT_TOOLS.has(t)) queueOver();
      if (!mode && t === 'move') hoverCursor(p, e.ctrlKey || e.metaKey);
      if (!mode && t === 'crop') {
        const box = store.cropBox.peek(), hit = box ? hitBox(store.view.peek(), box, p.x, p.y) : null;
        el.style.cursor = hit && hit !== 'move' ? HANDLE_CURSOR[hit as Handle] : hit ? 'move' : 'crosshair';
      }
    };
    /** Move tool, nothing pressed: show what a drag would do. */
    const hoverCursor = (p: { x: number; y: number }, ctrl = false) => {
      if (store.spaceHeld.peek() || !store.hasEngine()) return;
      const view = store.view.peek();
      const g = store.showGuides.peek() ? hitGuide(view, store.engine.guides(), p.x, p.y) : null;
      const tg = orientedTarget(store);
      if (tg) {
        const oh = hitOriented(view, tg.t, tg.w, tg.h, p.x, p.y);
        if (g && (!oh || oh === 'move' || oh === 'rotate')) el.style.cursor = g.axis === 'h' ? 'row-resize' : 'col-resize';
        else el.style.cursor = cursorFor(oh, tg.t, tg.w, tg.h, ctrl);
        return;
      }
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
      el.style.cursor = store.spaceHeld.peek() || t === 'hand' ? 'grab' : PAINT_TOOLS.has(t) ? 'none' : t === 'move' ? 'default' : mouseCursor[t] || 'default';
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
    el.addEventListener('contextmenu', onContext);
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
      shownGl?.remove(); ro.disconnect(); off(); stopWant(); stopSync(); stopFx(); stopOverFx(); stopCursor(); if (ants) clearInterval(ants);
      offAnts(); stopAntsFx();
      el.removeEventListener('contextmenu', onContext);
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
  return (
    <div ref={host} data-viewport style="flex:1 1 auto;min-height:0;position:relative;overflow:hidden;background:#1c1c1c;touch-action:none">
      <canvas ref={main} style={layer} />
      <canvas ref={over} style={layer + ';pointer-events:none'} />
      {store.textEdit.value && <TextEditor />}
    </div>
  );
}
