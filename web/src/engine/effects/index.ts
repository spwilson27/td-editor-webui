// Layer effects, browser preview (docs/DESIGN_V5.md "Layer effects").  Runs the SAME GLSL as TouchDesigner
// (shared/effects/*.glsl, pass lists from plan.ts == td/raster_editor/effects.py) in WebGL2 on one shared OffscreenCanvas.
//
// CONTRACT: effects run in DOCUMENT space.  TouchDesigner applies them to the doc-sized, already transformed layer content, and
// several effects depend on absolute document coordinates (glitch bands, the halftone grid, 256 px pixel-sort chunks, glows and
// shadows that extend beyond the layer's own surface).  Callers therefore pass a document-sized (or document sub-rect aligned at
// 0,0) surface as `src` / `out`, rects in document pixels, never a layer-local surface whose origin is the layer's own corner.
//
//   applyEffects(src, effects, rect, out)   src / out: surfaces of the same size in document space.  `rect` = the region of src
//        that changed (any real numbers).  Returns the rect of `out` that was rewritten: expandRect(rect, forward) -- the dirty rect
//        grown by every effect's reach (pixel sort: widened along its axis to whole 256 px chunks, nothing across) -- rounded
//        outwards and clipped to the surfaces.  `out` keeps its content elsewhere.  Premultiplied in / out.  src may be out.
//   effectsReach(effects)                   conservative isotropic reach in px (finite; use expandRect for the exact region).
//   expandRect(rect, effects, forward, w, h)
//
// v6 filters run through the same call.  An ADJUSTMENT layer passes the document-sized composite BELOW it as `src` (nothing else is special).
//   applyEffects(src, effects, rect, out, aux?)  `aux` = optional document-sized surface read by filters that take a second image (displace
//        by layer / input): `{ type: 'displace', source: 'aux' }`; without it such a filter renders with no displacement.
//   effectNeedsNeighbourhood(e) / effectReads(e)  does an output pixel read other input pixels ('point' | 'neighbourhood' | 'global')?
//   effectTdPreview(e)   the preview cannot match TouchDesigner within 3/255 for this effect: show TD's render instead (phase B).
//
// Without WebGL2 / EXT_color_buffer_float, or when a shader fails to compile / link (cached), or the context is lost, effects are
// skipped: out receives the plain copy of src and one console warning is printed.
// Region sizes are rounded up to multiples of 64 (textures and scratch canvas are re-used between frames); the texture pool is
// capped at 256 MB and released, with the drawing buffer shrunk, after 4 s without use.

import type { Rect } from '../types';
import { createSurface, releaseSurface, type Surface } from '../surface';
import { FxGL, type Tex } from './gl';
import {
  effectExtent, effectNeedsNeighbourhood, effectReach, effectReads, effectsReach, effectTdPreview, expandRect, filterTypes, planChain, planEffect,
  type AnyEffect, type EffectPass,
} from './plan';
import { cubeAtlas, parseCube } from './filters';

export { effectExtent, effectNeedsNeighbourhood, effectReach, effectReads, effectsReach, effectTdPreview, expandRect, filterTypes, planChain, planEffect };
export { cubeAtlas, parseCube };
export type { AnyEffect, EffectPass };

const BUCKET = 64;
const IDLE_MS = 4000;
const bucket = (n: number): number => Math.ceil(n / BUCKET) * BUCKET;

let gl: FxGL | null | undefined;
let warned = new Set<string>();
let scratch: Surface | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[effects] ' + msg);
}

function runner(): FxGL | null {
  if (gl && (gl.lost || gl.gl.isContextLost())) {
    gl.dispose();
    gl = undefined;
  }
  if (gl === undefined) {
    gl = FxGL.create();
    if (!gl) warnOnce('nogl', 'WebGL2 (EXT_color_buffer_float) is unavailable: layer effects are skipped in the preview');
  }
  return gl;
}

function touchIdle(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    gl?.releaseIdle();
    if (scratch) releaseSurface(scratch);
    scratch = null;
  }, IDLE_MS);
}

/** True when the WebGL2 runner can be created. */
export function effectsAvailable(): boolean {
  return runner() !== null;
}

/** Test hook / teardown: drops programs, textures and the context. */
export function disposeEffects(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
  gl?.dispose();
  gl = undefined;
  warned = new Set();
  if (scratch) releaseSurface(scratch);
  scratch = null;
}

/** Number of shader passes executed so far (tests / perf). */
export function effectsPassCount(): number {
  return gl ? gl.passesRun : 0;
}

function copyRegion(src: Surface, out: Surface, r: Rect): void {
  if (src === out) return;
  const c = out.ctx;
  c.save();
  c.globalCompositeOperation = 'copy';
  c.globalAlpha = 1;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.beginPath();
  c.rect(r.x, r.y, r.w, r.h);
  c.clip();
  c.drawImage(src.canvas as CanvasImageSource, 0, 0);
  c.restore();
}

