import { store } from '../state/store';
import { BRUSHES } from '../state/tools';

export function BrushesPanel() {
  const current = store.brushPreset.value;
  return (
    <div style="display:flex;flex-direction:column;padding:6px 0">
      {BRUSHES.map((b) => (
        <button key={b.id} class="row" data-brush={b.id} aria-pressed={b.id === current} onClick={() => store.applyPreset(b.id)}
          style={`display:flex;align-items:center;gap:12px;height:44px;padding:0 12px;text-align:left;background:${b.id === current ? '#383838' : 'transparent'}`}>
          <svg width="96" height="24" viewBox="0 0 96 24" aria-hidden="true">
            <path d="M4 16c14-14 26 6 44-2s26-8 44-4" fill="none" stroke="#e3e3e3" stroke-width={b.sw} stroke-linecap="round" opacity={b.op} />
          </svg>
          <span style="flex:1 1 auto">{b.name}</span>
          <span style="color:#a8a8a8">{b.size} px</span>
        </button>
      ))}
    </div>
  );
}
