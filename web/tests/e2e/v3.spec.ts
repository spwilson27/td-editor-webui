import { expect, test, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import type { LayerSpec } from '../../src/engine/types';
import { FakeTd } from './fakeTd';

let td: FakeTd;
test.afterEach(async () => { await td.close(); });

const open = async (page: Page, opts: { client?: 'panel' | 'external'; fonts?: string[]; tops?: boolean } = {}) => {
  td = await FakeTd.start({ w: 160, h: 90, fonts: opts.fonts });
  if (opts.tops) td.tops = [solidTop('/project1/red1', 100, 50, [220, 20, 30, 255]), solidTop('/project1/big1', 400, 300, [10, 200, 30, 255]), solidTop('/lib/blue1', 20, 20, [20, 30, 220, 255])];
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`/?test=1&client=${opts.client ?? 'panel'}&ws=${encodeURIComponent(td.url)}&token=${td.token}`);
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await td.waitFor(() => td.doc !== null);
};
const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const solidTop = (path: string, w: number, h: number, c: [number, number, number, number]) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(c, i);
  return { path, w, h, rgba };
};
const specs = () => td.doc!.layers;
const kindLayers = (kind: string) => specs().filter((l: LayerSpec) => l.kind === kind);
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// -- minimal PNG writer (RGBA8) --
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (w: number, h: number, rgba: [number, number, number, number]) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgba, y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

const dragDoc = async (page: Page, a: [number, number], b: [number, number]) => {
  const p = await hook<{ x: number; y: number }>(page, 'docToScreen', a[0], a[1]);
  const q = await hook<{ x: number; y: number }>(page, 'docToScreen', b[0], b[1]);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: 6 });
  await page.mouse.up();
};
const clickDoc = async (page: Page, x: number, y: number) => {
  const p = await hook<{ x: number; y: number }>(page, 'docToScreen', x, y);
  await page.mouse.click(p.x, p.y);
};
const layerNames = (page: Page) => page.locator('[data-layer] [data-name]').allTextContents();

test('fonts from TD fill the text tool dropdown', async ({ page }) => {
  await open(page, { fonts: ['Menlo', 'Zapfino', 'Arial'] });
  await page.keyboard.press('t');
  await expect(page.locator('[data-context=name]')).toHaveText('Text Tool');
  await expect(page.locator('#tf option')).toHaveText(['Menlo', 'Zapfino', 'Arial']);
  expect(await hook<string[]>(page, 'fonts')).toEqual(['Menlo', 'Zapfino', 'Arial']);
  await expect(page.locator('#tf')).toHaveValue('Arial');
});

test('standalone: built-in font list and Import from TouchDesigner is disabled', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  td = await FakeTd.start({ w: 8, h: 8 }); // so afterEach has something to close
  await page.keyboard.press('t');
  expect(await page.locator('#tf option').count()).toBeGreaterThan(3);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /Import from TouchDesigner/ })).toHaveAttribute('aria-disabled', 'true');
});

test('Import from TouchDesigner: dialog lists TOPs, the chosen one appears as a layer and reaches TD', async ({ page }) => {
  await open(page, { tops: true });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /Import from TouchDesigner/ }).click();
  await expect(page.locator('[data-top-dialog]')).toBeVisible();
  await expect(page.locator('[data-top-path]')).toHaveCount(3);
  await expect(page.locator('[data-top-path]').first()).toContainText('100×50');
  await page.locator('[data-top-filter]').fill('red');
  await expect(page.locator('[data-top-path]')).toHaveCount(1);
  await page.locator('[data-top-path]').click();
  await page.locator('[data-top-import]').click();
  await expect(page.locator('[data-top-dialog]')).toBeHidden();
  await expect(page.locator('[data-layer] [data-name]').first()).toHaveText('red1');
  expect(td.topFetches.length).toBe(1);
  // centred 100x50 in 160x90 -> (30,20)..(130,70)
  expect(await hook<number[]>(page, 'readPixel', 80, 45)).toEqual([220, 20, 30, 255]);
  const imported = (await hook<any[]>(page, 'layers'))[0];
  await td.waitFor(() => specs().some((l) => l.id === imported.id));
  const spec = specs().find((l) => l.id === imported.id)!;
  expect(spec.kind).toBe('pixel');
  await td.waitFor(() => near(td.surfacePixel(spec.slot!, 80, 45), [220, 20, 30, 255], 0));
  expect([spec.surfaceW, spec.surfaceH]).toEqual([100, 50]); // v5: imported images keep their native resolution
});

