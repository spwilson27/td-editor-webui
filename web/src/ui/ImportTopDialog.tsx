import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TopItem } from '../bridge/codec';
import { store } from '../state/store';

/** File > Import from TouchDesigner…: lists the project's TOPs, copies the chosen one in as a pixel layer. */
export function ImportTopDialog() {
  const open = store.topDialog.value;
  const [items, setItems] = useState<TopItem[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setItems(null); setError(''); setFilter(''); setPicked(null); setBusy(false);
    const api = store.bridge;
    if (!api) { setError('Not connected to TouchDesigner'); return; }
    api.listTops().then((l) => { if (live) setItems(l); }).catch((e: Error) => { if (live) setError(e.message); });
    filterRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') store.topDialog.value = false; };
    window.addEventListener('keydown', esc);
    return () => { live = false; window.removeEventListener('keydown', esc); };
  }, [open]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (items ?? []).filter((i) => !f || i.path.toLowerCase().includes(f));
  }, [items, filter]);

  if (!open) return null;
  const close = () => { store.topDialog.value = false; };
  const doImport = async (path: string | null) => {
    if (!path || busy || !store.bridge) return;
    setBusy(true); setError('');
    try {
      await store.bridge.importTop(path);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div data-top-dialog role="dialog" aria-label="Import from TouchDesigner" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style="position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:rgba(20,20,20,0.55)">
      <div style="width:520px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;gap:10px;padding:16px;background:#2b2b2b;border:1px solid #161616;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.6)">
        <div style="font-size:14px;font-weight:600">Import from TouchDesigner</div>
        <div style="color:#a8a8a8">Pick a TOP. Its current image is copied in once as a new layer.</div>
        <input ref={filterRef} data-top-filter type="search" placeholder="Filter by path" aria-label="Filter TOPs" value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doImport(picked ?? (shown.length === 1 ? shown[0].path : null)); }}
          style="height:26px;box-sizing:border-box;padding:0 8px;color:#e3e3e3;background:#1f1f1f;border:1px solid #474747;border-radius:4px" />
        <div data-top-list role="listbox" aria-label="TOPs" style="min-height:140px;max-height:320px;overflow-y:auto;background:#1f1f1f;border:1px solid #474747;border-radius:4px">
          {items === null && !error && <div style="padding:12px;color:#a8a8a8">Asking TouchDesigner…</div>}
          {items !== null && shown.length === 0 && <div style="padding:12px;color:#a8a8a8">{items.length ? 'No TOP matches the filter' : 'No TOPs found in the project'}</div>}
          {shown.map((i) => (
            <button key={i.path} role="option" aria-selected={picked === i.path} data-top-path={i.path} class="mi"
              onClick={() => setPicked(i.path)} onDblClick={() => void doImport(i.path)}
              style={`display:flex;width:100%;box-sizing:border-box;align-items:center;gap:12px;height:26px;padding:0 10px;text-align:left;color:#e3e3e3;background:${picked === i.path ? '#3d6fb4' : 'transparent'}`}>
              <span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{i.path}</span>
              <span style="flex:none;color:#b5b5b5;font-size:11px">{i.w}×{i.h}</span>
            </button>
          ))}
        </div>
        {error && <div role="alert" data-top-error style="color:#f07a6a">{error}</div>}
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button onClick={close} style="height:28px;padding:0 14px;border:1px solid #474747;border-radius:5px;background:#262626">Cancel</button>
          <button data-top-import aria-disabled={!picked || busy} onClick={() => void doImport(picked)}
            style={`height:28px;padding:0 16px;border-radius:5px;background:#3d6fb4;color:#fff;font-weight:600;opacity:${picked && !busy ? 1 : 0.5}`}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      </div>
    </div>
  );
}
