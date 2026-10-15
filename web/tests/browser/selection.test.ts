import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { EngineEvent, SelectionOptions } from '../../src/engine/types';
import { brushCtx, collect, drawRect, layerPx, maskAt, near, newEngine, ptr, px, rgba, setBase, slotPx, solidLayer, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const OPTS: SelectionOptions = { mode: 'new', feather: 0, antialias: true, wandTolerance: 0, wandContiguous: true, wandSampleAll: false };
const setOpts = (o: Partial<SelectionOptions> = {}): void => e.setSelectionOptions({ ...OPTS, ...o });
const cov = (x: number, y: number): number => (e.selectionMask()?.alpha[y * e.width + x] ?? 0);
const area = (): number => {
  const m = e.selectionMask();
  if (!m) return 0;
  let n = 0;
  m.alpha.forEach((v) => (n += v));
  return n / 255;
};
const marquee = (x0: number, y0: number, x1: number, y1: number, mod: { shift?: boolean; alt?: boolean } = {}): void => stroke(e, 'marquee', [[x0, y0], [x1, y1]], mod);

describe('marquee modes', () => {
  it('new replaces; options.mode applies without modifiers', () => {
    e = newEngine(100, 100);
    setOpts();
    marquee(10, 10, 30, 30);
    marquee(50, 50, 60, 60);
    expect(e.selection()).toEqual({ x: 50, y: 50, w: 10, h: 10 });
    expect(area()).toBe(100);
    setOpts({ mode: 'add' });
    marquee(10, 10, 20, 20);
    expect(e.selection()).toEqual({ x: 10, y: 10, w: 50, h: 50 });
    expect(area()).toBe(200);
  });

  it('shift = add, alt = subtract, shift+alt = intersect, overriding options.mode', () => {
    e = newEngine(100, 100);
    setOpts({ mode: 'intersect' }); // would replace alone
    marquee(10, 10, 30, 30);
    expect(area()).toBe(400);
    marquee(50, 10, 70, 30, { shift: true });
    expect(area()).toBe(800);
    expect(cov(60, 20)).toBe(255);
    expect(cov(40, 20)).toBe(0);
    setOpts({ mode: 'new' });
    marquee(20, 10, 60, 20, { alt: true }); // remove the middle strip
    expect(area()).toBe(800 - 10 * 10 - 10 * 10);
    expect(cov(25, 15)).toBe(0);
    expect(cov(15, 15)).toBe(255);
    marquee(0, 0, 25, 100, { shift: true, alt: true }); // intersect with x < 25
    expect(area()).toBe(250);
    expect(e.selection()).toEqual({ x: 10, y: 10, w: 15, h: 20 });
  });

  it('subtract everything or intersect with nothing leaves no selection', () => {
    e = newEngine(50, 50);
    setOpts();
    marquee(10, 10, 20, 20);
    marquee(0, 0, 50, 50, { alt: true });
    expect(e.selection()).toBeNull();
    expect(e.selectionMask()).toBeNull();
    marquee(10, 10, 20, 20);
    marquee(30, 30, 40, 40, { shift: true, alt: true });
    expect(e.selection()).toBeNull();
  });

  it('a click in new mode deselects, in add mode it keeps the selection; one history entry per drag', () => {
    e = newEngine(50, 50);
    setOpts();
    marquee(10, 10, 20, 20);
    const n = e.history().entries.length;
    stroke(e, 'marquee', [[30, 30]], { shift: true });
    expect(e.selection()).toEqual({ x: 10, y: 10, w: 10, h: 10 });
    expect(e.history().entries.length).toBe(n);
    e.setTool('marquee');
    e.pointerDown(ptr(5, 5));
    e.pointerMove(ptr(25, 25));
    e.pointerMove(ptr(26, 26));
    e.pointerUp(ptr(27, 27));
    expect(e.history().entries.length).toBe(n + 1);
    stroke(e, 'marquee', [[40, 40]]);
    expect(e.selection()).toBeNull();
    expect(e.history().entries.length).toBe(n + 2);
  });
});

describe('selection history and basic commands', () => {
  it('selection changes are undoable / redoable entries with masks restored exactly', () => {
    e = newEngine(60, 60);
    setOpts();
    const ev = collect(e);
    marquee(10, 10, 30, 30);
    setOpts({ mode: 'add' });
    marquee(20, 20, 50, 50);
    const full = Array.from(e.selectionMask()!.alpha);
    expect(e.history().entries.map((x) => x.label)).toEqual(['Rectangular marquee', 'Rectangular marquee']);
    ev.length = 0;
    e.undo();
    expect(e.selection()).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    expect(ev.some((x) => x.type === 'selection')).toBe(true);
    e.undo();
    expect(e.selection()).toBeNull();
    e.redo();
    e.redo();
    expect(Array.from(e.selectionMask()!.alpha)).toEqual(full);
    e.jumpTo(-1);
    expect(e.selection()).toBeNull();
  });

  it('selectAll / deselect / invertSelection record history and are no-ops when nothing changes', () => {
    e = newEngine(40, 30);
    const ev: EngineEvent[] = collect(e);
    e.invertSelection(); // nothing selected: no-op
    e.deselect();
    expect(e.history().entries).toHaveLength(0);
    e.selectAll();
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 40, h: 30 });
    expect(area()).toBe(1200);
    e.selectAll();
    expect(e.history().entries).toHaveLength(1);
    e.invertSelection();
    expect(e.selection()).toBeNull();
    e.undo();
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 40, h: 30 });
    e.deselect();
    expect(e.selectionMask()).toBeNull();
    expect(e.history().entries.map((x) => x.label)).toEqual(['Select all', 'Deselect']);
    expect(ev.filter((x) => x.type === 'selection').length).toBeGreaterThan(3);
  });

  it('invertSelection flips coverage, including feathered edges', () => {
    e = newEngine(80, 80);
    setOpts({ feather: 6 });
    marquee(30, 30, 50, 50);
    const before = [cov(30, 40), cov(40, 40), cov(10, 10)];
    e.invertSelection();
    expect([cov(30, 40), cov(40, 40), cov(10, 10)]).toEqual(before.map((v) => 255 - v));
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 80, h: 80 });
  });

  it('setSelection stays a one-call rect selection with history', () => {
    e = newEngine(40, 40);
    e.setSelection({ x: 5, y: 5, w: 10, h: 10 });
    expect(e.history().entries.map((x) => x.label)).toEqual(['Select']);
    e.setSelection(null);
    e.undo();
    expect(e.selection()).toEqual({ x: 5, y: 5, w: 10, h: 10 });
    expect(area()).toBe(100);
  });

  it('resize clips the mask; loadDocument clears the selection', () => {
    e = newEngine(40, 40);
    setOpts({ feather: 4 });
    marquee(10, 10, 30, 30);
    e.resize(20, 20);
    expect(e.selectionMask()!.alpha.length).toBe(400);
    expect(e.selection()!.x + e.selection()!.w).toBeLessThanOrEqual(20);
    expect(cov(15, 15)).toBeGreaterThan(200);
    const spec = e.docSpec();
    e.loadDocument(spec);
    expect(e.selection()).toBeNull();
  });
});

