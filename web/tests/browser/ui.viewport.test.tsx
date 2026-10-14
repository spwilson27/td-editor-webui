import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { Viewport } from '../../src/ui/Viewport';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let el: HTMLElement;

beforeEach(async () => {
  engine = freshEngine(64, 48);
  store.tool.value = 'brush';
  store.spaceHeld.value = false;
  el = await mount(<Viewport />, 'display:flex;flex-direction:column;width:400px;height:300px');
  await settle();
});
afterEach(unmount);

const vp = () => q('[data-viewport]');
const canvases = () => [...document.querySelectorAll('[data-viewport] canvas')] as HTMLCanvasElement[];
const pixel = (c: HTMLCanvasElement, x: number, y: number) => {
  const k = c.width / 400;
  return Array.from(c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data);
};
const toClient = (dx: number, dy: number): [number, number] => {
  const r = vp().getBoundingClientRect(), v = store.view.value;
  return [r.left + v.x + dx * v.zoom, r.top + v.y + dy * v.zoom];
};
const send = (type: string, [x, y]: [number, number], extra: PointerEventInit = {}) =>
  vp().dispatchEvent(ptr(type, { clientX: x, clientY: y, ...extra }));

describe('Viewport drawing', () => {
  it('fits the document on load, centred', () => {
    const v = store.view.value;
    expect(v.zoom).toBeCloseTo(Math.min(336 / 64, 236 / 48), 6);
    expect(v.x + (64 * v.zoom) / 2).toBeCloseTo(200, 3);
    expect(v.y + (48 * v.zoom) / 2).toBeCloseTo(150, 3);
  });

  it('draws the composite inside the document and the dark background outside', () => {
    const [main] = canvases();
    expect(pixel(main, 200, 150)).toEqual([0x33, 0x66, 0x99, 255]);
    expect(pixel(main, 3, 3)).toEqual([0x1c, 0x1c, 0x1c, 255]);
  });

  it('shows a checkerboard under transparent pixels', async () => {
    engine.compositeSource = () => document.createElement('canvas'); // fully transparent
    engine.emit({ type: 'composite', rect: { x: 0, y: 0, w: 64, h: 48 } });
    await settle();
    const [main] = canvases();
    const v = store.view.value;
    const a = pixel(main, v.x + 2, v.y + 2), b = pixel(main, v.x + 10, v.y + 2);
    expect([a[0], b[0]].sort()).toEqual([0xcf, 0xff]);
  });

  it('redraws only on composite events and view changes, at most once per frame', async () => {
    const [main] = canvases();
    const ctx = main.getContext('2d')!;
    let draws = 0;
    const orig = ctx.drawImage.bind(ctx);
    (ctx as unknown as { drawImage: (...a: unknown[]) => void }).drawImage = (...a: unknown[]) => { if (a.length === 9) draws++; (orig as (...x: unknown[]) => void)(...a); };
    await settle();
    expect(draws).toBe(0);
    for (let i = 0; i < 30; i++) engine.emit({ type: 'composite', rect: { x: 0, y: 0, w: 4, h: 4 } });
    await settle();
    expect(draws).toBe(1);
    store.zoomBy(1.5);
    store.panBy(5, 5);
    await settle();
    expect(draws).toBe(2);
    engine.emit({ type: 'structure' });
    await settle();
    expect(draws).toBe(2);
  });

  it('draws marching ants for a selection on the overlay canvas', async () => {
    engine.setSelection({ x: 10, y: 10, w: 20, h: 20 });
    await settle();
    const over = canvases()[1];
    const v = store.view.value;
    const x = Math.round(v.x + 10 * v.zoom), y = Math.round(v.y + 20 * v.zoom);
    const px = pixel(over, x, y);
    expect(px[3]).toBeGreaterThan(0);
    engine.setSelection(null);
    await settle();
    expect(pixel(over, x, y)[3]).toBe(0);
  });

  it('draws a brush outline following the pointer, sized by zoom', async () => {
    store.setBrush({ size: 10 });
    await settle();
    const c = toClient(32, 24);
    send('pointermove', c);
    await settle();
    const over = canvases()[1];
    const r = vp().getBoundingClientRect();
    const radius = 5 * store.view.value.zoom;
    expect(pixel(over, c[0] - r.left + radius, c[1] - r.top)[3]).toBeGreaterThan(0);
    expect(pixel(over, c[0] - r.left, c[1] - r.top)[3]).toBe(0);
    store.setTool('marquee');
    await settle();
    expect(pixel(over, c[0] - r.left + radius, c[1] - r.top)[3]).toBe(0);
  });
});

