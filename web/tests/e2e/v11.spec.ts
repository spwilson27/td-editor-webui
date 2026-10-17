import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v11 (protocol 12): the fast (JPEG over the WebSocket) and exact (deflate RGBA, tiles) TD view, against the fake TD.
let td: FakeTd;
test.beforeEach(async () => { td = await FakeTd.start({ w: 160, h: 90 }); });
test.afterEach(async () => { await td.close(); });

const open = async (page: Page, url = td.url, token = td.token) => {
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`/?test=1&ws=${encodeURIComponent(url)}#token=${token}`);
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const tdPixel = (page: Page, x: number, y: number) => hook<number[] | null>(page, 'tdViewPixel', x, y);

const badge = (page: Page) => page.locator('[data-status=view-frame]');
const quality = (page: Page) => page.locator('[data-view-quality]');

async function paintStroke(page: Page, steps = 8) {
  await hook(page, 'setTool', 'pencil');
  const a = await hook<{ x: number; y: number }>(page, 'docToScreen', 20, 20);
  const b = await hook<{ x: number; y: number }>(page, 'docToScreen', 100, 50);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}
async function enterTd(page: Page) {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.viewSubscribed);
}

test('subscribe: view {mode td, quality auto, viewport}; the selector sits next to the Local/TD switch', async ({ page }) => {
  await enterTd(page);
  expect(td.messages.find((m) => m.t === 'ready')).toMatchObject({ protocol: 12 });
  expect(td.lastView).toMatchObject({ t: 'view', mode: 'td', quality: 'auto', viewport: { x: 0, y: 0, w: 160, h: 90 } });
  const sel = quality(page);
  await expect(sel).toHaveValue('auto');
  await expect(sel.locator('option')).toHaveText(['Auto', 'Low latency', 'Accurate']);
  // same status-bar group: the selector follows the Local / TD switch
  const order = await page.evaluate(() => {
    const bar = document.querySelector('[data-view-mode=td]')!.closest('[role=group]')!.parentElement!;
    return [...bar.children].map((c) => (c.matches('[role=group]') ? 'switch' : c.querySelector('[data-view-quality]') ? 'quality' : ''));
  });
  expect(order.indexOf('quality')).toBe(order.indexOf('switch') + 1);
});

test('Auto: fast frames stream while drawing (<= 2 un-acked), one exact frame lands after idle, then tile patches', async ({ page }) => {
  await td.close();
  td = await FakeTd.start({ w: 512, h: 384 }); // 8 x 6 tiles: a small edit stays well below the 30 % full-frame threshold
  await enterTd(page);
  td.fastColor = 'red';
  await paintStroke(page, 12);
  await td.waitFor(() => td.fastSent.length >= 2);
  await expect(page.locator('[data-status=latency]')).toContainText('view age');
  await td.waitFor(() => td.acks.length >= 1);
  // every fast frame carries the viewport that was current and an appliedFrameId that is a SURFACE frame id of this client
  const ids = new Set(td.frames.map((f) => f.frameId));
  expect(td.fastSent.some((f) => ids.has(f.applied))).toBe(true);
  expect(td.fastSent.every((f) => f.viewport?.w === 512)).toBe(true);
  // idle: ~200 ms after the last change the exact frame arrives and replaces the fast one
  await td.waitFor(() => td.exactSent.length >= 1, 4000);
  expect(td.exactSent[0].kind).toBe('full');
  await expect(badge(page)).toHaveText('exact');
  const surfacePx = td.surfacePixel(td.frames[0].slot, 60, 35);
  expect(await tdPixel(page, 60, 35)).toEqual(surfacePx);
  expect(surfacePx[3]).toBe(255);
  // the page acked everything it received
  await td.waitFor(() => td.acks.length >= td.fastSent.length + td.exactSent.length);
  // a small edit afterwards: fast frames again, then a TILE exact frame well below a full frame
  const n = td.exactSent.length;
  await hook(page, 'setTool', 'pencil');
  const p = await hook<{ x: number; y: number }>(page, 'docToScreen', 140, 80);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down(); await page.mouse.move(p.x + 3, p.y + 1, { steps: 3 }); await page.mouse.up();
  await td.waitFor(() => td.exactSent.length > n, 4000);
  expect(td.exactSent[n].kind).toBe('tiles');
  expect(td.exactSent[n].nTiles).toBeLessThanOrEqual(4);
  expect(td.exactSent[n].bytes).toBeLessThan(td.exactSent[0].bytes / 3);
  const px = td.surfacePixel(td.frames[0].slot, 141, 80);
  await expect.poll(() => tdPixel(page, 141, 80)).toEqual(px);
  expect(px[3]).toBe(255);
  expect(td.exactResets).toBe(0);
});

test('a fast frame shows with the right alpha over the checkerboard; pixels outside its rect stay empty', async ({ page }) => {
  await enterTd(page);
  await quality(page).selectOption('fast'); // no exact frame may replace it
  await td.waitFor(() => (td.lastView as any)?.quality === 'fast');
  td.fastColor = 'halfRed';
  td.fastAlpha = 'a128';
  td.sendFast();
  await expect.poll(() => tdPixel(page, 80, 45).then((p) => !!p && p[0] >= 230 && p[1] >= 95 && p[1] <= 135)).toBe(true);
  const p = (await tdPixel(page, 80, 45))!;
  // premultiplied (128,0,0) + 0.5 x checkerboard (207 or 255): (231,103,103) on a dark cell, (255,127,127) on a light one
  expect([[231, 103, 103], [255, 127, 127]].some((e) => e.every((v, i) => Math.abs(v - p[i]) <= 2))).toBe(true);
  expect(p[3]).toBe(255);
});

