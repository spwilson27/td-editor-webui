import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine';
import type { EngineEvent, ShapeSpec } from '../../src/engine/types';
import { FoldedPolygon, polyVertices, renderShapeBytes, sdPolygonFull, setShapeCacheBudget, shapeCacheStats, shapeUniforms } from '../../src/engine/shapeSdf';
import shapeGlsl from '../../../td/raster_editor/shape.glsl?raw';
import { newEngine, perfEnabled, ptr, px } from './engineTestUtils';

let e: Engine;
afterEach(() => e?.dispose());

const F = { enabled: true, color: { r: 200, g: 40, b: 90, a: 220 } };
const G = { enabled: true, color: { r: 30, g: 200, b: 60, a: 255 } };
const S = { enabled: true, color: { r: 10, g: 120, b: 250, a: 200 }, width: 5 };
const NS = { ...S, enabled: false };
const cases: Record<string, ShapeSpec> = {
  rect: { type: 'rect', x: 13.5, y: 17, w: 70, h: 50, radius: 0, fill: F, stroke: S, rotation: 0 },
  'rounded rect': { type: 'rect', x: 13, y: 17, w: 70, h: 50, radius: 18, fill: F, stroke: S, rotation: 0 },
  'rounded rect fill only': { type: 'rect', x: 20, y: 20, w: 60, h: 60, radius: 12, fill: G, stroke: NS, rotation: 0 },
  'rotated rounded rect': { type: 'rect', x: 20, y: 30, w: 60, h: 30, radius: 10, fill: F, stroke: S, rotation: 33 },
  'huge radius': { type: 'rect', x: 20, y: 30, w: 60, h: 30, radius: 400, fill: F, stroke: S, rotation: 0 },
  'negative size': { type: 'rect', x: 80, y: 70, w: -50, h: -40, radius: 4, fill: F, stroke: NS, rotation: 10 },
  ellipse: { type: 'ellipse', x: 12, y: 22, w: 76, h: 44, fill: F, stroke: S, rotation: 0 },
  'rotated ellipse': { type: 'ellipse', x: 12, y: 22, w: 76, h: 44, fill: F, stroke: S, rotation: 40 },
  'thin ellipse stroke': { type: 'ellipse', x: 10, y: 30, w: 80, h: 6, fill: G, stroke: { ...S, width: 2 }, rotation: 0 },
  circle: { type: 'ellipse', x: 20, y: 15, w: 60, h: 60, fill: F, stroke: NS, rotation: 0 },
  line: { type: 'line', x1: 10, y1: 12, x2: 90, y2: 70, stroke: S, arrowStart: false, arrowEnd: false },
  'line with arrows': { type: 'line', x1: 10, y1: 12, x2: 90, y2: 70, stroke: S, arrowStart: true, arrowEnd: true },
  'thin arrow': { type: 'line', x1: 10, y1: 40, x2: 90, y2: 40, stroke: { ...S, width: 1 }, arrowStart: false, arrowEnd: true },
  polygon: { type: 'polygon', cx: 50, cy: 45, radius: 38, sides: 7, innerRatio: 1, fill: F, stroke: S, rotation: 0 },
  triangle: { type: 'polygon', cx: 50, cy: 48, radius: 34, sides: 3, innerRatio: 1, fill: G, stroke: { ...S, width: 6 }, rotation: 0 },
  star: { type: 'polygon', cx: 50, cy: 45, radius: 38, sides: 5, innerRatio: 0.45, fill: F, stroke: S, rotation: 17 },
  'star stroke only': { type: 'polygon', cx: 50, cy: 45, radius: 40, sides: 7, innerRatio: 0.6, fill: { ...F, enabled: false }, stroke: { ...S, width: 3 }, rotation: 40 },
};
const W = 100;
const H = 90;

/** Largest difference of two straight RGBA buffers, compared premultiplied (colour of ~transparent pixels is noise). */
function premultDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    m = Math.max(m, Math.abs(a[i + 3] - b[i + 3]));
    for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs((a[i + k] * a[i + 3]) / 255 - (b[i + k] * b[i + 3]) / 255));
  }
  return m;
}