describe('Viewport pointer handling', () => {
  it('maps pointer events to document coordinates and forwards down/move/up', () => {
    send('pointerdown', toClient(10, 12), { shiftKey: true });
    send('pointermove', toClient(20, 22));
    send('pointermove', toClient(30, 32), { altKey: true, ctrlKey: true });
    send('pointerup', toClient(30, 32));
    const kinds = engine.pointers.map((p) => p.kind);
    expect(kinds).toEqual(['down', 'move', 'move', 'up']);
    expect(engine.pointers[0].p).toMatchObject({ shift: true, alt: false, ctrl: false, pressure: 1 });
    expect(engine.pointers[0].p.x).toBeCloseTo(10, 6);
    expect(engine.pointers[0].p.y).toBeCloseTo(12, 6);
    expect(engine.pointers[2].p).toMatchObject({ alt: true, ctrl: true });
    expect(engine.pointers[3].p.x).toBeCloseTo(30, 6);
  });

  it('does not send moves without a pressed pointer, ignores right button', () => {
    send('pointermove', toClient(5, 5));
    send('pointerdown', toClient(5, 5), { button: 2 });
    expect(engine.pointers.length).toBe(0);
  });

  it('space-drag pans without touching the document', async () => {
    store.spaceHeld.value = true;
    store.spaceSeenAt = performance.now();
    const before = { ...store.view.value };
    send('pointerdown', [100, 100]);
    send('pointermove', [130, 120]);
    send('pointerup', [130, 120]);
    expect(store.view.value.x).toBeCloseTo(before.x + 30, 6);
    expect(store.view.value.y).toBeCloseTo(before.y + 20, 6);
    expect(engine.pointers.length).toBe(0);
    await settle();
    expect(vp().style.cursor).toBe('grab');
  });

  it('hand tool and middle button pan', () => {
    store.setTool('hand');
    const before = store.view.value.x;
    send('pointerdown', [100, 100]);
    send('pointermove', [90, 100]);
    send('pointerup', [90, 100]);
    expect(store.view.value.x).toBeCloseTo(before - 10, 6);
    store.setTool('brush');
    send('pointerdown', [100, 100], { button: 1 });
    send('pointermove', [100, 140]);
    send('pointerup', [100, 140]);
    expect(engine.pointers.length).toBe(0);
  });

  it('zoom tool zooms in on click and out with alt, about the cursor', () => {
    store.setTool('zoom');
    const p: [number, number] = [vp().getBoundingClientRect().left + 120, vp().getBoundingClientRect().top + 90];
    const z0 = store.view.value.zoom;
    const docBefore = store.toDoc(120, 90);
    send('pointerdown', p);
    expect(store.view.value.zoom).toBeCloseTo(z0 * 1.25, 6);
    expect(store.toDoc(120, 90).x).toBeCloseTo(docBefore.x, 6);
    send('pointerdown', p, { altKey: true });
    expect(store.view.value.zoom).toBeCloseTo(z0, 6);
    expect(engine.pointers.length).toBe(0);
  });

  it('wheel zooms about the cursor and prevents page scroll', () => {
    const r = vp().getBoundingClientRect();
    const docBefore = store.toDoc(150, 100);
    const z0 = store.view.value.zoom;
    const e = new WheelEvent('wheel', { deltaY: -100, clientX: r.left + 150, clientY: r.top + 100, bubbles: true, cancelable: true });
    vp().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(store.view.value.zoom).toBeCloseTo(z0 * 1.1, 6);
    expect(store.toDoc(150, 100).x).toBeCloseTo(docBefore.x, 6);
    vp().dispatchEvent(new WheelEvent('wheel', { deltaY: 300, clientX: r.left + 150, clientY: r.top + 100, bubbles: true, cancelable: true }));
    expect(store.view.value.zoom).toBeLessThan(z0);
  });

  it('refits on document resize and on container resize until the user zooms', async () => {
    engine.resize(128, 48);
    await settle();
    expect(store.view.value.zoom).toBeCloseTo(Math.min(336 / 128, 236 / 48), 6);
    el.style.width = '300px';
    await settle(); await settle();
    expect(store.view.value.zoom).toBeCloseTo(Math.min(236 / 128, 236 / 48), 6);
    store.zoomBy(2);
    const z = store.view.value.zoom;
    el.style.width = '500px';
    await settle(); await settle();
    expect(store.view.value.zoom).toBe(z);
  });
});

