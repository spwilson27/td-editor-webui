import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTyping, onKeyDown, onKeyUp, type KeyLike } from '../../src/state/keyboard';
import { CLIP_MARKER } from '../../src/state/layersSlice';
import { createStore } from '../../src/state/store';
import { TOOLS } from '../../src/state/tools';
import { FakeEngine } from '../browser/fakeEngine';

let store: ReturnType<typeof createStore>;
let engine: FakeEngine;
const body = { tagName: 'BODY' };

const press = (key: string, mods: Partial<KeyLike> = {}) => {
  const e = { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: body, preventDefault: vi.fn(), ...mods };
  onKeyDown(store, e);
  return e;
};

beforeEach(() => {
  store = createStore();
  engine = new FakeEngine(200, 100);
  store.attach(engine);
  store.setViewSize(1064, 564);
});

describe('keyboard shortcuts', () => {
  it('selects tools by key, case-insensitively', () => {
    press('e'); expect(store.tool.value).toBe('eraser');
    press('V'); expect(store.tool.value).toBe('move');
    press('m'); expect(store.tool.value).toBe('marquee');
    press('h'); expect(store.tool.value).toBe('hand');
    press('z'); expect(store.tool.value).toBe('zoom');
    press('i'); expect(store.tool.value).toBe('picker');
    press('n'); expect(store.tool.value).toBe('pencil');
  });

  it('G cycles between fill and gradient', () => {
    press('g'); expect(store.tool.value).toBe('fill');
    press('g'); expect(store.tool.value).toBe('gradient');
    press('g'); expect(store.tool.value).toBe('fill');
  });

  it('disabled tools do not activate and raise a notice', () => {
    const crop = TOOLS.find((t) => t.id === 'crop')!;
    crop.enabled = false;
    try {
      press('c');
      expect(store.tool.value).toBe('brush');
      expect(store.notice.value).toMatch(/not available/);
    } finally { crop.enabled = true; }
  });

  it('selects the v3 tools: L lasso, W wand, T text, U shape', () => {
    press('l'); expect(store.tool.value).toBe('lasso');
    press('w'); expect(store.tool.value).toBe('wand');
    press('t'); expect(store.tool.value).toBe('text');
    press('u'); expect(store.tool.value).toBe('shape');
    expect(engine.shapeTool).toBe('rect');
  });

  it('Select All (Ctrl/Cmd+A), Deselect (Ctrl/Cmd+D) and Invert (Shift+Ctrl/Cmd+I) call the engine and prevent the browser default', () => {
    const a = press('a', { ctrlKey: true });
    expect(a.preventDefault).toHaveBeenCalled();
    expect(engine.selection()).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    press('i', { metaKey: true, shiftKey: true });
    press('d', { metaKey: true });
    expect(engine.calls.filter((c) => /selectAll|invertSelection|deselect/.test(c))).toEqual(['selectAll', 'invertSelection', 'deselect']);
    press('i', { ctrlKey: true }); // no shift: nothing
    expect(engine.calls.filter((c) => c === 'invertSelection').length).toBe(1);
  });

  it('while the inline text editor is open no shortcut fires (forwarded TD keys target the body); Escape commits', () => {
    store.setTool('text');
    const id = store.beginText(5, 5);
    expect(store.textEdit.value).toMatchObject({ id, isNew: true });
    for (const k of ['b', 'e', 'x', ' ', '0']) press(k);
    press('a', { ctrlKey: true });
    press('z', { ctrlKey: true });
    expect(store.tool.value).toBe('text');
    expect(engine.calls).not.toContain('selectAll');
    expect(engine.calls).not.toContain('undo');
    expect(store.spaceHeld.value).toBe(false);
    press('Escape');
    expect(store.textEdit.value).toBeNull();
    expect(engine.layers().some((l) => l.id === id)).toBe(false); // empty new text removed
    press('b');
    expect(store.tool.value).toBe('brush');
  });

  it('brackets resize, X swaps, D resets colours', () => {
    store.setBrush({ size: 64 });
    press(']'); expect(store.brush.value.size).toBe(69);
    press('['); press('['); expect(store.brush.value.size).toBe(59);
    store.setPrimaryHex('#123456');
    press('x'); expect(store.secondary.value).toBe('#123456');
    press('d'); expect(store.primary.value).toBe('#000000');
  });

  it('undo, redo and deselect with ctrl or cmd', () => {
    const z = press('z', { ctrlKey: true });
    expect(z.preventDefault).toHaveBeenCalled();
    press('z', { metaKey: true, shiftKey: true });
    press('y', { ctrlKey: true });
    engine.setSelection({ x: 1, y: 1, w: 5, h: 5 });
    press('d', { ctrlKey: true });
    expect(engine.calls.filter((c) => c === 'undo').length).toBe(1);
    expect(engine.calls.filter((c) => c === 'redo').length).toBe(2);
    expect(engine.selection()).toBeNull();
  });

  it('does not swallow unrelated ctrl combinations or alt+letter', () => {
    const e = press('r', { ctrlKey: true });
    expect(e.preventDefault).not.toHaveBeenCalled();
    press('e', { altKey: true });
    expect(store.tool.value).toBe('brush');
  });

  it('space holds pan and releases on keyup', () => {
    const e = press(' ');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(store.spaceHeld.value).toBe(true);
    onKeyUp(store, { key: ' ' });
    expect(store.spaceHeld.value).toBe(false);
  });

  it('0 fits and 1 shows 100%', () => {
    press('1');
    expect(store.view.value.zoom).toBe(1);
    press('0');
    expect(store.view.value.zoom).toBeCloseTo(5, 6);
  });

  it('ignores keys while typing in text fields but not on sliders', () => {
    press('e', { target: { tagName: 'INPUT', type: 'text' } });
    press('e', { target: { tagName: 'SELECT' } });
    expect(store.tool.value).toBe('brush');
    press('e', { target: { tagName: 'INPUT', type: 'range' } });
    expect(store.tool.value).toBe('eraser');
    expect(isTyping({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTyping(null)).toBe(false);
  });
});

describe('keyboard hardening', () => {
  it('Space does not preventDefault on a focused button or link, but still pans', () => {
    const b = press(' ', { target: { tagName: 'BUTTON' } });
    expect(b.preventDefault).not.toHaveBeenCalled();
    expect(store.spaceHeld.value).toBe(true);
    onKeyUp(store, { key: ' ' });
    expect(press(' ', { target: { tagName: 'A' } }).preventDefault).not.toHaveBeenCalled();
    onKeyUp(store, { key: ' ' });
    expect(press(' ').preventDefault).toHaveBeenCalled();
  });

  it('auto-repeat does not retrigger toggles but [ ] and Space keep repeating', () => {
    store.setPrimaryHex('#123456');
    press('x');
    press('x', { repeat: true });
    press('x', { repeat: true });
    expect(store.secondary.value).toBe('#123456');
    expect(store.primary.value).toBe('#ffffff');
    press('g'); press('g', { repeat: true });
    expect(store.tool.value).toBe('fill');
    store.setBrush({ size: 64 });
    press(']', { repeat: true }); press(']', { repeat: true });
    expect(store.brush.value.size).toBe(74);
    store.spaceSeenAt = 0;
    press(' ', { repeat: true });
    expect(store.spaceSeenAt).toBeGreaterThan(0);
    press('z', { ctrlKey: true, repeat: true });
    expect(engine.calls.filter((c) => c === 'undo').length).toBe(1);
  });

  it('releases a Space whose keyup never arrived only after a second of silence', () => {
    store.spaceHeld.value = true;
    store.spaceSeenAt = 1000;
    store.releaseStaleSpace(1900);
    expect(store.spaceHeld.value).toBe(true);
    store.releaseStaleSpace(2100);
    expect(store.spaceHeld.value).toBe(false);
  });
});

describe('v5 keys', () => {
  it('C S R Y O select crop, clone, smudge, blur, dodge', () => {
    for (const [k, id] of [['c', 'crop'], ['s', 'clone'], ['r', 'smudge'], ['y', 'blur'], ['o', 'dodge']] as const) {
      press(k);
      expect(store.tool.value).toBe(id);
      expect(engine.tool).toBe(id);
    }
  });

  it('Q toggles Quick Mask on the engine', () => {
    press('q'); expect(engine.quickMask()).toBe(true);
    press('q'); expect(engine.quickMask()).toBe(false);
    expect(engine.calls.filter((c) => c.startsWith('quickMask:'))).toEqual(['quickMask:true', 'quickMask:false']);
  });

  describe('Ctrl/Cmd+T', () => {
    beforeEach(() => { engine.setActiveLayer(engine.addPixelLayer('P')); });

    it('lifts the selection of a pixel layer into a floating selection and switches to Move', () => {
      engine.setSelection({ x: 10, y: 10, w: 30, h: 20 });
      const e = press('t', { ctrlKey: true });
      expect(e.preventDefault).toHaveBeenCalled();
      expect(engine.calls).toContain('liftSelection');
      expect(engine.floating()).not.toBeNull();
      expect(store.tool.value).toBe('move');
      expect(store.wantMove.value).toBe(false);
    });

    it('does nothing without a selection (and leaves the browser default alone)', () => {
      const e = press('t', { metaKey: true });
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(engine.calls).not.toContain('liftSelection');
      expect(store.tool.value).toBe('brush');
    });

    it('does nothing on a non-pixel layer', () => {
      engine.setActiveLayer('base');
      engine.setSelection({ x: 1, y: 1, w: 5, h: 5 });
      press('t', { ctrlKey: true });
      expect(engine.floating()).toBeNull();
    });

    it('a plain T is still the text tool', () => {
      press('t'); expect(store.tool.value).toBe('text');
    });
  });

  describe('Enter / Esc', () => {
    it('commit / cancel a floating selection', () => {
      engine.setActiveLayer(engine.addPixelLayer('P'));
      engine.setSelection({ x: 10, y: 10, w: 30, h: 20 });
      press('t', { ctrlKey: true });
      const e = press('Enter');
      expect(e.preventDefault).toHaveBeenCalled();
      expect(engine.calls).toContain('commitFloating');
      expect(engine.floating()).toBeNull();
      press('t', { ctrlKey: true });
      press('Escape');
      expect(engine.calls).toContain('cancelFloating');
      expect(engine.floating()).toBeNull();
    });

    it('Enter applies the crop box, Esc drops it', () => {
      store.setTool('crop');
      store.cropBox.value = { x: 10, y: 20, w: 100, h: 50 };
      press('Enter');
      expect(engine.cropped).toEqual([{ x: 10, y: 20, w: 100, h: 50 }]);
      expect(store.cropBox.value).toBeNull();
      store.cropBox.value = { x: 1, y: 1, w: 20, h: 20 };
      press('Escape');
      expect(store.cropBox.value).toBeNull();
      expect(engine.cropped.length).toBe(1);
    });

    it('Enter without anything pending is inert', () => {
      const e = press('Enter');
      expect(e.preventDefault).not.toHaveBeenCalled();
    });
  });

  it('the file and selection-op dialogs own the keyboard', () => {
    store.selOpDialog.value = 'grow';
    press('e');
    expect(store.tool.value).toBe('brush');
    store.selOpDialog.value = null;
    store.fileDialog.value = { op: 'exportPng', path: '', busy: false, result: null } as never;
    press('e');
    expect(store.tool.value).toBe('brush');
    store.fileDialog.value = null;
    press('e');
    expect(store.tool.value).toBe('eraser');
  });

  describe('layer clipboard keys (v7.1)', () => {
    const ctrl = { ctrlKey: true };
    const ops = (op: string) => engine.clipLog.filter((c) => c.op === op);
    let a: string, b: string;
    beforeEach(() => {
      vi.useFakeTimers();
      a = engine.addPixelLayer('A');
      b = engine.addPixelLayer('B');
      engine.clipLog.length = 0;
    });
    afterEach(() => { store.cancelPasteFallback(); vi.useRealTimers(); });

    it('Ctrl/Cmd+C, X and J drive the engine and prevent the browser default; V arms the paste fallback', () => {
      expect(press('c', ctrl).preventDefault).toHaveBeenCalled();
      expect(ops('copy')).toMatchObject([{ op: 'copy', ids: [b], asCut: false }]);
      expect(press('j', { metaKey: true }).preventDefault).toHaveBeenCalled();
      expect(ops('duplicate')).toEqual([{ op: 'duplicate', ids: [b] }]);
      expect(press('v', ctrl).preventDefault).not.toHaveBeenCalled(); // the paste event must still arrive
      expect(ops('paste')).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(ops('paste')).toHaveLength(1);
      vi.advanceTimersByTime(500);
      expect(ops('paste')).toHaveLength(1);
      expect(press('x', ctrl).preventDefault).toHaveBeenCalled();
      expect(engine.calls.some((c) => c.startsWith('deleteLayers:'))).toBe(true);
      expect(a).toBeTruthy();
    });

    it('a pending fallback is cancelled by cancelPasteFallback (the paste event path)', () => {
      press('c', ctrl);
      press('v', ctrl);
      store.cancelPasteFallback();
      vi.advanceTimersByTime(200);
      expect(ops('paste')).toHaveLength(0);
    });

    it('V without a layer clipboard arms nothing', () => {
      press('v', ctrl);
      vi.advanceTimersByTime(200);
      expect(ops('paste')).toHaveLength(0);
    });

    it('ignores Shift and Alt combinations', () => {
      press('c', { ctrlKey: true, shiftKey: true });
      press('j', { ctrlKey: true, altKey: true });
      expect(engine.clipLog).toHaveLength(0);
    });

    it('guards: typing, other controls, already-handled keys, no engine, crop box, floating selection, text editing, dialogs', () => {
      const input = { tagName: 'INPUT', type: 'text' };
      const button = { tagName: 'BUTTON', closest: () => null };
      const inList = { tagName: 'BUTTON', closest: (s: string) => (s === '[data-layer-list]' ? {} : null) };
      for (const k of ['c', 'x', 'j']) {
        expect(press(k, { ...ctrl, target: input }).preventDefault).not.toHaveBeenCalled();
        expect(press(k, { ...ctrl, target: button }).preventDefault).not.toHaveBeenCalled();
        expect(press(k, { ...ctrl, defaultPrevented: true }).preventDefault).not.toHaveBeenCalled();
      }
      expect(engine.clipLog).toHaveLength(0);
      expect(press('c', { ...ctrl, target: inList }).preventDefault).toHaveBeenCalled();
      expect(ops('copy')).toHaveLength(1);
      engine.clipLog.length = 0;

      store.cropBox.value = { x: 0, y: 0, w: 5, h: 5 };
      for (const k of ['c', 'x', 'j', 'v']) press(k, ctrl);
      store.cropBox.value = null;
      store.cancelPasteFallback();
      expect(engine.clipLog).toHaveLength(0);

      engine.setActiveLayer(engine.addPixelLayer('P'));
      engine.setSelection({ x: 10, y: 10, w: 30, h: 20 });
      press('t', ctrl);
      expect(store.isFloating()).toBe(true);
      engine.clipLog.length = 0;
      for (const k of ['c', 'x', 'j', 'v']) press(k, ctrl);
      store.cancelPasteFallback();
      expect(engine.clipLog).toHaveLength(0);
      press('Escape');

      store.fileDialog.value = { op: 'exportPng', path: '', busy: false, result: null } as never;
      press('c', ctrl);
      store.fileDialog.value = null;
      expect(engine.clipLog).toHaveLength(0);
    });

    it('a pixel selection does not stop layer copy', () => {
      engine.setSelection({ x: 1, y: 1, w: 5, h: 5 });
      press('c', ctrl);
      expect(ops('copy')).toHaveLength(1);
    });

    it('input-only selection: copy notices, cut/duplicate do nothing', () => {
      engine.setActiveLayer('base');
      engine.clipLog.length = 0;
      press('c', ctrl);
      expect(store.notice.value).toBe('Input layers cannot be copied');
      press('x', ctrl);
      press('j', ctrl);
      expect(ops('copy')).toHaveLength(0);
      expect(ops('duplicate')).toHaveLength(0);
      expect(engine.calls.some((c) => c.startsWith('deleteLayers:'))).toBe(false);
    });

    describe('hardening (review)', () => {
      const button = { tagName: 'BUTTON', closest: () => null };
      afterEach(() => { vi.unstubAllGlobals(); store.loadingDoc.value = false; store.topDialog.value = false; store.textEdit.value = null; store.cropBox.value = null; });

      it('key repeat for c/x/v/j does nothing and is preventDefault-ed; one non-repeat press acts once', () => {
        for (const k of ['c', 'x', 'v', 'j']) expect(press(k, { ...ctrl, repeat: true }).preventDefault).toHaveBeenCalled();
        store.cancelPasteFallback();
        expect(engine.clipLog).toHaveLength(0);
        press('c', ctrl);
        for (let i = 0; i < 3; i++) press('c', { ...ctrl, repeat: true });
        expect(ops('copy')).toHaveLength(1);
        press('v', ctrl);
        for (let i = 0; i < 3; i++) press('v', { ...ctrl, repeat: true });
        vi.advanceTimersByTime(50);
        expect(ops('paste')).toHaveLength(1);
      });

      it('paste is not subject to the deleteKeyTarget guard (a focused button still arms the fallback); copy/cut/duplicate are', () => {
        press('c', ctrl);
        engine.clipLog.length = 0;
        for (const k of ['c', 'x', 'j']) press(k, { ...ctrl, target: button });
        expect(engine.clipLog).toHaveLength(0);
        press('v', { ...ctrl, target: button });
        vi.advanceTimersByTime(50);
        expect(ops('paste')).toHaveLength(1);
      });

      it('a typing input target never arms the paste fallback', () => {
        press('c', ctrl);
        press('v', { ...ctrl, target: { tagName: 'INPUT', type: 'text' } });
        press('v', { ...ctrl, target: { tagName: 'TEXTAREA' } });
        vi.advanceTimersByTime(100);
        expect(ops('paste')).toHaveLength(0);
      });

      it.each([
        ['loadingDoc', () => { store.loadingDoc.value = true; }],
        ['a dialog', () => { store.topDialog.value = true; }],
        ['text editing', () => { store.textEdit.value = { id: 'x', isNew: false }; }],
        ['a crop box', () => { store.cropBox.value = { x: 0, y: 0, w: 4, h: 4 }; }],
        ['a floating selection', () => {
          engine.setActiveLayer(engine.addPixelLayer('P'));
          engine.setSelection({ x: 10, y: 10, w: 30, h: 20 });
          expect(store.beginTransformSelection()).toBeTruthy();
        }],
      ])('state changing to %s between keydown and the 0 ms timer pastes nothing', (_n, change) => {
        press('c', ctrl);
        engine.clipLog.length = 0;
        press('v', ctrl);
        change();
        vi.advanceTimersByTime(100);
        expect(ops('paste')).toHaveLength(0);
      });

      it('a throwing engine.pasteLayers inside the timer does not escape; a notice is shown', () => {
        press('c', ctrl);
        vi.spyOn(engine, 'pasteLayers').mockImplementation(() => { throw new Error('boom'); });
        press('v', ctrl);
        expect(() => vi.advanceTimersByTime(100)).not.toThrow();
        expect(store.notice.value).toBe('Paste failed: boom');
      });

      it('copy then copy again releases the previous clip before copying', () => {
        press('c', ctrl);
        engine.clipLog.length = 0;
        press('c', ctrl);
        expect(engine.clipLog.map((c) => c.op)).toEqual(['release', 'copy']);
      });

      it('cut copies with asCut=true; cut-then-paste keeps names (no copy suffix) while copy-then-paste adds one', () => {
        press('x', ctrl);
        expect(ops('copy')).toMatchObject([{ asCut: true }]);
        vi.advanceTimersByTime(600);
        press('v', ctrl);
        vi.advanceTimersByTime(50);
        expect(ops('paste')).toHaveLength(1);
        expect(engine.layers().filter((l) => l.name.endsWith(' copy'))).toHaveLength(0);
        expect(engine.layers().filter((l) => l.name === 'B')).toHaveLength(1);
        vi.advanceTimersByTime(600);
        press('c', ctrl);
        press('v', ctrl);
        vi.advanceTimersByTime(50);
        expect(engine.layers().some((l) => l.name.endsWith(' copy'))).toBe(true);
      });

      describe('pasteFromClipboard (stubbed navigator.clipboard)', () => {
        const item = (types: Record<string, Blob>) => ({ types: Object.keys(types), getType: async (t: string) => types[t] });
        const marker = () => item({ 'text/plain': new Blob([`${CLIP_MARKER}:1`], { type: 'text/plain' }) });
        const image = () => item({ 'image/png': new Blob(['x'], { type: 'image/png' }) });
        const stub = (read: () => Promise<unknown>) => vi.stubGlobal('navigator', { clipboard: { read, writeText: () => Promise.resolve() } });
        let imports: Blob[];
        beforeEach(async () => {
          imports = [];
          stub(async () => []); // a working writeText at copy time, so the marker counts as written
          vi.spyOn(store, 'importBlob').mockImplementation((async (b: Blob) => { imports.push(b); }) as never);
          press('c', ctrl);
          await Promise.resolve();
          engine.clipLog.length = 0;
        });

        it('marker text item => layers pasted', async () => {
          stub(async () => [marker()]);
          await store.pasteFromClipboard();
          expect(ops('paste')).toHaveLength(1);
          expect(imports).toHaveLength(0);
        });
        it('image + marker => layers; image only => import', async () => {
          stub(async () => [image(), marker()]);
          await store.pasteFromClipboard();
          expect(ops('paste')).toHaveLength(1);
          expect(imports).toHaveLength(0);
          stub(async () => [image()]);
          await store.pasteFromClipboard();
          expect(ops('paste')).toHaveLength(1);
          expect(imports).toHaveLength(1);
        });
        it('read rejects => layer clip, else the Press Ctrl+V notice', async () => {
          stub(() => Promise.reject(new Error('denied')));
          await store.pasteFromClipboard();
          expect(ops('paste')).toHaveLength(1);
          expect(store.notice.value).toBe('');
          store.setLayerClip(null);
          await store.pasteFromClipboard();
          expect(ops('paste')).toHaveLength(1);
          expect(store.notice.value).toBe('Press Ctrl+V to paste an image');
        });
        it('a read that never resolves falls back to the layer clip after 2 s', async () => {
          stub(() => new Promise(() => {}));
          const p = store.pasteFromClipboard();
          await vi.advanceTimersByTimeAsync(1900);
          expect(ops('paste')).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(200);
          await p;
          expect(ops('paste')).toHaveLength(1);
        });
        it('loadingDoc => nothing at all', async () => {
          const read = vi.fn(async () => [marker()]);
          stub(read);
          store.loadingDoc.value = true;
          await store.pasteFromClipboard();
          expect(read).not.toHaveBeenCalled();
          expect(ops('paste')).toHaveLength(0);
        });
      });
    });
  });
});
