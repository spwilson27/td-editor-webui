import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { EngineEvent, Rect, ShapeSpec, TextSpec } from '../../src/engine/types';
import { brushCtx, collect, maskAt, newEngine, ptr, px, rgba, setBase, slotPx, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const NOSTROKE = { enabled: false, color: BLUE, width: 0 };
const rect = (o: Partial<Extract<ShapeSpec, { type: 'rect' }>> = {}): ShapeSpec => ({
  type: 'rect', x: 20, y: 20, w: 40, h: 30, radius: 0, fill: { enabled: true, color: RED }, stroke: NOSTROKE, rotation: 0, ...o,
});
const text = (o: Partial<TextSpec> = {}): TextSpec => ({
  text: 'HHHH', font: 'sans-serif', size: 40, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: true, italic: false,
  lineHeight: 1.2, x: 10, y: 10, boxWidth: null, ...o,
});
/** Bounding box of pixels with alpha > 20 in the composite of a transparent base. */
function inkBox(): Rect | null {
  const d = e.readComposite({ x: 0, y: 0, w: e.width, h: e.height });
  let x0 = e.width, y0 = e.height, x1 = -1, y1 = -1;
  for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
    if (d[(y * e.width + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const layer = (id: string) => e.layers().find((l) => l.id === id)!;
const last = () => e.history().entries.slice(-1)[0].label;

describe('shape rendering', () => {
  it('rect fill: exact interior and edges, spec in layers() and docSpec()', () => {
    e = newEngine(100, 80);
    const id = e.addShapeLayer(rect());
    expect(layer(id)).toMatchObject({ kind: 'shape', rasterize: false, slot: null, text: null });
    expect(layer(id).shape).toMatchObject({ type: 'rect', w: 40 });
    expect(px(e, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(px(e, 19, 30)[3]).toBe(0);
    expect(px(e, 60, 30)[3]).toBe(0);
    expect(inkBox()).toEqual({ x: 20, y: 20, w: 40, h: 30 });
    const spec = e.docSpec().layers.find((l) => l.id === id)!;
    expect(spec).toMatchObject({ kind: 'shape', slot: null, rasterize: false, x: 0, y: 0, text: null });
    expect(spec.shape).toEqual(layer(id).shape);
    expect(last()).toBe('Add shape');
  });

  it('rect corner radius, rotation about the centre', () => {
    e = newEngine(100, 100);
    e.addShapeLayer(rect({ x: 20, y: 20, w: 40, h: 40, radius: 12 }));
    expect(px(e, 21, 21)[3]).toBe(0);
    expect(px(e, 40, 21)).toEqual([255, 0, 0, 255]);
    const e2 = newEngine(100, 100);
    e2.addShapeLayer(rect({ x: 30, y: 40, w: 40, h: 10, rotation: 90 }));
    const d = e2.readComposite({ x: 0, y: 0, w: 100, h: 100 });
    const a = (x: number, y: number) => d[(y * 100 + x) * 4 + 3];
    expect(a(50, 28)).toBe(255);
    expect(a(50, 62)).toBe(255);
    expect(a(35, 45)).toBe(0);
    e2.dispose();
  });

  it('ellipse fill and centred stroke (half inside / half outside)', () => {
    e = newEngine(100, 100);
    e.addShapeLayer({ type: 'ellipse', x: 20, y: 30, w: 60, h: 40, fill: { enabled: true, color: RED }, stroke: { enabled: true, color: BLUE, width: 8 }, rotation: 0 });
    expect(px(e, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(px(e, 50, 31)).toEqual([0, 0, 255, 255]);
    expect(px(e, 50, 27)).toEqual([0, 0, 255, 255]);
    expect(px(e, 50, 24)[3]).toBe(0);
    expect(px(e, 20, 20)[3]).toBe(0);
    const b = inkBox()!;
    expect(b.y).toBeGreaterThanOrEqual(25);
    expect(b.y).toBeLessThanOrEqual(26);
  });

  it('polygon / star: vertex 0 points up, rotation is clockwise, star has inner points', () => {
    e = newEngine(100, 100);
    const poly = (o: object) => ({ type: 'polygon', cx: 50, cy: 50, radius: 40, sides: 5, innerRatio: 1, fill: { enabled: true, color: RED }, stroke: NOSTROKE, rotation: 0, ...o }) as ShapeSpec;
    const id = e.addShapeLayer(poly({}));
    expect(px(e, 50, 14)[3]).toBe(255);
    expect(px(e, 50, 90)[3]).toBe(0);
    expect(px(e, 50, 80)[3]).toBe(255);
    e.setShape(id, poly({ rotation: 36 }));
    expect(px(e, 50, 14)[3]).toBe(0);
    e.setShape(id, poly({ rotation: 0, innerRatio: 0.3, sides: 5 }));
    expect(px(e, 50, 20)[3]).toBe(255);
    expect(px(e, 50, 50)[3]).toBe(255);
    const a = (-54 * Math.PI) / 180;
    expect(px(e, Math.round(50 + 35 * Math.cos(a)), Math.round(50 + 35 * Math.sin(a)))[3]).toBe(0);
  });

  it('line with arrowheads: tip on the end point, shaft width, hidden when stroke is off', () => {
    e = newEngine(100, 60);
    const ln = (o: object) => ({ type: 'line', x1: 10, y1: 30, x2: 90, y2: 30, stroke: { enabled: true, color: RED, width: 4 }, arrowStart: false, arrowEnd: false, ...o }) as ShapeSpec;
    const id = e.addShapeLayer(ln({}));
    expect(inkBox()).toEqual({ x: 10, y: 28, w: 80, h: 4 });
    e.setShape(id, ln({ arrowEnd: true }));
    expect(px(e, 78, 27)[3]).toBe(255);
    expect(px(e, 85, 30)[3]).toBe(255);
    expect(px(e, 91, 30)[3]).toBe(0);
    expect(px(e, 14, 25)[3]).toBe(0);
    e.setShape(id, ln({ arrowStart: true, arrowEnd: true }));
    expect(px(e, 22, 27)[3]).toBe(255);
    expect(px(e, 40, 25)[3]).toBe(0);
    e.setShape(id, ln({ stroke: { enabled: false, color: RED, width: 4 } }));
    expect(inkBox()).toBeNull();
    e.setShape(id, ln({ x2: 10 }));
    expect(inkBox()).toBeNull();
  });

  it('opacity, blend, visibility and mask apply to shape layers', () => {
    e = newEngine(60, 60);
    setBase(e, [255, 255, 255, 255]);
    const id = e.addShapeLayer(rect({ x: 10, y: 10, w: 40, h: 40, fill: { enabled: true, color: { r: 0, g: 0, b: 0, a: 255 } } }));
    e.setLayerProps(id, { opacity: 0.5 });
    expect(px(e, 30, 30)[0]).toBeGreaterThan(120);
    expect(px(e, 30, 30)[0]).toBeLessThan(135);
    e.setLayerProps(id, { opacity: 1, blend: 'multiply' });
    expect(px(e, 30, 30)).toEqual([0, 0, 0, 255]);
    const slot = e.addMask(id);
    e.writeSurface(slot, { x: 0, y: 0, w: 60, h: 60 }, new Uint8Array(60 * 60 * 4).fill(0));
    e.commitSurfaces();
    expect(px(e, 30, 30)).toEqual([255, 255, 255, 255]);
    expect(maskAt(e, slot, 1, 1)).toBe(0);
    e.setLayerProps(id, { visible: false });
    expect(px(e, 30, 30)).toEqual([255, 255, 255, 255]);
  });

  it('shape layers inside a group render with the group opacity', () => {
    e = newEngine(60, 60);
    setBase(e, [255, 255, 255, 255]);
    const id = e.addShapeLayer(rect({ x: 10, y: 10, w: 20, h: 20, fill: { enabled: true, color: { r: 0, g: 0, b: 0, a: 255 } } }));
    const g = e.addGroup();
    e.moveLayer(id, g, 0);
    e.setLayerProps(g, { opacity: 0.5 });
    const v = px(e, 20, 20)[0];
    expect(v).toBeGreaterThan(120);
    expect(v).toBeLessThan(135);
  });

  it('sanitises specs (negative size, sides, ratio) and rejects unknown types', () => {
    e = newEngine(80, 80);
    const id = e.addShapeLayer(rect({ x: 50, y: 50, w: -20, h: -10 }));
    expect(layer(id).shape).toMatchObject({ x: 30, y: 40, w: 20, h: 10 });
    const p = e.addShapeLayer({ type: 'polygon', cx: 1, cy: 1, radius: 5, sides: 500, innerRatio: 9, fill: { enabled: true, color: RED }, stroke: NOSTROKE, rotation: 0 });
    expect(layer(p).shape).toMatchObject({ sides: 64, innerRatio: 1 });
    expect(() => e.addShapeLayer({ type: 'blob' } as never)).toThrow();
  });
});

describe('shape edits and history', () => {
  it('setShape coalesces like opacity into one entry and announces docspec', () => {
    e = newEngine(100, 80);
    const id = e.addShapeLayer(rect());
    const ev = collect(e);
    const n = e.history().entries.length;
    for (let i = 1; i <= 5; i++) e.setShape(id, rect({ w: 40 + i * 4 }));
    expect(e.history().entries.length).toBe(n + 1);
    expect(last()).toBe('Edit shape');
    expect(ev.filter((x) => x.type === 'docspec')).toHaveLength(5);
    expect(inkBox()).toEqual({ x: 20, y: 20, w: 60, h: 30 });
    e.setShape(id, rect({ w: 60 }));
    expect(ev.filter((x) => x.type === 'docspec')).toHaveLength(5);
    e.undo();
    expect(layer(id).shape).toMatchObject({ w: 40 });
    expect(inkBox()).toEqual({ x: 20, y: 20, w: 40, h: 30 });
    e.redo();
    expect(layer(id).shape).toMatchObject({ w: 60 });
  });

  it('dirty rect covers old and new bounds (no ghost left behind)', () => {
    e = newEngine(120, 60);
    const id = e.addShapeLayer(rect({ x: 5, y: 5, w: 20, h: 20 }));
    e.flush();
    e.setShape(id, rect({ x: 90, y: 30, w: 20, h: 20 }));
    expect(px(e, 10, 10)[3]).toBe(0);
    expect(px(e, 100, 40)[3]).toBe(255);
  });

  it('setShape / setText ignore unknown ids and wrong kinds', () => {
    e = newEngine(50, 50);
    const t = e.addTextLayer(text());
    const s = e.addShapeLayer(rect());
    const n = e.history().entries.length;
    e.setShape('nope', rect());
    e.setShape(t, rect());
    e.setText(s, text());
    e.setText('nope', text());
    expect(e.history().entries.length).toBe(n);
  });

  it('paint tools on a text / shape layer give a notice and change nothing; masks stay paintable', () => {
    e = newEngine(60, 60);
    const id = e.addShapeLayer(rect({ x: 5, y: 5, w: 40, h: 40 }));
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    e.setToolContext(brushCtx({ size: 20 }, { primary: rgba(0, 255, 0) }));
    for (const t of ['brush', 'pencil', 'eraser', 'fill', 'gradient'] as const) stroke(e, t, [[20, 20], [30, 30]]);
    expect(notices).toEqual(new Array(5).fill('Flatten the layer to paint on it'));
    expect(px(e, 25, 25)).toEqual([255, 0, 0, 255]);
    const slot = e.addMask(id);
    e.setPaintTarget(id, 'mask');
    e.setToolContext(brushCtx({ size: 20, hardness: 1 }, { primary: rgba(0, 0, 0) }));
    stroke(e, 'brush', [[25, 25], [26, 25]]);
    expect(maskAt(e, slot, 25, 25)).toBe(0);
    expect(px(e, 25, 25)[3]).toBe(0);
    expect(notices).toHaveLength(5);
  });

  it('move tool edits the spec position (live docspec), not x / y; undo restores', () => {
    e = newEngine(100, 80);
    const id = e.addShapeLayer(rect());
    const t = e.addTextLayer(text({ x: 5, y: 5 }));
    e.setActiveLayer(id);
    const ev = collect(e);
    e.setTool('move');
    e.pointerDown(ptr(30, 30));
    e.pointerMove(ptr(40, 35));
    expect(ev.filter((x) => x.type === 'docspec').length).toBeGreaterThan(0);
    expect(e.docSpec().layers.find((l) => l.id === id)!.shape).toMatchObject({ x: 30, y: 25 });
    e.pointerUp(ptr(45, 40));
    expect(e.docSpec().layers.find((l) => l.id === id)).toMatchObject({ x: 0, y: 0, shape: { x: 35, y: 30 } });
    expect(last()).toBe('Move');
    e.undo();
    expect(layer(id).shape).toMatchObject({ x: 20, y: 20 });
    e.redo();
    expect(layer(id).shape).toMatchObject({ x: 35, y: 30 });
    e.setActiveLayer(t);
    stroke(e, 'move', [[0, 0], [10, 20]]);
    expect(layer(t).text).toMatchObject({ x: 15, y: 25 });
  });

  it("the engine's text and shape tools are no-ops", () => {
    e = newEngine(60, 60);
    e.setShapeTool('ellipse');
    const n = e.layers().length;
    stroke(e, 'shape', [[5, 5], [40, 40]]);
    stroke(e, 'text', [[5, 5]]);
    expect(e.layers().length).toBe(n);
    expect(e.history().entries).toHaveLength(0);
  });
});

describe('text rendering', () => {
  it('draws inside its box: top-left placement, line pitch, no wrap without a box', () => {
    e = newEngine(300, 200);
    const id = e.addTextLayer(text({ text: 'HHHH', size: 40, x: 10, y: 20 }));
    const b = inkBox()!;
    expect(b.x).toBeGreaterThanOrEqual(10);
    expect(b.x).toBeLessThanOrEqual(16);
    expect(b.y).toBeGreaterThanOrEqual(24);
    expect(b.y + b.h).toBeLessThanOrEqual(60);
    expect(b.h).toBeGreaterThan(20);
    expect(b.w).toBeGreaterThan(60);
    expect(layer(id)).toMatchObject({ kind: 'text', name: 'HHHH', rasterize: false });
    const one = b.h;
    e.setText(id, text({ text: 'HHHH\nHHHH', size: 40, x: 10, y: 20 }));
    const two = inkBox()!;
    expect(two.h).toBeGreaterThanOrEqual(one + 40 * 1.2 - 3);
    expect(two.h).toBeLessThanOrEqual(one + 40 * 1.2 + 3);
    e.setText(id, text({ text: 'HHHH\nHHHH', size: 40, x: 10, y: 20, lineHeight: 2 }));
    expect(inkBox()!.h).toBeGreaterThanOrEqual(one + 80 - 3);
  });

  it('wraps greedily at spaces inside boxWidth and never breaks a long word', () => {
    e = newEngine(400, 300);
    const base = text({ text: 'HH HH HH HH', size: 30, x: 10, y: 10 });
    const id = e.addTextLayer(base);
    const flat = inkBox()!;
    e.setText(id, { ...base, boxWidth: 80 });
    const wrapped = inkBox()!;
    expect(wrapped.w).toBeLessThanOrEqual(84);
    expect(wrapped.h).toBeGreaterThan(flat.h * 1.8);
    e.setText(id, { ...base, text: 'HHHHHHHHHHHH', boxWidth: 30 });
    const long = inkBox()!;
    expect(long.w).toBeGreaterThan(100);
    expect(long.h).toBeLessThanOrEqual(flat.h + 2);
  });

  it('alignment: left starts at x, right ends at x + boxWidth, centre is centred on the box', () => {
    e = newEngine(400, 100);
    const base = text({ text: 'HHH', size: 30, x: 100, y: 10, boxWidth: 200 });
    const id = e.addTextLayer(base);
    expect(inkBox()!.x).toBeLessThanOrEqual(106);
    e.setText(id, { ...base, align: 'right' });
    const right = inkBox()!;
    expect(right.x + right.w).toBeGreaterThanOrEqual(294);
    expect(right.x + right.w).toBeLessThanOrEqual(301);
    e.setText(id, { ...base, align: 'center' });
    const c = inkBox()!;
    expect(Math.abs(c.x + c.w / 2 - 200)).toBeLessThanOrEqual(5);
  });

  it('size, colour alpha; empty text paints nothing', () => {
    e = newEngine(300, 120);
    const id = e.addTextLayer(text({ text: 'HH', size: 30 }));
    const small = inkBox()!;
    e.setText(id, text({ text: 'HH', size: 60 }));
    expect(inkBox()!.h).toBeGreaterThan(small.h * 1.7);
    e.setText(id, text({ text: '', size: 30 }));
    expect(inkBox()).toBeNull();
    e.setText(id, text({ text: 'HH', size: 30, color: { r: 0, g: 0, b: 0, a: 100 } }));
    const p = e.readComposite({ x: 0, y: 0, w: 300, h: 120 });
    let maxA = 0;
    for (let i = 3; i < p.length; i += 4) maxA = Math.max(maxA, p[i]);
    expect(maxA).toBeLessThanOrEqual(101);
    expect(maxA).toBeGreaterThan(90);
  });

  it('setText coalesces into one history entry', () => {
    e = newEngine(200, 100);
    const id = e.addTextLayer(text({ text: 'a' }));
    const n = e.history().entries.length;
    e.setText(id, text({ text: 'ab' }));
    e.setText(id, text({ text: 'abc' }));
    e.setText(id, text({ text: 'abcd' }));
    expect(e.history().entries.length).toBe(n + 1);
    expect(last()).toBe('Edit text');
    e.undo();
    expect(layer(id).text?.text).toBe('a');
  });

  it('textLayerAt hits the layout box of the topmost visible text layer', () => {
    e = newEngine(300, 200);
    const a = e.addTextLayer(text({ text: 'HHHH', size: 40, x: 20, y: 20 }));
    const b = e.addTextLayer(text({ text: 'HHHH', size: 40, x: 40, y: 30 }));
    expect(e.textLayerAt(5, 5)).toBeNull();
    expect(e.textLayerAt(25, 25)).toBe(a);
    expect(e.textLayerAt(60, 40)).toBe(b);
    e.setLayerProps(b, { visible: false });
    expect(e.textLayerAt(60, 40)).toBe(a);
    const empty = e.addTextLayer(text({ text: '', x: 200, y: 100 }));
    expect(e.textLayerAt(205, 110)).toBe(empty);
  });

  it('moving text leaves no ghost', () => {
    e = newEngine(300, 100);
    const id = e.addTextLayer(text({ text: 'HH', size: 30, x: 10, y: 10 }));
    e.flush();
    e.setText(id, text({ text: 'HH', size: 30, x: 200, y: 50 }));
    expect(inkBox()!.x).toBeGreaterThanOrEqual(198);
  });
});

describe('rasterize on / off', () => {
  it('on: allocates a slot, renders a surface identical to the preview, announces bbox; off releases the slot', () => {
    e = newEngine(100, 80);
    const id = e.addShapeLayer(rect());
    const before = inkBox();
    const ev = collect(e);
    e.setRasterize(id, true);
    const info = layer(id);
    expect(info.rasterize).toBe(true);
    expect(info.slot).toBeGreaterThan(0);
    expect(e.surfaceSlots()).toContain(info.slot);
    expect(e.docSpec().layers.find((l) => l.id === id)).toMatchObject({ slot: info.slot, rasterize: true, kind: 'shape' });
    const surf = ev.filter((x): x is Extract<EngineEvent, { type: 'surface' }> => x.type === 'surface');
    expect(surf).toHaveLength(1);
    expect(surf[0].slot).toBe(info.slot);
    expect(surf[0].rect.x).toBeLessThanOrEqual(20);
    expect(surf[0].rect.w).toBeLessThan(100);
    expect(slotPx(e, info.slot!, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(slotPx(e, info.slot!, 5, 5)[3]).toBe(0);
    expect(inkBox()).toEqual(before);
    ev.length = 0;
    e.setShape(id, rect({ x: 60, y: 40, w: 20, h: 20 }));
    expect(slotPx(e, info.slot!, 30, 30)[3]).toBe(0);
    expect(slotPx(e, info.slot!, 70, 50)).toEqual([255, 0, 0, 255]);
    const s2 = ev.filter((x) => x.type === 'surface') as Array<Extract<EngineEvent, { type: 'surface' }>>;
    expect(s2).toHaveLength(1);
    expect(s2[0].rect.x).toBeLessThanOrEqual(20);
    expect(s2[0].rect.x + s2[0].rect.w).toBeGreaterThanOrEqual(80);
    expect(s2[0].rect.y + s2[0].rect.h).toBeGreaterThanOrEqual(60);
    const slot = info.slot!;
    e.setRasterize(id, false);
    expect(layer(id)).toMatchObject({ rasterize: false, slot: null });
    expect(e.surfaceSlots()).not.toContain(slot);
    expect(e.docSpec().layers.find((l) => l.id === id)).toMatchObject({ slot: null, rasterize: false });
    expect(inkBox()!.x).toBe(60);
    e.setRasterize(id, true);
    expect(layer(id).slot).not.toBe(slot);
  });

  it('undo / redo of the toggle and of spec edits keep the surface and slots consistent', () => {
    e = newEngine(100, 80);
    const id = e.addShapeLayer(rect());
    e.setRasterize(id, true);
    const slot = layer(id).slot!;
    e.setShape(id, rect({ x: 60, y: 40, w: 20, h: 20 }));
    const ev = collect(e);
    e.undo();
    expect(slotPx(e, slot, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(slotPx(e, slot, 70, 50)[3]).toBe(0);
    expect(ev.some((x) => x.type === 'surface' && x.slot === slot)).toBe(true);
    e.undo();
    expect(layer(id)).toMatchObject({ rasterize: false, slot: null });
    expect(e.surfaceSlots()).not.toContain(slot);
    e.redo();
    expect(layer(id).slot).toBe(slot);
    expect(slotPx(e, slot, 30, 30)).toEqual([255, 0, 0, 255]);
    e.redo();
    expect(slotPx(e, slot, 70, 50)).toEqual([255, 0, 0, 255]);
    expect(slotPx(e, slot, 30, 30)[3]).toBe(0);
  });

  it('rasterized text matches the unrasterized preview pixel for pixel', () => {
    e = newEngine(240, 100);
    const id = e.addTextLayer(text({ text: 'Hi there', size: 36 }));
    const a = Array.from(e.readComposite({ x: 0, y: 0, w: 240, h: 100 }));
    e.setRasterize(id, true);
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: 240, h: 100 }))).toEqual(a);
    expect(Array.from(e.readSurface(layer(id).slot!, { x: 0, y: 0, w: 240, h: 100 }))).toEqual(a);
    expect(last()).toBe('Rasterize on');
  });

  it('rasterized layers accept writeSurface (TD upload path) and draw thumbnails either way', () => {
    e = newEngine(40, 40);
    const id = e.addShapeLayer(rect({ x: 0, y: 0, w: 10, h: 10 }));
    e.setRasterize(id, true);
    e.writeSurface(layer(id).slot!, { x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3, 255]));
    e.commitSurfaces();
    expect(px(e, 0, 0)).toEqual([1, 2, 3, 255]);
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    e.drawThumbnail(id, c);
    expect(c.getContext('2d')!.getImageData(1, 1, 1, 1).data[3]).toBe(255);
    e.setRasterize(id, false);
    e.drawThumbnail(id, c);
    expect(c.getContext('2d')!.getImageData(1, 1, 1, 1).data[3]).toBe(255);
  });
});

describe('flatten', () => {
  it('turns a shape into a pixel layer keeping id, name, mask, opacity, blend, visibility', () => {
    e = newEngine(80, 60);
    setBase(e, [255, 255, 255, 255]);
    const id = e.addShapeLayer(rect({ x: 10, y: 10, w: 40, h: 30 }));
    e.setLayerProps(id, { name: 'Box', opacity: 0.5, blend: 'multiply' });
    const m = e.addMask(id);
    const before = Array.from(e.readComposite({ x: 0, y: 0, w: 80, h: 60 }));
    e.flattenLayer(id);
    const info = layer(id);
    expect(info).toMatchObject({ kind: 'pixel', name: 'Box', opacity: 0.5, blend: 'multiply', visible: true, rasterize: false, text: null, shape: null });
    expect(info.mask).toEqual({ slot: m, enabled: true });
    expect(info.slot).toBeGreaterThan(0);
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: 80, h: 60 }))).toEqual(before);
    expect(slotPx(e, info.slot!, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(last()).toBe('Flatten layer');
    e.setToolContext(brushCtx({ size: 6, hardness: 1 }, { primary: rgba(0, 255, 0) }));
    e.setPaintTarget(id, 'pixels');
    stroke(e, 'brush', [[20, 20], [21, 20]]);
    expect(slotPx(e, info.slot!, 20, 20)[1]).toBe(255);
    e.undo();
    e.undo();
    expect(layer(id)).toMatchObject({ kind: 'shape' });
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: 80, h: 60 }))).toEqual(before);
    e.redo();
    expect(layer(id).kind).toBe('pixel');
  });

  it('flattening a rasterized layer keeps its slot; ignores pixel layers and unknown ids', () => {
    e = newEngine(50, 50);
    const id = e.addTextLayer(text({ text: 'H', size: 30 }));
    e.setRasterize(id, true);
    const slot = layer(id).slot;
    const n = e.history().entries.length;
    e.flattenLayer(id);
    expect(layer(id)).toMatchObject({ kind: 'pixel', slot });
    e.flattenLayer(id);
    e.flattenLayer('nope');
    e.flattenLayer('base');
    expect(e.history().entries.length).toBe(n + 1);
  });
});

describe('docSpec / loadDocument round trip', () => {
  it('text and shape layers (raster or not) survive a round trip; raster surfaces are re-rendered locally', () => {
    e = newEngine(120, 90);
    const s = e.addShapeLayer(rect());
    const t = e.addTextLayer(text({ text: 'Hi', size: 30 }));
    const r = e.addShapeLayer({ type: 'ellipse', x: 5, y: 5, w: 30, h: 30, fill: { enabled: true, color: BLUE }, stroke: NOSTROKE, rotation: 0 });
    e.setRasterize(r, true);
    const g = e.addGroup();
    e.moveLayer(t, g, 0);
    const m = e.addMask(s);
    const spec = JSON.parse(JSON.stringify(e.docSpec()));
    const before = Array.from(e.readComposite({ x: 0, y: 0, w: 120, h: 90 }));
    const e2 = newEngine(10, 10);
    e2.loadDocument(spec);
    expect(e2.docSpec().layers).toEqual(spec.layers);
    expect(e2.layers().map((l) => [l.id, l.kind, l.rasterize, l.slot])).toEqual(e.layers().map((l) => [l.id, l.kind, l.rasterize, l.slot]));
    expect(e2.surfaceSlots().sort()).toEqual(e.surfaceSlots().sort());
    e2.writeSurface(m, { x: 0, y: 0, w: 120, h: 90 }, new Uint8Array(120 * 90 * 4).fill(255));
    e2.commitSurfaces();
    expect(Array.from(e2.readComposite({ x: 0, y: 0, w: 120, h: 90 }))).toEqual(before);
    e2.dispose();
  });

  it('rejects malformed text / shape specs and duplicate raster slots', () => {
    e = newEngine(30, 30);
    e.addShapeLayer(rect());
    e.addTextLayer(text());
    const good = JSON.parse(JSON.stringify(e.docSpec()));
    const bad = (f: (s: typeof good) => void): void => {
      const s = JSON.parse(JSON.stringify(good));
      f(s);
      expect(() => e.loadDocument(s)).toThrow(RangeError);
    };
    bad((s) => { s.layers[1].shape = null; });
    bad((s) => { s.layers[2].text = null; });
    bad((s) => { s.layers[1].shape = { type: 'blob' }; });
    bad((s) => { s.layers[1].rasterize = true; s.layers[1].slot = 5; s.layers[2].rasterize = true; s.layers[2].slot = 5; });
    bad((s) => { s.layers[1].rasterize = true; s.layers[1].slot = null; });
    expect(e.layers().length).toBe(3);
  });
});

describe('importImage', () => {
  const solid = (w: number, h: number, c: number[]): Uint8ClampedArray => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) a.set(c, i * 4);
    return a;
  };

  it('centres a small image on a new pixel layer above the active one, with history', () => {
    e = newEngine(100, 80);
    const below = e.addPixelLayer();
    const id = e.importImage(solid(20, 10, [10, 200, 30, 255]), 20, 10, 'photo.png');
    const l = e.layers();
    expect(l[0].id).toBe(id);
    expect(l[1].id).toBe(below);
    expect(l[0]).toMatchObject({ kind: 'pixel', name: 'photo.png' });
    expect(e.activeLayerId()).toBe(id);
    expect(px(e, 40, 35)).toEqual([10, 200, 30, 255]);
    expect(px(e, 59, 44)).toEqual([10, 200, 30, 255]);
    expect(px(e, 39, 35)[3]).toBe(0);
    expect(px(e, 60, 35)[3]).toBe(0);
    expect(px(e, 40, 34)[3]).toBe(0);
    expect(slotPx(e, l[0].slot!, 40, 35)).toEqual([10, 200, 30, 255]);
    expect(last()).toBe('Import image');
    e.undo();
    expect(e.layers().some((x) => x.id === id)).toBe(false);
  });

  it('keeps straight alpha; scales larger images down to fit with a notice, aspect kept', () => {
    e = newEngine(100, 50);
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    e.importImage(solid(4, 4, [255, 0, 0, 128]), 4, 4, 'a');
    expect(px(e, 50, 25)[3]).toBeGreaterThanOrEqual(127);
    expect(px(e, 50, 25)[3]).toBeLessThanOrEqual(129);
    expect(notices).toEqual([]);
    e.importImage(solid(400, 200, [0, 0, 255, 255]), 400, 200, 'big');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/scaled/i);
    expect(px(e, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(px(e, 99, 49)).toEqual([0, 0, 255, 255]);
    notices.length = 0;
    e.importImage(solid(100, 200, [0, 255, 0, 255]), 100, 200, 'tall');
    expect(notices).toHaveLength(1);
    expect(px(e, 50, 25)).toEqual([0, 255, 0, 255]);
    expect(px(e, 36, 25)[1]).toBe(0);
    expect(px(e, 38, 25)[1]).toBe(255);
    expect(px(e, 61, 25)[1]).toBe(255);
    expect(px(e, 63, 25)[1]).toBe(0);
  });

  it('high-quality downscale averages (checkerboard -> mid grey) and rejects bad input', () => {
    e = newEngine(16, 16);
    const w = 64;
    const a = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) a.set(((x + y) & 1) === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * w + x) * 4);
    e.importImage(a, w, w, 'cb');
    const v = px(e, 8, 8)[0];
    expect(v).toBeGreaterThan(100);
    expect(v).toBeLessThan(155);
    expect(() => e.importImage(new Uint8Array(3), 2, 2, 'x')).toThrow(RangeError);
    expect(() => e.importImage(new Uint8Array(16), 0, 4, 'x')).toThrow(RangeError);
    const n = e.layers().length;
    e.importImage(new Uint8Array(16), 2, 2, '');
    expect(e.layers().length).toBe(n + 1);
    expect(e.layers()[0].name).toBe('Image');
  });
});

