import type { EditorEngine, Rect } from '../engine/types';
import {
  FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_VIEW, MAX_BAND_PAYLOAD, PROTOCOL_VERSION,
  decodeFrame, decodeTdMessage, encodeBands, encodeMessage, isStale, type TdMessage, type ViewMode, type ViewRect, type WebMessage,
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
}

export interface ViewState { mode: ViewMode; zoom: number; panX: number; panY: number; rect: ViewRect }

export interface Bridge {
  takeover(): void;
  dispose(): void;
  /** Report viewport state; sent to TD at most once per animation frame. */
  setView(v: ViewState): void;
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
  const raf: (cb: () => void) => unknown = opts.raf ?? (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16));

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

  // doc stack
  let docPending = false, docQueued = false, lastDocRev = -1;
  // view
  let viewState: ViewState | null = null, viewQueued = false, viewDirty = false;
  let viewFetching = false, viewRefetch = false, viewNotice: { frameId: number; applied: number; at: number } | null = null;
  // latency
  const sentAt = new Map<number, number>();
  const samples: number[] = [], viewSamples: number[] = [];

  const isOpen = () => ws !== null && ws.readyState === 1;
  const canSend = () => active && authoritative && !loading && !loadPending;
  const sendJson = (m: WebMessage) => { if (isOpen()) ws!.send(encodeMessage(m)); };

  const markFull = (slots: number[] = engine.surfaceSlots()) => {
    for (const slot of slots) if (!unsafe.has(slot)) dirty.set(slot, { x: 0, y: 0, w: engine.width, h: engine.height });
    schedule();
  };

  function sendDocNow() {
    docPending = false;
    if (!isOpen()) return;
    const spec = engine.docSpec();
    if (spec.rev === lastDocRev) return;
    lastDocRev = spec.rev;
    tdRev = spec.rev;
    sendJson({ t: 'doc', rev: spec.rev, layers: spec.layers });
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
      const x1 = Math.min(engine.width, Math.ceil(r.x + r.w)), y1 = Math.min(engine.height, Math.ceil(r.y + r.h));
      if (x1 <= x0 || y1 <= y0) continue;
      const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const n = rect.w * rect.h * 4;
      if (scratch.length < n) scratch = new Uint8ClampedArray(n);
      const pixels = engine.readSurface(slot, rect, scratch.subarray(0, n));
      const id = frameId;
      frameId = (frameId + 1) >>> 0;
      sentAt.set(id, now());
      if (sentAt.size > SENT_KEEP) sentAt.delete(sentAt.keys().next().value!);
      for (const band of encodeBands({ type: FRAME_SURFACE, slot, frameId: id, docW: engine.width, docH: engine.height, rect, pixels, maxPayload: MAX_BAND_PAYLOAD })) {
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
      case 'docspec': if (canSend()) queueDoc(); break;
      case 'resize': if (canSend()) { queueDoc(); markFull(); } break;
      default: break;
    }
  });

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
      engine.loadDocument({ rev: m.rev, width: m.docW, height: m.docH, layers: m.layers });
      const slots: number[] = [];
      for (const l of m.layers) {
        if (l.slot !== null && l.slot !== undefined) slots.push(l.slot);
        if (l.mask) slots.push(l.mask.slot);
      }
      let next = 0;
      const failed: number[] = [];
      const worker = async () => {
        while (next < slots.length && my === loadToken && !disposed) {
          const slot = slots[next++];
          if (!(await fetchSurface(slot, sock, my)) && my === loadToken) failed.push(slot);
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
        lastDocRev = engine.docSpec().rev;
        if (complete) {
          loadIncomplete = false;
          synced = true;
          authoritative = true;
          tdRev = m.rev;
          endLoadState();
          if (viewState) sendView();
        } else if (loadPending && !disposed) {
          armLoadRetry(); // stay non-authoritative; ask TD again
          status.setNotice('Loading document from TouchDesigner… (retrying)');
        }
      }
    }
  }

  /** True when the slot is settled: loaded, or TD has no pixels for it (404 = loaded-empty). False = failed. */
  async function fetchSurface(slot: number, sock: WebSocket | null, my: number): Promise<boolean> {
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
        if (!r.ok || r.frame.type !== FRAME_SURFACE_DUMP || isStale(r.frame, engine.width, engine.height)) return false;
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
        if (m.doc.w !== engine.width || m.doc.h !== engine.height) engine.resize(m.doc.w, m.doc.h);
        // Another client edited TD's document while this page was away: reload instead of overwriting.
        const newer = synced && m.rev !== null && tdRev !== null && m.rev > tdRev;
        const needsLoad = m.hasDocument && (!synced || loadIncomplete || newer);
        setActive(m.active);
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
        if (m.w !== engine.width || m.h !== engine.height) engine.resize(m.w, m.h);
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
    }
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
      if (!r.ok || r.frame.type !== FRAME_BASE || isStale(r.frame, engine.width, engine.height)) return;
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
      endLoadState();
      docEpoch++;
      for (const c of aborts) c.abort();
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
        if (!disposed && viewDirty && !loading) sendView();
      });
    },
    dispose() {
      disposed = true;
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
