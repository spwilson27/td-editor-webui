import type { Rect, RGBA, ToolPointer } from '../types';
import { intersect, translate, union } from '../rect';
import { cropData, floodFill } from '../floodFill';
import { isVector, layerBox, type EditTarget, type PixelLayer, type StructureSnapshot, type VectorLayer } from '../model';
import { translateShape, translateText } from '../textShape';
import { luminance } from '../adjustments';
import { applyMat, innerLayerRect, invMat, isAxis, layerRectToDoc, matOf, outerRect, toLayer } from '../xform';
import type { Surface } from '../surface';
import { commitPatches, drawCoverage, editableRegion, restoreAndDraw } from './paint';
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

/**
 * Drags the active layer: pixel / base layers change their transform position (whole-pixel steps from where they were
 * picked up), text / shape layers edit their geometry. Snapping (Host.snapMove) adjusts the dragged bounds.
 * Scaling is done through EditorEngine.setTransform / setLayerBox (the UI draws the transform box and its handles).
 */
export class MoveTool implements Tool {
  private layer: PixelLayer | VectorLayer | null = null;
  private before: StructureSnapshot | null = null;
  private sx = 0;
  private sy = 0;
  private ox = 0;
  private oy = 0;
  private box: Rect | null = null; // document bounds at pointer down
  private spec: VectorLayer['spec'] | null = null; // text / shape: the spec at pointer down
  private moved = false;

  constructor(private host: Host) {}

  down(p: ToolPointer): void {
    this.layer = this.host.movableLayer();
    if (!this.layer) return;
    this.before = this.host.doc.snapshot();
    this.sx = p.x;
    this.sy = p.y;
    this.moved = false;
    this.box = layerBox(this.layer);
    if (isVector(this.layer)) {
      this.spec = this.layer.spec;
      this.ox = this.oy = 0;
    } else {
      this.ox = this.layer.x;
      this.oy = this.layer.y;
    }
  }

  move(p: ToolPointer): void {
    const l = this.layer;
    if (!l) return;
    let dx = Math.round(p.x - this.sx);
    let dy = Math.round(p.y - this.sy);
    if (this.box && (dx !== 0 || dy !== 0)) {
      const sn = this.host.snapMove(translate(this.box, dx, dy), l.id);
      dx = Math.round(dx + sn.dx); // whole pixels
      dy = Math.round(dy + sn.dy);
    }
    if (isVector(l)) {
      // Text and shapes move by editing the spec position (TouchDesigner renders from it), never by an offset.
      if (!this.moved && dx === 0 && dy === 0) return;
      const cur = this.spec as VectorLayer['spec'];
      const next = l.kind === 'text' ? translateText(cur as never, dx, dy) : translateShape(cur as never, dx, dy);
      this.host.respec(l, next);
      this.host.docMoved();
      this.moved = dx !== 0 || dy !== 0 || this.moved;
      return;
    }
    const nx = this.ox + dx;
    const ny = this.oy + dy;
    if (nx === l.x && ny === l.y) return;
    const old = outerRect(layerRectToDoc(l, { x: 0, y: 0, w: l.surface.width, h: l.surface.height }));
    l.x = nx;
    l.y = ny;
    const now = outerRect(layerRectToDoc(l, { x: 0, y: 0, w: l.surface.width, h: l.surface.height }));
    this.host.changed(union(old, now) as Rect);
    this.host.docMoved();
  }

  up(p: ToolPointer): void {
    const l = this.layer;
    if (!l) return;
    this.move(p);
    const changed = isVector(l) ? l.spec !== this.spec : l.x !== this.ox || l.y !== this.oy;
    if (changed) this.host.commitStructure('Move', this.before as StructureSnapshot, undefined, false);
    this.layer = null;
    this.before = null;
    this.spec = null;
  }
}

export class FillTool implements Tool {
  constructor(private host: Host) {}