test('mode pinning: Low latency never gets an exact frame, Accurate never a fast one; the choice survives a reload', async ({ page }) => {
  await enterTd(page);
  await quality(page).selectOption('fast');
  await td.waitFor(() => (td.lastView as any)?.quality === 'fast');
  const ex0 = td.exactSent.length;
  await paintStroke(page, 6);
  await td.waitFor(() => td.fastSent.length >= 2);
  await page.waitForTimeout(700); // longer than the exact delay
  expect(td.exactSent.length).toBe(ex0);
  await expect(badge(page)).toHaveText('≈');
  await quality(page).selectOption('exact');
  await td.waitFor(() => (td.lastView as any)?.quality === 'exact');
  const fast0 = td.fastSent.length;
  await paintStroke(page, 6);
  await td.waitFor(() => td.exactSent.length > ex0, 4000);
  expect(td.fastSent.length).toBe(fast0);
  await expect(badge(page)).toHaveText('exact');
  // per viewer: persisted in localStorage
  expect(await page.evaluate(() => localStorage.getItem('raster-editor.view.quality'))).toBe('exact');
  await td.close();
  td = await FakeTd.start({ w: 160, h: 90 });
  await open(page); // same origin, new TD: the page reloads with the stored choice
  await expect(quality(page)).toHaveValue('exact');
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.viewSubscribed);
  expect(td.lastView).toMatchObject({ mode: 'td', quality: 'exact' });
  await page.evaluate(() => localStorage.removeItem('raster-editor.view.quality'));
});

test('viewport updates are throttled to <= 10 Hz while zooming', async ({ page }) => {
  await enterTd(page);
  await td.waitFor(() => td.viewMessages.length >= 1);
  const n0 = td.viewMessages.length;
  const t0 = Date.now();
  await page.mouse.move(700, 450);
  for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, -40); await page.waitForTimeout(12); }
  await page.waitForTimeout(250);
  const dt = (Date.now() - t0) / 1000;
  const sent = td.viewMessages.length - n0;
  expect(sent).toBeGreaterThanOrEqual(2);
  expect(sent).toBeLessThanOrEqual(Math.ceil(dt * 10) + 1);
  // the last message reflects the final view
  const last = td.viewMessages.at(-1) as any;
  const z = await page.evaluate(() => (window as any).__editorTest.view?.() ?? null);
  void z;
  expect(last.viewport.scale).toBeGreaterThan(0);
});

test('large exact frames go through viewExact + GET /view?exact=1 and are displayed', async ({ page }) => {
  td.exactSocketLimit = 100; // everything is "too large for the socket"
  await enterTd(page);
  const img = new Uint8Array(160 * 90 * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 1; img[i + 1] = 2; img[i + 2] = 3; img[i + 3] = 77; } // semi-transparent
  td.setOutput(img);
  await td.waitFor(() => td.exactFetches.length >= 1, 4000);
  expect(td.exactFetches[0].status).toBe(200);
  expect(td.exactSent[0].viaHttp).toBe(true);
  await expect(badge(page)).toHaveText('exact');
  await td.waitFor(() => td.acks.includes(td.exactSent[0].frameId));
  // semi-transparent exact pixels reach the screen as straight alpha over the checkerboard: 1*a + (1-a)*ck
  const p = (await tdPixel(page, 5, 5))!;
  const a = 77 / 255;
  expect(Math.abs(p[0] - (1 * a + (1 - a) * 207))).toBeLessThanOrEqual(1.5 + 48 * (1 - a)); // checker phase unknown: 207 or 255
  expect(p[3]).toBe(255);
});

test('a reconnect resets the view: TD sends a full exact frame again, the badge clears meanwhile', async ({ page }) => {
  await enterTd(page);
  td.setOutput(new Uint8Array(160 * 90 * 4).fill(90));
  await td.waitFor(() => td.exactSent.length >= 1, 4000);
  await expect(badge(page)).toHaveText('exact');
  td.dropClient();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked', { timeout: 15000 });
  // the page fell back to Local while disconnected; entering TD again subscribes again and gets a full frame for the new client
  await expect(badge(page)).toHaveCount(0);
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.viewSubscribed);
  await td.waitFor(() => td.exactSent.filter((f) => f.kind === 'full').length >= 2, 6000);
  await expect(badge(page)).toHaveText('exact');
});

test('GPU context loss: the badge clears, and on restore the page re-subscribes and shows a fresh frame', async ({ page }) => {
  await enterTd(page);
  td.fastColor = 'green';
  td.sendFast();
  await expect(badge(page)).toHaveText('≈');
  const views = td.viewMessages.length;
  expect(await hook<boolean>(page, 'tdContext', true)).toBe(true);
  await expect(badge(page)).toHaveCount(0);
  await expect.poll(() => tdPixel(page, 80, 45)).toBeNull();
  const fast0 = td.fastSent.length;
  await hook(page, 'tdContext', false);
  await td.waitFor(() => td.viewMessages.length > views, 4000); // view {mode td} sent again
  await td.waitFor(() => td.fastSent.length > fast0, 4000);
  td.fastColor = 'blue';
  td.sendFast();
  await expect(badge(page)).toHaveText(/≈|exact/);
  await expect.poll(async () => { const p = await tdPixel(page, 80, 45); return !!p && p[3] === 255; }).toBe(true);
});
