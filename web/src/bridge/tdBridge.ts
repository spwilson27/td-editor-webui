import type { CanvasMode, EditorEngine, LayerSpec, Rect } from '../engine/types';
import {
  FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_TOP, FRAME_VIEW, MAX_BAND_PAYLOAD, PROTOCOL_VERSION,
  decodeFrame, decodeTdMessage, encodeBands, encodeMessage, isStale, type TdMessage, type TopItem, type ViewMode, type ViewRect, type WebMessage,
} from './codec';

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
  /** An image of TD's output for the external TD view: straight RGBA, document sized; `ageMs` = notice to display. */
  setViewFrame?(w: number, h: number, rgba: Uint8ClampedArray, ageMs: number): void;
  /** v4: TD's font family list (sent after hello). */
  setFonts?(families: string[]): void;
}

export interface ViewState { mode: ViewMode; zoom: number; panX: number; panY: number; rect: ViewRect }

export interface Bridge {
  takeover(): void;
  dispose(): void;
  /** Report viewport state; sent to TD at most once per animation frame. */
  setView(v: ViewState): void;
  /** v4: the importable TOPs of the TD project. Rejects when not linked, on a timeout or when TD answers with an error. */
  listTops(): Promise<TopItem[]>;
  /** v4: snapshot a TOP once and add it as a pixel layer (engine.importImage). Resolves with the new layer id. */
  importTop(path: string): Promise<string>;
  /** v5 Flatten: TD renders the text/shape layer alone at document size, the pixels replace the layer (engine.replaceWithPixels). */
  renderLayer(layerId: string): Promise<void>;
  /** v5: tell TD the canvas size / mode (active, loaded page only). Returns false when nothing was sent. */
  setCanvas(w: number, h: number, mode: CanvasMode): boolean;
}

export interface TdBridgeOptions {
  url?: string;
  client?: 'panel' | 'external';
  token?: string;
  version?: string;
  WebSocketCtor?: typeof WebSocket;
  forwardLogs?: boolean;
  now?: () => number;
  fetch?: typeof fetch;
  raf?: (cb: () => void) => unknown;
}

export const BACKPRESSURE_BYTES = 8 * 1024 * 1024;
export const SURFACE_FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10000, FETCH_RETRY_MS = 500, REQUEST_BASE_MS = 2000;
const BACKOFF_MIN = 500, BACKOFF_MAX = 5000, DEFAULT_FPS = 30;
const LOAD_RETRY_MIN = 2000, LOAD_RETRY_MAX = 10000, NO_DOC_FALLBACK_MS = 10000;
const LATENCY_WINDOW = 60, SENT_KEEP = 512;
export const RENDER_LAYER_TIMEOUT_MS = 30000;
export const LIST_TOPS_TIMEOUT_MS = 10000, IMPORT_TOP_TIMEOUT_MS = 30000;

export function resolveWsUrl(search: string, loc: { protocol: string; host: string }): string {
  const override = new URLSearchParams(search).get('ws');
  if (override) return override;
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

export function resolveToken(search: string): string {
  return new URLSearchParams(search).get('token') ?? '';
}

export const TOKEN_EXPIRED_MESSAGE = 'Reopen from TouchDesigner — session expired';

/** The HTTP origin that serves /base, /surface and /view: same host and port as the WebSocket (so `?ws=` overrides carry over). */
export function httpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}

