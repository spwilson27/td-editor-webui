import { store } from '../state/store';
import { toolInfo } from '../state/tools';
import type { LatencyStats } from '../bridge/tdBridge';

const CONN = {
  linked: { label: 'TouchDesigner linked', dot: '#5cc27a' },
  standalone: { label: 'Standalone', dot: '#8a8a8a' },
  reconnecting: { label: 'Reconnecting…', dot: '#e0a030' },
};

const fmt = (ms: number) => `${Math.round(ms)} ms`;

function ViewToggle() {
  const mode = store.viewMode.value, ok = store.tdAvailable.value;
  const seg = (id: 'local' | 'td', label: string) => {
    const on = mode === id, off = id === 'td' && !ok;
    return (
      <button key={id} data-view-mode={id} aria-pressed={on} aria-disabled={off}
        title={off ? 'TouchDesigner view needs a TouchDesigner connection' : id === 'td' ? "Show TouchDesigner's output" : 'Show the browser preview'}
        onClick={() => { if (!off) store.setViewMode(id); }}
        style={`height:18px;padding:0 9px;border-radius:3px;color:${on ? '#ffffff' : off ? '#6f6f6f' : '#b5b5b5'};background:${on ? '#3f3f3f' : 'transparent'}`}>
        {label}
      </button>
    );
  };
  return (
    <div role="group" aria-label="View mode" style="display:flex;gap:1px;padding:1px;background:#1f1f1f;border:1px solid #3a3a3a;border-radius:5px">
      {seg('local', 'Local')}{seg('td', 'TD')}
    </div>
  );
}

/** v12: "Keep live" (never idle, also with a hidden tab) and the "Paused (idle)" badge while TD's streams to this page are paused. */
function KeepLive() {
  const on = store.keepLive.value, paused = store.streamsPaused.value && store.connection.value === 'linked';
  return (
    <span style="display:flex;align-items:center;gap:6px">
      <button data-keep-live aria-pressed={on} title="Keep TouchDesigner streaming to this page even when it is idle or in a background tab"
        onClick={() => store.setKeepLive(!on)}
        style={`height:18px;padding:0 8px;border-radius:3px;border:1px solid #3a3a3a;font:inherit;color:${on ? '#ffffff' : '#b5b5b5'};background:${on ? '#3f3f3f' : '#1f1f1f'}`}>
        Keep live
      </button>
      {paused && (
        <span data-status="paused" title="No input for a while (or the tab is hidden): TouchDesigner stopped streaming frames to this page. Any input resumes."
          style="padding:0 6px;border-radius:3px;background:#1f1f1f;color:#e0a030">
          Paused (idle)
        </span>
      )}
    </span>
  );
}

const QUALITIES: { id: 'auto' | 'fast' | 'exact'; label: string; title: string }[] = [
  { id: 'auto', label: 'Auto', title: 'Low-latency frames while anything changes, then one exact frame when it settles' },
  { id: 'fast', label: 'Low latency', title: 'Always the fast, approximate (JPEG) preview' },
  { id: 'exact', label: 'Accurate', title: 'Only bit-exact frames at full document resolution (slower)' },
];

/** v11: Auto / Low latency / Accurate for the TD view, plus a badge for the kind of frame on screen ("≈" fast, "exact"). */
function ViewQuality() {
  const q = store.viewQuality.value, ok = store.tdAvailable.value, td = store.viewMode.value === 'td';
  const shown = td ? store.viewShown.value : null;
  return (
    <span style="display:flex;align-items:center;gap:6px">
      <select data-view-quality aria-label="TouchDesigner view quality" value={q} disabled={!ok}
        title={QUALITIES.find((o) => o.id === q)!.title}
        onChange={(e) => store.setViewQuality((e.currentTarget as HTMLSelectElement).value as 'auto' | 'fast' | 'exact')}
        style="height:20px;background:#1f1f1f;color:#b5b5b5;border:1px solid #3a3a3a;border-radius:4px;font:inherit;padding:0 2px">
        {QUALITIES.map((o) => <option key={o.id} value={o.id} selected={o.id === q}>{o.label}</option>)}
      </select>
      {shown && (
        <span data-status="view-frame" data-kind={shown} title={shown === 'fast' ? 'Low-latency preview (approximate)' : 'Exact frame (bit-exact, full resolution)'}
          style={`min-width:34px;text-align:center;padding:0 5px;border-radius:3px;background:#1f1f1f;color:${shown === 'exact' ? '#5cc27a' : '#e0a030'}`}>
          {shown === 'fast' ? '≈' : 'exact'}
        </span>
      )}
    </span>
  );
}

function LatencyReadout() {
  if (store.connection.value !== 'linked') return null;
  const stroke: LatencyStats = store.latency.value, vl = store.viewLatency.value, age = store.viewAge.value;
  const td = store.viewMode.value === 'td';
  const ext = td;
  return (
    <span data-status="latency" title={stroke.n ? `median ${fmt(stroke.median)}, p95 ${fmt(stroke.p95)} over ${stroke.n} strokes` : 'no samples yet'}>
      stroke → TD {stroke.n ? fmt(stroke.median) : '—'}
      {ext && <span data-status="view-age"> · view age {age === null ? '—' : fmt(age)}{vl.n ? ` · stroke → view ${fmt(vl.median)}` : ''}</span>}
    </span>
  );
}

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
      <span data-status="canvas" title={store.canvasMode.value === 'input' ? 'Document size follows the TouchDesigner Input' : 'Fixed document size (Document ▸ Canvas Size…)'}>
        {store.docSize.value.w} × {store.docSize.value.h} · {store.canvasMode.value === 'input' ? 'Follow input' : 'Fixed'}
      </span>
      <span>Layer: <b data-status="layer" style="color:#e3e3e3;font-weight:500">{layer ? layer.name : '—'}</b></span>
      <ViewToggle />
      <ViewQuality />
      <KeepLive />
      <LatencyReadout />
      <span data-status="connection" style="display:flex;align-items:center;gap:6px">
        <span aria-hidden="true" style={`width:7px;height:7px;border-radius:50%;background:${conn.dot}`} />{conn.label}
      </span>
    </div>
  );
}
