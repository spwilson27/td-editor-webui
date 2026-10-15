import { useRef, useState } from 'preact/hooks';
import type { BrushPreset } from '../engine/types';
import { DEFAULT_DYNAMICS, DYNAMICS_FIELDS, MAX_IMPORT_BYTES, TIP_SHAPES } from '../state/brushes';
import type { PresetEntry, PresetSource } from '../state/brushesSlice';
import { store } from '../state/store';
import { Icon } from './Icon';
import { ScrubSelect } from './Scrub';

const BTN = 'height:24px;padding:0 8px;border:1px solid #474747;border-radius:4px;background:#262626;color:#e3e3e3';
const SECTION = 'padding:6px 12px 2px;font-size:10px;letter-spacing:0.04em;text-transform:uppercase;color:#8f8f8f';
const SOURCE_LABEL: Record<PresetSource, string> = { builtin: 'Built-in', user: 'My presets (this browser)', document: 'Document presets' };

/** Stroke weight / opacity of the list preview: the classic presets carry their own, others derive it from the settings. */
function lookOf(e: PresetEntry): { sw: number; op: number } {
  const s = e.preset.settings;
  return { sw: Math.max(1.5, Math.min(12, s.size / 12)), op: Math.max(0.25, s.opacity * (0.4 + s.flow * 0.6)) };
}

function PresetRow({ e, current, editing, onEdit }: { e: PresetEntry; current: string; editing: boolean; onEdit: (key: string | null) => void }) {
  const { sw, op } = lookOf(e);
  const on = e.key === current;
  const editable = e.source !== 'builtin';
  const preview = (
    <svg width="72" height="22" viewBox="0 0 96 24" aria-hidden="true" style="flex:none">
      <path d="M4 16c14-14 26 6 44-2s26-8 44-4" fill="none" stroke="#e3e3e3" stroke-width={sw} stroke-linecap="round" opacity={op} />
    </svg>
  );
  return (
    <div class="row" data-brush-row={e.key} style={`display:flex;align-items:center;gap:4px;background:${on ? '#383838' : 'transparent'}`}>
      {editing ? (
        <div style="flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:10px;height:40px;padding:0 4px 0 12px">
          {preview}
          <RenameField name={e.name} onDone={(v) => { if (v !== null) store.renamePreset(e.key, v); onEdit(null); }} />
        </div>
      ) : (
        <button class="row" data-brush={e.key} data-brush-source={e.source} aria-pressed={on} onClick={() => void store.applyPreset(e.key)}
          style="flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:10px;height:40px;padding:0 4px 0 12px;text-align:left;background:transparent">
          {preview}
          <span data-brush-name style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{e.name}</span>
          <span style="flex:none;color:#a8a8a8">{e.preset.settings.size} px</span>
        </button>
      )}
      {editable && !editing && (
        <>
          <button class="ib" data-brush-rename={e.key} aria-label={`Rename ${e.name}`} title="Rename" onClick={() => onEdit(e.key)} style="flex:none;width:22px;height:26px">
            <Icon d="M16 3l5 5L8 21H3v-5L16 3z" size={12} sw={1.8} />
          </button>
          <button class="ib" data-brush-delete={e.key} aria-label={`Delete ${e.name}`} title="Delete" onClick={() => store.deletePreset(e.key)} style="flex:none;width:22px;height:26px;margin-right:6px">
            <Icon d="M6 6l12 12M18 6L6 18" size={12} sw={2} />
          </button>
        </>
      )}
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (save: boolean) => { if (done.current) return; done.current = true; onDone(save ? ref.current!.value : null); };
  return (
    <input ref={ref} data-brush-rename-input value={name} aria-label="Preset name" autoFocus
      onFocus={(e) => (e.target as HTMLInputElement).select()} onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); }}
      style="flex:1 1 auto;min-width:0;height:22px;box-sizing:border-box;padding:0 4px;background:#1f1f1f;border:1px solid #4a8fe0;border-radius:3px" />
  );
}

