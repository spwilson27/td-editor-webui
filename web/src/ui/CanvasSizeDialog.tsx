import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Anchor } from '../engine/types';
import { store } from '../state/store';

const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
const ANCHOR_LABEL: Record<Anchor, string> = {
  tl: 'top left', t: 'top', tr: 'top right', l: 'left', c: 'centre', r: 'right', bl: 'bottom left', b: 'bottom', br: 'bottom right',
};
const ARROWS: Record<Anchor, string> = { tl: '↖', t: '↑', tr: '↗', l: '←', c: '●', r: '→', bl: '↙', b: '↓', br: '↘' };

/** Document ▸ Canvas Size…: width, height and a 9-point anchor; "Follow Input Size" returns to tracking the TD Input. */
export function CanvasSizeDialog() {
  const open = store.canvasDialog.value;
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const [anchor, setAnchor] = useState<Anchor>('c');
  const wRef = useRef<HTMLInputElement>(null);
  const size = store.docSize.value, mode = store.canvasMode.value;

  // the fields start from the current size; layout effect = before the user can type into them
  useLayoutEffect(() => {
    if (!open) return;
    const s = store.docSize.peek();
    setW(String(s.w)); setH(String(s.h)); setAnchor('c');
  }, [open]);
  useEffect(() => {
    if (!open) return;
    wRef.current?.focus();
    wRef.current?.select();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') store.canvasDialog.value = false; };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  if (!open) return null;
  const close = () => { store.canvasDialog.value = false; };
  const nw = Math.round(Number(w)), nh = Math.round(Number(h));
  const valid = nw >= 1 && nh >= 1 && nw <= 8192 && nh <= 8192;
  const ok = () => { if (!valid) return; store.setCanvasSize(nw, nh, anchor); close(); };
  const follow = () => { store.followInput(); close(); };
  const field = (id: string, label: string, value: string, set: (v: string) => void, ref?: typeof wRef) => (
    <label for={id} style="display:flex;align-items:center;gap:8px;color:#a8a8a8">
      <span style="width:46px">{label}</span>
      <input id={id} ref={ref} data-canvas-field={id} type="number" min={1} max={8192} value={value} aria-label={`${label} (px)`} title="1 to 8192 px" 
        onInput={(e) => set((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); else if (e.key === 'Escape') close(); }}
        style="width:80px;height:26px;box-sizing:border-box;padding:0 6px;text-align:right;color:#e3e3e3;background:#1f1f1f;border:1px solid #474747;border-radius:4px" />
      <span>px</span>
    </label>
  );
  return (
    <div data-canvas-dialog role="dialog" aria-label="Canvas Size" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style="position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:rgba(20,20,20,0.55)">
      <div style="width:340px;max-width:92vw;display:flex;flex-direction:column;gap:12px;padding:16px;background:#2b2b2b;border:1px solid #161616;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.6)">
        <div style="font-size:14px;font-weight:600">Canvas Size</div>
        <div data-canvas-current style="color:#a8a8a8">
          Current: <b style="color:#e3e3e3;font-weight:500">{size.w} × {size.h} px</b> · {mode === 'input' ? 'Following the TouchDesigner input' : 'Fixed size'}
        </div>
        <div style="display:flex;gap:18px;align-items:center">
          <div style="display:flex;flex-direction:column;gap:8px">
            {field('cw', 'Width', w, setW, wRef)}
            {field('ch', 'Height', h, setH)}
          </div>
          <div role="group" aria-label="Anchor" data-anchor-grid style="display:grid;grid-template-columns:repeat(3,26px);grid-auto-rows:26px;gap:2px">
            {ANCHORS.map((a) => (
              <button key={a} data-anchor={a} aria-label={`Anchor ${ANCHOR_LABEL[a]}`} aria-pressed={anchor === a} title={`Anchor ${ANCHOR_LABEL[a]}`} onClick={() => setAnchor(a)}
                style={`border:1px solid #474747;border-radius:3px;color:${anchor === a ? '#ffffff' : '#8f8f8f'};background:${anchor === a ? '#3d6fb4' : '#1f1f1f'}`}>{ARROWS[a]}</button>
            ))}
          </div>
        </div>
        <div style="color:#8f8f8f;font-size:11px">Existing pixels are not resampled. The anchor decides how layers shift when the canvas grows or shrinks.</div>
        <div style="display:flex;justify-content:space-between;gap:8px">
          <button data-follow-input title="The document size tracks the TouchDesigner Input resolution" onClick={follow}
            style={`height:28px;padding:0 12px;border:1px solid #474747;border-radius:5px;background:#262626;${mode === 'input' ? 'color:#8f8f8f' : ''}`}>Follow Input Size</button>
          <div style="display:flex;gap:8px">
            <button onClick={close} style="height:28px;padding:0 14px;border:1px solid #474747;border-radius:5px;background:#262626">Cancel</button>
            <button data-canvas-ok aria-disabled={!valid} onClick={ok}
              style={`height:28px;padding:0 16px;border-radius:5px;background:#3d6fb4;color:#fff;font-weight:600;opacity:${valid ? 1 : 0.5}`}>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}