describe('feather and antialias', () => {
  it('marquee feather builds a soft edge bounded by rect + radius', () => {
    e = newEngine(100, 100);
    setOpts({ feather: 8 });
    marquee(30, 30, 70, 70);
    expect(near([cov(30, 50)], [128], 25)).toBe(true);
    expect(cov(50, 50)).toBe(255);
    expect(cov(30 - 10, 50)).toBeLessThanOrEqual(3);
    const r = e.selection()!;
    expect(r.x).toBeGreaterThanOrEqual(30 - 12);
    expect(r.x + r.w).toBeLessThanOrEqual(70 + 12);
    let prev = -1;
    for (let x = 20; x <= 40; x++) {
      expect(cov(x, 50)).toBeGreaterThanOrEqual(prev);
      prev = cov(x, 50);
    }
  });

  it('lasso: antialiased edges give partial coverage, antialias off gives only 0 / 255', () => {
    e = newEngine(60, 60);
    const tri: [number, number][] = [[10, 10], [50, 10], [10, 50], [10.2, 10.2]];
    setOpts({ antialias: true });
    stroke(e, 'lasso', tri);
    const m = Array.from(e.selectionMask()!.alpha);
    expect(m.some((v) => v > 0 && v < 255)).toBe(true);
    expect(cov(15, 15)).toBe(255);
    expect(cov(45, 45)).toBe(0);
    setOpts({ antialias: false });
    stroke(e, 'lasso', tri);
    expect(Array.from(e.selectionMask()!.alpha).every((v) => v === 0 || v === 255)).toBe(true);
    expect(e.history().entries.map((x) => x.label)).toEqual(['Lasso', 'Lasso']);
  });

  it('lasso with feather and modes; a short drag selects nothing', () => {
    e = newEngine(80, 80);
    setOpts({ feather: 5 });
    stroke(e, 'lasso', [[20, 20], [60, 20], [60, 60], [20, 60]]);
    expect(cov(40, 40)).toBe(255);
    expect(cov(20, 40)).toBeGreaterThan(60);
    expect(cov(20, 40)).toBeLessThan(200);
    setOpts();
    stroke(e, 'lasso', [[30, 30], [31, 30]]);
    expect(e.selection()).toBeNull();
  });

  it('lasso: concave shapes keep the notch and figure-eights use the non-zero rule', () => {
    e = newEngine(60, 60);
    setOpts({ antialias: false });
    stroke(e, 'lasso', [[5, 5], [25, 5], [25, 20], [18, 20], [18, 10], [12, 10], [12, 20], [5, 20]]);
    expect(cov(15, 15)).toBe(0); // notch
    expect(cov(8, 15)).toBe(255);
    expect(cov(22, 15)).toBe(255);
    stroke(e, 'lasso', [[5, 5], [45, 40], [45, 5], [5, 40]]);
    expect(cov(10, 22)).toBe(255);
    expect(cov(40, 22)).toBe(255);
    expect(cov(25, 8)).toBe(0);
  });
});

