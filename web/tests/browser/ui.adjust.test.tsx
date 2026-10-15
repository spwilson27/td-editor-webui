import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { Studio } from '../../src/ui/Studio';
import type { FakeEngine } from './fakeEngine';
import { frame, freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const tabs = () => [...document.querySelectorAll('[aria-label="Layer panels"] [role=tab]')].map((t) => `${t.textContent}:${t.getAttribute('aria-selected')}`);
const slider = (label: string) => q<HTMLInputElement>(`input[aria-label="${label}"]`);
const setSlider = (label: string, v: number) => {
  const s = slider(label);
  s.value = String(v);
  s.dispatchEvent(new Event('input', { bubbles: true }));
};
const fxCalls = () => engine.calls.filter((c) => c.startsWith('setEffects'));
const open = async () => { q('[data-fx-open]').click(); await settle(); };

beforeEach(async () => {
  engine = freshEngine();
  store.layerTab.value = 'layers';
  await mount(<Studio />, 'width:300px;height:900px;display:flex;flex-direction:column');
});
afterEach(unmount);

// v8: an adjustment layer is an FX stack; the old Adjustment tab is the Effects panel, the classic adjustments are ordinary FX.
describe('Adjustment layers use the Effects panel', () => {
  it('there is no Adjustment tab; a new adjustment layer opens the Effects tab with its stack', async () => {
    expect(tabs()).toEqual(['Layers:true', 'History:false', 'Effects:false']);
    store.addAdjustment('levels');
    await settle();
    expect(tabs()).toEqual(['Layers:false', 'History:false', 'Effects:true']);
    expect(document.querySelector('[data-adjust-panel]')).toBeNull();
    expect(q('[data-effects-panel]').textContent).toContain('Adjustment stack of');
    expect(document.querySelectorAll('[data-effect=levels]').length).toBe(1);
  });

  it('goes back to Layers when a non-adjustment layer becomes active', async () => {
    store.addAdjustment('blur');
    await settle();
    engine.setActiveLayer('base');
    await settle();
    expect(tabs()).toEqual(['Layers:true', 'History:false', 'Effects:false']);
  });

  it('shows sliders per classic type with the v2 ranges', async () => {
    const cases: [string, string[]][] = [
      ['levels', ['Input black', 'Input white', 'Gamma', 'Output black', 'Output white']],
      ['brightnessContrast', ['Brightness', 'Contrast']],
      ['hueSaturation', ['Hue', 'Saturation', 'Value']],
      ['threshold', ['Level']],
    ];
    for (const [type, labels] of cases) {
      store.addAdjustment(type);
      await settle();
      await open();
      expect([...document.querySelectorAll('[data-fx-params] input[type=range]')].map((i) => i.getAttribute('aria-label'))).toEqual(labels);
    }
    store.addAdjustment('invert');
    await settle();
    await open();
    expect(document.querySelectorAll('[data-fx-params] input[type=range]').length).toBe(0);
    store.addAdjustment('levels');
    await settle();
    await open();
    expect([slider('Gamma').min, slider('Gamma').max]).toEqual(['0.1', '10']);
    store.addAdjustment('hueSaturation');
    await settle();
    await open();
    expect([slider('Hue').min, slider('Hue').max, slider('Saturation').max]).toEqual(['-180', '180', '2']);
    store.addAdjustment('blur');
    await settle();
    await open();
    expect(slider('Radius').max).toBe('200');
  });

  it('dragging a slider updates the readout at once and the engine at most once per frame with the newest value', async () => {
    store.addAdjustment('threshold');
    await settle();
    await open();
    setSlider('Level', 0.1);
    setSlider('Level', 0.2);
    setSlider('Level', 0.3);
    await settle();
    expect(q('[data-fx-value=level]').textContent).toBe('0.30');
    expect(fxCalls()).toHaveLength(1);
    expect(fxCalls()[0]).toContain('"level":0.3');
    setSlider('Level', 0.4);
    await frame(); await frame();
    expect(fxCalls()).toHaveLength(2);
    expect(engine.layers()[0].effects[0]).toMatchObject({ type: 'threshold', level: 0.4 });
  });

  it('editing one parameter keeps the others', async () => {
    store.addAdjustment('levels');
    await settle();
    await open();
    setSlider('Gamma', 2.2);
    await settle();
    expect(engine.layers()[0].effects[0]).toEqual({ type: 'levels', enabled: true, inLow: 0, inHigh: 1, gamma: 2.2, outLow: 0, outHigh: 1 });
  });

  it('reflects engine-side changes (undo) in the sliders', async () => {
    store.addAdjustment('threshold');
    await settle();
    await open();
    const id = engine.activeLayerId()!;
    engine.setEffects(id, [{ type: 'threshold', enabled: true, level: 0.8 } as never]);
    await settle();
    expect(slider('Level').value).toBe('0.8');
  });
});
