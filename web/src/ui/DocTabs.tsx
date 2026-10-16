import { store } from '../state/store';
import { formatZoom } from '../state/view';

const STRIP = 'height:30px;flex:none;display:flex;align-items:flex-end;gap:2px;padding:0 8px;background:#242424;border-bottom:1px solid #161616;overflow-x:auto;overflow-y:hidden';
const TAB = 'height:26px;flex:none;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid #161616;border-bottom:0;border-radius:5px 5px 0 0';

function DocInfo() {
  const { w, h } = store.docSize.value;
  return <span data-doc-info style="color:#9a9a9a">{w} × {h} · {store.canvasMode.value === 'input' ? 'Follow input' : 'Fixed'} · RGBA/8 · {formatZoom(store.zoom.value)}</span>;
}

/** v10: one tab per editor of the TouchDesigner project (create / delete / rename happens in TD). Standalone: the single document tab. */
export function DocTabs() {
  const list = store.editors.value;
  if (!list.length) {
    return (
      <div style={STRIP}>
        <div style={`${TAB};background:#1c1c1c`}>
          <span>{store.docName.value}</span>
          <DocInfo />
          <button class="ib" aria-label="Close document" aria-disabled="true" title="Not in this version" style="width:18px;height:18px">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </div>
    );
  }
  const cur = store.editorId.value, master = store.editorMaster.value, busy = store.editorSwitching.value;
  // while a switch is pending a click on the current tab cancels it
  const select = (id: string) => { if (id !== cur || busy) store.switchEditor?.(id); };
  const move = (to: number, el: HTMLElement) => {
    const n = list.length, next = ((to % n) + n) % n;
    el.parentElement?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  };
  return (
    <div data-editor-tabs role="tablist" aria-label="Editors" aria-busy={busy} style={busy ? `${STRIP};position:relative;z-index:91` : STRIP}>
      {list.map((e, i) => {
        const on = e.id === cur;
        return (
          <button key={e.id} role="tab" type="button" data-editor-tab={e.id} data-editor-active={e.active} data-selected={on} aria-selected={on} aria-disabled={!e.active}
            tabIndex={on ? 0 : -1} title={e.active ? e.path : `${e.path} (inactive)`}
            onClick={() => { if (e.active) select(e.id); else store.setNotice(`${e.name} is inactive in TouchDesigner`); }}
            onKeyDown={(ev) => {
              const t = ev.currentTarget as HTMLElement;
              if (ev.key === 'ArrowRight') { ev.preventDefault(); move(i + 1, t); }
              else if (ev.key === 'ArrowLeft') { ev.preventDefault(); move(i - 1, t); }
              else if (ev.key === 'Home') { ev.preventDefault(); move(0, t); }
              else if (ev.key === 'End') { ev.preventDefault(); move(list.length - 1, t); }
              else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (e.active) select(e.id); }
            }}
            style={`${TAB};cursor:${e.active ? 'pointer' : 'default'};color:${e.active ? '#e3e3e3' : '#7a7a7a'};background:${on ? '#1c1c1c' : '#2b2b2b'}`}>
            {e.id === master && (
              <span data-editor-master role="img" aria-label="Master editor" title="Master editor (runs the web server)" style="width:6px;height:6px;border-radius:50%;background:#4a8fe0;flex:none" />
            )}
            <span data-editor-name>{e.name}</span>
            {on && <DocInfo />}
          </button>
        );
      })}
    </div>
  );
}
