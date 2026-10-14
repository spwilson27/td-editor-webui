import { Fragment } from 'preact';
import { store } from '../state/store';
import { TOOLS } from '../state/tools';
import { Icon, NOT_IN_VERSION } from './Icon';

export function ToolRail() {
  const current = store.tool.value;
  return (
    <div class="rail" data-rail>
      {TOOLS.map((t) => {
        const on = t.id === current;
        const label = `${t.name} (${t.key})`;
        return (
          <Fragment key={t.id}>
            {t.sep && <div class="rail-sep" />}
            <button class="ib tb" data-tool={t.id} aria-label={label} aria-pressed={on} aria-disabled={!t.enabled}
              title={t.enabled ? label : `${t.name} — ${NOT_IN_VERSION}`}
              onClick={() => store.setTool(t.id)}
              style={`background:${on ? '#3d6fb4' : 'transparent'};color:${on ? '#ffffff' : '#d4d4d4'};opacity:${t.enabled ? 1 : 0.35}`}>
              <Icon d={t.d} size={20} sw={1.6} />
            </button>
          </Fragment>
        );
      })}
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
