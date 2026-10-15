// v8: the one "Add effect / filter" catalogue, shared by the Effects panel (layer FX / adjustment stacks) and Layer ▸ New Adjustment.
import { Fragment } from 'preact';
import type { EffectType } from '../engine/types';
import { CLASSIC_ORDER, EFFECT_ORDER, EXPERIMENTAL, effectLabel, isClassicType } from '../state/effectDefaults';
import { filterDoc, filterGroups, isFilterType } from '../state/filterSchema';

const ITEM = 'display:flex;width:100%;box-sizing:border-box;align-items:center;justify-content:space-between;height:26px;padding:0 10px;border-radius:4px;text-align:left;color:#e3e3e3';
const LABEL = 'padding:3px 10px 2px;font-size:10px;letter-spacing:0.04em;text-transform:uppercase;color:#8f8f8f';
const SEP = 'height:1px;margin:4px 6px;background:#161616';

/** Menu body. `attr` is the data attribute carrying the type on every entry (e.g. `data-add-effect`, `data-new-adjustment`). */
export function EffectCatalogue({ label, attr, onPick, style }: { label: string; attr: string; onPick: (type: string) => void; style: string }) {
  const item = (t: string, extra = {}) => {
    const props = { [attr]: t, ...(isFilterType(t) ? { 'data-add-filter': t } : {}), ...extra };
    return (
      <button key={t} role="menuitem" class="mi" {...props} title={filterDoc(t) || undefined} onClick={() => onPick(t)} style={ITEM}>
        <span>{effectLabel(t)}</span>{EXPERIMENTAL.has(t as EffectType) && <span style="font-size:10px;color:#d9a441">Experimental</span>}
      </button>
    );
  };
  return (
    <div role="menu" aria-label={label} data-effect-catalogue style={style}>
      <div role="group" aria-label="Adjustments" data-catalogue-group="adjustments">
        <div style={LABEL}>Adjustments</div>
        {CLASSIC_ORDER.map((t) => item(t))}
      </div>
      <div role="group" aria-label="Layer styles" data-catalogue-group="styles">
        <div role="separator" style={SEP} />
        <div style={LABEL}>Layer styles</div>
        {EFFECT_ORDER.map((t, i) => (
          <Fragment key={t}>
            {i > 0 && EXPERIMENTAL.has(t) && !EXPERIMENTAL.has(EFFECT_ORDER[i - 1]) && <div role="separator" style={SEP} />}
            {item(t)}
          </Fragment>
        ))}
      </div>
      {filterGroups().map((g) => {
        const types = g.types.filter((t) => !isClassicType(t));
        return (
          <div key={g.id} role="group" aria-label={g.label} data-filter-group={g.id}>
            <div role="separator" style={SEP} />
            <div data-filter-group-label style={LABEL}>{g.label}</div>
            {types.map((t) => item(t))}
          </div>
        );
      })}
    </div>
  );
}
