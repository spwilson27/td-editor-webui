import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { EngineEvent, ToolId } from '../../src/engine/types';
import { brushCtx, collect, drawRect, layerPx, near, newEngine, nextFrame, ptr, px, rgba, setBase, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

function paintSetup(w = 100, h = 100, ctxOver = {}, extra = {}) {
  e = newEngine(w, h);
  const id = e.addPixelLayer();
  e.setToolContext(brushCtx(ctxOver, extra));
  return id;
}

describe('brush', () => {
  it('single click stamps one dab', () => {
    const id = paintSetup();
    stroke(e, 'brush', [[50, 50]]);
    expect(layerPx(e, id, 50, 50)).toEqual([0, 0, 0, 255]);
    expect(layerPx(e, id, 53, 50)[3]).toBe(255);
    expect(layerPx(e, id, 58, 50)[3]).toBe(0);
    expect(layerPx(e, id, 50, 44)[3]).toBe(0);
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add layer', 'Brush']);
  });

  it('draws a continuous line between sparse pointer events with the primary colour', () => {
    const id = paintSetup(100, 100, {}, { primary: rgba(255, 0, 0) });
    stroke(e, 'brush', [[10, 20], [90, 20]]);
    for (let x = 10; x <= 90; x += 5) expect(layerPx(e, id, x, 20)).toEqual([255, 0, 0, 255]);
    expect(layerPx(e, id, 50, 30)[3]).toBe(0);
    expect(layerPx(e, id, 6, 20)[3]).toBe(255);
    expect(layerPx(e, id, 2, 20)[3]).toBe(0);
    expect(layerPx(e, id, 97, 20)[3]).toBe(0);
  });

  it('stroke opacity does not accumulate where the stroke overlaps itself', () => {
    const id = paintSetup(100, 100, { opacity: 0.5, size: 20 });
    stroke(e, 'brush', [[20, 50], [80, 50], [20, 50], [80, 50]]);
    for (const x of [30, 50, 70]) expect(near(layerPx(e, id, x, 50), [0, 0, 0, 128], 2)).toBe(true);
  });

  it('flow accumulates dab over dab', () => {
    const id = paintSetup(100, 100, { flow: 0.5, size: 20 });
    stroke(e, 'brush', [[50, 50]]);
    expect(near(layerPx(e, id, 50, 50), [0, 0, 0, 128], 2)).toBe(true);
    stroke(e, 'brush', [[10, 80], [90, 80]]);
    expect(layerPx(e, id, 50, 80)[3]).toBeGreaterThan(200);
  });

  it('hardness 0 falls off from the centre', () => {
    const id = paintSetup(100, 100, { hardness: 0, size: 40 });
    stroke(e, 'brush', [[50, 50]]);
    const a = [0, 5, 10, 15, 19].map((d) => layerPx(e, id, 50 + d, 50)[3]);
    expect(a[0]).toBeGreaterThan(240);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeLessThan(a[i - 1]);
    expect(a[4]).toBeLessThan(40);
  });

  it('primary alpha scales stroke opacity', () => {
    const id = paintSetup(100, 100, {}, { primary: rgba(0, 0, 0, 128) });
    stroke(e, 'brush', [[50, 50]]);
    expect(near(layerPx(e, id, 50, 50), [0, 0, 0, 128], 2)).toBe(true);
  });

  it('stroke entirely outside the document changes nothing and records no history', () => {
    const id = paintSetup();
    const before = e.history().entries.length;
    const events = collect(e);
    stroke(e, 'brush', [[-200, -200], [-100, -150]]);
    stroke(e, 'brush', [[500, 50], [600, 80]]);
    expect(e.history().entries.length).toBe(before);
    expect(events.filter((x) => x.type === 'pixels')).toHaveLength(0);
    expect(layerPx(e, id, 0, 0)[3]).toBe(0);
  });

  it('stroke partly outside the document is clipped', () => {
    const id = paintSetup();
    stroke(e, 'brush', [[-30, 50], [3, 50]]);
    expect(layerPx(e, id, 0, 50)[3]).toBe(255);
    expect(layerPx(e, id, 10, 50)[3]).toBe(0);
  });

  it('size 1 and max-size brushes work', () => {
    const id = paintSetup(100, 100, { size: 1 });
    stroke(e, 'brush', [[50.5, 50.5]]);
    expect(layerPx(e, id, 50, 50)[3]).toBeGreaterThan(0);
    e.setToolContext(brushCtx({ size: 5000 }));
    stroke(e, 'brush', [[50, 50]]);
    expect(layerPx(e, id, 99, 99)[3]).toBe(255);
  });

  it('pointer events without a pointer down are ignored', () => {
    const id = paintSetup();
    e.setTool('brush');
    e.pointerMove(ptr(10, 10));
    e.pointerUp(ptr(10, 10));
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
  });

  it('the stroke shows up in the composite', () => {
    paintSetup();
    stroke(e, 'brush', [[50, 50]]);
    expect(px(e, 50, 50)).toEqual([0, 0, 0, 255]);
  });
});

describe('pencil', () => {
  it('paints hard-edged aliased squares only', () => {
    const id = paintSetup(50, 50, { size: 3 });
    stroke(e, 'pencil', [[10.7, 10.2]]);
    for (let y = 8; y <= 12; y++) {
      for (let x = 8; x <= 12; x++) {
        const inside = x >= 9 && x <= 11 && y >= 9 && y <= 11;
        expect(layerPx(e, id, x, y)).toEqual(inside ? [0, 0, 0, 255] : [0, 0, 0, 0]);
      }
    }
  });

  it('is gap-free along a diagonal line and every pixel is fully opaque or empty', () => {
    const id = paintSetup(50, 50, { size: 1 }, { primary: rgba(10, 20, 30) });
    stroke(e, 'pencil', [[5, 5], [45, 20]]);
    let count = 0;
    for (let x = 5; x <= 45; x++) {
      let col = 0;
      for (let y = 0; y < 50; y++) {
        const p = layerPx(e, id, x, y);
        if (p[3]) { col++; expect(p).toEqual([10, 20, 30, 255]); }
      }
      expect(col).toBeGreaterThanOrEqual(1);
      count += col;
    }
    expect(count).toBe(41); // Bresenham: one pixel per column for a shallow line
  });
});

describe('eraser', () => {
  it('removes alpha under the brush only, revealing layers below', () => {
    e = newEngine(50, 50);
    setBase(e, [0, 0, 255, 255]);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 50, h: 50 }, '#f00');
    e.setToolContext(brushCtx({ size: 10 }));
    stroke(e, 'eraser', [[25, 25]]);
    expect(layerPx(e, id, 25, 25)[3]).toBe(0);
    expect(layerPx(e, id, 40, 25)).toEqual([255, 0, 0, 255]);
    expect(px(e, 25, 25)).toEqual([0, 0, 255, 255]);
  });

  it('opacity 0.5 half-erases', () => {
    e = newEngine(50, 50);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 50, h: 50 }, '#f00');
    e.setToolContext(brushCtx({ size: 10, opacity: 0.5 }));
    stroke(e, 'eraser', [[10, 25], [40, 25], [10, 25]]);
    expect(near(layerPx(e, id, 25, 25), [255, 0, 0, 128], 3)).toBe(true);
  });
});

