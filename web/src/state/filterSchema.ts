// v6 filter library UI schema, generated from shared/effects/<type>.filter.json (the same specs the planners use), so the
// parameter editors always mirror the ranges documented in shared/effects/filters*.d.ts.
import type { Effect, RGBA } from '../engine/types';

export type FilterGroupId = 'blur' | 'color' | 'stylise' | 'distort' | 'animated';

interface RawParam {
  kind: string; default?: unknown; min?: number; max?: number; round?: boolean; unit?: string; values?: string[]; len?: number; cube?: boolean; doc?: string;
}
interface RawSpec { type: string; group: FilterGroupId; doc?: string; params: Record<string, RawParam> }

const specModules = import.meta.glob('../../../shared/effects/*.filter.json', { eager: true, import: 'default' }) as Record<string, RawSpec>;
const SPECS = new Map<string, RawSpec>();
for (const s of Object.values(specModules)) if (s && typeof s.type === 'string') SPECS.set(s.type, s);

export interface NumField { kind: 'num'; key: string; label: string; min: number; max: number; step: number; unit?: string; digits?: number }
export interface EnumField { kind: 'enum'; key: string; label: string; options: [string, string][] }
export interface ColorFieldDef { kind: 'color'; key: string; label: string }
export interface BoolField { kind: 'bool'; key: string; label: string }
export interface SeedField { kind: 'seed'; key: string; label: string }
/** curves: master + red + green + blue point lists edited together. */
export interface CurvesField { kind: 'curves'; key: 'curves'; label: string; keys: string[] }
export interface StopsField { kind: 'stops'; key: string; label: string }
/** selectiveColor: 36 numbers (9 ranges x c, m, y, k), -1..1. */
export interface ListField { kind: 'list'; key: string; label: string; len: number }
export interface TextField { kind: 'lut'; key: string; label: string }
/** displace: noise or another layer / TD input (`source` + `auxSource` 'layer:<id>' | 'input:<n>'). */
export interface AuxField { kind: 'aux'; key: 'source'; label: string }
export type FilterField = NumField | EnumField | ColorFieldDef | BoolField | SeedField | CurvesField | StopsField | ListField | TextField | AuxField;

export const FILTER_GROUPS: { id: FilterGroupId; label: string; order: string[] }[] = [
  { id: 'blur', label: 'Blur & sharpen', order: ['motionBlur', 'radialBlur', 'zoomBlur', 'lensBlur', 'unsharp', 'highPass', 'blur'] },
  { id: 'color', label: 'Colour', order: ['levels', 'brightnessContrast', 'hueSaturation', 'invert', 'threshold', 'curves', 'gradientMap', 'colorBalance', 'vibrance', 'channelMixer', 'selectiveColor', 'posterize', 'duotone', 'lut'] },
  { id: 'stylise', label: 'Stylise', order: ['emboss', 'edgeDetect', 'kuwahara', 'pixelate', 'dither', 'crt', 'grain', 'bloom'] },
  { id: 'distort', label: 'Distort', order: ['displace', 'twirl', 'ripple', 'lensDistortion', 'polar', 'kaleidoscope', 'tileMirror'] },
  { id: 'animated', label: 'Static animated', order: ['driftGlitch', 'feedback', 'echo', 'colorCycle'] },
];

const LABELS: Record<string, string> = {
  blur: 'Gaussian blur', motionBlur: 'Motion blur', radialBlur: 'Radial (spin) blur', zoomBlur: 'Zoom blur', lensBlur: 'Lens blur (bokeh)', unsharp: 'Unsharp mask', highPass: 'High pass',
  levels: 'Levels', brightnessContrast: 'Brightness/Contrast', hueSaturation: 'Hue/Saturation', invert: 'Invert', threshold: 'Threshold',
  curves: 'Curves', gradientMap: 'Gradient map', colorBalance: 'Colour balance', vibrance: 'Vibrance & saturation', channelMixer: 'Channel mixer', selectiveColor: 'Selective colour',
  posterize: 'Posterize', duotone: 'Duotone', lut: 'Colour LUT (.cube)',
  emboss: 'Emboss', edgeDetect: 'Edge detect', kuwahara: 'Oil paint (Kuwahara)', pixelate: 'Pixelate', dither: 'Dither', crt: 'CRT', grain: 'Film grain & noise', bloom: 'Bloom',
  displace: 'Displace', twirl: 'Twirl', ripple: 'Ripple & wave', lensDistortion: 'Lens distortion', polar: 'Polar coordinates', kaleidoscope: 'Kaleidoscope', tileMirror: 'Tile & mirror',
  driftGlitch: 'Drift glitch', feedback: 'Feedback trails', echo: 'Echo', colorCycle: 'Colour cycle',
};

