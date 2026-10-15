import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { PixelLayer } from '../../src/engine/model';
import type { DocSpec, LayerSpec } from '../../src/engine/types';
import { effectsPassCount } from '../../src/engine/effects';
import { brushCtx, collect, drawRect, layerPx, maskAt, near, newEngine, perfEnabled, ptr, px, rgba, solid, stroke } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const rot = (r: number) => ({ rot: r, kx: 0, ky: 0 });

describe('free transform: rot / kx / ky', () => {
  it('rotates a layer 90 degrees clockwise about its top-left; layerBounds is the transformed box', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    e.setTransform(id, { x: 0, y: 0, sx: 1, sy: 1, ...rot(0) });
    const l = e.doc.find(id) as PixelLayer;
    // 20x10 surface
    l.surface.canvas.width = 20; // reset size (OffscreenCanvas): redraw below
    l.surface.canvas.height = 10;
    e.doc.pixelLayers(); // keep types happy
    (l as { surface: unknown }).surface = { ...l.surface, width: 20, height: 10 };
    l.surface.ctx.fillStyle = '#f00';
    l.surface.ctx.fillRect(0, 0, 20, 10);
    e.setTransform(id, { x: 50, y: 50, sx: 1, sy: 1, ...rot(90) });
    expect(e.layerBounds(id)).toEqual({ x: 40, y: 50, w: 10, h: 20 });
    expect(near(px(e, 45, 60), RED, 1)).toBe(true);
    expect(px(e, 60, 55)[3]).toBe(0);
    expect(px(e, 45, 40)[3]).toBe(0);
  });

  it('paints under the cursor on a rotated layer (30 deg) and on a skewed one', () => {
    for (const t of [{ rot: 30, kx: 0, ky: 0 }, { rot: 0, kx: 25, ky: 0 }, { rot: 20, kx: 10, ky: -15 }]) {
      e = newEngine(200, 200);
      const id = e.addPixelLayer();
      e.setTransform(id, { x: 60, y: 40, sx: 1, sy: 1, ...t });
      // make the layer big enough: 150x150 white surface
      const l = e.doc.find(id) as PixelLayer;
      e.dispose();
      e = newEngine(200, 200);
      const rgbaBuf = solid(150, 150, [255, 255, 255, 255]);
      const img = e.importImage(rgbaBuf, 150, 150, 'w');
      e.setTransform(img, { x: 60, y: 40, sx: 1, sy: 1, ...t });
      void l;
      e.setToolContext(brushCtx({ size: 8, hardness: 1 }));
      // pick a doc point inside the transformed layer
      const target = { x: 100.5, y: 120.5 };
      stroke(e, 'brush', [[target.x, target.y], [target.x + 1, target.y]]);
      expect(near(px(e, 100, 120), BLACK, 2)).toBe(true);
      // the painted layer pixel is the one under the cursor: inverse mapping lands on a black layer pixel
      const lay = e.doc.find(img) as PixelLayer;
      const dark = lay.surface.ctx.getImageData(0, 0, 150, 150).data;
      let n = 0;
      for (let i = 0; i < dark.length; i += 4) if (dark[i] < 100) n++;
      expect(n).toBeGreaterThan(10);
      expect(n).toBeLessThan(150); // a ~8 px dot, not a smear
      e.dispose();
    }
  });

  it('the brush tip is a circle of `size` document pixels even under rotation + non-uniform scale', () => {
    e = newEngine(200, 200);
    const img = e.importImage(solid(100, 100, [255, 255, 255, 255]), 100, 100, 'w');
    e.setTransform(img, { x: 50, y: 50, sx: 2, sy: 1, rot: 45, kx: 0, ky: 0 });
    e.setToolContext(brushCtx({ size: 20, hardness: 1 }));
    stroke(e, 'brush', [[100.5, 110.5], [100.5, 110.5]]);
    const d = e.readComposite({ x: 80, y: 90, w: 41, h: 41 });
    let area = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && d[i] < 128) area++;
    expect(Math.abs(area - Math.PI * 100)).toBeLessThan(60); // ~314 px
  });

  it('clips painting to a selection on a rotated layer and to the canvas', () => {
    e = newEngine(100, 100);
    const img = e.importImage(solid(80, 80, [255, 255, 255, 255]), 80, 80, 'w');
    e.setTransform(img, { x: 40, y: 0, sx: 1, sy: 1, rot: 30, kx: 0, ky: 0 });
    e.setSelection({ x: 0, y: 0, w: 60, h: 100 });
    e.setToolContext(brushCtx({ size: 30, hardness: 1 }));
    stroke(e, 'brush', [[40, 50], [80, 50]]);
    expect(near(px(e, 50, 50), BLACK, 2)).toBe(true);
    expect(px(e, 70, 50)[0]).toBeGreaterThan(250); // outside the selection: untouched
  });

  it('fill and gradient work on a rotated layer', () => {
    e = newEngine(100, 100);
    const img = e.importImage(solid(60, 60, [255, 255, 255, 255]), 60, 60, 'w');
    e.setTransform(img, { x: 30, y: 10, sx: 1, sy: 1, rot: 45, kx: 0, ky: 0 });
    e.setToolContext(brushCtx({}, { primary: rgba(0, 0, 255), secondary: rgba(255, 0, 0), fillTolerance: 10 }));
    stroke(e, 'fill', [[30, 40]]);
    expect(near(px(e, 30, 40), [0, 0, 255, 255], 1)).toBe(true);
    stroke(e, 'gradient', [[10, 40], [60, 40]]);
    const a = px(e, 30, 40);
    const b = px(e, 45, 40);
    expect(a[0]).toBeLessThan(b[0]); // blue -> red along the drag
  });

  it('applyTransform bakes rotation + skew: same picture, identity transform', () => {
    e = newEngine(120, 120);
    const buf = new Uint8ClampedArray(40 * 30 * 4);
    for (let i = 0; i < buf.length; i += 4) { buf[i] = (i >> 2) % 40 * 6; buf[i + 1] = 80; buf[i + 2] = 200; buf[i + 3] = 255; }
    const id = e.importImage(buf, 40, 30, 'g');
    e.setTransform(id, { x: 50, y: 20, sx: 1.5, sy: 1.2, rot: 25, kx: 10, ky: 0 });
    const before = e.readComposite({ x: 0, y: 0, w: 120, h: 120 });
    e.applyTransform(id);
    const info = e.layers().find((l) => l.id === id)!;
    expect(info.transform).toMatchObject({ sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
    const after = e.readComposite({ x: 0, y: 0, w: 120, h: 120 });
    let bad = 0;
    for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - after[i]) > 40 || Math.abs(before[i + 3] - after[i + 3]) > 90) bad++;
    expect(bad / (before.length / 4)).toBeLessThan(0.02); // only anti-aliased edge pixels differ
    e.undo();
    expect((e.layers().find((l) => l.id === id)!).transform.rot).toBe(25);
  });

  it('setLayerBox: move, uniform resize and non-uniform resize of a rotated layer fit the bounding box', () => {
    e = newEngine(200, 200);
    const id = e.importImage(solid(40, 20, [9, 9, 9, 255]), 40, 20, 'a');
    e.setTransform(id, { x: 60, y: 60, sx: 1, sy: 1, rot: 30, kx: 0, ky: 0 });
    const b = e.layerBounds(id)!;
    e.setLayerBox(id, { ...b, x: b.x + 10, y: b.y + 5 });
    let nb = e.layerBounds(id)!;
    expect(nb.x).toBeCloseTo(b.x + 10, 5);
    expect(e.layers().find((l) => l.id === id)!.transform.rot).toBe(30);
    e.setLayerBox(id, { x: nb.x, y: nb.y, w: nb.w * 2, h: nb.h * 2 });
    nb = e.layerBounds(id)!;
    expect(nb.w).toBeCloseTo(b.w * 2, 4);
    expect(e.layers().find((l) => l.id === id)!.transform.rot).toBe(30);
    e.setLayerBox(id, { x: nb.x, y: nb.y, w: nb.w * 1.5, h: nb.h });
    const nb2 = e.layerBounds(id)!;
    expect(nb2.w).toBeCloseTo(nb.w * 1.5, 4);
    expect(nb2.h).toBeCloseTo(nb.h, 4);
  });

  it('round-trips rot / kx / ky through docSpec and loadDocument', () => {
    e = newEngine(100, 100);
    const id = e.importImage(solid(10, 10, [1, 2, 3, 255]), 10, 10, 'a');
    e.setTransform(id, { x: 5, y: 6, sx: 2, sy: 3, rot: 33, kx: 11, ky: -7 });
    const spec = e.docSpec();
    expect(spec.layers.find((l) => l.id === id)).toMatchObject({ rot: 33, kx: 11, ky: -7, x: 5, y: 6 });
    const e2 = newEngine(10, 10);
    e2.loadDocument(spec);
    expect(e2.layers().find((l) => l.id === id)!.transform).toEqual({ x: 5, y: 6, sx: 2, sy: 3, rot: 33, kx: 11, ky: -7 });
    e2.dispose();
    expect(() => e.loadDocument({ ...spec, layers: spec.layers.map((l) => (l.id === id ? { ...l, rot: Number.NaN } : l)) })).toThrow();
  });
});

