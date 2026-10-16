import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v7.2: scrubbable dropdowns and font size against the fake TD: real mouse drags in the page reach TD's document live,
// one undo reverts the whole drag.
let td: FakeTd;
test.afterEach(async () => { await (td as FakeTd | undefined)?.close(); });

const url = () => `/?test=1&ws=${encodeURIComponent(td.url)}#token=${td.token}`;
const open = async (page: Page) => {
  td = await FakeTd.start({ w: 320, h: 200, hasInput: true });
  page.on('pageerror', (e) => { throw e; });
  await page.goto(url());
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await td.waitFor(() => td.doc !== null);
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const spec = (id: string) => td.doc!.layers.find((l) => l.id === id)!;

/** Press in the middle of `loc`, move `dx,dy` in small real mouse steps (optionally pausing), release. */
async function scrub(page: Page, loc: ReturnType<Page['locator']>, dx: number, dy: number, steps = 12) {
  const b = (await loc.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
    await page.waitForTimeout(12);
  }
  return () => page.mouse.up();
}

test('dragging the blend mode select steps through the modes live in TD; one undo reverts the whole drag', async ({ page }) => {
  await open(page);
  const id = await hook<string>(page, 'addLayer');
  await td.waitFor(() => !!td.doc!.layers.find((l) => l.id === id));
  const entries = () => hook<{ length: number }>(page, 'history').then((h) => h.length);
  const before = await entries();
  const sel = page.getByLabel('Blend mode');
  const up = await scrub(page, sel, 0, 50); // ~4 steps
  await td.waitFor(() => spec(id).blend !== 'normal'); // live: the button is still down
  const live = spec(id).blend;
  await up();
  await expect(sel).not.toHaveValue('normal');
  expect(live).not.toBe('normal');
  const final = await sel.inputValue();
  await td.waitFor(() => spec(id).blend === final);
  expect(await entries()).toBe(before + 1);
  await hook(page, 'undo');
  await td.waitFor(() => spec(id).blend === 'normal');
  await expect(sel).toHaveValue('normal');
  // a click (no movement) opens the list instead of changing anything
  await sel.click();
  await expect(sel).toHaveAttribute('data-scrub-opened', /native|list/);
  await page.keyboard.press('Escape');
  expect(spec(id).blend).toBe('normal');
});

test('dragging the font size box re-renders the text layer live in TD; one undo restores the size', async ({ page }) => {
  await open(page);
  const id = await hook<string>(page, 'addTextLayer', { text: 'Hi', size: 40, x: 20, y: 20, color: { r: 0, g: 0, b: 0, a: 255 } });
  await td.waitFor(() => spec(id)?.text?.size === 40);
  await hook(page, 'setTool', 'text');
  const entries = () => hook<{ length: number }>(page, 'history').then((h) => h.length);
  const size = page.getByLabel('Font size');
  await expect(size).toHaveValue('40');
  const before = await entries();
  const up = await scrub(page, size, 0, -40); // 40 px up = +20
  await td.waitFor(() => spec(id).text!.size === 60); // live, before the release
  await up();
  await expect(size).toHaveValue('60');
  expect(await entries()).toBe(before + 1);
  await hook(page, 'undo');
  await td.waitFor(() => spec(id).text!.size === 40);
  await expect(size).toHaveValue('40');
  // Escape during a drag reverts and leaves no step
  const idx = () => hook<{ index: number }>(page, 'history').then((h) => h.index);
  const n = await idx();
  const up2 = await scrub(page, size, 0, -30);
  await td.waitFor(() => spec(id).text!.size > 40);
  await page.keyboard.press('Escape');
  await td.waitFor(() => spec(id).text!.size === 40);
  await up2();
  await expect(size).toHaveValue('40');
  expect(await idx()).toBe(n); // no step left behind
});