export function applyEffects(src: Surface, effects: readonly AnyEffect[], rect: Rect, out: Surface, aux?: Surface | null): Rect {
  const none = { x: 0, y: 0, w: 0, h: 0 };
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return none;
  const W = Math.min(src.width, out.width);
  const H = Math.min(src.height, out.height);
  const chain = planChain(effects);
  const on = chain.length ? effects.filter((e) => planChain([e]).length) : [];
  const needAux = chain.some((c) => c.pass.aux);
  const R = expandRect(rect, on, true, W, H);
  if (!R) return none;
  const fx = chain.length ? runner() : null;
  if (!fx || chain.some((c) => fx.failed.has(c.pass.shader))) {
    copyRegion(src, out, R);
    return R;
  }
  const S = expandRect(R, on, false, W, H)!;
  const bw = bucket(S.w);
  const bh = bucket(S.h);
  let srcTex: Tex | null = null;
  let auxTex: Tex | null = null;
  // uploads the region S of a surface (premultiplied) into the top-left of a bucket-sized transparent canvas, then into a texture
  const uploadRegion = (surf: Surface): Tex => {
    let source: TexImageSource = surf.canvas as TexImageSource;
    if (!(S.x === 0 && S.y === 0 && S.w === surf.width && S.h === surf.height && bw === S.w && bh === S.h)) {
      if (!scratch || scratch.width !== bw || scratch.height !== bh) {
        if (scratch) releaseSurface(scratch);
        scratch = createSurface(bw, bh);
      }
      const c = scratch.ctx;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'copy';
      c.fillStyle = 'rgba(0,0,0,0)';
      c.fillRect(0, 0, bw, bh); // 'copy' + a transparent fill clears everything including the padding
      c.drawImage(surf.canvas as CanvasImageSource, S.x, S.y, S.w, S.h, 0, 0, S.w, S.h);
      c.restore();
      source = scratch.canvas as TexImageSource;
    }
    return fx.upload(source, S.w, S.h, bw, bh);
  };
  try {
    srcTex = uploadRegion(src);
    if (needAux && aux) auxTex = uploadRegion(aux);
    const t = srcTex;
    srcTex = null; // runChain owns it from here
    const ax = auxTex;
    auxTex = null;
    try {
      runChain(fx, t, chain, { x: S.x, y: S.y, w: bw, h: bh }, false, S, ax, needAux && !aux, W, H);
    } finally {
      if (ax) fx.free(ax);
    }
    if (fx.gl.isContextLost()) throw new Error('WebGL context lost');
    // result: the bucket sits in the bottom-left of the canvas, upright
    const cv = fx.canvas;
    const sy = cv.height - bh + (R.y - S.y);
    const c = out.ctx;
    c.save();
    c.globalCompositeOperation = 'copy';
    c.globalAlpha = 1;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(cv as CanvasImageSource, R.x - S.x, sy, R.w, R.h, R.x, R.y, R.w, R.h);
    c.restore();
    touchIdle();
  } catch (err) {
    if (srcTex) fx.free(srcTex);
    if (auxTex) fx.free(auxTex);
    warnOnce('fail:' + String((err as Error).message).slice(0, 80), 'effect rendering failed, effects skipped: ' + String((err as Error).message ?? err));
    copyRegion(src, out, R);
  }
  return R;
}

/** Executes the planned passes on `srcTex` (consumed, returned to the pool even on failure); the last pass renders to the canvas. */
function runChain(fx: FxGL, srcTex: Tex, chain: ReturnType<typeof planChain>, S: Rect, keepSrc = false, logical?: Rect, aux: Tex | null = null,
  auxMissing = false, docW = 0, docH = 0): void {
  let effIn: Tex = srcTex;
  let prev: Tex = srcTex;
  let held: Tex[] = [srcTex]; // textures of the current effect (its input + pass outputs)
  let curEffect = chain[0].effect;
  const release = (keep?: Tex) => {
    for (const t of held) if (t !== keep && !(keepSrc && t === srcTex)) fx.free(t);
  };
  try {
    for (let k = 0; k < chain.length; k++) {
      const { effect, pass } = chain[k];
      if (effect !== curEffect) {
        release(prev);
        held = [prev];
        effIn = prev;
        curEffect = effect;
      }
      const last = k === chain.length - 1;
      const lv = pass.level ?? 0;
      const d = 1 << lv;
      const target = last ? null : fx.alloc(lv ? Math.ceil(S.w / d) + 3 : S.w, lv ? Math.ceil(S.h / d) + 3 : S.h, pass.fmt); // level > 0: same size rule as TD
      if (target) held.push(target);
      const in2 = pass.data ? fx.data(pass.data) : pass.aux ? aux : null;
      fx.run(pass, effIn, prev, in2, target, S.x, S.y, logical?.w ?? 0, logical?.h ?? 0, docW, docH, !!pass.aux && auxMissing);
      if (target) prev = target;
    }
  } finally {
    release();
  }
}

/**
 * Benchmark helper (perf harness): GPU wall time per run of the effect passes over `src` (uploaded once, no read-back),
 * bracketed by a 1x1 read-back (gl.finish() does not wait in Chromium).  Returns null without WebGL2.
 */
export function benchEffects(src: Surface, effects: readonly AnyEffect[], iterations = 10, aux?: Surface | null): { passes: number; ms: number } | null {
  const chain = planChain(effects);
  const fx = chain.length ? runner() : null;
  if (!fx) return null;
  const S = { x: 0, y: 0, w: src.width, h: src.height };
  const tex = fx.upload(src.canvas as TexImageSource, S.w, S.h);
  const ax = aux && chain.some((c) => c.pass.aux) ? fx.upload(aux.canvas as TexImageSource, S.w, S.h) : null;
  const needMiss = chain.some((c) => c.pass.aux) && !ax;
  runChain(fx, tex, chain, S, true, undefined, ax, needMiss, S.w, S.h); // warm-up (program compile)
  const sync = () => fx.gl.readPixels(0, 0, 1, 1, fx.gl.RGBA, fx.gl.UNSIGNED_BYTE, new Uint8Array(4));
  sync();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) runChain(fx, tex, chain, S, true, undefined, ax, needMiss, S.w, S.h);
  sync();
  const ms = (performance.now() - t0) / iterations;
  fx.free(tex);
  if (ax) fx.free(ax);
  return { passes: chain.length, ms };
}
