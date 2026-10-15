import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onKeyDown } from '../../src/state/keyboard';
import { CLIP_MARKER } from '../../src/state/layersSlice';
import { installPaste } from '../../src/state/paste';
import { store } from '../../src/state/store';
import { LayersPanel } from '../../src/ui/LayersPanel';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { centre, freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let offPaste: () => void;
let writeText: ReturnType<typeof vi.fn>;
const row = (id: string) => q(`[data-layer="${id}"]`);
const sel = (id: string) => q('[data-act=sel]', row(id));
const names = () => [...document.querySelectorAll('[data-layer] [data-name]')].map((e) => e.textContent);
const selected = () => [...document.querySelectorAll('[data-layer][data-selected=true]')].map((e) => e.getAttribute('data-layer'));
const click = (id: string, mods: MouseEventInit = {}) => { sel(id).dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods })); };
const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: unknown; defaultPrevented: boolean }> = {}) => {
  let prevented = false;
  onKeyDown(store, { key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: document.body, preventDefault() { prevented = true; }, ...mods });
  return prevented;
};
// pasteHandledAt is a 500 ms stamp in the store: give every test a clean window and let a test jump past it
const realNow = Date.now.bind(Date);
let skew = 0;
const jump = () => { skew += 600; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clipOps = (op: string) => engine.clipLog.filter((c) => c.op === op);
const pastes = () => clipOps('paste');
/** Display order: top first. */
const layerIds = () => engine.layers().map((l) => l.id);

async function four() {
  for (let i = 0; i < 4; i++) store.addLayer();
  await settle();
}
/** A real PNG file. */
async function pngFile(w = 3, h = 3, name = 'pic.png'): Promise<File> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ff0000'; g.fillRect(0, 0, w, h);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}
function firePaste(parts: { text?: string; file?: File }, target: EventTarget = document.body): ClipboardEvent {
  const dt = new DataTransfer();
  if (parts.text !== undefined) dt.items.add(parts.text, 'text/plain');
  if (parts.file) dt.items.add(parts.file);
  const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
  target.dispatchEvent(ev);
  return ev;
}
const menu = async (top: string) => {
  [...document.querySelectorAll<HTMLElement>('button.menu')].find((b) => b.textContent === top)!.click();
  await settle();
};
const item = (t: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.startsWith(t))!;
const itemOff = (t: string) => item(t).getAttribute('aria-disabled') === 'true';
const closeMenu = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); };

beforeEach(async () => {
  jump();
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
  engine = freshEngine();
  store.connection.value = 'standalone';
  store.setLayerClip(null);
  store.cancelPasteFallback();
  store.setNotice('');
  writeText = vi.fn(() => Promise.resolve());
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText as never);
  offPaste = installPaste(store);
  await mount(<><TopBar /><LayersPanel /></>, 'width:300px;height:640px;display:flex;flex-direction:column');
});
afterEach(() => {
  offPaste();
  store.cancelPasteFallback();
  store.cropBox.value = null;
  vi.restoreAllMocks();
  store.setLayerClip(null);
  store.bridge = null;
  unmount();
});

