import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import { brushCtx, drawRect, layerPx, newEngine, px, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());
const labels = (en: Engine) => en.history().entries.map((x) => x.label);

describe('pixel history', () => {
  it('undo / redo restore exact pixels', () => {
    e = newEngine(50, 50);
    const a = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 10 }, { primary: { r: 255, g: 0, b: 0, a: 255 } }));
    stroke(e, 'brush', [[10, 10], [40, 10]]);
    const painted = e.readComposite({ x: 0, y: 0, w: 50, h: 50 });
    e.undo();
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: 50, h: 50 })).every((v) => v === 0)).toBe(true);
    e.redo();
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: 50, h: 50 }))).toEqual(Array.from(painted));
    expect(layerPx(e, a, 25, 10)).toEqual([255, 0, 0, 255]);
  });

  it('undo steps through several strokes in order', () => {
    e = newEngine(50, 50);
    e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 6 }));
    stroke(e, 'brush', [[10, 10]]);
    stroke(e, 'brush', [[30, 30]]);
    e.undo();
    expect(px(e, 30, 30)[3]).toBe(0);
    expect(px(e, 10, 10)[3]).toBe(255);
    e.undo();
    expect(px(e, 10, 10)[3]).toBe(0);
    e.undo(); // undo the layer add
    expect(e.layers()).toHaveLength(1);
    e.undo(); // nothing left
    expect(e.history().index).toBe(-1);
  });

  it('a new edit after undo drops the redo branch', () => {
    e = newEngine(50, 50);
    e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 6 }));
    stroke(e, 'brush', [[10, 10]]);
    e.undo();
    stroke(e, 'pencil', [[30, 30]]);
    expect(labels(e)).toEqual(['Add layer', 'Pencil']);
    e.redo();
    expect(px(e, 10, 10)[3]).toBe(0);
  });

  it('fill, gradient, pencil and eraser each undo exactly', () => {
    e = newEngine(30, 30);
    const a = e.addPixelLayer();
    drawRect(e, a, { x: 0, y: 0, w: 30, h: 30 }, 'rgb(10,20,30)');
    const base = Array.from(e.readComposite({ x: 0, y: 0, w: 30, h: 30 }));
    e.setToolContext(brushCtx({ size: 8 }, { primary: { r: 255, g: 0, b: 0, a: 255 } }));
    for (const tool of ['fill', 'pencil', 'eraser'] as const) {
      stroke(e, tool, [[5, 5], [20, 20]]);
      expect(Array.from(e.readComposite({ x: 0, y: 0, w: 30, h: 30 }))).not.toEqual(base);
      e.undo();
      expect(Array.from(e.readComposite({ x: 0, y: 0, w: 30, h: 30 }))).toEqual(base);
    }
    stroke(e, 'gradient', [[0, 0], [29, 0]]);
    e.undo();
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: 30, h: 30 }))).toEqual(base);
  });

  it('a patch applies to its layer even when another layer is active', () => {
    e = newEngine(30, 30);
    const a = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 6 }));
    stroke(e, 'brush', [[10, 10]]);
    e.addPixelLayer();
    e.undo(); // undoes "add layer"
    e.undo(); // undoes the stroke on `a`
    expect(layerPx(e, a, 10, 10)[3]).toBe(0);
  });

  it('undo repaints only the patch rect', () => {
    e = newEngine(400, 400);
    e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 6 }));
    stroke(e, 'brush', [[50, 50]]);
    e.flush();
    const rects: unknown[] = [];
    e.on((ev) => ev.type === 'composite' && rects.push(ev.rect));
    e.undo();
    e.flush();
    expect(rects).toHaveLength(1);
    const r = rects[0] as { w: number; h: number };
    expect(r.w).toBeLessThanOrEqual(128); // one 128 px tile
    expect(r.h).toBeLessThanOrEqual(128);
  });
});