describe('fill', () => {
  it('fills a transparent layer completely (tolerance 0 and 255)', () => {
    const id = paintSetup(20, 20, {}, { primary: rgba(1, 2, 3) });
    for (const tol of [0, 255]) {
      e.setToolContext(brushCtx({}, { primary: rgba(1, 2, 3), fillTolerance: tol }));
      stroke(e, 'fill', [[3, 3]]);
      expect(layerPx(e, id, 0, 0)).toEqual([1, 2, 3, 255]);
      expect(layerPx(e, id, 19, 19)).toEqual([1, 2, 3, 255]);
      e.undo();
    }
  });

  it('is bounded by differing pixels at tolerance 0 and leaks through them at 255', () => {
    const id = paintSetup(20, 20, {}, { primary: rgba(9, 9, 9) });
    drawRect(e, id, { x: 10, y: 0, w: 1, h: 20 }, 'rgb(255,255,255)'); // vertical wall
    stroke(e, 'fill', [[2, 2]]);
    expect(layerPx(e, id, 5, 15)).toEqual([9, 9, 9, 255]);
    expect(layerPx(e, id, 10, 5)).toEqual([255, 255, 255, 255]);
    expect(layerPx(e, id, 15, 5)[3]).toBe(0);
    e.undo();
    e.setToolContext(brushCtx({}, { primary: rgba(9, 9, 9), fillTolerance: 255 }));
    stroke(e, 'fill', [[2, 2]]);
    expect(layerPx(e, id, 15, 5)).toEqual([9, 9, 9, 255]);
  });

  it('tolerance accepts near colours', () => {
    const id = paintSetup(20, 20, {}, { primary: rgba(0, 0, 0) });
    drawRect(e, id, { x: 0, y: 0, w: 20, h: 20 }, 'rgb(100,100,100)');
    drawRect(e, id, { x: 10, y: 0, w: 10, h: 20 }, 'rgb(110,100,100)');
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 0), fillTolerance: 5 }));
    stroke(e, 'fill', [[2, 2]]);
    expect(layerPx(e, id, 15, 2)).toEqual([110, 100, 100, 255]);
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 0), fillTolerance: 10 }));
    stroke(e, 'fill', [[15, 2]]);
    expect(layerPx(e, id, 2, 2)).toEqual([0, 0, 0, 255]);
  });

  it('is clipped to the selection and ignores clicks outside it', () => {
    const id = paintSetup(20, 20, {}, { primary: rgba(5, 6, 7) });
    e.setSelection({ x: 5, y: 5, w: 5, h: 5 });
    stroke(e, 'fill', [[0, 0]]);
    expect(layerPx(e, id, 0, 0)[3]).toBe(0);
    stroke(e, 'fill', [[6, 6]]);
    expect(layerPx(e, id, 5, 5)).toEqual([5, 6, 7, 255]);
    expect(layerPx(e, id, 9, 9)).toEqual([5, 6, 7, 255]);
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
    expect(layerPx(e, id, 4, 5)[3]).toBe(0);
  });

  it('click outside the document does nothing', () => {
    paintSetup(20, 20);
    const n = e.history().entries.length;
    stroke(e, 'fill', [[-5, 3]]);
    stroke(e, 'fill', [[30, 3]]);
    expect(e.history().entries.length).toBe(n);
  });
});

