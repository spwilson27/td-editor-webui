import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDrop } from '../../src/state/layerDrop';
import { onKeyDown } from '../../src/state/keyboard';
import { MERGE_DOWN_TITLE, MERGE_GROUP_TITLE, FLATTEN_TITLE } from '../../src/state/layersSlice';
import { defaultEffect } from '../../src/state/effectDefaults';
import { store } from '../../src/state/store';
import { LayersPanel } from '../../src/ui/LayersPanel';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { centre, freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const row = (id: string) => q(`[data-layer="${id}"]`);
const sel = (id: string) => q('[data-act=sel]', row(id));
const names = () => [...document.querySelectorAll('[data-layer] [data-name]')].map((e) => e.textContent);
const selected = () => [...document.querySelectorAll('[data-layer][data-selected=true]')].map((e) => e.getAttribute('data-layer'));
const last = (prefix: string) => [...engine.calls].reverse().find((c) => c.startsWith(prefix));
const click = (id: string, mods: MouseEventInit = {}) => { sel(id).dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods })); };
const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: unknown }> = {}) => {
  let prevented = false;
  onKeyDown(store, { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: document.body, preventDefault() { prevented = true; }, ...mods });
  return prevented;
};

/** base, L1..L4 (L4 on top), all pixel layers. */
async function four() {
  for (let i = 0; i < 4; i++) store.addLayer();
  await settle();
}

beforeEach(async () => {
  engine = freshEngine();
  store.connection.value = 'standalone';
  await mount(<><TopBar /><LayersPanel /></>, 'width:300px;height:640px;display:flex;flex-direction:column');
});
afterEach(() => { store.bridge = null; unmount(); });

