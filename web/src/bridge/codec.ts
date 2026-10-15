// Pure encode/decode of docs/PROTOCOL.md (version 6). No sockets here.
import type { CanvasMode, Guides, LayerSpec } from '../engine/types';
import type { FileOp, FileResult } from '../state/filesSlice';
import type { InputItem } from '../state/inputsSlice';

export const MAGIC = [0x52, 0x45, 0x46, 0x31]; // "REF1"
export const HEADER_BYTES = 24;
export const MAX_BAND_PAYLOAD = 2 * 1024 * 1024;
export const PROTOCOL_VERSION = 6;
export const FRAME_BASE = 1;
export const FRAME_SURFACE = 3;
export const FRAME_SURFACE_DUMP = 4;
export const FRAME_VIEW = 5;
export const FRAME_TOP = 6; // v4: TD → web, GET /top (a TOP snapshot; docW/docH = the TOP's own size)
export const FLAG_FRAME_END = 1;

export type FrameType = typeof FRAME_BASE | typeof FRAME_SURFACE | typeof FRAME_SURFACE_DUMP | typeof FRAME_VIEW | typeof FRAME_TOP;
const VALID_TYPES: readonly number[] = [FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_VIEW, FRAME_TOP];

export interface FrameHeader {
  type: FrameType;
  frameEnd: boolean;
  slot: number; // surface slot (SURFACE / SURFACE_DUMP); v6: the input index 1..8 (BASE); 0 otherwise
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

export type FrameError = 'too-short' | 'bad-magic' | 'bad-type' | 'bad-rect' | 'bad-length' | 'bad-slot';
export type DecodedFrame = { ok: true; frame: Frame } | { ok: false; error: FrameError };

const U16 = 0xffff;

function checkHeader(h: FrameHeader): void {
  const fields = [h.slot, h.docW, h.docH, h.x, h.y, h.w, h.h];
  if (!fields.every((n) => Number.isInteger(n) && n >= 0 && n <= U16)) throw new RangeError('frame field out of u16 range');
  if (h.w < 1 || h.h < 1 || h.x + h.w > h.docW || h.y + h.h > h.docH) throw new RangeError('frame rect outside document');
  if (!VALID_TYPES.includes(h.type)) throw new RangeError('bad frame type');
  if (h.type === FRAME_BASE && !(h.slot >= 1 && h.slot <= 8)) throw new RangeError('BASE slot (input index) must be 1..8');
}

function writeHeader(view: DataView, bytes: Uint8Array, h: FrameHeader): void {
  bytes.set(MAGIC, 0);
  view.setUint8(4, h.type);
  view.setUint8(5, h.frameEnd ? FLAG_FRAME_END : 0);
  view.setUint16(6, h.slot, true);
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
  slot?: number;
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
  const base: FrameHeader = { type: p.type, frameEnd: false, slot: p.slot ?? 0, frameId: p.frameId, docW: p.docW, docH: p.docH, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
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
  if (!VALID_TYPES.includes(type)) return { ok: false, error: 'bad-type' };
  if (type === FRAME_BASE) { const slot = v.getUint16(6, true); if (slot < 1 || slot > 8) return { ok: false, error: 'bad-slot' }; } // v6: BASE slot = input index
  const frame: Frame = {
    type: type as FrameType, frameEnd: (v.getUint8(5) & FLAG_FRAME_END) !== 0, slot: v.getUint16(6, true), frameId: v.getUint32(8, true),
    docW: v.getUint16(12, true), docH: v.getUint16(14, true),
    x: v.getUint16(16, true), y: v.getUint16(18, true), w: v.getUint16(20, true), h: v.getUint16(22, true),
    payload: bytes.subarray(HEADER_BYTES),
  };
  if (frame.w < 1 || frame.h < 1 || frame.x + frame.w > frame.docW || frame.y + frame.h > frame.docH) return { ok: false, error: 'bad-rect' };
  if (frame.payload.length !== frame.w * frame.h * 4) return { ok: false, error: 'bad-length' };
  return { ok: true, frame };
}

/** v5: `docW/docH` are the SURFACE size of the slot (BASE: the input size). Frames from before a surface resize carry another size and are dropped silently. */
export function isStale(f: FrameHeader, docW: number, docH: number): boolean {
  return f.docW !== docW || f.docH !== docH;
}

// ---- JSON messages ----

export type ClientKind = 'panel' | 'external';
export type ChoosePurpose = 'placeImage' | 'saveProject' | 'openProject' | 'exportPng';
const PURPOSES: readonly string[] = ['placeImage', 'saveProject', 'openProject', 'exportPng'];
export type ViewMode = 'local' | 'td';
export type LogLevel = 'info' | 'warn' | 'error';

export interface ViewRect { x: number; y: number; w: number; h: number }

export type WebMessage =
  | { t: 'ready'; protocol: number; client: ClientKind; version: string; token: string; fresh: boolean }
  | { t: 'doc'; rev: number; layers: LayerSpec[]; guides: Guides; canvas: { mode: CanvasMode } }
  | { t: 'requestDoc' }
  | { t: 'view'; mode: ViewMode; zoom: number; panX: number; panY: number; rect: ViewRect }
  | { t: 'takeover' }
  | { t: 'requestBase' }
  | { t: 'listTops'; requestId: string }
  | { t: 'importTop'; requestId: string; path: string }
  | { t: 'setCanvas'; w: number; h: number; mode: CanvasMode } // v5
  | { t: 'renderLayer'; requestId: string; layerId: string } // v5: Flatten
  | { t: 'saveProject'; requestId: string; path?: string } // v6
  | { t: 'openProject'; requestId: string; path?: string }
  | { t: 'exportPng'; requestId: string; path?: string }
  | { t: 'chooseFile'; requestId: string; purpose: ChoosePurpose } // v6: TD shows a file chooser (panel clients have no file input)
  | { t: 'log'; level: LogLevel; msg: string };

export type TdMessage =
  | { t: 'hello'; protocol: number; doc: { w: number; h: number; mode?: CanvasMode }; hasInput: boolean; maxSendFps: number; active: boolean; clientId: string; hasDocument: boolean; rev: number | null; inputs?: InputItem[] }
  | { t: 'docState'; rev: number; layers: LayerSpec[]; docW: number; docH: number; guides: Guides; canvas: { mode: CanvasMode } }
  | { t: 'base'; frameId: number; input: number; docW: number; docH: number; x: number; y: number; w: number; h: number }
  | { t: 'view'; frameId: number; docW: number; docH: number; w: number; h: number; appliedFrameId: number }
  | { t: 'applied'; frameId: number; tdFrame: number }
  | { t: 'docSize'; w: number; h: number; hasInput: boolean; mode: CanvasMode }
  | { t: 'inputs'; items: InputItem[] } // v6: TD inputs (connect / disconnect / resolution)
  | { t: 'fileResult'; requestId?: string; op: FileOp; ok: boolean; path: string; msg?: string } // v6
  | { t: 'fileChosen'; requestId: string; path: string | null } // null = cancelled
  | { t: 'reload'; rev: number } // v6: TD replaced its document (Open Project)
  | { t: 'files'; projectFile: string; pngFile: string } // v6
  | { t: 'active'; active: boolean }
  | { t: 'error'; msg: string }
  | { t: 'fonts'; families: string[] }
  | { t: 'tops'; requestId: string; items: TopItem[] }
  | { t: 'topReady'; requestId: string; w: number; h: number }
  | { t: 'topError'; requestId: string; msg: string };

export type { FileOp, FileResult, InputItem };
export interface TopItem { path: string; w: number; h: number }

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

const isMode = (v: unknown): v is CanvasMode => v === 'input' || v === 'fixed';
const num = (a: unknown): number[] => (Array.isArray(a) ? a.filter(isNum) : []);

/** Guides and canvas default to "none" / "input" when absent (a pre-v5 peer). */
export function readGuides(v: unknown): Guides {
  const g = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { h: num(g.h), v: num(g.v) };
}
export function readCanvas(v: unknown): { mode: CanvasMode } {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { mode: isMode(c.mode) ? c.mode : 'input' };
}

const isInputIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 8;

/** Strict list of `{input, w, h, connected}`; null when any item is malformed. w/h may be 0 (no input). */
function readInputItems(v: unknown): InputItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: InputItem[] = [];
  for (const it of v as Record<string, unknown>[]) {
    if (!it || typeof it !== 'object' || !isInputIndex(it.input) || !isNum(it.w) || !isNum(it.h) || it.w < 0 || it.h < 0 || it.w > U16 || it.h > U16 || !isBool(it.connected)) return null;
    out.push({ input: it.input, w: it.w, h: it.h, connected: it.connected });
  }
  return out;
}

const FILE_OPS: readonly string[] = ['saveProject', 'openProject', 'exportPng'];

/** v6 layer normalisation: a v5 `base` layer is input 1; missing rot/kx/ky = 0, effects = [], `input` is a number for input layers, else null. */
export function normalizeLayer(l: LayerSpec): LayerSpec {
  const raw = l as unknown as Record<string, unknown>;
  const isInput = (raw.kind as string) === 'base' || raw.kind === 'input';
  const n = (v: unknown) => (isNum(v) ? v : 0);
  return {
    ...l,
    kind: isInput ? 'input' : l.kind,
    rot: n(raw.rot), kx: n(raw.kx), ky: n(raw.ky),
    input: isInput ? (isInputIndex(raw.input) ? raw.input : 1) : null,
    effects: Array.isArray(raw.effects) ? (raw.effects as LayerSpec['effects']) : [],
  };
}
export const normalizeLayers = (layers: LayerSpec[]): LayerSpec[] => layers.map(normalizeLayer);

const isLayers = (v: unknown): v is LayerSpec[] =>
  Array.isArray(v) && v.every((l) => l !== null && typeof l === 'object' && isStr((l as LayerSpec).id) && isStr((l as LayerSpec).kind));

/** Parse a TD → web message. Unknown types, unknown fields and malformed messages yield null / are dropped. */
export function decodeTdMessage(text: string): TdMessage | null {
  const o = parseObject(text);
  if (!o) return null;
  const doc = o.doc as Record<string, unknown> | undefined;
  switch (o.t) {
    case 'hello':
      return isNum(o.protocol) && doc && isSize(doc.w) && isSize(doc.h) && isBool(o.hasInput) && isNum(o.maxSendFps) && isBool(o.active)
        ? {
          t: 'hello', protocol: o.protocol, doc: isMode(doc.mode) ? { w: doc.w, h: doc.h, mode: doc.mode } : { w: doc.w, h: doc.h }, hasInput: o.hasInput, maxSendFps: o.maxSendFps, active: o.active,
          clientId: isStr(o.clientId) ? o.clientId : '', hasDocument: o.hasDocument === true, rev: isNum(o.rev) ? o.rev : null,
          ...(o.inputs !== undefined && readInputItems(o.inputs) ? { inputs: readInputItems(o.inputs)! } : {}),
        }
        : null;
    case 'docState':
      return isNum(o.rev) && isLayers(o.layers) && isSize(o.docW) && isSize(o.docH)
        ? { t: 'docState', rev: o.rev, layers: normalizeLayers(o.layers), docW: o.docW, docH: o.docH, guides: readGuides(o.guides), canvas: readCanvas(o.canvas) }
        : null;
    case 'base':
      return isNum(o.frameId) && isSize(o.docW) && isSize(o.docH) && isNum(o.x) && isNum(o.y) && isSize(o.w) && isSize(o.h)
        ? { t: 'base', frameId: o.frameId, input: isInputIndex(o.input) ? o.input : 1, docW: o.docW, docH: o.docH, x: o.x, y: o.y, w: o.w, h: o.h }
        : null;
    case 'view':
      return isNum(o.frameId) && isSize(o.docW) && isSize(o.docH) && isSize(o.w) && isSize(o.h)
        ? { t: 'view', frameId: o.frameId, docW: o.docW, docH: o.docH, w: o.w, h: o.h, appliedFrameId: isNum(o.appliedFrameId) ? o.appliedFrameId : -1 }
        : null;
    case 'applied':
      return isNum(o.frameId) ? { t: 'applied', frameId: o.frameId, tdFrame: isNum(o.tdFrame) ? o.tdFrame : 0 } : null;
    case 'docSize':
      return isSize(o.w) && isSize(o.h) && isBool(o.hasInput) ? { t: 'docSize', w: o.w, h: o.h, hasInput: o.hasInput, mode: isMode(o.mode) ? o.mode : 'input' } : null;
    case 'inputs': {
      const items = readInputItems(o.items);
      return items ? { t: 'inputs', items } : null;
    }
    case 'fileResult':
      return isStr(o.op) && FILE_OPS.includes(o.op) && isBool(o.ok) && isStr(o.path)
        ? { t: 'fileResult', ...(isStr(o.requestId) ? { requestId: o.requestId } : {}), op: o.op as FileOp, ok: o.ok, path: o.path, ...(isStr(o.msg) ? { msg: o.msg } : {}) }
        : null;
    case 'fileChosen':
      return isStr(o.requestId) && (o.path === null || isStr(o.path)) ? { t: 'fileChosen', requestId: o.requestId, path: o.path } : null;
    case 'reload':
      return isNum(o.rev) ? { t: 'reload', rev: o.rev } : null;
    case 'files':
      return isStr(o.projectFile) && isStr(o.pngFile) ? { t: 'files', projectFile: o.projectFile, pngFile: o.pngFile } : null;
    case 'active':
      return isBool(o.active) ? { t: 'active', active: o.active } : null;
    case 'error':
      return isStr(o.msg) ? { t: 'error', msg: o.msg } : null;
    case 'fonts':
      return Array.isArray(o.families) ? { t: 'fonts', families: o.families.filter(isStr) } : null;
    case 'tops': {
      if (!isStr(o.requestId) || !Array.isArray(o.items)) return null;
      const items: TopItem[] = [];
      for (const it of o.items as Record<string, unknown>[]) {
        if (it && typeof it === 'object' && isStr(it.path) && isNum(it.w) && isNum(it.h)) items.push({ path: it.path, w: it.w, h: it.h });
      }
      return { t: 'tops', requestId: o.requestId, items };
    }
    case 'topReady':
      return isStr(o.requestId) && isSize(o.w) && isSize(o.h) ? { t: 'topReady', requestId: o.requestId, w: o.w, h: o.h } : null;
    case 'topError':
      return isStr(o.requestId) ? { t: 'topError', requestId: o.requestId, msg: isStr(o.msg) ? o.msg : 'TouchDesigner import failed' } : null;
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
        ? { t: 'ready', protocol: o.protocol, client: o.client, version: o.version, token: isStr(o.token) ? o.token : '', fresh: o.fresh === true }
        : null;
    case 'doc':
      return isNum(o.rev) && isLayers(o.layers) ? { t: 'doc', rev: o.rev, layers: normalizeLayers(o.layers), guides: readGuides(o.guides), canvas: readCanvas(o.canvas) } : null;
    case 'requestDoc':
      return { t: 'requestDoc' };
    case 'view': {
      const r = o.rect as Record<string, unknown> | undefined;
      return (o.mode === 'local' || o.mode === 'td') && isNum(o.zoom) && isNum(o.panX) && isNum(o.panY) && r && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h)
        ? { t: 'view', mode: o.mode, zoom: o.zoom, panX: o.panX, panY: o.panY, rect: { x: r.x, y: r.y, w: r.w, h: r.h } }
        : null;
    }
    case 'takeover':
      return { t: 'takeover' };
    case 'requestBase':
      return { t: 'requestBase' };
    case 'listTops':
      return isStr(o.requestId) ? { t: 'listTops', requestId: o.requestId } : null;
    case 'importTop':
      return isStr(o.requestId) && isStr(o.path) ? { t: 'importTop', requestId: o.requestId, path: o.path } : null;
    case 'setCanvas':
      return isMode(o.mode) && (o.mode === 'input' || (isSize(o.w) && isSize(o.h))) ? { t: 'setCanvas', w: isNum(o.w) ? o.w : 0, h: isNum(o.h) ? o.h : 0, mode: o.mode } : null;
    case 'renderLayer':
      return isStr(o.requestId) && isStr(o.layerId) ? { t: 'renderLayer', requestId: o.requestId, layerId: o.layerId } : null;
    case 'saveProject':
    case 'openProject':
    case 'exportPng':
      return isStr(o.requestId) ? { t: o.t, requestId: o.requestId, ...(isStr(o.path) ? { path: o.path } : {}) } : null;
    case 'chooseFile':
      return isStr(o.requestId) && isStr(o.purpose) && PURPOSES.includes(o.purpose) ? { t: 'chooseFile', requestId: o.requestId, purpose: o.purpose as ChoosePurpose } : null;
    case 'log':
      return (o.level === 'info' || o.level === 'warn' || o.level === 'error') && isStr(o.msg) ? { t: 'log', level: o.level, msg: o.msg } : null;
    default:
      return null;
  }
}