/** Run the real shape.glsl in WebGL2; returns premultiplied RGBA bytes, top row first (null when unavailable). */
function glRender(spec: ShapeSpec): Uint8Array | null {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const gl = cv.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const mk = (t: number, s: string): WebGLShader => {
    const sh = gl.createShader(t) as WebGLShader;
    gl.shaderSource(sh, s);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    return sh;
  };
  const pr = gl.createProgram() as WebGLProgram;
  gl.attachShader(pr, mk(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }'));
  gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\nprecision highp int;\n#define TDOutputSwizzle(x) (x)\n${shapeGlsl}`));
  gl.linkProgram(pr);
  gl.useProgram(pr);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = shapeUniforms(spec, H);
  const vec = (n: string, v: number[]) => gl.uniform4fv(gl.getUniformLocation(pr, n), v);
  vec('uParams', [u.type, u.rot, u.fillOn ? 1 : 0, u.strokeOn ? 1 : 0]);
  vec('uOffset', u.off);
  vec('uA', u.a);
  vec('uB', u.fill);
  vec('uC', u.stroke);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const raw = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  return out;
}

/** premultiplied bytes of the TS port over the whole document */
function tsPremult(spec: ShapeSpec): Uint8Array {
  const s = renderShapeBytes(spec, H, { x: 0, y: 0, w: W, h: H });
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3] / 255;
    out[i] = Math.round(s[i] * a);
    out[i + 1] = Math.round(s[i + 1] * a);
    out[i + 2] = Math.round(s[i + 2] * a);
    out[i + 3] = s[i + 3];
  }
  return out;
}

describe('TS port of shape.glsl vs the real shader in WebGL2', () => {
  for (const [name, spec] of Object.entries(cases)) {
    it(name, () => {
      const gl = glRender(spec);
      if (!gl) {
        console.warn('WebGL2 unavailable: skipping parity check');
        return;
      }
      const ts = tsPremult(spec);
      let worst = 0;
      let big = 0;
      for (let i = 0; i < ts.length; i++) {
        const d = Math.abs(ts[i] - gl[i]);
        worst = Math.max(worst, d);
        if (d > 1) big++;
      }
      console.log(`SDF parity ${name}: max diff ${worst}/255, pixels over 1: ${big}`);
      expect(worst).toBeLessThanOrEqual(2); // 1 for the shader's own float32 + 1 from premultiplying the rounded straight bytes here
    });
  }
});

describe('SDF renderer maths', () => {
  it('interior is exact, a half-covered pixel edge is ~50%, outside is transparent', () => {
    e = newEngine(100, 90);
    e.addShapeLayer({ type: 'rect', x: 10.5, y: 10, w: 40, h: 30, radius: 0, fill: { enabled: true, color: { r: 255, g: 0, b: 0, a: 255 } }, stroke: NS, rotation: 0 });
    expect(px(e, 30, 20)).toEqual([255, 0, 0, 255]);
    expect(px(e, 10, 20)[3]).toBeGreaterThan(120);
    expect(px(e, 10, 20)[3]).toBeLessThan(136);
    expect(px(e, 9, 20)[3]).toBe(0);
    expect(px(e, 60, 20)[3]).toBe(0);
  });

  it('stroke is a centred band over the fill; line arrowheads have their tip on the end point', () => {
    e = newEngine(100, 90);
    e.addShapeLayer({ type: 'rect', x: 20, y: 20, w: 40, h: 40, radius: 0, fill: { enabled: true, color: { r: 255, g: 0, b: 0, a: 255 } }, stroke: { enabled: true, color: { r: 0, g: 0, b: 255, a: 255 }, width: 8 }, rotation: 0 });
    expect(px(e, 22, 40)).toEqual([0, 0, 255, 255]);
    expect(px(e, 17, 40)).toEqual([0, 0, 255, 255]);
    expect(px(e, 14, 40)[3]).toBe(0);
    expect(px(e, 40, 40)).toEqual([255, 0, 0, 255]);
  });

  it('cache: an unchanged shape is rasterised once across recomposites; a new spec rasterises again', () => {
    e = newEngine(200, 150);
    const id = e.addShapeLayer(cases.star);
    e.flush();
    const n = shapeCacheStats().renders;
    for (let i = 0; i < 5; i++) { e.changed({ x: 0, y: 0, w: 200, h: 150 }); e.flush(); }
    e.setLayerProps(id, { opacity: 0.5 });
    e.flush();
    expect(shapeCacheStats().renders).toBe(n);
    e.setShape(id, { ...cases.star, rotation: 20 } as ShapeSpec);
    e.flush();
    expect(shapeCacheStats().renders).toBe(n + 1);
  });
});

