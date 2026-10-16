import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Effect } from '../../src/engine/types';
import { CLASSIC_ORDER, EFFECT_ORDER, defaultEffect, isClassicType } from '../../src/state/effectDefaults';
import { filterGroups, filterFields, type NumField } from '../../src/state/filterSchema';
import { store } from '../../src/state/store';
import { Studio } from '../../src/ui/Studio';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { frame, freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
const setFx = () => engine.calls.filter((c) => c.startsWith('setEffects'));
const lastFx = (): Array<Record<string, any>> => JSON.parse(setFx()[setFx().length - 1].replace(/^setEffects:[^:]+:/, ''));
const tabsEl = () => q('[aria-label="Layer panels"]');
const range = (el: HTMLInputElement, v: number) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };
const select = (el: HTMLSelectElement, v: string) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
const flush = async () => { await frame(); await settle(); };
const addFilter = async (t: string) => {
  q('[data-fx-add]').click();
  await settle();
  q(`[data-add-filter="${t}"]`).click();
  await flush();
};

beforeEach(async () => {
  engine = freshEngine();
  store.layerTab.value = 'layers';
  store.addLayer();
  await mount(<Studio />, 'width:300px;height:900px;display:flex;flex-direction:column');
  q('[role=tab]:nth-child(3)', tabsEl()).click();
  await settle();
});
afterEach(unmount);

describe('Add effect menu: the filter library grouped', () => {
  it('lists the v5 effects unchanged, then five groups with every filter', async () => {
    q('[data-fx-add]').click();
    await settle();
    const offered = [...document.querySelectorAll('[data-add-effect]')].map((b) => b.getAttribute('data-add-effect')!);
    expect(offered.filter((t) => (EFFECT_ORDER as string[]).includes(t))).toEqual(EFFECT_ORDER);
    expect(offered.slice(0, 6)).toEqual(CLASSIC_ORDER);
    const groups = [...document.querySelectorAll('[data-filter-group]')];
    expect(groups.map((g) => g.querySelector('[data-filter-group-label]')!.textContent)).toEqual(['Blur & sharpen', 'Colour', 'Stylise', 'Distort', 'Static animated']);
    expect(groups.map((g) => g.querySelectorAll('[data-add-filter]').length)).toEqual([6, 9, 8, 7, 4]); // the classic adjustments are listed once, in their own group
    expect([...document.querySelectorAll('[data-add-filter]')].map((b) => b.getAttribute('data-add-filter')).sort()).toEqual(filterGroups().flatMap((g) => g.types).sort());
    expect(q('[data-add-filter=motionBlur]').textContent).toBe('Motion blur');
    expect(q('[data-add-filter=lut]').textContent).toBe('Colour LUT (.cube)');
    expect(q('[role=menu][aria-label="Add effect"]').scrollHeight).toBeGreaterThan(0);
  });

  it('every filter can be added; the effect has exactly the spec defaults and an editor for each parameter', async () => {
    for (const g of filterGroups()) {
      for (const t of g.types) {
        await addFilter(t);
        const list = lastFx();
        expect(list.at(-1), t).toEqual(defaultEffect(t));
      }
    }
    const names = [...document.querySelectorAll('[data-effect]')].map((r) => r.getAttribute('data-effect'));
    expect(names).toEqual(filterGroups().flatMap((g) => g.types));
    expect(CLASSIC_ORDER.every((t) => names.includes(t) && isClassicType(t))).toBe(true);
    // every one opened with its parameter panel
    expect(document.querySelectorAll('[data-fx-params]').length).toBe(names.length);
  });

  it('closes after a pick and the new filter row is open and named', async () => {
    await addFilter('unsharp');
    expect(document.querySelector('[role=menu][aria-label="Add effect"]')).toBeNull();
    expect(q('[data-fx-name]').textContent).toBe('Unsharp mask');
    expect(q('[data-fx-params]')).toBeTruthy();
  });
});

