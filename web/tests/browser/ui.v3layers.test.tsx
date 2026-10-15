import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeShapeSpec, completeTextSpec } from '../../src/state/specs';
import { store } from '../../src/state/store';
import { LayersPanel } from '../../src/ui/LayersPanel';
import { TopBar } from '../../src/ui/TopBar';
import { App } from '../../src/ui/App';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
beforeEach(() => { engine = freshEngine(64, 48); store.layerTab.value = 'layers'; });
afterEach(() => { unmount(); store.connection.value = 'reconnecting'; store.bridge = null; });

const openMenu = async (label: string) => {
  [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === label)!.click();
  await settle();
};
const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes(name))!;

describe('layers panel: text and shape layers', () => {
  beforeEach(async () => { await mount(<LayersPanel />, 'width:300px;height:500px;display:flex;flex-direction:column'); });

  it('rows show an icon and the name; pixel layers still draw thumbnails', async () => {
    engine.addPixelLayer('Paint');
    const t = engine.addTextLayer(completeTextSpec({ text: 'Title' }));
    const s = engine.addShapeLayer(completeShapeSpec({ type: 'ellipse' }));
    await settle();
    expect(q(`[data-layer="${t}"] [data-kind-icon=text]`)).toBeTruthy();
    expect(q(`[data-layer="${s}"] [data-kind-icon=shape]`)).toBeTruthy();
    expect(q(`[data-layer="${t}"] [data-name]`).textContent).toBe('Title');
    expect(q(`[data-layer="${s}"] [data-name]`).textContent).toBe('ellipse');
    expect(document.querySelectorAll('[data-layer] canvas').length).toBe(2); // Paint + TD Input
    expect(engine.calls).not.toContain(`thumb:${t}`);
  });

  const bridgeStub = (calls: string[], fail?: string) => ({
    listTops: async () => [], importTop: async () => '',
    renderLayer: async (id: string) => { calls.push(`render:${id}`); if (fail) throw new Error(fail); engine.replaceWithPixels(id, new Uint8Array(64 * 48 * 4), 64, 48); },
  });

  it('there is no Rasterize checkbox or properties strip any more', async () => {
    engine.addTextLayer(completeTextSpec({ text: 'T' }));
    await settle();
    expect(document.querySelector('[data-rasterize]')).toBeNull();
    expect(document.querySelector('[data-layer-props]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Rasterize/);
  });

  it('text and shape rows get a Flatten button next to the lock; pixel and base rows do not', async () => {
    const t = engine.addTextLayer(completeTextSpec({ text: 'T' }));
    const s = engine.addShapeLayer(completeShapeSpec({ type: 'rect' }));
    const p = engine.addPixelLayer('Px');
    await settle();
    for (const id of [t, s]) {
      const btn = q(`[data-layer="${id}"] [data-act=flatten]`);
      expect(btn.getAttribute('aria-label')).toBe('Flatten to pixels');
      expect(btn.title).toMatch(/Flatten to pixels/);
      expect(btn.querySelector('svg')).toBeTruthy();
      const lock = q(`[data-layer="${id}"] [data-act=lock]`);
      expect(btn.nextElementSibling).toBe(lock); // directly before the lock
    }
    expect(document.querySelector(`[data-layer="${p}"] [data-act=flatten]`)).toBeNull();
    expect(document.querySelector('[data-layer="base"] [data-act=flatten]')).toBeNull();
  });

  it('standalone: the Flatten button is disabled with an explanatory tooltip and does nothing', async () => {
    const t = engine.addTextLayer(completeTextSpec({ text: 'T' }));
    store.connection.value = 'standalone';
    await settle();
    const btn = q(`[data-layer="${t}"] [data-act=flatten]`);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toMatch(/TouchDesigner/);
    btn.click();
    await settle();
    expect(engine.layers().find((l) => l.id === t)!.kind).toBe('text');
  });

  it('linked: Flatten asks the bridge to render the layer, which then replaces it with pixels', async () => {
    const calls: string[] = [];
    store.bridge = bridgeStub(calls);
    store.connection.value = 'linked';
    const t = engine.addShapeLayer(completeShapeSpec({ type: 'ellipse' }));
    await settle();
    const btn = q(`[data-layer="${t}"] [data-act=flatten]`);
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    btn.click();
    await settle();
    expect(calls).toEqual([`render:${t}`]);
    expect(engine.replaced).toMatchObject([{ id: t, w: 64, h: 48 }]);
    expect(engine.layers().find((l) => l.id === t)!.kind).toBe('pixel');
    expect(document.querySelector(`[data-layer="${t}"] [data-act=flatten]`)).toBeNull();
    store.bridge = null;
  });

  it('a failing render shows a notice and leaves the layer alone', async () => {
    store.bridge = bridgeStub([], 'layer not renderable');
    store.connection.value = 'linked';
    const t = engine.addTextLayer(completeTextSpec({ text: 'T' }));
    await settle();
    q(`[data-layer="${t}"] [data-act=flatten]`).click();
    await settle();
    expect(store.notice.value).toMatch(/Flatten failed: layer not renderable/);
    expect(engine.layers().find((l) => l.id === t)!.kind).toBe('text');
    expect(store.flattening.value).toBeNull();
    store.bridge = null;
  });

  it('text and shape layers can take a mask; the Add mask button works on them', async () => {
    const t = engine.addTextLayer(completeTextSpec());
    await settle();
    expect(store.canAddMask()).toBe(true);
    q('[aria-label="Add mask"]').click();
    await settle();
    expect(engine.calls).toContain(`addMask:${t}`);
  });
});

describe('Layer menu', () => {
  beforeEach(async () => { await mount(<TopBar />, 'width:1200px'); });

  it('Flatten Layer is enabled for text / shape layers while linked; there is no Rasterize item', async () => {
    store.bridge = { listTops: async () => [], importTop: async () => '', renderLayer: async (id: string) => { engine.replaceWithPixels(id, new Uint8Array(64 * 48 * 4), 64, 48); } };
    store.connection.value = 'linked';
    await openMenu('Layer');
    expect(item('Flatten Layer').getAttribute('aria-disabled')).toBe('true');
    expect([...document.querySelectorAll('[role=menuitem]')].some((b) => /Rasterize/.test(b.textContent!))).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    const t = engine.addTextLayer(completeTextSpec());
    await settle();
    await openMenu('Layer');
    expect(item('Flatten Layer').getAttribute('aria-disabled')).toBe('false');
    item('Flatten Layer').click();
    await settle();
    expect(engine.replaced.map((r) => r.id)).toEqual([t]);
    expect(engine.layers()[0].kind).toBe('pixel');
    store.bridge = null;
  });

  it('standalone: Flatten Layer is disabled with a tooltip', async () => {
    store.connection.value = 'standalone';
    engine.addTextLayer(completeTextSpec());
    await settle();
    await openMenu('Layer');
    expect(item('Flatten Layer').getAttribute('aria-disabled')).toBe('true');
    expect(item('Flatten Layer').title).toMatch(/TouchDesigner/);
  });
});

describe('App layout with the new tools', () => {
  it('mounts with the shape flyout toggle and the hidden place input inside the app root', async () => {
    await mount(<App />, 'width:1600px;height:960px');
    expect(document.querySelector('[data-flyout-toggle]')).toBeTruthy();
    expect(document.querySelectorAll('[data-tool]').length).toBe(19);
    expect(q<HTMLInputElement>('[data-place-input]').hidden).toBe(true);
    for (const id of ['lasso', 'wand', 'text', 'shape']) expect(q(`[data-tool=${id}]`).getAttribute('aria-disabled')).toBe('false');
  });
});
