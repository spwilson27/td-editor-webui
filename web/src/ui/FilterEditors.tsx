// Parameter editors for the v6 filter library (generated from state/filterSchema.ts): curves, gradient stops, selective colour,
// .cube LUT loader, displace source picker, plus the generic number / enum / colour / bool / seed fields.
import { useRef, useState } from 'preact/hooks';
import type { Effect, RGBA } from '../engine/types';
import {
  CURVE_MAX_POINTS, CUBE_MAX_CHARS, LUT_WARN_CHARS, STOPS_MAX, filterFields, inspectCube, readCurve, readStops, stopColorAt, type CurvePt, type FilterField, type GradStop, IDENTITY_CURVE,
} from '../state/filterSchema';
import { curveEvalTable } from '../engine/effects/filters';
import { store } from '../state/store';
import { capture } from './capture';
import { BoolField, ColorField, EnumField, NumField, SeedField, clamp, parseHex, rgbHex } from './fields';
import { ScrubSelect } from './Scrub';

/** An edit of one effect: fields to merge, or a function from the current effect to the new one (always applied to the latest draft). */
export type Patch = Record<string, unknown> | ((cur: Record<string, unknown>) => Record<string, unknown>);
type Vals = Record<string, unknown>;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const BTN = 'height:22px;padding:0 8px;border:1px solid #474747;border-radius:4px;background:#262626;color:#e3e3e3';
const SEGB = (on: boolean) => `height:22px;padding:0 8px;border-radius:3px;${on ? 'background:#3d6fb4;color:#ffffff' : 'color:#b5b5b5'}`;

// ---- curves ----

/** The curve as the filter draws it (PCHIP through the points, flat outside the end points): the engine's own table, so the editor matches the result. */
export function curveValue(pts: CurvePt[], x: number): number {
  const t = curveEvalTable(pts);
  return t[Math.min(255, Math.max(0, Math.round(x * 255)))];
}

const CURVE_SIZE = 180;
const CHAN_LABEL: Record<string, string> = { master: 'RGB', red: 'Red', green: 'Green', blue: 'Blue' };
const CHAN_COLOR: Record<string, string> = { master: '#e3e3e3', red: '#e5604f', green: '#5cc27a', blue: '#6f9bd6' };

