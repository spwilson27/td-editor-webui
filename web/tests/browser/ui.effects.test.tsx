import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Effect, EffectType } from '../../src/engine/types';
import { EFFECT_ORDER, defaultEffect } from '../../src/state/effectDefaults';
import { store } from '../../src/state/store';
import { Studio } from '../../src/ui/Studio';
import type { FakeEngine } from './fakeEngine';
import { frame, freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const setFx = () => engine.calls.filter((c) => c.startsWith('setEffects'));
const lastFx = (): Effect[] => JSON.parse(setFx()[setFx().length - 1].replace(/^setEffects:[^:]+:/, ''));
const tabs = () => [...document.querySelectorAll('[aria-label="Layer panels"] [role=tab]')].map((t) => `${t.textContent}:${t.getAttribute('aria-selected')}`);
const eff = (i = 0) => q(`[data-effect-index="${i}"]`);
const addFx = async (t: EffectType) => {
  q('[data-fx-add]').click();
  await settle();
  q(`[data-add-effect="${t}"]`).click();
  await settle();
  await frame();
  await settle();
};
const range = (el: HTMLInputElement, v: number) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };

beforeEach(async () => {
  engine = freshEngine();
  store.layerTab.value = 'layers';
  store.addLayer();
  await mount(<Studio />, 'width:300px;height:900px;display:flex;flex-direction:column');
  q('[role=tab]:nth-child(3)', q('[aria-label="Layer panels"]')).click();
  await settle();
});
afterEach(unmount);

describe('Effects tab', () => {
  it('is the third tab, shows a hint for groups and adjustments', async () => {
    expect(tabs()).toEqual(['Layers:false', 'History:false', 'Effects:true']);
    expect(document.querySelector('[data-effects-panel]')).toBeTruthy();
    store.addGroup();
    await settle();
    expect(q('[data-effects-hint]').textContent).toBe('Effects are available for pixel, text, shape and input layers.');
    store.addAdjustment('blur');
    await settle();
    // adjustment layers switch to the Adjustment tab; choose Effects again
    q('[role=tab]:nth-child(4)', q('[aria-label="Layer panels"]')).click();
    await settle();
    expect(document.querySelector('[data-effects-hint]')).toBeTruthy();
  });

  it('adds each of the 10 types with its default shape; experimental ones are labelled', async () => {
    expect(document.querySelector('[data-effects-empty]')).toBeTruthy();
    q('[data-fx-add]').click();
    await settle();
    expect([...document.querySelectorAll('[data-add-effect]')].map((b) => b.getAttribute('data-add-effect'))).toEqual(EFFECT_ORDER);
    q('[data-fx-add]').click();
    await settle();
    const expected: Effect[] = [];
    for (const t of EFFECT_ORDER) {
      await addFx(t);
      expected.push(defaultEffect(t));
      expect(lastFx()).toEqual(expected);
    }
    expect(engine.activeLayerId()).toBeTruthy();
    expect(lastFx()[0]).toEqual({ type: 'dropShadow', enabled: true, dx: 4, dy: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 0.75 });
    expect(lastFx()[6]).toEqual({ type: 'pixelSort', enabled: true, direction: 'h', low: 0.25, high: 0.75, key: 'luma' });
    expect(lastFx()[7]).toEqual({ type: 'glitch', enabled: true, amount: 50, blockSize: 16, seed: 1, rgbShift: 4 });
    expect(lastFx()[8]).toEqual({ type: 'chromaticAberration', enabled: true, amount: 4, angle: 0 });
    expect(lastFx()[9]).toEqual({ type: 'halftone', enabled: true, cellSize: 8, angle: 45, shape: 'dot' });
    const exp = [...document.querySelectorAll('[data-effect]')].filter((r) => r.querySelector('[data-fx-experimental]')).map((r) => r.getAttribute('data-effect'));
    expect(exp).toEqual(['pixelSort', 'glitch', 'chromaticAberration', 'halftone']);
  });

  it('edits parameters (slider, enum, colour, alpha) with the exact Effect shape', async () => {
    await addFx('stroke');
    expect(q('[data-fx-params]', eff())).toBeTruthy(); // a new effect starts expanded
    range(q('input[aria-label="Width"]'), 6);
    await settle();
    expect(lastFx()).toEqual([{ type: 'stroke', enabled: true, width: 6, color: { r: 255, g: 255, b: 255, a: 255 }, position: 'outside', opacity: 1 }]);
    const sel = q<HTMLSelectElement>('select[aria-label="Position"]');
    sel.value = 'inside';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await frame(); await settle();
    expect((lastFx()[0] as { position: string }).position).toBe('inside');
    const col = q<HTMLInputElement>('input[data-fx-color=color]');
    col.value = '#ff8000';
    col.dispatchEvent(new Event('input', { bubbles: true }));
    range(q('input[data-fx-alpha=color]'), 128);
    await frame(); await settle();
    expect((lastFx()[0] as { color: unknown }).color).toEqual({ r: 255, g: 128, b: 0, a: 128 });
    expect(q('[data-fx-value=width]').textContent).toBe('6 px');
  });

  it('shows the draft instantly and coalesces slider drags into one engine call per frame', async () => {
    await addFx('dropShadow');
    const before = setFx().length;
    const s = q<HTMLInputElement>('input[aria-label="Blur"]');
    for (const v of [10, 20, 30]) range(s, v);
    await Promise.resolve();
    await settle().then(() => {});
    expect(q('[data-fx-value=blur]').textContent).toBe('30 px');
    expect(setFx().length - before).toBe(1);
    expect((lastFx()[0] as { blur: number }).blur).toBe(30);
  });

  it('toggles enable, reorders, removes', async () => {
    await addFx('dropShadow');
    await addFx('bevel');
    await addFx('colorOverlay');
    q('[data-fx-enable]', eff(1)).click();
    await frame(); await settle();
    expect(lastFx().map((e) => `${e.type}:${e.enabled}`)).toEqual(['dropShadow:true', 'bevel:false', 'colorOverlay:true']);
    q('[data-fx-down]', eff(0)).click();
    await frame(); await settle();
    expect(lastFx().map((e) => e.type)).toEqual(['bevel', 'dropShadow', 'colorOverlay']);
    expect(q('[data-fx-name]', eff(0)).textContent).toBe('Bevel');
    q('[data-fx-up]', eff(2)).click();
    await frame(); await settle();
    expect(lastFx().map((e) => e.type)).toEqual(['bevel', 'colorOverlay', 'dropShadow']);
    const n = setFx().length;
    q('[data-fx-up]', eff(0)).click(); // no-op at the top
    q('[data-fx-down]', eff(2)).click(); // no-op at the bottom
    await frame(); await settle();
    expect(setFx().length).toBe(n);
    q('[data-fx-remove]', eff(1)).click();
    await frame(); await settle();
    expect(lastFx().map((e) => e.type)).toEqual(['bevel', 'dropShadow']);
    expect(document.querySelectorAll('[data-effect]').length).toBe(2);
  });

  it('the open state follows the effect through reorder and removal (not the index)', async () => {
    await addFx('dropShadow');
    await addFx('bevel');
    await addFx('colorOverlay');
    const open = () => [...document.querySelectorAll('[data-effect]')].filter((r) => r.querySelector('[data-fx-params]')).map((r) => r.getAttribute('data-effect'));
    expect(open()).toEqual(['dropShadow', 'bevel', 'colorOverlay']);
    // collapse bevel and dropShadow, leaving only the overlay open
    q('[data-fx-open]', eff(1)).click();
    q('[data-fx-open]', eff(0)).click();
    await settle();
    expect(open()).toEqual(['colorOverlay']);
    q('[data-fx-up]', eff(2)).click();
    await frame(); await settle();
    expect(open()).toEqual(['colorOverlay']);
    expect(q('[data-effect-index="1"]').getAttribute('data-effect')).toBe('colorOverlay');
    q('[data-fx-remove]', eff(0)).click();
    await frame(); await settle();
    expect(open()).toEqual(['colorOverlay']);
    expect(document.querySelectorAll('[data-effect]').length).toBe(2);
  });

  it('does not overflow horizontally in a 260 px column with every effect expanded', async () => {
    unmount();
    await mount(<Studio />, 'width:260px;height:900px;display:flex;flex-direction:column');
    q('[role=tab]:nth-child(3)', q('[aria-label="Layer panels"]')).click();
    await settle();
    for (const t of EFFECT_ORDER) await addFx(t);
    const p = q('[data-effects-panel]');
    const w = p.getBoundingClientRect().width;
    for (const el of p.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width) expect(r.right).toBeLessThanOrEqual(p.getBoundingClientRect().right + 1);
    }
    expect(p.scrollWidth).toBeLessThanOrEqual(Math.ceil(w) + 1);
  });
});

