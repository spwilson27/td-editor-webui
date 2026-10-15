import { useEffect, useRef, useState } from 'preact/hooks';
import { effectLabel } from '../state/effectDefaults';
import { filterDoc, filterGroups } from '../state/filterSchema';
import { store, type Store } from '../state/store';
import { MODES } from '../state/tools';
import { formatZoom } from '../state/view';
import { Icon, NOT_IN_VERSION } from './Icon';

type Item = 'sep' | { label: string; hint?: string; flyout?: 'filters'; run?: (s: Store) => void; checked?: (s: Store) => boolean; enabled?: (s: Store) => boolean; title?: (s: Store) => string | undefined };
interface MenuDef { label: string; items: Item[] | ((s: Store) => Item[]) }

const off = (label: string, hint?: string): Item => ({ label, hint });
const isEditable = (kind?: string) => kind === 'text' || kind === 'shape';

const MENUS: MenuDef[] = [
  { label: 'File', items: [
    { label: 'Save Project…', run: (s) => s.openFileDialog('saveProject'), enabled: (s) => s.canUseFiles(), title: (s) => s.fileTitle() },
    { label: 'Open Project…', run: (s) => s.openFileDialog('openProject'), enabled: (s) => s.canUseFiles(), title: (s) => s.fileTitle() },
    { label: 'Export PNG…', run: (s) => s.openFileDialog('exportPng'), enabled: (s) => s.canUseFiles(), title: (s) => s.fileTitle() },
    { label: 'Clear stored undo history', run: (s) => void s.clearStoredHistory(), enabled: (s) => s.canUseFiles(), title: (s) => s.fileTitle() ?? 'Removes the undo history TouchDesigner keeps with the document' }, 'sep',
    { label: 'Place Image…', run: (s) => s.placeImage(), title: (s) => s.placeImageTitle() },
    { label: 'Import from TouchDesigner…', run: (s) => { s.topDialog.value = true; }, enabled: (s) => s.connection.value === 'linked' }, 'sep',
    { label: 'New layer', run: (s) => s.addLayer() }, { label: 'Flatten to new layer', run: (s) => s.flatten() }] },
  { label: 'Edit', items: [{ label: 'Undo', hint: 'Ctrl+Z', run: (s) => s.undo() }, { label: 'Redo', hint: 'Ctrl+Shift+Z', run: (s) => s.redo() },
    'sep', off('Cut', 'Ctrl+X'), off('Copy', 'Ctrl+C'), { label: 'Paste', hint: 'Ctrl+V', run: (s) => void s.pasteFromClipboard() }] },
  { label: 'Document', items: [off('Resize document…'),
    { label: 'Canvas Size…', run: (s) => { s.canvasDialog.value = true; } },
    { label: 'Follow Input Size', run: (s) => s.followInput(), checked: (s) => s.canvasMode.value === 'input', title: () => 'The document size tracks the TouchDesigner Input resolution' }, off('Rotate…')] },
  { label: 'Layer', items: (s) => [off('Duplicate'), off('Merge down'), off('Layer properties…'), 'sep',
    { label: 'Layer Effects…', run: (x) => x.openEffects(), enabled: (x) => x.canHaveEffects(x.activeLayer()?.kind) },
    { label: 'New Filter Adjustment ▸', flyout: 'filters', run: () => {}, enabled: (x) => x.hasEngine() },
    ...(s.connectedInputs().length
      ? s.connectedInputs().map((i): Item => ({ label: `Add Input Layer ▸ Input ${i.input}`, run: (x) => void x.addInputLayer(i.input) }))
      : [{ label: 'Add Input Layer ▸ (no connected inputs)', run: () => {}, enabled: () => false } as Item]), 'sep',
    { label: 'Flatten Layer', run: (s) => { const l = s.activeLayer(); if (l) void s.flattenLayer(l.id); }, enabled: (s) => s.canFlatten(s.activeLayer()),
      title: (s) => (isEditable(s.activeLayer()?.kind) && s.connection.value !== 'linked' ? 'Flatten needs TouchDesigner' : undefined) },
    { label: 'Apply Transform', run: (s) => s.applyTransform(), enabled: (s) => s.canApplyTransform(s.activeLayer()) },
    { label: 'Reset Transform', run: (s) => s.resetTransform(), enabled: (s) => s.canResetTransform(s.activeLayer()) }, 'sep', { label: 'Add mask', run: (s) => s.addMask(), enabled: (s) => s.canAddMask() }, { label: 'Delete mask', run: (s) => s.deleteMask(), enabled: (s) => !!s.activeLayer()?.mask }] },
  { label: 'Select', items: [{ label: 'Select All', hint: 'Ctrl+A', run: (s) => s.selectAll() }, { label: 'Deselect', hint: 'Ctrl+D', run: (s) => s.deselect() },
    { label: 'Invert Selection', hint: 'Shift+Ctrl+I', run: (s) => s.invertSelection() }, 'sep',
    { label: 'Mask from Selection', run: (s) => s.maskFromSelection(), enabled: (s) => s.canMaskFromSelection() }, 'sep',
    { label: 'Transform Selection', hint: 'Ctrl+T', run: (s) => void s.beginTransformSelection(), enabled: (s) => s.canTransformSelection() },
    { label: 'Quick Mask', hint: 'Q', run: (s) => s.toggleQuickMask(), checked: (s) => (s.floatVersion.value, s.selectionVersion.value, s.quickMaskOn()) }, 'sep',
    { label: 'Grow…', run: (s) => s.openSelectionOp('grow'), enabled: (s) => s.canModifySelection() },
    { label: 'Shrink…', run: (s) => s.openSelectionOp('shrink'), enabled: (s) => s.canModifySelection() },
    { label: 'Smooth…', run: (s) => s.openSelectionOp('smooth'), enabled: (s) => s.canModifySelection() },
    { label: 'Feather…', run: (s) => s.openSelectionOp('feather'), enabled: (s) => s.canModifySelection() },
    { label: 'Border…', run: (s) => s.openSelectionOp('border'), enabled: (s) => s.canModifySelection() }] },
  { label: 'Filters', items: [off('Blur…'), off('Sharpen…'), off('Noise…')] },
  { label: 'View', items: [{ label: 'Zoom in', hint: '+', run: (s) => s.zoomStep(1) }, { label: 'Zoom out', hint: '-', run: (s) => s.zoomStep(-1) },
    { label: 'Fit', hint: '0', run: (s) => s.fit() }, { label: '100%', hint: '1', run: (s) => s.zoomTo(1) }, 'sep',
    { label: 'Show Rulers', run: (s) => s.setShowRulers(!s.showRulers.value), checked: (s) => s.showRulers.value },
    { label: 'Show Guides', run: (s) => s.setShowGuides(!s.showGuides.value), checked: (s) => s.showGuides.value },
    { label: 'Snap', run: (s) => s.setSnapOn(!s.snapOn.value), checked: (s) => s.snapOn.value },
    { label: 'Clear Guides', run: (s) => s.clearGuides(), enabled: (s) => s.hasGuides() },
    { label: 'Quick Mask', hint: 'Q', run: (s) => s.toggleQuickMask(), checked: (s) => (s.floatVersion.value, s.selectionVersion.value, s.quickMaskOn()) }, 'sep',
    { label: 'Local view', run: (s) => s.setViewMode('local'), checked: (s) => s.viewMode.value === 'local' },
    { label: 'TouchDesigner view', run: (s) => s.setViewMode('td'), checked: (s) => s.viewMode.value === 'td', enabled: (s) => s.tdAvailable.value }, 'sep',
    { label: 'Shape antialiasing: Exact (matches TouchDesigner)', run: (s) => s.setShapeRenderer('sdf'), checked: (s) => s.shapeRenderer.value === 'sdf' },
    { label: 'Shape antialiasing: Browser canvas', run: (s) => s.setShapeRenderer('canvas'), checked: (s) => s.shapeRenderer.value === 'canvas' }] },
  { label: 'Window', items: [off('Reset layout')] },
];

