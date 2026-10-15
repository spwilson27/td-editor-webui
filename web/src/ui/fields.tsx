// Parameter field editors shared by the Effects panel (effects, filters) and the Adjustment panel (filter adjustments).
import type { RGBA } from '../engine/types';

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const rgbHex = (c: RGBA) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
export const parseHex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface NumDef { key: string; label: string; min: number; max: number; step: number; unit?: string; digits?: number }

export function NumField({ f, value, onChange }: { f: NumDef; value: number; onChange: (v: number) => void }) {
  const v = typeof value === 'number' && isFinite(value) ? value : f.min;
  return (
    <div style="display:flex;flex-direction:column;gap:2px">
      <label style="display:flex;justify-content:space-between;color:#a8a8a8">
        <span>{f.label}</span>
        <span data-fx-value={f.key} style="color:#e3e3e3">{v.toFixed(f.digits ?? 0)}{f.unit ?? ''}</span>
      </label>
      <input type="range" aria-label={f.label} min={f.min} max={f.max} step={f.step} value={v}
        onInput={(ev) => { const n = parseFloat((ev.target as HTMLInputElement).value); if (!isNaN(n)) onChange(clamp(n, f.min, f.max)); }} />
    </div>
  );
}

export function ColorField({ f, value, onChange }: { f: { key: string; label: string }; value: RGBA; onChange: (c: Partial<RGBA>) => void }) {
  const c = value ?? { r: 0, g: 0, b: 0, a: 255 };
  return (
    <div style="display:flex;align-items:center;gap:6px;min-width:0">
      <span style="flex:none;width:62px;color:#a8a8a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{f.label}</span>
      <input type="color" data-fx-color={f.key} aria-label={f.label} value={rgbHex(c)}
        onInput={(ev) => { const [r, g, b] = parseHex((ev.target as HTMLInputElement).value); onChange({ r, g, b }); }}
        style="flex:none;width:30px;height:22px;padding:0;border:1px solid #474747;border-radius:3px;background:#1f1f1f" />
      <input type="range" data-fx-alpha={f.key} aria-label={`${f.label} alpha`} title="Alpha" min={0} max={255} step={1} value={c.a}
        onInput={(ev) => { const a = parseInt((ev.target as HTMLInputElement).value, 10); if (!isNaN(a)) onChange({ a: clamp(a, 0, 255) }); }}
        style="flex:1 1 auto;min-width:0" />
    </div>
  );
}

export function EnumField({ f, value, onChange }: { f: { label: string; options: [string, string][] }; value: string; onChange: (v: string) => void }) {
  return (
    <label style="display:flex;align-items:center;gap:6px;color:#a8a8a8">
      <span style="flex:none;width:62px">{f.label}</span>
      <select aria-label={f.label} value={value} style="flex:1 1 auto;min-width:0" onChange={(ev) => onChange((ev.target as HTMLSelectElement).value)}>
        {f.options.map(([v, t]) => <option key={v} value={v} selected={v === value}>{t}</option>)}
      </select>
    </label>
  );
}

export function BoolField({ f, value, onChange }: { f: { key: string; label: string }; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style="display:flex;align-items:center;gap:6px;color:#e3e3e3">
      <input type="checkbox" data-fx-bool={f.key} aria-label={f.label} checked={!!value} style="accent-color:#4a8fe0;margin:0" onChange={(ev) => onChange((ev.target as HTMLInputElement).checked)} />
      <span>{f.label}</span>
    </label>
  );
}

export function SeedField({ f, value, onChange }: { f: { key: string; label: string }; value: number; onChange: (v: number) => void }) {
  return (
    <label style="display:flex;align-items:center;gap:6px;color:#a8a8a8">
      <span style="flex:none;width:62px">{f.label}</span>
      <input type="number" data-fx-seed={f.key} aria-label={f.label} min={0} max={16777215} step={1} value={Math.round(Number(value) || 0)}
        onChange={(ev) => { const n = Math.round(Number((ev.target as HTMLInputElement).value)); if (isFinite(n)) onChange(((n % 16777216) + 16777216) % 16777216); }}
        style="flex:1 1 auto;min-width:0;padding:2px 6px;background:#1f1f1f;border:1px solid #474747;border-radius:4px;height:22px;box-sizing:border-box" />
      <button class="ib" aria-label={`Randomize ${f.label}`} title="Random seed" onClick={() => onChange(Math.floor(Math.random() * 16777216))}
        style="flex:none;width:24px;height:22px;border:1px solid #474747;border-radius:4px">⚄</button>
    </label>
  );
}
