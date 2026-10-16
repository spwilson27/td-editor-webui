import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v6 phase B over protocol 7: filters in the document, filter adjustments, undo history persisted in TD, layer previews, brush presets in the document.
let td: FakeTd;
test.afterEach(async () => { await td.close(); });

const url = (td: FakeTd) => `/?test=1&ws=${encodeURIComponent(td.url)}#token=${td.token}`;
const open = async (page: Page, opts: Parameters<typeof FakeTd.start>[0] = { w: 160, h: 90 }, prep?: (t: FakeTd) => void) => {
  td = await FakeTd.start(opts);
  prep?.(td);
  page.on('pageerror', (e) => { throw e; });
  await page.goto(url(td));
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await td.waitFor(() => td.doc !== null);
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const layers = (page: Page) => hook<any[]>(page, 'layers');
const pixelLayer = async (page: Page) => (await layers(page)).find((l) => l.kind === 'pixel').id as string;

test('protocol 7 hello, activeLayer follows the active layer', async ({ page }) => {
  await open(page);
  expect(td.messages[0]).toMatchObject({ t: 'ready', protocol: 11 });
  const id = await hook<string>(page, 'addLayer');
  await td.waitFor(() => td.activeLayers.includes(id));
  const other = (await layers(page)).find((l) => l.id !== id)!.id;
  await page.evaluate((i) => (window as any).__editorTest.engine().setActiveLayer(i), other);
  await td.waitFor(() => td.activeLayers.at(-1) === other);
});

test('filter effect round trip: TD stores it verbatim and a fresh page gets it back', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  const id = await pixelLayer(page);
  await hook(page, 'addFilterEffect', id, 'unsharp', { amount: 180, radius: 7 });
  await hook(page, 'addFilterEffect', id, 'gradientMap');
  await td.waitFor(() => (td.doc?.layers.find((l) => l.id === id)?.effects.length ?? 0) === 2);
  const stored = td.doc!.layers.find((l) => l.id === id)!.effects as any[];
  expect(stored[0]).toMatchObject({ type: 'unsharp', enabled: true, amount: 180, radius: 7, threshold: 0 });
  expect(stored[1].stops).toEqual([{ pos: 0, color: { r: 0, g: 0, b: 0, a: 255 } }, { pos: 1, color: { r: 255, g: 255, b: 255, a: 255 } }]);
  await page.reload();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await expect.poll(async () => ((await layers(page)).find((l) => l.id === id)?.effects ?? []).map((e: any) => e.type)).toEqual(['unsharp', 'gradientMap']);
  expect(((await layers(page)).find((l) => l.id === id)!.effects[0] as any).amount).toBe(180);
});

test('adjustment layer reaches TD as an FX stack (effects[]) and survives a reload', async ({ page }) => {
  await open(page);
  const id = await hook<string>(page, 'addFilterAdjustment', 'posterize', { levels: 5 });
  await td.waitFor(() => !!td.doc?.layers.find((l) => l.id === id && l.kind === 'adjustment' && (l.effects as any[])[0]?.type === 'posterize'));
  expect(td.doc!.layers.find((l) => l.id === id)!.effects).toMatchObject([{ type: 'posterize', enabled: true, levels: 5 }]); // v8: the FX stack is the adjustment
  await page.reload();
  await expect.poll(async () => (await layers(page)).find((l) => l.id === id)?.effects?.[0]?.levels).toBe(5);
  await expect(page.locator(`[data-layer="${id}"]`)).toBeVisible();
});

test('the Layer menu creates filter adjustments in the browser UI', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Layer', exact: true }).click();
  await page.locator('[data-flyout=adjustments]').click();
  await page.locator('[data-new-adjustment=vibrance]').click();
  await td.waitFor(() => !!td.doc?.layers.some((l) => l.kind === 'adjustment' && (l.effects as any[])[0]?.type === 'vibrance'));
  await expect(page.locator('[data-effects-panel] [data-effect=vibrance]')).toBeVisible();
});