describe('wand', () => {
  /** 60x40 doc: base grey 100; layer: left half red, right half blue, a green 10x10 island in the red half. */
  function wandDoc(): string {
    e = newEngine(60, 40);
    setBase(e, [100, 100, 100, 255]);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 30, h: 40 }, 'rgb(255,0,0)');
    drawRect(e, id, { x: 30, y: 0, w: 30, h: 40 }, 'rgb(0,0,255)');
    drawRect(e, id, { x: 10, y: 10, w: 10, h: 10 }, 'rgb(0,255,0)');
    return id;
  }

  it('selects the contiguous region of the active layer, honouring tolerance', () => {
    wandDoc();
    setOpts({ wandTolerance: 0 });
    stroke(e, 'wand', [[3, 3]]);
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 30, h: 40 });
    expect(area()).toBe(30 * 40 - 100); // island excluded
    expect(cov(15, 15)).toBe(0);
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Magic wand');
    setOpts({ wandTolerance: 255 });
    stroke(e, 'wand', [[3, 3]]);
    expect(area()).toBe(60 * 40);
  });

  it('tolerance is the max channel delta (red vs green island needs >= 255)', () => {
    wandDoc();
    setOpts({ wandTolerance: 254 });
    stroke(e, 'wand', [[3, 3]]);
    expect(cov(15, 15)).toBe(0);
    setOpts({ wandTolerance: 255 });
    stroke(e, 'wand', [[3, 3]]);
    expect(cov(15, 15)).toBe(255);
  });

  it('contiguous off selects every matching pixel', () => {
    wandDoc();
    const id = e.activeLayerId() as string;
    drawRect(e, id, { x: 45, y: 25, w: 5, h: 5 }, 'rgb(255,0,0)'); // a red patch inside the blue half
    setOpts({ wandContiguous: true });
    stroke(e, 'wand', [[3, 3]]);
    expect(cov(47, 27)).toBe(0);
    setOpts({ wandContiguous: false });
    stroke(e, 'wand', [[3, 3]]);
    expect(cov(47, 27)).toBe(255);
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 50, h: 40 });
  });

  it('sampleAll reads the composite, the active layer alone does not see layers beneath', () => {
    wandDoc();
    const top = e.addPixelLayer(); // empty layer on top
    setOpts({ wandSampleAll: false, wandTolerance: 0 });
    stroke(e, 'wand', [[3, 3]]);
    expect(area()).toBe(60 * 40); // the empty layer is one transparent region
    setOpts({ wandSampleAll: true });
    stroke(e, 'wand', [[3, 3]]);
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 30, h: 40 });
    expect(cov(15, 15)).toBe(0);
    expect(top).toBeTruthy();
  });

  it('sampleAll works with the preview disabled (TD view mode)', () => {
    wandDoc();
    e.setPreviewEnabled(false);
    setOpts({ wandSampleAll: true, wandTolerance: 0 });
    stroke(e, 'wand', [[40, 20]]);
    expect(e.selection()).toEqual({ x: 30, y: 0, w: 30, h: 40 });
  });

  it('respects layer offsets (selection is in document space)', () => {
    const id = wandDoc();
    e.doc.find(id)!; // eslint-disable-line @typescript-eslint/no-unused-expressions
    (e.doc.find(id) as unknown as { x: number }).x = 10;
    e.changed({ x: 0, y: 0, w: 60, h: 40 });
    setOpts({ wandTolerance: 0 });
    stroke(e, 'wand', [[15, 5]]); // layer-space x = 5: red
    expect(e.selection()).toEqual({ x: 10, y: 0, w: 30, h: 40 });
    stroke(e, 'wand', [[3, 5]]); // left of the shifted layer: transparent
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 10, h: 40 });
  });

  it('modes combine, feather softens, outside clicks deselect, wand on a mask target reads the mask', () => {
    wandDoc();
    setOpts({ wandTolerance: 0 });
    stroke(e, 'wand', [[3, 3]]);
    stroke(e, 'wand', [[40, 3]], { shift: true });
    expect(area()).toBe(30 * 40 - 100 + 30 * 40);
    stroke(e, 'wand', [[40, 3]], { alt: true });
    expect(area()).toBe(30 * 40 - 100);
    setOpts({ feather: 4 });
    stroke(e, 'wand', [[40, 3]]);
    expect(cov(30, 20)).toBeGreaterThan(60);
    expect(cov(30, 20)).toBeLessThan(200);
    expect(cov(45, 20)).toBe(255);
    setOpts();
    stroke(e, 'wand', [[-5, -5]]);
    expect(e.selection()).toBeNull();
    const id = e.activeLayerId() as string;
    e.addMask(id);
    e.setPaintTarget(id, 'mask');
    stroke(e, 'wand', [[3, 3]]);
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 60, h: 40 }); // all white
  });
});

