import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Effect, EffectType, LayerInfo, RGBA } from '../engine/types';
import { EFFECT_FIELDS, EFFECT_LABELS, EFFECT_ORDER, EXPERIMENTAL, defaultEffect, type EffectField } from '../state/effectDefaults';
import { store } from '../state/store';
import { Icon } from './Icon';

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const rgbHex = (c: RGBA) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const parseHex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const BTN = 'width:20px;height:22px;flex:none;padding:0';

function NumField({ f, value, onChange }: { f: Extract<EffectField, { kind: 'num' }>; value: number; onChange: (v: number) => void }) {
  return (
    <div style="display:flex;flex-direction:column;gap:2px">
      <label style="display:flex;justify-content:space-between;color:#a8a8a8">
        <span>{f.label}</span>
        <span data-fx-value={f.key} style="color:#e3e3e3">{value.toFixed(f.digits ?? 0)}{f.unit ?? ''}</span>
      </label>
      <input type="range" aria-label={f.label} min={f.min} max={f.max} step={f.step} value={value}
        onInput={(ev) => { const n = parseFloat((ev.target as HTMLInputElement).value); if (!isNaN(n)) onChange(clamp(n, f.min, f.max)); }} />
    </div>
  );
}

function ColorField({ f, value, onChange }: { f: Extract<EffectField, { kind: 'color' }>; value: RGBA; onChange: (c: Partial<RGBA>) => void }) {
  return (
    <div style="display:flex;align-items:center;gap:6px;min-width:0">
      <span style="flex:none;width:62px;color:#a8a8a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{f.label}</span>
      <input type="color" data-fx-color={f.key} aria-label={f.label} value={rgbHex(value)}
        onInput={(ev) => { const [r, g, b] = parseHex((ev.target as HTMLInputElement).value); onChange({ r, g, b }); }}
        style="flex:none;width:30px;height:22px;padding:0;border:1px solid #474747;border-radius:3px;background:#1f1f1f" />
      <input type="range" data-fx-alpha={f.key} aria-label={`${f.label} alpha`} title="Alpha" min={0} max={255} step={1} value={value.a}
        onInput={(ev) => { const a = parseInt((ev.target as HTMLInputElement).value, 10); if (!isNaN(a)) onChange({ a: clamp(a, 0, 255) }); }}
        style="flex:1 1 auto;min-width:0" />
    </div>
  );
}

function EnumField({ f, value, onChange }: { f: Extract<EffectField, { kind: 'enum' }>; value: string; onChange: (v: string) => void }) {
  return (
    <label style="display:flex;align-items:center;gap:6px;color:#a8a8a8">
      <span style="flex:none;width:62px">{f.label}</span>
      <select aria-label={f.label} value={value} style="flex:1 1 auto;min-width:0" onChange={(ev) => onChange((ev.target as HTMLSelectElement).value)}>
        {f.options.map(([v, t]) => <option key={v} value={v} selected={v === value}>{t}</option>)}
      </select>
    </label>
  );
}

function EffectRow({ fx, index, count, open, onToggleOpen, edit, onMove, onRemove }: {
  fx: Effect; index: number; count: number; open: boolean; onToggleOpen: () => void; edit: (fn: (list: Effect[]) => Effect[]) => void;
  onMove: (index: number, d: number) => void; onRemove: (index: number) => void;
}) {
  const label = EFFECT_LABELS[fx.type];
  const set = (patch: Record<string, unknown>) => edit((l) => l.map((e, i) => (i === index ? ({ ...e, ...patch } as Effect) : e)));
  // colour edits merge into the latest draft so two edits in one frame never drop each other
  const setColor = (key: string, part: Partial<RGBA>) => edit((l) => l.map((e, i) => (i === index ? ({ ...e, [key]: { ...(e as unknown as Record<string, RGBA>)[key], ...part } } as Effect) : e)));
  const vals = fx as unknown as Record<string, unknown>;
  return (
    <div data-effect={fx.type} data-effect-index={index} data-enabled={fx.enabled} style="border-bottom:1px solid #1f1f1f">
      <div style="display:flex;align-items:center;gap:4px;min-height:32px;padding:2px 8px">
        <input type="checkbox" data-fx-enable aria-label={`Enable ${label}`} checked={fx.enabled} onChange={(ev) => set({ enabled: (ev.target as HTMLInputElement).checked })} style="flex:none;margin:0 4px 0 0" />
        <button class="ib" data-fx-open aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} onClick={onToggleOpen}
          style={`flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;text-align:left;padding:0 2px;opacity:${fx.enabled ? 1 : 0.55}`}>
          <span data-fx-name style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e3e3e3">{label}</span>
          {EXPERIMENTAL.has(fx.type) && <span data-fx-experimental style="font-size:10px;color:#d9a441">Experimental</span>}
        </button>
        <button class="ib" data-fx-up aria-label={`Move ${label} up`} aria-disabled={index === 0} onClick={() => index > 0 && onMove(index, -1)} style={`${BTN};opacity:${index === 0 ? 0.35 : 1}`}><Icon d="M6 15l6-6 6 6" size={12} sw={2} /></button>
        <button class="ib" data-fx-down aria-label={`Move ${label} down`} aria-disabled={index === count - 1} onClick={() => index < count - 1 && onMove(index, 1)} style={`${BTN};opacity:${index === count - 1 ? 0.35 : 1}`}><Icon d="M6 9l6 6 6-6" size={12} sw={2} /></button>
        <button class="ib" data-fx-remove aria-label={`Remove ${label}`} onClick={() => onRemove(index)} style={BTN}><Icon d="M6 6l12 12M18 6L6 18" size={12} sw={2} /></button>
      </div>
      {open && (
        <div data-fx-params style="display:flex;flex-direction:column;gap:8px;padding:4px 10px 10px 28px">
          {EFFECT_FIELDS[fx.type].map((f) => f.kind === 'num'
            ? <NumField key={f.key} f={f} value={vals[f.key] as number} onChange={(v) => set({ [f.key]: v })} />
            : f.kind === 'enum'
              ? <EnumField key={f.key} f={f} value={vals[f.key] as string} onChange={(v) => set({ [f.key]: v })} />
              : <ColorField key={f.key} f={f} value={vals[f.key] as RGBA} onChange={(c) => setColor(f.key, c)} />)}
        </div>
      )}
    </div>
  );
}