describe('number, enum, bool, seed and colour editors', () => {
  it('sliders carry the spec range and unit; edits keep the exact filter shape', async () => {
    await addFilter('unsharp');
    const f = filterFields('unsharp').filter((x): x is NumField => x.kind === 'num');
    expect(f.map((x) => [x.key, x.min, x.max])).toEqual([['amount', 0, 500], ['radius', 0, 200], ['threshold', 0, 255]]);
    for (const x of f) {
      const el = q<HTMLInputElement>(`input[aria-label="${x.label}"]`);
      expect([Number(el.min), Number(el.max)]).toEqual([x.min, x.max]);
    }
    range(q('input[aria-label="Radius"]'), 12);
    range(q('input[aria-label="Amount"]'), 250);
    await flush();
    expect(lastFx()).toEqual([{ ...defaultEffect('unsharp'), radius: 12, amount: 250 }]);
    expect(q('[data-fx-value=radius]').textContent).toBe('12 px');
    expect(q('[data-fx-value=amount]').textContent).toBe('250%');
  });

  it('values outside the range are clamped by the control', async () => {
    await addFilter('posterize');
    const el = q<HTMLInputElement>('input[aria-label="Levels"]');
    range(el, 9999);
    await flush();
    expect(lastFx()[0].levels).toBe(255);
    range(el, -5);
    await flush();
    expect(lastFx()[0].levels).toBe(2);
  });

  it('enum, bool and seed fields', async () => {
    await addFilter('crt');
    select(q<HTMLSelectElement>('select[aria-label="Mask"]'), 'slot');
    await flush();
    expect(lastFx()[0].mask).toBe('slot');
    await addFilter('dither');
    const colour = q<HTMLInputElement>('input[data-fx-bool=colour]');
    colour.checked = false;
    colour.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(lastFx()[1]).toMatchObject({ type: 'dither', colour: false });
    await addFilter('grain');
    const seed = q<HTMLInputElement>('input[data-fx-seed=seed]');
    seed.value = '123';
    seed.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(lastFx()[2]).toMatchObject({ type: 'grain', seed: 123 });
    seed.value = '-5';
    seed.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(lastFx()[2].seed).toBe(16777211); // integer mod 2^24
    q('button[aria-label="Randomize Seed"]').click();
    await flush();
    expect(lastFx()[2].seed).toBeGreaterThanOrEqual(0);
    expect(lastFx()[2].seed).toBeLessThan(16777216);
  });

  it('colour parameters merge colour and alpha edits', async () => {
    await addFilter('bloom');
    const col = q<HTMLInputElement>('input[data-fx-color=tint]');
    col.value = '#ff8000';
    col.dispatchEvent(new Event('input', { bubbles: true }));
    range(q('input[data-fx-alpha=tint]'), 100);
    await flush();
    expect(lastFx()[0].tint).toEqual({ r: 255, g: 128, b: 0, a: 100 });
  });

  it('reorder, disable and remove work for filters like for v5 effects', async () => {
    await addFilter('blur');
    await addFilter('posterize');
    q('[data-fx-down]', q('[data-effect-index="0"]')).click();
    await flush();
    expect(lastFx().map((e) => e.type)).toEqual(['posterize', 'blur']);
    q('[data-fx-enable]', q('[data-effect-index="1"]')).click();
    await flush();
    expect(lastFx()[1]).toMatchObject({ type: 'blur', enabled: false });
    q('[data-fx-remove]', q('[data-effect-index="0"]')).click();
    await flush();
    expect(lastFx().map((e) => e.type)).toEqual(['blur']);
  });
});

describe('blur editor: sigma and edge', () => {
  it('shows Radius while sigma is 0, Sigma (0..200 px) instead of Radius when sigma > 0, and the Edge choice', async () => {
    await addFilter('blur');
    expect(document.querySelector('input[aria-label="Radius"]')).toBeTruthy();
    expect(q<HTMLInputElement>('input[aria-label="Sigma"]').max).toBe('200');
    expect([...q<HTMLSelectElement>('select[aria-label="Edge"]').options].map((o) => o.value)).toEqual(['transparent', 'hold']);
    engine.setEffects('L1', [{ ...defaultEffect('blur'), sigma: 6 } as never]); // a migrated legacy blur
    await flush();
    expect(document.querySelector('input[aria-label="Radius"]')).toBeNull(); // sigma overrides the radius: the slider would do nothing
    expect(q<HTMLInputElement>('input[aria-label="Sigma"]').value).toBe('6');
    select(q<HTMLSelectElement>('select[aria-label="Edge"]'), 'hold');
    await flush();
    expect(lastFx()[0]).toMatchObject({ type: 'blur', sigma: 6, edge: 'hold' });
  });
});

