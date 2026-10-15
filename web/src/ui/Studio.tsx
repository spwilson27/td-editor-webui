import { store } from '../state/store';
import { BrushesPanel } from './BrushesPanel';
import { ColourPanel } from './ColourPanel';
import { HistoryPanel } from './HistoryPanel';
import { LayersPanel } from './LayersPanel';
import { SwatchesPanel } from './SwatchesPanel';
import { EffectsPanel } from './EffectsPanel';
import { Tabs } from './Tabs';

export function Studio() {
  store.docVersion.value;
  const ct = store.colorTab.value;
  const active = store.hasEngine() ? store.activeLayer() : undefined;
  const lt = store.layerTab.value;
  return (
    <div style="flex:1 1 290px;max-width:320px;min-width:260px;display:flex;flex-direction:column;background:#2b2b2b;border-left:1px solid #161616;overflow:hidden">
      <div style="flex:none;border-bottom:1px solid #161616">
        <Tabs label="Colour panels" value={ct} onChange={(v) => { store.colorTab.value = v; }}
          tabs={[['color', 'Colour'], ['swatches', 'Swatches'], ['brushes', 'Brushes']]} />
        {ct === 'color' ? <ColourPanel /> : ct === 'swatches' ? <SwatchesPanel /> : <BrushesPanel />}
      </div>
      <div style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">
        <Tabs label="Layer panels" value={lt} onChange={(v) => { store.layerTab.value = v; }} tabs={[['layers', 'Layers'], ['history', 'History'], ['fx', 'Effects']]} />
        {lt === 'layers' ? <LayersPanel /> : lt === 'history' ? <HistoryPanel /> : <EffectsPanel layer={active} />}
      </div>
    </div>
  );
}