describe('shortcuts', () => {
  it('Ctrl+C copies the selection, Ctrl+X cuts it, Ctrl+J duplicates, Ctrl+V pastes (Cmd works too)', async () => {
    await four();
    expect(key('c')).toBe(true);
    expect(clipOps('copy')).toMatchObject([{ op: 'copy', ids: ['L4'], asCut: false }]);
    expect(store.hasLayerClip()).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(String(writeText.mock.calls[0][0])).toMatch(new RegExp(`^${CLIP_MARKER}`));

    expect(key('j', { ctrlKey: false, metaKey: true })).toBe(true);
    expect(clipOps('duplicate')).toEqual([{ op: 'duplicate', ids: ['L4'] }]);
    await settle();
    expect(names()).toHaveLength(6);

    click('L2');
    await settle();
    expect(key('x', { ctrlKey: false, metaKey: true })).toBe(true);
    expect(engine.calls).toContain('deleteLayers:L2');
    expect(layerIds()).not.toContain('L2');
    expect(clipOps('copy').at(-1)).toMatchObject({ op: 'copy', ids: ['L2'], asCut: true });

    // Ctrl+V does not preventDefault (the paste event follows); the fallback pastes when none does
    expect(key('v')).toBe(false);
    await sleep(120);
    expect(pastes()).toHaveLength(1);
  });

  it('Shift or Alt combos are not clipboard keys', async () => {
    await four();
    key('c', { shiftKey: true });
    expect(clipOps('copy')).toHaveLength(0);
  });

  it('a multi-selection copies its top-level layers only (a group carries its children)', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    const a = store.addLayer();
    engine.moveLayer(a, g, 0);
    const b = store.addLayer();
    engine.moveLayer(b, null, 0);
    await settle();
    click(b);
    click(g, { metaKey: true });
    click(a, { metaKey: true });
    await settle();
    expect(selected().sort()).toEqual([a, b, g].sort());
    key('c');
    const ids = clipOps('copy').at(-1)!.ids!;
    expect(ids.sort()).toEqual([b, g].sort());
    expect(ids).not.toContain(a);
  });

  it('input layers are skipped; only inputs gives a notice and no copy', async () => {
    await four();
    click('L2');
    click('base', { metaKey: true });
    await settle();
    key('c');
    expect(clipOps('copy').at(-1)!.ids).toEqual(['L2']);
    store.setLayerClip(null);
    engine.clipLog.length = 0;
    click('base');
    await settle();
    key('c');
    expect(clipOps('copy')).toHaveLength(0);
    expect(store.notice.value).toBe('Input layers cannot be copied');
    expect(store.hasLayerClip()).toBe(false);
  });

  it('Cut respects locks: locked layers stay; all locked gives a notice and nothing is copied', async () => {
    await four();
    engine.setLayerProps('L3', { locked: true });
    click('L4');
    click('L3', { metaKey: true });
    await settle();
    key('x');
    expect(clipOps('copy').at(-1)!.ids).toEqual(['L4']);
    expect(engine.calls).toContain('deleteLayers:L4');
    expect(layerIds()).toContain('L3');
    await settle();
    engine.clipLog.length = 0;
    click('L3');
    await settle();
    store.setNotice('');
    key('x');
    expect(clipOps('copy')).toHaveLength(0);
    expect(store.notice.value).toBe('The layer is locked');
    expect(layerIds()).toContain('L3');
    // copy still works on a locked layer
    key('c');
    expect(clipOps('copy').at(-1)!.ids).toEqual(['L3']);
  });

  describe('Paste placement', () => {
    it('no active layer: root index 0', async () => {
      await four();
      key('c');
      vi.spyOn(engine, 'activeLayerId').mockReturnValue(null as never);
      expect(store.pasteTarget()).toEqual({ parentId: null, index: 0 });
      store.pasteLayerClip();
      expect(pastes().at(-1)).toMatchObject({ parent: null, index: 0 });
    });

    it('an active normal layer: its parent, index just below it', async () => {
      await four();
      click('L4');
      key('c');
      click('L2');
      await settle();
      key('v');
      await sleep(120);
      // L4, L3, L2 -> siblings top first: L4=0, L3=1, L2=2 => below L2 = 3
      expect(pastes().at(-1)).toMatchObject({ parent: null, index: 3 });
      await settle();
      const order = layerIds();
      expect(order.slice(0, 3)).toEqual(['L4', 'L3', 'L2']);
      expect(order[3]).not.toBe('L1');
    });

    it('an active group: into the group at index 0, group expanded', async () => {
      await four();
      click('L3');
      key('c');
      store.addGroup();
      const g = engine.activeLayerId()!;
      engine.setLayerProps(g, { expanded: false });
      await settle();
      expect(engine.activeLayerId()).toBe(g);
      key('v');
      await sleep(120);
      expect(pastes().at(-1)).toMatchObject({ parent: g, index: 0 });
      expect(engine.layers().find((l) => l.id === g)!.expanded).toBe(true);
      expect(engine.layers().filter((l) => l.parentId === g)).toHaveLength(1);
    });

    it('the pasted layers become the selection with the topmost active', async () => {
      await four();
      click('L4');
      click('L2', { metaKey: true });
      await settle();
      key('c');
      key('v');
      await sleep(120);
      await settle();
      const made = layerIds().filter((id) => !['base', 'L1', 'L2', 'L3', 'L4'].includes(id));
      expect(made).toHaveLength(2);
      expect(selected().sort()).toEqual([...made].sort());
      const topmost = layerIds().find((id) => made.includes(id));
      expect(engine.activeLayerId()).toBe(topmost);
    });
  });

  it('Duplicate (Ctrl+J) leaves the layer clipboard alone: a later paste still pastes the earlier copy', async () => {
    await four();
    click('L2');
    key('c');
    click('L4');
    await settle();
    key('j');
    expect(clipOps('copy')).toHaveLength(1);
    expect(store.hasLayerClip()).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    key('v');
    await sleep(120);
    expect(pastes()).toHaveLength(1);
    // the pasted snapshot is the one taken from L2 (the duplicate copied L4)
    expect(names().filter((n) => n?.endsWith(' copy'))).toHaveLength(2);
  });

  describe('guards', () => {
    it('ignored while typing in a text input', async () => {
      await four();
      const input = document.createElement('input');
      input.type = 'text';
      document.body.appendChild(input);
      for (const k of ['c', 'x', 'v', 'j']) expect(key(k, { target: input })).toBe(false);
      input.remove();
      key('v', { target: document.body });
      store.cancelPasteFallback();
      expect(engine.clipLog).toHaveLength(0);
    });

    it('ignored when aimed at a control outside the layer list; fine inside the list', async () => {
      await four();
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      expect(key('c', { target: btn })).toBe(false);
      expect(key('j', { target: btn })).toBe(false);
      expect(engine.clipLog).toHaveLength(0);
      expect(key('c', { target: q('[data-act=vis]', row('L1')) })).toBe(true);
      expect(clipOps('copy')).toHaveLength(1);
      expect(key('c', { defaultPrevented: true })).toBe(false);
      expect(clipOps('copy')).toHaveLength(1);
      btn.remove();
    });

    it('ignored during a crop box or a floating selection', async () => {
      await four();
      store.cropBox.value = { x: 0, y: 0, w: 4, h: 4 };
      for (const k of ['c', 'x', 'j']) expect(key(k)).toBe(false);
      key('v');
      store.cancelPasteFallback();
      store.cropBox.value = null;
      expect(engine.clipLog).toHaveLength(0);
      engine.setSelection({ x: 2, y: 2, w: 10, h: 10 });
      expect(store.beginTransformSelection()).toBeTruthy();
      expect(store.isFloating()).toBe(true);
      for (const k of ['c', 'x', 'j']) expect(key(k)).toBe(false);
      expect(engine.clipLog).toHaveLength(0);
    });

    it('Cmd+C with a pixel selection still copies layers', async () => {
      await four();
      engine.setSelection({ x: 1, y: 1, w: 5, h: 5 });
      expect(key('c')).toBe(true);
      expect(clipOps('copy')).toHaveLength(1);
    });
  });
});

