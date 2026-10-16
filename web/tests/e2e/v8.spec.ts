import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v8 (protocol 10): several editors per project as tabs, against the multi-editor fake TD (one server, one token, N independent documents).
let a: FakeTd; // the master editor ed1 (owns the server)
let b: FakeTd; // ed2
let c: FakeTd; // ed3
test.afterEach(async () => { await a?.close(); });

const base = { parentId: null, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, effects: [] as never[], mask: null, adjustment: null, text: null, shape: null } as const;
/** An editor document with one pixel layer (slot 1) filled with `rgba`. */
const seed = (t: FakeTd, name: string, rgba: [number, number, number, number], rev = 3) => {
  t.seedDocument([
    { ...base, id: `in-${t.editorId}`, kind: 'input', input: 1, name: 'TD Input 1', slot: null, surfaceW: t.w, surfaceH: t.h },
    { ...base, id: `p-${t.editorId}`, kind: 'pixel', input: null, name, slot: 1, surfaceW: t.w, surfaceH: t.h },
  ], rev, { 1: rgba });
};

async function setup(opts: { third?: boolean } = {}) {
  a = await FakeTd.start({ w: 160, h: 90, hasInput: true, editorId: 'ed1', name: 'Main' });
  b = a.addEditor('ed2', { w: 120, h: 60, name: 'Second' });
  seed(a, 'Red layer', [255, 0, 0, 255]);
  seed(b, 'Green layer', [0, 255, 0, 255]);
  if (opts.third) { c = a.addEditor('ed3', { w: 100, h: 50, name: 'Third' }); seed(c, 'Blue layer', [0, 0, 255, 255]); }
}

const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, x]) => (window as any).__editorTest[f as string](...(x as unknown[])), [fn, args] as const) as Promise<T>;
const pageUrl = (hash: string) => `/?test=1&ws=${encodeURIComponent(a.url)}${hash}`;
const open = async (page: Page, hash = a.hash) => {
  page.on('pageerror', (e) => { throw e; });
  await page.goto(pageUrl(hash));
  await expect(page.locator('[data-tool]').first()).toBeVisible();
};
const tab = (page: Page, id: string) => page.locator(`[data-editor-tab=${id}]`);
const current = (page: Page) => hook<{ id: string }>(page, 'editor').then((e) => e.id);
const pixel = (page: Page, x = 95, y = 48) => hook<number[]>(page, 'readPixel', x, y);
const docSize = async (page: Page) => (await hook<any>(page, 'state')).doc as { w: number; h: number };
const hashOf = (page: Page) => page.evaluate(() => location.hash);
const loaded = async (page: Page, id: string, rgba: number[]) => {
  await expect(tab(page, id)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => pixel(page)).toEqual(rgba);
};

test('tab strip: one tab per editor (label = name, tooltip = path), the hash editor is selected, requests carry editor=', async ({ page }) => {
  await setup({ third: true });
  await open(page, b.hash);
  await expect(page.locator('[data-editor-tab]')).toHaveCount(3);
  await expect(page.locator('[data-editor-tab] [data-editor-name]')).toHaveText(['Main', 'Second', 'Third']);
  await expect(tab(page, 'ed2')).toHaveAttribute('title', '/project1/ed2');
  await expect(tab(page, 'ed2')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'ed1')).toHaveAttribute('aria-selected', 'false');
  await expect(tab(page, 'ed1').locator('[data-editor-master]')).toHaveCount(1);
  await expect(tab(page, 'ed2').locator('[data-editor-master]')).toHaveCount(0);
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  expect(await docSize(page)).toEqual({ w: 120, h: 60 });
  // the page connected to ed2 only, with editor= on the ws url and on every HTTP request
  expect(b.requests.length).toBeGreaterThan(2);
  expect(b.requests.every((r) => r.editor === 'ed2')).toBe(true);
  expect(b.requests.some((r) => r.method === 'GET' && r.path === '/surface')).toBe(true);
  expect(a.requests.filter((r) => r.path !== '/' && r.path !== '/editors' && r.editor !== 'ed2')).toEqual([]);
  expect(a.connections).toBe(0);
  expect(c.connections).toBe(0);
  expect(a.requests.some((r) => r.path === '/editors')).toBe(true);
  expect(b.messages[0]).toMatchObject({ t: 'ready', protocol: 10, client: 'external', token: a.token });
});

