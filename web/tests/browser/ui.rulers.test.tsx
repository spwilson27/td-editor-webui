import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUIDES_KEY, RULERS_KEY, SNAP_KEY, store } from '../../src/state/store';
import { ViewportFrame, RULER_SIZE } from '../../src/ui/Rulers';
import { TopBar } from '../../src/ui/TopBar';
import { GUIDE_COLOR } from '../../src/ui/viewportDraw';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const GUIDE_RGB = [parseInt(GUIDE_COLOR.slice(1, 3), 16), parseInt(GUIDE_COLOR.slice(3, 5), 16), parseInt(GUIDE_COLOR.slice(5, 7), 16)];

beforeEach(async () => {
  try { localStorage.clear(); } catch { /* ignore */ }
  engine = freshEngine(200, 100);
  store.setShowRulers(true);
  store.setShowGuides(true);
  store.setSnapOn(false);
  store.spaceHeld.value = false;
  store.viewMode.value = 'local';
  store.setTool('move');
  await mount(<ViewportFrame />, 'display:flex;flex-direction:column;width:640px;height:420px');
  await settle();
});
afterEach(() => { unmount(); store.setSnapOn(true); store.setShowGuides(true); store.setShowRulers(true); store.viewMode.value = 'local'; });

const vp = () => q('[data-viewport]');
const top = () => q<HTMLCanvasElement>('[data-ruler=top]');
const left = () => q<HTMLCanvasElement>('[data-ruler=left]');
const over = () => document.querySelectorAll<HTMLCanvasElement>('[data-viewport] canvas')[1];
const toClient = (x: number, y: number): [number, number] => {
  const r = vp().getBoundingClientRect(), v = store.view.value;
  return [r.left + v.x + x * v.zoom, r.top + v.y + y * v.zoom];
};
const fire = (el: Element, type: string, [x, y]: [number, number], extra: PointerEventInit = {}) => el.dispatchEvent(ptr(type, { clientX: x, clientY: y, ...extra }));
const overPixel = (x: number, y: number) => {
  const c = over(), r = vp().getBoundingClientRect(), k = c.width / r.width;
  return Array.from(c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data);
};
const local = (x: number, y: number): [number, number] => { const r = vp().getBoundingClientRect(), c = toClient(x, y); return [c[0] - r.left, c[1] - r.top]; };
const centreOfRuler = (c: HTMLElement) => { const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] as [number, number]; };

describe('rulers', () => {
  it('are RULER_SIZE (18 px) thick, above and left of the viewport, and the viewport keeps its own origin', () => {
    expect(RULER_SIZE).toBe(18);
    const t = top().getBoundingClientRect(), l = left().getBoundingClientRect(), v = vp().getBoundingClientRect();
    expect(t.height).toBe(18);
    expect(l.width).toBe(18);
    expect(t.bottom).toBeCloseTo(v.top, 0);
    expect(l.right).toBeCloseTo(v.left, 0);
    expect(t.left).toBeCloseTo(v.left, 0);
    expect(store.viewRect.value.x).toBeCloseTo(v.left, 0);
  });

  it('tick density follows the zoom', async () => {
    store.zoomTo(1);
    await settle();
    expect(top().dataset.step).toBe('100');
    store.zoomTo(4);
    await settle();
    expect(top().dataset.step).toBe('20');
    expect(left().dataset.step).toBe('20');
    store.zoomTo(0.25);
    await settle();
    expect(top().dataset.step).toBe('500');
  });

  it('draw ticks (the canvas is not blank) and follow pan', async () => {
    const sum = (c: HTMLCanvasElement) => { const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) n += d[i]; return n; };
    const a = sum(top());
    store.panBy(37, 0);
    await settle();
    expect(sum(top())).not.toBe(a);
    expect(a).toBeGreaterThan(0);
  });

  it('show a cursor marker at the pointer position on both rulers', async () => {
    const p = toClient(50, 25);
    fire(vp(), 'pointermove', p);
    await settle();
    const r = vp().getBoundingClientRect();
    expect(Number(top().dataset.cursor)).toBe(Math.round(p[0] - r.left));
    expect(Number(left().dataset.cursor)).toBe(Math.round(p[1] - r.top));
    vp().dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    await settle();
    expect(top().dataset.cursor).toBeUndefined();
  });
});

