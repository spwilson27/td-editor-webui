import type { Rect, ToolPointer } from '../types';
import type { EditTarget } from '../model';
import { createSurface, releaseSurface, type Ctx2D, type Surface } from '../surface';
import { luminance } from '../adjustments';
import { clipToSize, intersect, union } from '../rect';
import { innerLayerRect, layerRectToDoc, type Xf } from '../xform';
import type { Host, Tool } from './host';
import { TileBackup } from '../tiles';

export type PaintMode = 'brush' | 'pencil' | 'eraser';

/**
 * Draw the selection coverage (document space canvas `sel`) so that layer-space point (u, v) lands at
 * (u - r.x + ox, v - r.y + oy) of `c`, for the layer rect `r` under `tf`. Only the part inside the document is drawn
 * (the selection is zero outside it). Cost is proportional to `r`.
 */
export function drawCoverage(host: Host, c: Ctx2D, sel: Surface, r: Rect, tf: Xf, ox: number, oy: number): void {
  const d = layerRectToDoc(tf, r);
  const x0 = Math.max(0, d.x);
  const y0 = Math.max(0, d.y);
  const x1 = Math.min(host.doc.width, d.x + d.w);
  const y1 = Math.min(host.doc.height, d.y + d.h);
  if (x1 <= x0 || y1 <= y0) return;
  const kx = r.w / d.w;
  const ky = r.h / d.h;
  c.save();
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'low';
  c.drawImage(sel.canvas as CanvasImageSource, x0, y0, x1 - x0, y1 - y0, (x0 - d.x) * kx + ox, (y0 - d.y) * ky + oy, (x1 - x0) * kx, (y1 - y0) * ky);
  c.restore();
}

/**
 * Where to draw `r` (layer space) of `canvas` from so that it is multiplied by the selection coverage: the canvas itself
 * when the selection is absent or a plain rect (the rect is clipped separately), otherwise a window copy multiplied by
 * the cached selection canvas mapped into layer space. Cost is proportional to `r`.
 */
export function coveredSource(host: Host, canvas: CanvasImageSource, r: Rect, tf: Xf, ox = 0, oy = 0): { img: CanvasImageSource; x: number; y: number } {
  const sel = host.selectionCanvas();
  if (!sel) return { img: canvas, x: r.x - ox, y: r.y - oy };
  const t = host.tempWindow(r.w, r.h);
  const c = t.ctx;
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, r.w, r.h);
  drawCoverage(host, c, sel, r, tf, 0, 0);
  c.globalCompositeOperation = 'source-in';
  c.drawImage(canvas, r.x - ox, r.y - oy, r.w, r.h, 0, 0, r.w, r.h);
  c.globalCompositeOperation = 'source-over';
  return { img: t.canvas as CanvasImageSource, x: 0, y: 0 };
}

/** Restore the pre-edit pixels in `r` (layer space), then run `draw` clipped to the selection (mapped into layer pixels). */
export function restoreAndDraw(host: Host, layer: EditTarget, tb: TileBackup, r: Rect, draw: () => void): void {
  tb.restore(r);
  const c = layer.surface.ctx;
  c.save();
  const s = host.doc.selection;
  if (s) {
    const q = innerLayerRect(layer.tf, s);
    c.beginPath();
    c.rect(q.x, q.y, q.w, q.h);
    c.clip();
  }
  draw();
  c.restore();
}

/**
 * Region of the layer an edit can touch: `r` (layer space) ∩ surface ∩ the layer pixels whose centres show inside the
 * document ∩ the selection. Returns layer space.
 */
export function editableRegion(host: Host, layer: EditTarget, r: Rect): Rect | null {
  const vis = innerLayerRect(layer.tf, { x: 0, y: 0, w: host.doc.width, h: host.doc.height });
  let out = intersect(r, { x: 0, y: 0, w: layer.surface.width, h: layer.surface.height });
  if (out) out = intersect(out, vis);
  if (out && host.doc.selection) out = intersect(out, innerLayerRect(layer.tf, host.doc.selection));
  return out;
}

export function commitPatches(host: Host, layer: EditTarget, tb: TileBackup, label: string): void {
  const patches = tb.patches();
  if (patches.length) host.pushPatch(label, layer, patches);
}

/**
 * Brush / pencil / eraser: dabs go to a stroke buffer, which is merged over the pre-stroke layer at stroke opacity.
 *
 * Everything is done in the edited surface's own pixel space (v4): the pointer's document position is mapped through the
 * inverse layer transform for every dab, spacing is measured in document pixels (so it matches what is seen), and the brush
 * tip is an ellipse of (size / sx) x (size / sy) layer pixels, i.e. exactly a circle of `size` document pixels. A pencil
 * dab is max(1, round(size / s)) layer pixels per axis.
 */
