import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { App } from '../../src/ui/App';
import { ContextBar } from '../../src/ui/ContextBar';
import { StandbyOverlay } from '../../src/ui/StandbyOverlay';
import { StatusBar } from '../../src/ui/StatusBar';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
beforeEach(() => {
  engine = freshEngine();
  store.tool.value = 'brush';
  store.active.value = true;
  store.connection.value = 'standalone';
  store.notice.value = '';
  store.setBrush({ size: 64, opacity: 1, flow: 0.72, hardness: 0.4 });
});
afterEach(unmount);

const slide = async (id: string, value: number) => {
  const el = q<HTMLInputElement>('#' + id);
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};

describe('TopBar', () => {
  beforeEach(async () => { await mount(<TopBar />, 'width:1200px'); });

  it('opens menus, runs implemented items, and closes', async () => {
    const file = [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'File')!;
    file.click();
    await settle();
    expect(document.querySelector('[role=menu]')).toBeTruthy();
    [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent === 'New layer')!.click();
    await settle();
    expect(engine.layers().length).toBe(2);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('disables unimplemented items with a tooltip and keeps the menu open on click', async () => {
    q('.menu').click();
    await settle();
    const open = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.startsWith('Open'))!;
    expect(open.getAttribute('aria-disabled')).toBe('true');
    expect(open.title).toBe('Not in this version');
    open.click();
    await settle();
    expect(document.querySelector('[role=menu]')).toBeTruthy();
  });

  it('closes on outside press and Escape, switches on hover while open', async () => {
    const [file, edit] = [...document.querySelectorAll<HTMLElement>('.menu')];
    file.click();
    await settle();
    edit.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
    await settle();
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(document.querySelector('[role=menu]')).toBeNull();
    file.click();
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('View menu drives zoom', async () => {
    store.setViewSize(800, 600);
    const view = [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'View')!;
    view.click();
    await settle();
    [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.startsWith('100%'))!.click();
    expect(store.view.value.zoom).toBe(1);
  });

  it('undo and redo buttons call the engine; Adjust and Output workspaces are disabled', async () => {
    q('[aria-label=Undo]').click();
    q('[aria-label=Redo]').click();
    expect(engine.calls).toEqual(expect.arrayContaining(['undo', 'redo']));
    const modes = [...document.querySelectorAll<HTMLElement>('[aria-label=Workspace] button')];
    expect(modes.map((m) => m.getAttribute('aria-disabled'))).toEqual(['false', 'true', 'true']);
    expect(modes[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('zoom select shows the current zoom and applies choices', async () => {
    store.setViewSize(800, 600);
    store.zoomTo(0.667);
    await settle();
    const sel = q<HTMLSelectElement>('#zoomSel');
    expect(sel.selectedOptions[0].textContent).toBe('66.7%');
    sel.value = '2';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.view.value.zoom).toBe(2);
    sel.value = 'fit';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.view.value.zoom).toBeCloseTo(Math.min(736 / 64, 536 / 48), 6);
  });
});

describe('ContextBar', () => {
  it('brush options edit the shared brush settings', async () => {
    await mount(<ContextBar />, 'width:1200px');
    await slide('bw', 120);
    await slide('bo', 50);
    await slide('bf', 30);
    await slide('bh', 80);
    expect(store.brush.value).toMatchObject({ size: 120, opacity: 0.5, flow: 0.3, hardness: 0.8 });
    expect(engine.context!.brush).toMatchObject({ size: 120, opacity: 0.5 });
    expect(q('[data-value=bw]').textContent).toBe('120 px');
    expect(q('[data-context=name]').textContent).toBe('Paint Brush');
  });

  it('shows per-tool options', async () => {
    await mount(<ContextBar />, 'width:1200px');
    store.setTool('pencil');
    await settle();
    expect(document.querySelector('#bf')).toBeNull();
    expect(document.querySelector('#bw')).toBeTruthy();
    store.setTool('fill');
    await settle();
    await slide('ft', 99);
    expect(store.fillTolerance.value).toBe(99);
    expect(engine.context!.fillTolerance).toBe(99);
    store.setTool('marquee');
    await settle();
    expect(document.body.textContent).toContain('Feather');
    expect([...document.querySelectorAll('[aria-label="Selection mode"] button')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    store.setTool('move');
    await settle();
    expect(document.body.textContent).toContain('W 64 px');
    engine.setSelection({ x: 3, y: 4, w: 10, h: 20 });
    await settle();
    expect(document.body.textContent).toContain('X 3 px');
    expect(document.body.textContent).toContain('H 20 px');
  });

  it('brush preset button opens the brushes tab', async () => {
    await mount(<ContextBar />, 'width:1200px');
    q('[aria-label="Brush presets"]').click();
    expect(store.colorTab.value).toBe('brushes');
    store.colorTab.value = 'color';
  });
});

describe('StatusBar and StandbyOverlay', () => {
  it('shows hint, active layer, connection state and notices', async () => {
    await mount(<StatusBar />, 'width:900px');
    expect(q('[data-status=hint]').textContent).toContain('Drag to paint');
    expect(q('[data-status=layer]').textContent).toBe('TD Input');
    expect(q('[data-status=connection]').textContent).toContain('Standalone');
    store.setConnection('linked');
    store.setNotice('Layer is locked');
    store.addLayer();
    await settle();
    expect(q('[data-status=connection]').textContent).toContain('TouchDesigner linked');
    expect(q('[data-status=notice]').textContent).toBe('Layer is locked');
    expect(q('[data-status=layer]').textContent).toBe('Layer 1');
    store.setConnection('reconnecting');
    await settle();
    expect(q('[data-status=connection]').textContent).toContain('Reconnecting…');
    store.setNotice('');
  });

  it('standby overlay appears when inactive and Take over calls the bridge', async () => {
    let taken = 0;
    store.takeover = () => { taken++; };
    await mount(<StandbyOverlay />);
    expect(document.querySelector('[data-standby]')).toBeNull();
    store.setActive(false);
    await settle();
    expect(q('[data-standby]').textContent).toContain('Editing in another window');
    [...document.querySelectorAll<HTMLElement>('[data-standby] button')].find((b) => b.textContent === 'Take over')!.click();
    expect(taken).toBe(1);
    store.setActive(true);
    await settle();
    expect(document.querySelector('[data-standby]')).toBeNull();
  });
});

describe('App', () => {
  it('mounts the whole editor with all regions', async () => {
    await mount(<App />, 'width:1600px;height:960px');
    expect(document.querySelectorAll('[data-tool]').length).toBe(17);
    expect(document.querySelector('[data-viewport]')).toBeTruthy();
    expect(document.querySelector('[data-wheel]')).toBeTruthy();
    expect(document.querySelector('[data-layer-list]')).toBeTruthy();
    expect(q('[role=tab][aria-selected=true]').textContent).toBe('Colour');
    [...document.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => t.textContent === 'History')!.click();
    await settle();
    expect(document.querySelector('[data-history]')).toBeTruthy();
    [...document.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => t.textContent === 'Swatches')!.click();
    await settle();
    expect(document.querySelector('[data-swatch-colour]')).toBeTruthy();
    store.colorTab.value = 'color';
    store.layerTab.value = 'layers';
  });
});
