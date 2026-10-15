import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installKeyboard } from '../../src/state/keyboard';
import { store } from '../../src/state/store';
import { ContextBar } from '../../src/ui/ContextBar';
import { ViewportFrame } from '../../src/ui/Rulers';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let uninstall: () => void;

beforeEach(async () => {
  engine = freshEngine(200, 100);
  store.setSnapOn(false);
  engine.setSelection({ x: 40, y: 20, w: 60, h: 40 });
  uninstall = installKeyboard(store);
  store.setTool('brush');
  await mount(<><ContextBar /><ViewportFrame /></>, 'display:flex;flex-direction:column;width:900px;height:520px');
  await settle();
});
afterEach(() => { uninstall(); unmount(); });

const vp = () => q('[data-viewport]');
const over = () => document.querySelectorAll<HTMLCanvasElement>('[data-viewport] canvas')[1];
const px = (x: number, y: number) => {
  const c = over(), r = vp().getBoundingClientRect(), v = store.view.value, k = c.width / r.width;
  return Array.from(c.getContext('2d')!.getImageData(Math.round((v.x + x * v.zoom) * k), Math.round((v.y + y * v.zoom) * k), 1, 1).data);
};
const maxAlpha = (x: number, y: number) => {
  const c = over(), r = vp().getBoundingClientRect(), v = store.view.value, k = c.width / r.width;
  const d = c.getContext('2d')!.getImageData(Math.round((v.x + x * v.zoom) * k) - 3, Math.round((v.y + y * v.zoom) * k) - 3, 6, 6).data;
  let m = 0;
  for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]);
  return m;
};
const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('Quick Mask', () => {
  it('Q toggles the engine quick mask; the overlay is red at about 50% alpha where selected', async () => {
    expect(px(60, 40)[3]).toBe(0);
    key('q');
    await settle();
    expect(engine.quickMask()).toBe(true);
    const [r, g, b, a] = px(60, 40);
    expect(r).toBeGreaterThan(180); expect(g).toBeLessThan(80); expect(b).toBeLessThan(80);
    expect(a).toBeGreaterThan(110); expect(a).toBeLessThan(145);
    expect(px(150, 80)[3]).toBe(0); // outside the selection: no overlay
    key('q');
    await settle();
    expect(engine.quickMask()).toBe(false);
    expect(px(60, 40)[3]).toBe(0);
  });

  it('scales the overlay by the mask coverage', async () => {
    const mask = engine.selectionMask.bind(engine);
    engine.selectionMask = () => { const m = mask()!; return { rect: m.rect, alpha: m.alpha.map((v) => Math.round(v / 4)) }; };
    key('q');
    await settle();
    const a = px(60, 40)[3];
    expect(a).toBeGreaterThan(25); expect(a).toBeLessThan(40);
  });

  it('hides the marching ants while on and brings them back after', async () => {
    key('q');
    await settle();
    expect(maxAlpha(40, 40)).toBeLessThan(200); // the selection edge: just the translucent red, no black / white ants
    key('q');
    await settle();
    await new Promise((r) => setTimeout(r, 150));
    expect(maxAlpha(40, 40)).toBeGreaterThan(200); // ants (black or white line)
  });

  it('redraws when the engine paints into the mask (pixels / surface events) and on selection events', async () => {
    key('q');
    await settle();
    expect(px(150, 80)[3]).toBe(0);
    (engine as unknown as { selectionRect: unknown }).selectionRect = { x: 140, y: 70, w: 30, h: 20 };
    engine.emit({ type: 'pixels', rect: { x: 140, y: 70, w: 30, h: 20 } });
    await settle();
    expect(px(150, 80)[3]).toBeGreaterThan(100);
    expect(px(60, 40)[3]).toBe(0);
    (engine as unknown as { selectionRect: unknown }).selectionRect = { x: 0, y: 0, w: 20, h: 20 };
    engine.emit({ type: 'surface', slot: 3, rect: { x: 0, y: 0, w: 20, h: 20 } });
    await settle();
    expect(px(10, 10)[3]).toBeGreaterThan(100);
    expect(px(150, 80)[3]).toBe(0);
    engine.setSelection({ x: 100, y: 10, w: 20, h: 20 });
    await settle();
    expect(px(110, 20)[3]).toBeGreaterThan(100);
  });

  it('shows a Quick Mask pill with the white-adds hint in the context bar while on', async () => {
    expect(document.querySelector('[data-quick-mask-pill]')).toBeNull();
    key('q');
    await settle();
    expect(q('[data-quick-mask-pill]').textContent).toBe('Quick Mask');
    expect(q('[data-quick-mask-pill]').title).toMatch(/white/i);
    store.setTool('smudge');
    await settle();
    expect(q('[data-quick-mask-pill]')).toBeTruthy();
    key('q');
    await settle();
    expect(document.querySelector('[data-quick-mask-pill]')).toBeNull();
  });

  it('with no selection the overlay is empty', async () => {
    engine.setSelection(null);
    key('q');
    await settle();
    expect(engine.quickMask()).toBe(true);
    expect(px(60, 40)[3]).toBe(0);
  });
});

describe('marching ants timer', () => {
  it('stops while Quick Mask hides the ants and resumes afterwards', async () => {
    const set = vi.spyOn(window, 'setInterval'), clear = vi.spyOn(window, 'clearInterval');
    try {
      key('q');
      await settle();
      expect(clear).toHaveBeenCalled();
      set.mockClear();
      key('q');
      await settle();
      expect(set).toHaveBeenCalledTimes(1);
      clear.mockClear();
      engine.setSelection(null); // no selection: nothing to animate
      await settle();
      expect(clear).toHaveBeenCalledTimes(1);
    } finally { set.mockRestore(); clear.mockRestore(); }
  });
});