describe('gradient', () => {
  it('blends primary to secondary along the drag and commits one history entry', async () => {
    const id = paintSetup(101, 10, {}, { primary: rgba(255, 0, 0), secondary: rgba(0, 0, 255) });
    e.setTool('gradient');
    e.pointerDown(ptr(0, 5));
    e.pointerMove(ptr(50, 5));
    e.pointerMove(ptr(100, 5));
    await nextFrame(); // redraws are coalesced per animation frame
    expect(layerPx(e, id, 50, 5)[3]).toBe(255); // live preview visible
    e.pointerUp(ptr(100, 5));
    expect(near(layerPx(e, id, 0, 5), [255, 0, 0, 255], 2)).toBe(true);
    expect(near(layerPx(e, id, 50, 5), [128, 0, 128, 255], 3)).toBe(true);
    expect(near(layerPx(e, id, 100, 5), [0, 0, 255, 255], 2)).toBe(true);
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add layer', 'Gradient']);
    e.undo();
    expect(layerPx(e, id, 50, 5)[3]).toBe(0);
  });

  it('a click without drag paints nothing', () => {
    const id = paintSetup();
    stroke(e, 'gradient', [[10, 10]]);
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add layer']);
  });

  it('respects the selection and replaces earlier previews when the drag changes direction', () => {
    const id = paintSetup(100, 10, {}, { primary: rgba(255, 0, 0), secondary: rgba(0, 0, 255) });
    e.setSelection({ x: 20, y: 0, w: 30, h: 10 });
    e.setTool('gradient');
    e.pointerDown(ptr(0, 5));
    e.pointerMove(ptr(100, 5));
    e.pointerMove(ptr(0, 8)); // vertical-ish, nearly zero horizontal change
    e.pointerUp(ptr(0, 8));
    expect(layerPx(e, id, 10, 5)[3]).toBe(0);
    expect(layerPx(e, id, 60, 5)[3]).toBe(0);
    expect(layerPx(e, id, 30, 2)[3]).toBe(255);
  });
});