describe('maskFromSelection', () => {
  it('adds a mask with the selection coverage (soft edges kept) and records history', () => {
    e = newEngine(60, 60);
    setBase(e, [100, 100, 100, 255]);
    const id = solidLayer(e, 'rgb(255,0,0)');
    setOpts({ feather: 6 });
    marquee(20, 20, 40, 40);
    const c = [cov(20, 30), cov(30, 30), cov(5, 5)];
    e.maskFromSelection(id);
    const slot = e.layers()[0].mask!.slot;
    expect(slot).toBeGreaterThan(0);
    expect([maskAt(e, slot, 20, 30), maskAt(e, slot, 30, 30), maskAt(e, slot, 5, 5)]).toEqual(c);
    expect(px(e, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(px(e, 5, 5)).toEqual([100, 100, 100, 255]);
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Mask from selection');
    e.undo();
    expect(e.layers()[0].mask).toBeNull();
    e.redo();
    expect(e.layers()[0].mask).not.toBeNull();
  });

  it('replaces an existing mask with a new slot; follows layer offsets; refuses without a selection', () => {
    e = newEngine(60, 60);
    const id = solidLayer(e, 'rgb(0,0,255)');
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    e.maskFromSelection(id);
    expect(notices).toEqual(['Make a selection first']);
    const old = e.addMask(id);
    (e.doc.find(id) as unknown as { x: number; y: number }).x = 10;
    (e.doc.find(id) as unknown as { x: number; y: number }).y = 5;
    e.setSelection({ x: 20, y: 20, w: 10, h: 10 });
    e.maskFromSelection(id);
    const slot = e.layers()[0].mask!.slot;
    expect(slot).not.toBe(old);
    expect(maskAt(e, slot, 10, 15)).toBe(255); // doc (20,20) = layer space (10,15)
    expect(maskAt(e, slot, 20, 20)).toBe(0);
    e.maskFromSelection('base');
    e.maskFromSelection(e.addGroup());
    expect(notices.length).toBe(3);
  });
});

describe('selection outline', () => {
  it('plain rect = one clockwise loop; masks trace their 50% contour; results are cached copies', () => {
    e = newEngine(80, 80);
    marquee(10, 20, 40, 50);
    expect(e.selectionPath()).toEqual([[{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 50 }, { x: 10, y: 50 }]]);
    setOpts({ feather: 6 });
    marquee(10, 20, 40, 50);
    const p = e.selectionPath();
    expect(p).toHaveLength(1);
    const xs = p[0].map((q) => q.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(9);
    expect(Math.max(...xs)).toBeLessThanOrEqual(41);
    p[0][0].x = -99;
    expect(e.selectionPath()[0][0].x).not.toBe(-99);
    setOpts({ wandTolerance: 0 });
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 80, h: 80 }, 'rgb(1,1,1)');
    drawRect(e, id, { x: 30, y: 30, w: 20, h: 20 }, 'rgb(200,0,0)');
    stroke(e, 'wand', [[40, 40]]);
    const sq = e.selectionPath();
    expect(sq).toHaveLength(1);
    expect(sq[0].map((q) => `${q.x},${q.y}`).sort()).toEqual(['30,30', '30,50', '50,30', '50,50']);
    e.deselect();
    expect(e.selectionPath()).toEqual([]);
  });
});

/** Soft selection: feathered square around (40,40) on a 80x80 document. */
function softSetup(): { cov: (x: number, y: number) => number } {
  e = newEngine(80, 80);
  setOpts({ feather: 10 });
  marquee(25, 25, 55, 55);
  return { cov };
}

describe('every paint tool is clipped by coverage', () => {
  const probes: Array<[number, number]> = [[25, 40], [40, 25], [20, 40], [30, 40], [40, 40], [5, 5], [60, 40]];

  it('brush multiplies the stroke by coverage (pixel layer)', () => {
    softSetup();
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 70, hardness: 1 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'brush', [[40, 40], [41, 40]]);
    let soft = 0;
    for (const [x, y] of probes) {
      const c = cov(x, y);
      expect(Math.abs(layerPx(e, id, x, y)[3] - c)).toBeLessThanOrEqual(2);
      if (c > 0 && c < 255) soft++;
    }
    expect(soft).toBeGreaterThan(2);
    expect(layerPx(e, id, 5, 5)[3]).toBe(0);
  });

  it('brush with opacity and a long stroke stays proportional to coverage; undo restores', () => {
    softSetup();
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 30, hardness: 1, opacity: 0.5 }, { primary: rgba(0, 0, 255) }));
    stroke(e, 'brush', [[10, 30], [30, 30], [50, 50], [70, 50]]);
    for (const [x, y] of [[25, 30], [30, 30], [40, 40], [50, 50]] as const) {
      const c = cov(x, y);
      if (layerPx(e, id, x, y)[3] === 0 && c === 0) continue;
      expect(Math.abs(layerPx(e, id, x, y)[3] - (c * 0.5))).toBeLessThanOrEqual(3);
    }
    expect(layerPx(e, id, 12, 30)[3]).toBe(0); // outside the selection
    e.undo();
    expect(layerPx(e, id, 30, 30)[3]).toBe(0);
  });

  it('pencil and eraser are clipped', () => {
    softSetup();
    const id = solidLayer(e, 'rgb(0,200,0)');
    e.setToolContext(brushCtx({ size: 60, hardness: 1 }, { primary: rgba(255, 255, 0) }));
    stroke(e, 'eraser', [[40, 40], [41, 40]]);
    for (const [x, y] of [[25, 40], [30, 40], [40, 40], [5, 5]] as const) {
      expect(Math.abs(layerPx(e, id, x, y)[3] - (255 - cov(x, y)))).toBeLessThanOrEqual(2);
    }
    const id2 = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 40 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'pencil', [[20, 40], [60, 40]]);
    for (const x of [22, 25, 28, 35, 55]) {
      expect(Math.abs(layerPx(e, id2, x, 40)[3] - cov(x, 40))).toBeLessThanOrEqual(2);
    }
    expect(layerPx(e, id2, 20, 40)[3]).toBe(cov(20, 40));
  });

  it('fill blends toward the colour by coverage and ignores clicks on unselected pixels', () => {
    softSetup();
    const id = solidLayer(e, 'rgb(0,0,255)');
    e.setToolContext(brushCtx({}, { primary: rgba(255, 0, 0), fillTolerance: 0 }));
    stroke(e, 'fill', [[2, 2]]); // outside: ignored
    expect(layerPx(e, id, 40, 40)).toEqual([0, 0, 255, 255]);
    const n = e.history().entries.length;
    stroke(e, 'fill', [[40, 40]]);
    expect(e.history().entries.length).toBe(n + 1);
    for (const [x, y] of [[40, 40], [30, 40], [26, 40], [20, 40], [5, 5]] as const) {
      const c = cov(x, y) / 255;
      const p = layerPx(e, id, x, y);
      expect(Math.abs(p[0] - 255 * c)).toBeLessThanOrEqual(2);
      expect(Math.abs(p[2] - 255 * (1 - c))).toBeLessThanOrEqual(2);
      expect(p[3]).toBe(255);
    }
    e.undo();
    expect(layerPx(e, id, 40, 40)).toEqual([0, 0, 255, 255]);
  });

  it('fill on a transparent layer yields alpha = coverage', () => {
    softSetup();
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({}, { primary: rgba(10, 20, 30), fillTolerance: 0 }));
    stroke(e, 'fill', [[40, 40]]);
    for (const [x, y] of [[40, 40], [30, 40], [25, 40], [22, 40]] as const) {
      const p = layerPx(e, id, x, y);
      expect(Math.abs(p[3] - cov(x, y))).toBeLessThanOrEqual(2);
      if (p[3] > 0) expect(near(p.slice(0, 3), [10, 20, 30], 3)).toBe(true);
    }
  });

  it('gradient is multiplied by coverage on pixels (and the preview redraws without accumulating)', () => {
    softSetup();
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({}, { primary: rgba(255, 0, 0), secondary: rgba(255, 0, 0) }));
    e.setTool('gradient');
    e.pointerDown(ptr(0, 0));
    e.pointerMove(ptr(79, 0));
    e.pointerMove(ptr(79, 1));
    e.pointerUp(ptr(79, 2));
    for (const [x, y] of [[40, 40], [30, 40], [25, 40], [5, 5], [20, 40]] as const) {
      expect(Math.abs(layerPx(e, id, x, y)[3] - cov(x, y))).toBeLessThanOrEqual(2);
    }
    e.undo();
    expect(layerPx(e, id, 40, 40)[3]).toBe(0);
  });

  it('mask painting: brush, fill and gradient on a mask follow the coverage', () => {
    softSetup();
    const id = solidLayer(e, 'rgb(255,0,0)');
    const slot = e.addMask(id);
    e.setPaintTarget(id, 'mask');
    e.setToolContext(brushCtx({ size: 70, hardness: 1 }, { primary: rgba(0, 0, 0), fillTolerance: 0 }));
    stroke(e, 'brush', [[40, 40], [41, 40]]);
    for (const [x, y] of [[40, 40], [30, 40], [25, 40], [5, 5]] as const) {
      expect(Math.abs(maskAt(e, slot, x, y) - (255 - cov(x, y)))).toBeLessThanOrEqual(3);
    }
    e.undo();
    expect(maskAt(e, slot, 40, 40)).toBe(255);
    // fill the (white) mask with black: lerp by coverage
    stroke(e, 'fill', [[40, 40]]);
    for (const [x, y] of [[40, 40], [30, 40], [26, 40], [5, 5]] as const) {
      expect(Math.abs(maskAt(e, slot, x, y) - (255 - cov(x, y)))).toBeLessThanOrEqual(3);
    }
    e.undo();
    // gradient white -> white replaces the mask by lerp too (here: black -> black)
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 0), secondary: rgba(0, 0, 0) }));
    e.setTool('gradient');
    e.pointerDown(ptr(0, 0));
    e.pointerMove(ptr(79, 0));
    e.pointerUp(ptr(79, 1));
    for (const [x, y] of [[40, 40], [30, 40], [26, 40], [5, 5]] as const) {
      expect(Math.abs(maskAt(e, slot, x, y) - (255 - cov(x, y)))).toBeLessThanOrEqual(3);
    }
    expect(slotPx(e, slot, 5, 5)[0]).toBe(255);
    // eraser on the mask
    e.undo();
    e.setToolContext(brushCtx({ size: 70, hardness: 1 }));
    stroke(e, 'eraser', [[40, 40], [41, 40]]);
    expect(Math.abs(maskAt(e, slot, 40, 40) - (255 - cov(40, 40)))).toBeLessThanOrEqual(3);
  });

  it('works with layer offsets (coverage is looked up in document space)', () => {
    softSetup();
    const id = e.addPixelLayer();
    (e.doc.find(id) as unknown as { x: number; y: number }).x = 7;
    (e.doc.find(id) as unknown as { x: number; y: number }).y = 3;
    e.setToolContext(brushCtx({ size: 70, hardness: 1 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'brush', [[40, 40], [41, 40]]);
    for (const [x, y] of [[40, 40], [30, 40], [25, 40], [20, 40]] as const) {
      expect(Math.abs(layerPx(e, id, x - 7, y - 3)[3] - cov(x, y))).toBeLessThanOrEqual(2);
    }
  });

  it('a rect-only selection still clips hard; select-all paints everywhere', () => {
    e = newEngine(50, 50);
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 60, hardness: 1 }, { primary: rgba(255, 0, 0) }));
    e.setSelection({ x: 20, y: 20, w: 10, h: 10 });
    stroke(e, 'brush', [[25, 25], [26, 25]]);
    expect(layerPx(e, id, 25, 25)[3]).toBe(255);
    expect(layerPx(e, id, 15, 25)[3]).toBe(0);
    e.selectAll();
    stroke(e, 'brush', [[10, 10], [11, 10]]);
    expect(layerPx(e, id, 10, 10)[3]).toBe(255);
  });

  it('selection edits do not touch pixels and a stroke outside a soft selection records nothing visible', () => {
    softSetup();
    const id = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 6, hardness: 1 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'brush', [[2, 2], [4, 4]]);
    expect(layerPx(e, id, 3, 3)[3]).toBe(0);
  });
});

