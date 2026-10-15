// v6 brushes UI state: tip, dynamics, presets (built-in + per-viewer in localStorage + document presets via the engine).
import { effect, signal, type Signal } from '@preact/signals';
import type { BrushDynamics, BrushPreset, BrushSettings, EditorEngine, TipShape } from '../engine/types';
import {
  DEFAULT_DYNAMICS, MAX_DOC_CUSTOM_PRESETS, MAX_DOC_PRESETS, alphaToPng, exportPresetsJson, isTip, loadUserPresets, newPresetId, normDynamics, normSettings, parsePresetsJson, pngToAlpha, saveUserPresets, tipLabel,
} from './brushes';
import type { SliceCtx } from './slice';
import { BRUSHES, TEXTURED_BRUSHES } from './tools';

export type PresetSource = 'builtin' | 'user' | 'document';
export interface PresetEntry { key: string; source: PresetSource; name: string; preset: BrushPreset }
export type CustomTip = { w: number; h: number; alpha: Uint8Array };

/** Built-in presets in the engine's shape; keys are the bare ids ('round', 'ink', …). */
export function builtinPresets(): BrushPreset[] {
  return [...BRUSHES, ...TEXTURED_BRUSHES].map((b) => ({
    id: b.id, name: b.name, tip: b.tip ?? 'round', dynamics: normDynamics(b.dyn),
    settings: { size: b.size, opacity: b.opacity, flow: b.flow, hardness: b.hardness, spacing: b.spacing ?? 0.15 },
  }));
}

export const presetKey = (source: PresetSource, id: string): string => (source === 'builtin' ? id : source === 'user' ? `user:${id}` : `doc:${id}`);

interface Deps { brush: Signal<BrushSettings>; brushPreset: Signal<string>; setBrush(p: Partial<BrushSettings>): void }

