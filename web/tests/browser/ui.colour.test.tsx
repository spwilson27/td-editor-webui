import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { ColourPanel } from '../../src/ui/ColourPanel';
import { SwatchesPanel } from '../../src/ui/SwatchesPanel';
import { BrushesPanel } from '../../src/ui/BrushesPanel';
import { drag, freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

beforeEach(async () => {
  freshEngine();
  store.setPrimaryHex('#e2683c');
  store.alpha.value = 100;
  await mount(<ColourPanel />, 'width:290px');
});
afterEach(unmount);

const wheel = () => q('[data-wheel]');
const at = (el: Element, x: number, y: number): [number, number] => { const r = el.getBoundingClientRect(); return [r.left + x, r.top + y]; };

describe('ColourPanel', () => {
  it('dragging on the ring sets the hue (top = red, right = 90 degrees)', async () => {
    const w = wheel();
    drag(w, at(w, 90, 9), at(w, 171, 90));
    await settle();
    expect(store.hsv.value.h).toBeCloseTo(90, 0);
    expect(store.primary.value).not.toBe('#e2683c');
    const handle = q('[data-handle=ring]');
    expect(parseFloat(handle.style.left)).toBeCloseTo(171, 0);
    expect(parseFloat(handle.style.top)).toBeCloseTo(90, 0);
  });

  it('dragging in the SV square sets saturation and value, clamped to the square', async () => {
    const w = wheel();
    store.setHsv({ h: 120, s: 0.5, v: 0.5 });
    drag(w, at(w, 90, 90), at(w, 136, 44));
    await settle();
    expect(store.hsv.value.s).toBeCloseTo(1, 2);
    expect(store.hsv.value.v).toBeCloseTo(1, 2);
    expect(store.primary.value).toBe('#00ff00');
    drag(w, at(w, 90, 90), at(w, 20, 150)); // drag outside the square clamps
    await settle();
    expect(store.hsv.value.s).toBe(0);
    expect(store.hsv.value.v).toBeCloseTo(0, 2);
  });

  it('ignores presses outside the ring and square', async () => {
    const w = wheel();
    const before = store.primary.value;
    drag(w, at(w, 4, 4), at(w, 60, 60));
    await settle();
    expect(store.primary.value).toBe(before);
  });

  it('H/S/L/A sliders respond to dragging along the track', async () => {
    const h = q('[data-slider=H]');
    const r = h.getBoundingClientRect();
    drag(h, [r.left + 1, r.top + 5], [r.left + r.width / 2, r.top + 5]);
    await settle();
    expect(store.hsl.value.h).toBeCloseTo(180, 0);

    const a = q('[data-slider=A]');
    const ar = a.getBoundingClientRect();
    drag(a, [ar.right - 1, ar.top + 5], [ar.left + ar.width * 0.25, ar.top + 5]);
    await settle();
    expect(store.alpha.value).toBe(25);
    expect(document.body.textContent).toContain('25%');

    const l = q('[data-slider=L]');
    const lr = l.getBoundingClientRect();
    drag(l, [lr.left + 2, lr.top + 5], [lr.left + lr.width * 0.8, lr.top + 5]);
    await settle();
    expect(store.hsl.value.l).toBeCloseTo(0.8, 1);
  });

  it('commits a valid hex on Enter and reverts an invalid one on blur', async () => {
    const input = q<HTMLInputElement>('#hex');
    expect(input.value).toBe('#E2683C');
    input.focus();
    input.value = '#336699';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(store.primary.value).toBe('#336699');
    expect(q<HTMLInputElement>('#hex').value).toBe('#336699'.toUpperCase());

    input.value = 'nope';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur'));
    await settle();
    expect(store.primary.value).toBe('#336699');
    expect(q<HTMLInputElement>('#hex').value).toBe('#336699');
  });

  it('accepts shorthand hex', async () => {
    const input = q<HTMLInputElement>('#hex');
    input.value = 'f80';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur'));
    await settle();
    expect(store.primary.value).toBe('#ff8800');
  });

  it('recent swatches set the primary colour; new colours are added in front', async () => {
    q('[data-recent="#2f6b3a"]').click();
    await settle();
    expect(store.primary.value).toBe('#2f6b3a');
    expect(q('[data-recent]').getAttribute('data-recent')).toBe('#2f6b3a');
  });

  it('commits drag colours to recent only when the drag ends', async () => {
    const w = wheel();
    const first = store.recent.value[0];
    w.dispatchEvent(ptr('pointerdown', { clientX: at(w, 90, 9)[0], clientY: at(w, 90, 9)[1] }));
    w.dispatchEvent(ptr('pointermove', { clientX: at(w, 171, 90)[0], clientY: at(w, 171, 90)[1] }));
    expect(store.recent.value[0]).toBe(first);
    w.dispatchEvent(ptr('pointerup'));
    expect(store.recent.value[0]).toBe(store.primary.value);
  });
});

describe('SwatchesPanel and BrushesPanel', () => {
  it('clicking a palette swatch sets the primary colour; add current colour appends', async () => {
    await mount(<SwatchesPanel />, 'width:290px');
    q('[data-swatch-colour="#3d6fb4"]').click();
    await settle();
    expect(store.primary.value).toBe('#3d6fb4');
    const n = document.querySelectorAll('[data-swatch-colour]').length;
    store.setPrimaryHex('#abcdef');
    q<HTMLButtonElement>('button:not([data-swatch-colour])').click();
    await settle();
    expect(document.querySelectorAll('[data-swatch-colour]').length).toBe(n + 1);
    expect(q('[data-swatch-colour="#abcdef"]')).toBeTruthy();
  });

  it('palette select switches to greys', async () => {
    await mount(<SwatchesPanel />, 'width:290px');
    const sel = q<HTMLSelectElement>('select');
    sel.value = 'greys';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(q('[data-swatch-colour="#000000"]')).toBeTruthy();
    expect(q('[data-swatch-colour="#ffffff"]')).toBeTruthy();
  });

  it('brush presets set the brush parameters', async () => {
    await mount(<BrushesPanel />, 'width:290px');
    expect(document.querySelectorAll('[data-brush-source=builtin]').length).toBe(12); // 6 classic + 6 textured / scatter (v6)
    expect(document.querySelectorAll('[data-brush]').length).toBe(12);
    q('[data-brush=airbrush]').click();
    await settle();
    expect(store.brush.value).toMatchObject({ size: 200, hardness: 0, flow: 0.25 });
    expect(q('[data-brush=airbrush]').getAttribute('aria-pressed')).toBe('true');
  });
});
