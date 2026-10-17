import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v10 / protocol 12: idle-aware streaming against the fake TD. The idle timeout is shortened with ?idleMs.
let td: FakeTd;
test.beforeEach(async () => { td = await FakeTd.start({ w: 160, h: 90, hasInput: true }); });
test.afterEach(async () => { await td.close(); });

const IDLE = 600;
const open = async (page: Page, idleMs = IDLE) => {
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`/?test=1&idleMs=${idleMs}&ws=${encodeURIComponent(td.url)}#token=${td.token}`);
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
};
const setVisibility = (page: Page, state: 'hidden' | 'visible') => page.evaluate((s) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}, state);
const badge = (page: Page) => page.locator('[data-status=paused]');

test('idle -> streams {paused: true}; input -> {paused: false} and frames flow again', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.viewSubscribed);
  await td.waitFor(() => td.fastSent.length >= 1);
  expect(td.streamMessages).toEqual([]);
  await expect(badge(page)).toHaveCount(0);
  await td.waitFor(() => td.streamMessages.length === 1, 4000);
  expect(td.streamMessages).toEqual([true]);
  await expect(badge(page)).toHaveText('Paused (idle)');
  // paused: TD sends nothing
  const fast = td.fastSent.length, notices = td.noticesSent.length;
  td.sendSolidBase(10, 20, 30);
  td.viewChanged();
  await page.waitForTimeout(300);
  expect(td.fastSent.length).toBe(fast);
  expect(td.noticesSent.length).toBe(notices);
  // input resumes
  await page.mouse.move(300, 300);
  await td.waitFor(() => td.streamMessages.length === 2);
  expect(td.streamMessages).toEqual([true, false]);
  await expect(badge(page)).toHaveCount(0);
  await td.waitFor(() => td.fastSent.length > fast && td.noticesSent.length > notices);
});

test('a hidden tab pauses immediately and becoming visible resumes', async ({ page }) => {
  await open(page, 60_000);
  await td.waitFor(() => td.doc !== null);
  await setVisibility(page, 'hidden');
  await td.waitFor(() => td.streamMessages.length === 1);
  expect(td.streamMessages).toEqual([true]);
  await setVisibility(page, 'visible');
  await td.waitFor(() => td.streamMessages.length === 2);
  expect(td.streamMessages).toEqual([true, false]);
});

test('Keep live: never idle, also with a hidden tab; persisted; toggling off while idle pauses', async ({ page }) => {
  await open(page);
  await page.locator('[data-keep-live]').click();
  await expect(page.locator('[data-keep-live]')).toHaveAttribute('aria-pressed', 'true');
  await setVisibility(page, 'hidden');
  await page.waitForTimeout(IDLE * 2);
  expect(td.streamMessages).toEqual([]);
  await expect(badge(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-keep-live]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-keep-live]').click(); // off, while the tab is still (emulated) visible and idle soon
  await td.waitFor(() => td.streamMessages.includes(true), 4000);
});

test('paused does not affect edit uploads', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  await td.waitFor(() => td.streamMessages.length === 1, 4000);
  const frames = td.frameEnds;
  await page.evaluate(() => (window as any).__editorTest.setTool('pencil'));
  const a = await page.evaluate(() => (window as any).__editorTest.docToScreen(20, 20));
  const b = await page.evaluate(() => (window as any).__editorTest.docToScreen(100, 50));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await td.waitFor(() => td.frameEnds > frames);
});