describe('structural history', () => {
  it('add / delete / move / rename / visibility / lock / opacity / blend all undo and redo', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer('a');
    const b = e.addPixelLayer('b');
    const snap = () => JSON.stringify(e.layers());
    const steps: [string, () => void][] = [
      ['rename', () => e.setLayerProps(a, { name: 'renamed' })],
      ['visible', () => e.setLayerProps(a, { visible: false })],
      ['lock', () => e.setLayerProps(a, { locked: true })],
      ['blend', () => e.setLayerProps(a, { blend: 'hue' })],
      ['opacity', () => e.setLayerProps(a, { opacity: 0.3 })],
      ['move', () => e.moveLayer(b, null, 1)],
      ['group', () => e.addGroup()],
      ['delete', () => e.deleteLayer(a)],
    ];
    const states = [snap()];
    for (const [, f] of steps) {
      f();
      states.push(snap());
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      e.undo();
      expect(snap(), `undo ${steps[i][0]}`).toBe(states[i]);
    }
    for (let i = 0; i < steps.length; i++) {
      e.redo();
      expect(snap(), `redo ${steps[i][0]}`).toBe(states[i + 1]);
    }
  });

  it('deleting a layer and undoing restores its pixels', () => {
    e = newEngine(20, 20);
    const a = e.addPixelLayer();
    drawRect(e, a, { x: 0, y: 0, w: 20, h: 20 }, '#f00');
    e.deleteLayer(a);
    expect(px(e, 5, 5)).toEqual([0, 0, 0, 0]);
    e.undo();
    expect(px(e, 5, 5)).toEqual([255, 0, 0, 255]);
  });

  it('undoing a delete restores a group with its children', () => {
    e = newEngine(10, 10);
    const g = e.addGroup();
    const c = e.addPixelLayer();
    e.moveLayer(c, g, 0);
    drawRect(e, c, { x: 0, y: 0, w: 10, h: 10 }, '#0f0');
    e.deleteLayer(g);
    e.undo();
    expect(e.layers().map((l) => l.id)).toEqual([g, c, 'base']);
    expect(px(e, 1, 1)).toEqual([0, 255, 0, 255]);
  });

  it('opacity slider drags coalesce into one entry', () => {
    e = newEngine(10, 10);
    const a = e.addPixelLayer();
    for (const o of [0.9, 0.7, 0.5, 0.2]) e.setLayerProps(a, { opacity: o });
    expect(labels(e)).toEqual(['Add layer', 'Layer opacity']);
    e.undo();
    expect(e.layers()[0].opacity).toBe(1);
    e.redo();
    expect(e.layers()[0].opacity).toBe(0.2);
  });
});

describe('jumpTo and caps', () => {
  it('jumpTo moves across mixed pixel and structural entries', () => {
    e = newEngine(30, 30);
    e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 6 }));
    stroke(e, 'brush', [[10, 10]]);
    stroke(e, 'brush', [[20, 20]]);
    e.addGroup();
    expect(e.history().index).toBe(3);
    e.jumpTo(1);
    expect(e.history().index).toBe(1);
    expect(px(e, 10, 10)[3]).toBe(255);
    expect(px(e, 20, 20)[3]).toBe(0);
    expect(e.layers()).toHaveLength(2);
    e.jumpTo(3);
    expect(px(e, 20, 20)[3]).toBe(255);
    expect(e.layers()).toHaveLength(3);
    e.jumpTo(-1);
    expect(e.layers()).toHaveLength(1);
    e.jumpTo(100);
    expect(e.history().index).toBe(3);
  });

  it('keeps at most 100 steps', () => {
    e = newEngine(20, 20);
    e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 2 }));
    for (let i = 0; i < 120; i++) stroke(e, 'pencil', [[i % 20, 5]]);
    expect(e.history().entries).toHaveLength(100);
    expect(e.history().index).toBe(99);
  });

  it('drops the oldest patches beyond 256 MB', () => {
    e = newEngine(1000, 1000);
    e.addPixelLayer();
    e.setToolContext(brushCtx({}, { primary: { r: 1, g: 2, b: 3, a: 255 } }));
    const entry = 1000 * 1000 * 4 * 2;
    const expected = Math.floor((256 * 1024 * 1024) / entry);
    for (let i = 0; i < expected + 6; i++) {
      e.setToolContext(brushCtx({}, { primary: { r: i & 255, g: 2, b: 3, a: 255 }, fillTolerance: 255 }));
      stroke(e, 'fill', [[1, 1]]);
    }
    const n = e.history().entries.length;
    expect(n).toBe(expected);
    expect(n).toBeLessThan(100);
  });

  it('history() ids are stable and labels are meaningful', () => {
    e = newEngine(10, 10);
    e.addPixelLayer();
    e.addGroup();
    const ids = e.history().entries.map((x) => x.id);
    expect(new Set(ids).size).toBe(2);
    expect(labels(e)).toEqual(['Add layer', 'Add group']);
  });
});
