import type { DodgeBurnRange, Rect, ToolPointer } from '../types';
import type { EditTarget } from '../model';
import { createSurface, releaseSurface, type Ctx2D, type Surface } from '../surface';
import { union } from '../rect';
import { invMat, layerRectToDoc, matOf, mulMat, toLayer, type Mat } from '../xform';
import { TileBackup } from '../tiles';
import { clipEditable, commitPatches, drawCoverage, editableRegion, renderTip, type Tip } from './paint';
import type { Host, Tool } from './host';

export interface RetouchOptions {
  strength: number; // 0..1 (smudge, blur / sharpen)
  sharpen: boolean; // blur tool: sharpen instead of blur
  burn: boolean; // dodge tool: burn instead of dodge
  range: DodgeBurnRange;
  exposure: number; // 0..1
}
export const DEFAULT_RETOUCH: RetouchOptions = { strength: 0.5, sharpen: false, burn: false, range: 'midtones', exposure: 0.5 };

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Weight of a tonal range at luminance l (0..1): shadows fade out above ~0.5, highlights fade in from ~0.5, midtones peak at 0.5. */
export function rangeWeight(range: DodgeBurnRange, l: number): number {
  if (range === 'shadows') return 1 - smooth(0.25, 0.6, l);
  if (range === 'highlights') return smooth(0.4, 0.75, l);
  return 1 - smooth(0.0, 0.5, Math.abs(l - 0.5));
}

/** Dodge / burn amount applied per dab (times exposure): dabs overlap by 1 / spacing, so one dab must be gentle. */
export const DODGE_STEP = 0.08;

/** One window of straight-RGBA pixels per dab, F-sized: P = f(S). Mutates `d` (ImageData of the source) into the result. */
export function dodgeBurn(d: Uint8ClampedArray, burn: boolean, range: DodgeBurnRange, exposure: number, isMask: boolean): void {
  const amt = Math.min(1, Math.max(0, exposure)) * DODGE_STEP;
  for (let i = 0; i < d.length; i += 4) {
    if (isMask) {
      const a = d[i + 3];
      const w = rangeWeight(range, a / 255) * amt;
      d[i + 3] = burn ? a * (1 - w) : a + (255 - a) * w;
      continue;
    }
    if (d[i + 3] === 0) continue;
    const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const w = rangeWeight(range, l) * amt;
    if (burn) {
      d[i] *= 1 - w;
      d[i + 1] *= 1 - w;
      d[i + 2] *= 1 - w;
    } else {
      d[i] += (255 - d[i]) * w;
      d[i + 1] += (255 - d[i + 1]) * w;
      d[i + 2] += (255 - d[i + 2]) * w;
    }
  }
}

const K5 = [1, 4, 6, 4, 1];

/** Blur (5-tap binomial, separable, premultiplied; edges clamp) of straight RGBA `d` into a new array; `sharpen`: out = src + (src - blur). */
export function blurOrSharpen(d: Uint8ClampedArray, w: number, h: number, sharpen: boolean): Uint8ClampedArray {
  const n = w * h;
  const pm = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    pm[i * 4] = d[i * 4] * a;
    pm[i * 4 + 1] = d[i * 4 + 1] * a;
    pm[i * 4 + 2] = d[i * 4 + 2] * a;
    pm[i * 4 + 3] = d[i * 4 + 3];
  }
  const tmp = new Float32Array(n * 4);
  const bl = new Float32Array(n * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = -2; k <= 2; k++) acc += K5[k + 2] * pm[(y * w + Math.min(w - 1, Math.max(0, x + k))) * 4 + c];
        tmp[(y * w + x) * 4 + c] = acc / 16;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = -2; k <= 2; k++) acc += K5[k + 2] * tmp[(Math.min(h - 1, Math.max(0, y + k)) * w + x) * 4 + c];
        bl[(y * w + x) * 4 + c] = acc / 16;
      }
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a0 = pm[o + 3];
    const a1 = sharpen ? Math.min(255, Math.max(0, a0 + (a0 - bl[o + 3]))) : bl[o + 3];
    if (a1 <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const p = sharpen ? pm[o + c] + (pm[o + c] - bl[o + c]) : bl[o + c]; // premultiplied
      out[o + c] = (Math.min(a1, Math.max(0, p)) * 255) / a1;
    }
    out[o + 3] = a1;
  }
  return out;
}

