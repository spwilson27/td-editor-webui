import { expect, test, type Page } from '@playwright/test';
import type { LayerSpec } from '../../src/engine/types';
import { FakeTd } from './fakeTd';

let td: FakeTd;
test.beforeEach(async () => { td = await FakeTd.start({ w: 160, h: 90 }); });
test.afterEach(async () => { await td.close(); });

const open = async (page: Page, client: 'panel' | 'external' = 'panel') => {
  page.on('console', (m) => { if (process.env.DEBUG_E2E) console.log('[page]', m.type(), m.text()); });
  page.on('pageerror', (e) => { if (process.env.DEBUG_E2E) console.log('[pageerror]', e.message); });
  await page.goto(`/?test=1&client=${client}&ws=${encodeURIComponent(td.url)}&token=${td.token}`);
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const layer = (id: string, over: Partial<LayerSpec>): LayerSpec => ({
  id, kind: 'pixel', parentId: null, name: id, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, slot: null, mask: null, adjustment: null, ...over,
});
const baseLayer = () => layer('base', { kind: 'base', name: 'TD Input' });
const mainPixel = (page: Page, fx: number, fy: number) => page.locator('[data-viewport] canvas').first().evaluate((c: HTMLCanvasElement, [x, y]) => {
  return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * x), Math.round(c.height * y), 1, 1).data);
}, [fx, fy]);

test('a fresh page loads TD\'s stored document: layers, mask, adjustment and surface pixels', async ({ page }) => {
  td.seedDocument([
    baseLayer(),
    layer('paint', { name: 'Painted', slot: 4, mask: { slot: 5, enabled: true } }),
    layer('fx', { kind: 'adjustment', name: 'Levels', adjustment: { type: 'levels', inLow: 0.1, inHigh: 0.9, gamma: 1.4, outLow: 0, outHigh: 1 } }),
  ], 9, { 4: [200, 20, 30, 255], 5: [255, 255, 255, 255] });
  await open(page);
  await expect(page.getByRole('tab', { name: 'Adjustment' })).toHaveAttribute('aria-selected', 'true'); // the loaded active layer is the adjustment
  await page.getByRole('tab', { name: 'Layers' }).click();
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['Levels', 'Painted', 'TD Input']);
  await expect(page.locator('[data-layer="paint"] [data-act=mask]')).toBeVisible();
  await expect(page.locator('[data-layer="fx"] [data-adjust-icon]')).toBeVisible();
  expect(td.messages[0]).toMatchObject({ t: 'ready', fresh: true });
  expect(td.messages.some((m) => m.t === 'requestDoc')).toBe(true);
  await td.waitFor(() => td.surfaceFetches.includes(4) && td.surfaceFetches.includes(5));
  expect(td.docMessages).toBe(0); // the page loaded; it did not push its own default document
  expect(td.frames.length).toBe(0);
  const spec = await hook<any>(page, 'docSpec');
  expect(spec.layers.map((l: LayerSpec) => l.id)).toEqual(['base', 'paint', 'fx']);
  expect(spec.layers[2].adjustment).toMatchObject({ type: 'levels', gamma: 1.4 });
  // the red layer shows through the Levels adjustment in the local preview (non-zero red, no green dominance)
  const [r, g] = await hook<number[]>(page, 'readPixel', 40, 40);
  expect(r).toBeGreaterThan(g);
});

test('painting sends SURFACE tiles; adjustment + mask edits round-trip into the stored document', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);

  // mask on Layer 1 via the UI, then an adjustment via the footer menu
  await page.getByRole('button', { name: 'Add mask' }).click();
  await page.getByRole('button', { name: 'New adjustment' }).click();
  await page.getByRole('menuitem', { name: 'Blur' }).click();
  await expect(page.getByRole('tab', { name: 'Adjustment' })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Radius').fill('25');
  await td.waitFor(() => td.doc?.layers.some((l) => l.adjustment?.type === 'blur' && (l.adjustment as any).radius === 25) ?? false);
  const stored = td.doc!.layers;
  expect(stored.map((l) => l.kind)).toEqual(['base', 'pixel', 'adjustment']);
  const paintLayer = stored[1];
  expect(paintLayer.mask).toMatchObject({ enabled: true });
  expect(td.surfaces.has(paintLayer.mask!.slot)).toBe(true);
  expect(td.surfaces.has(paintLayer.slot!)).toBe(true);

  // paint on the mask: black pencil hides -> grey mask surface goes dark
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.locator('[data-layer] [data-act=mask]').first().click();
  await hook(page, 'setPrimary', '#000000');
  await hook(page, 'setTool', 'pencil');
  await page.locator('#bw').fill('8');
  const a = await hook<{ x: number; y: number }>(page, 'docToScreen', 30, 30);
  const b = await hook<{ x: number; y: number }>(page, 'docToScreen', 60, 30);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  const m = paintLayer.mask!.slot;
  await td.waitFor(() => td.surfacePixel(m, 45, 30)[0] < 40);
  expect(td.surfacePixel(m, 45, 30)[3]).toBe(255); // masks travel as grey RGBA, alpha 255
  expect(td.surfacePixel(m, 5, 80)[0]).toBe(255); // untouched mask stays white
  expect(td.frames.some((f) => f.slot === m)).toBe(true);
  expect(td.surfacePixel(paintLayer.slot!, 45, 30)).toEqual([0, 0, 0, 0]); // pixels untouched

  // shift-click disables the mask: the stored doc follows
  await page.locator('[data-layer] [data-act=mask]').first().click({ modifiers: ['Shift'] });
  await td.waitFor(() => td.doc?.layers[1].mask?.enabled === false);
  await expect(page.locator('[data-mask-off]')).toBeVisible();
});

