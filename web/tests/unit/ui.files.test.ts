import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/state/store';
import { FakeEngine } from '../browser/fakeEngine';

let store: ReturnType<typeof createStore>;
beforeEach(() => { vi.useFakeTimers(); store = createStore(); store.attach(new FakeEngine(8, 8)); });
afterEach(() => { store.detach(); vi.useRealTimers(); });

const bridge = (r: (op: string, p?: string) => unknown) => ({
  listTops: async () => [], importTop: async () => ({}),
  saveProject: async (p?: string) => r('saveProject', p), openProject: async (p?: string) => r('openProject', p), exportPng: async (p?: string) => r('exportPng', p),
}) as never;

describe('files slice', () => {
  it('canUseFiles needs a link and a bridge; the dialog does not open standalone', () => {
    store.setFiles({ projectFile: 'a', pngFile: 'b' });
    expect(store.canUseFiles()).toBe(false);
    expect(store.fileTitle()).toBe('Needs TouchDesigner');
    store.openFileDialog('saveProject');
    expect(store.fileDialog.value).toBeNull();
    store.connection.value = 'linked';
    store.bridge = bridge(() => ({}));
    expect(store.canUseFiles()).toBe(true);
    expect(store.fileTitle()).toBeUndefined();
  });

  it('prefills at open time, edits the path, and runs the op', async () => {
    store.connection.value = 'linked';
    const seen: Array<[string, string | undefined]> = [];
    store.bridge = bridge((op, p) => { seen.push([op, p]); return { op, ok: true, path: p ?? '' }; });
    store.setFiles({ projectFile: '/p.rproj', pngFile: '/o.png' });
    store.openFileDialog('exportPng');
    store.setFiles({ projectFile: '/later', pngFile: '/later.png' }); // later changes do not alter the open dialog
    expect(store.fileDialog.value!.path).toBe('/o.png');
    store.setFilePath(' /x.png ');
    const r = await store.runFileOp();
    expect(seen).toEqual([['exportPng', '/x.png']]);
    expect(r!.ok).toBe(true);
    expect(store.fileDialog.value!.result!.ok).toBe(true);
    expect(store.fileDialog.value!.busy).toBe(false);
    store.closeFileDialog();
    expect(store.fileDialog.value).toBeNull();
  });

  it('turns a rejection into an error result; onFileResult posts a notice when no request is pending', async () => {
    store.connection.value = 'linked';
    store.bridge = { ...(bridge(() => ({})) as object), saveProject: async () => { throw new Error('boom'); } } as never;
    store.openFileDialog('saveProject');
    const r = await store.runFileOp();
    expect(r).toMatchObject({ ok: false, msg: 'boom' });
    store.closeFileDialog();
    store.onFileResult({ op: 'saveProject', ok: true, path: '/q' });
    expect(store.notice.value).toBe('Save Project: /q');
    store.onFileResult({ op: 'exportPng', ok: false, path: '/q', msg: 'nope' });
    expect(store.notice.value).toBe('Export PNG failed: nope');
  });

  it('Save and Export commit a floating selection and exit Quick Mask first; Open does not', async () => {
    const eng = new FakeEngine(8, 8);
    store.attach(eng);
    store.connection.value = 'linked';
    const order: string[] = [];
    store.bridge = bridge((op, p) => { order.push(op); return { op, ok: true, path: p ?? '' }; });
    for (const op of ['saveProject', 'exportPng'] as const) {
      eng.floatingState = { bounds: { x: 0, y: 0, w: 2, h: 2 }, transform: { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 } };
      eng.quickMaskOn = true;
      store.openFileDialog(op);
      await store.runFileOp();
      expect(eng.floating()).toBeNull();
      expect(eng.quickMask()).toBe(false);
      expect(store.notice.value).toMatch(/Floating selection committed|Quick Mask exited/);
      store.closeFileDialog();
    }
    expect(eng.calls.filter((c) => c === 'commitFloating').length).toBe(2);
    eng.floatingState = { bounds: { x: 0, y: 0, w: 2, h: 2 }, transform: { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 } };
    store.openFileDialog('openProject');
    await store.runFileOp();
    expect(eng.floating()).not.toBeNull();
  });
});
