import { store } from '../state/store';

export function StandbyOverlay() {
  if (store.active.value) return null;
  return (
    <div role="dialog" aria-label="Editing in another window" data-standby
      style="position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(20,20,20,0.78)">
      <div style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 36px;background:#2b2b2b;border:1px solid #161616;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.6)">
        <div style="font-size:15px;font-weight:600">Editing in another window</div>
        <div style="color:#a8a8a8">Your document is kept here. Take over to continue editing in this window.</div>
        <button onClick={() => store.takeover?.()} style="height:30px;padding:0 18px;border-radius:5px;background:#3d6fb4;color:#fff;font-weight:600">Take over</button>
      </div>
    </div>
  );
}
