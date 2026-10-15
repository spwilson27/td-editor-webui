import type { ComponentChildren } from 'preact';
import { store } from '../state/store';
import type { RGBA, SelectionMode } from '../engine/types';
import { toHex } from '../state/colour';
import { PAINT_TOOLS, BRUSHES, SHAPE_KINDS, toolInfo } from '../state/tools';
import { editBounds, type BoundsField } from '../state/transform';
import { Icon, NOT_IN_VERSION } from './Icon';

const BOX = 'padding:3px 6px;color:#e3e3e3;background:#1f1f1f;border:1px solid #474747;border-radius:4px;text-align:right';
const CHK = 'accent-color:#4a8fe0;margin:0';

interface RangeProps { label: string; id: string; min: number; max: number; value: number; unit: string; w: number; span: number; onInput: (v: number) => void }

function RangeRow({ label, id, min, max, value, unit, w, span, onInput }: RangeProps) {
  return (
    <div style="display:flex;align-items:center;gap:8px">
      <label for={id} style="color:#a8a8a8">{label}</label>
      <input id={id} class={w >= 140 ? 'rw-xl' : w > 100 ? 'rw-lg' : 'rw-sm'} type="range" min={min} max={max} value={value} 
        onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))} />
      <span data-value={id} style={`min-width:${span}px;${BOX}`}>{value}{unit}</span>
    </div>
  );
}

function Disabled({ children, low }: { children: ComponentChildren; low?: boolean }) {
  return <label class={low ? 'lowprio' : undefined} title={NOT_IN_VERSION} style="display:flex;align-items:center;gap:6px;color:#707070">{children}</label>;
}

function BrushOptions() {
  const b = store.brush.value, t = store.tool.value;
  const preset = BRUSHES.find((p) => p.id === store.brushPreset.value) || BRUSHES[0];
  return (
    <div class="opts">
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
      <Disabled low><input type="checkbox" disabled style={CHK} />Wet edges</Disabled>
      <Disabled low><input type="checkbox" checked disabled style={CHK} />Protect alpha</Disabled>
    </div>
  );
}

const SEG = 'display:flex;gap:2px;padding:2px;background:#1f1f1f;border:1px solid #474747;border-radius:5px';
const segBtn = (on: boolean) => `height:22px;padding:0 10px;border-radius:3px;${on ? 'background:#3d6fb4;color:#ffffff' : 'color:#b5b5b5'}`;
const hex = (c: RGBA) => toHex(c);

function Check({ id, label, checked, onChange, low }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; low?: boolean }) {
  return (
    <label class={low ? 'lowprio' : undefined} for={id} style="display:flex;align-items:center;gap:6px;color:#e3e3e3">
      <input id={id} type="checkbox" checked={checked} style={CHK} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />{label}
    </label>
  );
}

function Swatch({ label, value, onChange, id }: { label: string; value: string; onChange: (hex: string) => void; id: string }) {
  return (
    <input id={id} type="color" aria-label={label} title={label} value={value}
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      style="width:26px;height:22px;padding:0;border:1px solid #474747;border-radius:4px;background:#1f1f1f" />
  );
}

function Toggle({ label, on, onClick, d, data }: { label: string; on: boolean; onClick: () => void; d?: string; data?: string }) {
  return (
    <button aria-label={label} title={label} aria-pressed={on} data-opt={data} onClick={onClick}
      style={`${segBtn(on)};display:inline-flex;align-items:center;justify-content:center;min-width:24px;padding:0 6px`}>
      {d ? <Icon d={d} size={14} sw={1.8} /> : label}
    </button>
  );
}

const MODES_SEL: { id: SelectionMode; label: string }[] = [{ id: 'new', label: 'New' }, { id: 'add', label: 'Add' }, { id: 'subtract', label: 'Subtract' }, { id: 'intersect', label: 'Intersect' }];