describe('review regressions', () => {
  it('a height-only resize does not leave a stale selection canvas (lasso paint stays clipped)', () => {
    e = newEngine(100, 100);
    setOpts();
    const id = e.addPixelLayer();
    stroke(e, 'lasso', [[10, 10], [90, 10], [50, 90]]);
    e.setToolContext(brushCtx({ size: 10, hardness: 1 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'brush', [[40, 30], [60, 30]]);
    expect(layerPx(e, id, 50, 30)[3]).toBe(255);
    e.resize(100, 200);
    const id2 = e.addPixelLayer(); // surfaces keep their size on resize: paint on a layer made after it
    stroke(e, 'lasso', [[10, 110], [90, 110], [50, 190]]);
    stroke(e, 'brush', [[5, 180], [95, 180]]);
    expect(layerPx(e, id2, 10, 180)[3]).toBe(0);
    expect(layerPx(e, id2, 50, 180)[3]).toBe(255);
    expect(id).not.toBe(id2);
  });

  it('marquee drags preview the plain rect and feather once on release', () => {
    e = newEngine(100, 100);
    setOpts({ feather: 8 });
    e.setTool('marquee');
    e.pointerDown(ptr(30, 30));
    e.pointerMove(ptr(70, 70));
    expect(cov(30, 50)).toBe(255); // unfeathered preview
    e.pointerUp(ptr(70, 70));
    expect(cov(30, 50)).toBeLessThan(200);
    expect(cov(30, 50)).toBeGreaterThan(60);
  });

  it('a wand click outside the document with no selection records nothing', () => {
    e = newEngine(50, 50);
    setOpts();
    stroke(e, 'wand', [[-5, -5]]);
    expect(e.history().entries).toHaveLength(0);
    expect(e.selection()).toBeNull();
  });
});
