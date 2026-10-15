import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayerTransform } from '../../src/engine/types';
import { installKeyboard } from '../../src/state/keyboard';
import { store } from '../../src/state/store';
import { ContextBar } from '../../src/ui/ContextBar';
import { ViewportFrame } from '../../src/ui/Rulers';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let px: string;
let uninstall: () => void;

beforeEach(async () => {
  engine = freshEngine(200, 100);
  store.setSnapOn(false);
  store.spaceHeld.value = false;
  store.aspectLock.value = true;
  px = engine.addPixelLayer('P');
  engine.setActiveLayer(px);
  engine.setSelection({ x: 20, y: 10, w: 50, h: 30 });
  engine.calls.length = 0;
  uninstall = installKeyboard(store);
  store.setTool('marquee');
  await mount(<><TopBar /><ContextBar /><ViewportFrame /></>, 'display:flex;flex-direction:column;width:900px;height:560px');
  await settle();
});
afterEach(() => { uninstall(); unmount(); store.setSnapOn(true); });

const vp = () => q('[data-viewport]');
const over = () => document.querySelectorAll<HTMLCanvasElement>('[data-viewport] canvas')[1];
const toClient = (x: number, y: number): [number, number] => {
  const r = vp().getBoundingClientRect(), v = store.view.value;
  return [r.left + v.x + x * v.zoom, r.top + v.y + y * v.zoom];
};
const send = (type: string, [x, y]: [number, number], extra: PointerEventInit = {}) => vp().dispatchEvent(ptr(type, { clientX: x, clientY: y, ...extra }));
async function dragDoc(from: [number, number], to: [number, number], mods: PointerEventInit = {}) {
  send('pointerdown', toClient(...from), { buttons: 1, ...mods });
  for (let i = 1; i <= 4; i++) send('pointermove', toClient(from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4), { buttons: 1, ...mods });
  send('pointerup', toClient(...to), mods);
  await settle();
}
const floats = () => engine.calls.filter((c) => c.startsWith('setFloatingTransform:')).map((c) => JSON.parse(c.slice('setFloatingTransform:'.length)) as LayerTransform);
const lastF = () => floats().slice(-1)[0]!;
const overNear = (x: number, y: number, rad = 2) => {
  const c = over(), r = vp().getBoundingClientRect(), k = c.width / r.width, [cx, cy] = toClient(x, y);
  const p = Math.round((cx - r.left) * k), q2 = Math.round((cy - r.top) * k), n = Math.round(rad * store.view.value.zoom * k);
  const d = c.getContext('2d')!.getImageData(Math.max(0, p - n), Math.max(0, q2 - n), 2 * n, 2 * n).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
};
const field = async (id: string, v: number) => {
  const el = q<HTMLInputElement>('#' + id);
  el.value = String(v);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};
const key = (k: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
const menu = async (top: string, item: string) => {
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === top)!.click();
  await settle();
  [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes(item))!.click();
  await settle();
};

