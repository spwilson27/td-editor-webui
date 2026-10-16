import type { CanvasMode, EditorEngine, LayerSpec, Rect } from '../engine/types';
import type { FileResult } from '../state/filesSlice';
import type { InputItem } from '../state/inputsSlice';
import { layerBelow } from '../state/layerDrop';
import { RENDER_STALE_MESSAGE } from '../state/layersSlice';
import {
  FRAME_BASE, FRAME_LAYER_PREVIEW, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_TOP, MAX_BAND_PAYLOAD, PROTOCOL_VERSION,
  decodeFrame, decodeTdMessage, encodeBands, encodeMessage, isStale, type ChoosePurpose, type EditorList, type TdMessage, type TopItem, type ViewQuality, type ViewRect, type RenderMode, type WebMessage,
} from './codec';
import { TdViewClient, type ViewSink } from './tdViewClient';
import { visibleDocRect } from './viewMath';
import { parseHash, requestQuery, withEditor } from './urls';

/** v10: what `Bridge.flush` achieved. 'dropped' = unsent edits could not be sent (not linked); 'timeout' is added by the session controller. */
export type FlushResult = 'ok' | 'dropped' | 'timeout';

export type Connection = 'linked' | 'standalone' | 'reconnecting';

export interface LatencyStats { n: number; last: number; median: number; p95: number }
export const NO_LATENCY: LatencyStats = { n: 0, last: 0, median: 0, p95: 0 };

export interface BridgeStatus {
  setConnection(c: Connection): void;
  setActive(active: boolean): void;
  setNotice(msg: string): void;
  setFatal?(msg: string): void; // persistent, until reload
  /** True while this page waits for / loads TD's document: editing is locked. */
  setLoading?(loading: boolean): void;
  /** stroke → TD `applied` latency (rolling). */
  setLatency?(s: LatencyStats): void;
  /** stroke → TD output visible in the external view stream (from view.appliedFrameId). */
  setViewLatency?(s: LatencyStats): void;
  /** v11: where decoded TD view frames (VIEW_FAST / VIEW_EXACT) are composited. */
  viewSink?: ViewSink;
  /** v11: which kind of TD frame is on screen now (`null` = none); `ageMs` = frame arrival to composited. */
  setViewShown?(kind: 'fast' | 'exact' | null, ageMs: number): void;
  /** v4: TD's font family list (sent after hello). */
  setFonts?(families: string[]): void;
  /** v6: TD's input list (`inputs` message / `hello.inputs`) for the Add Input Layer menu. The bridge itself calls engine.setInputs. */
  setInputs?(items: InputItem[]): void;
  /** v6: `files` message: current Projectfile / Pngfile parameter values. */
  setFiles?(f: { projectFile: string; pngFile: string }): void;
  /** v6: a `fileResult` that no dialog request is waiting for (TD pulses). */
  onFileResult?(r: FileResult): void;
  /** v7: state of a tdPreview layer's TD render: 'pending' (announced, not fetched yet) or 'ready' (the engine shows TD's image). */
  setLayerPreview?(layerId: string, state: 'pending' | 'ready'): void;
  /** v7: all TD layer renders are void (document reload). */
  clearLayerPreviews?(): void;
  /** v10: the project's editor list (`editors` message). */
  setEditors?(list: EditorList): void;
  /** v10: TD closed the socket with 4404 (this session's editor does not exist (any more)); the bridge does not reconnect. */
  onEditorGone?(): void;
}
export type { FileResult, FileOp } from '../state/filesSlice';
export type { InputItem } from '../state/inputsSlice';

/** The page's view: `zoom` / `panX` / `panY` place the document inside the viewport element (`rect`, CSS px). */
export interface ViewState { mode: 'local' | 'td'; quality?: ViewQuality; zoom: number; panX: number; panY: number; rect: ViewRect }
/** v11: at most this often a changed viewport is sent (mode / quality changes go out at once). */
export const VIEW_SEND_INTERVAL_MS = 100;

export interface Bridge {
  takeover(): void;
  dispose(): void;
  /** v10: send everything that is pending (document, dirty surfaces, active layer) and upload the undo history, so the session can be closed without losing edits. Resolves when done (never rejects); 'dropped' when edits were made offline and nothing could be sent. */
  flush?(): Promise<FlushResult>;
  /** v10: edits exist that TD does not have yet (made while disconnected, or still queued). */
  hasUnsent?(): boolean;
  /** v10: the editor this session is bound to ('' = the master's own editor). */
  readonly editor?: string;
  /** v11: send the current view again (TD then streams a fresh frame). */
  refreshView?(): void;
  /** Report viewport state; sent to TD at most once per animation frame. */
  setView(v: ViewState): void;
  /** v4: the importable TOPs of the TD project. Rejects when not linked, on a timeout or when TD answers with an error. */
  listTops(): Promise<TopItem[]>;
  /** v4: snapshot a TOP once and add it as a pixel layer (engine.importImage). Resolves with the new layer id. */
  importTop(path: string): Promise<string>;
  /** v5 Flatten: TD renders the text/shape layer alone at document size, the pixels replace the layer (engine.replaceWithPixels). */
  renderLayer(layerId: string, mode?: RenderMode): Promise<void>;
  /** v8 Merge Selected: TD renders the given layers as one isolated composite; they are replaced by one pixel layer (engine.replaceLayersWithPixels). */
  renderLayers(layerIds: string[]): Promise<void>;
  /** v5: tell TD the canvas size / mode (active, loaded page only). Returns false when nothing was sent. */
  setCanvas(w: number, h: number, mode: CanvasMode): boolean;
  /** v6 files (written/read by TD). `path` omitted = the TD parameter value. Reject when not linked / on timeout; resolve with TD's `fileResult` (ok may be false). */
  saveProject(path?: string, opts?: { includeHistory?: boolean }): Promise<FileResult>;
  /** v7: remove the undo history TD stores (empty POST /history). The page uploads again after its next history change. */
  clearStoredHistory(): Promise<void>;
  openProject(path?: string): Promise<FileResult>;
  exportPng(path?: string): Promise<FileResult>;
  /** v6: TD shows a file chooser (no UI uses it since the in-TD panel is gone; the protocol still has it). Resolves with the chosen path, null when cancelled. */
  chooseFile(purpose: ChoosePurpose): Promise<string | null>;
}

export interface TdBridgeOptions {
  url?: string;
  /** v10: the editor id sent as `editor=` on the WebSocket URL and every HTTP request ('' / absent = the master's own editor). */
  editor?: string;
  token?: string;
  version?: string;
  WebSocketCtor?: typeof WebSocket;
  forwardLogs?: boolean;
  now?: () => number;
  fetch?: typeof fetch;
  raf?: (cb: () => void) => unknown;
  /** v11: device pixel ratio for the viewport report. */
  dpr?: () => number;
  /** v11: JPEG decoder (default createImageBitmap). */
  decodeJpeg?: (bytes: Uint8Array) => Promise<ImageBitmap>;
}

export const BACKPRESSURE_BYTES = 8 * 1024 * 1024;
export const SURFACE_FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10000, FETCH_RETRY_MS = 500, REQUEST_BASE_MS = 2000;
const BACKOFF_MIN = 500, BACKOFF_MAX = 5000, DEFAULT_FPS = 30;
/** A WebSocket still CONNECTING after this long is abandoned and retried (a browser serialises handshakes to one address: one that hangs, e.g. against a server that was just restarted, would block every later attempt). */
const CONNECT_TIMEOUT_MS = 4000;
/** An open socket that gets no `hello` after `ready` within this long is dead (e.g. accepted by a server that was just stopped and never serves it): closed and retried. */
const HELLO_TIMEOUT_MS = 8000;
const LOAD_RETRY_MIN = 2000, LOAD_RETRY_MAX = 10000, NO_DOC_FALLBACK_MS = 10000;
const LATENCY_WINDOW = 60, SENT_KEEP = 512;
export const RENDER_LAYER_TIMEOUT_MS = 30000;
export const FILE_OP_TIMEOUT_MS = 60000;
export const CHOOSE_FILE_TIMEOUT_MS = 300000; // the user is picking a file
export const INFLIGHT_WAIT_MS = 8000; // v10: how long a tab switch waits for running TOP imports / renders
export const HISTORY_UPLOAD_DELAY_MS = 2000; // v7: debounce after the last history change
export const HISTORY_MAX_FAILURES = 3; // consecutive failed uploads before TD's stored history is cleared
export const HISTORY_MAX_STEPS = 50, HISTORY_MAX_BYTES = 256 * 1024 * 1024;
export const LIST_TOPS_TIMEOUT_MS = 10000, IMPORT_TOP_TIMEOUT_MS = 30000;

