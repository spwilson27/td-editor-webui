import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayerTransform } from '../../src/engine/types';
import { boxCorners, centreOfBox } from '../../src/state/affine';
import { store } from '../../src/state/store';
import { ContextBar } from '../../src/ui/ContextBar';
import { ViewportFrame } from '../../src/ui/Rulers';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let px: string; // a 100 x 50 pixel layer
const ID: LayerTransform = { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 };

beforeEach(async () => {
  engine = freshEngine(200, 100);
  store.setSnapOn(false);
  store.aspectLock.value = true;
  store.spaceHeld.value = false;
  px = engine.importImage(new Uint8Array(100 * 50 * 4), 100, 50, 'Px');
  engine.setTransform(px, { ...ID, x: 20, y: 10 });
  engine.calls.length = 0;
  store.setTool('move');
  await mount(<><ContextBar /><ViewportFrame /></>, 'display:flex;flex-direction:column;width:900px;height:520px');
  await settle();
});
afterEach(() => { unmount(); store.connection.value = 'reconnecting'; store.setSnapOn(true); });

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
const transforms = () => engine.calls.filter((c) => c.startsWith(`setTransform:${px}:`)).map((c) => JSON.parse(c.slice(`setTransform:${px}:`.length)) as LayerTransform);
const lastT = () => transforms().slice(-1)[0]!;
const overPixel = (x: number, y: number) => {
  const c = over(), r = vp().getBoundingClientRect(), k = c.width / r.width, [cx, cy] = toClient(x, y);
  return Array.from(c.getContext('2d')!.getImageData(Math.round((cx - r.left) * k), Math.round((cy - r.top) * k), 1, 1).data);
};
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
const near = (a: number, b: number, d = 2) => expect(a).toBeCloseTo(b, d);
const centre = () => { const l = engine.layers().find((x) => x.id === px)!; return centreOfBox(l.transform, 100, 50); };

describe('Free transform: rotate', () => {
  it('dragging just outside a corner handle rotates about the centre (one setTransform per pointermove)', async () => {
    // se corner is at (120, 60); the pointer starts 2 doc px (~6 screen px) beyond it, centre (70, 35)
    await dragDoc([122, 62], [43, 87]); // quarter turn clockwise on screen
    expect(transforms().length).toBe(4);
    const t = lastT();
    near(t.rot, 90, 1);
    expect([t.sx, t.sy, t.kx, t.ky]).toEqual([1, 1, 0, 0]);
    near(t.x, 95, 1); near(t.y, -15, 1); // the centre stays at (70, 35)
    const c = centre();
    near(c.x, 70, 1); near(c.y, 35, 1);
  });

  it('Shift snaps to 15 degree steps', async () => {
    const a = 20 * Math.PI / 180;
    await dragDoc([122, 62], [70 + 55 * Math.cos(a) - 0, 35 + 55 * Math.sin(a)], { shiftKey: true });
    // the start angle of (122,62) about (70,35) is not 0, so snapping applies to the absolute result
    expect(lastT().rot % 15).toBeCloseTo(0, 6);
  });

  it('the cursor over the rotate zone is the rotate cursor; over the body it is move', async () => {
    send('pointermove', toClient(122, 62));
    expect(vp().style.cursor).toContain('url(');
    expect(vp().style.cursor).toContain('svg');
    send('pointermove', toClient(70, 30));
    expect(vp().style.cursor).toBe('move');
    send('pointermove', toClient(120, 35));
    expect(vp().style.cursor).toBe('ew-resize');
  });

  it('a text layer keeps the plain axis-aligned box: outside a corner does nothing', async () => {
    const s = engine.addShapeLayer({ type: 'rect', x: 100, y: 40, w: 60, h: 40, radius: 0, fill: { enabled: true, color: { r: 0, g: 0, b: 0, a: 255 } }, stroke: { enabled: false, color: { r: 0, g: 0, b: 0, a: 255 }, width: 1 }, rotation: 0 });
    engine.setActiveLayer(s);
    await settle();
    engine.calls.length = 0;
    await dragDoc([162, 82], [200, 95]);
    expect(engine.calls.filter((c) => c.startsWith('setShape') || c.startsWith('setTransform') || c.startsWith('setLayerBox'))).toEqual([]);
  });
});

describe('Free transform: skew', () => {
  it('Ctrl-drag of the south edge handle shears x (kx), about the centre', async () => {
    await dragDoc([70, 60], [95, 60], { ctrlKey: true }); // half height is 25 -> tan kx = 1
    const t = lastT();
    near(t.kx, 45, 1); expect(t.ky).toBe(0); expect(t.rot).toBe(0);
    const c = centre();
    near(c.x, 70, 1); near(c.y, 35, 1);
  });

  it('Ctrl-drag of the east edge handle shears y (ky); the Meta key works too', async () => {
    await dragDoc([120, 35], [120, 85], { metaKey: true });
    near(lastT().ky, 45, 1);
    expect(lastT().kx).toBe(0);
  });

  it('without Ctrl an edge handle scales', async () => {
    await dragDoc([70, 60], [70, 85]);
    const t = lastT();
    expect(t.kx).toBe(0);
    near(t.sy, 1.5, 2);
  });

  it('Ctrl over an edge handle shows an along-the-edge cursor', async () => {
    send('pointermove', toClient(70, 60), { ctrlKey: true });
    expect(vp().style.cursor).toBe('ew-resize');
    send('pointermove', toClient(120, 35), { ctrlKey: true });
    expect(vp().style.cursor).toBe('ns-resize');
  });
});

