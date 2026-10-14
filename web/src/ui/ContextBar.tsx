import type { ComponentChildren } from 'preact';
import { store } from '../state/store';
import { PAINT_TOOLS, BRUSHES, toolInfo } from '../state/tools';
import { Icon, NOT_IN_VERSION } from './Icon';

const BOX = 'padding:3px 6px;background:#1f1f1f;border:1px solid #474747;border-radius:4px;text-align:right';
const CHK = 'accent-color:#4a8fe0;margin:0';

interface RangeProps { label: string; id: string; min: number; max: number; value: number; unit: string; w: number; span: number; onInput: (v: number) => void }

function RangeRow({ label, id, min, max, value, unit, w, span, onInput }: RangeProps) {
  return (
    <div style="display:flex;align-items:center;gap:8px">
      <label for={id} style="color:#a8a8a8">{label}</label>
      <input id={id} type="range" min={min} max={max} value={value} style={`width:${w}px`}
        onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))} />
      <span data-value={id} style={`min-width:${span}px;${BOX}`}>{value}{unit}</span>
    </div>
  );
}

function Disabled({ children }: { children: ComponentChildren }) {
  return <label title={NOT_IN_VERSION} style="display:flex;align-items:center;gap:6px;color:#707070">{children}</label>;
}

function BrushOptions() {
  const b = store.brush.value, t = store.tool.value;
  const preset = BRUSHES.find((p) => p.id === store.brushPreset.value) || BRUSHES[0];
  return (
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:18px">
      <button aria-label="Brush presets" onClick={() => { store.colorTab.value = 'brushes'; }}
        style="display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border:1px solid #474747;border-radius:5px;background:#262626">
        <svg width="44" height="14" viewBox="0 0 44 14" aria-hidden="true"><path d="M2 10c8-8 14 4 22-2s14-4 18-2" fill="none" stroke="#e3e3e3" stroke-width="3" stroke-linecap="round" /></svg>
        <span>{preset.name}</span>
        <Icon d="M6 9l6 6 6-6" size={10} sw={2.4} />
      </button>
      <RangeRow label="Width" id="bw" min={1} max={300} value={b.size} unit=" px" w={110} span={46} onInput={(v) => store.setBrush({ size: v })} />
      <RangeRow label="Opacity" id="bo" min={0} max={100} value={Math.round(b.opacity * 100)} unit="%" w={80} span={36} onInput={(v) => store.setBrush({ opacity: v / 100 })} />
      {t !== 'pencil' && <>
        <RangeRow label="Flow" id="bf" min={0} max={100} value={Math.round(b.flow * 100)} unit="%" w={80} span={36} onInput={(v) => store.setBrush({ flow: v / 100 })} />
        <RangeRow label="Hardness" id="bh" min={0} max={100} value={Math.round(b.hardness * 100)} unit="%" w={80} span={36} onInput={(v) => store.setBrush({ hardness: v / 100 })} />
      </>}
      <Disabled><input type="checkbox" disabled style={CHK} />Wet edges</Disabled>
      <Disabled><input type="checkbox" checked disabled style={CHK} />Protect alpha</Disabled>
    </div>
  );
}

function SelectOptions() {
  const modes = ['New', 'Add', 'Subtract', 'Intersect'];
  return (
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:18px">
      <div role="group" aria-label="Selection mode" style="display:flex;gap:2px;padding:2px;background:#1f1f1f;border:1px solid #474747;border-radius:5px">
        {modes.map((m, i) => (
          <button key={m} aria-pressed={i === 0} aria-disabled={i !== 0} title={i === 0 ? undefined : NOT_IN_VERSION}
            style={`height:22px;padding:0 10px;border-radius:3px;${i === 0 ? 'background:#3d6fb4;color:#ffffff' : 'color:#8f8f8f'}`}>{m}</button>
        ))}
      </div>
      <div style="display:flex;align-items:center;gap:8px"><label style="color:#a8a8a8">Feather</label><span style={`min-width:40px;${BOX}`}>0 px</span></div>
      <Disabled><input type="checkbox" checked disabled style={CHK} />Antialias</Disabled>
      <button aria-disabled="true" title={NOT_IN_VERSION} style="height:26px;padding:0 12px;border:1px solid #474747;border-radius:5px;background:#262626;color:#8f8f8f">Refine…</button>
    </div>
  );
}

function FillOptions() {
  return (
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:18px">
      <RangeRow label="Tolerance" id="ft" min={0} max={255} value={store.fillTolerance.value} unit="" w={140} span={36} onInput={(v) => { store.fillTolerance.value = v; }} />
      <Disabled><input type="checkbox" checked disabled style={CHK} />Contiguous</Disabled>
      <Disabled><input type="checkbox" disabled style={CHK} />All layers</Disabled>
    </div>
  );
}

function Readout() {
  store.selectionVersion.value;
  const { w: dw, h: dh } = store.docSize.value;
  const sel = store.hasEngine() ? store.engine.selection() : null;
  const r = sel || { x: 0, y: 0, w: dw, h: dh };
  const v = (n: number) => <b style="color:#e3e3e3;font-weight:500">{n} px</b>;
  return (
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px;color:#a8a8a8">
      <span>X {v(r.x)}</span><span>Y {v(r.y)}</span><span>W {v(r.w)}</span><span>H {v(r.h)}</span>
      <Disabled><input type="checkbox" disabled style={CHK} />Snap</Disabled>
    </div>
  );
}

export function ContextBar() {
  const id = store.tool.value;
  const info = toolInfo(id);
  return (
    <div style="min-height:42px;flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:16px;padding:4px 12px;background:#303030;border-bottom:1px solid #1a1a1a">
      <div style="display:flex;align-items:center;gap:8px;min-width:150px">
        <Icon d={info.d} size={18} sw={1.7} stroke="#7fb2f0" />
        <span data-context="name" style="font-weight:600">{info.name}</span>
      </div>
      <div style="width:1px;height:22px;background:#474747" />
      {PAINT_TOOLS.has(id) ? <BrushOptions />
        : id === 'marquee' ? <SelectOptions />
        : id === 'fill' ? <FillOptions />
        : id === 'gradient' ? <span style="color:#a8a8a8">Linear · primary to secondary colour</span>
        : <Readout />}
    </div>
  );
}
