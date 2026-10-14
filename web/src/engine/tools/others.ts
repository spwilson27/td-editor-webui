import type { Rect, ToolPointer } from '../types';
import { fromPoints, intersect, isEmpty, translate, union } from '../rect';
import { cropData, floodFill, paintMasked } from '../floodFill';
import type { StructureSnapshot, PixelLayer } from '../model';
import { commitPatches, editableRegion, restoreAndDraw } from './paint';
import { cancelRaf, raf } from '../compositor';
import { TileBackup } from '../tiles';
import type { Host, Tool } from './host';

export class PickerTool implements Tool {
  constructor(private host: Host) {}
  down(p: ToolPointer): void {
    this.move(p);
  }
  move(p: ToolPointer): void {
    const color = this.host.sample(p.x, p.y);
    if (color) this.host.emit({ type: 'pick', color });
  }
  up(): void {}
}

export class MoveTool implements Tool {
  private layer: PixelLayer | null = null;
  private before: StructureSnapshot | null = null;
  private sx = 0;
  private sy = 0;
  private ox = 0;
  private oy = 0;

  constructor(private host: Host) {}

  down(p: ToolPointer): void {
    const l = this.host.doc.active();
    if (l && l.kind === 'group') return this.host.emit({ type: 'notice', message: 'Select a pixel layer to move' });
    this.layer = this.host.editableLayer();
    if (!this.layer) return;
    this.before = this.host.doc.snapshot();
    this.sx = p.x;
    this.sy = p.y;
    this.ox = this.layer.x;
    this.oy = this.layer.y;
  }

  move(p: ToolPointer): void {
    const l = this.layer;
    if (!l) return;
    const nx = this.ox + Math.round(p.x - this.sx);
    const ny = this.oy + Math.round(p.y - this.sy);
    if (nx === l.x && ny === l.y) return;
    const old: Rect = { x: l.x, y: l.y, w: l.surface.width, h: l.surface.height };
    l.x = nx;
    l.y = ny;
    this.host.changed(union(old, translate(old, nx - old.x, ny - old.y)) as Rect);
  }

  up(p: ToolPointer): void {
    if (!this.layer) return;
    this.move(p);
    if (this.layer.x !== this.ox || this.layer.y !== this.oy) this.host.commitStructure('Move', this.before as StructureSnapshot, undefined, false);
    this.layer = null;
    this.before = null;
  }
}

export class MarqueeTool implements Tool {
  private sx = 0;
  private sy = 0;
  constructor(private setSelection: (r: Rect | null) => void) {}
  down(p: ToolPointer): void {
    this.sx = p.x;
    this.sy = p.y;
    this.setSelection(null);
  }
  move(p: ToolPointer): void {
    const r = fromPoints(Math.round(this.sx), Math.round(this.sy), Math.round(p.x), Math.round(p.y));
    this.setSelection(isEmpty(r) ? null : r);
  }
  up(p: ToolPointer): void {
    this.move(p);
  }
}

export class FillTool implements Tool {
  constructor(private host: Host) {}

  down(p: ToolPointer): void {
    const layer = this.host.editableLayer();
    if (!layer) return;
    const area = editableRegion(this.host, layer, { x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 });
    if (!area) return;
    // Flood only inside the selection (or the whole layer): read just that region.
    const lay = intersect({ x: 0, y: 0, w: layer.surface.width, h: layer.surface.height }, translate(this.host.doc.selection ?? { x: 0, y: 0, w: this.host.doc.width, h: this.host.doc.height }, -layer.x, -layer.y)) as Rect;
    const ctx = this.host.context();
    const img = layer.surface.ctx.getImageData(lay.x, lay.y, lay.w, lay.h);
    const res = floodFill(img.data, lay.w, lay.h, Math.floor(p.x) - layer.x - lay.x, Math.floor(p.y) - layer.y - lay.y, ctx.fillTolerance);
    if (!res) return;
    const before = cropData(img.data, lay.w, res.rect);
    const after = before.slice();
    paintMasked(after, lay.w, res.rect, res.mask, ctx.primary);
    const r = { x: lay.x + res.rect.x, y: lay.y + res.rect.y, w: res.rect.w, h: res.rect.h };
    const afterImg = new ImageData(after, r.w, r.h);
    layer.surface.ctx.putImageData(afterImg, r.x, r.y);
    this.host.changed(translate(r, layer.x, layer.y));
    this.host.pushPatch('Fill', layer, [{ rect: r, before: new ImageData(before, r.w, r.h), after: afterImg }]);
  }
  move(): void {}
  up(): void {}
}

export class GradientTool implements Tool {
  private layer: PixelLayer | null = null;
  private tb: TileBackup | null = null;
  private sx = 0;
  private sy = 0;
  private pending: { x: number; y: number } | null = null;
  private handle: unknown = null;
  private drew = false;

  constructor(private host: Host) {}

  down(p: ToolPointer): void {
    this.layer = this.host.editableLayer();
    if (!this.layer) return;
    this.tb = new TileBackup(this.layer, this.host.scratch.backup);
    this.sx = p.x;
    this.sy = p.y;
    this.drew = false;
  }

  /** Redraws are coalesced to one per animation frame: every move repaints the whole layer. */
  move(p: ToolPointer): void {
    if (!this.layer) return;
    this.pending = { x: p.x, y: p.y };
    if (this.handle === null) {
      this.handle = raf(() => {
        this.handle = null;
        this.draw();
      });
    }
  }

  up(p: ToolPointer): void {
    if (!this.layer) return;
    if (this.handle !== null) cancelRaf(this.handle);
    this.handle = null;
    this.pending = { x: p.x, y: p.y };
    this.draw();
    const layer = this.layer;
    const tb = this.tb as TileBackup;
    this.layer = null;
    this.tb = null;
    if (this.drew && !(p.x === this.sx && p.y === this.sy)) commitPatches(this.host, layer, tb, 'Gradient');
  }

  private draw(): void {
    const layer = this.layer;
    const p = this.pending;
    this.pending = null;
    if (!layer || !p) return;
    const area = editableRegion(this.host, layer, { x: 0, y: 0, w: this.host.doc.width, h: this.host.doc.height });
    if (!area) return;
    const lr = translate(area, -layer.x, -layer.y);
    const { primary: a, secondary: b } = this.host.context();
    restoreAndDraw(this.host, layer, this.tb as TileBackup, lr, () => {
      if (p.x === this.sx && p.y === this.sy) return; // zero-length drag paints nothing
      const c = layer.surface.ctx;
      const g = c.createLinearGradient(this.sx - layer.x, this.sy - layer.y, p.x - layer.x, p.y - layer.y);
      g.addColorStop(0, `rgba(${a.r},${a.g},${a.b},${a.a / 255})`);
      g.addColorStop(1, `rgba(${b.r},${b.g},${b.b},${b.a / 255})`);
      c.fillStyle = g;
      c.fillRect(lr.x, lr.y, lr.w, lr.h);
    });
    this.drew = true;
    this.host.changed(area);
  }
}
