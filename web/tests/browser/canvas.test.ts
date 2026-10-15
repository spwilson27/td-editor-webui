import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { PixelLayer } from '../../src/engine/model';
import type { Anchor, EngineEvent, TextSpec } from '../../src/engine/types';
import { brushCtx, collect, newEngine, px, rgba, setBase, slotOf, stroke, type Px } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const RED: Px = [255, 0, 0, 255];
const BLUE: Px = [0, 0, 255, 255];
const info = (id: string) => e.layers().find((l) => l.id === id)!;
const types = <T extends EngineEvent['type']>(ev: EngineEvent[], t: T) => ev.filter((x): x is Extract<EngineEvent, { type: T }> => x.type === t);
const text = (o: Partial<TextSpec> = {}): TextSpec => ({
  text: 'Hi', font: 'sans-serif', size: 20, color: rgba(0, 0, 0), align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 10, y: 12, boxWidth: null, ...o,
});

/** A pixel layer with a red 10x10 marker at its top-left, plus a text layer, a mask on an adjustment, guides, a selection. */
function scene(): { px: string; text: string; adj: string } {
  e = newEngine(100, 100);
  const p = e.addPixelLayer('marker');
  const l = e.doc.find(p) as PixelLayer;
  l.surface.ctx.fillStyle = 'rgb(255,0,0)';
  l.surface.ctx.fillRect(0, 0, 10, 10);
  e.changed({ x: 0, y: 0, w: 100, h: 100 });
  const t = e.addTextLayer(text());
  const adj = e.addAdjustment('invert');
  e.addMask(adj);
  e.setLayerProps(adj, { visible: false }); // its mask is what the tests look at, not an inverted picture
  e.addGuide('h', 30);
  e.addGuide('v', 40);
  e.setSelection({ x: 20, y: 20, w: 30, h: 30 });
  return { px: p, text: t, adj };
}