export function CurvesEditor({ vals, keys, onSet }: { vals: Vals; keys: string[]; onSet: (p: Patch) => void }) {
  const [chan, setChan] = useState(keys[0]);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const work = useRef<CurvePt[]>([]); // the points being edited: pointer events can arrive faster than re-renders
  const pts = readCurve(vals[chan]);
  const commit = (next: CurvePt[]) => { work.current = next; onSet({ [chan]: next.map(([x, y]) => [r4(x), r4(y)]) }); };
  const xy = (e: { clientX: number; clientY: number }): CurvePt => {
    const r = svg.current!.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01(1 - (e.clientY - r.top) / r.height)];
  };
  const move = (i: number, p: CurvePt, list: CurvePt[]): CurvePt[] => {
    const lo = i > 0 ? list[i - 1][0] + 0.002 : 0, hi = i < list.length - 1 ? list[i + 1][0] - 0.002 : 1;
    const next = list.map((q) => [q[0], q[1]] as CurvePt);
    next[i] = [clamp(p[0], lo, Math.max(lo, hi)), p[1]];
    return next;
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const hit = (e.target as Element).closest('[data-curve-point]') as HTMLElement | null;
    capture(svg.current!, e.pointerId);
    work.current = pts;
    if (hit) { drag.current = Number(hit.dataset.curvePoint); return; }
    if (pts.length >= CURVE_MAX_POINTS) return;
    const p = xy(e);
    let at = pts.findIndex((q) => q[0] > p[0]);
    if (at < 0) at = pts.length;
    if ((at > 0 && p[0] - pts[at - 1][0] < 0.004) || (at < pts.length && pts[at][0] - p[0] < 0.004)) return;
    const next = [...pts.slice(0, at), p, ...pts.slice(at)];
    drag.current = at;
    commit(next);
  };
  const onMove = (e: PointerEvent) => {
    if (drag.current === null) return;
    commit(move(drag.current, xy(e), work.current));
  };
  const onUp = () => { drag.current = null; };
  const remove = (i: number) => { if (pts.length > 2) commit(pts.filter((_, k) => k !== i)); };
  const key = (e: KeyboardEvent, i: number) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(i); return; }
    const v = d[e.key];
    if (v) { e.preventDefault(); commit(move(i, [clamp01(pts[i][0] + v[0]), clamp01(pts[i][1] + v[1])], pts)); }
  };
  const S = CURVE_SIZE;
  const table = curveEvalTable(pts);
  const line = table.map((v, k) => `${k ? 'L' : 'M'}${((k / 255) * S).toFixed(1)} ${((1 - clamp01(v)) * S).toFixed(1)}`).join('');
  return (
    <div data-curves style="display:flex;flex-direction:column;gap:6px">
      <div role="group" aria-label="Curve channel" style="display:flex;gap:2px;padding:2px;background:#1f1f1f;border:1px solid #474747;border-radius:5px;align-self:flex-start">
        {keys.map((k) => <button key={k} data-curve-channel={k} aria-pressed={chan === k} onClick={() => setChan(k)} style={SEGB(chan === k)}>{CHAN_LABEL[k] ?? k}</button>)}
      </div>
      <svg ref={svg} data-curve-editor={chan} width={S} height={S} viewBox={`0 0 ${S} ${S}`} role="application" aria-label={`${CHAN_LABEL[chan] ?? chan} curve`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style="background:#1b1b1b;border:1px solid #474747;border-radius:3px;touch-action:none;cursor:crosshair;align-self:center">
        {[0.25, 0.5, 0.75].map((g) => <path key={g} d={`M${g * S} 0V${S}M0 ${g * S}H${S}`} stroke="#333" stroke-width="1" fill="none" />)}
        <path d={`M0 ${S}L${S} 0`} stroke="#3c3c3c" stroke-width="1" stroke-dasharray="3 3" fill="none" />
        <path data-curve-line d={line} stroke={CHAN_COLOR[chan] ?? '#e3e3e3'} stroke-width="1.6" fill="none" />
        {pts.map((p, i) => (
          <circle key={i} data-curve-point={i} data-x={p[0]} data-y={p[1]} cx={p[0] * S} cy={(1 - p[1]) * S} r={5} tabIndex={0} role="slider" aria-label={`Point ${i + 1}`}
            aria-valuetext={`${Math.round(p[0] * 255)} → ${Math.round(p[1] * 255)}`}
            onDblClick={() => remove(i)} onContextMenu={(e) => { e.preventDefault(); remove(i); }} onKeyDown={(e) => key(e as unknown as KeyboardEvent, i)}
            fill="#1b1b1b" stroke={CHAN_COLOR[chan] ?? '#e3e3e3'} stroke-width="2" style="cursor:grab" />
        ))}
      </svg>
      <div style="display:flex;gap:6px;align-items:center;color:#8f8f8f">
        <span data-curve-count>{pts.length} points</span>
        <span style="flex:1 1 auto">Click to add, double-click to remove</span>
        <button data-curve-reset style={BTN} onClick={() => onSet({ [chan]: IDENTITY_CURVE() })}>Reset</button>
      </div>
    </div>
  );
}

// ---- gradient stops ----

const rgbCss = (c: RGBA) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;

