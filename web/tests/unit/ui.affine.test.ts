import { describe, expect, it } from 'vitest';
import type { LayerTransform } from '../../src/engine/types';
import {
  ROTATE_CURSOR, aabbOf, boxAabb, boxCorners, centreOfBox, cursorFor, docToSurface, handlePoints, hitOriented, invertAff, keepCentre,
  matrixOf, normDeg, rotateDrag, scaleDrag, skewDrag, surfaceToDoc,
} from '../../src/state/affine';

const T = (p: Partial<LayerTransform> = {}): LayerTransform => ({ x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, ...p });
const near = (a: { x: number; y: number }, b: { x: number; y: number }, d = 1e-6) => { expect(a.x).toBeCloseTo(b.x, d > 1e-3 ? 0 : 5); expect(a.y).toBeCloseTo(b.y, d > 1e-3 ? 0 : 5); };

describe('matrixOf / mapping', () => {
  it('identity and translate+scale', () => {
    near(surfaceToDoc(T(), 3, 4), { x: 3, y: 4 });
    near(surfaceToDoc(T({ x: 10, y: 20, sx: 2, sy: 3 }), 5, 5), { x: 20, y: 35 });
  });
  it('rotation is clockwise on screen (y down) about the surface top-left', () => {
    near(surfaceToDoc(T({ rot: 90 }), 10, 0), { x: 0, y: 10 }); // +x axis turns to +y (down)
    near(surfaceToDoc(T({ rot: 90 }), 0, 10), { x: -10, y: 0 });
    near(surfaceToDoc(T({ x: 5, y: 5, rot: 180 }), 10, 10), { x: -5, y: -5 });
  });
  it('skew: kx shears x by y, ky shears y by x', () => {
    near(surfaceToDoc(T({ kx: 45 }), 0, 10), { x: 10, y: 10 });
    near(surfaceToDoc(T({ ky: 45 }), 10, 0), { x: 10, y: 10 });
  });
  it('order is T·R·K·S: scale first, then skew, then rotate', () => {
    const t = T({ sx: 2, sy: 1, kx: 45, rot: 90 });
    // (1,1) -> S (2,1) -> K (2+1, 1) = (3,1) -> R90 (-1, 3)
    near(surfaceToDoc(t, 1, 1), { x: -1, y: 3 });
  });
  it('invert round-trips', () => {
    const t = T({ x: 7, y: -3, sx: 1.5, sy: 0.5, rot: 33, kx: 12, ky: -8 });
    const p = surfaceToDoc(t, 13, 29), q = docToSurface(t, p.x, p.y)!;
    near(q, { x: 13, y: 29 });
    expect(invertAff({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toBeNull();
  });
});

describe('box geometry', () => {
  it('corners, handles, centre, aabb of a rotated box', () => {
    const t = T({ x: 100, y: 100, rot: 90 });
    const [tl, tr, br, bl] = boxCorners(t, 40, 20);
    near(tl, { x: 100, y: 100 }); near(tr, { x: 100, y: 140 }); near(br, { x: 80, y: 140 }); near(bl, { x: 80, y: 100 });
    near(centreOfBox(t, 40, 20), { x: 90, y: 120 });
    const hp = handlePoints(t, 40, 20);
    near(hp.n, { x: 100, y: 120 }); near(hp.e, { x: 90, y: 140 }); near(hp.se, br);
    expect(boxAabb(t, 40, 20)).toEqual({ x: 80, y: 100, w: 20, h: 40 });
    expect(aabbOf([{ x: 1, y: 5 }, { x: -2, y: 3 }])).toEqual({ x: -2, y: 3, w: 3, h: 2 });
  });
  it('matrixOf of a scaled box has the right columns', () => {
    const m = matrixOf(T({ sx: 2, sy: 3 }));
    expect([m.a, m.b, m.c, m.d]).toEqual([2, 0, 0, 3]);
  });
});

describe('keepCentre / normDeg', () => {
  it('rotating via keepCentre leaves the visual centre fixed', () => {
    const t = T({ x: 20, y: 10, sx: 2 });
    const c = centreOfBox(t, 100, 50);
    for (const rot of [15, 90, -37, 180]) near(centreOfBox(keepCentre(t, 100, 50, { rot }), 100, 50), c);
  });
  it('normalises degrees into (-180, 180]', () => {
    expect(normDeg(190)).toBe(-170); expect(normDeg(-190)).toBe(170); expect(normDeg(360)).toBe(0); expect(normDeg(180)).toBe(180); expect(normDeg(-180)).toBe(180);
  });
});

describe('rotateDrag', () => {
  const t = T({ x: 100, y: 100 });
  it('turns by the pointer angle about the centre, clockwise on screen', () => {
    const c = centreOfBox(t, 100, 50); // (150, 125)
    const r = rotateDrag(t, 100, 50, { x: c.x + 50, y: c.y }, { x: c.x, y: c.y + 50 }, false);
    expect(r.rot).toBeCloseTo(90);
    near(centreOfBox(r, 100, 50), c);
  });
  it('Shift snaps the absolute angle to 15 degrees', () => {
    const c = centreOfBox(t, 100, 50);
    const a = 20 * Math.PI / 180;
    const r = rotateDrag(t, 100, 50, { x: c.x + 50, y: c.y }, { x: c.x + 50 * Math.cos(a), y: c.y + 50 * Math.sin(a) }, true);
    expect(r.rot).toBe(15);
    const r2 = rotateDrag(T({ x: 100, y: 100, rot: 10 }), 100, 50, { x: c.x + 50, y: c.y }, { x: c.x + 50, y: c.y }, true);
    expect(r2.rot).toBe(15); // 10 -> nearest multiple
  });
  it('keeps scale and skew', () => {
    const s = T({ sx: 2, sy: 1.5, kx: 10 });
    const r = rotateDrag(s, 10, 10, { x: 5, y: 0 }, { x: 0, y: 5 }, false);
    expect([r.sx, r.sy, r.kx, r.ky]).toEqual([2, 1.5, 10, 0]);
  });
});

describe('scaleDrag', () => {
  it('matches a plain rect scale when unrotated', () => {
    const r = scaleDrag(T({ x: 20, y: 10 }), 100, 50, 'se', 50, 25, { shift: false, alt: false });
    expect(r).toMatchObject({ x: 20, y: 10, sx: 1.5, sy: 1.5 });
    const w = scaleDrag(T({ x: 20, y: 10 }), 100, 50, 'nw', -10, -10, { shift: false, alt: false });
    expect(w).toMatchObject({ x: 10, y: 0, sx: 1.1, sy: 1.2 });
  });
  it('works in layer space on a rotated box: dragging the east handle along the rotated x axis', () => {
    const t = T({ x: 100, y: 100, rot: 90 }); // layer x axis points down in the doc
    const r = scaleDrag(t, 100, 50, 'e', 0, 50, { shift: false, alt: false }); // drag east handle 50 px down
    expect(r.sx).toBeCloseTo(1.5); expect(r.sy).toBeCloseTo(1);
    near({ x: r.x, y: r.y }, { x: 100, y: 100 }); // the west edge (origin) stays put
    const h = scaleDrag(t, 100, 50, 'e', 50, 0, { shift: false, alt: false }); // sideways drag is perpendicular: no change
    expect(h.sx).toBeCloseTo(1);
  });
  it('the opposite corner stays fixed on rotated + skewed boxes (and about the centre with Alt)', () => {
    const t = T({ x: 50, y: 40, sx: 1.2, rot: 25, kx: 15 });
    const before = handlePoints(t, 80, 60);
    const r = scaleDrag(t, 80, 60, 'se', 17, 9, { shift: false, alt: false });
    near(handlePoints(r, 80, 60).nw, before.nw);
    const a = scaleDrag(t, 80, 60, 'se', 17, 9, { shift: false, alt: true });
    near(centreOfBox(a, 80, 60), centreOfBox(t, 80, 60));
  });
  it('the dragged corner follows the pointer', () => {
    const t = T({ x: 50, y: 40, rot: 30 });
    const p = handlePoints(t, 80, 60).se;
    const r = scaleDrag(t, 80, 60, 'se', 10, -4, { shift: false, alt: false });
    near(handlePoints(r, 80, 60).se, { x: p.x + 10, y: p.y - 4 });
  });
  it('Shift keeps the aspect ratio', () => {
    const r = scaleDrag(T({ rot: 40, x: 10, y: 10 }), 100, 50, 'se', 30, 0, { shift: true, alt: false });
    expect(r.sx / r.sy).toBeCloseTo(1);
  });
});

describe('skewDrag', () => {
  it('n/s edge -> kx, e/w edge -> ky', () => {
    const t = T({ x: 10, y: 10 });
    const s = skewDrag(t, 100, 50, 's', 25, 0); // bottom edge moves right by 25 over half-height 25 -> tan = 1
    expect(s.kx).toBeCloseTo(45); expect(s.ky).toBe(0);
    const n = skewDrag(t, 100, 50, 'n', 25, 0); // top edge moves right: opposite sign
    expect(n.kx).toBeCloseTo(-45);
    const e = skewDrag(t, 100, 50, 'e', 0, 50); // right edge moves down by 50 over half-width 50 -> 45 deg
    expect(e.ky).toBeCloseTo(45); expect(e.kx).toBe(0);
    const w = skewDrag(t, 100, 50, 'w', 0, 50);
    expect(w.ky).toBeCloseTo(-45);
  });
  it('skews about the centre and ignores corners', () => {
    const t = T({ x: 10, y: 10, rot: 20 });
    const s = skewDrag(t, 100, 50, 's', 12, 3);
    near(centreOfBox(s, 100, 50), centreOfBox(t, 100, 50));
    expect(skewDrag(t, 100, 50, 'se', 12, 3)).toBe(t);
  });
  it('the dragged edge handle follows the pointer along the edge direction', () => {
    const t = T({ x: 10, y: 10, rot: 30 });
    const p = handlePoints(t, 100, 50).s;
    const dir = { x: Math.cos(30 * Math.PI / 180), y: Math.sin(30 * Math.PI / 180) };
    const s = skewDrag(t, 100, 50, 's', dir.x * 8, dir.y * 8);
    const q = handlePoints(s, 100, 50).s;
    // the handle (a point on the south edge middle) moved ~8 px along the rotated x axis, relative to the fixed centre
    expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThan(5);
  });
  it('clamps the skew angle and refuses a collapsing box', () => {
    const s = skewDrag(T(), 100, 50, 's', 1e6, 0);
    expect(s.kx).toBeLessThanOrEqual(85.0001);
    const both = skewDrag(T({ kx: 85, ky: 85 }), 100, 50, 's', 5, 0);
    expect(both.kx).toBe(85);
  });
});

describe('hitOriented', () => {
  const view = { zoom: 2, x: 10, y: 10 };
  const t = T({ x: 50, y: 50, rot: 45 });
  const scr = (p: { x: number; y: number }): [number, number] => [view.x + p.x * view.zoom, view.y + p.y * view.zoom];
  it('hits rotated handles where they are drawn, not at the AABB corners', () => {
    const hp = handlePoints(t, 100, 60);
    expect(hitOriented(view, t, 100, 60, ...scr(hp.se))).toBe('se');
    expect(hitOriented(view, t, 100, 60, ...scr(hp.n))).toBe('n');
    const ab = boxAabb(t, 100, 60);
    expect(hitOriented(view, t, 100, 60, ...scr({ x: ab.x + ab.w - 2, y: ab.y + 2 }))).not.toBe('ne');
  });
  it('inside is move; just outside a corner is rotate; far away is nothing', () => {
    const c = centreOfBox(t, 100, 60);
    expect(hitOriented(view, t, 100, 60, ...scr(c))).toBe('move');
    const hp = handlePoints(t, 100, 60), cc = c;
    const dir = { x: hp.se.x - cc.x, y: hp.se.y - cc.y }, len = Math.hypot(dir.x, dir.y);
    const out = { x: hp.se.x + (dir.x / len) * 10 / view.zoom, y: hp.se.y + (dir.y / len) * 10 / view.zoom };
    expect(hitOriented(view, t, 100, 60, ...scr(out))).toBe('rotate');
    const far = { x: hp.se.x + (dir.x / len) * 80, y: hp.se.y + (dir.y / len) * 80 };
    expect(hitOriented(view, t, 100, 60, ...scr(far))).toBeNull();
  });
  it('a point inside the AABB but outside the rotated box is not a move', () => {
    const ab = boxAabb(t, 100, 60);
    const p = { x: ab.x + 3, y: ab.y + 3 }; // AABB corner region, outside the diamond
    expect(hitOriented(view, t, 100, 60, ...scr(p))).not.toBe('move');
  });
  it('a tiny box is all body', () => {
    expect(hitOriented({ zoom: 1, x: 0, y: 0 }, T({ x: 10, y: 10 }), 8, 8, 14, 14)).toBe('move');
  });
});

describe('cursorFor', () => {
  it('maps hits to cursors, turning resize cursors with the box', () => {
    expect(cursorFor(null, T(), 10, 10)).toBe('default');
    expect(cursorFor('move', T(), 10, 10)).toBe('move');
    expect(cursorFor('rotate', T(), 10, 10)).toBe(ROTATE_CURSOR);
    expect(ROTATE_CURSOR).toMatch(/^url\(/);
    expect(cursorFor('e', T(), 100, 50)).toBe('ew-resize');
    expect(cursorFor('n', T(), 100, 50)).toBe('ns-resize');
    expect(cursorFor('e', T({ rot: 90 }), 100, 50)).toBe('ns-resize');
    expect(cursorFor('se', T(), 100, 100)).toBe('nwse-resize');
    expect(cursorFor('ne', T(), 100, 100)).toBe('nesw-resize');
    expect(cursorFor('se', T({ rot: 90 }), 100, 100)).toBe('nesw-resize');
  });
  it('Ctrl over an edge handle is a skew cursor along the edge', () => {
    expect(cursorFor('n', T(), 100, 50, true)).toBe('ew-resize');
    expect(cursorFor('e', T(), 100, 50, true)).toBe('ns-resize');
    expect(cursorFor('se', T(), 100, 100, true)).toBe('nwse-resize'); // corners ignore Ctrl
  });
});
