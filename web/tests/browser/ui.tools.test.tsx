import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { installKeyboard } from '../../src/state/keyboard';
import { store } from '../../src/state/store';
import { App } from '../../src/ui/App';
import { ContextBar } from '../../src/ui/ContextBar';
import { ViewportFrame } from '../../src/ui/Rulers';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let uninstall: () => void;

beforeEach(async () => {
  engine = freshEngine(200, 100);
  store.setSnapOn(false);
  store.spaceHeld.value = false;
  store.cloneOpts.value = { aligned: true, sampleAll: false };
  store.cropBox.value = null;
  uninstall = installKeyboard(store);
  store.setTool('brush');
  await mount(<><ContextBar /><ViewportFrame /></>, 'display:flex;flex-direction:column;width:900px;height:520px');
  await settle();
});
afterEach(() => { uninstall(); unmount(); store.setSnapOn(true); store.cropBox.value = null; });

const vp = () => q('[data-viewport]');
const over = () => document.querySelectorAll<HTMLCanvasElement>('[data-viewport] canvas')[1];
const toClient = (x: number, y: number): [number, number] => {
  const r = vp().getBoundingClientRect(), v = store.view.value;
  return [r.left + v.x + x * v.zoom, r.top + v.y + y * v.zoom];
};
const send = (type: string, [x, y]: [number, number], extra: PointerEventInit = {}) => vp().dispatchEvent(ptr(type, { clientX: x, clientY: y, ...extra }));
async function dragDoc(from: [number, number], d: [number, number], mods: PointerEventInit = {}) {
  send('pointerdown', toClient(...from), { buttons: 1, ...mods });
  for (let i = 1; i <= 4; i++) send('pointermove', toClient(from[0] + (d[0] * i) / 4, from[1] + (d[1] * i) / 4), { buttons: 1, ...mods });
  send('pointerup', toClient(from[0] + d[0], from[1] + d[1]), mods);
  await settle();
}
const overAlpha = (x: number, y: number) => {
  const c = over(), r = vp().getBoundingClientRect(), k = c.width / r.width, [cx, cy] = toClient(x, y);
  return c.getContext('2d')!.getImageData(Math.round((cx - r.left) * k), Math.round((cy - r.top) * k), 1, 1).data[3];
};
/** Any painted overlay pixel within `rad` doc px of a point. */
const overNear = (x: number, y: number, rad = 8) => {
  const c = over(), r = vp().getBoundingClientRect(), k = c.width / r.width, [cx, cy] = toClient(x, y);
  const px = Math.round((cx - r.left) * k), py = Math.round((cy - r.top) * k), n = Math.round(rad * store.view.value.zoom * k);
  const d = c.getContext('2d')!.getImageData(Math.max(0, px - n), Math.max(0, py - n), 2 * n, 2 * n).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
};
const slide = async (id: string, value: number) => {
  const el = q<HTMLInputElement>('#' + id);
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};
const click = async (sel: string) => { q(sel).click(); await settle(); };
const key = (k: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
const field = async (id: string, v: number) => {
  const el = q<HTMLInputElement>('#' + id);
  el.value = String(v);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};

describe('retouch tool context bars', () => {
  it('Clone: size, hardness, Aligned and Sample all layers reach the engine', async () => {
    store.setTool('clone');
    await settle();
    expect(q('[data-context=name]').textContent).toBe('Clone Brush');
    await slide('bw', 80); await slide('bh', 30);
    expect(store.brush.value).toMatchObject({ size: 80, hardness: 0.3 });
    expect(engine.context!.brush).toMatchObject({ size: 80, hardness: 0.3 });
    expect(q<HTMLInputElement>('#cla').checked).toBe(true);
    expect(q<HTMLInputElement>('#clsa').checked).toBe(false);
    q<HTMLInputElement>('#cla').click(); await settle();
    expect(engine.cloneOpts).toEqual({ aligned: false, sampleAll: false });
    q<HTMLInputElement>('#clsa').click(); await settle();
    expect(engine.cloneOpts).toEqual({ aligned: false, sampleAll: true });
    expect(document.querySelector('#bo, #bf')).toBeNull(); // no opacity / flow for the retouch brushes
  });

  it('Smudge: strength', async () => {
    store.setTool('smudge');
    await settle();
    expect(q('[data-context=name]').textContent).toBe('Smudge Brush');
    await slide('rs', 70);
    expect(engine.retouchOpts.strength).toBeCloseTo(0.7);
    expect(document.querySelector('[data-opt=sharpen], [data-range]')).toBeNull();
  });

  it('Blur / Sharpen: strength and the Sharpen toggle', async () => {
    store.setTool('blur');
    await settle();
    await slide('rs', 25);
    expect(engine.retouchOpts).toMatchObject({ strength: 0.25, sharpen: false });
    await click('[data-opt=sharpen]');
    expect(engine.retouchOpts.sharpen).toBe(true);
    expect(q('[data-opt=sharpen]').getAttribute('aria-pressed')).toBe('true');
    await click('[data-opt=sharpen]');
    expect(engine.retouchOpts.sharpen).toBe(false);
  });

  it('Dodge / Burn: range, exposure and the Burn toggle', async () => {
    store.setTool('dodge');
    await settle();
    expect([...document.querySelectorAll('[data-range]')].map((b) => b.getAttribute('data-range'))).toEqual(['shadows', 'midtones', 'highlights']);
    expect(q('[data-range=midtones]').getAttribute('aria-pressed')).toBe('true');
    await click('[data-range=highlights]');
    expect(engine.retouchOpts.range).toBe('highlights');
    expect(q('[data-range=midtones]').getAttribute('aria-pressed')).toBe('false');
    await slide('re', 20);
    expect(engine.retouchOpts.exposure).toBeCloseTo(0.2);
    await click('[data-opt=burn]');
    expect(engine.retouchOpts.burn).toBe(true);
  });

  it('the brush-like tools draw the brush cursor and route pointers to the engine', async () => {
    store.setBrush({ size: 40 });
    for (const t of ['clone', 'smudge', 'blur', 'dodge'] as const) {
      store.setTool(t);
      await settle();
      send('pointermove', toClient(100, 50));
      await settle();
      expect(vp().style.cursor, t).toBe('none');
      expect(overNear(100 + 20, 50, 2), t).toBe(true); // the ring at radius 20 doc px
      engine.pointers.length = 0;
      await dragDoc([60, 40], [30, 0]);
      expect(engine.pointers.map((p) => p.kind), t).toEqual(['down', 'move', 'move', 'move', 'move', 'up']);
    }
  });
});

describe('Clone source', () => {
  beforeEach(async () => { store.setTool('clone'); await settle(); });

  it('Alt-click sets the source: forwarded with alt, a crosshair is drawn there', async () => {
    expect(overNear(50, 30)).toBe(false);
    send('pointerdown', toClient(50, 30), { buttons: 1, altKey: true });
    send('pointerup', toClient(50, 30), { altKey: true });
    await settle();
    expect(engine.pointers[0]).toMatchObject({ kind: 'down' });
    expect(engine.pointers[0].p.alt).toBe(true);
    expect(overNear(50, 30, 3)).toBe(true);
  });

  it('while aligned, the marker follows the cursor with the offset set by the first stroke', async () => {
    send('pointerdown', toClient(50, 30), { buttons: 1, altKey: true });
    send('pointerup', toClient(50, 30), { altKey: true });
    await dragDoc([100, 60], [10, 0]); // first stroke starts 50 right / 30 below the source
    send('pointermove', toClient(150, 80));
    await settle();
    expect(overNear(100, 50, 3)).toBe(true); // 150-50, 80-30
    expect(overNear(50, 30, 3)).toBe(false);
  });

  it('non-aligned strokes restart at the source each time', async () => {
    store.setCloneOpts({ aligned: false });
    send('pointerdown', toClient(50, 30), { buttons: 1, altKey: true });
    send('pointerup', toClient(50, 30), { altKey: true });
    await dragDoc([100, 60], [10, 0]);
    send('pointermove', toClient(150, 80));
    await settle();
    expect(overNear(50, 30, 3)).toBe(true); // back at the source after the stroke
    expect(overNear(100, 50, 3)).toBe(false);
  });
});

describe('Crop tool', () => {
  beforeEach(async () => { store.setTool('crop'); await settle(); });

  it('dragging on the canvas makes a crop box with the dimmed outside, thirds and handles', async () => {
    expect(store.cropBox.value).toBeNull();
    await dragDoc([20, 10], [100, 60]);
    const b = store.cropBox.value!;
    expect([b.x, b.y, b.w, b.h].map((n) => Math.round(n * 10) / 10)).toEqual([20, 10, 100, 60]);
    expect(overAlpha(150, 50)).toBeGreaterThan(100); // outside the box: dimmed
    expect(overAlpha(62, 44)).toBeLessThan(50); // inside
    expect(overNear(120, 70, 3)).toBe(true); // a handle at the corner
    expect(vp().style.cursor).toBe('crosshair');
  });

  it('clamps to the canvas', async () => {
    await dragDoc([150, 60], [400, 300]);
    const c = store.cropBox.value!;
    expect([c.x, c.y, c.w, c.h].map(Math.round)).toEqual([150, 60, 50, 40]);
    await dragDoc([180, 40], [-400, -300]);
    const b = store.cropBox.value!;
    expect(b.x).toBe(0); expect(b.y).toBe(0);
  });

  it('handles resize and the body moves the box (kept inside the canvas)', async () => {
    await dragDoc([20, 10], [100, 60]);
    await dragDoc([120, 70], [30, 10]); // se handle
    expect(store.cropBox.value).toMatchObject({ x: expect.closeTo(20, 0), y: expect.closeTo(10, 0), w: expect.closeTo(130, 0), h: expect.closeTo(70, 0) });
    await dragDoc([80, 40], [10, 5]);
    expect(store.cropBox.value).toMatchObject({ x: expect.closeTo(30, 0), y: expect.closeTo(15, 0) });
    await dragDoc([80, 40], [500, 0]);
    const b = store.cropBox.value!;
    expect(b.x + b.w).toBeCloseTo(200, 3);
  });

  it('Enter applies: engine.cropTo with the integer rect, the box is dropped and the view refits', async () => {
    await dragDoc([20.4, 10.4], [100, 60]);
    key('Enter');
    await settle();
    expect(engine.cropped).toEqual([{ x: 20, y: 10, w: 100, h: 60 }]);
    expect(store.cropBox.value).toBeNull();
    expect(store.docSize.value).toEqual({ w: 100, h: 60 });
    const v = store.view.value;
    expect(v.zoom).toBeGreaterThan(1.5); // refitted to the smaller canvas (900 wide frame)
  });

  it('Esc cancels, a plain click drops the box, switching tools drops it', async () => {
    await dragDoc([20, 10], [100, 60]);
    key('Escape');
    expect(store.cropBox.value).toBeNull();
    expect(engine.cropped).toEqual([]);
    await dragDoc([20, 10], [50, 30]);
    expect(store.cropBox.value).not.toBeNull();
    await dragDoc([180, 90], [0, 0]); // outside, no drag
    expect(store.cropBox.value).toBeNull();
    await dragDoc([20, 10], [50, 30]);
    store.setTool('brush');
    await settle();
    expect(store.cropBox.value).toBeNull();
  });

  it('the context bar shows X / Y / W / H and edits the box; Crop and Cancel buttons', async () => {
    expect(q<HTMLInputElement>('#crw').disabled).toBe(true);
    await dragDoc([20, 10], [100, 60]);
    expect(q<HTMLInputElement>('#crw').value).toBe('100');
    expect(q<HTMLInputElement>('#crx').value).toBe('20');
    await field('crw', 150);
    await field('crh', 400); // clamped to the canvas
    await field('crx', 10);
    const e = store.cropBox.value!;
    expect([e.x, e.y, e.w, e.h].map(Math.round)).toEqual([10, 10, 150, 90]);
    await field('crx', 90); // pushes w down to stay inside
    expect(store.cropBox.value!.x + store.cropBox.value!.w).toBeLessThanOrEqual(200);
    await click('[data-act=crop-apply]');
    expect(engine.cropped.length).toBe(1);
    expect(engine.cropped[0].x).toBe(90);
    await dragDoc([10, 10], [30, 30]);
    await click('[data-act=crop-cancel]');
    expect(store.cropBox.value).toBeNull();
  });
});

describe('ContextBar layout of the v5 tools', () => {
  afterEach(async () => { await page.viewport(414, 896); });

  const tools = ['crop', 'clone', 'smudge', 'blur', 'dodge', 'move'] as const;
  for (const [w, h] of [[1600, 960], [1280, 800], [1024, 700]] as const) {
    it(`does not clip or overflow at ${w}x${h}`, async () => {
      await page.viewport(w, h);
      await settle();
      expect(window.innerWidth).toBe(w);
      await mount(<App />);
      await settle();
      const px = engine.importImage(new Uint8Array(40 * 30 * 4), 40, 30, 'Px');
      engine.setActiveLayer(px);
      for (const t of tools) {
        store.setTool(t);
        if (t === 'crop') store.cropBox.value = { x: 1, y: 1, w: 50, h: 50 };
        await settle();
        const bar = q('[data-context-bar]');
        const r = bar.getBoundingClientRect();
        expect(bar.scrollWidth, `${t} scrollWidth`).toBeLessThanOrEqual(Math.ceil(r.width) + 1);
        expect(r.right, `${t} within window`).toBeLessThanOrEqual(w + 1);
        for (const c of bar.querySelectorAll<HTMLElement>('.ctx > div > *, .ctx > * ')) {
          const cr = c.getBoundingClientRect();
          if (!cr.width || getComputedStyle(c).display === 'none') continue;
          expect(cr.right, `${t} ${c.className || c.tagName} right edge`).toBeLessThanOrEqual(r.right + 1);
        }
      }
    });
  }
});
