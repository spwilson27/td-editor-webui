import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { ContextBar } from '../../src/ui/ContextBar';
import { SelectionOpDialog } from '../../src/ui/SelectionOpDialog';
import { TopBar } from '../../src/ui/TopBar';
import { Viewport } from '../../src/ui/Viewport';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
beforeEach(() => {
  engine = freshEngine(64, 48);
  store.setSelOpts({ mode: 'new', feather: 0, antialias: true, wandTolerance: 32, wandContiguous: true, wandSampleAll: false });
  store.tool.value = 'lasso';
});
afterEach(unmount);

const slide = async (id: string, value: number) => {
  const el = q<HTMLInputElement>('#' + id);
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes(name))!;

describe('selection context bars', () => {
  beforeEach(async () => { await mount(<ContextBar />, 'width:1500px'); });

  it('lasso: mode segments, feather and antialias reach the engine; hints are shown', async () => {
    const modes = [...document.querySelectorAll<HTMLElement>('[data-sel-mode]')];
    expect(modes.map((m) => m.textContent)).toEqual(['New', 'Add', 'Subtract', 'Intersect']);
    expect(q('[data-sel-hint]').textContent).toContain('Shift');
    expect(q('[data-sel-hint]').textContent).toContain('Alt');
    q('[data-sel-mode=subtract]').click();
    await settle();
    expect(q('[data-sel-mode=subtract]').getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-sel-mode=new]').getAttribute('aria-pressed')).toBe('false');
    await slide('sf', 12);
    q<HTMLInputElement>('#sa').click();
    await settle();
    expect(engine.selectionOptions).toMatchObject({ mode: 'subtract', feather: 12, antialias: false });
    expect(document.querySelector('#wt')).toBeNull(); // wand-only controls
  });

  it('wand adds tolerance, contiguous and sample-all', async () => {
    store.setTool('wand');
    await settle();
    await slide('wt', 90);
    q<HTMLInputElement>('#wc').click();
    q<HTMLInputElement>('#wa').click();
    await settle();
    expect(engine.selectionOptions).toMatchObject({ wandTolerance: 90, wandContiguous: false, wandSampleAll: true });
    expect(q('[data-context=name]').textContent).toBe('Flood Select');
  });

  it('marquee shares the same mode and feather settings', async () => {
    store.setTool('marquee');
    q('[data-sel-mode=intersect]').click();
    await settle();
    expect(engine.selectionOptions!.mode).toBe('intersect');
    expect(q<HTMLInputElement>('#sf').value).toBe('0');
  });
});

describe('Select menu', () => {
  beforeEach(async () => { await mount(<TopBar />, 'width:1200px'); });
  const open = async (label: string) => {
    [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === label)!.click();
    await settle();
  };

  it('Select All, Deselect and Invert call the engine; Mask from Selection needs a selection and a maskable layer', async () => {
    await open('Select');
    expect(menuItem('Select All').textContent).toContain('Ctrl+A');
    expect(menuItem('Invert').textContent).toContain('Shift+Ctrl+I');
    expect(menuItem('Mask from Selection').getAttribute('aria-disabled')).toBe('true');
    menuItem('Select All').click();
    await settle();
    expect(engine.selection()).toEqual({ x: 0, y: 0, w: 64, h: 48 });
    store.addLayer();
    await open('Select');
    expect(menuItem('Mask from Selection').getAttribute('aria-disabled')).toBe('false');
    menuItem('Invert').click();
    await settle();
    await open('Select');
    menuItem('Mask from Selection').click();
    await settle();
    await open('Select');
    menuItem('Deselect').click();
    await settle();
    expect(engine.calls.filter((c) => /^(selectAll|invertSelection|deselect|maskFromSelection)/.test(c))).toEqual(['selectAll', 'invertSelection', `maskFromSelection:${engine.activeLayerId()}`, 'deselect']);
    expect(engine.selection()).toBeNull();
  });
});