describe('group visuals', () => {
  async function scene() {
    store.addGroup();
    const g = engine.activeLayerId()!;
    const a = store.addLayer(), b = store.addLayer();
    engine.moveLayer(a, g, 0); engine.moveLayer(b, g, 0);
    await settle();
    return { g, a, b };
  }

  it('an open group: folder icon + chevron, tinted header, indented children with a guide line, one group end on the last child', async () => {
    const { g, a, b } = await scene();
    expect(q('[data-folder=open]', row(g))).toBeTruthy();
    expect(q('[data-act=open]', row(g)).getAttribute('aria-expanded')).toBe('true');
    expect(row(g).hasAttribute('data-group-header')).toBe(true);
    expect(row(g).style.getPropertyValue('--tint')).toContain('linear-gradient');
    for (const id of [a, b]) {
      expect(row(id).getAttribute('data-depth')).toBe('1');
      expect(parseInt(row(id).style.paddingLeft)).toBeGreaterThan(parseInt(row(g).style.paddingLeft)); // indented
      expect(row(id).style.getPropertyValue('--tint')).toContain('linear-gradient'); // tinted block behind the children
      expect(row(id).querySelector(`[data-guide="${g}"]`)).toBeTruthy(); // guide line spans every child
    }
    // the header's own guide starts below the header row; the end of the group is drawn once, on the last child
    expect(row(g).querySelector(`[data-guide="${g}"]`)).toBeTruthy();
    expect(document.querySelectorAll(`[data-group-end="${g}"]`).length).toBe(1);
    expect(row(a).querySelector(`[data-group-end="${g}"]`)).toBeTruthy(); // a is the lower child (display order: b, a)
    expect(row(b).querySelector('[data-group-end]')).toBeNull();
    expect(row(g).querySelector('[data-child-count]')).toBeNull(); // the count is for collapsed groups
    // guide and tint share the group's colour
    const guide = row(a).querySelector<HTMLElement>(`[data-guide="${g}"]`)!;
    expect(guide.style.background).toBe(row(b).querySelector<HTMLElement>(`[data-guide="${g}"]`)!.style.background);
    expect(guide.style.background).not.toBe('');
  });

  it('a collapsed group: closed folder, child count, children gone', async () => {
    const { g } = await scene();
    q('[data-act=open]', row(g)).click();
    await settle();
    expect(q('[data-folder=closed]', row(g))).toBeTruthy();
    expect(q('[data-child-count]', row(g)).textContent).toBe('2');
    expect(document.querySelectorAll('[data-layer]').length).toBe(2); // group + base
    expect(document.querySelectorAll('[data-guide]').length).toBe(0);
  });

  it('nested groups draw one guide per ancestor in their own colours; both ends show on the last row', async () => {
    const { g, a } = await scene();
    store.addGroup();
    const inner = engine.activeLayerId()!;
    engine.moveLayer(inner, g, 1); // below b, above a
    engine.moveLayer(a, inner, 0);
    await settle();
    const guides = [...row(a).querySelectorAll('[data-guide]')].map((e) => e.getAttribute('data-guide'));
    expect(guides).toEqual([g, inner]);
    expect(row(a).getAttribute('data-depth')).toBe('2');
    expect([...row(a).querySelectorAll('[data-group-end]')].map((e) => e.getAttribute('data-group-end'))).toEqual([g, inner]);
  });

  describe('drop indicator', () => {
    const dragTo = (from: string, to: string, frac: number) => {
      const list = q('[data-layer-list]');
      const [fx, fy] = centre(q('[data-act=sel]', row(from)));
      const tr = row(to).getBoundingClientRect();
      const ty = tr.top + tr.height * frac;
      q('[data-act=sel]', row(from)).dispatchEvent(ptr('pointerdown', { clientX: fx, clientY: fy }));
      list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: (fy + ty) / 2 }));
      list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: ty }));
      return { list, x: fx, y: ty };
    };
    const ind = () => q('[data-drop-indicator]');

    it('shows the insertion line at the depth of the drop: into a group, inside it, and out of it', async () => {
      const { g, a, b } = await scene();
      const o = store.addLayer(); // outside, above the group
      engine.moveLayer(o, null, 0);
      await settle();
      // over the middle of the group header: into the group, one level deeper
      dragTo(o, g, 0.5);
      await settle();
      expect([ind().getAttribute('data-drop-zone'), ind().getAttribute('data-drop-depth')]).toEqual(['into', '1']);
      expect(row(g).style.boxShadow).toContain('inset');
      // upper half of a child: between children, depth 1
      dragTo(o, a, 0.1);
      await settle();
      expect([ind().getAttribute('data-drop-zone'), ind().getAttribute('data-drop-depth')]).toEqual(['before', '1']);
      expect(parseInt(ind().style.left)).toBeGreaterThan(parseInt(row(g).style.paddingLeft));
      // lower half of the base row (outside the group): depth 0, the left edge moves out
      dragTo(b, 'base', 0.9);
      await settle();
      expect(ind().getAttribute('data-drop-depth')).toBe('0');
      const out = parseInt(ind().style.left);
      dragTo(b, a, 0.9);
      await settle();
      expect(parseInt(ind().style.left)).toBeGreaterThan(out);
      expect(document.querySelectorAll('[data-drop-indicator]').length).toBe(1);
    });

    it('drops of a child below the last row of its group leave the group when released past the group end', async () => {
      const { g, b } = await scene();
      const o = store.addLayer();
      engine.moveLayer(o, null, 0);
      await settle();
      const d = dragTo(b, o, 0.9); // below the outside layer: moved out of the group
      d.list.dispatchEvent(ptr('pointerup', { clientX: d.x, clientY: d.y }));
      await settle();
      expect(last('move:')).toMatch(new RegExp(`^move:${b}:null:`));
      expect(engine.layers().find((l) => l.id === b)!.parentId).toBeNull();
      expect(engine.layers().find((l) => l.id === g)).toBeTruthy();
    });
  });
});

