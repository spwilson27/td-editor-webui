import { Component } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LayerInfo } from '../engine/types';
import { computeDrop, dropZone, type DropZone } from '../state/layerDrop';
import { EffectCatalogue } from './EffectCatalogue';
import { capture } from './capture';
import { store } from '../state/store';
import { effectLabel } from '../state/effectDefaults';
import { BLEND_LABELS, BLEND_MODES, TOOLS, shapeKind } from '../state/tools';
import { Icon, NOT_IN_VERSION } from './Icon';

const EYE = 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z';
const EYE_OFF = 'M3 3l18 18M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3 3.7M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 005.4-1.6';
const LOCK = 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4';
const FLATTEN = 'M4 8l8-4 8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4';
const FOLDER = 'M3 6h7l2 2h9v11H3z';

const ADJUST_ICON = 'M12 3a9 9 0 100 18V3z M12 3a9 9 0 010 18';
const MASK_ICON = 'M4 4h16v16H4zM12 8a4 4 0 100 8 4 4 0 000-8z';

const FOLDER_OPEN = 'M3 19V6h7l2 2h8v3M3 19l3-8h17l-3 8z';
/** Per-depth indent of the rows (px) and the left padding of depth 0. */
const IND = 16, PAD = 6;

/** Each group gets a stable colour (guide line, header tint, child block). */
export function groupColors(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  const hue = [212, 152, 32, 282, 188, 340, 92, 12][h % 8];
  return { solid: `hsl(${hue} 62% 62%)`, header: `hsla(${hue},55%,55%,0.20)`, block: `hsla(${hue},55%,55%,0.08)` };
}
const layerAdjustLabel = (l: LayerInfo) => (l.effects.length ? l.effects.map((x) => effectLabel(x.type)).join(' + ') : 'Adjustment');

let suppressClick = false; // a drag ends with a click on the row: it must not change the selection

function Thumb({ layer }: { layer: LayerInfo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tick = store.thumbTick.value;
  useEffect(() => {
    if (layer.kind !== 'group' && layer.kind !== 'adjustment' && layer.kind !== 'text' && layer.kind !== 'shape' && ref.current) store.engine.drawThumbnail(layer.id, ref.current);
  }, [layer.id, layer.kind, tick]);
  const bg = 'background-color:#ffffff;background-image:repeating-conic-gradient(#cfcfcf 0 25%,#ffffff 0 50%);background-size:8px 8px';
  if (layer.kind === 'adjustment') {
    return <span aria-hidden="true" data-adjust-icon title={layerAdjustLabel(layer)} style="width:34px;height:24px;flex:none;border-radius:2px;box-shadow:0 0 0 1px #111111;background:#3a3a3a;display:flex;align-items:center;justify-content:center;color:#d4d4d4"><Icon d={ADJUST_ICON} size={14} sw={1.6} /></span>;
  }
  if (layer.kind === 'text' || layer.kind === 'shape') {
    const d = layer.kind === 'text' ? TOOLS.find((t) => t.id === 'text')!.d : shapeKind(layer.shape?.type ?? 'rect').d;
    return <span aria-hidden="true" data-kind-icon={layer.kind} title={layer.kind === 'text' ? 'Text layer' : 'Shape layer'} style="width:34px;height:24px;flex:none;border-radius:2px;box-shadow:0 0 0 1px #111111;background:#3a3a3a;display:flex;align-items:center;justify-content:center;color:#d4d4d4"><Icon d={d} size={14} sw={1.6} /></span>;
  }
  if (layer.kind === 'group') {
    const c = groupColors(layer.id);
    return <span aria-hidden="true" data-folder={layer.expanded ? 'open' : 'closed'} style={`width:34px;height:24px;flex:none;border-radius:2px;box-shadow:0 0 0 1px ${c.solid};background:#3a3a3a;display:flex;align-items:center;justify-content:center;color:${c.solid}`}><Icon d={layer.expanded ? FOLDER_OPEN : FOLDER} size={15} sw={1.8} /></span>;
  }
  return <canvas ref={ref} width={68} height={48} aria-hidden="true" style={`width:34px;height:24px;flex:none;border-radius:2px;box-shadow:0 0 0 1px #111111;${bg}`} />;
}

function MaskThumb({ layer, target }: { layer: LayerInfo; target: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tick = store.thumbTick.value;
  const mask = layer.mask!;
  useEffect(() => { if (ref.current) store.engine.drawMaskThumbnail(layer.id, ref.current); }, [layer.id, mask.slot, tick]);
  const e = store.engine;
  return (
    <button class="ib" data-nodrag data-act="mask" aria-label={`Mask of ${layer.name}`} aria-pressed={target} data-enabled={mask.enabled}
      title="Click: paint on mask. Shift-click: disable/enable mask"
      onClick={(ev) => { ev.stopPropagation(); if (ev.shiftKey) e.setMaskEnabled(layer.id, !mask.enabled); else e.setPaintTarget(layer.id, 'mask'); }}
      style={`position:relative;width:34px;height:24px;flex:none;border-radius:2px;padding:0;box-shadow:0 0 0 ${target ? 2 : 1}px ${target ? '#7fb2f0' : '#111111'};background:#000000;overflow:hidden`}>
      <canvas ref={ref} width={68} height={48} aria-hidden="true" style={`width:34px;height:24px;display:block;opacity:${mask.enabled ? 1 : 0.45}`} />
      {!mask.enabled && (
        <svg data-mask-off width="34" height="24" viewBox="0 0 34 24" aria-hidden="true" style="position:absolute;left:0;top:0">
          <path d="M8 3l18 18M26 3L8 21" stroke="#e5483c" stroke-width="2" stroke-linecap="round" fill="none" />
        </svg>
      )}
    </button>
  );
}

function NameField({ layer, onDone }: { layer: LayerInfo; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const commit = (save: boolean) => {
    const v = ref.current?.value.trim();
    if (save && v && v !== layer.name) store.engine.setLayerProps(layer.id, { name: v });
    onDone();
  };
  return (
    <input ref={ref} value={layer.name} aria-label="Layer name" onBlur={() => commit(true)} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); }}
      style="flex:1 1 auto;min-width:0;height:22px;box-sizing:border-box;padding:0 4px;color:#e3e3e3;background:#1f1f1f;border:1px solid #4a8fe0;border-radius:3px" />
  );
}

