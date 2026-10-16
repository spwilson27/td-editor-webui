import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onKeyDown } from '../../src/state/keyboard';
import { store } from '../../src/state/store';
import { completeTextSpec } from '../../src/state/specs';
import { ContextBar } from '../../src/ui/ContextBar';
import { Viewport } from '../../src/ui/Viewport';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const vp = () => q('[data-viewport]');
const editor = () => document.querySelector<HTMLTextAreaElement>('[data-text-editor]');
const clientOf = (dx: number, dy: number): [number, number] => {
  const r = vp().getBoundingClientRect(), v = store.view.value;
  return [r.left + v.x + dx * v.zoom, r.top + v.y + dy * v.zoom];
};
const click = async (dx: number, dy: number) => {
  const [x, y] = clientOf(dx, dy);
  vp().dispatchEvent(ptr('pointerdown', { clientX: x, clientY: y, buttons: 1 }));
  vp().dispatchEvent(ptr('pointerup', { clientX: x, clientY: y }));
  await settle();
};
const type = async (text: string) => {
  const ta = editor()!;
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};
/** Client y of the first baseline the engine draws (textShape.drawText: y + (lineH - size)/2 + 0.8 size, scaled by the view). */
const engineBaseline = (t: { y: number; size: number; lineHeight: number }, r: DOMRect) => {
  const v = store.view.value;
  return r.top + v.y + (t.y + (t.size * t.lineHeight - t.size) / 2 + 0.8 * t.size) * v.zoom;
};
/** Client y of the CSS baseline of the textarea's first line, measured with a twin element that has an inline-block sitting on the baseline. */
const cssBaseline = (ta: HTMLTextAreaElement) => {
  const cs = getComputedStyle(ta), r = ta.getBoundingClientRect();
  const twin = document.createElement('div');
  twin.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;font:${cs.font};line-height:${cs.lineHeight};white-space:pre;margin:0;padding:0`;
  twin.innerHTML = 'Hg<span style="display:inline-block;width:1px;height:0"></span>';
  document.body.appendChild(twin);
  const y = twin.querySelector('span')!.getBoundingClientRect().bottom;
  twin.remove();
  return y;
};
const textLayers = () => engine.layers().filter((l) => l.kind === 'text');

beforeEach(async () => {
  engine = freshEngine(200, 100);
  store.textEdit.value = null;
  store.viewMode.value = 'local';
  store.setTool('text');
  await mount(<Viewport />, 'display:flex;flex-direction:column;width:600px;height:400px');
});
afterEach(() => { store.textEdit.value = null; unmount(); });

describe('text tool: inline editor', () => {
  it('click adds a text layer at the document point and opens an editor aligned with the view transform and font', async () => {
    store.primary.value = '#336699';
    await click(40, 20);
    expect(textLayers().length).toBe(1);
    const spec = textLayers()[0].text!;
    expect(spec).toMatchObject({ x: 40, y: 20, text: '', size: 64, font: 'Arial', color: { r: 51, g: 102, b: 153, a: 255 } });
    const ta = editor()!;
    expect(ta).toBeTruthy();
    expect(document.activeElement).toBe(ta);
    const [cx] = clientOf(40, 20), z = store.view.value.zoom;
    expect(ta.getBoundingClientRect().left).toBeCloseTo(cx, 0);
    expect(Math.abs(cssBaseline(ta) - engineBaseline(spec, vp().getBoundingClientRect()))).toBeLessThan(1); // sub-pixel: Blink snaps font metrics
    expect(parseFloat(getComputedStyle(ta).fontSize)).toBeCloseTo(64 * z, 1);
    expect(getComputedStyle(ta).fontFamily).toContain('Arial');
    store.zoomBy(2);
    await settle();
    const [nx] = clientOf(40, 20);
    expect(editor()!.getBoundingClientRect().left).toBeCloseTo(nx, 0);
    expect(Math.abs(cssBaseline(editor()!) - engineBaseline(spec, vp().getBoundingClientRect()))).toBeLessThan(1); // sub-pixel: Blink snaps font metrics
    expect(parseFloat(getComputedStyle(editor()!).fontSize)).toBeCloseTo(64 * store.view.value.zoom, 1);
  });

  it('typing edits the layer live via engine.setText; Escape commits and keeps non-empty text', async () => {
    await click(10, 10);
    await type('Hello');
    expect(textLayers()[0].text!.text).toBe('Hello');
    expect(engine.calls.some((c) => c.startsWith('setText:') && c.includes('"text":"Hello"'))).toBe(true);
    editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(editor()).toBeNull();
    expect(store.textEdit.value).toBeNull();
    expect(textLayers().length).toBe(1);
  });

  it('a new text left empty is deleted on commit (Esc and click-away)', async () => {
    await click(10, 10);
    editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(textLayers().length).toBe(0);
    expect(engine.history().index).toBe(0); // the abandoned click leaves nothing applied in the history
    expect(engine.history().entries.slice(0, engine.history().index + 1).map((e) => e.label)).toEqual(['Open']);
    await click(30, 30);
    expect(textLayers().length).toBe(1);
    await click(150, 80); // click outside the editor commits (and, being empty, removes the layer) without starting another
    expect(editor()).toBeNull();
    expect(textLayers().length).toBe(0);
  });

  it('click-away keeps typed text; clicking an existing text layer edits it instead of adding a new one', async () => {
    await click(10, 10);
    await type('Hi');
    await click(150, 80);
    expect(editor()).toBeNull();
    expect(textLayers().length).toBe(1);
    const id = textLayers()[0].id;
    engine.setActiveLayer('base');
    await click(14, 14); // inside the 'Hi' box
    expect(textLayers().length).toBe(1);
    expect(store.textEdit.value).toEqual({ id, isNew: false });
    expect(editor()!.value).toBe('Hi');
    expect(engine.activeLayerId()).toBe(id);
    await type('');
    await click(150, 80);
    expect(textLayers().length).toBe(1); // an existing layer emptied by the user is kept
  });

  it('clicking another text layer while editing moves the editor to it', async () => {
    engine.addTextLayer(completeTextSpec({ text: 'AA', x: 100, y: 10 }));
    const second = engine.addTextLayer(completeTextSpec({ text: 'BB', x: 10, y: 10 }));
    store.setTool('text');
    await click(12, 12);
    expect(store.textEdit.value!.id).toBe(second);
    await click(105, 15);
    expect(store.textEdit.value!.id).not.toBe(second);
    expect(editor()!.value).toBe('AA');
    expect(textLayers().length).toBe(2);
  });

  it('keyboard shortcuts are suppressed while editing, including forwarded keys that target the body', async () => {
    store.tool.value = 'text';
    await click(10, 10);
    const press = (key: string, mods = {}) => onKeyDown(store, { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: document.body, preventDefault() {}, ...mods });
    for (const k of ['b', 'e', ' ', 'x', '[']) press(k);
    press('z', { ctrlKey: true });
    expect(store.tool.value).toBe('text');
    expect(store.spaceHeld.value).toBe(false);
    expect(engine.calls).not.toContain('undo');
    // a real key typed into the textarea reaches no shortcut either
    editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    expect(store.tool.value).toBe('text');
    press('Escape'); // forwarded Esc commits
    await settle();
    expect(editor()).toBeNull();
    press('b');
    expect(store.tool.value).toBe('brush');
  });

  it('switching tools commits the editor', async () => {
    await click(10, 10);
    await type('x');
    store.setTool('brush');
    await settle();
    expect(editor()).toBeNull();
    expect(textLayers().length).toBe(1);
  });

  it('the editor shows in TD view too, and then draws its own glyphs (the local preview is off)', async () => {
    await click(10, 10);
    expect(getComputedStyle(editor()!).color).toBe('rgba(0, 0, 0, 0)'); // local view: engine renders the glyphs
    store.setConnection('linked');
    store.setViewMode('td');
    await settle();
    expect(editor()).toBeTruthy();
    expect(getComputedStyle(editor()!).color).not.toBe('rgba(0, 0, 0, 0)');
    store.setViewMode('local');
    store.setConnection('standalone');
  });
});

describe('text editor geometry', () => {
  it('baselines match the engine for another font size, line height, zoom and multiple lines; wrap width follows boxWidth; right align keeps the edge', async () => {
    const id = engine.addTextLayer(completeTextSpec({ text: 'Hg\nHg', size: 40, lineHeight: 1.5, x: 30, y: 12, font: 'Georgia' }));
    store.setTool('text');
    store.zoomTo(3);
    await settle();
    store.beginText(32, 14);
    await settle();
    const spec = engine.layers().find((l) => l.id === id)!.text!;
    expect(Math.abs(cssBaseline(editor()!) - engineBaseline(spec, vp().getBoundingClientRect()))).toBeLessThan(1); // sub-pixel: Blink snaps font metrics
    expect(getComputedStyle(editor()!).whiteSpace).toBe('pre');
    store.commitText();
    engine.setText(id, { ...spec, boxWidth: 90, align: 'right' });
    store.beginText(32, 14);
    await settle();
    const ta = editor()!, z = store.view.value.zoom;
    expect(getComputedStyle(ta).whiteSpace).toBe('pre-wrap');
    expect(ta.getBoundingClientRect().width).toBeCloseTo(90 * z + 3, 0);
    expect(ta.getBoundingClientRect().right).toBeCloseTo(clientOf(30 + 90, 0)[0], 0); // the right edge is the block edge x + boxWidth; the slack is on the left
    expect(getComputedStyle(ta).textAlign).toBe('right');
  });
});

describe('text editor and the context bar', () => {
  it('a press on a non-focusable part of the context bar keeps the editor open (blur without relatedTarget)', async () => {
    const bar = document.createElement('div');
    bar.setAttribute('data-context-bar', '');
    bar.innerHTML = '<span>label</span>';
    document.body.appendChild(bar);
    await click(10, 10);
    await type('Hi');
    bar.firstElementChild!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    editor()!.blur();
    await settle();
    expect(editor()).toBeTruthy();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 450));
    editor()!.focus();
    editor()!.blur();
    await settle();
    expect(editor()).toBeNull();
    bar.remove();
  });
});

describe('text context bar', () => {
  beforeEach(async () => { await mount(<ContextBar />, 'width:1500px'); store.setTool('text'); await settle(); });

  it('lists the fonts (TD list replaces the built-in fallback) and falls back when the current font is missing', async () => {
    expect([...document.querySelectorAll('#tf option')].map((o) => o.textContent)).toContain('Arial');
    store.setFonts(['Menlo', 'Zapfino']);
    await settle();
    expect([...document.querySelectorAll('#tf option')].map((o) => o.textContent)).toEqual(['Menlo', 'Zapfino']);
    expect(store.textOpts.value.font).toBe('Menlo');
    store.setFonts(['Arial', 'Menlo']);
    expect(store.textOpts.value.font).toBe('Menlo'); // still available: kept
  });

  it('without a text layer the controls set the defaults for the next one', async () => {
    store.setFonts(['Arial', 'Menlo']);
    const size = q<HTMLInputElement>('#ts');
    size.value = '90';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    q('[data-opt=bold]').click();
    q('[data-opt=align-center]').click();
    await settle();
    expect(store.textOpts.value).toMatchObject({ size: 90, bold: true, align: 'center' });
    expect(engine.calls.some((c) => c.startsWith('setText'))).toBe(false);
  });

  it('with a text layer selected every control edits that layer through engine.setText', async () => {
    store.setFonts(['Arial', 'Menlo']);
    const id = engine.addTextLayer(completeTextSpec({ text: 'Hi', size: 40 }));
    await settle();
    expect(q<HTMLInputElement>('#ts').value).toBe('40');
    const font = q<HTMLSelectElement>('#tf');
    font.value = 'Menlo';
    font.dispatchEvent(new Event('change', { bubbles: true }));
    const size = q<HTMLInputElement>('#ts');
    size.value = '55';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    q('[data-opt=italic]').click();
    q('[data-opt=align-right]').click();
    const lh = q<HTMLInputElement>('#tl');
    lh.value = '150';
    lh.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(engine.layers().find((l) => l.id === id)!.text).toMatchObject({ text: 'Hi', font: 'Menlo', size: 55, italic: true, align: 'right', lineHeight: 1.5 });
    const color = q<HTMLInputElement>('#tc');
    color.value = '#ff0000';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(engine.layers().find((l) => l.id === id)!.text!.color).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(store.primary.value).toBe('#ff0000');
  });
});
