import type { AdjustmentSpec, AdjustmentType, LayerInfo } from '../engine/types';
import { store } from '../state/store';
import { adjustmentLabel } from './LayersPanel';

interface Param { key: string; label: string; min: number; max: number; step: number; unit?: string; digits?: number }

export const ADJUSTMENT_PARAMS: Record<AdjustmentType, Param[]> = {
  levels: [
    { key: 'inLow', label: 'Input black', min: 0, max: 1, step: 0.01, digits: 2 },
    { key: 'gamma', label: 'Gamma', min: 0.1, max: 10, step: 0.01, digits: 2 },
    { key: 'inHigh', label: 'Input white', min: 0, max: 1, step: 0.01, digits: 2 },
    { key: 'outLow', label: 'Output black', min: 0, max: 1, step: 0.01, digits: 2 },
    { key: 'outHigh', label: 'Output white', min: 0, max: 1, step: 0.01, digits: 2 },
  ],
  brightnessContrast: [
    { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01, digits: 2 },
    { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, digits: 2 },
  ],
  hueSaturation: [
    { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, unit: '°', digits: 0 },
    { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, digits: 2 },
    { key: 'value', label: 'Value', min: 0, max: 2, step: 0.01, digits: 2 },
  ],
  blur: [{ key: 'radius', label: 'Radius', min: 0, max: 200, step: 1, unit: ' px', digits: 0 }],
  invert: [],
  threshold: [{ key: 'level', label: 'Level', min: 0, max: 1, step: 0.01, digits: 2 }],
};

/** Sliders for the active adjustment layer; edits go to the engine live, at most once per animation frame. */
export function AdjustPanel({ layer }: { layer: LayerInfo | undefined }) {
  const draft = store.adjDraft.value;
  if (!layer || layer.kind !== 'adjustment' || !layer.adjustment) {
    return <div data-adjust-panel style="padding:12px;color:#a8a8a8">Select an adjustment layer to edit it.</div>;
  }
  const spec: AdjustmentSpec = draft && draft.id === layer.id ? draft.spec : layer.adjustment;
  const params = ADJUSTMENT_PARAMS[spec.type];
  const values = spec as unknown as Record<string, number>;
  return (
    <div data-adjust-panel data-adjust-type={spec.type} style="flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px">
      <div style="font-weight:600;color:#ffffff">{adjustmentLabel(spec.type)}</div>
      {params.length === 0 && <div style="color:#a8a8a8">This adjustment has no parameters.</div>}
      {params.map((p) => (
        <div key={p.key} style="display:flex;flex-direction:column;gap:3px">
          <label for={`adj-${p.key}`} style="display:flex;justify-content:space-between;color:#a8a8a8">
            <span>{p.label}</span>
            <span data-adjust-value={p.key} style="color:#e3e3e3">{values[p.key].toFixed(p.digits ?? 2)}{p.unit ?? ''}</span>
          </label>
          <input id={`adj-${p.key}`} type="range" aria-label={p.label} min={p.min} max={p.max} step={p.step} value={values[p.key]}
            onInput={(ev) => store.editAdjustment(layer.id, { ...spec, [p.key]: parseFloat((ev.target as HTMLInputElement).value) } as AdjustmentSpec)} />
        </div>
      ))}
    </div>
  );
}
