import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';
import type { LayerSpec } from '../../src/engine/types';

let td: FakeTd;
test.beforeEach(async () => { td = await FakeTd.start({ w: 160, h: 90 }); });
test.afterEach(async () => { await td.close(); });

const open = async (page: Page, extra = '') => {
  await page.goto(`/?test=1&client=panel&ws=${encodeURIComponent(td.url)}&token=${td.token}${extra}`);
  await expect(page.locator('[data-tool]').first()).toBeVisible();
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

test('connects, says ready as the panel client and shows the linked state', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.messages.length > 0);
  expect(td.messages[0]).toMatchObject({ t: 'ready', protocol: 9, client: 'panel', token: td.token, fresh: true });
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  expect((await hook<any>(page, 'state')).doc).toEqual({ w: 160, h: 90 });
});

test('defaults to the external client', async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(td.url)}&token=${td.token}`);
  await td.waitFor(() => td.messages.length > 0);
  expect(td.messages[0]).toMatchObject({ t: 'ready', client: 'external' });
});

test('base frames from TD appear in the document', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  td.sendSolidBase(200, 30, 10);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 80, 45)).toEqual([200, 30, 10, 255]);
  expect(await hook<number[]>(page, 'readPixel', 0, 0)).toEqual([200, 30, 10, 255]);
  expect(await hook<number[]>(page, 'readPixel', 159, 89)).toEqual([200, 30, 10, 255]);
  expect(td.frames.every((f) => f.type === 3)).toBe(true); // only SURFACE tiles go to TD, never a composite
});

test('a burst of BASE frames arrives via notices: one outstanding, newest wins, nothing lost at the end', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  const shades = [10, 60, 110, 160, 210];
  for (const v of shades) td.sendSolidBase(v, 0, 0);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 80, 45)).toEqual([210, 0, 0, 255]);
  expect(td.noticesSent.length).toBe(td.fetches.length); // every notice fetched exactly once
  expect(td.noticesSent.length).toBeLessThanOrEqual(shades.length);
  expect(td.badFetches).toBe(0);
  expect(td.fetches.every((f) => f.status === 200)).toBe(true);
  expect(td.fetches.length).toBeLessThanOrEqual(shades.length);

  // and a later frame still flows after the burst
  td.sendSolidBase(5, 6, 7);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 80, 45)).toEqual([5, 6, 7, 255]);
});

test('a frame stored before the page connected is announced on hello and fetched', async ({ page }) => {
  td.sendSolidBase(33, 44, 55);
  await open(page);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 10, 10)).toEqual([33, 44, 55, 255]);
});

test('404 from /base is ignored; the next notice delivers the frame', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  td.baseStatus = 404;
  td.sendSolidBase(1, 1, 1);
  await td.waitFor(() => td.fetches.some((f) => f.status === 404));
  await page.waitForTimeout(700); // no retry storm, no error shown
  expect(td.fetches.filter((f) => f.status === 404).length).toBe(1);
  await expect(page.locator('[data-status=fatal]')).toHaveCount(0);
  await expect(page.locator('[data-status=notice]')).toHaveCount(0);
  td.baseStatus = null;
  td.sendSolidBase(70, 80, 90); // the "notice that follows"
  await expect.poll(() => hook<number[]>(page, 'readPixel', 10, 10)).toEqual([70, 80, 90, 255]);
  expect(td.noticesSent.length).toBe(td.fetches.length);
});

test('403 from /base is a token failure: fatal status message', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  td.baseStatus = 403;
  td.sendSolidBase(1, 1, 1);
  await expect(page.locator('[data-status=fatal]')).toHaveText('Reopen from TouchDesigner — session expired');
});

test('a fetch result that arrives after docSize is dropped; the new-size frame wins', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  td.baseDelayMs = 400;
  td.sendSolidBase(200, 0, 0);
  await td.waitFor(() => td.noticesSent.length === 1);
  await page.waitForTimeout(100); // the page is now waiting on the slow response
  td.resize(80, 60);
  await expect.poll(async () => (await hook<any>(page, 'state')).doc).toEqual({ w: 80, h: 60 });
  await page.waitForTimeout(500); // old (160x90) response lands and must be ignored
  expect(await hook<number[]>(page, 'readPixel', 5, 5)).not.toEqual([200, 0, 0, 255]);
  td.baseDelayMs = 0;
  td.sendSolidBase(0, 200, 0);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 79, 59)).toEqual([0, 200, 0, 255]);
});

test('painting sends only dirty SURFACE tiles of the painted layer to TD', async ({ page }) => {
  await open(page);
  td.sendSolidBase(10, 10, 200);
  await td.waitFor(() => td.doc !== null);
  await page.getByRole('button', { name: 'New pixel layer' }).click();
  await td.waitFor(() => (td.doc?.layers.length ?? 0) >= 3);
  const activeId = (await hook<any>(page, 'state')).activeLayer as string;
  const slot = (await hook<any[]>(page, 'layers')).find((l) => l.id === activeId)!.slot as number;
  await hook(page, 'setPrimary', '#ffffff');
  await hook(page, 'setTool', 'pencil');
  await page.locator('#bw').fill('6');
  const count = td.frames.length;
  const a = await hook<{ x: number; y: number }>(page, 'docToScreen', 40, 40);
  const b = await hook<{ x: number; y: number }>(page, 'docToScreen', 60, 40);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await td.waitFor(() => td.surfacePixel(slot, 50, 40)[0] === 255);
  const sent = td.frames.slice(count);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((f) => f.slot === slot && f.w * f.h < 160 * 90)).toBe(true);
  expect(td.surfacePixel(slot, 5, 80)).toEqual([0, 0, 0, 0]); // untouched pixels stay transparent
});

test('docSize from TD resizes the document', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  td.resize(80, 60);
  await expect.poll(async () => (await hook<any>(page, 'state')).doc).toEqual({ w: 80, h: 60 });
  td.sendSolidBase(9, 9, 9);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 79, 59)).toEqual([9, 9, 9, 255]);
});

const pxLayer = (id: string, slot: number, extra: Partial<LayerSpec> = {}): LayerSpec => ({
  id, kind: 'pixel', parentId: null, name: id, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, rot: 0, kx: 0, ky: 0, input: null, effects: [], slot, mask: null, adjustment: null, text: null, shape: null, sx: 1, sy: 1, surfaceW: null, surfaceH: null, ...extra,
});
const baseLayer = (): LayerSpec => ({ ...pxLayer('base', 0), kind: 'input', input: 1, slot: null, name: 'TD Input' });

test('standby: overlay, Take over loads TD\'s document (nothing pushed), then editing resumes', async ({ page }) => {
  await td.close();
  td = await FakeTd.start({ w: 160, h: 90, active: false });
  td.seedDocument([baseLayer(), pxLayer('tdLayer', 7, { name: 'From TD' })], 3, { 7: [9, 8, 7, 255] });
  await open(page);
  await expect(page.getByText('Editing in another window')).toBeVisible();
  await page.waitForTimeout(300);
  expect(td.frames.length).toBe(0);
  expect(td.docMessages).toBe(0);
  await page.getByRole('button', { name: 'Take over' }).click();
  await td.waitFor(() => td.messages.some((m) => m.t === 'takeover'));
  await expect(page.getByText('Editing in another window')).toBeHidden();
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['From TD', 'TD Input']);
  await td.waitFor(() => td.surfaceFetches.includes(7));
  await expect.poll(() => hook<number[]>(page, 'readPixel', 3, 3)).toEqual([9, 8, 7, 255]); // surface pixels came from TD
  expect(td.docMessages).toBe(0); // loading is not echoed back
  expect(td.frames.length).toBe(0);

  td.setActive(false);
  await expect(page.getByText('Editing in another window')).toBeVisible();
});

test('reconnects after the socket drops and re-pushes doc and full surfaces', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  const ends = td.frameEnds, docs = td.docMessages;
  td.dropClient();
  await expect(page.locator('[data-status=connection]')).toContainText('Reconnecting');
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked', { timeout: 8000 });
  expect(td.connections).toBe(2);
  expect(td.messages.filter((m) => m.t === 'ready').map((m) => (m as { fresh: boolean }).fresh)).toEqual([true, false]);
  await td.waitFor(() => td.frameEnds > ends && td.docMessages > docs);
  // v5: surfaces keep their own size (the default Layer 1 was created at the boot size), frames carry the SURFACE size
  const last = td.frames[td.frames.length - 1];
  expect(last.x).toBe(0);
  expect(last.w).toBe(last.docW);
});

test('forwards page errors to TD as log messages', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.messages.length > 0);
  await page.evaluate(() => console.error('boom from test'));
  await td.waitFor(() => td.messages.some((m) => m.t === 'log' && m.msg.includes('boom from test')));
});

test('a missing or wrong token is rejected and the status bar says to reopen from TouchDesigner', async ({ page }) => {
  await page.goto(`/?test=1&ws=${encodeURIComponent(td.url)}&token=wrong`);
  await expect(page.locator('[data-status=fatal]')).toHaveText('Reopen from TouchDesigner — session expired');
  await page.waitForTimeout(1500);
  expect(td.rejected).toBe(1); // no reconnect storm
  expect(td.messages[0]).toMatchObject({ t: 'ready', token: 'wrong' });

  await page.goto(`/?test=1&ws=${encodeURIComponent(td.url)}`);
  await expect(page.locator('[data-status=fatal]')).toBeVisible();
  expect(td.messages[td.messages.length - 1]).toMatchObject({ t: 'ready', token: '' });
});

test('same-origin page served by TD fetches /base without any CORS headers or Origin', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${td.port}/?test=1&client=panel&token=${td.token}`);
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  td.sendSolidBase(12, 34, 56);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 10, 10)).toEqual([12, 34, 56, 255]);
  expect(td.fetches.length).toBeGreaterThan(0);
  expect(td.fetches.every((f) => f.status === 200 && f.acao === undefined)).toBe(true);
});

test('cross-origin dev page: loopback origin is echoed, foreign origins get no CORS headers', async () => {
  const get = async (origin: string) => {
    const r = await fetch(`http://127.0.0.1:${td.port}/base?token=x&client=y&frameId=1`, { headers: { Origin: origin } }).catch(() => null);
    return r;
  };
  expect(FakeTd.corsHeaders('http://127.0.0.1:4173')).toEqual({ 'Access-Control-Allow-Origin': 'http://127.0.0.1:4173', Vary: 'Origin' });
  expect(FakeTd.corsHeaders('http://localhost:5173')['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  expect(FakeTd.corsHeaders('https://evil.example')).toEqual({});
  expect(FakeTd.corsHeaders('http://127.0.0.1.evil.example')).toEqual({});
  expect(FakeTd.corsHeaders(undefined)).toEqual({});
  const evil = await get('https://evil.example');
  if (evil) expect(evil.headers.get('access-control-allow-origin')).toBeNull();
});
