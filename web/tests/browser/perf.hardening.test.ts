import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { RGBA } from '../../src/engine/types';
import { brushCtx, newEngine, perfEnabled, ptr } from './engineTestUtils';

// Hardening: large-document (3840x2160, 30+ layers) engine numbers. Reported via console.log (PERF-H ...)
// and only loosely asserted (generous ceilings, to catch order-of-magnitude regressions, not to gate budgets).
// Skipped with PERF=0 / VITE_PERF=0 (CI).
const d = perfEnabled ? describe : describe.skip;
let e: Engine | undefined;
afterEach(() => { e?.dispose(); e = undefined; });

const W = 3840;
const H = 2160;
const col = (r: number, g: number, b: number, a = 255): RGBA => ({ r, g, b, a });
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const time = <T,>(fn: () => T): [number, T] => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };
const timeN = (fn: () => void, n: number): number[] => Array.from({ length: n }, () => time(fn)[0]);
const log = (s: string) => console.log(`PERF-H ${s}`);
const heapMB = (): number | null => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize / 1048576 : null;
};

function fill(w: number, h: number, seed: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const k = (y * w + x) * 4;
      px[k] = (x + seed * 37) & 255; px[k + 1] = (y + seed * 91) & 255; px[k + 2] = ((x ^ y) + seed) & 255; px[k + 3] = 90 + ((seed * 29) % 160);
    }
  }
  return px;
}

let surfaceBytes = 0;

/** 4K doc: 22 pixel layers (6 full-size, 8 half-res scaled 2x, 8 small), 4 masks, 3 adjustments (blur, hueSat, levels), 4 text, 4 shapes = 37+ layers. */
function bigDoc(): Engine {
  surfaceBytes = 0;
  const en = newEngine(W, H);
  en.writeBase({ x: 0, y: 0, w: W, h: H }, new Uint8ClampedArray(W * H * 4).fill(120));
  en.commitBase();
  surfaceBytes += W * H * 4;
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) { // full-size, fill only a band to keep setup quick
    const id = en.addPixelLayer(`full${i}`);
    ids.push(id);
    surfaceBytes += W * H * 4;
  }
  for (let i = 0; i < 8; i++) { // 1920x1080 surfaces scaled 2x
    const id = en.importImage(fill(1920, 1080, i), 1920, 1080, `scaled${i}`);
    en.setTransform(id, { x: (i % 2) * 1900, y: Math.floor(i / 2) * 500, sx: 2, sy: 2 });
    ids.push(id);
    surfaceBytes += 1920 * 1080 * 4;
  }
  for (let i = 0; i < 8; i++) { // small, partly minified / enlarged
    const id = en.importImage(fill(800, 600, i + 10), 800, 600, `small${i}`);
    en.setTransform(id, { x: 200 + i * 400, y: 300 + i * 150, sx: i % 2 ? 0.5 : 1.5, sy: i % 2 ? 0.5 : 1.5 });
    ids.push(id);
    surfaceBytes += 800 * 600 * 4;
  }
  for (const i of [0, 7, 9, 15]) { en.addMask(ids[i]); surfaceBytes += (i < 6 ? W * H : i < 14 ? 1920 * 1080 : 800 * 600) * 4; }
  en.addAdjustment('hueSaturation');
  const blur = en.addAdjustment('blur');
  en.setAdjustment(blur, { type: 'blur', radius: 8 });
  en.addAdjustment('levels');
  for (let i = 0; i < 4; i++) {
    en.addTextLayer({ text: `Hardening layer ${i}\nsecond line`, font: 'sans-serif', size: 120, color: col(255, 255, 255), align: 'left', bold: true, italic: false, lineHeight: 1.2, x: 200 + i * 800, y: 200 + i * 300, boxWidth: null });
    en.addShapeLayer({ type: i % 2 ? 'ellipse' : 'rect', x: 300 + i * 700, y: 400 + i * 200, w: 900, h: 600, ...(i % 2 ? {} : { radius: 40 }), fill: { enabled: true, color: col(200, 40 * i, 90, 200) }, stroke: { enabled: true, color: col(0, 0, 0), width: 12 }, rotation: i * 10 } as never);
  }
  en.flush();
  return en;
}

