import type { Rect } from '../engine/types';
import type { View } from '../state/view';
import { HANDLES, handlePoint, centreOf } from '../state/transform';
import { boxCorners, handlePoints, centreOfBox } from '../state/affine';
import type { LayerTransform } from '../engine/types';

let checker: HTMLCanvasElement | null = null;

function checkerTile(): HTMLCanvasElement {
  if (!checker) {
    checker = document.createElement('canvas');
    checker.width = checker.height = 16;
    const c = checker.getContext('2d')!;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, 16, 16);
    c.fillStyle = '#cfcfcf';
    c.fillRect(0, 0, 8, 8);
    c.fillRect(8, 8, 8, 8);
  }
  return checker;
}

/** Pre-rendered background, drop shadow and checkerboard; rebuilt only when view, document or canvas size change. */
export class Backdrop {
  private canvas: HTMLCanvasElement | null = null;
  private key = '';
  builds = 0;

  draw(ctx: CanvasRenderingContext2D, vw: number, vh: number, view: View, docW: number, docH: number, hole = false): void {
    const t = ctx.getTransform();
    const key = [vw, vh, view.zoom, view.x, view.y, docW, docH, ctx.canvas.width, ctx.canvas.height, hole].join(',');
    if (!this.canvas || key !== this.key) {
      const c = this.canvas ?? document.createElement('canvas');
      c.width = ctx.canvas.width;
      c.height = ctx.canvas.height;
      const b = c.getContext('2d')!;
      b.setTransform(t);
      paintBackdrop(b, vw, vh, view, docW, docH, hole);
      this.canvas = c;
      this.key = key;
      this.builds++;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); // a transparent hole must not keep the last frame
    ctx.drawImage(this.canvas, 0, 0);
    ctx.restore();
  }
}

/** `hole`: TD-view in the panel. Surround and shadow are drawn, the document rect stays fully transparent. */
function paintBackdrop(ctx: CanvasRenderingContext2D, vw: number, vh: number, view: View, docW: number, docH: number, hole: boolean): void {
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(0, 0, vw, vh);
  const { zoom: z, x, y } = view;
  const w = docW * z, h = docH * z;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(vw, x + w), y1 = Math.min(vh, y + h);
  if (x1 <= x0 || y1 <= y0) return;
  if (hole) {
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.translate(x, y);
  ctx.fillStyle = ctx.createPattern(checkerTile(), 'repeat')!;
  ctx.fillRect(x0 - x, y0 - y, x1 - x0, y1 - y0);
  ctx.restore();
}

/** Draws the cached backdrop, then the composite. `ctx` is already scaled to CSS px. */
export function drawDocument(ctx: CanvasRenderingContext2D, backdrop: Backdrop, vw: number, vh: number, view: View, docW: number, docH: number, source: CanvasImageSource | null, hole = false): void {
  backdrop.draw(ctx, vw, vh, view, docW, docH, hole);
  if (!source || hole) return;
  const { zoom: z, x, y } = view;
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(vw, x + docW * z), y1 = Math.min(vh, y + docH * z);
  if (x1 <= x0 || y1 <= y0) return;
  const sx = Math.max(0, Math.floor((x0 - x) / z)), sy = Math.max(0, Math.floor((y0 - y) / z));
  const sx1 = Math.min(docW, Math.ceil((x1 - x) / z)), sy1 = Math.min(docH, Math.ceil((y1 - y) / z));
  ctx.imageSmoothingEnabled = z < 1;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(source, sx, sy, sx1 - sx, sy1 - sy, x + sx * z, y + sy * z, (sx1 - sx) * z, (sy1 - sy) * z);
}

export interface CursorShape { x: number; y: number; diameter: number; square: boolean }
export type Pt = { x: number; y: number };
export interface OverlayExtra {
  /** Outlines of the current selection (document px); drawn closed. Falls back to the bounding rect. */
  paths?: Pt[][] | null;
  /** In-progress lasso / shape outline (document px). */
  preview?: { paths: Pt[][]; closed: boolean } | null;
  /** v4: document guides (doc px); `skip` hides the guide being dragged, `drag` draws it at its dragged position. */
  guides?: { h: number[]; v: number[]; skip?: { axis: 'h' | 'v'; index: number } | null; drag?: { axis: 'h' | 'v'; pos: number } | null } | null;
  /** v4: the Move tool's transform box (doc px). */
  box?: Rect | null;
  /** v5: oriented (rotated / skewed) transform box of a pixel / input layer or a floating selection. */
  obox?: { t: LayerTransform; w: number; h: number; rotating?: { pointer: Pt; text: string } | null } | null;
  /** v5: crop box (doc px) with the dimmed outside and a rule-of-thirds grid. */
  crop?: Rect | null;
  /** v5: Quick Mask overlay: a doc-sized red canvas. */
  quickMask?: { src: CanvasImageSource; w: number; h: number } | null;
  /** v5: clone source marker (doc px). */
  clone?: Pt | null;
  /** Canvas size (doc px), needed by the crop dimming. */
  docW?: number; docH?: number;
  /** v4: snap feedback lines (doc px) while dragging. */
  snap?: { x: number | null; y: number | null } | null;
}

export const GUIDE_COLOR = '#18c8e0';
export const SNAP_COLOR = '#ff4fb0';
export const BOX_COLOR = '#4a8fe0';
export const HANDLE_SIZE = 8;

const px = (n: number) => Math.round(n) + 0.5;

function drawGuides(ctx: CanvasRenderingContext2D, vw: number, vh: number, view: View, g: NonNullable<OverlayExtra['guides']>): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.beginPath();
  g.h.forEach((pos, i) => {
    if (g.skip?.axis === 'h' && g.skip.index === i) return;
    const y = px(view.y + pos * view.zoom);
    ctx.moveTo(0, y); ctx.lineTo(vw, y);
  });
  g.v.forEach((pos, i) => {
    if (g.skip?.axis === 'v' && g.skip.index === i) return;
    const x = px(view.x + pos * view.zoom);
    ctx.moveTo(x, 0); ctx.lineTo(x, vh);
  });
  if (g.drag) {
    if (g.drag.axis === 'h') { const y = px(view.y + g.drag.pos * view.zoom); ctx.moveTo(0, y); ctx.lineTo(vw, y); }
    else { const x = px(view.x + g.drag.pos * view.zoom); ctx.moveTo(x, 0); ctx.lineTo(x, vh); }
  }
  ctx.stroke();
  ctx.restore();
}