function SelectOptions({ wand }: { wand?: boolean }) {
  const o = store.selOpts.value;
  return (
    <div class="opts">
      <div role="group" aria-label="Selection mode" style={SEG}>
        {MODES_SEL.map((m) => (
          <button key={m.id} data-sel-mode={m.id} aria-pressed={o.mode === m.id} onClick={() => store.setSelOpts({ mode: m.id })} style={segBtn(o.mode === m.id)}>{m.label}</button>
        ))}
      </div>
      <span class="lowprio" data-sel-hint style="color:#8f8f8f">Shift add · Alt subtract · Shift+Alt intersect</span>
      <RangeRow label="Feather" id="sf" min={0} max={100} value={o.feather} unit=" px" w={80} span={44} onInput={(v) => store.setSelOpts({ feather: v })} />
      <Check id="sa" label="Antialias" checked={o.antialias} onChange={(v) => store.setSelOpts({ antialias: v })} />
      {wand && <>
        <RangeRow label="Tolerance" id="wt" min={0} max={255} value={o.wandTolerance} unit="" w={110} span={36} onInput={(v) => store.setSelOpts({ wandTolerance: v })} />
        <Check id="wc" label="Contiguous" checked={o.wandContiguous} onChange={(v) => store.setSelOpts({ wandContiguous: v })} />
        <Check id="wa" label="Sample all layers" checked={o.wandSampleAll} onChange={(v) => store.setSelOpts({ wandSampleAll: v })} low />
      </>}
    </div>
  );
}

const ALIGN_D = {
  left: 'M4 6h16M4 10h10M4 14h16M4 18h10',
  center: 'M4 6h16M7 10h10M4 14h16M7 18h10',
  right: 'M4 6h16M10 10h10M4 14h16M10 18h10',
};

function TextOptions() {
  store.docVersion.value;
  const bound = store.boundText()?.text;
  const o = store.textOpts.value;
  const v = bound ?? { ...o, color: store.primaryRgba() };
  const fonts = store.fonts.value.includes(v.font) ? store.fonts.value : [v.font, ...store.fonts.value];
  return (
    <div class="opts">
      <select id="tf" aria-label="Font" value={v.font} style="max-width:150px" onChange={(e) => store.setTextOpt({ font: (e.target as HTMLSelectElement).value })}>
        {fonts.map((f) => <option key={f} value={f} selected={f === v.font}>{f}</option>)}
      </select>
      <div style="display:flex;align-items:center;gap:6px">
        <label for="ts" style="color:#a8a8a8">Size</label>
        <input id="ts" type="number" min={1} max={1000} value={v.size} aria-label="Font size"
          onChange={(e) => { const n = Math.round(Number((e.target as HTMLInputElement).value)); if (n >= 1) store.setTextOpt({ size: Math.min(1000, n) }); }}
          style={`width:52px;${BOX}`} />
      </div>
      <div role="group" aria-label="Style" style={SEG}>
        <Toggle label="Bold" data="bold" on={v.bold} onClick={() => store.setTextOpt({ bold: !v.bold })} />
        <Toggle label="Italic" data="italic" on={v.italic} onClick={() => store.setTextOpt({ italic: !v.italic })} />
      </div>
      <div role="group" aria-label="Alignment" style={SEG}>
        {(['left', 'center', 'right'] as const).map((a) => (
          <Toggle key={a} label={`Align ${a}`} data={`align-${a}`} on={v.align === a} d={ALIGN_D[a]} onClick={() => store.setTextOpt({ align: a })} />
        ))}
      </div>
      <RangeRow label="Line height" id="tl" min={80} max={300} value={Math.round(v.lineHeight * 100)} unit="%" w={80} span={44} onInput={(n) => store.setTextOpt({ lineHeight: n / 100 })} />
      <div style="display:flex;align-items:center;gap:6px"><label for="tc" style="color:#a8a8a8">Colour</label>
        <Swatch id="tc" label="Text colour" value={hex(v.color)} onChange={(h) => store.setTextColor(h)} /></div>
    </div>
  );
}

