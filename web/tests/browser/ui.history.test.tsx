import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { FileDialog } from '../../src/ui/FileDialog';
import { TopBar } from '../../src/ui/TopBar';
import { frame, freshEngine, mount, q, settle, unmount } from './uiHelpers';

const flush = async () => { await frame(); await settle(); };
let saves: Array<{ path?: string; opts?: { includeHistory?: boolean } }>;
let clears: number;

beforeEach(async () => {
  freshEngine();
  saves = []; clears = 0;
  store.bridge = {
    listTops: async () => [], importTop: async () => 'x',
    saveProject: async (path?: string, opts?: { includeHistory?: boolean }) => { saves.push({ path, opts }); return { op: 'saveProject', ok: true, path: path ?? '/p.redoc' }; },
    clearStoredHistory: async () => { clears++; },
  } as never;
  store.setConnection('linked');
  store.setFiles({ projectFile: '/tmp/p.redoc', pngFile: '/tmp/p.png' });
  await mount(<><TopBar /><FileDialog /></>, 'width:900px');
});
afterEach(() => { unmount(); store.closeFileDialog(); store.setIncludeHistory(true); store.setConnection('reconnecting'); store.bridge = null; });

describe('Save Project: include undo history', () => {
  it('the Save dialog has the checkbox, on by default, with a privacy hint; Open and Export do not', async () => {
    store.openFileDialog('saveProject');
    await flush();
    const box = q<HTMLInputElement>('input[data-file-history]');
    expect(box.checked).toBe(true);
    expect(q('[data-file-dialog]').textContent).toContain('turn this off before sharing');
    store.closeFileDialog();
    store.openFileDialog('openProject');
    await flush();
    expect(document.querySelector('input[data-file-history]')).toBeNull();
    store.closeFileDialog();
    store.openFileDialog('exportPng');
    await flush();
    expect(document.querySelector('input[data-file-history]')).toBeNull();
  });

  it('OK passes includeHistory true by default and false when unchecked; the choice is remembered for the next dialog', async () => {
    store.openFileDialog('saveProject');
    await flush();
    q('[data-file-ok]').click();
    await flush();
    expect(saves).toEqual([{ path: '/tmp/p.redoc', opts: { includeHistory: true } }]);
    store.closeFileDialog();
    store.openFileDialog('saveProject');
    await flush();
    const box = q<HTMLInputElement>('input[data-file-history]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    q('[data-file-ok]').click();
    await flush();
    expect(saves[1].opts).toEqual({ includeHistory: false });
    store.closeFileDialog();
    store.openFileDialog('saveProject');
    await flush();
    expect(q<HTMLInputElement>('input[data-file-history]').checked).toBe(false);
  });
});

describe('File ▸ Clear stored undo history', () => {
  const openFile = async () => {
    [...document.querySelectorAll<HTMLElement>('button.menu')].find((b) => b.textContent === 'File')!.click();
    await settle();
  };
  const item = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent === 'Clear stored undo history')!;

  it('is in the File menu, runs the bridge call and says so', async () => {
    await openFile();
    expect(item().getAttribute('aria-disabled')).toBe('false');
    item().click();
    await flush();
    expect(clears).toBe(1);
    expect(store.notice.value).toBe('Stored undo history cleared');
  });

  it('is disabled without a TouchDesigner connection; a failing request is reported', async () => {
    store.setConnection('reconnecting');
    await openFile();
    expect(item().getAttribute('aria-disabled')).toBe('true');
    store.setConnection('linked');
    (store.bridge as { clearStoredHistory: () => Promise<void> }).clearStoredHistory = async () => { throw new Error('HTTP 409'); };
    expect(await store.clearStoredHistory()).toBe(false);
    expect(store.notice.value).toContain('HTTP 409');
  });
});
