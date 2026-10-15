import type { AdjustmentSpec, BlendMode, Effect, Rect } from './types';
import { createSurface, releaseSurface, type Ctx2D, type Surface } from './surface';
import { floatingBounds, grow, isVector, specBounds, surfaceDocBounds, type Document, type GroupLayer, type Mask, type PixelLayer, type VectorLayer } from './model';
import { drawMapped, IDENT, isAligned, outerRect, type Xf } from './xform';
import { applyEffectsSafe, effectsReach, effectsSourceRect, hasEffects } from './effectsAdapter';
import { drawText } from './textShape';
import { drawShapeWith } from './shapeSdf';
import { clipToSize, intersect, union } from './rect';
import { adjustmentReach, isIdentity, pixRect, renderAdjusted } from './adjustments';

const OPS: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  'soft-light': 'soft-light', 'hard-light': 'hard-light', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

export const raf: (cb: () => void) => unknown =
  typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
export const cancelRaf: (h: unknown) => void =
  typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h as number) : (h) => clearTimeout(h as number);

interface FxEntry { sig: unknown[]; rect: Rect; surf: Surface }

/** A render target: a canvas context plus the document position of its top-left pixel. */
interface Target {
  ctx: Ctx2D;
  canvas: Surface['canvas'];
  ox: number;
  oy: number;
  k: number; // canvas pixels per document pixel (1, or the thumbnail scale)
  pool: Surface[]; // scratch windows for nested groups / masks / adjustments by depth, matching k
}

const round64 = (n: number): number => Math.ceil(n / 64) * 64;

/**
 * Flattens the layer tree into `surface`, redrawing only the pending dirty rect, at most once per frame.
 * Masks are applied with destination-in on a scratch copy of the layer; adjustments read the accumulated
 * result of their parent (see adjustments.ts). Blur widens the redrawn rect by its reach only.
 *
 * Scratch canvases are windows the size of the rect being drawn (a transform maps document coordinates
 * onto them): a document-sized scratch would be copied wholesale by the browser on every reuse.
 */
export class Compositor {
  surface: Surface;
  private pool: Surface[] = []; // scratch windows by nesting depth (full resolution passes)
  private tpool: Surface[] = []; // scratch windows of thumbnail passes: never shared with the main passes
  private padWin: Surface | null = null; // blur edge-hold source
  private thumb: Surface | null = null;
  private fxSrc: Surface | null = null; // effects input / output windows (exact size of the rect being processed)
  private fxOut: Surface | null = null;
  private stage: Surface | null = null; // render target when blur needs source pixels beyond the output rect
  private dirty: Rect | null = null;
  private epoch = 0; // bumped by every invalidation that may change layer content (not by property / transform edits)
  private fxCache = new Map<object, FxEntry>(); // per layer: the effects output over a rect, valid while the signature matches
  private handle: unknown = null;
  private disposed = false;
  private enabled = true;

  constructor(private doc: Document, private onComposite: (r: Rect) => void) {
    this.surface = createSurface(doc.width, doc.height, true);
    this.invalidate(null);
  }

  get isEnabled(): boolean { return this.enabled; }

  /** Mark a document-space rect dirty; null = whole document. */
  invalidate(r: Rect | null, propsOnly = false): void {
    if (this.disposed) return;
    if (!propsOnly) this.epoch++; // pixels changed somewhere: cached effect results are stale
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const clipped = r ? clipToSize(r, full.w, full.h) : full;
    if (!clipped) return;
    this.dirty = union(this.dirty, clipped);
    if (this.enabled && this.handle === null) this.schedule();
  }

  private schedule(): void {
    this.handle = raf(() => {
      this.handle = null;
      this.flush();
    });
  }

  /** false = no automatic compositing: dirty rects accumulate until re-enabled. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      if (this.handle !== null) cancelRaf(this.handle);
      this.handle = null;
    } else if (this.dirty && this.handle === null && !this.disposed) {
      this.schedule();
    }
  }

  /** Composite pending dirty rect now (the rect is widened by the blur reach so every changed pixel is redrawn). */
  flush(): void {
    const r = this.disposed ? null : this.dirty;
    if (!r) return;
    this.dirty = null;
    const out = this.widen(r);
    this.renderRegion(out);
    this.pruneFxCache();
    this.onComposite(out);
  }