describe('picker', () => {
  it('emits the composite colour under the pointer, also while dragging', () => {
    e = newEngine(20, 20);
    setBase(e, [10, 20, 30, 255]);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 10, y: 0, w: 10, h: 20 }, 'rgb(200,100,50)');
    const picks: EngineEvent[] = [];
    e.on((ev) => ev.type === 'pick' && picks.push(ev));
    e.setTool('picker');
    e.pointerDown(ptr(2, 2));
    e.pointerMove(ptr(15, 2));
    e.pointerMove(ptr(-5, 2)); // outside: no event
    e.pointerUp(ptr(15, 2));
    expect(picks).toEqual([
      { type: 'pick', color: { r: 10, g: 20, b: 30, a: 255 } },
      { type: 'pick', color: { r: 200, g: 100, b: 50, a: 255 } },
    ]);
  });

  it('alt with a paint tool samples instead of painting', () => {
    const id = paintSetup();
    setBase(e, [1, 2, 3, 255]);
    const picks: EngineEvent[] = [];
    e.on((ev) => ev.type === 'pick' && picks.push(ev));
    stroke(e, 'brush', [[10, 10]], { alt: true });
    expect(picks).toHaveLength(1);
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
  });
});

describe('move', () => {
  it('drags the active layer by integer offsets and records one undoable step', () => {
    e = newEngine(50, 50);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 10, y: 10, w: 5, h: 5 }, '#f00');
    stroke(e, 'move', [[12, 12], [20, 15], [32.4, 19.6]]);
    expect(px(e, 10 + 20, 10 + 8)).toEqual([255, 0, 0, 255]);
    expect(px(e, 12, 12)).toEqual([0, 0, 0, 0]);
    expect(px(e, 30 - 1, 18)).toEqual([0, 0, 0, 0]);
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add layer', 'Move']);
    e.undo();
    expect(px(e, 12, 12)).toEqual([255, 0, 0, 255]);
    e.redo();
    expect(px(e, 31, 19)).toEqual([255, 0, 0, 255]);
  });

  it('keeps off-canvas content so moving back restores it', () => {
    e = newEngine(20, 20);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 15, y: 0, w: 5, h: 5 }, '#f00');
    stroke(e, 'move', [[0, 0], [10, 0], [0, 0]]);
    expect(px(e, 17, 2)).toEqual([255, 0, 0, 255]);
  });

  it('a no-op drag records nothing; locked, hidden and group layers refuse', () => {
    e = newEngine(20, 20);
    const id = e.addPixelLayer();
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    stroke(e, 'move', [[5, 5], [5, 5]]);
    expect(e.history().entries).toHaveLength(1);
    e.setLayerProps(id, { locked: true });
    stroke(e, 'move', [[5, 5], [9, 9]]);
    e.setLayerProps(id, { locked: false, visible: false });
    stroke(e, 'move', [[5, 5], [9, 9]]);
    const g = e.addGroup();
    e.setActiveLayer(g);
    stroke(e, 'move', [[5, 5], [9, 9]]);
    expect(notices).toEqual(['Layer is locked', 'Layer is hidden', 'Select a pixel layer to move']);
  });
});

describe('marquee and selection clipping', () => {
  it('drag creates a normalised, document-clipped selection; click clears it', () => {
    e = newEngine(50, 50);
    const events = collect(e);
    stroke(e, 'marquee', [[20, 30], [10, 5], [5.4, 4.6]]);
    expect(e.selection()).toEqual({ x: 5, y: 5, w: 15, h: 25 });
    expect(events.some((x) => x.type === 'selection')).toBe(true);
    stroke(e, 'marquee', [[40, 40], [90, 90]]);
    expect(e.selection()).toEqual({ x: 40, y: 40, w: 10, h: 10 });
    stroke(e, 'marquee', [[10, 10]]);
    expect(e.selection()).toBeNull();
  });

  it('setSelection clips, rejects empty rects, and only notifies on change', () => {
    e = newEngine(50, 50);
    const events = collect(e);
    e.setSelection({ x: -10, y: -10, w: 20, h: 20 });
    expect(e.selection()).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    e.setSelection({ x: 0, y: 0, w: 10, h: 10 });
    e.setSelection({ x: 60, y: 60, w: 10, h: 10 });
    expect(e.selection()).toBeNull();
    e.setSelection({ x: 5, y: 5, w: 0, h: 5 });
    e.setSelection(null);
    expect(events.filter((x) => x.type === 'selection')).toHaveLength(2);
    const s = { x: 1, y: 1, w: 2, h: 2 };
    e.setSelection(s);
    e.selection()!.x = 99; // returned copy
    expect(e.selection()).toEqual(s);
  });

  it('brush and eraser are clipped to the selection', () => {
    const id = paintSetup(60, 60, { size: 40 });
    e.setSelection({ x: 20, y: 20, w: 20, h: 20 });
    stroke(e, 'brush', [[30, 30]]);
    expect(layerPx(e, id, 30, 30)).toEqual([0, 0, 0, 255]);
    expect(layerPx(e, id, 19, 30)[3]).toBe(0);
    expect(layerPx(e, id, 40, 30)[3]).toBe(0);
    expect(layerPx(e, id, 30, 19)[3]).toBe(0);
    e.setSelection({ x: 25, y: 25, w: 10, h: 10 });
    stroke(e, 'eraser', [[30, 30]]);
    expect(layerPx(e, id, 30, 30)[3]).toBe(0);
    expect(layerPx(e, id, 22, 30)[3]).toBe(255);
  });

  it('a stroke fully outside the selection records nothing', () => {
    paintSetup(60, 60);
    e.setSelection({ x: 40, y: 40, w: 10, h: 10 });
    const n = e.history().entries.length;
    stroke(e, 'brush', [[5, 5]]);
    expect(e.history().entries.length).toBe(n);
  });
});

