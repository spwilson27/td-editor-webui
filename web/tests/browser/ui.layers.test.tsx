import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { HistoryPanel } from '../../src/ui/HistoryPanel';
import { LayersPanel } from '../../src/ui/LayersPanel';
import type { FakeEngine } from './fakeEngine';
import { centre, freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const row = (id: string) => q(`[data-layer="${id}"]`);
const names = () => [...document.querySelectorAll('[data-layer] [data-name]')].map((e) => e.textContent);
const last = (prefix: string) => [...engine.calls].reverse().find((c) => c.startsWith(prefix));

beforeEach(async () => {
  engine = freshEngine();
  await mount(<LayersPanel />, 'width:290px;height:420px;display:flex;flex-direction:column');
});
afterEach(unmount);

async function addTwo() {
  store.addLayer(); store.addLayer();
  await settle();
}

describe('LayersPanel rows', () => {
  it('lists layers top first and marks the active one', async () => {
    await addTwo();
    expect(names()).toEqual(['Layer 2', 'Layer 1', 'TD Input']);
    expect(row('L2').getAttribute('data-selected')).toBe('true');
    expect(row('base').getAttribute('data-selected')).toBe('false');
    expect(q('.row.sel', row('L2').parentElement!)).toBeTruthy();
  });

  it('selects on click', async () => {
    await addTwo();
    q('[data-act=sel]', row('base')).click();
    await settle();
    expect(engine.activeLayerId()).toBe('base');
    expect(row('base').getAttribute('data-selected')).toBe('true');
  });

  it('toggles visibility and lock through the engine', async () => {
    await addTwo();
    q('[data-act=vis]', row('L1')).click();
    expect(last('props:L1')).toBe('props:L1:{"visible":false}');
    await settle();
    expect(q('[data-act=vis]', row('L1')).getAttribute('aria-label')).toBe('Show Layer 1');
    q('[data-act=lock]', row('L1')).click();
    expect(last('props:L1')).toBe('props:L1:{"locked":true}');
    await settle();
    expect(q('[data-act=lock]', row('L1')).classList.contains('on')).toBe(true);
    expect(q('[data-act=lock]', row('base')).classList.contains('on')).toBe(true);
  });

  it('renames on double click: Enter commits, Escape cancels, empty is ignored, base is not renamable', async () => {
    await addTwo();
    const dbl = (id: string) => q('[data-act=sel]', row(id)).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    dbl('L1');
    await settle();
    let input = q<HTMLInputElement>('input[aria-label="Layer name"]');
    expect(document.activeElement).toBe(input);
    input.value = 'Sky';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(last('props:L1')).toBe('props:L1:{"name":"Sky"}');
    expect(names()).toContain('Sky');
    expect(document.querySelector('input[aria-label="Layer name"]')).toBeNull();

    dbl('L1');
    await settle();
    input = q<HTMLInputElement>('input[aria-label="Layer name"]');
    input.value = 'Nope';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(names()).toContain('Sky');

    dbl('L1');
    await settle();
    input = q<HTMLInputElement>('input[aria-label="Layer name"]');
    input.value = '  ';
    input.dispatchEvent(new Event('blur'));
    await settle();
    expect(names()).toContain('Sky');

    dbl('base');
    await settle();
    expect(document.querySelector('input[aria-label="Layer name"]')).toBeNull();
  });

  it('expands and collapses groups, indenting children', async () => {
    engine.setActiveLayer('base');
    store.addGroup();
    const g = engine.activeLayerId()!;
    engine.moveLayer(store.addLayer(), g, 0);
    await settle();
    expect(row(g).style.paddingLeft).toBe('4px');
    expect(document.querySelectorAll('[data-layer]').length).toBe(3);
    q('[data-act=open]', row(g)).click();
    await settle();
    expect(document.querySelectorAll('[data-layer]').length).toBe(2);
    expect(q('[data-act=open]', row(g)).getAttribute('aria-expanded')).toBe('false');
  });

  it('dims children of a hidden group', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    engine.moveLayer(store.addLayer(), g, 0);
    await settle();
    engine.setLayerProps(g, { visible: false });
    await settle();
    const child = engine.layers().find((l) => l.parentId === g)!;
    expect(q<HTMLElement>('[data-act=vis]', row(child.id)).style.opacity).toBe('0.4');
  });
});

describe('LayersPanel settings and footer', () => {
  it('edits blend mode and opacity of the selected layer', async () => {
    await addTwo();
    const sel = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    sel.value = 'multiply';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(last('props:L2')).toBe('props:L2:{"blend":"multiply"}');

    const op = q<HTMLInputElement>('input[aria-label="Layer opacity"]');
    op.value = '45';
    op.dispatchEvent(new Event('change', { bubbles: true }));
    expect(last('props:L2')).toBe('props:L2:{"opacity":0.45}');
    await settle();
    const again = q<HTMLInputElement>('input[aria-label="Layer opacity"]');
    again.value = '250';
    again.dispatchEvent(new Event('change', { bubbles: true }));
    expect(last('props:L2')).toBe('props:L2:{"opacity":1}');
  });

  it('shows opacity as percent text in the row', async () => {
    await addTwo();
    engine.setLayerProps('L1', { opacity: 0.9 });
    await settle();
    expect(row('L1').textContent).toContain('90%');
  });

  it('footer adds layers and groups, deletes the active layer, disables the rest', async () => {
    q('[aria-label="New pixel layer"]').click();
    await settle();
    expect(engine.layers().length).toBe(2);
    q('[aria-label="New group"]').click();
    await settle();
    expect(engine.layers().some((l) => l.kind === 'group')).toBe(true);
    q('[aria-label="Delete layer"]').click();
    await settle();
    expect(engine.layers().some((l) => l.kind === 'group')).toBe(false);

    for (const label of ['Add mask', 'New adjustment', 'Layer effects']) {
      const b = q(`[aria-label="${label}"]`);
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.title).toContain('Not in this version');
    }
  });

  it('does not delete the base layer', async () => {
    expect(q('[aria-label="Delete layer"]').getAttribute('aria-disabled')).toBe('true');
    q('[aria-label="Delete layer"]').click();
    await settle();
    expect(engine.layers().length).toBe(1);
  });
});