test('no e= in the hash: the master\'s editor opens and the hash gets e=<master>', async ({ page }) => {
  await setup();
  await open(page, `#token=${a.token}`);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await expect.poll(() => hashOf(page)).toBe(`#token=${a.token}&e=ed1`);
});

test('tabs update live: create, rename, deactivate, master change, delete', async ({ page }) => {
  await setup();
  await open(page);
  await expect(page.locator('[data-editor-tab]')).toHaveCount(2);
  const e3 = a.addEditor('ed3', { name: 'Third' });
  await expect(page.locator('[data-editor-tab]')).toHaveCount(3);
  a.renameEditor('ed3', 'Renamed');
  await expect(tab(page, 'ed3').locator('[data-editor-name]')).toHaveText('Renamed');
  a.setEditorActive('ed3', false);
  await expect(tab(page, 'ed3')).toHaveAttribute('aria-disabled', 'true');
  await expect(tab(page, 'ed3')).toHaveAttribute('title', /inactive/);
  await tab(page, 'ed3').click({ force: true }); // aria-disabled: Playwright would wait forever otherwise
  await expect(page.locator('[data-status=notice]')).toContainText('inactive');
  expect(await current(page)).toBe('ed1');
  expect(e3.connections).toBe(0);
  a.setEditorActive('ed3', true);
  await expect(tab(page, 'ed3')).toHaveAttribute('aria-disabled', 'false');
  a.setMaster('ed2');
  await expect(tab(page, 'ed2').locator('[data-editor-master]')).toHaveCount(1);
  await expect(tab(page, 'ed1').locator('[data-editor-master]')).toHaveCount(0);
  a.removeEditor('ed3');
  await expect(page.locator('[data-editor-tab]')).toHaveCount(2);
  expect(await current(page)).toBe('ed1'); // an unrelated deletion does not move the page
});

test('clicking a tab switches editors without a reload: each editor shows its own document; back / forward switch too', async ({ page }) => {
  await setup({ third: true });
  await open(page);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await page.evaluate(() => { (window as any).__noReload = 42; });
  expect(await docSize(page)).toEqual({ w: 160, h: 90 });

  await tab(page, 'ed2').click();
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  expect(await docSize(page)).toEqual({ w: 120, h: 60 });
  expect(await hashOf(page)).toBe(`#token=${a.token}&e=ed2`);
  await expect(tab(page, 'ed2').locator('[data-doc-info]')).toContainText('120 × 60');
  await expect(page.locator('[data-doc-info]')).toHaveCount(1);

  await tab(page, 'ed3').click();
  await loaded(page, 'ed3', [0, 0, 255, 255]);
  expect(await docSize(page)).toEqual({ w: 100, h: 50 });
  expect(await hook<any[]>(page, 'layers').then((l) => l.map((x) => x.name))).toContain('Blue layer');
  expect(await hook<any[]>(page, 'layers').then((l) => l.map((x) => x.name))).not.toContain('Green layer');

  await page.goBack();
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  await page.goBack();
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await page.goForward();
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(42);

  // typing a hash by hand switches as well
  await page.evaluate((h) => { location.hash = h; }, `#token=${a.token}&e=ed3`);
  await loaded(page, 'ed3', [0, 0, 255, 255]);

  // each switch re-requested its editor's document; one WebSocket at a time
  expect(b.requestDocs).toBeGreaterThanOrEqual(1);
  await expect.poll(() => [a.client === null, b.client === null, c.client !== null]).toEqual([true, true, true]);
});