describe('menus', () => {
  it('Edit: Cut/Copy are disabled for an input-only selection, Paste is enabled; Layer > Duplicate follows the selection', async () => {
    await menu('Edit');
    expect(itemOff('Cut')).toBe(true);
    expect(itemOff('Copy')).toBe(true);
    expect(itemOff('Paste')).toBe(false);
    await closeMenu();
    await menu('Layer');
    expect(itemOff('Duplicate')).toBe(true);
    await closeMenu();
  });

  it('enabled with a copyable selection; Cut disabled when all are locked', async () => {
    await four();
    await menu('Edit');
    expect(itemOff('Cut')).toBe(false);
    expect(itemOff('Copy')).toBe(false);
    await closeMenu();
    await menu('Layer');
    expect(itemOff('Duplicate')).toBe(false);
    await closeMenu();
    engine.setLayerProps('L4', { locked: true });
    await settle();
    await menu('Edit');
    expect(itemOff('Cut')).toBe(true);
    expect(itemOff('Copy')).toBe(false);
    await closeMenu();
  });

  it('disabled while a crop box exists', async () => {
    await four();
    store.cropBox.value = { x: 0, y: 0, w: 4, h: 4 };
    await settle();
    await menu('Edit');
    expect(itemOff('Copy')).toBe(true);
    expect(itemOff('Paste')).toBe(true);
    await closeMenu();
    store.cropBox.value = null;
  });

  it('clicking Copy, Paste, Cut and Duplicate drives the engine', async () => {
    await four();
    await menu('Edit');
    item('Copy').click();
    await settle();
    expect(clipOps('copy')).toHaveLength(1);
    // Paste: clipboard.read rejects -> the layer clipboard is pasted
    vi.spyOn(navigator.clipboard, 'read').mockRejectedValue(new Error('denied'));
    await menu('Edit');
    item('Paste').click();
    await settle();
    await sleep(30);
    await settle();
    expect(pastes()).toHaveLength(1);
    expect(store.notice.value).toBe('');
    await menu('Edit');
    item('Cut').click();
    await settle();
    expect(clipOps('copy')).toHaveLength(2);
    expect(engine.calls.some((c) => c.startsWith('deleteLayers:'))).toBe(true);
    await menu('Layer');
    item('Duplicate').click();
    await settle();
    expect(clipOps('duplicate')).toHaveLength(1);
  });

  it('Edit > Paste with an unreadable clipboard and no layer clip keeps the old notice', async () => {
    vi.spyOn(navigator.clipboard, 'read').mockRejectedValue(new Error('denied'));
    await menu('Edit');
    item('Paste').click();
    await settle();
    await sleep(30);
    expect(store.notice.value).toBe('Press Ctrl+V to paste an image');
    expect(pastes()).toHaveLength(0);
  });
});

