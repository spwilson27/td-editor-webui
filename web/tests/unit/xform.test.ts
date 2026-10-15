import { describe, expect, it } from 'vitest';
import { anchorOffset, cleanXf, dirtyDoc, docRectToLayer, innerLayerRect, isAligned, layerRectToDoc, outerRect, toDoc, toLayer } from '../../src/engine/xform';
import { reframeSel, NO_SEL } from '../../src/engine/selection';
import { scaleSpec, shapeBox } from '../../src/engine/textShape';
import type { Anchor, ShapeSpec, TextSpec } from '../../src/engine/types';

const T = { x: 10, y: 20, sx: 2, sy: 0.5 };

describe('layer <-> document mapping', () => {
  it('maps points and rects both ways', () => {
    expect(toDoc(T, 3, 8)).toEqual({ x: 16, y: 24 });
    expect(toLayer(T, 16, 24)).toEqual({ x: 3, y: 8 });
    expect(layerRectToDoc(T, { x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 12, y: 21, w: 6, h: 2 });
    expect(docRectToLayer(T, { x: 12, y: 21, w: 6, h: 2 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('outerRect rounds outwards', () => {
    expect(outerRect({ x: 2.5, y: 4.25, w: 10, h: 10 })).toEqual({ x: 2, y: 4, w: 11, h: 11 });
    expect(outerRect({ x: 2, y: 3, w: 4, h: 5 })).toEqual({ x: 2, y: 3, w: 4, h: 5 });
  });

  it('aligned transforms (scale 1, whole-pixel offset) dirty exactly their pixels; others grow by the filter footprint', () => {
    expect(isAligned({ x: 3, y: -4, sx: 1, sy: 1 })).toBe(true);
    expect(isAligned({ x: 3.5, y: 0, sx: 1, sy: 1 })).toBe(false);
    expect(isAligned({ x: 0, y: 0, sx: 2, sy: 1 })).toBe(false);
    expect(dirtyDoc({ x: 3, y: -4, sx: 1, sy: 1 }, { x: 10, y: 10, w: 5, h: 6 })).toEqual({ x: 13, y: 6, w: 5, h: 6 });
    const d = dirtyDoc(T, { x: 10, y: 10, w: 4, h: 4 }); // mapped: x 30..38, y 25..27
    expect(d.x).toBeLessThanOrEqual(30 - 2 - 2);
    expect(d.x + d.w).toBeGreaterThanOrEqual(38 + 2 + 2);
    expect(d.y).toBeLessThanOrEqual(25 - 0.5 - 2);
    expect(d.y + d.h).toBeGreaterThanOrEqual(27 + 0.5 + 2);
    expect(Number.isInteger(d.x) && Number.isInteger(d.w)).toBe(true);
  });

  it('innerLayerRect: layer pixels whose centres are inside the document rect', () => {
    // identity: exactly the rect
    expect(innerLayerRect({ x: 0, y: 0, sx: 1, sy: 1 }, { x: 5, y: 6, w: 7, h: 8 })).toEqual({ x: 5, y: 6, w: 7, h: 8 });
    // 2x at offset 10: pixel u covers doc 10 + 2u .. 12 + 2u, centre 11 + 2u
    expect(innerLayerRect({ x: 10, y: 10, sx: 2, sy: 2 }, { x: 40, y: 40, w: 20, h: 20 })).toEqual({ x: 15, y: 15, w: 10, h: 10 });
    // 0.5x: pixel u covers 0.5u .. 0.5u + 0.5, centre 0.5u + 0.25
    expect(innerLayerRect({ x: 0, y: 0, sx: 0.5, sy: 0.5 }, { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    // empty when no centre falls inside
    expect(innerLayerRect({ x: 0, y: 0, sx: 10, sy: 10 }, { x: 1, y: 1, w: 3, h: 3 }).w).toBe(0);
    // negative origin
    expect(innerLayerRect({ x: -5, y: -5, sx: 1, sy: 1 }, { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 10, h: 10 });
  });

  it('cleanXf clamps the scale to a positive range and rejects non-finite numbers', () => {
    expect(cleanXf({ x: 1, y: 2, sx: 3, sy: 4 })).toEqual({ x: 1, y: 2, sx: 3, sy: 4 });
    const c = cleanXf({ x: 0, y: 0, sx: -1, sy: 0 });
    expect(c && c.sx > 0 && c.sy > 0).toBe(true);
    expect(cleanXf({ x: NaN, y: 0, sx: 1, sy: 1 })).toBeNull();
    expect(cleanXf({ x: 0, y: 0, sx: Infinity, sy: 1 })).toBeNull();
  });
});

describe('canvas anchors', () => {
  const cases: Array<[Anchor, number, number]> = [
    ['tl', 0, 0], ['t', 25, 0], ['tr', 50, 0],
    ['l', 0, 10], ['c', 25, 10], ['r', 50, 10],
    ['bl', 0, 20], ['b', 25, 20], ['br', 50, 20],
  ];
  for (const [a, dx, dy] of cases) {
    it(`growing 100x80 -> 150x100 with ${a}`, () => expect(anchorOffset(a, 100, 80, 150, 100)).toEqual({ dx, dy }));
    it(`shrinking 100x80 -> 50x60 with ${a}`, () => expect(anchorOffset(a, 100, 80, 50, 60)).toEqual({ dx: dx === 0 ? 0 : -dx, dy: dy === 0 ? 0 : -dy }));
  }
  it('rounds to whole pixels and never returns -0', () => {
    expect(anchorOffset('c', 100, 100, 101, 101)).toEqual({ dx: 1, dy: 1 }); // 0.5 rounds up
    expect(anchorOffset('c', 101, 101, 100, 100)).toEqual({ dx: 0, dy: 0 });
    expect(Object.is(anchorOffset('c', 101, 101, 100, 100).dx, 0)).toBe(true);
  });
});

describe('selection reframe', () => {
  it('moves a rect selection and clips it to the new document', () => {
    expect(reframeSel({ rect: { x: 10, y: 10, w: 20, h: 20 }, alpha: null }, 100, 100, 100, 5, -3)).toEqual({ rect: { x: 15, y: 7, w: 20, h: 20 }, alpha: null });
    expect(reframeSel({ rect: { x: 10, y: 10, w: 20, h: 20 }, alpha: null }, 100, 25, 25, 0, 0)).toEqual({ rect: { x: 10, y: 10, w: 15, h: 15 }, alpha: null });
    expect(reframeSel({ rect: { x: 10, y: 10, w: 20, h: 20 }, alpha: null }, 100, 30, 30, -35, 0)).toEqual(NO_SEL);
    expect(reframeSel(NO_SEL, 10, 20, 20, 5, 5)).toBe(NO_SEL);
  });

  it('moves the coverage of a non-rect selection', () => {
    const w = 6;
    const alpha = new Uint8Array(w * 6);
    alpha[2 * w + 2] = 255;
    alpha[3 * w + 3] = 128;
    const out = reframeSel({ rect: { x: 2, y: 2, w: 2, h: 2 }, alpha }, w, 10, 10, 3, 1);
    expect(out.rect).toEqual({ x: 5, y: 3, w: 2, h: 2 });
    expect((out.alpha as Uint8Array)[3 * 10 + 5]).toBe(255);
    expect((out.alpha as Uint8Array)[4 * 10 + 6]).toBe(128);
  });
});

describe('scaleSpec / shapeBox', () => {
  const text: TextSpec = { text: 'Hi', font: 'sans-serif', size: 20, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 10, y: 10, boxWidth: 100 };
  it('text: position follows the box, size the vertical factor, wrap width the horizontal one', () => {
    const t = scaleSpec(text, { x: 10, y: 10, w: 100, h: 24 }, { x: 50, y: 60, w: 300, h: 72 });
    expect(t).toMatchObject({ x: 50, y: 60, size: 60, boxWidth: 300 });
    expect(scaleSpec({ ...text, boxWidth: null }, { x: 10, y: 10, w: 100, h: 24 }, { x: 10, y: 10, w: 50, h: 24 }).boxWidth).toBeNull();
    expect(scaleSpec(text, { x: 10, y: 10, w: 100, h: 0 }, { x: 0, y: 0, w: 100, h: 50 }).size).toBe(20); // degenerate source height: only moves
  });

  it('shapes: coordinates map linearly, radius and stroke by the geometric mean', () => {
    const rect: ShapeSpec = { type: 'rect', x: 10, y: 10, w: 20, h: 10, radius: 4, fill: { enabled: true, color: { r: 1, g: 2, b: 3, a: 255 } }, stroke: { enabled: true, color: { r: 0, g: 0, b: 0, a: 255 }, width: 2 }, rotation: 15 };
    const r = scaleSpec(rect, shapeBox(rect), { x: 0, y: 0, w: 40, h: 40 }) as typeof rect;
    expect(r).toMatchObject({ x: 0, y: 0, w: 40, h: 40, rotation: 15 });
    expect(r.radius).toBeCloseTo(4 * Math.sqrt(8), 6);
    expect(r.stroke.width).toBeCloseTo(2 * Math.sqrt(8), 6);
    expect(rect.w).toBe(20); // input untouched
    const ell: ShapeSpec = { ...rect, type: 'ellipse' } as unknown as ShapeSpec;
    expect(scaleSpec(ell, shapeBox(ell), { x: 5, y: 5, w: 10, h: 5 })).toMatchObject({ x: 5, y: 5, w: 10, h: 5 });
    const line: ShapeSpec = { type: 'line', x1: 50, y1: 10, x2: 10, y2: 30, stroke: { enabled: true, color: { r: 0, g: 0, b: 0, a: 255 }, width: 4 }, arrowStart: false, arrowEnd: true };
    expect(shapeBox(line)).toEqual({ x: 10, y: 10, w: 40, h: 20 });
    expect(scaleSpec(line, shapeBox(line), { x: 0, y: 0, w: 80, h: 20 })).toMatchObject({ x1: 80, y1: 0, x2: 0, y2: 20 });
    const poly: ShapeSpec = { type: 'polygon', cx: 20, cy: 20, radius: 10, sides: 6, innerRatio: 1, fill: { enabled: true, color: { r: 1, g: 2, b: 3, a: 255 } }, stroke: { enabled: false, color: { r: 0, g: 0, b: 0, a: 255 }, width: 1 }, rotation: 0 };
    expect(shapeBox(poly)).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    expect(scaleSpec(poly, shapeBox(poly), { x: 0, y: 0, w: 80, h: 80 })).toMatchObject({ cx: 40, cy: 40, radius: 40 });
  });
});
