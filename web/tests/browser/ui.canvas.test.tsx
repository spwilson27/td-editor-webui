import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Anchor, CanvasMode } from '../../src/engine/types';
import { store } from '../../src/state/store';
import { App } from '../../src/ui/App';
import { CanvasSizeDialog } from '../../src/ui/CanvasSizeDialog';
import { DocTabs } from '../../src/ui/DocTabs';
import { StatusBar } from '../../src/ui/StatusBar';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let sent: { w: number; h: number; mode: CanvasMode }[];
beforeEach(() => {
  engine = freshEngine(200, 100);
  sent = [];
  store.bridge = { listTops: async () => [], importTop: async () => '', setCanvas: (w: number, h: number, mode: CanvasMode) => { sent.push({ w, h, mode }); return true; } };
  store.canvasDialog.value = false;
});
afterEach(() => { unmount(); store.bridge = null; store.canvasDialog.value = false; });

const openMenu = async (label: string) => { [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === label)!.click(); await settle(); };
const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes(name))!;
const field = (id: 'cw' | 'ch') => q<HTMLInputElement>(`#${id}`);
const type = async (id: 'cw' | 'ch', v: string) => { const el = field(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); await settle(); };
const ok = () => q('[data-canvas-ok]');

describe('Document menu', () => {
  it('has Canvas Size… and Follow Input Size; Canvas Size opens the dialog', async () => {
    await mount(<><TopBar /><CanvasSizeDialog /></>, 'width:1200px');
    await openMenu('Document');
    expect(item('Canvas Size…').getAttribute('aria-disabled')).toBe('false');
    expect(item('Follow Input Size').getAttribute('aria-disabled')).toBe('false');
    expect(item('Follow Input Size').getAttribute('aria-checked')).toBe('true'); // the default mode
    item('Canvas Size…').click();
    await settle();
    expect(q('[data-canvas-dialog]')).toBeTruthy();
    expect(field('cw').value).toBe('200');
    expect(field('ch').value).toBe('100');
  });

  it('Follow Input Size resets the engine to follow mode and tells TD', async () => {
    engine.setCanvasSize(300, 150, 'c');
    sent.length = 0;
    await mount(<TopBar />, 'width:1200px');
    await openMenu('Document');
    expect(item('Follow Input Size').getAttribute('aria-checked')).toBe('false');
    item('Follow Input Size').click();
    await settle();
    expect(engine.canvasMode()).toBe('input');
    expect(sent).toEqual([{ w: 0, h: 0, mode: 'input' }]);
  });
});

