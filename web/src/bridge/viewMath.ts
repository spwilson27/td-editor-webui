import type { ViewportReport } from './codec';

export interface ViewXform { zoom: number; x: number; y: number } // x / y = the document origin inside the viewport (CSS px)

/**
 * v11: the part of the document that is on screen, in document px (whole pixels, rounded outwards), and the device pixels per document
 * pixel. null when nothing of the document is visible or the viewport has no size.
 */
export function visibleDocRect(view: ViewXform, vw: number, vh: number, docW: number, docH: number, dpr: number): ViewportReport | null {
  if (!(vw > 0 && vh > 0 && docW > 0 && docH > 0 && view.zoom > 0)) return null;
  const x0 = Math.max(0, Math.floor(-view.x / view.zoom)), y0 = Math.max(0, Math.floor(-view.y / view.zoom));
  const x1 = Math.min(docW, Math.ceil((vw - view.x) / view.zoom)), y1 = Math.min(docH, Math.ceil((vh - view.y) / view.zoom));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, scale: Math.round(view.zoom * (dpr > 0 ? dpr : 1) * 1e4) / 1e4 };
}

export const sameViewport = (a: ViewportReport | null, b: ViewportReport | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.scale === b.scale);

/** u32 `a` is at least as new as `b`. */
export { frameGeq } from './codec';