describe('paste event', () => {
  it('text/plain starting with the marker pastes the layers and prevents default', async () => {
    await four();
    key('c');
    const ev = firePaste({ text: `${CLIP_MARKER}:1` });
    expect(ev.defaultPrevented).toBe(true);
    expect(pastes()).toHaveLength(1);
  });

  it('an image with no marker imports the image even when a layer clip exists', async () => {
    await four();
    key('c');
    const ev = firePaste({ file: await pngFile(3, 3, 'image.png') });
    expect(ev.defaultPrevented).toBe(true);
    for (let i = 0; i < 100 && !engine.calls.some((c) => c.startsWith('importImage')); i++) await sleep(20);
    expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(true);
    expect(pastes()).toHaveLength(0);
  });

  it('an image plus the marker pastes the layers', async () => {
    await four();
    key('c');
    firePaste({ text: `${CLIP_MARKER}:2`, file: await pngFile() });
    await sleep(100);
    expect(pastes()).toHaveLength(1);
    expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(false);
  });

  it('an image wins unless writing the marker failed: then the layer clip is pasted', async () => {
    await four();
    (navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.reject(new Error('no')));
    key('c');
    await sleep(20);
    expect(store.markerWriteFailed()).toBe(true);
    firePaste({ file: await pngFile() });
    await sleep(100);
    expect(pastes()).toHaveLength(1);
    expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(false);
  });

  it('with no image and no marker the layer clip is pasted (text-free clipboard), without a clip nothing happens', async () => {
    await four();
    const none = firePaste({});
    expect(none.defaultPrevented).toBe(false);
    key('c');
    const ev = firePaste({});
    expect(ev.defaultPrevented).toBe(true);
    expect(pastes()).toHaveLength(1);
  });

  it('a paste into a text input is left alone', async () => {
    await four();
    key('c');
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    const ev = firePaste({ text: 'hello' }, input);
    input.remove();
    expect(ev.defaultPrevented).toBe(false);
    expect(pastes()).toHaveLength(0);
  });

  it('keydown-only Ctrl+V pastes once via the fallback; a paste event cancels it so layers are pasted exactly once', async () => {
    await four();
    key('c');
    key('v');
    expect(pastes()).toHaveLength(0);
    await sleep(120);
    expect(pastes()).toHaveLength(1);
    await sleep(120);
    expect(pastes()).toHaveLength(1);
    // with a paste event
    jump();
    key('v');
    firePaste({ text: `${CLIP_MARKER}:9` });
    expect(pastes()).toHaveLength(2);
    await sleep(150);
    expect(pastes()).toHaveLength(2);
  });

  it('Ctrl+V with no layer clip arms nothing', async () => {
    await four();
    key('v');
    await sleep(120);
    expect(pastes()).toHaveLength(0);
  });

  it('a refused paste shows the engine notice and selects nothing new', async () => {
    await four();
    key('c');
    engine.refusePaste = true;
    firePaste({ text: `${CLIP_MARKER}:3` });
    await settle();
    expect(pastes()).toHaveLength(1);
    expect(store.notice.value).toMatch(/Cannot paste/);
    expect(layerIds()).toHaveLength(5);
    engine.refusePaste = false;
  });
});

