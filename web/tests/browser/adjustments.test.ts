import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { AdjustmentSpec, Rect } from '../../src/engine/types';
import { levelsLut } from '../../src/engine/adjustments';
import { brushCtx, collect, maskAt, near, newEngine, px, rgba, setBase, solidLayer, stroke, type Px } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const SRC: Px = [100, 150, 200, 255];
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const to8 = (v: number) => Math.round(clamp(v) * 255);

function withAdj(spec: AdjustmentSpec, src: Px = SRC): string {
  e = newEngine(24, 24);
  setBase(e, src);
  const id = e.addAdjustment(spec.type);
  e.setAdjustment(id, spec);
  return id;
}

describe('adjustment layers: formulas (see adjustments.ts)', () => {
  it('defaults are identities where possible', () => {
    for (const t of ['levels', 'brightnessContrast', 'hueSaturation'] as const) {
      e = newEngine(8, 8);
      setBase(e, SRC);
      e.addAdjustment(t);
      expect(px(e, 3, 3)).toEqual(SRC);
      e.dispose();
    }
    e = newEngine(8, 8);
  });

  it('adds above the active layer, named and active, with one history entry', () => {
    e = newEngine(8, 8);
    const a = e.addAdjustment('levels');
    const b = e.addPixelLayer();
    const c = e.addAdjustment('blur');
    expect(e.layers().map((l) => [l.id, l.kind, l.name])).toEqual([[c, 'adjustment', 'Blur'], [b, 'pixel', 'Layer 1'], [a, 'adjustment', 'Levels'], ['base', 'input', 'TD Input']]);
    expect(e.activeLayerId()).toBe(c);
    expect(e.layers()[0].adjustment).toEqual({ type: 'blur', radius: 4 });
    expect(e.history().entries.map((x) => x.label)).toEqual(['Add adjustment', 'Add layer', 'Add adjustment']);
    e.undo();
    expect(e.layers()).toHaveLength(3);
  });

  it('levels', () => {
    const spec: AdjustmentSpec = { type: 'levels', inLow: 0.2, inHigh: 0.8, gamma: 2, outLow: 0.1, outHigh: 0.9 };
    withAdj(spec);
    const lut = levelsLut(spec);
    expect(near(px(e, 5, 5), [lut[100], lut[150], lut[200], 255], 1)).toBe(true);
    const manual = (v: number) => to8(0.1 + Math.sqrt(clamp((v / 255 - 0.2) / 0.6)) * 0.8);
    expect(near(px(e, 5, 5), [manual(100), manual(150), manual(200), 255], 2)).toBe(true);
  });

  it('brightness / contrast', () => {
    withAdj({ type: 'brightnessContrast', brightness: 0.2, contrast: 0.5 });
    const f = (v: number) => to8((clamp((v / 255) * 1.2) - 0.5) * 1.5 + 0.5);
    expect(near(px(e, 5, 5), [f(100), f(150), f(200), 255], 3)).toBe(true);
    e.dispose();
    withAdj({ type: 'brightnessContrast', brightness: -0.3, contrast: -0.4 });
    const g = (v: number) => to8(((v / 255) * 0.7 - 0.5) * 0.6 + 0.5);
    expect(near(px(e, 5, 5), [g(100), g(150), g(200), 255], 3)).toBe(true);
  });

  it('hue / saturation / value', () => {
    withAdj({ type: 'hueSaturation', hue: 0, saturation: 0, value: 1 });
    expect(near(px(e, 5, 5), [200, 200, 200, 255], 1)).toBe(true);
    e.dispose();
    withAdj({ type: 'hueSaturation', hue: 0, saturation: 1, value: 0.5 });
    expect(near(px(e, 5, 5), [50, 75, 100, 255], 2)).toBe(true);
    e.dispose();
    withAdj({ type: 'hueSaturation', hue: 90, saturation: 1.5, value: 1 });
    // HSV(210 deg, 0.5, 0.784): hue +90 -> 300 deg, S' = 0.75 -> (200, 50, 200)
    expect(near(px(e, 5, 5), [200, 50, 200, 255], 2)).toBe(true);
  });

  it('invert keeps alpha; transparent stays transparent', () => {
    withAdj({ type: 'invert' });
    expect(px(e, 5, 5)).toEqual([155, 105, 55, 255]);
    e.dispose();
    e = newEngine(8, 8);
    const l = solidLayer(e, 'rgba(255,0,0,0.5)');
    e.setActiveLayer(l);
    const a = e.addAdjustment('invert');
    expect(a).toBeTruthy();
    const got = px(e, 2, 2);
    expect(got[3]).toBeGreaterThan(125);
    expect(got[3]).toBeLessThan(131);
    expect(got[0]).toBeLessThan(5);
    expect(got[2]).toBeGreaterThan(250);
    e.setActiveLayer('base');
    expect(px(e, 2, 2)[3]).toBeGreaterThan(0);
  });

  it('threshold uses Rec.709 luminance, alpha preserved', () => {
    withAdj({ type: 'threshold', level: 0.5 }, [100, 150, 200, 255]); // lum = 21.3+107.3+14.4 = 143 > 127.5
    expect(px(e, 5, 5)).toEqual([255, 255, 255, 255]);
    e.dispose();
    withAdj({ type: 'threshold', level: 0.6 }, [100, 150, 200, 255]);
    expect(px(e, 5, 5)).toEqual([0, 0, 0, 255]);
    e.dispose();
    withAdj({ type: 'threshold', level: 0.5 }, [255, 0, 0, 255]); // lum 54
    expect(px(e, 5, 5)).toEqual([0, 0, 0, 255]);
    e.dispose();
    withAdj({ type: 'threshold', level: 0.5 }, [0, 255, 0, 255]); // lum 182
    expect(px(e, 5, 5)).toEqual([255, 255, 255, 255]);
  });

  it('blur smooths an edge, leaves flat areas, and radius 0 is the identity', () => {
    e = newEngine(60, 20);
    const w = solidLayer(e, 'rgb(255,255,255)');
    e.setActiveLayer(w);
    const l = e.doc.find(w) as import('../../src/engine/model').PixelLayer;
    l.surface.ctx.clearRect(30, 0, 30, 20);
    l.surface.ctx.fillStyle = '#000';
    l.surface.ctx.fillRect(30, 0, 30, 20);
    e.changed({ x: 0, y: 0, w: 60, h: 20 });
    const a = e.addAdjustment('blur');
    e.setAdjustment(a, { type: 'blur', radius: 4 });
    expect(Math.abs(px(e, 29, 10)[0] - 140)).toBeLessThan(25); // half way across the edge
    expect(px(e, 29, 10)[0]).toBeGreaterThan(px(e, 33, 10)[0]);
    expect(px(e, 5, 10)[0]).toBeGreaterThan(250);
    expect(px(e, 55, 10)[0]).toBeLessThan(5);
    e.setAdjustment(a, { type: 'blur', radius: 0 });
    expect(px(e, 29, 10)).toEqual([255, 255, 255, 255]);
    expect(px(e, 30, 10)).toEqual([0, 0, 0, 255]);
  });
});