export class StrokeTool implements Tool {
  private layer: EditTarget | null = null;
  private lx = 0; // last pointer position (document)
  private ly = 0;
  private lu = 0; // last pointer position (layer space)
  private lv = 0;
  private toNext = 0; // distance until the next dab
  private tb: TileBackup | null = null;
  private acc: Rect | null = null; // dabs stamped but not yet merged into the layer (layer space)
  private buf: Surface | null = null; // stroke buffer: a window of layer space that grows with the stroke (never layer sized)
  private win: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private stampW = 0; // stamp canvas pixels used
  private stampH = 0;
  private drawW = 0; // size of one dab in layer pixels
  private drawH = 0;

  constructor(private host: Host, private mode: PaintMode) {}

  private map(x: number, y: number): { u: number; v: number } {
    const t = (this.layer as EditTarget).tf;
    return { u: (x - t.x) / t.sx, v: (y - t.y) / t.sy };
  }

  down(p: ToolPointer): void {
    this.layer = this.host.editableLayer();
    if (!this.layer) return;
    this.tb = new TileBackup(this.layer);
    this.buf = null;
    if (this.mode !== 'pencil') this.prepareStamp();
    this.acc = null;
    const { u, v } = this.map(p.x, p.y);
    this.accumulate(this.dab(u, v));
    this.lx = p.x;
    this.ly = p.y;
    this.lu = u;
    this.lv = v;
    this.toNext = this.step();
    this.merge();
  }

  move(p: ToolPointer): void {
    if (!this.layer) return;
    if (this.mode === 'pencil') {
      this.bresenham(p.x, p.y);
    } else {
      const dist = Math.hypot(p.x - this.lx, p.y - this.ly);
      const step = this.step();
      let pos = this.toNext;
      while (pos <= dist) {
        const t = pos / dist;
        const { u, v } = this.map(this.lx + (p.x - this.lx) * t, this.ly + (p.y - this.ly) * t);
        this.accumulate(this.dab(u, v));
        pos += step;
      }
      this.toNext = pos - dist;
    }
    this.lx = p.x;
    this.ly = p.y;
    const m = this.map(p.x, p.y);
    this.lu = m.u;
    this.lv = m.v;
    this.merge();
  }

  up(p: ToolPointer): void {
    if (!this.layer) return;
    this.move(p);
    const layer = this.layer;
    const tb = this.tb as TileBackup;
    this.layer = null;
    this.tb = null;
    if (this.buf) releaseSurface(this.buf);
    this.buf = null;
    commitPatches(this.host, layer, tb, this.mode === 'eraser' ? 'Eraser' : this.mode === 'pencil' ? 'Pencil' : 'Brush');
  }

  private step(): number {
    return this.mode === 'pencil' ? 1 : Math.max(1, this.host.context().brush.spacing * Math.max(1, this.host.context().brush.size));
  }

  private color(): string {
    if (this.layer?.isMask) return 'rgb(255,255,255)'; // coverage only: the mask value is applied at merge time
    const { r, g, b } = this.mode === 'eraser' ? { r: 0, g: 0, b: 0 } : this.host.context().primary;
    return `rgb(${r},${g},${b})`;
  }

  private prepareStamp(): void {
    const { size, hardness } = this.host.context().brush;
    const t = (this.layer as EditTarget).tf;
    const d = Math.min(1000, Math.max(1, size));
    const dx = d / t.sx; // tip diameter in layer pixels
    const dy = d / t.sy;
    const cap = this.host.scratch.stamp.width;
    this.drawW = Math.ceil(dx) + 2;
    this.drawH = Math.ceil(dy) + 2;
    const sw = Math.min(cap, this.drawW); // canvas pixels (a huge tip is drawn smaller and enlarged)
    const sh = Math.min(cap, this.drawH);
    this.stampW = sw;
    this.stampH = sh;
    const s = this.host.scratch.stamp;
    // Clear the whole scratch canvas, not just sw x sh: the stamp is drawn at fractional positions with bilinear sampling, which
    // reads the texels just outside its source rect; leftovers of a previous (larger / differently coloured) tip there showed up
    // as 1 px lines of the old colour along the dab edges (rows and columns) on scaled layers.
    s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
    s.ctx.save();
    s.ctx.translate(sw / 2, sh / 2);
    s.ctx.scale((dx / 2) * (sw / this.drawW), (dy / 2) * (sh / this.drawH));
    const col = this.color();
    if (hardness >= 1) {
      s.ctx.fillStyle = col;
      s.ctx.beginPath();
      s.ctx.arc(0, 0, 1, 0, Math.PI * 2);
      s.ctx.fill();
    } else {
      const g = s.ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      const base = col.slice(4, -1);
      g.addColorStop(0, `rgba(${base},1)`);
      g.addColorStop(Math.max(0, hardness), `rgba(${base},1)`);
      g.addColorStop(1, `rgba(${base},0)`);
      s.ctx.fillStyle = g;
      s.ctx.fillRect(-1.5, -1.5, 3, 3);
    }
    s.ctx.restore();
  }