function MenuBar() {
  const [open, setOpen] = useState(-1);
  const [fly, setFly] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open < 0) setFly(false); }, [open]);
  useEffect(() => {
    if (open < 0) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(-1); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(-1); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div ref={ref} class="topbar-left">
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
              {(typeof m.items === 'function' ? m.items(store) : m.items).map((it, k) => {
                if (it === 'sep') return <div key={k} style="height:1px;background:#444;margin:4px 2px" />;
                const usable = !!it.run && (!it.enabled || it.enabled(store));
                const check = it.checked?.(store);
                if (it.flyout && it.enabled && !it.enabled(store)) {
                  return <button key={it.label} role="menuitem" class="mi" aria-disabled="true" data-flyout={it.flyout} style="display:flex;width:100%;box-sizing:border-box;align-items:center;height:26px;padding:0 10px;border-radius:4px;text-align:left;color:#707070">{it.label}</button>;
                }
                if (it.flyout) {
                  return (
                    <div key={it.label} style="position:relative">
                      <button role="menuitem" class="mi" aria-haspopup="menu" aria-expanded={fly} data-flyout={it.flyout} onClick={() => setFly(true)} onPointerEnter={() => setFly(true)}
                        style="display:flex;width:100%;box-sizing:border-box;align-items:center;gap:24px;height:26px;padding:0 10px;border-radius:4px;text-align:left;color:#e3e3e3">
                        <span style="flex:1 1 auto">{it.label}</span>
                      </button>
                      {fly && (
                        <div role="menu" aria-label="New Filter Adjustment" style="position:absolute;left:100%;top:-4px;z-index:60;min-width:210px;max-height:min(520px,80vh);overflow-y:auto;padding:4px;background:#2f2f2f;border:1px solid #161616;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.55)">
                          {filterGroups().map((g, gi) => (
                            <div key={g.id} role="group" aria-label={g.label}>
                              {gi > 0 && <div role="separator" style="height:1px;background:#444;margin:4px 2px" />}
                              <div style="padding:3px 10px 2px;font-size:10px;letter-spacing:0.04em;text-transform:uppercase;color:#8f8f8f">{g.label}</div>
                              {g.types.map((t) => (
                                <button key={t} role="menuitem" class="mi" data-new-filter-adjustment={t} title={filterDoc(t)}
                                  onClick={() => { setOpen(-1); store.addFilterAdjustment(t); }}
                                  style="display:flex;width:100%;box-sizing:border-box;align-items:center;height:26px;padding:0 10px;border-radius:4px;text-align:left;color:#e3e3e3">
                                  {effectLabel(t)}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <button key={it.label} role="menuitem" class="mi" aria-disabled={!usable} aria-checked={check} title={it.run ? it.title?.(store) : NOT_IN_VERSION}
                    onClick={() => { if (!usable) return; setOpen(-1); it.run!(store); }}
                    style={`display:flex;width:100%;box-sizing:border-box;align-items:center;gap:24px;height:26px;padding:0 10px;border-radius:4px;text-align:left;color:${usable ? '#e3e3e3' : '#707070'}`}>
                    <span style="flex:1 1 auto">{check ? '✓ ' : ''}{it.label}</span>
                    {it.hint && <span style="color:#8f8f8f;font-size:11px">{it.hint}</span>}
                  </button>
                );
              })}
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
      <div class="topbar-right">
        <button class="ib" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => store.undo()} style="width:30px;height:30px"><Icon d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" /></button>
        <button class="ib" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={() => store.redo()} style="width:30px;height:30px"><Icon d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" /></button>
        <div style="width:1px;height:18px;background:#444;margin:0 6px" />
        <ZoomSelect />
      </div>
    </div>
  );
}
