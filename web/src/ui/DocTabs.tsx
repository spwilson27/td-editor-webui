import { store } from '../state/store';
import { formatZoom } from '../state/view';

export function DocTabs() {
  const { w, h } = store.docSize.value;
  return (
    <div style="height:30px;flex:none;display:flex;align-items:flex-end;gap:2px;padding:0 8px;background:#242424;border-bottom:1px solid #161616">
      <div style="height:26px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#1c1c1c;border:1px solid #161616;border-bottom:0;border-radius:5px 5px 0 0">
        <span>{store.docName.value}</span>
        <span style="color:#9a9a9a">{w} × {h} · RGBA/8 · {formatZoom(store.zoom.value)}</span>
        <button class="ib" aria-label="Close document" aria-disabled="true" title="Not in this version" style="width:18px;height:18px">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </div>
  );
}
