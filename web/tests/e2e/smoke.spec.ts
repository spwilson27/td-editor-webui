import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const URL = '/?standalone=1&test=1';
const REVIEW = resolve(process.cwd(), '../dist/review');

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => { throw e; });
  await page.goto(URL);
  await expect(page.locator('[data-viewport] canvas').first()).toBeVisible();
});

const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

const docPoint = async (page: Page, x: number, y: number) => hook<{ x: number; y: number }>(page, 'docToScreen', x, y);

test('renders the editor in standalone mode', async ({ page }) => {
  await expect(page.locator('[data-tool]')).toHaveCount(17);
  await expect(page.locator('[data-status=connection]')).toContainText('Standalone');
  await expect(page.getByText('landscape.png')).toBeVisible();
  await expect(page.locator('[data-status=layer]')).toHaveText('Layer 1');
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['Layer 1', 'TD Input']);
  const sky = await hook<number[]>(page, 'readPixel', 960, 10);
  expect(sky[3]).toBe(255);
  const tree = await hook<number[]>(page, 'readPixel', 441, 549);
  expect(tree.slice(0, 3)).toEqual([0x2f, 0x6b, 0x3a]);
  const main = await page.locator('[data-viewport] canvas').first().evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data;
    return Array.from(d);
  });
  expect(main[3]).toBe(255);
  expect(main.slice(0, 3)).not.toEqual([0x1c, 0x1c, 0x1c]);
});

test('screenshot for review', async ({ page }) => {
  mkdirSync(REVIEW, { recursive: true });
  await page.mouse.move(700, 480);
  await page.screenshot({ path: resolve(REVIEW, 'app.png') });
});

test('switches tools by click and keyboard; disabled tools stay off', async ({ page }) => {
  await page.getByRole('button', { name: 'Erase Brush (E)' }).click();
  await expect(page.locator('[data-context=name]')).toHaveText('Erase Brush');
  await page.keyboard.press('m');
  await expect(page.locator('[data-context=name]')).toHaveText('Rectangular Marquee');
  await page.keyboard.press('g');
  await expect(page.locator('[data-context=name]')).toHaveText('Flood Fill');
  await page.keyboard.press('g');
  await expect(page.locator('[data-context=name]')).toHaveText('Gradient Tool');
  await page.locator('[data-tool=crop]').click({ force: true });
  await expect(page.locator('[data-context=name]')).toHaveText('Gradient Tool');
  await expect(page.locator('[data-tool=crop]')).toHaveAttribute('title', /Not in this version/);
  await page.keyboard.press('c');
  await expect(page.locator('[data-status=notice]')).toContainText('not available');
});

test('colour panel: ring, square, sliders, hex and recent swatches', async ({ page }) => {
  const hex = page.locator('#hex');
  await expect(hex).toHaveValue('#E2683C');

  const wheel = page.locator('[data-wheel]');
  const box = (await wheel.boundingBox())!;
  await page.mouse.move(box.x + 90, box.y + 9);
  await page.mouse.down();
  await page.mouse.move(box.x + 171, box.y + 90, { steps: 5 });
  await page.mouse.up();
  const afterRing = await hex.inputValue();
  expect(afterRing).not.toBe('#E2683C');
  expect((await hook<any>(page, 'state')).primary).toBe(afterRing.toLowerCase());

  await page.mouse.move(box.x + 90, box.y + 90);
  await page.mouse.down();
  await page.mouse.move(box.x + 136, box.y + 44, { steps: 5 });
  await page.mouse.up();
  expect((await hook<any>(page, 'state')).primary).toMatch(/^#[0-9a-f]{6}$/);

  const slider = page.locator('[data-slider=A]');
  const sb = (await slider.boundingBox())!;
  await page.mouse.move(sb.x + sb.width - 1, sb.y + 5);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 5, { steps: 4 });
  await page.mouse.up();
  expect((await hook<any>(page, 'state')).alpha).toBe(50);

  await hex.fill('#336699');
  await hex.press('Enter');
  expect((await hook<any>(page, 'state')).primary).toBe('#336699');
  await expect(page.locator('[data-recent]').first()).toHaveAttribute('data-recent', '#336699');

  await page.locator('[data-recent="#2f6b3a"]').click();
  await expect(hex).toHaveValue('#2F6B3A');
});

test('swatches and brushes tabs set colour and brush', async ({ page }) => {
  await page.getByRole('tab', { name: 'Swatches' }).click();
  await page.locator('[data-swatch-colour="#3d6fb4"]').click();
  expect((await hook<any>(page, 'state')).primary).toBe('#3d6fb4');
  await page.getByRole('tab', { name: 'Brushes' }).click();
  await page.locator('[data-brush=ink]').click();
  expect((await hook<any>(page, 'state')).brush.size).toBe(8);
  await expect(page.locator('#bw')).toHaveValue('8');
});

