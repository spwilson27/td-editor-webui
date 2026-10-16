import { expect, test, type Page } from '@playwright/test';
import { FakeTd } from './fakeTd';

// v7.1: layer copy / paste / duplicate / Cmd-drag copy against the fake TD (document + uploaded surfaces).
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
const specs = () => td.doc!.layers;
const ids = () => specs().map((l) => l.id);
const row = (page: Page, id: string) => page.locator(`[data-layer="${id}"]`);
const settle = () => new Promise((r) => setTimeout(r, 300));
const surf = (slot: number) => Array.from(td.surfaces.get(slot) ?? []);
const nonEmpty = (slot: number) => (td.surfaces.get(slot) ?? []).some((v) => v !== 0);

/** A painted pixel layer with a drop shadow, plus a group holding two painted layers. */
const scene = async (page: Page) => {
  await hook(page, 'setPrimary', '#c83c28');
  const px = await hook<string>(page, 'addLayer');
  await hook(page, 'stroke', 'brush', [[20, 20], [80, 20], [80, 60]]);
  await hook(page, 'addFilterEffect', px, 'invert');
  const g = await hook<string>(page, 'addGroup');
  const c1 = await hook<string>(page, 'addLayer');
  await hook(page, 'stroke', 'brush', [[30, 70], [120, 70]]);
  const c2 = await hook<string>(page, 'addLayer');
  await hook(page, 'stroke', 'brush', [[100, 10], [100, 80]]);
  await hook(page, 'moveLayer', c1, g, 0);
  await hook(page, 'moveLayer', c2, g, 0);
  await td.waitFor(() => specs().find((l) => l.id === c2)?.parentId === g && specs().find((l) => l.id === px)?.effects.length === 1);
  await td.waitFor(() => [px, c1, c2].every((id) => nonEmpty(specs().find((l) => l.id === id)!.slot!)));
  await settle();
  return { px, g, c1, c2 };
};

test('Ctrl+C / Ctrl+V: pixel layer with effects + group with children reach the TD doc with new ids, slots and equal pixels', async ({ page }) => {
  await open(page);
  const { px, g, c1, c2 } = await scene(page);
  const before = new Set(ids());
  await hook(page, 'selectLayers', [px, g]);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await td.waitFor(() => ids().length === before.size + 4);
  const fresh = specs().filter((l) => !before.has(l.id));
  expect(fresh.map((l) => l.kind).sort()).toEqual(['group', 'pixel', 'pixel', 'pixel']);
  const nGroup = fresh.find((l) => l.kind === 'group')!;
  const kids = fresh.filter((l) => l.parentId === nGroup.id);
  expect(kids).toHaveLength(2);
  const nPx = fresh.find((l) => l.kind === 'pixel' && l.parentId === nGroup.parentId && l.id !== kids[0].id && l.id !== kids[1].id)!;
  expect(nPx.effects).toEqual(specs().find((l) => l.id === px)!.effects);
  const usedSlots = specs().filter((l) => l.slot != null).map((l) => l.slot);
  expect(new Set(usedSlots).size).toBe(usedSlots.length); // every copy owns its slot
  // the originals stay
  expect(specs().find((l) => l.id === px)!.slot).not.toBe(nPx.slot);
  for (const id of [px, g, c1, c2]) expect(ids()).toContain(id);
  // pixels uploaded for the new slots equal the source's
  const srcSlots = [px, c1, c2].map((id) => specs().find((l) => l.id === id)!.slot!);
  const copySlots = [nPx.slot!, ...kids.map((k) => k.slot!)];
  await td.waitFor(() => copySlots.every(nonEmpty));
  await td.waitFor(() => surf(nPx.slot!).join() === surf(srcSlots[0]).join());
  // children keep their relative order: matching painted content in some source child
  for (const k of kids) {
    await td.waitFor(() => srcSlots.slice(1).some((s) => surf(s).join() === surf(k.slot!).join()));
  }
  await expect(row(page, nGroup.id)).toBeVisible();
});

