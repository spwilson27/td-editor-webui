import { expect, test, type Page } from '@playwright/test';
import type { Effect } from '../../src/engine/types';
import { FakeTd } from './fakeTd';

// v5 features over protocol 6: several TD inputs, effects, files (save / open + reload), crop, rotate / skew. The fake TD is the v6 one.
let td: FakeTd;
test.afterEach(async () => { await td.close(); });

const open = async (page: Page, opts: Parameters<typeof FakeTd.start>[0] = { w: 160, h: 90 }, prep?: (t: FakeTd) => void) => {
  td = await FakeTd.start(opts);
  prep?.(td);
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`/?test=1&client=panel&ws=${encodeURIComponent(td.url)}&token=${td.token}`);
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await td.waitFor(() => td.doc !== null);
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const layers = (page: Page) => hook<any[]>(page, 'layers');
const state = (page: Page) => hook<any>(page, 'state');
const overlay = (page: Page) => page.locator('[data-loading-doc]');

const overlayFx: Effect = { enabled: true, type: 'colorOverlay', color: { r: 255, g: 0, b: 0, a: 255 }, opacity: 0.5 };
const shadowFx: Effect = { enabled: false, type: 'dropShadow', dx: 4, dy: 6, blur: 3, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 0.75 };

test('two inputs appear as two input layers and each BASE frame lands in its own input', async ({ page }) => {
  await open(page, { w: 160, h: 90, hasInput: true, inputs: [{ input: 1, w: 160, h: 90 }, { input: 2, w: 80, h: 40 }] });
  await expect.poll(async () => (await layers(page)).filter((l) => l.kind === 'input').map((l) => l.input).sort()).toEqual([1, 2]);
  expect(await hook<any[]>(page, 'inputs')).toEqual([{ input: 1, w: 160, h: 90, connected: true }, { input: 2, w: 80, h: 40, connected: true }]);
  const ls = (await layers(page)).filter((l) => l.kind === 'input');
  expect(ls.map((l) => l.input).sort()).toEqual([1, 2]);
  expect((await state(page)).doc).toEqual({ w: 160, h: 90 });
  const stored = td.doc?.layers.filter((l) => l.kind === 'input') ?? [];
  if (stored.length) expect(stored.map((l) => l.input).sort()).toEqual([1, 2]);

  td.sendSolidBase(200, 10, 10, 1);
  td.sendSolidBase(10, 10, 200, 2);
  await td.waitFor(() => td.fetches.some((f) => f.input === 1 && f.status === 200) && td.fetches.some((f) => f.input === 2 && f.status === 200));
  expect(td.fetches.every((f) => f.input === 1 || f.input === 2)).toBe(true);
  const l1 = ls.find((l) => l.input === 1)!, l2 = ls.find((l) => l.input === 2)!;
  // only input 2 visible: its (fitted) area is blue, the rest transparent; only input 1 visible: red everywhere
  await hook(page, 'setLayerVisible', l1.id, false);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 10, 10)).toEqual([10, 10, 200, 255]);
  // the engine fits a new input layer to the canvas keeping the aspect ratio (80x40 -> 160x80, y offset 5): row y=2 stays empty
  expect((await hook<number[]>(page, 'readPixel', 120, 2))[3]).toBe(0);
  await hook(page, 'setLayerVisible', l1.id, true);
  await hook(page, 'setLayerVisible', l2.id, false);
  await expect.poll(() => hook<number[]>(page, 'readPixel', 120, 2)).toEqual([200, 10, 10, 255]);
  expect(await hook<number[]>(page, 'readPixel', 10, 10)).toEqual([200, 10, 10, 255]);

  // one resolution change touches only that input
  td.resize(40, 20, 2);
  await expect.poll(() => hook<any[]>(page, 'inputs')).toEqual([{ input: 1, w: 160, h: 90, connected: true }, { input: 2, w: 40, h: 20, connected: true }]);
  expect((await state(page)).doc).toEqual({ w: 160, h: 90 });
});

test('effects round trip: setEffects reaches the fake TD verbatim and a fresh page gets them back', async ({ page }) => {
  await open(page);
  const id = await hook<string>(page, 'addLayer').then(async () => (await layers(page)).find((l) => l.kind === 'pixel').id as string);
  await hook(page, 'setEffects', id, [overlayFx, shadowFx]);
  await td.waitFor(() => (td.doc?.layers.find((l) => l.id === id)?.effects?.length ?? 0) === 2);
  expect(td.doc!.layers.find((l) => l.id === id)!.effects).toEqual([overlayFx, shadowFx]);
  await page.reload();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await expect.poll(async () => (await layers(page)).find((l) => l.id === id)?.effects).toEqual([overlayFx, shadowFx]);
  expect(await hook<any>(page, 'docSpec').then((d) => d.layers.find((l: any) => l.id === id).effects)).toEqual([overlayFx, shadowFx]);
});