interface DragState { id: string; target: string | null; zone: DropZone }

interface AncestorRef { id: string; depth: number }
interface FlatState { enabled: boolean; title: string; tooltip: string; reason: string | null }
/** Everything a row draws from, as plain values: a row re-renders only when one of them changes. */
interface RowProps {
  layer: LayerInfo; selected: boolean; active: boolean; maskTarget: boolean; editing: boolean; onEdit: (id: string | null) => void;
  dropZone: DropZone | null; tdPreview: boolean; hiddenByParent: boolean; ancestors: AncestorRef[]; ends: string[]; childCount: number; flat: FlatState; busy: boolean;
}

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** engine.layers() hands out fresh objects each call: compare by value (structured fields only when the reference differs). */
function sameLayer(a: LayerInfo, b: LayerInfo): boolean {
  if (a === b) return true;
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;
  for (const k of Object.keys(x)) if (x[k] !== y[k] && !(typeof x[k] === 'object' && sameJson(x[k], y[k]))) return false;
  return Object.keys(y).length === Object.keys(x).length;
}
function sameRow(a: RowProps, b: RowProps): boolean {
  return a.selected === b.selected && a.active === b.active && a.maskTarget === b.maskTarget && a.editing === b.editing && a.onEdit === b.onEdit
    && a.dropZone === b.dropZone && a.tdPreview === b.tdPreview && a.hiddenByParent === b.hiddenByParent && a.childCount === b.childCount && a.busy === b.busy
    && a.ends.join() === b.ends.join() && a.ancestors.map((x) => x.id + x.depth).join() === b.ancestors.map((x) => x.id + x.depth).join()
    && a.flat.enabled === b.flat.enabled && a.flat.title === b.flat.title && a.flat.tooltip === b.flat.tooltip && a.flat.reason === b.flat.reason
    && sameLayer(a.layer, b.layer);
}
class MemoRow extends Component<RowProps> {
  shouldComponentUpdate(next: RowProps) { return !sameRow(this.props, next); }
  render() { return <LayerRow {...this.props} />; }
}

