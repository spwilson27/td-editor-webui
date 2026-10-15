import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFECT_FIELDS, EFFECT_ORDER, EXPERIMENTAL, defaultEffect } from '../../src/state/effectDefaults';
import { createStore } from '../../src/state/store';
import { FakeEngine } from '../browser/fakeEngine';

let store: ReturnType<typeof createStore>;
let engine: FakeEngine;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16));
  store = createStore();
  engine = new FakeEngine(64, 48);
  store.attach(engine);
});
afterEach(() => { store.detach(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('effect defaults', () => {
  it('has a default and a schema for each of the 10 types; every schema key exists on the default', () => {
    expect(EFFECT_ORDER.length).toBe(10);
    for (const t of EFFECT_ORDER) {
      const d = defaultEffect(t) as unknown as Record<string, unknown>;
      expect(d.type).toBe(t);
      expect(d.enabled).toBe(true);
      for (const f of EFFECT_FIELDS[t]) {
        expect(d[f.key], `${t}.${f.key}`).toBeDefined();
        if (f.kind === 'num') {
          expect(d[f.key] as number).toBeGreaterThanOrEqual(f.min);
          expect(d[f.key] as number).toBeLessThanOrEqual(f.max);
        }
      }
    }
    expect([...EXPERIMENTAL].sort()).toEqual(['chromaticAberration', 'glitch', 'halftone', 'pixelSort']);
  });
});

describe('store.editEffects', () => {
  it('keeps one draft per layer: two layers edited in one frame are not lost', () => {
    const a = [defaultEffect('stroke')], b = [defaultEffect('bevel')];
    const l2 = store.addLayer();
    store.editEffects('base', a);
    store.editEffects(l2, b);
    expect(store.pendingEffects('base')).toBe(a);
    expect(store.pendingEffects(l2)).toBe(b);
    vi.advanceTimersByTime(20);
    expect(engine.calls.filter((c) => c.startsWith('setEffects'))).toEqual([`setEffects:base:${JSON.stringify(a)}`, `setEffects:${l2}:${JSON.stringify(b)}`]);
  });

  it('coalesces to the latest edit per frame and exposes the pending draft', () => {
    const a = [defaultEffect('stroke')], b = [defaultEffect('stroke'), defaultEffect('bevel')];
    store.editEffects('base', a);
    store.editEffects('base', b);
    expect(store.pendingEffects('base')).toBe(b);
    expect(store.pendingEffects('other')).toBeNull();
    expect(engine.calls.filter((c) => c.startsWith('setEffects')).length).toBe(0);
    vi.advanceTimersByTime(20);
    const calls = engine.calls.filter((c) => c.startsWith('setEffects'));
    expect(calls).toEqual([`setEffects:base:${JSON.stringify(b)}`]);
    expect(store.pendingEffects('base')).toBeNull();
  });

  it('canHaveEffects covers pixel, text, shape and input only', () => {
    expect(['pixel', 'text', 'shape', 'input', 'group', 'adjustment'].map((k) => store.canHaveEffects(k))).toEqual([true, true, true, true, false, false]);
    expect(store.canHaveEffects(undefined)).toBe(false);
  });

  it('openEffects selects the layer and shows the fx tab', () => {
    const id = store.addLayer();
    engine.setActiveLayer('base');
    store.openEffects(id);
    expect(engine.activeLayerId()).toBe(id);
    expect(store.layerTab.value).toBe('fx');
  });
});
