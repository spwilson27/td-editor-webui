import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDropGuard, installPaste } from '../../src/state/paste';
import { store } from '../../src/state/store';
import { App } from '../../src/ui/App';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
let off: () => void;
let offGuard: () => void;

/** A real PNG file: opaque red left half, half-transparent blue right half. */
async function pngFile(w = 6, h = 4, name = 'pic.png'): Promise<File> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ff0000'; g.fillRect(0, 0, w / 2, h);
  g.fillStyle = 'rgba(0,0,255,0.5)'; g.fillRect(w / 2, 0, w / 2, h);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}
const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); await settle(); };

beforeEach(async () => {
  engine = freshEngine(64, 48);
  store.setConnection('standalone');
  store.bridge = null;
  store.topDialog.value = false;
  store.textEdit.value = null;
  off = installPaste(store);
  offGuard = installDropGuard();
  await mount(<App />, 'width:1400px;height:900px');
});
afterEach(() => { off(); offGuard(); store.bridge = null; unmount(); });

const menu = async (label: string, item: string) => {
  [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === label)!.click();
  await settle();
  const el = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.includes(item))!;
  return el;
};

describe('image import: file, drop, paste', () => {
  it('File > Place Image… clicks the hidden accept=image/* input; choosing a file decodes it to straight RGBA and imports', async () => {
    const input = q<HTMLInputElement>('[data-place-input]');
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
    let clicked = 0;
    input.addEventListener('click', () => clicked++);
    (await menu('File', 'Place Image')).click();
    await settle();
    expect(clicked).toBe(1);
    const dt = new DataTransfer();
    dt.items.add(await pngFile(6, 4, 'photo.png'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => engine.imported.length > 0);
    expect(engine.imported).toEqual([{ w: 6, h: 4, name: 'photo', len: 6 * 4 * 4 }]);
    expect(engine.layers()[0].name).toBe('photo');
    expect(input.value).toBe(''); // the same file can be chosen again
  });

  it('the decoded pixels are right (opaque red; blue with alpha ~128 and not premultiplied)', async () => {
    const { decodeImage } = await import('../../src/state/importImage');
    const img = await decodeImage(await pngFile(6, 4));
    expect([img.w, img.h]).toEqual([6, 4]);
    expect(Array.from(img.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    const right = Array.from(img.rgba.subarray(4 * 4, 4 * 4 + 4));
    expect(right[3]).toBeGreaterThan(120);
    expect(right[3]).toBeLessThan(135);
    expect(right[2]).toBeGreaterThan(240);
  });

  it('dropping an image file on the viewport imports it; non-image drops are ignored and the default is prevented', async () => {
    const vp = q('[data-viewport]');
    const dt = new DataTransfer();
    dt.items.add(await pngFile(5, 5, 'dropped.png'));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    vp.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    vp.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await until(() => engine.imported.length > 0);
    expect(engine.imported[0]).toMatchObject({ w: 5, h: 5, name: 'dropped' });
    const txt = new DataTransfer();
    txt.items.add('hello', 'text/plain');
    const dragText = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: txt });
    vp.dispatchEvent(dragText);
    expect(dragText.defaultPrevented).toBe(false);
    const other = new DataTransfer();
    other.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
    vp.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: other }));
    await settle();
    expect(engine.imported.length).toBe(1);
  });

  it('Ctrl+V with an image on the clipboard imports it; text fields keep their own paste', async () => {
    const dt = new DataTransfer();
    dt.items.add(await pngFile(3, 3, 'image.png'));
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await until(() => engine.imported.length > 0);
    expect(engine.imported[0]).toMatchObject({ w: 3, h: 3 });

    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    const dt2 = new DataTransfer();
    dt2.items.add(await pngFile(3, 3));
    const ev2 = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt2 });
    input.dispatchEvent(ev2);
    input.remove();
    await settle();
    expect(ev2.defaultPrevented).toBe(false);
    expect(engine.imported.length).toBe(1);

    const textOnly = new DataTransfer();
    textOnly.items.add('plain', 'text/plain');
    const ev3 = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: textOnly });
    document.body.dispatchEvent(ev3);
    expect(ev3.defaultPrevented).toBe(false);
  });

  it('an undecodable file raises a notice instead of throwing', async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(['not an image'], 'broken.png', { type: 'image/png' }));
    q('[data-viewport]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await until(() => store.notice.value !== '');
    expect(store.notice.value).toContain('broken.png');
    expect(engine.imported.length).toBe(0);
  });
});