describe('rasterize on / off render identically for every shape type', () => {
  const F = { enabled: true, color: { r: 200, g: 40, b: 90, a: 220 } };
  const S = { enabled: true, color: { r: 10, g: 120, b: 250, a: 200 }, width: 5 };
  const cases: Record<string, ShapeSpec> = {
    rect: { type: 'rect', x: 13.5, y: 17, w: 70, h: 50, radius: 0, fill: F, stroke: S, rotation: 0 },
    'rounded rect': { type: 'rect', x: 13, y: 17, w: 70, h: 50, radius: 18, fill: F, stroke: S, rotation: 0 },
    'rounded rect, fill only': { type: 'rect', x: 20, y: 20, w: 60, h: 60, radius: 12, fill: F, stroke: { ...S, enabled: false }, rotation: 0 },
    'rotated rounded rect': { type: 'rect', x: 20, y: 30, w: 60, h: 30, radius: 10, fill: F, stroke: S, rotation: 33 },
    'huge radius': { type: 'rect', x: 20, y: 30, w: 60, h: 30, radius: 400, fill: F, stroke: S, rotation: 0 },
    ellipse: { type: 'ellipse', x: 12, y: 22, w: 76, h: 44, fill: F, stroke: S, rotation: 0 },
    'rotated ellipse': { type: 'ellipse', x: 12, y: 22, w: 76, h: 44, fill: F, stroke: S, rotation: 40 },
    line: { type: 'line', x1: 10, y1: 12, x2: 90, y2: 70, stroke: S, arrowStart: false, arrowEnd: false },
    'line with arrows': { type: 'line', x1: 10, y1: 12, x2: 90, y2: 70, stroke: S, arrowStart: true, arrowEnd: true },
    polygon: { type: 'polygon', cx: 50, cy: 45, radius: 38, sides: 7, innerRatio: 1, fill: F, stroke: S, rotation: 0 },
    star: { type: 'polygon', cx: 50, cy: 45, radius: 38, sides: 5, innerRatio: 0.45, fill: F, stroke: S, rotation: 17 },
  };
  for (const [name, spec] of Object.entries(cases)) {
    it(name, () => {
      e = newEngine(100, 90);
      const id = e.addShapeLayer(spec);
      const off = e.readComposite({ x: 0, y: 0, w: 100, h: 90 });
      e.setRasterize(id, true);
      const on = e.readComposite({ x: 0, y: 0, w: 100, h: 90 });
      const surf = e.readSurface(layer(id).slot!, { x: 0, y: 0, w: 100, h: 90 });
      let worst = 0;
      let worstS = 0;
      for (let i = 0; i < off.length; i++) {
        worst = Math.max(worst, Math.abs(off[i] - on[i]));
        worstS = Math.max(worstS, Math.abs(off[i] - surf[i]));
      }
      expect(worst).toBeLessThanOrEqual(1);
      expect(worstS).toBeLessThanOrEqual(1);
    });
  }
});
