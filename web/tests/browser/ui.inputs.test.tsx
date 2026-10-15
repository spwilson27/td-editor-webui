import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { LayersPanel } from '../../src/ui/LayersPanel';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const items = [{ input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 32, h: 32, connected: true }, { input: 3, w: 0, h: 0, connected: false }];
const feed = (list = items) => { engine.setInputs(list); store.setInputs(list); };

beforeEach(() => { engine = freshEngine(); store.setInputs([]); });
afterEach(unmount);

describe('Input layer rows', () => {
  beforeEach(async () => { await mount(<LayersPanel />, 'width:290px;height:420px;display:flex;flex-direction:column'); });

  it('shows the engine name, an In N meta, and no disconnected mark when connected', async () => {
    feed();
    await settle();
    expect([...document.querySelectorAll('[data-layer] [data-name]')].map((e) => e.textContent).sort()).toEqual(['TD Input 1', 'TD Input 2']);
    expect(q('[data-layer="in2"] [data-meta]').textContent).toBe('In 2');
    expect(document.querySelector('[data-disconnected]')).toBeNull();
  });

  it('marks a disconnected input and keeps it usable', async () => {
    feed();
    engine.addInputLayer(3);
    feed([items[0], items[1], { input: 3, w: 0, h: 0, connected: false }]);
    await settle();
    const row = q('[data-layer="in3"]');
    const mark = q('[data-disconnected]', row);
    expect(mark.title).toBe('TD input 3 is not connected - placement is kept');
    expect(q('[data-name]', row).style.opacity).toBe('0.55');
    expect(document.querySelectorAll('[data-disconnected]').length).toBe(1);
    // delete, reorder, rename all allowed
    q('[data-act=sel]', row).click();
    await settle();
    q('[aria-label="Delete layer"]').click();
    await settle();
    expect(document.querySelector('[data-layer="in3"]')).toBeNull();
    q('[data-act=sel]', q('[data-layer="in2"]')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(document.querySelector('input[aria-label="Layer name"]')).toBeTruthy();
  });
});

describe('store.inputs and Add Input Layer', () => {
  it('connectedInputs / freeInputs exclude disconnected inputs and inputs that already have a layer', () => {
    feed();
    expect(store.connectedInputs().map((i) => i.input)).toEqual([1, 2]);
    expect(store.freeInputs().map((i) => i.input)).toEqual([]); // setInputs created layers for 1 and 2
    engine.deleteLayer('in2');
    expect(store.freeInputs().map((i) => i.input)).toEqual([2]);
    expect(store.addInputLayer(2)).toBe('in2');
    expect(store.freeInputs()).toEqual([]);
  });

  it('Layer menu lists connected inputs and adds an input layer', async () => {
    await mount(<TopBar />, 'width:1200px');
    feed();
    engine.deleteLayer('in2');
    store.setInputs(items);
    await settle();
    [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'Layer')!.click();
    await settle();
    const labels = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].map((b) => b.textContent!).filter((t) => t.startsWith('Add Input Layer'));
    expect(labels).toEqual(['Add Input Layer ▸ Input 1', 'Add Input Layer ▸ Input 2']);
    [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.endsWith('Input 2'))!.click();
    await settle();
    expect(engine.calls).toContain('addInputLayer:2');
    expect(engine.layers().some((l) => l.kind === 'input' && l.input === 2)).toBe(true);
  });

  it('Layer menu shows a disabled placeholder with no connected inputs; Layer Effects opens the tab', async () => {
    await mount(<TopBar />, 'width:1200px');
    store.setInputs([{ input: 1, w: 0, h: 0, connected: false }]);
    await settle();
    [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'Layer')!.click();
    await settle();
    const ph = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes('no connected inputs'))!;
    expect(ph.getAttribute('aria-disabled')).toBe('true');
    const fx = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.startsWith('Layer Effects'))!;
    fx.click();
    await settle();
    expect(store.layerTab.value).toBe('fx');
  });
});
