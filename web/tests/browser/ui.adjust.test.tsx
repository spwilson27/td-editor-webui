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
const adjustCalls = () => engine.calls.filter((c) => c.startsWith('setAdjustment'));

beforeEach(async () => {
  engine = freshEngine();
  store.layerTab.value = 'layers';
  await mount(<Studio />, 'width:300px;height:900px;display:flex;flex-direction:column');
});
afterEach(unmount);

describe('Adjustment panel', () => {
  it('has no Adjustment tab until an adjustment layer is active; it is then selected automatically', async () => {
    expect(tabs()).toEqual(['Layers:true', 'History:false']);
    store.addAdjustment('levels');
    await settle();
    expect(tabs()).toEqual(['Layers:false', 'History:false', 'Adjustment:true']);
    expect(document.querySelector('[data-adjust-panel][data-adjust-type=levels]')).toBeTruthy();
  });

  it('goes back to Layers when a non-adjustment layer becomes active', async () => {
    store.addAdjustment('blur');
    await settle();
    engine.setActiveLayer('base');
    await settle();
    expect(tabs()).toEqual(['Layers:true', 'History:false']);
    expect(document.querySelector('[data-adjust-panel]')).toBeNull();
  });

  it('shows sliders per type with their ranges', async () => {
    const cases: [Parameters<typeof store.addAdjustment>[0], string[]][] = [
      ['levels', ['Input black', 'Gamma', 'Input white', 'Output black', 'Output white']],
      ['brightnessContrast', ['Brightness', 'Contrast']],
      ['hueSaturation', ['Hue', 'Saturation', 'Value']],
      ['blur', ['Radius']],
      ['threshold', ['Level']],
    ];
    for (const [type, labels] of cases) {
      store.addAdjustment(type);
      await settle();
      expect([...document.querySelectorAll('[data-adjust-panel] input[type=range]')].map((i) => i.getAttribute('aria-label'))).toEqual(labels);
    }
    store.addAdjustment('invert');
    await settle();
    expect(document.querySelectorAll('[data-adjust-panel] input[type=range]').length).toBe(0);
    expect(q('[data-adjust-panel]').textContent).toContain('no parameters');
    store.addAdjustment('levels');
    await settle();
    expect(slider('Gamma').min).toBe('0.1');
    expect(slider('Gamma').max).toBe('10');
    store.addAdjustment('hueSaturation');
    await settle();
    expect([slider('Hue').min, slider('Hue').max, slider('Saturation').max]).toEqual(['-180', '180', '2']);
    store.addAdjustment('blur');
    await settle();
    expect(slider('Radius').max).toBe('200');
  });

  it('dragging a slider updates the readout at once and the engine at most once per frame with the newest value', async () => {
    store.addAdjustment('blur');
    await settle();
    setSlider('Radius', 10);
    setSlider('Radius', 20);
    setSlider('Radius', 30);
    await settle();
    expect(q('[data-adjust-value=radius]').textContent).toBe('30 px');
    expect(adjustCalls()).toHaveLength(1);
    expect(adjustCalls()[0]).toContain('"radius":30');
    setSlider('Radius', 40);
    await frame(); await frame();
    expect(adjustCalls()).toHaveLength(2);
    expect(engine.layers()[0].adjustment).toEqual({ type: 'blur', radius: 40 });
  });

  it('editing one parameter keeps the others', async () => {
    store.addAdjustment('levels');
    await settle();
    setSlider('Gamma', 2.2);
    await settle();
    expect(engine.layers()[0].adjustment).toEqual({ type: 'levels', inLow: 0, inHigh: 1, gamma: 2.2, outLow: 0, outHigh: 1 });
  });

  it('reflects engine-side changes (undo) in the sliders', async () => {
    store.addAdjustment('threshold');
    await settle();
    engine.setAdjustment(engine.activeLayerId()!, { type: 'threshold', level: 0.8 });
    await settle();
    expect(slider('Level').value).toBe('0.8');
  });
});
