import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onKeyDown } from '../../src/state/keyboard';
import { createStore } from '../../src/state/store';
import { FakeEngine } from '../browser/fakeEngine';

let store: ReturnType<typeof createStore>;
let engine: FakeEngine;
beforeEach(() => {
  vi.useFakeTimers();
  store = createStore();
  engine = new FakeEngine(200, 100);
  store.attach(engine);
  store.setViewSize(1064, 564);
});

describe('v10 editor switch: store', () => {
  it('commitPending ends an open gesture (keeping its value), commits the crop box and the floating selection, leaves Quick Mask and text', () => {
    const calls: string[] = [];
    (engine as unknown as { endGesture: (c?: boolean) => string }).endGesture = (c) => { calls.push(`endGesture:${String(c)}`); return 'kept'; };
    store.setTool('crop');
    store.cropBox.value = { x: 2, y: 3, w: 50, h: 40 };
    engine.setQuickMask(true);
    store.commitPending();
    expect(calls).toEqual(['endGesture:false']);
    expect(store.cropBox.value).toBeNull(); // applied like Enter
    expect(engine.calls).toContain('quickMask:false');
  });

  it('commitPending commits a floating selection like Enter', () => {
    engine.setSelection({ x: 0, y: 0, w: 20, h: 20 });
    store.beginTransformSelection();
    expect(store.isFloating()).toBe(true);
    store.commitPending();
    expect(engine.calls).toContain('commitFloating');
    expect(store.isFloating()).toBe(false);
  });

  it('setSwitching drives the busy flag and the overlay target', () => {
    expect(store.editorSwitching.value).toBe(false);
    store.setSwitching({ to: 'Second', waiting: false });
    expect(store.editorSwitching.value).toBe(true);
    expect(store.switchTarget.value).toEqual({ to: 'Second', waiting: false });
    store.setSwitching(null);
    expect(store.editorSwitching.value).toBe(false);
    expect(store.switchTarget.value).toBeNull();
  });

  it('keys are ignored while a switch is pending', () => {
    const press = (key: string) => onKeyDown(store, { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: { tagName: 'BODY' }, preventDefault: vi.fn() });
    press('e');
    expect(store.tool.value).toBe('eraser');
    store.setSwitching({ to: 'x', waiting: false });
    press('v');
    expect(store.tool.value).toBe('eraser');
    store.setSwitching(null);
    press('v');
    expect(store.tool.value).toBe('move');
  });

  it('askDiscard resolves with the answer, closes itself, and resolves "cancel" on abort', async () => {
    const ctl = new AbortController();
    const p = store.askDiscard('A', 'B', ctl.signal);
    expect(store.discardAsk.value).toEqual({ from: 'A', to: 'B' });
    store.answerDiscard('wait');
    expect(await p).toBe('wait');
    expect(store.discardAsk.value).toBeNull();
    const p2 = store.askDiscard('A', 'B', ctl.signal);
    store.answerDiscard('discard');
    expect(await p2).toBe('discard');
    const p3 = store.askDiscard('A', 'B', ctl.signal);
    ctl.abort();
    expect(await p3).toBe('cancel');
    expect(store.discardAsk.value).toBeNull();
  });

  it('failures of an ended session ("Bridge closed") are not shown in the next editor', () => {
    store.setNotice('Flatten failed: Bridge closed');
    expect(store.notice.value).toBe('');
    store.setNotice('Something else');
    expect(store.notice.value).toBe('Something else');
  });

  it('a held notice is not replaced by the next session\'s loading progress', () => {
    store.holdNotice('Editor "x" no longer exists - showing "Main"');
    store.setNotice('Loading document from TouchDesigner…');
    expect(store.notice.value).toMatch(/no longer exists/);
    store.setNotice('Protocol mismatch');
    expect(store.notice.value).toBe('Protocol mismatch');
  });

  it('endSessionState keeps the layer clipboard (it pastes into the next editor)', () => {
    const clip = { kind: 'layer-clip' as const, count: 2, bytes: 8 };
    store.setLayerClip(clip);
    store.endSessionState();
    expect(store.hasLayerClip()).toBe(true);
  });
});