describe('locked, hidden and unsupported cases', () => {
  const paintTools: ToolId[] = ['brush', 'pencil', 'eraser', 'fill', 'gradient'];

  it.each(paintTools)('%s does nothing on a locked layer and reports why', (tool) => {
    const id = paintSetup();
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    e.setLayerProps(id, { locked: true });
    const n = e.history().entries.length;
    stroke(e, tool, [[10, 10], [30, 30]]);
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
    expect(e.history().entries.length).toBe(n);
    expect(notices).toContain('Layer is locked');
  });

  it.each(paintTools)('%s does nothing on a hidden layer', (tool) => {
    const id = paintSetup();
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    e.setLayerProps(id, { visible: false });
    stroke(e, tool, [[10, 10], [30, 30]]);
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
    expect(notices).toContain('Layer is hidden');
  });

  it('painting on the base layer is always refused, even after trying to unlock it', () => {
    e = newEngine(20, 20);
    e.setToolContext(brushCtx());
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    stroke(e, 'brush', [[10, 10]]);
    expect(px(e, 10, 10)).toEqual([0, 0, 0, 0]);
    expect(notices).toEqual(['Layer is locked']);
    e.setLayerProps('base', { locked: false });
    stroke(e, 'brush', [[10, 10]]);
    expect(px(e, 10, 10)).toEqual([0, 0, 0, 0]);
    expect(e.layers()[0].locked).toBe(true);
  });

  it('painting with a group active is refused', () => {
    e = newEngine(20, 20);
    e.setToolContext(brushCtx());
    e.setActiveLayer(e.addGroup());
    const notices: string[] = [];
    e.on((ev) => ev.type === 'notice' && notices.push(ev.message));
    stroke(e, 'brush', [[10, 10]]);
    expect(notices).toEqual(['Select a pixel layer']);
  });

  it.each(['lasso', 'wand', 'crop', 'clone', 'smudge', 'text', 'shape', 'hand', 'zoom'] as ToolId[])('%s is a no-op', (tool) => {
    const id = paintSetup();
    const n = e.history().entries.length;
    stroke(e, tool, [[10, 10], [30, 30]]);
    expect(layerPx(e, id, 10, 10)[3]).toBe(0);
    expect(e.history().entries.length).toBe(n);
    expect(e.selection()).toBeNull();
  });

  it('switching tool or starting a new stroke mid-stroke finishes the previous one', () => {
    const id = paintSetup();
    e.setTool('brush');
    e.pointerDown(ptr(10, 10));
    e.pointerMove(ptr(30, 10));
    e.setTool('eraser');
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add layer', 'Brush']);
    e.pointerDown(ptr(10, 10));
    e.pointerDown(ptr(50, 50)); // missed pointerUp
    e.pointerUp(ptr(50, 50));
    expect(layerPx(e, id, 20, 10)[3]).toBe(255); // earlier brush stroke kept
    expect(layerPx(e, id, 10, 10)[3]).toBe(0); // interrupted eraser stroke was committed
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add layer', 'Brush', 'Eraser', 'Eraser']);
  });
});