d('large document (3840x2160, 30+ layers) engine perf (hardening)', () => {
  it('builds the document and reports setup cost + memory', () => {
    const h0 = heapMB();
    const [t, en] = time(() => bigDoc());
    e = en;
    const n = en.doc.all().length;
    log(`4K build: ${t.toFixed(0)} ms, layers=${n}, surfaces ~${(surfaceBytes / 1048576).toFixed(0)} MB (canvas backing), JS heap ${h0 === null ? 'n/a' : `${h0.toFixed(0)} -> ${heapMB()!.toFixed(0)} MB`}`);
    expect(n).toBeGreaterThanOrEqual(30);
  });

  it('recomposite times: dirty 256^2 (several positions), 1024^2, full frame', () => {
    e = bigDoc();
    const en = e;
    const rect = (x: number, y: number, s: number) => ({ x, y, w: s, h: s });
    const run = (name: string, r: { x: number; y: number; w: number; h: number }, n: number) => {
      timeN(() => { en.changed(r); en.flush(); }, 2);
      const a = timeN(() => { en.changed(r); en.flush(); }, n);
      log(`recomposite ${name}: median ${median(a).toFixed(2)} ms, p99 ${pct(a, 0.99).toFixed(2)} ms (n=${n})`);
      return median(a);
    };
    run('dirty 256x256 (no blur region, corner)', rect(20, 20, 256), 40);
    const m = run('dirty 256x256 centre', rect(1800, 1000, 256), 40);
    run('dirty 1024x1024 centre', rect(1400, 600, 1024), 10);
    run('full 3840x2160', { x: 0, y: 0, w: W, h: H }, 4);
    expect(m).toBeLessThan(200);
  });

  it('readComposite (what TD / the view reads) of a 256^2 and 1024^2 window', () => {
    e = bigDoc();
    const en = e;
    const o256 = new Uint8ClampedArray(256 * 256 * 4);
    const o1k = new Uint8ClampedArray(1024 * 1024 * 4);
    const a = timeN(() => en.readComposite({ x: 1800, y: 1000, w: 256, h: 256 }, o256), 30);
    const b = timeN(() => en.readComposite({ x: 1400, y: 600, w: 1024, h: 1024 }, o1k), 6);
    log(`readComposite 256^2: median ${median(a).toFixed(2)} ms; 1024^2: median ${median(b).toFixed(2)} ms`);
  });

  for (const [label, size, target] of [['64px soft brush on a scaled (2x) layer', 64, 'scaled'], ['256px brush on a full-size 4K layer', 256, 'full']] as const) {
    it(`stroke throughput: ${label}`, () => {
      e = bigDoc();
      const en = e;
      const id = en.doc.all().find((l) => l.name === (target === 'scaled' ? 'scaled1' : 'full2'))!.id;
      en.setActiveLayer(id);
      en.setToolContext(brushCtx({ size, hardness: 0.6, opacity: 0.9 }));
      en.setTool('brush');
      const out = new Uint8ClampedArray(size * 2 * size * 2 * 4);
      en.pointerDown(ptr(600, 900));
      const frames: number[] = [];
      const t0 = performance.now();
      for (let i = 1; i <= 300; i++) {
        const x = 600 + i * 8;
        const y = 900 + Math.sin(i / 12) * 400;
        // one "pointer event": move + flush + readback of the dab window (what the view does per frame)
        frames.push(time(() => { en.pointerMove(ptr(x, y)); en.readComposite({ x: x - size, y: y - size, w: size * 2, h: size * 2 }, out); })[0]);
      }
      const total = performance.now() - t0;
      const [tUp] = time(() => en.pointerUp(ptr(3000, 900)));
      log(`stroke ${label}: ${(300 / (total / 1000)).toFixed(0)} events/s, mean ${(total / 300).toFixed(2)} ms, median ${median(frames).toFixed(2)}, p99 ${pct(frames, 0.99).toFixed(2)}, max ${Math.max(...frames).toFixed(2)} ms; pointerUp ${tUp.toFixed(1)} ms`);
      expect(pct(frames, 0.99)).toBeLessThan(500);
    });
  }

  it('stroke with a blur adjustment above the paint target (worst case recomposite per dab)', () => {
    e = bigDoc();
    const en = e;
    const id = en.doc.all().find((l) => l.name === 'scaled2')!.id;
    en.setActiveLayer(id);
    en.setToolContext(brushCtx({ size: 64, hardness: 0.6, opacity: 0.9 }));
    en.setTool('brush');
    const out = new Uint8ClampedArray(128 * 128 * 4);
    en.pointerDown(ptr(500, 500));
    const f: number[] = [];
    for (let i = 1; i <= 150; i++) f.push(time(() => { en.pointerMove(ptr(500 + i * 10, 500 + Math.sin(i / 9) * 300)); en.readComposite({ x: 500 + i * 10 - 64, y: 500 + Math.sin(i / 9) * 300 - 64, w: 128, h: 128 }, out); })[0]);
    en.pointerUp(ptr(2000, 500));
    log(`stroke 64px, 4K, all layers + blur(8): median ${median(f).toFixed(2)}, p99 ${pct(f, 0.99).toFixed(2)} ms`);
  });

  it('document load: docSpec -> loadDocument -> surface refill (TD "load" path)', () => {
    e = bigDoc();
    const spec = e.docSpec();
    const slots = e.surfaceSlots();
    const [tSpec] = time(() => e!.docSpec());
    const bufs = slots.map((s) => e!.readSurface(s, { x: 0, y: 0, w: 1, h: 1 }));
    void bufs;
    const e2 = newEngine(W, H);
    const [tLoad] = time(() => e2.loadDocument(spec));
    // refill every surface like the bridge does when TD sends them (full-surface writes)
    let bytes = 0;
    const [tFill] = time(() => {
      for (const l of e2.doc.pixelLayers()) {
        const sw = l.surface.width, sh = l.surface.height;
        e2.writeSurface(l.slot as number, { x: 0, y: 0, w: sw, h: sh }, new Uint8Array(sw * sh * 4));
        bytes += sw * sh * 4;
      }
      e2.commitSurfaces();
    });
    const [tFirst] = time(() => { e2.changed({ x: 0, y: 0, w: W, h: H }); e2.flush(); });
    log(`doc load: docSpec ${tSpec.toFixed(2)} ms, loadDocument ${tLoad.toFixed(0)} ms, refill ${(bytes / 1048576).toFixed(0)} MB ${tFill.toFixed(0)} ms, first full composite ${tFirst.toFixed(0)} ms, heap ${heapMB()?.toFixed(0) ?? 'n/a'} MB`);
    e2.dispose();
  });
});