function ShapeOptions() {
  store.docVersion.value;
  const o = store.shapeOpts.value;
  const bound = store.boundShape()?.shape;
  // Bound layer values win; for a layer the switch to line has no fill.
  let fillOn = o.fillOn, strokeOn = o.strokeOn, width = o.strokeWidth, radius = o.radius, sides = o.sides, inner = o.innerRatio, aS = o.arrowStart, aE = o.arrowEnd;
  let fillC = hex(store.primaryRgba()), strokeC = hex(store.secondaryRgba());
  if (bound) {
    if (bound.type === 'line') { width = bound.stroke.width; aS = bound.arrowStart; aE = bound.arrowEnd; strokeC = hex(bound.stroke.color); }
    else {
      fillOn = bound.fill.enabled; strokeOn = bound.stroke.enabled; width = bound.stroke.width; fillC = hex(bound.fill.color); strokeC = hex(bound.stroke.color);
      if (bound.type === 'rect') radius = bound.radius;
      if (bound.type === 'polygon') { sides = bound.sides; inner = bound.innerRatio; }
    }
  }
  const line = o.type === 'line';
  return (
    <div class="opts">
      <div role="group" aria-label="Shape type" style={SEG}>
        {SHAPE_KINDS.map((k) => <Toggle key={k.id} label={k.name} data={`shape-${k.id}`} on={o.type === k.id} d={k.d} onClick={() => store.setShapeOpt({ type: k.id })} />)}
      </div>
      {!line && <>
        <Check id="shf" label="Fill" checked={fillOn} onChange={(v) => store.setShapeOpt({ fillOn: v })} />
        <Swatch id="shfc" label="Fill colour" value={fillC} onChange={(h) => store.setShapeFill(h)} />
        <Check id="shs" label="Stroke" checked={strokeOn} onChange={(v) => store.setShapeOpt({ strokeOn: v })} />
      </>}
      {line
        ? <Swatch id="shsc" label="Line colour" value={bound?.type === 'line' ? hex(bound.stroke.color) : fillC} onChange={(h) => store.setLineColor(h)} />
        : <Swatch id="shsc" label="Stroke colour" value={strokeC} onChange={(h) => store.setShapeStroke(h)} />}
      {(line || strokeOn) && <RangeRow label="Width" id="shw" min={1} max={100} value={width} unit=" px" w={80} span={44} onInput={(v) => store.setShapeOpt({ strokeWidth: v })} />}
      {o.type === 'rect' && <RangeRow label="Radius" id="shr" min={0} max={300} value={radius} unit=" px" w={80} span={44} onInput={(v) => store.setShapeOpt({ radius: v })} />}
      {o.type === 'polygon' && <>
        <RangeRow label="Sides" id="shn" min={3} max={64} value={sides} unit="" w={80} span={28} onInput={(v) => store.setShapeOpt({ sides: v })} />
        <RangeRow label="Inner" id="shi" min={10} max={100} value={Math.round(inner * 100)} unit="%" w={80} span={40} onInput={(v) => store.setShapeOpt({ innerRatio: v / 100 })} />
      </>}
      {line && <>
        <Check id="sha0" label="Start arrow" checked={aS} onChange={(v) => store.setShapeOpt({ arrowStart: v })} low />
        <Check id="sha1" label="End arrow" checked={aE} onChange={(v) => store.setShapeOpt({ arrowEnd: v })} low />
      </>}
    </div>
  );
}

