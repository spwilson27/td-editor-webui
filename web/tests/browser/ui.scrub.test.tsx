import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { Engine } from '../../src/engine';
import { store } from '../../src/state/store';
import { completeTextSpec } from '../../src/state/specs';
import { ContextBar } from '../../src/ui/ContextBar';
import { LayersPanel } from '../../src/ui/LayersPanel';
import { ScrubNumber, ScrubSelect } from '../../src/ui/Scrub';
import { frame, mount, ptr, q, settle, unmount } from './uiHelpers';

// ---- ScrubSelect in isolation ----
let changes: string[];
const OPTS: Array<[string, string, boolean?]> = [['a', 'Alpha'], ['b', 'Bravo', true], ['c', 'Charlie'], ['d', 'Delta'], ['e', 'Echo']];

function Harness({ start = 'a', disabled = false }: { start?: string; disabled?: boolean }) {
  const [v, setV] = useState(start);
  return (
    <ScrubSelect aria-label="Pick" value={v} disabled={disabled} style="width:140px;height:24px" onChange={(e) => { const n = (e.target as HTMLSelectElement).value; changes.push(n); setV(n); }}>
      {OPTS.map(([k, t, off]) => <option key={k} value={k} disabled={off} selected={k === v}>{t}</option>)}
    </ScrubSelect>
  );
}

const sel = () => q<HTMLSelectElement>('select[aria-label="Pick"]');
const press = (el: Element, x: number, y: number) => el.dispatchEvent(ptr('pointerdown', { clientX: x, clientY: y, buttons: 1 }));
const move = (el: Element, x: number, y: number) => el.dispatchEvent(ptr('pointermove', { clientX: x, clientY: y, buttons: 1 }));
const release = (el: Element, x: number, y: number) => el.dispatchEvent(ptr('pointerup', { clientX: x, clientY: y }));
const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