test('an edit on editor A never reaches B (and the other way round)', async ({ page }) => {
  await setup();
  await open(page);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  const bDocs = b.docMessages, bFrames = b.frames.length, bMsgs = b.messages.length;
  await hook(page, 'setPrimary', '#ffffff');
  await hook(page, 'setTool', 'pencil');
  const id = await hook<string>(page, 'addLayer');
  await hook(page, 'stroke', 'pencil', [[10, 10], [60, 10], [60, 40]]);
  await a.waitFor(() => a.doc?.layers.some((l) => l.id === id) ?? false);
  const slot = a.doc!.layers.find((l) => l.id === id)!.slot!;
  await a.waitFor(() => a.surfacePixel(slot, 30, 10)[3] > 0);
  expect(b.docMessages).toBe(bDocs);
  expect(b.frames.length).toBe(bFrames);
  expect(b.messages.length).toBe(bMsgs); // not even a view / activeLayer / log
  expect(b.doc!.layers.map((l) => l.name)).toEqual(['TD Input 1', 'Green layer']);

  await tab(page, 'ed2').click();
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  const aDocs = a.docMessages, aFrames = a.frames.length, aLayers = a.doc!.layers.length, bLayers = b.doc!.layers.length;
  const id2 = await hook<string>(page, 'addLayer');
  await hook(page, 'stroke', 'pencil', [[5, 20], [50, 20]]);
  await b.waitFor(() => b.doc?.layers.some((l) => l.id === id2) ?? false);
  const slot2 = b.doc!.layers.find((l) => l.id === id2)!.slot!;
  await b.waitFor(() => b.surfacePixel(slot2, 30, 20)[3] > 0);
  await page.waitForTimeout(300);
  expect(a.docMessages).toBe(aDocs);
  expect(a.frames.length).toBe(aFrames);
  // A's earlier stroke is still exactly what A stored; B's new layer is not in A's document
  expect(a.doc!.layers.length).toBe(aLayers);
  expect(b.doc!.layers.length).toBe(bLayers + 1);
  expect(a.surfacePixel(slot, 30, 10)[3]).toBeGreaterThan(0);
});

test('an edit made right before switching is flushed to the old editor (surfaces, doc, history) and never sent to the new one', async ({ page }) => {
  await setup();
  await open(page);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await hook(page, 'setPrimary', '#ffffff');
  const bBefore = { docs: b.docMessages, frames: b.frames.length, posts: b.historyPosts.length };
  // paint and click the other tab in the same task: the 30 fps send timers have not fired yet
  const id = await page.evaluate(() => {
    const t = (window as any).__editorTest;
    const layer = t.addLayer() as string;
    t.stroke('pencil', [[10, 10], [80, 10]]);
    t.switchEditor('ed2');
    return layer;
  });
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  await a.waitFor(() => a.doc?.layers.some((l) => l.id === id) ?? false);
  const slot = a.doc!.layers.find((l) => l.id === id)!.slot!;
  expect(a.surfacePixel(slot, 40, 10)[3]).toBeGreaterThan(0); // the stroke arrived
  expect(a.historyPosts.length).toBeGreaterThanOrEqual(1); // history persisted before the session closed
  expect(a.historyBlob).not.toBeNull();
  await page.waitForTimeout(500);
  expect(b.docMessages).toBe(bBefore.docs);
  expect(b.frames.length).toBe(bBefore.frames);
  expect(b.historyPosts.length).toBe(bBefore.posts);
  // coming back: the edit is in the document TD gave back, with its history
  await tab(page, 'ed1').click();
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  expect((await hook<any[]>(page, 'layers')).some((l) => l.id === id)).toBe(true);
  expect(a.historyGets.at(-1)).toEqual({ status: 200 });
});

test('switching many times does not leak: one socket, no growth of canvases', async ({ page }) => {
  await setup({ third: true });
  await open(page);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  const canvases = () => page.evaluate(() => document.querySelectorAll('canvas').length);
  const before = await canvases();
  for (const id of ['ed2', 'ed3', 'ed1', 'ed2', 'ed3', 'ed1']) {
    await tab(page, id).click();
    await expect(tab(page, id)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-loading-doc]')).toHaveCount(0);
  }
  await expect.poll(canvases).toBe(before);
  const open2 = [a, b, c].filter((t) => t.client !== null).length;
  expect(open2).toBe(1);
  expect(a.connections).toBe(3);
  expect(b.connections).toBe(2);
});

