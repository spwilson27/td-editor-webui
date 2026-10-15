import type { Rect } from './types';
import { createSurface, releaseSurface, type Surface } from './surface';

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
  private tiles = new Map<number, Surface>(); // saved pre-edit pixels, one small canvas per touched tile (memory ~ touched area)
  private cols: number;

  /** The second argument is accepted for compatibility and ignored: backups are per-tile, never layer sized. */
  constructor(private layer: { readonly surface: Surface }, _backup?: Surface) {
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
        if (this.tiles.has(i)) continue;
        const t = this.tileRect(i);
        const s = createSurface(t.w, t.h);
        s.ctx.drawImage(this.layer.surface.canvas as CanvasImageSource, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
        this.tiles.set(i, s);
      }
    }
  }

  /** Drop the saved tiles without producing patches. */
  dispose(): void {
    this.tiles.forEach(releaseSurface);
    this.tiles.clear();
  }

  /** Put the saved pixels back into `r` (layer space). */
  restore(r: Rect): void {
    this.cover(r);
    const c = this.layer.surface.ctx;
    c.clearRect(r.x, r.y, r.w, r.h);
    for (const [i, s] of this.tiles) {
      const t = this.tileRect(i);
      const x0 = Math.max(r.x, t.x);
      const y0 = Math.max(r.y, t.y);
      const x1 = Math.min(r.x + r.w, t.x + t.w);
      const y1 = Math.min(r.y + r.h, t.y + t.h);
      if (x1 > x0 && y1 > y0) c.drawImage(s.canvas as CanvasImageSource, x0 - t.x, y0 - t.y, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
  }

  /**
   * Before/after pixels of the saved tiles. Horizontally adjacent tiles are read back together (one
   * getImageData per run, not per tile), so a full-document edit costs one read per tile row.
   */
  patches(): Patch[] {
    const out: Patch[] = [];
    const sorted = Array.from(this.tiles.keys()).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1 && sorted[j + 1] % this.cols !== 0) j++;
      const first = this.tileRect(sorted[i]);
      const last = this.tileRect(sorted[j]);
      const r = { x: first.x, y: first.y, w: last.x + last.w - first.x, h: first.h };
      const run = createSurface(r.w, r.h);
      for (let k = i; k <= j; k++) {
        const t = this.tileRect(sorted[k]);
        run.ctx.drawImage(this.tiles.get(sorted[k])!.canvas as CanvasImageSource, t.x - r.x, 0);
      }
      out.push({ rect: r, before: run.ctx.getImageData(0, 0, r.w, r.h), after: this.layer.surface.ctx.getImageData(r.x, r.y, r.w, r.h) });
      releaseSurface(run);
      i = j + 1;
    }
    this.tiles.forEach(releaseSurface);
    this.tiles.clear();
    return out;
  }
}
