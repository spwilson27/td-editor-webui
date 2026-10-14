import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FRAME_BASE, FRAME_COMPOSITE, decodeFrame, decodeWebMessage, encodeFrame, encodeMessage, isStale,
  type Frame, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';

export interface FakeTdOptions { token?: string; w: number; h: number; active?: boolean; hasInput?: boolean; maxSendFps?: number }

/**
 * A stand-in for the TouchDesigner web server DAT (protocol v2): WebSocket for JSON and COMPOSITE frames,
 * HTTP `GET /base` for BASE frames announced by at most one un-fetched `base` notice per client.
 */
export class FakeTd {
  messages: WebMessage[] = [];
  frames: Frame[] = [];
  frameEnds = 0;
  composite: Uint8ClampedArray;
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
    this.composite = new Uint8ClampedArray(this.w * this.h * 4);
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
    if (u.pathname !== '/base') { res.writeHead(404, cors).end(); return; }
    const q = u.searchParams;
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
          if (this.stored) this.announce();
        }
        if (m.t === 'requestBase') { this.pending = false; this.announce(); }
        if (m.t === 'takeover') { this.active = true; this.send({ t: 'active', active: true }); }
        return;
      }
      const buf = data as Buffer;
      const r = decodeFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (!r.ok || r.frame.type !== FRAME_COMPOSITE || !this.active || isStale(r.frame, this.w, this.h)) return;
      const f = r.frame;
      this.frames.push({ ...f, payload: f.payload.slice() });
      for (let row = 0; row < f.h; row++) {
        this.composite.set(f.payload.subarray(row * f.w * 4, (row + 1) * f.w * 4), ((f.y + row) * this.w + f.x) * 4);
      }
      if (f.frameEnd) this.frameEnds++;
    });
    ws.on('close', () => { if (this.client === ws) this.client = null; });
  }

  hello(): TdMessage {
    return { t: 'hello', protocol: 2, doc: { w: this.w, h: this.h }, hasInput: this.opts.hasInput ?? false, maxSendFps: this.opts.maxSendFps ?? 30, active: this.active, clientId: this.clientId };
  }

  send(m: TdMessage) { this.client?.send(encodeMessage(m)); }

  setActive(active: boolean) { this.active = active; this.send({ t: 'active', active }); }

  /** Like TD: the old frame is gone and any outstanding notice is void until a base is stored again. */
  resize(w: number, h: number) {
    this.w = w; this.h = h;
    this.composite = new Uint8ClampedArray(w * h * 4);
    this.stored = null;
    this.pending = false;
    this.send({ t: 'docSize', w, h, hasInput: true });
  }

  /** Stores a whole-document BASE frame (replacing any older one) and announces it if no notice is outstanding. */
  setBase(rgba: Uint8Array) {
    const id = this.nextFrameId++;
    const bytes = encodeFrame({ type: FRAME_BASE, frameEnd: true, frameId: id, docW: this.w, docH: this.h, x: 0, y: 0, w: this.w, h: this.h }, rgba);
    this.stored = { id, bytes };
    this.announce();
  }

  sendSolidBase(r: number, g: number, b: number) {
    const px = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
    this.setBase(px);
  }

  pixel(x: number, y: number): number[] { const i = (y * this.w + x) * 4; return Array.from(this.composite.subarray(i, i + 4)); }

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