describe('Layer row fx button and badge', () => {
  beforeEach(() => { q('[role=tab]:nth-child(1)', q('[aria-label="Layer panels"]')).click(); });

  it('fx button opens the Effects tab for that layer; badge appears with effects, dimmed when all disabled', async () => {
    await settle();
    engine.setActiveLayer('base');
    await settle();
    const l1 = q('[data-layer="L1"]');
    expect(l1.querySelector('[data-fx-badge]')).toBeNull();
    q('[data-act=fx]', l1).click();
    await settle();
    expect(engine.activeLayerId()).toBe('L1');
    expect(tabs()).toEqual(['Layers:false', 'History:false', 'Effects:true']);
    expect(q('[data-effects-panel]').getAttribute('data-layer-id')).toBe('L1');
    await addFx('glitch');
    q('[role=tab]:nth-child(1)', q('[aria-label="Layer panels"]')).click();
    await settle();
    const badge = q('[data-layer="L1"] [data-fx-badge]');
    expect(badge.style.opacity).toBe('1');
    expect(document.querySelector('[data-layer="base"] [data-fx-badge]')).toBeNull();
    engine.setEffects('L1', [{ ...defaultEffect('glitch'), enabled: false }]);
    await settle();
    expect(q('[data-layer="L1"] [data-fx-badge]').style.opacity).toBe('0.4');
  });

  it('groups and adjustments get no fx button', async () => {
    store.addGroup();
    store.addAdjustment('invert');
    q('[role=tab]:nth-child(1)', q('[aria-label="Layer panels"]')).click();
    await settle();
    expect(document.querySelectorAll('[data-layer] [data-act=fx]').length).toBe(2); // L1 + base
    expect(store.canHaveEffects('group')).toBe(false);
    expect(store.canHaveEffects('adjustment')).toBe(false);
  });
});
