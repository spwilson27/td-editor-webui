import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

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
  expect(td.messages[0]).toMatchObject({ t: 'ready', protocol: 1, client: 'panel', token: td.token });
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  expect((await hook<any>(page, 'state')).doc).toEqual({ w: 160, h: 90 });
});

test('defaults to the external client', async ({ page }) => {
  await page.goto(`/?ws=${encodeURIComponent(td.url)}&token=${td.token}`);
  await td.waitFor(() => td.messages.length > 0);
  expect(td.messages[0]).toMatchObject({ t: 'ready', client: 'external' });
});

test('base frames from TD appear in the document and come back as a composite', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  td.sendSolidBase(200, 30, 10);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 80, 45)).toEqual([200, 30, 10, 255]);
  await td.waitFor(() => td.pixel(80, 45)[0] === 200);
  expect(td.pixel(0, 0)).toEqual([200, 30, 10, 255]);
  expect(td.pixel(159, 89)).toEqual([200, 30, 10, 255]);
});

test('painting sends only dirty rects to TD', async ({ page }) => {
  await open(page);
  td.sendSolidBase(10, 10, 200);
  await td.waitFor(() => td.pixel(5, 5)[2] === 200);
  await page.getByRole('button', { name: 'New pixel layer' }).click();
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
  await td.waitFor(() => td.pixel(50, 40)[0] === 255);
  const sent = td.frames.slice(count);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((f) => f.w * f.h < 160 * 90)).toBe(true);
  expect(td.pixel(5, 80)).toEqual([10, 10, 200, 255]);
});

test('docSize from TD resizes the document', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  td.resize(80, 60);
  await expect.poll(async () => (await hook<any>(page, 'state')).doc).toEqual({ w: 80, h: 60 });
  td.sendSolidBase(9, 9, 9);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 79, 59)).toEqual([9, 9, 9, 255]);
  await td.waitFor(() => td.pixel(79, 59)[0] === 9);
});

test('standby: overlay, Take over, then editing resumes with a full frame', async ({ page }) => {
  td.close();
  td = await FakeTd.start({ w: 160, h: 90, active: false });
  await open(page);
  await expect(page.getByText('Editing in another window')).toBeVisible();
  await page.waitForTimeout(300);
  expect(td.frames.length).toBe(0);
  await page.getByRole('button', { name: 'Take over' }).click();
  await td.waitFor(() => td.messages.some((m) => m.t === 'takeover'));
  await expect(page.getByText('Editing in another window')).toBeHidden();
  await td.waitFor(() => td.frameEnds >= 1);
  expect(td.frames[0]).toMatchObject({ x: 0, y: 0, w: 160, h: 90 });

  td.setActive(false);
  await expect(page.getByText('Editing in another window')).toBeVisible();
});

test('reconnects after the socket drops and resends a full frame', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.frameEnds >= 1);
  const ends = td.frameEnds;
  td.dropClient();
  await expect(page.locator('[data-status=connection]')).toContainText('Reconnecting');
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked', { timeout: 8000 });
  expect(td.connections).toBe(2);
  await td.waitFor(() => td.frameEnds > ends);
  expect(td.frames[td.frames.length - 1]).toMatchObject({ x: 0, y: 0, w: 160, h: 90 });
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