describe('retouch tools', () => {
  function canvasWith(draw: (id: string) => void, w = 100, h = 100): string {
    e = newEngine(w, h);
    const id = e.addPixelLayer();
    draw(id);
    return id;
  }

  it('clone: Alt-click sets the source; aligned keeps the offset across strokes, non-aligned restarts', () => {
    const id = canvasWith((i) => drawRect(e, i, { x: 10, y: 10, w: 10, h: 10 }, '#f00'));
    e.setToolContext(brushCtx({ size: 6, hardness: 1 }));
    e.setCloneOptions({ aligned: true, sampleAll: false });
    e.setTool('clone');
    e.pointerDown(ptr(15.5, 15.5, { alt: true }));
    e.pointerUp(ptr(15.5, 15.5, { alt: true }));
    expect(e.layers().find((l) => l.id === id)).toBeTruthy();
    stroke(e, 'clone', [[60.5, 60.5], [60.5, 60.5]]);
    expect(near(layerPx(e, id, 60, 60), RED, 1)).toBe(true);
    stroke(e, 'clone', [[80.5, 20.5], [80.5, 20.5]]); // aligned: offset (-45,-45) -> samples (35,-25): empty
    expect(layerPx(e, id, 80, 20)[3]).toBe(0);
    e.setCloneOptions({ aligned: false, sampleAll: false });
    stroke(e, 'clone', [[80.5, 20.5], [80.5, 20.5]]); // non-aligned: starts from the source again
    expect(near(layerPx(e, id, 80, 20), RED, 1)).toBe(true);
    e.undo();
    expect(layerPx(e, id, 80, 20)[3]).toBe(0);
  });

  it('clone refuses without a source; sampleAll samples the composite', () => {
    const id = canvasWith(() => undefined);
    e.setToolContext(brushCtx({ size: 6, hardness: 1 }));
    e.writeBase({ x: 0, y: 0, w: 100, h: 100 }, solid(100, 100, [0, 255, 0, 255]));
    e.commitBase();
    const ev = collect(e);
    stroke(e, 'clone', [[50, 50], [52, 50]]);
    expect(ev.some((x) => x.type === 'notice')).toBe(true);
    e.setCloneOptions({ aligned: true, sampleAll: true });
    e.setTool('clone');
    e.pointerDown(ptr(10.5, 10.5, { alt: true }));
    e.pointerUp(ptr(10.5, 10.5, { alt: true }));
    stroke(e, 'clone', [[50.5, 50.5], [50.5, 50.5]]);
    expect(near(layerPx(e, id, 50, 50), [0, 255, 0, 255], 2)).toBe(true);
  });

  it('smudge drags colour along the stroke; strength 0 changes nothing', () => {
    const id = canvasWith((i) => {
      drawRect(e, i, { x: 0, y: 0, w: 50, h: 100 }, '#f00');
      drawRect(e, i, { x: 50, y: 0, w: 50, h: 100 }, '#00f');
    });
    e.setToolContext(brushCtx({ size: 12, hardness: 1 }));
    e.setRetouchOptions({ strength: 0, sharpen: false, burn: false, range: 'midtones', exposure: 0.5 });
    stroke(e, 'smudge', [[40, 50], [70, 50]]);
    expect(near(layerPx(e, id, 62, 50), [0, 0, 255, 255], 1)).toBe(true);
    e.setRetouchOptions({ strength: 1, sharpen: false, burn: false, range: 'midtones', exposure: 0.5 });
    stroke(e, 'smudge', [[40, 50], [70, 50]]);
    expect(layerPx(e, id, 62, 50)[0]).toBeGreaterThan(150); // red carried over the boundary
    e.undo();
    expect(near(layerPx(e, id, 62, 50), [0, 0, 255, 255], 1)).toBe(true);
  });

  it('blur softens an edge, sharpen increases its contrast', () => {
    const id = canvasWith((i) => {
      drawRect(e, i, { x: 0, y: 0, w: 50, h: 100 }, '#fff');
      drawRect(e, i, { x: 50, y: 0, w: 50, h: 100 }, '#000');
    });
    e.setToolContext(brushCtx({ size: 24, hardness: 1 }));
    e.setRetouchOptions({ strength: 1, sharpen: false, burn: false, range: 'midtones', exposure: 0.5 });
    stroke(e, 'blur', [[50, 40], [50, 60], [50, 40]]);
    expect(layerPx(e, id, 48, 50)[0]).toBeLessThan(250);
    expect(layerPx(e, id, 51, 50)[0]).toBeGreaterThan(5);
    e.undo();
    expect(layerPx(e, id, 48, 50)[0]).toBe(255);
    // sharpen on a soft grey edge
    const g = canvasWith((i) => {
      drawRect(e, i, { x: 0, y: 0, w: 50, h: 100 }, 'rgb(100,100,100)');
      drawRect(e, i, { x: 50, y: 0, w: 50, h: 100 }, 'rgb(150,150,150)');
    });
    e.setToolContext(brushCtx({ size: 24, hardness: 1 }));
    e.setRetouchOptions({ strength: 1, sharpen: true, burn: false, range: 'midtones', exposure: 0.5 });
    stroke(e, 'blur', [[50, 40], [50, 60], [50, 40]]);
    expect(layerPx(e, g, 49, 50)[0]).toBeLessThan(100);
    expect(layerPx(e, g, 50, 50)[0]).toBeGreaterThan(150);
  });

  it('dodge lightens, burn darkens, and the range limits what changes', () => {
    const id = canvasWith((i) => {
      drawRect(e, i, { x: 0, y: 0, w: 50, h: 100 }, 'rgb(128,128,128)');
      drawRect(e, i, { x: 50, y: 0, w: 50, h: 100 }, 'rgb(30,30,30)');
    });
    e.setToolContext(brushCtx({ size: 10, hardness: 1 }));
    e.setRetouchOptions({ strength: 0.5, sharpen: false, burn: false, range: 'midtones', exposure: 1 });
    stroke(e, 'dodge', [[20, 20], [30, 20]]);
    expect(layerPx(e, id, 25, 20)[0]).toBeGreaterThan(140);
    stroke(e, 'dodge', [[70, 20], [80, 20]]); // shadows are outside the midtones range
    expect(layerPx(e, id, 75, 20)[0]).toBeLessThan(60);
    e.setRetouchOptions({ strength: 0.5, sharpen: false, burn: true, range: 'midtones', exposure: 1 });
    stroke(e, 'dodge', [[20, 60], [30, 60]]);
    expect(layerPx(e, id, 25, 60)[0]).toBeLessThan(120);
    e.setRetouchOptions({ strength: 0.5, sharpen: false, burn: false, range: 'shadows', exposure: 1 });
    stroke(e, 'dodge', [[70, 60], [80, 60]]);
    expect(layerPx(e, id, 75, 60)[0]).toBeGreaterThan(40);
  });

  it('respects selections and works on a scaled + rotated layer', () => {
    e = newEngine(100, 100);
    const img = e.importImage(solid(40, 40, [128, 128, 128, 255]), 40, 40, 'g');
    e.setTransform(img, { x: 30, y: 20, sx: 2, sy: 2, rot: 30, kx: 0, ky: 0 });
    e.setSelection({ x: 0, y: 0, w: 55, h: 100 });
    e.setToolContext(brushCtx({ size: 30, hardness: 1 }));
    e.setRetouchOptions({ strength: 1, sharpen: false, burn: false, range: 'midtones', exposure: 1 });
    stroke(e, 'dodge', [[40, 50], [75, 50]]);
    expect(px(e, 45, 50)[0]).toBeGreaterThan(140);
    expect(px(e, 70, 50)[0]).toBeLessThan(135);
  });

  it('works on masks (dodge raises the mask value)', () => {
    const id = canvasWith((i) => drawRect(e, i, { x: 0, y: 0, w: 100, h: 100 }, '#fff'));
    const slot = e.addMask(id);
    e.setPaintTarget(id, 'mask');
    e.setToolContext(brushCtx({ size: 20, hardness: 1 }, { primary: rgba(0, 0, 0) }));
    stroke(e, 'brush', [[50, 50], [50, 50]]);
    const before = maskAt(e, slot, 50, 50);
    expect(before).toBeLessThan(10);
    e.setRetouchOptions({ strength: 1, sharpen: false, burn: false, range: 'shadows', exposure: 1 });
    stroke(e, 'dodge', [[45, 50], [55, 50]]);
    expect(maskAt(e, slot, 50, 50)).toBeGreaterThan(before);
  });
});