export function resolveWsUrl(search: string, loc: { protocol: string; host: string }): string {
  const override = new URLSearchParams(search).get('ws');
  if (override) return override;
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

/** v10: the token comes from the URL hash (`#token=…&e=…`); a `?token=` query is still honoured (dev / tests). */
export function resolveToken(search: string, hash = ''): string {
  return parseHash(hash).token || (new URLSearchParams(search).get('token') ?? '');
}

export const TOKEN_EXPIRED_MESSAGE = 'Reopen from TouchDesigner — session expired';

/** The HTTP origin that serves /base, /surface and /view: same host and port as the WebSocket (so `?ws=` overrides carry over). */
export function httpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}

/** slot → surface size from a spec: a pixel layer's surface; a mask has the size of its layer's surface (document size when the layer has none). */
export function slotSizesOf(layers: LayerSpec[], docW: number, docH: number): Map<number, { w: number; h: number }> {
  const out = new Map<number, { w: number; h: number }>();
  for (const l of layers) {
    const sz = { w: l.surfaceW ?? docW, h: l.surfaceH ?? docH };
    if (l.slot !== null && l.slot !== undefined) out.set(l.slot, sz);
    if (l.mask) out.set(l.mask.slot, sz);
  }
  return out;
}

const unionRect = (a: Rect | null | undefined, b: Rect): Rect => {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export function latencyStats(samples: number[]): LatencyStats {
  if (!samples.length) return NO_LATENCY;
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, last: samples[samples.length - 1], median: at(0.5), p95: at(0.95) };
}