export function createBrushesSlice(ctx: SliceCtx, deps: Deps) {
  const tip = signal<TipShape>('round');
  const dynamics = signal<BrushDynamics>({ ...DEFAULT_DYNAMICS });
  const customTip = signal<CustomTip | null>(null);
  const userPresets = signal<BrushPreset[]>(loadUserPresets());
  const docPresets = signal<BrushPreset[]>([]);
  let stopSync: (() => void) | null = null;
  const builtins = builtinPresets();

  const entries = (): PresetEntry[] => [
    ...builtins.map((preset): PresetEntry => ({ key: presetKey('builtin', preset.id), source: 'builtin', name: preset.name, preset })),
    ...userPresets.value.map((preset): PresetEntry => ({ key: presetKey('user', preset.id), source: 'user', name: preset.name, preset })),
    ...docPresets.value.map((preset): PresetEntry => ({ key: presetKey('document', preset.id), source: 'document', name: preset.name, preset })),
  ];
  const find = (key: string): PresetEntry | undefined => entries().find((e) => e.key === key);

  const persistUser = (list: BrushPreset[]) => {
    userPresets.value = list;
    if (!saveUserPresets(list)) ctx.setNotice('Could not save presets in this browser (storage is blocked)');
  };
  const persistDoc = (list: BrushPreset[]): boolean => {
    if (!ctx.hasEngine()) return false;
    if (list.length > MAX_DOC_PRESETS) { ctx.setNotice(`A document holds at most ${MAX_DOC_PRESETS} brush presets`); return false; }
    if (list.filter((p) => p.customTip).length > MAX_DOC_CUSTOM_PRESETS) { ctx.setNotice(`A document holds at most ${MAX_DOC_CUSTOM_PRESETS} presets with custom tips`); return false; }
    ctx.engine().setBrushPresets(list);
    docPresets.value = ctx.engine().brushPresets();
    return true;
  };

  return {
    tip, dynamics, customTip, userPresets, docPresets,
    presetEntries: entries,
    presetByKey: find,
    /** Name shown in the context bar: the chosen preset ('Custom' when it no longer exists). */
    currentPresetName(): string { return find(deps.brushPreset.value)?.name ?? 'Custom'; },
    currentTipLabel(): string { return tipLabel(tip.value); },
    /** Engine sync: tip + dynamics follow the signals. */
    startBrushSync(e: EditorEngine) {
      stopSync?.();
      stopSync = effect(() => { e.setBrushTip(tip.value, dynamics.value, tip.value === 'custom' ? customTip.value ?? undefined : undefined); });
      docPresets.value = e.brushPresets();
    },
    stopBrushSync() { stopSync?.(); stopSync = null; },
    /** Document presets changed in the engine (load, undo, our own edit). */
    syncDocPresets() { if (ctx.hasEngine()) docPresets.value = ctx.engine().brushPresets(); },
    setTip(t: TipShape) {
      if (t === 'custom' && !customTip.peek()) return;
      tip.value = t;
    },
    setDynamics(p: Partial<BrushDynamics>) { dynamics.value = normDynamics({ ...dynamics.peek(), ...p }); },
    /** "From selection": the active layer's luminance × alpha inside the selection becomes the tip. */
    useTipFromSelection(): boolean {
      if (!ctx.hasEngine()) return false;
      const t = ctx.engine().tipFromSelection();
      if (!t || t.w < 1 || t.h < 1) { ctx.setNotice('Make a selection on a pixel layer first'); return false; }
      customTip.value = { w: t.w, h: t.h, alpha: t.alpha };
      tip.value = 'custom';
      return true;
    },
    /** Choose a preset by key (built-in id, `user:<id>`, `doc:<id>`): brush settings, tip and dynamics. Resolves when a custom tip is decoded. */
    async applyPreset(key: string): Promise<void> {
      const e = find(key);
      if (!e) return;
      const p = e.preset;
      deps.brushPreset.value = key;
      deps.setBrush(normSettings(p.settings));
      dynamics.value = normDynamics(p.dynamics);
      if (p.tip === 'custom' && p.customTip) {
        const decoded = await pngToAlpha(p.customTip.png);
        if (deps.brushPreset.peek() !== key) return; // another preset was chosen meanwhile
        if (decoded) { customTip.value = decoded; tip.value = 'custom'; return; }
        ctx.setNotice(`The custom tip of "${p.name}" could not be read`);
        tip.value = 'round';
        return;
      }
      tip.value = isTip(p.tip) && p.tip !== 'custom' ? p.tip : 'round';
    },
    /** Save the current brush as a preset ("user" = this browser, "document" = in the .redoc). Returns its key or null. */
    saveCurrentPreset(name: string, where: 'user' | 'document'): string | null {
      const n = name.trim();
      if (!n) { ctx.setNotice('Name the preset first'); return null; }
      const b = deps.brush.peek();
      const preset: BrushPreset = { id: newPresetId(), name: n.slice(0, 64), settings: normSettings(b), tip: tip.peek(), dynamics: { ...dynamics.peek() } };
      const ct = customTip.peek();
      if (tip.peek() === 'custom' && ct) {
        const png = alphaToPng(ct.w, ct.h, ct.alpha);
        if (!png) { ctx.setNotice('The custom tip could not be saved'); return null; }
        preset.customTip = { w: ct.w, h: ct.h, png };
      }
      if (where === 'user') persistUser([...userPresets.peek(), preset]);
      else if (!persistDoc([...docPresets.peek(), preset])) return null;
      const key = presetKey(where === 'user' ? 'user' : 'document', preset.id);
      deps.brushPreset.value = key;
      return key;
    },
    renamePreset(key: string, name: string): boolean {
      const e = find(key), n = name.trim().slice(0, 64);
      if (!e || e.source === 'builtin' || !n) return false;
      const mapper = (l: BrushPreset[]) => l.map((p) => (p.id === e.preset.id ? { ...p, name: n } : p));
      if (e.source === 'user') persistUser(mapper(userPresets.peek())); else persistDoc(mapper(docPresets.peek()));
      return true;
    },
    deletePreset(key: string): boolean {
      const e = find(key);
      if (!e || e.source === 'builtin') return false;
      const keep = (l: BrushPreset[]) => l.filter((p) => p.id !== e.preset.id);
      if (e.source === 'user') persistUser(keep(userPresets.peek())); else persistDoc(keep(docPresets.peek()));
      if (deps.brushPreset.peek() === key) deps.brushPreset.value = 'round';
      return true;
    },
    /** JSON text of this viewer's presets (the Export button / tests). */
    exportPresets(where: 'user' | 'document' = 'user'): string { return exportPresetsJson(where === 'user' ? userPresets.peek() : docPresets.peek()); },
    /** Merge presets from JSON (a file or pasted text) into this viewer's list / the document. Ids that already exist get fresh ids. Returns the number added; throws on bad JSON. */
    importPresets(text: string, where: 'user' | 'document' = 'user'): number {
      const incoming = parsePresetsJson(text);
      const cur = where === 'user' ? userPresets.peek() : docPresets.peek();
      const used = new Set(cur.map((p) => p.id));
      const added = incoming.map((p) => (used.has(p.id) ? { ...p, id: newPresetId() } : p));
      if (!added.length) return 0;
      if (where === 'user') persistUser([...cur, ...added]);
      else if (!persistDoc([...cur, ...added])) return 0;
      return added.length;
    },
  };
}
