import { store } from '../state/store';
import { toolInfo } from '../state/tools';

const CONN = {
  linked: { label: 'TouchDesigner linked', dot: '#5cc27a' },
  standalone: { label: 'Standalone', dot: '#8a8a8a' },
  reconnecting: { label: 'Reconnecting…', dot: '#e0a030' },
};

export function StatusBar() {
  store.docVersion.value;
  const e = store.hasEngine() ? store.engine : null;
  const id = e?.activeLayerId();
  const layer = e?.layers().find((l) => l.id === id);
  const conn = CONN[store.connection.value];
  const notice = store.notice.value;
  const fatal = store.fatal.value;
  return (
    <div style="height:26px;flex:none;display:flex;align-items:center;gap:16px;padding:0 12px;background:#2b2b2b;border-top:1px solid #161616;color:#b5b5b5">
      <span data-status="hint" style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{toolInfo(store.tool.value).hint}</span>
      {fatal && <span data-status="fatal" style="color:#f07a6a;font-weight:600">{fatal}</span>}
      {notice && <span data-status="notice" style="color:#f0b45a">{notice}</span>}
      <span>Layer: <b data-status="layer" style="color:#e3e3e3;font-weight:500">{layer ? layer.name : '—'}</b></span>
      <span data-status="connection" style="display:flex;align-items:center;gap:6px">
        <span aria-hidden="true" style={`width:7px;height:7px;border-radius:50%;background:${conn.dot}`} />{conn.label}
      </span>
    </div>
  );
}