export function resolveClient(search: string): 'panel' | 'external' {
  return new URLSearchParams(search).get('client') === 'panel' ? 'panel' : 'external';
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
  const url = opts.url ?? resolveWsUrl(location.search, location);
  const client = opts.client ?? resolveClient(location.search);
  const token = opts.token ?? resolveToken(location.search);
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
  let active = false;
  let backoff = BACKOFF_MIN;
  let maxFps = DEFAULT_FPS;
  let frameId = 0;
  let clientId = '';
  let noticeId = 0;
  let fetching = false;
  let refetch = false; // a newer notice arrived while fetching: fetch again, newest wins
  let docEpoch = 0; // bumped by docSize/reconnect/doc load: results fetched before are void
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
  let scratch = new Uint8ClampedArray(0);

  // canvas as TD knows it (last received from / sent to TD): engine changes of any other origin (undo, redo, jumpTo) are sent
  let tdCanvas: { w: number; h: number; mode: CanvasMode } | null = null;
  let adopting = false;
  let pendingTd: { size?: Extract<TdMessage, { t: 'docSize' }>; base?: { w: number; h: number } } = {};
  // doc stack
  let docPending = false, docQueued = false, lastDocRev = -1;
  // view
  let viewState: ViewState | null = null, viewQueued = false, viewDirty = false;
  let viewFetching = false, viewRefetch = false, viewNotice: { frameId: number; applied: number; at: number } | null = null;
  // v4 TOP import
  let requestSeq = 0;
  const pendingTops = new Map<string, { resolve: (items: TopItem[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingImports = new Map<string, { resolve: (w: number, h: number) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const failPending = (msg: string) => {
    for (const p of pendingTops.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    for (const p of pendingImports.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
    pendingTops.clear();
    pendingImports.clear();
  };
  // latency
  const sentAt = new Map<number, number>();
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
  const baseSize = (): { w: number; h: number } => {
    const b = engine.layers().find((l) => l.kind === 'base');
    return { w: b?.surfaceW ?? engine.width, h: b?.surfaceH ?? engine.height };
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
    sendJson({ t: 'doc', rev: spec.rev, layers: spec.layers, guides: spec.guides, canvas: spec.canvas });
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
    sendTimer = setTimeout(flush, wait);
  }

  function flush() {
    sendTimer = null;
    if (!dirty.size || !canSend() || !isOpen()) return;
    if (ws!.bufferedAmount > BACKPRESSURE_BYTES) { sendTimer = setTimeout(flush, 1000 / maxFps); return; }
    if (docPending) sendDocNow(); // TD drops surfaces of slots it has not seen in a `doc`
    lastSend = now();
    for (const [slot, r] of [...dirty]) {
      if (ws!.bufferedAmount > BACKPRESSURE_BYTES) break;
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
      if (sentAt.size > SENT_KEEP) sentAt.delete(sentAt.keys().next().value!);
      for (const band of encodeBands({ type: FRAME_SURFACE, slot, frameId: id, docW: sz.w, docH: sz.h, rect, pixels, maxPayload: MAX_BAND_PAYLOAD })) {
        ws!.send(band as BufferSource);
      }
    }
    if (dirty.size) schedule();
  }

  const offEngine = engine.on((e) => {
    if (loading) return;
    switch (e.type) {
      case 'surface':
        if (canSend() && !unsafe.has(e.slot)) { dirty.set(e.slot, unionRect(dirty.get(e.slot), e.rect)); schedule(); }
        break;
      case 'docspec': if (canSend()) { queueDoc(); syncCanvas(); } break;
      case 'resize': if (canSend()) { queueDoc(); syncCanvas(); } break; // v5: the canvas size never reallocates surfaces
      default: break;
    }
  });

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
    endLoadState();
    authoritative = true;
    synced = true;
    docPending = true;
    lastDocRev = -1;
    if (isOpen()) sendDocNow();
    markFull();
  }

  function setActive(a: boolean) {
    active = a;
    status.setActive(a);
    if (!a) {
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
    unsafe.clear();
    const sock = ws;
    let complete = false;
    try {
      engine.loadDocument({ rev: m.rev, width: m.docW, height: m.docH, layers: m.layers, guides: m.guides, canvas: m.canvas });
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
        if (complete) { // TD changes that arrived mid-load: applied while still not authoritative, so nothing is pushed back
          tdCanvas = { w: m.docW, h: m.docH, mode: m.canvas.mode };
          const pend = pendingTd;
          pendingTd = {};
          if (pend.size) adoptCanvas(pend.size.w, pend.size.h, pend.size.mode);
          if (pend.base) applyBaseSize(pend.base.w, pend.base.h);
        }
        dirty.clear();
        lastDocRev = engine.docSpec().rev;
        if (complete) {
          loadIncomplete = false;
          synced = true;
          authoritative = true;
          tdRev = m.rev;
          endLoadState();
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

  const query = (extra = '') => `token=${encodeURIComponent(token)}&client=${encodeURIComponent(clientId)}${extra}`;

  // ---- viewport state ----

  function sendView() {
    viewDirty = false;
    if (!viewState || !isOpen()) return;
    sendJson({ t: 'view', ...viewState });
  }

  function onJson(text: string) {
    const m = decodeTdMessage(text);
    if (!m) return;
    switch (m.t) {
      case 'hello': {
        if (m.protocol !== PROTOCOL_VERSION) { status.setNotice(`Protocol mismatch (TD ${m.protocol})`); return; }
        backoff = BACKOFF_MIN;
        clientId = m.clientId;
        maxFps = m.maxSendFps > 0 ? m.maxSendFps : DEFAULT_FPS;
        status.setConnection('linked');
        active = false;
        authoritative = false;
        tdHasDocument = m.hasDocument;
        adoptCanvas(m.doc.w, m.doc.h, m.doc.mode ?? engine.canvasMode());
        // Another client edited TD's document while this page was away: reload instead of overwriting.
        const newer = synced && m.rev !== null && tdRev !== null && m.rev > tdRev;
        const needsLoad = m.hasDocument && (!synced || loadIncomplete || newer);
        setActive(m.active);
        if (m.baseSize) {
          docEpoch++;
          if (m.active && needsLoad) pendingTd.base = m.baseSize; // applied when the load completes
          else applyBaseSize(m.baseSize.w, m.baseSize.h);
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
        if (loading || loadPending) { pendingTd.size = m; break; } // never adopt mid-load: applied when the load completes
        adoptCanvas(m.w, m.h, m.mode);
        break;
      case 'baseSize':
        docEpoch++;
        if (loading || loadPending) { pendingTd.base = { w: m.w, h: m.h }; break; }
        applyBaseSize(m.w, m.h);
        break;
      case 'base':
        noticeId = m.frameId;
        pullBase();
        break;
      case 'view':
        viewNotice = { frameId: m.frameId, applied: m.appliedFrameId, at: now() };
        pullView();
        break;
      case 'applied': {
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
      case 'error':
        if (/token/i.test(m.msg)) rejectToken();
        else status.setNotice(m.msg);
        break;
      case 'fonts':
        status.setFonts?.(m.families);
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

  /** v5: the TD Input resolution changed; the base surface follows (no history). 0x0 = no input (the engine keeps an empty placeholder). */
  function applyBaseSize(w: number, h: number) {
    if (w < 0 || h < 0) return;
    const cur = baseSize();
    if (cur.w === w && cur.h === h) return;
    engine.setBaseSize?.(w, h);
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
    if (disposed || epoch !== docEpoch) throw new Error('The document changed during the import');
    const name = path.split('/').filter(Boolean).pop() ?? 'TOP';
    return engine.importImage(frame.payload, frame.w, frame.h, name);
  }

  /** v5 Flatten: renderLayer → topReady → GET /top (document-sized) → engine.replaceWithPixels. */
  async function renderLayer(layerId: string): Promise<void> {
    if (!isOpen() || !clientId) throw new Error('Not connected to TouchDesigner');
    const requestId = `r${++requestSeq}`;
    const sock = ws;
    const fingerprint = () => {
      const l = engine.layers().find((x) => x.id === layerId);
      return l ? JSON.stringify([l.kind, l.text, l.shape, engine.width, engine.height]) : null;
    };
    const before = fingerprint();
    if (canSend() && lastDocRev !== engine.docSpec().rev) sendDocNow(); // TD must render the layer as the page has it now
    await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const timer = setTimeout(() => { pendingImports.delete(requestId); reject(new Error('TouchDesigner did not answer')); }, RENDER_LAYER_TIMEOUT_MS);
      pendingImports.set(requestId, { resolve: (w, h) => resolve({ w, h }), reject, timer });
      sendJson({ t: 'renderLayer', requestId, layerId });
    });
    const frame = await fetchTop(requestId, sock);
    if (disposed) throw new Error('Bridge closed');
    const l = engine.layers().find((x) => x.id === layerId);
    if (!l || (l.kind !== 'text' && l.kind !== 'shape') || fingerprint() !== before) throw new Error('The layer changed during Flatten');
    engine.replaceWithPixels(layerId, frame.payload, frame.w, frame.h);
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
        if (disposed || ws !== sock) throw new Error('Disconnected from TouchDesigner');
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
    status.setNotice(`TOP fetch failed: ${lastErr}`);
    throw new Error(lastErr);
  }

  function rejectToken() {
    rejected = true;
    (status.setFatal ?? status.setNotice)(TOKEN_EXPIRED_MESSAGE);
  }

  /** BASE frames are pulled over HTTP (never the WebSocket): one fetch in flight, a newer notice just triggers one more. */
  function pullBase() {
    if (fetching) { refetch = true; return; }
    fetching = true;
    void fetchBase(0).finally(() => {
      fetching = false;
      if (refetch && !disposed) { refetch = false; pullBase(); }
    });
  }

  async function fetchBase(attempt: number): Promise<void> {
    const sock = ws, epoch = docEpoch;
    const ctrl = new AbortController();
    aborts.add(ctrl);
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${httpBase}/base?${query(`&frameId=${noticeId}`)}`, { cache: 'no-store', signal: ctrl.signal });
      if (res.status === 404) return; // nothing stored yet; a notice follows
      if (res.status === 403) { rejectToken(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (disposed || ws !== sock) return;
      if (epoch !== docEpoch) { refetch = true; return; } // TD counted this frame as fetched and will not re-announce it

      const r = decodeFrame(buf);
      if (!r.ok || r.frame.type !== FRAME_BASE) return;
      applyBaseSize(r.frame.docW, r.frame.docH); // v5: BASE docW/docH = the input's size, not the document's
      engine.writeBase({ x: r.frame.x, y: r.frame.y, w: r.frame.w, h: r.frame.h }, r.frame.payload);
      if (r.frame.frameEnd) engine.commitBase();
    } catch {
      if (disposed || ws !== sock) return;
      if (attempt === 0) {
        await new Promise<void>((resolve) => { retryTimer = setTimeout(() => { retryTimer = null; resolve(); }, FETCH_RETRY_MS); });
        if (!disposed && ws === sock) await fetchBase(1);
      } else {
        // Give up on this notice; ask TD to announce the stored frame again later.
        requestTimer = setTimeout(() => { requestTimer = null; sendJson({ t: 'requestBase' }); }, REQUEST_BASE_MS);
      }
    } finally {
      clearTimeout(timeout);
      aborts.delete(ctrl);
    }
  }

  /** VIEW frames (TD's output, external clients in TD mode): same single-flight, newest-wins pull as BASE. */
  function pullView() {
    if (viewFetching) { viewRefetch = true; return; }
    viewFetching = true;
    void fetchView().finally(() => {
      viewFetching = false;
      if (viewRefetch && !disposed) { viewRefetch = false; pullView(); }
    });
  }

  async function fetchView(): Promise<void> {
    const sock = ws, epoch = docEpoch, notice = viewNotice;
    if (!notice) return;
    const ctrl = new AbortController();
    aborts.add(ctrl);
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${httpBase}/view?${query(`&frameId=${notice.frameId}`)}`, { cache: 'no-store', signal: ctrl.signal });
      if (res.status === 404) return;
      if (res.status === 403) { rejectToken(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (disposed || ws !== sock || epoch !== docEpoch) return;
      const r = decodeFrame(buf);
      if (!r.ok || r.frame.type !== FRAME_VIEW || isStale(r.frame, engine.width, engine.height)) return;
      const t = now();
      status.setViewFrame?.(r.frame.w, r.frame.h, new Uint8ClampedArray(r.frame.payload.buffer, r.frame.payload.byteOffset, r.frame.payload.byteLength), t - notice.at);
      if (notice.applied >= 0) {
        const sent = takeSent(notice.applied);
        if (sent !== undefined) recordLatency(viewSamples, t - sent, (x) => status.setViewLatency?.(x));
      }
    } catch {
      if (disposed || ws !== sock) return;
      // A failed fetch leaves the notice un-fetched; re-subscribing makes TD announce the newest frame again.
      requestTimer = setTimeout(() => { requestTimer = null; if (viewState?.mode === 'td') sendView(); }, REQUEST_BASE_MS);
    } finally {
      clearTimeout(timeout);
      aborts.delete(ctrl);
    }
  }

  function scheduleReconnect() {
    if (disposed || rejected || reconnectTimer) return;
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
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      if (ws === sock) sendJson({ t: 'ready', protocol: PROTOCOL_VERSION, client, version: '0.1.0', token, fresh: !synced });
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      if (typeof ev.data === 'string') onJson(ev.data);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      active = false;
      dirty.clear();
      loading = false;
      authoritative = false;
      loadToken++;
      pendingTd = {};
      tdCanvas = null;
      endLoadState();
      docEpoch++;
      for (const c of aborts) c.abort();
      failPending('Disconnected from TouchDesigner');
      viewFetching = viewRefetch = false;
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
      status.setConnection('reconnecting');
      status.setActive(true); // offline: keep editing locally, no standby overlay
      scheduleReconnect();
    };
  }

  status.setConnection('reconnecting');
  connect();
  const stopLogs = opts.forwardLogs === false ? () => {} : installLogForwarding(sendJson);

  return {
    takeover: () => {
      if (isOpen()) sendJson({ t: 'takeover' });
      else status.setNotice('Not connected to TouchDesigner');
    },
    setView(v) {
      if (!(v.rect.w > 0 && v.rect.h > 0)) return; // layout not measured yet
      viewState = v;
      viewDirty = true;
      if (viewQueued) return;
      viewQueued = true;
      raf(() => {
        viewQueued = false;
        if (!disposed && viewDirty) sendView();
      });
    },
    listTops,
    importTop,
    renderLayer,
    setCanvas,
    dispose() {
      disposed = true;
      failPending('Bridge closed');
      offEngine();
      stopLogs();
      if (sendTimer) clearTimeout(sendTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const c of aborts) c.abort();
      if (loadRetry) clearTimeout(loadRetry);
      if (retryTimer) clearTimeout(retryTimer);
      if (requestTimer) clearTimeout(requestTimer);
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