test('latency readout fills in from TD applied replies', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  await expect(page.locator('[data-status=latency]')).toContainText('stroke → TD');
  await hook(page, 'setTool', 'pencil');
  const a = await hook<{ x: number; y: number }>(page, 'docToScreen', 20, 20);
  const b = await hook<{ x: number; y: number }>(page, 'docToScreen', 80, 40);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-status=latency]')).toContainText(/stroke → TD \d+ ms/);
  const lat = await hook<any>(page, 'latency');
  expect(lat.strokeToTd.n).toBeGreaterThan(0);
  expect(lat.strokeToTd.median).toBeGreaterThanOrEqual(0);
});

test('external client: TD view shows the image served by TD, Local restores the preview', async ({ page }) => {
  await open(page, 'external');
  await td.waitFor(() => td.doc !== null);
  expect(await mainPixel(page, 0.5, 0.5)).not.toEqual([10, 200, 30, 255]);
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.viewSubscribed);
  expect(td.lastView).toMatchObject({ t: 'view', mode: 'td' });
  const rgba = new Uint8Array(160 * 90 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 10; rgba[i + 1] = 200; rgba[i + 2] = 30; rgba[i + 3] = 255; }
  td.setViewImage(rgba);
  await expect.poll(() => mainPixel(page, 0.5, 0.5)).toEqual([10, 200, 30, 255]);
  await expect(page.locator('[data-status=view-age]')).toContainText('view age');
  expect(td.viewFetches.every((f) => f.status === 200)).toBe(true);
  // a newer TD frame replaces it
  const rgba2 = new Uint8Array(rgba).map((v, i) => (i % 4 === 0 ? 250 : i % 4 === 3 ? 255 : v));
  td.setViewImage(rgba2);
  await expect.poll(() => mainPixel(page, 0.5, 0.5)).toEqual([250, 200, 30, 255]);
  // painting in TD mode does not recomposite locally
  await page.locator('[data-view-mode=local]').click();
  await td.waitFor(() => td.lastView?.mode === 'local');
  await expect.poll(() => mainPixel(page, 0.5, 0.5)).not.toEqual([250, 200, 30, 255]);
});

test('panel client: TD view leaves the document rect transparent and reports the viewport to TD', async ({ page }) => {
  await open(page, 'panel');
  await td.waitFor(() => td.doc !== null);
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.lastView?.mode === 'td');
  expect(td.lastView!.zoom).toBeGreaterThan(0);
  expect(td.lastView!.rect.w).toBeGreaterThan(300);
  expect(td.viewFetches).toEqual([]); // the panel never pulls /view
  await expect.poll(() => mainPixel(page, 0.5, 0.5).then((p) => p[3])).toBe(0);
  const bg = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('[data-app-root]')!).backgroundColor]);
  expect(bg).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  // zoom changes are forwarded
  const z0 = td.lastView!.zoom;
  await page.keyboard.press('1');
  await td.waitFor(() => td.lastView!.zoom !== z0);
  expect(td.lastView!.zoom).toBe(1);
  await page.locator('[data-view-mode=local]').click();
  await expect.poll(() => mainPixel(page, 0.5, 0.5).then((p) => p[3])).toBe(255);
});

test('TD view needs a connection: toggle test hook refuses while standalone', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-view-mode=td]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('[data-view-mode=td]')).toHaveAttribute('title', /TouchDesigner/);
  expect(await hook<string>(page, 'setViewMode', 'td')).toBe('local');
  await expect(page.locator('[data-status=latency]')).toHaveCount(0);
});

test('test hook drives adjustments, masks and paint targets', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  const layers0 = await hook<any[]>(page, 'layers');
  const l1 = layers0.find((l) => l.kind === 'pixel').id as string;
  await hook(page, 'addMask', l1);
  const adj = await hook<string>(page, 'addAdjustment', 'threshold', { level: 0.25 });
  await hook(page, 'setPaintTarget', l1, 'mask');
  const st = await hook<any>(page, 'loadState');
  expect(st.paintTarget).toEqual({ layerId: l1, target: 'mask' });
  expect(st.docSpec.layers.find((l: LayerSpec) => l.id === adj).adjustment).toEqual({ type: 'threshold', level: 0.25 });
  await td.waitFor(() => td.doc?.layers.some((l) => l.id === adj) ?? false);
  expect(td.doc!.layers.find((l) => l.id === l1)!.mask).not.toBeNull();
});

