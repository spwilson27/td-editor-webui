import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { LayersPanel } from '../../src/ui/LayersPanel';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const row = (id: string) => q(`[data-layer="${id}"]`);
const maskBtn = (id: string) => q<HTMLButtonElement>('[data-act=mask]', row(id));
const has = (id: string) => !!row(id).querySelector('[data-act=mask]');
const last = (prefix: string) => [...engine.calls].reverse().find((c) => c.startsWith(prefix));

beforeEach(async () => {
  engine = freshEngine();
  store.layerTab.value = 'layers';
  await mount(<LayersPanel />, 'width:290px;height:420px;display:flex;flex-direction:column');
});
afterEach(unmount);

describe('layer masks UI', () => {
  it('Add mask is disabled for the base layer and groups, enabled for pixel and adjustment layers', async () => {
    const add = () => q('[aria-label="Add mask"]');
    expect(add().getAttribute('aria-disabled')).toBe('true'); // base is active
    store.addGroup();
    await settle();
    expect(add().getAttribute('aria-disabled')).toBe('true');
    store.addLayer();
    await settle();
    expect(add().getAttribute('aria-disabled')).toBe('false');
    store.addAdjustment('invert');
    await settle();
    expect(add().getAttribute('aria-disabled')).toBe('false');
  });

  it('Add mask creates a mask on the active layer, shows its thumbnail and disables the button', async () => {
    store.addLayer();
    await settle();
    expect(has('L1')).toBe(false);
    q('[aria-label="Add mask"]').click();
    await settle();
    expect(last('addMask')).toBe('addMask:L1');
    expect(has('L1')).toBe(true);
    expect(engine.calls.some((c) => c === 'maskThumb:L1')).toBe(true);
    expect(q('[aria-label="Add mask"]').getAttribute('aria-disabled')).toBe('true');
  });

  it('clicking the mask thumbnail paints on the mask and highlights it; clicking the layer thumbnail goes back to pixels', async () => {
    store.addLayer();
    engine.addMask('L1');
    await settle();
    expect(maskBtn('L1').getAttribute('aria-pressed')).toBe('false');
    maskBtn('L1').click();
    await settle();
    expect(last('paintTarget')).toBe('paintTarget:L1:mask');
    expect(maskBtn('L1').getAttribute('aria-pressed')).toBe('true');
    q('[data-act=thumb]', row('L1')).click();
    await settle();
    expect(last('paintTarget')).toBe('paintTarget:L1:pixels');
    expect(maskBtn('L1').getAttribute('aria-pressed')).toBe('false');
  });

  it('the highlight follows the paint target of the active layer only', async () => {
    store.addLayer(); engine.addMask('L1');
    store.addLayer(); engine.addMask('L2');
    engine.setPaintTarget('L1', 'mask');
    await settle();
    expect(maskBtn('L1').getAttribute('aria-pressed')).toBe('true');
    expect(maskBtn('L2').getAttribute('aria-pressed')).toBe('false');
  });

  it('Shift-click toggles the mask off (red cross) and on', async () => {
    store.addLayer();
    engine.addMask('L1');
    await settle();
    expect(row('L1').querySelector('[data-mask-off]')).toBeNull();
    maskBtn('L1').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await settle();
    expect(last('maskEnabled')).toBe('maskEnabled:L1:false');
    expect(maskBtn('L1').dataset.enabled).toBe('false');
    expect(row('L1').querySelector('[data-mask-off]')).toBeTruthy();
    expect(last('paintTarget')).toBeUndefined(); // shift-click does not change the paint target
    maskBtn('L1').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await settle();
    expect(last('maskEnabled')).toBe('maskEnabled:L1:true');
    expect(row('L1').querySelector('[data-mask-off]')).toBeNull();
  });

  it('pressing the mask thumbnail does not start a layer drag', async () => {
    store.addLayer(); engine.addMask('L1');
    store.addLayer();
    await settle();
    const b = maskBtn('L1');
    b.dispatchEvent(ptr('pointerdown', { clientX: 10, clientY: 10 }));
    b.dispatchEvent(ptr('pointermove', { clientX: 10, clientY: 90 }));
    b.dispatchEvent(ptr('pointerup', { clientX: 10, clientY: 90 }));
    expect(engine.calls.some((c) => c.startsWith('move:'))).toBe(false);
  });

  it('adjustment rows show an adjustment icon instead of a thumbnail; masks work there too', async () => {
    store.addAdjustment('levels');
    await settle();
    const id = engine.activeLayerId()!;
    expect(row(id).querySelector('[data-adjust-icon]')).toBeTruthy();
    expect(row(id).querySelector('canvas')).toBeNull();
    q('[aria-label="Add mask"]').click();
    await settle();
    expect(has(id)).toBe(true);
    expect(q('canvas', row(id))).toBeTruthy(); // the mask thumbnail
  });
});

describe('adjustment menu', () => {
  it('opens from the footer, lists the six adjustments and adds one above the active layer', async () => {
    store.addLayer();
    await settle();
    expect(document.querySelector('[role=menu][aria-label="New adjustment"]')).toBeNull();
    q('[aria-label="New adjustment"]').click();
    await settle();
    const items = [...document.querySelectorAll('[role=menu][aria-label="New adjustment"] [role=menuitem]')].map((e) => e.textContent);
    expect(items).toEqual(['Levels', 'Brightness/Contrast', 'Hue/Saturation', 'Blur', 'Invert', 'Threshold']);
    q('[data-adjustment=hueSaturation]').click();
    await settle();
    expect(last('addAdjustment')).toBe('addAdjustment:hueSaturation');
    expect(document.querySelector('[role=menu][aria-label="New adjustment"]')).toBeNull();
    expect(engine.layers()[0].kind).toBe('adjustment');
  });

  it('closes on Escape and on an outside press without adding anything', async () => {
    q('[aria-label="New adjustment"]').click();
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(document.querySelector('[role=menu]')).toBeNull();
    q('[aria-label="New adjustment"]').click();
    await settle();
    document.body.dispatchEvent(ptr('pointerdown'));
    await settle();
    expect(document.querySelector('[role=menu]')).toBeNull();
    expect(engine.calls.some((c) => c.startsWith('addAdjustment'))).toBe(false);
  });

  it('every adjustment type can be added', async () => {
    for (const t of ['levels', 'brightnessContrast', 'hueSaturation', 'blur', 'invert', 'threshold']) {
      q('[aria-label="New adjustment"]').click();
      await settle();
      q(`[data-adjustment=${t}]`).click();
      await settle();
      expect(last('addAdjustment')).toBe(`addAdjustment:${t}`);
    }
  });
});
