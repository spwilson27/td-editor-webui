import { TOOLS } from '../../src/state/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/state/store';
import { FakeEngine } from '../browser/fakeEngine';

let store: ReturnType<typeof createStore>;
let engine: FakeEngine;

beforeEach(() => {
  vi.useFakeTimers();
  store = createStore();
  engine = new FakeEngine(200, 100);
  store.attach(engine);
});
afterEach(() => { store.detach(); vi.useRealTimers(); });

describe('store: tools and brush', () => {
  it('sets enabled tools on the engine and ignores disabled ones', () => {
    store.setTool('eraser');
    expect(store.tool.value).toBe('eraser');
    expect(engine.tool).toBe('eraser');
    const crop = TOOLS.find((t) => t.id === 'crop')!;
    crop.enabled = false;
    try {
      store.setTool('crop');
      expect(store.tool.value).toBe('eraser');
      expect(engine.tool).toBe('eraser');
    } finally { crop.enabled = true; }
  });

  it('pushes colours and brush settings to the engine tool context', () => {
    store.setPrimaryHex('#336699');
    store.alpha.value = 50;
    store.setBrush({ size: 12.4, hardness: 0.9 });
    store.fillTolerance.value = 7;
    expect(engine.context).toMatchObject({
      primary: { r: 51, g: 102, b: 153, a: 128 }, secondary: { r: 255, g: 255, b: 255, a: 255 },
      brush: { size: 12, hardness: 0.9 }, fillTolerance: 7,
    });
  });

  it('clamps brush size and nudges by size-dependent steps', () => {
    store.setBrush({ size: 5000 });
    expect(store.brush.value.size).toBe(1000);
    store.setBrush({ size: 0 });
    expect(store.brush.value.size).toBe(1);
    store.setBrush({ size: 8 });
    store.nudgeSize(1);
    expect(store.brush.value.size).toBe(9);
    store.setBrush({ size: 64 });
    store.nudgeSize(-1);
    expect(store.brush.value.size).toBe(59);
  });

  it('applies brush presets', () => {
    store.applyPreset('ink');
    expect(store.brushPreset.value).toBe('ink');
    expect(store.brush.value).toMatchObject({ size: 8, hardness: 1 });
    store.applyPreset('missing');
    expect(store.brushPreset.value).toBe('ink');
  });
});

describe('store: colour', () => {
  it('keeps recent colours unique, newest first, max 12', () => {
    store.setPrimaryHex('#010203');
    store.setPrimaryHex('#040506');
    store.setPrimaryHex('#010203');
    expect(store.recent.value.slice(0, 2)).toEqual(['#010203', '#040506']);
    expect(store.recent.value.length).toBe(12);
  });

  it('rejects invalid hex without changing the colour', () => {
    const before = store.primary.value;
    expect(store.setPrimaryHex('#nothex')).toBe(false);
    expect(store.primary.value).toBe(before);
  });

  it('keeps hue when saturation or value collapse', () => {
    store.setHsv({ h: 200, s: 1, v: 1 });
    store.applyRgb({ r: 128, g: 128, b: 128 });
    expect(store.hsv.value.h).toBe(200);
    store.applyRgb({ r: 0, g: 0, b: 0 });
    expect(store.hsv.value).toEqual({ h: 200, s: 0, v: 0 });
  });

  it('swaps and resets colours', () => {
    store.setPrimaryHex('#112233');
    store.swapColours();
    expect(store.primary.value).toBe('#ffffff');
    expect(store.secondary.value).toBe('#112233');
    store.defaultColours();
    expect(store.primary.value).toBe('#000000');
    expect(store.secondary.value).toBe('#ffffff');
  });

  it('takes the colour sampled by the picker', () => {
    engine.emit({ type: 'pick', color: { r: 1, g: 2, b: 3, a: 255 } });
    expect(store.primary.value).toBe('#010203');
  });
});

