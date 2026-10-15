import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DYNAMICS, PRESETS_KEY, exportPresetsJson, loadUserPresets, normDynamics, normPreset, normPresetList, normSettings, parsePresetsJson, saveUserPresets,
} from '../../src/state/brushes';
import { builtinPresets } from '../../src/state/brushesSlice';
import { BIG_DOC_PIXELS, createStore } from '../../src/state/store';
import { FakeEngine } from '../browser/fakeEngine';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

let mem: MemoryStorage;
let store: ReturnType<typeof createStore>;
let engine: FakeEngine;
const fresh = (w = 64, h = 48) => { store = createStore(); engine = new FakeEngine(w, h); store.attach(engine); };
beforeEach(() => { mem = new MemoryStorage(); vi.stubGlobal('localStorage', mem); fresh(); });
afterEach(() => { store.detach(); vi.unstubAllGlobals(); });

describe('brush data helpers', () => {
  it('normalises dynamics and settings into range', () => {
    expect(normDynamics(undefined)).toEqual(DEFAULT_DYNAMICS);
    expect(normDynamics({ scatter: 99, scatterCount: 0.2, sizeJitter: -1, angleJitter: 999, roundness: 0, seed: -5 })).toMatchObject({ scatter: 4, scatterCount: 1, sizeJitter: 0, angleJitter: 360, roundness: 0.05, seed: 0 });
    expect(normDynamics({ hueJitter: NaN as unknown as number }).hueJitter).toBe(0);
    expect(normSettings({ size: 5000, opacity: 2, flow: -1, hardness: 0.3, spacing: 0 })).toEqual({ size: 1000, opacity: 1, flow: 0, hardness: 0.3, spacing: 0.01 });
  });

  it('normPreset rejects malformed presets and drops invalid custom tips', () => {
    const ok = { id: 'a', name: ' Chalk ', tip: 'chalk', settings: {}, dynamics: {} };
    expect(normPreset(ok)).toMatchObject({ id: 'a', name: 'Chalk', tip: 'chalk' });
    expect(normPreset({ ...ok, name: '  ' })).toBeNull();
    expect(normPreset({ ...ok, id: '' })?.id).toBeTruthy(); // the engine's sanitiser invents an id
    expect(normPreset(null)).toBeNull();
    expect(normPreset({ ...ok, tip: 'bogus' })?.tip).toBe('round');
    expect(normPreset({ ...ok, tip: 'custom' })?.tip).toBe('round'); // no tip data
    const big = normPreset({ ...ok, tip: 'custom', customTip: { w: 513, h: 4, png: 'data:image/png;base64,AA' } });
    expect(big?.customTip).toBeUndefined();
    const good = normPreset({ ...ok, tip: 'custom', customTip: { w: 8, h: 8, png: 'data:image/png;base64,AA' } });
    expect(good).toMatchObject({ tip: 'custom', customTip: { w: 8, h: 8 } });
    expect(normPreset({ ...ok, tip: 'custom', customTip: { w: 8, h: 8, png: 'https://evil.example/x.png' } })?.customTip).toBeUndefined();
  });

  it('normPresetList drops bad entries and duplicate ids', () => {
    const p = { id: 'a', name: 'A', tip: 'round', settings: {}, dynamics: {} };
    const l = normPresetList([p, p, { id: 'b' }, 4]);
    expect(l.map((x) => x.name)).toEqual(['A', 'A']); // nameless and non-object entries are dropped
    expect(new Set(l.map((x) => x.id)).size).toBe(2); // duplicate ids get fresh ones
    expect(normPresetList('x')).toEqual([]);
  });

  it('the export format round trips and accepts a bare array', () => {
    const list = normPresetList([{ id: 'a', name: 'A', tip: 'star', settings: { size: 30 }, dynamics: { scatter: 2 } }]);
    const json = exportPresetsJson(list);
    expect(JSON.parse(json)).toMatchObject({ format: 'raster-editor-brush-presets', version: 1 });
    expect(parsePresetsJson(json)).toEqual(list);
    expect(parsePresetsJson(JSON.stringify(list))).toEqual(list);
    expect(() => parsePresetsJson('{"foo":1}')).toThrow();
    expect(() => parsePresetsJson('not json')).toThrow();
  });

  it('per-viewer storage: saved presets reload; blocked or corrupt storage never throws', () => {
    const list = normPresetList([{ id: 'a', name: 'A', tip: 'noise', settings: {}, dynamics: {} }]);
    expect(saveUserPresets(list)).toBe(true);
    expect(loadUserPresets()).toEqual(list);
    mem.setItem(PRESETS_KEY, '{broken');
    expect(loadUserPresets()).toEqual([]);
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    expect(loadUserPresets()).toEqual([]);
    expect(saveUserPresets(list)).toBe(false);
  });

  it('built-in presets: the six classic ones keep their settings, the textured ones add tips and dynamics', () => {
    const b = builtinPresets();
    expect(b.slice(0, 6).map((p) => p.id)).toEqual(['round', 'hard', 'ink', 'chalk', 'gouache', 'airbrush']);
    expect(b.slice(0, 6).every((p) => p.tip === 'round')).toBe(true);
    expect(b.find((p) => p.id === 'airbrush')!.settings).toMatchObject({ size: 200, hardness: 0, flow: 0.25 });
    expect(b.find((p) => p.id === 'stars')).toMatchObject({ tip: 'star', dynamics: { scatterCount: 4, angleJitter: 360 } });
    expect(new Set(b.map((p) => p.id)).size).toBe(b.length);
  });
});