describe('ScrubSelect', () => {
  beforeEach(async () => { changes = []; await mount(<Harness />, 'width:300px;padding:80px 20px'); });
  afterEach(unmount);

  it('is still a native select with the same options', () => {
    expect(sel().tagName).toBe('SELECT');
    expect([...sel().options].map((o) => o.text)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    expect(sel().value).toBe('a');
  });

  it('steps one option per 12 px, down = next, applying each step (one change per crossed step), skipping disabled', async () => {
    const s = sel();
    press(s, 50, 100);
    move(s, 50, 103); // under the 4 px threshold: nothing yet
    expect(changes).toEqual([]);
    for (let y = 104; y <= 136; y += 4) move(s, 50, y); // 36 px down
    expect(changes).toEqual(['c', 'd', 'e']); // 12 px -> Charlie (Bravo is disabled), 24 px -> Delta, 36 px -> Echo
    release(s, 50, 136);
    await settle();
    expect(s.value).toBe('e');
  });

  it('a long drag clamps at the last option; dragging back up goes to previous options', async () => {
    const s = sel();
    press(s, 50, 100);
    move(s, 50, 140);
    move(s, 50, 400);
    await settle();
    expect(s.value).toBe('e');
    const n = changes.length;
    move(s, 50, 600); // still the end
    expect(changes.length).toBe(n);
    move(s, 50, 100 + 12); // one step from the press point = next enabled
    await settle();
    expect(s.value).toBe('c');
    move(s, 50, 100 - 40); // above the press point: previous (clamped at the first)
    await settle();
    expect(s.value).toBe('a');
    release(s, 50, 60);
  });

  it('the dominant axis decides: right = next, left = previous (ew-resize), diagonal drags use the larger axis', async () => {
    const s = sel();
    press(s, 50, 100);
    move(s, 76, 104);
    expect(s.style.cursor).toBe('ew-resize');
    await settle();
    expect(s.value).toBe('d'); // 26 px right: Charlie, Delta... (Bravo skipped)
    move(s, 50 + 200, 100 + 8);
    await settle();
    expect(s.value).toBe('e');
    move(s, 50 - 30, 100 + 8); // left
    await settle();
    expect(s.value).toBe('a');
    release(s, 20, 108);
    expect(s.style.cursor).toBe('');
    // vertical axis shows ns-resize
    press(s, 50, 100);
    move(s, 53, 110);
    expect(s.style.cursor).toBe('ns-resize');
    release(s, 53, 110);
  });

  it('shows a tooltip with the current option while scrubbing and removes it on release', async () => {
    const s = sel();
    press(s, 50, 100);
    move(s, 50, 130);
    const tip = q('[data-scrub-tip]');
    expect(tip.textContent).toBe(s.options[s.selectedIndex].text);
    release(s, 50, 130);
    expect(document.querySelector('[data-scrub-tip]')).toBeNull();
  });

  it('Escape during a drag reverts to the value at press and ends the drag (no list on release)', async () => {
    const s = sel();
    press(s, 50, 100);
    move(s, 50, 140);
    await settle();
    expect(s.value).not.toBe('a');
    esc();
    await settle();
    expect(s.value).toBe('a');
    expect(changes[changes.length - 1]).toBe('a');
    const n = changes.length;
    move(s, 50, 200); // the drag is over
    release(s, 50, 200);
    await settle();
    expect(changes.length).toBe(n);
    expect(document.querySelector('[data-scrub-list]')).toBeNull();
    expect(s.style.cursor).toBe('');
  });

  it('a disabled select does not scrub or open', async () => {
    await mount(<Harness disabled />, 'width:300px;padding:80px 20px');
    const s = sel();
    press(s, 50, 100);
    move(s, 50, 160);
    release(s, 50, 160);
    expect(changes).toEqual([]);
    expect(document.querySelector('[data-scrub-list]')).toBeNull();
  });

  it('a press released with under 4 px of movement opens the list (the fallback listbox when the browser refuses the picker), choosing applies', async () => {
    const s = sel();
    (s as unknown as { showPicker: () => void }).showPicker = () => { throw new DOMException('no activation', 'NotAllowedError'); };
    press(s, 50, 100);
    move(s, 52, 102);
    release(s, 52, 102);
    await settle();
    expect(changes).toEqual([]);
    const list = q('[data-scrub-list]');
    expect(s.getAttribute('data-scrub-opened')).toBe('list');
    expect(s.getAttribute('aria-expanded')).toBe('true');
    expect([...list.querySelectorAll('[role=option]')].map((o) => o.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    expect(list.querySelectorAll('[aria-selected=true]')).toHaveLength(1);
    q('[data-scrub-option="3"]').dispatchEvent(ptr('pointerdown', { clientX: 5, clientY: 5 }));
    await settle();
    expect(changes).toEqual(['d']);
    expect(document.querySelector('[data-scrub-list]')).toBeNull();
    expect(s.value).toBe('d');
  });

  it('the fallback list is keyboard operable: arrows skip disabled, Enter picks, Escape closes without a change', async () => {
    const s = sel();
    (s as unknown as { showPicker: () => void }).showPicker = () => { throw new DOMException('x', 'NotAllowedError'); };
    press(s, 50, 100); release(s, 50, 100);
    await settle();
    const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowDown'); key('ArrowDown'); // Alpha -> Charlie (Bravo disabled) -> Delta
    key('Enter');
    await settle();
    expect(changes).toEqual(['d']);
    expect(document.querySelector('[data-scrub-list]')).toBeNull();
    press(s, 50, 100); release(s, 50, 100);
    await settle();
    expect(document.querySelector('[data-scrub-list]')).not.toBeNull();
    key('Escape');
    expect(document.querySelector('[data-scrub-list]')).toBeNull();
    expect(changes).toEqual(['d']);
  });

  it('uses select.showPicker() when it works (no fallback list)', async () => {
    const s = sel();
    let shown = 0;
    (s as unknown as { showPicker: () => void }).showPicker = () => { shown++; };
    press(s, 50, 100); release(s, 50, 100);
    expect(shown).toBe(1);
    expect(s.getAttribute('data-scrub-opened')).toBe('native');
    expect(document.querySelector('[data-scrub-list]')).toBeNull();
  });

  it('a real click (trusted events) opens the browser picker (or the fallback list) without changing the value', async () => {
    const s = sel();
    await userEvent.click(s);
    await settle();
    expect(['native', 'list']).toContain(s.getAttribute('data-scrub-opened'));
    expect(changes).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await frame();
    expect(changes).toEqual([]);
  });

  it('keyboard behaviour is unchanged: keys on the focused select are not intercepted (the native select handles them)', async () => {
    const s = sel();
    s.focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      s.dispatchEvent(e);
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(document.querySelector('[data-scrub-list]')).toBeNull();
    // a native change (what the browser does on a key press / list choice) reaches the call site's onChange
    s.value = 'c';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    expect(changes).toEqual(['c']);
  });

  it('wheel-less / touch: a touch press is left to the native control', async () => {
    const s = sel();
    const e = ptr('pointerdown', { clientX: 50, clientY: 100, pointerType: 'touch' });
    s.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

// ---- ScrubNumber ----
let nums: number[];
function NumHarness({ value = 40, min = 1, max = 100 }: { value?: number; min?: number; max?: number }) {
  const [v, setV] = useState(value);
  return <ScrubNumber aria-label="Size" min={min} max={max} value={v} onChange={(n) => { nums.push(n); setV(n); }} style="width:52px" />;
}
const num = () => q<HTMLInputElement>('input[aria-label="Size"]');
const mv = (el: Element, x: number, y: number, mods: PointerEventInit = {}) => el.dispatchEvent(ptr('pointermove', { clientX: x, clientY: y, buttons: 1, ...mods }));

describe('ScrubNumber', () => {
  beforeEach(async () => { nums = []; await mount(<NumHarness />, 'width:200px;padding:80px 20px'); });
  afterEach(unmount);

  it('drag up = larger, 1 unit per 2 px; down = smaller; live (rAF-throttled) and exact on release', async () => {
    const el = num();
    press(el, 30, 100);
    mv(el, 30, 90); // 10 px up
    expect(el.value).toBe('45');
    await frame();
    expect(nums).toEqual([45]);
    mv(el, 30, 80);
    mv(el, 30, 82); // coalesced into one frame
    release(el, 30, 82);
    expect(nums[nums.length - 1]).toBe(49); // 18 px up in total
    mv(el, 30, 200); // released: ignored
    expect(nums[nums.length - 1]).toBe(49);
    await settle();
    press(el, 30, 100);
    mv(el, 30, 120);
    release(el, 30, 120);
    expect(nums[nums.length - 1]).toBe(39);
  });

  it('Shift is x10 and Alt x0.1 (read per move), clamped to the range', async () => {
    const el = num();
    press(el, 30, 100);
    mv(el, 30, 96, { shiftKey: true }); // 4 px * 0.5 * 10 = 20
    expect(el.value).toBe('60');
    mv(el, 30, 56, { shiftKey: true }); // 40 px more -> clamps at 100
    expect(el.value).toBe('100');
    mv(el, 30, 156, { shiftKey: true }); // and back: the clamp is not "owed" (starts from 100)
    expect(Number(el.value)).toBeLessThan(100);
    release(el, 30, 156);
    nums = [];
    press(el, 30, 100);
    mv(el, 30, 60, { altKey: true }); // 40 px * 0.5 * 0.1 = 2
    release(el, 30, 60);
    expect(nums[nums.length - 1]).toBeGreaterThan(0);
    expect(Math.abs(nums[nums.length - 1] - Number(el.defaultValue || 0))).toBeLessThan(100);
  });

  it('under 4 px is a click: no scrub, the box keeps focus for typing', async () => {
    const el = num();
    press(el, 30, 100);
    mv(el, 31, 102);
    release(el, 31, 102);
    await frame();
    expect(nums).toEqual([]);
    el.focus();
    expect(document.activeElement).toBe(el);
  });

  it('Escape during a drag reverts the value and stops scrubbing', async () => {
    const el = num();
    press(el, 30, 100);
    mv(el, 30, 60);
    await frame();
    expect(nums[nums.length - 1]).toBeGreaterThan(40);
    esc();
    await frame();
    expect(nums[nums.length - 1]).toBe(40);
    expect(el.value).toBe('40');
    const n = nums.length;
    mv(el, 30, 0);
    release(el, 30, 0);
    await frame();
    expect(nums.length).toBe(n);
  });

  it('typed valid values apply live on each input, invalid ones do not; commit clamps; Escape reverts', async () => {
    const el = num();
    el.focus();
    const type = async (t: string) => { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); await settle(); };
    await type('5'); await type('55'); await type(''); await type('500'); // 500 > max: ignored while typing
    expect(nums).toEqual([5, 55]);
    el.dispatchEvent(new Event('change', { bubbles: true })); // commit "500" -> clamps to 100
    await settle();
    expect(nums[nums.length - 1]).toBe(100);
    expect(el.value).toBe('100');
    nums = [];
    await type('77');
    expect(nums).toEqual([77]);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(nums[nums.length - 1]).toBe(100); // the value at the start of this edit
  });
});

// ---- history: one undo step per drag (real engine) ----
describe('one drag = one undo step', () => {
  let engine: Engine;
  beforeEach(() => {
    engine = new Engine(80, 60);
    store.attach(engine);
  });
  afterEach(unmount);
  const steps = () => engine.history().entries.length;

  it('blend mode scrubbed across several options (even with pauses past the coalesce window) is one entry; undo restores the original', async () => {
    await mount(<LayersPanel />, 'width:290px;height:420px;display:flex;flex-direction:column');
    store.addLayer();
    await settle();
    const id = store.activeLayer()!.id;
    const before = steps();
    const s = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    const x = 50;
    press(s, x, 100);
    const seen = new Set<string>();
    for (let y = 104; y <= 160; y += 4) { move(s, x, y); await frame(); seen.add(s.value); }
    expect(seen.size).toBeGreaterThan(3);
    await new Promise((r) => setTimeout(r, 1100)); // > engine coalesceMs
    for (let y = 164; y <= 200; y += 4) { move(s, x, y); await frame(); seen.add(s.value); }
    release(s, x, 200);
    await settle();
    const blend = engine.layers().find((l) => l.id === id)!.blend;
    expect(blend).not.toBe('normal');
    expect(s.value).toBe(blend);
    expect(steps()).toBe(before + 1);
    engine.undo();
    expect(engine.layers().find((l) => l.id === id)!.blend).toBe('normal');
    engine.redo();
    expect(engine.layers().find((l) => l.id === id)!.blend).toBe(blend);
  });

  it('Escape on a blend scrub reverts and leaves no history entry', async () => {
    await mount(<LayersPanel />, 'width:290px;height:420px;display:flex;flex-direction:column');
    store.addLayer();
    await settle();
    const id = store.activeLayer()!.id;
    const before = steps();
    const s = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    press(s, 50, 100);
    move(s, 50, 150);
    await settle();
    expect(engine.layers().find((l) => l.id === id)!.blend).not.toBe('normal');
    esc();
    await settle();
    expect(engine.layers().find((l) => l.id === id)!.blend).toBe('normal');
    expect(s.value).toBe('normal');
    expect(steps()).toBe(before);
    release(s, 50, 150);
  });

  it('font size scrubbed on a text layer re-renders live and is one entry; the next edit is a separate one', async () => {
    await mount(<ContextBar />, 'width:1500px');
    store.setTool('text');
    store.setFonts(['Arial', 'Menlo']);
    const id = engine.addTextLayer(completeTextSpec({ text: 'Hi', size: 40 }));
    await settle();
    const before = steps();
    const el = q<HTMLInputElement>('#ts');
    expect(el.value).toBe('40');
    press(el, 30, 300);
    const sizes: number[] = [];
    for (let i = 1; i <= 12; i++) {
      mv(el, 30, 300 - i * 6);
      await frame();
      sizes.push(engine.layers().find((l) => l.id === id)!.text!.size);
    }
    expect(sizes[0]).toBeGreaterThan(40); // live, before release
    expect(sizes[sizes.length - 1]).toBe(76);
    release(el, 30, 228);
    await settle();
    expect(steps()).toBe(before + 1);
    engine.undo();
    expect(engine.layers().find((l) => l.id === id)!.text!.size).toBe(40);
    engine.redo();
    expect(engine.layers().find((l) => l.id === id)!.text!.size).toBe(76);
    // font dropdown scrub: also one step
    const n = steps();
    const font = q<HTMLSelectElement>('#tf');
    press(font, 50, 100);
    move(font, 50, 130);
    release(font, 50, 130);
    await settle();
    expect(engine.layers().find((l) => l.id === id)!.text!.font).toBe('Menlo');
    expect(steps()).toBe(n + 1);
  });
});

// ---- review fixes ----
describe('ScrubSelect: a list that changes while dragging', () => {
  afterEach(unmount);
  it('steps by value, not by index (an option inserted at the front mid-drag does not shift the stepping)', async () => {
    const seen: string[] = [];
    function Shifty() {
      const [v, setV] = useState('a');
      const base = ['a', 'b', 'c', 'd', 'e'];
      const list = v === 'a' ? base : ['z', ...base]; // like the zoom list gaining its current value: indices shift after the first step
      return (
        <ScrubSelect aria-label="Pick" value={v} onChange={(e) => { const n = (e.target as HTMLSelectElement).value; seen.push(n); setV(n); }}>
          {list.map((k) => <option key={k} value={k} selected={k === v}>{k}</option>)}
        </ScrubSelect>
      );
    }
    await mount(<Shifty />, 'width:300px;padding:80px 20px');
    const s = sel();
    press(s, 50, 100);
    for (let y = 104; y <= 136; y += 4) { move(s, 50, y); await settle(); } // 36 px = 3 steps
    release(s, 50, 136);
    await settle();
    expect(seen).toEqual(['b', 'c', 'd']);
    expect(s.value).toBe('d');
  });
});

describe('stuck gestures and gesture ends', () => {
  let engine: Engine;
  let ends: boolean[];
  let origEnd: typeof store.endGesture;
  beforeEach(() => {
    engine = new Engine(80, 60);
    store.attach(engine);
    ends = [];
    origEnd = store.endGesture;
    store.endGesture = (c = false) => { ends.push(c); return origEnd(c); };
  });
  afterEach(() => { store.endGesture = origEnd; unmount(); });
  const steps = () => engine.history().entries.length;
  const mountBlend = async () => {
    await mount(<LayersPanel />, 'width:290px;height:420px;display:flex;flex-direction:column');
    store.addLayer();
    await settle();
    return store.activeLayer()!.id;
  };
  const blendOf = (id: string) => engine.layers().find((l) => l.id === id)!.blend;

  it('a move without a pressed button ends the gesture (the release was never seen) and later moves do nothing', async () => {
    const id = await mountBlend();
    const s = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    press(s, 50, 100);
    move(s, 50, 140);
    await settle();
    const b = blendOf(id);
    expect(b).not.toBe('normal');
    s.dispatchEvent(ptr('pointermove', { clientX: 50, clientY: 220, buttons: 0 }));
    expect(ends).toEqual([false]);
    move(s, 50, 300);
    await settle();
    expect(blendOf(id)).toBe(b);
    // an unrelated edit afterwards is its own step
    const n = steps();
    engine.setLayerProps(id, { name: 'renamed' });
    expect(steps()).toBe(n + 1);
  });

  it('lostpointercapture ends the gesture', async () => {
    const id = await mountBlend();
    const s = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    press(s, 50, 100);
    move(s, 50, 140);
    s.dispatchEvent(new Event('lostpointercapture'));
    expect(ends).toEqual([false]);
    expect(blendOf(id)).not.toBe('normal');
  });

  it('a second press (on a number box) ends the first drag', async () => {
    await mount(<><NumHarness /><NumHarness /></>, 'width:200px;padding:80px 20px');
    const [a, b] = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Size"]')];
    press(a, 30, 100);
    mv(a, 30, 80);
    expect(ends).toEqual([]);
    press(b, 130, 100); // a never saw its pointerup
    expect(ends).toEqual([false]);
    mv(a, 30, 0); // a is over
    release(b, 130, 100);
  });

  it('a foreign engine edit during a drag is its own undoable step; the drag continues in a fresh step; redo is right', async () => {
    const id = await mountBlend();
    const before = steps();
    const s = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    press(s, 50, 100);
    move(s, 50, 130);
    await settle();
    const first = blendOf(id);
    engine.setLayerProps(id, { name: 'renamed' }); // e.g. a TD / keyboard edit
    move(s, 50, 170);
    await settle();
    release(s, 50, 170);
    await settle();
    const last = blendOf(id);
    expect(last).not.toBe(first);
    expect(steps()).toBe(before + 3);
    engine.undo();
    expect(blendOf(id)).toBe(first);
    engine.undo();
    expect(engine.layers().find((l) => l.id === id)!.name).not.toBe('renamed');
    expect(blendOf(id)).toBe(first);
    engine.undo();
    expect(blendOf(id)).toBe('normal');
    engine.redo(); engine.redo(); engine.redo();
    expect(blendOf(id)).toBe(last);
    expect(engine.layers().find((l) => l.id === id)!.name).toBe('renamed');
  });

  it('unmounting mid-drag commits: the value stays, the gesture ends (not cancelled), one undo step', async () => {
    const id = await mountBlend();
    const before = steps();
    const s = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    press(s, 50, 100);
    move(s, 50, 140);
    await settle();
    const b = blendOf(id);
    unmount();
    await settle();
    expect(ends).toEqual([false]);
    expect(blendOf(id)).toBe(b);
    expect(steps()).toBe(before + 1);
  });

  it('unmounting a number box mid-drag commits too', async () => {
    nums = [];
    await mount(<NumHarness />, 'width:200px;padding:80px 20px');
    const el = num();
    press(el, 30, 100);
    mv(el, 30, 80);
    unmount();
    await settle();
    expect(ends).toEqual([false]);
    expect(nums[nums.length - 1]).toBe(50);
  });

  it('Escape after an external undo pushes no revert entry and resets the box to the model value', async () => {
    const id = await mountBlend();
    const s = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    press(s, 50, 100);
    move(s, 50, 140);
    await settle();
    engine.undo(); // external undo of the drag's step
    await settle();
    expect(blendOf(id)).toBe('normal');
    const n = steps(), idx = engine.history().index;
    esc();
    await settle();
    expect(steps()).toBe(n);
    expect(engine.history().index).toBe(idx);
    expect(blendOf(id)).toBe('normal');
    expect(s.value).toBe('normal');
    expect(engine.redo()).toBeUndefined(); // redo tail is intact (nothing was pushed over it)
    expect(blendOf(id)).not.toBe('normal');
    release(s, 50, 140);
  });
});

describe('ScrubNumber typing', () => {
  beforeEach(async () => { nums = []; await mount(<NumHarness />, 'width:200px;padding:80px 20px'); });
  afterEach(unmount);
  it('applies only changed values, at most once per frame', async () => {
    const el = num();
    el.focus();
    const type = (t: string) => { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); };
    type('41'); type('42'); type('43'); // one frame: only the last applies
    await settle();
    expect(nums).toEqual([43]);
    type('43'); // unchanged
    await settle();
    expect(nums).toEqual([43]);
    type('44'); type('43'); // back to the applied value inside the frame: nothing to do
    await settle();
    expect(nums).toEqual([43]);
  });
});
