import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DYNAMICS, PRESETS_KEY } from '../../src/state/brushes';
import { store } from '../../src/state/store';
import { BigDocNotice } from '../../src/ui/BigDocNotice';
import { BrushesPanel } from '../../src/ui/BrushesPanel';
import { ContextBar } from '../../src/ui/ContextBar';
import { FakeEngine } from './fakeEngine';
import { frame, freshEngine, mount, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const flush = async () => { await frame(); await settle(); };
const range = (el: HTMLInputElement, v: number) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };
const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string, ev = 'input') => { el.value = v; el.dispatchEvent(new Event(ev, { bubbles: true })); };
const rows = (src?: string) => [...document.querySelectorAll(src ? `[data-brush-source=${src}]` : '[data-brush]')].map((b) => b.getAttribute('data-brush'));
const names = (src: string) => [...document.querySelectorAll(`[data-brush-source=${src}] [data-brush-name]`)].map((n) => n.textContent);
const saveAs = async (name: string, where: 'user' | 'document' = 'user') => {
  type(q<HTMLInputElement>('[data-preset-name]'), name);
  const sel = q<HTMLSelectElement>('select[data-preset-where]');
  sel.value = where;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  q('[data-preset-save-btn]').click();
  await flush();
};

beforeEach(async () => {
  try { localStorage.removeItem(PRESETS_KEY); } catch { /* ignore */ }
  store.userPresets.value = [];
  store.customTip.value = null;
  engine = freshEngine();
  store.applyPreset('round');
  store.setTip('round');
  store.setDynamics(DEFAULT_DYNAMICS);
  store.tool.value = 'brush';
  await mount(<BrushesPanel />, 'width:290px');
});
afterEach(unmount);

