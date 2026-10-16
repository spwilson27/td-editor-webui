// Pure encode/decode of docs/PROTOCOL.md (version 11). No sockets here.
import type { BrushPreset, CanvasMode, Guides, LayerSpec } from '../engine/types';
import type { FileOp, FileResult } from '../state/filesSlice';
import type { InputItem } from '../state/inputsSlice';

export const MAGIC = [0x52, 0x45, 0x46, 0x31]; // "REF1"
export const HEADER_BYTES = 24;
export const MAX_BAND_PAYLOAD = 2 * 1024 * 1024;
export type RenderMode = 'flatten' | 'mergeDown';
export const PROTOCOL_VERSION = 11;
export const FRAME_BASE = 1;
export const FRAME_SURFACE = 3;
export const FRAME_SURFACE_DUMP = 4;
export const FRAME_VIEW = 5;
export const FRAME_TOP = 6; // v4: TD → web, GET /top (a TOP snapshot; docW/docH = the TOP's own size)
export const FRAME_LAYER_PREVIEW = 7; // v7: TD → web, GET /layer (doc-sized render of one tdPreview layer after its effects; slot 0)
export const FRAME_VIEW_FAST = 8; // v11: TD → web, WebSocket binary: two JPEGs (premultiplied RGB + alpha) of the visible region
export const FRAME_VIEW_EXACT = 9; // v11: TD → web, WebSocket binary (or GET /view?exact=1): deflate RGBA, full document or 64 px tiles
export const FLAG_FRAME_END = 1;

export type FrameType = typeof FRAME_BASE | typeof FRAME_SURFACE | typeof FRAME_SURFACE_DUMP | typeof FRAME_VIEW | typeof FRAME_TOP | typeof FRAME_LAYER_PREVIEW;
const VALID_TYPES: readonly number[] = [FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_VIEW, FRAME_TOP, FRAME_LAYER_PREVIEW];

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
  if (h.type === FRAME_LAYER_PREVIEW && h.slot !== 0) throw new RangeError('LAYER_PREVIEW slot must be 0');
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
  if (type === FRAME_LAYER_PREVIEW && v.getUint16(6, true) !== 0) return { ok: false, error: 'bad-slot' }; // v7: LAYER_PREVIEW slot = 0
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

/** v10: the in-TD panel is gone; every client is an external browser. */
export type ClientKind = 'external';

/** v10: one raster editor COMP of the project (GET /editors, `editors` message). */
export interface EditorInfo { id: string; name: string; path: string; version: string; active: boolean }
export interface EditorList { master: string; editors: EditorInfo[] }
export type ChoosePurpose = 'saveProject' | 'openProject' | 'exportPng';
const PURPOSES: readonly string[] = ['saveProject', 'openProject', 'exportPng'];
export type ViewMode = 'local' | 'td';
/** v11: which kind of TD frames to stream. */
export type ViewQuality = 'auto' | 'fast' | 'exact';
export const VIEW_QUALITIES: readonly ViewQuality[] = ['auto', 'fast', 'exact'];
/** v11: the visible part of the document (document px) and the device pixels per document pixel. */
export interface ViewportReport { x: number; y: number; w: number; h: number; scale: number }
export type LogLevel = 'info' | 'warn' | 'error';

export interface ViewRect { x: number; y: number; w: number; h: number }