describe('Viewport interruption handling', () => {
  const stroke = () => {
    send('pointerdown', toClient(10, 10));
    send('pointermove', toClient(20, 22));
    send('pointermove', toClient(30, 33));
  };
  const ups = () => engine.pointers.filter((p) => p.kind === 'up');

  it('pointercancel ends the stroke at the last move position, not the cancel coordinates', () => {
    stroke();
    send('pointercancel', [0, 0]);
    expect(ups().length).toBe(1);
    expect(ups()[0].p.x).toBeCloseTo(30, 6);
    expect(ups()[0].p.y).toBeCloseTo(33, 6);
    send('pointermove', toClient(40, 40));
    expect(engine.pointers.filter((p) => p.kind === 'move').length).toBe(2);
  });

  it('lostpointercapture ends the stroke once; a normal pointerup afterwards adds nothing', () => {
    stroke();
    send('lostpointercapture', [0, 0]);
    send('pointerup', toClient(30, 33));
    expect(ups().length).toBe(1);
  });

  it('a normal release followed by lostpointercapture does not double-end', () => {
    stroke();
    send('pointerup', toClient(31, 34));
    send('lostpointercapture', [0, 0]);
    expect(ups().length).toBe(1);
    expect(ups()[0].p.x).toBeCloseTo(31, 6);
  });

  it('window blur ends the stroke', () => {
    stroke();
    window.dispatchEvent(new Event('blur'));
    expect(ups().length).toBe(1);
    window.dispatchEvent(new Event('blur'));
    expect(ups().length).toBe(1);
  });

  it('ignores a second pointer while a stroke is active', () => {
    send('pointerdown', toClient(10, 10), { pointerId: 1 });
    send('pointerdown', toClient(50, 10), { pointerId: 2 });
    send('pointermove', toClient(60, 10), { pointerId: 2 });
    send('pointerup', toClient(60, 10), { pointerId: 2 });
    send('pointercancel', [0, 0], { pointerId: 2 });
    expect(engine.pointers.map((p) => p.kind)).toEqual(['down']);
    send('pointerup', toClient(11, 11), { pointerId: 1 });
    expect(engine.pointers.map((p) => p.kind)).toEqual(['down', 'up']);
  });

  it('a stuck Space (keyup never delivered) is released by the next press after a second of silence', () => {
    store.spaceHeld.value = true;
    store.spaceSeenAt = performance.now() - 5000;
    send('pointerdown', toClient(10, 10));
    expect(store.spaceHeld.value).toBe(false);
    expect(engine.pointers.map((p) => p.kind)).toEqual(['down']);
  });

  it('a fresh Space still pans', () => {
    store.spaceHeld.value = true;
    store.spaceSeenAt = performance.now();
    send('pointerdown', toClient(10, 10));
    expect(engine.pointers.length).toBe(0);
    send('pointerup', toClient(10, 10));
    store.spaceHeld.value = false;
  });

  it('ctrl+wheel (pinch) scales small deltas up and caps big ones', () => {
    const r = vp().getBoundingClientRect();
    const z0 = store.view.value.zoom;
    vp().dispatchEvent(new WheelEvent('wheel', { deltaY: -4, ctrlKey: true, clientX: r.left + 100, clientY: r.top + 100, bubbles: true, cancelable: true }));
    expect(store.view.value.zoom / z0).toBeCloseTo(Math.exp(0.04), 6);
    const z1 = store.view.value.zoom;
    vp().dispatchEvent(new WheelEvent('wheel', { deltaY: -500, ctrlKey: true, clientX: r.left + 100, clientY: r.top + 100, bubbles: true, cancelable: true }));
    expect(store.view.value.zoom / z1).toBeCloseTo(Math.exp(0.25), 6);
  });
});