export function startTdBridge(engine: EditorEngine, status: BridgeStatus, opts: TdBridgeOptions = {}): Bridge {
  const editor = opts.editor ?? '';
  const url = withEditor(opts.url ?? resolveWsUrl(location.search, location), editor);
  const token = opts.token ?? resolveToken(location.search, location.hash);
  const WS = opts.WebSocketCtor ?? WebSocket;
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const httpBase = httpOrigin(url);
  const now = opts.now ?? (() => performance.now());
  const rawRaf: (cb: () => void) => unknown = opts.raf ?? (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16));
  /** Next frame, but never later than 50 ms: rAF is throttled or paused in hidden / offscreen pages. Runs cb once. */
  const raf = (cb: () => void) => {
    let done = false;
    const run = () => { if (done) return; done = true; clearTimeout(t); cb(); };
    const t = setTimeout(run, 50);
    rawRaf(run);
  };

  let ws: WebSocket | null = null;
  let disposed = false;
  let rejected = false; // TD refused the token; only a reload with a fresh URL can fix it
  let goneSeen = false; // v10: TD said `gone` / `no such editor` on the current socket (its close code is not 4404)
  let gone404 = false; // v10: TD closed the socket with 4404 (no such editor): no reconnect
  let active = false;
  let backoff = BACKOFF_MIN;
  let maxFps = DEFAULT_FPS;
  let frameId = 0;
  let clientId = '';
  // v6: BASE bookkeeping per TD input: newest notice id, single flight, and a refetch flag (newest wins)
  interface BaseState { noticeId: number; fetching: boolean; refetch: boolean }
  const baseStates = new Map<number, BaseState>();
  let reapplyInputs = false; // after `reload`: re-apply knownInputs once the reload's load completes
  let knownInputs: InputItem[] = []; // the list as last announced (hello.inputs / inputs), sizes corrected by BASE frames
  let docEpoch = 0; // bumped by docSize/reconnect/doc load: results fetched before are void
  let offlineEdits = false; // v10: the page was edited while disconnected (TD does not have it)
  const inflight = new Set<Promise<unknown>>(); // v10: TOP imports / renders / file ops that a tab switch waits for
  let synced = false; // the page has loaded or pushed a document; false = `fresh`
  let loading = false; // loading TD's document: engine events are not echoed back
  let loadToken = 0;
  let loadRetry: ReturnType<typeof setTimeout> | null = null;
  let loadRetryDelay = LOAD_RETRY_MIN;
  let loadStart = 0;
  // TD's persisted document must never be overwritten by a page that has not loaded it.
  let authoritative = false; // this page may send doc / SURFACE
  let loadPending = false; // waiting for / loading TD's document
  let loadIncomplete = false; // a load was started and has not finished successfully
  let tdHasDocument = false; // from the latest hello
  let tdRev: number | null = null; // newest TD rev this page loaded or wrote
  const unsafe = new Set<number>(); // slots whose TD pixels could not be loaded: never sent
  const aborts = new Set<AbortController>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let requestTimer: ReturnType<typeof setTimeout> | null = null;
  const dirty = new Map<number, Rect>();
  let lastSend = -Infinity;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let scratch = new Uint8ClampedArray(0);

  // canvas as TD knows it (last received from / sent to TD): engine changes of any other origin (undo, redo, jumpTo) are sent
  let tdCanvas: { w: number; h: number; mode: CanvasMode } | null = null;
  let adopting = false;
  let pendingTd: { size?: Extract<TdMessage, { t: 'docSize' }>; inputs?: InputItem[] } = {};
  // doc stack
  let docPending = false, docQueued = false, lastDocRev = -1;
  // view
  let viewState: ViewState | null = null, viewQueued = false, viewDirty = false;
  let lastViewKey = '', lastViewSent = -Infinity, viewTimer: ReturnType<typeof setTimeout> | null = null;
  const nullSink: ViewSink = { fast: (i) => { i.rgb.close(); i.alpha?.close(); return false; }, exact: () => false, show() {}, clear() {} };
  const viewClient = new TdViewClient({
    send: (m) => sendJson(m),
    sink: status.viewSink ?? nullSink,
    fetchExact: (id) => fetchExactFrame(id),
    decodeJpeg: opts.decodeJpeg,
    now,
    onDisplayed: (_kind, applied) => {
      const sent = takeSent(applied);
      if (sent !== undefined) recordLatency(viewSamples, now() - sent, (x) => status.setViewLatency?.(x));
    },
    onShown: (kind, age) => status.setViewShown?.(kind, age),
    onError: (msg) => sendJson({ t: 'log', level: 'warn', msg }),
    onNotice: (msg) => status.setNotice(msg),
  });
  viewClient.setActive(false); // Local until a td `view` is sent: frames that arrive meanwhile are acked and dropped
  // v7: layer previews (per layer single flight, newest notice wins), active layer, history persistence
  interface PreviewState { frameId: number; fetching: boolean; refetch: boolean; attempts: number }
  const previews = new Map<string, PreviewState>();
  const previewReady = new Set<string>();
  let activeSent: string | null | undefined, activeQueued = false; // undefined = nothing sent yet (a null id is sent too)
  let historyDirty = false, historyTouched = false, restoring = false, historyTimer: ReturnType<typeof setTimeout> | null = null;
  let historyChain: Promise<void> = Promise.resolve();
  let uploadedKey = '', uploadedRev = -1, uploadFailures = 0, lastBlobBytes = 0;
  // v4 TOP import
  let requestSeq = 0;
  const pendingTops = new Map<string, { resolve: (items: TopItem[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingImports = new Map<string, { resolve: (w: number, h: number) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingFiles = new Map<string, { resolve: (r: FileResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingChoose = new Map<string, { resolve: (p: string | null) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const failPending = (msg: string) => {
    for (const p of pendingChoose.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    pendingChoose.clear();
    for (const p of pendingFiles.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    pendingFiles.clear();
    for (const p of pendingTops.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    for (const p of pendingImports.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    pendingTops.clear();
    pendingImports.clear();
  };
  // latency
  const sentAt = new Map<number, number>();
  const unacked = new Map<number, number>(); // slot -> newest SURFACE frameId sent and not yet reported by TD's `applied`
  const samples: number[] = [], viewSamples: number[] = [];

  const isOpen = () => ws !== null && ws.readyState === 1;
  const canSend = () => active && authoritative && !loading && !loadPending;
  const sendJson = (m: WebMessage) => { if (isOpen()) ws!.send(encodeMessage(m)); };

  /** Per-slot surface sizes (v5): a layer's surface, a mask has its layer's size. Cached per spec rev. */
  let sizesRev = -2;
  let sizesCache = new Map<number, { w: number; h: number }>();
  const slotSizes = (): Map<number, { w: number; h: number }> => {
    const known = (engine as EditorEngine & { docRev?(): number }).docRev?.();
    if (known !== undefined && known === sizesRev) return sizesCache; // no docSpec() build per flush
    const spec = engine.docSpec();
    if (spec.rev !== sizesRev) { sizesRev = spec.rev; sizesCache = slotSizesOf(spec.layers, spec.width, spec.height); }
    return sizesCache;
  };
  const markFull = (slots: number[] = engine.surfaceSlots()) => {
    const sizes = slotSizes();
    for (const slot of slots) {
      const sz = sizes.get(slot);
      if (sz && !unsafe.has(slot)) dirty.set(slot, { x: 0, y: 0, w: sz.w, h: sz.h });
    }
    schedule();
  };

  function sendDocNow() {
    docPending = false;
    if (!isOpen()) return;
    const spec = engine.docSpec();
    if (spec.rev === lastDocRev) return;
    lastDocRev = spec.rev;
    tdRev = spec.rev;
    sendJson({ t: 'doc', rev: spec.rev, layers: spec.layers, guides: spec.guides, canvas: spec.canvas, brushPresets: spec.brushPresets ?? [] });
  }

  function queueDoc() {
    docPending = true;
    if (docQueued || !canSend()) return;
    docQueued = true;
    raf(() => {
      docQueued = false;
      if (disposed || !canSend() || !docPending) return;
      sendDocNow();
    });
  }

  function schedule() {
    if (sendTimer || !dirty.size || !canSend() || !isOpen()) return;
    const wait = Math.max(0, lastSend + 1000 / maxFps - now());
    sendTimer = setTimeout(() => flush(), wait);
  }

  function flush(force = false) {
    sendTimer = null;
    if (!dirty.size || !canSend() || !isOpen()) return;
    if (!force && ws!.bufferedAmount > BACKPRESSURE_BYTES) { sendTimer = setTimeout(() => flush(), 1000 / maxFps); return; }
    if (docPending || (force && lastDocRev !== engine.docSpec().rev)) sendDocNow(); // TD drops surfaces of slots it has not seen in a `doc`
    lastSend = now();
    for (const [slot, r] of [...dirty]) {
      if (!force && ws!.bufferedAmount > BACKPRESSURE_BYTES) break;
      dirty.delete(slot);
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const sz = slotSizes().get(slot);
      if (!sz) continue;
      const x1 = Math.min(sz.w, Math.ceil(r.x + r.w)), y1 = Math.min(sz.h, Math.ceil(r.y + r.h));
      if (x1 <= x0 || y1 <= y0) continue;
      const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const n = rect.w * rect.h * 4;
      if (scratch.length < n) scratch = new Uint8ClampedArray(n);
      const pixels = engine.readSurface(slot, rect, scratch.subarray(0, n));
      const id = frameId;
      frameId = (frameId + 1) >>> 0;
      sentAt.set(id, now());
      unacked.set(slot, id);
      if (sentAt.size > SENT_KEEP) sentAt.delete(sentAt.keys().next().value!);
      for (const band of encodeBands({ type: FRAME_SURFACE, slot, frameId: id, docW: sz.w, docH: sz.h, rect, pixels, maxPayload: MAX_BAND_PAYLOAD })) {
        ws!.send(band as BufferSource);
      }
    }
    if (dirty.size) { if (force) flush(true); else schedule(); }
  }

  const offEngine = engine.on((e) => {
    if (loading) return;
    if (!isOpen() && synced && !adopting && !restoring && (e.type === 'surface' || e.type === 'docspec' || e.type === 'history' || e.type === 'resize')) offlineEdits = true;
    switch (e.type) {
      case 'surface':
        if (canSend() && !unsafe.has(e.slot)) { dirty.set(e.slot, unionRect(dirty.get(e.slot), e.rect)); schedule(); }
        break;
      case 'docspec': if (canSend()) { queueDoc(); syncCanvas(); } break;
      case 'structure': queueActiveLayer(); break;
      case 'history':
        if (restoring) break;
        historyTouched = true;
        historyDirty = true;
        scheduleHistoryUpload();
        break;
      case 'resize': if (canSend()) { queueDoc(); syncCanvas(); } break; // v5: the canvas size never reallocates surfaces
      default: break;
    }
  });

  // ---- v7: active layer ----

  /** The active client tells TD which layer is being edited (TD's set_active_layer); coalesced to one message per frame, only changes. */
  function queueActiveLayer() {
    if (activeQueued || !canSend()) return;
    activeQueued = true;
    raf(() => {
      activeQueued = false;
      if (disposed || !canSend() || !isOpen()) return;
      const id = engine.activeLayerId();
      if (id === activeSent || (id === null && activeSent === undefined)) return;
      if (docPending) sendDocNow(); // TD must know a just-created layer before it is named active
      activeSent = id;
      sendJson({ t: 'activeLayer', id });
    });
  }

  // ---- v7: history persistence ----

  const needsHistoryUpload = (beforeSave: boolean) => canSend() && isOpen() && !!clientId && (historyDirty || (beforeSave && engine.docSpec().rev !== uploadedRev && uploadedRev !== -1));

  /** Debounce: 2 s, plus 100 ms per MB of the last blob (a large history is quieter), at most 10 s. */
  const historyDelay = () => HISTORY_UPLOAD_DELAY_MS + Math.min(8000, Math.floor(lastBlobBytes / 1048576) * 100);

  function scheduleHistoryUpload(delay = historyDelay()) {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    if (disposed || !canSend()) return;
    historyTimer = setTimeout(() => { historyTimer = null; void uploadHistory(false); }, delay);
  }

  const historyVersion = (): string | null => {
    const v = engine.historyVersion?.();
    return v === undefined ? null : String(v);
  };

  /** Stale history must never be restorable: when the current one cannot be sent, TD's stored copy is cleared (empty body). Best effort, once. */
  async function dropStaleHistory(rev: number, sock: WebSocket | null) {
    uploadedKey = ''; uploadedRev = -1;
    const ctrl = new AbortController();
    aborts.add(ctrl);
    try {
      await doFetch(`${httpBase}/history?${query(`&rev=${rev}`)}`, { method: 'POST', body: new Uint8Array(0) as BufferSource, headers: { 'Content-Type': 'application/octet-stream' }, signal: ctrl.signal });
    } catch { /* offline: TD drops history of older revisions itself */ } finally {
      aborts.delete(ctrl);
      if (ws !== sock) historyDirty = false;
    }
  }

  /** Cheap fingerprint of a blob (length + FNV-1a over at most ~1 MB of strided samples): unchanged history is not sent again. */
  function blobKey(rev: number, b: Uint8Array): string {
    let h = 2166136261;
    const stride = Math.max(1, Math.floor(b.length / 262144));
    for (let i = 0; i < b.length; i += stride) h = Math.imul(h ^ b[i], 16777619) >>> 0;
    return `${rev}:${b.length}:${h}`;
  }

  /** POST /history?…&rev= with engine.serializeHistory(50, 256 MB). Serialised; skipped when nothing changed; never while loading / standby. */
  function uploadHistory(beforeSave: boolean): Promise<void> {
    historyChain = historyChain.then(async () => {
      if (disposed || !needsHistoryUpload(beforeSave)) return;
      if (docPending || lastDocRev !== engine.docSpec().rev) sendDocNow(); // TD stores the history with the revision it belongs to
      const rev = engine.docSpec().rev;
      const sock = ws;
      // change detection: the engine's history version when it has one (exact), else a sampled fingerprint of the blob
      const ver = historyVersion();
      if (ver !== null && `${rev}:v${ver}` === uploadedKey) { historyDirty = false; return; }
      let blob: Uint8Array;
      try { blob = engine.serializeHistory(HISTORY_MAX_STEPS, HISTORY_MAX_BYTES); } catch {
        historyDirty = false;
        await dropStaleHistory(rev, sock); // cannot serialise: the stored history is stale now
        return;
      }
      if (blob.byteLength > HISTORY_MAX_BYTES) { historyDirty = false; await dropStaleHistory(rev, sock); return; }
      lastBlobBytes = blob.byteLength;
      const key = ver !== null ? `${rev}:v${ver}` : blobKey(rev, blob);
      historyDirty = false;
      if (key === uploadedKey) return;
      const ctrl = new AbortController();
      aborts.add(ctrl);
      try {
        const res = await doFetch(`${httpBase}/history?${query(`&rev=${rev}`)}`, { method: 'POST', body: blob as BufferSource, headers: { 'Content-Type': 'application/octet-stream' }, signal: ctrl.signal });
        if (res.status === 403) { rejectToken(); return; }
        if (res.ok) { uploadedKey = key; uploadedRev = rev; uploadFailures = 0; } else throw new Error(`HTTP ${res.status}`);
      } catch {
        if (disposed || ws !== sock) return; // disconnected: the next session starts clean
        if (++uploadFailures >= HISTORY_MAX_FAILURES) { uploadFailures = 0; historyDirty = false; await dropStaleHistory(rev, sock); return; }
        historyDirty = true; // retry later (back off, the change is still unsent)
        scheduleHistoryUpload(HISTORY_UPLOAD_DELAY_MS * 5);
      } finally {
        aborts.delete(ctrl);
      }
    }).catch(() => {});
    return historyChain;
  }

  /** After a complete document load: GET /history; restore it when its rev is the loaded document's. Silent on 404 / mismatch / corrupt blobs. */
  async function restoreHistory(loadedRev: number, my: number) {
    const sock = ws, epoch = docEpoch;
    historyTouched = false;
    const ctrl = new AbortController();
    aborts.add(ctrl);
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS * 3);
    try {
      const res = await doFetch(`${httpBase}/history?${query()}`, { cache: 'no-store', signal: ctrl.signal });
      if (res.status === 404) return;
      if (res.status === 403) { rejectToken(); return; }
      if (!res.ok) return;
      const hdr = res.headers.get('X-Doc-Rev');
      const buf = await res.arrayBuffer();
      if (disposed || ws !== sock || epoch !== docEpoch || my !== loadToken || loading || historyTouched || !active || !authoritative) return;
      const num = (v: string | null) => (v === null || v.trim() === '' ? NaN : Number(v));
      const docRev = num(hdr);
      if (!Number.isFinite(docRev) || docRev !== loadedRev) return; // TD's document is not the one that was loaded
      // X-History-Rev = the revision embedded in the blob (differs from X-Doc-Rev after Open Project rebased the revision)
      const histRev = num(res.headers.get('X-History-Rev'));
      const rev = Number.isFinite(histRev) ? histRev : docRev;
      restoring = true;
      let ok = false;
      try { ok = engine.restoreHistory(new Uint8Array(buf), rev); } catch { ok = false; } finally { restoring = false; }
      if (ok) { historyDirty = false; uploadedRev = loadedRev; uploadedKey = ''; }
      else sendJson({ t: 'log', level: 'warn', msg: 'undo history from TouchDesigner could not be restored' });
    } catch {
      /* no history: start empty */
    } finally {
      clearTimeout(timeout);
      aborts.delete(ctrl);
    }
  }

  // ---- v7: layer previews (GET /layer) ----

  function pullPreview(layerId: string, frameId: number) {
    let st = previews.get(layerId);
    if (!st) previews.set(layerId, (st = { frameId, fetching: false, refetch: false, attempts: 0 }));
    st.frameId = frameId;
    if (!previewReady.has(layerId)) status.setLayerPreview?.(layerId, 'pending');
    if (st.fetching) { st.refetch = true; return; }
    st.fetching = true;
    st.attempts = 0;
    void fetchPreview(layerId, st).finally(() => {
      st.fetching = false;
      if (st.refetch && !disposed && previews.get(layerId) === st) { st.refetch = false; pullPreview(layerId, st.frameId); }
    });
  }

  /** True while TD may still lack pixels the page painted on the layer (sent but unacknowledged, or not sent yet): a TD render fetched now would be older than the page's own pixels. */
  function surfacesPending(layerId: string): boolean {
    if (!unacked.size && !dirty.size) return false;
    const l = engine.docSpec().layers.find((x) => x.id === layerId);
    const busy = (slot: number) => unacked.has(slot) || dirty.has(slot);
    if (!l || l.kind === 'adjustment' || l.kind === 'group') return [...unacked.keys(), ...dirty.keys()].length > 0; // their result depends on every layer below / inside
    return (l.slot != null && busy(l.slot)) || (!!l.mask && busy(l.mask.slot));
  }

  async function fetchPreview(layerId: string, st: PreviewState): Promise<void> {
    const sock = ws, epoch = docEpoch;
    const ctrl = new AbortController();
    aborts.add(ctrl);
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${httpBase}/layer?${query(`&layerId=${encodeURIComponent(layerId)}&frameId=${st.frameId}`)}`, { cache: 'no-store', signal: ctrl.signal });
      if (res.status === 404) { previews.delete(layerId); return; } // not rendered (any more): a later notice follows
      if (res.status === 403) { rejectToken(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (disposed || ws !== sock || epoch !== docEpoch) return;
      const r = decodeFrame(buf);
      if (!r.ok || r.frame.type !== FRAME_LAYER_PREVIEW || isStale(r.frame, engine.width, engine.height)) return;
      if (!engine.layers().some((l) => l.id === layerId)) return;
      if (surfacesPending(layerId)) return; // older than the page's pixels: TD announces a newer render once it applied them
      if (!engine.tdPreviewLayers().includes(layerId)) return; // the engine would ignore it (layer no longer needs TD's render)
      engine.setLayerPreview(layerId, r.frame.payload);
      previewReady.add(layerId);
      status.setLayerPreview?.(layerId, 'ready');
    } catch {
      if (disposed || ws !== sock) return;
      if (st.attempts++ === 0) {
        await new Promise<void>((resolve) => { retryTimer = setTimeout(() => { retryTimer = null; resolve(); }, FETCH_RETRY_MS); });
        if (!disposed && ws === sock && epoch === docEpoch) await fetchPreview(layerId, st);
      }
    } finally {
      clearTimeout(timeout);
      aborts.delete(ctrl);
    }
  }

  function clearPreviews() {
    previews.clear();
    for (const id of previewReady) { try { engine.setLayerPreview(id, null); } catch { /* layer gone */ } }
    previewReady.clear();
    status.clearLayerPreviews?.();
  }

  /** Tell TD about a canvas size / mode change that did not come from TD (undo / redo / jumpTo, the dialog). */
  function syncCanvas() {
    if (adopting || loading || !isOpen()) return;
    const mode = engine.canvasMode(), w = engine.width, h = engine.height;
    const t = tdCanvas;
    if (t && t.mode === mode && (mode === 'input' || (t.w === w && t.h === h))) return;
    if (!t && mode === 'input') { tdCanvas = { w, h, mode }; return; }
    tdCanvas = { w, h, mode };
    sendJson({ t: 'setCanvas', w: mode === 'input' ? 0 : w, h: mode === 'input' ? 0 : h, mode });
  }

  function endLoadState() {
    loadPending = false;
    if (loadRetry) { clearTimeout(loadRetry); loadRetry = null; }
    status.setLoading?.(false);
  }

  function pushAll() {
    offlineEdits = false;
    endLoadState();
    authoritative = true;
    synced = true;
    docPending = true;
    lastDocRev = -1;
    if (isOpen()) sendDocNow();
    markFull();
    activeSent = undefined;
    queueActiveLayer();
  }

  function setActive(a: boolean) {
    active = a;
    status.setActive(a);
    if (!a) {
      unacked.clear();
      activeSent = undefined;
      historyDirty = false;
      if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
      dirty.clear();
      docPending = false;
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    }
  }

  function recordLatency(list: number[], v: number, report?: (s: LatencyStats) => void) {
    list.push(v);
    if (list.length > LATENCY_WINDOW) list.shift();
    report?.(latencyStats(list));
  }

  function takeSent(id: number): number | undefined {
    const t = sentAt.get(id);
    for (const k of [...sentAt.keys()]) if (((id - k) >>> 0) < 0x80000000) sentAt.delete(k);
    return t;
  }

  // ---- document load from TD ----

  /** Ask TD for its document and keep asking (backoff) until it is loaded completely. Never pushes over a stored document. */
  function beginLoad() {
    loadPending = true;
    loadIncomplete = true;
    authoritative = false;
    unacked.clear();
    historyDirty = false;
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    dirty.clear();
    docPending = false;
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    loadStart = now();
    loadRetryDelay = LOAD_RETRY_MIN;
    status.setLoading?.(true);
    sendLoadRequest();
  }

  function armLoadRetry() {
    if (loadRetry || disposed) return;
    loadRetry = setTimeout(() => {
      loadRetry = null;
      if (!loadPending || disposed) return;
      loadRetryDelay = Math.min(LOAD_RETRY_MAX, loadRetryDelay * 2);
      // Only where TD may truly have no document (takeover with none stored) does the page eventually become the source.
      if (!tdHasDocument && !loading && now() - loadStart >= NO_DOC_FALLBACK_MS) { pushAll(); return; }
      if (loading) { armLoadRetry(); return; } // a load is in flight; do not restart it
      sendLoadRequest();
    }, loadRetryDelay);
  }

  function sendLoadRequest() {
    if (!loadPending || !isOpen()) return;
    sendJson({ t: 'requestDoc' });
    status.setNotice('Loading document from TouchDesigner…');
    armLoadRetry();
  }

  async function loadDoc(m: Extract<TdMessage, { t: 'docState' }>) {
    if (!active || !loadPending) {
      sendJson({ t: 'log', level: 'warn', msg: 'ignored docState: this page is not waiting for a document load' });
      return;
    }
    const my = ++loadToken;
    loading = true;
    docEpoch++;
    dirty.clear();
    unacked.clear();
    unsafe.clear();
    const sock = ws;
    let complete = false;
    try {
      clearPreviews();
      engine.loadDocument({ rev: m.rev, width: m.docW, height: m.docH, layers: m.layers, guides: m.guides, canvas: m.canvas, ...(m.brushPresets ? { brushPresets: m.brushPresets } : {}) });
      const slots: number[] = [];
      const sizes = slotSizesOf(m.layers, m.docW, m.docH);
      for (const l of m.layers) {
        if (l.slot !== null && l.slot !== undefined) slots.push(l.slot);
        if (l.mask) slots.push(l.mask.slot);
      }
      let next = 0;
      const failed: number[] = [];
      const worker = async () => {
        while (next < slots.length && my === loadToken && !disposed) {
          const slot = slots[next++];
          if (!(await fetchSurface(slot, sock, my, sizes.get(slot))) && my === loadToken) failed.push(slot);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SURFACE_FETCH_CONCURRENCY, slots.length) }, worker));
      if (my === loadToken && !disposed) {
        for (const f of failed) unsafe.add(f);
        complete = failed.length === 0;
      }
    } catch (err) {
      if (my === loadToken) status.setNotice(`Document load failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (my === loadToken) {
        loading = false;
        try { engine.commitSurfaces(); } catch { /* the document may be unusable; the retry reloads it */ }
        dirty.clear();
        const specKey = (sp: ReturnType<EditorEngine['docSpec']>) => JSON.stringify([sp.layers, sp.guides, sp.canvas, sp.width, sp.height]);
        const specLoaded = engine.docSpec();
        const revLoaded = specLoaded.rev; // what TD has: the loaded document
        const keyLoaded = specKey(specLoaded);
        if (complete) { // TD changes that arrived mid-load: applied while still not authoritative, so nothing is pushed back
          tdCanvas = { w: m.docW, h: m.docH, mode: m.canvas.mode };
          const pend = pendingTd;
          pendingTd = {};
          if (pend.size) adoptCanvas(pend.size.w, pend.size.h, pend.size.mode);
          if (pend.inputs) applyInputs(pend.inputs);
          else if (reapplyInputs && knownInputs.length) applyInputs(knownInputs); // restores badges / missing input layers
          reapplyInputs = false;
        }
        dirty.clear();
        lastDocRev = revLoaded;
        if (complete) {
          loadIncomplete = false;
          offlineEdits = false;
          synced = true;
          authoritative = true;
          tdRev = m.rev;
          endLoadState();
          // Layers that setInputs auto-created differ from TD's stored document: TD must get them.
          if (isOpen() && active) { const now2 = engine.docSpec(); if (now2.rev !== revLoaded && specKey(now2) !== keyLoaded) sendDocNow(); }
          activeSent = undefined;
          queueActiveLayer();
          if (isOpen() && active) void restoreHistory(m.rev, my);
        } else if (loadPending && !disposed) {
          armLoadRetry(); // stay non-authoritative; ask TD again
          status.setNotice('Loading document from TouchDesigner… (retrying)');
        }
        if (viewState) sendView(); // the viewport state must reach TD whatever the load outcome
      }
    }
  }

  /** True when the slot is settled: loaded, or TD has no pixels for it (404 = loaded-empty). False = failed. */
  async function fetchSurface(slot: number, sock: WebSocket | null, my: number, size: { w: number; h: number } | undefined): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      aborts.add(ctrl);
      const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await doFetch(`${httpBase}/surface?${query()}&slot=${slot}`, { cache: 'no-store', signal: ctrl.signal });
        if (res.status === 404) return true;
        if (res.status === 403) { rejectToken(); return false; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (disposed || ws !== sock || my !== loadToken || !loading) return true; // superseded; the newer load owns the result
        const r = decodeFrame(buf);
        if (!r.ok || r.frame.type !== FRAME_SURFACE_DUMP || !size || isStale(r.frame, size.w, size.h)) return false;
        engine.writeSurface(slot, { x: r.frame.x, y: r.frame.y, w: r.frame.w, h: r.frame.h }, r.frame.payload);
        return true;
      } catch {
        if (disposed || ws !== sock || my !== loadToken) return true;
        if (attempt === 1) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, FETCH_RETRY_MS));
      } finally {
        clearTimeout(timeout);
        aborts.delete(ctrl);
      }
    }
    return false;
  }

  const query = (extra = '') => requestQuery({ token, client: clientId, editor }, extra);

  // ---- viewport state ----

  /** The wire form of the page's view (protocol 11): local = unsubscribed; td = quality + the visible document rect. null = nothing to say yet. */
  function wireView(v: ViewState): Extract<WebMessage, { t: 'view' }> | null {
    if (v.mode === 'local') return { t: 'view', mode: 'local' };
    const dpr = opts.dpr?.() ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const viewport = visibleDocRect({ zoom: v.zoom, x: v.panX, y: v.panY }, v.rect.w, v.rect.h, engine.width, engine.height, dpr);
    return viewport ? { t: 'view', mode: 'td', quality: v.quality ?? 'auto', viewport } : null;
  }

  /** `force`: send even when unchanged / too soon (reconnect, load end). Viewport-only changes are throttled to VIEW_SEND_INTERVAL_MS. */
  function sendView(force = true) {
    viewDirty = false;
    if (!viewState || !isOpen()) return;
    const m = wireView(viewState);
    if (!m) return;
    const key = JSON.stringify(m);
    if (!force && key === lastViewKey) return;
    if (!force) {
      let last: Extract<WebMessage, { t: 'view' }> | null = null;
      try { last = lastViewKey ? JSON.parse(lastViewKey) : null; } catch { last = null; }
      const viewportOnly = m.mode === 'td' && last?.mode === 'td' && last.quality === m.quality;
      const wait = lastViewSent + VIEW_SEND_INTERVAL_MS - now();
      if (viewportOnly && wait > 0) {
        viewDirty = true;
        if (!viewTimer) viewTimer = setTimeout(() => { viewTimer = null; if (!disposed && viewDirty) sendView(false); }, wait);
        return;
      }
    }
    if (viewTimer) { clearTimeout(viewTimer); viewTimer = null; }
    viewClient.setActive(m.mode === 'td'); // leaving TD mode drops the frames, the exact buffer and the GPU picture
    lastViewKey = key;
    lastViewSent = now();
    sendJson(m);
  }

  /** GET /view?exact=1&frameId=N: a VIEW_EXACT frame too large for the socket (the same bytes as a socket message). */
  async function fetchExactFrame(id: number): Promise<ArrayBuffer | null> {
    const sock = ws;
    const ctrl = new AbortController();
    aborts.add(ctrl);
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${httpBase}/view?${query(`&exact=1&frameId=${id}`)}`, { cache: 'no-store', signal: ctrl.signal });
      if (res.status === 403) { rejectToken(); return null; }
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return disposed || ws !== sock ? null : buf;
    } catch {
      return null; // the client treats a failed fetch as a lost exact frame: it invalidates its buffer and sends viewExactReset
    } finally {
      clearTimeout(timeout);
      aborts.delete(ctrl);
    }
  }

  function onJson(text: string) {
    const m = decodeTdMessage(text);
    if (!m) return;
    switch (m.t) {
      case 'hello': {
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        if (m.protocol !== PROTOCOL_VERSION) { status.setNotice(m.protocol < PROTOCOL_VERSION
          ? `Protocol mismatch: this page speaks protocol ${PROTOCOL_VERSION} but the TouchDesigner component speaks ${m.protocol} - update the component (.tox)`
          : `Protocol mismatch: the TouchDesigner component speaks protocol ${m.protocol}, this page ${PROTOCOL_VERSION} - reload the page`); return; }
        backoff = BACKOFF_MIN;
        clientId = m.clientId;
        maxFps = m.maxSendFps > 0 ? m.maxSendFps : DEFAULT_FPS;
        status.setConnection('linked');
        active = false;
        authoritative = false;
        tdHasDocument = m.hasDocument;
        adoptCanvas(m.doc.w, m.doc.h, m.doc.mode ?? engine.canvasMode());
        // TD's document is another revision than the one this page last synced (another client edited it, or Open Project replaced it while we
        // were away): load it instead of overwriting. The page's offline edits are kept (and pushed) only when TD still has the revision we synced.
        const moved = synced && m.rev !== null && tdRev !== null && m.rev !== tdRev;
        if (moved && m.hasDocument && engine.docSpec().rev !== lastDocRev) status.setNotice('Document changed in TouchDesigner while you were offline; your offline edits were discarded');
        const needsLoad = m.hasDocument && (!synced || loadIncomplete || moved);
        setActive(m.active);
        if (m.inputs) {
          docEpoch++;
          if (m.active && needsLoad) pendingTd.inputs = m.inputs; // applied when the load completes
          else applyInputs(m.inputs);
        }
        if (m.active) {
          if (needsLoad) beginLoad();
          else pushAll();
        }
        if (viewState) sendView();
        break;
      }
      case 'docState':
        void loadDoc(m);
        break;
      case 'docSize':
        docEpoch++;
        clearPreviews();
        if (loading || loadPending) { pendingTd.size = m; break; } // never adopt mid-load: applied when the load completes
        adoptCanvas(m.w, m.h, m.mode);
        break;
      case 'inputs':
        docEpoch++;
        if (loading || loadPending) { pendingTd.inputs = m.items; break; }
        applyInputs(m.items);
        break;
      case 'base': {
        let st = baseStates.get(m.input);
        if (!st) baseStates.set(m.input, (st = { noticeId: 0, fetching: false, refetch: false }));
        st.noticeId = m.frameId;
        pullBase(m.input, st);
        break;
      }
      case 'reload':
        onReload();
        break;
      case 'fileChosen': {
        const c = pendingChoose.get(m.requestId);
        if (c) { pendingChoose.delete(m.requestId); clearTimeout(c.timer); c.resolve(m.path); }
        break;
      }
      case 'files':
        status.setFiles?.({ projectFile: m.projectFile, pngFile: m.pngFile });
        break;
      case 'fileResult': {
        const r: FileResult = { op: m.op, ok: m.ok, path: m.path, ...(m.msg !== undefined ? { msg: m.msg } : {}) };
        const p = m.requestId !== undefined ? pendingFiles.get(m.requestId) : undefined;
        if (p) { pendingFiles.delete(m.requestId!); clearTimeout(p.timer); p.resolve(r); } else status.onFileResult?.(r);
        break;
      }
      case 'layerPreview':
        pullPreview(m.layerId, m.frameId);
        break;
      case 'viewExact':
        viewClient.handleExactNotice(m.frameId);
        break;
      case 'applied': {
        for (const [slot, id] of unacked) if (((m.frameId - id) >>> 0) < 0x80000000) unacked.delete(slot);
        const t = takeSent(m.frameId);
        if (t !== undefined) recordLatency(samples, now() - t, (x) => status.setLatency?.(x));
        break;
      }
      case 'active': {
        const gained = m.active && !active;
        setActive(m.active);
        if (gained) beginLoad(); // takeover: TD's document is the truth
        break;
      }
      case 'gone': // v10: TD cannot close with 4404: it says so, then closes
        goneSeen = true;
        break;
      case 'error':
        if (/token/i.test(m.msg)) rejectToken();
        else if (/no such editor/i.test(m.msg)) goneSeen = true; // (older TD builds: the error text, then the close)
        else status.setNotice(m.msg);
        break;
      case 'fonts':
        status.setFonts?.(m.families);
        break;
      case 'editors':
        status.setEditors?.({ master: m.master, editors: m.editors });
        break;
      case 'tops': {
        const p = pendingTops.get(m.requestId);
        if (!p) break;
        pendingTops.delete(m.requestId);
        clearTimeout(p.timer);
        p.resolve(m.items);
        break;
      }
      case 'topReady': {
        const p = pendingImports.get(m.requestId);
        if (!p) break;
        pendingImports.delete(m.requestId);
        clearTimeout(p.timer);
        p.resolve(m.w, m.h);
        break;
      }
      case 'topError': {
        const p = pendingImports.get(m.requestId);
        status.setNotice(m.msg);
        const lt = pendingTops.get(m.requestId);
        if (lt) { pendingTops.delete(m.requestId); clearTimeout(lt.timer); lt.reject(new Error(m.msg)); }
        if (!p) break;
        pendingImports.delete(m.requestId);
        clearTimeout(p.timer);
        p.reject(new Error(m.msg));
        break;
      }
    }
  }

  /** TD's document size + mode become the engine's, without history (engine.adoptCanvas; older engines: setCanvasMode + resize). */
  function adoptCanvas(w: number, h: number, mode: CanvasMode) {
    adopting = true;
    try {
      if (engine.adoptCanvas) {
        if (w !== engine.width || h !== engine.height || mode !== engine.canvasMode()) engine.adoptCanvas(w, h, mode);
      } else {
        if (engine.canvasMode() !== mode) engine.setCanvasMode(mode);
        if (w !== engine.width || h !== engine.height) engine.resize(w, h);
      }
    } finally {
      adopting = false;
    }
    tdCanvas = { w: engine.width, h: engine.height, mode: engine.canvasMode() };
  }

  /** v6: TD's input list (hello.inputs / inputs). The engine creates / updates the input layers; no history. */
  function applyInputs(items: InputItem[]) {
    knownInputs = items.map((i) => ({ ...i }));
    engine.setInputs(knownInputs.map((i) => ({ ...i })));
    status.setInputs?.(knownInputs.map((i) => ({ ...i })));
  }

  /** A BASE frame announces the real size of its input: correct the known list when it differs (the input is connected). */
  function adoptInputSize(input: number, w: number, h: number) {
    const cur = knownInputs.find((i) => i.input === input);
    if (cur && cur.w === w && cur.h === h) return;
    const next = cur ? knownInputs.map((i) => (i.input === input ? { ...i, w, h, connected: true } : i)) : [...knownInputs, { input, w, h, connected: true }].sort((a, b) => a.input - b.input);
    applyInputs(next);
  }

  /** TD replaced its stored document (Open Project): drop ours and load TD's again. */
  function onReload() {
    loadToken++; // cancels an in-flight load
    clearPreviews();
    loading = false;
    docEpoch++;
    dirty.clear();
    unacked.clear();
    unsafe.clear();
    docPending = false;
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    authoritative = false;
    tdRev = null;
    tdHasDocument = true;
    reapplyInputs = true;
    loadIncomplete = true; // a standby page reloads on its next takeover / hello
    if (active) beginLoad();
  }

  /** Make TD current before it writes a file: the pending doc and every dirty surface go out at once. */
  function syncForFile() {
    if (!canSend() || !isOpen()) return;
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (docPending || lastDocRev !== engine.docSpec().rev) sendDocNow();
    flush(true);
  }

  function chooseFile(purpose: ChoosePurpose): Promise<string | null> {
    if (!isOpen() || !clientId) return Promise.reject(new Error('Not connected to TouchDesigner'));
    const requestId = `c${++requestSeq}`;
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => { pendingChoose.delete(requestId); reject(new Error('TouchDesigner did not answer')); }, CHOOSE_FILE_TIMEOUT_MS);
      pendingChoose.set(requestId, { resolve, reject, timer });
      sendJson({ t: 'chooseFile', requestId, purpose });
    });
  }

  function fileOp(op: FileResult['op'], path?: string, opts?: { includeHistory?: boolean }): Promise<FileResult> {
    if (!isOpen() || !clientId) return Promise.reject(new Error('Not connected to TouchDesigner'));
    const requestId = `f${++requestSeq}`;
    if (op !== 'openProject') syncForFile();
    const send = () => new Promise<FileResult>((resolve, reject) => {
      const timer = setTimeout(() => { pendingFiles.delete(requestId); reject(new Error('TouchDesigner did not answer')); }, FILE_OP_TIMEOUT_MS);
      pendingFiles.set(requestId, { resolve, reject, timer });
      sendJson({ t: op, requestId, ...(path !== undefined ? { path } : {}), ...(op === 'saveProject' && opts?.includeHistory !== undefined ? { includeHistory: opts.includeHistory } : {}) } as WebMessage);
    });
    // v7: the undo history goes to TD before it writes the project, so the file carries the current history
    if (op === 'saveProject' && opts?.includeHistory !== false && needsHistoryUpload(true)) return uploadHistory(true).then(() => { if (!isOpen()) throw new Error('Disconnected from TouchDesigner'); return send(); });
    return send();
  }

  /** File ▸ Clear stored undo history: TD forgets the blob (it would keep erased content recoverable in shared .toe / .redoc files). */
  function clearStoredHistory(): Promise<void> {
    if (!isOpen() || !clientId) return Promise.reject(new Error('Not connected to TouchDesigner'));
    if (!canSend()) return Promise.reject(new Error('Only the active editor can clear the stored history'));
    const run = historyChain.then(async () => {
      if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
      historyDirty = false;
      const ctrl = new AbortController();
      aborts.add(ctrl);
      try {
        const res = await doFetch(`${httpBase}/history?${query(`&rev=${engine.docSpec().rev}`)}`, { method: 'POST', body: new Uint8Array(0) as BufferSource, headers: { 'Content-Type': 'application/octet-stream' }, signal: ctrl.signal });
        if (res.status === 403) { rejectToken(); throw new Error(TOKEN_EXPIRED_MESSAGE); }
        if (!res.ok) throw new Error(`TouchDesigner answered HTTP ${res.status}`);
        uploadedKey = ''; uploadedRev = -1;
      } finally {
        aborts.delete(ctrl);
      }
    });
    historyChain = run.catch(() => {});
    return run;
  }

  function listTops(): Promise<TopItem[]> {
    if (!isOpen() || !clientId) return Promise.reject(new Error('Not connected to TouchDesigner'));
    const requestId = `t${++requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingTops.delete(requestId); reject(new Error('TouchDesigner did not answer')); }, LIST_TOPS_TIMEOUT_MS);
      pendingTops.set(requestId, { resolve, reject, timer });
      sendJson({ t: 'listTops', requestId });
    });
  }

  async function importTop(path: string): Promise<string> {
    if (!isOpen() || !clientId) throw new Error('Not connected to TouchDesigner');
    const requestId = `i${++requestSeq}`;
    const sock = ws, epoch = docEpoch;
    await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const timer = setTimeout(() => { pendingImports.delete(requestId); reject(new Error('TouchDesigner did not answer')); }, IMPORT_TOP_TIMEOUT_MS);
      pendingImports.set(requestId, { resolve: (w, h) => resolve({ w, h }), reject, timer });
      sendJson({ t: 'importTop', requestId, path });
    });
    const frame = await fetchTop(requestId, sock);
    if (disposed) throw new Error('Bridge closed'); // the session ended (tab switch): the store ignores this one
    if (epoch !== docEpoch) throw new Error('The document changed during the import');
    const name = path.split('/').filter(Boolean).pop() ?? 'TOP';
    return engine.importImage(frame.payload, frame.w, frame.h, name);
  }

  /** Ask TD for an isolated render (renderLayer / renderLayers), fetch it from GET /top and hand it to `apply` unless the layers changed meanwhile. */
  async function renderRequest(prefix: string, msg: (requestId: string) => WebMessage, ids: string[], apply: (frame: { w: number; h: number; payload: Uint8Array }) => void): Promise<void> {
    if (!isOpen() || !clientId) throw new Error('Not connected to TouchDesigner');
    const requestId = `${prefix}${++requestSeq}`;
    const sock = ws;
    // everything the render depends on: the layers asked for, the document revision and the undo position / history version
    const fingerprint = () => {
      const all = engine.layers(), h = engine.history();
      return JSON.stringify([engine.width, engine.height, engine.docSpec().rev, engine.historyVersion?.() ?? null, h.entries.length, h.index,
        ids.map((id) => { const l = all.find((x) => x.id === id); return l ? [l.id, l.kind, l.parentId, l.text, l.shape, l.effects, l.mask, l.transform, l.visible, l.opacity, l.blend] : null; })]);
    };
    const before = fingerprint();
    if (canSend() && lastDocRev !== engine.docSpec().rev) sendDocNow(); // TD must render the layers as the page has them now
    await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const timer = setTimeout(() => { pendingImports.delete(requestId); reject(new Error('TouchDesigner did not answer')); }, RENDER_LAYER_TIMEOUT_MS);
      pendingImports.set(requestId, { resolve: (w, h) => resolve({ w, h }), reject, timer });
      sendJson(msg(requestId));
    });
    const frame = await fetchTop(requestId, sock);
    if (disposed) throw new Error('Bridge closed');
    if (fingerprint() !== before) { status.setNotice(RENDER_STALE_MESSAGE); throw new Error(RENDER_STALE_MESSAGE); }
    apply(frame);
  }

  /** v5/v8 Flatten: renderLayer {mode} → topReady → GET /top (document-sized) → replace the layer (mergeDown: the adjustment and the layer below) by one pixel layer. */
  async function renderLayer(layerId: string, mode: RenderMode = 'flatten'): Promise<void> {
    if (!isOpen() || !clientId) throw new Error('Not connected to TouchDesigner');
    const all = engine.layers();
    const l = all.find((x) => x.id === layerId);
    if (!l) throw new Error('Layer not found');
    let ids = [layerId];
    let name: string | undefined;
    if (mode === 'mergeDown') {
      const below = layerBelow(all, layerId);
      if (l.kind !== 'adjustment' || !below) throw new Error('Nothing below to merge into');
      if (below.kind === 'input' || below.kind === 'adjustment') throw new Error(`Cannot merge down into ${below.kind === 'input' ? 'an input layer' : 'another adjustment'}`);
      ids = [layerId, below.id];
      name = below.name; // the merged layer keeps the name of the layer it was merged into
    }
    const legacy = mode === 'flatten' && (l.kind === 'text' || l.kind === 'shape');
    await renderRequest('r', (requestId) => ({ t: 'renderLayer', requestId, layerId, mode }), ids, (f) => {
      if (legacy) engine.replaceWithPixels(layerId, f.payload, f.w, f.h);
      else engine.replaceLayersWithPixels(ids, f.payload, f.w, f.h, name);
    });
  }

  /** v8 Merge Selected: renderLayers → topReady → GET /top → engine.replaceLayersWithPixels(ids). */
  async function renderLayers(layerIds: string[]): Promise<void> {
    if (!layerIds.length) throw new Error('No layers to merge');
    await renderRequest('m', (requestId) => ({ t: 'renderLayers', requestId, layerIds }), layerIds, (f) => { engine.replaceLayersWithPixels(layerIds, f.payload, f.w, f.h); });
  }

  function setCanvas(w: number, h: number, mode: CanvasMode): boolean {
    if (!isOpen() || !active || !authoritative || loadPending) return false;
    const t = tdCanvas;
    if (t && t.mode === mode && (mode === 'input' || (t.w === w && t.h === h))) return true; // already sent for this very change
    tdCanvas = { w: mode === 'input' ? engine.width : w, h: mode === 'input' ? engine.height : h, mode };
    sendJson({ t: 'setCanvas', w: mode === 'input' ? 0 : w, h: mode === 'input' ? 0 : h, mode });
    return true;
  }

  /** GET /top: same auth, abort and timeout rules as /surface; one retry. */
  async function fetchTop(requestId: string, sock: WebSocket | null): Promise<{ w: number; h: number; payload: Uint8Array }> {
    let lastErr = 'TOP fetch failed';
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      aborts.add(ctrl);
      const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await doFetch(`${httpBase}/top?${query(`&requestId=${encodeURIComponent(requestId)}`)}`, { cache: 'no-store', signal: ctrl.signal });
        if (res.status === 403) { rejectToken(); throw new Error(TOKEN_EXPIRED_MESSAGE); }
        if (res.status === 404) throw new Error('The TOP snapshot expired');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (disposed) throw new Error('Bridge closed');
        if (ws !== sock) throw new Error('Disconnected from TouchDesigner');
        const r = decodeFrame(buf);
        if (!r.ok || r.frame.type !== FRAME_TOP) throw new Error('Invalid TOP image from TouchDesigner');
        return { w: r.frame.w, h: r.frame.h, payload: r.frame.payload };
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (rejected || disposed || ws !== sock || /expired|Invalid|Disconnected/.test(lastErr)) break;
        if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, FETCH_RETRY_MS));
      } finally {
        clearTimeout(timeout);
        aborts.delete(ctrl);
      }
    }
    if (disposed) throw new Error('Bridge closed');
    status.setNotice(`TOP fetch failed: ${lastErr}`);
    throw new Error(lastErr);
  }

  function rejectToken() {
    rejected = true;
    (status.setFatal ?? status.setNotice)(TOKEN_EXPIRED_MESSAGE);
  }

  /** BASE frames are pulled over HTTP (never the WebSocket): per input one fetch in flight, a newer notice just triggers one more. */
  function pullBase(input: number, st: BaseState) {
    if (st.fetching) { st.refetch = true; return; }
    st.fetching = true;
    void fetchBase(input, st, 0).finally(() => {
      st.fetching = false;
      if (st.refetch && !disposed && baseStates.get(input) === st) { st.refetch = false; pullBase(input, st); }
    });
  }

  async function fetchBase(input: number, st: BaseState, attempt: number): Promise<void> {
    const sock = ws, epoch = docEpoch;
    const ctrl = new AbortController();
    aborts.add(ctrl);
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${httpBase}/base?${query(`&frameId=${st.noticeId}&input=${input}`)}`, { cache: 'no-store', signal: ctrl.signal });
      if (res.status === 404) return; // nothing stored yet; a notice follows
      if (res.status === 403) { rejectToken(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (disposed || ws !== sock) return;
      if (epoch !== docEpoch) { st.refetch = true; return; } // TD counted this frame as fetched and will not re-announce it

      const r = decodeFrame(buf);
      if (!r.ok || r.frame.type !== FRAME_BASE || r.frame.slot !== input) return;
      adoptInputSize(input, r.frame.docW, r.frame.docH); // BASE docW/docH = the input's size, not the document's
      engine.writeInput(input, { x: r.frame.x, y: r.frame.y, w: r.frame.w, h: r.frame.h }, r.frame.payload);
      if (r.frame.frameEnd) engine.commitInput(input);
    } catch {
      if (disposed || ws !== sock) return;
      if (attempt === 0) {
        await new Promise<void>((resolve) => { retryTimer = setTimeout(() => { retryTimer = null; resolve(); }, FETCH_RETRY_MS); });
        if (!disposed && ws === sock) await fetchBase(input, st, 1);
      } else {
        // Give up on this notice; ask TD to announce the stored frame again later.
        requestTimer = setTimeout(() => { requestTimer = null; sendJson({ t: 'requestBase' }); }, REQUEST_BASE_MS);
      }
    } finally {
      clearTimeout(timeout);
      aborts.delete(ctrl);
    }
  }

  const dbg: Record<string, unknown> = { connects: 0, closes: 0, sched: 0, skipped: '', lastClose: null, url: '' };
  (globalThis as { __bridgeDbg?: unknown }).__bridgeDbg = dbg;   // diagnostics for the live validation (read through the test hook)
  function scheduleReconnect() {
    dbg.sched = (dbg.sched as number) + 1;
    if (disposed || rejected || gone404 || reconnectTimer) { dbg.skipped = `disposed=${disposed} rejected=${rejected} gone404=${gone404} timer=${!!reconnectTimer}`; return; }
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
    backoff = Math.min(BACKOFF_MAX, backoff * 2);
  }

  function connect() {
    if (disposed) return;
    let sock: WebSocket;
    try {
      sock = new WS(url);
    } catch {
      status.setConnection('reconnecting');
      scheduleReconnect();
      return;
    }
    ws = sock;
    dbg.connects = (dbg.connects as number) + 1;
    dbg.url = url;
    sock.binaryType = 'arraybuffer';
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (ws === sock && sock.readyState === 0) { try { sock.close(); } catch { /* already closing */ } }   // onclose schedules the retry
    }, CONNECT_TIMEOUT_MS);
    sock.onopen = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = setTimeout(() => { helloTimer = null; if (ws === sock) { try { sock.close(); } catch { /* already closing */ } } }, HELLO_TIMEOUT_MS);
      if (ws === sock) sendJson({ t: 'ready', protocol: PROTOCOL_VERSION, client: 'external', version: '0.1.0', token, fresh: !synced });
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      if (typeof ev.data === 'string') onJson(ev.data);
      else if (ev.data instanceof ArrayBuffer || ArrayBuffer.isView(ev.data)) viewClient.handleBinary(ev.data); // v11: VIEW_FAST / VIEW_EXACT; other frame types are ignored
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      dbg.closes = (dbg.closes as number) + 1;
      dbg.lastClose = (ev as CloseEvent | undefined)?.code ?? null;
      const gone = (ev as CloseEvent | undefined)?.code === 4404 || goneSeen; // v10: no such editor
      goneSeen = false;
      active = false;
      dirty.clear();
      loading = false;
      authoritative = false;
      loadToken++;
      pendingTd = {};
      baseStates.clear();
      previews.clear();
      unacked.clear();
      activeSent = undefined;
      historyDirty = false;
      if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
      knownInputs = [];
      tdCanvas = null;
      endLoadState();
      docEpoch++;
      for (const c of aborts) c.abort();
      failPending('Disconnected from TouchDesigner');
      viewClient.reset();
      lastViewKey = '';
      if (viewTimer) { clearTimeout(viewTimer); viewTimer = null; }
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
      status.setConnection('reconnecting');
      status.setActive(true); // offline: keep editing locally, no standby overlay
      if (gone) { gone404 = true; status.onEditorGone?.(); return; }
      scheduleReconnect();
    };
  }

  /** v10: make TD current before this session is closed (tab switch): pending doc + dirty surfaces + active layer go out, then the history upload completes. */
  const waitInflight = (ms: number) => (inflight.size
    ? Promise.race([Promise.allSettled([...inflight]), new Promise<void>((r) => setTimeout(r, ms))])
    : Promise.resolve());
  const track = <T,>(p: Promise<T>): Promise<T> => { inflight.add(p); const done = () => { inflight.delete(p); }; p.then(done, done); return p; };

  const hasUnsent = () => offlineEdits || (canSend() && isOpen() && (dirty.size > 0 || docPending || historyDirty || lastDocRev !== engine.docSpec().rev));

  async function flushPending(): Promise<FlushResult> {
    if (disposed) return 'ok';
    try {
      if (inflight.size) await waitInflight(INFLIGHT_WAIT_MS); // a Flatten / Merge / TOP import that is still running lands in the document first
      if (!isOpen()) return offlineEdits ? 'dropped' : 'ok';
      // the document may change while the history upload is awaited: flush again until nothing is pending (bounded)
      for (let round = 0; round < 3; round++) {
        if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
        if (canSend() && isOpen()) {
          if (docPending || lastDocRev !== engine.docSpec().rev) sendDocNow();
          if (dirty.size) flush(true);
          const id = engine.activeLayerId();
          if (id !== activeSent && !(id === null && activeSent === undefined)) { activeSent = id; sendJson({ t: 'activeLayer', id }); }
        }
        if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
        if (needsHistoryUpload(true)) await uploadHistory(true);
        else await historyChain;
        if (!(canSend() && isOpen() && (dirty.size > 0 || docPending || lastDocRev !== engine.docSpec().rev))) break;
      }
      return isOpen() ? 'ok' : offlineEdits ? 'dropped' : 'ok';
    } catch { return 'ok'; /* best effort */ }
  }

  status.setConnection('reconnecting');
  connect();
  const stopLogs = opts.forwardLogs === false ? () => {} : installLogForwarding(sendJson);

  return {
    editor,
    flush: flushPending,
    hasUnsent,
    takeover: () => {
      if (isOpen()) sendJson({ t: 'takeover' });
      else status.setNotice('Not connected to TouchDesigner');
    },
    refreshView() {
      if (viewState && isOpen()) sendView(true); // re-subscribe: TD answers with a fresh frame (after a GPU context restore)
    },
    setView(v) {
      if (!(v.rect.w > 0 && v.rect.h > 0)) return; // layout not measured yet
      viewState = v;
      viewDirty = true;
      if (viewQueued) return;
      viewQueued = true;
      raf(() => {
        viewQueued = false;
        if (!disposed && viewDirty) sendView(false);
      });
    },
    listTops,
    importTop: (path) => track(importTop(path)),
    renderLayer: (id, mode) => track(renderLayer(id, mode)),
    renderLayers: (ids) => track(renderLayers(ids)),
    setCanvas,
    saveProject: (path, opts) => fileOp('saveProject', path, opts),
    clearStoredHistory,
    openProject: (path) => fileOp('openProject', path),
    exportPng: (path) => fileOp('exportPng', path),
    chooseFile,
    dispose() {
      disposed = true;
      viewClient.dispose();
      if (viewTimer) clearTimeout(viewTimer);
      failPending('Bridge closed');
      offEngine();
      stopLogs();
      if (sendTimer) clearTimeout(sendTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (connectTimer) clearTimeout(connectTimer);
      if (helloTimer) clearTimeout(helloTimer);
      for (const c of aborts) c.abort();
      if (loadRetry) clearTimeout(loadRetry);
      if (retryTimer) clearTimeout(retryTimer);
      if (requestTimer) clearTimeout(requestTimer);
      if (historyTimer) clearTimeout(historyTimer);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}

const LOG_PER_SECOND = 20;

/** Forwards window.onerror, unhandled rejections and console.error to TD as `log`, at most 20 per second. */
type EventHost = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export function installLogForwarding(send: (m: WebMessage) => void, now: () => number = Date.now, win: EventHost = window): () => void {
  let windowStart = 0, count = 0, inSend = false;
  const forward = (msg: string) => {
    if (inSend) return;
    const t = now();
    if (t - windowStart >= 1000) { windowStart = t; count = 0; }
    if (++count > LOG_PER_SECOND) return;
    inSend = true;
    try { send({ t: 'log', level: 'error', msg: msg.slice(0, 2000) }); } finally { inSend = false; }
  };
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    forward(args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' '));
  };
  const onError = (e: ErrorEvent) => forward(`${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  const onReject = (e: PromiseRejectionEvent) => forward(`Unhandled rejection: ${String(e.reason)}`);
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onReject);
  return () => {
    console.error = origError;
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onReject);
  };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}
