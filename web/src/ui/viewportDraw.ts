import type { Rect } from '../engine/types';
import type { View } from '../state/view';
import { HANDLES, handlePoint, centreOf } from '../state/transform';

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
  if (extra.box) drawBox(ctx, view, extra.box);
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