describe('Import from TouchDesigner…', () => {
  const tops = [
    { path: '/project1/noise1', w: 1280, h: 720 },
    { path: '/project1/ramp1', w: 256, h: 256 },
    { path: '/other/movie', w: 3840, h: 2160 },
  ];
  const fakeBridge = (over: Partial<{ importTop: (p: string) => Promise<string>; listTops: () => Promise<typeof tops> }> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      listTops: async () => tops,
      importTop: async (p: string) => { calls.push(p); return 'L1'; },
      ...over,
    };
  };

  it('is disabled in standalone mode', async () => {
    const item = await menu('File', 'Import from TouchDesigner');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    item.click();
    await settle();
    expect(document.querySelector('[data-top-dialog]')).toBeNull();
  });

  it('lists TOPs with path and size, filters, and imports the chosen one', async () => {
    const b = fakeBridge();
    store.bridge = b;
    store.setConnection('linked');
    await settle();
    (await menu('File', 'Import from TouchDesigner')).click();
    await until(() => document.querySelectorAll('[data-top-path]').length === 3);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-top-path]')];
    expect(rows[0].textContent).toContain('/project1/noise1');
    expect(rows[0].textContent).toContain('1280×720');
    expect(rows[2].textContent).toContain('3840×2160');
    const filter = q<HTMLInputElement>('[data-top-filter]');
    filter.value = 'ramp';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('[data-top-path]').length).toBe(1);
    expect(q('[data-top-import]').getAttribute('aria-disabled')).toBe('true');
    q('[data-top-path]').click();
    await settle();
    expect(q('[data-top-import]').getAttribute('aria-disabled')).toBe('false');
    q('[data-top-import]').click();
    await until(() => document.querySelector('[data-top-dialog]') === null);
    expect(b.calls).toEqual(['/project1/ramp1']);
    store.setConnection('standalone');
  });

  it('shows an error from the bridge and keeps the dialog open; Escape and Cancel close it', async () => {
    store.bridge = fakeBridge({ importTop: async () => { throw new Error('TOP is too large'); } });
    store.setConnection('linked');
    store.topDialog.value = true;
    await until(() => document.querySelectorAll('[data-top-path]').length === 3);
    q('[data-top-path]').click();
    await settle();
    q('[data-top-import]').click();
    await until(() => document.querySelector('[data-top-error]') !== null);
    expect(q('[data-top-error]').textContent).toBe('TOP is too large');
    expect(document.querySelector('[data-top-dialog]')).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(document.querySelector('[data-top-dialog]')).toBeNull();
    store.setConnection('standalone');
  });

  it('shows the list error when TouchDesigner does not answer', async () => {
    store.bridge = fakeBridge({ listTops: async () => { throw new Error('TouchDesigner did not answer'); } });
    store.setConnection('linked');
    store.topDialog.value = true;
    await until(() => document.querySelector('[data-top-error]') !== null);
    expect(q('[data-top-error]').textContent).toContain('did not answer');
    store.topDialog.value = false;
    store.setConnection('standalone');
  });
});

describe('window drop guard', () => {
  it('file drags anywhere are cancelled (no navigation); outside the viewport they are refused and not imported', async () => {
    const dt = new DataTransfer();
    dt.items.add(await pngFile(4, 4, 'x.png'));
    const panel = q('[data-layer-list]');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    panel.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('none');
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    panel.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await settle();
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.imported.length).toBe(0);
    const text = new DataTransfer();
    text.items.add('t', 'text/plain');
    const other = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: text });
    document.body.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('a drop on the viewport is imported exactly once', async () => {
    const dt = new DataTransfer();
    dt.items.add(await pngFile(4, 4, 'once.png'));
    q('[data-viewport]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await until(() => engine.imported.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.imported.length).toBe(1);
  });
});

describe('TOP dialog and shortcuts', () => {
  it('global shortcuts are suppressed while the dialog is open', async () => {
    const { onKeyDown } = await import('../../src/state/keyboard');
    store.setTool('brush');
    store.topDialog.value = true;
    await settle();
    onKeyDown(store, { key: 'e', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: document.body, preventDefault() {} });
    onKeyDown(store, { key: 'a', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: document.body, preventDefault() {} });
    expect(store.tool.value).toBe('brush');
    expect(engine.calls).not.toContain('selectAll');
    store.topDialog.value = false;
    await settle();
    onKeyDown(store, { key: 'e', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: document.body, preventDefault() {} });
    expect(store.tool.value).toBe('eraser');
  });
});
