import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine';
import { brushCtx, drawRect, newEngine, solid, stroke } from './engineTestUtils';

// Review follow-ups for v7.3 (masks on groups and TD inputs).
const engines: Engine[] = [];
const mk = (w = 80, h = 80): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });
const fx = (type: string, o: Record<string, unknown> = {}) => ({ enabled: true, type, ...o }) as any;
const all = (e: Engine) => Array.from(e.readComposite({ x: 0, y: 0, w: e.doc.width, h: e.doc.height }));
const full = (e: Engine) => { (e as any).compositor.invalidate(null); return all(e); };
const info = (e: Engine, id: string) => e.layers().find((l) => l.id === id)!;
const black = brushCtx({ size: 10 }, { primary: { r: 0, g: 0, b: 0, a: 255 } });
const i1 = (w: number, h: number) => [{ input: 1, w, h, connected: true }];
const same = (a: number[], b: number[]) => { let n = 0, m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > 2) n++; m = Math.max(m, d); } return { n, m }; };

function scene(e: Engine) {
  const bg = e.addPixelLayer('bg'); drawRect(e, bg, { x: 0, y: 0, w: 80, h: 80 }, 'rgb(90,90,90)');
  const red = e.addPixelLayer('red'); drawRect(e, red, { x: 10, y: 10, w: 60, h: 60 }, 'rgb(255,0,0)');
  const g = e.groupLayers([red], 'G');
  return { bg, red, g };
}

