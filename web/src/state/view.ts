export interface View { zoom: number; x: number; y: number } // screen = doc * zoom + (x, y), CSS px

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 32;
export const FIT_PADDING = 32;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function fitView(docW: number, docH: number, vw: number, vh: number, pad = FIT_PADDING): View {
  const zoom = clampZoom(Math.min((vw - pad * 2) / docW, (vh - pad * 2) / docH));
  return { zoom, x: (vw - docW * zoom) / 2, y: (vh - docH * zoom) / 2 };
}

export function zoomAbout(v: View, zoom: number, ax: number, ay: number): View {
  const z = clampZoom(zoom);
  const k = z / v.zoom;
  return { zoom: z, x: ax - (ax - v.x) * k, y: ay - (ay - v.y) * k };
}

export const screenToDoc = (v: View, sx: number, sy: number) => ({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom });

/** "66.7%" like the mockup: one decimal only when not a whole number. */
export function formatZoom(z: number): string {
  const p = Math.round(z * 1000) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}