function grown(s: Surface | null, w: number, h: number): Surface {
  if (s && s.width >= w && s.height >= h) return s;
  if (s) releaseSurface(s);
  return createSurface(Math.ceil(Math.max(w, 64) / 64) * 64, Math.ceil(Math.max(h, 64) / 64) * 64, true);
}

export type RetouchKind = 'clone' | 'smudge' | 'blur' | 'dodge';

/**
 * Shared machinery of the retouch brushes (clone, smudge, blur / sharpen, dodge / burn). Dab based like the paint brush:
 * dabs are placed along the stroke by the brush spacing, in the edited surface's pixel space (the tip is the exact affine
 * footprint of the document-space circle, see renderTip). For every dab
 *   M = tip shape * opacity (* selection coverage)      what fraction of the pixel is replaced
 *   P = the tool's idea of what the pixels should become (clone: the source, smudge: the carried colour, ...)
 *   layer = layer * (1 - M) + P * M                    (premultiplied)
 * Edits are in place (a dab sees the previous ones), tiles are saved lazily for undo, and everything is clipped to the
 * selection and to what is visible in the canvas.
 */
abstract class DabTool implements Tool {
  protected layer: EditTarget | null = null;
  protected tb: TileBackup | null = null;
  protected tip: Tip = { drawW: 0, drawH: 0, stampW: 0, stampH: 0 };
  private winM: Surface | null = null;
  protected winS: Surface | null = null;
  protected winP: Surface | null = null;
  private lx = 0;
  private ly = 0;
  private toNext = 0;
  private acc: Rect | null = null;
  protected drew = false;

  constructor(protected host: Host, protected label: string) {}

  protected abstract begin(p: ToolPointer): boolean; // false = do not stroke
  /** Fill winP (F-sized, straight pixel semantics of a canvas) with P for the footprint F; winS holds the layer's pixels there. */
  protected abstract paintSource(F: Rect, u: number, v: number, first: boolean): boolean;
  protected abstract alpha(): number;
  protected end(): void {}

  protected map(x: number, y: number): { u: number; v: number } {
    const p = toLayer((this.layer as EditTarget).tf, x, y);
    return { u: p.x, v: p.y };
  }

  down(p: ToolPointer): void {
    this.layer = this.host.editableLayer();
    if (!this.layer) return;
    this.drew = false;
    this.acc = null;
    if (!this.begin(p)) {
      this.layer = null;
      return;
    }
    this.tb = new TileBackup(this.layer);
    const { size, hardness } = this.host.context().brush;
    this.tip = renderTip(this.host.scratch.stamp, this.layer.tf, size, hardness, 'rgb(255,255,255)');
    this.lx = p.x;
    this.ly = p.y;
    this.toNext = this.step();
    const { u, v } = this.map(p.x, p.y);
    this.dab(u, v, true);
    this.flush();
  }

  move(p: ToolPointer): void {
    if (!this.layer) return;
    const dist = Math.hypot(p.x - this.lx, p.y - this.ly);
    const step = this.step();
    let pos = this.toNext;
    while (pos <= dist) {
      const t = pos / dist;
      const { u, v } = this.map(this.lx + (p.x - this.lx) * t, this.ly + (p.y - this.ly) * t);
      this.dab(u, v, false);
      pos += step;
    }
    this.toNext = pos - dist;
    this.lx = p.x;
    this.ly = p.y;
    this.flush();
  }