describe('brush store', () => {
  it('tip and dynamics follow the engine (setBrushTip) and clamp to their ranges', () => {
    const before = engine.calls.filter((c) => c.startsWith('setBrushTip')).length;
    store.setTip('chalk');
    store.setDynamics({ scatter: 2, scatterCount: 5, angleJitter: 720 });
    const calls = engine.calls.filter((c) => c.startsWith('setBrushTip'));
    expect(calls.length).toBeGreaterThan(before);
    expect(engine.tip).toBe('chalk');
    expect(engine.dynamics).toMatchObject({ scatter: 2, scatterCount: 5, angleJitter: 360 });
    expect(store.currentTipLabel()).toBe('Chalk');
  });

  it('custom tip: "from selection" asks the engine; without a selection a notice explains', () => {
    engine.selectionTip = null;
    expect(store.useTipFromSelection()).toBe(false);
    expect(store.notice.peek()).toMatch(/selection/i);
    expect(store.tip.peek()).toBe('round');
    expect(store.setTip('custom')).toBeUndefined();
    expect(store.tip.peek()).toBe('round'); // nothing to use yet
    engine.selectionTip = { w: 3, h: 2, alpha: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    expect(store.useTipFromSelection()).toBe(true);
    expect(store.tip.peek()).toBe('custom');
    expect(engine.customTip).toEqual({ w: 3, h: 2, alpha: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    expect(engine.tip).toBe('custom');
    store.setTip('round');
    expect(engine.customTip).toBeNull();
  });

  it('applyPreset sets brush settings, tip and dynamics; unknown keys do nothing; classic ids stay synchronous', async () => {
    store.applyPreset('ink');
    expect(store.brushPreset.value).toBe('ink');
    expect(store.brush.value).toMatchObject({ size: 8, hardness: 1 });
    store.applyPreset('missing');
    expect(store.brushPreset.value).toBe('ink');
    await store.applyPreset('stars');
    expect(store.tip.value).toBe('star');
    expect(store.dynamics.value).toMatchObject({ scatterCount: 4, angleJitter: 360, sizeJitter: 0.4 });
    await store.applyPreset('round');
    expect(store.tip.value).toBe('round');
    expect(store.dynamics.value).toEqual(DEFAULT_DYNAMICS);
    expect(store.currentPresetName()).toBe('Round — soft');
  });

  it('saves the current brush as a user preset in this browser (localStorage), renames and deletes it', () => {
    store.setBrush({ size: 33, opacity: 0.5 });
    store.setTip('bristle');
    store.setDynamics({ scatter: 1.5, seed: 9 });
    const key = store.saveCurrentPreset('  My brush ', 'user')!;
    expect(key).toMatch(/^user:/);
    expect(store.presetByKey(key)).toMatchObject({ source: 'user', name: 'My brush' });
    expect(store.brushPreset.value).toBe(key);
    const saved = JSON.parse(mem.getItem(PRESETS_KEY)!) as Array<{ name: string; tip: string; settings: { size: number }; dynamics: { scatter: number; seed: number } }>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'My brush', tip: 'bristle', settings: { size: 33 }, dynamics: { scatter: 1.5, seed: 9 } });
    // per viewer: a new store (a new page load) sees it, a different storage does not
    const other = createStore();
    expect(other.userPresets.value.map((p) => p.name)).toEqual(['My brush']);
    vi.stubGlobal('localStorage', new MemoryStorage());
    expect(createStore().userPresets.value).toEqual([]);
    vi.stubGlobal('localStorage', mem);
    expect(store.renamePreset(key, 'Renamed')).toBe(true);
    expect(store.presetByKey(key)!.name).toBe('Renamed');
    expect(JSON.parse(mem.getItem(PRESETS_KEY)!)[0].name).toBe('Renamed');
    expect(store.renamePreset('round', 'Nope')).toBe(false); // built-ins are fixed
    expect(store.deletePreset('round')).toBe(false);
    expect(store.deletePreset(key)).toBe(true);
    expect(JSON.parse(mem.getItem(PRESETS_KEY)!)).toEqual([]);
    expect(store.brushPreset.value).toBe('round');
  });

  it('refuses an empty name and survives blocked storage with a notice', () => {
    expect(store.saveCurrentPreset('   ', 'user')).toBeNull();
    expect(store.notice.peek()).toMatch(/name/i);
    vi.stubGlobal('localStorage', { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } });
    expect(store.saveCurrentPreset('A', 'user')).toMatch(/^user:/);
    expect(store.notice.peek()).toMatch(/storage/i);
    expect(store.userPresets.value).toHaveLength(1); // still usable this session
  });

  it('document presets go through engine.setBrushPresets and follow the engine (load, undo)', () => {
    const key = store.saveCurrentPreset('In the file', 'document')!;
    expect(key).toMatch(/^doc:/);
    expect(engine.calls).toContain('setBrushPresets:1');
    expect(engine.docSpec().brushPresets!.map((p) => p.name)).toEqual(['In the file']);
    expect(store.docPresets.value.map((p) => p.name)).toEqual(['In the file']);
    expect(mem.getItem(PRESETS_KEY)).toBeNull(); // not stored per viewer
    expect(store.renamePreset(key, 'Renamed in file')).toBe(true);
    expect(engine.brushPresets()[0].name).toBe('Renamed in file');
    // the document is replaced (load): presets follow the loaded document
    engine.loadDocument({ ...engine.docSpec(), brushPresets: [] });
    expect(store.docPresets.value).toEqual([]);
    expect(store.presetEntries().some((e) => e.source === 'document')).toBe(false);
  });

  it('at most 16 document presets with custom tips', () => {
    const tip = { id: 'x', name: 'N', tip: 'custom' as const, settings: normSettings({}), dynamics: normDynamics({}), customTip: { w: 4, h: 4, png: 'data:image/png;base64,AA' } };
    engine.setBrushPresets(Array.from({ length: 16 }, (_, i) => ({ ...tip, id: `t${i}` })));
    store.syncDocPresets();
    store.setTip('round');
    // a plain preset still fits ...
    expect(store.saveCurrentPreset('plain', 'document')).toMatch(/^doc:/);
    // ... but a 17th custom-tip preset does not
    engine.selectionTip = { w: 2, h: 2, alpha: new Uint8Array(4).fill(200) };
    store.useTipFromSelection();
    const n = engine.brushPresets().length;
    store.saveCurrentPreset('17th', 'document');
    expect(engine.brushPresets().length).toBe(n);
  });

  it('import merges presets (fresh ids on collision) and reports bad files', () => {
    store.saveCurrentPreset('One', 'user');
    const json = store.exportPresets('user');
    expect(store.importPresets(json, 'user')).toBe(1);
    const ids = store.userPresets.value.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(store.userPresets.value.map((p) => p.name)).toEqual(['One', 'One']);
    expect(() => store.importPresets('nope', 'user')).toThrow();
    expect(store.importPresets('{"presets":[]}', 'user')).toBe(0);
    expect(store.importPresets(json, 'document')).toBe(1);
    expect(engine.brushPresets()).toHaveLength(1);
  });
});