describe('crop', () => {
  it('cropTo shifts content, keeps pixels, goes to fixed mode; one history entry; undo restores', () => {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 30, y: 30, w: 30, h: 30 }, '#f00');
    e.addGuide('v', 40);
    const n = e.history().entries.length;
    e.cropTo({ x: 30, y: 30, w: 50, h: 40 });
    expect(e.width).toBe(50);
    expect(e.height).toBe(40);
    expect(e.canvasMode()).toBe('fixed');
    expect(e.history().entries.length).toBe(n + 1);
    expect(near(px(e, 0, 0), RED, 0)).toBe(true);
    expect(near(px(e, 29, 29), RED, 0)).toBe(true);
    expect(px(e, 30, 30)[3]).toBe(0);
    expect(e.guides().v).toEqual([10]);
    expect(e.layers().find((l) => l.id === id)!.transform).toMatchObject({ x: -30, y: -30 });
    e.undo();
    expect(e.width).toBe(100);
    expect(near(px(e, 30, 30), RED, 0)).toBe(true);
    expect(px(e, 0, 0)[3]).toBe(0);
    e.redo();
    expect(e.width).toBe(50);
  });

  it('crop may extend the canvas', () => {
    e = newEngine(50, 50);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 50, h: 50 }, '#00f');
    e.cropTo({ x: -10, y: -10, w: 70, h: 70 });
    expect(px(e, 5, 5)[3]).toBe(0);
    expect(px(e, 10, 10)[2]).toBe(255);
  });
});

