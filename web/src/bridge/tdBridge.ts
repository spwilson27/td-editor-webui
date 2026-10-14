import type { EditorEngine, Rect } from '../engine/types';
import {
  FRAME_BASE, FRAME_COMPOSITE, MAX_BAND_PAYLOAD, PROTOCOL_VERSION,
  decodeFrame, decodeTdMessage, encodeBands, encodeMessage, isStale, type WebMessage,
} from './codec';

export type Connection = 'linked' | 'standalone' | 'reconnecting';

export interface BridgeStatus {
  setConnection(c: Connection): void;
  setActive(active: boolean): void;
  setNotice(msg: string): void;
  setFatal?(msg: string): void; // persistent, until reload
}

export interface Bridge { takeover(): void; dispose(): void }

export interface TdBridgeOptions {
  url?: string;
  client?: 'panel' | 'external';
  token?: string;
  version?: string;
  WebSocketCtor?: typeof WebSocket;
  forwardLogs?: boolean;
  now?: () => number;
  fetch?: typeof fetch;
}

export const BACKPRESSURE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000, FETCH_RETRY_MS = 500, REQUEST_BASE_MS = 2000;
const BACKOFF_MIN = 500, BACKOFF_MAX = 5000, DEFAULT_FPS = 30;

export function resolveWsUrl(search: string, loc: { protocol: string; host: string }): string {
  const override = new URLSearchParams(search).get('ws');
  if (override) return override;
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

export function resolveToken(search: string): string {
  return new URLSearchParams(search).get('token') ?? '';
}

export const TOKEN_EXPIRED_MESSAGE = 'Reopen from TouchDesigner — session expired';

/** The HTTP origin that serves /base: same host and port as the WebSocket (so `?ws=` overrides carry over). */
export function httpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}

export function resolveClient(search: string): 'panel' | 'external' {
  return new URLSearchParams(search).get('client') === 'panel' ? 'panel' : 'external';
}

const unionRect = (a: Rect | null, b: Rect): Rect => {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export function startTdBridge(engine: EditorEngine, status: BridgeStatus, opts: TdBridgeOptions = {}): Bridge {
  const url = opts.url ?? resolveWsUrl(location.search, location);
  const client = opts.client ?? resolveClient(location.search);
  const token = opts.token ?? resolveToken(location.search);
  const WS = opts.WebSocketCtor ?? WebSocket;
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const httpBase = httpOrigin(url);
  const now = opts.now ?? (() => performance.now());

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
  let docEpoch = 0; // bumped by docSize/reconnect: results fetched before are void
  let fetchAbort: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let requestTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty: Rect | null = null;
  let lastSend = -Infinity;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let scratch = new Uint8ClampedArray(0);

  const isOpen = () => ws !== null && ws.readyState === 1;
  const sendJson = (m: WebMessage) => { if (isOpen()) ws!.send(encodeMessage(m)); };

  const markFull = () => { dirty = { x: 0, y: 0, w: engine.width, h: engine.height }; schedule(); };

  function schedule() {
    if (sendTimer || !dirty || !active || !isOpen()) return;
    const wait = Math.max(0, lastSend + 1000 / maxFps - now());
    sendTimer = setTimeout(flush, wait);
  }

  function flush() {
    sendTimer = null;
    if (!dirty || !active || !isOpen()) return;
    if (ws!.bufferedAmount > BACKPRESSURE_BYTES) { sendTimer = setTimeout(flush, 1000 / maxFps); return; }
    const x0 = Math.max(0, Math.floor(dirty.x)), y0 = Math.max(0, Math.floor(dirty.y));
    const x1 = Math.min(engine.width, Math.ceil(dirty.x + dirty.w)), y1 = Math.min(engine.height, Math.ceil(dirty.y + dirty.h));
    dirty = null;
    if (x1 <= x0 || y1 <= y0) return;
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const n = rect.w * rect.h * 4;
    if (scratch.length < n) scratch = new Uint8ClampedArray(n);
    const pixels = engine.readComposite(rect, scratch.subarray(0, n));
    const id = frameId;
    frameId = (frameId + 1) >>> 0;
    lastSend = now();
    for (const band of encodeBands({ type: FRAME_COMPOSITE, frameId: id, docW: engine.width, docH: engine.height, rect, pixels, maxPayload: MAX_BAND_PAYLOAD })) {
      ws!.send(band as BufferSource);
    }
  }

  const offEngine = engine.on((e) => {
    if (e.type === 'composite' && active) { dirty = unionRect(dirty, e.rect); schedule(); }
    else if (e.type === 'resize') markFull();
  });

  function setActive(a: boolean) {
    const gained = a && !active;
    active = a;
    status.setActive(a);
    if (gained) markFull();
    if (!a) {
      dirty = null;
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    }
  }

  function onJson(text: string) {
    const m = decodeTdMessage(text);
    if (!m) return;
    switch (m.t) {
      case 'hello':
        if (m.protocol !== PROTOCOL_VERSION) { status.setNotice(`Protocol mismatch (TD ${m.protocol})`); return; }
        backoff = BACKOFF_MIN;
        clientId = m.clientId;
        maxFps = m.maxSendFps > 0 ? m.maxSendFps : DEFAULT_FPS;
        if (m.doc.w !== engine.width || m.doc.h !== engine.height) engine.resize(m.doc.w, m.doc.h);
        status.setConnection('linked');
        active = false;
        setActive(m.active);
        break;
      case 'docSize':
        docEpoch++;
        if (m.w !== engine.width || m.h !== engine.height) engine.resize(m.w, m.h);
        break;
      case 'base':
        noticeId = m.frameId;
        pullBase();
        break;
      case 'active':
        setActive(m.active);
        break;
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
    const q = `token=${encodeURIComponent(token)}&client=${encodeURIComponent(clientId)}&frameId=${noticeId}`;
    const ctrl = new AbortController();
    fetchAbort = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${httpBase}/base?${q}`, { cache: 'no-store', signal: ctrl.signal });
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
      if (fetchAbort === ctrl) fetchAbort = null;
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
      if (ws === sock) sendJson({ t: 'ready', protocol: PROTOCOL_VERSION, client, version: '0.1.0', token });
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      if (typeof ev.data === 'string') onJson(ev.data);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      active = false;
      dirty = null;
      docEpoch++;
      fetchAbort?.abort();
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
    dispose() {
      disposed = true;
      offEngine();
      stopLogs();
      if (sendTimer) clearTimeout(sendTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      fetchAbort?.abort();
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
