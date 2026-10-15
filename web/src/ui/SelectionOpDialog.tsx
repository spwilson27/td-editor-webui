import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { store } from '../state/store';
import { MAX_SEL_PX } from '../engine/selectionOps';
import type { SelectionOp } from '../state/toolsSlice';

const TITLES: Record<SelectionOp, string> = {
  grow: 'Grow Selection', shrink: 'Shrink Selection', smooth: 'Smooth Selection', feather: 'Feather Selection', border: 'Border Selection',
};
const HINTS: Record<SelectionOp, string> = {
  grow: 'Expands the selection edge outwards.', shrink: 'Contracts the selection edge inwards.', smooth: 'Rounds off jagged corners.',
  feather: 'Softens the selection edge; 0 px leaves it hard.', border: 'Keeps a band of this width along the selection edge.',
};

/** Select ▸ Grow / Shrink / Smooth / Feather / Border…: one pixel amount. */
export function SelectionOpDialog() {
  const op = store.selOpDialog.value;
  const [px, setPx] = useState('4');
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (op) setPx('4'); }, [op]);
  useEffect(() => {
    if (!op) return;
    ref.current?.focus();
    ref.current?.select();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') store.selOpDialog.value = null; };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [op]);
  if (!op) return null;
  const min = op === 'feather' ? 0 : 1, n = Math.round(Number(px));
  const valid = px.trim() !== '' && Number.isFinite(n) && n >= min && n <= MAX_SEL_PX;
  const close = () => { store.selOpDialog.value = null; };
  const ok = () => { if (valid) store.applySelectionOp(op, n); };
  return (
    <div data-selop-dialog={op} role="dialog" aria-label={TITLES[op]} onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style="position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:rgba(20,20,20,0.55)">
      <div style="width:300px;max-width:92vw;display:flex;flex-direction:column;gap:12px;padding:16px;background:#2b2b2b;border:1px solid #161616;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.6)">
        <div style="font-size:14px;font-weight:600">{TITLES[op]}</div>
        <label for="selop-px" style="display:flex;align-items:center;gap:8px;color:#a8a8a8">
          <span style="width:56px">{op === 'feather' ? 'Radius' : 'Amount'}</span>
          <input id="selop-px" ref={ref} data-selop-field type="number" min={min} max={MAX_SEL_PX} value={px} aria-label={`${op === 'feather' ? 'Radius' : 'Amount'} (px)`} title={`${min} to ${MAX_SEL_PX} px`}
            onInput={(e) => setPx((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); else if (e.key === 'Escape') close(); }}
            style="width:80px;height:26px;box-sizing:border-box;padding:0 6px;text-align:right;color:#e3e3e3;background:#1f1f1f;border:1px solid #474747;border-radius:4px" />
          <span>px</span>
        </label>
        <div style="color:#8f8f8f;font-size:11px">{HINTS[op]}</div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button data-selop-cancel onClick={close} style="height:28px;padding:0 14px;border:1px solid #474747;border-radius:5px;background:#262626">Cancel</button>
          <button data-selop-ok aria-disabled={!valid} onClick={ok}
            style={`height:28px;padding:0 16px;border-radius:5px;background:#3d6fb4;color:#fff;font-weight:600;opacity:${valid ? 1 : 0.5}`}>OK</button>
        </div>
      </div>
    </div>
  );
}