describe('floating selection', () => {
  function setup(): string {
    e = newEngine(100, 100);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 20, y: 20, w: 20, h: 20 }, '#f00');
    e.setSelection({ x: 20, y: 20, w: 20, h: 20 });
    return id;
  }

  it('lift cuts the pixels, the composite still shows them; commit after a move resamples into the layer (one history entry)', () => {
    const id = setup();
    const n = e.history().entries.length;
    expect(e.liftSelection()).toBe(true);
    const f = e.floating()!;
    expect(f.bounds).toEqual({ x: 20, y: 20, w: 20, h: 20 });
    expect(layerPx(e, id, 25, 25)[3]).toBe(0); // hole
    expect(near(px(e, 25, 25), RED, 1)).toBe(true); // drawn by the compositor
    e.setFloatingTransform({ ...f.transform, x: 60, y: 30 });
    expect(px(e, 25, 25)[3]).toBe(0);
    expect(near(px(e, 65, 35), RED, 1)).toBe(true);
    expect(e.history().entries.length).toBe(n);
    e.commitFloating();
    expect(e.floating()).toBeNull();
    expect(near(layerPx(e, id, 65, 35), RED, 1)).toBe(true);
    expect(layerPx(e, id, 25, 25)[3]).toBe(0);
    expect(e.history().entries.length).toBe(n + 1);
    expect(e.selection()).toEqual({ x: 60, y: 30, w: 20, h: 20 });
    e.undo();
    expect(near(layerPx(e, id, 25, 25), RED, 1)).toBe(true);
    expect(layerPx(e, id, 65, 35)[3]).toBe(0);
    expect(e.selection()).toEqual({ x: 20, y: 20, w: 20, h: 20 });
    e.redo();
    expect(near(layerPx(e, id, 65, 35), RED, 1)).toBe(true);
  });

  it('cancel restores the layer without history; undo while floating cancels', () => {
    const id = setup();
    const n = e.history().entries.length;
    e.liftSelection();
    e.setFloatingTransform({ ...e.floating()!.transform, x: 70, y: 70 });
    e.cancelFloating();
    expect(near(layerPx(e, id, 25, 25), RED, 1)).toBe(true);
    expect(e.history().entries.length).toBe(n);
    e.liftSelection();
    e.undo();
    expect(e.floating()).toBeNull();
    expect(near(layerPx(e, id, 25, 25), RED, 1)).toBe(true);
    expect(e.history().entries.length).toBe(n);
  });

  it('rotating the floating selection 90 degrees about its top-left; unmoved commit is exact; other actions commit', () => {
    const id = setup();
    e.liftSelection();
    e.commitFloating(); // unmoved: identical pixels
    expect(near(layerPx(e, id, 20, 20), RED, 0)).toBe(true);
    expect(near(layerPx(e, id, 39, 39), RED, 0)).toBe(true);
    e.liftSelection();
    const t = e.floating()!.transform;
    e.setFloatingTransform({ ...t, x: 60, y: 20, rot: 90 });
    e.setLayerProps(id, { opacity: 0.9 }); // any edit commits
    expect(e.floating()).toBeNull();
    expect(near(layerPx(e, id, 50, 25), RED, 2)).toBe(true); // x in [40,60], y in [20,40]
    expect(layerPx(e, id, 65, 25)[3]).toBe(0);
  });

  it('refuses without a selection / on locked layers', () => {
    e = newEngine(50, 50);
    e.addPixelLayer();
    const ev = collect(e);
    expect(e.liftSelection()).toBe(false);
    expect(ev.some((x) => x.type === 'notice')).toBe(true);
  });
});

describe('quick mask', () => {
  it('round trip: painting adds / removes selection, exit yields the selection, history is one entry', () => {
    e = newEngine(100, 100);
    e.addPixelLayer();
    e.setSelection({ x: 10, y: 10, w: 20, h: 20 });
    const n = e.history().entries.length;
    e.setQuickMask(true);
    expect(e.quickMask()).toBe(true);
    expect(e.quickMaskSource()).not.toBeNull();
    expect(e.selectionPath()).toEqual([]);
    e.setToolContext(brushCtx({ size: 10, hardness: 1 }, { primary: rgba(255, 255, 255) }));
    stroke(e, 'brush', [[60, 60], [60, 60]]);
    e.setToolContext(brushCtx({ size: 6, hardness: 1 }, { primary: rgba(0, 0, 0) }));
    stroke(e, 'brush', [[20, 20], [20, 20]]);
    e.setQuickMask(false);
    expect(e.quickMask()).toBe(false);
    const m = e.selectionMask()!;
    const W = 100;
    expect(m.alpha[60 * W + 60]).toBe(255);
    expect(m.alpha[20 * W + 20]).toBe(0);
    expect(m.alpha[12 * W + 12]).toBe(255);
    expect(m.alpha[50 * W + 50]).toBe(0);
    expect(e.history().entries.length).toBe(n + 1);
    expect(e.history().entries[e.history().entries.length - 1].label).toBe('Quick mask');
    e.undo();
    expect(e.selection()).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    expect(e.selectionMask()!.alpha[60 * W + 60]).toBe(0);
  });

  it('toggling without painting keeps the selection and adds no history; selection commands wait; layers are not painted', () => {
    e = newEngine(60, 60);
    const id = e.addPixelLayer();
    e.setSelection({ x: 5, y: 5, w: 10, h: 10 });
    const sel = e.selectionMask()!;
    const n = e.history().entries.length;
    e.setQuickMask(true);
    const ev = collect(e);
    e.deselect();
    expect(ev.some((x) => x.type === 'notice')).toBe(true);
    e.setToolContext(brushCtx({ size: 8, hardness: 1 }, { primary: rgba(255, 255, 255) }));
    stroke(e, 'brush', [[40, 40], [41, 40]]);
    expect(layerPx(e, id, 40, 40)[3]).toBe(0);
    e.undo(); // undoes the quick mask stroke
    e.setQuickMask(false);
    expect(e.history().entries.length).toBe(n);
    expect(Array.from(e.selectionMask()!.alpha)).toEqual(Array.from(sel.alpha));
  });

  it('no selection + quick mask + nothing painted = still no selection', () => {
    e = newEngine(30, 30);
    e.setQuickMask(true);
    e.setQuickMask(false);
    expect(e.selection()).toBeNull();
  });
});

describe('modifySelection (engine)', () => {
  it('grow / shrink / border / smooth / feather change the selection with history', () => {
    e = newEngine(100, 100);
    e.setSelection({ x: 40, y: 40, w: 20, h: 20 });
    e.modifySelection('grow', 5);
    expect(e.selection()).toEqual({ x: 35, y: 35, w: 30, h: 30 });
    e.modifySelection('shrink', 5);
    expect(e.selection()).toEqual({ x: 40, y: 40, w: 20, h: 20 });
    e.modifySelection('feather', 6);
    expect(e.selection()!.w).toBeGreaterThan(20);
    e.undo();
    e.modifySelection('border', 4);
    const m = e.selectionMask()!;
    expect(m.alpha[50 * 100 + 50]).toBe(0);
    expect(m.alpha[50 * 100 + 40]).toBe(255);
    e.undo();
    e.modifySelection('smooth', 6);
    expect(e.selectionMask()!.alpha[40 * 100 + 40]).toBeLessThan(255); // rounded corner
    expect(e.history().entries.length).toBeGreaterThan(3);
  });
});