export function GradientEditor({ vals, fieldKey, onSet }: { vals: Vals; fieldKey: string; onSet: (p: Patch) => void }) {
  const [sel, setSel] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const stops = readStops(vals[fieldKey]);
  const work = useRef<GradStop[]>(stops); // the stops being edited: pointer events can arrive faster than re-renders
  const cur = Math.min(sel, stops.length - 1);
  const commit = (next: GradStop[]) => { work.current = next; onSet({ [fieldKey]: next.map((s) => ({ pos: r4(s.pos), color: { ...s.color } })) }); };
  const posAt = (e: { clientX: number }) => { const r = bar.current!.getBoundingClientRect(); return clamp01((e.clientX - r.left) / r.width); };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const hit = (e.target as Element).closest('[data-stop]') as HTMLElement | null;
    capture(bar.current!, e.pointerId);
    work.current = stops;
    if (hit) { const i = Number(hit.dataset.stop); drag.current = i; setSel(i); return; }
    if (stops.length >= STOPS_MAX) return;
    const pos = posAt(e);
    const next = [...stops, { pos, color: stopColorAt(stops, pos) }].sort((a, b) => a.pos - b.pos);
    const at = next.findIndex((s) => s.pos === pos);
    drag.current = at;
    setSel(at);
    commit(next);
  };
  const onMove = (e: PointerEvent) => {
    const i = drag.current;
    if (i === null) return;
    const list = work.current;
    if (!list[i]) return;
    const lo = i > 0 ? list[i - 1].pos : 0, hi = i < list.length - 1 ? list[i + 1].pos : 1;
    commit(list.map((s, k) => (k === i ? { ...s, pos: clamp(posAt(e), lo, hi) } : s)));
  };
  const onUp = () => { drag.current = null; };
  const setColor = (i: number, part: Partial<RGBA>) => commit(readStops(vals[fieldKey]).map((s, k) => (k === i ? { ...s, color: { ...s.color, ...part } } : s)));
  const setPos = (i: number, pos: number) => {
    const list = readStops(vals[fieldKey]);
    const moved = { ...list[i], pos: clamp01(pos) };
    const next = list.map((s, k) => (k === i ? moved : s)).sort((a, b) => a.pos - b.pos);
    setSel(next.indexOf(moved));
    commit(next);
  };
  const remove = (i: number) => { if (stops.length > 1) { setSel(Math.max(0, i - 1)); commit(stops.filter((_, k) => k !== i)); } };
  const css = stops.length === 1 ? rgbCss(stops[0].color) : `linear-gradient(90deg,${stops.map((s) => `${rgbCss(s.color)} ${(s.pos * 100).toFixed(1)}%`).join(',')})`;
  const s = stops[cur];
  return (
    <div data-gradient style="display:flex;flex-direction:column;gap:6px">
      <div ref={bar} data-gradient-bar onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style="position:relative;height:36px;touch-action:none;cursor:crosshair">
        <div style={`position:absolute;left:0;right:0;top:0;height:18px;border:1px solid #474747;border-radius:3px;background:${css}`} />
        {stops.map((st, i) => (
          <button key={i} data-stop={i} aria-label={`Gradient stop ${i + 1}`} aria-pressed={i === cur} style={`position:absolute;top:18px;left:calc(${(st.pos * 100).toFixed(2)}% - 6px);width:12px;height:16px;padding:0;cursor:grab;`
            + `border:2px solid ${i === cur ? '#ffffff' : '#888888'};border-radius:2px;background:${rgbCss(st.color)};box-sizing:border-box`} />
        ))}
      </div>
      {s && (
        <div style="display:flex;align-items:center;gap:6px;min-width:0">
          <input type="color" data-stop-color aria-label="Stop colour" value={rgbHex(s.color)}
            onInput={(ev) => { const [r, g, b] = parseHex((ev.target as HTMLInputElement).value); setColor(cur, { r, g, b }); }}
            style="flex:none;width:30px;height:22px;padding:0;border:1px solid #474747;border-radius:3px;background:#1f1f1f" />
          <label style="display:flex;align-items:center;gap:4px;color:#a8a8a8">Position
            <input type="number" data-stop-pos aria-label="Stop position" min={0} max={100} step={1} value={Math.round(s.pos * 100)}
              onChange={(ev) => { const n = Number((ev.target as HTMLInputElement).value); if (isFinite(n)) setPos(cur, n / 100); }}
              style="width:48px;padding:2px 4px;background:#1f1f1f;border:1px solid #474747;border-radius:4px;height:22px;box-sizing:border-box" />%
          </label>
          <span style="flex:1 1 auto" />
          <button data-stop-remove aria-disabled={stops.length < 2} style={`${BTN};opacity:${stops.length < 2 ? 0.4 : 1}`} onClick={() => remove(cur)}>Remove</button>
        </div>
      )}
      <div style="color:#8f8f8f"><span data-stop-count>{stops.length} stops</span> · click the bar to add a stop</div>
    </div>
  );
}

// ---- selective colour ----

const SC_RANGES = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas', 'Whites', 'Neutrals', 'Blacks'];
const SC_INKS = ['Cyan', 'Magenta', 'Yellow', 'Black'];