describe('canvas size: anchors, no resampling', () => {
  const cases: Array<[Anchor, number, number]> = [
    ['tl', 0, 0], ['t', 25, 0], ['tr', 50, 0],
    ['l', 0, 10], ['c', 25, 10], ['r', 50, 10],
    ['bl', 0, 20], ['b', 25, 20], ['br', 50, 20],
  ];
  for (const [a, dx, dy] of cases) {
    it(`grow 100x100 -> 150x120, anchor ${a}: content moves by (${dx}, ${dy})`, () => {
      const s = scene();
      const slot = slotOf(e, s.px);
      const before = e.readSurface(slot, { x: 0, y: 0, w: 100, h: 100 });
      const ev = collect(e);
      e.setCanvasSize(150, 120, a);
      expect([e.width, e.height]).toEqual([150, 120]);
      expect(e.docSpec()).toMatchObject({ width: 150, height: 120, canvas: { mode: 'fixed' } });
      expect(info(s.px)).toMatchObject({ surfaceW: 100, surfaceH: 100, transform: { x: dx, y: dy, sx: 1, sy: 1 } });
      expect(Array.from(e.readSurface(slot, { x: 0, y: 0, w: 100, h: 100 }))).toEqual(Array.from(before)); // not one pixel touched
      expect(info('base')).toMatchObject({ transform: { x: dx, y: dy, sx: 1, sy: 1 } });
      expect(px(e, dx + 5, dy + 5)).toEqual(RED);
      expect(px(e, dx + 12, dy + 12)[3]).toBe(0);
      expect(info(s.text).text).toMatchObject({ x: 10 + dx, y: 12 + dy });
      expect(e.guides()).toEqual({ h: [30 + dy], v: [40 + dx] });
      expect(e.selection()).toEqual({ x: 20 + dx, y: 20 + dy, w: 30, h: 30 });
      expect(types(ev, 'resize')).toEqual([{ type: 'resize', width: 150, height: 120 }]);
      expect(types(ev, 'selection').length).toBe(dx || dy ? 1 : 0);
      expect(types(ev, 'docspec').length).toBeGreaterThan(0);
      expect(e.history().entries.slice(-1)[0].label).toBe('Canvas size');
      e.undo();
      expect([e.width, e.height]).toEqual([100, 100]);
      expect(info(s.px).transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
      expect(info(s.text).text).toMatchObject({ x: 10, y: 12 });
      expect(e.guides()).toEqual({ h: [30], v: [40] });
      expect(e.selection()).toEqual({ x: 20, y: 20, w: 30, h: 30 });
      expect(e.canvasMode()).toBe('input');
      expect(px(e, 5, 5)).toEqual(RED);
      e.redo();
      expect([e.width, e.height]).toEqual([150, 120]);
      expect(info(s.px).transform).toMatchObject({ x: dx, y: dy });
      expect(e.guides()).toEqual({ h: [30 + dy], v: [40 + dx] });
      expect(e.canvasMode()).toBe('fixed');
    });
  }

  const frac: Record<Anchor, [number, number]> = { tl: [0, 0], t: [0.5, 0], tr: [1, 0], l: [0, 0.5], c: [0.5, 0.5], r: [1, 0.5], bl: [0, 1], b: [0.5, 1], br: [1, 1] };
  for (const a of Object.keys(frac) as Anchor[]) {
    const mx = Math.round(-50 * frac[a][0]) || 0;
    const my = Math.round(-40 * frac[a][1]) || 0;
    it(`shrink 100x100 -> 50x60, anchor ${a}: content moves by (${mx}, ${my}) and keeps its whole surface`, () => {
      const s = scene();
      e.setCanvasSize(50, 60, a);
      expect(info(s.px)).toMatchObject({ surfaceW: 100, surfaceH: 100, transform: { x: mx, y: my } });
      expect(info(s.text).text).toMatchObject({ x: 10 + mx, y: 12 + my });
      expect(e.guides()).toEqual({ h: [30 + my], v: [40 + mx] });
      // the marker (surface px 0..9) is visible only when it stays inside the cropped canvas
      expect(px(e, 5 + mx, 5 + my)[3]).toBe(5 + mx >= 0 && 5 + my >= 0 ? 255 : 0);
      e.undo();
      expect([e.width, e.height]).toEqual([100, 100]);
      expect(px(e, 5, 5)).toEqual(RED); // nothing was cropped away
    });
  }

  it('document-space masks are reallocated at the new size, old content shifted; undo restores them', () => {
    const s = scene();
    const m = info(s.adj).mask!.slot;
    e.writeSurface(m, { x: 0, y: 0, w: 10, h: 10 }, new Uint8Array(10 * 10 * 4)); // top-left 10x10 hidden
    e.commitSurfaces();
    const ev = collect(e);
    e.setCanvasSize(130, 100, 'tr'); // dx = 30
    expect(e.readSurface(m, { x: 0, y: 0, w: 130, h: 100 }).length).toBe(130 * 100 * 4);
    expect(e.readSurface(m, { x: 35, y: 5, w: 1, h: 1 })[0]).toBe(0); // the hidden block moved with the content
    expect(e.readSurface(m, { x: 5, y: 5, w: 1, h: 1 })[0]).toBe(255); // new area visible
    expect(e.readSurface(m, { x: 60, y: 60, w: 1, h: 1 })[0]).toBe(255);
    expect(types(ev, 'surface').some((x) => x.slot === m && x.rect.w === 130)).toBe(true);
    e.undo();
    expect(e.readSurface(m, { x: 5, y: 5, w: 1, h: 1 })[0]).toBe(0);
    expect(e.readSurface(m, { x: 0, y: 0, w: 100, h: 100 }).length).toBe(100 * 100 * 4);
  });

  it('a same-size call only flips the mode (once); a second identical call is a no-op', () => {
    e = newEngine(80, 60);
    const n = e.history().entries.length;
    e.setCanvasSize(80, 60, 'c');
    expect(e.canvasMode()).toBe('fixed');
    expect(e.history().entries.length).toBe(n + 1);
    e.setCanvasSize(80, 60, 'c');
    expect(e.history().entries.length).toBe(n + 1);
    e.setCanvasSize(NaN, 0, 'tl'); // clamped to 1 x 1, not rejected
    expect([e.width, e.height]).toEqual([1, 1]);
  });

  it('painting and compositing work on the resized canvas; new layers are document sized', () => {
    e = newEngine(40, 40);
    setBase(e, BLUE);
    e.setCanvasSize(60, 40, 'r'); // dx = 20
    expect(px(e, 25, 5)).toEqual(BLUE);
    expect(px(e, 10, 5)[3]).toBe(0);
    const id = e.addPixelLayer();
    expect(info(id)).toMatchObject({ surfaceW: 60, surfaceH: 40 });
    expect(e.readComposite({ x: 0, y: 0, w: 60, h: 40 }).length).toBe(60 * 40 * 4);
  });

  it('resize() (TD docSize) keeps surfaces, anchors top-left and clears history; adoptCanvas also sets the mode', () => {
    const s = scene();
    e.resize(120, 90);
    expect(info(s.px)).toMatchObject({ surfaceW: 100, surfaceH: 100, transform: { x: 0, y: 0 } });
    expect(e.history().entries).toHaveLength(0);
    expect(e.canvasMode()).toBe('input');
    expect(e.guides()).toEqual({ h: [30], v: [40] });
    expect(px(e, 5, 5)).toEqual(RED);
    e.adoptCanvas(64, 64, 'fixed');
    expect([e.width, e.height, e.canvasMode()]).toEqual([64, 64, 'fixed']);
    expect(e.docSpec().canvas).toEqual({ mode: 'fixed' });
    expect(e.history().entries).toHaveLength(0);
    e.adoptCanvas(64, 64, 'input');
    expect(e.canvasMode()).toBe('input');
  });

  it('adoptCanvas reallocates untouched empty document-sized layers, not painted ones', () => {
    e = newEngine(200, 100);
    const empty = e.addPixelLayer();
    const painted = e.addPixelLayer();
    e.setActiveLayer(painted);
    e.setToolContext(brushCtx());
    stroke(e, 'brush', [[20, 20]]);
    e.adoptCanvas(80, 40, 'input');
    expect(info(empty)).toMatchObject({ surfaceW: 80, surfaceH: 40 });
    expect(info(painted)).toMatchObject({ surfaceW: 200, surfaceH: 100 });
  });

  it('layers still waiting for TD pixels after a load are not reallocated (pristine is explicit, not "all transparent")', () => {
    e = newEngine(200, 100);
    e.addPixelLayer();
    const spec = JSON.parse(JSON.stringify(e.docSpec()));
    e.loadDocument(spec);
    const id = e.layers()[0].id;
    e.adoptCanvas(80, 40, 'input');
    expect(info(id)).toMatchObject({ surfaceW: 200, surfaceH: 100 });
    // writing pixels (TD upload) also clears the flag
    const f = newEngine(100, 50);
    const l = f.addPixelLayer();
    f.writeSurface(f.layers()[0].slot!, { x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([0, 0, 0, 0]));
    f.adoptCanvas(10, 10, 'input');
    expect(f.layers().find((x) => x.id === l)).toMatchObject({ surfaceW: 100, surfaceH: 50 });
    f.dispose();
  });
});

describe('misc engine API', () => {
  it('docRev follows docSpec().rev without building a spec', () => {
    e = newEngine(50, 50);
    const r = e.docRev!();
    expect(r).toBe(e.docSpec().rev);
    e.addGuide('h', 5);
    expect(e.docRev!()).toBeGreaterThan(r);
    expect(e.docRev!()).toBe(e.docSpec().rev);
  });
});

describe('canvas mode', () => {
  it('follows the input by default; fixed once a size is set; Follow Input returns to the base size with an identity base', () => {
    e = newEngine(100, 100);
    expect(e.canvasMode()).toBe('input');
    expect(e.docSpec().canvas).toEqual({ mode: 'input' });
    e.setBaseSize(80, 60);
    e.setCanvasSize(200, 200, 'c');
    expect(e.canvasMode()).toBe('fixed');
    e.setTransform('base', { x: 10, y: 10, sx: 2, sy: 2 });
    const n = e.history().entries.length;
    e.setCanvasMode('input');
    expect([e.width, e.height, e.canvasMode()]).toEqual([80, 60, 'input']);
    expect(info('base').transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
    expect(e.history().entries).toHaveLength(n + 1);
    expect(e.history().entries.slice(-1)[0].label).toBe('Follow input size');
    e.undo();
    expect([e.width, e.height, e.canvasMode()]).toEqual([200, 200, 'fixed']);
    expect(info('base').transform).toEqual({ x: 10, y: 10, sx: 2, sy: 2 });
    e.redo();
    expect([e.width, e.height]).toEqual([80, 60]);
    e.setCanvasMode('input'); // already following: nothing
    expect(e.history().entries).toHaveLength(n + 1);
    e.setCanvasMode('fixed');
    expect([e.width, e.height, e.canvasMode()]).toEqual([80, 60, 'fixed']);
  });

  it('Follow Input without an input keeps the size', () => {
    e = newEngine(100, 50);
    e.setBaseSize(0, 0);
    e.setCanvasSize(70, 70, 'tl');
    e.setCanvasMode('input');
    expect([e.width, e.height]).toEqual([70, 70]);
  });
});

describe('guides', () => {
  it('add / move / remove with history, docspec events and copies', () => {
    e = newEngine(100, 100);
    const ev = collect(e);
    const rev = e.docSpec().rev;
    e.addGuide('h', 25);
    e.addGuide('v', 10);
    e.addGuide('v', 70);
    expect(e.guides()).toEqual({ h: [25], v: [10, 70] });
    expect(e.docSpec().guides).toEqual({ h: [25], v: [10, 70] });
    expect(e.docSpec().rev).toBeGreaterThanOrEqual(rev + 3);
    expect(types(ev, 'docspec').length).toBeGreaterThanOrEqual(3);
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add guide', 'Add guide', 'Add guide']);
    const g = e.guides();
    g.v.push(999); // a copy
    expect(e.guides().v).toEqual([10, 70]);
    // a drag of one guide is a single history entry
    for (const p of [72, 75, 80, 85]) e.moveGuide('v', 1, p);
    expect(e.guides().v).toEqual([10, 85]);
    expect(e.history().entries).toHaveLength(4);
    expect(e.history().entries[3].label).toBe('Move guide');
    e.removeGuide('v', 0);
    expect(e.guides()).toEqual({ h: [25], v: [85] });
    expect(e.history().entries).toHaveLength(5);
    e.undo();
    expect(e.guides()).toEqual({ h: [25], v: [10, 85] });
    e.undo();
    expect(e.guides()).toEqual({ h: [25], v: [10, 70] });
    e.undo();
    e.undo();
    e.undo();
    expect(e.guides()).toEqual({ h: [], v: [] });
    e.jumpTo(4);
    expect(e.guides()).toEqual({ h: [25], v: [85] });
    expect(e.history().index).toBe(4);
  });

  it('ignores bad input and unknown indices; emits docspec only when something changed', () => {
    e = newEngine(50, 50);
    e.addGuide('h', 10);
    const n = e.history().entries.length;
    const ev = collect(e);
    e.addGuide('h', NaN);
    e.addGuide('v', Infinity);
    e.moveGuide('h', 5, 3);
    e.moveGuide('h', -1, 3);
    e.moveGuide('h', 0, NaN);
    e.moveGuide('h', 0, 10); // same position
    e.moveGuide('h', 0.5, 3);
    e.removeGuide('v', 0);
    e.removeGuide('h', 3);
    expect(e.history().entries).toHaveLength(n);
    expect(ev).toEqual([]);
    expect(e.guides()).toEqual({ h: [10], v: [] });
  });

  it('guides survive docSpec -> loadDocument and live outside the canvas too', () => {
    e = newEngine(50, 50);
    e.addGuide('h', -12);
    e.addGuide('v', 77.5);
    const spec = JSON.parse(JSON.stringify(e.docSpec()));
    const e2 = newEngine(10, 10);
    e2.loadDocument(spec);
    expect(e2.guides()).toEqual({ h: [-12], v: [77.5] });
    expect(e2.history().entries).toHaveLength(0);
    e2.dispose();
  });
});

describe('snapping', () => {
  const on = (o: Partial<Parameters<Engine['setSnap']>[0]> = {}): void =>
    e.setSnap({ enabled: true, guides: true, canvas: true, layers: true, threshold: 6, ...o });

  it('does nothing while disabled (the default)', () => {
    e = newEngine(100, 80);
    e.addGuide('v', 50);
    expect(e.snapPoint(51, 1, 1)).toEqual({ x: 51, y: 1, guideX: null, guideY: null });
    expect(e.snapRect({ x: 49, y: 0, w: 10, h: 10 }, 1)).toEqual({ dx: 0, dy: 0, guideX: null, guideY: null });
  });

  it('snaps points to guides within threshold / zoom', () => {
    e = newEngine(1000, 800);
    e.addGuide('v', 500);
    e.addGuide('h', 300);
    on({ canvas: false, layers: false });
    expect(e.snapPoint(503, 298, 1)).toEqual({ x: 500, y: 300, guideX: 500, guideY: 300 });
    expect(e.snapPoint(507, 292, 1)).toEqual({ x: 507, y: 292, guideX: null, guideY: null }); // 7 and 8 px away, threshold 6
    expect(e.snapPoint(510, 300, 0.5)).toEqual({ x: 500, y: 300, guideX: 500, guideY: 300 }); // zoomed out: 12 document px
    expect(e.snapPoint(504, 300, 2)).toEqual({ x: 504, y: 300, guideX: null, guideY: 300 }); // zoomed in: 3 document px
    expect(e.snapPoint(503, 300, 2)).toEqual({ x: 500, y: 300, guideX: 500, guideY: 300 });
    expect(e.snapPoint(503, 298, 0)).toEqual({ x: 503, y: 298, guideX: null, guideY: null }); // nonsense zoom: off
    // the two axes are independent
    expect(e.snapPoint(503, 100, 1)).toEqual({ x: 500, y: 100, guideX: 500, guideY: null });
  });

  it('snaps to the canvas edges and centre', () => {
    e = newEngine(100, 80);
    on({ guides: false, layers: false });
    expect(e.snapPoint(98, 41, 1)).toEqual({ x: 100, y: 40, guideX: 100, guideY: 40 });
    expect(e.snapPoint(2, 78, 1)).toEqual({ x: 0, y: 80, guideX: 0, guideY: 80 });
    expect(e.snapPoint(52, 3, 1)).toEqual({ x: 50, y: 0, guideX: 50, guideY: 0 });
    on({ guides: false, layers: false, canvas: false });
    expect(e.snapPoint(98, 41, 1)).toEqual({ x: 98, y: 41, guideX: null, guideY: null });
  });

  it("snaps to other layers' bounds (edges and centres) but not to the active layer's own", () => {
    e = newEngine(400, 400);
    const other = e.addPixelLayer('o');
    e.doc.find(other); // 400x400 surface: bounds = the canvas; shrink it with a transform
    e.setTransform(other, { x: 100, y: 120, sx: 0.5, sy: 0.25 }); // bounds 100..300 x 120..220
    const mine = e.addPixelLayer('mine'); // active
    e.setTransform(mine, { x: 10, y: 10, sx: 0.1, sy: 0.1 });
    on({ guides: false, canvas: false });
    expect(e.snapPoint(103, 223, 1)).toMatchObject({ x: 100, y: 220, guideX: 100, guideY: 220 });
    expect(e.snapPoint(198, 172, 1)).toMatchObject({ x: 200, y: 170 }); // centres
    expect(e.snapPoint(12, 12, 1)).toMatchObject({ guideX: null, guideY: null }); // its own bounds (10..50) are ignored
    e.setActiveLayer(other);
    expect(e.snapPoint(12, 12, 1)).toMatchObject({ x: 10, y: 10 }); // ...but others see them
    e.setLayerProps(mine, { visible: false });
    expect(e.snapPoint(12, 12, 1)).toMatchObject({ guideX: null }); // hidden layers do not attract
  });

  it('snapRect aligns the left / centre / right (top / middle / bottom) edge that is nearest to a line', () => {
    e = newEngine(1000, 800);
    e.addGuide('v', 500);
    e.addGuide('v', 640);
    e.addGuide('h', 100);
    on({ canvas: false, layers: false });
    // left 497 (-3 from 500), centre 502, right 507: the centre is nearest -> dx = -2
    expect(e.snapRect({ x: 497, y: 400, w: 10, h: 10 }, 1)).toEqual({ dx: -3 + 1, dy: 0, guideX: 500, guideY: null });
    // right edge near the second guide
    expect(e.snapRect({ x: 628, y: 94, w: 10, h: 10 }, 1)).toEqual({ dx: 2, dy: 1, guideX: 640, guideY: 100 }); // right 638 -> 640; middle y 99 -> 100
    expect(e.snapRect({ x: 200, y: 400, w: 10, h: 10 }, 1)).toEqual({ dx: 0, dy: 0, guideX: null, guideY: null });
    // the closest of several candidates wins
    on({ canvas: false, layers: false, threshold: 20 });
    expect(e.snapRect({ x: 630, y: 0, w: 4, h: 4 }, 1)).toMatchObject({ dx: 6, guideX: 640 }); // right 634 -> 640 (6) beats centre 632 (8) and left 630 (10)
    expect(e.snapRect({ x: 630, y: 400, w: 4, h: 4 }, 2)).toMatchObject({ dx: 6, guideX: 640 }); // threshold 10 document px at zoom 2
    expect(e.snapRect({ x: 600, y: 400, w: 4, h: 4 }, 2)).toMatchObject({ dx: 0, guideX: null }); // right edge 604 is 36 px from the nearest line
  });

  it('setSnap sanitises its options', () => {
    e = newEngine(100, 100);
    e.setSnap({ enabled: true, guides: false, canvas: true, layers: false, threshold: -4 });
    expect(e.snapPoint(0.4, 0, 1)).toMatchObject({ x: 0.4 }); // threshold clamps to 0: only exact hits
    expect(e.snapPoint(0, 0, 1)).toMatchObject({ x: 0, guideX: 0, guideY: 0 });
  });
});