function TipPicker() {
  const tip = store.tip.value, custom = store.customTip.value;
  return (
    <div data-tip-picker style="padding:6px 12px;display:flex;flex-direction:column;gap:6px">
      <div style="color:#a8a8a8">Tip</div>
      <div role="group" aria-label="Brush tip" style="display:flex;flex-wrap:wrap;gap:4px">
        {TIP_SHAPES.map((t) => (
          <button key={t.id} data-tip={t.id} aria-pressed={tip === t.id} onClick={() => store.setTip(t.id)}
            style={`${BTN};${tip === t.id ? 'background:#3d6fb4;color:#fff;border-color:#3d6fb4' : ''}`}>{t.label}</button>
        ))}
        <button data-tip="custom" aria-pressed={tip === 'custom'} title="Use the selected pixels (luminance × alpha of the active layer) as the tip"
          onClick={() => { if (!store.useTipFromSelection() && store.customTip.peek()) store.setTip('custom'); }}
          style={`${BTN};${tip === 'custom' ? 'background:#3d6fb4;color:#fff;border-color:#3d6fb4' : ''}`}>From selection{custom ? ` (${custom.w}×${custom.h})` : ''}</button>
      </div>
    </div>
  );
}

function Dynamics() {
  const d = store.dynamics.value;
  return (
    <div data-dynamics style="padding:6px 12px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;color:#a8a8a8"><span style="flex:1 1 auto">Dynamics</span>
        <button data-dynamics-reset style={BTN} onClick={() => store.setDynamics(DEFAULT_DYNAMICS)}>Reset</button></div>
      {DYNAMICS_FIELDS.map((f) => (
        <div key={f.key} style="display:flex;align-items:center;gap:8px">
          <label for={`dyn-${f.key}`} style="flex:none;width:92px;color:#a8a8a8">{f.label}</label>
          <input id={`dyn-${f.key}`} data-dyn={f.key} type="range" aria-label={f.label} min={f.min} max={f.max} step={f.step} value={d[f.key]}
            onInput={(ev) => { const n = parseFloat((ev.target as HTMLInputElement).value); if (!isNaN(n)) store.setDynamics({ [f.key]: n }); }} style="flex:1 1 auto;min-width:0" />
          <span data-dyn-value={f.key} style="flex:none;width:44px;text-align:right;color:#e3e3e3">{(d[f.key] * f.scale).toFixed(f.digits)}{f.unit}</span>
        </div>
      ))}
      <div style="display:flex;align-items:center;gap:8px">
        <label for="dyn-seed" style="flex:none;width:92px;color:#a8a8a8">Seed</label>
        <input id="dyn-seed" data-dyn="seed" type="number" aria-label="Seed" min={0} max={16777215} step={1} value={d.seed}
          onChange={(ev) => { const n = Number((ev.target as HTMLInputElement).value); if (isFinite(n)) store.setDynamics({ seed: n }); }}
          style="flex:1 1 auto;min-width:0;padding:2px 6px;background:#1f1f1f;border:1px solid #474747;border-radius:4px;height:22px;box-sizing:border-box" />
        <button class="ib" aria-label="Random seed" title="Random seed" onClick={() => store.setDynamics({ seed: Math.floor(Math.random() * 16777216) })} style="flex:none;width:24px;height:22px;border:1px solid #474747;border-radius:4px">⚄</button>
      </div>
    </div>
  );
}

function SavePreset() {
  const [name, setName] = useState('');
  const [where, setWhere] = useState<'user' | 'document'>('user');
  const save = () => { if (store.saveCurrentPreset(name || `Brush ${store.userPresets.value.length + store.docPresets.value.length + 1}`, where)) setName(''); };
  return (
    <div data-preset-save style="padding:6px 12px;display:flex;flex-direction:column;gap:6px;border-top:1px solid #1f1f1f">
      <div style="color:#a8a8a8">Save current brush as preset</div>
      <div style="display:flex;gap:4px;align-items:center">
        <input data-preset-name aria-label="New preset name" placeholder="Preset name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') save(); }}
          style="flex:1 1 auto;min-width:0;height:24px;box-sizing:border-box;padding:0 6px;background:#1f1f1f;border:1px solid #474747;border-radius:4px" />
        <ScrubSelect aria-label="Save preset in" data-preset-where value={where} onChange={(e) => setWhere((e.target as HTMLSelectElement).value as 'user' | 'document')} style="flex:none;max-width:104px">
          <option value="user" selected={where === 'user'}>This browser</option>
          <option value="document" selected={where === 'document'}>Document</option>
        </ScrubSelect>
        <button data-preset-save-btn style={BTN} onClick={save}>Save</button>
      </div>
    </div>
  );
}

