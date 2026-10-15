import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine';
import { brushCtx, newEngine, stroke } from './engineTestUtils';

const engines: Engine[] = [];
const mk = (w = 64, h = 48): Engine => { const e = newEngine(w, h); engines.push(e); return e; };
afterEach(() => { while (engines.length) engines.pop()?.dispose(); });

const full = (e: Engine) => ({ x: 0, y: 0, w: e.width, h: e.height });
const comp = (e: Engine): number[] => Array.from(e.readComposite(full(e)));
const specKey = (e: Engine): string => { const d = e.docSpec(); return JSON.stringify([d.width, d.height, d.layers, d.guides, d.canvas]); };

/** Everything a user could observe of the state: composite, every surface, spec, selection. */
function state(e: Engine): string {
  const surf = e.surfaceSlots().map((s) => {
    const sp = e.docSpec().layers.find((l) => l.slot === s || l.mask?.slot === s);
    const w = sp?.slot === s ? sp.surfaceW ?? e.width : sp?.surfaceW ?? e.width;
    const h = sp?.slot === s ? sp.surfaceH ?? e.height : sp?.surfaceH ?? e.height;
    const d = e.readSurface(s, { x: 0, y: 0, w, h });
    let hsh = 0;
    for (let i = 0; i < d.length; i++) hsh = (Math.imul(hsh, 31) + d[i]) | 0;
    return `${s}:${w}x${h}:${hsh}`;
  });
  const c = comp(e);
  let ch = 0;
  for (let i = 0; i < c.length; i++) ch = (Math.imul(ch, 31) + c[i]) | 0;
  return JSON.stringify([specKey(e), surf, ch, e.selection()]);
}

/** A fresh engine showing the same document as `src` (what the page does after a reload: loadDocument + surfaces). */
function reload(src: Engine): Engine {
  const e = mk(src.width, src.height);
  const spec = src.docSpec();
  e.loadDocument(spec);
  for (const slot of src.surfaceSlots()) {
    const sp = spec.layers.find((l) => l.slot === slot || l.mask?.slot === slot);
    const w = sp?.slot === slot ? sp.surfaceW ?? spec.width : sp?.surfaceW ?? spec.width;
    const h = sp?.slot === slot ? sp.surfaceH ?? spec.height : sp?.surfaceH ?? spec.height;
    e.writeSurface(slot, { x: 0, y: 0, w, h }, src.readSurface(slot, { x: 0, y: 0, w, h }));
  }
  e.commitSurfaces();
  e.flush();
  return e;
}