export function SelectiveColorEditor({ vals, fieldKey, onSet }: { vals: Vals; fieldKey: string; onSet: (p: Patch) => void }) {
  const [range, setRange] = useState(0);
  const raw = Array.isArray(vals[fieldKey]) ? (vals[fieldKey] as unknown[]) : [];
  const get = (i: number) => (typeof raw[i] === 'number' && isFinite(raw[i] as number) ? (raw[i] as number) : 0);
  return (
    <div data-selective style="display:flex;flex-direction:column;gap:8px">
      <label style="display:flex;align-items:center;gap:6px;color:#a8a8a8">
        <span style="flex:none;width:62px">Colours</span>
        <ScrubSelect aria-label="Colour range" value={String(range)} style="flex:1 1 auto;min-width:0" onChange={(ev) => setRange(Number((ev.target as HTMLSelectElement).value))}>
          {SC_RANGES.map((n, i) => <option key={n} value={String(i)} selected={i === range}>{n}</option>)}
        </ScrubSelect>
      </label>
      {SC_INKS.map((ink, k) => {
        const idx = range * 4 + k;
        return <NumField key={`${range}-${k}`} f={{ key: `${fieldKey}${idx}`, label: ink, min: -100, max: 100, step: 1, unit: '%', digits: 0 }} value={Math.round(get(idx) * 100)}
          onChange={(v) => onSet((cur) => {
            const a = Array.isArray(cur[fieldKey]) ? (cur[fieldKey] as number[]).slice() : new Array(36).fill(0);
            while (a.length < 36) a.push(0);
            a[idx] = v / 100;
            return { ...cur, [fieldKey]: a };
          })} />;
      })}
    </div>
  );
}

// ---- LUT ----

export function LutField({ vals, fieldKey, onSet }: { vals: Vals; fieldKey: string; onSet: (p: Patch) => void }) {
  const text = typeof vals[fieldKey] === 'string' ? (vals[fieldKey] as string) : '';
  const info = inspectCube(text);
  const [paste, setPaste] = useState(false);
  const [err, setErr] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const load = (t: string, name?: string) => {
    if (t.length > CUBE_MAX_CHARS) { setErr('The .cube file is too large (12 MB limit)'); return; }
    const i = inspectCube(t);
    if (!i.ok) { setErr(`Not a usable 3D .cube LUT: ${i.reason}`); return; }
    setErr('');
    onSet({ [fieldKey]: t });
    if (name) store.setNotice(`Loaded LUT ${name}`);
  };
  return (
    <div data-lut style="display:flex;flex-direction:column;gap:6px">
      <div data-lut-status style={`color:${text ? (info.ok ? '#e3e3e3' : '#f0b45a') : '#8f8f8f'}`}>
        {!text ? 'No LUT loaded (the filter does nothing)' : info.ok ? `${info.title || 'LUT'} · ${info.size}×${info.size}×${info.size}` : `Unusable LUT: ${info.reason}`}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-lut-file style={BTN} onClick={() => file.current?.click()}>Load .cube…</button>
        <button data-lut-paste style={BTN} aria-expanded={paste} onClick={() => setPaste(!paste)}>Paste text…</button>
        <button data-lut-clear style={`${BTN};opacity:${text ? 1 : 0.4}`} aria-disabled={!text} onClick={() => { if (text) { setErr(''); onSet({ [fieldKey]: '' }); } }}>Clear</button>
      </div>
      <input ref={file} type="file" accept=".cube,.txt,text/plain" hidden data-lut-input aria-hidden="true" tabIndex={-1}
          onChange={async (ev) => {
            const input = ev.target as HTMLInputElement, f = input.files?.[0];
            input.value = '';
            if (!f) return;
            if (f.size > CUBE_MAX_CHARS) { setErr('The .cube file is too large (12 MB limit)'); return; }
            try { load(await f.text(), f.name); } catch { setErr('Could not read the file'); }
          }} />
      {text.length > LUT_WARN_CHARS && <div data-lut-warn style="color:#f0b45a">Large LUT ({(text.length / 1048576).toFixed(1)} MB): it is stored in the document and sent to TouchDesigner.</div>}
      {paste && (
        <div style="display:flex;flex-direction:column;gap:6px">
          <textarea ref={area} data-lut-text aria-label=".cube text" rows={5}
            style="resize:vertical;background:#1f1f1f;color:#e3e3e3;border:1px solid #474747;border-radius:4px;font:11px monospace;min-height:60px" />
          <button data-lut-apply style={`${BTN};align-self:flex-start`} onClick={() => { const t = area.current?.value ?? ''; load(t); if (inspectCube(t).ok) setPaste(false); }}>Use this LUT</button>
        </div>
      )}
      {err && <div data-lut-error style="color:#f07a6a">{err}</div>}
    </div>
  );
}

// ---- displace source ----

