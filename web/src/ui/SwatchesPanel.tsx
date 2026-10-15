import { useState } from 'preact/hooks';
import { store } from '../state/store';
import { GREYS, PALETTE } from '../state/tools';
import { Icon } from './Icon';
import { ScrubSelect } from './Scrub';

const SETS: Record<string, string> = { landscape: 'Landscape palette', greys: 'Greys', document: 'Document colours' };

export function SwatchesPanel() {
  const [set, setSet] = useState('landscape');
  const colours = set === 'greys' ? GREYS : set === 'document' ? store.recent.value : PALETTE;
  const list = set === 'document' ? colours : [...colours, ...store.customSwatches.value];
  return (
    <div style="display:flex;flex-direction:column;gap:10px;padding:12px">
      <ScrubSelect aria-label="Palette" value={set} onChange={(e) => setSet((e.target as HTMLSelectElement).value)}>
        {Object.entries(SETS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </ScrubSelect>
      <div style="display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:5px">
        {list.map((h, i) => (
          <button key={h + i} class="sw" data-swatch-colour={h} aria-label={`Use ${h}`} title={h} onClick={() => store.setPrimaryHex(h)}
            style={`aspect-ratio:1;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12);background:${h}`} />
        ))}
      </div>
      <button onClick={() => store.addCustomSwatch()}
        style="align-self:flex-start;display:flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid #474747;border-radius:5px;background:#262626">
        <Icon d="M12 5v14M5 12h14" size={12} sw={2.4} />Add current colour
      </button>
    </div>
  );
}