// ---- TD's persisted document must never be overwritten by a page that has not loaded it ----

const seeded = () => {
  td.seedDocument([baseLayer(), layer('paint', { name: 'Painted', slot: 4 })], 9, { 4: [200, 20, 30, 255] });
};
const untouched = () => {
  expect(td.docMessages).toBe(0);
  expect(td.frames.length).toBe(0);
  expect(td.surfacePixel(4, 10, 10)).toEqual([200, 20, 30, 255]);
};

test('a slow TD (docState after 4 s) is waited for: nothing is pushed before the load, TD pixels stay intact', async ({ page }) => {
  seeded();
  td.docStateDelayMs = 4000;
  await open(page);
  await expect(page.locator('[data-loading-doc]')).toBeVisible();
  await page.waitForTimeout(3500); // beyond the old 3 s destructive fallback
  untouched();
  await expect(page.locator('[data-loading-doc]')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['Painted', 'TD Input']);
  untouched();
  await page.getByRole('button', { name: 'New pixel layer' }).click(); // now authoritative
  await td.waitFor(() => td.docMessages > 0);
});

test('editing is locked while the document loads (tools do not paint, keys are ignored)', async ({ page }) => {
  seeded();
  td.docStateDelayMs = 2500;
  await open(page);
  await expect(page.locator('[data-loading-doc]')).toBeVisible();
  expect((await hook<any>(page, 'loadState')).loadingDoc).toBe(true);
  await hook(page, 'setViewMode', 'td'); // switching view mid-load still reaches TD (the overlay blocks the mouse)
  await td.waitFor(() => td.lastView?.mode === 'td');
  await page.keyboard.press('e');
  expect((await hook<any>(page, 'state')).tool).toBe('brush');
  await page.waitForTimeout(100);
  untouched();
});

test('/surface 500: the page stays locked, retries the load, and never pushes; recovery completes the load', async ({ page }) => {
  seeded();
  td.surfaceStatus = 500;
  await open(page);
  await td.waitFor(() => td.requestDocs >= 2, 15000); // retried with backoff
  await expect(page.locator('[data-loading-doc]')).toBeVisible();
  // docSize during a failed load must not push empty surfaces over TD's pixels
  td.resize(80, 60);
  td.surfaces.set(4, new Uint8ClampedArray(80 * 60 * 4).fill(7));
  await page.waitForTimeout(800);
  expect(td.docMessages).toBe(0);
  expect(td.frames.length).toBe(0);
  // reconnect: still no push, load asked again
  const asked = td.requestDocs;
  td.dropClient();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked', { timeout: 8000 });
  await td.waitFor(() => td.requestDocs > asked);
  expect(td.docMessages).toBe(0);
  expect(td.frames.length).toBe(0);
  // TD recovers
  td.surfaceStatus = null;
  await expect(page.locator('[data-loading-doc]')).toBeHidden({ timeout: 15000 });
  expect(td.docMessages).toBe(0);
  expect(td.frames.length).toBe(0);
  expect(td.surfacePixel(4, 10, 10)).toEqual([7, 7, 7, 7]);
});

test('/surface 404 means TD has no pixels for that slot: the load completes', async ({ page }) => {
  seeded();
  td.surfaces.delete(4);
  await open(page);
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['Painted', 'TD Input']);
  await expect(page.locator('[data-loading-doc]')).toHaveCount(0);
  expect(td.surfaceFetches).toContain(4);
});

test('a reconnect that finds a newer TD document reloads it instead of overwriting it', async ({ page }) => {
  seeded();
  await open(page);
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['Painted', 'TD Input']);
  await expect(page.locator('[data-loading-doc]')).toHaveCount(0);
  const asked = td.requestDocs;
  td.doc!.rev = 500; // another client edited meanwhile
  td.doc!.layers = [baseLayer(), layer('other', { name: 'Edited elsewhere', slot: 4 })];
  td.dropClient();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked', { timeout: 8000 });
  await td.waitFor(() => td.requestDocs > asked);
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['Edited elsewhere', 'TD Input']);
  expect(td.docMessages).toBe(0);
  expect(td.frames.length).toBe(0);
});

test('moving a layer (nonzero x/y) sends a doc message and no SURFACE frames', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  await page.waitForTimeout(300);
  await hook(page, 'setTool', 'move');
  const frames = td.frames.length, docs = td.docMessages;
  const a = await hook<{ x: number; y: number }>(page, 'docToScreen', 40, 40);
  const b = await hook<{ x: number; y: number }>(page, 'docToScreen', 70, 55);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await td.waitFor(() => td.docMessages > docs && td.doc!.layers.some((l) => l.x !== 0 || l.y !== 0));
  await page.waitForTimeout(300);
  expect(td.frames.length).toBe(frames);
});