const humanize = (key: string): string => {
  const w = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const PARAM_LABELS: Record<string, string> = {
  inLow: 'Input black', inHigh: 'Input white', outLow: 'Output black', outHigh: 'Output white',
  rr: 'Red from red', rg: 'Red from green', rb: 'Red from blue', gr: 'Green from red', gg: 'Green from green', gb: 'Green from blue',
  br: 'Blue from red', bg: 'Blue from green', bb: 'Blue from blue', r: 'Red constant', g: 'Green constant', b: 'Blue constant',
  grayRed: 'Gray from red', grayGreen: 'Gray from green', grayBlue: 'Gray from blue',
  k1: 'Barrel k1', k2: 'Barrel k2', centerX: 'Centre X', centerY: 'Centre Y', rgbShift: 'RGB shift', strengthX: 'Strength X', strengthY: 'Strength Y',
  colour: 'Colour', dx: 'Offset X', dy: 'Offset Y', cube: '.cube file', adjust: 'Adjustments', useMid: 'Use mid colour', preserveLuminosity: 'Preserve luminosity',
  tilesX: 'Tiles X', tilesY: 'Tiles Y', offsetX: 'Offset X', offsetY: 'Offset Y', angleOffset: 'Angle offset', radiusScale: 'Radius scale',
};
const balanceLabel = (key: string): string | null => {
  const m = /^(shadows|midtones|highlights)(CyanRed|MagentaGreen|YellowBlue)$/.exec(key);
  if (!m) return null;
  const pair = m[2] === 'CyanRed' ? 'cyan / red' : m[2] === 'MagentaGreen' ? 'magenta / green' : 'yellow / blue';
  return `${humanize(m[1])} ${pair}`;
};
const paramLabel = (key: string) => PARAM_LABELS[key] ?? balanceLabel(key) ?? humanize(key);

const unitOf = (u?: string): string => {
  if (!u) return '';
  const t = u.toLowerCase();
  if (t.startsWith('px')) return ' px';
  if (t.startsWith('%') || t.startsWith('percent')) return '%';
  if (t.startsWith('deg')) return '°';
  return '';
};

function numField(key: string, p: RawParam): NumField {
  const min = p.min ?? 0, max = p.max ?? 1, range = max - min;
  const whole = !!p.round || range > 10;
  return { kind: 'num', key, label: paramLabel(key), min, max, step: whole ? 1 : 0.01, unit: unitOf(p.unit), digits: whole ? 0 : 2 };
}

/** Parameter editors of a filter type, in spec order; [] for unknown types. */
export function filterFields(type: string): FilterField[] {
  const spec = SPECS.get(type);
  if (!spec) return [];
  const out: FilterField[] = [];
  let curvesDone = false;
  for (const [key, p] of Object.entries(spec.params)) {
    switch (p.kind) {
      case 'num': out.push(numField(key, p)); break;
      case 'seed': out.push({ kind: 'seed', key, label: paramLabel(key) }); break;
      case 'bool': out.push({ kind: 'bool', key, label: paramLabel(key) }); break;
      case 'enum':
        if (type === 'displace' && key === 'source') out.push({ kind: 'aux', key: 'source', label: 'Source' });
        else out.push({ kind: 'enum', key, label: paramLabel(key), options: (p.values ?? []).map((v): [string, string] => [v, humanize(v)]) });
        break;
      case 'color': out.push({ kind: 'color', key, label: paramLabel(key) }); break;
      case 'points':
        if (!curvesDone) { curvesDone = true; out.push({ kind: 'curves', key: 'curves', label: 'Curves', keys: Object.keys(spec.params).filter((k) => spec.params[k].kind === 'points') }); }
        break;
      case 'stops': out.push({ kind: 'stops', key, label: 'Gradient' }); break;
      case 'list': out.push({ kind: 'list', key, label: paramLabel(key), len: p.len ?? 36 }); break;
      case 'text': out.push({ kind: 'lut', key, label: paramLabel(key) }); break;
      default: break;
    }
  }
  return out;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Default parameters from the spec (stops as {pos, color} objects, lists zero filled). */
export function defaultFilter(type: string): Effect {
  const spec = SPECS.get(type);
  const fx: Record<string, unknown> = { type, enabled: true };
  if (spec) {
    for (const [key, p] of Object.entries(spec.params)) {
      switch (p.kind) {
        case 'stops': fx[key] = (Array.isArray(p.default) ? p.default as [number, RGBA][] : []).map(([pos, color]) => ({ pos, color: { ...color } })); break;
        case 'list': fx[key] = new Array(p.len ?? 36).fill(0); break;
        case 'points': fx[key] = clone(p.default ?? [[0, 0], [1, 1]]); break;
        case 'text': fx[key] = typeof p.default === 'string' ? p.default : ''; break;
        default: if (p.default !== undefined) fx[key] = clone(p.default); break;
      }
    }
  }
  return fx as unknown as Effect;
}

export const isFilterType = (type: string): boolean => SPECS.has(type);
export const filterLabel = (type: string): string => LABELS[type] ?? humanize(type);

export interface FilterGroup { id: FilterGroupId; label: string; types: string[] }
/** The menu groups: documented order first, anything else the library adds is appended to its group. */
export function filterGroups(): FilterGroup[] {
  return FILTER_GROUPS.map((g) => {
    const known = g.order.filter((t) => SPECS.has(t));
    const extra = [...SPECS.values()].filter((s) => s.group === g.id && !g.order.includes(s.type)).map((s) => s.type).sort();
    return { id: g.id, label: g.label, types: [...known, ...extra] };
  });
}

export const ALL_FILTER_TYPES = (): string[] => filterGroups().flatMap((g) => g.types);

/** One-line summary of a filter's spec (tooltips). */
export const filterDoc = (type: string): string => (SPECS.get(type)?.doc ?? '').split('. ')[0].slice(0, 200);

// ---- curves ----
export type CurvePt = [number, number];
export const IDENTITY_CURVE = (): CurvePt[] => [[0, 0], [1, 1]];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Control points ({x,y} objects or pairs) as sorted [x, y] pairs in 0..1; fewer than 2 valid points = identity. */
export function readCurve(v: unknown): CurvePt[] {
  const pts: CurvePt[] = [];
  if (Array.isArray(v)) {
    for (const p of v) {
      const x = Array.isArray(p) ? p[0] : (p as { x?: unknown })?.x, y = Array.isArray(p) ? p[1] : (p as { y?: unknown })?.y;
      if (typeof x === 'number' && typeof y === 'number' && isFinite(x) && isFinite(y)) pts.push([clamp01(x), clamp01(y)]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts.length >= 2 ? pts : IDENTITY_CURVE();
}
export const CURVE_MAX_POINTS = 32;
export const curveIsIdentity = (pts: CurvePt[]): boolean => pts.every(([x, y]) => Math.abs(x - y) < 1e-9);

// ---- gradient stops ----
export interface GradStop { pos: number; color: RGBA }
export const STOPS_MAX = 32;
export function readStops(v: unknown): GradStop[] {
  const out: GradStop[] = [];
  if (Array.isArray(v)) {
    for (const s of v) {
      const pos = (s as GradStop)?.pos, c = (s as GradStop)?.color;
      if (typeof pos === 'number' && isFinite(pos) && c && typeof c === 'object') out.push({ pos: clamp01(pos), color: { r: +c.r || 0, g: +c.g || 0, b: +c.b || 0, a: typeof c.a === 'number' ? c.a : 255 } });
    }
  }
  out.sort((a, b) => a.pos - b.pos);
  return out.length ? out : [{ pos: 0, color: { r: 0, g: 0, b: 0, a: 255 } }, { pos: 1, color: { r: 255, g: 255, b: 255, a: 255 } }];
}
/** Colour of a gradient at `pos` (straight RGBA, linear between stops). */
export function stopColorAt(stops: GradStop[], pos: number): RGBA {
  if (pos <= stops[0].pos) return { ...stops[0].color };
  const last = stops[stops.length - 1];
  if (pos >= last.pos) return { ...last.color };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (pos <= b.pos) {
      const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
      const mix = (u: number, v: number) => Math.round(u + (v - u) * t);
      return { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: mix(a.color.a, b.color.a) };
    }
  }
  return { ...last.color };
}

// ---- LUT (.cube) ----
export interface CubeInfo { ok: boolean; size: number; title: string; reason?: string }
export const CUBE_MAX_CHARS = 12_000_000; // TD refuses larger files
export const LUT_WARN_CHARS = 1_000_000;
/** Cheap .cube header check: only LUT_3D_SIZE 2..64 with size^3 data rows is usable (anything else is a no-op in the filter). */
let lastCube: { text: string; info: CubeInfo } | null = null;
export function inspectCube(text: string): CubeInfo {
  if (lastCube && lastCube.text === text) return lastCube.info; // renders re-inspect the same (possibly MB sized) text
  const info = inspectCubeUncached(text);
  lastCube = { text, info };
  return info;
}
function inspectCubeUncached(text: string): CubeInfo {
  if (!text) return { ok: false, size: 0, title: '', reason: 'empty' };
  let size = 0, title = '', rows = 0, oneD = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1] ?? '', 10) || 0; continue; }
    if (up.startsWith('LUT_1D_SIZE')) { oneD = true; continue; }
    if (/^[A-Z_]/.test(up)) continue; // DOMAIN_MIN / DOMAIN_MAX and other keywords
    if (/^[-+0-9.]/.test(line)) rows++;
  }
  if (oneD && !size) return { ok: false, size: 0, title, reason: '1D LUTs are not supported' };
  if (!(size >= 2 && size <= 64)) return { ok: false, size, title, reason: 'LUT_3D_SIZE must be 2..64' };
  if (rows < size * size * size) return { ok: false, size, title, reason: `expected ${size * size * size} rows, found ${rows}` };
  return { ok: true, size, title };
}