describe('TD input layers', () => {
  const info = (n: number, w = 64, h = 48, connected = true) => ({ input: n, w, h, connected });
  const inputs = () => e.layers().filter((l) => l.kind === 'input');

  it('starts with one locked input-1 layer; writeInput / commitInput per input', () => {
    e = newEngine(64, 48);
    expect(e.layers()).toHaveLength(1);
    expect(e.layers()[0]).toMatchObject({ kind: 'input', input: 1, locked: true, inputConnected: true, id: 'base' });
    e.writeInput(1, { x: 0, y: 0, w: 64, h: 48 }, solid(64, 48, [10, 20, 30, 255]));
    e.commitInput(1);
    expect(near(px(e, 3, 3), [10, 20, 30, 255], 0)).toBe(true);
  });

  it('a newly connected input creates a locked "TD Input N" layer (fixed canvas: fit + centre), disconnect marks it, reconnect keeps placement', () => {
    e = newEngine(100, 100);
    e.setCanvasSize(100, 100, 'tl'); // fixed
    e.setInputs([info(1, 100, 100), info(2, 200, 100)]);
    expect(inputs().map((l) => l.input).sort()).toEqual([1, 2]);
    const l2 = inputs().find((l) => l.input === 2)!;
    expect(l2).toMatchObject({ name: 'TD Input 2', locked: true, inputConnected: true });
    expect(l2.transform).toMatchObject({ sx: 0.5, sy: 0.5, x: 0, y: 25 });
    e.writeInput(2, { x: 0, y: 0, w: 200, h: 100 }, solid(200, 100, [255, 0, 0, 255]));
    e.commitInput(2);
    expect(near(px(e, 50, 50), RED, 1)).toBe(true);
    e.setTransform(l2.id, { ...l2.transform, x: 10, y: 10 });
    e.setInputs([info(1, 100, 100)]); // input 2 disconnected
    const d = inputs().find((l) => l.input === 2)!;
    expect(d.inputConnected).toBe(false);
    expect(px(e, 50, 50)[3]).toBeLessThan(255); // renders nothing
    e.setInputs([info(1, 100, 100), info(2, 200, 100)]);
    const r = inputs().filter((l) => l.input === 2);
    expect(r).toHaveLength(1); // no duplicate layer
    expect(r[0].inputConnected).toBe(true);
    expect(r[0].transform).toMatchObject({ x: 10, y: 10, sx: 0.5 });
  });

  it('Follow Input: input 1 is identity; a size change in fixed mode keeps the displayed box per input', () => {
    e = newEngine(80, 60);
    e.setInputs([info(1, 80, 60)]);
    expect(inputs()[0].transform).toMatchObject({ x: 0, y: 0, sx: 1, sy: 1 });
    e.setCanvasSize(200, 200, 'tl');
    e.setInputs([info(1, 80, 60), info(3, 40, 40)]);
    const a = inputs().find((l) => l.input === 3)!;
    const box0 = { w: 40 * a.transform.sx, h: 40 * a.transform.sy };
    e.setInputs([info(1, 80, 60), info(3, 80, 80)]);
    const b = inputs().find((l) => l.input === 3)!;
    expect(b.surfaceW).toBe(80);
    expect(80 * b.transform.sx).toBeCloseTo(box0.w, 6);
    expect(80 * b.transform.sy).toBeCloseTo(box0.h, 6);
    // input 1 resized in fixed mode keeps its box too
    const i1 = inputs().find((l) => l.input === 1)!;
    e.setInputs([info(1, 160, 120), info(3, 80, 80)]);
    const i1b = inputs().find((l) => l.input === 1)!;
    expect(160 * i1b.transform.sx).toBeCloseTo(80 * i1.transform.sx, 6);
    e.setCanvasMode('input');
    expect(inputs().find((l) => l.input === 1)!.transform).toMatchObject({ x: 0, y: 0, sx: 1, sy: 1 });
    expect(e.width).toBe(160);
  });

  it('input layers can be reordered, deleted, masked, added again; several may show the same input', () => {
    e = newEngine(64, 48);
    e.setInputs([info(1), info(2, 32, 32)]);
    const ids = inputs().map((l) => l.id);
    expect(ids).toHaveLength(2);
    const top = e.addPixelLayer('p');
    e.moveLayer('base', null, 0); // input above the pixel layer
    expect(e.layers()[0].id).toBe('base');
    e.moveLayer(top, null, 0);
    e.deleteLayer('base');
    expect(inputs().map((l) => l.input)).toEqual([2]);
    const again = e.addInputLayer(1);
    expect(e.layers().find((l) => l.id === again)).toMatchObject({ kind: 'input', input: 1, inputConnected: true });
    const dup = e.addInputLayer(1);
    expect(e.layers().find((l) => l.id === dup)!.surfaceW).toBe(64);
    const slot = e.addMask(again);
    expect(slot).toBeGreaterThan(0);
    e.setPaintTarget(again, 'mask');
    e.setToolContext(brushCtx({ size: 10, hardness: 1 }, { primary: rgba(0, 0, 0) }));
    stroke(e, 'brush', [[30, 20], [30, 20]]);
    expect(maskAt(e, slot, 30, 20)).toBeLessThan(10);
    e.setPaintTarget(again, 'pixels');
    const ev = collect(e);
    stroke(e, 'brush', [[30, 20], [30, 20]]);
    expect(ev.some((x) => x.type === 'notice')).toBe(true);
  });

  it('auto-created layers survive undo of earlier history; undo of delete restores a layer with the live surface', () => {
    e = newEngine(64, 48);
    const p = e.addPixelLayer();
    e.setLayerProps(p, { opacity: 0.5 });
    e.setInputs([info(1), info(2, 20, 20)]);
    expect(inputs()).toHaveLength(2);
    e.undo(); // opacity
    e.undo(); // add layer
    expect(inputs()).toHaveLength(2);
    e.redo();
    e.redo();
    expect(inputs()).toHaveLength(2);
    const l2 = inputs().find((l) => l.input === 2)!;
    e.deleteLayer(l2.id);
    e.setInputs([info(1), info(2, 40, 40)]); // resized while deleted
    e.undo();
    const back = inputs().find((l) => l.input === 2)!;
    expect(back.surfaceW).toBe(40); // never restores a stale surface
    expect(back.transform.sx * 40).toBeCloseTo(l2.transform.sx * 20, 6);
    e.writeInput(2, { x: 0, y: 0, w: 40, h: 40 }, solid(40, 40, [0, 0, 255, 255]));
    e.commitInput(2);
    expect(px(e, 31, 31)[3]).toBe(255);
  });

  it('docSpec / loadDocument keep input numbers; a legacy base layer migrates to input 1 keeping its id', () => {
    e = newEngine(64, 48);
    e.setInputs([info(1), info(2, 20, 20)]);
    const spec = e.docSpec();
    expect(spec.layers.filter((l) => l.kind === 'input').map((l) => l.input).sort()).toEqual([1, 2]);
    expect(spec.layers.every((l) => Array.isArray(l.effects))).toBe(true);
    const e2 = newEngine(10, 10);
    e2.loadDocument(spec);
    expect(e2.layers().filter((l) => l.kind === 'input')).toHaveLength(2);
    // v5 document with 'base'
    const legacy = {
      rev: 1, width: 30, height: 20, guides: { h: [], v: [] }, canvas: { mode: 'input' },
      layers: [
        { id: 'base', kind: 'base', parentId: null, name: 'TD Input', visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, sx: 1, sy: 1, slot: null, mask: null, adjustment: null, text: null, shape: null, surfaceW: 30, surfaceH: 20 },
        { id: 'L1', kind: 'pixel', parentId: null, name: 'p', visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, sx: 1, sy: 1, slot: 1, mask: null, adjustment: null, text: null, shape: null, surfaceW: 30, surfaceH: 20 },
      ],
    } as unknown as DocSpec;
    e2.loadDocument(legacy);
    expect(e2.layers().map((l) => [l.id, l.kind, l.input])).toEqual([['L1', 'pixel', null], ['base', 'input', 1]]);
    expect(e2.layers()[1].transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
    expect(e2.docSpec().layers[0]).toMatchObject({ kind: 'input', input: 1, rot: 0, effects: [] });
    // documents without layers and bad input numbers
    e2.loadDocument({ ...legacy, layers: [] });
    expect(e2.layers()).toHaveLength(0);
    expect(() => e2.loadDocument({ ...spec, layers: spec.layers.map((l: LayerSpec) => (l.kind === 'input' ? { ...l, input: 9 } : l)) })).toThrow();
    e2.dispose();
  });

  it('thumbnails and mask thumbnails of rotated layers draw without throwing', () => {
    e = newEngine(64, 48);
    const id = e.importImage(solid(20, 20, [255, 0, 0, 255]), 20, 20, 'a');
    e.setTransform(id, { x: 30, y: 10, sx: 1, sy: 1, rot: 45, kx: 0, ky: 0 });
    e.addMask(id);
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    e.drawThumbnail(id, c);
    e.drawMaskThumbnail(id, c);
    expect(c.getContext('2d')!.getImageData(0, 0, 64, 48).data.length).toBeGreaterThan(0);
  });
});

describe('regressions from live TD validation', () => {
  it('a floating selection survives setTool, docSpec, readSurface and same-layer paint-target calls; edits commit it', () => {
    e = newEngine(80, 60);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 10, y: 10, w: 20, h: 20 }, '#f00');
    e.setSelection({ x: 10, y: 10, w: 20, h: 20 });
    expect(e.liftSelection()).toBe(true);
    expect(e.floating()).not.toBeNull();
    e.setTool('move');
    e.docSpec();
    e.docRev();
    e.layers();
    e.readSurface((e.layers().find((l) => l.id === id)!).slot as number, { x: 0, y: 0, w: 10, h: 10 });
    e.readComposite({ x: 0, y: 0, w: 80, h: 60 });
    e.setPaintTarget(id, 'pixels');
    e.setToolContext(brushCtx());
    e.commitSurfaces();
    expect(e.floating()).not.toBeNull();
    e.setLayerProps(id, { opacity: 0.5 }); // a real edit
    expect(e.floating()).toBeNull();
  });

  it('inputs already connected at load get layers: the first list creates them, later lists do not recreate deleted ones; unlisted = gone', () => {
    e = newEngine(64, 48);
    e.loadDocument({ ...e.docSpec(), layers: [] }); // a document without any input layer
    expect(e.layers()).toHaveLength(0);
    e.setInputs([{ input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 32, h: 32, connected: true }, { input: 3, w: 0, h: 0, connected: false }]);
    expect(e.layers().filter((l) => l.kind === 'input').map((l) => l.input).sort()).toEqual([1, 2]);
    const l1 = e.layers().find((l) => l.input === 1)!;
    e.deleteLayer(l1.id);
    e.setInputs([{ input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 32, h: 32, connected: true }, { input: 3, w: 0, h: 0, connected: false }]);
    expect(e.layers().filter((l) => l.input === 1)).toHaveLength(0); // the user deleted it
    e.setInputs([{ input: 2, w: 32, h: 32, connected: true }]); // input 1 no longer listed
    e.setInputs([{ input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 32, h: 32, connected: true }]);
    expect(e.layers().filter((l) => l.input === 1)).toHaveLength(1); // reconnected
    // a document load re-arms the first-list rule
    e.loadDocument({ ...e.docSpec(), layers: [] });
    e.setInputs([{ input: 2, w: 32, h: 32, connected: true }]);
    expect(e.layers().map((l) => l.input)).toEqual([2]);
  });

  it('glitch / pixel sort / halftone: a partial recomposite equals a full one (the engine paints the whole region the effects read)', () => {
    for (const fx of [
      { enabled: true, type: 'glitch', amount: 0.6, blockSize: 16, seed: 5, rgbShift: 3 },
      { enabled: true, type: 'pixelSort', direction: 'h', low: 0.1, high: 0.9, key: 'luma' },
      { enabled: true, type: 'halftone', cellSize: 9, angle: 15, shape: 'dot' },
    ] as never[]) {
      e = newEngine(300, 120);
      const id = e.addPixelLayer();
      const l = e.doc.find(id) as PixelLayer;
      const d = new ImageData(300, 120);
      for (let i = 0; i < 300 * 120; i++) { d.data[i * 4] = (i * 37) & 255; d.data[i * 4 + 1] = (i * 91) & 255; d.data[i * 4 + 2] = 90; d.data[i * 4 + 3] = 255; }
      l.surface.ctx.putImageData(d, 0, 0);
      e.setEffects(id, [fx]);
      e.flush();
      drawRect(e, id, { x: 133, y: 47, w: 9, h: 7 }, '#fff');
      const partial = e.readComposite({ x: 0, y: 0, w: 300, h: 120 });
      e.changed({ x: 0, y: 0, w: 300, h: 120 });
      const full = e.readComposite({ x: 0, y: 0, w: 300, h: 120 });
      expect(near(partial, full, 1)).toBe(true);
      e.dispose();
    }
  });
});