export function AuxPicker({ vals, onSet, selfId }: { vals: Vals; onSet: (p: Patch) => void; selfId?: string }) {
  store.docVersion.value;
  const layers = (store.hasEngine() ? store.engine.layers() : []).filter((l) => l.id !== selfId && (l.kind === 'pixel' || l.kind === 'input' || l.kind === 'text' || l.kind === 'shape'));
  const inputs = store.connectedInputs();
  // effect params: source 'noise' | 'aux' and auxSource 'layer:<layerId>' | 'input:<n>' (n 1..8)
  const aux = typeof vals.auxSource === 'string' ? vals.auxSource : '';
  const value = vals.source !== 'aux' ? 'noise' : /^(layer|input):.+/.test(aux) ? aux : 'aux:';
  const choose = (v: string) => onSet((cur) => {
    const n: Record<string, unknown> = { ...cur };
    delete n.auxSource;
    if (v === 'noise') n.source = 'noise';
    else if (v.startsWith('layer:') || v.startsWith('input:')) { n.source = 'aux'; n.auxSource = v; }
    else n.source = 'aux';
    return n;
  });
  const known = value === 'aux:' || value === 'noise' || layers.some((l) => `layer:${l.id}` === value) || inputs.some((i) => `input:${i.input}` === value);
  return (
    <label style="display:flex;align-items:center;gap:6px;color:#a8a8a8">
      <span style="flex:none;width:62px">Source</span>
      <ScrubSelect aria-label="Displace source" data-fx-aux value={value} style="flex:1 1 auto;min-width:0" onChange={(ev) => choose((ev.target as HTMLSelectElement).value)}>
        <option value="noise" selected={value === 'noise'}>Noise</option>
        {value === 'aux:' && <option value="aux:" selected>Choose a source…</option>}
        {!known && <option value={value} selected>{value.startsWith('layer:') ? 'Layer (missing)' : 'TD input (missing)'}</option>}
        {layers.length > 0 && <optgroup label="Another layer">{layers.map((l) => <option key={l.id} value={`layer:${l.id}`} selected={value === `layer:${l.id}`}>{l.name}</option>)}</optgroup>}
        {inputs.length > 0 && <optgroup label="TD input">{inputs.map((i) => <option key={i.input} value={`input:${i.input}`} selected={value === `input:${i.input}`}>TD input {i.input}</option>)}</optgroup>}
      </ScrubSelect>
    </label>
  );
}

// ---- generic ----

/** All parameter editors of a library filter. `onSet` receives the edit; `selfId` = the layer being edited (excluded from the displace source list). */
export function FilterParams({ fx, onSet, selfId }: { fx: Effect; onSet: (p: Patch) => void; selfId?: string }) {
  const vals = fx as unknown as Vals;
  const setColor = (key: string, part: Partial<RGBA>) => onSet((cur) => ({ ...cur, [key]: { ...(cur[key] as RGBA), ...part } }));
  const one = (f: FilterField) => {
    switch (f.kind) {
      case 'num': return <NumField key={f.key} f={f} value={vals[f.key] as number} onChange={(v) => onSet({ [f.key]: v })} />;
      case 'enum': return <EnumField key={f.key} f={f} value={vals[f.key] as string} onChange={(v) => onSet({ [f.key]: v })} />;
      case 'color': return <ColorField key={f.key} f={f} value={vals[f.key] as RGBA} onChange={(c) => setColor(f.key, c)} />;
      case 'bool': return <BoolField key={f.key} f={f} value={vals[f.key] as boolean} onChange={(v) => onSet({ [f.key]: v })} />;
      case 'seed': return <SeedField key={f.key} f={f} value={vals[f.key] as number} onChange={(v) => onSet({ [f.key]: v })} />;
      case 'curves': return <CurvesEditor key="curves" vals={vals} keys={f.keys} onSet={onSet} />;
      case 'stops': return <GradientEditor key={f.key} vals={vals} fieldKey={f.key} onSet={onSet} />;
      case 'list': return <SelectiveColorEditor key={f.key} vals={vals} fieldKey={f.key} onSet={onSet} />;
      case 'lut': return <LutField key={f.key} vals={vals} fieldKey={f.key} onSet={onSet} />;
      case 'aux': return <AuxPicker key="aux" vals={vals} onSet={onSet} selfId={selfId} />;
    }
  };
  // blur: a sigma > 0 overrides the radius (migrated legacy blurs), so the Radius slider would do nothing then
  const fields = filterFields(fx.type).filter((f) => !((fx.type as string) === 'blur' && f.key === 'radius' && Number(vals.sigma) > 0));
  return <>{fields.map(one)}</>;
}

/** Apply a Patch to an effect. */
export function applyPatch(e: Effect, patch: Patch): Effect {
  const cur = e as unknown as Record<string, unknown>;
  return (typeof patch === 'function' ? patch(cur) : { ...cur, ...patch }) as unknown as Effect;
}