test('save then open project through TD: reload flow shows the loading overlay and restores the saved document', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  const paintId = (await layers(page)).find((l) => l.kind === 'pixel').id as string;
  await hook(page, 'stroke', 'brush', [[20, 20], [60, 20], [60, 50]]);
  await td.waitFor(() => td.frameEnds >= 1);
  const countAtSave = (await layers(page)).length;

  const saved = await hook<any>(page, 'saveProject', '/tmp/e2e-a.redoc');
  expect(saved).toMatchObject({ op: 'saveProject', ok: true, path: '/tmp/e2e-a.redoc' });
  const file = td.savedFiles.get('/tmp/e2e-a.redoc')!;
  expect(file.doc.layers.map((l) => l.id)).toContain(paintId);
  expect([...file.surfaces.values()].some((s) => s.some((v) => v !== 0))).toBe(true); // the stroke was flushed to TD before it wrote the file

  // change the document afterwards, then open the saved project
  await hook(page, 'addLayer');
  await td.waitFor(() => (td.doc?.layers.length ?? 0) === countAtSave + 1);
  const requests = td.requestDocs;
  td.docStateDelayMs = 700; // a slow TD keeps the overlay visible
  const opened = await hook<any>(page, 'openProject', '/tmp/e2e-a.redoc');
  expect(opened).toMatchObject({ op: 'openProject', ok: true });
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toBeHidden({ timeout: 8000 });
  expect(td.requestDocs).toBeGreaterThan(requests);
  await expect.poll(async () => (await layers(page)).length).toBe(countAtSave);
  expect((await layers(page)).some((l) => l.id === paintId)).toBe(true);
  // editing works again and is pushed
  const docs = td.docMessages;
  await hook(page, 'addLayer');
  await td.waitFor(() => td.docMessages > docs);

  // export and a failing open report TD's answer
  expect(await hook<any>(page, 'exportPng', '/tmp/e2e-a.png')).toMatchObject({ op: 'exportPng', ok: true, path: '/tmp/e2e-a.png' });
  expect(td.exportedPngs).toEqual(['/tmp/e2e-a.png']);
  expect(await hook<any>(page, 'openProject', '/tmp/missing.redoc')).toMatchObject({ op: 'openProject', ok: false });
  await expect.poll(() => hook<any>(page, 'files')).toMatchObject({ projectFile: '/tmp/missing.redoc', pngFile: '/tmp/e2e-a.png' });
});

test('crop shrinks the document and tells TD (doc message, fixed canvas)', async ({ page }) => {
  await open(page);
  const docs = td.docMessages;
  await hook(page, 'crop', { x: 10, y: 10, w: 100, h: 50 });
  await expect.poll(async () => (await state(page)).doc).toEqual({ w: 100, h: 50 });
  await td.waitFor(() => td.docMessages > docs);
  await td.waitFor(() => td.setCanvasMessages.some((m) => m.w === 100 && m.h === 50 && m.mode === 'fixed'));
  expect(td.doc!.canvas.mode).toBe('fixed');
  expect(await hook<string>(page, 'canvasMode')).toBe('fixed');
});

test('rotation and skew round trip through the stored document', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  const id = (await layers(page)).find((l) => l.kind === 'pixel').id as string;
  await hook(page, 'setTransform', id, { x: 5, y: 6, sx: 1.5, rot: 30, kx: 10, ky: -5 });
  await td.waitFor(() => td.doc?.layers.find((l) => l.id === id)?.rot === 30);
  expect(td.doc!.layers.find((l) => l.id === id)).toMatchObject({ x: 5, y: 6, sx: 1.5, rot: 30, kx: 10, ky: -5 });
  await page.reload();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await expect.poll(async () => (await layers(page)).find((l) => l.id === id)?.transform).toMatchObject({ x: 5, y: 6, sx: 1.5, rot: 30, kx: 10, ky: -5 });
});

