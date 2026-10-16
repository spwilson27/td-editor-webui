import { expect, test, type Page } from '@playwright/test';
import type { LayerSpec } from '../../src/engine/types';
import { FakeTd } from './fakeTd';

let td: FakeTd;
test.beforeEach(async () => { td = await FakeTd.start({ w: 160, h: 90 }); });
test.afterEach(async () => { await td.close(); });

const open = async (page: Page) => {
  page.on('console', (m) => { if (process.env.DEBUG_E2E) console.log('[page]', m.type(), m.text()); });
  page.on('pageerror', (e) => { if (process.env.DEBUG_E2E) console.log('[pageerror]', e.message); });
  await page.goto(`/?test=1&ws=${encodeURIComponent(td.url)}#token=${td.token}`);
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const layer = (id: string, over: Partial<LayerSpec>): LayerSpec => ({
  id, kind: 'pixel', parentId: null, name: id, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, rot: 0, kx: 0, ky: 0, input: null, effects: [], slot: null, mask: null, adjustment: null, text: null, shape: null, sx: 1, sy: 1,
  surfaceW: !over.kind || over.kind === 'pixel' || over.kind === 'input' ? 160 : null, surfaceH: !over.kind || over.kind === 'pixel' || over.kind === 'input' ? 90 : null, ...over,
});
const baseLayer = () => layer('base', { kind: 'input', input: 1, name: 'TD Input' });
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
  await expect(page.getByRole('tab', { name: 'Layers' })).toHaveAttribute('aria-selected', 'true'); // a loaded adjustment does not steal the panel (only a newly created one opens Effects)
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
  expect(spec.layers[2].adjustment).toBeNull(); // v8: the legacy spec migrated to the layer's FX stack
  expect(spec.layers[2].effects[0]).toMatchObject({ type: 'levels', enabled: true, gamma: 1.4 });
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
  await page.locator('[data-new-adjustment=blur]').click();
  await expect(page.getByRole('tab', { name: 'Effects' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-fx-open]').click();
  await page.getByLabel('Radius').fill('25');
  await td.waitFor(() => td.doc?.layers.some((l) => l.kind === 'adjustment' && (l.effects as any[]).some((e) => e.type === 'blur' && e.radius === 25)) ?? false);
  const stored = td.doc!.layers;
  expect(stored.map((l) => l.kind)).toEqual(['input', 'pixel', 'adjustment']);
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

const tdPixel = (page: Page, x: number, y: number) => hook<number[] | null>(page, 'tdViewPixel', x, y);
const near = (a: number[] | null, b: number[], tol = 8) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('external client: TD view shows what TD streams (fast, then exact), Local restores the preview', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  expect(await mainPixel(page, 0.5, 0.5)).not.toEqual([10, 200, 30, 255]);
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.viewSubscribed);
  expect(td.lastView).toMatchObject({ t: 'view', mode: 'td', quality: 'auto' });
  // a fast frame: green JPEG over the whole document
  td.fastColor = 'green';
  td.sendFast();
  await expect.poll(() => tdPixel(page, 80, 45).then((p) => near(p, [0, 255, 0, 255]))).toBe(true);
  await expect(page.locator('[data-status=view-frame]')).toHaveText('≈');
  await expect(page.locator('[data-status=view-age]')).toContainText('view age');
  await td.waitFor(() => td.acks.length >= 1);
  // the exact frame lands after idle and replaces it, bit-exact
  const img = new Uint8Array(160 * 90 * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 10; img[i + 1] = 200; img[i + 2] = 30; img[i + 3] = 255; }
  td.setOutput(img);
  await expect(page.locator('[data-status=view-frame]')).toHaveText('exact');
  expect(await tdPixel(page, 80, 45)).toEqual([10, 200, 30, 255]);
  // a newer TD image replaces it
  img.forEach((_, i) => { if (i % 4 === 0) img[i] = 250; });
  td.setOutput(img);
  await expect.poll(() => tdPixel(page, 80, 45)).toEqual([250, 200, 30, 255]);
  await page.locator('[data-view-mode=local]').click();
  await td.waitFor(() => td.lastView?.mode === 'local');
  await expect(page.locator('[data-status=view-frame]')).toHaveCount(0);
  await expect.poll(() => mainPixel(page, 0.5, 0.5).then((p) => p[3])).toBe(255);
  expect(await mainPixel(page, 0.5, 0.5)).not.toEqual([250, 200, 30, 255]);
});

test('TD view reports the visible document rect and device-pixel scale to TD and forwards zoom changes', async ({ page }) => {
  await open(page);
  await td.waitFor(() => td.doc !== null);
  await page.locator('[data-view-mode=td]').click();
  await td.waitFor(() => td.lastView?.mode === 'td');
  const vp = () => (td.lastView as Extract<typeof td.lastView, { mode: 'td' }>).viewport;
  expect(vp()).toMatchObject({ x: 0, y: 0, w: 160, h: 90 }); // fit: the whole document
  const s0 = vp().scale;
  expect(s0).toBeGreaterThan(0);
  await page.keyboard.press('1');
  await td.waitFor(() => vp().scale !== s0);
  expect(vp().scale).toBe(await page.evaluate(() => window.devicePixelRatio)); // zoom 100 % x dpr
  for (let i = 0; i < 12; i++) await page.keyboard.press('+'); // 1.25^12: the document no longer fits the viewport
  await td.waitFor(() => vp().w < 160);
  expect(vp().w).toBeLessThan(160);
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
  expect(st.docSpec.layers.find((l: LayerSpec) => l.id === adj).effects).toMatchObject([{ type: 'threshold', enabled: true, level: 0.25 }]);
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
  td.surfaces.set(4, new Uint8ClampedArray(160 * 90 * 4).fill(7)); // surfaces keep their own size when the document resizes
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
  // v6: the input resized to 80x60 while the load failed; once loaded, that correction of the input layer is the only thing pushed (a doc, never pixels)
  expect(td.docMessages).toBeLessThanOrEqual(1);
  if (td.docMessages === 1) expect(td.doc!.layers.find((l) => l.kind === 'input')).toMatchObject({ surfaceW: 80, surfaceH: 60 });
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