test('Import from TouchDesigner: a TOP larger than the document is scaled to fit; a TD error shows a notice', async ({ page }) => {
  await open(page, { tops: true });
  const id = await hook<string>(page, 'importImageFromTop', '/project1/big1');
  const layers = await hook<any[]>(page, 'layers');
  expect(layers[0].id).toBe(id);
  expect(await hook<number[]>(page, 'readPixel', 80, 45)).toEqual([10, 200, 30, 255]);
  await td.waitFor(() => specs().some((l) => l.id === id));
  await expect(hook(page, 'importImageFromTop', '/does/not/exist')).rejects.toThrow(/No TOP/);
  await expect(page.locator('[data-status=notice]')).toContainText('No TOP at /does/not/exist');
});

test('Place Image… uses a file chooser; the image becomes a layer and is sent to TD (external browser)', async ({ page }) => {
  await open(page, { client: 'external' });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Place Image/ }).click();
  (await chooser).setFiles({ name: 'blue.png', mimeType: 'image/png', buffer: png(40, 20, [20, 30, 220, 255]) });
  await expect(page.locator('[data-layer] [data-name]').first()).toHaveText('blue');
  expect(await hook<number[]>(page, 'readPixel', 80, 45)).toEqual([20, 30, 220, 255]);
  const id = (await hook<any[]>(page, 'layers'))[0].id;
  await td.waitFor(() => specs().some((l) => l.id === id && l.slot !== null));
  const slot = specs().find((l) => l.id === id)!.slot!;
  await td.waitFor(() => near(td.surfacePixel(slot, 80, 45), [20, 30, 220, 255], 0));
});

test('paste and drag-and-drop of an image (synthetic events)', async ({ page }) => {
  await open(page);
  const b64 = png(30, 30, [250, 120, 10, 255]).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, b64);
  await expect(page.locator('[data-layer] [data-name]').first()).toHaveText('pasted');
  expect(await hook<number[]>(page, 'readPixel', 80, 45)).toEqual([250, 120, 10, 255]);
  const b64b = png(10, 10, [10, 250, 10, 255]).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const vp = document.querySelector('[data-viewport]')!;
    vp.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    vp.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, b64b);
  await expect(page.locator('[data-layer] [data-name]').first()).toHaveText('dropped');
  expect(await hook<number[]>(page, 'readPixel', 80, 45)).toEqual([10, 250, 10, 255]);
  expect((await layerNames(page)).slice(0, 2)).toEqual(['dropped', 'pasted']);
});

test('lasso and wand selections clip painting; the clipped pixels are what TD stores', async ({ page }) => {
  await open(page, { client: 'external' });
  const layers = await hook<any[]>(page, 'layers');
  const paint = layers.find((l) => l.kind === 'pixel');
  const slot = paint.slot as number;
  await hook(page, 'setPrimary', '#dc1e1e');
  // 1. lasso (triangle) + fill tool: only the triangle becomes red
  await hook(page, 'selectPolygon', [[20, 10], [100, 10], [20, 70]]);
  const mask = await hook<{ rect: any; alpha: number[] } | null>(page, 'selectionMask');
  expect(mask).not.toBeNull();
  expect(mask!.alpha[30 * 160 + 25]).toBeGreaterThan(200); // inside
  expect(mask!.alpha[60 * 160 + 90]).toBe(0); // inside the bounding rect but outside the triangle
  expect((await hook<any[]>(page, 'selectionPath')).length).toBeGreaterThan(0);
  await hook(page, 'setTool', 'fill');
  await clickDoc(page, 30, 20);
  await td.waitFor(() => near(td.surfacePixel(slot, 30, 20), [220, 30, 30, 255], 2));
  expect(td.surfacePixel(slot, 90, 60)).toEqual([0, 0, 0, 0]);
  expect(td.surfacePixel(slot, 140, 80)).toEqual([0, 0, 0, 0]);
  // marching ants are drawn on the overlay (not just a rect)
  const ants = await page.locator('[data-viewport] canvas').nth(1).evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0));
  expect(ants).toBe(true);
  // 2. wand on the red triangle (current layer, tolerance 0) + pencil stroke across the document: only the triangle turns blue
  await hook(page, 'deselect');
  await hook(page, 'setSelectionOptions', { mode: 'new', wandTolerance: 0, wandContiguous: true, wandSampleAll: false, feather: 0 });
  await hook(page, 'selectWand', 30, 20);
  await hook(page, 'setPrimary', '#1e1edc');
  await hook(page, 'setTool', 'pencil');
  await page.locator('#bw').fill('20');
  await dragDoc(page, [5, 20], [150, 20]);
  await td.waitFor(() => near(td.surfacePixel(slot, 30, 20), [30, 30, 220, 255], 2));
  expect(td.surfacePixel(slot, 120, 20)).toEqual([0, 0, 0, 0]); // outside the wand selection: untouched
  expect(td.surfacePixel(slot, 10, 20)).toEqual([0, 0, 0, 0]);
  // 3. Select menu: invert + keyboard shortcuts
  await page.keyboard.press('Control+d');
  expect(await hook(page, 'selectionMask')).toBeNull();
  await page.keyboard.press('Control+a');
  expect((await hook<any>(page, 'selectionMask')).rect).toMatchObject({ x: 0, y: 0, w: 160, h: 90 });
  await page.keyboard.press('Control+Shift+i');
  expect(await hook(page, 'selectionMask')).toBeNull(); // inverting everything leaves nothing
});