export type WebMessage =
  | { t: 'ready'; protocol: number; client: ClientKind; version: string; token: string; fresh: boolean }
  | { t: 'doc'; rev: number; layers: LayerSpec[]; guides: Guides; canvas: { mode: CanvasMode }; brushPresets?: BrushPreset[] }
  | { t: 'requestDoc' }
  | { t: 'view'; mode: 'local' }
  | { t: 'view'; mode: 'td'; quality: ViewQuality; viewport: ViewportReport } // v11
  | { t: 'viewAck'; frameId: number } // v11: a VIEW_FAST frame was decoded
  | { t: 'viewExactReset' } // v11: the exact buffer is missing / has another size: send a full exact frame
  | { t: 'takeover' }
  | { t: 'requestBase' }
  | { t: 'listTops'; requestId: string }
  | { t: 'importTop'; requestId: string; path: string }
  | { t: 'setCanvas'; w: number; h: number; mode: CanvasMode } // v5
  | { t: 'renderLayer'; requestId: string; layerId: string; mode?: RenderMode } // v5: Flatten; v8 mode (default 'flatten')
  | { t: 'renderLayers'; requestId: string; layerIds: string[] } // v8: isolated composite of these layers (Merge Selected)
  | { t: 'saveProject'; requestId: string; path?: string; includeHistory?: boolean } // v6; v7 includeHistory (default true): false = TD writes no history.bin
  | { t: 'openProject'; requestId: string; path?: string }
  | { t: 'exportPng'; requestId: string; path?: string }
  | { t: 'chooseFile'; requestId: string; purpose: ChoosePurpose } // v6: TD shows a file chooser
  | { t: 'activeLayer'; id: string | null } // v7: the active client's active layer (drives TD's set_active_layer)
  | { t: 'log'; level: LogLevel; msg: string };

export type TdMessage =
  | { t: 'hello'; protocol: number; doc: { w: number; h: number; mode?: CanvasMode }; hasInput: boolean; maxSendFps: number; active: boolean; clientId: string; hasDocument: boolean; rev: number | null; inputs?: InputItem[] }
  | { t: 'docState'; rev: number; layers: LayerSpec[]; docW: number; docH: number; guides: Guides; canvas: { mode: CanvasMode }; brushPresets?: BrushPreset[] }
  | { t: 'base'; frameId: number; input: number; docW: number; docH: number; x: number; y: number; w: number; h: number }
  | { t: 'viewExact'; frameId: number; size: number } // v11: a large exact frame: fetch with GET /view?exact=1&frameId=
  | { t: 'applied'; frameId: number; tdFrame: number }
  | { t: 'docSize'; w: number; h: number; hasInput: boolean; mode: CanvasMode }
  | { t: 'inputs'; items: InputItem[] } // v6: TD inputs (connect / disconnect / resolution)
  | { t: 'fileResult'; requestId?: string; op: FileOp; ok: boolean; path: string; msg?: string } // v6
  | { t: 'fileChosen'; requestId: string; path: string | null } // null = cancelled
  | { t: 'reload'; rev: number } // v6: TD replaced its document (Open Project)
  | { t: 'files'; projectFile: string; pngFile: string } // v6
  | { t: 'active'; active: boolean }
  | { t: 'error'; msg: string }
  | { t: 'gone' } // v10: this socket's editor does not exist (any more); TD closes right after (it cannot send close code 4404)
  | { t: 'fonts'; families: string[] }
  | { t: 'tops'; requestId: string; items: TopItem[] }
  | { t: 'topReady'; requestId: string; w: number; h: number }
  | { t: 'layerPreview'; layerId: string; frameId: number } // v7: fetch with GET /layer
  | { t: 'editors'; master: string; editors: EditorInfo[] } // v10: the project's editors (on connect and on every change)
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

/** v7: document brush presets; malformed entries are dropped (a v6 peer sends none). */
export function readBrushPresets(v: unknown): BrushPreset[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is BrushPreset => p !== null && typeof p === 'object' && isStr((p as BrushPreset).id) && isStr((p as BrushPreset).name)
    && (p as BrushPreset).settings !== null && typeof (p as BrushPreset).settings === 'object' && (p as BrushPreset).dynamics !== null && typeof (p as BrushPreset).dynamics === 'object' && isStr((p as BrushPreset).tip));
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

/** v10: `{master, editors:[{id,name,path,version,active}]}` (GET /editors body, `editors` message); null when malformed. Entries without an id are dropped. */
export function readEditorList(o: unknown): EditorList | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (!isStr(r.master) || !Array.isArray(r.editors)) return null;
  const editors: EditorInfo[] = [];
  for (const e of r.editors as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object' || !isStr(e.id) || e.id === '') continue;
    editors.push({ id: e.id, name: isStr(e.name) && e.name ? e.name : e.id, path: isStr(e.path) ? e.path : '', version: isStr(e.version) ? e.version : '', active: e.active !== false });
  }
  return { master: r.master, editors };
}