  /**
   * Make `r` (null = everything) of the surface current. Enabled: flush the dirty rect. Disabled: render just `r`
   * and leave the dirty union alone for when the preview is switched back on.
   */
  ensure(r: Rect | null): void {
    if (this.enabled) return this.flush();
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const want = r ? clipToSize(r, full.w, full.h) : full;
    if (want) this.renderRegion(want);
  }

  /** Doc size changed: reallocate (callers re-invalidate content via full dirty). */
  resize(): void {
    releaseSurface(this.surface);
    this.releaseScratch();
    this.surface = createSurface(this.doc.width, this.doc.height, true);
    this.dirty = null;
    this.invalidate(null);
  }

  dispose(): void {
    this.disposed = true;
    this.dirty = null;
    if (this.handle !== null) cancelRaf(this.handle);
    this.handle = null;
    releaseSurface(this.surface);
    this.releaseScratch();
  }

  /**
   * Render a group alone at thumbnail scale k (canvas pixels per document pixel). Returns a surface whose top-left
   * round(width*k) x round(height*k) pixels hold the result. Never touches the full-resolution scratch pool.
   */
  renderIsolated(group: GroupLayer, k: number): Surface {
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const pw = Math.max(1, Math.round(full.w * k));
    const ph = Math.max(1, Math.round(full.h * k));
    this.thumb = this.fit(this.thumb, pw, ph, 0, 0, k);
    this.thumb.ctx.clearRect(0, 0, full.w, full.h);
    this.renderGroup({ ctx: this.thumb.ctx, canvas: this.thumb.canvas, ox: 0, oy: 0, k, pool: this.tpool }, group, full, 1);
    return this.thumb;
  }

  /**
   * How far a change can show up from where it happened: the sum of the reach of all visible blur adjustments plus the
   * largest reach of the layer effects (a drop shadow / glow paints beyond the layer's own pixels).
   */
  reach(): number {
    let n = 0;
    let fx = 0;
    for (const l of this.doc.all()) {
      if (!l.visible || l.opacity <= 0) continue;
      if (l.kind === 'adjustment') n += adjustmentReach(l.adjustment);
      else if (l.kind !== 'group' && l.effects.length) fx = Math.max(fx, effectsReach(l.effects));
    }
    return n + fx;
  }

  private widen(r: Rect): Rect {
    const e = this.reach();
    if (!e) return r;
    return clipToSize({ x: r.x - e, y: r.y - e, w: r.w + 2 * e, h: r.h + 2 * e }, this.doc.width, this.doc.height) as Rect;
  }