function ImportExport() {
  const [mode, setMode] = useState<'export' | 'import' | null>(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const panel = store.clientKind.value === 'panel';
  const open = (m: 'export' | 'import') => {
    if (mode === m) { setMode(null); return; }
    setMode(m);
    setMsg('');
    setText(m === 'export' ? store.exportPresets('user') : '');
  };
  const doImport = (t: string) => {
    if (t.length > MAX_IMPORT_BYTES) { setMsg('That file is too large to be a preset file'); return; }
    try {
      const n = store.importPresets(t, 'user');
      setMsg(n ? `Imported ${n} preset${n === 1 ? '' : 's'}` : 'No presets found in that text');
      if (n) { setText(''); }
    } catch { setMsg('That is not a brush preset file'); }
  };
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([store.exportPresets('user')], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'brush-presets.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setMsg('Download is not available here; copy the text instead'); }
  };
  return (
    <div data-preset-io style="padding:6px 12px 10px;display:flex;flex-direction:column;gap:6px;border-top:1px solid #1f1f1f">
      <div style="display:flex;gap:4px">
        <button data-preset-export style={BTN} aria-expanded={mode === 'export'} onClick={() => open('export')}>Export…</button>
        <button data-preset-import style={BTN} aria-expanded={mode === 'import'} onClick={() => open('import')}>Import…</button>
        <span style="flex:1 1 auto;align-self:center;color:#8f8f8f;text-align:right">my presets, JSON</span>
      </div>
      {mode && (
        <div style="display:flex;flex-direction:column;gap:6px">
          <textarea ref={area} data-preset-text aria-label={mode === 'export' ? 'Exported presets' : 'Preset JSON to import'} rows={5} value={text} readOnly={mode === 'export'}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            style="resize:vertical;background:#1f1f1f;color:#e3e3e3;border:1px solid #474747;border-radius:4px;font:11px monospace;min-height:60px" />
          <div style="display:flex;gap:4px">
            {mode === 'export'
              ? <button data-preset-download style={BTN} onClick={download}>Download file</button>
              : <>
                <button data-preset-apply style={BTN} onClick={() => doImport(area.current?.value ?? text)}>Import text</button>
                {!panel && <button data-preset-file style={BTN} onClick={() => file.current?.click()}>Choose file…</button>}
              </>}
          </div>
          {!panel && (
            <input ref={file} type="file" accept=".json,application/json" hidden data-preset-file-input aria-hidden="true" tabIndex={-1}
              onChange={async (ev) => { const i = ev.target as HTMLInputElement, f = i.files?.[0]; i.value = ''; if (f) { if (f.size > MAX_IMPORT_BYTES) { setMsg('That file is too large to be a preset file'); return; } try { doImport(await f.text()); } catch { setMsg('Could not read the file'); } } }} />
          )}
        </div>
      )}
      {msg && <div data-preset-msg style="color:#f0b45a">{msg}</div>}
    </div>
  );
}

export function BrushesPanel() {
  const current = store.brushPreset.value;
  store.userPresets.value; store.docPresets.value;
  const [editing, setEditing] = useState<string | null>(null);
  const entries = store.presetEntries();
  const sources: PresetSource[] = ['builtin', 'user', 'document'];
  return (
    <div data-brushes-panel style="display:flex;flex-direction:column;box-sizing:border-box;padding:6px 0;max-height:min(460px,52vh);overflow-y:auto;overflow-x:hidden">
      {sources.map((src) => {
        const rows = entries.filter((e) => e.source === src);
        if (src !== 'builtin' && rows.length === 0) return null;
        return (
          <div key={src} role="group" aria-label={SOURCE_LABEL[src]} data-preset-section={src}>
            <div style={SECTION}>{SOURCE_LABEL[src]}</div>
            {rows.map((e) => <PresetRow key={e.key} e={e} current={current} editing={editing === e.key} onEdit={setEditing} />)}
          </div>
        );
      })}
      <TipPicker />
      <Dynamics />
      <SavePreset />
      <ImportExport />
    </div>
  );
}

export type { BrushPreset };