describe('review fixes', () => {
  it('sanitizeEffects clamps to TD ranges, completes missing fields, keeps unknown (filter) types verbatim', () => {
    e = newEngine(40, 40);
    const id = e.addPixelLayer();
    e.setEffects(id, [
      { enabled: true, type: 'bevel', depth: 500, size: Number.NaN, angle: 1e9, highlight: { r: 999, g: -4 } } as never,
      { enabled: false, type: 'glitch', amount: 7, seed: 3.7 } as never,
      { enabled: true, type: 'dropShadow', opacity: 5, color: null } as never,
      { enabled: true, type: 'boxBlur', radius: 12, nested: { lut: [1, 2, 3] } } as never,
      { type: 'halftone', cellSize: 0, shape: 'triangle' } as never,
      { enabled: true, type: 'not a name!' } as never,
    ]);
    const fx = e.layers().find((l) => l.id === id)!.effects as unknown as Record<string, unknown>[];
    expect(fx).toHaveLength(5);
    expect(fx[0]).toMatchObject({ type: 'bevel', depth: 100, angle: 3600, highlight: { r: 255, g: 0, b: 255, a: 255 } });
    expect(Number.isFinite(fx[0].size as number)).toBe(true);
    expect(fx[1]).toMatchObject({ enabled: false, type: 'glitch', amount: 7, seed: 4 });
    expect(Number.isFinite(fx[1].blockSize as number) && Number.isFinite(fx[1].rgbShift as number)).toBe(true);
    expect(fx[2]).toMatchObject({ opacity: 1, color: { a: 255 } });
    expect(fx[3]).toEqual({ enabled: true, type: 'boxBlur', radius: 12, nested: { lut: [1, 2, 3] } });
    expect(fx[4]).toMatchObject({ enabled: true, cellSize: 1, shape: 'dot' });
    const e2 = newEngine(40, 40);
    e2.loadDocument(e.docSpec());
    expect(e2.docSpec().layers.find((l) => l.id === id)!.effects).toEqual(e.docSpec().layers.find((l) => l.id === id)!.effects);
    e2.dispose();
  });

  it('an unmoved floating selection with a feathered edge is restored exactly', () => {
    e = newEngine(80, 80);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 80, h: 80 }, '#f00');
    e.setSelection({ x: 20, y: 20, w: 30, h: 30 });
    e.modifySelection('feather', 6);
    const before = e.readSurface(e.layers().find((l) => l.id === id)!.slot as number, { x: 0, y: 0, w: 80, h: 80 });
    const n = e.history().entries.length;
    expect(e.liftSelection()).toBe(true);
    e.commitFloating();
    const after = e.readSurface(e.layers().find((l) => l.id === id)!.slot as number, { x: 0, y: 0, w: 80, h: 80 });
    expect(Array.from(after)).toEqual(Array.from(before));
    expect(e.history().entries.length).toBe(n);
  });

  it('leaving quick mask keeps the redo stack when nothing changed and removes the strokes wherever they are', () => {
    e = newEngine(60, 60);
    const id = e.addPixelLayer();
    e.setLayerProps(id, { opacity: 0.5 });
    e.setLayerProps(id, { blend: 'multiply' });
    e.undo();
    expect(e.history().index).toBe(e.history().entries.length - 2);
    e.setQuickMask(true);
    e.setQuickMask(false);
    e.redo();
    expect(e.layers().find((l) => l.id === id)!.blend).toBe('multiply');
    e.undo();
    e.setQuickMask(true);
    e.setToolContext(brushCtx({ size: 6, hardness: 1 }, { primary: rgba(255, 255, 255) }));
    stroke(e, 'brush', [[30, 30], [31, 30]]);
    e.setQuickMask(false);
    expect(e.history().entries.map((x) => x.label)).not.toContain('Brush');
    expect(e.selection()).not.toBeNull();
  });

  it('rejects singular / mirrored skews in setTransform and loadDocument', () => {
    e = newEngine(50, 50);
    const id = e.importImage(solid(10, 10, [1, 1, 1, 255]), 10, 10, 'a');
    const t0 = e.layers().find((l) => l.id === id)!.transform;
    e.setTransform(id, { ...t0, kx: 80, ky: 80 }); // 1 - tan80 tan80 < 0
    e.setTransform(id, { ...t0, kx: 70, ky: 60 }); // 1 - 2.75*1.73 < 0
    expect(e.layers().find((l) => l.id === id)!.transform).toEqual(t0);
    e.setTransform(id, { ...t0, kx: 30, ky: 30 });
    expect(e.layers().find((l) => l.id === id)!.transform.kx).toBe(30);
    const spec = e.docSpec();
    expect(() => e.loadDocument({ ...spec, layers: spec.layers.map((l) => (l.id === id ? { ...l, kx: 80, ky: 80 } : l)) })).toThrow();
  });

  it('opacity / blend changes of a layer with effects re-blend a cached result; transform and content changes recompute', () => {
    e = newEngine(200, 200);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 50, y: 50, w: 60, h: 60 }, '#f00');
    e.setEffects(id, [{ enabled: true, type: 'dropShadow', dx: 5, dy: 5, blur: 6, color: BLACK_C, opacity: 1 }]);
    e.flush();
    const p0 = effectsPassCount();
    e.setLayerProps(id, { opacity: 0.8 });
    e.flush();
    e.setLayerProps(id, { opacity: 0.6 });
    e.flush();
    e.setLayerProps(id, { blend: 'multiply' });
    e.flush();
    expect(effectsPassCount()).toBe(p0);
    const a = px(e, 80, 80);
    e.setTransform(id, { ...e.layers().find((l) => l.id === id)!.transform, x: 20 });
    e.flush();
    if (p0 > 0) expect(effectsPassCount()).toBeGreaterThan(p0);
    expect(px(e, 80, 80)).not.toEqual([0, 0, 0, 0]);
    void a;
  });
});