test('text tool: create, type (shortcuts suppressed), commit, re-edit, TD renders it (no slot, no tiles)', async ({ page }) => {
  await open(page);
  await page.keyboard.press('t');
  await clickDoc(page, 10, 10);
  const editor = page.locator('[data-text-editor]');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await page.keyboard.type('Hi bge'); // would switch tools if shortcuts were live
  expect((await hook<any>(page, 'state')).tool).toBe('text');
  await td.waitFor(() => kindLayers('text').length === 1 && kindLayers('text')[0].text?.text === 'Hi bge');
  const t = kindLayers('text')[0];
  expect(t).toMatchObject({ slot: null });
  expect('rasterize' in t).toBe(false); // v5: gone from the spec
  expect(t.text).toMatchObject({ x: 10, y: 10 });
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  expect((await hook<any>(page, 'state')).tool).toBe('text');
  // re-edit the same layer by clicking on its text
  await clickDoc(page, 14, 14);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('Hi bge');
  await expect(editor).toBeFocused();
  await editor.press('ControlOrMeta+a'); // select-all in the textarea, not the document
  await page.keyboard.type('Yo');
  await expect(editor).toHaveValue('Yo');
  await page.keyboard.press('Escape');
  await td.waitFor(() => kindLayers('text')[0].text?.text === 'Yo', 1500).catch(() => { throw new Error('texts=' + JSON.stringify(kindLayers('text').map((l) => l.text?.text))); });
  expect(kindLayers('text')).toHaveLength(1);
  expect(await hook(page, 'selectionMask')).toBeNull();
  // an empty new text is removed again
  await clickDoc(page, 100, 60);
  await expect(editor).toBeVisible();
  await page.keyboard.press('Escape');
  await td.waitFor(() => kindLayers('text').length === 1);
  // the font controls edit the selected layer
  await page.locator('#ts').fill('30');
  await page.locator('#ts').blur();
  await td.waitFor(() => kindLayers('text')[0].text?.size === 30);
  // text layers never own a surface: no SURFACE tiles for them, ever
  expect(kindLayers('text')[0].slot).toBeNull();
  expect(td.frames.every((f) => f.slot !== kindLayers('text')[0].slot)).toBe(true);
});

test('shape tool: flyout, drag draws a layer (rendered by TD, no slot), undo removes it', async ({ page }) => {
  await open(page);
  await hook(page, 'setPrimary', '#2060e0');
  await page.locator('[data-flyout-toggle]').click();
  await page.locator('[data-shape=ellipse]').click();
  await expect(page.locator('[data-context=name]')).toHaveText('Shape Tool');
  await dragDoc(page, [40, 20], [120, 70]);
  await td.waitFor(() => kindLayers('shape').length === 1);
  const s = kindLayers('shape')[0];
  expect(s.shape).toMatchObject({ type: 'ellipse', x: 40, y: 20, w: 80, h: 50 });
  expect((s.shape as any).fill).toMatchObject({ enabled: true, color: { r: 32, g: 96, b: 224 } });
  expect(s.slot).toBeNull();
  expect(await hook<number[]>(page, 'readPixel', 80, 45)).toEqual([32, 96, 224, 255]);
  // a polygon/star through the flyout
  await page.locator('[data-flyout-toggle]').click();
  await page.locator('[data-shape=polygon]').click();
  await page.locator('#shn').fill('7');
  await dragDoc(page, [130, 30], [150, 30]);
  await td.waitFor(() => kindLayers('shape').length === 2);
  expect(kindLayers('shape')[1].shape).toMatchObject({ type: 'polygon', cx: 130, cy: 30, radius: 20, sides: 7 });
  await page.keyboard.press('Control+z');
  await td.waitFor(() => kindLayers('shape').length === 1);
});

