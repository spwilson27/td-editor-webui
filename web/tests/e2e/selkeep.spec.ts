import { expect, test, type Page } from '@playwright/test';

const hook = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__editorTest[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

test('the selection stays after an adjustment is added (the mask is made from it); real engine, standalone', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await hook(page, 'selectRect', 20, 20, 60, 40);
  const before = await hook<any>(page, 'selectionMask');
  expect(before).not.toBeNull();
  for (const add of [() => hook(page, 'addAdjustment', 'invert'), () => hook(page, 'addFilterAdjustment', 'blur')]) {
    const id = await add();
    const l = (await hook<any[]>(page, 'layers')).find((x) => x.id === id);
    expect(l.mask).not.toBeNull();
    const after = await hook<any>(page, 'selectionMask');
    expect(after, 'selection after adding an adjustment').not.toBeNull();
    expect(after.rect).toEqual(before.rect);
  }
});

test('the selection also stays when the adjustment is added from the menus', async ({ page }) => {
  await page.goto('/?standalone=1&test=1');
  await expect(page.locator('[data-tool]').first()).toBeVisible();
  await hook(page, 'selectRect', 20, 20, 60, 40);
  await page.getByRole('button', { name: 'New adjustment' }).click();
  await page.locator('[data-adjustment=invert]').click();
  expect(await hook<any>(page, 'selectionMask')).not.toBeNull();
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'New adjustment' }).click();
  await page.locator('[data-adjustment-filter=posterize]').click();
  expect(await hook<any>(page, 'selectionMask')).not.toBeNull();
  await page.getByRole('button', { name: 'Layer', exact: true }).click();
  await page.locator('[data-flyout=filters]').click();
  await page.locator('[data-new-filter-adjustment=twirl]').click();
  expect(await hook<any>(page, 'selectionMask')).not.toBeNull();
  // painting on the new mask does not clear it either
  await page.waitForTimeout(300);
  expect(await hook<any>(page, 'selectionMask')).not.toBeNull();
  expect((await hook<any>(page, 'state')).selection).not.toBeNull();
});

test('linked to TD (panel): the selection stays after adding adjustments, also once TD has echoed the document', async ({ page }) => {
  const { FakeTd } = await import('./fakeTd');
  const td = await FakeTd.start({ w: 160, h: 90 });
  try {
    await page.goto(`/?test=1&client=panel&ws=${encodeURIComponent(td.url)}&token=${td.token}`);
    await expect(page.locator('[data-status=connection]')).toContainText('TouchDesigner linked');
    await td.waitFor(() => td.doc !== null);
    await hook(page, 'addLayer');
    await hook(page, 'selectRect', 20, 20, 60, 40);
    const id = await hook<string>(page, 'addAdjustment', 'invert');
    await td.waitFor(() => !!td.doc?.layers.find((l) => l.id === id)?.mask);
    expect(await hook<any>(page, 'selectionMask')).not.toBeNull();
    const id2 = await hook<string>(page, 'addFilterAdjustment', 'blur');
    await td.waitFor(() => !!td.doc?.layers.find((l) => l.id === id2)?.mask);
    await page.waitForTimeout(500);
    expect(await hook<any>(page, 'selectionMask')).not.toBeNull();
  } finally {
    await td.close();
  }
});