export function decodeEditorList(text: string): EditorList | null {
  return readEditorList(parseObject(text));
}

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
        ? { t: 'docState', rev: o.rev, layers: normalizeLayers(o.layers), docW: o.docW, docH: o.docH, guides: readGuides(o.guides), canvas: readCanvas(o.canvas), ...(o.brushPresets !== undefined ? { brushPresets: readBrushPresets(o.brushPresets) } : {}) }
        : null;
    case 'base':
      return isNum(o.frameId) && isSize(o.docW) && isSize(o.docH) && isNum(o.x) && isNum(o.y) && isSize(o.w) && isSize(o.h)
        ? { t: 'base', frameId: o.frameId, input: isInputIndex(o.input) ? o.input : 1, docW: o.docW, docH: o.docH, x: o.x, y: o.y, w: o.w, h: o.h }
        : null;
    case 'viewExact':
      return isNum(o.frameId) && isNum(o.size) ? { t: 'viewExact', frameId: o.frameId, size: o.size } : null;
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
      return isStr(o.requestId) && (o.path === null || isStr(o.path))
        ? { t: 'fileChosen', requestId: o.requestId, path: o.path }
        : null;
    case 'reload':
      return isNum(o.rev) ? { t: 'reload', rev: o.rev } : null;
    case 'files':
      return isStr(o.projectFile) && isStr(o.pngFile) ? { t: 'files', projectFile: o.projectFile, pngFile: o.pngFile } : null;
    case 'active':
      return isBool(o.active) ? { t: 'active', active: o.active } : null;
    case 'error':
      return isStr(o.msg) ? { t: 'error', msg: o.msg } : null;
    case 'gone':
      return { t: 'gone' };
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
    case 'layerPreview':
      return isStr(o.layerId) && isNum(o.frameId) ? { t: 'layerPreview', layerId: o.layerId, frameId: o.frameId } : null;
    case 'editors': {
      const l = readEditorList(o);
      return l ? { t: 'editors', master: l.master, editors: l.editors } : null;
    }
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
      return isNum(o.protocol) && o.client === 'external' && isStr(o.version)
        ? { t: 'ready', protocol: o.protocol, client: o.client, version: o.version, token: isStr(o.token) ? o.token : '', fresh: o.fresh === true }
        : null;
    case 'doc':
      return isNum(o.rev) && isLayers(o.layers) ? { t: 'doc', rev: o.rev, layers: normalizeLayers(o.layers), guides: readGuides(o.guides), canvas: readCanvas(o.canvas), ...(o.brushPresets !== undefined ? { brushPresets: readBrushPresets(o.brushPresets) } : {}) } : null;
    case 'requestDoc':
      return { t: 'requestDoc' };
    case 'view': {
      if (o.mode === 'local') return { t: 'view', mode: 'local' };
      const r = o.viewport as Record<string, unknown> | undefined;
      return o.mode === 'td' && VIEW_QUALITIES.includes(o.quality as ViewQuality) && r && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h) && isNum(r.scale)
        ? { t: 'view', mode: 'td', quality: o.quality as ViewQuality, viewport: { x: r.x, y: r.y, w: r.w, h: r.h, scale: r.scale } }
        : null;
    }
    case 'viewAck':
      return isNum(o.frameId) ? { t: 'viewAck', frameId: o.frameId } : null;
    case 'viewExactReset':
      return { t: 'viewExactReset' };
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
      if (o.mode !== undefined && o.mode !== 'flatten' && o.mode !== 'mergeDown') return null;
      return isStr(o.requestId) && isStr(o.layerId) ? { t: 'renderLayer', requestId: o.requestId, layerId: o.layerId, ...(o.mode ? { mode: o.mode as RenderMode } : {}) } : null;
    case 'renderLayers':
      return isStr(o.requestId) && Array.isArray(o.layerIds) && o.layerIds.length > 0 && o.layerIds.every(isStr) ? { t: 'renderLayers', requestId: o.requestId, layerIds: o.layerIds as string[] } : null;
    case 'saveProject':
    case 'openProject':
    case 'exportPng':
      return isStr(o.requestId) ? { t: o.t, requestId: o.requestId, ...(isStr(o.path) ? { path: o.path } : {}), ...(o.t === 'saveProject' && isBool(o.includeHistory) ? { includeHistory: o.includeHistory } : {}) } as WebMessage : null;
    case 'chooseFile':
      return isStr(o.requestId) && isStr(o.purpose) && PURPOSES.includes(o.purpose)
        ? { t: 'chooseFile', requestId: o.requestId, purpose: o.purpose as ChoosePurpose }
        : null;
    case 'activeLayer':
      return isStr(o.id) || o.id === null ? { t: 'activeLayer', id: o.id } : null;
    case 'log':
      return (o.level === 'info' || o.level === 'warn' || o.level === 'error') && isStr(o.msg) ? { t: 'log', level: o.level, msg: o.msg } : null;
    default:
      return null;
  }
}

