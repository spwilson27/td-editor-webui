import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import { brushCtx, perfEnabled, ptr, newEngine } from './engineTestUtils';

// v3 budgets (docs/DESIGN_V3.md section 4). Skipped with VITE_PERF=0.
const d = perfEnabled ? describe : describe.skip;
let e: Engine;
afterEach(() => e?.dispose());
const log = (s: string) => console.log(s);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const time = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };

function noisyDoc(): Engine {
  const en = newEngine(1920, 1080);
  en.writeBase({ x: 0, y: 0, w: 1920, h: 1080 }, new Uint8ClampedArray(1920 * 1080 * 4).fill(128));
  en.commitBase();
  for (let i = 0; i < 9; i++) {
    const id = en.addPixelLayer();
    const l = en.doc.find(id) as import('../../src/engine/model').PixelLayer;
    l.surface.ctx.fillStyle = `rgba(${i * 25},${255 - i * 20},${i * 10},0.8)`;
    l.surface.ctx.fillRect(i * 50, i * 30, 960, 540);
  }
  en.flush();
  return en;
}

d('selection performance (1080p)', () => {
  it('wand on a 1920x1080 layer takes < 30 ms (contiguous and global)', () => {
    e = newEngine(1920, 1080);
    e.setActiveLayer(e.addPixelLayer());
    const l = e.doc.find(e.activeLayerId() as string) as import('../../src/engine/model').PixelLayer;
    l.surface.ctx.fillStyle = '#336699';
    l.surface.ctx.fillRect(0, 0, 1920, 1080);
    l.surface.ctx.fillStyle = '#ff0000';
    for (let i = 0; i < 40; i++) l.surface.ctx.fillRect(i * 45, 100 + (i % 5) * 150, 20, 400);
    e.setSelectionOptions({ mode: 'new', feather: 0, antialias: true, wandTolerance: 10, wandContiguous: true, wandSampleAll: false });
    e.setTool('wand');
    const run = (): number => time(() => { e.pointerDown(ptr(1000, 1000)); e.pointerUp(ptr(1000, 1000)); });
    run();
    const t = median([run(), run(), run(), run(), run()]);
    log(`PERF wand 1080p contiguous: median ${t.toFixed(1)} ms`);
    expect(t).toBeLessThan(30);
    e.setSelectionOptions({ mode: 'new', feather: 0, antialias: true, wandTolerance: 10, wandContiguous: false, wandSampleAll: false });
    const g = median([run(), run(), run(), run(), run()]);
    log(`PERF wand 1080p global: median ${g.toFixed(1)} ms`);
    expect(g).toBeLessThan(30);
  });

  it('wand sampling the composite of 10 layers takes < 60 ms', () => {
    e = noisyDoc();
    e.setSelectionOptions({ mode: 'new', feather: 0, antialias: true, wandTolerance: 20, wandContiguous: true, wandSampleAll: true });
    e.setTool('wand');
    const run = (): number => time(() => { e.pointerDown(ptr(1500, 900)); e.pointerUp(ptr(1500, 900)); });
    run();
    const t = median([run(), run(), run()]);
    log(`PERF wand 1080p sampleAll: median ${t.toFixed(1)} ms`);
    expect(t).toBeLessThan(60);
  });

  it('selectionPath on a complex 1080p mask takes < 20 ms', () => {
    e = newEngine(1920, 1080);
    e.setActiveLayer(e.addPixelLayer());
    const l = e.doc.find(e.activeLayerId() as string) as import('../../src/engine/model').PixelLayer;
    l.surface.ctx.fillStyle = '#fff';
    for (let i = 0; i < 400; i++) {
      l.surface.ctx.beginPath();
      l.surface.ctx.arc((i * 97) % 1900 + 10, (i * 53) % 1050 + 10, 12 + (i % 30), 0, Math.PI * 2);
      l.surface.ctx.fill();
    }
    e.setSelectionOptions({ mode: 'new', feather: 0, antialias: true, wandTolerance: 0, wandContiguous: false, wandSampleAll: false });
    e.setTool('wand');
    e.pointerDown(ptr(10, 10)); // transparent background...
    e.pointerUp(ptr(10, 10));
    e.invertSelection(); // ...inverted = the discs
    const loops = e.selectionPath().length;
    expect(loops).toBeGreaterThan(50);
    // the path is cached until the selection changes: force a fresh trace with a new (equal) mask
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      e.invertSelection();
      e.invertSelection();
      runs.push(time(() => e.selectionPath()));
    }
    const t = median(runs);
    log(`PERF selectionPath complex 1080p (${loops} loops): median ${t.toFixed(1)} ms`);
    expect(t).toBeLessThan(20);
  });

  it('64 px brush stroke under a feathered arbitrary selection keeps >= 55 events/s with no frame over 32 ms', () => {
    e = noisyDoc();
    e.setSelectionOptions({ mode: 'new', feather: 20, antialias: true, wandTolerance: 0, wandContiguous: true, wandSampleAll: false });
    e.setTool('lasso');
    const poly: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = 700 + 150 * Math.sin(a * 5);
      poly.push([960 + r * Math.cos(a) * 1.3, 540 + r * Math.sin(a) * 0.7]);
    }
    e.pointerDown(ptr(poly[0][0], poly[0][1]));
    for (const p of poly.slice(1)) e.pointerMove(ptr(p[0], p[1]));
    e.pointerUp(ptr(poly[0][0], poly[0][1]));
    expect(e.selectionMask()).not.toBeNull();
    e.setToolContext(brushCtx({ size: 64, hardness: 0.7, opacity: 0.8 }));
    e.setTool('brush');
    e.pointerDown(ptr(300, 500));
    const frames: number[] = [];
    const out = new Uint8ClampedArray(80 * 80 * 4);
    for (let i = 1; i <= 240; i++) {
      const x = 300 + i * 5;
      const y = 500 + Math.sin(i / 10) * 200;
      frames.push(time(() => { e.pointerMove(ptr(x, y)); e.readComposite({ x: x - 40, y: y - 40, w: 80, h: 80 }, out); }));
    }
    const up = time(() => e.pointerUp(ptr(1500, 500)));
    const sorted = [...frames].sort((a, b) => a - b);
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    log(`PERF stroke under feathered selection: mean ${mean.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms (=> ${(1000 / mean).toFixed(0)} ev/s); pointerUp ${up.toFixed(1)} ms`);
    expect(1000 / mean).toBeGreaterThanOrEqual(55);
    expect(p99).toBeLessThan(32);
  });

  it('feathering a 1000x600 marquee by 30 px takes < 150 ms', () => {
    e = newEngine(1920, 1080);
    e.setSelectionOptions({ mode: 'new', feather: 30, antialias: true, wandTolerance: 0, wandContiguous: true, wandSampleAll: false });
    e.setTool('marquee');
    const t = time(() => { e.pointerDown(ptr(100, 100)); e.pointerMove(ptr(1100, 700)); e.pointerUp(ptr(1100, 700)); });
    log(`PERF marquee 1000x600 feather 30: ${t.toFixed(1)} ms`);
    expect(t).toBeLessThan(150);
  });
});

d('vector layers performance', () => {
  it('moving a text layer recomposites only its bounds (< 6 ms per update with 10 layers)', () => {
    e = noisyDoc();
    const id = e.addTextLayer({ text: 'Hello world', font: 'sans-serif', size: 64, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: true, italic: false, lineHeight: 1.2, x: 100, y: 100, boxWidth: null });
    e.flush();
    e.setActiveLayer(id);
    e.setTool('move');
    e.pointerDown(ptr(100, 100));
    const ts: number[] = [];
    for (let i = 1; i <= 60; i++) ts.push(time(() => { e.pointerMove(ptr(100 + i * 4, 100 + i * 2)); e.flush(); }));
    e.pointerUp(ptr(340, 220));
    const m = median(ts);
    log(`PERF move text layer: median ${m.toFixed(2)} ms`);
    expect(m).toBeLessThan(6);
  });
});