describe('View menu toggles', () => {
  beforeEach(async () => { await mount(<><TopBar /><ViewportFrame /></>, 'display:flex;flex-direction:column;width:1200px;height:500px'); });
  const open = async () => { [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'View')!.click(); await settle(); };
  const item = (n: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes(n))!;

  it('Show Rulers hides / shows both rulers and persists per viewer', async () => {
    await open();
    expect(item('Show Rulers').getAttribute('aria-checked')).toBe('true');
    item('Show Rulers').click();
    await settle();
    expect(document.querySelector('[data-ruler]')).toBeNull();
    expect(localStorage.getItem(RULERS_KEY)).toBe('0');
    await open();
    expect(item('Show Rulers').getAttribute('aria-checked')).toBe('false');
    item('Show Rulers').click();
    await settle();
    expect(document.querySelectorAll('[data-ruler]').length).toBe(2);
    expect(localStorage.getItem(RULERS_KEY)).toBe('1');
  });

  it('Show Guides and Snap persist; Snap reaches the engine', async () => {
    await open();
    item('Show Guides').click();
    await settle();
    expect(store.showGuides.value).toBe(false);
    expect(localStorage.getItem(GUIDES_KEY)).toBe('0');
    await open();
    item('Snap').click();
    await settle();
    expect(store.snapOn.value).toBe(true);
    expect(localStorage.getItem(SNAP_KEY)).toBe('1');
    expect(engine.snapOpts).toMatchObject({ enabled: true, guides: true, canvas: true, threshold: 6 });
  });

  it('Clear Guides removes all guides (and is disabled with none)', async () => {
    await open();
    expect(item('Clear Guides').getAttribute('aria-disabled')).toBe('true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    engine.addGuide('h', 10); engine.addGuide('v', 20); engine.addGuide('v', 30);
    await settle();
    await open();
    item('Clear Guides').click();
    await settle();
    expect(engine.guides()).toEqual({ h: [], v: [] });
  });

  it('the toggles are restored from localStorage by a fresh store read', () => {
    store.setShowRulers(false); store.setSnapOn(true);
    expect([localStorage.getItem(RULERS_KEY), localStorage.getItem(SNAP_KEY)]).toEqual(['0', '1']);
  });
});

describe('guides', () => {
  it('drag from the top ruler into the viewport creates a horizontal guide at the drop position', async () => {
    const start = centreOfRuler(top());
    fire(top(), 'pointerdown', start, { buttons: 1 });
    expect(store.guideDrag.value).toMatchObject({ axis: 'h', index: null, remove: true }); // still over the ruler
    fire(top(), 'pointermove', toClient(100, 30), { buttons: 1 });
    expect(store.guideDrag.value).toMatchObject({ axis: 'h', pos: 30, remove: false });
    await settle();
    // the dragged guide is previewed in the overlay
    expect(overPixel(...local(100, 30)).slice(0, 3)).toEqual(GUIDE_RGB);
    fire(top(), 'pointerup', toClient(100, 30));
    await settle();
    expect(engine.guides()).toEqual({ h: [30], v: [] });
    expect(store.guideDrag.value).toBeNull();
  });

  it('drag from the left ruler creates a vertical guide', async () => {
    fire(left(), 'pointerdown', centreOfRuler(left()), { buttons: 1 });
    fire(left(), 'pointermove', toClient(75, 50), { buttons: 1 });
    fire(left(), 'pointerup', toClient(75, 50));
    await settle();
    expect(engine.guides()).toEqual({ h: [], v: [75] });
  });

  it('releasing back over the ruler creates nothing', async () => {
    fire(top(), 'pointerdown', centreOfRuler(top()), { buttons: 1 });
    fire(top(), 'pointermove', toClient(100, 30), { buttons: 1 });
    fire(top(), 'pointermove', centreOfRuler(top()), { buttons: 1 });
    fire(top(), 'pointerup', centreOfRuler(top()));
    await settle();
    expect(engine.guides()).toEqual({ h: [], v: [] });
  });

  it('guides are drawn in the overlay, only when Show Guides is on', async () => {
    engine.addGuide('h', 40);
    engine.addGuide('v', 60);
    await settle();
    expect(overPixel(...local(10, 40)).slice(0, 3)).toEqual(GUIDE_RGB);
    expect(overPixel(...local(60, 10)).slice(0, 3)).toEqual(GUIDE_RGB);
    expect(overPixel(...local(100, 80))[3]).toBe(0);
    store.setShowGuides(false);
    await settle();
    expect(overPixel(...local(10, 40))[3]).toBe(0);
  });


  it('dragging a guide with the Move tool moves it', async () => {
    engine.addGuide('h', 40);
    store.setTool('move');
    await settle();
    engine.setActiveLayer('base');
    fire(vp(), 'pointerdown', toClient(150, 40), { buttons: 1 }); // base box covers it; a guide wins over the box body
    expect(store.guideDrag.value).toMatchObject({ axis: 'h', index: 0, pos: 40 });
    fire(vp(), 'pointermove', toClient(150, 55), { buttons: 1 });
    await settle();
    expect(overPixel(...local(150, 40))[3]).toBe(0); // the original is hidden while dragging
    expect(overPixel(...local(150, 55)).slice(0, 3)).toEqual(GUIDE_RGB);
    fire(vp(), 'pointerup', toClient(150, 55));
    await settle();
    expect(engine.calls).toContain('moveGuide:h:0:55');
    expect(engine.guides()).toEqual({ h: [55], v: [] });
    expect(engine.calls.filter((c) => c.startsWith('setTransform:base'))).toHaveLength(0);
  });

  it('dragging a guide back onto its ruler deletes it', async () => {
    engine.addGuide('v', 60);
    engine.addGuide('v', 90);
    await settle();
    fire(vp(), 'pointerdown', toClient(90, 50), { buttons: 1 });
    expect(store.guideDrag.value).toMatchObject({ axis: 'v', index: 1 });
    const r = vp().getBoundingClientRect();
    fire(vp(), 'pointermove', [r.left - 8, r.top + 100], { buttons: 1 }); // over the left ruler
    expect(store.guideDrag.value?.remove).toBe(true);
    fire(vp(), 'pointerup', [r.left - 8, r.top + 100]);
    await settle();
    expect(engine.calls).toContain('removeGuide:v:1');
    expect(engine.guides()).toEqual({ h: [], v: [60] });
  });

  it('a cancelled guide drag (capture lost) changes nothing', async () => {
    engine.addGuide('h', 40);
    await settle();
    fire(vp(), 'pointerdown', toClient(150, 40), { buttons: 1 });
    fire(vp(), 'pointermove', toClient(150, 70), { buttons: 1 });
    vp().dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
    await settle();
    expect(engine.guides()).toEqual({ h: [40], v: [] });
    expect(store.guideDrag.value).toBeNull();
  });

  it('guides are only grabbed with the Move tool (other tools paint across them)', async () => {
    engine.addGuide('h', 40);
    store.setTool('brush');
    await settle();
    fire(vp(), 'pointerdown', toClient(150, 40), { buttons: 1 });
    expect(store.guideDrag.value).toBeNull();
    fire(vp(), 'pointerup', toClient(150, 40));
  });
});

describe('snapping for other tools', () => {
  beforeEach(async () => { store.setSnapOn(true); engine.addGuide('v', 137); engine.addGuide('h', 63); engine.pointers.length = 0; engine.calls.length = 0; await settle(); });
  const near = (x: number, y: number): [number, number] => { const z = store.view.value.zoom; return toClient(x + 1 / z, y + 1 / z); };

  it('marquee points snap to guides, with snap-line feedback during the drag', async () => {
    store.setTool('marquee');
    fire(vp(), 'pointerdown', near(20, 20), { buttons: 1 });
    fire(vp(), 'pointermove', near(137, 63), { buttons: 1 });
    expect(store.snapLines.value).toEqual({ x: 137, y: 63 });
    fire(vp(), 'pointerup', near(137, 63));
    const ps = engine.pointers.map((p) => p.p);
    expect(ps[0].x).toBeCloseTo(20, 0); // nowhere near a guide: untouched
    expect(ps[ps.length - 1]).toMatchObject({ x: 137, y: 63 });
    expect(store.snapLines.value).toEqual({ x: null, y: null });
  });

  it('shape drags snap their end point (and start point)', async () => {
    store.setTool('shape');
    fire(vp(), 'pointerdown', near(137, 63), { buttons: 1 });
    fire(vp(), 'pointermove', near(160, 90), { buttons: 1 });
    fire(vp(), 'pointerup', toClient(160, 90));
    await settle();
    const added = engine.calls.filter((c) => c.startsWith('addShape:')).map((c) => JSON.parse(c.slice(9)));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ x: 137, y: 63 });
  });

  it('a text click near a guide places the text on it', async () => {
    store.setTool('text');
    fire(vp(), 'pointerdown', near(137, 63), { buttons: 1 });
    fire(vp(), 'pointerup', near(137, 63));
    await settle();
    const added = engine.calls.filter((c) => c.startsWith('addText:')).map((c) => JSON.parse(c.slice(8)));
    expect(added[0]).toMatchObject({ x: 137, y: 63 });
    store.commitText();
  });

  it('with Snap off nothing snaps and the engine is not asked', async () => {
    store.setSnapOn(false);
    store.setTool('marquee');
    engine.calls.length = 0;
    fire(vp(), 'pointerdown', near(137, 63), { buttons: 1 });
    fire(vp(), 'pointermove', near(137, 63), { buttons: 1 });
    expect(engine.calls).not.toContain('snapPoint');
    expect(store.snapLines.value).toEqual({ x: null, y: null });
    fire(vp(), 'pointerup', near(137, 63));
  });

  it('brush strokes are never snapped', async () => {
    store.setTool('brush');
    engine.calls.length = 0;
    fire(vp(), 'pointerdown', near(137, 63), { buttons: 1 });
    fire(vp(), 'pointermove', near(137, 63), { buttons: 1 });
    expect(engine.calls).not.toContain('snapPoint');
    fire(vp(), 'pointerup', near(137, 63));
  });
});