// ---- v11: VIEW_FAST / VIEW_EXACT binary frames (docs/PROTOCOL.md §13) ----

/** Two JPEGs of the visible region: `rgb` = premultiplied colour, `alpha` = greyscale (null = fully opaque). */
export interface ViewFastFrame {
  kind: 'fast';
  frameId: number;
  appliedFrameId: number; // the newest web SURFACE frame TD had applied when it rendered this (0xFFFFFFFF = none)
  x: number; y: number; w: number; h: number; // document rect covered
  pw: number; ph: number; // pixel size of the JPEGs
  rgb: Uint8Array;
  alpha: Uint8Array | null;
}

/** `body` = a zlib stream of straight RGBA8: the whole document (`full`) or an index of `nTiles` × (u16 tx, ty, w, h) followed by the tiles' rows (`tiles`). */
export interface ViewExactFrame {
  kind: 'exact';
  frameId: number;
  appliedFrameId: number;
  docW: number; docH: number;
  full: boolean;
  tile: number;
  nTiles: number;
  body: Uint8Array;
}

export type ViewFrameError = 'too-short' | 'bad-magic' | 'bad-type' | 'bad-length' | 'bad-header';
export type DecodedViewFrame = { ok: true; frame: ViewFastFrame | ViewExactFrame } | { ok: false; error: ViewFrameError };

export const NO_FRAME = 0xffffffff;
/** a ≥ b in u32 sequence order (wrap-safe). */
export const frameGeq = (a: number, b: number): boolean => ((a - b) >>> 0) < 0x80000000;

const FAST_HEADER = 36;
const EXACT_HEADER = 16;
export const EXACT_TILE = 64;

