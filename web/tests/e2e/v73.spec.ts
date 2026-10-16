import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v7.3 (protocol 9): masks on groups and TD input layers against the fake TD: the doc spec sent to TD lists the masks,
// painting a mask streams its surface, and the UI enables mask controls on group / input rows.
let td: FakeTd;
test.afterEach(async () => { await (td as FakeTd | undefined)?.close(); });

const url = () => `/?test=1&ws=${encodeURIComponent(td.url)}#token=${td.token}`;
const open = async (page: Page) => {
  td = await FakeTd.start({ w: 160, h: 90, hasInput: true });
  page.on('pageerror', (e) => { throw e; });
  await page.goto(url());
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await td.waitFor(() => td.doc !== null);
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const spec = (id: string) => td.doc!.layers.find((l) => l.id === id)!;
const row = (page: Page, id: string) => page.locator(`[data-layer="${id}"]`);

test('fake TD speaks protocol 9: ready carries 9 and no mismatch notice appears', async ({ page }) => {
  await open(page);
  expect(td.messages.find((m) => m.t === 'ready')).toMatchObject({ protocol: 10 });
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
});

test('group mask: Add mask enabled on a group row, the doc spec lists it, painting streams the mask surface', async ({ page }) => {
  await open(page);
  const g = await hook<string>(page, 'addGroup');
  const c = await hook<string>(page, 'addLayer');
  await hook(page, 'moveLayer', c, g, 0);
  await row(page, g).locator('[data-act=sel]').click();
  const add = page.locator('[aria-label="Add mask"]');
  await expect(add).toHaveAttribute('aria-disabled', 'false');
  await add.click();
  await td.waitFor(() => !!spec(g)?.mask);
  const slot = spec(g).mask!.slot;
  expect(spec(g).mask).toEqual({ slot, enabled: true });
  expect(td.surfaces.get(slot)!.length).toBe(160 * 90 * 4); // group masks are document sized
  await expect(row(page, g).locator('[data-act=mask]')).toBeVisible();
  await row(page, g).locator('[data-act=mask]').click();
  expect((await hook<{ paintTarget: unknown }>(page, 'loadState')).paintTarget).toMatchObject({ layerId: g, target: 'mask' });
  await hook(page, 'setPrimary', '#000000');
  await hook(page, 'setTool', 'pencil');
  await page.locator('#bw').fill('8');
  await hook(page, 'stroke', 'pencil', [[40, 40], [90, 40]]);
  await td.waitFor(() => td.surfacePixel(slot, 60, 40)[0] < 40);
  expect(td.surfacePixel(slot, 60, 40)[0]).toBeLessThan(40);
  expect(td.surfacePixel(slot, 5, 5)[0]).toBe(255);
  await row(page, g).locator('[data-act=mask]').click({ modifiers: ['Shift'] });
  await td.waitFor(() => spec(g).mask?.enabled === false);
});

test('input mask: Add mask enabled on the TD Input row (input surface size), painted mask reaches TD, transform keeps the mask in the spec', async ({ page }) => {
  await open(page);
  await hook(page, 'setPaintTarget', 'base', 'pixels');
  const add = page.locator('[aria-label="Add mask"]');
  await expect(add).toHaveAttribute('aria-disabled', 'false');
  await add.click();
  await td.waitFor(() => !!spec('base')?.mask);
  const m = spec('base').mask!;
  expect(td.surfaces.get(m.slot)!.length).toBe(spec('base').surfaceW! * spec('base').surfaceH! * 4);
  await hook(page, 'setPaintTarget', 'base', 'mask');
  await hook(page, 'setPrimary', '#000000');
  await hook(page, 'setTool', 'pencil');
  await page.locator('#bw').fill('8');
  await hook(page, 'stroke', 'pencil', [[30, 30], [70, 30]]);
  await td.waitFor(() => td.surfacePixel(m.slot, 50, 30)[0] < 40);
  await hook(page, 'setTransform', 'base', { x: 10, y: 5 });
  await td.waitFor(() => spec('base').x === 10);
  expect(spec('base').mask).toEqual(m);
  await page.keyboard.press('Control+z'); // the transform
  await td.waitFor(() => spec('base').x === 0);
  expect(spec('base').mask).toEqual(m);
});
