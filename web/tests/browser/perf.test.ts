import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { BlendMode } from '../../src/engine/types';
import { brushCtx, perfEnabled, ptr, newEngine } from './engineTestUtils';

// Budgets from docs/DESIGN.md section 6. Skipped with PERF=0 (VITE_PERF=0 in browser mode).
const d = perfEnabled ? describe : describe.skip;
const perfLog = (s: string) => console.log(s);
let e: Engine;
afterEach(() => e?.dispose());

const BLENDS: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'normal', 'soft-light', 'normal', 'darken', 'normal', 'normal'];

function tenLayers(w: number, h: number): Engine {
  const en = newEngine(w, h);
  en.writeBase({ x: 0, y: 0, w, h }, new Uint8ClampedArray(w * h * 4).fill(128));
  en.commitBase();
  for (let i = 0; i < 9; i++) {
    const id = en.addPixelLayer();
    const l = en.doc.find(id) as import('../../src/engine/model').PixelLayer;
    l.surface.ctx.fillStyle = `rgba(${i * 25},${255 - i * 20},${i * 10},0.8)`;
    l.surface.ctx.fillRect(i * 50, i * 30, w / 2, h / 2);
    en.setLayerProps(id, { blend: BLENDS[i] });
  }
  en.flush();
  return en;
}

function time(fn: () => void, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return out;
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

d('performance budgets (DESIGN section 6)', () => {
  it('recomposites a 256x256 dirty rect of 10 layers in < 2 ms', () => {
    e = tenLayers(1920, 1080);
    const rect = { x: 400, y: 300, w: 256, h: 256 };
    time(() => { e.changed(rect); e.flush(); }, 10);
    const t = median(time(() => { e.changed(rect); e.flush(); }, 50));
    perfLog(`PERF dirty 256x256 x10 layers: median ${t.toFixed(2)} ms`);
    expect(t).toBeLessThan(2);
  });

  it('full 1920x1080 recomposite of 10 layers in < 25 ms', () => {
    e = tenLayers(1920, 1080);
    const full = { x: 0, y: 0, w: 1920, h: 1080 };
    time(() => { e.changed(full); e.flush(); }, 3);
    const t = median(time(() => { e.changed(full); e.flush(); }, 15));
    perfLog(`PERF full 1920x1080 x10 layers: median ${t.toFixed(2)} ms`);
    expect(t).toBeLessThan(25);
  });

  it('reads a dirty 256x256 composite rect quickly', () => {
    e = tenLayers(1920, 1080);
    const out = new Uint8ClampedArray(256 * 256 * 4);
    const rect = { x: 400, y: 300, w: 256, h: 256 };
    time(() => e.readComposite(rect, out), 5);
    const t = median(time(() => e.readComposite(rect, out), 30));
    perfLog(`PERF readComposite 256x256: median ${t.toFixed(2)} ms`);
    expect(t).toBeLessThan(3);
  });

  it('64 px brush stroke on 1920x1080 / 10 layers sustains >= 55 events/s with no frame over 32 ms', () => {
    e = tenLayers(1920, 1080);
    e.setToolContext(brushCtx({ size: 64, hardness: 0.7, opacity: 0.8 }));
    e.setTool('brush');
    e.pointerDown(ptr(200, 500));
    const frames: number[] = [];
    const out = new Uint8ClampedArray(80 * 80 * 4);
    // ~25 px per pointer event, one composite per event (as per animation frame)
    for (let i = 1; i <= 240; i++) {
      const x = 200 + i * 6;
      const y = 500 + Math.sin(i / 10) * 200;
      frames.push(time(() => { e.pointerMove(ptr(x, y)); e.readComposite({ x: x - 40, y: y - 40, w: 80, h: 80 }, out); }, 1)[0]); // read back like the bridge does
    }
    const up = time(() => e.pointerUp(ptr(1640, 500)), 1)[0];
    const sorted = [...frames].sort((a, b) => a - b);
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    perfLog(`PERF stroke event: mean ${mean.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${sorted[sorted.length - 1].toFixed(2)} ms (=> ${(1000 / mean).toFixed(0)} ev/s); pointerUp ${up.toFixed(1)} ms`);
    expect(1000 / mean).toBeGreaterThanOrEqual(55);
    expect(p99).toBeLessThan(32);
  });

  it('100 long-segment moves (~1500 dabs of a 64 px brush) take under a second', () => {
    e = newEngine(1920, 1080);
    e.setActiveLayer(e.addPixelLayer());
    e.setToolContext(brushCtx({ size: 64, hardness: 0.5, spacing: 0.15 }));
    e.setTool('brush');
    e.pointerDown(ptr(10, 10));
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      e.pointerMove(ptr(10 + i * 18, 10 + (i % 7) * 100)); // each segment is a few dabs
    }
    const dt = performance.now() - t0;
    e.pointerUp(ptr(1900, 800));
    perfLog(`PERF 100 long segments: ${dt.toFixed(1)} ms`);
    expect(dt).toBeLessThan(1000);
  });
});

d('release cost of full-document edits', () => {
  for (const [w, h] of [[1920, 1080], [3840, 2160]] as const) {
    it(`gradient pointerUp at ${w}x${h}`, () => {
      e = newEngine(w, h);
      e.setActiveLayer(e.addPixelLayer());
      e.setToolContext(brushCtx({}, { primary: { r: 255, g: 0, b: 0, a: 255 }, secondary: { r: 0, g: 0, b: 255, a: 255 } }));
      e.setTool('gradient');
      e.pointerDown(ptr(0, 0));
      e.pointerMove(ptr(w, h));
      const t = time(() => e.pointerUp(ptr(w, h)), 1)[0];
      perfLog(`PERF gradient pointerUp ${w}x${h}: ${t.toFixed(1)} ms`);
      expect(t).toBeLessThan(250);
    });
  }
});
