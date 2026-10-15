import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FRAME_BASE, FRAME_LAYER_PREVIEW, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_TOP, FRAME_VIEW, decodeFrame, decodeWebMessage, encodeFrame, encodeMessage, isStale,
  type Frame, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';
import type { BrushPreset, CanvasMode, Guides, LayerSpec } from '../../src/engine/types';

export interface FakeTdOptions {
  token?: string; w: number; h: number; active?: boolean; hasInput?: boolean; maxSendFps?: number; fonts?: string[];
  /** v6: the TD inputs (default: input 1 at w x h). Several inputs may differ in size. */
  inputs?: { input: number; w: number; h: number }[];
  projectFile?: string; pngFile?: string;
}

/** The stored document (the last `doc` of the active client; v7 adds the document brush presets). */
export interface FakeDoc { rev: number; layers: LayerSpec[]; guides: Guides; canvas: { mode: CanvasMode }; brushPresets?: BrushPreset[] }

/** A saved project in the fake TD's in-memory file system (`saveProject` stores it, `openProject` restores it). */
export interface FakeFile {
  doc: FakeDoc;
  history: Uint8Array | null;
  surfaces: Map<number, Uint8ClampedArray>;
  slotSizes: Map<number, { w: number; h: number }>;
  w: number; h: number; mode: CanvasMode;
}

interface FakeInput { w: number; h: number; connected: boolean; stored: { id: number; bytes: Uint8Array } | null; pending: boolean }

export interface FakeTop { path: string; w: number; h: number; rgba: Uint8Array }

/**
 * A stand-in for the TouchDesigner web server DAT (protocol v7: `activeLayer` log, `POST/GET /history` (blob + `X-Doc-Rev`), `layerPreview` notices + `GET /layer` (frame type 7), `brushPresets` in the doc; protocol v6: several inputs with BASE frames per input, `inputs`, effects/transforms stored verbatim in the doc, `saveProject`/`openProject`/`exportPng` with an in-memory file map + `reload`/`files`, plus the v5 `setCanvas`/`renderLayer` features): WebSocket for JSON and SURFACE tiles (stored per
 * slot with the last `doc`), HTTP `GET /base` / `/surface` / `/view` / `/top`; `fonts` after `hello`; `listTops` / `importTop` over a registry of fake TOPs; `applied` replies per finished SURFACE frame.
 */
export class FakeTd {
  messages: WebMessage[] = [];
  frames: Frame[] = [];
  frameEnds = 0;
  /** Stored document (last `doc` from the active client) and surface buffers (straight RGBA, doc sized). */
  doc: FakeDoc | null = null;
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
  /** v5: the TD Input resolution (BASE frames carry it), the canvas mode, and what `renderLayer` answers with. */
  /** v6: TD inputs by index. */
  inputs = new Map<number, FakeInput>();
  /** Input 1's resolution (what the single-input tests call "the base"). */
  get baseW(): number { return this.inputs.get(1)?.w ?? 0; }
  get baseH(): number { return this.inputs.get(1)?.h ?? 0; }
  /** v6 files: in-memory 'disk' by path, parameter values, and logs of the requests. */
  savedFiles = new Map<string, FakeFile>();
  exportedPngs: string[] = [];
  /** v7: `activeLayer` ids received from the active client, in order. */
  activeLayers: Array<string | null> = [];
  /** v7: the stored undo history (COMP storage) and a log of the requests; `historyPostStatus` forces the POST answer (e.g. 500). */
  historyBlob: { rev: number; bytes: Uint8Array } | null = null;
  historyPosts: { rev: number; size: number; client: string }[] = [];
  historyGets: { status: number }[] = [];
  /** `includeHistory` of every saveProject request (undefined = field absent). */
  saveHistoryFlags: Array<boolean | undefined> = [];
  historyPostStatus: number | null = null;
  /** Ordered log of interesting requests ('history POST', 'saveProject', ...), to assert sequencing. */
  events: string[] = [];
  /** v7: LAYER_PREVIEW frames by layer id, the notice/fetch bookkeeping. */
  layerFrames = new Map<string, { id: number; bytes: Uint8Array }>();
  layerFetches: { layerId: string; frameId: number; status: number }[] = [];
  layerNotices: { layerId: string; frameId: number }[] = [];
  private layerPending = new Set<string>();
  private nextLayerFrame = 1;
  /** Real TD behaviour: after `reload` the client's `doc` / SURFACE are ignored until it has sent `requestDoc`. */
  awaitingRequestDoc = false;
  ignoredAfterReload = { docs: 0, frames: 0 };
  /** Delay the `reload` message itself (a stray edit can then be in flight). */
  reloadDelayMs = 0;
  projectFile: string;
  pngFile: string;
  fileRequests: Extract<WebMessage, { t: 'saveProject' | 'openProject' | 'exportPng' }>[] = [];
  mode: CanvasMode;
  setCanvasMessages: { w: number; h: number; mode: CanvasMode }[] = [];
  renderCalls: string[] = [];
  /** Colour `renderLayer` paints for a layer id (default green); `renderFails` makes it answer topError. */
  renderColors = new Map<string, [number, number, number, number]>();
  renderFails: string | null = null;
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
  noticesByInput: { input: number; frameId: number }[] = [];
  fetches: { frameId: number; status: number; input: number; origin?: string; acao?: string }[] = [];
  badFetches = 0;
  /** Force every /base response to this status (404 / 403) instead of serving the frame. */
  baseStatus: number | null = null;
  /** Hold /base responses for this long (to race them against docSize). */
  baseDelayMs = 0;

