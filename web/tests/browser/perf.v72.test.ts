import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import { completeTextSpec } from '../../src/state/specs';
import { BLEND_MODES } from '../../src/state/tools';
import { newEngine, perfEnabled } from './engineTestUtils';

// v7.2: a scrub drag applies one edit per animation frame, so each step (edit + history + recomposite) must stay far inside a 16.7 ms frame.
const d = perfEnabled ? describe : describe.skip;
let e: Engine;
afterEach(() => e?.dispose());

const stats = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};

d('scrub step cost (v7.2)', () => {
  it('60 font-size steps on a text layer (1920x1080 doc, 5 other layers) stay under a frame', () => {
    e = newEngine(1920, 1080);
    e.writeBase({ x: 0, y: 0, w: 1920, h: 1080 }, new Uint8ClampedArray(1920 * 1080 * 4).fill(90));
    e.commitBase();
    for (let i = 0; i < 5; i++) e.importImage(new Uint8ClampedArray(800 * 600 * 4).fill(60 + i * 30), 800, 600, `p${i}`);
    const id = e.addTextLayer(completeTextSpec({ text: 'Scrub me please\nsecond line of text', size: 40, x: 100, y: 100 }));
    e.flush();
    const spec = () => e.layers().find((l) => l.id === id)!.text!;
    for (let i = 0; i < 5; i++) { e.setText(id, { ...spec(), size: 30 + i }); e.flush(); } // warm up (font + caches)
    e.beginGesture();
    const ms: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      e.setText(id, { ...spec(), size: 40 + i * 2 });
      e.flush();
      ms.push(performance.now() - t);
    }
    e.endGesture();
    const st = stats(ms);
    console.log(`PERF v72 text size scrub x60: median ${st.median.toFixed(2)} ms, p95 ${st.p95.toFixed(2)} ms, max ${st.max.toFixed(2)} ms`);
    expect(spec().size).toBe(158);
    expect(st.median).toBeLessThan(8);
    expect(st.p95).toBeLessThan(16);
  });

  it('60 blend-mode steps on a 20-layer 1920x1080 document stay under a frame', () => {
    e = newEngine(1920, 1080);
    e.writeBase({ x: 0, y: 0, w: 1920, h: 1080 }, new Uint8ClampedArray(1920 * 1080 * 4).fill(128));
    e.commitBase();
    const ids: string[] = [];
    for (let i = 0; i < 19; i++) ids.push(e.importImage(new Uint8ClampedArray(1920 * 1080 * 4).fill(40 + i * 10), 1920, 1080, `p${i}`));
    e.flush();
    const target = ids[9];
    for (let i = 0; i < 5; i++) { e.setLayerProps(target, { blend: BLEND_MODES[1 + i] }); e.flush(); }
    e.beginGesture();
    const ms: number[] = [], edit: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      e.setLayerProps(target, { blend: BLEND_MODES[i % BLEND_MODES.length] });
      const t1 = performance.now();
      e.flush();
      ms.push(performance.now() - t);
      edit.push(t1 - t);
    }
    e.endGesture();
    const st = stats(ms);
    console.log(`PERF v72 blend edit-only (doc snapshot + history + dirty marking): median ${stats(edit).median.toFixed(2)} ms`);
    console.log(`PERF v72 blend scrub x60 on 20 layers 1080p: median ${st.median.toFixed(2)} ms, p95 ${st.p95.toFixed(2)} ms, max ${st.max.toFixed(2)} ms`);
    expect(st.median).toBeLessThan(16);
  });
});
