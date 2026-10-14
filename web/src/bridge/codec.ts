// Pure encode/decode of docs/PROTOCOL.md. No sockets here.

export const MAGIC = [0x52, 0x45, 0x46, 0x31]; // "REF1"
export const HEADER_BYTES = 24;
export const MAX_BAND_PAYLOAD = 2 * 1024 * 1024;
export const PROTOCOL_VERSION = 1;
export const FRAME_BASE = 1;
export const FRAME_COMPOSITE = 2;
export const FLAG_FRAME_END = 1;

export type FrameType = typeof FRAME_BASE | typeof FRAME_COMPOSITE;

export interface FrameHeader {
  type: FrameType;
  frameEnd: boolean;
  frameId: number;
  docW: number;
  docH: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame extends FrameHeader {
  payload: Uint8Array; // view into the received buffer, w*h*4 bytes
}

export type FrameError = 'too-short' | 'bad-magic' | 'bad-type' | 'bad-rect' | 'bad-length';
export type DecodedFrame = { ok: true; frame: Frame } | { ok: false; error: FrameError };

const U16 = 0xffff;

function checkHeader(h: FrameHeader): void {
  const fields = [h.docW, h.docH, h.x, h.y, h.w, h.h];
  if (!fields.every((n) => Number.isInteger(n) && n >= 0 && n <= U16)) throw new RangeError('frame field out of u16 range');
  if (h.w < 1 || h.h < 1 || h.x + h.w > h.docW || h.y + h.h > h.docH) throw new RangeError('frame rect outside document');
  if (h.type !== FRAME_BASE && h.type !== FRAME_COMPOSITE) throw new RangeError('bad frame type');
}

function writeHeader(view: DataView, bytes: Uint8Array, h: FrameHeader): void {
  bytes.set(MAGIC, 0);
  view.setUint8(4, h.type);
  view.setUint8(5, h.frameEnd ? FLAG_FRAME_END : 0);
  view.setUint16(6, 0, true);
  view.setUint32(8, h.frameId >>> 0, true);
  view.setUint16(12, h.docW, true);
  view.setUint16(14, h.docH, true);
  view.setUint16(16, h.x, true);
  view.setUint16(18, h.y, true);
  view.setUint16(20, h.w, true);
  view.setUint16(22, h.h, true);
}

/** One message: header + payload. Throws RangeError on an invalid header or payload length. */
export function encodeFrame(h: FrameHeader, payload: Uint8Array | Uint8ClampedArray): Uint8Array {
  checkHeader(h);
  if (payload.length !== h.w * h.h * 4) throw new RangeError('payload length != w*h*4');
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  writeHeader(new DataView(out.buffer), out, h);
  out.set(payload, HEADER_BYTES);
  return out;
}

export interface BandParams {
  type: FrameType;
  frameId: number;
  docW: number;
  docH: number;
  rect: { x: number; y: number; w: number; h: number };
  pixels: Uint8Array | Uint8ClampedArray; // rect.w*rect.h*4, tightly packed rows
  maxPayload?: number;
}

/** Split a rect into row bands of at most `maxPayload` bytes (default 2 MB); the last carries FRAME_END. */
export function* encodeBands(p: BandParams): Generator<Uint8Array> {
  const { rect } = p;
  const rowBytes = rect.w * 4;
  const max = p.maxPayload ?? MAX_BAND_PAYLOAD;
  if (rowBytes > max) throw new RangeError('a single row exceeds the band size');
  const base: FrameHeader = { type: p.type, frameEnd: false, frameId: p.frameId, docW: p.docW, docH: p.docH, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  checkHeader(base);
  if (p.pixels.length !== rowBytes * rect.h) throw new RangeError('pixels length != w*h*4');
  const rows = Math.floor(max / rowBytes);
  for (let row = 0; row < rect.h; row += rows) {
    const n = Math.min(rows, rect.h - row);
    yield encodeFrame(
      { ...base, y: rect.y + row, h: n, frameEnd: row + n >= rect.h },
      p.pixels.subarray(row * rowBytes, (row + n) * rowBytes),
    );
  }
}

export function decodeFrame(data: ArrayBuffer | ArrayBufferView): DecodedFrame {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  if (bytes.length < HEADER_BYTES) return { ok: false, error: 'too-short' };
  if (MAGIC.some((m, i) => bytes[i] !== m)) return { ok: false, error: 'bad-magic' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getUint8(4);
  if (type !== FRAME_BASE && type !== FRAME_COMPOSITE) return { ok: false, error: 'bad-type' };
  const frame: Frame = {
    type, frameEnd: (v.getUint8(5) & FLAG_FRAME_END) !== 0, frameId: v.getUint32(8, true),
    docW: v.getUint16(12, true), docH: v.getUint16(14, true),
    x: v.getUint16(16, true), y: v.getUint16(18, true), w: v.getUint16(20, true), h: v.getUint16(22, true),
    payload: bytes.subarray(HEADER_BYTES),
  };
  if (frame.w < 1 || frame.h < 1 || frame.x + frame.w > frame.docW || frame.y + frame.h > frame.docH) return { ok: false, error: 'bad-rect' };
  if (frame.payload.length !== frame.w * frame.h * 4) return { ok: false, error: 'bad-length' };
  return { ok: true, frame };
}

/** Frames from before a resize carry a different document size and are dropped silently. */
export function isStale(f: FrameHeader, docW: number, docH: number): boolean {
  return f.docW !== docW || f.docH !== docH;
}

// ---- JSON messages ----

export type WebMessage =
  | { t: 'ready'; protocol: number; client: 'panel' | 'external'; version: string }
  | { t: 'takeover' }
  | { t: 'requestBase' }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

export type TdMessage =
  | { t: 'hello'; protocol: number; doc: { w: number; h: number }; hasInput: boolean; maxSendFps: number; active: boolean }
  | { t: 'docSize'; w: number; h: number; hasInput: boolean }
  | { t: 'active'; active: boolean }
  | { t: 'error'; msg: string };

export function encodeMessage(m: WebMessage | TdMessage): string {
  return JSON.stringify(m);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= U16;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(text);
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse a TD → web message. Unknown types, unknown fields and malformed messages yield null / are dropped. */
export function decodeTdMessage(text: string): TdMessage | null {
  const o = parseObject(text);
  if (!o) return null;
  const doc = o.doc as Record<string, unknown> | undefined;
  switch (o.t) {
    case 'hello':
      return isNum(o.protocol) && doc && isSize(doc.w) && isSize(doc.h) && isBool(o.hasInput) && isNum(o.maxSendFps) && isBool(o.active)
        ? { t: 'hello', protocol: o.protocol, doc: { w: doc.w, h: doc.h }, hasInput: o.hasInput, maxSendFps: o.maxSendFps, active: o.active }
        : null;
    case 'docSize':
      return isSize(o.w) && isSize(o.h) && isBool(o.hasInput) ? { t: 'docSize', w: o.w, h: o.h, hasInput: o.hasInput } : null;
    case 'active':
      return isBool(o.active) ? { t: 'active', active: o.active } : null;
    case 'error':
      return isStr(o.msg) ? { t: 'error', msg: o.msg } : null;
    default:
      return null;
  }
}

/** Parse a web → TD message (used by TD-side fakes and tests). */
export function decodeWebMessage(text: string): WebMessage | null {
  const o = parseObject(text);
  if (!o) return null;
  switch (o.t) {
    case 'ready':
      return isNum(o.protocol) && (o.client === 'panel' || o.client === 'external') && isStr(o.version)
        ? { t: 'ready', protocol: o.protocol, client: o.client, version: o.version }
        : null;
    case 'takeover':
      return { t: 'takeover' };
    case 'requestBase':
      return { t: 'requestBase' };
    case 'log':
      return (o.level === 'info' || o.level === 'warn' || o.level === 'error') && isStr(o.msg) ? { t: 'log', level: o.level, msg: o.msg } : null;
    default:
      return null;
  }
}
