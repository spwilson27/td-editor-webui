import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeShapeSpec } from '../../src/state/specs';
import { store } from '../../src/state/store';
import { ContextBar } from '../../src/ui/ContextBar';
import { ToolRail } from '../../src/ui/ToolRail';
import { Viewport } from '../../src/ui/Viewport';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, ptr, q, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
beforeEach(() => {
  engine = freshEngine(200, 100);
  store.shapeOpts.value = { type: 'rect', fillOn: true, strokeOn: false, strokeWidth: 4, radius: 0, sides: 5, innerRatio: 1, arrowStart: false, arrowEnd: true };
  store.setPrimaryHex('#e2683c', false);
  store.secondary.value = '#ffffff';
  store.setTool('shape');
});
afterEach(unmount);

const slide = async (id: string, value: number) => {
  const el = q<HTMLInputElement>('#' + id);
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};
const shapeCalls = () => engine.calls.filter((c) => c.startsWith('addShape:')).map((c) => JSON.parse(c.slice(9)));

describe('shape flyout in the tool rail', () => {
  beforeEach(async () => { await mount(<ToolRail />, 'width:52px;height:800px'); });

  it('the corner mark opens a flyout with the four shape types; choosing one selects the tool and changes the icon', async () => {
    const before = q('[data-tool=shape] svg path').getAttribute('d');
    expect(document.querySelector('[data-shape-flyout]')).toBeNull();
    q('[data-flyout-toggle]').click();
    await settle();
    const items = [...document.querySelectorAll<HTMLElement>('[data-shape-flyout] [role=menuitemradio]')];
    expect(items.map((i) => i.textContent!.replace('✓', '').trim())).toEqual(['Rectangle', 'Ellipse', 'Line / Arrow', 'Polygon / Star']);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    store.setTool('brush');
    q('[data-shape=polygon]').click();
    await settle();
    expect(store.tool.value).toBe('shape');
    expect(store.shapeOpts.value.type).toBe('polygon');
    expect(engine.shapeTool).toBe('polygon');
    expect(document.querySelector('[data-shape-flyout]')).toBeNull();
    expect(q('[data-tool=shape] svg path').getAttribute('d')).not.toBe(before);
  });

  it('closes on Escape and on an outside press; right-click also opens it', async () => {
    q('[data-tool=shape]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle();
    expect(document.querySelector('[data-shape-flyout]')).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(document.querySelector('[data-shape-flyout]')).toBeNull();
    q('[data-flyout-toggle]').click();
    await settle();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(document.querySelector('[data-shape-flyout]')).toBeNull();
  });
});

describe('shape context bar', () => {
  beforeEach(async () => { await mount(<ContextBar />, 'width:1500px'); await settle(); });

  it('shows the controls of the chosen type', async () => {
    expect(q('[data-context=name]').textContent).toBe('Shape Tool');
    expect(document.querySelector('#shr')).toBeTruthy(); // rectangle: corner radius
    expect(document.querySelector('#shn')).toBeNull();
    q('[data-opt=shape-polygon]').click();
    await settle();
    expect(document.querySelector('#shn')).toBeTruthy(); // sides
    expect(document.querySelector('#shi')).toBeTruthy(); // inner ratio
    expect(document.querySelector('#shr')).toBeNull();
    q('[data-opt=shape-line]').click();
    await settle();
    expect(document.querySelector('#sha1')).toBeTruthy(); // arrowheads
    expect(document.querySelector('#shf')).toBeNull(); // no fill for a line
    expect(document.querySelector('#shw')).toBeTruthy();
    expect(engine.shapeTool).toBe('line');
  });

  it('without a shape layer the settings are the defaults for the next shape', async () => {
    q<HTMLInputElement>('#shs').click();
    await settle();
    await slide('shw', 9);
    await slide('shr', 20);
    expect(store.shapeOpts.value).toMatchObject({ strokeOn: true, strokeWidth: 9, radius: 20 });
    expect(engine.calls.some((c) => c.startsWith('setShape:'))).toBe(false);
  });

  it('with a shape layer selected the controls edit it through engine.setShape', async () => {
    const id = engine.addShapeLayer(completeShapeSpec({ type: 'rect', w: 80, h: 40 }));
    await settle();
    q<HTMLInputElement>('#shs').click(); // stroke on
    await settle();
    await slide('shw', 7);
    await slide('shr', 12);
    q<HTMLInputElement>('#shf').click(); // fill off
    await settle();
    const fillC = q<HTMLInputElement>('#shfc');
    fillC.value = '#00ff00';
    fillC.dispatchEvent(new Event('input', { bubbles: true }));
    const strokeC = q<HTMLInputElement>('#shsc');
    strokeC.value = '#0000ff';
    strokeC.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    const s = engine.layers().find((l) => l.id === id)!.shape as Extract<ReturnType<typeof completeShapeSpec>, { type: 'rect' }>;
    expect(s).toMatchObject({ type: 'rect', w: 80, radius: 12 });
    expect(s.stroke).toMatchObject({ enabled: true, width: 7, color: { r: 0, g: 0, b: 255 } });
    expect(s.fill).toMatchObject({ enabled: false, color: { r: 0, g: 255, b: 0 } });
    expect(store.primary.value).toBe('#00ff00');
    expect(store.secondary.value).toBe('#0000ff');
  });

  it('polygon layer: sides and inner ratio; line layer: arrowheads', async () => {
    const poly = engine.addShapeLayer(completeShapeSpec({ type: 'polygon' }));
    await settle();
    expect(q<HTMLInputElement>('#shn').value).toBe('5');
    await slide('shn', 8);
    await slide('shi', 40);
    expect(engine.layers().find((l) => l.id === poly)!.shape).toMatchObject({ sides: 8, innerRatio: 0.4 });
    const line = engine.addShapeLayer(completeShapeSpec({ type: 'line' }));
    await settle();
    expect(store.shapeOpts.value.type).toBe('line'); // selecting a shape layer loads its type
    q<HTMLInputElement>('#sha0').click();
    q<HTMLInputElement>('#sha1').click();
    await settle();
    expect(engine.layers().find((l) => l.id === line)!.shape).toMatchObject({ arrowStart: true, arrowEnd: true });
  });

  it('a line shows a single colour control (the line colour = primary) and no fill / stroke toggles', async () => {
    q('[data-opt=shape-line]').click();
    await settle();
    expect(document.querySelectorAll('input[type=color]').length).toBe(1);
    expect(q('#shsc').getAttribute('aria-label')).toBe('Line colour');
    const id = engine.addShapeLayer(completeShapeSpec({ type: 'line' }));
    await settle();
    const c = q<HTMLInputElement>('#shsc');
    c.value = '#00ff00';
    c.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect((engine.layers().find((l) => l.id === id)!.shape as { stroke: { color: object } }).stroke.color).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(store.primary.value).toBe('#00ff00');
    expect(store.secondary.value).toBe('#ffffff');
  });

  it('changing the type does not convert the selected layer', async () => {
    const id = engine.addShapeLayer(completeShapeSpec({ type: 'rect' }));
    await settle();
    q('[data-opt=shape-ellipse]').click();
    await settle();
    expect(engine.layers().find((l) => l.id === id)!.shape!.type).toBe('rect');
    expect(engine.shapeTool).toBe('ellipse');
  });
});

describe('shape tool drag', () => {
  beforeEach(async () => { await mount(<Viewport />, 'display:flex;flex-direction:column;width:600px;height:400px'); });
  const drag = async (a: [number, number], b: [number, number], extra: PointerEventInit = {}) => {
    const vp = q('[data-viewport]'), r = vp.getBoundingClientRect(), v = store.view.value;
    const c = (p: [number, number]) => ({ clientX: r.left + v.x + p[0] * v.zoom, clientY: r.top + v.y + p[1] * v.zoom });
    vp.dispatchEvent(ptr('pointerdown', { ...c(a), buttons: 1, ...extra }));
    vp.dispatchEvent(ptr('pointermove', { ...c([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), buttons: 1, ...extra }));
    await settle();
    vp.dispatchEvent(ptr('pointermove', { ...c(b), buttons: 1, ...extra }));
    vp.dispatchEvent(ptr('pointerup', { ...c(b), ...extra }));
    await settle();
  };

  it('drag creates a rectangle layer with the context bar settings; the engine pointer API is not used', async () => {
    store.setShapeOpt({ strokeOn: true, strokeWidth: 6, radius: 10 });
    await drag([20, 10], [100, 60]);
    expect(shapeCalls()).toHaveLength(1);
    expect(shapeCalls()[0]).toMatchObject({
      type: 'rect', x: 20, y: 10, w: 80, h: 50, radius: 10,
      fill: { enabled: true, color: { r: 226, g: 104, b: 60, a: 255 } }, stroke: { enabled: true, width: 6, color: { r: 255, g: 255, b: 255 } },
    });
    expect(engine.pointers).toHaveLength(0);
    expect(engine.layers().filter((l) => l.kind === 'shape')).toHaveLength(1);
  });

  it('dragging up-left normalises the bounds; Shift makes a square', async () => {
    await drag([100, 60], [60, 40]);
    expect(shapeCalls()[0]).toMatchObject({ x: 60, y: 40, w: 40, h: 20 });
    await drag([20, 10], [70, 30], { shiftKey: true });
    expect(shapeCalls()[1]).toMatchObject({ x: 20, y: 10, w: 50, h: 50 });
  });

  it('ellipse, line (Shift snaps to 45 degrees, forced stroke, arrows) and polygon (centre + radius)', async () => {
    store.setShapeOpt({ type: 'ellipse' });
    await drag([10, 10], [50, 30]);
    expect(shapeCalls()[0]).toMatchObject({ type: 'ellipse', x: 10, y: 10, w: 40, h: 20 });
    store.setShapeOpt({ type: 'line', strokeWidth: 5, arrowEnd: true });
    await drag([10, 10], [60, 15], { shiftKey: true });
    const line = shapeCalls()[1];
    expect(line).toMatchObject({ type: 'line', x1: 10, y1: 10, arrowEnd: true, arrowStart: false, stroke: { enabled: true, width: 5, color: { r: 226, g: 104, b: 60 } } });
    expect(line.y2).toBe(10); // snapped to horizontal
    store.setShapeOpt({ type: 'polygon', sides: 6, innerRatio: 0.5 });
    await drag([100, 50], [130, 50]);
    expect(shapeCalls()[2]).toMatchObject({ type: 'polygon', cx: 100, cy: 50, radius: 30, sides: 6, innerRatio: 0.5 });
  });

  it('a click without a drag creates nothing and the preview is cleared', async () => {
    await drag([20, 20], [20, 20]);
    expect(shapeCalls()).toHaveLength(0);
  });
});