describe('document preset cap', () => {
  it('refuses more than 64 document presets with a notice', () => {
    const base = normPreset({ id: 'x', name: 'N', tip: 'round', settings: {}, dynamics: {} })!;
    engine.setBrushPresets(Array.from({ length: 64 }, (_, i) => ({ ...base, id: `p${i}` })));
    store.syncDocPresets();
    expect(store.docPresets.value).toHaveLength(64);
    expect(store.saveCurrentPreset('65th', 'document')).toBeNull();
    expect(store.notice.peek()).toMatch(/at most 64/);
    expect(engine.brushPresets()).toHaveLength(64);
    const json = store.exportPresets('document');
    expect(store.importPresets(json, 'document')).toBe(0);
    expect(engine.brushPresets()).toHaveLength(64);
    expect(store.saveCurrentPreset('mine', 'user')).toMatch(/^user:/); // per-viewer presets are not limited by the document
  });
});

describe('big document notice (above ~8 MP)', () => {
  it('threshold is 8 MP; shown once per viewer; never switches the view by itself', () => {
    expect(BIG_DOC_PIXELS).toBe(8_000_000);
    expect(store.bigDocNotice.value).toBe(false);
    store.detach();
    fresh(3000, 2667); // 8.001 MP
    expect(store.bigDocNotice.value).toBe(true);
    expect(store.viewMode.value).toBe('local');
    store.detach();
    fresh(2828, 2828); // 7.998 MP
    expect(store.bigDocNotice.value).toBe(false);
  });

  it('dismissal is remembered per viewer in localStorage', () => {
    store.detach();
    fresh(4000, 3000);
    expect(store.bigDocNotice.value).toBe(true);
    store.dismissBigDocNotice();
    expect(store.bigDocNotice.value).toBe(false);
    expect(mem.getItem('raster-editor.bigDocNoticeDismissed')).toBe('1');
    // a new page load on the same viewer does not show it again
    const again = createStore();
    again.attach(new FakeEngine(4000, 3000));
    expect(again.bigDocNotice.value).toBe(false);
    again.detach();
    // another viewer (empty storage) does
    vi.stubGlobal('localStorage', new MemoryStorage());
    const other = createStore();
    other.attach(new FakeEngine(4000, 3000));
    expect(other.bigDocNotice.value).toBe(true);
    other.detach();
  });

  it('"Try TD view" only works while linked and then ends the notice; unlinked it does nothing', () => {
    store.detach();
    fresh(4000, 3000);
    store.acceptBigDocNotice();
    expect(store.viewMode.value).toBe('local');
    expect(store.bigDocNotice.value).toBe(true);
    store.setConnection('linked');
    store.acceptBigDocNotice();
    expect(store.viewMode.value).toBe('td');
    expect(store.bigDocNotice.value).toBe(false);
    expect(mem.getItem('raster-editor.bigDocNoticeDismissed')).toBe('1');
  });

  it('the notice follows the document size (resize below the threshold hides it)', () => {
    store.detach();
    fresh(4000, 3000);
    expect(store.bigDocNotice.value).toBe(true);
    engine.resize(1000, 1000);
    expect(store.bigDocNotice.value).toBe(false);
  });

  it('blocked storage never throws (notice stays dismissible for the session)', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } });
    const s = createStore();
    s.attach(new FakeEngine(4000, 3000));
    expect(s.bigDocNotice.value).toBe(true);
    s.dismissBigDocNotice();
    expect(s.bigDocNotice.value).toBe(false);
    s.detach();
  });
});