describe('multi-select', () => {
  it('click selects one; Cmd/Ctrl+click toggles; Shift+click selects the range in display order; the active layer is the last clicked', async () => {
    await four(); // display: L4 L3 L2 L1 base
    click('L3');
    await settle();
    expect(selected()).toEqual(['L3']);
    click('L1', { metaKey: true });
    await settle();
    expect(selected().sort()).toEqual(['L1', 'L3']);
    expect(engine.activeLayerId()).toBe('L1');
    expect(row('L1').classList.contains('sel')).toBe(true); // the active row is the strong highlight
    expect(row('L3').classList.contains('sel2')).toBe(true);
    click('L3', { ctrlKey: true }); // toggle off
    await settle();
    expect(selected()).toEqual(['L1']);
    click('L4');
    click('L2', { shiftKey: true });
    await settle();
    expect(selected()).toEqual(['L4', 'L3', 'L2']);
    expect(engine.activeLayerId()).toBe('L2');
    click('base', { shiftKey: true }); // the range is anchored at the last plain click (L4)
    await settle();
    expect(selected()).toEqual(['L4', 'L3', 'L2', 'L1', 'base']);
    click('L1');
    await settle();
    expect(selected()).toEqual(['L1']);
  });

  it('a range covers the visible rows only (a collapsed group counts as one row)', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    const c = store.addLayer();
    engine.moveLayer(c, g, 0);
    engine.setLayerProps(g, { expanded: false });
    engine.setActiveLayer(g);
    const top = store.addLayer();
    await settle();
    click(top);
    click('base', { shiftKey: true });
    await settle();
    expect(selected()).toEqual([top, g, 'base']);
  });

  it('Delete (key) and the footer button delete the whole selection in one engine call; Undo restores it in one step', async () => {
    await four();
    click('L4');
    click('L2', { metaKey: true });
    click('L1', { shiftKey: true });
    await settle();
    expect(selected()).toEqual(['L2', 'L1']); // Shift ranges from the last plain/toggle click
    const ids = store.selectedIds();
    expect(ids).toEqual(['L2', 'L1']);
    const before = engine.history().entries.length;
    expect(key('Delete')).toBe(true);
    await settle();
    expect(last('deleteLayers')).toBe(`deleteLayers:${ids.join(',')}`);
    expect(engine.calls.filter((c) => c.startsWith('deleteLayers'))).toHaveLength(1);
    expect(engine.history().entries.length).toBe(before + 1); // one undo step
    for (const id of ids) expect(document.querySelector(`[data-layer="${id}"]`)).toBeNull();
    engine.undo();
    await settle();
    for (const id of ids) expect(document.querySelector(`[data-layer="${id}"]`)).toBeTruthy();
    // footer button, with the count in its tooltip
    click('L3');
    click('L2', { metaKey: true });
    await settle();
    expect(q('[aria-label="Delete layer"]').title).toBe('Delete 2 layers');
    q('[aria-label="Delete layer"]').click();
    await settle();
    expect(last('deleteLayers')).toBe('deleteLayers:L3,L2');
  });

  it('keyboard shortcuts are ignored while typing', async () => {
    await four();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    expect(key('Delete', { target: input })).toBe(false);
    expect(key('g', { ctrlKey: true, target: input })).toBe(false);
    input.remove();
    expect(engine.calls.some((c) => c.startsWith('deleteLayers') || c.startsWith('groupLayers'))).toBe(false);
  });

  it('eye and lock on a selected row apply to every selected layer (one engine call); on an unselected row only to it', async () => {
    await four();
    click('L4');
    click('L2', { metaKey: true });
    click('L3', { shiftKey: true });
    await settle();
    const ids = store.selectedIds();
    q('[data-act=vis]', row('L3')).click();
    expect(last('setLayersProps')).toBe(`setLayersProps:${ids.join(',')}:{"visible":false}`);
    await settle();
    for (const id of ids) expect(q('[data-act=vis]', row(id)).getAttribute('aria-pressed')).toBe('false');
    q('[data-act=lock]', row('L2')).click();
    expect(last('setLayersProps')).toBe(`setLayersProps:${ids.join(',')}:{"locked":true}`);
    // L1 is not selected: a plain single-layer call
    q('[data-act=vis]', row('L1')).click();
    expect(last('props:L1')).toBe('props:L1:{"visible":false}');
  });

  it('dragging a selected row moves the whole selection with one moveLayers call', async () => {
    await four(); // L4 L3 L2 L1 base
    click('L4');
    click('L3', { metaKey: true });
    await settle();
    const list = q('[data-layer-list]');
    const [fx, fy] = centre(sel('L4'));
    const tr = row('L1').getBoundingClientRect();
    const ty = tr.top + tr.height * 0.9;
    sel('L4').dispatchEvent(ptr('pointerdown', { clientX: fx, clientY: fy }));
    list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: (fy + ty) / 2 }));
    list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: ty }));
    list.dispatchEvent(ptr('pointerup', { clientX: fx, clientY: ty }));
    await settle();
    expect(last('moveLayers')).toBe('moveLayers:L4,L3:null:2'); // below L1 (2 siblings remain above the target slot: L2, L1)
    expect(engine.calls.some((c) => c.startsWith('move:'))).toBe(false);
    expect(names().slice(0, 4)).toEqual(['Layer 2', 'Layer 1', 'Layer 4', 'Layer 3'].slice(0, 4));
    expect(selected().sort()).toEqual(['L3', 'L4']); // the drag does not collapse the selection
  });

  it('Group Layers (Ctrl+G and Layer menu) wraps the selection in a new group; Merge Selected is disabled standalone', async () => {
    await four();
    click('L3');
    click('L2', { shiftKey: true });
    await settle();
    expect(key('g', { ctrlKey: true })).toBe(true);
    await settle();
    expect(last('groupLayers')).toBe('groupLayers:L3,L2');
    const g = engine.activeLayerId()!;
    expect(engine.layers().find((l) => l.id === g)!.kind).toBe('group');
    expect(engine.layers().filter((l) => l.parentId === g).map((l) => l.id).sort()).toEqual(['L2', 'L3']);
    expect(selected()).toEqual([g]);
    // the menu
    click('L1');
    click('L1', { metaKey: false });
    const menu = [...document.querySelectorAll<HTMLElement>('button.menu')].find((b) => b.textContent === 'Layer')!;
    menu.click();
    await settle();
    const item = (t: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.startsWith(t))!;
    expect(item('Group Layers').getAttribute('aria-disabled')).toBe('false');
    expect(item('Group Layers').textContent).toContain('Ctrl+G');
    expect(item('Merge Selected').getAttribute('aria-disabled')).toBe('true');
    item('Group Layers').click();
    await settle();
    expect(last('groupLayers')).toBe('groupLayers:L1');
  });

  it('Merge Selected renders the selection through the bridge (renderLayers) and the layers become one pixel layer', async () => {
    await four();
    const calls: string[][] = [];
    store.bridge = {
      listTops: async () => [], importTop: async () => '',
      renderLayers: async (ids: string[]) => { calls.push(ids); engine.replaceLayersWithPixels(ids, new Uint8Array(64 * 48 * 4), 64, 48, 'Merged'); },
    };
    store.connection.value = 'linked';
    click('L4');
    click('L2', { shiftKey: true });
    await settle();
    const menu = [...document.querySelectorAll<HTMLElement>('button.menu')].find((b) => b.textContent === 'Layer')!;
    menu.click();
    await settle();
    const merge = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.startsWith('Merge Selected'))!;
    expect(merge.getAttribute('aria-disabled')).toBe('false');
    merge.click();
    await settle();
    await settle();
    expect(calls).toEqual([['L4', 'L3', 'L2']]);
    expect(engine.replacedMany).toMatchObject([{ ids: ['L4', 'L3', 'L2'], w: 64, h: 48 }]);
    expect(names()).toEqual(['Merged', 'Layer 1', 'TD Input 1']);
    expect(store.flattening.value).toBeNull();
  });

  it('Merge Selected needs two layers', async () => {
    await four();
    store.bridge = { listTops: async () => [], importTop: async () => '', renderLayers: async () => undefined };
    store.connection.value = 'linked';
    click('L2');
    await settle();
    expect(store.canMergeSelected()).toBe(false);
    click('L3', { metaKey: true });
    await settle();
    expect(store.canMergeSelected()).toBe(true);
  });

  it('the selection is pruned when layers disappear, and collapses to a newly active layer', async () => {
    await four();
    click('L4');
    click('L3', { metaKey: true });
    await settle();
    expect(store.selectedIds().sort()).toEqual(['L3', 'L4']);
    engine.deleteLayers(['L3']);
    await settle();
    expect(store.layerSel.value).not.toContain('L3');
    expect(selected()).toEqual(['L4']);
    click('L4', { metaKey: true }); // the last selected layer cannot be toggled off
    await settle();
    expect(selected()).toEqual(['L4']);
    click('L1');
    click('L2', { metaKey: true });
    store.addLayer(); // a new active layer replaces the selection
    await settle();
    expect(selected()).toEqual([engine.activeLayerId()]);
  });
});