  up(p: ToolPointer): void {
    if (!this.layer) return;
    this.move(p);
    const layer = this.layer;
    const tb = this.tb as TileBackup;
    this.layer = null;
    this.tb = null;
    this.end();
    for (const w of [this.winM, this.winS, this.winP]) if (w) releaseSurface(w);
    this.winM = this.winS = this.winP = null;
    commitPatches(this.host, layer, tb, this.label);
  }

  private step(): number {
    const b = this.host.context().brush;
    return Math.max(1, b.spacing * Math.max(1, b.size));
  }

  private flush(): void {
    const r = this.acc;
    this.acc = null;
    if (r && this.layer) this.host.paintChanged(this.layer, r);
  }

  private dab(u: number, v: number, first: boolean): void {
    const layer = this.layer as EditTarget;
    const { drawW, drawH } = this.tip;
    const F: Rect = { x: Math.floor(u - drawW / 2) - 1, y: Math.floor(v - drawH / 2) - 1, w: drawW + 3, h: drawH + 3 };
    const region = editableRegion(this.host, layer, F);
    if (!region) return;
    this.winM = grown(this.winM, F.w, F.h);
    this.winS = grown(this.winS, F.w, F.h);
    this.winP = grown(this.winP, F.w, F.h);
    const M = this.winM;
    const S = this.winS;
    const P = this.winP;
    // M: tip shape * alpha * selection coverage
    const mc = M.ctx;
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.globalCompositeOperation = 'source-over';
    mc.globalAlpha = 1;
    mc.clearRect(0, 0, F.w, F.h);
    mc.globalAlpha = this.alpha();
    mc.drawImage(this.host.scratch.stamp.canvas as CanvasImageSource, 0, 0, this.tip.stampW, this.tip.stampH, u - drawW / 2 - F.x, v - drawH / 2 - F.y, drawW, drawH);
    mc.globalAlpha = 1;
    const sel = this.host.selectionCanvas();
    if (sel) {
      mc.globalCompositeOperation = 'destination-in';
      drawCoverage(this.host, mc, sel, F, layer.tf, 0, 0);
      mc.globalCompositeOperation = 'source-over';
    }
    // S: the layer's pixels under the footprint
    S.ctx.setTransform(1, 0, 0, 1, 0, 0);
    S.ctx.globalCompositeOperation = 'copy';
    S.ctx.globalAlpha = 1;
    S.ctx.drawImage(layer.surface.canvas as CanvasImageSource, F.x, F.y, F.w, F.h, 0, 0, F.w, F.h);
    S.ctx.globalCompositeOperation = 'source-over';
    P.ctx.setTransform(1, 0, 0, 1, 0, 0);
    P.ctx.globalCompositeOperation = 'source-over';
    P.ctx.globalAlpha = 1;
    P.ctx.clearRect(0, 0, P.width, P.height);
    if (!this.paintSource(F, u, v, first)) return;
    P.ctx.globalCompositeOperation = 'destination-in';
    P.ctx.drawImage(M.canvas as CanvasImageSource, 0, 0, F.w, F.h, 0, 0, F.w, F.h);
    P.ctx.globalCompositeOperation = 'source-over';
    // layer = layer * (1 - M) + P * M
    (this.tb as TileBackup).cover(region);
    const c = layer.surface.ctx as Ctx2D;
    c.save();
    clipEditable(this.host, layer, c);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'destination-out';
    c.drawImage(M.canvas as CanvasImageSource, region.x - F.x, region.y - F.y, region.w, region.h, region.x, region.y, region.w, region.h);
    c.globalCompositeOperation = 'lighter';
    c.drawImage(P.canvas as CanvasImageSource, region.x - F.x, region.y - F.y, region.w, region.h, region.x, region.y, region.w, region.h);
    c.restore();
    this.acc = union(this.acc, region);
    this.drew = true;
  }

  /** Read the straight RGBA pixels of winS (F-sized). */
  protected readS(F: Rect): ImageData {
    return (this.winS as Surface).ctx.getImageData(0, 0, F.w, F.h);
  }
  /** Replace winP with straight RGBA pixels (F-sized). */
  protected writeP(F: Rect, data: Uint8ClampedArray): void {
    (this.winP as Surface).ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, F.w, F.h), 0, 0);
  }
}

