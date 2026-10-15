import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { store } from '../state/store';
import { rulerTicks } from '../state/transform';
import { capture } from './capture';
import { Viewport } from './Viewport';

export const RULER_SIZE = 18;
const BG = '#2b2b2b', EDGE = '#161616', TICK = '#8f8f8f', TEXT = '#b5b5b5', MARK = '#e2683c';

function Ruler({ axis }: { axis: 'top' | 'left' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, ctx = c.getContext('2d')!, m = mark.current!, mctx = m.getContext('2d')!;
    let w = 0, h = 0, queued = false, markQueued = false;
    const top = axis === 'top';
    const paint = () => {
      queued = false;
      if (!w || !h) return;
      ctx.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
      const v = store.view.peek();
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = EDGE;
      if (top) ctx.fillRect(0, h - 1, w, 1); else ctx.fillRect(w - 1, 0, 1, h);
      const length = top ? w : h, origin = top ? v.x : v.y;
      const { step, ticks } = rulerTicks(v.zoom, origin, length);
      c.dataset.step = String(step);
      ctx.strokeStyle = TICK;
      ctx.fillStyle = TEXT;
      ctx.lineWidth = 1;
      ctx.font = '9px -apple-system,BlinkMacSystemFont,sans-serif';
      ctx.textBaseline = 'top';
      ctx.beginPath();
      for (const t of ticks) {
        const s = Math.round(t.screen) + 0.5;
        if (s < 0 || s > length) continue;
        const len = t.level === 0 ? RULER_SIZE - 2 : t.level === 1 ? 8 : 4;
        if (top) { ctx.moveTo(s, RULER_SIZE - 1); ctx.lineTo(s, RULER_SIZE - 1 - len); } else { ctx.moveTo(RULER_SIZE - 1, s); ctx.lineTo(RULER_SIZE - 1 - len, s); }
      }
      ctx.stroke();
      for (const t of ticks) {
        if (t.level !== 0 || t.screen < -50 || t.screen > length + 50) continue;
        const label = String(t.pos);
        if (top) ctx.fillText(label, t.screen + 3, 1);
        else { ctx.save(); ctx.translate(1, t.screen - 3); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'left'; ctx.fillText(label, 0, 0); ctx.restore(); }
      }
    };
    // the cursor marker lives on its own transparent canvas: pointer moves never repaint the ticks
    const paintMark = () => {
      markQueued = false;
      if (!w || !h) return;
      mctx.setTransform(m.width / w, 0, 0, m.height / h, 0, 0);
      mctx.clearRect(0, 0, w, h);
      const cur = store.cursorPos.peek();
      if (cur) {
        const at = Math.round(top ? cur.x : cur.y) + 0.5;
        mctx.strokeStyle = MARK;
        mctx.lineWidth = 1;
        mctx.beginPath();
        if (top) { mctx.moveTo(at, 0); mctx.lineTo(at, h); } else { mctx.moveTo(0, at); mctx.lineTo(w, at); }
        mctx.stroke();
        c.dataset.cursor = String(Math.round(top ? cur.x : cur.y));
      } else delete c.dataset.cursor;
    };
    const queueMark = () => { if (!markQueued) { markQueued = true; requestAnimationFrame(paintMark); } };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
    const resize = () => {
      const r = c.getBoundingClientRect();
      w = r.width; h = r.height;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      m.width = c.width; m.height = c.height;
      queue(); queueMark();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();
    const stop = effect(() => { store.view.value; store.docSize.value; queue(); queueMark(); });
    const stopMark = effect(() => { store.cursorPos.value; queueMark(); });
    return () => { ro.disconnect(); stop(); stopMark(); };
  }, [axis]);

  // Drag from a ruler: a new guide (horizontal from the top ruler, vertical from the left one).
  const guideAxis = axis === 'top' ? 'h' : 'v';
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || store.loadingDoc.peek()) return;
    e.preventDefault();
    capture(e.currentTarget as Element, e.pointerId);
    store.guideDragMove(guideAxis, null, e.clientX, e.clientY);
  };
  const move = (e: PointerEvent) => {
    if (store.guideDrag.peek()?.index === null) store.guideDragMove(guideAxis, null, e.clientX, e.clientY);
  };
  const up = (e: PointerEvent) => {
    if (store.guideDrag.peek()?.index !== null) return;
    store.guideDragMove(guideAxis, null, e.clientX, e.clientY);
    store.guideDragEnd(true);
  };
  const cancel = () => { if (store.guideDrag.peek()?.index === null) store.guideDragEnd(false); };
  const style = axis === 'top' ? `height:${RULER_SIZE}px;flex:1 1 auto;min-width:0` : `width:${RULER_SIZE}px;flex:none`;
  return (
    <div style={`${style};position:relative`}>
      <canvas ref={ref} data-ruler={axis} aria-label={`${axis === 'top' ? 'Horizontal' : 'Vertical'} ruler`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
        style={`position:absolute;inset:0;width:100%;height:100%;display:block;cursor:${axis === 'top' ? 'row-resize' : 'col-resize'};touch-action:none`} />
      <canvas ref={mark} aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none" />
    </div>
  );
}

/** The viewport with optional pixel rulers on the top and left (View ▸ Show Rulers). The viewport element itself keeps its own coordinates. */
export function ViewportFrame() {
  const on = store.showRulers.value;
  return (
    <div data-viewport-frame style="flex:1 1 auto;min-height:0;min-width:0;display:flex;flex-direction:column">
      {on && (
        <div style={`height:${RULER_SIZE}px;flex:none;display:flex`}>
          <div data-ruler-corner style={`width:${RULER_SIZE}px;flex:none;background:${BG};border-right:1px solid ${EDGE};border-bottom:1px solid ${EDGE};box-sizing:border-box`} />
          <Ruler axis="top" />
        </div>
      )}
      <div style="flex:1 1 auto;min-height:0;min-width:0;display:flex">
        {on && <Ruler axis="left" />}
        <Viewport />
      </div>
    </div>
  );
}