describe('store: engine events', () => {
  it('bumps counters and resizes the doc signal', () => {
    const v = store.docVersion.value;
    engine.emit({ type: 'structure' });
    expect(store.docVersion.value).toBe(v + 1);
    engine.emit({ type: 'history' });
    expect(store.historyVersion.value).toBeGreaterThan(0);
    engine.resize(50, 40);
    expect(store.docSize.value).toEqual({ w: 50, h: 40 });
  });

  it('throttles thumbnail refresh for pixel events', () => {
    const t = store.thumbTick.value;
    for (let i = 0; i < 20; i++) engine.emit({ type: 'pixels', rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(store.thumbTick.value).toBe(t);
    vi.advanceTimersByTime(300);
    expect(store.thumbTick.value).toBe(t + 1);
  });

  it('shows notices and clears them', () => {
    engine.emit({ type: 'notice', message: 'Layer is locked' });
    expect(store.notice.value).toBe('Layer is locked');
    vi.advanceTimersByTime(4100);
    expect(store.notice.value).toBe('');
  });

  it('stops listening after detach', () => {
    store.detach();
    const v = store.docVersion.value;
    engine.emit({ type: 'structure' });
    expect(store.docVersion.value).toBe(v);
  });
});

describe('store: view', () => {
  it('fits on resize of the view and keeps manual zoom afterwards', () => {
    store.setViewSize(1064, 564);
    expect(store.view.value.zoom).toBeCloseTo(Math.min(1000 / 200, 500 / 100), 6);
    store.zoomTo(2);
    expect(store.view.value.zoom).toBe(2);
    store.setViewSize(800, 500);
    expect(store.view.value.zoom).toBe(2);
    store.fit();
    expect(store.view.value.zoom).toBeCloseTo(Math.min(736 / 200, 436 / 100), 6);
  });

  it('refits when the document is resized', () => {
    store.setViewSize(1064, 564);
    engine.resize(400, 100);
    expect(store.view.value.zoom).toBeCloseTo(1000 / 400, 6);
  });

  it('zooms about a point and pans', () => {
    store.setViewSize(500, 500);
    store.zoomTo(1, 0, 0);
    const before = store.toDoc(100, 100);
    store.zoomStep(1, 100, 100);
    expect(store.toDoc(100, 100).x).toBeCloseTo(before.x, 6);
    const x = store.view.value.x;
    store.panBy(10, -5);
    expect(store.view.value.x).toBe(x + 10);
  });
});

describe('store: layers', () => {
  it('adds, groups and deletes through the engine', () => {
    const a = store.addLayer();
    expect(engine.activeLayerId()).toBe(a);
    store.addGroup();
    store.deleteActive();
    expect(engine.layers().some((l) => l.kind === 'group')).toBe(false);
    engine.setActiveLayer('base');
    store.deleteActive(); // v5: input layers can be deleted
    expect(engine.layers().some((l) => l.kind === 'input')).toBe(false);
  });
});

describe('store: v2 view mode, masks, adjustments', () => {
  it('TD view needs a linked connection and toggles the engine preview', () => {
    store.setViewMode('td');
    expect(store.viewMode.value).toBe('local');
    expect(store.tdAvailable.value).toBe(false);
    store.setConnection('linked');
    store.setViewMode('td');
    expect(store.viewMode.value).toBe('td');
    expect(engine.previewEnabled).toBe(false);
    store.setViewMode('local');
    expect(engine.previewEnabled).toBe(true);
  });

  it('falls back to Local when the connection drops while in TD view', () => {
    store.setConnection('linked');
    store.setViewMode('td');
    store.setConnection('reconnecting');
    expect(store.viewMode.value).toBe('local');
    expect(engine.previewEnabled).toBe(true);
  });

  it('only a panel client in TD view is transparent', () => {
    store.setConnection('linked');
    store.setViewMode('td');
    expect(store.tdPanel.value).toBe(false);
    store.clientKind.value = 'panel';
    expect(store.tdPanel.value).toBe(true);
    store.setViewMode('local');
    expect(store.tdPanel.value).toBe(false);
  });

  it('selects the Adjustment tab when an adjustment layer becomes active and leaves it otherwise', () => {
    const adj = store.addAdjustment('blur');
    expect(store.layerTab.value).toBe('adjust');
    engine.setActiveLayer('base');
    expect(store.layerTab.value).toBe('layers');
    engine.setActiveLayer(adj);
    expect(store.layerTab.value).toBe('adjust');
    store.layerTab.value = 'history';
    engine.emit({ type: 'structure' }); // same active layer: the user's tab choice stays
    expect(store.layerTab.value).toBe('history');
  });

  it('adds a mask only to pixel and adjustment layers that have none', () => {
    expect(store.canAddMask()).toBe(false); // base
    store.addLayer();
    expect(store.canAddMask()).toBe(true);
    store.addMask();
    expect(engine.calls.filter((c) => c.startsWith('addMask'))).toHaveLength(1);
    expect(store.canAddMask()).toBe(false);
    store.deleteMask();
    expect(store.canAddMask()).toBe(true);
    store.addGroup();
    expect(store.canAddMask()).toBe(false);
  });

  it('coalesces live adjustment edits to the newest value per animation frame', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16) as unknown as number);
    const id = store.addAdjustment('threshold');
    for (const level of [0.1, 0.2, 0.3]) store.editAdjustment(id, { type: 'threshold', level });
    expect(store.adjDraft.value).toEqual({ id, spec: { type: 'threshold', level: 0.3 } });
    expect(engine.calls.filter((c) => c.startsWith('setAdjustment'))).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(engine.calls.filter((c) => c.startsWith('setAdjustment'))).toEqual([`setAdjustment:${id}:{"type":"threshold","level":0.3}`]);
    expect(store.adjDraft.value).toBeNull();
    vi.unstubAllGlobals();
  });
});
