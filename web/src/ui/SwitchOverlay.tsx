import { store } from '../state/store';

/** v10: shown while an editor switch is pending. Editing is blocked (the regions are inert, keys are ignored); the tab strip stays clickable so the switch can be cancelled by clicking the current tab. */
export function SwitchOverlay() {
  const s = store.switchTarget.value;
  if (!s) return null;
  return (
    <div data-switching role="status" aria-live="polite" aria-label={`Switching to ${s.to}`}
      style="position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(20,20,20,0.45);cursor:progress">
      <div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 24px;background:#2b2b2b;border:1px solid #161616;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.6)">
        <div data-switching-title style="font-size:14px;font-weight:600">Switching to {s.to}…</div>
        {s.waiting && <div data-switching-wait style="color:#a8a8a8">Waiting for TouchDesigner to reconnect so the changes can be sent. Click the current tab to stay.</div>}
      </div>
    </div>
  );
}

/** v10: the open editor has changes TouchDesigner has not received (it is reconnecting). */
export function DiscardDialog() {
  const d = store.discardAsk.value;
  if (!d) return null;
  return (
    <div data-discard-dialog role="alertdialog" aria-label="Unsent changes" aria-describedby="discard-msg"
      style="position:fixed;inset:0;z-index:96;display:flex;align-items:center;justify-content:center;background:rgba(20,20,20,0.6)">
      <div style="width:380px;max-width:92vw;display:flex;flex-direction:column;gap:12px;padding:16px;background:#2b2b2b;border:1px solid #161616;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.6)">
        <div style="font-size:14px;font-weight:600">Unsent changes</div>
        <div id="discard-msg" style="color:#c8c8c8">This editor has unsent changes and TouchDesigner is reconnecting. <span style="color:#8f8f8f">({d.from})</span></div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button data-discard-discard onClick={() => store.answerDiscard('discard')} style="height:28px;padding:0 14px;border:1px solid #474747;border-radius:5px;background:#262626">Discard &amp; switch</button>
          <button data-discard-wait autofocus onClick={() => store.answerDiscard('wait')} style="height:28px;padding:0 16px;border-radius:5px;background:#3d6fb4;color:#fff;font-weight:600">Wait</button>
        </div>
      </div>
    </div>
  );
}