test('undo history is uploaded to TD (rev of the stored document) and persists across a page reload: undo works afterwards', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  await hook(page, 'setPrimary', '#ff0000');
  await hook(page, 'stroke', 'brush', [[20, 20], [100, 20]]);
  const before = await hook<{ length: number; index: number }>(page, 'history');
  expect(before.length).toBeGreaterThanOrEqual(2);
  await td.waitFor(() => td.historyPosts.length > 0 && td.doc !== null && td.historyBlob?.rev === td.doc.rev, 8000);
  expect(td.historyBlob!.bytes.length).toBeGreaterThan(8);
  expect(td.historyPosts.every((p) => p.client.startsWith('client-'))).toBe(true);
  // the stroke's surface has been sent as well
  await td.waitFor(() => td.frameEnds > 0);
  const px = await hook<number[]>(page, 'readPixel', 60, 20);
  expect(px[0]).toBeGreaterThan(200);

  await page.reload();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await td.waitFor(() => td.historyGets.some((g) => g.status === 200));
  await expect.poll(async () => (await hook<{ length: number }>(page, 'history')).length, { timeout: 8000 }).toBe(before.length);
  expect((await hook<{ index: number }>(page, 'history')).index).toBe(before.index);
  // undo the stroke after the reload
  await expect.poll(() => hook<number[]>(page, 'readPixel', 60, 20)).toEqual(expect.arrayContaining([255]));
  await hook(page, 'undo');
  await expect.poll(async () => (await hook<number[]>(page, 'readPixel', 60, 20))[3]).toBe(0);
});

test('history is not restored for a different revision of the document (empty history after reload)', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  await td.waitFor(() => td.historyBlob !== null, 8000);
  td.historyBlob = { ...td.historyBlob!, rev: td.historyBlob!.rev + 100 };
  await page.reload();
  await td.waitFor(() => td.historyGets.length > 0);
  await page.waitForTimeout(500);
  expect((await hook<{ length: number }>(page, 'history')).length).toBeLessThanOrEqual(1);
});

test('Save Project sends the pending history before the saveProject request', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  const saved = hook<any>(page, 'saveProject');
  expect((await saved).ok).toBe(true);
  expect(td.events.indexOf('history POST')).toBeGreaterThanOrEqual(0);
  expect(td.events.indexOf('history POST')).toBeLessThan(td.events.indexOf('saveProject'));
  expect(td.savedFiles.get(td.projectFile)!.history).not.toBeNull();
});

test('layerPreview notices are fetched over /layer (frame type 7) and handed to the engine', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  const id = await pixelLayer(page);
  td.setLayerPreview(id);
  await td.waitFor(() => td.layerFetches.some((f) => f.layerId === id && f.status === 200));
  expect(td.layerNotices.map((n) => n.layerId)).toEqual([id]);
  // a newer image is announced after the first was fetched
  td.setLayerPreview(id);
  await td.waitFor(() => td.layerFetches.filter((f) => f.layerId === id).length >= 2);
});

test('layer preview substitution is visible: a pixelSort layer shows TD\'s render instead of the browser\'s own result', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  const id = await pixelLayer(page);
  await hook(page, 'addFilterEffect', id, 'pixelSort'); // v5 effect the browser cannot match: flagged tdPreview
  await expect.poll(async () => (await hook<{ layers: string[] }>(page, 'layerPreviews')).layers).toContain(id);
  await expect(page.locator(`[data-layer="${id}"] [data-td-render]`)).toContainText('pending');
  td.setLayerPreview(id); // blue 200 everywhere, red / green ramps
  await expect(page.locator(`[data-layer="${id}"] [data-td-render]`)).not.toContainText('pending');
  await hook(page, 'setViewMode', 'local');
  await expect.poll(async () => (await hook<number[]>(page, 'readPixel', 80, 45))[2]).toBeGreaterThan(150);
  const px = await hook<number[]>(page, 'readPixel', 159, 0);
  expect(px[0]).toBeGreaterThan(240); // red ramps with x
});

