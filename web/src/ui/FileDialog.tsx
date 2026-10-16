import { useEffect, useRef } from 'preact/hooks';
import { FILE_LABELS } from '../state/filesSlice';
import { store } from '../state/store';

const DONE: Record<string, string> = { saveProject: 'Saved to', openProject: 'Opened', exportPng: 'Exported' };

/** File ▸ Save Project… / Open Project… / Export PNG…: a path on the TouchDesigner machine (TD writes/reads the file). */
export function FileDialog() {
  const d = store.fileDialog.value;
  const ref = useRef<HTMLInputElement>(null);
  const op = d?.op;
  useEffect(() => {
    if (!op) return;
    ref.current?.focus();
    ref.current?.select();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') store.closeFileDialog(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [op]);
  // a successful Open closes itself (TD then sends reload)
  const opened = !!d && d.op === 'openProject' && d.result?.ok === true;
  useEffect(() => { if (opened) store.closeFileDialog(); }, [opened]);
  const linked = store.connection.value === 'linked';
  // a dropped connection closes the dialog (that also releases the keyboard, which dialogs swallow)
  useEffect(() => { if (!linked && store.fileDialog.peek()) store.closeFileDialog(); }, [linked, op]);
  if (!d || !linked) return null;

  const close = () => store.closeFileDialog();
  const ok = () => { if (!d.busy) void store.runFileOp(); };
  const title = FILE_LABELS[d.op];
  const r = d.result;
  return (
    <div data-file-dialog={d.op} role="dialog" aria-label={title} onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style="position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:rgba(20,20,20,0.55)">
      <div style="width:400px;max-width:92vw;display:flex;flex-direction:column;gap:12px;padding:16px;background:#2b2b2b;border:1px solid #161616;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.6)">
        <div style="font-size:14px;font-weight:600">{title}</div>
        <label for="file-path" style="display:flex;flex-direction:column;gap:6px;color:#a8a8a8">
          <span>{d.op === 'exportPng' ? 'PNG file path' : 'Project file path'}</span>
          <span style="display:flex;gap:6px">
          <input id="file-path" ref={ref} data-file-path type="text" spellcheck={false} value={d.path} disabled={d.busy} aria-label="File path"
            onInput={(e) => store.setFilePath((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); else if (e.key === 'Escape') close(); }}
            style="flex:1 1 auto;min-width:0;height:26px;box-sizing:border-box;padding:0 6px;color:#e3e3e3;background:#1f1f1f;border:1px solid #474747;border-radius:4px" />
          </span>
        </label>
        {d.op === 'saveProject' && (
          <label style="display:flex;align-items:flex-start;gap:8px;color:#e3e3e3">
            <input type="checkbox" data-file-history aria-label="Include undo history" checked={d.includeHistory} disabled={d.busy} style="accent-color:#4a8fe0;margin:2px 0 0"
              onChange={(e) => store.setIncludeHistory((e.target as HTMLInputElement).checked)} />
            <span>Include undo history<br /><span style="color:#8f8f8f;font-size:11px">Lets you undo after reopening. Erased or deleted content stays recoverable from the history, so turn this off before sharing the file.</span></span>
          </label>
        )}
        <div data-file-help style="color:#8f8f8f;font-size:11px">Written by TouchDesigner on its machine.</div>
        {d.op === 'openProject' && <div data-file-warning style="color:#d9a441;font-size:11px">Replaces the current document; history is cleared.</div>}
        {d.busy && <div data-file-busy style="color:#a8a8a8">Working…</div>}
        {r && !d.busy && (r.ok
          ? <div data-file-result="ok" style="color:#7fc77f;word-break:break-all">{DONE[r.op] ?? 'Done'} {r.path}</div>
          : <div data-file-result="error" role="alert" style="color:#e5483c;word-break:break-word">{r.msg || `${title} failed`}</div>)}
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button data-file-cancel onClick={close} style="height:28px;padding:0 14px;border:1px solid #474747;border-radius:5px;background:#262626">{r?.ok ? 'Close' : 'Cancel'}</button>
          <button data-file-ok aria-disabled={d.busy} disabled={d.busy} onClick={ok}
            style={`height:28px;padding:0 16px;border-radius:5px;background:#3d6fb4;color:#fff;font-weight:600;opacity:${d.busy ? 0.5 : 1}`}>OK</button>
        </div>
      </div>
    </div>
  );
}