export function decodeViewFrame(data: ArrayBuffer | ArrayBufferView): DecodedViewFrame {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  if (bytes.length < HEADER_BYTES) return { ok: false, error: 'too-short' };
  if (MAGIC.some((m, i) => bytes[i] !== m)) return { ok: false, error: 'bad-magic' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getUint8(4);
  if (type !== FRAME_VIEW_FAST && type !== FRAME_VIEW_EXACT) return { ok: false, error: 'bad-type' };
  // frame header of types 8 / 9: slot 0, x = y = w = h = 0 (docW / docH = the document size)
  if (v.getUint16(6, true) !== 0 || v.getUint16(16, true) !== 0 || v.getUint16(18, true) !== 0 || v.getUint16(20, true) !== 0 || v.getUint16(22, true) !== 0) return { ok: false, error: 'bad-header' };
  const o = HEADER_BYTES;
  if (type === FRAME_VIEW_FAST) {
    if (bytes.length < o + FAST_HEADER) return { ok: false, error: 'too-short' };
    // sub-header from o: frameId u32, applied u32, x y w h f32, pw ph u16, rgbLen u32, alphaLen u32
    const rl = v.getUint32(o + 28, true), al = v.getUint32(o + 32, true);
    if (bytes.length !== o + FAST_HEADER + rl + al) return { ok: false, error: 'bad-length' };
    const pw = v.getUint16(o + 24, true), ph = v.getUint16(o + 26, true);
    const f = { x: v.getFloat32(o + 8, true), y: v.getFloat32(o + 12, true), w: v.getFloat32(o + 16, true), h: v.getFloat32(o + 20, true) };
    if (rl === 0 || pw < 1 || ph < 1 || !(f.w > 0) || !(f.h > 0) || !Number.isFinite(f.x) || !Number.isFinite(f.y)) return { ok: false, error: 'bad-header' };
    const start = o + FAST_HEADER;
    return { ok: true, frame: {
      kind: 'fast', frameId: v.getUint32(o, true), appliedFrameId: v.getUint32(o + 4, true), ...f, pw, ph,
      rgb: bytes.subarray(start, start + rl), alpha: al ? bytes.subarray(start + rl, start + rl + al) : null,
    } };
  }
  if (bytes.length < o + EXACT_HEADER) return { ok: false, error: 'too-short' };
  const docW = v.getUint16(12, true), docH = v.getUint16(14, true);
  const sw = v.getUint16(o + 8, true), sh = v.getUint16(o + 10, true), kind = v.getUint8(o + 12), tile = v.getUint8(o + 13), nTiles = v.getUint16(o + 14, true);
  if (sw < 1 || sh < 1 || kind > 1 || tile !== EXACT_TILE || (docW !== 0 && (docW !== sw || docH !== sh))) return { ok: false, error: 'bad-header' };
  return { ok: true, frame: { kind: 'exact', frameId: v.getUint32(o, true), appliedFrameId: v.getUint32(o + 4, true), docW: sw, docH: sh, full: kind === 0, tile, nTiles, body: bytes.subarray(o + EXACT_HEADER) } };
}

/** Test/fake-TD side of the fast frame. */
export function encodeViewFast(f: Omit<ViewFastFrame, 'kind'> & { docW?: number; docH?: number }): Uint8Array {
  const alphaLen = f.alpha ? f.alpha.length : 0;
  const out = new Uint8Array(HEADER_BYTES + 36 + f.rgb.length + alphaLen);
  const v = new DataView(out.buffer);
  out.set(MAGIC, 0);
  v.setUint8(4, FRAME_VIEW_FAST); v.setUint8(5, FLAG_FRAME_END); v.setUint32(8, f.frameId >>> 0, true);
  v.setUint16(12, f.docW ?? 0, true); v.setUint16(14, f.docH ?? 0, true);
  let o = HEADER_BYTES;
  v.setUint32(o, f.frameId >>> 0, true); v.setUint32(o + 4, f.appliedFrameId >>> 0, true);
  v.setFloat32(o + 8, f.x, true); v.setFloat32(o + 12, f.y, true); v.setFloat32(o + 16, f.w, true); v.setFloat32(o + 20, f.h, true);
  v.setUint16(o + 24, f.pw, true); v.setUint16(o + 26, f.ph, true); v.setUint32(o + 28, f.rgb.length, true); v.setUint32(o + 32, alphaLen, true);
  o += 36;
  out.set(f.rgb, o); if (f.alpha) out.set(f.alpha, o + f.rgb.length);
  return out;
}

/** Test/fake-TD side of the exact frame; `body` is the already deflated stream. */
export function encodeViewExact(f: Omit<ViewExactFrame, 'kind'>): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + EXACT_HEADER + f.body.length);
  const v = new DataView(out.buffer);
  out.set(MAGIC, 0);
  v.setUint8(4, FRAME_VIEW_EXACT); v.setUint8(5, FLAG_FRAME_END); v.setUint32(8, f.frameId >>> 0, true);
  v.setUint16(12, f.docW, true); v.setUint16(14, f.docH, true);
  const o = HEADER_BYTES;
  v.setUint32(o, f.frameId >>> 0, true); v.setUint32(o + 4, f.appliedFrameId >>> 0, true);
  v.setUint16(o + 8, f.docW, true); v.setUint16(o + 10, f.docH, true); v.setUint8(o + 12, f.full ? 0 : 1); v.setUint8(o + 13, f.tile); v.setUint16(o + 14, f.nTiles, true);
  out.set(f.body, o + EXACT_HEADER);
  return out;
}