describe('adjustment layers: stacking and mixing', () => {
  it('applies to everything below, not above', () => {
    e = newEngine(20, 20);
    setBase(e, [200, 0, 0, 255]);
    const a = e.addAdjustment('invert');
    solidLayer(e, 'rgb(0,0,255)');
    e.setActiveLayer('base');
    expect(a).toBeTruthy();
    // the blue layer was created on top of the adjustment: untouched
    expect(px(e, 5, 5)).toEqual([0, 0, 255, 255]);
    e.setLayerProps(e.layers()[0].id, { visible: false });
    expect(px(e, 5, 5)).toEqual([55, 255, 255, 255]);
  });

  it('inside a group only affects the group content below it', () => {
    e = newEngine(20, 20);
    setBase(e, [200, 0, 0, 255]);
    const g = e.addGroup();
    e.setActiveLayer(g);
    const inner = solidLayer(e, 'rgb(0,255,0)');
    e.moveLayer(inner, g, 0);
    const adj = e.addAdjustment('invert');
    expect(e.layers().find((l) => l.id === adj)?.parentId).toBe(g);
    expect(px(e, 5, 5)).toEqual([255, 0, 255, 255]); // inverted green; the base below the group is not inverted
    // a layer below the group is not touched by the adjustment inside it
    e.setLayerProps(inner, { visible: false });
    expect(px(e, 5, 5)).toEqual([200, 0, 0, 255]);
  });

  it('a group with an adjustment as its only content stays transparent', () => {
    e = newEngine(10, 10);
    setBase(e, [10, 20, 30, 255]);
    const g = e.addGroup();
    const adj = e.addAdjustment('invert'); // lands above the group...
    expect(px(e, 2, 2)).toEqual([245, 235, 225, 255]);
    e.moveLayer(adj, g, 0); // ...inside it, it has nothing below it to adjust
    expect(px(e, 2, 2)).toEqual([10, 20, 30, 255]);
  });

  it('opacity mixes the adjusted and the original result', () => {
    const a = withAdj({ type: 'invert' }, [100, 100, 100, 255]);
    e.setLayerProps(a, { opacity: 0.5 });
    expect(near(px(e, 3, 3), [128, 128, 128, 255], 2)).toBe(true);
    e.setLayerProps(a, { opacity: 0.25 });
    expect(near(px(e, 3, 3), [Math.round(100 * 0.75 + 155 * 0.25), Math.round(100 * 0.75 + 155 * 0.25), Math.round(100 * 0.75 + 155 * 0.25), 255], 2)).toBe(true);
    e.setLayerProps(a, { opacity: 0 });
    expect(px(e, 3, 3)).toEqual([100, 100, 100, 255]);
    e.setLayerProps(a, { opacity: 1, visible: false });
    expect(px(e, 3, 3)).toEqual([100, 100, 100, 255]);
  });

  it('opacity x mask: mix(below, adjusted, opacity * mask)', () => {
    const a = withAdj({ type: 'invert' }, [100, 100, 100, 255]);
    const slot = e.addMask(a);
    e.setPaintTarget(a, 'mask');
    e.setToolContext(brushCtx({ size: 10 }, { primary: rgba(128, 128, 128) }));
    stroke(e, 'brush', [[12, 12]]);
    e.setLayerProps(a, { opacity: 0.5 });
    const m = maskAt(e, slot, 12, 12) / 255;
    const k = 0.5 * m;
    expect(near(px(e, 12, 12), [Math.round(100 + 55 * k)].concat([0, 0]).map((_, i) => (i === 0 ? Math.round(100 + 55 * k) : Math.round(100 + 55 * k))).concat([255]) as Px, 3)).toBe(true);
    expect(near(px(e, 1, 1), [128, 128, 128, 255], 2)).toBe(true); // mask white: opacity only
    e.setMaskEnabled(a, false);
    expect(near(px(e, 12, 12), [128, 128, 128, 255], 2)).toBe(true);
  });

  it('adjustments on masked pixel layers mix with the layer mask', () => {
    e = newEngine(20, 20);
    setBase(e, [100, 100, 100, 255]);
    const l = solidLayer(e, 'rgb(200,0,0)');
    const slot = e.addMask(l);
    e.setPaintTarget(l, 'mask');
    e.setToolContext(brushCtx({ size: 30 }));
    stroke(e, 'brush', [[0, 10]]);
    expect(maskAt(e, slot, 0, 10)).toBe(0);
    e.addAdjustment('invert');
    expect(px(e, 0, 10)).toEqual([155, 155, 155, 255]); // layer hidden by its mask, base inverted
    expect(px(e, 19, 10)).toEqual([55, 255, 255, 255]);
  });
});

