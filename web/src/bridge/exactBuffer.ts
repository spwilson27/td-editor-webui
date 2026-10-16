// v11: the persistent exact RGBA8 (straight alpha) copy of TD's output for one editor, patched by VIEW_EXACT frames.

export interface DirtyRect { x: number; y: number; w: number; h: number }

export type ApplyResult = { ok: true; dirty: DirtyRect[] } | { ok: false; reason: 'no-buffer' | 'size' | 'length' | 'tile' };

export class ExactBuffer {
  w = 0;
  h = 0;
  /** docW × docH × 4 once a full frame arrived; reused (never reallocated) while the size stays. */
  data = new Uint8Array(0);
  /** A full frame has been applied for the current size and nothing failed since. */
  valid = false;

  /** Drop the content (memory is kept for a document of the same size). */
  invalidate() { this.valid = false; }

  /** Start a full frame: returns the buffer to inflate into (reallocated only when the size changes). The content is invalid until `commitFull`. */
  beginFull(docW: number, docH: number): Uint8Array {
    this.valid = false;
    if (this.w !== docW || this.h !== docH || this.data.length !== docW * docH * 4) { this.data = new Uint8Array(docW * docH * 4); this.w = docW; this.h = docH; }
    return this.data;
  }
  commitFull(): void { this.valid = true; }

  /** A full frame: `rgba` is docW*docH*4 bytes. */
  applyFull(docW: number, docH: number, rgba: Uint8Array): ApplyResult {
    if (rgba.length !== docW * docH * 4) { this.valid = false; return { ok: false, reason: 'length' }; }
    if (this.w !== docW || this.h !== docH || this.data.length !== rgba.length) { this.data = new Uint8Array(rgba.length); this.w = docW; this.h = docH; }
    this.data.set(rgba);
    this.valid = true;
    return { ok: true, dirty: [{ x: 0, y: 0, w: docW, h: docH }] };
  }

  /** Tiles: `body` = nTiles × (u16 tx, ty, w, h) then each tile's rows. tx/ty are in tile units (× `tile` px). The buffer is untouched when the frame is malformed. */
  applyTiles(docW: number, docH: number, tile: number, nTiles: number, body: Uint8Array): ApplyResult {
    if (!this.valid || this.w !== docW || this.h !== docH) return { ok: false, reason: this.valid ? 'size' : 'no-buffer' };
    const idx = nTiles * 8;
    if (body.length < idx) return { ok: false, reason: 'length' };
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    // validate everything before touching the buffer
    let need = idx;
    const rects: DirtyRect[] = [];
    for (let i = 0; i < nTiles; i++) {
      const x = v.getUint16(i * 8, true) * tile, y = v.getUint16(i * 8 + 2, true) * tile, w = v.getUint16(i * 8 + 4, true), h = v.getUint16(i * 8 + 6, true);
      if (w < 1 || h < 1 || x + w > docW || y + h > docH) return { ok: false, reason: 'tile' };
      rects.push({ x, y, w, h });
      need += w * h * 4;
    }
    if (need !== body.length) return { ok: false, reason: 'length' };
    let o = idx;
    const rowStride = docW * 4;
    for (const r of rects) {
      const rb = r.w * 4;
      for (let row = 0; row < r.h; row++, o += rb) this.data.set(body.subarray(o, o + rb), (r.y + row) * rowStride + r.x * 4);
    }
    return { ok: true, dirty: rects };
  }
}