describe('Free transform: scale and move on a rotated box', () => {
  beforeEach(async () => {
    engine.setTransform(px, { ...ID, x: 100, y: 0, rot: 90 }); // occupies x 50..100, y 0..100
    engine.calls.length = 0;
    await settle();
  });

  it('the east handle sits on the rotated box and scales along the layer x axis (down on screen)', async () => {
    // surface (100, 25) -> doc (75, 100)
    await dragDoc([75, 100], [75, 80]);
    const t = lastT();
    near(t.sx, 0.8, 2); near(t.sy, 1, 6); near(t.rot, 90, 6);
    near(t.x, 100, 3); near(t.y, 0, 3); // the origin edge does not move
  });

  it('the AABB corner region is not a handle, the rotated corner is', async () => {
    await dragDoc([100, 0], [100, 0]); // exactly the surface origin: nw handle (no change)
    expect(vp().style.cursor).not.toBe('move');
    engine.calls.length = 0;
    await dragDoc([75, 50], [95, 60]); // body
    expect(lastT()).toMatchObject({ rot: 90, sx: 1, sy: 1 });
    near(lastT().x, 120, 2); near(lastT().y, 10, 2);
  });

  it('draws the rotated parallelogram, not the AABB of the unrotated layer', async () => {
    expect(overNear(75, 50, 2)).toBe(true); // centre cross at (75, 50)
    expect(overNear(150, 25, 3)).toBe(false); // where the unrotated box would have been
    const corners = boxCorners(engine.layers().find((l) => l.id === px)!.transform, 100, 50);
    for (const c of corners) expect(overPixel(c.x, c.y).slice(0, 3)).toEqual([255, 255, 255]); // white handle squares on the real corners
    expect(overPixel(75, 100)[3]).toBeGreaterThan(0); // an edge handle at (75, 100)
  });
});

describe('Move tool context bar: rotation and skew', () => {
  it('has Rotate / Skew X / Skew Y fields showing the layer values', async () => {
    engine.setTransform(px, { ...ID, x: 20, y: 10, rot: 30, kx: 10, ky: -5 });
    await settle();
    expect(q<HTMLInputElement>('#mr').value).toBe('30');
    expect(q<HTMLInputElement>('#mkx').value).toBe('10');
    expect(q<HTMLInputElement>('#mky').value).toBe('-5');
  });

  it('editing rotation keeps the visual centre; skew too; values are clamped', async () => {
    const c0 = centre();
    await field('mr', 45);
    near(lastT().rot, 45, 6);
    near(centre().x, c0.x, 4); near(centre().y, c0.y, 4);
    await field('mkx', 20);
    near(lastT().kx, 20, 6); near(lastT().rot, 45, 6);
    near(centre().x, c0.x, 4);
    await field('mky', 200);
    near(lastT().ky, 85, 6);
    await field('mr', 270);
    near(lastT().rot, -90, 6);
  });

  it('X / Y use the visual bounds of a rotated box; W / H are the scaled surface size', async () => {
    engine.setTransform(px, { ...ID, x: 100, y: 0, rot: 90 });
    await settle();
    expect(q<HTMLInputElement>('#mx').value).toBe('50');
    expect(q<HTMLInputElement>('#my').value).toBe('0');
    expect(q<HTMLInputElement>('#mw').value).toBe('100');
    expect(q<HTMLInputElement>('#mh').value).toBe('50');
    await field('mx', 70);
    near(lastT().x, 120, 3); near(lastT().y, 0, 3);
  });

  it('Reset Transform clears rotation and skew; the Apply button follows the identity state', async () => {
    engine.setTransform(px, { ...ID, x: 20, y: 10, rot: 30, kx: 10 });
    await settle();
    q('[data-act=reset-transform]').click();
    await settle();
    expect(lastT()).toEqual(ID);
    expect(q('[data-act=apply-transform]').getAttribute('aria-disabled')).toBe('true');
  });

  it('input layers can be transformed too, although locked', async () => {
    engine.setActiveLayer('base');
    await settle();
    const base = () => engine.calls.filter((c) => c.startsWith('setTransform:base:'));
    await field('mr', 10);
    expect(base().length).toBe(1);
    expect(JSON.parse(base()[0].slice('setTransform:base:'.length)).rot).toBeCloseTo(10, 6);
  });
});

describe('contextmenu during a Ctrl-drag skew (macOS Ctrl+click)', () => {
  const ctx = () => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); vp().dispatchEvent(e); return e.defaultPrevented; };

  it('is suppressed while Ctrl is down on an edge handle, and only then', async () => {
    expect(ctx()).toBe(false); // normal context menu elsewhere
    send('pointerdown', toClient(70, 60), { buttons: 1, ctrlKey: true }); // south edge handle
    expect(ctx()).toBe(true);
    send('pointermove', toClient(80, 60), { buttons: 1, ctrlKey: true });
    expect(ctx()).toBe(true);
    send('pointerup', toClient(80, 60), { ctrlKey: true });
    await settle();
    expect(ctx()).toBe(false);
  });

  it('is not suppressed during a plain move, scale or rotate drag', async () => {
    send('pointerdown', toClient(70, 30), { buttons: 1 });
    expect(ctx()).toBe(false);
    send('pointerup', toClient(70, 30));
    send('pointerdown', toClient(120, 60), { buttons: 1, ctrlKey: true }); // corner + Ctrl scales
    expect(ctx()).toBe(false);
    send('pointerup', toClient(120, 60));
  });
});
