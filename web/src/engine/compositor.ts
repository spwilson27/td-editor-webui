import type { BlendMode, Rect } from './types';
import { createSurface, releaseSurface, type Ctx2D, type Surface } from './surface';
import type { Document, GroupLayer } from './model';
import { clipToSize, intersect, union } from './rect';

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

/** Flattens the layer tree into `surface`, redrawing only the pending dirty rect, at most once per frame. */
export class Compositor {
  surface: Surface;
  private scratch: Surface[] = [];
  private dirty: Rect | null = null;
  private handle: unknown = null;
  private disposed = false;

  constructor(private doc: Document, private onComposite: (r: Rect) => void) {
    this.surface = createSurface(doc.width, doc.height, true);
    this.invalidate(null);
  }

  /** Mark a document-space rect dirty; null = whole document. */
  invalidate(r: Rect | null): void {
    if (this.disposed) return;
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const clipped = r ? clipToSize(r, full.w, full.h) : full;
    if (!clipped) return;
    this.dirty = union(this.dirty, clipped);
    if (this.handle === null) {
      this.handle = raf(() => {
        this.handle = null;
        this.flush();
      });
    }
  }

  /** Composite pending dirty rect now. */
  flush(): void {
    const r = this.disposed ? null : this.dirty;
    if (!r) return;
    this.dirty = null;
    const ctx = this.surface.ctx;
    ctx.clearRect(r.x, r.y, r.w, r.h);
    this.renderGroup(ctx, this.doc.root, r, 0);
    this.onComposite(r);
  }

  /** Doc size changed: reallocate (callers re-invalidate content via full dirty). */
  resize(): void {
    releaseSurface(this.surface);
    this.scratch.forEach(releaseSurface);
    this.scratch = [];
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
    this.scratch.forEach(releaseSurface);
    this.scratch = [];
  }

  /** Render a group alone (thumbnails) into scratch(0) and return it. */
  renderIsolated(group: GroupLayer): Surface {
    const s = this.scratchAt(0);
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    s.ctx.clearRect(0, 0, full.w, full.h);
    this.renderGroup(s.ctx, group, full, 1);
    return s;
  }

  private scratchAt(depth: number): Surface {
    if (!this.scratch[depth]) this.scratch[depth] = createSurface(this.doc.width, this.doc.height);
    return this.scratch[depth];
  }

  private renderGroup(ctx: Ctx2D, group: GroupLayer, r: Rect, depth: number): void {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const l = group.children[i];
      if (!l.visible || l.opacity <= 0) continue;
      if (l.kind === 'group') {
        const s = this.scratchAt(depth);
        s.ctx.clearRect(r.x, r.y, r.w, r.h);
        this.renderGroup(s.ctx, l, r, depth + 1);
        this.blit(ctx, s, r, r.x, r.y, l.opacity, l.blend);
      } else {
        const vis = intersect(r, { x: l.x, y: l.y, w: l.surface.width, h: l.surface.height });
        if (vis) this.blit(ctx, l.surface, { x: vis.x - l.x, y: vis.y - l.y, w: vis.w, h: vis.h }, vis.x, vis.y, l.opacity, l.blend);
      }
    }
  }

  private blit(ctx: Ctx2D, src: Surface, s: Rect, dx: number, dy: number, alpha: number, blend: BlendMode): void {
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = OPS[blend];
    ctx.drawImage(src.canvas as CanvasImageSource, s.x, s.y, s.w, s.h, dx, dy, s.w, s.h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