describe('Cmd-drag copy in the layers panel', () => {
  // display: L4, L3, L2, L1, base
  const start = (from: string) => {
    const [fx, fy] = centre(sel(from));
    sel(from).dispatchEvent(ptr('pointerdown', { clientX: fx, clientY: fy }));
    return { fx, fy };
  };
  const rowY = (id: string, frac: number) => { const r = row(id).getBoundingClientRect(); return r.top + r.height * frac; };
  const moveTo = (id: string, frac: number, init: PointerEventInit = {}) => {
    const { fx } = { fx: centre(sel('L1'))[0] };
    q('[data-layer-list]').dispatchEvent(ptr('pointermove', { clientX: fx, clientY: rowY(id, frac), ...init }));
  };
  const drop = (id: string, frac: number, init: PointerEventInit = {}) => {
    const fx = centre(sel('L1'))[0];
    q('[data-layer-list]').dispatchEvent(ptr('pointerup', { clientX: fx, clientY: rowY(id, frac), ...init }));
  };
  const drag = async (from: string, to: string, frac: number, init: PointerEventInit = {}) => {
    start(from);
    moveTo(to, frac, init);
    moveTo(to, frac, init);
    drop(to, frac, init);
    await settle();
  };
  const moves = () => engine.calls.filter((c) => c.startsWith('move:') || c.startsWith('moveLayers:'));

  it('Cmd held at pointerup copies to the drop position (pasteLayers) and leaves the originals', async () => {
    await four();
    await drag('L1', 'L4', 0.1, { metaKey: true });
    expect(moves()).toHaveLength(0);
    expect(pastes()).toEqual([{ op: 'paste', parent: null, index: 0 }]);
    expect(layerIds().filter((id) => ['L1', 'L2', 'L3', 'L4', 'base'].includes(id)).sort()).toEqual(['L1', 'L2', 'L3', 'L4', 'base']);
    expect(layerIds()).toHaveLength(6);
    expect(clipOps('copy').at(-1)).toMatchObject({ op: 'copy', ids: ['L1'], asCut: false });
    expect(clipOps('release')).toHaveLength(1); // the transient snapshot is freed
    expect(store.hasLayerClip()).toBe(false); // the layer clipboard is untouched
    expect(writeText).not.toHaveBeenCalled();
    // the copy is the selection and on top
    expect(layerIds()[0]).not.toBe('L4');
    expect(engine.activeLayerId()).toBe(layerIds()[0]);
  });

  it('Ctrl held works too; the index counts every sibling (below L3 = 2)', async () => {
    await four();
    await drag('L1', 'L3', 0.9, { ctrlKey: true });
    expect(pastes()).toEqual([{ op: 'paste', parent: null, index: 2 }]);
  });

  it('without the modifier the drag still moves', async () => {
    await four();
    await drag('L1', 'L4', 0.1);
    expect(moves()).toEqual(['move:L1:null:0']);
    expect(pastes()).toHaveLength(0);
    expect(layerIds()).toHaveLength(5);
  });

  it('copies the whole multi-selection', async () => {
    await four();
    click('L1');
    click('L2', { metaKey: true });
    await settle();
    await drag('L2', 'L4', 0.1, { metaKey: true });
    expect(clipOps('copy').at(-1)!.ids!.sort()).toEqual(['L1', 'L2']);
    expect(pastes()).toEqual([{ op: 'paste', parent: null, index: 0 }]);
    expect(layerIds()).toHaveLength(7);
  });

  it('Cmd+click without movement still toggles the selection', async () => {
    await four();
    click('L3');
    await settle();
    const [x, y] = centre(sel('L2'));
    sel('L2').dispatchEvent(ptr('pointerdown', { clientX: x, clientY: y, metaKey: true }));
    q('[data-layer-list]').dispatchEvent(ptr('pointerup', { clientX: x, clientY: y, metaKey: true }));
    click('L2', { metaKey: true });
    await settle();
    expect(selected().sort()).toEqual(['L2', 'L3']);
    expect(pastes()).toHaveLength(0);
    expect(moves()).toHaveLength(0);
  });

  it('the drop indicator shows data-drop-copy and the badge only while Cmd is held; Meta key presses toggle it mid-drag', async () => {
    await four();
    start('L1');
    moveTo('L3', 0.9, { metaKey: true });
    moveTo('L3', 0.9, { metaKey: true });
    await settle();
    const ind = () => document.querySelector('[data-drop-indicator]');
    expect(ind()!.hasAttribute('data-drop-copy')).toBe(true);
    expect(ind()!.querySelector('[data-drop-copy-badge]')!.textContent).toContain('copy');
    expect(q('[data-layer-list]').hasAttribute('data-drag-copy')).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', metaKey: false, bubbles: true }));
    await settle();
    expect(ind()!.hasAttribute('data-drop-copy')).toBe(false);
    expect(ind()!.querySelector('[data-drop-copy-badge]')).toBeNull();
    expect(q('[data-layer-list]').hasAttribute('data-drag-copy')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, bubbles: true }));
    await settle();
    expect(ind()!.hasAttribute('data-drop-copy')).toBe(true);
    expect(ind()!.querySelector('[data-drop-copy-badge]')).toBeTruthy();

    // a plain drag has neither
    drop('L3', 0.9);
    await settle();
    expect(ind()).toBeNull();
    start('L1');
    moveTo('L3', 0.9);
    moveTo('L3', 0.9);
    await settle();
    expect(ind()!.hasAttribute('data-drop-copy')).toBe(false);
    expect(ind()!.querySelector('[data-drop-copy-badge]')).toBeNull();
    drop('L3', 0.9);
  });

  it('releasing Cmd before the drop moves instead of copying', async () => {
    await four();
    start('L1');
    moveTo('L4', 0.1, { metaKey: true });
    moveTo('L4', 0.1, { metaKey: true });
    drop('L4', 0.1); // no modifier at pointerup
    await settle();
    expect(pastes()).toHaveLength(0);
    expect(moves()).toEqual(['move:L1:null:0']);
  });

  it('a copy may be dropped onto the dragged layer itself and into its own group', async () => {
    await four();
    await drag('L2', 'L2', 0.1, { metaKey: true });
    expect(pastes()).toEqual([{ op: 'paste', parent: null, index: 2 }]); // before L2 among all siblings (L4, L3, L2, L1, base)
  });

  it('a copy into its own source group lands inside it', async () => {
    store.addGroup();
    const g = engine.activeLayerId()!;
    const a = store.addLayer();
    engine.moveLayer(a, g, 0);
    await settle();
    engine.calls.length = 0;
    await drag(g, g, 0.7, { metaKey: true });
    expect(pastes()).toEqual([{ op: 'paste', parent: g, index: 0 }]);
    expect(engine.layers().filter((l) => l.parentId === g).length).toBeGreaterThanOrEqual(2);
    // without Cmd the same drop is refused
    pastes().length = 0;
    engine.clipLog.length = 0;
    await drag(g, g, 0.7);
    expect(pastes()).toHaveLength(0);
    expect(moves()).toHaveLength(0);
  });
});

