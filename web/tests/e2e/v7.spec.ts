import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v7 (protocol 8): multi-select, Group Layers, Merge Selected, Flatten of every kind, against the fake TD (it serves synthetic renders).
let td: FakeTd;
test.afterEach(async () => { await (td as FakeTd | undefined)?.close(); });

const REVIEW = resolve(process.cwd(), '../dist/review');
const url = () => `/?test=1&client=panel&ws=${encodeURIComponent(td.url)}&token=${td.token}`;
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
const specs = () => td.doc!.layers;
const ids = () => specs().map((l) => l.id);
const row = (page: Page, id: string) => page.locator(`[data-layer="${id}"]`);
const menu = async (page: Page, top: string, item: string | RegExp) => {
  await page.getByRole('button', { name: top, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
const near = (a: number[], b: number[], tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** base + three pixel layers a < b < c (bottom to top). */
const three = async (page: Page) => {
  const a = await hook<string>(page, 'addLayer'), b = await hook<string>(page, 'addLayer'), c = await hook<string>(page, 'addLayer');
  await td.waitFor(() => ids().includes(c));
  return { a, b, c };
};

test('multi-select: click, Shift range, Cmd/Ctrl toggle; Delete removes all selected in one undo step', async ({ page }) => {
  await open(page);
  const { a, b, c } = await three(page);
  await page.locator(`[data-layer="${c}"] [data-act=sel]`).click();
  await page.locator(`[data-layer="${a}"] [data-act=sel]`).click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-layer][data-selected=true]')).toHaveCount(3);
  await page.locator(`[data-layer="${b}"] [data-act=sel]`).click({ modifiers: ['Meta'] }); // toggle one off
  await expect(page.locator('[data-layer][data-selected=true]')).toHaveCount(2);
  const hist = (await hook<{ length: number }>(page, 'history')).length;
  await page.keyboard.press('Delete');
  await td.waitFor(() => !ids().includes(a) && !ids().includes(c) && ids().includes(b));
  expect((await hook<{ length: number }>(page, 'history')).length).toBe(hist + 1);
  await page.keyboard.press('Control+z');
  await td.waitFor(() => ids().includes(a) && ids().includes(b) && ids().includes(c));
  await expect(row(page, a)).toBeVisible();
});

test('eye and lock on a selected row apply to the whole selection', async ({ page }) => {
  await open(page);
  const { a, b, c } = await three(page);
  await page.locator(`[data-layer="${c}"] [data-act=sel]`).click();
  await page.locator(`[data-layer="${b}"] [data-act=sel]`).click({ modifiers: ['Shift'] });
  await page.locator(`[data-layer="${c}"] [data-act=vis]`).click();
  await td.waitFor(() => specs().filter((l) => !l.visible).length === 2);
  expect(specs().find((l) => l.id === a)!.visible).toBe(true);
});

test('Group Layers (Ctrl+G) wraps the selection in a group; the group draws as a group', async ({ page }) => {
  await open(page);
  const { a, b, c } = await three(page);
  await page.locator(`[data-layer="${c}"] [data-act=sel]`).click();
  await page.locator(`[data-layer="${b}"] [data-act=sel]`).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+g');
  await td.waitFor(() => specs().some((l) => l.kind === 'group'));
  const g = specs().find((l) => l.kind === 'group')!.id;
  expect(specs().filter((l) => l.parentId === g).map((l) => l.id).sort()).toEqual([b, c].sort());
  expect(specs().find((l) => l.id === a)!.parentId).toBeNull();
  await expect(page.locator(`[data-layer="${g}"] [data-folder=open]`)).toBeVisible();
  await expect(page.locator(`[data-layer="${c}"] [data-guide="${g}"]`)).toBeVisible();
  await expect(page.locator(`[data-group-end="${g}"]`)).toHaveCount(1);
  // collapse: closed folder with a child count
  await page.locator(`[data-layer="${g}"] [data-act=open]`).click();
  await expect(page.locator(`[data-layer="${g}"] [data-child-count]`)).toHaveText('2');
});

test('Merge Selected: TD renders the layers, they become one pixel layer, undo brings them back', async ({ page }) => {
  await open(page);
  const { a, b, c } = await three(page);
  const existing = new Set(ids());
  td.renderColors.set(c, [30, 90, 200, 255]);
  await page.locator(`[data-layer="${c}"] [data-act=sel]`).click();
  await page.locator(`[data-layer="${b}"] [data-act=sel]`).click({ modifiers: ['Shift'] });
  await menu(page, 'Layer', /Merge Selected/);
  await td.waitFor(() => !ids().includes(c) && !ids().includes(b) && ids().some((id) => !existing.has(id)));
  expect(td.renderRequests).toEqual([{ t: 'renderLayers', ids: [c, b] }]);
  expect(ids()).toContain(a);
  const merged = specs().find((l) => !existing.has(l.id))!;
  expect(merged.kind).toBe('pixel');
  await td.waitFor(() => near(td.surfacePixel(merged.slot!, 80, 45), [30, 90, 200, 255]));
  await page.keyboard.press('Control+z');
  await td.waitFor(() => ids().includes(b) && ids().includes(c) && !ids().includes(merged.id));
});

test('Flatten of each kind: pixel layer with effects, group (merged), adjustment (merged down)', async ({ page }) => {
  await open(page);
  // pixel layer with an effect
  const fx = await hook<string>(page, 'addLayer');
  await hook(page, 'addFilterEffect', fx, 'invert');
  await td.waitFor(() => (specs().find((l) => l.id === fx)?.effects.length ?? 0) === 1);
  td.renderColors.set(fx, [10, 200, 30, 255]);
  const flatBtn = (id: string) => page.locator(`[data-layer="${id}"] [data-act=flatten]`);
  await expect(flatBtn(fx)).toHaveAttribute('title', 'Flatten to pixels');
  await expect(flatBtn(fx)).toHaveAttribute('aria-disabled', 'false');
  await flatBtn(fx).click();
  await td.waitFor(() => td.renderRequests.length === 1);
  expect(td.renderRequests[0]).toEqual({ t: 'renderLayer', ids: [fx], mode: 'flatten' });
  await td.waitFor(() => specs().filter((l) => l.kind === 'pixel' && l.effects.length === 0).length >= 1 && !specs().some((l) => l.effects.length));

  // a group: children merged into one pixel layer
  const g = await hook<string>(page, 'addGroup');
  const child = await hook<string>(page, 'addLayer');
  await hook(page, 'moveLayer', child, g, 0);
  await td.waitFor(() => specs().find((l) => l.id === child)?.parentId === g);
  await expect(flatBtn(g)).toHaveAttribute('title', 'Merge group');
  await flatBtn(g).click();
  await td.waitFor(() => td.renderRequests.length === 2);
  expect(td.renderRequests[1]).toMatchObject({ t: 'renderLayer', mode: 'flatten' });
  await td.waitFor(() => !specs().some((l) => l.kind === 'group'));

  // an adjustment: merged down into the layer below
  const below = specs().filter((l) => l.kind === 'pixel').at(-1)!.id;
  const adj = await hook<string>(page, 'addAdjustment', 'invert');
  await td.waitFor(() => ids().includes(adj));
  await page.getByRole('tab', { name: 'Layers' }).click(); // a new adjustment opens its FX stack in the Effects tab
  await expect(flatBtn(adj)).toHaveAttribute('title', 'Merge down into layer below');
  await flatBtn(adj).click();
  await td.waitFor(() => td.renderRequests.length === 3);
  expect(td.renderRequests[2]).toEqual({ t: 'renderLayer', ids: [adj], mode: 'mergeDown' });
  await td.waitFor(() => !ids().includes(adj) && !ids().includes(below));
  // input layers have no Flatten
  await expect(page.locator('[data-layer][data-selected] [data-act=flatten]').first()).toBeVisible();
  await expect(page.locator('[data-layer] [data-kind=input][data-act=flatten]').first()).toHaveAttribute('aria-disabled', 'true');
});

test('standalone: Flatten buttons are disabled with a TouchDesigner tooltip; no per-row fx button', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-viewport] canvas').first()).toBeVisible();
  const id = await hook<string>(page, 'addLayer');
  await hook(page, 'addFilterEffect', id, 'invert');
  const btn = page.locator(`[data-layer="${id}"] [data-act=flatten]`);
  await expect(btn).toHaveAttribute('aria-disabled', 'true');
  await expect(btn).toHaveAttribute('title', 'Flatten to pixels (needs TouchDesigner)');
  await expect(page.locator('[data-layer] [data-act=fx]')).toHaveCount(0);
});

test('screenshot for review: groups', async ({ page }) => {
  mkdirSync(REVIEW, { recursive: true });
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-viewport] canvas').first()).toBeVisible();
  await page.evaluate(() => {
    const e = (window as any).__editorTest.engine();
    e.addPixelLayer('Sky');
    const g = e.addGroup('Foreground');
    const tree = e.addPixelLayer('Tree'), grass = e.addPixelLayer('Grass');
    e.moveLayer(tree, g, 0); e.moveLayer(grass, g, 0);
    const props = e.addGroup('Props');
    e.moveLayer(props, g, 0);
    const rock = e.addPixelLayer('Rock');
    e.moveLayer(rock, props, 0);
    e.setActiveLayer(props);
    const hidden = e.addGroup('Collapsed');
    e.moveLayer(hidden, null, 0);
    e.moveLayer(e.addPixelLayer('Hidden A'), hidden, 0);
    e.setLayerProps(hidden, { expanded: false });
    e.setActiveLayer(tree);
  });
  // give the Layers panel the height of the whole column for the review image
  await page.evaluate(() => { const c = document.querySelector('[aria-label="Colour panels"]')?.parentElement as HTMLElement | undefined; if (c) c.style.display = 'none'; });
  await page.locator('[data-layer]', { hasText: 'Sky' }).locator('[data-act=sel]').click();
  await page.locator('[data-layer]', { hasText: 'Layer 1' }).locator('[data-act=sel]').click({ modifiers: ['Meta'] });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(REVIEW, 'layers-v7-after.png') });
});
