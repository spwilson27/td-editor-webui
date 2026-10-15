import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_TOP, FRAME_VIEW, decodeFrame, decodeWebMessage, encodeFrame, encodeMessage, isStale,
  type Frame, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';
import type { LayerSpec } from '../../src/engine/types';

export interface FakeTdOptions { token?: string; w: number; h: number; active?: boolean; hasInput?: boolean; maxSendFps?: number; fonts?: string[] }

export interface FakeTop { path: string; w: number; h: number; rgba: Uint8Array }

/**
 * A stand-in for the TouchDesigner web server DAT (protocol v4): WebSocket for JSON and SURFACE tiles (stored per
 * slot with the last `doc`), HTTP `GET /base` / `/surface` / `/view` / `/top`; `fonts` after `hello`; `listTops` / `importTop` over a registry of fake TOPs; `applied` replies per finished SURFACE frame.
 */
export class FakeTd {
  messages: WebMessage[] = [];
  frames: Frame[] = [];
  frameEnds = 0;
  /** Stored document (last `doc` from the active client) and surface buffers (straight RGBA, doc sized). */
  doc: { rev: number; layers: LayerSpec[] } | null = null;
  docMessages = 0;
  surfaces = new Map<number, Uint8ClampedArray>();
  /** Drop the `applied` reply (to test missing latency data). */
  autoApplied = true;
  surfaceFetches: number[] = [];
  /** Force every /surface response to this status (500 etc.) instead of serving the buffer. */
  surfaceStatus: number | null = null;
  /** Delay the docState reply (a slow TouchDesigner). */
  docStateDelayMs = 0;
  requestDocs = 0;
  /** v4: TOPs the project 'contains' (listTops / importTop) and snapshots waiting for GET /top. */
  tops: FakeTop[] = [];
  topSnapshots = new Map<string, Uint8Array>();
  topFetches: string[] = [];
  /** Hold topReady for this long (a slow readback). */
  topDelayMs = 0;
  viewFetches: { frameId: number; status: number }[] = [];
  viewSubscribed = false;
  lastView: Extract<WebMessage, { t: 'view' }> | null = null;
  private viewStored: { id: number; bytes: Uint8Array; applied: number } | null = null;
  private viewPending = false;
  private nextViewId = 1;
  private lastSurfaceFrameId = -1;
  private tdFrame = 0;
  client: WebSocket | null = null;
  connections = 0;
  rejected = 0;
  token: string;
  clientId = '';
  w: number;
  h: number;
  active: boolean;

  /** BASE delivery bookkeeping. */
  noticesSent: number[] = [];
  fetches: { frameId: number; status: number; origin?: string; acao?: string }[] = [];
  badFetches = 0;
  /** Force every /base response to this status (404 / 403) instead of serving the frame. */
  baseStatus: number | null = null;
  /** Hold /base responses for this long (to race them against docSize). */
  baseDelayMs = 0;

  private nextFrameId = 1;
  private stored: { id: number; bytes: Uint8Array } | null = null;
  private pending = false;
  private clientSeq = 0;

  private constructor(private http: Server, private wss: WebSocketServer, private opts: FakeTdOptions) {
    this.token = opts.token ?? 'tok-e2e';
    this.w = opts.w;
    this.h = opts.h;
    this.active = opts.active ?? true;
    wss.on('connection', (ws) => this.onConnection(ws));
    http.on('request', (req, res) => this.onHttp(req, res));
  }

  static async start(opts: FakeTdOptions): Promise<FakeTd> {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    return new FakeTd(http, wss, opts);
  }

  get port(): number { return (this.http.address() as { port: number }).port; }
  get url(): string { return `ws://127.0.0.1:${this.port}/ws`; }