/**
 * Clone stamp. Alt-click sets the source point. The source is sampled at (dab position + offset) in document space where
 * offset = source - first dab position of the stroke; `aligned` keeps that offset across strokes (set by the first stroke
 * after the Alt-click), non-aligned restarts from the source point at every stroke. The source is the edited surface itself or
 * (sampleAll) the visible composite. Offsets are whole document pixels (a 1:1 layer is copied exactly).
 */
export class CloneTool extends DabTool {
  private src: { x: number; y: number } | null = null;
  private off: { x: number; y: number } | null = null;
  private cur: { x: number; y: number } | null = null;

  constructor(host: Host, private opts: () => { aligned: boolean; sampleAll: boolean }) {
    super(host, 'Clone');
  }

  /** The point being sampled now (while stroking) or the Alt-click point. */
  sourcePoint(): { x: number; y: number } | null {
    return this.cur ?? this.src;
  }

  down(p: ToolPointer): void {
    if (p.alt) {
      this.src = { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 };
      this.off = null;
      this.cur = null;
      this.host.emit({ type: 'notice', message: 'Clone source set' });
      return;
    }
    super.down(p);
  }

  move(p: ToolPointer): void {
    super.move(p);
    if (this.off && this.layer) this.cur = { x: p.x + this.off.x, y: p.y + this.off.y };
  }

  up(p: ToolPointer): void {
    super.up(p);
    this.cur = null;
  }

  protected begin(p: ToolPointer): boolean {
    if (!this.src) {
      this.host.emit({ type: 'notice', message: 'Alt-click to set the clone source' });
      return false;
    }
    if (!this.opts().aligned || !this.off) this.off = { x: Math.round(this.src.x - p.x), y: Math.round(this.src.y - p.y) };
    this.cur = { x: p.x + this.off.x, y: p.y + this.off.y };
    return true;
  }

  protected alpha(): number {
    const b = this.host.context().brush;
    return b.opacity * b.flow;
  }

  protected paintSource(F: Rect): boolean {
    const layer = this.layer as EditTarget;
    const off = this.off as { x: number; y: number };
    const P = this.winP as Surface;
    const c = P.ctx;
    const m = matOf(layer.tf);
    const inv = invMat(m);
    if (this.opts().sampleAll && !layer.isMask) {
      const area = layerRectToDoc(layer.tf, F);
      const sx = Math.max(0, Math.floor(area.x + off.x) - 2);
      const sy = Math.max(0, Math.floor(area.y + off.y) - 2);
      const ex = Math.min(this.host.doc.width, Math.ceil(area.x + area.w + off.x) + 2);
      const ey = Math.min(this.host.doc.height, Math.ceil(area.y + area.h + off.y) + 2);
      if (ex <= sx || ey <= sy) return true; // source entirely outside the canvas: transparent
      const comp = this.host.compositeCanvas({ x: sx, y: sy, w: ex - sx, h: ey - sy });
      // composite point D appears at window pixel inv(D - off) - F
      const X: Mat = mulMat({ a: 1, b: 0, c: 0, d: 1, e: -F.x, f: -F.y }, mulMat(inv, { a: 1, b: 0, c: 0, d: 1, e: -off.x, f: -off.y }));
      c.save();
      c.imageSmoothingEnabled = true;
      c.transform(X.a, X.b, X.c, X.d, X.e, X.f);
      c.drawImage(comp, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
      c.restore();
      return true;
    }
    // same surface: layer pixel U is sampled at U + inv.lin * off
    const dU = { x: inv.a * off.x + inv.c * off.y, y: inv.b * off.x + inv.d * off.y };
    c.imageSmoothingEnabled = !(Number.isInteger(dU.x) && Number.isInteger(dU.y));
    c.imageSmoothingQuality = 'medium';
    c.drawImage(layer.surface.canvas as CanvasImageSource, F.x + dU.x, F.y + dU.y, F.w, F.h, 0, 0, F.w, F.h);
    c.imageSmoothingEnabled = true;
    return true;
  }
}

/**
 * Smudge: a finger buffer (the pixels under the tip) travels with the brush. At every dab
 *   carried = lerp(pixels here, finger, strength);  layer = lerp(layer, carried, tip shape);  finger = carried
 * so strength 0 changes nothing and strength 1 drags the colour picked up at the start along the whole stroke.
 */
export class SmudgeTool extends DabTool {
  private finger: Surface | null = null;