describe('Canvas Size dialog', () => {
  beforeEach(async () => {
    await mount(<CanvasSizeDialog />);
    store.canvasDialog.value = true;
    await settle();
  });

  it('shows the current size and mode', async () => {
    expect(q('[data-canvas-current]').textContent).toMatch(/200 × 100 px/);
    expect(q('[data-canvas-current]').textContent).toMatch(/Following the TouchDesigner input/);
    engine.setCanvasSize(320, 240, 'c');
    await settle();
    expect(q('[data-canvas-current]').textContent).toMatch(/320 × 240 px/);
    expect(q('[data-canvas-current]').textContent).toMatch(/Fixed size/);
  });

  it('the fields say the 8192 px cap', () => {
    expect(field('cw').title).toMatch(/8192/);
  });

  it('has a 9-point anchor grid, centre selected, one at a time', async () => {
    const ids = [...document.querySelectorAll<HTMLElement>('[data-anchor]')].map((b) => b.dataset.anchor);
    expect(ids).toEqual(['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br']);
    const pressed = () => [...document.querySelectorAll<HTMLElement>('[data-anchor]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.anchor);
    expect(pressed()).toEqual(['c']);
    q('[data-anchor=tl]').click();
    await settle();
    expect(pressed()).toEqual(['tl']);
  });

  it('OK applies W, H and the anchor to the engine and sends setCanvas fixed to TD', async () => {
    await type('cw', '400');
    await type('ch', '300');
    q('[data-anchor=br]').click();
    await settle();
    ok().click();
    await settle();
    expect(engine.canvasCalls).toEqual([{ w: 400, h: 300, anchor: 'br' as Anchor }]);
    expect(sent).toEqual([{ w: 400, h: 300, mode: 'fixed' }]);
    expect(store.docSize.value).toEqual({ w: 400, h: 300 });
    expect(engine.canvasMode()).toBe('fixed');
    expect(document.querySelector('[data-canvas-dialog]')).toBeNull();
  });

  it('the anchor shifts the layers as the engine decides (centre = half the growth)', async () => {
    await type('cw', '300');
    ok().click();
    await settle();
    const base = engine.layers().find((l) => l.id === 'base')!;
    expect(base.transform.x).toBe(50);
    expect(base.transform.y).toBe(0);
  });

  it('rejects empty, zero and oversized values (OK disabled, nothing applied)', async () => {
    for (const bad of ['', '0', '-5', '9000']) {
      await type('cw', bad);
      expect(ok().getAttribute('aria-disabled')).toBe('true');
      ok().click();
      await settle();
      expect(engine.canvasCalls).toHaveLength(0);
      expect(q('[data-canvas-dialog]')).toBeTruthy();
    }
    await type('cw', '640');
    expect(ok().getAttribute('aria-disabled')).toBe('false');
  });

  it('Follow Input Size in the dialog switches the engine to input mode, tells TD and closes', async () => {
    engine.setCanvasSize(320, 240, 'c');
    sent.length = 0;
    await settle();
    q('[data-follow-input]').click();
    await settle();
    expect(engine.canvasMode()).toBe('input');
    expect(sent).toEqual([{ w: 0, h: 0, mode: 'input' }]);
    expect(document.querySelector('[data-canvas-dialog]')).toBeNull();
  });

  it('Cancel, Escape and a click on the backdrop close it without changes', async () => {
    q('[data-canvas-dialog] button:not([data-anchor]):not([data-follow-input]):not([data-canvas-ok])').click();
    await settle();
    expect(document.querySelector('[data-canvas-dialog]')).toBeNull();
    store.canvasDialog.value = true;
    await settle();
    field('cw').focus(); // Escape while a field has focus (the field swallows other keys)
    field('cw').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(document.querySelector('[data-canvas-dialog]')).toBeNull();
    store.canvasDialog.value = true;
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(document.querySelector('[data-canvas-dialog]')).toBeNull();
    store.canvasDialog.value = true;
    await settle();
    q('[data-canvas-dialog]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(document.querySelector('[data-canvas-dialog]')).toBeNull();
    expect(engine.canvasCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('without a bridge (standalone) the canvas still changes locally', async () => {
    store.bridge = null;
    await type('cw', '256');
    ok().click();
    await settle();
    expect(engine.canvasCalls).toHaveLength(1);
  });
});

describe('size and mode readouts', () => {
  it('the document tab and status bar show size and mode, and follow engine changes', async () => {
    await mount(<><DocTabs /><StatusBar /></>, 'width:1000px');
    expect(q('[data-doc-info]').textContent).toContain('200 × 100');
    expect(q('[data-doc-info]').textContent).toContain('Follow input');
    expect(q('[data-status=canvas]').textContent).toContain('200 × 100 · Follow input');
    store.setCanvasSize(512, 256, 'c');
    await settle();
    expect(q('[data-doc-info]').textContent).toContain('512 × 256');
    expect(q('[data-doc-info]').textContent).toContain('Fixed');
    expect(q('[data-status=canvas]').textContent).toContain('512 × 256 · Fixed');
    // TD says the document follows the input again at another size
    engine.adoptCanvas(640, 360, 'input');
    await settle();
    expect(q('[data-status=canvas]').textContent).toContain('640 × 360 · Follow input');
  });

  it('the App wires the dialog', async () => {
    await mount(<App />, 'width:1600px;height:960px');
    await openMenu('Document');
    item('Canvas Size…').click();
    await settle();
    expect(q('[data-canvas-dialog]')).toBeTruthy();
  });
});
