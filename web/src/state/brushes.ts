// v6 brush tips, dynamics and presets: defaults, validation, per-viewer persistence (localStorage) and custom-tip PNG codec.
import { decodeTipPng, encodeTipPng, sanitizeBrushPresets } from '../engine';
import type { BrushDynamics, BrushPreset, BrushSettings, TipShape } from '../engine/types';

export const PRESETS_KEY = 'raster-editor.brushPresets';
export const BIG_DOC_KEY = 'raster-editor.bigDocNoticeDismissed';
export const MAX_CUSTOM_TIP = 512;
export const MAX_DOC_CUSTOM_PRESETS = 16;

export const DEFAULT_DYNAMICS: BrushDynamics = {
  scatter: 0, scatterCount: 1, sizeJitter: 0, angleJitter: 0, hueJitter: 0, satJitter: 0, valJitter: 0, angle: 0, roundness: 1, seed: 1,
};

export interface TipInfo { id: TipShape; label: string }
export const TIP_SHAPES: TipInfo[] = [
  { id: 'round', label: 'Round' }, { id: 'chalk', label: 'Chalk' }, { id: 'bristle', label: 'Bristle' }, { id: 'spatter', label: 'Spatter' },
  { id: 'noise', label: 'Noise' }, { id: 'square', label: 'Square' }, { id: 'star', label: 'Star' },
];
export const tipLabel = (t: TipShape): string => (t === 'custom' ? 'From selection' : TIP_SHAPES.find((x) => x.id === t)?.label ?? t);

export type DynField = { key: Exclude<keyof BrushDynamics, 'seed'>; label: string; min: number; max: number; step: number; unit: string; scale: number; digits: number };
/** Dynamics sliders. `scale` converts the stored value to the displayed one (fractions as %). */
export const DYNAMICS_FIELDS: DynField[] = [
  { key: 'scatter', label: 'Scatter', min: 0, max: 4, step: 0.05, unit: '×', scale: 1, digits: 2 },
  { key: 'scatterCount', label: 'Count', min: 1, max: 16, step: 1, unit: '', scale: 1, digits: 0 },
  { key: 'sizeJitter', label: 'Size jitter', min: 0, max: 1, step: 0.01, unit: '%', scale: 100, digits: 0 },
  { key: 'angleJitter', label: 'Angle jitter', min: 0, max: 360, step: 1, unit: '°', scale: 1, digits: 0 },
  { key: 'angle', label: 'Angle', min: 0, max: 360, step: 1, unit: '°', scale: 1, digits: 0 },
  { key: 'roundness', label: 'Roundness', min: 0.05, max: 1, step: 0.01, unit: '%', scale: 100, digits: 0 },
  { key: 'hueJitter', label: 'Hue jitter', min: 0, max: 1, step: 0.01, unit: '%', scale: 100, digits: 0 },
  { key: 'satJitter', label: 'Saturation jitter', min: 0, max: 1, step: 0.01, unit: '%', scale: 100, digits: 0 },
  { key: 'valJitter', label: 'Value jitter', min: 0, max: 1, step: 0.01, unit: '%', scale: 100, digits: 0 },
];

const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function normDynamics(d: Partial<BrushDynamics> | null | undefined): BrushDynamics {
  const x = d ?? {};
  return {
    scatter: num(x.scatter, 0, 0, 4), scatterCount: Math.round(num(x.scatterCount, 1, 1, 16)),
    sizeJitter: num(x.sizeJitter, 0, 0, 1), angleJitter: num(x.angleJitter, 0, 0, 360),
    hueJitter: num(x.hueJitter, 0, 0, 1), satJitter: num(x.satJitter, 0, 0, 1), valJitter: num(x.valJitter, 0, 0, 1),
    angle: num(x.angle, 0, 0, 360), roundness: num(x.roundness, 1, 0.05, 1), seed: Math.round(num(x.seed, 1, 0, 0xffffff)),
  };
}

const TIPS: readonly string[] = ['round', 'chalk', 'bristle', 'spatter', 'noise', 'square', 'star', 'custom'];
export const isTip = (v: unknown): v is TipShape => typeof v === 'string' && TIPS.includes(v);

export function normSettings(s: Partial<BrushSettings> | null | undefined): BrushSettings {
  const x = s ?? {};
  return { size: Math.round(num(x.size, 64, 1, 1000)), opacity: num(x.opacity, 1, 0, 1), flow: num(x.flow, 1, 0, 1), hardness: num(x.hardness, 0.5, 0, 1), spacing: num(x.spacing, 0.15, 0.01, 4) };
}

/** Presets read from storage / JSON / a document: the engine's sanitiser (clamps settings, validates custom tips), then nameless entries are dropped. */
export function normPresetList(v: unknown): BrushPreset[] {
  return sanitizeBrushPresets(v).map((p) => ({ ...p, name: p.name.trim() })).filter((p) => p.name !== '');
}
export function normPreset(v: unknown): BrushPreset | null { return normPresetList([v])[0] ?? null; }

export function loadUserPresets(): BrushPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? normPresetList(JSON.parse(raw)) : [];
  } catch { return []; }
}
export function saveUserPresets(list: BrushPreset[]): boolean {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export const newPresetId = (): string => `p${Date.now().toString(36)}${Math.floor(Math.random() * 0x7fffffff).toString(36)}`;

/** Export file contents: a versioned wrapper so future formats can be told apart. */
export function exportPresetsJson(list: BrushPreset[]): string {
  return JSON.stringify({ format: 'raster-editor-brush-presets', version: 1, presets: list }, null, 2);
}
/** Accepts the wrapper, or a bare array. Throws on anything else. */
export function parsePresetsJson(text: string): BrushPreset[] {
  const j = JSON.parse(text) as unknown;
  const arr = Array.isArray(j) ? j : (j as { presets?: unknown } | null)?.presets;
  if (!Array.isArray(arr)) throw new Error('not a brush preset file');
  return normPresetList(arr);
}

// ---- custom tip <-> PNG data URL (the engine's codec: white with alpha = coverage) ----

export function alphaToPng(w: number, h: number, alpha: Uint8Array): string | null {
  try { return encodeTipPng(w, h, alpha); } catch { return null; }
}

export async function pngToAlpha(png: string): Promise<{ w: number; h: number; alpha: Uint8Array } | null> {
  try { const t = await decodeTipPng(png); return { w: t.w, h: t.h, alpha: t.alpha }; } catch { return null; }
}

/** Most presets one document holds (TD refuses more). */
export const MAX_DOC_PRESETS = 64;
/** Import files larger than this are refused (a preset list is a few KB; custom tips add PNGs). */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
