import { Fragment } from 'preact';
import { store } from '../state/store';
import { TOOLS } from '../state/tools';
import { Icon, NOT_IN_VERSION } from './Icon';

export function ToolRail() {
  const current = store.tool.value;
  return (
    <div style="width:52px;flex:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;background:#2b2b2b;border-right:1px solid #161616;overflow-y:auto">
      {TOOLS.map((t) => {
        const on = t.id === current;
        const label = `${t.name} (${t.key})`;
        return (
          <Fragment key={t.id}>
            {t.sep && <div style="width:28px;height:1px;background:#444;margin:4px 0" />}
            <button class="ib" data-tool={t.id} aria-label={label} aria-pressed={on} aria-disabled={!t.enabled}
              title={t.enabled ? label : `${t.name} — ${NOT_IN_VERSION}`}
              onClick={() => store.setTool(t.id)}
              style={`width:44px;height:40px;flex:none;background:${on ? '#3d6fb4' : 'transparent'};color:${on ? '#ffffff' : '#d4d4d4'};opacity:${t.enabled ? 1 : 0.35}`}>
              <Icon d={t.d} size={20} sw={1.6} />
            </button>
          </Fragment>
        );
      })}
      <div style="flex:1 1 auto" />
      <div style="position:relative;width:40px;height:40px;flex:none;margin-top:8px">
        <button aria-label="Secondary colour" onClick={() => store.swapColours()}
          style={`position:absolute;right:0;bottom:0;width:24px;height:24px;border-radius:50%;border:2px solid #1a1a1a;box-shadow:0 0 0 1px #5a5a5a;background:${store.secondary.value}`} />
        <button aria-label="Primary colour" onClick={() => { store.colorTab.value = 'color'; }}
          style={`position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;border:2px solid #1a1a1a;box-shadow:0 0 0 1px #8a8a8a;background:${store.primary.value}`} />
      </div>
    </div>
  );
}