describe('adjustment layers: editing and history', () => {
  it('setAdjustment clamps, ignores no-ops, coalesces and undoes', () => {
    const id = withAdj({ type: 'threshold', level: 0.5 });
    const n = e.history().entries.length;
    e.setAdjustment(id, { type: 'threshold', level: 0.5 });
    expect(e.history().entries).toHaveLength(n);
    e.setAdjustment(id, { type: 'threshold', level: 0.7 });
    e.setAdjustment(id, { type: 'threshold', level: 0.9 });
    e.setAdjustment(id, { type: 'threshold', level: 7 });
    expect(e.layers()[0].adjustment).toEqual({ type: 'threshold', level: 1 });
    expect(e.history().entries).toHaveLength(n + 1);
    expect(e.history().entries.slice(-1)[0]?.label).toBe('Adjustment');
    e.undo();
    expect(e.layers()[0].adjustment).toEqual({ type: 'threshold', level: 0.5 });
    e.redo();
    expect(e.layers()[0].adjustment).toEqual({ type: 'threshold', level: 1 });
    e.setAdjustment('base', { type: 'invert' });
    e.setAdjustment('nope', { type: 'invert' });
  });

  it('the adjustment type can change; blend and lock props are fixed', () => {
    const id = withAdj({ type: 'invert' });
    e.setAdjustment(id, { type: 'blur', radius: 3 });
    expect(e.layers()[0].adjustment).toEqual({ type: 'blur', radius: 3 });
    e.setLayerProps(id, { blend: 'multiply', name: 'x' });
    expect(e.layers()[0]).toMatchObject({ blend: 'normal', name: 'x', kind: 'adjustment' });
    expect(e.docSpec().layers[1].blend).toBe('normal');
    const cv = document.createElement('canvas');
    cv.width = 8;
    cv.height = 8;
    e.drawThumbnail(id, cv); // no thumbnail for adjustments: stays blank
    expect(cv.getContext('2d')?.getImageData(4, 4, 1, 1).data[3]).toBe(0);
  });

  it('moving an adjustment layer re-orders the effect', () => {
    e = newEngine(10, 10);
    setBase(e, [100, 0, 0, 255]);
    const a = e.addAdjustment('invert');
    const top = solidLayer(e, 'rgb(0,0,255)');
    expect(px(e, 2, 2)).toEqual([0, 0, 255, 255]);
    e.moveLayer(a, null, 0);
    expect(px(e, 2, 2)).toEqual([255, 255, 0, 255]);
    expect(top).toBeTruthy();
  });
});