  /** Draw the output rect `r` into the main surface. */
  private renderRegion(r: Rect): void {
    const ctx = this.surface.ctx;
    const e = this.reach();
    const main: Target = { ctx, canvas: this.surface.canvas, ox: 0, oy: 0, k: 1, pool: this.pool };
    if (!e) {
      ctx.clearRect(r.x, r.y, r.w, r.h);
      this.renderGroup(main, this.doc.root, r, 0);
      return;
    }
    // Blur reads pixels around the output rect: render the widened rect off to the side, keep only `r`.
    const rr = clipToSize({ x: r.x - e, y: r.y - e, w: r.w + 2 * e, h: r.h + 2 * e }, this.doc.width, this.doc.height) as Rect;
    this.stage = this.fit(this.stage, rr.w, rr.h, rr.x, rr.y, 1);
    this.stage.ctx.clearRect(rr.x, rr.y, rr.w, rr.h);
    this.renderGroup({ ctx: this.stage.ctx, canvas: this.stage.canvas, ox: rr.x, oy: rr.y, k: 1, pool: this.pool }, this.doc.root, rr, 0);
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(this.stage.canvas as CanvasImageSource, r.x - rr.x, r.y - rr.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }

  private releaseScratch(): void {
    for (const s of [...this.pool, ...this.tpool, this.stage, this.padWin, this.thumb, this.fxSrc, this.fxOut]) if (s) releaseSurface(s);
    this.fxSrc = null;
    this.fxOut = null;
    this.fxCache.forEach((c) => releaseSurface(c.surf));
    this.fxCache.clear();
    this.pool = [];
    this.tpool = [];
    this.stage = null;
    this.padWin = null;
    this.thumb = null;
  }

  /** A canvas of at least pw x ph pixels (and not much bigger) whose context maps document coordinates (scale k, origin tx,ty) onto it. */
  private fit(s: Surface | null, pw: number, ph: number, tx: number, ty: number, k: number): Surface {
    pw = Math.ceil(pw);
    ph = Math.ceil(ph);
    if (!s || s.width < pw || s.height < ph || s.width * s.height > 4 * pw * ph + 4096) {
      if (s) releaseSurface(s);
      s = createSurface(round64(pw), round64(ph), true);
    }
    s.ctx.setTransform(k, 0, 0, k, -tx * k, -ty * k);
    return s;
  }

  /** Target for the scratch window at `depth` covering `r`, at the parent's scale. */
  private scratch(parent: Target, depth: number, r: Rect): Target {
    const s = (parent.pool[depth] = this.fit(parent.pool[depth] ?? null, r.w * parent.k, r.h * parent.k, r.x, r.y, parent.k));
    return { ctx: s.ctx, canvas: s.canvas, ox: r.x, oy: r.y, k: parent.k, pool: parent.pool };
  }

  private padTarget(p: Rect, k: number): { ctx: Ctx2D; canvas: Surface['canvas']; ox: number; oy: number; k: number } {
    this.padWin = this.fit(this.padWin, p.w * k, p.h * k, p.x, p.y, k);
    return { ctx: this.padWin.ctx, canvas: this.padWin.canvas, ox: p.x, oy: p.y, k };
  }

  private renderGroup(tgt: Target, group: GroupLayer, r: Rect, depth: number): void {
    const ctx = tgt.ctx;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const l = group.children[i];
      if (!l.visible || l.opacity <= 0) continue;
      if (l.kind === 'group') {
        const s = this.scratch(tgt, depth, r);
        s.ctx.clearRect(r.x, r.y, r.w, r.h);
        this.renderGroup(s, l, r, depth + 1);
        this.blit(ctx, s.canvas, pixRect(s, r), r, l.opacity, l.blend);
      } else if (l.kind === 'adjustment') {
        if (!isIdentity(l.adjustment)) this.applyAdjustment(tgt, l.adjustment, l.opacity, l.mask && l.mask.enabled ? l.mask : null, r, depth);
      } else if (isVector(l)) {
        this.drawVector(tgt, l, r, depth);
      } else {
        this.drawPixel(tgt, l as PixelLayer, r, depth);
      }
    }
  }

  /**
   * A pixel / input layer under its transform. Pixel-aligned layers (scale 1, whole-pixel position, no rotation or skew)
   * are copied; others are resampled by drawImage (bilinear, 'high' quality when minifying) under the layer's full affine,
   * clipped to the visible rect; masks use the same mapping. Layers with enabled effects go through a scratch window and
   * the effects module (see effectsAdapter.ts) before they are blended.
   */
  private drawPixel(tgt: Target, pl: PixelLayer, r: Rect, depth: number): void {
    if (!this.doc.inputConnected(pl)) return; // a disconnected TD input renders nothing (the layer keeps its placement)
    const fx = hasEffects(pl.effects) && tgt.k === 1;
    const own = outerRect(surfaceDocBounds(pl));
    const vis = intersect(r, fx ? grow(own, effectsReach(pl.effects)) : own);
    if (!vis) {
      this.drawFloating(tgt, pl, r);
      return;
    }
    const ctx = tgt.ctx;
    const masked = pl.mask && pl.mask.enabled;
    if (!masked && !fx) {
      if (isAligned(pl)) {
        const src: Rect = { x: vis.x - pl.x, y: vis.y - pl.y, w: vis.w, h: vis.h };
        this.blit(ctx, pl.surface.canvas, src, vis, pl.opacity, pl.blend);
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(vis.x, vis.y, vis.w, vis.h);
        ctx.clip();
        ctx.globalAlpha = pl.opacity;
        ctx.globalCompositeOperation = OPS[pl.blend];
        drawMapped(ctx, pl.surface.canvas as CanvasImageSource, pl.surface.width, pl.surface.height, pl, vis);
        ctx.restore();
      }
      this.drawFloating(tgt, pl, r);
      return;
    }
    if (fx) {
      this.renderFx(tgt, pl, [pl.surface, pl.mask, pl.mask?.enabled, pl.x, pl.y, pl.sx, pl.sy, pl.rot, pl.kx, pl.ky], vis, pl.effects, pl.opacity, pl.blend, (c, cr) => {
        drawMapped(c, pl.surface.canvas as CanvasImageSource, pl.surface.width, pl.surface.height, pl, cr);
        if (masked) this.maskIn(c, pl.mask as Mask, pl, cr);
      });
      this.drawFloating(tgt, pl, r);
      return;
    }
    const s = this.scratch(tgt, depth, r);
    s.ctx.clearRect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.save();
    s.ctx.beginPath();
    s.ctx.rect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.clip();
    drawMapped(s.ctx, pl.surface.canvas as CanvasImageSource, pl.surface.width, pl.surface.height, pl, vis);
    s.ctx.restore();
    if (masked) this.maskIn(s.ctx, pl.mask as Mask, pl, vis);
    this.blit(tgt.ctx, s.canvas, pixRect(s, vis), vis, pl.opacity, pl.blend);
    this.drawFloating(tgt, pl, r);
  }