describe('marching ants for arbitrary selections', () => {
  it('draws the outline from selectionPath on the overlay canvas, animated, also in TD panel mode', async () => {
    await mount(<Viewport />, 'display:flex;flex-direction:column;width:400px;height:300px');
    const over = document.querySelectorAll<HTMLCanvasElement>('[data-viewport] canvas')[1];
    // a triangle whose bounding rect corner stays empty: proves a polygon, not the rect, is drawn
    engine.selectionPath = () => [[{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 10, y: 40 }]];
    engine.setSelection({ x: 10, y: 10, w: 40, h: 30 });
    await settle();
    const v = store.view.value, k = over.width / 400;
    const px = (dx: number, dy: number) => Array.from(over.getContext('2d')!.getImageData(Math.round((v.x + dx * v.zoom) * k), Math.round((v.y + dy * v.zoom) * k), 3, 3).data.filter((_, i) => i % 4 === 3)).some((a) => a > 0);
    expect(px(30, 10)).toBe(true); // top edge
    expect(px(10, 25)).toBe(true); // left edge
    expect(px(50, 40)).toBe(false); // rect corner is NOT outlined
    const frame = () => over.getContext('2d')!.getImageData(0, 0, over.width, over.height).data.join(',');
    const a = frame();
    await new Promise((r) => setTimeout(r, 400));
    expect(frame()).not.toBe(a); // dash offset moved
    store.viewMode.value = 'td';
    store.clientKind.value = 'panel';
    await settle();
    expect(px(30, 10)).toBe(true);
    store.viewMode.value = 'local';
    store.clientKind.value = 'external';
  });

  it('shows the in-progress lasso outline while dragging and forwards the pointer stream to the engine', async () => {
    await mount(<Viewport />, 'display:flex;flex-direction:column;width:400px;height:300px');
    const vp = q('[data-viewport]'), r = vp.getBoundingClientRect(), v = store.view.value;
    const at = (dx: number, dy: number): [number, number] => [r.left + v.x + dx * v.zoom, r.top + v.y + dy * v.zoom];
    vp.dispatchEvent(ptr('pointerdown', { clientX: at(10, 10)[0], clientY: at(10, 10)[1], buttons: 1 }));
    for (const [x, y] of [[30, 10], [30, 30], [10, 30]]) vp.dispatchEvent(ptr('pointermove', { clientX: at(x, y)[0], clientY: at(x, y)[1], buttons: 1 }));
    await settle();
    const over = document.querySelectorAll<HTMLCanvasElement>('[data-viewport] canvas')[1];
    const k = over.width / 400;
    const some = (dx: number, dy: number) => over.getContext('2d')!.getImageData(Math.round((v.x + dx * v.zoom) * k) - 1, Math.round((v.y + dy * v.zoom) * k) - 1, 3, 3).data.some((c, i) => i % 4 === 3 && c > 0);
    expect(some(20, 10)).toBe(true);
    vp.dispatchEvent(ptr('pointerup', { clientX: at(10, 30)[0], clientY: at(10, 30)[1] }));
    await settle();
    expect(engine.pointers.map((p) => p.kind)).toEqual(['down', 'move', 'move', 'move', 'up']);
    expect(some(20, 10)).toBe(false); // preview gone after release
  });
});

describe('Select > Grow / Shrink / Smooth / Feather / Border dialog', () => {
  beforeEach(async () => {
    engine.setSelection({ x: 5, y: 5, w: 20, h: 20 });
    engine.calls.length = 0;
    store.selOpDialog.value = null;
    await mount(<><TopBar /><SelectionOpDialog /></>);
  });
  afterEach(() => { store.selOpDialog.value = null; });

  const open = async (item: string) => {
    [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === 'Select')!.click();
    await settle();
    menuItem(item).click();
    await settle();
  };
  const input = () => q<HTMLInputElement>('[data-selop-field]');
  const type = async (v: string) => { input().value = v; input().dispatchEvent(new Event('input', { bubbles: true })); await settle(); };
  const enter = async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle(); };

  it('opens with a per-op title and a default of 4 px, focused', async () => {
    expect(document.querySelector('[data-selop-dialog]')).toBeNull();
    for (const [item, title] of [['Grow', 'Grow Selection'], ['Shrink', 'Shrink Selection'], ['Smooth', 'Smooth Selection'], ['Feather', 'Feather Selection'], ['Border', 'Border Selection']] as const) {
      await open(item);
      expect(q('[role=dialog]').textContent).toContain(title);
      expect(input().value).toBe('4');
      expect(document.activeElement).toBe(input());
      store.selOpDialog.value = null;
      await settle();
    }
  });

  it('OK applies the op with the px value and closes', async () => {
    await open('Grow');
    await type('12');
    q('[data-selop-ok]').click();
    await settle();
    expect(engine.calls).toContain('modifySelection:grow:12');
    expect(document.querySelector('[data-selop-dialog]')).toBeNull();
  });

  it('Enter applies; Esc and Cancel close without applying', async () => {
    await open('Shrink');
    await enter();
    expect(engine.calls).toContain('modifySelection:shrink:4');
    expect(store.selOpDialog.value).toBeNull();
    await open('Border');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(document.querySelector('[data-selop-dialog]')).toBeNull();
    await open('Smooth');
    q('[data-selop-cancel]').click();
    await settle();
    expect(document.querySelector('[data-selop-dialog]')).toBeNull();
    expect(engine.calls.filter((c) => c.startsWith('modifySelection'))).toEqual(['modifySelection:shrink:4']);
  });

  it('validates the range: feather accepts 0, the others need 1..200 (engine MAX_SEL_PX)', async () => {
    await open('Feather');
    await type('0');
    expect(q('[data-selop-ok]').getAttribute('aria-disabled')).toBe('false');
    await enter();
    expect(engine.calls).toContain('modifySelection:feather:0');
    await open('Grow');
    await type('0');
    expect(q('[data-selop-ok]').getAttribute('aria-disabled')).toBe('true');
    await enter();
    await type('201');
    await enter();
    await type('');
    await enter();
    expect(engine.calls.filter((c) => c.startsWith('modifySelection:grow'))).toEqual([]);
    expect(store.selOpDialog.value).toBe('grow');
    await type('200');
    await enter();
    expect(engine.calls).toContain('modifySelection:grow:200');
  });

  it('a stray key does not reach the shortcuts while the dialog is open', async () => {
    const { installKeyboard } = await import('../../src/state/keyboard');
    const off = installKeyboard(store);
    await open('Grow');
    const before = store.tool.value;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(store.tool.value).toBe(before);
    off();
  });

  it('is not offered without a selection', async () => {
    engine.setSelection(null);
    await settle();
    store.openSelectionOp('grow');
    expect(store.selOpDialog.value).toBeNull();
  });
});