  /** TD's rule: CORS headers only for loopback origins (echoed, with Vary: Origin); none otherwise and none for same-origin. */
  static corsHeaders(origin: string | undefined): Record<string, string> {
    if (origin && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
      return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    return {};
  }

  private onHttp(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(readFileSync(resolve(process.cwd(), '../dist/ui/index.html')));
      return;
    }
    const cors = FakeTd.corsHeaders(req.headers.origin);
    const q = u.searchParams;
    if (u.pathname === '/top') {
      if (q.get('token') !== this.token || q.get('client') !== this.clientId) { this.badFetches++; res.writeHead(403, cors).end(); return; }
      const id = q.get('requestId') ?? '';
      this.topFetches.push(id);
      const body = this.topSnapshots.get(id);
      res.writeHead(body ? 200 : 404, { ...cors, 'Content-Type': 'application/octet-stream' });
      res.end(body ? Buffer.from(body) : undefined);
      return;
    }
    if (u.pathname === '/surface' || u.pathname === '/view') {
      if (q.get('token') !== this.token || q.get('client') !== this.clientId) { this.badFetches++; res.writeHead(403, cors).end(); return; }
      const send = (status: number, body?: Uint8Array) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/octet-stream' }); res.end(body ? Buffer.from(body) : undefined); };
      if (u.pathname === '/surface') {
        const slot = Number(q.get('slot'));
        this.surfaceFetches.push(slot);
        if (this.surfaceStatus !== null) { send(this.surfaceStatus); return; }
        const buf = this.surfaces.get(slot);
        if (!buf) { send(404); return; }
        send(200, encodeFrame({ type: FRAME_SURFACE_DUMP, frameEnd: true, slot, frameId: 1, docW: this.w, docH: this.h, x: 0, y: 0, w: this.w, h: this.h }, buf));
        return;
      }
      this.viewFetches.push({ frameId: Number(q.get('frameId')), status: this.viewStored ? 200 : 404 });
      this.viewPending = false;
      if (!this.viewStored) { send(404); return; }
      const served = this.viewStored;
      send(200, served.bytes);
      if (this.viewStored.id > served.id) this.announceView();
      return;
    }
    if (u.pathname !== '/base') { res.writeHead(404, cors).end(); return; }
    const answer = (status: number, body?: Uint8Array) => {
      this.fetches.push({ frameId: Number(q.get('frameId')), status, origin: req.headers.origin, acao: cors['Access-Control-Allow-Origin'] });
      res.writeHead(status, { ...cors, 'Content-Type': 'application/octet-stream' });
      res.end(body ? Buffer.from(body) : undefined);
    };
    if (q.get('token') !== this.token || q.get('client') !== this.clientId) { this.badFetches++; answer(403); return; }
    setTimeout(() => {
      if (this.baseStatus !== null) { answer(this.baseStatus); this.pending = false; return; }
      if (!this.stored) { answer(404); this.pending = false; return; }
      const served = this.stored;
      answer(200, served.bytes);
      this.pending = false;
      if (this.stored.id > served.id) this.announce(); // a newer frame arrived meanwhile
    }, this.baseDelayMs);
  }

  private announce() {
    if (!this.client || !this.stored) return;
    if (this.pending) return; // one un-fetched notice per client; the stored frame is simply newer
    this.pending = true;
    this.noticesSent.push(this.stored.id);
    this.send({ t: 'base', frameId: this.stored.id, docW: this.w, docH: this.h, x: 0, y: 0, w: this.w, h: this.h });
  }

