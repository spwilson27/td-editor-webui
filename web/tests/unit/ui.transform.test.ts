import { describe, expect, it } from 'vitest';
import type { ShapeSpec, TextSpec } from '../../src/engine/types';
import {
  IDENTITY, editBounds, handlePoint, hitBox, hitGuide, isIdentity, moveRect, remapShape, remapText, rulerStep, rulerTicks, scaleRect, transformFor,
} from '../../src/state/transform';

const R = { x: 100, y: 50, w: 200, h: 100 };
const rgba = { r: 0, g: 0, b: 0, a: 255 };

describe('transform box geometry', () => {
  it('handle points: corners, edge midpoints', () => {
    expect(handlePoint(R, 'nw')).toEqual({ x: 100, y: 50 });
    expect(handlePoint(R, 'se')).toEqual({ x: 300, y: 150 });
    expect(handlePoint(R, 'n')).toEqual({ x: 200, y: 50 });
    expect(handlePoint(R, 'e')).toEqual({ x: 300, y: 100 });
  });

  it('dragging a corner scales against the opposite corner', () => {
    expect(scaleRect(R, 'se', 100, 50, { shift: false, alt: false })).toEqual({ x: 100, y: 50, w: 300, h: 150 });
    expect(scaleRect(R, 'nw', -20, -10, { shift: false, alt: false })).toEqual({ x: 80, y: 40, w: 220, h: 110 });
    expect(scaleRect(R, 'nw', 50, 25, { shift: false, alt: false })).toEqual({ x: 150, y: 75, w: 150, h: 75 });
  });

  it('an edge handle only changes one dimension', () => {
    expect(scaleRect(R, 'e', 40, 999, { shift: false, alt: false })).toEqual({ x: 100, y: 50, w: 240, h: 100 });
    expect(scaleRect(R, 'n', 999, -30, { shift: false, alt: false })).toEqual({ x: 100, y: 20, w: 200, h: 130 });
  });

  it('Shift keeps the aspect ratio (corner: the larger change wins; edge: the other axis follows about the centre)', () => {
    const c = scaleRect(R, 'se', 100, 0, { shift: true, alt: false });
    expect(c.w / c.h).toBeCloseTo(2);
    expect(c).toEqual({ x: 100, y: 50, w: 300, h: 150 });
    const e = scaleRect(R, 'e', 100, 0, { shift: true, alt: false });
    expect(e.w / e.h).toBeCloseTo(2);
    expect(e.x).toBe(100);
    expect(e.y + e.h / 2).toBeCloseTo(100); // vertical centre unchanged
  });

  it('Alt scales about the centre', () => {
    expect(scaleRect(R, 'se', 20, 10, { shift: false, alt: true })).toEqual({ x: 80, y: 40, w: 240, h: 120 });
    expect(scaleRect(R, 'e', 50, 0, { shift: false, alt: true })).toEqual({ x: 50, y: 50, w: 300, h: 100 });
    const both = scaleRect(R, 'se', 40, 0, { shift: true, alt: true });
    expect(both.w / both.h).toBeCloseTo(2);
    expect(both.x + both.w / 2).toBeCloseTo(200);
    expect(both.y + both.h / 2).toBeCloseTo(100);
  });

  it('never collapses below the minimum size', () => {
    const r = scaleRect(R, 'se', -500, -500, { shift: false, alt: false });
    expect(r).toMatchObject({ x: 100, y: 50, w: 1, h: 1 });
    const l = scaleRect(R, 'w', 500, 0, { shift: false, alt: false });
    expect(l.w).toBe(1);
    expect(l.x + l.w).toBe(300);
  });

  it('moveRect translates', () => { expect(moveRect(R, 5, -5)).toEqual({ x: 105, y: 45, w: 200, h: 100 }); });
});

describe('mapping a layer onto new bounds', () => {
  it('isIdentity sees rotation and skew', () => {
    const id = { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 };
    expect(isIdentity({ ...id, rot: 1 })).toBe(false);
    expect(isIdentity({ ...id, kx: 1 })).toBe(false);
    expect(isIdentity({ ...id, ky: -1 })).toBe(false);
    expect(IDENTITY).toEqual(id);
  });

  it('transformFor: pixel layer scales about the box origin and follows it', () => {
    const t = { x: 100, y: 50, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 };
    expect(transformFor(t, R, { x: 100, y: 50, w: 400, h: 200 })).toEqual({ x: 100, y: 50, sx: 2, sy: 2, rot: 0, kx: 0, ky: 0 });
    expect(transformFor(t, R, { x: 10, y: 20, w: 200, h: 100 })).toEqual({ x: 10, y: 20, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
    expect(isIdentity({ x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 })).toBe(true);
    expect(isIdentity({ x: 0, y: 0, sx: 1.01, sy: 1, rot: 0, kx: 0, ky: 0 })).toBe(false);
  });

  const text: TextSpec = { text: 'Hi', font: 'Arial', size: 20, color: rgba, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 100, y: 50, boxWidth: 100 };
  it('text scales its font size, position and box width; a move leaves the size alone', () => {
    const big = remapText(text, R, { x: 100, y: 50, w: 400, h: 200 });
    expect(big).toMatchObject({ x: 100, y: 50, size: 40, boxWidth: 200 });
    expect(remapText(text, R, { x: 120, y: 70, w: 200, h: 100 })).toMatchObject({ x: 120, y: 70, size: 20, boxWidth: 100 });
    expect(remapText(text, R, { x: 100, y: 50, w: 400, h: 100 }).size).toBe(40); // one-axis change drives the size
  });

  const stroke = { enabled: true, color: rgba, width: 2 };
  const fill = { enabled: true, color: rgba };
  it('rect / ellipse / line / polygon scale their geometry', () => {
    const rect: ShapeSpec = { type: 'rect', x: 100, y: 50, w: 200, h: 100, radius: 10, fill, stroke, rotation: 0 };
    expect(remapShape(rect, R, { x: 0, y: 0, w: 100, h: 50 })).toMatchObject({ x: 0, y: 0, w: 100, h: 50 });
    const ell: ShapeSpec = { type: 'ellipse', x: 100, y: 50, w: 200, h: 100, fill, stroke, rotation: 0 };
    expect(remapShape(ell, R, { x: 100, y: 50, w: 400, h: 100 })).toMatchObject({ x: 100, y: 50, w: 400, h: 100 });
    const line: ShapeSpec = { type: 'line', x1: 100, y1: 50, x2: 300, y2: 150, stroke, arrowStart: false, arrowEnd: true };
    expect(remapShape(line, R, { x: 0, y: 0, w: 100, h: 50 })).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 50 });
    const poly: ShapeSpec = { type: 'polygon', cx: 200, cy: 100, radius: 50, sides: 5, innerRatio: 1, fill, stroke, rotation: 0 };
    expect(remapShape(poly, { x: 150, y: 50, w: 100, h: 100 }, { x: 150, y: 50, w: 200, h: 200 })).toMatchObject({ cx: 250, cy: 150, radius: 100 });
  });

  it('degenerate source bounds leave the layer alone', () => {
    const t = { x: 1, y: 2, sx: 3, sy: 4, rot: 0, kx: 0, ky: 0 };
    expect(transformFor(t, { x: 0, y: 0, w: 0, h: 5 }, R)).toBe(t);
  });
});

