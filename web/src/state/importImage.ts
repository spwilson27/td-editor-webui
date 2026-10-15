export interface DecodedImage { rgba: Uint8ClampedArray; w: number; h: number }

/** Decode an image blob to straight RGBA8 (top-left origin) through createImageBitmap and a canvas. */
export async function decodeImage(blob: Blob): Promise<DecodedImage> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  try {
    const w = bmp.width, h = bmp.height;
    if (!w || !h) throw new Error('empty image');
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
  } finally {
    bmp.close();
  }
}

/** Image files out of a DataTransfer / clipboard event. */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) out.push(f);
  return out;
}

/** True when a drag carries files (dragover cannot read their types reliably). */
export const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes('Files');