function LayerRow({ layer, selected, active, maskTarget, editing, onEdit, dropZone: zone, tdPreview, hiddenByParent, ancestors, ends, childCount, flat, busy }: RowProps) {
  const e = store.engine;
  const group = layer.kind === 'group';
  const dim = !layer.visible || hiddenByParent;
  const pad = PAD + layer.depth * IND;
  const pct = layer.opacity < 1 ? `${Math.round(layer.opacity * 100)}%` : '';
  const collapsedCount = group && !layer.expanded ? childCount : null;
  const meta = group ? (collapsedCount === null ? 'Group' : '') : layer.kind === 'input' ? [`In ${layer.input ?? '?'}`, pct].filter(Boolean).join(' · ') : pct;
  const canFx = store.canHaveEffects(layer.kind);
  const fxCount = layer.effects.length, fxOn = layer.effects.some((x) => x.enabled);
  const disconnected = layer.kind === 'input' && layer.inputConnected === false;
  const fg = selected ? '#ffffff' : dim ? '#8f8f8f' : '#e3e3e3';
  const own = group ? groupColors(layer.id) : null;
  const tints = [...ancestors.map((a) => groupColors(a.id).block), ...(own ? [own.header] : [])];
  const tint = tints.length ? tints.map((c) => `linear-gradient(${c},${c})`).join(',') : '';
  const dropHere = zone !== null;
  const into = zone === 'into';
  const indDepth = dropHere ? (into ? layer.depth + 1 : layer.depth) : 0;
  const guideX = (depth: number) => PAD + depth * IND + 12;
  const emptyOpen = group && layer.expanded && childCount === 0;
  return (
    <div class={'row' + (selected ? (active ? ' sel' : ' sel2') : '')} data-layer={layer.id} data-selected={selected} data-active={active || undefined} data-depth={layer.depth}
      data-group-header={group || undefined} data-tint={tint ? '' : undefined}
      style={`position:relative;display:flex;align-items:center;gap:6px;height:40px;padding-right:8px;padding-left:${pad}px;color:${fg};${tint ? `--tint:${tint};` : ''}${into ? 'box-shadow:inset 0 0 0 2px #7fb2f0;' : ''}`}>
      {ancestors.map((a) => {
        const c = groupColors(a.id).solid;
        return <span key={a.id} data-guide={a.id} aria-hidden="true" style={`position:absolute;left:${guideX(a.depth)}px;top:0;bottom:0;width:2px;background:${c};opacity:0.75;pointer-events:none`} />;
      })}
      {group && layer.expanded && childCount > 0 && <span data-guide={layer.id} aria-hidden="true" style={`position:absolute;left:${guideX(layer.depth)}px;top:32px;bottom:0;width:2px;background:${own!.solid};opacity:0.75;pointer-events:none`} />}
      {[...ancestors, ...(emptyOpen ? [layer] : [])].filter((a) => ends.includes(a.id)).map((a) => {
        const c = groupColors(a.id).solid;
        return <span key={a.id} data-group-end={a.id} aria-hidden="true" style={`position:absolute;left:${guideX(a.depth)}px;right:6px;bottom:0;height:2px;background:${c};opacity:0.6;border-radius:0 0 0 2px;pointer-events:none`} />;
      })}
      {dropHere && (
        <span data-drop-indicator data-drop-zone={zone} data-drop-depth={indDepth} aria-hidden="true"
          style={`position:absolute;left:${PAD + indDepth * IND}px;right:4px;${zone === 'before' ? 'top:-1px' : 'bottom:-1px'};height:2px;background:#7fb2f0;border-radius:1px;pointer-events:none;z-index:3`}>
          <span style="position:absolute;left:-3px;top:-2px;width:6px;height:6px;border-radius:3px;background:#7fb2f0" />
        </span>
      )}
      <button class="ib" data-nodrag data-act="vis" aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`} aria-pressed={layer.visible}
        onClick={() => store.setLayerFlag(layer.id, { visible: !layer.visible })}
        style={`width:26px;height:26px;flex:none;opacity:${hiddenByParent ? 0.4 : 1}`}>
        <Icon d={layer.visible ? EYE : EYE_OFF} />
      </button>
      {group
        ? (
          <button class="ib" data-nodrag data-act="open" aria-label={`${layer.expanded ? 'Collapse' : 'Expand'} ${layer.name}`} aria-expanded={!!layer.expanded}
            onClick={() => e.setLayerProps(layer.id, { expanded: !layer.expanded })} style="width:16px;height:26px;flex:none">
            <Icon d="M9 6l6 6-6 6" size={10} sw={2.6} style={`transform:rotate(${layer.expanded ? 90 : 0}deg)`} />
          </button>
        )
        : <span aria-hidden="true" style="width:16px;flex:none" />}
      <div data-act="sel" role="button" aria-pressed={selected} tabIndex={0}
        onClick={(ev) => { if (suppressClick) return; store.clickLayer(layer.id, { shift: ev.shiftKey, toggle: ev.metaKey || ev.ctrlKey }); }}
        onKeyDown={(ev) => {
          if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
          ev.preventDefault(); ev.stopPropagation(); // Space must not start panning
          store.clickLayer(layer.id, { shift: ev.shiftKey, toggle: ev.metaKey || ev.ctrlKey });
        }}
        onDblClick={() => onEdit(layer.id)}
        style="flex:1 1 auto;min-width:0;height:40px;display:flex;align-items:center;gap:10px;text-align:left;cursor:default">
        <span data-act="thumb" onClick={() => { if (layer.mask) e.setPaintTarget(layer.id, 'pixels'); }} style={`display:flex;opacity:${disconnected ? 0.45 : 1}`}><Thumb layer={layer} /></span>
        {layer.mask && <MaskThumb layer={layer} target={active && maskTarget} />}
        {editing
          ? <NameField layer={layer} onDone={() => onEdit(null)} />
          : <span data-name style={`flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:${disconnected ? 0.55 : 1};${group ? 'font-weight:600;' : ''}`}>{layer.name}</span>}
        {collapsedCount !== null && (
          <span data-child-count title={`${collapsedCount} layer${collapsedCount === 1 ? '' : 's'} inside`}
            style={`flex:none;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;color:${own!.solid};border:1px solid ${own!.solid}`}>{collapsedCount}</span>
        )}
        {disconnected && (
          <span data-disconnected title={`TD input ${layer.input} is not connected - placement is kept`} aria-label={`TD input ${layer.input} is not connected`}
            style="flex:none;display:flex;color:#d9a441"><Icon d="M12 4l9 16H3zM12 10v4M12 17v1" size={13} sw={1.8} /></span>
        )}
        {tdPreview && (() => {
          const pending = layer.previewPending ?? store.layerPreviewState(layer.id) !== 'ready';
          return (
            <span data-td-render data-pending={pending || undefined} title={pending ? "This layer's effects are shown from TouchDesigner's render; it has not arrived yet" : "This layer's effects are shown from TouchDesigner's render"}
              style={`flex:none;font-size:9px;font-weight:600;letter-spacing:0.02em;padding:1px 4px;border-radius:3px;white-space:nowrap;color:${pending ? '#d9a441' : '#7fd9a0'};border:1px solid ${pending ? '#6b5320' : '#2f6b45'}`}>
              {pending ? 'TD render · pending' : 'TD render'}
            </span>
          );
        })()}
        {canFx && fxCount > 0 && <span data-fx-badge title={`${fxCount} effect${fxCount === 1 ? '' : 's'}${fxOn ? '' : ' (all disabled)'}`} style={`flex:none;font-size:10px;font-style:italic;font-weight:600;color:#7fb2f0;opacity:${fxOn ? 1 : 0.4}`}>fx</span>}
        <span data-meta style={`flex:none;font-size:11px;color:${selected ? '#e6eefa' : '#a8a8a8'}`}>{meta}</span>
      </div>
      <button class="ib flattenbtn" data-nodrag data-act="flatten" data-kind={layer.kind} aria-label={flat.enabled || !flat.reason ? flat.title : `${flat.title} (${flat.reason})`} aria-disabled={!flat.enabled} data-busy={busy || undefined}
        title={flat.tooltip} onClick={() => { if (flat.enabled) void store.flattenLayer(layer.id); }}
        style={`width:22px;height:26px;flex:none;opacity:${flat.enabled ? 0.8 : 0.35}`}>
        <Icon d={FLATTEN} size={14} sw={1.8} />
      </button>
      <button class={'ib lockbtn' + (layer.locked ? ' on' : '')} data-nodrag data-act="lock" aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`} aria-pressed={layer.locked}
        onClick={() => store.setLayerFlag(layer.id, { locked: !layer.locked })} style="width:20px;height:26px;flex:none">
        <Icon d={LOCK} size={13} sw={2} />
      </button>
    </div>
  );
}

function LayerSettings({ layer }: { layer: LayerInfo | undefined }) {
  const e = store.engine;
  const opacity = layer ? String(Math.round(layer.opacity * 100)) : '100';
  const commit = (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    const n = Math.min(100, Math.max(0, parseFloat(input.value)));
    if (layer && !isNaN(n)) e.setLayerProps(layer.id, { opacity: n / 100 });
    input.value = opacity;
  };
  return (
    <>
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #1f1f1f">
      <select aria-label="Blend mode" disabled={!layer || layer.kind === 'adjustment'} value={layer?.blend || 'normal'} style="flex:1 1 auto"
        onChange={(ev) => layer && e.setLayerProps(layer.id, { blend: (ev.target as HTMLSelectElement).value as LayerInfo['blend'] })}>
        {BLEND_MODES.map((b) => <option key={b} value={b} selected={layer?.blend === b}>{BLEND_LABELS[b]}</option>)}
      </select>
      <label for="lop" style="color:#a8a8a8">Opacity</label>
      <span style="display:flex;align-items:center;min-width:38px;box-sizing:border-box;padding:3px 6px;background:#1f1f1f;border:1px solid #474747;border-radius:4px">
        <input id="lop" key={(layer?.id || '') + opacity} defaultValue={opacity} inputMode="numeric" aria-label="Layer opacity" disabled={!layer}
          onChange={commit} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }}
          style="width:26px;padding:0;text-align:right;color:#e3e3e3;background:none;border:0;outline:0" />%
      </span>
    </div>
    </>
  );
}

export function LayersPanel() {
  store.docVersion.value;
  const e = store.engine;
  const layers = e.layers(); // once per render
  const activeId = e.activeLayerId();
  const active = layers.find((l) => l.id === activeId);
  const paint = e.paintTarget();
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const tdLayers = new Set(e.tdPreviewLayers());
  store.layerPreviews.value;
  store.layerSel.value;
  const list = useRef<HTMLDivElement>(null);
  const selectedIds = store.selectedIds(layers, activeId);
  const selectedSet = new Set(selectedIds);
  const busyId = store.flattening.value;
  // group structure: direct child counts (also of collapsed groups, whose rows are not listed), ancestors, where each group ends
  const counts = useRef<{ ver: number; n: number; map: Map<string, number> }>({ ver: -1, n: -1, map: new Map() });
  if (layers.some((l) => l.kind === 'group') && (counts.current.ver !== store.docspecVersion.value || counts.current.n !== layers.length)) {
    const map = new Map<string, number>();
    for (const sp of e.docSpec().layers) if (sp.parentId) map.set(sp.parentId, (map.get(sp.parentId) ?? 0) + 1);
    counts.current = { ver: store.docspecVersion.value, n: layers.length, map };
  }
  const byId = new Map(layers.map((l) => [l.id, l]));
  const hiddenMemo = new Map<string, boolean>();
  const hiddenBy = (l: LayerInfo): boolean => {
    if (!l.parentId) return false;
    let h = hiddenMemo.get(l.parentId);
    if (h === undefined) { const p = byId.get(l.parentId); h = !p || !p.visible || hiddenBy(p); hiddenMemo.set(l.parentId, h); }
    return h;
  };
  const rowProps = (l: LayerInfo, i: number): RowProps => {
    const ancestors: AncestorRef[] = [];
    for (let p = l.parentId ? byId.get(l.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) ancestors.unshift({ id: p.id, depth: p.depth });
    const next = layers[i + 1], ends: string[] = [];
    for (const a of ancestors) if (!next || next.depth <= a.depth) ends.push(a.id);
    const childCount = counts.current.map.get(l.id) ?? 0;
    const info = store.flattenInfo(l, layers, childCount);
    return {
      layer: l, selected: selectedSet.has(l.id), active: l.id === activeId, maskTarget: paint.layerId === l.id && paint.target === 'mask', editing: editing === l.id, onEdit: setEditing,
      dropZone: drag && drag.target === l.id ? drag.zone : null, tdPreview: tdLayers.has(l.id), hiddenByParent: hiddenBy(l), ancestors, ends, childCount,
      flat: { enabled: info.enabled, title: info.title, reason: info.reason, tooltip: info.reason && store.flattenTooltip(l, info) === info.title ? `${info.title} (${info.reason})` : store.flattenTooltip(l, info) },
      busy: busyId === l.id,
    };
  };
  const press = useRef<{ id: string; x: number; y: number; started: boolean } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const rects = useRef<{ id: string; top: number; bottom: number }[] | null>(null); // row rects, measured once when a drag starts
  const targetAt = (y: number): DragState | null => {
    if (!rects.current) rects.current = [...list.current!.querySelectorAll<HTMLElement>('[data-layer]')].map((row) => { const r = row.getBoundingClientRect(); return { id: row.dataset.layer!, top: r.top, bottom: r.bottom }; });
    for (const r of rects.current) {
      if (y < r.top || y >= r.bottom) continue;
      const target = byId.get(r.id)!;
      return { id: press.current!.id, target: r.id, zone: dropZone(target, (y - r.top) / (r.bottom - r.top)) };
    }
    return null;
  };

  const onDown = (ev: PointerEvent) => {
    const row = (ev.target as Element).closest('[data-layer]') as HTMLElement | null;
    if (!row || (ev.target as Element).closest('[data-nodrag],input') || ev.button !== 0) return;
    const l = layers.find((x) => x.id === row.dataset.layer);
    if (!l) return;
    press.current = { id: l.id, x: ev.clientX, y: ev.clientY, started: false };
  };
  const onMove = (ev: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!p.started && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 4) return;
    p.started = true;
    capture(list.current!, ev.pointerId);
    const next = targetAt(ev.clientY) || { id: p.id, target: null, zone: 'after' as DropZone };
    const cur = dragRef.current;
    if (!cur || cur.target !== next.target || cur.zone !== next.zone) { dragRef.current = next; setDrag(next); }
  };
  const onUp = () => {
    const p = press.current, d = dragRef.current;
    press.current = null;
    dragRef.current = null;
    rects.current = null;
    setDrag(null);
    if (!p || !p.started || !d || !d.target) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const multi = selectedIds.length > 1 && selectedIds.includes(d.id);
    const ids = store.dragIds(d.id);
    const drop = computeDrop(layers, ids, d.target, d.zone);
    if (!drop) return;
    if (multi) e.moveLayers(ids, drop.parentId, drop.index);
    else e.moveLayer(d.id, drop.parentId, drop.index);
  };

  const canDelete = selectedIds.length > 0;
  const canFx = !!active && store.canHaveEffects(active.kind);
  return (
    <div style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">
      <LayerSettings layer={active} />
      <div ref={list} data-layer-list onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style="flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 0;user-select:none">
        {layers.map((l, i) => <MemoRow key={l.id} {...rowProps(l, i)} />)}
      </div>
      <Footer canDelete={canDelete} count={selectedIds.length} canMask={store.canAddMask()} canFx={canFx} />
    </div>
  );
}

function Footer({ canDelete, count, canMask, canFx }: { canDelete: boolean; count: number; canMask: boolean; canFx: boolean }) {
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
  const buttons: { label: string; d: string; run?: () => void; enabled: boolean; menu?: boolean; title?: string }[] = [
    { label: 'New pixel layer', d: 'M4 4h16v16H4zM12 8v8M8 12h8', run: () => store.addLayer(), enabled: true },
    { label: 'New group', d: FOLDER, run: () => store.addGroup(), enabled: true },
    { label: 'Add mask', d: MASK_ICON, run: () => store.addMask(), enabled: canMask },
    { label: 'New adjustment', d: ADJUST_ICON, run: () => setMenu(!menu), enabled: true, menu: true },
    { label: 'Layer effects', d: 'M5 19h4M7 17v4M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z', run: () => store.openEffects(), enabled: canFx },
    { label: 'Delete layer', d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', run: () => store.deleteSelected(), enabled: canDelete, title: count > 1 ? `Delete ${count} layers` : undefined },
  ];
  return (
    <div ref={ref} style="position:relative;height:36px;flex:none;display:flex;align-items:center;justify-content:space-around;border-top:1px solid #1f1f1f;background:#282828">
      {buttons.map((b) => (
        <button key={b.label} class="ib" aria-label={b.label} aria-disabled={!b.enabled} aria-haspopup={b.menu ? 'menu' : undefined} aria-expanded={b.menu ? menu : undefined}
          title={b.run ? (b.enabled ? b.title ?? b.label : `${b.label} — not available for this layer`) : `${b.label} — ${NOT_IN_VERSION}`}
          onClick={() => b.enabled && b.run?.()} style={`width:32px;height:30px;opacity:${b.enabled ? 1 : 0.4}`}>
          <Icon d={b.d} sw={1.7} />
        </button>
      ))}
      {menu && <EffectCatalogue label="New adjustment" attr="data-new-adjustment" onPick={(t) => { setMenu(false); store.addAdjustment(t); }}
        style="position:absolute;left:50%;bottom:100%;z-index:50;min-width:190px;max-height:min(480px,70vh);overflow-y:auto;padding:4px;background:#2f2f2f;border:1px solid #161616;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.55)" />}
    </div>
  );
}
