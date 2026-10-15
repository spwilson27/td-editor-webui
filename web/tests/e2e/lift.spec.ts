import { expect, test } from '@playwright/test';

const hook = <T,>(page: import('@playwright/test').Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => ((window as any).__editorTest[f as string] as (...x: unknown[]) => unknown)(...(a as unknown[])), [fn, args]) as Promise<T>;

test('lifting a selection keeps the floating selection alive (real engine, standalone)', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await hook(page, 'setPrimary', '#ff0000');
  await hook(page, 'stroke', 'brush', [[20, 20], [80, 20], [80, 60]]);
  await hook(page, 'selectRect', 10, 10, 90, 60);
  expect(await hook(page, 'liftSelection')).toBe(true);
  expect(await hook(page, 'floating')).not.toBeNull();
  await page.waitForTimeout(300);
  expect(await hook(page, 'floating')).not.toBeNull();
  expect((await hook<any>(page, 'state')).tool).toBe('move');
  await hook(page, 'cancelFloating');
  expect(await hook(page, 'floating')).toBeNull();
});

test('Ctrl+T lifts the selection and the floating box stays', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await hook(page, 'stroke', 'brush', [[20, 20], [80, 20], [80, 60]]);
  await hook(page, 'selectRect', 10, 10, 90, 60);
  await page.keyboard.press('Control+t');
  await page.waitForTimeout(300);
  expect(await hook(page, 'floating')).not.toBeNull();
  expect((await hook<any>(page, 'state')).tool).toBe('move');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(await hook(page, 'floating')).toBeNull();
});
