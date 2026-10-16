import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExactBuffer } from '../../src/bridge/exactBuffer';
import { loadViewQuality, store } from '../../src/state/store';
import { peekTdViewGl } from '../../src/ui/tdViewGl';
import { solid } from '../helpers/viewFrames';
import { StatusBar } from '../../src/ui/StatusBar';
import { TopBar } from '../../src/ui/TopBar';
import { Viewport } from '../../src/ui/Viewport';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const seg = (id: string) => q<HTMLButtonElement>(`[data-view-mode=${id}]`);

function reset() {
  store.setConnection('reconnecting');
  store.viewMode.value = 'local';
  store.latency.value = { n: 0, last: 0, median: 0, p95: 0 };
  store.viewLatency.value = { n: 0, last: 0, median: 0, p95: 0 };
  store.viewAge.value = null;
  document.documentElement.removeAttribute('data-td-panel');
}
beforeEach(() => { engine = freshEngine(64, 48); reset(); });
afterEach(() => { unmount(); reset(); });

describe('status bar view toggle', () => {
  it('standalone: Local is on and the TD segment is disabled with a tooltip', async () => {
    store.setConnection('standalone');
    await mount(<StatusBar />);
    expect(seg('local').getAttribute('aria-pressed')).toBe('true');
    expect(seg('td').getAttribute('aria-disabled')).toBe('true');
    expect(seg('td').title).toMatch(/TouchDesigner/);
    seg('td').click();
    await settle();
    expect(store.viewMode.value).toBe('local');
    expect(engine.previewEnabled).toBe(true);
    expect(document.querySelector('[data-status=latency]')).toBeNull();
  });

  it('linked: TD switches the mode, disables the engine preview, and Local restores it', async () => {
    store.setConnection('linked');
    await mount(<StatusBar />);
    expect(seg('td').getAttribute('aria-disabled')).toBe('false');
    seg('td').click();
    await settle();
    expect(store.viewMode.value).toBe('td');
    expect(seg('td').getAttribute('aria-pressed')).toBe('true');
    expect(engine.previewEnabled).toBe(false);
    seg('local').click();
    await settle();
    expect(engine.previewEnabled).toBe(true);
    expect(seg('local').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the stroke -> TD latency, and the view age in TD mode for an external client', async () => {
    store.setConnection('linked');
    await mount(<StatusBar />);
    expect(q('[data-status=latency]').textContent).toContain('stroke → TD —');
    store.setLatency({ n: 12, last: 40, median: 34, p95: 58 });
    await settle();
    expect(q('[data-status=latency]').textContent).toContain('stroke → TD 34 ms');
    expect(q('[data-status=latency]').title).toContain('p95 58 ms');
    expect(document.querySelector('[data-status=view-age]')).toBeNull(); // local mode
    store.setViewMode('td');
    store.viewAge.value = 45;
    await settle();
    expect(q('[data-status=view-age]').textContent).toContain('view age 45 ms');
  });

  it('quality selector: Auto / Low latency / Accurate next to the Local/TD switch, persisted per viewer', async () => {
    store.setConnection('linked');
    try { localStorage.removeItem('raster-editor.view.quality'); } catch { /* */ }
    store.viewQuality.value = 'auto';
    await mount(<StatusBar />);
    const sel = q<HTMLSelectElement>('[data-view-quality]');
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Auto', 'Low latency', 'Accurate']);
    expect(sel.value).toBe('auto');
    expect(sel.disabled).toBe(false);
    sel.value = 'fast';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(store.viewQuality.value).toBe('fast');
    expect(localStorage.getItem('raster-editor.view.quality')).toBe('fast');
    expect(loadViewQuality()).toBe('fast');
    sel.value = 'exact';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.viewQuality.value).toBe('exact');
    store.setViewQuality('auto');
  });

  it('quality selector is disabled while standalone; an unreadable stored value means Auto', async () => {
    store.setConnection('standalone');
    await mount(<StatusBar />);
    expect(q<HTMLSelectElement>('[data-view-quality]').disabled).toBe(true);
    localStorage.setItem('raster-editor.view.quality', 'bogus');
    expect(loadViewQuality()).toBe('auto');
    localStorage.removeItem('raster-editor.view.quality');
  });

  it('badge: "≈" for a fast frame, "exact" for an exact one, nothing in Local or before a frame', async () => {
    store.setConnection('linked');
    await mount(<StatusBar />);
    expect(document.querySelector('[data-status=view-frame]')).toBeNull();
    store.setViewMode('td');
    await settle();
    expect(document.querySelector('[data-status=view-frame]')).toBeNull();
    store.setViewShown('fast', 5);
    await settle();
    expect(q('[data-status=view-frame]').textContent).toBe('≈');
    expect(q('[data-status=view-frame]').getAttribute('data-kind')).toBe('fast');
    store.setViewShown('exact', 5);
    await settle();
    expect(q('[data-status=view-frame]').textContent).toBe('exact');
    store.setViewMode('local');
    await settle();
    expect(document.querySelector('[data-status=view-frame]')).toBeNull();
    store.setViewShown(null, 0);
  });

  it('a lost connection drops back to Local', async () => {
    store.setConnection('linked');
    await mount(<StatusBar />);
    store.setViewMode('td');
    store.setConnection('reconnecting');
    await settle();
    expect(seg('local').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('View menu toggle', () => {
  const open = async () => {
    await mount(<TopBar />);
    [...document.querySelectorAll<HTMLElement>('[aria-haspopup=menu]')].find((b) => b.textContent === 'View')!.click();
    await settle();
  };
  const item = (t: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((i) => i.textContent?.includes(t))!;

  it('has Local view / TouchDesigner view with a check; TD is disabled when not linked', async () => {
    await open();
    expect(item('Local view').textContent).toContain('✓');
    expect(item('TouchDesigner view').getAttribute('aria-disabled')).toBe('true');
  });

  it('switches to TD view when linked', async () => {
    store.setConnection('linked');
    await open();
    item('TouchDesigner view').click();
    await settle();
    expect(store.viewMode.value).toBe('td');
    expect(engine.previewEnabled).toBe(false);
  });
});

describe('viewport in TD mode', () => {
  const canvas = () => document.querySelector<HTMLCanvasElement>('[data-viewport] canvas')!;
  const px = (x: number, y: number) => {
    const c = canvas(), k = c.width / c.getBoundingClientRect().width;
    return Array.from(c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data);
  };
  /** The TD view is a WebGL canvas layered above the backdrop; its drawing buffer is only readable in the task that drew it, so draw again at the viewport's view and read. */
  const glCanvas = () => peekTdViewGl()!.canvas;
  const glPx = (x: number, y: number) => {
    const g = peekTdViewGl()!, c = canvas(), r = c.getBoundingClientRect(), k = c.width / r.width;
    g.draw({ vw: r.width, vh: r.height, cw: c.width, ch: c.height, view: store.view.value, docW: 64, docH: 48 });
    const all = g.readCanvas();
    const i = (Math.round(y * k) * c.width + Math.round(x * k)) * 4;
    return Array.from(all.subarray(i, i + 4));
  };
  const centre = () => { const v = store.view.value; return [v.x + (64 * v.zoom) / 2, v.y + (48 * v.zoom) / 2] as const; };

  beforeEach(async () => {
    store.setConnection('linked');
    await mount(<Viewport />, 'display:flex;flex-direction:column;width:400px;height:300px');
    await settle();
  });



  /** Feeds the compositor like the bridge does: an exact frame (straight RGBA) shown on screen. */
  const showExact = (rgba: Uint8Array | Uint8ClampedArray, w = 64, h = 48, age = 0) => {
    const buf = new ExactBuffer();
    buf.applyFull(w, h, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    store.tdViewSink.exact(buf, [{ x: 0, y: 0, w, h }]);
    store.tdViewSink.show('exact');
    store.setViewShown('exact', age);
  };

  it('external client: shows the exact TD frame instead of the local preview', async () => {
    store.setViewMode('td');
    await settle();
    const [cx, cy] = centre();
    expect(px(cx, cy)).not.toEqual([0x33, 0x66, 0x99, 255]); // no image yet: checkerboard, never the local preview
    showExact(solid(64, 48, 200, 10, 20), 64, 48, 12);
    await settle();
    expect(glCanvas().parentElement).toBe(document.querySelector('[data-viewport]'));
    expect(glCanvas().style.display).toBe('block');
    expect(glCanvas().width).toBe(canvas().width);
    expect(glPx(cx, cy)).toEqual([200, 10, 20, 255]);
    expect(store.viewAge.value).toBe(12);
    // the layer order: backdrop, TD view, overlay
    const kids = [...document.querySelector('[data-viewport]')!.children].filter((c) => c.tagName === 'CANVAS');
    expect(kids.indexOf(glCanvas())).toBe(1);
    expect(kids).toHaveLength(3);
  });

  it('external client: a semi-transparent TD pixel shows the checkerboard through it', async () => {
    store.setViewMode('td');
    showExact(new Uint8Array(64 * 48 * 4)); // fully transparent
    await settle();
    const v = store.view.value;
    const a = glPx(v.x + 2, v.y + 2), b = glPx(v.x + 10, v.y + 2);
    expect([a[0], b[0]].sort()).toEqual([0xcf, 0xff]);
  });

  it('no WebGL2 / a shader failure: one notice, the Local view stays, and TD is refused without a loop', async () => {
    store.setViewMode('td'); // creates the compositor
    store.setViewMode('local');
    const g = peekTdViewGl()!;
    const saved = g.failure;
    g.failure = 'WebGL setup failed: test';
    store.notice.value = '';
    store.setViewMode('td');
    expect(store.viewMode.value).toBe('local');
    expect(store.notice.value).toMatch(/WebGL 2/);
    const n = store.notice.value;
    store.setViewMode('td');
    expect(store.viewMode.value).toBe('local');
    // frames that still arrive for an established TD view fall back to Local too
    g.failure = saved;
    store.setViewMode('td');
    expect(store.viewMode.value).toBe('td');
    g.failure = 'WebGL setup failed: test';
    const bmp = await createImageBitmap(new ImageData(2, 2));
    expect(store.tdViewSink.fast({ rgb: bmp, alpha: null, x: 0, y: 0, w: 4, h: 4 })).toBe(false);
    expect(store.viewMode.value).toBe('local');
    expect(n).toBeTruthy();
    g.failure = saved;
  });

  it('the badge never claims a frame while the GPU context is lost', async () => {
    store.setViewMode('td');
    const g = peekTdViewGl()!;
    store.setViewShown('exact', 1);
    expect(store.viewShown.value).toBe('exact');
    const ext = g.gl!.getExtension('WEBGL_lose_context')!;
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 60));
    expect(store.viewShown.value).toBeNull();
    store.setViewShown('exact', 1);
    expect(store.viewShown.value).toBeNull();
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 120));
    expect(g.isLost).toBe(false);
  });

  it('leaving TD mode shows the local preview again; ending the session clears the TD frame', async () => {
    store.setViewMode('td');
    showExact(solid(64, 48, 200, 10, 20));
    await settle();
    expect(glCanvas().style.display).toBe('block');
    store.setViewMode('local');
    await settle();
    expect(glCanvas().style.display).toBe('none');
    const [cx, cy] = centre();
    expect(px(cx, cy)).toEqual([0x33, 0x66, 0x99, 255]);
    store.setViewMode('td');
    await settle();
    expect(glCanvas().style.display).toBe('block');
    store.endSessionState();
    expect(store.viewShown.value).toBeNull();
    await settle();
    expect(glCanvas().style.display).toBe('none');
  });

  it('reports its rect to the store for the TD view message', async () => {
    const r = store.viewRect.value;
    expect(r.w).toBe(400);
    expect(r.h).toBe(300);
  });
});

