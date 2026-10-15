import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import { brushCtx, newEngine, perfEnabled, ptr } from './engineTestUtils';

// v4 budgets: transformed layers stay within the v2 composite budgets (docs/DESIGN.md section 6).
const d = perfEnabled ? describe : describe.skip;
let e: Engine;
afterEach(() => e?.dispose());

function time(fn: () => void, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); out.push(performance.now() - t); }
  return out;
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function transformedLayers(w: number, h: number): Engine {
  const en = newEngine(w, h);
  en.writeBase({ x: 0, y: 0, w, h }, new Uint8ClampedArray(w * h * 4).fill(128));
  en.commitBase();
  for (let i = 0; i < 9; i++) {
    const iw = 600 + i * 100;
    const px = new Uint8ClampedArray(iw * 400 * 4);
    for (let k = 0; k < px.length; k += 4) { px[k] = i * 25; px[k + 1] = 255 - i * 20; px[k + 2] = (k >> 4) & 255; px[k + 3] = 200; }
    const id = en.importImage(px, iw, 400, `i${i}`);
    en.setTransform(id, { x: i * 80, y: i * 40, sx: [0.5, 1.5, 0.8, 2, 1.1, 0.3, 1, 0.9, 1.7][i], sy: [0.5, 1.2, 0.8, 1.5, 1.1, 0.3, 1, 1.3, 1.7][i], rot: 0, kx: 0, ky: 0 });
    if (i % 3 === 0) en.addMask(id);
  }
  en.flush();
  return en;
}

d('performance budgets with transformed layers (v4)', () => {
  it('recomposites a 256x256 dirty rect of 10 transformed layers (3 masked) in < 4 ms', () => {
    e = transformedLayers(1920, 1080);
    const rect = { x: 400, y: 300, w: 256, h: 256 };
    time(() => { e.changed(rect); e.flush(); }, 10);
    const t = median(time(() => { e.changed(rect); e.flush(); }, 50));
    console.log(`PERF v4 dirty 256x256 x10 transformed layers: median ${t.toFixed(2)} ms`);
    expect(t).toBeLessThan(4);
  });

  it('a 64 px stroke on a 2x scaled 1920x1080 layer sustains >= 55 events/s, p99 < 32 ms', () => {
    e = transformedLayers(1920, 1080);
    const id = e.addPixelLayer();
    e.setTransform(id, { x: 100, y: 50, sx: 2, sy: 2, rot: 0, kx: 0, ky: 0 });
    e.setToolContext(brushCtx({ size: 64, hardness: 0.7, opacity: 0.8 }));
    e.setTool('brush');
    e.pointerDown(ptr(300, 500));
    const frames: number[] = [];
    const out = new Uint8ClampedArray(80 * 80 * 4);
    for (let i = 1; i <= 240; i++) {
      const x = 300 + i * 5;
      const y = 500 + Math.sin(i / 10) * 200;
      frames.push(time(() => { e.pointerMove(ptr(x, y)); e.readComposite({ x: x - 40, y: y - 40, w: 80, h: 80 }, out); }, 1)[0]);
    }
    e.pointerUp(ptr(1500, 500));
    const sorted = [...frames].sort((a, b) => a - b);
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    console.log(`PERF v4 stroke on 2x layer: mean ${mean.toFixed(2)} ms, p99 ${sorted[Math.floor(sorted.length * 0.99)].toFixed(2)} ms`);
    expect(1000 / mean).toBeGreaterThanOrEqual(55);
    expect(sorted[Math.floor(sorted.length * 0.99)]).toBeLessThan(32);
  });
});