  /**
   * Flood fill in the layer's own pixels: the clicked layer pixel is the one under the cursor (inverse transform),
   * tolerance is measured on layer pixels, and the fill is limited to the part of the layer visible in the document
   * (and the selection; partial coverage is sampled at layer pixel centres).
   */
  down(p: ToolPointer): void {
    const layer = this.host.editableLayer();
    if (!layer) return;
    const tf = layer.tf;
    const { width: docW, height: docH } = this.host.doc;
    const dxp = Math.floor(p.x);
    const dyp = Math.floor(p.y);
    if (!(dxp >= 0 && dyp >= 0 && dxp < docW && dyp < docH)) return;
    const cov = this.host.selectionAlpha();
    if (cov && cov[dyp * docW + dxp] === 0) return; // clicked on an unselected pixel
    const lp = toLayer(tf, p.x, p.y);
    const cu = Math.floor(lp.x);
    const cv = Math.floor(lp.y);
    const lay = intersect(
      { x: 0, y: 0, w: layer.surface.width, h: layer.surface.height },
      innerLayerRect(tf, this.host.doc.selection ?? { x: 0, y: 0, w: docW, h: docH }),
    );
    if (!lay || cu < lay.x || cv < lay.y || cu >= lay.x + lay.w || cv >= lay.y + lay.h) return;
    const ctx = this.host.context();
    const img = layer.surface.ctx.getImageData(lay.x, lay.y, lay.w, lay.h);
    // Masks flood on their value (alpha) only; the colour channels of the alpha-stored mask are meaningless.
    const probe = layer.isMask ? maskProbe(img.data) : img.data;
    const res = floodFill(probe, lay.w, lay.h, cu - lay.x, cv - lay.y, ctx.fillTolerance);
    if (!res) return;
    const before = cropData(img.data, lay.w, res.rect);
    const after = before.slice();
    // selection coverage at crop pixel (x, y) of res.rect: sampled at the layer pixel's centre in document space
    const m = matOf(tf);
    const sel = this.host.doc.selection;
    const covAt = cov || !isAxis(tf) // rotated / skewed: the layer pixels in the bounding box can lie outside the canvas / selection
      ? (x: number, y: number): number => {
        const q = applyMat(m, lay.x + res.rect.x + x + 0.5, lay.y + res.rect.y + y + 0.5);
        const dx = Math.floor(q.x);
        const dy = Math.floor(q.y);
        if (!(dx >= 0 && dy >= 0 && dx < docW && dy < docH)) return 0;
        if (sel && !(dx >= sel.x && dy >= sel.y && dx < sel.x + sel.w && dy < sel.y + sel.h)) return 0;
        return cov ? cov[dy * docW + dx] : 255;
      }
      : null;
    if (layer.isMask) paintMaskValue(after, lay.w, res.rect, res.mask, luminance(ctx.primary.r, ctx.primary.g, ctx.primary.b), ctx.primary.a / 255, covAt);
    else paintCovered(after, lay.w, res.rect, res.mask, ctx.primary, covAt);
    const r = { x: lay.x + res.rect.x, y: lay.y + res.rect.y, w: res.rect.w, h: res.rect.h };
    const afterImg = new ImageData(after, r.w, r.h);
    layer.surface.ctx.putImageData(afterImg, r.x, r.y);
    this.host.paintChanged(layer, r);
    this.host.pushPatch('Fill', layer, [{ rect: r, before: new ImageData(before, r.w, r.h), after: afterImg }]);
  }
  move(): void {}
  up(): void {}
}

/** Replace pixels with `color` wherever `mask` is set, blended by the selection coverage (premultiplied lerp). */
function paintCovered(crop: Uint8ClampedArray, w: number, rect: Rect, mask: Uint8Array, color: RGBA, covAt: ((x: number, y: number) => number) | null): void {
  const ca = color.a / 255;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (!mask[(rect.y + y) * w + rect.x + x]) continue;
      const c = covAt ? covAt(x, y) / 255 : 1;
      if (c <= 0) continue;
      const i = (y * rect.w + x) * 4;
      if (c >= 1) {
        crop[i] = color.r; crop[i + 1] = color.g; crop[i + 2] = color.b; crop[i + 3] = color.a;
        continue;
      }
      const ba = crop[i + 3] / 255;
      const oa = ba * (1 - c) + ca * c;
      if (oa <= 0) { crop[i] = crop[i + 1] = crop[i + 2] = crop[i + 3] = 0; continue; }
      crop[i] = (crop[i] * ba * (1 - c) + color.r * ca * c) / oa;
      crop[i + 1] = (crop[i + 1] * ba * (1 - c) + color.g * ca * c) / oa;
      crop[i + 2] = (crop[i + 2] * ba * (1 - c) + color.b * ca * c) / oa;
      crop[i + 3] = oa * 255;
    }
  }
}

/** Greyscale probe of an alpha-stored mask: every channel = mask value. */
function maskProbe(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) out.fill(data[i + 3], i, i + 4);
  return out;
}