  /** Make the stroke buffer cover `r` (layer space, inside the surface); grows geometrically so a long stroke reallocates rarely. */
  private ensure(r: Rect): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
    const lay = this.layer as EditTarget;
    const bounds = { x: 0, y: 0, w: lay.surface.width, h: lay.surface.height };
    if (this.buf && r.x >= this.win.x && r.y >= this.win.y && r.x + r.w <= this.win.x + this.win.w && r.y + r.h <= this.win.y + this.win.h) return this.buf.ctx;
    const want = this.buf ? (union(this.win, r) as Rect) : r;
    const m = Math.max(64, Math.ceil(Math.max(want.w, want.h) * (this.buf ? 0.25 : 0)));
    const nw = intersect({ x: want.x - m, y: want.y - m, w: want.w + 2 * m, h: want.h + 2 * m }, bounds) as Rect;
    const next = createSurface(nw.w, nw.h);
    if (this.buf) {
      next.ctx.drawImage(this.buf.canvas as CanvasImageSource, this.win.x - nw.x, this.win.y - nw.y);
      releaseSurface(this.buf);
    }
    this.buf = next;
    this.win = nw;
    return next.ctx;
  }

  /** Stamp one dab centred at layer position (u, v); returns the editable layer rect it touched. */
  private dab(u: number, v: number): Rect | null {
    const layer = this.layer as EditTarget;
    const { brush } = this.host.context();
    const t = layer.tf;
    let r: Rect;
    let pw = 0;
    let ph = 0;
    if (this.mode === 'pencil') {
      pw = Math.max(1, Math.round(brush.size / t.sx));
      ph = Math.max(1, Math.round(brush.size / t.sy));
      r = { x: Math.floor(u) - Math.floor(pw / 2), y: Math.floor(v) - Math.floor(ph / 2), w: pw, h: ph };
    } else {
      r = { x: Math.floor(u - this.drawW / 2) - 1, y: Math.floor(v - this.drawH / 2) - 1, w: this.drawW + 3, h: this.drawH + 3 };
    }
    const lr = clipToSize(r, layer.surface.width, layer.surface.height);
    if (!lr) return null;
    const sc = this.ensure(lr);
    if (this.mode === 'pencil') {
      sc.fillStyle = this.color();
      sc.fillRect(r.x - this.win.x, r.y - this.win.y, pw, ph);
    } else {
      sc.globalAlpha = brush.flow;
      sc.drawImage(this.host.scratch.stamp.canvas as CanvasImageSource, 0, 0, this.stampW, this.stampH, u - this.drawW / 2 - this.win.x, v - this.drawH / 2 - this.win.y, this.drawW, this.drawH);
      sc.globalAlpha = 1;
    }
    return editableRegion(this.host, layer, lr);
  }

  private bresenham(x1: number, y1: number): void {
    const { u, v } = this.map(x1, y1);
    let x0 = Math.floor(this.lu), y0 = Math.floor(this.lv);
    const ex = Math.floor(u), ey = Math.floor(v);
    const dx = Math.abs(ex - x0), dy = -Math.abs(ey - y0);
    const sx = x0 < ex ? 1 : -1, sy = y0 < ey ? 1 : -1;
    let err = dx + dy;
    while (x0 !== ex || y0 !== ey) {
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
      this.accumulate(this.dab(x0, y0));
    }
  }

  /** Merge long runs in pieces so a fast stroke only restores/saves the tiles it actually crosses. */
  private accumulate(r: Rect | null): void {
    this.acc = union(this.acc, r);
    if (this.acc && (this.acc.w > 192 || this.acc.h > 192)) this.merge();
  }

  private merge(): void {
    const layer = this.layer;
    const r = this.acc;
    this.acc = null;
    if (!layer || !r) return;
    const { brush, primary } = this.host.context();
    restoreAndDraw(this.host, layer, this.tb as TileBackup, r, () => {
      const c = layer.surface.ctx;
      const cov = coveredSource(this.host, (this.buf as Surface).canvas as CanvasImageSource, r, layer.tf, this.win.x, this.win.y);
      const stroke = cov.img;
      const sx = cov.x;
      const sy = cov.y;
      if (layer.isMask) {
        // mask = lerp(mask, value, coverage * opacity), stored as alpha: scale the old alpha down, add value * coverage.
        const a = brush.opacity * primary.a / 255;
        const value = this.mode === 'eraser' ? 0 : luminance(primary.r, primary.g, primary.b) / 255;
        const amount = this.mode === 'eraser' ? brush.opacity : a;
        c.globalAlpha = amount;
        c.globalCompositeOperation = 'destination-out';
        c.drawImage(stroke, sx, sy, r.w, r.h, r.x, r.y, r.w, r.h);
        if (value > 0) {
          c.globalAlpha = amount * value;
          c.globalCompositeOperation = 'lighter';
          c.drawImage(stroke, sx, sy, r.w, r.h, r.x, r.y, r.w, r.h);
        }
        return;
      }
      c.globalAlpha = brush.opacity * (this.mode === 'eraser' ? 1 : primary.a / 255);
      c.globalCompositeOperation = this.mode === 'eraser' ? 'destination-out' : 'source-over';
      c.drawImage(stroke, sx, sy, r.w, r.h, r.x, r.y, r.w, r.h);
    });
    this.host.paintChanged(layer, r);
  }
}