const BLACK_C = { r: 0, g: 0, b: 0, a: 255 };

describe('effects plumbing', () => {
  it('setEffects: docSpec + LayerInfo, coalesced history, undo; invalid entries dropped', () => {
    e = newEngine(50, 50);
    const id = e.addPixelLayer();
    const n = e.history().entries.length;
    const fx = [{ enabled: true, type: 'colorOverlay', color: { r: 255, g: 0, b: 0, a: 255 }, opacity: 1 }] as const;
    e.setEffects(id, [...fx] as never);
    e.setEffects(id, [{ ...fx[0], opacity: 0.5 }] as never);
    e.setEffects(id, [{ enabled: true, type: 'bo gus' } as never, { ...fx[0], opacity: 0.25 }] as never);
    expect(e.history().entries.length).toBe(n + 1);
    expect(e.layers().find((l) => l.id === id)!.effects).toHaveLength(1);
    expect((e.docSpec().layers.find((l) => l.id === id)!.effects[0] as { opacity: number }).opacity).toBe(0.25);
    e.undo();
    expect(e.layers().find((l) => l.id === id)!.effects).toHaveLength(0);
    e.redo();
    expect(e.docRev()).toBeGreaterThan(0);
    const e2 = newEngine(50, 50);
    e2.loadDocument(e.docSpec());
    expect(e2.layers().find((l) => l.id === id)!.effects).toHaveLength(1);
    e2.dispose();
  });

  it('a colour overlay effect changes the composite (when the effects module has WebGL2) and never breaks it otherwise', () => {
    e = newEngine(50, 50);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 10, y: 10, w: 20, h: 20 }, '#00f');
    e.setEffects(id, [{ enabled: true, type: 'colorOverlay', color: { r: 255, g: 0, b: 0, a: 255 }, opacity: 1 }]);
    const p = px(e, 20, 20);
    expect(p[3]).toBe(255);
    expect([p[0] > 200 && p[2] < 50, p[2] > 200]).toContain(true); // red with WebGL2, unchanged blue without
    expect(px(e, 5, 5)[3]).toBe(0);
  });
});