describe('Brushes panel: presets', () => {
  it('lists the built-in presets (classic six first, then textured / scatter ones) and nothing else at first', () => {
    expect(rows('builtin')).toEqual(['round', 'hard', 'ink', 'chalk', 'gouache', 'airbrush', 'chalk-tip', 'bristle', 'spatter', 'grain', 'stars', 'confetti']);
    expect(document.querySelector('[data-preset-section=user]')).toBeNull();
    expect(document.querySelector('[data-preset-section=document]')).toBeNull();
    expect(q('[data-brush=round]').getAttribute('aria-pressed')).toBe('true');
  });

  it('choosing a textured built-in sets size, tip and dynamics, and the engine gets them', async () => {
    q('[data-brush=stars]').click();
    await flush();
    expect(store.brush.value).toMatchObject({ size: 40, hardness: 1 });
    expect(engine.tip).toBe('star');
    expect(engine.dynamics).toMatchObject({ scatterCount: 4, scatter: 1.5, angleJitter: 360, sizeJitter: 0.4, hueJitter: 0.1 });
    expect(q('[data-tip=star]').getAttribute('aria-pressed')).toBe('true');
    expect(q<HTMLInputElement>('input[data-dyn=scatterCount]').value).toBe('4');
    expect(q('[data-brush=stars]').getAttribute('aria-pressed')).toBe('true');
    q('[data-brush=ink]').click(); // a classic preset resets tip and dynamics
    await flush();
    expect(engine.tip).toBe('round');
    expect(engine.dynamics).toEqual(DEFAULT_DYNAMICS);
  });

  it('saves the current brush as a preset in this browser: row appears, localStorage has it', async () => {
    q('[data-brush=bristle]').click();
    await flush();
    await saveAs('My bristle');
    expect(names('user')).toEqual(['My bristle']);
    expect(q('[data-preset-section=user]').getAttribute('aria-label')).toBe('My presets (this browser)');
    const stored = JSON.parse(localStorage.getItem(PRESETS_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'My bristle', tip: 'bristle', settings: { size: 60 } });
    expect(rows('user')[0]).toMatch(/^user:/);
    expect(q(`[data-brush="${rows('user')[0]}"]`).getAttribute('aria-pressed')).toBe('true');
    expect(q<HTMLInputElement>('[data-preset-name]').value).toBe(''); // cleared for the next one
    expect(engine.calls.some((c) => c.startsWith('setBrushPresets'))).toBe(false);
  });

  it('a nameless Save uses a default name', async () => {
    q('[data-preset-save-btn]').click();
    await flush();
    expect(names('user')).toEqual(['Brush 1']);
  });

  it('saves into the document: engine.setBrushPresets, a Document presets section, nothing in localStorage', async () => {
    await saveAs('In the file', 'document');
    expect(engine.calls).toContain('setBrushPresets:1');
    expect(names('document')).toEqual(['In the file']);
    expect(rows('document')[0]).toMatch(/^doc:/);
    expect(localStorage.getItem(PRESETS_KEY)).toBeNull();
    expect(engine.brushPresets()[0]).toMatchObject({ name: 'In the file', tip: 'round' });
    // the document is replaced: the section follows the loaded document
    engine.loadDocument({ ...engine.docSpec(), brushPresets: [] });
    await flush();
    expect(document.querySelector('[data-preset-section=document]')).toBeNull();
  });

  it('rename (Enter saves, Escape cancels) and delete work for user presets only', async () => {
    await saveAs('First');
    const key = rows('user')[0]!;
    expect(document.querySelector('[data-brush-rename="round"]')).toBeNull(); // built-ins are fixed
    expect(document.querySelector('[data-brush-delete="round"]')).toBeNull();
    q(`[data-brush-rename="${key}"]`).click();
    await settle();
    const input = q<HTMLInputElement>('input[data-brush-rename-input]');
    type(input, 'Second');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(names('user')).toEqual(['Second']);
    expect(JSON.parse(localStorage.getItem(PRESETS_KEY)!)[0].name).toBe('Second');
    q(`[data-brush-rename="${key}"]`).click();
    await settle();
    const again = q<HTMLInputElement>('input[data-brush-rename-input]');
    type(again, 'Discarded');
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(names('user')).toEqual(['Second']);
    q(`[data-brush-delete="${key}"]`).click();
    await flush();
    expect(rows('user')).toEqual([]);
    expect(JSON.parse(localStorage.getItem(PRESETS_KEY)!)).toEqual([]);
    expect(store.brushPreset.value).toBe('round');
  });

  it('document presets can be renamed and deleted too (engine.setBrushPresets each time)', async () => {
    await saveAs('Doc one', 'document');
    const key = rows('document')[0]!;
    q(`[data-brush-rename="${key}"]`).click();
    await settle();
    const input = q<HTMLInputElement>('input[data-brush-rename-input]');
    type(input, 'Doc renamed');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(engine.brushPresets().map((p) => p.name)).toEqual(['Doc renamed']);
    q(`[data-brush-delete="${key}"]`).click();
    await flush();
    expect(engine.brushPresets()).toEqual([]);
    expect(document.querySelector('[data-preset-section=document]')).toBeNull();
  });

  it('export shows this viewer\'s presets as JSON; import merges pasted JSON and rejects junk', async () => {
    await saveAs('Exported');
    q('[data-preset-export]').click();
    await settle();
    const text = q<HTMLTextAreaElement>('textarea[data-preset-text]');
    const json = JSON.parse(text.value);
    expect(json).toMatchObject({ format: 'raster-editor-brush-presets', version: 1 });
    expect(json.presets.map((p: { name: string }) => p.name)).toEqual(['Exported']);
    q('[data-preset-import]').click();
    await settle();
    const area = q<HTMLTextAreaElement>('textarea[data-preset-text]');
    expect(area.value).toBe('');
    type(area, 'garbage');
    q('[data-preset-apply]').click();
    await flush();
    expect(q('[data-preset-msg]').textContent).toMatch(/not a brush preset file/);
    type(area, JSON.stringify(json));
    q('[data-preset-apply]').click();
    await flush();
    expect(q('[data-preset-msg]').textContent).toBe('Imported 1 preset');
    expect(names('user')).toEqual(['Exported', 'Exported']);
    expect(new Set(rows('user')).size).toBe(2);
  });

  it('imports a preset file chosen with the file input (external client)', async () => {
    await saveAs('Filed');
    const json = store.exportPresets('user');
    q('[data-preset-import]').click();
    await settle();
    const input = q<HTMLInputElement>('input[data-preset-file-input]');
    const dt = new DataTransfer();
    dt.items.add(new File([json], 'presets.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(names('user')).toEqual(['Filed', 'Filed']);
  });


  it('storage that throws neither breaks the panel nor loses the preset for this session', async () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
    try {
      await saveAs('Volatile');
      expect(names('user')).toEqual(['Volatile']);
      expect(store.notice.value).toMatch(/storage/i);
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});

describe('Brushes panel: tip picker', () => {
  it('offers the seven built-in tips and "From selection"', () => {
    expect([...document.querySelectorAll('[data-tip]')].map((b) => b.getAttribute('data-tip'))).toEqual(['round', 'chalk', 'bristle', 'spatter', 'noise', 'square', 'star', 'custom']);
    expect(q('[data-tip=round]').getAttribute('aria-pressed')).toBe('true');
  });

  it('each tip reaches the engine', async () => {
    for (const t of ['chalk', 'bristle', 'spatter', 'noise', 'square', 'star', 'round']) {
      q(`[data-tip=${t}]`).click();
      await flush();
      expect(engine.tip).toBe(t);
      expect(q(`[data-tip=${t}]`).getAttribute('aria-pressed')).toBe('true');
      expect(document.querySelectorAll('[data-tip][aria-pressed=true]').length).toBe(1);
    }
  });

  it('"From selection" takes the tip from the engine (size shown), and sends it with the tip', async () => {
    engine.selectionTip = { w: 5, h: 3, alpha: new Uint8Array(15).map((_, i) => i * 10) };
    q('[data-tip=custom]').click();
    await flush();
    expect(engine.tip).toBe('custom');
    expect(engine.customTip).toEqual({ w: 5, h: 3, alpha: new Uint8Array(15).map((_, i) => i * 10) });
    expect(q('[data-tip=custom]').textContent).toBe('From selection (5×3)');
    // another tip, then back to the remembered custom one without asking the engine again
    q('[data-tip=star]').click();
    await flush();
    engine.selectionTip = null;
    q('[data-tip=custom]').click();
    await flush();
    expect(engine.tip).toBe('custom');
  });

  it('"From selection" without a selection explains instead of changing the tip', async () => {
    engine.selectionTip = null;
    q('[data-tip=custom]').click();
    await flush();
    expect(engine.tip).toBe('round');
    expect(store.notice.value).toMatch(/selection/i);
  });

  it('a preset with a custom tip is saved as a PNG data URL and restored to the same coverage', async () => {
    const alpha = new Uint8Array(16).map((_, i) => (i * 17) & 255);
    engine.selectionTip = { w: 4, h: 4, alpha };
    q('[data-tip=custom]').click();
    await flush();
    await saveAs('Stamp', 'document');
    const saved = engine.brushPresets()[0];
    expect(saved.tip).toBe('custom');
    expect(saved.customTip).toMatchObject({ w: 4, h: 4 });
    expect(saved.customTip!.png.startsWith('data:image/png;base64,')).toBe(true);
    q('[data-brush=hard]').click();
    await flush();
    expect(engine.tip).toBe('round');
    q(`[data-brush="${rows('document')[0]}"]`).click();
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    expect(engine.tip).toBe('custom');
    expect(Array.from(engine.customTip!.alpha)).toEqual(Array.from(alpha));
    expect([engine.customTip!.w, engine.customTip!.h]).toEqual([4, 4]);
  });
});

describe('Brushes panel: dynamics', () => {
  const dyn = (k: string) => q<HTMLInputElement>(`input[data-dyn=${k}]`);

  it('has sliders for scatter, count, size / angle jitter, roundness, angle, hue / saturation / value jitter and a seed', () => {
    expect([...document.querySelectorAll('input[data-dyn]')].map((i) => i.getAttribute('data-dyn'))).toEqual(
      ['scatter', 'scatterCount', 'sizeJitter', 'angleJitter', 'angle', 'roundness', 'hueJitter', 'satJitter', 'valJitter', 'seed']);
    expect([Number(dyn('scatter').min), Number(dyn('scatter').max)]).toEqual([0, 4]);
    expect([Number(dyn('scatterCount').min), Number(dyn('scatterCount').max)]).toEqual([1, 16]);
    expect([Number(dyn('roundness').min), Number(dyn('roundness').max)]).toEqual([0.05, 1]);
    expect([Number(dyn('angleJitter').min), Number(dyn('angleJitter').max)]).toEqual([0, 360]);
  });

  it('every slider reaches engine.setBrushTip with the clamped value; values are shown with units', async () => {
    range(dyn('scatter'), 2.5);
    range(dyn('scatterCount'), 9);
    range(dyn('sizeJitter'), 0.4);
    range(dyn('angleJitter'), 120);
    range(dyn('angle'), 30);
    range(dyn('roundness'), 0.5);
    range(dyn('hueJitter'), 0.2);
    range(dyn('satJitter'), 0.3);
    range(dyn('valJitter'), 0.6);
    await flush();
    expect(engine.dynamics).toMatchObject({ scatter: 2.5, scatterCount: 9, sizeJitter: 0.4, angleJitter: 120, angle: 30, roundness: 0.5, hueJitter: 0.2, satJitter: 0.3, valJitter: 0.6 });
    expect(q('[data-dyn-value=sizeJitter]').textContent).toBe('40%');
    expect(q('[data-dyn-value=angleJitter]').textContent).toBe('120°');
    expect(q('[data-dyn-value=scatter]').textContent).toBe('2.50×');
    expect(q('[data-dyn-value=scatterCount]').textContent).toBe('9');
  });

  it('seed accepts integers (and has a random button); Reset restores the defaults', async () => {
    type(dyn('seed'), '4242', 'change');
    await flush();
    expect(engine.dynamics!.seed).toBe(4242);
    q('button[aria-label="Random seed"]').click();
    await flush();
    expect(engine.dynamics!.seed).not.toBe(4242);
    range(dyn('scatter'), 3);
    q('[data-dynamics-reset]').click();
    await flush();
    expect(engine.dynamics).toEqual(DEFAULT_DYNAMICS);
  });

  it('saved presets keep the dynamics', async () => {
    range(dyn('scatter'), 1.25);
    range(dyn('angleJitter'), 45);
    type(dyn('seed'), '77', 'change');
    await flush();
    await saveAs('Dyn');
    const saved = JSON.parse(localStorage.getItem(PRESETS_KEY)!)[0];
    expect(saved.dynamics).toMatchObject({ scatter: 1.25, angleJitter: 45, seed: 77 });
    q('[data-brush=round]').click();
    await flush();
    expect(engine.dynamics!.scatter).toBe(0);
    q(`[data-brush="${rows('user')[0]}"]`).click();
    await flush();
    expect(engine.dynamics).toMatchObject({ scatter: 1.25, angleJitter: 45, seed: 77 });
  });
});

describe('Brushes panel: layout', () => {
  it('scrolls inside its own box instead of growing without bound, and never overflows horizontally in 260 px', async () => {
    unmount();
    await mount(<BrushesPanel />, 'width:260px');
    for (let i = 0; i < 6; i++) await saveAs(`Preset ${i}`);
    q('[data-preset-export]').click();
    await settle();
    const p = q('[data-brushes-panel]');
    const box = p.getBoundingClientRect();
    expect(box.height).toBeLessThanOrEqual(window.innerHeight * 0.52 + 2);
    expect(p.scrollHeight).toBeGreaterThan(box.height);
    expect(p.scrollWidth).toBeLessThanOrEqual(Math.ceil(box.width) + 1);
    for (const el of p.querySelectorAll('[data-brush-row],[data-tip-picker] *,[data-dynamics] *')) {
      const r = el.getBoundingClientRect();
      if (r.width) expect(r.right, el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(box.right + 1);
    }
  });
});

describe('Context bar: current preset and tip', () => {
  beforeEach(async () => {
    unmount();
    await mount(<ContextBar />, 'width:1400px');
  });

  it('shows the chosen preset and the tip', async () => {
    expect(q('[data-brush-current]').textContent).toBe('Round — soft');
    expect(q('[data-brush-tip]').textContent).toBe('Tip: Round');
    store.applyPreset('spatter');
    await flush();
    expect(q('[data-brush-current]').textContent).toBe('Spatter');
    expect(q('[data-brush-tip]').textContent).toBe('Tip: Spatter');
    store.setTip('star');
    await flush();
    expect(q('[data-brush-tip]').textContent).toBe('Tip: Star');
  });

  it('follows user presets, "Custom" tips and the document presets; clicking opens the Brushes tab', async () => {
    store.saveCurrentPreset('Mine', 'user');
    await flush();
    expect(q('[data-brush-current]').textContent).toBe('Mine');
    engine.selectionTip = { w: 2, h: 2, alpha: new Uint8Array(4).fill(255) };
    store.useTipFromSelection();
    await flush();
    expect(q('[data-brush-tip]').textContent).toBe('Tip: From selection');
    store.colorTab.value = 'color';
    q('[data-brush-tip]').click();
    expect(store.colorTab.value).toBe('brushes');
    store.colorTab.value = 'color';
    q('[aria-label="Brush presets"]').click();
    expect(store.colorTab.value).toBe('brushes');
  });
});

describe('Big document notice', () => {
  const big = async () => {
    store.detach();
    store.attach(new FakeEngine(4000, 3000));
    store.resetBigDocNotice();
    store.setConnection('reconnecting');
    unmount();
    await mount(<BigDocNotice />, 'width:900px');
  };
  afterEach(() => { store.setConnection('reconnecting'); store.setViewMode('local'); store.resetBigDocNotice(); });

  it('is absent for small documents', async () => {
    unmount();
    await mount(<BigDocNotice />, 'width:900px');
    expect(document.querySelector('[data-bigdoc-notice]')).toBeNull();
  });

  it('appears above 8 MP with the size and a TD suggestion; nothing switches by itself', async () => {
    await big();
    const n = q('[data-bigdoc-notice]');
    expect(n.textContent).toContain('12.0 MP');
    expect(n.textContent).toContain('TouchDesigner view');
    expect(store.viewMode.value).toBe('local');
    store.setConnection('linked');
    await flush();
    expect(store.viewMode.value).toBe('local'); // linking does not switch either
    expect(document.querySelector('[data-bigdoc-notice]')).toBeTruthy();
  });

  it('without a TouchDesigner connection the button is disabled and does nothing', async () => {
    await big();
    expect(q('[data-bigdoc-td]').getAttribute('aria-disabled')).toBe('true');
    expect(q('[data-bigdoc-notice]').textContent).toContain('needs a TouchDesigner connection');
    q('[data-bigdoc-td]').click();
    await flush();
    expect(store.viewMode.value).toBe('local');
    expect(document.querySelector('[data-bigdoc-notice]')).toBeTruthy();
  });

  it('"Try TD view" switches (linked) and ends the notice for good on this viewer', async () => {
    await big();
    store.setConnection('linked');
    await flush();
    expect(q('[data-bigdoc-td]').getAttribute('aria-disabled')).toBe('false');
    q('[data-bigdoc-td]').click();
    await flush();
    expect(store.viewMode.value).toBe('td');
    expect(document.querySelector('[data-bigdoc-notice]')).toBeNull();
    expect(localStorage.getItem('raster-editor.bigDocNoticeDismissed')).toBe('1');
  });

  it('"Don\u2019t show again" dismisses it, remembered per viewer; the view stays Local', async () => {
    await big();
    q('[data-bigdoc-dismiss]').click();
    await flush();
    expect(document.querySelector('[data-bigdoc-notice]')).toBeNull();
    expect(localStorage.getItem('raster-editor.bigDocNoticeDismissed')).toBe('1');
    expect(store.viewMode.value).toBe('local');
    // the next page load (same storage): still dismissed
    store.detach();
    store.attach(new FakeEngine(4000, 3000));
    await flush();
    expect(document.querySelector('[data-bigdoc-notice]')).toBeNull();
  });

  it('hides while the TD view is shown and returns to the layout flow (no overlay)', async () => {
    await big();
    const r = q('[data-bigdoc-notice]').getBoundingClientRect();
    expect(r.height).toBeGreaterThan(0);
    expect(getComputedStyle(q('[data-bigdoc-notice]')).position).not.toBe('absolute');
    store.setConnection('linked');
    store.setViewMode('td');
    await flush();
    expect(document.querySelector('[data-bigdoc-notice]')).toBeNull();
  });
});