describe('adjustment layers: blur dirty rect and preview switch', () => {
  function blurDoc(): { layer: string } {
    e = newEngine(200, 100);
    const layer = e.addPixelLayer();
    e.addAdjustment('blur');
    e.setActiveLayer(layer);
    e.flush();
    return { layer };
  }

  it('widens the redrawn area by the blur reach (3 * radius) and by nothing else', () => {
    blurDoc();
    const ev = collect(e);
    e.changed({ x: 100, y: 50, w: 10, h: 10 });
    e.flush();
    const c = ev.filter((x) => x.type === 'composite').map((x) => (x as { rect: Rect }).rect);
    expect(c).toEqual([{ x: 88, y: 38, w: 34, h: 34 }]); // 4 px blur = 12 px reach
  });

  it('stays local without blur', () => {
    e = newEngine(200, 100);
    e.addPixelLayer();
    e.addAdjustment('levels');
    e.flush();
    const ev = collect(e);
    e.changed({ x: 100, y: 50, w: 10, h: 10 });
    e.flush();
    expect(ev.filter((x) => x.type === 'composite').map((x) => (x as { rect: Rect }).rect)).toEqual([{ x: 100, y: 50, w: 10, h: 10 }]);
  });

  it('a stroke under a blur is blurred correctly at the redrawn rect borders', () => {
    const { layer } = blurDoc();
    e.setToolContext(brushCtx({ size: 6 }, { primary: rgba(255, 255, 255) }));
    stroke(e, 'brush', [[40, 50], [100, 50]]);
    e.flush();
    const incremental = Array.from(e.readComposite({ x: 0, y: 0, w: 200, h: 100 }));
    // a full redraw gives the same picture
    e.changed({ x: 0, y: 0, w: 200, h: 100 });
    e.flush();
    const full = Array.from(e.readComposite({ x: 0, y: 0, w: 200, h: 100 }));
    expect(near(incremental, full, 1)).toBe(true);
    expect(layer).toBeTruthy();
    expect(px(e, 70, 50)[3]).toBeGreaterThan(80);
    expect(px(e, 70, 58)[3]).toBeGreaterThan(0); // blurred halo
    expect(px(e, 70, 80)[3]).toBe(0);
  });

  it('setPreviewEnabled(false) stops automatic compositing; re-enabling repaints the dirty union', async () => {
    e = newEngine(60, 60);
    setBase(e, [10, 10, 10, 255]);
    e.flush();
    const ev = collect(e);
    e.setPreviewEnabled(false);
    const l = e.addPixelLayer();
    e.setToolContext(brushCtx({ size: 10 }, { primary: rgba(255, 0, 0) }));
    stroke(e, 'brush', [[10, 10]]);
    stroke(e, 'brush', [[50, 50]]);
    await new Promise((r) => setTimeout(r, 80));
    expect(ev.filter((x) => x.type === 'composite')).toHaveLength(0);
    expect(ev.filter((x) => x.type === 'pixels').length).toBeGreaterThan(1); // events still flow
    // on demand: picker / readComposite show the truth for what they ask for
    expect(e.sample(10, 10)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(px(e, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(ev.filter((x) => x.type === 'composite')).toHaveLength(0);
    e.setPreviewEnabled(true);
    e.setPreviewEnabled(true);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 30));
    const comps = ev.filter((x) => x.type === 'composite');
    expect(comps).toHaveLength(1); // the accumulated union, in one pass
    const r = (comps[0] as { rect: Rect }).rect;
    expect(r.x).toBeLessThanOrEqual(5);
    expect(r.x + r.w).toBeGreaterThanOrEqual(55);
    expect(l).toBeTruthy();
    e.setPreviewEnabled(false);
    e.setPreviewEnabled(true); // nothing dirty: nothing happens
    await new Promise((r) => setTimeout(r, 40));
    expect(ev.filter((x) => x.type === 'composite')).toHaveLength(1);
  });

  it('flatten works with the preview off', () => {
    e = newEngine(20, 20);
    setBase(e, [10, 20, 30, 255]);
    e.setPreviewEnabled(false);
    e.addAdjustment('invert');
    const f = e.flattenToNewLayer();
    e.setLayerProps('base', { visible: false });
    e.setPreviewEnabled(true);
    e.flush();
    const flat = e.layers().find((x) => x.id === f);
    expect(flat).toBeTruthy();
    expect(px(e, 3, 3)).toEqual([245, 235, 225, 255]);
  });
});

describe('TD parity details (td/raster_editor/network.py)', () => {
  it('blur holds the edge pixels instead of fading to transparent at the document border', () => {
    e = newEngine(40, 40);
    setBase(e, [200, 100, 50, 255]);
    const a = e.addAdjustment('blur');
    e.setAdjustment(a, { type: 'blur', radius: 6 });
    for (const [x, y] of [[0, 0], [39, 0], [0, 39], [39, 39], [0, 20], [20, 0], [39, 20], [20, 39], [20, 20]]) {
      expect(near(px(e, x, y), [200, 100, 50, 255], 2)).toBe(true); // flat colour stays flat, edges and corners included
    }
  });

  it('blur at an edge still smooths, and an incremental redraw near the border equals a full redraw', () => {
    e = newEngine(60, 30);
    const l = solidLayer(e, 'rgb(255,255,255)');
    e.setActiveLayer(l);
    const a = e.addAdjustment('blur');
    e.setAdjustment(a, { type: 'blur', radius: 3 });
    e.setActiveLayer(l);
    e.setToolContext(brushCtx({ size: 8 }));
    stroke(e, 'brush', [[3, 15], [10, 15]]);
    e.flush();
    const inc = Array.from(e.readComposite({ x: 0, y: 0, w: 60, h: 30 }));
    e.changed({ x: 0, y: 0, w: 60, h: 30 });
    e.flush();
    expect(near(inc, Array.from(e.readComposite({ x: 0, y: 0, w: 60, h: 30 })), 1)).toBe(true);
    expect(px(e, 0, 15)[0]).toBeLessThan(120); // the dark stroke reaches the border and is held there
    expect(px(e, 50, 15)[0]).toBeGreaterThan(250);
  });

  it('levels keeps inHigh above inLow by 1e-4 like TD', () => {
    e = newEngine(4, 4);
    const a = e.addAdjustment('levels');
    e.setAdjustment(a, { type: 'levels', inLow: 0.5, inHigh: 0.2, gamma: 1, outLow: 0, outHigh: 1 });
    const adj = e.layers()[0].adjustment as { inLow: number; inHigh: number };
    expect(adj.inHigh).toBeCloseTo(adj.inLow + 1e-4, 9);
  });

  it('a full-document adjustment is exact across the internal row bands', () => {
    e = newEngine(900, 700);
    e.writeBase({ x: 0, y: 0, w: 900, h: 700 }, (() => {
      const d = new Uint8ClampedArray(900 * 700 * 4);
      for (let i = 0; i < d.length; i += 4) { d[i] = (i >> 2) % 251; d[i + 1] = 90; d[i + 2] = 10; d[i + 3] = 255; }
      return d;
    })());
    e.commitBase();
    e.addAdjustment('invert');
    for (const y of [0, 290, 291, 292, 582, 583, 699]) {
      const p = px(e, 5, y);
      expect(p).toEqual([255 - (((y * 900 + 5)) % 251), 165, 245, 255]);
    }
  });
});

describe('spec change tracking without serialising', () => {
  it('moving and slider ticks never JSON.stringify and still announce every change once', () => {
    e = newEngine(30, 30);
    const l = solidLayer(e, 'red');
    const a = e.addAdjustment('blur');
    const orig = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { calls++; return orig(...args); }) as typeof JSON.stringify;
    try {
      const ev = collect(e);
      for (let r = 1; r <= 20; r++) e.setAdjustment(a, { type: 'blur', radius: r });
      e.setActiveLayer(l);
      e.setTool('move');
      const p = (x: number) => ({ x, y: 3, pressure: 1, shift: false, alt: false, ctrl: false });
      e.pointerDown(p(0));
      for (let x = 1; x <= 10; x++) e.pointerMove(p(x));
      e.pointerUp(p(10));
      expect(ev.filter((x) => x.type === 'docspec')).toHaveLength(30);
    } finally {
      JSON.stringify = orig;
    }
    expect(calls).toBe(0);
  });

  it('a drag that returns to its start leaves no stale state: the next real change still announces', () => {
    e = newEngine(30, 30);
    const l = solidLayer(e, 'red');
    e.setActiveLayer(l);
    e.setTool('move');
    const p = (x: number) => ({ x, y: 3, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerDown(p(0));
    e.pointerMove(p(5));
    e.pointerUp(p(0));
    const ev = collect(e);
    e.setLayerProps(l, { name: 'again' });
    expect(ev.filter((x) => x.type === 'docspec')).toHaveLength(1);
  });
});

describe('group thumbnails', () => {
  it('render at thumbnail resolution with masks and adjustments, without touching the full-size scratch', () => {
    e = newEngine(400, 300);
    setBase(e, [0, 0, 0, 255]);
    const g = e.addGroup();
    e.setActiveLayer(g);
    const l = solidLayer(e, 'rgb(255,0,0)');
    e.moveLayer(l, g, 0);
    const m = e.addMask(l);
    e.writeSurface(m, { x: 200, y: 0, w: 200, h: 300 }, new Uint8Array(200 * 300 * 4)); // right half hidden
    e.commitSurfaces();
    const adj = e.addAdjustment('invert');
    e.moveLayer(adj, g, 0);
    e.setPreviewEnabled(false);
    const comp = (e as unknown as { compositor: { pool: unknown[]; tpool: { width: number; height: number }[]; thumb: { width: number } | null; surface: { ctx: CanvasRenderingContext2D } } }).compositor;
    const before = comp.pool.length;
    const t = document.createElement('canvas');
    t.width = 40;
    t.height = 30;
    e.drawThumbnail(g, t);
    const d = t.getContext('2d')?.getImageData(0, 0, 40, 30).data as Uint8ClampedArray;
    const at = (x: number, y: number) => Array.from(d.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
    expect(near(at(5, 15), [0, 255, 255, 255], 3)).toBe(true); // inverted red
    expect(at(35, 15)[3]).toBe(0); // masked half is transparent
    expect(comp.pool.length).toBe(before);
    expect(comp.thumb?.width).toBeLessThan(200); // never document sized
    expect(comp.tpool.every((s) => s.width < 200)).toBe(true);
    expect(e.sample(5, 5)).toEqual({ r: 0, g: 255, b: 255, a: 255 }); // the main composite is unaffected and still on demand
  });
});