describe('hardening (review)', () => {
  const kd = (k: string, target: unknown, extra: Record<string, unknown> = {}) => key(k, { target, ...extra } as never);
  const toolbarButton = () => { const b = document.createElement('button'); document.body.appendChild(b); return b; };
  const textInput = () => { const i = document.createElement('input'); i.type = 'text'; document.body.appendChild(i); return i; };

  describe('paste event', () => {
    it('late paste event within 500 ms after the fallback pasted: no second paste or import, and it is preventDefault-ed', async () => {
      await four();
      key('c');
      key('v');
      await sleep(40); // the 0 ms fallback has pasted
      expect(pastes()).toHaveLength(1);
      const a = firePaste({ text: `${CLIP_MARKER}:1` });
      const b = firePaste({ file: await pngFile() });
      expect(a.defaultPrevented).toBe(true);
      expect(b.defaultPrevented).toBe(true);
      await sleep(100);
      expect(pastes()).toHaveLength(1);
      expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(false);
      jump(); // outside the window a paste event works again
      firePaste({ text: `${CLIP_MARKER}:2` });
      expect(pastes()).toHaveLength(2);
    });

    it('two real paste events in a row paste twice (only a late event after the keyboard fallback is deduplicated)', async () => {
      await four();
      key('c');
      firePaste({ text: `${CLIP_MARKER}:1` });
      firePaste({ text: `${CLIP_MARKER}:1` });
      expect(pastes()).toHaveLength(2);
    });

    it('image-only with a layer clip but no marker (marker was written) imports the image, no layer paste', async () => {
      await four();
      key('c');
      await sleep(20);
      expect(store.markerWriteFailed()).toBe(false);
      firePaste({ file: await pngFile() });
      for (let i = 0; i < 100 && !engine.calls.some((c) => c.startsWith('importImage')); i++) await sleep(20);
      expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(true);
      expect(pastes()).toHaveLength(0);
    });

    it('image + clip + markerWriteFailed (writeText rejects at copy time): layers win, no import', async () => {
      await four();
      (navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.reject(new Error('no')));
      key('c');
      await sleep(20);
      const ev = firePaste({ file: await pngFile() });
      expect(ev.defaultPrevented).toBe(true);
      await sleep(100);
      expect(pastes()).toHaveLength(1);
      expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(false);
    });

    it('a paste event aimed at a typing input never pastes layers', async () => {
      await four();
      key('c');
      const i = textInput();
      const ev = firePaste({ text: `${CLIP_MARKER}:1` }, i);
      i.remove();
      expect(ev.defaultPrevented).toBe(false);
      expect(pastes()).toHaveLength(0);
    });
  });

  describe('keydown targets', () => {
    it('Ctrl+V with a focused toolbar button pastes (fallback); Ctrl+C with a button target does not copy', async () => {
      await four();
      key('c');
      const btn = toolbarButton();
      engine.clipLog.length = 0;
      expect(kd('c', btn)).toBe(false);
      expect(clipOps('copy')).toHaveLength(0);
      jump();
      expect(kd('v', btn)).toBe(false);
      await sleep(40);
      expect(pastes()).toHaveLength(1);
      btn.remove();
    });

    it('Ctrl+V with a focused toolbar button pastes via the paste event too (no guard but isTyping)', async () => {
      await four();
      key('c');
      const btn = toolbarButton();
      kd('v', btn);
      const ev = firePaste({ text: `${CLIP_MARKER}:1` }, btn);
      expect(ev.defaultPrevented).toBe(true);
      expect(pastes()).toHaveLength(1);
      await sleep(60);
      expect(pastes()).toHaveLength(1);
      btn.remove();
    });

    it('a typing input target never pastes (keydown nor timer)', async () => {
      await four();
      key('c');
      const i = textInput();
      kd('v', i);
      await sleep(60);
      i.remove();
      expect(pastes()).toHaveLength(0);
    });

    it('focusing a text input between keydown and the timer cancels the paste', async () => {
      await four();
      key('c');
      const i = textInput();
      kd('v', document.body);
      i.focus();
      expect(document.activeElement).toBe(i);
      await sleep(60);
      i.remove();
      expect(pastes()).toHaveLength(0);
    });

    it.each([
      ['loadingDoc', () => { store.loadingDoc.value = true; }, () => { store.loadingDoc.value = false; }],
      ['a dialog', () => { store.topDialog.value = true; }, () => { store.topDialog.value = false; }],
      ['text edit', () => { store.textEdit.value = { id: 'x', isNew: false }; }, () => { store.textEdit.value = null; }],
      ['a crop box', () => { store.cropBox.value = { x: 0, y: 0, w: 4, h: 4 }; }, () => { store.cropBox.value = null; }],
      ['a floating selection', () => { engine.setSelection({ x: 2, y: 2, w: 10, h: 10 }); expect(store.beginTransformSelection()).toBeTruthy(); }, () => {}],
    ])('state change to %s between keydown and the timer pastes nothing', async (_n, set, reset) => {
      await four();
      key('c');
      kd('v', document.body);
      set();
      await sleep(60);
      reset();
      expect(pastes()).toHaveLength(0);
    });

    it('a throwing pasteLayers inside the timer does not escape; a notice is shown', async () => {
      await four();
      key('c');
      vi.spyOn(engine, 'pasteLayers').mockImplementation(() => { throw new Error('boom'); });
      const errs: unknown[] = [];
      const onErr = (e: ErrorEvent) => { errs.push(e.error); e.preventDefault(); };
      window.addEventListener('error', onErr);
      kd('v', document.body);
      await sleep(60);
      window.removeEventListener('error', onErr);
      expect(errs).toHaveLength(0);
      expect(store.notice.value).toBe('Paste failed: boom');
    });

    it('key repeat does nothing for c/x/v/j and is preventDefault-ed; one real press acts once', async () => {
      await four();
      for (const k of ['c', 'x', 'v', 'j']) expect(kd(k, document.body, { repeat: true })).toBe(true);
      expect(engine.clipLog).toHaveLength(0);
      expect(kd('c', document.body)).toBe(true);
      expect(kd('c', document.body, { repeat: true })).toBe(true);
      expect(clipOps('copy')).toHaveLength(1);
      kd('v', document.body);
      kd('v', document.body, { repeat: true });
      await sleep(60);
      expect(pastes()).toHaveLength(1);
    });
  });

  describe('Edit menu states', () => {
    it('no engine: Cut/Copy/Paste and Duplicate are disabled', async () => {
      store.detach();
      await settle();
      await menu('Edit');
      for (const t of ['Cut', 'Copy', 'Paste']) expect(itemOff(t)).toBe(true);
      await closeMenu();
      await menu('Layer');
      expect(itemOff('Duplicate')).toBe(true);
      await closeMenu();
    });

    it('a floating selection disables Cut/Copy/Paste/Duplicate', async () => {
      await four();
      engine.setSelection({ x: 2, y: 2, w: 10, h: 10 });
      expect(store.beginTransformSelection()).toBeTruthy();
      await settle();
      await menu('Edit');
      for (const t of ['Cut', 'Copy', 'Paste']) expect(itemOff(t)).toBe(true);
      await closeMenu();
      await menu('Layer');
      expect(itemOff('Duplicate')).toBe(true);
      await closeMenu();
    });

    it('a crop box disables Cut and Duplicate too', async () => {
      await four();
      store.cropBox.value = { x: 0, y: 0, w: 4, h: 4 };
      await settle();
      await menu('Edit');
      expect(itemOff('Cut')).toBe(true);
      await closeMenu();
      await menu('Layer');
      expect(itemOff('Duplicate')).toBe(true);
      await closeMenu();
    });

    it('a locked selection disables Cut but not Copy or Duplicate', async () => {
      await four();
      engine.setLayerProps('L4', { locked: true });
      await settle();
      await menu('Edit');
      expect(itemOff('Cut')).toBe(true);
      expect(itemOff('Copy')).toBe(false);
      await closeMenu();
      await menu('Layer');
      expect(itemOff('Duplicate')).toBe(false);
      await closeMenu();
    });
  });

  describe('Edit > Paste (stubbed navigator.clipboard.read)', () => {
    const it_ = (types: Record<string, Blob>) => ({ types: Object.keys(types), getType: async (t: string) => types[t] });
    const markerItem = () => it_({ 'text/plain': new Blob([`${CLIP_MARKER}:1`], { type: 'text/plain' }) });
    const imageItem = (b: Blob) => it_({ 'image/png': b });
    const paste = async () => { await menu('Edit'); item('Paste').click(); await settle(); await sleep(60); await settle(); };

    it('marker text item => layers; image only => import; rejects => layer clip, else the notice', async () => {
      await four();
      key('c');
      vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([markerItem()] as never);
      await paste();
      expect(pastes()).toHaveLength(1);
      expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(false);

      const png = await pngFile();
      vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([imageItem(png)] as never);
      await paste();
      for (let i = 0; i < 100 && !engine.calls.some((c) => c.startsWith('importImage')); i++) await sleep(20);
      expect(engine.calls.some((c) => c.startsWith('importImage'))).toBe(true);
      expect(pastes()).toHaveLength(1);

      vi.spyOn(navigator.clipboard, 'read').mockRejectedValue(new Error('denied'));
      await paste();
      expect(pastes()).toHaveLength(2);
      store.setLayerClip(null);
      await paste();
      expect(pastes()).toHaveLength(2);
      expect(store.notice.value).toBe('Press Ctrl+V to paste an image');
    });

    it('loadingDoc: nothing happens (read is not even called)', async () => {
      await four();
      key('c');
      const read = vi.spyOn(navigator.clipboard, 'read').mockResolvedValue([markerItem()] as never);
      await store.pasteFromClipboard.call(store); // sanity: works while idle
      expect(pastes()).toHaveLength(1);
      read.mockClear();
      store.loadingDoc.value = true;
      await store.pasteFromClipboard();
      store.loadingDoc.value = false;
      expect(read).not.toHaveBeenCalled();
      expect(pastes()).toHaveLength(1);
    });

    it('a read that never resolves: after 2 s the layer clip is pasted', async () => {
      await four();
      key('c');
      vi.spyOn(navigator.clipboard, 'read').mockImplementation(() => new Promise(() => {}));
      const t0 = performance.now();
      await store.pasteFromClipboard();
      expect(performance.now() - t0).toBeGreaterThanOrEqual(1900);
      expect(pastes()).toHaveLength(1);
    }, 6000);
  });

  it('copy then copy again releases the previous clip before copying', async () => {
    await four();
    key('c');
    engine.clipLog.length = 0;
    key('c');
    expect(engine.clipLog.map((c) => c.op)).toEqual(['release', 'copy']);
  });

  it('cut then paste uses asCut=true and the paste keeps the names (no " copy"); copy then paste adds " copy"', async () => {
    await four();
    key('x');
    expect(clipOps('copy').at(-1)).toMatchObject({ asCut: true });
    await settle();
    expect(names()).not.toContain('Layer 4');
    jump();
    key('v');
    await sleep(60);
    await settle();
    expect(pastes()).toHaveLength(1);
    expect(names().some((n) => n?.endsWith(' copy'))).toBe(false);
    expect(names().length).toBe(5);
    click('L2');
    await settle();
    key('c');
    expect(clipOps('copy').at(-1)).toMatchObject({ asCut: false });
    jump();
    key('v');
    await sleep(60);
    await settle();
    expect(names().some((n) => n?.endsWith(' copy'))).toBe(true);
  });
});

