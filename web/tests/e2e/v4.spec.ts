import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { LayerSpec } from '../../src/engine/types';
import { FakeTd } from './fakeTd';

// v4 (protocol 6): Flatten via renderLayer, canvas size, guides, transforms, rulers layout. The fake TD is the v6 one.
let td: FakeTd;
test.afterEach(async () => { await td.close(); });

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
const specs = () => td.doc!.layers;
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const menu = async (page: Page, top: string, item: string | RegExp) => {
  await page.getByRole('button', { name: top, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
const state = (page: Page) => hook<any>(page, 'state');
const mouseDragDoc = async (page: Page, a: [number, number], b: [number, number], mods: string[] = []) => {
  const p = await hook<{ x: number; y: number }>(page, 'docToScreen', a[0], a[1]);
  const q = await hook<{ x: number; y: number }>(page, 'docToScreen', b[0], b[1]);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(q.x, q.y, { steps: 6 });
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
};

test.describe('Flatten via TouchDesigner', () => {
  test('the row button asks TD to render the layer, then the layer becomes a pixel layer in TD\'s document', async ({ page }) => {
    await open(page);
    const id = await hook<string>(page, 'addShapeLayer', { type: 'rect', x: 10, y: 10, w: 50, h: 30 });
    await td.waitFor(() => specs().some((l) => l.id === id));
    td.renderColors.set(id, [200, 100, 50, 255]);
    const btn = page.locator(`[data-layer="${id}"] [data-act=flatten]`);
    await expect(btn).toHaveAttribute('aria-label', 'Flatten to pixels');
    await expect(btn).toHaveAttribute('title', 'Flatten to pixels');
    await btn.click();
    await td.waitFor(() => specs().some((l) => l.id === id && l.kind === 'pixel'));
    expect(td.renderCalls).toEqual([id]);
    expect(td.topFetches).toHaveLength(1);
    const spec = specs().find((l) => l.id === id)!;
    expect(spec.slot).not.toBeNull();
    await td.waitFor(() => near(td.surfacePixel(spec.slot!, 80, 45), [200, 100, 50, 255], 1));
    expect(await hook<number[]>(page, 'readPixel', 5, 5)).toEqual([200, 100, 50, 255]);
    await expect(page.locator(`[data-layer="${id}"] [data-act=flatten]`)).toHaveAttribute('aria-disabled', 'true'); // a plain pixel layer now
    await page.keyboard.press('Control+z'); // history entry: back to the shape
    await td.waitFor(() => specs().some((l) => l.id === id && l.kind === 'shape'));
  });

  test('a TD error shows a notice and leaves the layer alone', async ({ page }) => {
    await open(page);
    const id = await hook<string>(page, 'addTextLayer', { text: 'X', size: 30, x: 10, y: 10 });
    await td.waitFor(() => specs().some((l) => l.id === id));
    td.renderFails = 'render failed in TD';
    await menu(page, 'Layer', 'Flatten Layer');
    await expect(page.locator('[data-status=notice]')).toContainText('Flatten failed: render failed in TD');
    expect(specs().find((l) => l.id === id)!.kind).toBe('text');
  });

  test('standalone: the button is disabled with a tooltip', async ({ page }) => {
    td = await FakeTd.start({ w: 8, h: 8 });
    await page.goto('/?standalone=1&test=1');
    await expect(page.locator('[data-tool]').first()).toBeVisible();
    const id = await hook<string>(page, 'addTextLayer', { text: 'X' });
    const btn = page.locator(`[data-layer="${id}"] [data-act=flatten]`);
    await expect(btn).toHaveAttribute('aria-disabled', 'true');
    await expect(btn).toHaveAttribute('title', /TouchDesigner/);
    await page.getByRole('button', { name: 'Layer', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Flatten Layer' })).toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('canvas size', () => {
  test('Document > Canvas Size… round trip: setCanvas to TD, docSize back, stored doc says fixed; input resolution then no longer moves the document', async ({ page }) => {
    await open(page);
    td.sendSolidBase(10, 20, 30);
    await td.waitFor(() => td.frameEnds >= 0 && td.fetches.length >= 1);
    await menu(page, 'Document', 'Canvas Size…');
    await expect(page.locator('[data-canvas-current]')).toContainText('160 × 90');
    await expect(page.locator('[data-canvas-current]')).toContainText('Following');
    await page.locator('#cw').fill('320');
    await page.locator('#ch').fill('180');
    await page.locator('[data-anchor=tl]').click();
    await page.locator('[data-canvas-ok]').click();
    await td.waitFor(() => td.setCanvasMessages.length === 1);
    expect(td.setCanvasMessages[0]).toEqual({ w: 320, h: 180, mode: 'fixed' });
    await expect.poll(async () => (await state(page)).doc).toEqual({ w: 320, h: 180 });
    await expect(page.locator('[data-status=canvas]')).toContainText('320 × 180 · Fixed');
    await expect(page.locator('[data-doc-info]')).toContainText('320 × 180');
    await td.waitFor(() => td.doc!.canvas.mode === 'fixed');
    expect(await hook<string>(page, 'canvasMode')).toBe('fixed');
    // the TD Input resolution changes while the canvas is fixed: the document keeps its size
    td.resize(64, 64);
    await page.waitForTimeout(300);
    expect((await state(page)).doc).toEqual({ w: 320, h: 180 });
    const base = (await hook<any[]>(page, 'layers')).find((l) => l.kind === 'input');
    expect([base.surfaceW, base.surfaceH]).toEqual([64, 64]);
    td.sendSolidBase(250, 0, 0);
    await expect.poll(() => hook<number[]>(page, 'readPixel', 30, 30)).toEqual([250, 0, 0, 255]); // the 64x64 input keeps its transform, it is not stretched to the canvas
    expect(await hook<number[]>(page, 'readPixel', 200, 100)).not.toEqual([250, 0, 0, 255]);
    // Follow Input Size: back to the input resolution
    await menu(page, 'Document', 'Follow Input Size');
    await td.waitFor(() => td.setCanvasMessages.length === 2);
    expect(td.setCanvasMessages[1]).toMatchObject({ mode: 'input' });
    await expect.poll(async () => (await state(page)).doc).toEqual({ w: 64, h: 64 });
    await expect(page.locator('[data-status=canvas]')).toContainText('64 × 64 · Follow input');
  });

  test('anchor shifts the layers: growing a 160x90 canvas to 200x100 anchored bottom-right moves the TD Input by (40, 10)', async ({ page }) => {
    await open(page);
    await menu(page, 'Document', 'Canvas Size…');
    await page.locator('#cw').fill('200');
    await page.locator('#ch').fill('100');
    await page.locator('[data-anchor=br]').click();
    await page.locator('[data-canvas-ok]').click();
    await td.waitFor(() => td.setCanvasMessages.length === 1);
    await td.waitFor(() => specs().some((l) => l.kind === 'input' && l.x === 40 && l.y === 10));
  });

  test('undo / redo of a canvas size change tell TD (Docw/Doch revert and return)', async ({ page }) => {
    await open(page);
    await menu(page, 'Document', 'Canvas Size…');
    await page.locator('#cw').fill('320');
    await page.locator('#ch').fill('180');
    await page.locator('[data-canvas-ok]').click();
    await td.waitFor(() => td.w === 320 && td.h === 180 && td.mode === 'fixed');
    await page.locator('[data-viewport]').hover(); // focus is not in a field
    await page.keyboard.press('Control+z');
    await td.waitFor(() => td.mode === 'input' && td.w === 160 && td.h === 90);
    await expect.poll(async () => (await state(page)).doc).toEqual({ w: 160, h: 90 });
    expect(td.setCanvasMessages.map((m) => m.mode)).toEqual(['fixed', 'input']);
    await page.keyboard.press('Control+Shift+z');
    await td.waitFor(() => td.mode === 'fixed' && td.w === 320 && td.h === 180);
  });

  test('a page reconnecting after the input was removed updates its input from hello.inputs', async ({ page }) => {
    await open(page);
    td.sendSolidBase(10, 20, 30);
    await expect.poll(() => hook<number[]>(page, 'readPixel', 5, 5)).toEqual([10, 20, 30, 255]);
    td.removeInput();
    td.dropClient();
    await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked', { timeout: 8000 });
    await expect.poll(() => hook<any[]>(page, 'inputs')).toEqual([{ input: 1, w: 0, h: 0, connected: false }]);
    await expect.poll(async () => (await hook<any[]>(page, 'layers')).find((l) => l.kind === 'input')?.inputConnected).toBe(false);
  });

  test('a TD-initiated docSize (input resolution while following) updates the page without echoing setCanvas', async ({ page }) => {
    await open(page);
    td.resize(96, 54);
    await expect.poll(async () => (await state(page)).doc).toEqual({ w: 96, h: 54 });
    await page.waitForTimeout(200);
    expect(td.setCanvasMessages).toEqual([]);
  });
});

test.describe('guides', () => {
  test('guides live in TD\'s stored document and come back when the page is reloaded', async ({ page }) => {
    await open(page);
    await hook(page, 'addGuide', 'h', 30);
    await hook(page, 'addGuide', 'v', 70);
    await td.waitFor(() => td.doc!.guides.h.length === 1 && td.doc!.guides.v.length === 1);
    expect(td.doc!.guides).toEqual({ h: [30], v: [70] });
    await page.reload();
    await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
    await expect.poll(() => hook<any>(page, 'guides')).toEqual({ h: [30], v: [70] });
    expect(td.requestDocs).toBeGreaterThan(0); // a fresh page loads TD's document
    expect(td.docMessages).toBeGreaterThan(0);
  });

  test('dragging from the rulers with the mouse creates, moves and deletes guides (TD gets each doc)', async ({ page }) => {
    await open(page);
    await hook(page, 'setTool', 'move');
    const vp = (await page.locator('[data-viewport]').boundingBox())!;
    const top = (await page.locator('[data-ruler=top]').boundingBox())!;
    const p = await hook<{ x: number; y: number }>(page, 'docToScreen', 80, 50);
    // create a horizontal guide from the top ruler
    await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2);
    await page.mouse.down();
    await page.mouse.move(p.x, p.y, { steps: 6 });
    await page.mouse.up();
    await td.waitFor(() => td.doc!.guides.h.length === 1);
    expect(td.doc!.guides.h[0]).toBe(50);
    // move it
    const q = await hook<{ x: number; y: number }>(page, 'docToScreen', 120, 65);
    await page.mouse.move(p.x + 5, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 6 });
    await page.mouse.up();
    await td.waitFor(() => td.doc!.guides.h[0] === 65);
    // drag it back onto the ruler: gone
    await page.mouse.move(q.x + 5, q.y);
    await page.mouse.down();
    await page.mouse.move(vp.x + 40, top.y + top.height / 2, { steps: 6 });
    await page.mouse.up();
    await td.waitFor(() => td.doc!.guides.h.length === 0);
  });

  test('guides are drawn on the overlay and View > Show Guides hides them (per viewer, persisted)', async ({ page }) => {
    await open(page);
    await hook(page, 'addGuide', 'v', 80);
    const px = async () => {
      const p = await hook<{ x: number; y: number }>(page, 'docToScreen', 80, 20);
      const r = (await page.locator('[data-viewport]').boundingBox())!;
      return page.locator('[data-viewport] canvas').nth(1).evaluate((c: HTMLCanvasElement, [x, y]) => {
        const k = c.width / c.getBoundingClientRect().width;
        return Array.from(c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data);
      }, [p.x - r.x, p.y - r.y]);
    };
    await expect.poll(async () => { const c = await px(); return c[3] > 150 && Math.abs(c[0] - 24) < 6 && Math.abs(c[1] - 200) < 6 && Math.abs(c[2] - 224) < 6; }).toBe(true);
    await menu(page, 'View', 'Show Guides');
    await expect.poll(async () => (await px())[3]).toBe(0);
    await page.reload();
    await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
    expect(await page.evaluate(() => localStorage.getItem('raster-editor.view.guides'))).toBe('0');
    await menu(page, 'View', 'Show Guides');
    await expect.poll(async () => (await px())[3]).toBeGreaterThan(150);
  });
});

test.describe('transforms', () => {
  test('scaling and moving send the doc only (no SURFACE tiles) and the stored spec carries x, y, sx, sy', async ({ page }) => {
    await open(page);
    const rgba = new Uint8Array(80 * 40 * 4).fill(200);
    td.tops = [{ path: '/project1/small', w: 80, h: 40, rgba }];
    const id = await hook<string>(page, 'importImageFromTop', '/project1/small');
    await td.waitFor(() => specs().some((l) => l.id === id));
    await page.waitForTimeout(500); // the new layer's full surface has been sent
    await hook(page, 'setTool', 'move');
    await hook(page, 'setSnap', { enabled: false });
    const frames = td.frames.length, docs = td.docMessages;
    const before = specs().find((l) => l.id === id)!;
    const b = await hook<any>(page, 'layerBounds', id);
    // drag the south-east handle: shrink to 80%
    await mouseDragDoc(page, [b.x + b.w, b.y + b.h], [b.x + b.w * 0.8, b.y + b.h * 0.8]);
    await td.waitFor(() => Math.abs(specs().find((l) => l.id === id)!.sx - before.sx * 0.8) < 0.02);
    const s = specs().find((l) => l.id === id)!;
    expect(s.sy).toBeCloseTo(before.sy * 0.8, 1);
    expect([s.surfaceW, s.surfaceH]).toEqual([80, 40]);
    // and move it
    await mouseDragDoc(page, [b.x + 10, b.y + 5], [b.x + 30, b.y + 15]);
    await td.waitFor(() => Math.abs(specs().find((l) => l.id === id)!.x - (s.x + 20)) < 1.5);
    expect(td.docMessages).toBeGreaterThan(docs);
    await page.waitForTimeout(300);
    expect(td.frames.length).toBe(frames);
  });

  test('the TD Input can be moved and scaled like any layer; its transform is stored in the doc', async ({ page }) => {
    await open(page);
    td.sendSolidBase(40, 50, 60);
    await expect.poll(() => hook<number[]>(page, 'readPixel', 80, 45)).toEqual([40, 50, 60, 255]);
    await page.waitForTimeout(500);
    await hook(page, 'setTool', 'move');
    await hook(page, 'setSnap', { enabled: false });
    await page.locator('[data-layer="base"]').click();
    const frames = td.frames.length;
    await mouseDragDoc(page, [80, 45], [100, 55]);
    await td.waitFor(() => specs().some((l) => l.kind === 'input' && Math.abs(l.x - 20) < 1.5 && Math.abs(l.y - 10) < 1.5));
    expect(td.frames).toHaveLength(frames);
  });

  test('context bar fields: W with the aspect lock scales both axes', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'New pixel layer' }).click();
    await hook(page, 'setTool', 'move');
    const id = (await state(page)).activeLayer as string;
    await td.waitFor(() => specs().some((l) => l.id === id));
    const b = await hook<any>(page, 'layerBounds', id);
    await page.locator('#mw').fill(String(b.w / 2));
    await page.locator('#mw').blur();
    await td.waitFor(() => Math.abs(specs().find((l) => l.id === id)!.sx - 0.5) < 0.01);
    expect(specs().find((l) => l.id === id)!.sy).toBeCloseTo(0.5, 2);
    await page.getByRole('button', { name: 'Reset Transform' }).click();
    await td.waitFor(() => specs().find((l) => l.id === id)!.sx === 1);
  });
});

const REVIEW = resolve(process.cwd(), '../dist/review');
for (const [w, h] of [[1600, 960], [1280, 800], [1024, 700]] as const) {
  test(`rulers do not break the layout at ${w}x${h} (single-row context bar, rail, status bar, rulers 18 px)`, async ({ page }) => {
    td = await FakeTd.start({ w: 8, h: 8 });
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?standalone=1&test=1');
    await expect(page.locator('[data-tool]')).toHaveCount(19);
    for (const tool of ['brush', 'move']) {
      await hook(page, 'setTool', tool);
      const r = await page.locator('[data-context-bar]').evaluate((el) => {
        const tops = new Set([...el.querySelectorAll<HTMLElement>('.ctx-tool, .opts > *')].filter((c) => c.offsetParent !== null).map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)));
        const kids = [...el.querySelectorAll<HTMLElement>('.opts > *')].filter((c) => c.offsetParent !== null);
        return { rows: tops.size, overflowX: el.scrollWidth > el.clientWidth + 1, right: Math.max(...kids.map((c) => c.getBoundingClientRect().right)), view: el.getBoundingClientRect().right, height: el.getBoundingClientRect().height };
      });
      if (w >= 1180) {
        expect(r.rows, `${tool} rows`).toBe(1);
        expect(r.overflowX, `${tool} overflow`).toBe(false);
        expect(r.right, `${tool} right edge`).toBeLessThanOrEqual(r.view);
      } else {
        expect(r.height, `${tool} bar height`).toBeLessThan(140);
      }
    }
    const rulers = await page.evaluate(() => {
      const t = document.querySelector('[data-ruler=top]')!.getBoundingClientRect(), l = document.querySelector('[data-ruler=left]')!.getBoundingClientRect();
      const v = document.querySelector('[data-viewport]')!.getBoundingClientRect(), doc = document.documentElement.clientWidth;
      return { th: t.height, lw: l.width, tTop: t.top, vTop: v.top, vLeft: v.left, lRight: l.right, vRight: v.right, vBottom: v.bottom, doc, vh: window.innerHeight, scrollX: document.documentElement.scrollWidth > doc };
    });
    expect(rulers.th).toBe(18);
    expect(rulers.lw).toBe(18);
    expect(Math.abs(rulers.vTop - (rulers.tTop + 18))).toBeLessThan(1.5);
    expect(Math.abs(rulers.vLeft - rulers.lRight)).toBeLessThan(1.5);
    expect(rulers.vRight).toBeLessThanOrEqual(rulers.doc);
    expect(rulers.scrollX).toBe(false);
    expect((await page.locator('[data-viewport]').boundingBox())!.height).toBeGreaterThan(h * 0.5 - 100);
    const rail = await page.locator('[data-rail]').evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(rail).toBe(false);
    const status = await page.locator('[data-status=connection]').evaluate((el) => {
      const bar = el.parentElement!;
      return { overflowX: bar.scrollWidth > bar.clientWidth + 1, right: el.getBoundingClientRect().right, view: document.documentElement.clientWidth };
    });
    expect(status.overflowX).toBe(false);
    expect(status.right).toBeLessThanOrEqual(status.view);
    mkdirSync(REVIEW, { recursive: true });
    await page.screenshot({ path: resolve(REVIEW, `rulers-${w}x${h}.png`) });
  });
}

test('View > Show Rulers hides the rulers and gives the space back to the viewport', async ({ page }) => {
  td = await FakeTd.start({ w: 8, h: 8 });
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-ruler]')).toHaveCount(2);
  const before = (await page.locator('[data-viewport]').boundingBox())!;
  await menu(page, 'View', 'Show Rulers');
  await expect(page.locator('[data-ruler]')).toHaveCount(0);
  const after = (await page.locator('[data-viewport]').boundingBox())!;
  expect(after.width - before.width).toBeCloseTo(18, 0);
  expect(after.height - before.height).toBeCloseTo(18, 0);
  await page.reload();
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await expect(page.locator('[data-ruler]')).toHaveCount(0); // remembered per viewer
});

void ({} as LayerSpec);