describe('Transform Selection', () => {
  it('Select > Transform Selection lifts the selection and switches to the Move tool with the floating box', async () => {
    await menu('Select', 'Transform Selection');
    expect(engine.calls).toContain('liftSelection');
    expect(store.tool.value).toBe('move');
    expect(engine.tool).toBe('move');
    expect(q('[data-float-pill]').textContent).toBe('Transform Selection');
    expect(q('[data-move-options]').getAttribute('data-oriented')).toBe('floating');
    expect(q<HTMLInputElement>('#mw').value).toBe('50');
    expect(q<HTMLInputElement>('#mh').value).toBe('30');
    expect(q<HTMLInputElement>('#mx').value).toBe('20');
    expect(overNear(70, 40, 2)).toBe(true); // se handle on the bounds corner
    expect(document.querySelector('[data-act=apply-transform]')).toBeNull();
  });

  it('Ctrl+T does the same', async () => {
    key('t', { ctrlKey: true });
    await settle();
    expect(store.tool.value).toBe('move');
    expect(engine.floating()).not.toBeNull();
  });

  describe('while floating', () => {
    beforeEach(async () => { key('t', { ctrlKey: true }); await settle(); engine.calls.length = 0; });

    it('moves, scales and rotates through setFloatingTransform, not setTransform', async () => {
      await dragDoc([45, 25], [55, 30]); // body
      expect(lastF()).toMatchObject({ x: expect.closeTo(30, 6), y: expect.closeTo(15, 6), sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
      expect(floats().length).toBe(4);
      await dragDoc([80, 45], [110, 75]); // se handle of the moved box (30..80, 15..45): +30,+30 -> 80x60 wait: se is at (80,45)
      expect(lastF().sx).toBeCloseTo(1.6, 2);
      expect(lastF().sy).toBeCloseTo(2, 2);
      expect(engine.calls.some((c) => c.startsWith('setTransform:'))).toBe(false);
    });

    it('rotates by dragging outside a corner (keeping the centre) and skews with Ctrl on an edge', async () => {
      // box 20..70 x 10..40, centre (45, 25); start 2 doc px beyond the se corner
      await dragDoc([72, 42], [45 - 17, 25 + 49]);
      const r = lastF();
      expect(Math.abs(r.rot)).toBeGreaterThan(30);
      const cx = r.x + (r.sx * 25) * Math.cos(r.rot * Math.PI / 180) - (r.sy * 15) * Math.sin(r.rot * Math.PI / 180);
      const cy = r.y + (r.sx * 25) * Math.sin(r.rot * Math.PI / 180) + (r.sy * 15) * Math.cos(r.rot * Math.PI / 180);
      expect(cx).toBeCloseTo(45, 1); expect(cy).toBeCloseTo(25, 1);
      engine.setFloatingTransform({ x: 20, y: 10, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
      engine.calls.length = 0;
      await dragDoc([45, 40], [60, 40], { ctrlKey: true }); // south edge: half height 15 -> tan 1
      expect(lastF().kx).toBeCloseTo(45, 0);
    });

    it('the context bar fields drive the floating transform, with Rotate / Skew', async () => {
      await field('mr', 30);
      expect(lastF().rot).toBeCloseTo(30, 6);
      await field('mkx', 15);
      expect(lastF()).toMatchObject({ rot: 30, kx: 15 });
      await field('mw', 100);
      expect(lastF().sx).toBeCloseTo(2, 6);
      expect(lastF().sy).toBeCloseTo(2, 6); // aspect lock
    });

    it('marching ants are not drawn for a floating selection (only the box)', async () => {
      await field('mr', 90); // box now spans x 30..60, y 0..50; the old selection edge y = 10 (x 20..70) is outside it
      expect(overNear(65, 10, 1.2)).toBe(false);
      engine.commitFloating();
      engine.setSelection({ x: 20, y: 10, w: 50, h: 30 });
      store.setTool('marquee');
      await settle();
      await new Promise((r) => setTimeout(r, 200));
      expect(overNear(65, 10, 1.2)).toBe(true); // ants are back
    });

    it('Enter commits and Esc cancels, from the keyboard', async () => {
      key('Enter');
      await settle();
      expect(engine.calls).toContain('commitFloating');
      expect(engine.floating()).toBeNull();
      key('t', { ctrlKey: true });
      await settle();
      key('Escape');
      await settle();
      expect(engine.calls).toContain('cancelFloating');
      expect(engine.floating()).toBeNull();
    });

    it('the Commit and Cancel buttons do the same, and the pill and buttons disappear afterwards', async () => {
      q('[data-act=commit-float]').click();
      await settle();
      expect(engine.calls).toContain('commitFloating');
      expect(document.querySelector('[data-float-pill]')).toBeNull();
      expect(document.querySelector('[data-act=commit-float]')).toBeNull();
      store.setTool('move');
      key('t', { ctrlKey: true });
      await settle();
      q('[data-act=cancel-float]').click();
      await settle();
      expect(engine.calls).toContain('cancelFloating');
    });

    it('switching tool commits the floating selection', async () => {
      store.setTool('brush');
      await settle();
      expect(engine.calls).toContain('commitFloating');
      expect(engine.floating()).toBeNull();
    });

    it('changing the active layer commits it', async () => {
      const other = engine.addPixelLayer('Q');
      engine.setActiveLayer(other);
      await settle();
      expect(engine.calls).toContain('commitFloating');
      expect(engine.floating()).toBeNull();
    });

    it('moving the layer content does not commit (same tool, same layer)', async () => {
      await dragDoc([45, 25], [50, 25]);
      expect(engine.calls).not.toContain('commitFloating');
      expect(engine.floating()).not.toBeNull();
    });
  });

  it('nothing to lift: a notice and the tool stays', async () => {
    engine.liftable = false;
    store.setTool('marquee');
    key('t', { ctrlKey: true });
    await settle();
    expect(store.tool.value).toBe('marquee');
    expect(store.notice.value).toMatch(/Nothing to transform/);
  });
});

describe('marching ants timer while floating', () => {
  it('stops for a floating selection and restarts after commit', async () => {
    const set = vi.spyOn(window, 'setInterval'), clear = vi.spyOn(window, 'clearInterval');
    try {
      key('t', { ctrlKey: true });
      await settle();
      expect(clear).toHaveBeenCalled();
      set.mockClear();
      key('Enter');
      await settle();
      expect(set).toHaveBeenCalledTimes(1);
    } finally { set.mockRestore(); clear.mockRestore(); }
  });
});