  private onConnection(ws: WebSocket) {
    this.client = ws;
    this.connections++;
    this.pending = false;
    this.viewPending = false;
    this.viewSubscribed = false;
    this.clientId = `client-${++this.clientSeq}`;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = decodeWebMessage(data.toString());
        if (!m) return;
        this.messages.push(m);
        if (m.t === 'ready') {
          if (m.token !== this.token) {
            this.rejected++;
            this.send({ t: 'error', msg: 'bad token' });
            ws.close();
            return;
          }
          this.send(this.hello());
          if (this.opts.fonts) this.send({ t: 'fonts', families: this.opts.fonts });
          if (this.stored) this.announce();
        }
        if (m.t === 'requestBase') { this.pending = false; this.announce(); }
        if (m.t === 'doc' && this.active) { this.doc = { rev: m.rev, layers: m.layers }; this.docMessages++; this.syncSlots(m.layers); }
        if (m.t === 'requestDoc') this.requestDocs++;
        if (m.t === 'listTops') this.send({ t: 'tops', requestId: m.requestId, items: this.tops.map(({ path, w, h }) => ({ path, w, h })) });
        if (m.t === 'importTop') {
          const top = this.tops.find((x) => x.path === m.path);
          if (!top) this.send({ t: 'topError', requestId: m.requestId, msg: `No TOP at ${m.path}` });
          else if (top.w > 8192 || top.h > 8192) this.send({ t: 'topError', requestId: m.requestId, msg: 'TOP is larger than 8192x8192' });
          else {
            this.topSnapshots.set(m.requestId, encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: top.w, docH: top.h, x: 0, y: 0, w: top.w, h: top.h }, top.rgba));
            setTimeout(() => this.send({ t: 'topReady', requestId: m.requestId, w: top.w, h: top.h }), this.topDelayMs);
          }
        }
        if (m.t === 'requestDoc' && this.doc) {
          const doc = this.doc;
          setTimeout(() => this.send({ t: 'docState', rev: doc.rev, layers: doc.layers, docW: this.w, docH: this.h }), this.docStateDelayMs);
        }
        if (m.t === 'view') {
          this.lastView = m;
          this.viewSubscribed = m.mode === 'td';
          if (this.viewSubscribed) { this.viewPending = false; this.announceView(); }
        }
        if (m.t === 'takeover') { this.active = true; this.send({ t: 'active', active: true }); }
        return;
      }
      const buf = data as Buffer;
      const r = decodeFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (!r.ok || r.frame.type !== FRAME_SURFACE || !this.active || isStale(r.frame, this.w, this.h)) return;
      const f = r.frame;
      const surface = this.surfaces.get(f.slot);
      if (!surface) return; // TD drops SURFACE frames for slots it does not know from the last `doc`
      this.frames.push({ ...f, payload: f.payload.slice() });
      for (let row = 0; row < f.h; row++) {
        surface.set(f.payload.subarray(row * f.w * 4, (row + 1) * f.w * 4), ((f.y + row) * this.w + f.x) * 4);
      }
      if (f.frameEnd) {
        this.frameEnds++;
        this.lastSurfaceFrameId = f.frameId;
        if (this.autoApplied) this.send({ t: 'applied', frameId: f.frameId, tdFrame: ++this.tdFrame });
      }
    });
    ws.on('close', () => { if (this.client === ws) this.client = null; });
  }

  hello(): TdMessage {
    return {
      t: 'hello', protocol: 4, doc: { w: this.w, h: this.h }, hasInput: this.opts.hasInput ?? false, maxSendFps: this.opts.maxSendFps ?? 30,
      active: this.active, clientId: this.clientId, hasDocument: this.doc !== null, rev: this.doc?.rev ?? null,
    };
  }

  /** Allocate / free surface buffers for the slots a `doc` lists (pixel + mask), like the generated Script TOPs. */
  private syncSlots(layers: LayerSpec[]) {
    const want = new Set<number>();
    for (const l of layers) { if (l.slot !== null) want.add(l.slot); if (l.mask) want.add(l.mask.slot); }
    for (const slot of want) if (!this.surfaces.has(slot)) this.surfaces.set(slot, new Uint8ClampedArray(this.w * this.h * 4));
    for (const slot of [...this.surfaces.keys()]) if (!want.has(slot)) this.surfaces.delete(slot);
  }

  /** Pre-load a stored document as if TouchDesigner had restored it from its .toe (for the fresh-page load flow). */
  seedDocument(layers: LayerSpec[], rev = 1, fill: Record<number, [number, number, number, number]> = {}) {
    this.doc = { rev, layers };
    this.syncSlots(layers);
    for (const [slot, rgba] of Object.entries(fill)) {
      const buf = this.surfaces.get(Number(slot))!;
      for (let i = 0; i < buf.length; i += 4) buf.set(rgba, i);
    }
  }

  surfacePixel(slot: number, x: number, y: number): number[] {
    const i = (y * this.w + x) * 4;
    return Array.from(this.surfaces.get(slot)!.subarray(i, i + 4));
  }

  /** Store a whole-document TD output image; announced as a `view` notice to subscribed (external TD-mode) clients. */
  setViewImage(rgba: Uint8Array) {
    const id = this.nextViewId++;
    const bytes = encodeFrame({ type: FRAME_VIEW, frameEnd: true, slot: 0, frameId: id, docW: this.w, docH: this.h, x: 0, y: 0, w: this.w, h: this.h }, rgba);
    this.viewStored = { id, bytes, applied: this.lastSurfaceFrameId };
    this.announceView();
  }

  private announceView() {
    if (!this.client || !this.viewStored || !this.viewSubscribed || this.viewPending) return;
    this.viewPending = true;
    this.send({ t: 'view', frameId: this.viewStored.id, docW: this.w, docH: this.h, w: this.w, h: this.h, appliedFrameId: this.viewStored.applied });
  }

  send(m: TdMessage) { this.client?.send(encodeMessage(m)); }

  setActive(active: boolean) { this.active = active; this.send({ t: 'active', active }); }

  /** Like TD: the old frame is gone and any outstanding notice is void until a base is stored again. */
  resize(w: number, h: number) {
    this.w = w; this.h = h;
    for (const slot of this.surfaces.keys()) this.surfaces.set(slot, new Uint8ClampedArray(w * h * 4));
    this.stored = null;
    this.pending = false;
    this.send({ t: 'docSize', w, h, hasInput: true });
  }

  /** Stores a whole-document BASE frame (replacing any older one) and announces it if no notice is outstanding. */
  setBase(rgba: Uint8Array) {
    const id = this.nextFrameId++;
    const bytes = encodeFrame({ type: FRAME_BASE, frameEnd: true, slot: 0, frameId: id, docW: this.w, docH: this.h, x: 0, y: 0, w: this.w, h: this.h }, rgba);
    this.stored = { id, bytes };
    this.announce();
  }

  sendSolidBase(r: number, g: number, b: number) {
    const px = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
    this.setBase(px);
  }

  dropClient() { this.client?.terminate(); }

  async waitFor(pred: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('FakeTd.waitFor timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async close() {
    for (const c of this.wss.clients) c.terminate();
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.wss.close(() => this.http.close(() => r())));
  }
}
