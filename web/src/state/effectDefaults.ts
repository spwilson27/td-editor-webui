// v5 layer effects: defaults and the parameter schema that drives the Effects panel.
import type { Effect, EffectType, RGBA } from '../engine/types';
import { defaultFilter, filterLabel } from './filterSchema';

export const EFFECT_ORDER: EffectType[] = [
  'dropShadow', 'outerGlow', 'innerGlow', 'stroke', 'bevel', 'colorOverlay',
  'pixelSort', 'glitch', 'chromaticAberration', 'halftone',
];
export const EXPERIMENTAL: ReadonlySet<EffectType> = new Set<EffectType>(['pixelSort', 'glitch', 'chromaticAberration', 'halftone']);
export const EFFECT_LABELS: Record<EffectType, string> = {
  dropShadow: 'Drop Shadow', outerGlow: 'Outer Glow', innerGlow: 'Inner Glow', stroke: 'Stroke', bevel: 'Bevel',
  colorOverlay: 'Colour Overlay', pixelSort: 'Pixel Sort', glitch: 'Glitch', chromaticAberration: 'Chromatic Aberration', halftone: 'Halftone',
};

export type EffectField =
  | { kind: 'num'; key: string; label: string; min: number; max: number; step: number; unit?: string; digits?: number }
  | { kind: 'enum'; key: string; label: string; options: [string, string][] }
  | { kind: 'color'; key: string; label: string };

const num = (key: string, label: string, min: number, max: number, step = 1, unit = '', digits = 0): EffectField =>
  ({ kind: 'num', key, label, min, max, step, unit, digits });
const opacity = num('opacity', 'Opacity', 0, 1, 0.01, '', 2);
const color = (key: string, label: string): EffectField => ({ kind: 'color', key, label });

export const EFFECT_FIELDS: Record<EffectType, EffectField[]> = {
  dropShadow: [num('dx', 'Offset X', -128, 128, 1, ' px'), num('dy', 'Offset Y', -128, 128, 1, ' px'), num('blur', 'Blur', 0, 128, 1, ' px'), color('color', 'Colour'), opacity],
  outerGlow: [num('size', 'Size', 0, 128, 1, ' px'), color('color', 'Colour'), opacity],
  innerGlow: [num('size', 'Size', 0, 128, 1, ' px'), color('color', 'Colour'), opacity],
  stroke: [num('width', 'Width', 0, 128, 1, ' px'), color('color', 'Colour'),
    { kind: 'enum', key: 'position', label: 'Position', options: [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']] }, opacity],
  bevel: [num('depth', 'Depth', 0, 100, 1, '%'), num('size', 'Size', 0, 128, 1, ' px'), num('angle', 'Angle', 0, 360, 1, '°'), color('highlight', 'Highlight'), color('shadow', 'Shadow')],
  colorOverlay: [color('color', 'Colour'), opacity],
  pixelSort: [{ kind: 'enum', key: 'direction', label: 'Direction', options: [['h', 'Horizontal'], ['v', 'Vertical']] },
    num('low', 'Low threshold', 0, 1, 0.01, '', 2), num('high', 'High threshold', 0, 1, 0.01, '', 2),
    { kind: 'enum', key: 'key', label: 'Sort by', options: [['luma', 'Luma'], ['hue', 'Hue']] }],
  glitch: [num('amount', 'Amount', 0, 100, 1, '%'), num('blockSize', 'Block size', 1, 128, 1, ' px'), num('seed', 'Seed', 0, 9999), num('rgbShift', 'RGB shift', 0, 128, 1, ' px')],
  chromaticAberration: [num('amount', 'Amount', 0, 128, 0.5, ' px', 1), num('angle', 'Angle', 0, 360, 1, '°')],
  halftone: [num('cellSize', 'Cell size', 2, 128, 1, ' px'), num('angle', 'Angle', 0, 360, 1, '°'),
    { kind: 'enum', key: 'shape', label: 'Shape', options: [['dot', 'Dot'], ['line', 'Line']] }],
};

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };

/** Display name of any effect or filter type. */
export const effectLabel = (type: string): string => (type in EFFECT_LABELS ? EFFECT_LABELS[type as EffectType] : filterLabel(type));

/** Default parameters of a v5 effect or a v6 library filter (spec defaults). */
export function defaultEffect(name: string): Effect {
  if (!(name in EFFECT_LABELS)) return defaultFilter(name);
  const type = name as EffectType;
  switch (type) {
    case 'dropShadow': return { type, enabled: true, dx: 4, dy: 4, blur: 8, color: { ...BLACK }, opacity: 0.75 };
    case 'outerGlow': return { type, enabled: true, size: 8, color: { r: 255, g: 255, b: 190, a: 255 }, opacity: 0.75 };
    case 'innerGlow': return { type, enabled: true, size: 8, color: { r: 255, g: 255, b: 190, a: 255 }, opacity: 0.75 };
    case 'stroke': return { type, enabled: true, width: 2, color: { ...WHITE }, position: 'outside', opacity: 1 };
    case 'bevel': return { type, enabled: true, depth: 4, size: 4, angle: 135, highlight: { ...WHITE }, shadow: { ...BLACK } };
    case 'colorOverlay': return { type, enabled: true, color: { r: 255, g: 0, b: 0, a: 255 }, opacity: 1 };
    case 'pixelSort': return { type, enabled: true, direction: 'h', low: 0.25, high: 0.75, key: 'luma' };
    case 'glitch': return { type, enabled: true, amount: 50, blockSize: 16, seed: 1, rgbShift: 4 };
    case 'chromaticAberration': return { type, enabled: true, amount: 4, angle: 0 };
    case 'halftone': return { type, enabled: true, cellSize: 8, angle: 45, shape: 'dot' };
  }
}