test('an editor that is deleted while open: the page falls back to the master\'s editor with a notice', async ({ page }) => {
  await setup({ third: true });
  await open(page, b.hash);
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  a.removeEditor('ed2');
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await expect(page.locator('[data-status=notice]')).toContainText('no longer exists');
  await expect(page.locator('[data-editor-tab]')).toHaveCount(2);
  expect(await hashOf(page)).toBe(`#token=${a.token}&e=ed1`);
  // nothing of it was sent to the survivor
  expect(a.docMessages).toBe(0);
});

test('deactivating the open editor falls back as well', async ({ page }) => {
  await setup();
  await open(page, b.hash);
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  a.setEditorActive('ed2', false);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await expect(page.locator('[data-status=notice]')).toContainText('deactivated');
});

test('an unknown editor in the URL: the master\'s editor with a notice', async ({ page }) => {
  await setup();
  await open(page, `#token=${a.token}&e=nope`);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await expect(page.locator('[data-status=notice]')).toContainText('"nope" no longer exists');
  expect(await hashOf(page)).toBe(`#token=${a.token}&e=ed1`);
});

test('a wrong token is fatal, tabs are not shown', async ({ page }) => {
  await setup();
  await open(page, '#token=wrong&e=ed1');
  await expect(page.locator('[data-status=fatal]')).toHaveText('Reopen from TouchDesigner — session expired');
  await expect(page.locator('[data-editor-tabs]')).toHaveCount(0);
});

test('failover: the server drops and comes back on the same port; the page reconnects, keeps its tab and keeps editing', async ({ page }) => {
  await setup();
  await open(page, b.hash);
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  await hook(page, 'setPrimary', '#ffffff');
  await a.stopServer();
  await expect.poll(async () => (await hook<any>(page, 'loadState')).connection).toBe('reconnecting');
  await page.waitForTimeout(800); // a few failed retries
  await a.startServer();
  await expect.poll(async () => (await hook<any>(page, 'loadState')).connection, { timeout: 15000 }).toBe('linked');
  expect(await current(page)).toBe('ed2');
  expect(b.connections).toBe(2);
  expect(await hashOf(page)).toBe(`#token=${a.token}&e=ed2`);
  await expect(page.locator('[data-editor-tab]')).toHaveCount(2);
  // still editing: a stroke after the reconnect reaches ed2 (not ed1)
  const id = await hook<string>(page, 'addLayer');
  await hook(page, 'stroke', 'pencil', [[10, 10], [60, 10]]);
  await b.waitFor(() => b.doc?.layers.some((l) => l.id === id) ?? false);
  const slot = b.doc!.layers.find((l) => l.id === id)!.slot!;
  await b.waitFor(() => b.surfacePixel(slot, 30, 10)[3] > 0);
  expect(a.docMessages).toBe(0);
});

test('failover with a new master: the old master editor is gone, the page stays on its own editor', async ({ page }) => {
  await setup();
  await open(page, b.hash);
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  await a.stopServer();
  a.removeEditor('ed1'); // the old master editor was deleted; ed2 takes over
  await a.startServer();
  await expect.poll(async () => (await hook<any>(page, 'loadState')).connection, { timeout: 15000 }).toBe('linked');
  expect(await current(page)).toBe('ed2');
  await expect(page.locator('[data-editor-tab]')).toHaveCount(1);
  await expect(tab(page, 'ed2').locator('[data-editor-master]')).toHaveCount(1);
});

test('failover while the open editor vanished: after the reconnect the page shows the master\'s editor with a notice', async ({ page }) => {
  await setup({ third: true });
  await open(page, c.hash);
  await loaded(page, 'ed3', [0, 0, 255, 255]);
  await a.stopServer();
  a.removeEditor('ed3');
  await a.startServer();
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await expect(page.locator('[data-status=notice]')).toContainText('no longer exists');
  expect(await hashOf(page)).toBe(`#token=${a.token}&e=ed1`);
});

