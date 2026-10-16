import { encodeViewExact, encodeViewFast, type ViewFastFrame } from '../../src/bridge/codec';
import { SOLID_ALPHA, SOLID_RGB } from './jpegs';

/** zlib (RFC 1950) deflate through CompressionStream - the same format TD sends and DecompressionStream('deflate') reads. Works in node and browsers. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  void w.write(bytes as Uint8Array<ArrayBuffer>).then(() => w.close());
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export function fastFrame(over: Partial<Omit<ViewFastFrame, 'kind'>> = {}, rgb = 'red', alpha: string | null = null): Uint8Array {
  return encodeViewFast({ frameId: 1, appliedFrameId: 0xffffffff, x: 0, y: 0, w: 64, h: 48, pw: 16, ph: 16, rgb: SOLID_RGB[rgb], alpha: alpha ? SOLID_ALPHA[alpha] : null, ...over });
}

export async function exactFull(docW: number, docH: number, rgba: Uint8Array, frameId = 1, applied = 0xffffffff): Promise<Uint8Array> {
  return encodeViewExact({ frameId, appliedFrameId: applied, docW, docH, full: true, tile: 64, nTiles: 0, body: await deflate(rgba) });
}

export interface TileSpec { tx: number; ty: number; w: number; h: number; rgba: Uint8Array }
/** tx / ty are tile indices (x 64 px). */
export async function exactTiles(docW: number, docH: number, tiles: TileSpec[], frameId = 2, applied = 0xffffffff): Promise<Uint8Array> {
  const idx = new Uint8Array(tiles.length * 8), dv = new DataView(idx.buffer);
  tiles.forEach((t, i) => { dv.setUint16(i * 8, t.tx, true); dv.setUint16(i * 8 + 2, t.ty, true); dv.setUint16(i * 8 + 4, t.w, true); dv.setUint16(i * 8 + 6, t.h, true); });
  const raw = new Uint8Array(idx.length + tiles.reduce((n, t) => n + t.rgba.length, 0));
  raw.set(idx);
  let o = idx.length;
  for (const t of tiles) { raw.set(t.rgba, o); o += t.rgba.length; }
  return encodeViewExact({ frameId, appliedFrameId: applied, docW, docH, full: false, tile: 64, nTiles: tiles.length, body: await deflate(raw) });
}

export const solid = (w: number, h: number, r: number, g: number, b: number, a = 255): Uint8Array => {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < o.length; i += 4) { o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = a; }
  return o;
};
