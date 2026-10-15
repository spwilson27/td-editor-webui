import type { AdjustmentSpec, BlendMode, Rect } from './types';
import { createSurface, releaseSurface, type Ctx2D, type Surface } from './surface';
import { isVector, specBounds, type Document, type GroupLayer, type Mask, type SurfaceLayer, type VectorLayer } from './model';
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
  private stage: Surface | null = null; // render target when blur needs source pixels beyond the output rect
  private dirty: Rect | null = null;
  private handle: unknown = null;
  private disposed = false;
  private enabled = true;

  constructor(private doc: Document, private onComposite: (r: Rect) => void) {
    this.surface = createSurface(doc.width, doc.height, true);
    this.invalidate(null);
  }

  get isEnabled(): boolean { return this.enabled; }

  /** Mark a document-space rect dirty; null = whole document. */
  invalidate(r: Rect | null): void {
    if (this.disposed) return;
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

  /** Sum of the reach of all visible blur adjustments: how far a change can show up from where it happened. */
  reach(): number {
    let n = 0;
    for (const l of this.doc.all()) {
      if (l.kind === 'adjustment' && l.visible && l.opacity > 0) n += adjustmentReach(l.adjustment);
    }
    return n;
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
    for (const s of [...this.pool, ...this.tpool, this.stage, this.padWin, this.thumb]) if (s) releaseSurface(s);
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
      } else if (isVector(l) && !l.surface) {
        this.drawVector(tgt, l, r, depth);
      } else {
        const pl = l as SurfaceLayer;
        const vis = intersect(r, { x: pl.x, y: pl.y, w: pl.surface.width, h: pl.surface.height });
        if (!vis) continue;
        const src: Rect = { x: vis.x - pl.x, y: vis.y - pl.y, w: vis.w, h: vis.h };
        if (pl.mask && pl.mask.enabled) {
          const s = this.scratch(tgt, depth, r);
          s.ctx.clearRect(vis.x, vis.y, vis.w, vis.h);
          s.ctx.drawImage(pl.surface.canvas as CanvasImageSource, src.x, src.y, src.w, src.h, vis.x, vis.y, vis.w, vis.h);
          this.maskIn(s.ctx, pl.mask, src, vis);
          this.blit(ctx, s.canvas, pixRect(s, vis), vis, pl.opacity, pl.blend);
        } else {
          this.blit(ctx, pl.surface.canvas, src, vis, pl.opacity, pl.blend);
        }
      }
    }
  }

  /** A non-rasterized text / shape layer: rendered straight from its spec into a scratch window, then masked and blended. */
  private drawVector(tgt: Target, l: VectorLayer, r: Rect, depth: number): void {
    const vis = intersect(r, specBounds(l));
    if (!vis) return;
    const s = this.scratch(tgt, depth, r);
    s.ctx.clearRect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.save();
    s.ctx.beginPath();
    s.ctx.rect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.clip();
    if (l.kind === 'text') drawText(s.ctx, l.spec);
    else drawShapeWith(this.doc.shapeRenderer, s.ctx, l.spec, this.doc.width, this.doc.height);
    s.ctx.restore();
    if (l.mask && l.mask.enabled) this.maskIn(s.ctx, l.mask, vis, vis);
    this.blit(tgt.ctx, s.canvas, pixRect(s, vis), vis, l.opacity, l.blend);
  }

  /** dst = dst * mask, for the (document-space) region `dst` of ctx; mask pixels come from `src` of the mask surface. */
  private maskIn(ctx: Ctx2D, mask: Mask, src: Rect, dst: Rect): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask.surface.canvas as CanvasImageSource, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
    ctx.restore();
  }

  /** target = mix(target, adjusted(target), opacity * mask) over r, in premultiplied RGBA. */
  private applyAdjustment(tgt: Target, spec: AdjustmentSpec, opacity: number, mask: Mask | null, r: Rect, depth: number): void {
    const tmp = this.scratch(tgt, depth, r);
    renderAdjusted(spec, tgt, tmp, r, { w: this.doc.width, h: this.doc.height }, (p) => this.padTarget(p, tgt.k));
    if (mask) this.maskIn(tmp.ctx, mask, r, r); // adjusted * mask
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