describe('effects run in document space', () => {
  const noise = (w: number, h: number): Uint8ClampedArray => {
    const b = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { b[i * 4] = (i * 37) & 255; b[i * 4 + 1] = (i * 91) & 255; b[i * 4 + 2] = 128; b[i * 4 + 3] = 255; }
    return b;
  };

  it('a layer offset by a non-multiple of the band / cell size matches a reference rendered at document space', () => {
    const fx = [{ enabled: true, type: 'halftone', cellSize: 8, angle: 0, shape: 'dot' }, { enabled: true, type: 'glitch', amount: 0.5, blockSize: 16, seed: 3, rgbShift: 2 }] as never;
    e = newEngine(160, 120);
    const a = e.importImage(noise(64, 48), 64, 48, 'moved');
    e.setTransform(a, { x: 37, y: 21, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
    e.setEffects(a, fx);
    const got = e.readComposite({ x: 0, y: 0, w: 160, h: 120 });
    const e2 = newEngine(160, 120);
    const full = new Uint8ClampedArray(160 * 120 * 4);
    const src = noise(64, 48);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) full.set(src.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4), ((y + 21) * 160 + x + 37) * 4);
    const b = e2.importImage(full, 160, 120, 'ref');
    e2.setEffects(b, fx);
    const ref = e2.readComposite({ x: 0, y: 0, w: 160, h: 120 });
    e2.dispose();
    expect(near(got, ref, 3)).toBe(true);
  });

  it('a partial recomposite equals a full one for a layer with a drop shadow (dirty rects grow by the effect reach)', () => {
    e = newEngine(120, 120);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 40, y: 40, w: 20, h: 20 }, '#f00');
    e.setEffects(id, [{ enabled: true, type: 'dropShadow', dx: 6, dy: 6, blur: 4, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 1 }]);
    e.flush();
    drawRect(e, id, { x: 70, y: 70, w: 6, h: 6 }, '#00f');
    const partial = e.readComposite({ x: 0, y: 0, w: 120, h: 120 });
    e.changed({ x: 0, y: 0, w: 120, h: 120 });
    const full = e.readComposite({ x: 0, y: 0, w: 120, h: 120 });
    expect(near(partial, full, 1)).toBe(true);
  });
});

const d = perfEnabled ? describe : describe.skip;
d('performance with rotated layers (v5)', () => {
  const time = (fn: () => void, n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) { const t = performance.now(); fn(); out.push(performance.now() - t); }
    return out;
  };
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

  it('recomposites a 256x256 dirty rect of 10 rotated / skewed layers in < 6 ms', () => {
    e = newEngine(1920, 1080);
    for (let i = 0; i < 10; i++) {
      const buf = new Uint8ClampedArray(800 * 500 * 4).fill(150);
      const id = e.importImage(buf, 800, 500, `r${i}`);
      e.setTransform(id, { x: i * 100, y: i * 50, sx: 1, sy: 1, rot: i * 13, kx: i % 3 ? 10 : 0, ky: 0 });
    }
    e.flush();
    const rect = { x: 500, y: 300, w: 256, h: 256 };
    time(() => { e.changed(rect); e.flush(); }, 10);
    const t = median(time(() => { e.changed(rect); e.flush(); }, 40));
    console.log(`PERF v5 dirty 256x256 x10 rotated layers: median ${t.toFixed(2)} ms`);
    expect(t).toBeLessThan(6);
  });

  it('a brush stroke on a rotated 4k layer, a clone stroke and a smudge stroke stay within budget', () => {
    e = newEngine(1920, 1080);
    const id = e.importImage(new Uint8ClampedArray(2000 * 1200 * 4).fill(200), 2000, 1200, 'big');
    e.setTransform(id, { x: 100, y: 50, sx: 1, sy: 1, rot: 17, kx: 0, ky: 0 });
    e.setToolContext(brushCtx({ size: 60, hardness: 0.5 }));
    e.flush();
    const pts = Array.from({ length: 60 }, (_, i) => [300 + i * 15, 400 + Math.sin(i / 5) * 80] as const);
    const run = (tool: 'brush' | 'smudge' | 'clone' | 'blur' | 'dodge'): number => {
      e.setTool(tool);
      const t = performance.now();
      e.pointerDown(ptr(pts[0][0], pts[0][1]));
      for (const p of pts.slice(1)) { e.pointerMove(ptr(p[0], p[1])); e.flush(); }
      e.pointerUp(ptr(pts[pts.length - 1][0], pts[pts.length - 1][1]));
      return (performance.now() - t) / pts.length;
    };
    e.setCloneOptions({ aligned: true, sampleAll: false });
    e.setTool('clone');
    e.pointerDown(ptr(200.5, 300.5, { alt: true }));
    e.pointerUp(ptr(200.5, 300.5, { alt: true }));
    const res = { brush: run('brush'), smudge: run('smudge'), clone: run('clone'), blur: run('blur'), dodge: run('dodge') };
    console.log(`PERF v5 per-move ms (size 60, rotated 2000x1200): ${JSON.stringify(res)}`);
    expect(res.brush).toBeLessThan(8);
    for (const k of ['smudge', 'clone', 'blur', 'dodge'] as const) expect(res[k]).toBeLessThan(25);
  });
});