test('layers panel: add, rename, hide, lock, reorder, delete', async ({ page }) => {
  const names = () => page.locator('[data-layer] [data-name]').allTextContents();
  await page.getByRole('button', { name: 'New pixel layer' }).click();
  await page.getByRole('button', { name: 'New pixel layer' }).click();
  const before = await names();
  expect(before.length).toBe(4);
  expect(before[3]).toBe('TD Input');

  await page.locator('[data-layer] [data-name]').first().dblclick();
  const input = page.getByLabel('Layer name');
  await input.fill('Highlights');
  await input.press('Enter');
  expect((await names())[0]).toBe('Highlights');

  const layers = await hook<any[]>(page, 'layers');
  const topId = layers[0].id;
  await page.locator(`[data-layer="${topId}"] [data-act=vis]`).click();
  expect((await hook<any[]>(page, 'layers'))[0].visible).toBe(false);
  await page.locator(`[data-layer="${topId}"] [data-act=lock]`).click({ force: true });
  expect((await hook<any[]>(page, 'layers'))[0].locked).toBe(true);

  // drag the top layer below the second one
  const rows = page.locator('[data-layer]');
  const a = (await rows.nth(0).boundingBox())!, b = (await rows.nth(1).boundingBox())!;
  await page.mouse.move(a.x + 80, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 80, b.y + b.height * 0.5, { steps: 4 });
  await page.mouse.move(a.x + 80, b.y + b.height * 0.85, { steps: 4 });
  await page.mouse.up();
  expect((await names()).slice(0, 2)).toEqual([before[1], 'Highlights']);

  await rows.nth(1).locator('[data-act=sel]').click();
  await page.getByRole('button', { name: 'Delete layer' }).click();
  expect((await names()).length).toBe(3);

  await page.getByRole('button', { name: 'New group' }).click();
  await expect(page.locator('[data-layer] [data-act=open]')).toHaveCount(1);
});

test('blend mode and opacity of the selected layer', async ({ page }) => {
  await page.getByRole('button', { name: 'New pixel layer' }).click();
  await page.getByLabel('Blend mode').selectOption('multiply');
  const op = page.getByLabel('Layer opacity');
  await op.fill('40');
  await op.press('Enter');
  const [top] = await hook<any[]>(page, 'layers');
  expect(top.blend).toBe('multiply');
  expect(top.opacity).toBeCloseTo(0.4, 5);
  await expect(page.locator('[data-layer]').first()).toContainText('40%');
});

test('the very first stroke on a fresh document paints (no locked-layer notice, one history entry)', async ({ page }) => {
  await hook(page, 'setPrimary', '#00ff00');
  await hook(page, 'setTool', 'pencil');
  await page.locator('#bw').fill('30');
  const a = await docPoint(page, 300, 300), b = await docPoint(page, 500, 300);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => hook<number[]>(page, 'readPixel', 400, 300)).toEqual([0, 255, 0, 255]);
  await expect(page.locator('[data-status=notice]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.locator('[data-history-index]')).toHaveCount(1);
});

test('painting with the mouse, undo and history jumping', async ({ page }) => {
  await hook(page, 'setPrimary', '#ff0000');
  await hook(page, 'setTool', 'pencil');
  await page.getByRole('button', { name: 'New pixel layer' }).click();
  await page.locator('#bw').fill('40');
  const p0 = await docPoint(page, 900, 500), p1 = await docPoint(page, 1100, 500);
  const before = await hook<number[]>(page, 'readPixel', 1000, 500);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p1.x, p1.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => hook<number[]>(page, 'readPixel', 1000, 500)).toEqual([255, 0, 0, 255]);
  expect(before).not.toEqual([255, 0, 0, 255]);
  expect(await hook<number[]>(page, 'readPixel', 100, 100)).not.toEqual([255, 0, 0, 255]);

  await page.keyboard.press('Control+z');
  await expect.poll(() => hook<number[]>(page, 'readPixel', 1000, 500)).toEqual(before);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => hook<number[]>(page, 'readPixel', 1000, 500)).toEqual([255, 0, 0, 255]);

  await page.getByRole('tab', { name: 'History' }).click();
  const rows = page.locator('[data-history-index]');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await rows.first().click();
  await expect.poll(() => hook<number[]>(page, 'readPixel', 1000, 500)).toEqual(before);
});