  private nextFrameId = 1;
  private clientSeq = 0;

  private constructor(private http: Server, private wss: WebSocketServer, private opts: FakeTdOptions) {
    this.token = opts.token ?? 'tok-e2e';
    this.w = opts.w;
    this.h = opts.h;
    for (const i of opts.inputs ?? [{ input: 1, w: opts.w, h: opts.h }]) this.inputs.set(i.input, { w: i.w, h: i.h, connected: true, stored: null, pending: false });
    this.projectFile = opts.projectFile ?? '/tmp/fake.redoc';
    this.pngFile = opts.pngFile ?? '/tmp/fake.png';
    this.mode = 'input';
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
    if (u.pathname === '/history') { this.onHistoryHttp(req, res, u, cors); return; }
    if (u.pathname === '/layer') {
      if (q.get('token') !== this.token || q.get('client') !== this.clientId) { this.badFetches++; res.writeHead(403, cors).end(); return; }
      const layerId = q.get('layerId') ?? '';
      const stored = this.layerFrames.get(layerId);
      this.layerFetches.push({ layerId, frameId: Number(q.get('frameId')), status: stored && this.active ? 200 : 404 });
      this.layerPending.delete(layerId);
      if (!stored || !this.active) { res.writeHead(404, cors).end(); return; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(stored.bytes));
      if (this.layerFrames.get(layerId)!.id > stored.id) this.announceLayer(layerId);
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
        const sz = this.slotSizes.get(slot) ?? { w: this.w, h: this.h };
        send(200, encodeFrame({ type: FRAME_SURFACE_DUMP, frameEnd: true, slot, frameId: 1, docW: sz.w, docH: sz.h, x: 0, y: 0, w: sz.w, h: sz.h }, buf));
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
    const input = Number(q.get('input') ?? 1);
    const inp = this.inputs.get(input);
    const answer = (status: number, body?: Uint8Array) => {
      this.fetches.push({ frameId: Number(q.get('frameId')), status, input, origin: req.headers.origin, acao: cors['Access-Control-Allow-Origin'] });
      res.writeHead(status, { ...cors, 'Content-Type': 'application/octet-stream' });
      res.end(body ? Buffer.from(body) : undefined);
    };
    if (q.get('token') !== this.token || q.get('client') !== this.clientId) { this.badFetches++; answer(403); return; }
    setTimeout(() => {
      if (this.baseStatus !== null) { answer(this.baseStatus); if (inp) inp.pending = false; return; }
      if (!inp || !inp.stored) { answer(404); if (inp) inp.pending = false; return; }
      const served = inp.stored;
      answer(200, served.bytes);
      inp.pending = false;
      if (inp.stored && inp.stored.id > served.id) this.announce(input); // a newer frame arrived meanwhile
    }, this.baseDelayMs);
  }

  /** v7 history endpoint: POST stores the blob with its `rev`, GET serves it with `X-Doc-Rev` (404 when none); OPTIONS answers the CORS preflight like TD. */
  private onHistoryHttp(req: IncomingMessage, res: import('node:http').ServerResponse, u: URL, cors: Record<string, string>) {
    const q = u.searchParams;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }).end();
      return;
    }
    if (q.get('token') !== this.token || q.get('client') !== this.clientId) { this.badFetches++; res.writeHead(403, cors).end(); return; }
    const expose = { ...cors, 'Access-Control-Expose-Headers': 'X-Doc-Rev, X-History-Rev' };
    if (req.method === 'GET') {
      if (!this.historyBlob) { this.historyGets.push({ status: 404 }); res.writeHead(404, expose).end(); return; }
      this.historyGets.push({ status: 200 });
      res.writeHead(200, { ...expose, 'Content-Type': 'application/octet-stream', 'X-Doc-Rev': String(this.doc?.rev ?? this.historyBlob.rev), 'X-History-Rev': String(this.historyBlob.rev), 'Cache-Control': 'no-store' });
      res.end(Buffer.from(this.historyBlob.bytes));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      this.events.push('history POST');
      this.historyPosts.push({ rev: Number(q.get('rev')), size: body.length, client: q.get('client') ?? '' });
      if (!this.active) { res.writeHead(409, expose).end(); return; }
      if (this.historyPostStatus !== null) { res.writeHead(this.historyPostStatus, expose).end(); return; }
      this.historyBlob = body.length ? { rev: Number(q.get('rev')), bytes: body } : null;
      res.writeHead(204, expose).end();
    });
  }

  /** v7: TD's render of one tdPreview layer (doc sized, straight RGBA; default = a deterministic gradient). Announced to the active client (one outstanding notice per layer). */
  setLayerPreview(layerId: string, rgba?: Uint8Array) {
    const px = rgba ?? FakeTd.syntheticLayerImage(this.w, this.h);
    const id = this.nextLayerFrame++;
    this.layerFrames.set(layerId, { id, bytes: encodeFrame({ type: FRAME_LAYER_PREVIEW, frameEnd: true, slot: 0, frameId: id, docW: this.w, docH: this.h, x: 0, y: 0, w: this.w, h: this.h }, px) });
    this.announceLayer(layerId);
  }

  /** A recognisable image: opaque, red ramps with x, green with y, blue constant 200. */
  static syntheticLayerImage(w: number, h: number): Uint8Array {
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([Math.round((x / Math.max(1, w - 1)) * 255), Math.round((y / Math.max(1, h - 1)) * 255), 200, 255], (y * w + x) * 4);
    return px;
  }

  private announceLayer(layerId: string) {
    const f = this.layerFrames.get(layerId);
    if (!this.client || !f || !this.active || this.layerPending.has(layerId)) return;
    this.layerPending.add(layerId);
    this.layerNotices.push({ layerId, frameId: f.id });
    this.send({ t: 'layerPreview', layerId, frameId: f.id });
  }

  private announce(input: number) {
    const inp = this.inputs.get(input);
    if (!this.client || !inp || !inp.stored) return;
    if (inp.pending) return; // one un-fetched notice per client and input; the stored frame is simply newer
    inp.pending = true;
    this.noticesSent.push(inp.stored.id);
    this.noticesByInput.push({ input, frameId: inp.stored.id });
    this.send({ t: 'base', frameId: inp.stored.id, input, docW: inp.w, docH: inp.h, x: 0, y: 0, w: inp.w, h: inp.h });
  }

  private onConnection(ws: WebSocket) {
    this.client = ws;
    this.connections++;
    this.awaitingRequestDoc = false;
    for (const i of this.inputs.values()) i.pending = false;
    this.viewPending = false;
    this.layerPending.clear();
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
          this.send({ t: 'files', projectFile: this.projectFile, pngFile: this.pngFile });
          if (this.opts.fonts) this.send({ t: 'fonts', families: this.opts.fonts });
          for (const n of this.inputs.keys()) this.announce(n);
        }
        if (m.t === 'requestBase') for (const n of this.inputs.keys()) { this.inputs.get(n)!.pending = false; this.announce(n); }
        if (m.t === 'chooseFile') this.onChooseFile(m);
        if (m.t === 'saveProject' || m.t === 'openProject' || m.t === 'exportPng') this.onFileRequest(m);
        if (m.t === 'doc' && this.awaitingRequestDoc) { this.ignoredAfterReload.docs++; return; }
        if (m.t === 'doc' && this.active) { this.doc = { rev: m.rev, layers: m.layers, guides: m.guides, canvas: m.canvas, ...(m.brushPresets ? { brushPresets: m.brushPresets } : {}) }; this.docMessages++; this.syncSlots(m.layers); }
        if (m.t === 'activeLayer' && this.active) this.activeLayers.push(m.id);
        if (m.t === 'setCanvas' && this.active) this.onSetCanvas(m);
        if (m.t === 'renderLayer') this.onRenderLayer(m);
        if (m.t === 'requestDoc') { this.requestDocs++; this.awaitingRequestDoc = false; }
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
          setTimeout(() => this.send({ t: 'docState', rev: doc.rev, layers: doc.layers, docW: this.w, docH: this.h, guides: doc.guides, canvas: doc.canvas, ...(doc.brushPresets ? { brushPresets: doc.brushPresets } : {}) }), this.docStateDelayMs);
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
      if (!r.ok || r.frame.type !== FRAME_SURFACE || !this.active) return;
      if (this.awaitingRequestDoc) { this.ignoredAfterReload.frames++; return; }
      const f = r.frame;
      const sz = this.slotSizes.get(f.slot);
      if (!sz || isStale(f, sz.w, sz.h)) return; // v5: the header carries the SURFACE size; a different size than the slot's is stale
      const surface = this.surfaces.get(f.slot);
      if (!surface) return; // TD drops SURFACE frames for slots it does not know from the last `doc`
      this.frames.push({ ...f, payload: f.payload.slice() });
      for (let row = 0; row < f.h; row++) {
        surface.set(f.payload.subarray(row * f.w * 4, (row + 1) * f.w * 4), ((f.y + row) * sz.w + f.x) * 4);
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
      t: 'hello', protocol: 7, doc: { w: this.w, h: this.h, mode: this.mode }, hasInput: this.opts.hasInput ?? false, maxSendFps: this.opts.maxSendFps ?? 30,
      inputs: this.inputList(),
      active: this.active, clientId: this.clientId, hasDocument: this.doc !== null, rev: this.doc?.rev ?? null,
    };
  }

  inputList(): { input: number; w: number; h: number; connected: boolean }[] {
    return [...this.inputs].sort((a, b) => a[0] - b[0]).map(([input, i]) => ({ input, w: i.w, h: i.h, connected: i.connected }));
  }

  private onFileRequest(m: Extract<WebMessage, { t: 'saveProject' | 'openProject' | 'exportPng' }>) {
    this.fileRequests.push(m);
    const reply = (ok: boolean, path: string, msg?: string) => this.send({ t: 'fileResult', requestId: m.requestId, op: m.t, ok, path, ...(msg ? { msg } : {}) });
    if (m.t === 'exportPng') {
      const path = m.path ?? this.pngFile;
      if (m.path) this.pngFile = m.path;
      this.exportedPngs.push(path);
      reply(true, path);
      if (m.path) this.send({ t: 'files', projectFile: this.projectFile, pngFile: this.pngFile });
      return;
    }
    const path = m.path ?? this.projectFile;
    if (m.path) { this.projectFile = m.path; this.send({ t: 'files', projectFile: this.projectFile, pngFile: this.pngFile }); }
    if (m.t === 'saveProject') {
      if (!this.doc) { reply(false, path, 'No document to save'); return; }
      this.events.push('saveProject');
      this.saveHistoryFlags.push(m.includeHistory);
      this.savedFiles.set(path, {
        doc: JSON.parse(JSON.stringify(this.doc)),
        history: m.includeHistory !== false && this.historyBlob && this.historyBlob.rev === this.doc.rev ? this.historyBlob.bytes : null, surfaces: new Map([...this.surfaces].map(([k, v]) => [k, new Uint8ClampedArray(v)])),
        slotSizes: new Map(this.slotSizes), w: this.w, h: this.h, mode: this.mode,
      });
      reply(true, path);
      return;
    }
    const file = this.savedFiles.get(path);
    if (!file) { reply(false, path, `File not found: ${path}`); return; }
    const rev = (this.doc?.rev ?? 0) + 1;
    this.doc = { ...JSON.parse(JSON.stringify(file.doc)), rev };
    this.historyBlob = file.history ? { rev, bytes: file.history } : null; // the file's history belongs to the opened document (now at its new rev)
    this.w = file.w; this.h = file.h; this.mode = file.mode;
    this.slotSizes = new Map(file.slotSizes);
    this.surfaces = new Map([...file.surfaces].map(([k, v]) => [k, new Uint8ClampedArray(v)]));
    reply(true, path);
    this.awaitingRequestDoc = true;
    const to = this.client;
    setTimeout(() => { if (this.client === to) this.send({ t: 'reload', rev }); }, this.reloadDelayMs);
  }

  /** v6 chooser: what the user "picks" (null = cancel) per purpose, and a log of the requests. */
  choice: Record<string, string | null> = { placeImage: '/tmp/picked-photo.png', saveProject: '/tmp/chosen.redoc', openProject: '/tmp/chosen.redoc', exportPng: '/tmp/chosen.png' };
  chooseRequests: Extract<WebMessage, { t: 'chooseFile' }>[] = [];
  /** Size and colour of the image `placeImage` serves, and an error to answer instead (topError). */
  placeSize = { w: 32, h: 16 };
  placeColor: [number, number, number, number] = [40, 90, 220, 255];
  placeFails: string | null = null;

  /** v7 `readText` answer: {path, text}, {path, error} or null (cancelled). */
  readTextAnswer: { path: string; text?: string; error?: string } | null = { path: '/tmp/grade.cube', text: 'LUT_3D_SIZE 2\n' + Array.from({ length: 8 }, () => '0.5 0.5 0.5').join('\n') + '\n' };

  private onChooseFile(m: Extract<WebMessage, { t: 'chooseFile' }>) {
    this.chooseRequests.push(m);
    if (m.purpose === 'readText') { this.send({ t: 'fileChosen', requestId: m.requestId, path: this.readTextAnswer?.path ?? null, ...(this.readTextAnswer?.text !== undefined ? { text: this.readTextAnswer.text } : {}), ...(this.readTextAnswer?.error !== undefined ? { error: this.readTextAnswer.error } : {}) }); return; }
    const path = this.choice[m.purpose] ?? null;
    this.send({ t: 'fileChosen', requestId: m.requestId, path });
    if (m.purpose !== 'placeImage' || path === null) return;
    if (this.placeFails) { this.send({ t: 'topError', requestId: m.requestId, msg: this.placeFails }); return; }
    const { w, h } = this.placeSize;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set(this.placeColor, i);
    this.topSnapshots.set(m.requestId, encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: w, docH: h, x: 0, y: 0, w, h }, rgba));
    setTimeout(() => this.send({ t: 'topReady', requestId: m.requestId, w, h }), this.topDelayMs);
  }

  /** Allocate / free surface buffers for the slots a `doc` lists (pixel + mask), like the generated Script TOPs. */
  slotSizes = new Map<number, { w: number; h: number }>();
  private syncSlots(layers: LayerSpec[]) {
    const want = new Map<number, { w: number; h: number }>();
    for (const l of layers) {
      const sz = { w: l.surfaceW ?? this.w, h: l.surfaceH ?? this.h };
      if (l.slot !== null) want.set(l.slot, sz);
      if (l.mask) want.set(l.mask.slot, sz);
    }
    for (const [slot, sz] of want) {
      const cur = this.slotSizes.get(slot);
      if (!this.surfaces.has(slot) || !cur || cur.w !== sz.w || cur.h !== sz.h) this.surfaces.set(slot, new Uint8ClampedArray(sz.w * sz.h * 4)); // Script TOPs are allocated at their own size
    }
    this.slotSizes = want;
    for (const slot of [...this.surfaces.keys()]) if (!want.has(slot)) this.surfaces.delete(slot);
  }

  private onSetCanvas(m: Extract<WebMessage, { t: 'setCanvas' }>) {
    this.setCanvasMessages.push({ w: m.w, h: m.h, mode: m.mode });
    this.mode = m.mode;
    if (m.mode === 'input') { this.w = this.baseW || this.w; this.h = this.baseH || this.h; } else { this.w = m.w; this.h = m.h; }
    for (const i of this.inputs.values()) { i.stored = null; i.pending = false; }
    this.send({ t: 'docSize', w: this.w, h: this.h, hasInput: true, mode: this.mode });
  }

  /** Flatten: TD renders the text / shape layer alone at document size and serves it like a TOP import. */
  private onRenderLayer(m: Extract<WebMessage, { t: 'renderLayer' }>) {
    this.renderCalls.push(m.layerId);
    const layer = this.doc?.layers.find((l) => l.id === m.layerId);
    if (this.renderFails || !layer || (layer.kind !== 'text' && layer.kind !== 'shape')) {
      this.send({ t: 'topError', requestId: m.requestId, msg: this.renderFails ?? `Layer ${m.layerId} cannot be rendered` });
      return;
    }
    const rgba = new Uint8Array(this.w * this.h * 4);
    const c = this.renderColors.get(m.layerId) ?? [10, 200, 30, 255];
    for (let i = 0; i < rgba.length; i += 4) rgba.set(c, i);
    this.topSnapshots.set(m.requestId, encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: this.w, docH: this.h, x: 0, y: 0, w: this.w, h: this.h }, rgba));
    setTimeout(() => this.send({ t: 'topReady', requestId: m.requestId, w: this.w, h: this.h }), this.topDelayMs);
  }

  /** Pre-load a stored document as if TouchDesigner had restored it from its .toe (for the fresh-page load flow). */
  seedDocument(layers: LayerSpec[], rev = 1, fill: Record<number, [number, number, number, number]> = {}, guides: Guides = { h: [], v: [] }, canvas: { mode: CanvasMode } = { mode: 'input' }, brushPresets?: BrushPreset[]) {
    // like TD's own specs: pixel / base layers always state their surface size (default: the document size)
    layers = layers.map((l) => {
      if (l.surfaceW != null || (l.kind !== 'pixel' && l.kind !== 'input')) return l;
      const inp = l.kind === 'input' ? this.inputs.get(l.input ?? 1) : undefined;
      return { ...l, surfaceW: inp?.w ?? this.baseW, surfaceH: inp?.h ?? this.baseH };
    });
    this.doc = { rev, layers, guides, canvas, ...(brushPresets ? { brushPresets } : {}) };
    this.syncSlots(layers);
    for (const [slot, rgba] of Object.entries(fill)) {
      const buf = this.surfaces.get(Number(slot))!;
      for (let i = 0; i < buf.length; i += 4) buf.set(rgba, i);
    }
  }

  surfacePixel(slot: number, x: number, y: number): number[] {
    const i = (y * (this.slotSizes.get(slot)?.w ?? this.w) + x) * 4;
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

  /** The input is disconnected while no page listens: the next hello lists it as 0x0, not connected. */
  removeInput(input = 1) {
    const i = this.inputs.get(input);
    if (!i) return;
    i.w = 0; i.h = 0; i.connected = false; i.stored = null; i.pending = false;
  }

  /** An input's resolution changes: always an `inputs` message; in Follow Input mode the document follows input 1 (docSize). The old BASE frame is gone. */
  resize(w: number, h: number, input = 1) {
    const i = this.inputs.get(input) ?? { w, h, connected: true, stored: null, pending: false };
    this.inputs.set(input, i);
    i.w = w; i.h = h; i.connected = true; i.stored = null; i.pending = false;
    if (this.mode === 'input' && input === 1) { this.w = w; this.h = h; }
    this.send({ t: 'inputs', items: this.inputList() });
    if (this.mode === 'input' && input === 1) this.send({ t: 'docSize', w, h, hasInput: true, mode: this.mode });
  }

  /** Stores a whole-input BASE frame (replacing any older one of that input) and announces it if no notice for it is outstanding. */
  setBase(rgba: Uint8Array, input = 1) {
    const i = this.inputs.get(input)!;
    const id = this.nextFrameId++;
    const bytes = encodeFrame({ type: FRAME_BASE, frameEnd: true, slot: input, frameId: id, docW: i.w, docH: i.h, x: 0, y: 0, w: i.w, h: i.h }, rgba);
    i.stored = { id, bytes };
    this.announce(input);
  }

  sendSolidBase(r: number, g: number, b: number, input = 1) {
    const i = this.inputs.get(input)!;
    const px = new Uint8Array(i.w * i.h * 4);
    for (let k = 0; k < px.length; k += 4) { px[k] = r; px[k + 1] = g; px[k + 2] = b; px[k + 3] = 255; }
    this.setBase(px, input);
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
