import { Engine } from '../../src/engine';
import type { BrushSettings, EngineEvent, Rect, RGBA, ToolContext, ToolId, ToolPointer } from '../../src/engine/types';
import type { PixelLayer } from '../../src/engine/model';

export type Px = [number, number, number, number];

export const perfEnabled = ((import.meta.env as Record<string, string | undefined>).PERF
  ?? (import.meta.env as Record<string, string | undefined>).VITE_PERF) !== '0';

export const rgba = (r: number, g: number, b: number, a = 255): RGBA => ({ r, g, b, a });

export function ptr(x: number, y: number, o: Partial<ToolPointer> = {}): ToolPointer {
  return { x, y, pressure: 1, shift: false, alt: false, ctrl: false, ...o };
}

export function newEngine(w = 100, h = 100): Engine {
  return new Engine(w, h);
}

export function px(e: Engine, x: number, y: number): Px {
  const d = e.readComposite({ x, y, w: 1, h: 1 });
  return [d[0], d[1], d[2], d[3]];
}

/** Pixel of one layer's own surface (not the composite). */
export function layerPx(e: Engine, id: string, x: number, y: number): Px {
  const l = e.doc.find(id) as PixelLayer;
  const d = l.surface.ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

export function solid(w: number, h: number, c: Px): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i += 4) a.set(c, i);
  return a;
}

export function setBase(e: Engine, c: Px): void {
  e.writeBase({ x: 0, y: 0, w: e.width, h: e.height }, solid(e.width, e.height, c));
  e.commitBase();
}

/** Fill a rect of a layer's surface directly (test setup). */
export function drawRect(e: Engine, id: string, r: Rect, css: string): void {
  const l = e.doc.find(id) as PixelLayer;
  l.surface.ctx.fillStyle = css;
  l.surface.ctx.fillRect(r.x, r.y, r.w, r.h);
  e.changed({ x: r.x + l.x, y: r.y + l.y, w: r.w, h: r.h });
}

export function brushCtx(over: Partial<BrushSettings> = {}, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    primary: rgba(0, 0, 0), secondary: rgba(255, 255, 255), fillTolerance: 0, ...extra,
    brush: { size: 10, opacity: 1, flow: 1, hardness: 1, spacing: 0.15, ...over },
  };
}

export function stroke(e: Engine, tool: ToolId, pts: [number, number][], o: Partial<ToolPointer> = {}): void {
  e.setTool(tool);
  e.pointerDown(ptr(pts[0][0], pts[0][1], o));
  for (const [x, y] of pts.slice(1)) e.pointerMove(ptr(x, y, o));
  const last = pts[pts.length - 1];
  e.pointerUp(ptr(last[0], last[1], o));
}

export function collect(e: Engine): EngineEvent[] {
  const out: EngineEvent[] = [];
  e.on((ev) => out.push(ev));
  return out;
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function near(a: ArrayLike<number>, b: ArrayLike<number>, tol = 2): boolean {
  return a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]) <= tol);
}

/** Grey value (r channel) of a mask slot at one pixel. */
export function maskAt(e: Engine, slot: number, x: number, y: number): number {
  return e.readSurface(slot, { x, y, w: 1, h: 1 })[0];
}

/** Straight RGBA of a surface slot at one pixel. */
export function slotPx(e: Engine, slot: number, x: number, y: number): Px {
  const d = e.readSurface(slot, { x, y, w: 1, h: 1 });
  return [d[0], d[1], d[2], d[3]];
}

/** A pixel layer filled with a solid colour (whole document), made active. */
export function solidLayer(e: Engine, css: string, name?: string): string {
  const id = e.addPixelLayer(name);
  drawRect(e, id, { x: 0, y: 0, w: e.width, h: e.height }, css);
  return id;
}

export function slotOf(e: Engine, id: string): number {
  return e.layers().find((l) => l.id === id)?.slot as number;
}