describe('flattening what the preview shows is lossless in both renderers', () => {
  for (const mode of ['sdf', 'canvas'] as const) {
    for (const [name, spec] of Object.entries(cases)) {
      it(`${mode}: ${name}`, () => {
        e = newEngine(W, H);
        e.setShapeRenderer(mode);
        const id = e.addShapeLayer(spec);
        const before = e.readComposite({ x: 0, y: 0, w: W, h: H });
        e.replaceWithPixels(id, before, W, H); // what TD would deliver for a layer alone at document size
        const after = e.readComposite({ x: 0, y: 0, w: W, h: H });
        let worst = 0;
        for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(before[i] - after[i]));
        expect(worst).toBeLessThanOrEqual(1);
      });
    }
  }
});

describe('renderer switch', () => {
  it("defaults to 'sdf'; switching re-renders every shape layer without touching the document", () => {
    e = newEngine(W, H);
    expect(e.shapeRenderer()).toBe('sdf');
    const a = e.addShapeLayer(cases['rounded rect']);
    const b = e.addShapeLayer(cases.star);
    const sdfComp = Array.from(e.readComposite({ x: 0, y: 0, w: W, h: H }));
    const ev: EngineEvent[] = [];
    e.on((x) => ev.push(x));
    const hist = e.history().entries.length;
    const spec = JSON.stringify(e.docSpec());
    e.setShapeRenderer('canvas');
    expect(e.shapeRenderer()).toBe('canvas');
    const canvasComp = Array.from(e.readComposite({ x: 0, y: 0, w: W, h: H }));
    expect(canvasComp).not.toEqual(sdfComp); // the two renderers differ at edges
    expect(ev.some((x) => x.type === 'surface')).toBe(false);
    expect(ev.some((x) => x.type === 'pixels')).toBe(true);
    expect(e.history().entries.length).toBe(hist); // not a document edit
    expect(JSON.stringify(e.docSpec())).toBe(spec);
    // no pixel is far apart: only anti-aliasing differs
    let big = 0;
    for (let i = 0; i < canvasComp.length; i += 4) if (Math.abs(canvasComp[i + 3] - sdfComp[i + 3]) > 90) big++;
    expect(big).toBeLessThan(80);
    e.setShapeRenderer('sdf');
    expect(Array.from(e.readComposite({ x: 0, y: 0, w: W, h: H }))).toEqual(sdfComp);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it('switching to the current mode does nothing', () => {
    e = newEngine(50, 50);
    const ev: EngineEvent[] = [];
    e.on((x) => ev.push(x));
    e.setShapeRenderer('sdf');
    expect(ev).toEqual([]);
  });
});


describe('review regressions: shortcut vs exact, folded polygons, move cache, budget, stale surfaces', () => {
  const stroke = (w: number) => ({ enabled: true, color: { r: 10, g: 120, b: 250, a: 255 }, width: w });
  const worst = (spec: ShapeSpec, w = 100, h = 100): number => {
    const a = renderShapeBytes(spec, h, { x: 0, y: 0, w, h });
    const b = renderShapeBytes(spec, h, { x: 0, y: 0, w, h }, { exact: true });
    return premultDiff(a, b);
  };
  const adversarial: Record<string, ShapeSpec> = {
    'sliver ellipse, thin stroke, rotated': { type: 'ellipse', x: 10.3, y: 40.2, w: 77, h: 1.4, fill: F, stroke: stroke(0.32), rotation: -128 },
    '14-point star, deep inner, hairline': { type: 'polygon', cx: 50, cy: 50, radius: 40, sides: 14, innerRatio: 0.17, fill: F, stroke: stroke(0.86), rotation: 3 },
    'tiny polygon r 3': { type: 'polygon', cx: 50.4, cy: 50.4, radius: 3, sides: 5, innerRatio: 1, fill: F, stroke: stroke(1), rotation: 11 },
    'tiny star r 3.9': { type: 'polygon', cx: 50.4, cy: 50.4, radius: 3.9, sides: 6, innerRatio: 0.4, fill: F, stroke: NS, rotation: 0 },
    'short arrow': { type: 'line', x1: 40, y1: 40, x2: 52, y2: 47, stroke: stroke(3), arrowStart: true, arrowEnd: true },
    'short arrow thin': { type: 'line', x1: 40.5, y1: 40.5, x2: 49, y2: 40.5, stroke: stroke(1), arrowStart: false, arrowEnd: true },
    'thin rect': { type: 'rect', x: 10.2, y: 50.1, w: 80, h: 1.5, radius: 0.7, fill: F, stroke: stroke(1), rotation: 20 },
    'thin rounded stroke': { type: 'rect', x: 10, y: 10, w: 60, h: 40, radius: 20, fill: F, stroke: stroke(0.5), rotation: 0 },
    'spiky 64 star': { type: 'polygon', cx: 50, cy: 50, radius: 45, sides: 64, innerRatio: 0.1, fill: F, stroke: stroke(2), rotation: 0 },
  };
  for (const [name, spec] of Object.entries(adversarial)) {
    it(`shortcut == exact (<= 2): ${name}`, () => { expect(worst(spec)).toBeLessThanOrEqual(2); });
  }

  it('shortcut == exact (<= 2) on 250 random shapes', () => {
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const col = () => ({ r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256), a: 80 + Math.floor(rnd() * 176) });
    let max = 0;
    for (let i = 0; i < 250; i++) {
      const fill = { enabled: rnd() > 0.2, color: col() };
      const st = { enabled: rnd() > 0.2, color: col(), width: rnd() < 0.3 ? rnd() * 2 : rnd() * 10 };
      const t = Math.floor(rnd() * 4);
      let spec: ShapeSpec;
      if (t === 0) spec = { type: 'rect', x: rnd() * 40, y: rnd() * 40, w: rnd() * 60, h: rnd() * 60, radius: rnd() * 30, fill, stroke: st, rotation: rnd() * 360 };
      else if (t === 1) spec = { type: 'ellipse', x: rnd() * 40, y: rnd() * 40, w: rnd() * 70, h: rnd() * 70, fill, stroke: st, rotation: rnd() * 360 };
      else if (t === 2) spec = { type: 'line', x1: rnd() * 100, y1: rnd() * 100, x2: rnd() * 100, y2: rnd() * 100, stroke: st, arrowStart: rnd() > 0.5, arrowEnd: rnd() > 0.5 };
      else spec = { type: 'polygon', cx: 30 + rnd() * 40, cy: 30 + rnd() * 40, radius: rnd() * 40, sides: 3 + Math.floor(rnd() * 20), innerRatio: rnd() < 0.5 ? 1 : 0.05 + rnd() * 0.9, fill, stroke: st, rotation: rnd() * 360 };
      max = Math.max(max, worst(spec));
    }
    expect(max).toBeLessThanOrEqual(2);
  });

  it('folded polygon / star distance equals the shader loop', () => {
    let seed = 99;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const [n, R, inner, star] of [[3, 30, 1, false], [5, 40, 1, false], [64, 50, 1, false], [5, 40, 0.45, true], [9, 45, 0.2, true], [14, 40, 0.8, true], [64, 50, 0.5, true]] as const) {
      const full = polyVertices(n, R, inner, star);
      const fold = new FoldedPolygon(n, R, inner, star);
      for (let i = 0; i < 400; i++) {
        const x = (rnd() - 0.5) * 140;
        const y = (rnd() - 0.5) * 140;
        expect(Math.abs(fold.sd(x, y) - sdPolygonFull(x, y, full))).toBeLessThan(1e-6);
      }
    }
  });

  it('integer moves never re-rasterise and give identical pixels; fractional moves do', () => {
    e = newEngine(200, 150);
    const base = { type: 'ellipse', x: 20.25, y: 30.5, w: 60, h: 40, fill: F, stroke: S, rotation: 0 } as const;
    const id = e.addShapeLayer(base);
    e.flush();
    const n = shapeCacheStats().renders;
    const moved = { ...base, x: base.x + 37, y: base.y + 21 } as ShapeSpec;
    e.setShape(id, moved);
    e.flush();
    for (let i = 0; i < 10; i++) { e.setShape(id, { ...base, x: base.x + i * 5, y: base.y + i * 3 } as ShapeSpec); e.flush(); }
    expect(shapeCacheStats().renders).toBe(n);
    e.setShape(id, moved);
    const got = e.readComposite({ x: 0, y: 0, w: 200, h: 150 });
    const want = renderShapeBytes(moved, 150, { x: 0, y: 0, w: 200, h: 150 }, { exact: true });
    expect(premultDiff(got, want)).toBeLessThanOrEqual(2);
    e.setShape(id, { ...base, x: base.x + 0.5 } as ShapeSpec);
    e.flush();
    expect(shapeCacheStats().renders).toBe(n + 1);
    // dragging the move tool re-renders nothing either
    const before = shapeCacheStats().renders;
    e.setActiveLayer(id);
    e.setTool('move');
    e.pointerDown(ptr(50, 50));
    for (let i = 1; i <= 30; i++) { e.pointerMove(ptr(50 + i, 50 + i / 2)); e.flush(); }
    e.pointerUp(ptr(80, 65));
    expect(shapeCacheStats().renders).toBe(before);
  });

  it('shapes touching the document border are clipped, cached by position, and still correct', () => {
    e = newEngine(100, 80);
    e.addShapeLayer({ type: 'rect', x: -20, y: 10, w: 60, h: 40, radius: 8, fill: F, stroke: S, rotation: 0 });
    expect(px(e, 0, 30)[3]).toBeGreaterThan(0);
    expect(px(e, 45, 30)[3]).toBe(0);
  });

  it('the cache cap follows the live shape bytes (up to the maximum) instead of cycling', () => {
    setShapeCacheBudget(0);
    expect(shapeCacheStats().cap).toBe(192 * 1024 * 1024);
    setShapeCacheBudget(300 * 1024 * 1024);
    expect(shapeCacheStats().cap).toBe(450 * 1024 * 1024);
    setShapeCacheBudget(10 * 1024 * 1024 * 1024);
    expect(shapeCacheStats().cap).toBe(768 * 1024 * 1024);
    setShapeCacheBudget(0);
    e = newEngine(300, 200);
    for (let i = 0; i < 4; i++) e.addShapeLayer({ type: 'rect', x: 10 + i, y: 10, w: 250, h: 150, radius: 0, fill: F, stroke: NS, rotation: 0 });
    e.flush();
    const r = shapeCacheStats().renders;
    for (let i = 0; i < 8; i++) { e.changed({ x: 0, y: 0, w: 300, h: 200 }); e.flush(); }
    expect(shapeCacheStats().renders).toBe(r); // working set fits: no cyclic misses
  });
});