  /** A text / shape layer: rendered straight from its spec into a scratch window, then masked, given its effects and blended. */
  private drawVector(tgt: Target, l: VectorLayer, r: Rect, depth: number): void {
    const fx = hasEffects(l.effects) && tgt.k === 1;
    const vis = intersect(r, fx ? grow(specBounds(l), effectsReach(l.effects)) : specBounds(l));
    if (!vis) return;
    if (fx) {
      this.renderFx(tgt, l, [l.spec, l.mask, l.mask?.enabled, this.doc.shapeRenderer], vis, l.effects, l.opacity, l.blend, (c, cr) => {
        if (l.kind === 'text') drawText(c, l.spec);
        else drawShapeWith(this.doc.shapeRenderer, c, l.spec, this.doc.width, this.doc.height);
        if (l.mask && l.mask.enabled) this.maskIn(c, l.mask, IDENT, cr);
      });
      return;
    }
    const s = this.scratch(tgt, depth, r);
    s.ctx.clearRect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.save();
    s.ctx.beginPath();
    s.ctx.rect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.clip();
    if (l.kind === 'text') drawText(s.ctx, l.spec);
    else drawShapeWith(this.doc.shapeRenderer, s.ctx, l.spec, this.doc.width, this.doc.height);
    s.ctx.restore();
    if (l.mask && l.mask.enabled) this.maskIn(s.ctx, l.mask, IDENT, vis);
    this.blit(tgt.ctx, s.canvas, pixRect(s, vis), vis, l.opacity, l.blend);
  }

  /**
   * Layer effects run in DOCUMENT space (TouchDesigner does the same): the layer's masked, transformed content is painted
   * into a document-sized surface over `vis` grown by the effects' reach, effects.applyEffects(src, effects, vis, out) runs
   * with document-space surfaces and rect, and the rewritten part of `out` inside `vis` is blended.
   */
  private renderFx(tgt: Target, layer: object, sig: unknown[], vis: Rect, effects: Effect[], opacity: number, blend: BlendMode, paint: (c: Ctx2D, cr: Rect) => void): void {
    const W = this.doc.width;
    const H = this.doc.height;
    const v = clipToSize(vis, W, H);
    const cr = v && (effectsSourceRect(effects, v, W, H) ?? grow(v, effectsReach(effects)));
    if (!cr || !v) return;
    const full = [this.epoch, W, H, effects, ...sig];
    const hit = this.fxCache.get(layer);
    if (hit && hit.sig.length === full.length && hit.sig.every((x, i) => x === full[i]) && hit.rect.x <= v.x && hit.rect.y <= v.y
      && hit.rect.x + hit.rect.w >= v.x + v.w && hit.rect.y + hit.rect.h >= v.y + v.h) {
      // opacity / blend (or a smaller dirty rect) changed only: re-blend the cached effects output
      this.blit(tgt.ctx, hit.surf.canvas, { x: v.x - hit.rect.x, y: v.y - hit.rect.y, w: v.w, h: v.h }, v, opacity, blend);
      return;
    }
    if (!this.fxSrc || this.fxSrc.width !== W || this.fxSrc.height !== H) {
      if (this.fxSrc) releaseSurface(this.fxSrc);
      if (this.fxOut) releaseSurface(this.fxOut);
      this.fxSrc = createSurface(W, H, true);
      this.fxOut = createSurface(W, H, true);
    }
    const src = this.fxSrc;
    const out = this.fxOut as Surface;
    src.ctx.setTransform(1, 0, 0, 1, 0, 0);
    src.ctx.clearRect(cr.x, cr.y, cr.w, cr.h);
    src.ctx.save();
    src.ctx.beginPath();
    src.ctx.rect(cr.x, cr.y, cr.w, cr.h);
    src.ctx.clip();
    paint(src.ctx, cr);
    src.ctx.restore();
    const valid = applyEffectsSafe(src, effects, v, out);
    const from = valid ? out : src;
    const got = valid ? intersect(valid, v) : v;
    if (got) {
      this.blit(tgt.ctx, from.canvas, got, got, opacity, blend);
      if (valid) { // keep the result (v is what was asked for; got ⊇ v unless clipped)
        const old = this.fxCache.get(layer);
        if (old) releaseSurface(old.surf);
        const surf = createSurface(got.w, got.h);
        surf.ctx.drawImage(from.canvas as CanvasImageSource, got.x, got.y, got.w, got.h, 0, 0, got.w, got.h);
        this.fxCache.set(layer, { sig: full, rect: got, surf });
      }
    }
  }