function drawBox(ctx: CanvasRenderingContext2D, view: View, r: Rect): void {
  const x = view.x + r.x * view.zoom, y = view.y + r.y * view.zoom, w = r.w * view.zoom, h = r.h * view.zoom;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = BOX_COLOR;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  const s = { x: view.x, y: view.y, z: view.zoom };
  for (const hd of HANDLES) {
    const p = handlePoint(r, hd);
    const cx = s.x + p.x * s.z, cy = s.y + p.y * s.z;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(cx - HANDLE_SIZE / 2) + 0.5, Math.round(cy - HANDLE_SIZE / 2) + 0.5, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeRect(Math.round(cx - HANDLE_SIZE / 2) + 0.5, Math.round(cy - HANDLE_SIZE / 2) + 0.5, HANDLE_SIZE, HANDLE_SIZE);
  }
  const c = centreOf(r), ccx = s.x + c.x * s.z, ccy = s.y + c.y * s.z;
  ctx.beginPath();
  ctx.moveTo(ccx - 5, ccy); ctx.lineTo(ccx + 5, ccy); ctx.moveTo(ccx, ccy - 5); ctx.lineTo(ccx, ccy + 5);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3; ctx.stroke();
  ctx.strokeStyle = BOX_COLOR;
  ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function handleSquare(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number): void {
  ctx.save();
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.rotate(rot);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-HANDLE_SIZE / 2, -HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  ctx.strokeRect(-HANDLE_SIZE / 2 + 0.5, -HANDLE_SIZE / 2 + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
  ctx.restore();
}

/** The oriented box: the real (rotated / skewed) parallelogram with its handles, a pivot cross and the rotate read-out. */
function drawObox(ctx: CanvasRenderingContext2D, view: View, o: NonNullable<OverlayExtra['obox']>): void {
  const scr = (p: Pt): Pt => ({ x: view.x + p.x * view.zoom, y: view.y + p.y * view.zoom });
  const c = boxCorners(o.t, o.w, o.h).map(scr);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = BOX_COLOR;
  ctx.beginPath();
  c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  const hp = handlePoints(o.t, o.w, o.h);
  const rot = (o.t.rot || 0) * Math.PI / 180;
  for (const hd of HANDLES) { const p = scr(hp[hd]); handleSquare(ctx, p.x, p.y, rot); }
  const cc = scr(centreOfBox(o.t, o.w, o.h));
  ctx.beginPath();
  ctx.moveTo(cc.x - 5, cc.y); ctx.lineTo(cc.x + 5, cc.y); ctx.moveTo(cc.x, cc.y - 5); ctx.lineTo(cc.x, cc.y + 5);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3; ctx.stroke();
  ctx.strokeStyle = BOX_COLOR;
  ctx.lineWidth = 1; ctx.stroke();
  if (o.rotating) {
    const p = scr(o.rotating.pointer);
    ctx.beginPath(); ctx.moveTo(cc.x, cc.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.font = '11px sans-serif';
    const tw = ctx.measureText(o.rotating.text).width;
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.fillRect(p.x + 12, p.y + 8, tw + 10, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(o.rotating.text, p.x + 17, p.y + 21);
  }
  ctx.restore();
}

/** Crop: dim everything on the canvas outside the box, thirds guides, then the box and handles. */
function drawCrop(ctx: CanvasRenderingContext2D, view: View, r: Rect, docW: number, docH: number): void {
  const z = view.zoom;
  const X0 = view.x, Y0 = view.y, X1 = view.x + docW * z, Y1 = view.y + docH * z;
  const x0 = view.x + r.x * z, y0 = view.y + r.y * z, x1 = x0 + r.w * z, y1 = y0 + r.h * z;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(X0, Y0, X1 - X0, y0 - Y0);
  ctx.fillRect(X0, y1, X1 - X0, Y1 - y1);
  ctx.fillRect(X0, y0, x0 - X0, y1 - y0);
  ctx.fillRect(x1, y0, X1 - x1, y1 - y0);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  for (let i = 1; i <= 2; i++) {
    const gx = Math.round(x0 + ((x1 - x0) * i) / 3) + 0.5, gy = Math.round(y0 + ((y1 - y0) * i) / 3) + 0.5;
    ctx.moveTo(gx, y0); ctx.lineTo(gx, y1); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy);
  }
  ctx.stroke();
  ctx.restore();
  drawBox(ctx, view, r);
}

function drawCloneMarker(ctx: CanvasRenderingContext2D, view: View, p: Pt): void {
  const x = view.x + p.x * view.zoom, y = view.y + p.y * view.zoom;
  ctx.save();
  ctx.setLineDash([]);
  for (const [color, w] of [['#000000', 3], ['#ffffff', 1]] as const) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function drawSnap(ctx: CanvasRenderingContext2D, vw: number, vh: number, view: View, s: { x: number | null; y: number | null }): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = SNAP_COLOR;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  if (s.x !== null) { const x = px(view.x + s.x * view.zoom); ctx.moveTo(x, 0); ctx.lineTo(x, vh); }
  if (s.y !== null) { const y = px(view.y + s.y * view.zoom); ctx.moveTo(0, y); ctx.lineTo(vw, y); }
  ctx.stroke();
  ctx.restore();
}

function antPath(ctx: CanvasRenderingContext2D, view: View, paths: Pt[][], closed: boolean, dashOffset: number): void {
  const trace = () => {
    ctx.beginPath();
    for (const p of paths) {
      p.forEach((pt, i) => {
        const x = view.x + pt.x * view.zoom, y = view.y + pt.y * view.zoom;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (closed && p.length > 2) ctx.closePath();
    }
  };
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = '#000000';
  trace();
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -dashOffset;
  ctx.strokeStyle = '#ffffff';
  trace();
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawOverlay(ctx: CanvasRenderingContext2D, vw: number, vh: number, view: View, selection: Rect | null, dashOffset: number, cursor: CursorShape | null, extra: OverlayExtra = {}): void {
  ctx.clearRect(0, 0, vw, vh);
  if (extra.quickMask) {
    const q = extra.quickMask;
    ctx.save();
    ctx.imageSmoothingEnabled = view.zoom < 1;
    ctx.drawImage(q.src, view.x, view.y, q.w * view.zoom, q.h * view.zoom);
    ctx.restore();
  }
  if (extra.paths && extra.paths.length) {
    antPath(ctx, view, extra.paths, true, dashOffset);
  } else if (selection) {
    const x = Math.round(view.x + selection.x * view.zoom) + 0.5, y = Math.round(view.y + selection.y * view.zoom) + 0.5;
    const w = Math.round(selection.w * view.zoom), h = Math.round(selection.h * view.zoom);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -dashOffset;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
  if (extra.guides) drawGuides(ctx, vw, vh, view, extra.guides);
  if (extra.crop) drawCrop(ctx, view, extra.crop, extra.docW ?? 0, extra.docH ?? 0);
  if (extra.box) drawBox(ctx, view, extra.box);
  if (extra.obox) drawObox(ctx, view, extra.obox);
  if (extra.clone) drawCloneMarker(ctx, view, extra.clone);
  if (extra.snap && (extra.snap.x !== null || extra.snap.y !== null)) drawSnap(ctx, vw, vh, view, extra.snap);
  if (extra.preview) antPath(ctx, view, extra.preview.paths, extra.preview.closed, dashOffset);
  if (cursor) {
    const r = Math.max(2, cursor.diameter / 2);
    ctx.lineWidth = 1;
    for (const [color, grow] of [['rgba(0,0,0,0.6)', 1], ['#ffffff', 0]] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      if (cursor.square) ctx.rect(cursor.x - r - grow, cursor.y - r - grow, (r + grow) * 2, (r + grow) * 2);
      else ctx.arc(cursor.x, cursor.y, r + grow, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
