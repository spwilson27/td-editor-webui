import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTyping, onKeyDown, onKeyUp, type KeyLike } from '../../src/state/keyboard';
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
});