describe('context bar field edits', () => {
  it('x / y move, w / h resize from the top-left, aspect lock links them', () => {
    expect(editBounds(R, 'x', 7, true)).toEqual({ ...R, x: 7 });
    expect(editBounds(R, 'w', 400, false)).toEqual({ ...R, w: 400 });
    expect(editBounds(R, 'w', 400, true)).toEqual({ ...R, w: 400, h: 200 });
    expect(editBounds(R, 'h', 50, true)).toEqual({ ...R, w: 100, h: 50 });
    expect(editBounds(R, 'w', -3, false).w).toBe(1);
  });
});

describe('hit testing', () => {
  const view = { zoom: 2, x: 10, y: 20 };
  it('handles win over the body; outside is nothing', () => {
    const se = handlePoint(R, 'se');
    expect(hitBox(view, R, 10 + se.x * 2 + 3, 20 + se.y * 2 - 3)).toBe('se');
    expect(hitBox(view, R, 10 + 200 * 2, 20 + 100 * 2)).toBe('move');
    expect(hitBox(view, R, 0, 0)).toBeNull();
  });
  it('a box too small for its handles is moved by its body; a large one still scales by its handles', () => {
    const tiny = { x: 100, y: 100, w: 10, h: 10 };
    const low = { zoom: 0.5, x: 0, y: 0 };
    expect(hitBox(low, tiny, 52, 52)).toBe('move'); // the nw handle's tolerance box covers the whole body here
    expect(hitBox(low, tiny, 50, 50)).toBe('move');
    expect(hitBox(low, tiny, 80, 80)).toBeNull();
    expect(hitBox({ zoom: 2, x: 0, y: 0 }, R, 200, 100)).toBe('nw');
    expect(hitBox({ zoom: 2, x: 0, y: 0 }, R, 203, 103)).toBe('nw');
  });
  it('guides within the tolerance, nearest first', () => {
    const g = { h: [10, 12], v: [30] };
    expect(hitGuide(view, g, 500, 20 + 10 * 2 - 3)).toEqual({ axis: 'h', index: 0 });
    expect(hitGuide(view, g, 500, 20 + 12 * 2 + 1)).toEqual({ axis: 'h', index: 1 });
    expect(hitGuide(view, g, 10 + 30 * 2 - 2, 9999)).toEqual({ axis: 'v', index: 0 });
    expect(hitGuide(view, g, 500, 9999)).toBeNull();
  });
});

describe('ruler tick density', () => {
  it('the step is 1/2/5 x 10^n and at least ~60 px on screen', () => {
    for (const z of [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 16, 32]) {
      const step = rulerStep(z);
      expect(step * z).toBeGreaterThanOrEqual(60 - 1e-9);
      expect(step * z).toBeLessThan(160);
      expect(/^[125]0*$/.test(String(step)) || step < 1 || (step < 10 && [1, 2, 5].includes(step))).toBe(true);
    }
    expect(rulerStep(1)).toBe(100);
    expect(rulerStep(4)).toBe(20);
    expect(rulerStep(0.1)).toBe(1000);
  });
  it('ticks cover the visible range; majors sit on multiples of the step; zooming in adds minors', () => {
    const lo = rulerTicks(1, 50, 800), hi = rulerTicks(8, 50, 800);
    expect(lo.step).toBe(100);
    for (const t of lo.ticks.filter((x) => x.level === 0)) expect(t.pos % 100).toBe(0);
    expect(lo.ticks.find((t) => t.pos === 0)?.screen).toBe(50);
    expect(hi.step).toBeLessThan(lo.step);
    expect(hi.ticks.filter((t) => t.level !== 0).length).toBeGreaterThan(0);
    // minor ticks stay at least ~6 px apart
    const xs = hi.ticks.map((t) => t.screen);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(5.99);
  });
});