describe('v7.3 review: group masks, strokes, caches', () => {
  it('A: group blur + mask stroke incremental == full', () => {
    const e = mk(); const { g } = scene(e);
    e.setEffects(g, [fx('blur', { sigma: 6, edge: 'hold' })]);
    e.addMask(g); e.setPaintTarget(g, 'mask'); e.setToolContext(black);
    all(e);
    stroke(e, 'brush', [[30, 30], [50, 40]]);
    const inc = all(e);
    expect(same(inc, full(e))).toEqual({ n: 0, m: 0 });
    stroke(e, 'brush', [[20, 60]]);
    const inc2 = all(e);
    expect(same(inc2, full(e))).toEqual({ n: 0, m: 0 });
    e.undo(); const u = all(e); expect(same(u, full(e))).toEqual({ n: 0, m: 0 });
  });
  it('A2: group dropShadow + mask stroke', () => {
    const e = mk(); const { g } = scene(e);
    e.setEffects(g, [fx('dropShadow', { dx: 12, dy: 12, blur: 4, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 1 })]);
    e.addMask(g); e.setPaintTarget(g, 'mask'); e.setToolContext(black);
    all(e);
    stroke(e, 'brush', [[30, 30], [50, 40]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
  });
  it('B: nested masked groups, outer blur, paint inner mask', () => {
    const e = mk(); const { g } = scene(e);
    const outer = e.groupLayers([g], 'O');
    e.setEffects(outer, [fx('blur', { sigma: 5, edge: 'hold' })]);
    e.addMask(outer); e.addMask(g);
    e.setPaintTarget(g, 'mask'); e.setToolContext(black);
    all(e);
    stroke(e, 'brush', [[30, 30], [50, 40]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
    e.setPaintTarget(outer, 'mask');
    stroke(e, 'brush', [[60, 60]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
    // toggle inner mask enabled under outer blur
    e.setMaskEnabled(g, false);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
  });
  it('B2: nested plain outer(with fx) toggling inner mask via add/delete', () => {
    const e = mk(); const { g } = scene(e);
    const outer = e.groupLayers([g], 'O');
    e.setEffects(outer, [fx('blur', { sigma: 5, edge: 'hold' })]);
    const before = all(e);
    e.addMask(g); e.setPaintTarget(g, 'mask'); e.setToolContext(black);
    stroke(e, 'brush', [[40, 40]]);
    const a = all(e);
    expect(same(a, before).n).toBeGreaterThan(0);
    e.undo(); e.undo();
    expect(same(all(e), before)).toEqual({ n: 0, m: 0 });
  });
  it('C: adjustment inside masked group only affects group content', () => {
    const e = mk(); const { g, red } = scene(e);
    const adj = e.addAdjustment('invert' as any);
    // move adj into group
    e.moveLayer(adj, g, 0);
    e.addMask(g);
    e.setPaintTarget(g, 'mask'); e.setToolContext(black);
    stroke(e, 'brush', [[40, 40]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
    const p = e.readComposite({ x: 2, y: 2, w: 1, h: 1 });
    expect([p[0], p[1], p[2]]).toEqual([90, 90, 90]); // bg untouched outside group content
    const q = e.readComposite({ x: 20, y: 20, w: 1, h: 1 });
    expect([q[0], q[1], q[2]]).toEqual([0, 255, 255]);
    void red;
  });
  it('D: stroke on child inside masked group uses below cache correctly', () => {
    const e = mk(); const { bg, red, g } = scene(e);
    const top = e.addPixelLayer('top'); drawRect(e, top, { x: 0, y: 0, w: 80, h: 80 }, 'rgba(0,0,255,0.5)');
    e.addMask(g); e.setPaintTarget(g, 'mask');
    e.setPaintTarget(g, 'pixels');
    e.setActiveLayer(red); e.setToolContext(brushCtx({ size: 10 }, { primary: { r: 0, g: 255, b: 0, a: 255 } }));
    e.setEffects(top, [fx('blur', { sigma: 3, edge: 'hold' })]);
    stroke(e, 'brush', [[20, 20], [60, 50]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
    void bg;
  });
  it('E: refuse pixel tools on masked group in pixel target', () => {
    const e = mk(); const { g } = scene(e);
    e.addMask(g); e.setPaintTarget(g, 'pixels'); e.setToolContext(black);
    const ev: any[] = []; e.on((x: any) => ev.push(x));
    const before = all(e);
    stroke(e, 'brush', [[40, 40]]);
    stroke(e, 'eraser', [[40, 40]]);
    stroke(e, 'fill', [[40, 40]]);
    expect(same(all(e), before)).toEqual({ n: 0, m: 0 });
  });
  it('F: delete group w/ mask then undo; mask painting after restore', () => {
    const e = mk(); const { g } = scene(e);
    const slot = e.addMask(g); e.setPaintTarget(g, 'mask'); e.setToolContext(black);
    stroke(e, 'brush', [[40, 40]]);
    const want = all(e);
    e.deleteLayer(g);
    e.undo();
    expect(same(all(e), want)).toEqual({ n: 0, m: 0 });
    expect(e.layers().find((l) => l.id === g)!.mask?.slot).toBe(slot);
    e.setPaintTarget(g, 'mask');
    stroke(e, 'brush', [[10, 10]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
    // ungroup / move group into other group keep mask
  });
  it('G: gradient/wand/clone on group mask', () => {
    const e = mk(); const { g } = scene(e);
    const slot = e.addMask(g); e.setPaintTarget(g, 'mask'); e.setToolContext(black);
    stroke(e, 'gradient', [[0, 0], [79, 0]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
    const m0 = e.readSurface(slot, { x: 0, y: 0, w: 80, h: 1 });
    expect(m0[0]).not.toBe(m0[79 * 4]);
    stroke(e, 'wand', [[5, 5]]);
    expect(e.selection()).not.toBeNull();
  });
});


function setup() {
  const e = mk(40, 40);
  e.setCanvasMode('fixed');
  e.setInputs(i1(40, 40));
  e.writeInput(1, { x: 0, y: 0, w: 40, h: 40 }, solid(40, 40, [10, 200, 30, 255]));
  e.commitInput(1);
  return e;
}

describe('v7.3 review: input masks vs input resolution', () => {
  it('an input resize stretches the mask, prunes the mask strokes recorded at the old size and re-sends the mask to TD', () => {
    const e = setup();
    const slot = e.addMask('base'); e.setPaintTarget('base', 'mask'); e.setToolContext(black);
    stroke(e, 'brush', [[20, 20]]);
    const events: any[] = [];
    e.on((ev) => events.push(ev));
    e.setInputs(i1(80, 80));
    expect(e.history().entries.map((x) => x.label)).not.toContain('Brush'); // the stroke targeted the 40x40 surface: pruned
    expect(events.some((ev) => ev.type === 'surface' && ev.slot === slot && ev.rect.w === 80 && ev.rect.h === 80)).toBe(true);
    const v = e.readSurface(slot, { x: 0, y: 0, w: 80, h: 80 });
    expect(v[(40 * 80 + 40) * 4]).toBeLessThan(40); // the painted hole was stretched with the layer
    expect(v[(5 * 80 + 5) * 4]).toBe(255);
    e.undo(); // now undoes Add mask, not a stroke on a released surface
    expect(info(e, 'base').mask).toBeNull();
    e.redo();
    const l: any = e.doc.find('base');
    expect(l.mask.surface.width).toBe(80);
    expect(e.readSurface(slot, { x: 40, y: 40, w: 1, h: 1 })[0]).toBeLessThan(40);
  });
  it('a stroke made after the resize is undoable as usual', () => {
    const e = setup();
    const slot = e.addMask('base'); e.setPaintTarget('base', 'mask'); e.setToolContext(black);
    e.setInputs(i1(80, 80));
    stroke(e, 'brush', [[20, 20]]); // doc (20,20) = mask pixel (40,40): the layer box stays 40x40 on the canvas
    expect(e.readSurface(slot, { x: 40, y: 40, w: 1, h: 1 })[0]).toBe(0);
    e.undo();
    expect(e.readSurface(slot, { x: 40, y: 40, w: 1, h: 1 })[0]).toBe(255);
  });
  it('undo / redo of a stroke that predates a resize while the mask is detached is a clean no-op', () => {
    const e = setup();
    const slot = e.addMask('base'); e.setPaintTarget('base', 'mask'); e.setToolContext(black);
    stroke(e, 'brush', [[20, 20]]);
    e.deleteMask('base');
    e.setInputs(i1(80, 80)); // the detached mask is not reachable by the resize
    e.undo(); // Delete mask: restored and stretched to 80x80
    const l: any = e.doc.find('base');
    expect(l.mask.surface.width).toBe(80);
    expect(l.mask.surface.height).toBe(80);
    expect(e.history().entries.map((x) => x.label)).not.toContain('Brush');
    expect(e.readSurface(slot, { x: 40, y: 40, w: 1, h: 1 })[0]).toBeLessThan(40);
    expect(e.docSpec().layers.find((x) => x.id === 'base')!.surfaceW).toBe(80);
  });
  it('undo delete mask after input resize: size', () => {
    const e = setup();
    e.addMask('base');
    e.deleteMask('base');
    e.setInputs(i1(80, 80));
    e.undo();
    const l: any = e.doc.find('base');
    expect(l.mask.surface.width).toBe(80);
  });
  it('undo add-mask then redo after input resize', () => {
    const e = setup();
    e.addMask('base');
    e.undo();
    e.setInputs(i1(80, 80));
    e.redo();
    const l: any = e.doc.find('base');
    expect(l.mask.surface.width).toBe(80);
  });
  it('input mask with rotated transform & canvas crop', () => {
    const e = setup();
    const slot = e.addMask('base');
    e.setCanvasSize(60, 60, 'br');
    const l: any = e.doc.find('base');
    expect(l.mask.surface.width).toBe(40);
    expect(slot).toBe(l.mask.slot);
  });
});


function nested(e: Engine) {
  const bg = e.addPixelLayer('bg'); drawRect(e, bg, { x: 0, y: 0, w: 60, h: 60 }, 'rgb(90,90,90)');
  const red = e.addPixelLayer('red'); drawRect(e, red, { x: 5, y: 5, w: 50, h: 50 }, 'rgb(255,0,0)');
  const inner = e.groupLayers([red], 'I');
  const outer = e.groupLayers([inner], 'O');
  e.addMask(inner); e.addMask(outer);
  e.setToolContext(black);
  e.setPaintTarget(inner, 'mask'); stroke(e, 'brush', [[20, 20]]);
  e.setPaintTarget(outer, 'mask'); stroke(e, 'brush', [[40, 40]]);
  return { bg, red, inner, outer };
}

describe('v7.3 review: nested masked groups', () => {
  it('nested copy/paste with masks, and after canvas crop', () => {
    const e = mk(60, 60); const { outer } = nested(e);
    const want = all(e);
    const clip = e.copyLayers([outer]);
    e.setCanvasSize(80, 70, 'br');
    const [n] = e.pasteLayers(clip, null, 0);
    const g = (e.doc.find(n) as any);
    expect(g.mask.surface.width).toBe(80);
    expect(g.children[0].mask.surface.width).toBe(80);
    expect(g.children[0].mask.surface.height).toBe(70);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
    void want;
  });
  it('blob roundtrip with deleted nested masked groups', () => {
    const e = mk(60, 60); const { outer, inner } = nested(e);
    e.deleteLayer(outer);
    const spec = e.docSpec();
    const blob = e.serializeHistory(100, 64 << 20);
    const f = mk(); f.loadDocument(spec);
    for (const s of e.surfaceSlots()) { const sp = spec.layers.find((l) => l.slot === s || l.mask?.slot === s)!; f.writeSurface(s, { x: 0, y: 0, w: sp.surfaceW ?? 60, h: sp.surfaceH ?? 60 }, e.readSurface(s, { x: 0, y: 0, w: sp.surfaceW ?? 60, h: sp.surfaceH ?? 60 })); }
    f.commitSurfaces();
    expect(f.restoreHistory(blob, spec.rev)).toBe(true);
    f.undo();
    expect(info(f, inner).mask).not.toBeNull();
    expect(info(f, outer).mask).not.toBeNull();
    f.setPaintTarget(inner, 'mask'); f.setToolContext(black);
    stroke(f, 'brush', [[10, 10]]);
    expect(same(all(f), full(f))).toEqual({ n: 0, m: 0 });
    f.undo(); f.undo();
    expect(same(all(f), full(f))).toEqual({ n: 0, m: 0 });
  });
  it('canvas resize undo with group masks; painted after', () => {
    const e = mk(60, 60); const { outer } = nested(e);
    const want = all(e);
    e.setCanvasSize(40, 40, 'tl');
    e.undo();
    expect(same(all(e), want)).toEqual({ n: 0, m: 0 });
    e.setPaintTarget(outer, 'mask'); stroke(e, 'brush', [[50, 10]]);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
  });
  it('group group-of-selection of masked group; groupLayers with masked group unchanged detection', () => {
    const e = mk(60, 60); const { outer } = nested(e);
    const before = all(e);
    const g2 = e.groupLayers([outer], 'W');
    expect(same(all(e), before)).toEqual({ n: 0, m: 0 });
    expect(info(e, g2)).toBeTruthy();
  });
  it('wand/sampleAll on mask & selection->mask on nested', () => {
    const e = mk(60, 60); const { inner } = nested(e);
    e.setPaintTarget(inner, 'mask');
    stroke(e, 'marquee', [[0, 0], [10, 10]]);
    e.maskFromSelection(inner);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
  });
});


describe('v7.3 review: canvas changes re-send masks; deleteMask resets mask edit', () => {
  it('Follow Input / canvas resize reallocate group masks and announce the new surfaces; undo announces the old ones', () => {
    const e = mk(80, 80);
    e.setCanvasMode('fixed');
    e.setInputs(i1(40, 30));
    e.writeInput(1, { x: 0, y: 0, w: 40, h: 30 }, solid(40, 30, [10, 200, 30, 255]));
    e.commitInput(1);
    const p = e.addPixelLayer('p'); drawRect(e, p, { x: 0, y: 0, w: 80, h: 80 }, 'rgb(255,0,0)');
    const g = e.groupLayers([p], 'G');
    const gs = e.addMask(g); e.setPaintTarget(g, 'mask'); e.setToolContext(black); stroke(e, 'brush', [[20, 20]]);
    const is = e.addMask('base');
    const events: any[] = [];
    e.on((ev) => events.push(ev));
    e.setCanvasMode('input'); // the canvas follows input 1: 40x30
    expect(e.width).toBe(40);
    expect(events.some((ev) => ev.type === 'surface' && ev.slot === gs && ev.rect.w === 40 && ev.rect.h === 30)).toBe(true);
    expect(e.readSurface(gs, { x: 0, y: 0, w: 40, h: 30 }).length).toBe(40 * 30 * 4);
    expect(e.readSurface(gs, { x: 20, y: 20, w: 1, h: 1 })[0]).toBeLessThan(40); // the hole moved with the content (top-left anchored)
    expect(info(e, 'base').mask).toEqual({ slot: is, enabled: true });
    expect(info(e, 'base').surfaceW).toBe(40);
    events.length = 0;
    e.undo();
    expect(e.width).toBe(80);
    expect(events.some((ev) => ev.type === 'surface' && ev.slot === gs && ev.rect.w === 80 && ev.rect.h === 80)).toBe(true);
    events.length = 0;
    e.setCanvasSize(100, 90, 'br');
    expect(events.some((ev) => ev.type === 'surface' && ev.slot === gs && ev.rect.w === 100 && ev.rect.h === 90)).toBe(true);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
  });

  it('input resize + group mask + undo/redo keep composite consistent', () => {
    const e = setup();
    const g = e.groupLayers(['base'], 'G');
    e.addMask(g); e.addMask('base');
    e.setInputs(i1(80, 80));
    e.undo(); e.undo(); e.redo(); e.redo();
    const l: any = e.doc.find('base');
    expect(l.mask.surface.width).toBe(80);
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
  });

  it('deleting a mask leaves mask edit mode; adding one again starts on pixels', () => {
    const e = mk(20, 20);
    const g = e.addGroup();
    e.addMask(g); e.setPaintTarget(g, 'mask');
    expect(e.paintTarget().target).toBe('mask');
    e.deleteMask(g);
    e.addMask(g);
    expect(e.paintTarget().target).toBe('pixels');
  });
});

describe('v7.3 review: group mask strokes use the below cache', () => {
  it('painting a group mask holds the below cache and matches a full render at every step', () => {
    const e = mk(256, 256);
    const bg = e.addPixelLayer('bg'); drawRect(e, bg, { x: 0, y: 0, w: 256, h: 256 }, 'rgb(90,90,90)');
    const heavy = e.addPixelLayer('heavy'); drawRect(e, heavy, { x: 0, y: 0, w: 256, h: 256 }, 'rgba(0,0,255,0.5)');
    e.setEffects(heavy, [fx('blur', { sigma: 4, edge: 'hold' })]);
    const red = e.addPixelLayer('red'); drawRect(e, red, { x: 20, y: 20, w: 200, h: 200 }, 'rgb(255,0,0)');
    const g = e.groupLayers([red], 'G');
    e.setEffects(g, [fx('dropShadow', { dx: 8, dy: 8, blur: 4, color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 1 })]);
    e.addMask(g); e.setPaintTarget(g, 'mask'); e.setToolContext(brushCtx({ size: 24 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
    all(e);
    e.setTool('brush');
    e.pointerDown({ x: 60, y: 60, pressure: 1, shift: false, alt: false, ctrl: false });
    expect((e as any).compositor.held).toBe(g);
    for (const [x, y] of [[90, 80], [120, 110], [160, 150]]) {
      e.pointerMove({ x, y, pressure: 1, shift: false, alt: false, ctrl: false });
      e.flush();
    }
    e.pointerUp({ x: 160, y: 150, pressure: 1, shift: false, alt: false, ctrl: false });
    expect(same(all(e), full(e))).toEqual({ n: 0, m: 0 });
  });
});
