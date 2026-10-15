import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayerTransform } from '../../src/engine/types';
import { completeShapeSpec, completeTextSpec } from '../../src/state/specs';
import { store } from '../../src/state/store';
import { ContextBar } from '../../src/ui/ContextBar';
import { ViewportFrame } from '../../src/ui/Rulers';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let px: string; // a 100 x 50 pixel layer at (20, 10)

beforeEach(async () => {
  engine = freshEngine(200, 100);
  store.setSnapOn(false);
  store.aspectLock.value = true;
  store.spaceHeld.value = false;
  px = engine.importImage(new Uint8Array(100 * 50 * 4), 100, 50, 'Px');
  engine.setTransform(px, { x: 20, y: 10, sx: 1, sy: 1 });
  engine.calls.length = 0;
  store.setTool('move');
  await mount(<ViewportFrame />, 'display:flex;flex-direction:column;width:640px;height:420px');
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
/** Drags from a document point by a document delta, in a few steps. */
async function dragDoc(from: [number, number], d: [number, number], mods: PointerEventInit = {}) {
  const a = toClient(from[0], from[1]);
  send('pointerdown', a, { buttons: 1, ...mods });
  for (let i = 1; i <= 4; i++) send('pointermove', toClient(from[0] + (d[0] * i) / 4, from[1] + (d[1] * i) / 4), { buttons: 1, ...mods });
  send('pointerup', toClient(from[0] + d[0], from[1] + d[1]), mods);
  await settle();
}
const transforms = () => engine.calls.filter((c) => c.startsWith(`setTransform:${px}:`)).map((c) => JSON.parse(c.slice(`setTransform:${px}:`.length)) as LayerTransform);
const lastT = () => transforms().slice(-1)[0]!;
const overPixel = (x: number, y: number) => {
  const c = over(), k = c.width / vp().getBoundingClientRect().width;
  return Array.from(c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data);
};
const local = (x: number, y: number): [number, number] => { const r = vp().getBoundingClientRect(), c = toClient(x, y); return [c[0] - r.left, c[1] - r.top]; };

describe('Move tool transform box', () => {
  it('draws the box with 8 handles and a centre for the active layer (move tool only)', async () => {
    // bounds of Px: x 20..120, y 10..60
    const corners: [number, number][] = [[20, 10], [70, 10], [120, 10], [20, 35], [120, 35], [20, 60], [70, 60], [120, 60]];
    for (const [x, y] of corners) expect(overPixel(...local(x, y)).slice(0, 3)).toEqual([255, 255, 255]); // white handle fill
    const c = local(70, 35);
    expect(overPixel(c[0] - 4, c[1] + 3)[3]).toBe(0); // inside the box, transparent
    store.setTool('brush');
    await settle();
    expect(overPixel(...local(20, 10))[3]).toBe(0);
  });

  it('works for the TD Input (base) layer too', async () => {
    engine.setActiveLayer('base');
    await settle();
    expect(overPixel(...local(0, 0)).slice(0, 3)).toEqual([255, 255, 255]);
    await dragDoc([100, 50], [10, 5]);
    const t = engine.calls.filter((c) => c.startsWith('setTransform:base:')).map((c) => JSON.parse(c.slice('setTransform:base:'.length)) as LayerTransform).slice(-1)[0]!;
    expect(t.x).toBeCloseTo(10);
    expect(t.y).toBeCloseTo(5);
  });

  it('dragging inside moves the layer by the pointer delta (absolute from the press, one setTransform per move)', async () => {
    await dragDoc([60, 30], [30, 20]);
    expect(lastT().x).toBeCloseTo(50);
    expect(lastT().y).toBeCloseTo(30);
    expect(lastT()).toMatchObject({ sx: 1, sy: 1 });
    expect(transforms().length).toBeGreaterThanOrEqual(4);
  });

  it('a press outside the box does nothing', async () => {
    await dragDoc([180, 90], [10, 10]);
    expect(transforms()).toHaveLength(0);
  });

  it('a handle scales against the opposite corner', async () => {
    await dragDoc([120, 60], [50, 25]); // se: 100x50 -> 150x75
    expect(lastT().sx).toBeCloseTo(1.5);
    expect(lastT().sy).toBeCloseTo(1.5);
    expect(lastT().x).toBeCloseTo(20);
    expect(lastT().y).toBeCloseTo(10);
  });

  it('an edge handle scales one axis only', async () => {
    await dragDoc([120, 35], [100, 0]); // e: 100 -> 200 wide
    expect(lastT().sx).toBeCloseTo(2);
    expect(lastT().sy).toBeCloseTo(1);
  });

  it('the nw handle moves the origin as it scales', async () => {
    await dragDoc([20, 10], [-20, -10]);
    expect(lastT().x).toBeCloseTo(0);
    expect(lastT().y).toBeCloseTo(0);
    expect(lastT().sx).toBeCloseTo(1.2);
    expect(lastT().sy).toBeCloseTo(1.2);
  });

  it('Shift keeps the aspect ratio of a one-sided drag', async () => {
    await dragDoc([120, 60], [100, 0], { shiftKey: true });
    expect(lastT().sx).toBeCloseTo(lastT().sy);
    expect(lastT().sx).toBeCloseTo(2);
  });

  it('Alt scales from the centre', async () => {
    await dragDoc([120, 60], [20, 10], { altKey: true }); // 100x50 -> 140x70 about (70, 35)
    expect(lastT().sx).toBeCloseTo(1.4);
    expect(lastT().sy).toBeCloseTo(1.4);
    expect(lastT().x).toBeCloseTo(0);
    expect(lastT().y).toBeCloseTo(0);
  });

  it('Shift + Alt: uniform about the centre', async () => {
    await dragDoc([120, 35], [30, 0], { shiftKey: true, altKey: true });
    expect(lastT().sx).toBeCloseTo(1.6);
    expect(lastT().sy).toBeCloseTo(1.6);
    expect(lastT().x + 50 * lastT().sx).toBeCloseTo(70); // centre fixed
    expect(lastT().y + 25 * lastT().sy).toBeCloseTo(35);
  });

  it('a locked non-base layer cannot be moved (notice) and shows no box', async () => {
    engine.setLayerProps(px, { locked: true });
    await settle();
    await dragDoc([60, 30], [10, 10]);
    expect(transforms()).toHaveLength(0);
    expect(store.notice.value).toBe('Layer is locked');
    expect(overPixel(...local(20, 10))[3]).toBe(0);
  });

  it('groups and adjustment layers have no box', async () => {
    engine.addGroup('G');
    await settle();
    expect(overPixel(...local(20, 10))[3]).toBe(0);
    await dragDoc([60, 30], [10, 10]);
    expect(transforms()).toHaveLength(0);
  });

  it('text layers: moving edits the text position, a corner scales font size and box', async () => {
    const t = engine.addTextLayer(completeTextSpec({ text: 'Hello', size: 20, x: 10, y: 10 }));
    engine.calls.length = 0;
    await settle();
    const b = engine.layerBounds(t)!;
    await dragDoc([b.x + b.w / 2, b.y + b.h / 2], [15, 5]);
    let c = engine.calls.filter((x) => x.startsWith(`setText:${t}:`)).map((x) => JSON.parse(x.slice(`setText:${t}:`.length)));
    expect(c.slice(-1)[0].x).toBeCloseTo(25);
    expect(Number.isInteger(c.slice(-1)[0].x) && Number.isInteger(c.slice(-1)[0].y)).toBe(true); // whole-pixel positions
    expect(c.slice(-1)[0].y).toBeCloseTo(15);
    expect(c.slice(-1)[0].size).toBe(20);
    const b2 = engine.layerBounds(t)!;
    engine.calls.length = 0;
    await dragDoc([b2.x + b2.w, b2.y + b2.h], [b2.w, b2.h]); // se corner: double
    c = engine.calls.filter((x) => x.startsWith(`setText:${t}:`)).map((x) => JSON.parse(x.slice(`setText:${t}:`.length)));
    expect(c.slice(-1)[0].size).toBeCloseTo(40, 0);
    expect(c.slice(-1)[0].x).toBeCloseTo(25);
  });

  it('shape layers: moving and scaling edit the shape geometry', async () => {
    const s = engine.addShapeLayer(completeShapeSpec({ type: 'rect', x: 100, y: 40, w: 60, h: 40 } as never));
    engine.calls.length = 0;
    await settle();
    const get = () => engine.calls.filter((x) => x.startsWith(`setShape:${s}:`)).map((x) => JSON.parse(x.slice(`setShape:${s}:`.length)));
    await dragDoc([130, 60], [10, -10]);
    expect(get().slice(-1)[0].x).toBeCloseTo(110);
    expect(get().slice(-1)[0].y).toBeCloseTo(30);
    expect(get().slice(-1)[0].w).toBeCloseTo(60);
    const b = engine.layerBounds(s)!;
    engine.calls.length = 0;
    await dragDoc([b.x + b.w, b.y + b.h], [60, 40]);
    expect(get().slice(-1)[0].w).toBeCloseTo(120);
    expect(get().slice(-1)[0].h).toBeCloseTo(80);
    expect(get().slice(-1)[0].x).toBeCloseTo(110);
  });

  it('the cursor shows resize arrows over handles and move inside', async () => {
    send('pointermove', toClient(120, 60));
    expect(vp().style.cursor).toBe('nwse-resize');
    send('pointermove', toClient(120, 35));
    expect(vp().style.cursor).toBe('ew-resize');
    send('pointermove', toClient(70, 35));
    expect(vp().style.cursor).toBe('move');
    send('pointermove', toClient(190, 95));
    expect(vp().style.cursor).toBe('default');
  });
});

describe('without engine.setLayerBox (older engines)', () => {
  it('the UI maps the box itself: setTransform for pixel layers, setText / setShape for vector layers', async () => {
    engine.setLayerBox = undefined;
    await dragDoc([60, 30], [30, 20]);
    expect(lastT().x).toBeCloseTo(50);
    expect(engine.calls.some((c) => c.startsWith('setLayerBox'))).toBe(false);
    await dragDoc([150, 90], [0, 0]);
    const s = engine.addShapeLayer(completeShapeSpec({ type: 'rect', x: 100, y: 40, w: 60, h: 40 } as never));
    engine.calls.length = 0;
    await settle();
    await dragDoc([130, 60], [10, -10]);
    expect(engine.calls.some((c) => c.startsWith(`setShape:${s}:`))).toBe(true);
  });

  it('with it, every move / scale goes through setLayerBox with the target box', async () => {
    await dragDoc([120, 60], [50, 25]);
    const boxes = engine.calls.filter((c) => c.startsWith(`setLayerBox:${px}:`)).map((c) => JSON.parse(c.slice(`setLayerBox:${px}:`.length)));
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    const last = boxes.slice(-1)[0];
    expect([last.x, last.y, last.w, last.h].map((n: number) => Math.round(n * 100) / 100)).toEqual([20, 10, 150, 75]);
  });
});

describe('Move tool snapping', () => {
  beforeEach(() => { store.setSnapOn(true); engine.addGuide('v', 137); engine.addGuide('h', 83); engine.calls.length = 0; });

  it('moving snaps the box edge to a guide and shows the snap line; releasing clears it', async () => {
    const z = store.view.value.zoom;
    const a = toClient(60, 30);
    send('pointerdown', a, { buttons: 1 });
    // move so the right edge (120 + d) lands within a few screen px of the guide at x = 137: d = 17 + 2/z
    send('pointermove', toClient(60 + 17 + 2 / z, 30), { buttons: 1 });
    expect(lastT().x).toBeCloseTo(37); // right edge exactly on the guide
    expect(store.snapLines.value.x).toBe(137);
    expect(store.snapLines.value.y).toBeNull();
    await settle();
    const [sx] = local(137, 5);
    expect(overPixel(sx, 150).slice(0, 3)).toEqual([255, 79, 176]); // the pink snap line (guide is cyan underneath is overdrawn)
    send('pointerup', toClient(60 + 17 + 2 / z, 30));
    expect(store.snapLines.value).toEqual({ x: null, y: null });
    expect(engine.calls).toContain('snapRect');
  });

  it('no snapping when Snap is off', async () => {
    store.setSnapOn(false);
    const z = store.view.value.zoom;
    send('pointerdown', toClient(60, 30), { buttons: 1 });
    send('pointermove', toClient(60 + 17 + 2 / z, 30), { buttons: 1 });
    expect(lastT().x).toBeCloseTo(37 + 2 / z);
    expect(store.snapLines.value.x).toBeNull();
    send('pointerup', toClient(60, 30));
  });

  it('scaling snaps the dragged edge (snapPoint) and shows the line', async () => {
    const z = store.view.value.zoom;
    send('pointerdown', toClient(120, 35), { buttons: 1 });
    send('pointermove', toClient(137 + 2 / z, 35), { buttons: 1 }); // east edge near the guide at 137
    expect(lastT().sx).toBeCloseTo(1.17); // width 117 => edge at exactly 137
    expect(store.snapLines.value.x).toBe(137);
    expect(engine.calls).toContain('snapPoint');
    send('pointerup', toClient(137, 35));
  });

  it('Shift (aspect) skips snapping', async () => {
    const z = store.view.value.zoom;
    send('pointerdown', toClient(120, 60), { buttons: 1, shiftKey: true });
    send('pointermove', toClient(137 + 2 / z, 60), { buttons: 1, shiftKey: true });
    expect(store.snapLines.value.x).toBeNull();
    send('pointerup', toClient(137, 60), { shiftKey: true });
  });
});

describe('Move tool context bar', () => {
  beforeEach(async () => { await mount(<ContextBar />, 'width:1500px'); });
  const val = (id: string) => q<HTMLInputElement>('#' + id).value;
  const type = async (id: string, v: string) => {
    const el = q<HTMLInputElement>('#' + id);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };

  it('shows X, Y, W, H and the scale of the active layer', () => {
    expect([val('mx'), val('my'), val('mw'), val('mh'), val('ms')]).toEqual(['20', '10', '100', '50', '100']);
    expect(q('[data-move-options]').textContent).toContain('px');
  });

  it('X / Y move the layer', async () => {
    await type('mx', '40');
    expect(lastT()).toEqual({ x: 40, y: 10, sx: 1, sy: 1 });
    await type('my', '5');
    expect(lastT()).toEqual({ x: 40, y: 5, sx: 1, sy: 1 });
  });

  it('W with the aspect lock scales both axes about the top-left; without it only the width', async () => {
    await type('mw', '200');
    expect(lastT()).toEqual({ x: 20, y: 10, sx: 2, sy: 2 });
    q('[data-aspect-lock]').click();
    await settle();
    expect(q('[data-aspect-lock]').getAttribute('aria-pressed')).toBe('false');
    await type('mw', '300'); // from the current 200x100
    expect(lastT()).toEqual({ x: 20, y: 10, sx: 3, sy: 2 });
    await type('mh', '50');
    expect(lastT().sy).toBeCloseTo(1);
  });

  it('H with the lock scales both; the scale % field sets a uniform scale', async () => {
    await type('mh', '100');
    expect(lastT()).toEqual({ x: 20, y: 10, sx: 2, sy: 2 });
    await type('ms', '50');
    expect(lastT().sx).toBeCloseTo(0.5);
    expect(lastT().sy).toBeCloseTo(0.5);
  });

  it('Apply Transform and Reset Transform buttons follow the layer state', async () => {
    const apply = q('[data-act=apply-transform]'), reset = q('[data-act=reset-transform]');
    expect(apply.getAttribute('aria-disabled')).toBe('false'); // non-identity (moved)
    reset.click();
    await settle();
    expect(lastT()).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
    expect(q('[data-act=apply-transform]').getAttribute('aria-disabled')).toBe('true');
    expect(q('[data-act=reset-transform]').getAttribute('aria-disabled')).toBe('true');
    engine.setTransform(px, { x: 0, y: 0, sx: 2, sy: 2 });
    await settle();
    q('[data-act=apply-transform]').click();
    await settle();
    expect(engine.calls).toContain(`applyTransform:${px}`);
  });

  it('the fields are disabled for layers without bounds (group)', async () => {
    engine.addGroup('G');
    await settle();
    expect(q<HTMLInputElement>('#mw').disabled).toBe(true);
  });

  it('the scale field is disabled for text layers; X/Y/W/H edit the geometry', async () => {
    const t = engine.addTextLayer(completeTextSpec({ text: 'Hi', size: 20, x: 10, y: 10 }));
    await settle();
    expect(q<HTMLInputElement>('#ms').disabled).toBe(true);
    await type('mx', '30');
    const c = engine.calls.filter((x) => x.startsWith(`setText:${t}:`)).map((x) => JSON.parse(x.slice(`setText:${t}:`.length)));
    expect(c.slice(-1)[0]).toMatchObject({ x: 30, y: 10 });
  });

  it('has a working Snap checkbox', async () => {
    const box = q<HTMLInputElement>('#snapc');
    expect(box.checked).toBe(false);
    box.click();
    await settle();
    expect(store.snapOn.value).toBe(true);
    expect(engine.snapOpts.enabled).toBe(true);
  });
});

describe('Layer menu transform items', () => {
  it('Apply Transform / Reset Transform act on the active pixel layer', async () => {
    await mount(<TopBar />, 'width:1200px');
    const open = async () => { [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'Layer')!.click(); await settle(); };
    const item = (n: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes(n))!;
    await open();
    expect(item('Apply Transform').getAttribute('aria-disabled')).toBe('false');
    item('Reset Transform').click();
    await settle();
    expect(lastT()).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
    await open();
    expect(item('Apply Transform').getAttribute('aria-disabled')).toBe('true');
    expect(item('Reset Transform').getAttribute('aria-disabled')).toBe('true');
  });
});