  /** Forget cached effect results of layers that are gone (called after every flush). */
  private pruneFxCache(): void {
    if (!this.fxCache.size) return;
    const live = new Set<object>(this.doc.all());
    let total = 0;
    this.fxCache.forEach((c, k) => {
      if (!live.has(k)) {
        releaseSurface(c.surf);
        this.fxCache.delete(k);
      } else total += c.surf.width * c.surf.height * 4;
    });
    if (total > 512 * 1024 * 1024) {
      this.fxCache.forEach((c) => releaseSurface(c.surf));
      this.fxCache.clear();
    }
  }

  /** The floating selection of `pl` (lifted pixels under their own transform), drawn right above the layer. */
  private drawFloating(tgt: Target, pl: PixelLayer, r: Rect): void {
    const f = this.doc.floating;
    if (!f || f.layer !== pl) return;
    const vis = intersect(r, outerRect(floatingBounds(f)));
    if (!vis) return;
    const ctx = tgt.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vis.x, vis.y, vis.w, vis.h);
    ctx.clip();
    ctx.globalAlpha = pl.opacity;
    ctx.globalCompositeOperation = OPS[pl.blend];
    drawMapped(ctx, f.buf.canvas as CanvasImageSource, f.buf.width, f.buf.height, f.t, vis);
    ctx.restore();
  }

  /** dst = dst * mask over the document rect `dst` of ctx; the mask is drawn under `t` (the layer's mapping; identity for document-space masks). */
  private maskIn(ctx: Ctx2D, mask: Mask, t: Xf, dst: Rect): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-in';
    drawMapped(ctx, mask.surface.canvas as CanvasImageSource, mask.surface.width, mask.surface.height, t, dst);
    ctx.restore();
  }

  /** target = mix(target, adjusted(target), opacity * mask) over r, in premultiplied RGBA. */
  private applyAdjustment(tgt: Target, spec: AdjustmentSpec, opacity: number, mask: Mask | null, r: Rect, depth: number): void {
    const tmp = this.scratch(tgt, depth, r);
    renderAdjusted(spec, tgt, tmp, r, { w: this.doc.width, h: this.doc.height }, (p) => this.padTarget(p, tgt.k));
    if (mask) this.maskIn(tmp.ctx, mask, IDENT, r); // adjusted * mask
    const ctx = tgt.ctx;
    // below * (1 - opacity * mask) ...
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-out';
    if (mask) {
      ctx.globalAlpha = opacity;
      ctx.drawImage(mask.surface.canvas as CanvasImageSource, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    } else {
      ctx.fillStyle = `rgba(0,0,0,${opacity})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // ... + adjusted * opacity * mask
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'lighter';
    const tp = pixRect(tmp, r);
    ctx.drawImage(tmp.canvas as CanvasImageSource, tp.x, tp.y, tp.w, tp.h, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  /** Draw `s` (pixels of src) onto the document rect `d` of ctx. */
  private blit(ctx: Ctx2D, src: Surface['canvas'], s: Rect, d: Rect, alpha: number, blend: BlendMode): void {
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = OPS[blend];
    ctx.drawImage(src as CanvasImageSource, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
