import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../state/store';
import { SHAPE_KINDS, TOOLS, shapeKind, type ToolInfo } from '../state/tools';
import { Icon, NOT_IN_VERSION } from './Icon';

/** Tool group flyout: the shape tool keeps one slot in the rail and offers its shape types from the corner mark. */
function ShapeFlyout({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  }, []);
  const r = anchor.getBoundingClientRect();
  const cur = store.shapeOpts.value.type;
  return (
    <div ref={ref} role="menu" aria-label="Shape type" data-shape-flyout
      style={`position:fixed;left:${r.right + 4}px;top:${r.top}px;z-index:60;min-width:170px;padding:4px;background:#2f2f2f;border:1px solid #161616;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.55)`}>
      {SHAPE_KINDS.map((k) => (
        <button key={k.id} role="menuitemradio" class="mi" aria-checked={cur === k.id} data-shape={k.id}
          onClick={() => { store.setShapeOpt({ type: k.id }); store.setTool('shape'); onClose(); }}
          style="display:flex;width:100%;box-sizing:border-box;align-items:center;gap:10px;height:28px;padding:0 10px;border-radius:4px;text-align:left;color:#e3e3e3">
          <Icon d={k.d} size={16} sw={1.7} /><span style="flex:1 1 auto">{k.name}</span>{cur === k.id && <span aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>
  );
}

function ToolButton({ t, group }: { t: ToolInfo; group?: boolean }) {
  const current = store.tool.value;
  const [flyout, setFlyout] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const on = t.id === current;
  const d = t.id === 'shape' ? shapeKind(store.shapeOpts.value.type).d : t.d;
  const label = `${t.name} (${t.key})`;
  return (
    <div ref={wrap} style="position:relative;flex:none" onContextMenu={group ? (e) => { e.preventDefault(); setFlyout(true); } : undefined}>
      <button class="ib tb" data-tool={t.id} aria-label={label} aria-pressed={on} aria-disabled={!t.enabled} aria-haspopup={group ? 'menu' : undefined}
        title={t.enabled ? label : `${t.name} — ${NOT_IN_VERSION}`}
        onClick={() => store.setTool(t.id)}
        style={`background:${on ? '#3d6fb4' : 'transparent'};color:${on ? '#ffffff' : '#d4d4d4'};opacity:${t.enabled ? 1 : 0.35}`}>
        <Icon d={d} size={20} sw={1.6} />
      </button>
      {group && (
        <button aria-label="Shape types" title="More shapes" data-flyout-toggle aria-expanded={flyout}
          onClick={(e) => { e.stopPropagation(); setFlyout(!flyout); }}
          style="position:absolute;right:1px;bottom:1px;width:12px;height:12px;display:flex;align-items:flex-end;justify-content:flex-end;padding:0">
          <svg width="7" height="7" viewBox="0 0 7 7" aria-hidden="true"><path d="M7 0v7H0z" fill={on ? '#ffffff' : '#9a9a9a'} /></svg>
        </button>
      )}
      {flyout && wrap.current && <ShapeFlyout anchor={wrap.current} onClose={() => setFlyout(false)} />}
    </div>
  );
}

export function ToolRail() {
  return (
    <div class="rail" data-rail>
      {TOOLS.map((t) => (
        <Fragment key={t.id}>
          {t.sep && <div class="rail-sep" />}
          <ToolButton t={t} group={t.id === 'shape'} />
        </Fragment>
      ))}
      <div style="flex:1 1 auto" />
      <div class="rail-chips">
        <button aria-label="Secondary colour" onClick={() => store.swapColours()}
          style={`position:absolute;right:0;bottom:0;width:24px;height:24px;border-radius:50%;border:2px solid #1a1a1a;box-shadow:0 0 0 1px #5a5a5a;background:${store.secondary.value}`} />
        <button aria-label="Primary colour" onClick={() => { store.colorTab.value = 'color'; }}
          style={`position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;border:2px solid #1a1a1a;box-shadow:0 0 0 1px #8a8a8a;background:${store.primary.value}`} />
      </div>
    </div>
  );
}