/** A rich history: strokes, layers, mask, moves, guides, selection, delete, bake, flatten, text. */
function build(e: Engine): void {
  e.setToolContext(brushCtx({ size: 8 }, { primary: { r: 200, g: 30, b: 30, a: 255 } }));
  const a = e.addPixelLayer('A');
  stroke(e, 'brush', [[8, 8], [50, 12], [30, 30]]);
  const b = e.addPixelLayer('B');
  e.setToolContext(brushCtx({ size: 12 }, { primary: { r: 20, g: 40, b: 220, a: 255 } }));
  stroke(e, 'brush', [[10, 40], [55, 40]]);
  e.setLayerProps(b, { opacity: 0.5 });
  e.setLayerProps(b, { opacity: 0.7 });
  e.setLayerProps(a, { blend: 'multiply' });
  e.addMask(a);
  e.setPaintTarget(a, 'mask');
  e.setToolContext(brushCtx({ size: 14 }, { primary: { r: 0, g: 0, b: 0, a: 255 } }));
  stroke(e, 'brush', [[20, 10], [40, 20]]);
  e.setPaintTarget(a, 'pixels');
  e.addGuide('v', 12);
  e.setSelection({ x: 5, y: 5, w: 30, h: 20 });
  const c = e.addPixelLayer('C');
  e.setTransform(c, { x: 3, y: 2, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
  e.setToolContext(brushCtx({ size: 10 }, { primary: { r: 10, g: 200, b: 20, a: 255 } }));
  stroke(e, 'brush', [[15, 15], [25, 22]]);
  e.deselect();
  e.deleteLayer(b);
  e.addAdjustment('invert');
  e.addTextLayer({ text: 'Hi', font: 'sans-serif', size: 14, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 4, y: 4, boxWidth: null });
}

describe('history persistence', () => {
  it('serialize -> reload -> restore: undo and redo reproduce the original states step by step', () => {
    const e1 = mk();
    build(e1);
    const n = e1.history().entries.length;
    expect(n).toBeGreaterThan(12);
    const rev = e1.docSpec().rev;
    const blob = e1.serializeHistory(50, 256 * 1024 * 1024);
    expect(blob.length).toBeGreaterThan(100);
    const e2 = reload(e1);
    expect(e2.history().entries.length).toBe(0);
    expect(state(e2)).toBe(state(e1));
    expect(e2.restoreHistory(blob, rev)).toBe(true);
    expect(e2.history().entries.map((x) => x.label)).toEqual(e1.history().entries.map((x) => x.label));
    expect(e2.history().index).toBe(e1.history().index);
    const seen1: string[] = [state(e1)];
    const seen2: string[] = [state(e2)];
    for (let i = 0; i < n; i++) {
      e1.undo();
      e2.undo();
      e1.flush();
      e2.flush();
      seen1.push(state(e1));
      seen2.push(state(e2));
      expect(seen2[i + 1], `undo step ${i + 1}`).toBe(seen1[i + 1]);
    }
    expect(e2.history().index).toBe(-1);
    for (let i = 0; i < n; i++) {
      e1.redo();
      e2.redo();
      e1.flush();
      e2.flush();
      expect(state(e2), `redo step ${i + 1}`).toBe(state(e1));
    }
    expect(state(e2)).toBe(seen1[0]);
  });

  it('keeps the redo tail', () => {
    const e1 = mk();
    build(e1);
    const n = e1.history().entries.length;
    for (let i = 0; i < 4; i++) e1.undo();
    const rev = e1.docSpec().rev;
    const blob = e1.serializeHistory(50, 256 * 1024 * 1024);
    const e2 = reload(e1);
    expect(e2.restoreHistory(blob, rev)).toBe(true);
    expect(e2.history().entries.length).toBe(n);
    expect(e2.history().index).toBe(n - 5);
    for (let i = 0; i < 4; i++) { e1.redo(); e2.redo(); }
    e1.flush(); e2.flush();
    expect(state(e2)).toBe(state(e1));
  });

  it('maxSteps limits the undo side', () => {
    const e1 = mk();
    build(e1);
    const blob = e1.serializeHistory(5, 256 * 1024 * 1024);
    const e2 = reload(e1);
    expect(e2.restoreHistory(blob, e1.docSpec().rev)).toBe(true);
    expect(e2.history().entries.length).toBe(5);
    expect(e2.history().index).toBe(4);
    for (let i = 0; i < 5; i++) { e1.undo(); e2.undo(); }
    e1.flush(); e2.flush();
    expect(state(e2)).toBe(state(e1));
    e2.undo(); // nothing older
    expect(e2.history().index).toBe(-1);
  });

  it('maxBytes drops the oldest steps', () => {
    const e1 = mk(200, 200);
    e1.addPixelLayer();
    e1.setToolContext(brushCtx({ size: 60 }));
    for (let i = 0; i < 6; i++) stroke(e1, 'brush', [[30 + i * 20, 30], [30 + i * 20, 170]]);
    const all = e1.serializeHistory(50, 256 * 1024 * 1024);
    const small = e1.serializeHistory(50, 1500 * 1024);
    expect(small.length).toBeLessThanOrEqual(1500 * 1024);
    expect(small.length).toBeLessThan(all.length);
    const e2 = reload(e1);
    expect(e2.restoreHistory(small, e1.docSpec().rev)).toBe(true);
    expect(e2.history().entries.length).toBeLessThan(e1.history().entries.length);
    expect(e2.history().entries.length).toBeGreaterThan(0);
    e2.undo();
    e1.undo();
    e1.flush(); e2.flush();
    expect(state(e2)).toBe(state(e1));
  });

  it('survives a canvas resize / crop and a baked transform', () => {
    const e1 = mk(60, 40);
    const a = e1.addPixelLayer();
    e1.setToolContext(brushCtx({ size: 10 }, { primary: { r: 255, g: 0, b: 0, a: 255 } }));
    stroke(e1, 'brush', [[10, 10], [40, 20]]);
    e1.setTransform(a, { x: 2, y: 2, sx: 1.5, sy: 1.5, rot: 0, kx: 0, ky: 0 });
    e1.applyTransform(a);
    e1.setCanvasSize(80, 50, 'c');
    e1.cropTo({ x: 5, y: 5, w: 50, h: 30 });
    e1.flattenToNewLayer();
    const n = e1.history().entries.length;
    const e2 = reload(e1);
    expect(e2.restoreHistory(e1.serializeHistory(50, 256 * 1024 * 1024), e1.docSpec().rev)).toBe(true);
    for (let i = 0; i < n; i++) {
      e1.undo(); e2.undo();
      e1.flush(); e2.flush();
      expect(state(e2), `undo ${i + 1}`).toBe(state(e1));
    }
    for (let i = 0; i < n; i++) {
      e1.redo(); e2.redo();
      e1.flush(); e2.flush();
      expect(state(e2), `redo ${i + 1}`).toBe(state(e1));
    }
  });

  it('a floating selection transform is persisted', () => {
    const e1 = mk(50, 50);
    const a = e1.addPixelLayer();
    e1.setToolContext(brushCtx({ size: 12 }, { primary: { r: 255, g: 0, b: 0, a: 255 } }));
    stroke(e1, 'brush', [[15, 15]]);
    e1.setSelection({ x: 5, y: 5, w: 20, h: 20 });
    expect(e1.liftSelection()).toBe(true);
    e1.setFloatingTransform({ x: 20, y: 20, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 });
    e1.commitFloating();
    expect(a).toBeTruthy();
    const n = e1.history().entries.length;
    const e2 = reload(e1);
    expect(e2.restoreHistory(e1.serializeHistory(50, 256 * 1024 * 1024), e1.docSpec().rev)).toBe(true);
    for (let i = 0; i < n; i++) {
      e1.undo(); e2.undo();
      e1.flush(); e2.flush();
      expect(state(e2), `undo ${i + 1}`).toBe(state(e1));
    }
  });
});

describe('history persistence: rejects what does not belong', () => {
  function pair() {
    const e1 = mk();
    build(e1);
    const rev = e1.docSpec().rev;
    const blob = e1.serializeHistory(50, 256 * 1024 * 1024);
    return { e1, rev, blob, e2: reload(e1) };
  }

  it('wrong revision', () => {
    const { rev, blob, e2 } = pair();
    const before = state(e2);
    expect(e2.restoreHistory(blob, rev + 1)).toBe(false);
    expect(e2.history().entries.length).toBe(0);
    expect(state(e2)).toBe(before);
  });

  it('another document layout', () => {
    const { rev, blob, e2 } = pair();
    e2.addPixelLayer('extra');
    e2.clearHistory();
    expect(e2.restoreHistory(blob, rev)).toBe(false);
    const e3 = mk(70, 48);
    expect(e3.restoreHistory(blob, rev)).toBe(false);
  });

  it('already has history', () => {
    const { rev, blob, e2 } = pair();
    e2.addGuide('h', 5);
    expect(e2.restoreHistory(blob, rev)).toBe(false);
  });

  it('corrupt blobs never throw or change the document', () => {
    const { rev, blob, e2 } = pair();
    const before = state(e2);
    const tries: Uint8Array[] = [
      new Uint8Array(0), new Uint8Array(3), new Uint8Array(16), blob.subarray(0, 20), blob.subarray(0, blob.length - 1), blob.slice(0, Math.floor(blob.length / 2)),
      (() => { const b = blob.slice(); b[0] = 0; return b; })(),
      (() => { const b = blob.slice(); b[4] = 9; return b; })(), // unknown version
      (() => { const b = blob.slice(); new DataView(b.buffer).setUint32(8, 0xfffffff0, true); return b; })(),
      (() => { const b = blob.slice(); b[20] = 0x7b ^ 0xff; return b; })(), // broken JSON
      new Uint8Array(blob.length).fill(255),
    ];
    // random single-byte corruption of the JSON part and of the pixel part
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 40; i++) {
      const b = blob.slice();
      for (let k = 0; k < 3; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      tries.push(b);
    }
    for (const t of tries) {
      const e = reload(e2);
      const s0 = state(e);
      let ok = false;
      expect(() => { ok = e.restoreHistory(t, rev); }).not.toThrow();
      if (!ok) {
        expect(e.history().entries.length).toBe(0);
        expect(state(e)).toBe(s0);
      } else {
        // a corruption that still parses (e.g. inside pixel data): history works and never throws
        expect(() => { while (e.history().index >= 0) e.undo(); }).not.toThrow();
      }
    }
    expect(state(e2)).toBe(before);
    expect(e2.restoreHistory(blob, rev)).toBe(true); // the genuine blob still works afterwards
  });

  it('a floating selection / empty history serialise to an empty blob that restores to nothing', () => {
    const e1 = mk(40, 40);
    const rev = e1.docSpec().rev;
    const blob = e1.serializeHistory(50, 1 << 20);
    const e2 = reload(e1);
    expect(e2.restoreHistory(blob, rev)).toBe(true);
    expect(e2.history().entries.length).toBe(0);
  });
});

describe('history persistence: data safety', () => {
  it('refuses to restore over pixels that moved on after the blob was made', () => {
    const e1 = mk();
    build(e1);
    const rev = e1.docSpec().rev;
    const blob = e1.serializeHistory(50, 256 * 1024 * 1024);
    e1.setActiveLayer(e1.layers().find((l) => l.kind === 'pixel')!.id);
    e1.setToolContext(brushCtx({ size: 8 }, { primary: { r: 1, g: 2, b: 3, a: 255 } }));
    stroke(e1, 'brush', [[5, 5], [20, 5]]); // pixel strokes do not bump the revision
    expect(e1.docSpec().rev).toBe(rev);
    const e2 = reload(e1);
    expect(e2.restoreHistory(blob, rev)).toBe(false);
    expect(e2.history().entries.length).toBe(0);
    // the up-to-date blob restores
    const e3 = reload(e1);
    expect(e3.restoreHistory(e1.serializeHistory(50, 256 * 1024 * 1024), rev)).toBe(true);
  });

  it('historyVersion changes with every stack change', () => {
    const e = mk();
    const v0 = e.historyVersion();
    e.addPixelLayer();
    const v1 = e.historyVersion();
    e.undo();
    const v2 = e.historyVersion();
    e.redo();
    expect(new Set([v0, v1, v2, e.historyVersion()]).size).toBe(4);
    expect(e.historyVersion()).toBe(e.historyVersion());
  });

  it('docSpec always carries brushPresets; the document list is capped at 64', () => {
    const e = mk();
    expect(e.docSpec().brushPresets).toEqual([]);
    const mkp = (i: number) => ({ id: `p${i}`, name: `P${i}`, tip: 'round' as const, settings: { size: 10, opacity: 1, flow: 1, hardness: 1, spacing: 0.15 },
      dynamics: { scatter: 0, scatterCount: 1, sizeJitter: 0, angleJitter: 0, hueJitter: 0, satJitter: 0, valJitter: 0, angle: 0, roundness: 1, seed: 1 } });
    e.setBrushPresets(Array.from({ length: 100 }, (_, i) => mkp(i)));
    expect(e.brushPresets()).toHaveLength(64);
    expect(e.docSpec().brushPresets).toHaveLength(64);
    const a = e.docSpec().brushPresets;
    expect(e.docSpec().brushPresets).toBe(a); // cached while unchanged
    e.setBrushPresets([]);
    expect(e.docSpec().brushPresets).toEqual([]);
  });
});

describe('tip PNG decoding limits', () => {
  it('checks the IHDR size and the URL length before decoding', async () => {
    const { decodeTipPng } = await import('../../src/engine');
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 10;
    await expect(decodeTipPng(c.toDataURL('image/png'))).rejects.toThrow(/size/);
    await expect(decodeTipPng('data:image/png;base64,' + 'A'.repeat(2_000_001))).rejects.toThrow(/long/);
    await expect(decodeTipPng('data:image/png;base64,AAAA')).rejects.toThrow();
  });
});