test('standalone (no TouchDesigner): no tab strip, the single document tab stays', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-editor-tabs]')).toHaveCount(0);
  await expect(page.locator('[data-doc-info]')).toHaveCount(1);
});

test('layer clipboard across tabs: copy in editor A, switch, paste in B, and B\'s TD document receives the layers', async ({ page }) => {
  await setup();
  await open(page);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await hook(page, 'setPrimary', '#ffffff');
  const id = await hook<string>(page, 'addLayer');
  await hook(page, 'stroke', 'pencil', [[10, 10], [60, 10]]);
  await a.waitFor(() => a.doc?.layers.some((l) => l.id === id) ?? false);
  await hook(page, 'selectLayers', [id]);
  await hook(page, 'copySelected');
  const aLayers = a.doc!.layers.length;

  await tab(page, 'ed2').click();
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  const bLayers = b.doc!.layers.length;
  const ids = await hook<string[]>(page, 'pasteLayers');
  expect(ids.length).toBe(1);
  await b.waitFor(() => (b.doc?.layers.length ?? 0) === bLayers + 1);
  const pasted = b.doc!.layers.find((l) => l.id === ids[0])!;
  expect(pasted.name).toMatch(/ copy$/);
  await b.waitFor(() => b.surfacePixel(pasted.slot!, 30, 10)[3] > 0); // the pixels came along
  // the source editor is untouched
  expect(a.doc!.layers.length).toBe(aLayers);
  // and the clip is still there for a second paste (e.g. back in A)
  await tab(page, 'ed1').click();
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  expect((await hook<string[]>(page, 'pasteLayers')).length).toBe(1);
  await a.waitFor(() => (a.doc?.layers.length ?? 0) === aLayers + 1);
});

test('switching while TouchDesigner is reconnecting with unsent edits: Wait holds the switch until the edits are sent', async ({ page }) => {
  await setup();
  await open(page);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await a.stopServer();
  await expect.poll(async () => (await hook<any>(page, 'loadState')).connection).toBe('reconnecting');
  const id = await hook<string>(page, 'addLayer'); // an offline edit
  await tab(page, 'ed2').click();
  await expect(page.locator('[data-discard-dialog]')).toContainText('This editor has unsent changes and TouchDesigner is reconnecting.');
  await page.locator('[data-discard-wait]').click();
  await expect(page.locator('[data-switching-title]')).toHaveText('Switching to Second…');
  await expect(page.locator('[data-switching-wait]')).toBeVisible();
  expect(await current(page)).toBe('ed1');
  await a.startServer();
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  expect(a.doc!.layers.some((l) => l.id === id)).toBe(true); // the offline edit reached ed1 before the switch
  await expect(page.locator('[data-switching]')).toHaveCount(0);
});

test('Discard & switch drops the unsent edits and says so; clicking the current tab while waiting cancels the switch', async ({ page }) => {
  await setup();
  await open(page);
  await loaded(page, 'ed1', [255, 0, 0, 255]);
  await a.stopServer();
  await expect.poll(async () => (await hook<any>(page, 'loadState')).connection).toBe('reconnecting');
  const layersBefore = a.doc!.layers.length;
  await hook(page, 'addLayer');
  await tab(page, 'ed2').click();
  await page.locator('[data-discard-wait]').click();
  await expect(page.locator('[data-switching-wait]')).toBeVisible();
  await tab(page, 'ed1').click(); // back to the editor that is still open: the switch is cancelled
  await expect(page.locator('[data-switching]')).toHaveCount(0);
  await expect(page.locator('[data-discard-dialog]')).toHaveCount(0);
  expect(await current(page)).toBe('ed1');
  expect((await hook<any[]>(page, 'layers')).length).toBe(layersBefore + 1); // the edit is still there, no reload

  await tab(page, 'ed2').click();
  await page.locator('[data-discard-discard]').click();
  await a.startServer();
  await loaded(page, 'ed2', [0, 255, 0, 255]);
  await expect(page.locator('[data-status=notice]')).toContainText('discarded');
  expect(a.doc!.layers.length).toBe(layersBefore);
});