test('Save Project without undo history: includeHistory false reaches TD and the file has no history', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  await td.waitFor(() => td.historyBlob !== null, 8000);
  expect((await hook<any>(page, 'saveProject', '/tmp/a.redoc', false)).ok).toBe(true);
  expect((await hook<any>(page, 'saveProject', '/tmp/b.redoc', true)).ok).toBe(true);
  expect(td.saveHistoryFlags).toEqual([false, true]);
  expect(td.savedFiles.get('/tmp/a.redoc')!.history).toBeNull();
  expect(td.savedFiles.get('/tmp/b.redoc')!.history).not.toBeNull();
});

test('Clear stored undo history empties the history TD keeps', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  await td.waitFor(() => td.historyBlob !== null, 8000);
  expect(await hook<boolean>(page, 'clearStoredHistory')).toBe(true);
  expect(td.historyBlob).toBeNull();
});

test('brush presets saved in the document reach TD and come back after a reload', async ({ page }) => {
  await open(page);
  await hook(page, 'setBrushTip', 'star', { scatter: 1.5, scatterCount: 3, seed: 5 });
  const key = await hook<string>(page, 'saveBrushPreset', 'Stars in file', 'document');
  expect(key).toMatch(/^doc:/);
  await td.waitFor(() => (td.doc?.brushPresets?.length ?? 0) === 1);
  expect(td.doc!.brushPresets![0]).toMatchObject({ name: 'Stars in file', tip: 'star', dynamics: { scatter: 1.5, scatterCount: 3, seed: 5 } });
  await page.reload();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await expect.poll(async () => (await hook<any[]>(page, 'brushPresets')).filter((p) => p.source === 'document').map((p) => p.name)).toEqual(['Stars in file']);
  await page.locator('[role=tab]', { hasText: 'Brushes' }).click();
  await expect(page.locator('[data-preset-section=document] [data-brush-name]')).toHaveText('Stars in file');
});

test('user presets live in this browser only (localStorage), not in TD', async ({ page }) => {
  await open(page);
  await hook(page, 'saveBrushPreset', 'Only mine', 'user');
  await page.waitForTimeout(300);
  expect(td.doc?.brushPresets ?? []).toEqual([]);
  await page.reload();
  await expect.poll(async () => (await hook<any[]>(page, 'brushPresets')).filter((p) => p.source === 'user').map((p) => p.name)).toEqual(['Only mine']);
});

test('big document notice is suggested, not automatic', async ({ page }) => {
  await open(page, { w: 3200, h: 2600 });
  await expect(page.locator('[data-bigdoc-notice]')).toBeVisible();
  expect(await hook(page, 'setViewMode', 'local')).toBe('local');
  await page.locator('[data-bigdoc-dismiss]').click();
  await expect(page.locator('[data-bigdoc-notice]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await expect(page.locator('[data-bigdoc-notice]')).toHaveCount(0);
});

test('Open Project while the page is disconnected: on reconnect the page loads TD\'s document and never pushes over it', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  await td.waitFor(() => (td.doc?.layers.length ?? 0) >= 2);
  const docs = td.docMessages;
  const stored = JSON.parse(JSON.stringify(td.doc)) as NonNullable<typeof td.doc>;
  // the page loses the socket; meanwhile "Open Project" replaced TD's document (other layers, rebased revision)
  const replaced = { ...stored, rev: stored.rev + 40, layers: stored.layers.map((l: any) => (l.kind === 'pixel' ? { ...l, name: 'From the opened file' } : l)) };
  td.doc = replaced;
  td.dropClient();
  await expect.poll(async () => (await layers(page)).some((l) => l.name === 'From the opened file'), { timeout: 15000 }).toBe(true);
  expect(td.docMessages).toBe(docs); // nothing was pushed over TD's document
  expect(td.doc!.rev).toBe(replaced.rev);
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
});

test('a reconnect to the same revision keeps the page\'s offline edits and sends them', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  await td.waitFor(() => (td.doc?.layers.length ?? 0) >= 2);
  td.dropClient();
  const id = await hook<string>(page, 'addLayer'); // offline edit
  await td.waitFor(() => !!td.doc?.layers.some((l) => l.id === id), 15000);
});