describe('curves editor', () => {
  const svgEl = () => q<SVGSVGElement>('[data-curve-editor]');
  const at = (fx: number, fy: number): { clientX: number; clientY: number } => {
    const r = svgEl().getBoundingClientRect();
    return { clientX: r.left + fx * r.width, clientY: r.top + (1 - fy) * r.height };
  };
  const pts = () => [...document.querySelectorAll('[data-curve-point]')].map((p) => [Number(p.getAttribute('data-x')), Number(p.getAttribute('data-y'))]);

  beforeEach(async () => { await addFilter('curves'); });

  it('starts as identity with four channel tabs', () => {
    expect(pts()).toEqual([[0, 0], [1, 1]]);
    expect([...document.querySelectorAll('[data-curve-channel]')].map((b) => b.getAttribute('data-curve-channel'))).toEqual(['master', 'red', 'green', 'blue']);
    expect(q('[data-curve-channel=master]').getAttribute('aria-pressed')).toBe('true');
    expect(lastFx()[0]).toEqual({ type: 'curves', enabled: true, master: [[0, 0], [1, 1]], red: [[0, 0], [1, 1]], green: [[0, 0], [1, 1]], blue: [[0, 0], [1, 1]] });
  });

  it('clicking the plot adds a point, dragging it moves it; the filter gets sorted [x, y] pairs', async () => {
    svgEl().dispatchEvent(ptr('pointerdown', { ...at(0.25, 0.1), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointermove', { ...at(0.3, 0.2), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointermove', { ...at(0.4, 0.3), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointerup', { ...at(0.4, 0.3) }));
    await flush();
    const m = lastFx()[0].master as number[][];
    expect(m.length).toBe(3);
    expect(m[0]).toEqual([0, 0]);
    expect(m[2]).toEqual([1, 1]);
    expect(m[1][0]).toBeCloseTo(0.4, 1);
    expect(m[1][1]).toBeCloseTo(0.3, 1);
    expect(q('[data-curve-count]').textContent).toBe('3 points');
    expect(lastFx()[0].red).toEqual([[0, 0], [1, 1]]); // other channels untouched
  });

  it('dragging an existing point keeps the order (it cannot pass its neighbours) and stays inside 0..1', async () => {
    svgEl().dispatchEvent(ptr('pointerdown', { ...at(0.3, 0.3), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointerup', { ...at(0.3, 0.3) }));
    await flush();
    svgEl().dispatchEvent(ptr('pointerdown', { ...at(0.7, 0.7), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointerup', { ...at(0.7, 0.7) }));
    await flush();
    expect(pts().length).toBe(4);
    const second = q('[data-curve-point="1"]');
    second.dispatchEvent(ptr('pointerdown', { ...at(0.3, 0.3), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointermove', { ...at(0.95, 2), buttons: 1 })); // far past the third point and above the plot
    svgEl().dispatchEvent(ptr('pointerup', { ...at(0.95, 2) }));
    await flush();
    const m = lastFx()[0].master as number[][];
    expect(m.map((p) => p[0])).toEqual([...m.map((p) => p[0])].sort((a, b) => a - b));
    expect(m[1][0]).toBeLessThan(m[2][0]);
    expect(m[1][1]).toBe(1);
  });

  it('double-click removes a point, the end points stay (never fewer than two)', async () => {
    svgEl().dispatchEvent(ptr('pointerdown', { ...at(0.5, 0.8), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointerup', { ...at(0.5, 0.8) }));
    await flush();
    expect(pts().length).toBe(3);
    q('[data-curve-point="1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(pts()).toEqual([[0, 0], [1, 1]]);
    q('[data-curve-point="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(pts().length).toBe(2);
  });

  it('keyboard: arrows nudge the focused point, Delete removes it', async () => {
    svgEl().dispatchEvent(ptr('pointerdown', { ...at(0.5, 0.5), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointerup', { ...at(0.5, 0.5) }));
    await flush();
    const p = q('[data-curve-point="1"]');
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await flush();
    expect((lastFx()[0].master as number[][])[1][1]).toBeCloseTo(0.51, 1);
    q('[data-curve-point="1"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await flush();
    expect(pts().length).toBe(2);
  });

  it('each channel has its own curve; Reset restores identity for the shown channel only', async () => {
    q('[data-curve-channel=red]').click();
    await settle();
    expect(q('[data-curve-channel=red]').getAttribute('aria-pressed')).toBe('true');
    svgEl().dispatchEvent(ptr('pointerdown', { ...at(0.5, 0.9), buttons: 1 }));
    svgEl().dispatchEvent(ptr('pointerup', { ...at(0.5, 0.9) }));
    await flush();
    const fx = lastFx()[0];
    expect((fx.red as number[][]).length).toBe(3);
    expect(fx.master).toEqual([[0, 0], [1, 1]]);
    expect(fx.green).toEqual([[0, 0], [1, 1]]);
    q('[data-curve-reset]').click();
    await flush();
    expect(lastFx()[0].red).toEqual([[0, 0], [1, 1]]);
  });

  it('shows a document curve given as {x,y} objects and draws a path', async () => {
    engine.setEffects('L1', [{ ...defaultEffect('curves'), master: [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }] } as unknown as Effect]);
    await flush();
    expect(pts()).toEqual([[0, 1], [0.5, 0.5], [1, 0]]);
    expect(q('[data-curve-line]').getAttribute('d')!.startsWith('M0.0 0.0')).toBe(true);
  });
});

describe('gradient map stop editor', () => {
  const bar = () => q('[data-gradient-bar]');
  const onBar = (f: number) => { const r = bar().getBoundingClientRect(); return { clientX: r.left + f * r.width, clientY: r.top + 6 }; };
  const stops = () => lastFx()[0].stops as Array<{ pos: number; color: { r: number; g: number; b: number; a: number } }>;

  beforeEach(async () => { await addFilter('gradientMap'); });

  it('starts black to white, two stops', () => {
    expect(document.querySelectorAll('[data-stop]').length).toBe(2);
    expect(q('[data-stop-count]').textContent).toBe('2 stops');
    expect(lastFx()[0].stops).toEqual([{ pos: 0, color: { r: 0, g: 0, b: 0, a: 255 } }, { pos: 1, color: { r: 255, g: 255, b: 255, a: 255 } }]);
    expect(q('[data-gradient-bar] div').style.background).toContain('linear-gradient');
  });

  it('clicking the bar adds a stop with the gradient colour there; it is selected', async () => {
    bar().dispatchEvent(ptr('pointerdown', { ...onBar(0.5), buttons: 1 }));
    bar().dispatchEvent(ptr('pointerup', onBar(0.5)));
    await flush();
    expect(stops().length).toBe(3);
    expect(stops()[1].pos).toBeCloseTo(0.5, 1);
    expect(stops()[1].color.r).toBeGreaterThan(100);
    expect(stops()[1].color.r).toBeLessThan(155);
    expect(q('[data-stop="1"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('dragging a stop moves it between its neighbours; colour and position inputs edit the selected stop', async () => {
    bar().dispatchEvent(ptr('pointerdown', { ...onBar(0.5), buttons: 1 }));
    bar().dispatchEvent(ptr('pointermove', { ...onBar(0.6), buttons: 1 }));
    bar().dispatchEvent(ptr('pointermove', { ...onBar(5), buttons: 1 })); // way past the end: clamped by the next stop
    bar().dispatchEvent(ptr('pointerup', onBar(0.6)));
    await flush();
    expect(stops()[1].pos).toBe(1);
    expect(stops().map((s) => s.pos)).toEqual([0, 1, 1]);
    const col = q<HTMLInputElement>('input[data-stop-color]');
    col.value = '#ff0000';
    col.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(stops()[1].color).toMatchObject({ r: 255, g: 0, b: 0 });
    const pos = q<HTMLInputElement>('input[data-stop-pos]');
    pos.value = '25';
    pos.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(stops().map((s) => s.pos)).toEqual([0, 0.25, 1]);
    expect(stops()[1].color).toMatchObject({ r: 255 });
  });

  it('remove keeps at least one stop; amount and reverse are normal fields', async () => {
    bar().dispatchEvent(ptr('pointerdown', { ...onBar(0.5), buttons: 1 }));
    bar().dispatchEvent(ptr('pointerup', onBar(0.5)));
    await flush();
    q('[data-stop-remove]').click();
    await flush();
    expect(stops().length).toBe(2);
    q('[data-stop-remove]').click();
    await flush();
    expect(stops().length).toBe(1);
    q('[data-stop-remove]').click();
    await flush();
    expect(stops().length).toBe(1);
    range(q('input[aria-label="Amount"]'), 40);
    const rev = q<HTMLInputElement>('input[data-fx-bool=reverse]');
    rev.checked = true;
    rev.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(lastFx()[0]).toMatchObject({ amount: 40, reverse: true });
  });
});

describe('selective colour', () => {
  it('range picker and ink sliders write the 36-number table in -1..1', async () => {
    await addFilter('selectiveColor');
    select(q<HTMLSelectElement>('select[aria-label="Colour range"]'), '4'); // Blues
    await settle();
    range(q('input[aria-label="Cyan"]'), -50);
    await flush();
    range(q('input[aria-label="Black"]'), 100);
    await flush();
    const a = lastFx()[0].adjust as number[];
    expect(a.length).toBe(36);
    expect(a[16]).toBe(-0.5);
    expect(a[19]).toBe(1);
    expect(a.filter((v) => v !== 0).length).toBe(2);
    select(q<HTMLSelectElement>('select[aria-label="Colour range"]'), '0');
    await settle();
    expect(q<HTMLInputElement>('input[aria-label="Cyan"]').value).toBe('0');
  });
});

describe('.cube LUT loader', () => {
  const cube = (n = 2) => `TITLE "Warm"\nLUT_3D_SIZE ${n}\n${Array.from({ length: n ** 3 }, (_, i) => `${(i % 2) * 0.9} ${(i % 3) * 0.4} 0.2`).join('\n')}\n`;
  beforeEach(async () => { await addFilter('lut'); });

  it('starts empty; pasting a valid cube sets it and shows its size', async () => {
    expect(q('[data-lut-status]').textContent).toContain('No LUT loaded');
    q('[data-lut-paste]').click();
    await settle();
    const ta = q<HTMLTextAreaElement>('textarea[data-lut-text]');
    ta.value = cube(2);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('[data-lut-apply]').click();
    await flush();
    expect(lastFx()[0].cube).toBe(cube(2));
    expect(q('[data-lut-status]').textContent).toBe('Warm · 2×2×2');
    expect(document.querySelector('textarea[data-lut-text]')).toBeNull();
  });

  it('an unusable cube is refused with a reason and the effect is unchanged', async () => {
    q('[data-lut-paste]').click();
    await settle();
    const ta = q<HTMLTextAreaElement>('textarea[data-lut-text]');
    ta.value = 'LUT_3D_SIZE 4\n0 0 0\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('[data-lut-apply]').click();
    await flush();
    expect(q('[data-lut-error]').textContent).toMatch(/expected 64 rows/);
    expect(setFx().filter((c) => c.includes('LUT_3D_SIZE')).length).toBe(0);
  });

  it('loads a .cube file from the file input (external client) and Clear removes it', async () => {
    const input = q<HTMLInputElement>('input[data-lut-input]');
    const dt = new DataTransfer();
    dt.items.add(new File([cube(3)], 'grade.cube'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(lastFx()[0].cube).toBe(cube(3));
    expect(q('[data-lut-status]').textContent).toBe('Warm · 3×3×3');
    expect(store.notice.value).toContain('grade.cube');
    q('[data-lut-clear]').click();
    await flush();
    expect(lastFx()[0].cube).toBe('');
  });

});

describe('LUT limits and panel loading', () => {
  beforeEach(async () => { await addFilter('lut'); });

  it('a file over 12 MB is refused before it is read', async () => {
    const input = q<HTMLInputElement>('input[data-lut-input]');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(12_000_001)], 'huge.cube'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(q('[data-lut-error]').textContent).toMatch(/12 MB/);
    expect(setFx().filter((c) => c.includes('huge')).length).toBe(0);
  });

  it('pasted text over 12 000 000 characters is refused', async () => {
    q('[data-lut-paste]').click();
    await settle();
    const ta = q<HTMLTextAreaElement>('textarea[data-lut-text]');
    ta.value = 'x'.repeat(12_000_001);
    q('[data-lut-apply]').click();
    await flush();
    expect(q('[data-lut-error]').textContent).toMatch(/12 MB/);
  });

  it('a LUT over 1 MB shows a size warning', async () => {
    const n = 17, row = '0.123456 0.654321 0.5\n';
    const big = `LUT_3D_SIZE ${n}\n` + row.repeat(n ** 3) + '#'.repeat(1_000_000) + '\n';
    engine.setEffects('L1', [{ ...defaultEffect('lut'), cube: big } as unknown as Effect]);
    await flush();
    expect(q('[data-lut-warn]').textContent).toMatch(/Large LUT/);
  });

});

describe('curve drawing matches the filter (PCHIP table)', () => {
  it('the drawn path is the engine\'s own curve table for a steep and a flat section', async () => {
    const { curveEvalTable } = await import('../../src/engine/effects/filters');
    const pts = [[0, 0], [0.2, 0.9], [0.5, 0.92], [1, 1]];
    engine.setEffects('L1', [{ ...defaultEffect('curves'), master: pts } as unknown as Effect]);
    await flush();
    q('[data-fx-open]').click();
    await flush();
    const d = q('[data-curve-line]').getAttribute('d')!;
    const ys = d.split(/[ML]/).filter(Boolean).map((seg) => Number(seg.split(' ')[1]));
    const table = curveEvalTable(pts as [number, number][]);
    expect(ys.length).toBe(256);
    for (let i = 0; i < 256; i += 17) expect(180 * (1 - table[i])).toBeCloseTo(ys[i], 0);
  });
});

describe('displace source picker', () => {
  beforeEach(async () => {
    store.setInputs([{ input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 64, h: 48, connected: true }, { input: 3, w: 0, h: 0, connected: false }]);
    store.addLayer(); // L2 above L1
    engine.setActiveLayer('L1');
    await settle();
    await addFilter('displace');
  });
  const sel = () => q<HTMLSelectElement>('select[data-fx-aux]');

  it('offers noise, the other layers and the connected TD inputs (not itself)', () => {
    const opts = [...sel().querySelectorAll('option')].map((o) => [o.value, o.textContent]);
    expect(opts[0]).toEqual(['noise', 'Noise']);
    const values = opts.map((o) => o[0]);
    expect(values).toContain('layer:L2');
    expect(values).not.toContain('layer:L1');
    expect(values).toContain('input:1');
    expect(values).toContain('input:2');
    expect(values).not.toContain('input:3');
    expect(sel().value).toBe('noise');
    expect(lastFx()[0]).toMatchObject({ source: 'noise' });
    expect('auxSource' in lastFx()[0]).toBe(false);
  });

  it('choosing another layer sets source aux + auxLayerId; a TD input sets auxInput; Noise removes both', async () => {
    select(sel(), 'layer:L2');
    await flush();
    expect(lastFx()[0]).toMatchObject({ source: 'aux', auxSource: 'layer:L2' });
    select(sel(), 'input:2');
    await flush();
    expect(lastFx()[0]).toMatchObject({ source: 'aux', auxSource: 'input:2' });
    expect(sel().value).toBe('input:2');
    select(sel(), 'noise');
    await flush();
    expect(lastFx()[0].source).toBe('noise');
    expect('auxSource' in lastFx()[0]).toBe(false);
  });

  it('offers only pixel, input, text and shape layers (no groups or adjustments), never itself', async () => {
    store.addGroup();
    store.addAdjustment('invert');
    engine.addTextLayer({ text: 'T', font: 'Arial', size: 10, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 0, y: 0, boxWidth: null });
    engine.setActiveLayer('L1');
    store.layerTab.value = 'fx';
    await flush();
    const values = [...sel().querySelectorAll('option')].map((o) => o.value);
    const kinds = new Map(engine.layers().map((l) => [`layer:${l.id}`, l.kind]));
    for (const v of values.filter((x) => x.startsWith('layer:'))) expect(['pixel', 'input', 'text', 'shape']).toContain(kinds.get(v));
    expect(values.some((v) => kinds.get(v) === 'group' || kinds.get(v) === 'adjustment')).toBe(false);
    expect(values).not.toContain('layer:L1');
  });

  it('a source that disappeared (layer deleted) stays visible as "missing" instead of silently changing', async () => {
    select(sel(), 'layer:L2');
    await flush();
    engine.deleteLayer('L2');
    await flush();
    expect(sel().value).toBe('layer:L2');
    expect(sel().selectedOptions[0].textContent).toBe('Layer (missing)');
  });
});

describe('effects on groups and adjustment layers', () => {
  it('a group can take filters like any layer', async () => {
    store.addGroup();
    await settle();
    expect(document.querySelector('[data-effects-hint]')).toBeNull();
    await addFilter('blur');
    expect(setFx().at(-1)!).toContain(`setEffects:${engine.activeLayerId()}:`);
    expect(lastFx()[0]).toMatchObject({ type: 'blur' });
  });
});

describe('Layer ▸ New Adjustment and the unified catalogue', () => {
  beforeEach(async () => {
    unmount();
    await mount(<><TopBar /><Studio /></>, 'width:900px;height:900px;display:flex;flex-direction:column');
    q('[role=tab]:nth-child(3)', tabsEl()).click();
    await settle();
  });
  const openLayerMenu = async () => {
    const btn = [...document.querySelectorAll<HTMLElement>('button.menu')].find((b) => b.textContent === 'Layer')!;
    btn.click();
    await settle();
    q('[data-flyout=adjustments]').click();
    await settle();
  };

  it('the Layer menu has a flyout with the same catalogue as Add effect', async () => {
    await openLayerMenu();
    const fly = q('[role=menu][aria-label="New Adjustment"]');
    expect([...fly.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Adjustments', 'Layer styles', 'Blur & sharpen', 'Colour', 'Stylise', 'Distort', 'Static animated']);
    const types = [...fly.querySelectorAll('[data-new-adjustment]')].map((b) => b.getAttribute('data-new-adjustment')!);
    expect(types.slice(0, 6)).toEqual(CLASSIC_ORDER);
    expect(new Set(types).size).toBe(types.length);
    expect(types.length).toBe(6 + EFFECT_ORDER.length + 35 - 1 + 0); // 35 filters incl. blur: the four classic filters are in the first group
  });

  it('picking an entry adds an adjustment layer whose FX stack is that effect with defaults, named after it, and opens the Effects tab', async () => {
    await openLayerMenu();
    q('[data-new-adjustment=twirl]').click();
    await flush();
    expect(engine.calls).toContain('addAdjustmentLayer:twirl');
    const l = engine.layers().find((x) => x.id === engine.activeLayerId())!;
    expect(l.kind).toBe('adjustment');
    expect(l.name).toBe('Twirl');
    expect(l.adjustment).toBeNull();
    expect(l.effects).toEqual([defaultEffect('twirl')]);
    expect(document.querySelector('[role=menu][aria-label="New Adjustment"]')).toBeNull();
    expect(q('[data-effects-panel]').getAttribute('data-layer-id')).toBe(l.id);
    expect(q('[data-effect=twirl]')).toBeTruthy();
  });

  it('a classic adjustment (Levels) comes from the same catalogue', async () => {
    await openLayerMenu();
    q('[data-new-adjustment=levels]').click();
    await flush();
    const l = engine.layers().find((x) => x.id === engine.activeLayerId())!;
    expect(l).toMatchObject({ kind: 'adjustment', name: 'Levels' });
    expect(l.effects).toEqual([{ type: 'levels', enabled: true, inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 }]);
  });

  it('editing the stack writes setEffects once per frame', async () => {
    store.addAdjustment('motionBlur');
    await flush();
    q('[data-fx-open]').click();
    await settle();
    const n = setFx().length;
    const len = q<HTMLInputElement>('[data-fx-params] input[aria-label="Length"]');
    for (const v of [10, 20, 30]) range(len, v);
    range(q<HTMLInputElement>('[data-fx-params] input[aria-label="Angle"]'), 45);
    await flush();
    expect(setFx().length - n).toBe(1);
    expect(lastFx()).toEqual([{ ...defaultEffect('motionBlur'), length: 30, angle: 45 }]);
  });

  it('special editors work inside an adjustment too (curves)', async () => {
    store.addAdjustment('curves');
    await flush();
    q('[data-fx-open]').click();
    await settle();
    const svg = q<SVGSVGElement>('[data-curve-editor]');
    const r = svg.getBoundingClientRect();
    svg.dispatchEvent(ptr('pointerdown', { clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.2, buttons: 1 }));
    svg.dispatchEvent(ptr('pointerup', { clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.2 }));
    await flush();
    expect(lastFx()[0].master.length).toBe(3);
  });

  it('the layers panel footer menu offers the same catalogue', async () => {
    q('[role=tab]:nth-child(1)', tabsEl()).click();
    await settle();
    q('[aria-label="New adjustment"]').click();
    await settle();
    const types = [...document.querySelectorAll('[role=menu][aria-label="New adjustment"] [data-new-adjustment]')].map((b) => b.getAttribute('data-new-adjustment')!);
    expect(types.slice(0, 6)).toEqual(CLASSIC_ORDER);
    expect(types).toContain('posterize');
    q('[data-new-adjustment=posterize]').click();
    await flush();
    expect(engine.layers().find((l) => l.id === engine.activeLayerId())!.effects).toMatchObject([{ type: 'posterize' }]);
    expect(document.querySelectorAll('[data-new-adjustment]').length).toBe(0); // menu closed
  });
});

describe('New Adjustment without a document', () => {
  it('the Layer menu entry is disabled when no engine is attached', async () => {
    unmount();
    await mount(<TopBar />, 'width:900px');
    store.detach();
    const btn = [...document.querySelectorAll<HTMLElement>('button.menu')].find((b) => b.textContent === 'Layer')!;
    btn.click();
    await settle();
    const item = q('[data-flyout=adjustments]');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    item.click();
    await settle();
    expect(document.querySelector('[data-new-adjustment]')).toBeNull();
    store.attach(engine);
  });
});

describe('TD render badge', () => {
  beforeEach(() => { q('[role=tab]:nth-child(1)', tabsEl()).click(); });

  it('layers whose filters need TD\'s render show a "TD render" badge, "pending" until the image arrives', async () => {
    engine.previewTypes.add('kuwahara');
    await settle();
    expect(document.querySelector('[data-td-render]')).toBeNull();
    engine.setEffects('L1', [defaultEffect('kuwahara'), defaultEffect('blur')]);
    await flush();
    const b = q('[data-layer="L1"] [data-td-render]');
    expect(b.textContent).toBe('TD render · pending');
    expect(b.hasAttribute('data-pending')).toBe(true);
    expect(document.querySelector('[data-layer="base"] [data-td-render]')).toBeNull();
    store.setLayerPreview('L1', 'ready');
    await flush();
    expect(q('[data-layer="L1"] [data-td-render]').textContent).toBe('TD render');
    expect(q('[data-layer="L1"] [data-td-render]').hasAttribute('data-pending')).toBe(false);
    store.clearLayerPreviews();
    await flush();
    expect(q('[data-layer="L1"] [data-td-render]').textContent).toBe('TD render · pending');
    engine.setEffects('L1', [defaultEffect('blur')]);
    await flush();
    expect(document.querySelector('[data-td-render]')).toBeNull();
  });

  it('filter adjustment layers get the badge as well; the engine\'s own previewPending wins when present', async () => {
    engine.previewTypes.add('kuwahara');
    const id = store.addFilterAdjustment('kuwahara');
    q('[role=tab]:nth-child(1)', tabsEl()).click();
    await flush();
    expect(q(`[data-layer="${id}"] [data-td-render]`).textContent).toBe('TD render · pending');
    const orig = engine.layers.bind(engine);
    engine.layers = () => orig().map((l) => (l.id === id ? { ...l, previewPending: false } : l));
    store.setLayerPreview(id, 'pending');
    await flush();
    expect(q(`[data-layer="${id}"] [data-td-render]`).textContent).toBe('TD render');
  });
});