// Panel clients have no file input: TD shows the chooser (chooseFile / fileChosen). Needs the testHook methods
// `placeImageViaTd` and `chooseFile` (store.bridge.placeImageViaTd / chooseFile).
test.describe('panel-mode file chooser through TD', () => {
  test('Place Image: the chosen file arrives as a pixel layer named after it; cancel adds nothing', async ({ page }) => {
    await open(page);
    const before = (await layers(page)).length;
    const id = await hook<string | null>(page, 'placeImageViaTd');
    expect(id).toBeTruthy();
    expect(td.chooseRequests[td.chooseRequests.length - 1]).toMatchObject({ t: 'chooseFile', purpose: 'placeImage' });
    const added = (await layers(page)).find((l) => l.id === id);
    expect(added).toMatchObject({ name: expect.stringContaining('picked-photo.png') });
    expect((await layers(page)).length).toBe(before + 1);
    expect(td.topFetches.length).toBe(1);

    td.choice.placeImage = null;
    expect(await hook<string | null>(page, 'placeImageViaTd')).toBeNull();
    expect((await layers(page)).length).toBe(before + 1);
    expect(td.topFetches.length).toBe(1);
  });

  test('Place Image rejects with the topError text', async ({ page }) => {
    await open(page);
    td.placeFails = 'Cannot read image';
    const msg = await page.evaluate(() => (window as any).__editorTest.placeImageViaTd().then(() => 'ok', (e: Error) => e.message));
    expect(msg).toBe('Cannot read image');
  });

  test('chooseFile returns the picked path or null', async ({ page }) => {
    await open(page);
    expect(await hook<string | null>(page, 'chooseFile', 'openProject')).toBe('/tmp/chosen.redoc');
    td.choice.exportPng = null;
    expect(await hook<string | null>(page, 'chooseFile', 'exportPng')).toBeNull();
    expect(td.chooseRequests.map((r) => r.purpose)).toEqual(['openProject', 'exportPng']);
  });
});

test('a hello input missing from TD\'s stored document: the layer the page creates at load completion reaches TD (real engine)', async ({ page }) => {
  await open(page, { w: 160, h: 90, hasInput: true, inputs: [{ input: 1, w: 160, h: 90 }, { input: 2, w: 80, h: 40 }] }, (t) => {
    const base = { parentId: null, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, effects: [] as never[], mask: null, adjustment: null, text: null, shape: null, slot: null } as const;
    t.seedDocument([{ ...base, id: 'in1', kind: 'input', input: 1, name: 'TD Input 1', surfaceW: 160, surfaceH: 90 }], 4);
  });
  await expect.poll(async () => (await layers(page)).filter((l) => l.kind === 'input').map((l) => l.input).sort()).toEqual([1, 2]);
  await td.waitFor(() => td.doc?.layers.some((l) => l.kind === 'input' && l.input === 2) ?? false);
  const l2 = td.doc!.layers.find((l) => l.kind === 'input' && l.input === 2)!;
  expect(l2.name).toBe('TD Input 2');
  expect(td.doc!.layers.filter((l) => l.kind === 'input' && l.input === 1)).toHaveLength(1);
});

test('after Open Project the known inputs are re-applied: a disconnected input stays flagged (real engine)', async ({ page }) => {
  await open(page, { w: 160, h: 90, hasInput: true, inputs: [{ input: 1, w: 160, h: 90 }, { input: 2, w: 80, h: 40 }] });
  await expect.poll(async () => (await layers(page)).filter((l) => l.kind === 'input').length).toBe(2);
  td.removeInput(2);
  td.send({ t: 'inputs', items: td.inputList() });
  await expect.poll(async () => (await layers(page)).find((l) => l.kind === 'input' && l.input === 2)?.inputConnected).toBe(false);
  await hook(page, 'saveProject', '/tmp/e2e-inputs.redoc');
  await hook(page, 'openProject', '/tmp/e2e-inputs.redoc');
  await expect(overlay(page)).toBeHidden({ timeout: 8000 });
  await expect.poll(() => hook<any[]>(page, 'inputs')).toEqual([{ input: 1, w: 160, h: 90, connected: true }, { input: 2, w: 0, h: 0, connected: false }]);
  await expect.poll(async () => (await layers(page)).find((l) => l.kind === 'input' && l.input === 2)?.inputConnected).toBe(false);
});

test('a stray edit during the reload window is ignored by TD and does not overwrite the opened document', async ({ page }) => {
  await open(page);
  await hook(page, 'addLayer');
  const saved = (await layers(page)).length;
  await td.waitFor(() => (td.doc?.layers.length ?? 0) === saved);
  await hook(page, 'saveProject', '/tmp/e2e-stray.redoc');
  await hook(page, 'addLayer');
  await td.waitFor(() => (td.doc?.layers.length ?? 0) === saved + 1);
  td.reloadDelayMs = 400; // the page still believes its own document is current for a moment
  const ignored = td.ignoredAfterReload.docs;
  expect(await hook<any>(page, 'openProject', '/tmp/e2e-stray.redoc')).toMatchObject({ ok: true });
  await hook(page, 'addLayer'); // the stray edit, sent before `reload` arrives
  await td.waitFor(() => td.ignoredAfterReload.docs > ignored);
  await expect(overlay(page)).toBeHidden({ timeout: 8000 });
  await expect.poll(async () => (await layers(page)).length).toBe(saved);
  expect(td.doc!.layers).toHaveLength(saved);
  expect(td.awaitingRequestDoc).toBe(false);
});
