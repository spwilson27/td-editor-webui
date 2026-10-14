import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTyping, onKeyDown, onKeyUp, type KeyLike } from '../../src/state/keyboard';
import { createStore } from '../../src/state/store';
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
    press('l');
    expect(store.tool.value).toBe('brush');
    expect(store.notice.value).toMatch(/not available/);
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