describe('Flatten button', () => {
  const stub = (calls: string[]) => ({
    listTops: async () => [], importTop: async () => '', renderLayers: async () => undefined,
    renderLayer: async (id: string, mode?: string) => { calls.push(`${id}:${mode}`); },
  });
  const btn = (id: string) => q<HTMLElement>('[data-act=flatten]', row(id));
  const disabled = (id: string) => btn(id).getAttribute('aria-disabled') === 'true';

  it('is on every row, per-kind tooltips, disabled where meaningless', async () => {
    store.bridge = stub([]);
    store.connection.value = 'linked';
    const px = engine.addPixelLayer('Plain');
    const fx = engine.addPixelLayer('WithFx');
    engine.setEffects(fx, [defaultEffect('invert')]);
    const mk = engine.addPixelLayer('Masked');
    engine.addMask(mk);
    store.addGroup();
    const g = engine.activeLayerId()!;
    const gc = store.addLayer();
    engine.moveLayer(gc, g, 0);
    const emptyG = engine.addGroup('Empty');
    const adj = store.addAdjustment('invert');
    await settle();
    expect(document.querySelectorAll('[data-layer]').length).toBe(document.querySelectorAll('[data-layer] [data-act=flatten]').length);
    expect(disabled(px)).toBe(true);
    expect(disabled('base')).toBe(true);
    expect(btn(fx).title).toBe(FLATTEN_TITLE);
    expect(disabled(fx)).toBe(false);
    expect(disabled(mk)).toBe(false);
    expect(btn(g).title).toBe(MERGE_GROUP_TITLE);
    expect(disabled(g)).toBe(false);
    expect(disabled(emptyG)).toBe(true); // nothing to merge
    expect(btn(adj).title).toBe(MERGE_DOWN_TITLE);
    expect(disabled(adj)).toBe(false);
    // an adjustment with nothing below: add it to an empty group
    store.addGroup();
    const g2 = engine.activeLayerId()!;
    const a2 = engine.addAdjustmentLayer([defaultEffect('invert')]);
    engine.moveLayer(a2, g2, 0);
    await settle();
    expect(disabled(a2)).toBe(true);
    // a transformed pixel layer can be baked
    const tr = engine.addPixelLayer('Moved');
    engine.setTransform(tr, { x: 5, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
    await settle();
    expect(disabled(tr)).toBe(false);
  });

  it('click sends flatten for layers and groups, mergeDown for adjustments (the bridge picks the layer below)', async () => {
    const calls: string[] = [];
    store.bridge = stub(calls);
    store.connection.value = 'linked';
    const fx = engine.addPixelLayer('WithFx');
    engine.setEffects(fx, [defaultEffect('invert')]);
    store.addGroup();
    const g = engine.activeLayerId()!;
    engine.moveLayer(store.addLayer(), g, 0);
    const adj = store.addAdjustment('threshold');
    await settle();
    btn(fx).click(); await settle();
    btn(g).click(); await settle();
    btn(adj).click(); await settle();
    expect(calls).toEqual([`${fx}:flatten`, `${g}:flatten`, `${adj}:mergeDown`]);
  });

  it('standalone: disabled with a tooltip about TouchDesigner, and nothing is sent', async () => {
    const calls: string[] = [];
    store.bridge = stub(calls);
    store.connection.value = 'standalone';
    const fx = engine.addPixelLayer('WithFx');
    engine.setEffects(fx, [defaultEffect('invert')]);
    await settle();
    expect(disabled(fx)).toBe(true);
    expect(btn(fx).title).toBe('Flatten to pixels (needs TouchDesigner)');
    btn(fx).click();
    await settle();
    expect(calls).toEqual([]);
  });

  it('there is no per-row fx button; the footer Layer Effects button and the fx badge stay', async () => {
    const fx = engine.addPixelLayer('WithFx');
    engine.setEffects(fx, [defaultEffect('invert')]);
    await settle();
    expect(document.querySelector('[data-act=fx]')).toBeNull();
    expect(q('[data-fx-badge]', row(fx))).toBeTruthy();
    expect(q('[aria-label="Layer effects"]')).toBeTruthy();
  });
});

describe('Delete key rules', () => {
  const del = (over: Partial<Parameters<typeof onKeyDown>[1]> = {}) => {
    let prevented = false;
    onKeyDown(store, { key: 'Delete', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: document.body, preventDefault() { prevented = true; }, ...over });
    return prevented;
  };
  const deletes = () => engine.calls.filter((c) => c.startsWith('deleteLayers'));

  it('is ignored when already handled, or aimed at anything but the page, a canvas or the layer list', async () => {
    await four();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    expect(del({ defaultPrevented: true })).toBe(false);
    expect(del({ target: btn })).toBe(false);
    expect(deletes()).toHaveLength(0);
    expect(del({ target: q('[data-act=vis]', row('L1')) })).toBe(true); // a button inside the layer list is fine
    expect(deletes()).toHaveLength(1);
    btn.remove();
  });

  it('does nothing while a crop box or a pixel selection exists (the engine has no clear op)', async () => {
    await four();
    store.cropBox.value = { x: 0, y: 0, w: 4, h: 4 };
    expect(del()).toBe(false);
    store.cropBox.value = null;
    engine.setSelection({ x: 1, y: 1, w: 5, h: 5 });
    expect(del()).toBe(false);
    expect(deletes()).toHaveLength(0);
    engine.setSelection(null);
    expect(del()).toBe(true);
    expect(deletes()).toHaveLength(1);
  });

  it('Backspace (the Mac delete key) deletes like Delete, with the same guards', async () => {
    await four();
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(del({ key: 'Backspace', target: input })).toBe(false);
    expect(deletes()).toHaveLength(0);
    expect(del({ key: 'Backspace' })).toBe(true);
    expect(deletes()).toHaveLength(1);
    input.remove();
  });

  it('with a pixel selection, the key still deletes layers when aimed at the layer list (a row was clicked)', async () => {
    await four();
    engine.setSelection({ x: 1, y: 1, w: 5, h: 5 });
    expect(del({ key: 'Backspace' })).toBe(false); // aimed at the page/canvas: the selection keeps the layers
    expect(del({ key: 'Backspace', target: row('L1') })).toBe(true);
    expect(deletes()).toHaveLength(1);
    engine.setSelection(null);
  });

  it('skips locked layers: the key and the footer button delete the unlocked ones; all locked = no-op with a message', async () => {
    await four();
    engine.setLayerProps('L3', { locked: true });
    click('L4');
    click('L3', { metaKey: true });
    await settle();
    del();
    expect(last('deleteLayers')).toBe('deleteLayers:L4');
    await settle();
    click('L3'); // locked, alone
    await settle();
    store.setNotice('');
    q('[aria-label="Delete layer"]').click();
    await settle();
    expect(deletes()).toHaveLength(1);
    expect(store.notice.value).toBe('The layer is locked');
    // input layers are locked by default and stay deletable
    click('base');
    await settle();
    q('[aria-label="Delete layer"]').click();
    expect(last('deleteLayers')).toBe('deleteLayers:base');
  });

  it('Delete on a curve point removes the point only (the event does not reach the window)', async () => {
    store.addAdjustment('curves');
    unmount();
    const { Studio } = await import('../../src/ui/Studio');
    await mount(<Studio />, 'width:300px;height:900px;display:flex;flex-direction:column');
    q('[data-fx-open]').click();
    await settle();
    let seen = 0;
    const onWin = (e: KeyboardEvent) => { if (e.key === 'Delete') seen++; };
    window.addEventListener('keydown', onWin);
    q('[data-curve-point]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    window.removeEventListener('keydown', onWin);
    expect(seen).toBe(0);
  });
});

describe('rows by keyboard', () => {
  it('Enter and Space select the row; Shift and Cmd/Ctrl are honoured', async () => {
    await four();
    const press = (id: string, k: string, mods: KeyboardEventInit = {}) => sel(id).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
    press('L3', 'Enter');
    await settle();
    expect(selected()).toEqual(['L3']);
    press('L1', ' ', { shiftKey: true });
    await settle();
    expect(selected()).toEqual(['L3', 'L2', 'L1']);
    press('base', 'Enter', { ctrlKey: true });
    await settle();
    expect(selected()).toEqual(['L3', 'L2', 'L1', 'base']);
    expect(store.spaceHeld.value).toBe(false);
  });
});

describe('disabled Flatten explains itself', () => {
  it('title and aria-label carry the reason', async () => {
    store.bridge = { listTops: async () => [], importTop: async () => '', renderLayer: async () => undefined, renderLayers: async () => undefined };
    store.connection.value = 'linked';
    const px = engine.addPixelLayer('Plain');
    await settle();
    const b = q('[data-act=flatten]', row(px));
    expect(b.title).toBe('Flatten to pixels (Already a plain pixel layer)');
    expect(b.getAttribute('aria-label')).toBe('Flatten to pixels (Already a plain pixel layer)');
    expect(q('[data-act=flatten]', row('base')).title).toBe('Flatten to pixels (Input layers cannot be flattened)');
  });

  it('merge down rules: into a group is allowed; into an input layer or another adjustment is disabled', async () => {
    store.bridge = { listTops: async () => [], importTop: async () => '', renderLayer: async () => undefined, renderLayers: async () => undefined };
    store.connection.value = 'linked';
    const a0 = store.addAdjustment('invert'); // directly above the input layer
    const a1 = store.addAdjustment('threshold'); // above another adjustment
    store.addGroup();
    const g = engine.activeLayerId()!;
    engine.moveLayer(store.addLayer(), g, 0);
    const a2 = store.addAdjustment('invert'); // above the group? (inserted above the active child, inside the group)
    engine.moveLayer(a2, null, 0);
    engine.setActiveLayer(g);
    await settle();
    const dis = (id: string) => q('[data-act=flatten]', row(id)).getAttribute('aria-disabled');
    expect(dis(a0)).toBe('true');
    expect(q('[data-act=flatten]', row(a0)).title).toContain('input layer');
    expect(dis(a1)).toBe('true');
    expect(q('[data-act=flatten]', row(a1)).title).toContain('another adjustment');
    expect(engine.layers()[0].id).toBe(a2);
    expect(dis(a2)).toBe('false'); // below it: the group
  });
});

describe('selections and drops: groups, descendants, undo, remote replace, merges', () => {
  it('a non-contiguous selection drags into a group and back out with single moveLayers calls', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    engine.setActiveLayer('base');
    const a = store.addLayer();
    store.addLayer();
    const c = store.addLayer();
    engine.moveLayer(g, null, 0);
    await settle(); // display: g, c, b, a, base
    click(c);
    click(a, { metaKey: true });
    await settle();
    const dragTo = async (from: string, to: string, frac: number) => {
      const list = q('[data-layer-list]');
      const [fx, fy] = centre(sel(from));
      const tr = row(to).getBoundingClientRect();
      const ty = tr.top + tr.height * frac;
      sel(from).dispatchEvent(ptr('pointerdown', { clientX: fx, clientY: fy }));
      list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: (fy + ty) / 2 }));
      list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: ty }));
      list.dispatchEvent(ptr('pointerup', { clientX: fx, clientY: ty }));
      await settle();
    };
    await dragTo(c, g, 0.5);
    expect(last('moveLayers')).toBe(`moveLayers:${c},${a}:${g}:0`);
    expect(engine.layers().filter((l) => l.parentId === g).map((l) => l.id).sort()).toEqual([a, c].sort());
    expect(selected().sort()).toEqual([a, c].sort());
    // out of the group: below the base layer
    await dragTo(c, 'base', 0.9);
    expect(last('moveLayers')).toMatch(new RegExp(`^moveLayers:${c},${a}:null:`));
    expect(engine.layers().find((l) => l.id === a)!.parentId).toBeNull();
  });

  it('a drop onto a descendant of the dragged group is illegal (no engine call, no indicator target)', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    const child = store.addLayer();
    engine.moveLayer(child, g, 0);
    await settle();
    expect(computeDrop(engine.layers(), g, child, 'before')).toBeNull();
    expect(computeDrop(engine.layers(), [g, 'base'], child, 'after')).toBeNull();
    const before = engine.calls.length;
    const list = q('[data-layer-list]');
    const [fx, fy] = centre(sel(g));
    const tr = row(child).getBoundingClientRect();
    sel(g).dispatchEvent(ptr('pointerdown', { clientX: fx, clientY: fy }));
    list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: tr.top + 5 }));
    list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: tr.top + 6 }));
    list.dispatchEvent(ptr('pointerup', { clientX: fx, clientY: tr.top + 6 }));
    await settle();
    expect(engine.calls.slice(before).some((c) => c.startsWith('move'))).toBe(false);
  });

  it('a selection with a group and its child: move and group pass only the group; delete passes both', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    const child = store.addLayer();
    engine.moveLayer(child, g, 0);
    const other = store.addLayer();
    engine.moveLayer(other, null, 0);
    await settle();
    click(g);
    click(child, { metaKey: true });
    click(other, { metaKey: true });
    await settle();
    expect(store.dragIds(g)).toEqual([other, g]);
    store.groupSelected();
    expect(last('groupLayers')).toBe(`groupLayers:${other},${g}`);
    await settle();
    click(g);
    click(child, { metaKey: true });
    await settle();
    store.deleteSelected();
    expect(last('deleteLayers')).toBe(`deleteLayers:${g},${child}`);
  });

  it('the selection is pruned after undo / redo and after a remote document replace', async () => {
    await four();
    click('L4');
    click('L3', { metaKey: true });
    click('L2', { metaKey: true });
    await settle();
    engine.deleteLayers(['L4', 'L3']);
    await settle();
    expect(selected()).toEqual(['L2']);
    engine.undo(); // the layers come back, but not into the selection
    await settle();
    expect(store.layerSel.value.every((id) => engine.layers().some((l) => l.id === id))).toBe(true);
    // a remote doc replace (Open Project, TD reload): ids that no longer exist disappear from the selection
    click('L3');
    click('L2', { metaKey: true });
    await settle();
    const spec = engine.docSpec();
    engine.loadDocument({ ...spec, layers: spec.layers.filter((l) => l.id !== 'L3' && l.id !== 'L2') });
    await settle();
    expect(store.layerSel.value.filter((id) => id === 'L3' || id === 'L2')).toEqual([]);
    expect(selected()).toEqual([engine.activeLayerId()]);
  });

  it('Merge Selected across parents sends the top-level ids of every parent', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    const inner = store.addLayer();
    engine.moveLayer(inner, g, 0);
    const outer = store.addLayer();
    engine.moveLayer(outer, null, 0);
    await settle();
    const calls: string[][] = [];
    store.bridge = { listTops: async () => [], importTop: async () => '', renderLayers: async (ids: string[]) => { calls.push(ids); } };
    store.connection.value = 'linked';
    click(outer);
    click(inner, { metaKey: true });
    await settle();
    await store.mergeSelected();
    expect(calls).toEqual([[outer, inner]]);
  });
});

describe('performance', () => {
  it('renders 200 layers and a selection change quickly, without re-rendering every row', async () => {
    for (let i = 0; i < 200; i++) engine.addPixelLayer(`P${i}`);
    const t0 = performance.now();
    store.docVersion.value++;
    await settle();
    expect(document.querySelectorAll('[data-layer]').length).toBe(201);
    const first = performance.now() - t0;
    expect(first).toBeLessThan(3000);
    const nodes = [...document.querySelectorAll('[data-layer]')];
    const t1 = performance.now();
    click('L3');
    await settle();
    expect(performance.now() - t1).toBeLessThan(2000);
    expect([...document.querySelectorAll('[data-layer]')].every((n, i) => n === nodes[i])).toBe(true); // rows were patched, not rebuilt
  });
});