describe('Viewport backdrop caching', () => {
  it('does not rebuild the shadow and checkerboard for composite-only repaints', async () => {
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.createPattern;
    let patterns = 0;
    proto.createPattern = function (this: CanvasRenderingContext2D, ...a: Parameters<typeof orig>) { patterns++; return orig.apply(this, a); } as typeof orig;
    try {
      await settle();
      const n = patterns;
      for (let i = 0; i < 20; i++) {
        engine.emit({ type: 'composite', rect: { x: i, y: 0, w: 2, h: 2 } });
        await frameOnly();
      }
      expect(patterns).toBe(n);
      store.zoomBy(1.3);
      await settle();
      expect(patterns).toBe(n + 1);
    } finally {
      proto.createPattern = orig;
    }
  });
});

const frameOnly = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

describe('Viewport device pixel ratio', () => {
  const setDpr = (v: number | undefined) => {
    if (v === undefined) delete (window as unknown as Record<string, unknown>).devicePixelRatio;
    else Object.defineProperty(window, 'devicePixelRatio', { value: v, configurable: true });
  };
  afterEach(() => setDpr(undefined));

  for (const dpr of [1, 1.5, 2]) {
    it(`sizes the backing store for dpr ${dpr} and maps pointers in CSS px`, async () => {
      setDpr(dpr);
      await mount(<Viewport />, 'display:flex;flex-direction:column;width:401px;height:301px');
      await settle();
      const [main, over] = canvases();
      for (const c of [main, over]) {
        expect(c.width).toBe(Math.round(401 * dpr));
        expect(c.height).toBe(Math.round(301 * dpr));
        expect(c.style.width).toBe('100%');
      }
      expect(pixelAtScale(main, 200, 150)).toEqual([0x33, 0x66, 0x99, 255]);
      send('pointerdown', toClient(10, 12));
      send('pointerup', toClient(10, 12));
      const first = engine.pointers[0].p;
      expect(first.x).toBeCloseTo(10, 6);
      expect(first.y).toBeCloseTo(12, 6);
    });
  }

  it('re-renders the backing store when the ratio changes under a media query', async () => {
    await settle();
    const [main] = canvases();
    const w1 = main.width;
    setDpr(2);
    el.style.width = '399px'; // any resize path reads the new ratio
    await settle(); await settle();
    expect(canvases()[0].width).toBe(Math.round(399 * 2));
    expect(canvases()[0].width).not.toBe(w1);
  });
});

const pixelAtScale = (c: HTMLCanvasElement, cssX: number, cssY: number) => {
  const kx = c.width / (c.parentElement as HTMLElement).getBoundingClientRect().width;
  return Array.from(c.getContext('2d')!.getImageData(Math.round(cssX * kx), Math.round(cssY * kx), 1, 1).data);
};
