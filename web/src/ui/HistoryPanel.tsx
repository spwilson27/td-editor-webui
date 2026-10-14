import { store } from '../state/store';

export function HistoryPanel() {
  store.historyVersion.value;
  const { entries, index } = store.engine.history();
  return (
    <div data-history style="flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 0">
      {entries.map((h, i) => {
        const cur = i === index;
        const future = i > index;
        return (
          <div key={h.id} class="row" data-history-index={i} aria-current={cur} onClick={() => store.engine.jumpTo(i)}
            style={`display:flex;align-items:center;gap:10px;height:30px;padding:0 12px;cursor:default;color:${cur ? '#ffffff' : future ? '#7d7d7d' : '#cfcfcf'};background:${cur ? '#383838' : 'transparent'}`}>
            <span style={`width:6px;height:6px;border-radius:50%;background:${cur ? '#3d6fb4' : '#5a5a5a'}`} />
            <span>{h.label}</span>
          </div>
        );
      })}
    </div>
  );
}