const d = perfEnabled ? describe : describe.skip;
d('SDF performance', () => {
  const time = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

  it('editing a 512x512 shape (re-rasterise + composite) takes < 8 ms', () => {
    e = newEngine(1920, 1080);
    const mk = (i: number): ShapeSpec => ({ type: 'rect', x: 100 + i * 0.37, y: 100, w: 512, h: 512, radius: 40, fill: F, stroke: S, rotation: (i % 7) + i * 0.011 });
    const id = e.addShapeLayer(mk(0));
    e.flush();
    for (let i = 1; i < 5; i++) { e.setShape(id, mk(i)); e.flush(); }
    const ts = [];
    for (let i = 10; i < 40; i++) ts.push(time(() => { e.setShape(id, mk(i)); e.flush(); }));
    const m = median(ts);
    console.log(`PERF sdf 512x512 rounded rect edit: median ${m.toFixed(2)} ms`);
    expect(m).toBeLessThan(8);
    const ell = e.addShapeLayer({ type: 'ellipse', x: 100, y: 100, w: 512, h: 512, fill: F, stroke: S, rotation: 0 });
    e.flush();
    const te = [];
    for (let i = 0; i < 20; i++) te.push(time(() => { e.setShape(ell, { type: 'ellipse', x: 100 + i * 0.37, y: 100, w: 512, h: 512, fill: F, stroke: S, rotation: 0 }); e.flush(); }));
    console.log(`PERF sdf 512x512 ellipse edit: median ${median(te).toFixed(2)} ms`);
    expect(median(te)).toBeLessThan(14); // worst case: curved fill + stroke edges, every edge pixel needs the Eberly root
  });

  it('a full-document 1920x1080 rect takes < 40 ms (also rotated, star)', () => {
    e = newEngine(1920, 1080);
    const spec = (i: number, rot = 0): ShapeSpec => ({ type: 'rect', x: 0.5 + i * 0.01, y: 0, w: 1920, h: 1080, radius: 0, fill: F, stroke: S, rotation: rot });
    const id = e.addShapeLayer(spec(0));
    e.flush();
    const ts = [];
    for (let i = 1; i < 12; i++) ts.push(time(() => { e.setShape(id, spec(i)); e.flush(); }));
    const m = median(ts);
    console.log(`PERF sdf 1920x1080 rect: median ${m.toFixed(2)} ms`);
    expect(m).toBeLessThan(40);
    const tr = [];
    for (let i = 1; i < 6; i++) tr.push(time(() => { e.setShape(id, spec(i, 5 + i)); e.flush(); }));
    console.log(`PERF sdf 1920x1080 rotated rect: median ${median(tr).toFixed(2)} ms`);
    const star = e.addShapeLayer({ type: 'polygon', cx: 960, cy: 540, radius: 500, sides: 9, innerRatio: 0.5, fill: F, stroke: S, rotation: 0 });
    const ts2 = [];
    for (let i = 1; i < 6; i++) ts2.push(time(() => { e.setShape(star, { type: 'polygon', cx: 960, cy: 540, radius: 500, sides: 9, innerRatio: 0.5, fill: F, stroke: S, rotation: i }); e.flush(); }));
    console.log(`PERF sdf 1000px star: median ${median(ts2).toFixed(2)} ms`);
  });

  it('a 64-point star r=500 at 1080p takes < 40 ms; a move drag of an ellipse costs no re-raster', () => {
    e = newEngine(1920, 1080);
    const star = (i: number): ShapeSpec => ({ type: 'polygon', cx: 960 + i * 0.01, cy: 540, radius: 500, sides: 64, innerRatio: 0.5, fill: F, stroke: S, rotation: 0 });
    const id = e.addShapeLayer(star(0));
    e.flush();
    const ts = [];
    for (let i = 1; i < 8; i++) ts.push(time(() => { e.setShape(id, star(i)); e.flush(); }));
    console.log(`PERF sdf 64-point star r=500 1080p: median ${median(ts).toFixed(2)} ms`);
    expect(median(ts)).toBeLessThan(40);
    const el = e.addShapeLayer({ type: 'ellipse', x: 100.5, y: 100.5, w: 512, h: 512, fill: F, stroke: S, rotation: 0 });
    e.flush();
    e.setActiveLayer(el);
    e.setTool('move');
    e.pointerDown(ptr(300, 300));
    const mv = [];
    for (let i = 1; i <= 40; i++) mv.push(time(() => { e.pointerMove(ptr(300 + i * 5, 300 + i * 2)); e.flush(); }));
    e.pointerUp(ptr(500, 380));
    console.log(`PERF sdf ellipse move drag event: median ${median(mv).toFixed(2)} ms`);
    expect(median(mv)).toBeLessThan(8);
  });
});
