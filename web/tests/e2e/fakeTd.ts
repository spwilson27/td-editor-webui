import { WebSocketServer, type WebSocket } from 'ws';
import {
  FRAME_BASE, FRAME_COMPOSITE, decodeFrame, isStale, decodeWebMessage, encodeBands, encodeMessage,
  type Frame, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';

export interface FakeTdOptions { w: number; h: number; active?: boolean; hasInput?: boolean; maxSendFps?: number }

/** A stand-in for the TouchDesigner web server DAT: speaks docs/PROTOCOL.md to one browser client. */
export class FakeTd {
  messages: WebMessage[] = [];
  frames: Frame[] = [];
  frameEnds = 0;
  composite: Uint8ClampedArray;
  client: WebSocket | null = null;
  connections = 0;
  w: number;
  h: number;
  active: boolean;
  private nextFrameId = 1;

  private constructor(private wss: WebSocketServer, private opts: FakeTdOptions) {
    this.w = opts.w;
    this.h = opts.h;
    this.active = opts.active ?? true;
    this.composite = new Uint8ClampedArray(this.w * this.h * 4);
    wss.on('connection', (ws) => this.onConnection(ws));
  }

  static async start(opts: FakeTdOptions): Promise<FakeTd> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    return new FakeTd(wss, opts);
  }

  get url(): string { return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}/ws`; }

  private onConnection(ws: WebSocket) {
    this.client = ws;
    this.connections++;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = decodeWebMessage(data.toString());
        if (!m) return;
        this.messages.push(m);
        if (m.t === 'ready') this.send(this.hello());
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
    return { t: 'hello', protocol: 1, doc: { w: this.w, h: this.h }, hasInput: this.opts.hasInput ?? false, maxSendFps: this.opts.maxSendFps ?? 30, active: this.active };
  }

  send(m: TdMessage) { this.client?.send(encodeMessage(m)); }

  setActive(active: boolean) { this.active = active; this.send({ t: 'active', active }); }

  resize(w: number, h: number) {
    this.w = w; this.h = h;
    this.composite = new Uint8ClampedArray(w * h * 4);
    this.send({ t: 'docSize', w, h, hasInput: true });
  }

  sendBase(rect: { x: number; y: number; w: number; h: number }, rgba: Uint8Array) {
    const id = this.nextFrameId++;
    for (const band of encodeBands({ type: FRAME_BASE, frameId: id, docW: this.w, docH: this.h, rect, pixels: rgba })) this.client?.send(band);
  }

  sendSolidBase(r: number, g: number, b: number) {
    const px = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
    this.sendBase({ x: 0, y: 0, w: this.w, h: this.h }, px);
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
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
