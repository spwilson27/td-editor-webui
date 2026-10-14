import { useEffect, useRef, useState } from 'preact/hooks';
import { store, type Store } from '../state/store';
import { MODES } from '../state/tools';
import { formatZoom } from '../state/view';
import { Icon, NOT_IN_VERSION } from './Icon';

type Item = 'sep' | { label: string; hint?: string; run?: (s: Store) => void };
interface MenuDef { label: string; items: Item[] }

const off = (label: string, hint?: string): Item => ({ label, hint });

const MENUS: MenuDef[] = [
  { label: 'File', items: [off('Open…', 'Ctrl+O'), off('Save', 'Ctrl+S'), off('Export…'), 'sep',
    { label: 'New layer', run: (s) => s.addLayer() }, { label: 'Flatten to new layer', run: (s) => s.flatten() }] },
  { label: 'Edit', items: [{ label: 'Undo', hint: 'Ctrl+Z', run: (s) => s.undo() }, { label: 'Redo', hint: 'Ctrl+Shift+Z', run: (s) => s.redo() },
    'sep', off('Cut', 'Ctrl+X'), off('Copy', 'Ctrl+C'), off('Paste', 'Ctrl+V')] },
  { label: 'Document', items: [off('Resize document…'), off('Resize canvas…'), off('Rotate…')] },
  { label: 'Layer', items: [off('Duplicate'), off('Merge down'), off('Layer properties…')] },
  { label: 'Select', items: [off('Select all', 'Ctrl+A'), { label: 'Deselect', hint: 'Ctrl+D', run: (s) => s.deselect() }, off('Invert selection')] },
  { label: 'Filters', items: [off('Blur…'), off('Sharpen…'), off('Noise…')] },
  { label: 'View', items: [{ label: 'Zoom in', hint: '+', run: (s) => s.zoomStep(1) }, { label: 'Zoom out', hint: '-', run: (s) => s.zoomStep(-1) },
    { label: 'Fit', hint: '0', run: (s) => s.fit() }, { label: '100%', hint: '1', run: (s) => s.zoomTo(1) }] },
  { label: 'Window', items: [off('Reset layout'), off('Show rulers')] },
];

function MenuBar() {
  const [open, setOpen] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open < 0) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(-1); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(-1); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div ref={ref} style="display:flex;align-items:center;gap:2px;flex:1 1 0;min-width:0">
      <div aria-hidden="true" style="width:22px;height:22px;margin-right:8px;border-radius:6px;background:#4a8fe0;display:flex;align-items:center;justify-content:center">
        <Icon d="M18 3l3 3-9 9-3-3 9-9zM9 12c-3 0-5 2-5 5 0 1.5-1 3-2 3 4 1 9 0 9-5" size={14} sw={2.2} stroke="#ffffff" />
      </div>
      {MENUS.map((m, i) => (
        <div key={m.label} style="position:relative">
          <button class={'menu' + (open === i ? ' open' : '')} aria-haspopup="menu" aria-expanded={open === i}
            onClick={() => setOpen(open === i ? -1 : i)} onPointerEnter={() => open >= 0 && setOpen(i)}
            style="padding:5px 8px;border-radius:4px">{m.label}</button>
          {open === i && (
            <div role="menu" style="position:absolute;left:0;top:100%;z-index:50;min-width:210px;padding:4px;background:#2f2f2f;border:1px solid #161616;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.55)">
              {m.items.map((it, k) => it === 'sep'
                ? <div key={k} style="height:1px;background:#444;margin:4px 2px" />
                : (
                  <button key={it.label} role="menuitem" class="mi" aria-disabled={!it.run} title={it.run ? undefined : NOT_IN_VERSION}
                    onClick={() => { if (!it.run) return; setOpen(-1); it.run(store); }}
                    style={`display:flex;width:100%;box-sizing:border-box;align-items:center;gap:24px;height:26px;padding:0 10px;border-radius:4px;text-align:left;color:${it.run ? '#e3e3e3' : '#707070'}`}>
                    <span style="flex:1 1 auto">{it.label}</span>
                    {it.hint && <span style="color:#8f8f8f;font-size:11px">{it.hint}</span>}
                  </button>
                ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4];

function ZoomSelect() {
  const z = store.zoom.value;
  const options = [...new Set([...ZOOM_PRESETS, z])].sort((a, b) => a - b);
  const onChange = (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'fit') store.fit(); else store.zoomTo(parseFloat(v));
  };
  return (
    <>
      <label for="zoomSel" style="color:#a8a8a8">Zoom</label>
      <select id="zoomSel" value={String(z)} onChange={onChange}>
        {options.map((o) => <option key={o} value={String(o)} selected={o === z}>{formatZoom(o)}</option>)}
        <option value="fit">Fit</option>
      </select>
    </>
  );
}

export function TopBar() {
  const mode = 'paint';
  return (
    <div style="height:38px;flex:none;display:flex;align-items:center;gap:12px;padding:0 10px;background:#2b2b2b;border-bottom:1px solid #161616">
      <MenuBar />
      <div role="group" aria-label="Workspace" style="display:flex;gap:2px;padding:2px;background:#1f1f1f;border-radius:7px;border:1px solid #3a3a3a">
        {MODES.map((m) => {
          const on = m.id === mode;
          return (
            <button key={m.id} aria-pressed={on} aria-disabled={!m.enabled} title={m.enabled ? undefined : NOT_IN_VERSION}
              style={`display:flex;align-items:center;gap:6px;height:26px;padding:0 12px;border-radius:5px;background:${on ? '#3f3f3f' : 'transparent'};color:${on ? '#ffffff' : m.enabled ? '#b5b5b5' : '#6f6f6f'}`}>
              <Icon d={m.d} size={14} sw={1.8} /><span>{m.label}</span>
            </button>
          );
        })}
      </div>
      <div style="flex:1 1 0;display:flex;justify-content:flex-end;align-items:center;gap:4px">
        <button class="ib" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => store.undo()} style="width:30px;height:30px"><Icon d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" /></button>
        <button class="ib" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={() => store.redo()} style="width:30px;height:30px"><Icon d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" /></button>
        <div style="width:1px;height:18px;background:#444;margin:0 6px" />
        <ZoomSelect />
      </div>
    </div>
  );
}