describe('LayersPanel drag reorder', () => {
  const dragRow = (from: string, to: string, frac: number) => {
    const list = q('[data-layer-list]');
    const [fx, fy] = centre(q('[data-act=sel]', row(from)));
    const tr = row(to).getBoundingClientRect();
    const ty = tr.top + tr.height * frac;
    q('[data-act=sel]', row(from)).dispatchEvent(ptr('pointerdown', { clientX: fx, clientY: fy }));
    list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: (fy + ty) / 2 }));
    list.dispatchEvent(ptr('pointermove', { clientX: fx, clientY: ty }));
    return { list, x: fx, y: ty };
  };

  it('moves a layer below another when dropped on its lower half', async () => {
    await addTwo();
    const d = dragRow('L2', 'L1', 0.8);
    await settle();
    expect(row('L1').style.boxShadow).toContain('0px -2px 0px');
    d.list.dispatchEvent(ptr('pointerup', { clientX: d.x, clientY: d.y }));
    await settle();
    expect(last('move:')).toBe('move:L2:null:1');
    expect(names().slice(0, 2)).toEqual(['Layer 1', 'Layer 2']);
  });

  it('drops into a group when released over its middle', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    engine.setLayerProps(g, { expanded: false });
    store.addLayer();
    await settle();
    const l = engine.activeLayerId()!;
    const d = dragRow(l, g, 0.5);
    d.list.dispatchEvent(ptr('pointerup', { clientX: d.x, clientY: d.y }));
    await settle();
    expect(last('move:')).toBe(`move:${l}:${g}:0`);
  });

  it('a plain click or tiny wiggle does not reorder; the base layer cannot be dragged', async () => {
    await addTwo();
    const list = q('[data-layer-list]');
    const [x, y] = centre(q('[data-act=sel]', row('L1')));
    q('[data-act=sel]', row('L1')).dispatchEvent(ptr('pointerdown', { clientX: x, clientY: y }));
    list.dispatchEvent(ptr('pointermove', { clientX: x + 1, clientY: y + 1 }));
    list.dispatchEvent(ptr('pointerup', { clientX: x, clientY: y }));
    const d = dragRow('base', 'L2', 0.2);
    d.list.dispatchEvent(ptr('pointerup'));
    await settle();
    expect(last('move:')).toBeUndefined();
  });

  it('a drop released outside any row cancels', async () => {
    await addTwo();
    const list = q('[data-layer-list]');
    const [x, y] = centre(q('[data-act=sel]', row('L2')));
    q('[data-act=sel]', row('L2')).dispatchEvent(ptr('pointerdown', { clientX: x, clientY: y }));
    list.dispatchEvent(ptr('pointermove', { clientX: x, clientY: y + 600 }));
    list.dispatchEvent(ptr('pointerup', { clientX: x, clientY: y + 600 }));
    await settle();
    expect(last('move:')).toBeUndefined();
  });
});

describe('LayersPanel thumbnails', () => {
  const count = (id: string) => engine.calls.filter((c) => c === `thumb:${id}`).length;

  it('draws a thumbnail per pixel layer, none for groups', async () => {
    store.addGroup();
    await settle();
    expect(count('base')).toBeGreaterThan(0);
    expect(engine.calls.some((c) => c === 'thumb:L1')).toBe(false);
  });

  it('throttles redraws during pixel edits', async () => {
    await settle();
    const before = count('base');
    for (let i = 0; i < 50; i++) engine.emit({ type: 'pixels', rect: { x: 0, y: 0, w: 2, h: 2 } });
    await settle();
    expect(count('base')).toBe(before);
    await new Promise((r) => setTimeout(r, 350));
    await settle();
    expect(count('base')).toBe(before + 1);
  });
});

describe('HistoryPanel', () => {
  it('lists entries, highlights the current one and jumps on click', async () => {
    store.addLayer(); store.addLayer();
    await mount(<HistoryPanel />, 'width:290px');
    const rows = () => [...document.querySelectorAll('[data-history-index]')];
    expect(rows().map((r) => r.textContent)).toEqual(['Open', 'New pixel layer', 'New pixel layer']);
    expect(rows()[2].getAttribute('aria-current')).toBe('true');
    (rows()[1] as HTMLElement).click();
    await settle();
    expect(last('jump:')).toBe('jump:1');
    expect(rows()[1].getAttribute('aria-current')).toBe('true');
    expect(rows()[2].getAttribute('aria-current')).toBe('false');
  });
});