/** Set the mask value (lerp towards `value` by `amount`) wherever `mask` is set; `crop` is rgb=255/alpha storage. */
function paintMaskValue(crop: Uint8ClampedArray, w: number, rect: Rect, mask: Uint8Array, value: number, amount: number, covAt: ((x: number, y: number) => number) | null): void {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (!mask[(rect.y + y) * w + rect.x + x]) continue;
      const k = covAt ? (amount * covAt(x, y)) / 255 : amount;
      if (k <= 0) continue;
      const i = (y * rect.w + x) * 4;
      crop[i] = 255;
      crop[i + 1] = 255;
      crop[i + 2] = 255;
      crop[i + 3] = Math.round(crop[i + 3] * (1 - k) + value * k);
    }
  }
}

export class GradientTool implements Tool {
  private layer: EditTarget | null = null;
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
    this.tb = new TileBackup(this.layer);
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

  /**
   * The gradient is defined in document space (start / end are pointer positions) and drawn under the layer's
   * doc -> layer transform, so its iso-lines stay perpendicular to the drag on screen even for non-uniform scales.
   */
  private draw(): void {
    const layer = this.layer;
    const p = this.pending;
    this.pending = null;
    if (!layer || !p) return;
    const area = editableRegion(this.host, layer, { x: 0, y: 0, w: layer.surface.width, h: layer.surface.height });
    if (!area) return;
    const tf = layer.tf;
    const { primary: a, secondary: b } = this.host.context();
    restoreAndDraw(this.host, layer, this.tb as TileBackup, area, () => {
      if (p.x === this.sx && p.y === this.sy) return; // zero-length drag paints nothing
      const c = layer.surface.ctx;
      const sel = this.host.selectionCanvas();
      if (sel) {
        this.drawCovered(layer, sel, area, p);
        return;
      }
      if (layer.isMask) c.clearRect(area.x, area.y, area.w, area.h); // the gradient replaces the old mask
      const d = layerRectToDoc(tf, area);
      const inv = invMat(matOf(tf)); // document -> layer
      c.save();
      c.beginPath();
      c.rect(area.x, area.y, area.w, area.h); // rotated / skewed: the gradient's bounding box is larger than the area
      c.clip();
      c.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
      const g = c.createLinearGradient(this.sx, this.sy, p.x, p.y);
      this.stops(g, layer.isMask, a, b);
      c.fillStyle = g;
      c.fillRect(d.x, d.y, d.w, d.h);
      c.restore();
    });
    this.drew = true;
    this.host.paintChanged(layer, area);
  }

  private stops(g: CanvasGradient, isMask: boolean, a: RGBA, b: RGBA): void {
    if (isMask) {
      // Mask value from colour luminance (stored as white with alpha).
      g.addColorStop(0, `rgba(255,255,255,${luminance(a.r, a.g, a.b) / 255})`);
      g.addColorStop(1, `rgba(255,255,255,${luminance(b.r, b.g, b.b) / 255})`);
    } else {
      g.addColorStop(0, `rgba(${a.r},${a.g},${a.b},${a.a / 255})`);
      g.addColorStop(1, `rgba(${b.r},${b.g},${b.b},${b.a / 255})`);
    }
  }

  /** Gradient under a non-rect selection: render it in a window, multiply by the coverage, then merge into the layer. */
  private drawCovered(layer: EditTarget, sel: Surface, area: Rect, p: { x: number; y: number }): void {
    const { primary: a, secondary: b } = this.host.context();
    const tf = layer.tf;
    const t = this.host.tempWindow(area.w, area.h);
    const tc = t.ctx;
    tc.globalCompositeOperation = 'source-over';
    tc.clearRect(0, 0, area.w, area.h);
    drawCoverage(this.host, tc, sel, area, tf, 0, 0);
    tc.globalCompositeOperation = 'source-in';
    const inv = invMat(matOf(tf));
    tc.setTransform(inv.a, inv.b, inv.c, inv.d, inv.e - area.x, inv.f - area.y); // document -> window
    const g = tc.createLinearGradient(this.sx, this.sy, p.x, p.y);
    this.stops(g, layer.isMask, a, b);
    tc.fillStyle = g;
    const d = layerRectToDoc(tf, area);
    tc.fillRect(d.x, d.y, d.w, d.h);
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.globalCompositeOperation = 'source-over';
    const c = layer.surface.ctx;
    if (layer.isMask) {
      // mask = old * (1 - coverage) + gradient * coverage
      c.globalCompositeOperation = 'destination-out';
      drawCoverage(this.host, c, sel, area, tf, area.x, area.y);
      c.globalCompositeOperation = 'lighter';
    }
    c.drawImage(t.canvas as CanvasImageSource, 0, 0, area.w, area.h, area.x, area.y, area.w, area.h);
  }
}