function AddMenu({ onAdd }: { onAdd: (t: EffectType) => void }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  }, [menu]);
  return (
    <div ref={ref} style="position:relative;flex:none;padding:6px 10px;border-top:1px solid #1f1f1f;background:#282828">
      <button data-fx-add aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}
        style="width:100%;height:26px;border:1px solid #474747;border-radius:5px;background:#262626;color:#e3e3e3">Add effect ▾</button>
      {menu && (
        <div role="menu" aria-label="Add effect" style="position:absolute;left:10px;right:10px;bottom:100%;z-index:50;padding:4px;background:#2f2f2f;border:1px solid #161616;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.55)">
          {EFFECT_ORDER.map((t, i) => (
            <Fragment key={t}>
              {i > 0 && EXPERIMENTAL.has(t) && !EXPERIMENTAL.has(EFFECT_ORDER[i - 1]) && <div role="separator" style="height:1px;margin:4px 6px;background:#161616" />}
              <button role="menuitem" class="mi" data-add-effect={t} onClick={() => { setMenu(false); onAdd(t); }}
                style="display:flex;width:100%;box-sizing:border-box;align-items:center;justify-content:space-between;height:26px;padding:0 10px;border-radius:4px;text-align:left;color:#e3e3e3">
                <span>{EFFECT_LABELS[t]}</span>{EXPERIMENTAL.has(t) && <span style="font-size:10px;color:#d9a441">Experimental</span>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** The Effects tab: ordered effects of the active layer; every edit goes through store.editEffects (one engine call per frame). */
export function EffectsPanel({ layer }: { layer: LayerInfo | undefined }) {
  store.docVersion.value;
  // stable id per effect row (parallel to the effects array, per layer) so the open state follows reorders and removals
  const ids = useRef<Map<string, number[]>>(new Map());
  const nextId = useRef(1);
  const [openSet, setOpenSet] = useState<Record<number, boolean>>({});
  if (!layer || !store.canHaveEffects(layer.kind)) {
    return <div data-effects-hint style="padding:12px;color:#a8a8a8">Effects are available for pixel, text, shape and input layers.</div>;
  }
  const effects = store.pendingEffects(layer.id) ?? layer.effects;
  const list = ids.current.get(layer.id) ?? [];
  while (list.length < effects.length) list.push(nextId.current++);
  list.length = effects.length;
  ids.current.set(layer.id, list);
  const edit = (fn: (list: Effect[]) => Effect[]) => store.editEffects(layer.id, fn(store.pendingEffects(layer.id) ?? layer.effects));
  const add = (t: EffectType) => {
    const id = nextId.current++;
    list.push(id);
    edit((l) => [...l, defaultEffect(t)]);
    setOpenSet((o) => ({ ...o, [id]: true }));
  };
  const onMove = (i: number, d: number) => {
    const [id] = list.splice(i, 1);
    list.splice(i + d, 0, id);
    edit((l) => { const n = l.slice(); const [e] = n.splice(i, 1); n.splice(i + d, 0, e); return n; });
  };
  const onRemove = (i: number) => { list.splice(i, 1); edit((l) => l.filter((_, k) => k !== i)); };
  return (
    <div data-effects-panel data-layer-id={layer.id} style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">
      <div style="flex:none;padding:6px 10px;color:#a8a8a8;border-bottom:1px solid #1f1f1f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Effects on <b style="color:#e3e3e3;font-weight:500">{layer.name}</b></div>
      <div style="flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden">
        {effects.length === 0 && <div data-effects-empty style="padding:12px;color:#8f8f8f">No effects. Use Add effect.</div>}
        {effects.map((fx, i) => (
          <EffectRow key={`${layer.id}-${list[i]}`} fx={fx} index={i} count={effects.length} open={!!openSet[list[i]]}
            onToggleOpen={() => { const rid = list[i]; setOpenSet((o) => ({ ...o, [rid]: !o[rid] })); }} edit={edit} onMove={onMove} onRemove={onRemove} />
        ))}
      </div>
      <AddMenu onAdd={add} />
    </div>
  );
}
