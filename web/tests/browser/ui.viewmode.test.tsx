import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { App } from '../../src/ui/App';
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
  store.clientKind.value = 'external';
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
  const centre = () => { const v = store.view.value; return [v.x + (64 * v.zoom) / 2, v.y + (48 * v.zoom) / 2] as const; };

  beforeEach(async () => {
    store.setConnection('linked');
    await mount(<Viewport />, 'display:flex;flex-direction:column;width:400px;height:300px');
    await settle();
  });

  it('panel client: the document rect is transparent, the surround and shadow are drawn', async () => {
    const [cx, cy] = centre();
    expect(px(cx, cy)).toEqual([0x33, 0x66, 0x99, 255]); // local preview
    store.clientKind.value = 'panel';
    store.setViewMode('td');
    await settle();
    expect(px(cx, cy)[3]).toBe(0);
    expect(px(3, 3)).toEqual([0x1c, 0x1c, 0x1c, 255]); // surround stays opaque
    const v = store.view.value;
    expect(px(v.x - 4, cy)[3]).toBeGreaterThan(0); // soft shadow next to the document
    expect(px(v.x - 4, cy)[0]).toBeLessThan(0x1c);
    expect(q('[data-viewport]').dataset.tdPanel).toBe('true');
    expect(getComputedStyle(q('[data-viewport]')).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('panel client: back to Local paints the preview again', async () => {
    store.clientKind.value = 'panel';
    store.setViewMode('td');
    await settle();
    store.setViewMode('local');
    await settle();
    const [cx, cy] = centre();
    expect(px(cx, cy)).toEqual([0x33, 0x66, 0x99, 255]);
  });

  it('external client: shows the fetched TD view image instead of the local preview', async () => {
    store.setViewMode('td');
    await settle();
    const [cx, cy] = centre();
    expect(px(cx, cy)).not.toEqual([0x33, 0x66, 0x99, 255]); // no image yet: checkerboard, never the local preview
    const rgba = new Uint8ClampedArray(64 * 48 * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 200; rgba[i + 1] = 10; rgba[i + 2] = 20; rgba[i + 3] = 255; }
    store.setViewFrame(64, 48, rgba, 12);
    await settle();
    expect(px(cx, cy)).toEqual([200, 10, 20, 255]);
    expect(store.viewAge.value).toBe(12);
  });

  it('external client: a semi-transparent TD pixel shows the checkerboard through it', async () => {
    store.setViewMode('td');
    const rgba = new Uint8ClampedArray(64 * 48 * 4); // fully transparent
    store.setViewFrame(64, 48, rgba, 0);
    await settle();
    const v = store.view.value;
    const a = px(v.x + 2, v.y + 2), b = px(v.x + 10, v.y + 2);
    expect([a[0], b[0]].sort()).toEqual([0xcf, 0xff]);
  });

  it('reports its rect to the store for the TD view message', async () => {
    const r = store.viewRect.value;
    expect(r.w).toBe(400);
    expect(r.h).toBe(300);
  });
});

describe('page background in panel TD mode', () => {
  it('the app root and html become transparent only for panel + TD', async () => {
    store.setConnection('linked');
    await mount(<App />, 'width:1200px;height:700px');
    const root = q('[data-app-root]');
    expect(getComputedStyle(root).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    store.clientKind.value = 'panel';
    store.setViewMode('td');
    document.documentElement.toggleAttribute('data-td-panel', store.tdPanel.value); // main.tsx does this in an effect
    await settle();
    expect(getComputedStyle(root).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(document.body).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(document.documentElement).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    // the side panels stay opaque
    expect(getComputedStyle(q('[aria-label="Layer panels"]').parentElement!.parentElement!).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });
});
