import type { Rect } from './types';
import type { PixelLayer } from './model';
import type { Surface } from './surface';

export const TILE = 128;

export interface Patch {
  rect: Rect; // layer space
  before: ImageData;
  after: ImageData;
}

/**
 * Lazily saves the pre-edit pixels of a layer, one TILE×TILE tile at a time, into a (GPU-friendly) backup surface.
 * Tiles are saved the first time an edit is about to touch them; only those tiles become undo patches.
 */
export class TileBackup {
  private done = new Set<number>();
  private cols: number;

  constructor(private layer: PixelLayer, private backup: Surface) {
    this.cols = Math.ceil(layer.surface.width / TILE);
  }

  private tileRect(i: number): Rect {
    const x = (i % this.cols) * TILE;
    const y = Math.floor(i / this.cols) * TILE;
    return { x, y, w: Math.min(TILE, this.layer.surface.width - x), h: Math.min(TILE, this.layer.surface.height - y) };
  }

  /** Make sure every tile touching `r` (layer space) is saved. Call before modifying the layer in `r`. */
  cover(r: Rect): void {
    const W = this.layer.surface.width;
    const H = this.layer.surface.height;
    const x0 = Math.max(0, Math.floor(r.x / TILE));
    const y0 = Math.max(0, Math.floor(r.y / TILE));
    const x1 = Math.min(Math.ceil(W / TILE) - 1, Math.floor((r.x + r.w - 1) / TILE));
    const y1 = Math.min(Math.ceil(H / TILE) - 1, Math.floor((r.y + r.h - 1) / TILE));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const i = ty * this.cols + tx;
        if (this.done.has(i)) continue;
        this.done.add(i);
        const t = this.tileRect(i);
        this.backup.ctx.clearRect(t.x, t.y, t.w, t.h);
        this.backup.ctx.drawImage(this.layer.surface.canvas as CanvasImageSource, t.x, t.y, t.w, t.h, t.x, t.y, t.w, t.h);
      }
    }
  }

  /** Put the saved pixels back into `r` (layer space). */
  restore(r: Rect): void {
    this.cover(r);
    const c = this.layer.surface.ctx;
    c.clearRect(r.x, r.y, r.w, r.h);
    c.drawImage(this.backup.canvas as CanvasImageSource, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }

  /**
   * Before/after pixels of the saved tiles. Horizontally adjacent tiles are read back together (one
   * getImageData per run, not per tile), so a full-document edit costs one read per tile row.
   */
  patches(): Patch[] {
    const out: Patch[] = [];
    const sorted = Array.from(this.done).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1 && sorted[j + 1] % this.cols !== 0) j++;
      const first = this.tileRect(sorted[i]);
      const last = this.tileRect(sorted[j]);
      const r = { x: first.x, y: first.y, w: last.x + last.w - first.x, h: first.h };
      out.push({
        rect: r,
        before: this.backup.ctx.getImageData(r.x, r.y, r.w, r.h),
        after: this.layer.surface.ctx.getImageData(r.x, r.y, r.w, r.h),
      });
      i = j + 1;
    }
    return out;
  }
}