  constructor(host: Host, private opts: () => { strength: number }) {
    super(host, 'Smudge');
  }

  protected begin(): boolean { return true; }
  protected alpha(): number { return this.host.context().brush.opacity; }

  protected paintSource(F: Rect, _u: number, _v: number, first: boolean): boolean {
    const S = this.winS as Surface;
    const P = this.winP as Surface;
    if (!this.finger || this.finger.width < F.w || this.finger.height < F.h) {
      const old = this.finger;
      this.finger = grown(null, F.w, F.h);
      if (old) releaseSurface(old);
      first = true;
    }
    const f = this.finger;
    if (first) {
      f.ctx.setTransform(1, 0, 0, 1, 0, 0);
      f.ctx.globalCompositeOperation = 'copy';
      f.ctx.drawImage(S.canvas as CanvasImageSource, 0, 0, F.w, F.h, 0, 0, F.w, F.h);
      f.ctx.globalCompositeOperation = 'source-over';
    }
    const k = Math.min(1, Math.max(0, this.opts().strength));
    const c = P.ctx;
    c.globalAlpha = 1 - k;
    c.drawImage(S.canvas as CanvasImageSource, 0, 0, F.w, F.h, 0, 0, F.w, F.h);
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = k;
    c.drawImage(f.canvas as CanvasImageSource, 0, 0, F.w, F.h, 0, 0, F.w, F.h);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    // the carried colour becomes the new finger (before it is masked)
    f.ctx.globalCompositeOperation = 'copy';
    f.ctx.drawImage(P.canvas as CanvasImageSource, 0, 0, F.w, F.h, 0, 0, F.w, F.h);
    f.ctx.globalCompositeOperation = 'source-over';
    return true;
  }

  protected end(): void {
    if (this.finger) releaseSurface(this.finger);
    this.finger = null;
  }
}

/** Blur / sharpen brush: every dab replaces the pixels by their blurred (or unsharp-masked) version, weighted by tip shape * strength. */
export class BlurTool extends DabTool {
  constructor(host: Host, private opts: () => RetouchOptions) {
    super(host, 'Blur');
  }

  protected begin(): boolean {
    this.label = this.opts().sharpen ? 'Sharpen' : 'Blur';
    return true;
  }
  protected alpha(): number { return this.host.context().brush.opacity * this.opts().strength; }

  protected paintSource(F: Rect): boolean {
    const img = this.readS(F);
    this.writeP(F, blurOrSharpen(img.data, F.w, F.h, this.opts().sharpen));
    return true;
  }
}

/** Dodge (lighten) / burn (darken) brush, limited to a tonal range, `exposure` strong. */
export class DodgeTool extends DabTool {
  constructor(host: Host, private opts: () => RetouchOptions) {
    super(host, 'Dodge');
  }

  protected begin(): boolean {
    this.label = this.opts().burn ? 'Burn' : 'Dodge';
    return true;
  }
  protected alpha(): number {
    const b = this.host.context().brush;
    return b.opacity * b.flow;
  }

  protected paintSource(F: Rect): boolean {
    const o = this.opts();
    const img = this.readS(F);
    dodgeBurn(img.data, o.burn, o.range, o.exposure, (this.layer as EditTarget).isMask);
    this.writeP(F, img.data);
    return true;
  }
}