test('Flatten Layer: TD renders the text layer, the page replaces it with a pixel layer in TD\'s document', async ({ page }) => {
  await open(page);
  const id = await hook<string>(page, 'addTextLayer', { text: 'AB', size: 40, x: 20, y: 20, color: { r: 0, g: 0, b: 0, a: 255 } });
  await td.waitFor(() => kindLayers('text').length === 1);
  td.renderColors.set(id, [11, 22, 33, 255]);
  await page.getByRole('button', { name: 'Layer', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Flatten Layer' }).click();
  await td.waitFor(() => specs().some((l) => l.id === id && l.kind === 'pixel'));
  expect(td.renderCalls).toEqual([id]);
  const spec = specs().find((l) => l.id === id)!;
  expect(spec).toMatchObject({ text: null, shape: null });
  expect(spec.slot).not.toBeNull();
  await td.waitFor(() => near(td.surfacePixel(spec.slot!, 80, 45), [11, 22, 33, 255], 1));
});

for (const [w, h] of [[1600, 960], [1280, 800]] as const) {
  test(`v3 context bars stay on one row and inside the window at ${w}x${h}`, async ({ page }) => {
    td = await FakeTd.start({ w: 8, h: 8 });
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?standalone=1&test=1');
    await expect(page.locator('[data-tool]').first()).toBeVisible();
    for (const key of ['l', 'w', 't', 'u']) {
      await page.keyboard.press(key);
      const r = await page.locator('[data-context-bar]').evaluate((el) => {
        const tops = new Set([...el.querySelectorAll<HTMLElement>('.ctx-tool, .opts > *')].filter((c) => c.offsetParent !== null).map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)));
        const kids = [...el.querySelectorAll<HTMLElement>('.opts > *')].filter((c) => c.offsetParent !== null);
        const right = Math.max(...kids.map((c) => c.getBoundingClientRect().right));
        return { rows: tops.size, overflowX: el.scrollWidth > el.clientWidth + 1, right, view: el.getBoundingClientRect().right };
      });
      expect(r.rows, `rows for ${key}`).toBe(1);
      expect(r.overflowX, `overflow for ${key}`).toBe(false);
      expect(r.right, `right edge for ${key}`).toBeLessThanOrEqual(r.view);
    }
    // the rail still shows every tool unscrolled with the flyout mark present
    const rail = await page.locator('[data-rail]').evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(rail).toBe(false);
    await expect(page.locator('[data-flyout-toggle]')).toBeVisible();
  });
}

test('a fresh page loading TD\'s document: text layers own no slot, nothing is fetched or pushed for them', async ({ page }) => {
  td = await FakeTd.start({ w: 160, h: 90 });
  const text = { text: 'AB', font: 'Arial', size: 40, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 20, y: 20, boxWidth: null };
  const base = { parentId: null, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, effects: [] as never[], surfaceW: null, surfaceH: null, mask: null, adjustment: null, shape: null } as const;
  td.seedDocument([
    { ...base, id: 'base', kind: 'input', input: 1, name: 'TD Input', slot: null, text: null } as LayerSpec,
    { ...base, id: 'tx', kind: 'text', input: null, name: 'AB', slot: null, text: text as never },
  ], 5);
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`/?test=1&client=panel&ws=${encodeURIComponent(td.url)}&token=${td.token}`);
  await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
  await expect(page.locator('[data-layer] [data-name]')).toHaveText(['AB', 'TD Input']);
  await page.waitForTimeout(300);
  expect(td.surfaceFetches).toEqual([]);
  expect(td.frames).toHaveLength(0);
});