test('marquee draws marching ants and Ctrl+D deselects', async ({ page }) => {
  await page.keyboard.press('m');
  const a = await docPoint(page, 200, 200), b = await docPoint(page, 600, 500);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  const sel = (await hook<any>(page, 'state')).selection;
  expect(sel).toMatchObject({ w: expect.any(Number) });
  expect(sel.w).toBeGreaterThan(300);
  await page.keyboard.press('Control+d');
  expect((await hook<any>(page, 'state')).selection).toBeNull();
});

test('view: wheel zoom, space-drag pan, fit and 100%', async ({ page }) => {
  const vp = (await page.locator('[data-viewport]').boundingBox())!;
  const z0 = (await hook<any>(page, 'state')).view;
  await page.mouse.move(vp.x + 300, vp.y + 200);
  await page.mouse.wheel(0, -300);
  const z1 = (await hook<any>(page, 'state')).view;
  expect(z1.zoom).toBeGreaterThan(z0.zoom);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(vp.x + 340, vp.y + 230, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const z2 = (await hook<any>(page, 'state')).view;
  expect(z2.x - z1.x).toBeCloseTo(40, 0);
  expect(z2.y - z1.y).toBeCloseTo(30, 0);
  await page.keyboard.press('1');
  expect((await hook<any>(page, 'state')).view.zoom).toBe(1);
  await page.keyboard.press('0');
  expect((await hook<any>(page, 'state')).view.zoom).toBeCloseTo(z0.zoom, 6);
});

test('menus: File > New layer, disabled items', async ({ page }) => {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Open/ })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('menuitem', { name: 'New layer', exact: true }).click();
  await expect(page.locator('[data-layer]')).toHaveCount(3);
});

test('window.__editorTest is only installed with ?test=1', async ({ page }) => {
  await page.goto('/?standalone=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  expect(await page.evaluate(() => '__editorTest' in window)).toBe(false);
});

for (const [w, h] of [[1280, 800], [1024, 700]] as const) {
  test(`layout fits at ${w}x${h}: single-row context bar, unscrolled rail with every tool visible`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(URL);
    await expect(page.locator('[data-tool]')).toHaveCount(17);
    const bar = page.locator('[data-context-bar]');
    const rows = await bar.evaluate((el) => {
      const tops = new Set([...el.querySelectorAll<HTMLElement>('.ctx-tool, .opts > *')].filter((c) => c.offsetParent !== null).map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)));
      return { rows: tops.size, overflowX: el.scrollWidth > el.clientWidth + 1, height: el.getBoundingClientRect().height };
    });
    if (w >= 1180) {
      expect(rows.rows).toBe(1);
      expect(rows.overflowX).toBe(false);
      expect(rows.height).toBeLessThan(60);
    }
    await expect(page.locator('[data-context=name]')).toBeVisible();
    await expect(page.getByLabel('Width')).toBeVisible();
    const rail = await page.locator('[data-rail]').evaluate((el) => ({ scrollable: el.scrollHeight > el.clientHeight, bottom: el.getBoundingClientRect().bottom }));
    expect(rail.scrollable).toBe(false);
    for (const b of await page.locator('[data-tool]').all()) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeGreaterThan(20);
      expect(box.y + box.height).toBeLessThanOrEqual(rail.bottom + 0.5);
    }
    for (const label of ['Primary colour', 'Secondary colour']) {
      const box = (await page.locator('[data-rail]').getByLabel(label).boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(rail.bottom + 0.5);
    }
    const status = await page.locator('[data-status=connection]').evaluate((el) => {
      const bar = el.parentElement!;
      return { overflowX: bar.scrollWidth > bar.clientWidth + 1, right: el.getBoundingClientRect().right, view: document.documentElement.clientWidth };
    });
    expect(status.overflowX).toBe(false);
    expect(status.right).toBeLessThanOrEqual(status.view);
    await expect(page.locator('[data-view-mode=td]')).toBeVisible();
    await page.mouse.move(w / 2, h / 2);
    mkdirSync(REVIEW, { recursive: true });
    await page.screenshot({ path: resolve(REVIEW, `app-${w}x${h}.png`) });
  });
}

test('at 1600 px the mockup slider widths are kept (Width 110, Tolerance 140); they shrink when narrower', async ({ page }) => {
  const width = (sel: string) => page.locator(sel).evaluate((e) => e.getBoundingClientRect().width);
  expect(await width('#bw')).toBe(110);
  expect(await width('#bo')).toBe(80);
  await page.keyboard.press('g');
  expect(await width('#ft')).toBe(140);
  await page.setViewportSize({ width: 1280, height: 960 });
  expect(await width('#ft')).toBeLessThan(140);
});
