import type { Rect, ToolPointer } from '../types';
import type { EditTarget } from '../model';
import { luminance } from '../adjustments';
import { clipToSize, intersect, union } from '../rect';
import type { Host, Tool } from './host';
import { TileBackup } from '../tiles';

export type PaintMode = 'brush' | 'pencil' | 'eraser';

/** Restore the pre-edit pixels in `r` (layer space), then run `draw` clipped to the selection. */
export function restoreAndDraw(host: Host, layer: EditTarget, tb: TileBackup, r: Rect, draw: () => void): void {
  tb.restore(r);
  const c = layer.surface.ctx;
  c.save();
  const s = host.doc.selection;
  if (s) {
    c.beginPath();
    c.rect(s.x - layer.x, s.y - layer.y, s.w, s.h);
    c.clip();
  }
  draw();
  c.restore();
}

/** Region of the document an edit to `layer` can touch: layer ∩ document ∩ selection, in document space. */
export function editableRegion(host: Host, layer: EditTarget, r: Rect): Rect | null {
  const lay = intersect({ x: layer.x, y: layer.y, w: layer.surface.width, h: layer.surface.height }, { x: 0, y: 0, w: host.doc.width, h: host.doc.height });
  let out = lay && intersect(r, lay);
  if (out && host.doc.selection) out = intersect(out, host.doc.selection);
  return out;
}

export function commitPatches(host: Host, layer: EditTarget, tb: TileBackup, label: string): void {
  const patches = tb.patches();
  if (patches.length) host.pushPatch(label, layer, patches);
}

/** Brush / pencil / eraser: dabs go to a stroke buffer, which is merged over the pre-stroke layer at stroke opacity. */
export class StrokeTool implements Tool {
  private layer: EditTarget | null = null;
  private lx = 0;
  private ly = 0;
  private toNext = 0; // distance until the next dab
  private tb: TileBackup | null = null;
  private acc: Rect | null = null; // dabs stamped but not yet merged into the layer
  private touched: Rect | null = null; // everything stamped into the stroke buffer (document clipped only)
  private stampSize = 0;

  constructor(private host: Host, private mode: PaintMode) {}

  down(p: ToolPointer): void {
    this.layer = this.host.editableLayer();
    if (!this.layer) return;
    this.tb = new TileBackup(this.layer, this.host.scratch.backup);
    this.touched = null;
    if (this.mode !== 'pencil') this.prepareStamp();
    this.acc = null;
    this.accumulate(this.dab(p.x, p.y));
    this.lx = p.x;
    this.ly = p.y;
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
        this.accumulate(this.dab(this.lx + (p.x - this.lx) * t, this.ly + (p.y - this.ly) * t));
        pos += step;
      }
      this.toNext = pos - dist;
    }
    this.lx = p.x;
    this.ly = p.y;
    this.merge();
  }

  up(p: ToolPointer): void {
    if (!this.layer) return;
    this.move(p);
    const layer = this.layer;
    const tb = this.tb as TileBackup;
    const t = this.touched;
    this.layer = null;
    this.tb = null;
    this.touched = null;
    if (t) this.host.scratch.stroke.ctx.clearRect(t.x, t.y, t.w, t.h);
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
    const d = Math.min(1000, Math.max(1, size));
    const sz = Math.ceil(d) + 2;
    this.stampSize = sz;
    const s = this.host.scratch.stamp;
    s.ctx.clearRect(0, 0, sz, sz);
    const c = sz / 2;
    const r = d / 2;
    const col = this.color();
    if (hardness >= 1) {
      s.ctx.fillStyle = col;
      s.ctx.beginPath();
      s.ctx.arc(c, c, r, 0, Math.PI * 2);
      s.ctx.fill();
    } else {
      const g = s.ctx.createRadialGradient(c, c, 0, c, c, r);
      const base = col.slice(4, -1);
      g.addColorStop(0, `rgba(${base},1)`);
      g.addColorStop(Math.max(0, hardness), `rgba(${base},1)`);
      g.addColorStop(1, `rgba(${base},0)`);
      s.ctx.fillStyle = g;
      s.ctx.fillRect(0, 0, sz, sz);
    }
  }

  /** Stamp one dab into the stroke buffer; returns the editable doc rect it touched. */
  private dab(x: number, y: number): Rect | null {
    const sc = this.host.scratch.stroke.ctx;
    const { brush } = this.host.context();
    let r: Rect;
    if (this.mode === 'pencil') {
      const side = Math.max(1, Math.round(brush.size));
      const px = Math.floor(x) - Math.floor(side / 2);
      const py = Math.floor(y) - Math.floor(side / 2);
      sc.fillStyle = this.color();
      sc.fillRect(px, py, side, side);
      r = { x: px, y: py, w: side, h: side };
    } else {
      const sz = this.stampSize;
      sc.globalAlpha = brush.flow;
      sc.drawImage(this.host.scratch.stamp.canvas as CanvasImageSource, 0, 0, sz, sz, x - sz / 2, y - sz / 2, sz, sz);
      sc.globalAlpha = 1;
      r = { x: Math.floor(x - sz / 2) - 1, y: Math.floor(y - sz / 2) - 1, w: sz + 3, h: sz + 3 };
    }
    const docR = clipToSize(r, this.host.doc.width, this.host.doc.height);
    if (!docR) return null;
    this.touched = union(this.touched, docR);
    return this.layer ? editableRegion(this.host, this.layer, docR) : null;
  }

  private bresenham(x1: number, y1: number): void {
    let x0 = Math.floor(this.lx), y0 = Math.floor(this.ly);
    const ex = Math.floor(x1), ey = Math.floor(y1);
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
    const lx = r.x - layer.x;
    const ly = r.y - layer.y;
    restoreAndDraw(this.host, layer, this.tb as TileBackup, { x: lx, y: ly, w: r.w, h: r.h }, () => {
      const c = layer.surface.ctx;
      const stroke = this.host.scratch.stroke.canvas as CanvasImageSource;
      if (layer.isMask) {
        // mask = lerp(mask, value, coverage * opacity), stored as alpha: scale the old alpha down, add value * coverage.
        const a = brush.opacity * primary.a / 255;
        const value = this.mode === 'eraser' ? 0 : luminance(primary.r, primary.g, primary.b) / 255;
        const amount = this.mode === 'eraser' ? brush.opacity : a;
        c.globalAlpha = amount;
        c.globalCompositeOperation = 'destination-out';
        c.drawImage(stroke, r.x, r.y, r.w, r.h, lx, ly, r.w, r.h);
        if (value > 0) {
          c.globalAlpha = amount * value;
          c.globalCompositeOperation = 'lighter';
          c.drawImage(stroke, r.x, r.y, r.w, r.h, lx, ly, r.w, r.h);
        }
        return;
      }
      c.globalAlpha = brush.opacity * (this.mode === 'eraser' ? 1 : primary.a / 255);
      c.globalCompositeOperation = this.mode === 'eraser' ? 'destination-out' : 'source-over';
      c.drawImage(stroke, r.x, r.y, r.w, r.h, lx, ly, r.w, r.h);
    });
    this.host.paintChanged(layer, r);
  }
}