test('Cmd/Ctrl+J duplicates; undo removes the copies in the TD doc; hook paste works too', async ({ page }) => {
  await open(page);
  const { px } = await scene(page);
  const n = ids().length;
  await hook(page, 'selectLayers', [px]);
  await page.keyboard.press('Control+j');
  await td.waitFor(() => ids().length === n + 1);
  const dup = specs().find((l) => !ids().slice(0, n).includes(l.id) && l.kind === 'pixel' && l.id !== px && specs().indexOf(l) === specs().findIndex((x) => x.id === px) + 1)
    ?? specs().find((l) => l.id !== px && l.kind === 'pixel' && surf(l.slot!).join() === surf(specs().find((x) => x.id === px)!.slot!).join());
  expect(dup).toBeTruthy();
  await td.waitFor(() => surf(dup!.slot!).join() === surf(specs().find((x) => x.id === px)!.slot!).join());
  await page.keyboard.press('Control+z');
  await td.waitFor(() => ids().length === n && !ids().includes(dup!.id));
  // copy via the hook, paste via the hook, undo
  await hook(page, 'selectLayers', [px]);
  expect(await hook<boolean>(page, 'copySelected')).toBe(true);
  const pasted = await hook<string[]>(page, 'pasteLayers');
  expect(pasted).toHaveLength(1);
  await td.waitFor(() => ids().includes(pasted[0]));
  await page.keyboard.press('Control+z');
  await td.waitFor(() => !ids().includes(pasted[0]) && ids().length === n);
});

test('paste after painting the source: the copy keeps the clipboard snapshot (not the new strokes)', async ({ page }) => {
  await open(page);
  const { px } = await scene(page);
  await hook(page, 'selectLayers', [px]);
  await hook(page, 'copySelected');
  const slot = specs().find((l) => l.id === px)!.slot!;
  const snap = surf(slot).join();
  await hook(page, 'stroke', 'brush', [[10, 80], [150, 80]]);
  await td.waitFor(() => surf(slot).join() !== snap);
  const [id] = await hook<string[]>(page, 'pasteLayers');
  await td.waitFor(() => ids().includes(id) && specs().find((l) => l.id === id)!.slot != null);
  const ns = specs().find((l) => l.id === id)!.slot!;
  await td.waitFor(() => surf(ns).join() === snap);
});

test('Cmd-drag in the layers panel copies (original stays); Cmd+click without movement only toggles selection; undo removes the copy', async ({ page }) => {
  await open(page);
  const { px, c1 } = await scene(page);
  const n = ids().length;
  const top = specs().at(-1)!.id; // topmost layer
  // Cmd+click without movement toggles selection, no copy
  await page.locator(`[data-layer="${px}"] [data-act=sel]`).click();
  await page.locator(`[data-layer="${c1}"] [data-act=sel]`).click({ modifiers: ['Meta'] });
  await expect(page.locator('[data-layer][data-selected=true]')).toHaveCount(2);
  await page.locator(`[data-layer="${c1}"] [data-act=sel]`).click({ modifiers: ['Meta'] });
  await expect(page.locator('[data-layer][data-selected=true]')).toHaveCount(1);
  await settle();
  expect(ids().length).toBe(n);
  // Cmd-drag px onto the top half of the topmost row
  await page.locator(`[data-layer="${px}"] [data-act=sel]`).click();
  const from = (await row(page, px).boundingBox())!, to = (await row(page, top).boundingBox())!;
  await page.keyboard.down('Meta');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 3, { steps: 8 });
  await expect(page.locator('[data-drop-indicator][data-drop-copy]')).toHaveCount(1);
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await td.waitFor(() => ids().length === n + 1);
  expect(ids()).toContain(px); // the original stays
  const copy = specs().find((l) => l.kind === 'pixel' && l.id !== px && l.effects.length === 1 && l.name.includes(specs().find((x) => x.id === px)!.name))!;
  expect(copy).toBeTruthy();
  await td.waitFor(() => surf(copy.slot!).join() === surf(specs().find((x) => x.id === px)!.slot!).join());
  await page.keyboard.press('Control+z');
  await td.waitFor(() => ids().length === n && !ids().includes(copy.id));
  expect(ids()).toContain(px);
});