function FillOptions() {
  return (
    <div class="opts">
      <RangeRow label="Tolerance" id="ft" min={0} max={255} value={store.fillTolerance.value} unit="" w={140} span={36} onInput={(v) => { store.fillTolerance.value = v; }} />
      <Disabled><input type="checkbox" checked disabled style={CHK} />Contiguous</Disabled>
      <Disabled><input type="checkbox" disabled style={CHK} />All layers</Disabled>
    </div>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A numeric field that commits on change / Enter and re-reads the engine value afterwards. */
function NumField({ id, label, value, unit, disabled, onCommit, min }: { id: string; label: string; value: number | null; unit?: string; disabled?: boolean; onCommit: (v: number) => void; min?: number }) {
  const shown = value === null ? '' : String(round(value));
  return (
    <div style="display:flex;align-items:center;gap:5px">
      <label for={id} style="color:#a8a8a8">{label}</label>
      <input id={id} data-field={id} type="number" step="any" min={min} value={shown} disabled={disabled || value === null} aria-label={`${label}${unit ? ` (${unit})` : ''}`}
        onChange={(e) => { const input = e.target as HTMLInputElement; const n = parseFloat(input.value); if (Number.isFinite(n)) onCommit(n); else input.value = shown; }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        style={`width:62px;${BOX};color:#e3e3e3`} />
      {unit && <span style="color:#8f8f8f">{unit}</span>}
    </div>
  );
}

const LINK = 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1';

/** Move tool: the active layer's bounds (X Y W H), scale %, aspect lock, Apply / Reset Transform. */
function MoveOptions() {
  store.docVersion.value; store.docspecVersion.value;
  const l = store.hasEngine() ? store.activeLayer() : undefined;
  const e = store.hasEngine() ? store.engine : null;
  const b = l && e ? e.layerBounds(l.id) : null;
  const ok = !!l && !!b && store.canEditTransform(l);
  const lock = store.aspectLock.value;
  const pixel = !!l && (l.kind === 'pixel' || l.kind === 'base');
  const edit = (field: BoundsField, v: number) => { if (l && b) store.setLayerBounds(l, b, editBounds(b, field, v, lock)); };
  const setScale = (pct: number) => {
    if (!l || !b || !pixel || !(pct > 0)) return;
    const k = pct / 100;
    const sx = k / (l.transform.sx || 1), sy = lock ? sx : 1;
    store.setLayerBounds(l, b, { x: b.x, y: b.y, w: b.w * sx, h: b.h * sy });
  };
  return (
    <div class="opts" data-move-options>
      <NumField id="mx" label="X" unit="px" value={ok ? b!.x : null} onCommit={(v) => edit('x', v)} />
      <NumField id="my" label="Y" unit="px" value={ok ? b!.y : null} onCommit={(v) => edit('y', v)} />
      <NumField id="mw" label="W" unit="px" min={1} value={ok ? b!.w : null} onCommit={(v) => edit('w', v)} />
      <button aria-label="Keep aspect ratio" data-aspect-lock title="Keep aspect ratio" aria-pressed={lock} onClick={() => { store.aspectLock.value = !lock; }}
        style={`${segBtn(lock)};display:inline-flex;align-items:center;justify-content:center;width:26px;padding:0;border:1px solid #474747`}><Icon d={LINK} size={14} sw={1.8} /></button>
      <NumField id="mh" label="H" unit="px" min={1} value={ok ? b!.h : null} onCommit={(v) => edit('h', v)} />
      <NumField id="ms" label="Scale" unit="%" min={0.01} value={ok && pixel ? l!.transform.sx * 100 : null} onCommit={setScale} />
      <button data-act="apply-transform" aria-disabled={!store.canApplyTransform(l)} title="Bake the transform into the layer's pixels" onClick={() => store.applyTransform()}
        style={`height:24px;padding:0 10px;border:1px solid #474747;border-radius:4px;background:#262626;opacity:${store.canApplyTransform(l) ? 1 : 0.45}`}>Apply Transform</button>
      <button data-act="reset-transform" aria-disabled={!store.canResetTransform(l)} title="Back to position 0, 0 at 100%" onClick={() => store.resetTransform()}
        style={`height:24px;padding:0 10px;border:1px solid #474747;border-radius:4px;background:#262626;opacity:${store.canResetTransform(l) ? 1 : 0.45}`}>Reset Transform</button>
      <SnapCheck />
    </div>
  );
}

function SnapCheck() {
  return <Check id="snapc" label="Snap" checked={store.snapOn.value} onChange={(v) => store.setSnapOn(v)} />;
}

function Readout() {
  store.selectionVersion.value;
  const { w: dw, h: dh } = store.docSize.value;
  const sel = store.hasEngine() ? store.engine.selection() : null;
  const r = sel || { x: 0, y: 0, w: dw, h: dh };
  const v = (n: number) => <b style="color:#e3e3e3;font-weight:500">{n} px</b>;
  return (
    <div class="opts" style="color:#a8a8a8">
      <span>X {v(r.x)}</span><span>Y {v(r.y)}</span><span>W {v(r.w)}</span><span>H {v(r.h)}</span>
      <SnapCheck />
    </div>
  );
}

export function ContextBar() {
  const id = store.tool.value;
  const info = toolInfo(id);
  return (
    <div class="ctx" data-context-bar>
      <div class="ctx-tool">
        <Icon d={info.d} size={18} sw={1.7} stroke="#7fb2f0" />
        <span data-context="name" class="ctx-name">{info.name}</span>
      </div>
      <div style="width:1px;height:22px;background:#474747" />
      {PAINT_TOOLS.has(id) ? <BrushOptions />
        : id === 'marquee' || id === 'lasso' ? <SelectOptions />
        : id === 'wand' ? <SelectOptions wand />
        : id === 'text' ? <TextOptions />
        : id === 'shape' ? <ShapeOptions />
        : id === 'fill' ? <FillOptions />
        : id === 'move' ? <MoveOptions />
        : id === 'gradient' ? <span style="color:#a8a8a8">Linear · primary to secondary colour</span>
        : <Readout />}
    </div>
  );
}