describe('pointercancel mid-drag', () => {
  const rowY = (id: string, frac: number) => { const r = row(id).getBoundingClientRect(); return r.top + r.height * frac; };
  const begin = (init: PointerEventInit = {}) => {
    const [fx, fy] = centre(sel('L1'));
    sel('L1').dispatchEvent(ptr('pointerdown', { clientX: fx, clientY: fy }));
    for (let i = 0; i < 2; i++) q('[data-layer-list]').dispatchEvent(ptr('pointermove', { clientX: fx, clientY: rowY('L4', 0.1), ...init }));
    return fx;
  };
  const calls = () => engine.calls.filter((c) => c.startsWith('move:') || c.startsWith('moveLayers:') || c.startsWith('pasteLayers') || c.startsWith('copyLayers'));

  it.each([['plain', {}], ['with Meta', { metaKey: true }]])('%s: no move, no copy, indicator gone, and the next click is not swallowed forever', async (_n, init) => {
    await four();
    const fx = begin(init);
    await settle();
    expect(document.querySelector('[data-drop-indicator]')).not.toBeNull();
    q('[data-layer-list]').dispatchEvent(ptr('pointercancel', { clientX: fx, clientY: rowY('L4', 0.1), ...init }));
    await settle();
    expect(calls()).toEqual([]);
    expect(document.querySelector('[data-drop-indicator]')).toBeNull();
    expect(q('[data-layer-list]').hasAttribute('data-drag-copy')).toBe(false);
    // a stray pointerup afterwards does nothing either
    q('[data-layer-list]').dispatchEvent(ptr('pointerup', { clientX: fx, clientY: rowY('L4', 0.1), ...init }));
    await sleep(20); // the click suppression lasts one task
    click('L3');
    await settle();
    expect(selected()).toEqual(['L3']);
    expect(calls()).toEqual([]);
  });
});
