import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileOp, FileResult } from '../../src/state/filesSlice';
import { store, type StoreBridge } from '../../src/state/store';
import { FileDialog } from '../../src/ui/FileDialog';
import { TopBar } from '../../src/ui/TopBar';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

type Call = { op: FileOp; path: string | undefined };
let calls: Call[];
let chosen: FileOp[];
let chooseResult: () => string | null | Promise<never>;
let pending: ((r: FileResult) => void) | null;
let respond: (op: FileOp, path?: string) => Promise<FileResult> | FileResult;

const makeBridge = (): StoreBridge => {
  const f = (op: FileOp) => (path?: string) => { calls.push({ op, path }); return Promise.resolve(respond(op, path)); };
  return { chooseFile: (op: FileOp) => { chosen.push(op); return Promise.resolve(chooseResult()); }, listTops: async () => [], importTop: async () => ({}) as never, saveProject: f('saveProject'), openProject: f('openProject'), exportPng: f('exportPng') } as unknown as StoreBridge;
};
const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent!.startsWith(text))!;
const openMenu = async () => {
  [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'File')!.click();
  await settle();
};
const dlg = () => document.querySelector('[data-file-dialog]');

beforeEach(async () => {
  freshEngine();
  calls = [];
  chosen = [];
  chooseResult = () => '/picked/p.rproj';
  pending = null;
  respond = (op, path) => ({ op, ok: true, path: path ?? '' });
  store.connection.value = 'linked';
  store.bridge = makeBridge();
  store.setFiles({ projectFile: '/td/proj.rproj', pngFile: '/td/out.png' });
  store.closeFileDialog();
  await mount(<><TopBar /><FileDialog /></>, 'width:1200px');
});
afterEach(() => { store.closeFileDialog(); store.bridge = null; store.connection.value = 'standalone'; unmount(); });

describe('File dialogs', () => {
  it('prefills the path from the files message: project for save/open, png for export', async () => {
    for (const [label, title, path] of [['Save Project', 'Save Project', '/td/proj.rproj'], ['Open Project', 'Open Project', '/td/proj.rproj'], ['Export PNG', 'Export PNG', '/td/out.png']]) {
      await openMenu();
      menuItem(label).click();
      await settle();
      expect(q('[role=dialog]').getAttribute('aria-label')).toBe(title);
      expect(q<HTMLInputElement>('[data-file-path]').value).toBe(path);
      expect(q('[data-file-help]').textContent).toContain('Written by TouchDesigner on its machine');
      expect(!!document.querySelector('[data-file-warning]')).toBe(label === 'Open Project');
      q('[data-file-cancel]').click();
      await settle();
      expect(dlg()).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('sends the edited path and shows the success line', async () => {
    await openMenu();
    menuItem('Save Project').click();
    await settle();
    const input = q<HTMLInputElement>('[data-file-path]');
    input.value = '/tmp/mine.rproj';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(calls).toEqual([{ op: 'saveProject', path: '/tmp/mine.rproj' }]);
    expect(q('[data-file-result=ok]').textContent).toBe('Saved to /tmp/mine.rproj');
    expect(dlg()).toBeTruthy();
  });

  it('shows Exported / error results; the error message is red and the dialog stays open', async () => {
    await openMenu();
    menuItem('Export PNG').click();
    await settle();
    q('[data-file-ok]').click();
    await settle();
    expect(q('[data-file-result=ok]').textContent).toBe('Exported /td/out.png');
    respond = (op, path) => ({ op, ok: false, path: path ?? '', msg: 'Permission denied' });
    q('[data-file-ok]').click();
    await settle();
    const err = q('[data-file-result=error]');
    expect(err.textContent).toBe('Permission denied');
    expect(getComputedStyle(err).color).not.toBe(getComputedStyle(q('[data-file-help]')).color);
    // a rejected request is reported as an error too
    respond = () => Promise.reject(new Error('timeout')) as never;
    q('[data-file-ok]').click();
    await settle();
    expect(q('[data-file-result=error]').textContent).toBe('timeout');
  });

  it('is busy while the request is in flight', async () => {
    respond = (op, path) => new Promise<FileResult>((res) => { pending = res; void path; void op; }) as never;
    await openMenu();
    menuItem('Save Project').click();
    await settle();
    q('[data-file-ok]').click();
    await settle();
    expect(q('[data-file-busy]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-file-ok]').disabled).toBe(true);
    q('[data-file-ok]').click(); // ignored while busy
    expect(calls.length).toBe(1);
    pending!({ op: 'saveProject', ok: true, path: '/td/proj.rproj' });
    await settle();
    expect(document.querySelector('[data-file-busy]')).toBeNull();
    expect(q('[data-file-result=ok]').textContent).toBe('Saved to /td/proj.rproj');
  });

  it('Open closes itself after success but stays open on failure; Escape closes', async () => {
    respond = (op, path) => ({ op, ok: false, path: path ?? '', msg: 'No such file' });
    await openMenu();
    menuItem('Open Project').click();
    await settle();
    q('[data-file-ok]').click();
    await settle();
    expect(q('[data-file-result=error]').textContent).toBe('No such file');
    respond = (op, path) => ({ op, ok: true, path: path ?? '' });
    q('[data-file-ok]').click();
    await settle();
    expect(dlg()).toBeNull();
    await openMenu();
    menuItem('Export PNG').click();
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(dlg()).toBeNull();
  });

  it('standalone: the items are disabled with a tooltip and the dialog never opens', async () => {
    store.connection.value = 'standalone';
    await settle();
    await openMenu();
    for (const l of ['Save Project', 'Open Project', 'Export PNG']) {
      const it = menuItem(l);
      expect(it.getAttribute('aria-disabled')).toBe('true');
      expect(it.title).toBe('Needs TouchDesigner');
      it.click();
      await settle();
    }
    expect(dlg()).toBeNull();
    store.openFileDialog('saveProject'); // direct calls are ignored as well
    await settle();
    expect(dlg()).toBeNull();
  });

  it('v10: there is no Browse button (the in-TD panel is gone); the path is typed', async () => {
    await openMenu();
    menuItem('Save Project').click();
    await settle();
    expect(document.querySelector('[data-file-browse]')).toBeNull();
  });

  it('a dropped connection closes the dialog and releases the keyboard block', async () => {
    await openMenu();
    menuItem('Save Project').click();
    await settle();
    expect(store.fileDialog.value).not.toBeNull();
    store.connection.value = 'reconnecting';
    await settle();
    expect(dlg()).toBeNull();
    expect(store.fileDialog.value).toBeNull();
  });
});
