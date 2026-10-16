import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_LAYER_PREVIEW, FRAME_SURFACE_DUMP, decodeFrame, decodeWebMessage, encodeBands, encodeMessage, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';
import { HISTORY_MAX_BYTES, HISTORY_MAX_FAILURES, HISTORY_MAX_STEPS, HISTORY_UPLOAD_DELAY_MS, startTdBridge, TOKEN_EXPIRED_MESSAGE, type Bridge } from '../../src/bridge/tdBridge';
import type { LayerSpec } from '../../src/engine/types';
import { FakeEngine } from '../browser/fakeEngine';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(d: string | Uint8Array) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  tell(m: TdMessage) { this.onmessage?.({ data: encodeMessage(m) }); }
  json(): WebMessage[] { return this.sent.filter((s): s is string => typeof s === 'string').map((s) => decodeWebMessage(s)!); }
  types(): string[] { return this.json().map((m) => m.t); }
}

interface Call { url: string; init: RequestInit | undefined; signal: AbortSignal | undefined; settle: (r: Response | Error) => void }
class FetchMock {
  calls: Call[] = [];
  fn = ((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    this.calls.push({ url, init, signal, settle: (r) => (r instanceof Error ? reject(r) : resolve(r)) });
  })) as unknown as typeof fetch;
  to(path: string): Call[] { return this.calls.filter((c) => new URL(c.url).pathname === path); }
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const raf = (cb: () => void) => setTimeout(cb, 16);
const spec = (over: Partial<LayerSpec> & { id: string }): LayerSpec => ({
  kind: 'pixel', parentId: null, name: over.id, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, rot: 0, kx: 0, ky: 0, input: null, effects: [], slot: null, mask: null, adjustment: null,
  text: null, shape: null, sx: 1, sy: 1, surfaceW: null, surfaceH: null, ...over,
});
const tdLayers: LayerSpec[] = [spec({ id: 'base', kind: 'input', input: 1 }), spec({ id: 'p1', slot: 1 })];
const docState = (rev = 7, layers = tdLayers): TdMessage => ({ t: 'docState', rev, layers, docW: 64, docH: 48, guides: { h: [], v: [] }, canvas: { mode: 'input' } });
const hello = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}): TdMessage => ({
  t: 'hello', protocol: 10, doc: { w: 64, h: 48 }, hasInput: false, maxSendFps: 30, active: true, clientId: 'c1', hasDocument: false, rev: null, ...over,
});
const dump = (slot: number, w: number, h: number, v: number) =>
  encodeBands({ type: FRAME_SURFACE_DUMP, slot, frameId: 1, docW: w, docH: h, rect: { x: 0, y: 0, w, h }, pixels: new Uint8Array(w * h * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const layerFrame = (w: number, h: number, v: number, frameId = 1, slot = 0) =>
  encodeBands({ type: FRAME_LAYER_PREVIEW, slot, frameId, docW: w, docH: h, rect: { x: 0, y: 0, w, h }, pixels: new Uint8Array(w * h * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const bytes = (b: Uint8Array, headers: Record<string, string> = {}) => new Response(b as BufferSource, { status: 200, headers });

interface Status {
  conn: string[]; fatal: string[]; notices: string[]; previews: Array<[string, string]>; cleared: number;
  setConnection(c: string): void; setActive(a: boolean): void; setNotice(m: string): void; setFatal(m: string): void;
  setLayerPreview(id: string, s: 'pending' | 'ready'): void; clearLayerPreviews(): void;
}
const makeStatus = (): Status => {
  const st: Status = {
    conn: [], fatal: [], notices: [], previews: [], cleared: 0,
    setConnection: (c) => { st.conn.push(c); }, setActive: () => {}, setNotice: (m) => { st.notices.push(m); }, setFatal: (m) => { st.fatal.push(m); },
    setLayerPreview: (id, s) => { st.previews.push([id, s]); }, clearLayerPreviews: () => { st.cleared++; },
  };
  return st;
};

let engine: FakeEngine;
let status: Status;
let fm: FetchMock;
let bridge: Bridge;
const sock = () => FakeSocket.all[FakeSocket.all.length - 1];
/** TD reports every SURFACE frame sent so far as applied (the initial full push after connecting). */
async function ackAll() {
  await vi.advanceTimersByTimeAsync(200);
  const ids = sock().sent.filter((x): x is Uint8Array => typeof x !== 'string').map((b) => { const r = decodeFrame(b); return r.ok ? r.frame.frameId : -1; });
  if (ids.length) sock().tell({ t: 'applied', frameId: Math.max(...ids), tdFrame: 1 });
  await flush();
}

function start(prep?: (e: FakeEngine) => void) {
  engine = new FakeEngine(64, 48);
  prep?.(engine);
  status = makeStatus();
  fm = new FetchMock();
  bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 'tok-123', WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, fetch: fm.fn, raf });
}
const connect = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) => { sock().open(); sock().tell(hello({ doc: { w: engine.width, h: engine.height }, ...over })); };
/** A fresh page loads TD's stored document `rev` (one surface slot) and the load completes; the GET /history request is then pending. */
async function loadFromTd(rev = 7) {
  connect({ hasDocument: true, rev });
  sock().tell(docState(rev));
  await flush();
  fm.to('/surface')[0].settle(bytes(dump(1, 64, 48, 5)));
  await flush();
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); FakeSocket.all = []; });
afterEach(() => { bridge?.dispose(); vi.useRealTimers(); });

describe('v7: protocol and activeLayer', () => {
  it('speaks protocol 10 and rejects a v7 hello', () => {
    start();
    sock().open();
    expect(sock().json()[0]).toMatchObject({ t: 'ready', protocol: 10 });
    sock().tell(hello({ protocol: 7 }));
    expect(status.notices.at(-1)).toMatch(/Protocol mismatch/);
  });

  it('sends activeLayer {id} once the page is the authoritative editor', () => {
    start((e) => { e.addPixelLayer('Layer 1'); });
    connect();
    vi.advanceTimersByTime(100);
    expect(sock().json().filter((m) => m.t === 'activeLayer')).toEqual([{ t: 'activeLayer', id: 'L1' }]);
  });

  it('active-layer changes are coalesced to one message per frame with the final id, and repeats are not resent', () => {
    start((e) => { e.addPixelLayer('A'); e.addPixelLayer('B'); });
    connect();
    vi.advanceTimersByTime(100);
    const n0 = sock().types().filter((t) => t === 'activeLayer').length;
    engine.setActiveLayer('L1');
    engine.setActiveLayer('base');
    engine.setActiveLayer('L1');
    vi.advanceTimersByTime(100);
    const msgs = sock().json().filter((m) => m.t === 'activeLayer');
    expect(msgs.length).toBe(n0 + 1);
    expect(msgs.at(-1)).toEqual({ t: 'activeLayer', id: 'L1' });
    engine.setActiveLayer('L1'); // same id again
    vi.advanceTimersByTime(100);
    expect(sock().json().filter((m) => m.t === 'activeLayer').length).toBe(n0 + 1);
  });

  it('a layer created and activated in one step: the doc that introduces it goes first', () => {
    start();
    connect();
    vi.advanceTimersByTime(100);
    sock().sent.length = 0;
    const id = engine.addPixelLayer('New');
    vi.advanceTimersByTime(100);
    const order = sock().types().filter((t) => t === 'doc' || t === 'activeLayer');
    expect(order[0]).toBe('doc');
    expect(sock().json().filter((m) => m.t === 'activeLayer')).toEqual([{ t: 'activeLayer', id }]);
  });

  it('nothing is sent by a standby page, or while TD\'s document is loading', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect({ active: false });
    engine.setActiveLayer('base');
    vi.advanceTimersByTime(200);
    expect(sock().types()).not.toContain('activeLayer');
    // active but waiting for TD's document
    start();
    connect({ hasDocument: true, rev: 3 });
    engine.setActiveLayer('base');
    vi.advanceTimersByTime(200);
    expect(sock().types()).not.toContain('activeLayer');
  });

  it('after a document load the loaded document\'s active layer is announced', async () => {
    start();
    await loadFromTd();
    vi.advanceTimersByTime(100);
    expect(sock().json().filter((m) => m.t === 'activeLayer')).toEqual([{ t: 'activeLayer', id: engine.activeLayerId() }]);
  });
});

describe('v7: layerPreview (GET /layer)', () => {
  beforeEach(async () => {
    start((e) => { e.addPixelLayer('A'); e.previewIds.add('L1'); e.previewIds.add('base'); });
    connect();
    await ackAll();
  });

  it('a notice pulls GET /layer with layerId and frameId, hands the image to the engine and reports ready', async () => {
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 5 });
    await flush();
    expect(status.previews).toEqual([['L1', 'pending']]);
    expect(fm.to('/layer').map((c) => c.url)).toEqual(['http://td:9980/layer?token=tok-123&client=c1&layerId=L1&frameId=5']);
    fm.to('/layer')[0].settle(bytes(layerFrame(64, 48, 77, 5)));
    await flush();
    expect(engine.layerPreviews.get('L1')!.length).toBe(64 * 48 * 4);
    expect(engine.layerPreviews.get('L1')![0]).toBe(77);
    expect(status.previews.at(-1)).toEqual(['L1', 'ready']);
  });

  it('is single flight per layer and the newest notice wins; other layers fetch in parallel', async () => {
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 1 });
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 2 });
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 3 });
    sock().tell({ t: 'layerPreview', layerId: 'base', frameId: 9 });
    await flush();
    expect(fm.to('/layer').map((c) => new URL(c.url).searchParams.get('layerId') + ':' + new URL(c.url).searchParams.get('frameId'))).toEqual(['L1:1', 'base:9']);
    fm.to('/layer')[0].settle(bytes(layerFrame(64, 48, 10, 1)));
    await flush();
    // exactly one more fetch for L1, with the newest id
    expect(fm.to('/layer').map((c) => new URL(c.url).searchParams.get('frameId'))).toEqual(['1', '9', '3']);
  });

  it('a 404 clears the notice without retry and without touching the engine', async () => {
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 5 });
    await flush();
    fm.to('/layer')[0].settle(new Response(null, { status: 404 }));
    await flush();
    vi.advanceTimersByTime(5000);
    await flush();
    expect(fm.to('/layer').length).toBe(1);
    expect(engine.layerPreviews.has('L1')).toBe(false);
    // a later notice works again
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 6 });
    await flush();
    expect(fm.to('/layer').length).toBe(2);
  });

  it('retries once after a network failure, then gives up quietly', async () => {
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 5 });
    await flush();
    fm.to('/layer')[0].settle(new Error('net'));
    await vi.advanceTimersByTimeAsync(600);
    expect(fm.to('/layer').length).toBe(2);
    fm.to('/layer')[1].settle(new Error('net'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.to('/layer').length).toBe(2);
    expect(status.notices).toEqual([]);
  });

  it('403 is a token problem; a stale-sized frame, a wrong frame type and a removed layer are dropped', async () => {
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 1 });
    await flush();
    fm.to('/layer')[0].settle(bytes(layerFrame(32, 24, 1)));      // other document size
    await flush();
    expect(engine.layerPreviews.has('L1')).toBe(false);
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 2 });
    await flush();
    fm.to('/layer')[1].settle(bytes(dump(1, 64, 48, 3)));          // a SURFACE_DUMP is not a preview
    await flush();
    expect(engine.layerPreviews.has('L1')).toBe(false);
    sock().tell({ t: 'layerPreview', layerId: 'gone', frameId: 3 });
    await flush();
    fm.to('/layer')[2].settle(bytes(layerFrame(64, 48, 3, 3)));    // no such layer
    await flush();
    expect(engine.layerPreviews.has('gone')).toBe(false);
    engine.previewIds.delete('L1'); // the engine no longer needs TD's render of L1: an image that still arrives is not accepted
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 5 });
    await flush();
    fm.to('/layer')[3].settle(bytes(layerFrame(64, 48, 3, 5)));
    await flush();
    expect(engine.layerPreviews.has('L1')).toBe(false);
    expect(status.previews.filter((p) => p[1] === 'ready')).toEqual([]);
    engine.previewIds.add('L1');
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 4 });
    await flush();
    fm.to('/layer')[4].settle(new Response(null, { status: 403 }));
    await flush();
    expect(status.fatal).toEqual([TOKEN_EXPIRED_MESSAGE]);
  });

  it('a disconnect aborts the fetch; a document reload clears every TD render', async () => {
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 1 });
    await flush();
    sock().tell({ t: 'layerPreview', layerId: 'base', frameId: 2 });
    await flush();
    fm.to('/layer')[1].settle(bytes(layerFrame(64, 48, 9, 2)));
    await flush();
    expect(engine.layerPreviews.get('base')).toBeTruthy();
    sock().tell({ t: 'reload', rev: 9 });
    await flush();
    expect(engine.layerPreviews.get('base')).toBeNull();
    expect(status.cleared).toBeGreaterThan(0);
    const inFlight = fm.to('/layer')[0];
    sock().close();
    expect(inFlight.signal!.aborted).toBe(true);
  });
});

describe('v7: history restore after load (GET /history)', () => {
  const blob = new Uint8Array([0x46, 0x48, 0x53, 0x54, 1, 123, 125]);

  it('fetches /history once the load completed and restores a blob whose X-Doc-Rev is the loaded revision', async () => {
    start();
    await loadFromTd(7);
    const h = fm.to('/history');
    expect(h.length).toBe(1);
    expect(h[0].url).toBe('http://td:9980/history?token=tok-123&client=c1');
    expect(h[0].init?.method ?? 'GET').toBe('GET');
    h[0].settle(bytes(blob, { 'X-Doc-Rev': '7' }));
    await flush();
    expect(engine.restored).toEqual([{ rev: 7, len: blob.length }]);
  });

  it('does not ask before the load is complete, nor when a surface failed', async () => {
    start();
    connect({ hasDocument: true, rev: 7 });
    sock().tell(docState(7));
    await flush();
    expect(fm.to('/history').length).toBe(0);
    fm.to('/surface')[0].settle(new Response(null, { status: 500 }));
    await vi.advanceTimersByTimeAsync(600);
    fm.to('/surface')[1].settle(new Response(null, { status: 500 }));
    await flush();
    expect(fm.to('/history').length).toBe(0);
  });

  it('a revision mismatch, a missing header or a 404 leave the history empty (no engine call)', async () => {
    start();
    await loadFromTd(7);
    fm.to('/history')[0].settle(bytes(blob, { 'X-Doc-Rev': '6' }));
    await flush();
    expect(engine.restored).toEqual([]);
    bridge.dispose();
    start();
    await loadFromTd(7);
    fm.to('/history')[0].settle(bytes(blob));
    await flush();
    expect(engine.restored).toEqual([]);
    bridge.dispose();
    start();
    await loadFromTd(7);
    fm.to('/history')[0].settle(new Response(null, { status: 404 }));
    await flush();
    expect(engine.restored).toEqual([]);
    expect(status.notices.filter((n) => /history/i.test(n))).toEqual([]);
  });

  it('a corrupt blob (engine refuses or throws) is ignored: a warning is logged, the page keeps working', async () => {
    start();
    engine.restoreResult = 'refuse';
    await loadFromTd(7);
    fm.to('/history')[0].settle(bytes(blob, { 'X-Doc-Rev': '7' }));
    await flush();
    expect(engine.restored.length).toBe(1);
    expect(sock().json().some((m) => m.t === 'log' && m.level === 'warn' && /history/.test(m.msg))).toBe(true);
    bridge.dispose();
    start();
    engine.restoreResult = 'throw';
    await loadFromTd(7);
    fm.to('/history')[0].settle(bytes(blob, { 'X-Doc-Rev': '7' }));
    await flush();
    expect(engine.restored.length).toBe(1);
    expect(status.notices.filter((n) => /history/i.test(n))).toEqual([]);
    // later edits still work and still upload
    engine.addPixelLayer('after');
    await vi.advanceTimersByTimeAsync(HISTORY_UPLOAD_DELAY_MS + 100);
    expect(fm.to('/history').filter((c) => c.init?.method === 'POST').length).toBe(1);
  });

  it('an edit made while the history download is in flight wins: nothing is restored over it', async () => {
    start();
    await loadFromTd(7);
    engine.addPixelLayer('typed fast');
    fm.to('/history')[0].settle(bytes(blob, { 'X-Doc-Rev': '7' }));
    await flush();
    expect(engine.restored).toEqual([]);
  });

  it('the restore itself does not schedule an upload', async () => {
    start();
    await loadFromTd(7);
    fm.to('/history')[0].settle(bytes(new Uint8Array([0x46, 0x48, 0x53, 0x54, 1, 123, 125]), { 'X-Doc-Rev': '7' }));
    await flush();
    await vi.advanceTimersByTimeAsync(HISTORY_UPLOAD_DELAY_MS * 3);
    expect(fm.to('/history').filter((c) => c.init?.method === 'POST')).toEqual([]);
  });
});

describe('v7: history upload (POST /history)', () => {
  const posts = () => fm.to('/history').filter((c) => c.init?.method === 'POST');
  const ok204 = () => new Response(null, { status: 204 });

  beforeEach(async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
  });

  it('uploads engine.serializeHistory(50, 256 MB) about 2 s after the last history change, with the document revision', async () => {
    expect([HISTORY_MAX_STEPS, HISTORY_MAX_BYTES, HISTORY_UPLOAD_DELAY_MS]).toEqual([50, 256 * 1024 * 1024, 2000]);
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(HISTORY_UPLOAD_DELAY_MS - 100);
    expect(posts().length).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(posts().length).toBe(1);
    const p = posts()[0];
    expect(p.url).toBe(`http://td:9980/history?token=tok-123&client=c1&rev=${engine.docSpec().rev}`);
    expect(engine.serialized.at(-1)).toEqual({ maxSteps: 50, maxBytes: 256 * 1024 * 1024 });
    const body = p.init!.body as Uint8Array;
    expect(Array.from(body.subarray(0, 4))).toEqual([0x46, 0x48, 0x53, 0x54]);
    expect((p.init!.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    p.settle(ok204());
    await flush();
  });

  it('debounces: every history change restarts the 2 s timer', async () => {
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(1500);
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(posts().length).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(posts().length).toBe(1);
  });

  it('skips unchanged history: a second event with an identical blob does not upload again, a changed one does', async () => {
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    posts()[0].settle(ok204());
    await flush();
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(posts().length).toBe(1);
    engine.addPixelLayer('changes the history blob');
    await vi.advanceTimersByTimeAsync(2100);
    expect(posts().length).toBe(2);
  });

  it('is serialised: a change during an upload is sent after the first finished', async () => {
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    engine.addPixelLayer('during');
    await vi.advanceTimersByTimeAsync(2100);
    expect(posts().length).toBe(1); // first still in flight
    posts()[0].settle(ok204());
    await vi.advanceTimersByTimeAsync(100);
    expect(posts().length).toBe(2);
  });

  it('a pending document revision is sent before the history that belongs to it', async () => {
    engine.addPixelLayer('B'); // docspec queued for the next frame
    await vi.advanceTimersByTimeAsync(2100);
    const order = sock().json().filter((m) => m.t === 'doc').map((m) => (m as Extract<WebMessage, { t: 'doc' }>).rev);
    expect(order.at(-1)).toBe(engine.docSpec().rev);
    expect(posts().length).toBe(1);
    expect(new URL(posts()[0].url).searchParams.get('rev')).toBe(String(engine.docSpec().rev));
  });

  it('a failed upload (network or 5xx) is retried later; 403 is a token problem', async () => {
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    posts()[0].settle(new Response(null, { status: 500 }));
    await vi.advanceTimersByTimeAsync(HISTORY_UPLOAD_DELAY_MS * 5 + 100);
    expect(posts().length).toBe(2);
    posts()[1].settle(new Response(null, { status: 403 }));
    await flush();
    expect(status.fatal).toEqual([TOKEN_EXPIRED_MESSAGE]);
  });

  it('after three failed uploads TD\'s stored history is cleared with an empty POST (stale history is never restorable)', async () => {
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    for (let i = 0; i < HISTORY_MAX_FAILURES; i++) {
      expect(posts().length).toBe(i + 1 + (i === HISTORY_MAX_FAILURES ? 1 : 0));
      posts()[i].settle(new Response(null, { status: 500 }));
      await vi.advanceTimersByTimeAsync(HISTORY_UPLOAD_DELAY_MS * 5 + 100);
    }
    const all = posts();
    expect(all.length).toBe(HISTORY_MAX_FAILURES + 1);
    const clear = all[all.length - 1];
    expect((clear.init!.body as Uint8Array).byteLength).toBe(0);
    expect(new URL(clear.url).searchParams.get('rev')).toBe(String(engine.docSpec().rev));
  });

  it('when the history cannot be serialised TD\'s stored copy is cleared instead of left stale', async () => {
    engine.serializeFails = true;
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(posts().length).toBe(1);
    expect((posts()[0].init!.body as Uint8Array).byteLength).toBe(0);
  });

  it('prefers engine.historyVersion() over sampling the blob: an unchanged version is not serialised again, a new one is', async () => {
    engine.historyVer = 5;
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    posts()[0].settle(ok204());
    await flush();
    const n = engine.serialized.length;
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(engine.serialized.length).toBe(n); // no work at all
    expect(posts().length).toBe(1);
    engine.historyVer = 6; // the blob bytes do not change in this fake: only the version says so
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(posts().length).toBe(2);
  });

  it('without historyVersion() the sampled blob fingerprint is the fallback', async () => {
    (engine as unknown as { historyVersion?: unknown }).historyVersion = undefined;
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    posts()[0].settle(ok204());
    await flush();
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(posts().length).toBe(1);
  });

  it('the debounce grows with the size of the last blob (100 ms per MB)', async () => {
    const big = new Uint8Array(30 * 1024 * 1024);
    big.set([0x46, 0x48, 0x53, 0x54, 1]);
    engine.serializeHistory = () => big;
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    posts()[0].settle(ok204());
    await flush();
    engine.historyVer = 99;
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(1100);
    expect(posts().length).toBe(1); // 3.2 s after the change: not yet (2 s + 3 s for 30 MB)
    await vi.advanceTimersByTimeAsync(2000);
    expect(posts().length).toBe(2);
  });

  it('a disconnect aborts the upload in flight and nothing is retried on the dead socket', async () => {
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    const p = posts()[0];
    sock().close();
    expect(p.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(HISTORY_UPLOAD_DELAY_MS * 8);
    expect(posts().length).toBe(1);
  });

  it('Save Project uploads the pending history first and sends saveProject only afterwards', async () => {
    engine.emit({ type: 'history' });
    const saved = bridge.saveProject();
    await flush();
    expect(sock().types()).not.toContain('saveProject');
    expect(posts().length).toBe(1);
    posts()[0].settle(ok204());
    await flush();
    const msg = sock().json().find((m) => m.t === 'saveProject') as Extract<WebMessage, { t: 'saveProject' }>;
    expect(msg).toBeTruthy();
    sock().tell({ t: 'fileResult', requestId: msg.requestId, op: 'saveProject', ok: true, path: '/tmp/x.redoc' });
    await expect(saved).resolves.toMatchObject({ ok: true });
  });

  it('Save Project with nothing new to upload sends saveProject immediately', async () => {
    bridge.saveProject().catch(() => {});
    expect(sock().types()).toContain('saveProject');
    expect(posts().length).toBe(0);
  });

  it('Save Project: the history is re-sent when the document revision moved on since the last upload', async () => {
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    posts()[0].settle(ok204());
    await flush();
    engine.setBrushPresets([]); // rev changes, no history change
    await vi.advanceTimersByTimeAsync(100);
    bridge.saveProject().catch(() => {});
    await flush();
    expect(posts().length).toBe(2);
  });
});

describe('v7: history upload is blocked while loading or in standby', () => {
  it('no upload from a standby page', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect({ active: false });
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.to('/history')).toEqual([]);
  });

  it('no upload while TD\'s document loads; the load clears pending history work', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
    engine.emit({ type: 'history' }); // dirty, timer pending
    sock().tell({ t: 'active', active: true }); // no-op
    sock().tell({ t: 'reload', rev: 4 });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.to('/history').filter((c) => c.init?.method === 'POST')).toEqual([]);
  });

  it('losing the active role drops pending uploads', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
    engine.emit({ type: 'history' });
    sock().tell({ t: 'active', active: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.to('/history')).toEqual([]);
  });
});

describe('v7: document brush presets in doc / docState', () => {
  it('doc always carries brushPresets, also an empty list', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
    const doc = sock().json().find((m) => m.t === 'doc') as Extract<WebMessage, { t: 'doc' }>;
    expect(doc.brushPresets).toEqual([]);
    delete (engine.docSpec() as { brushPresets?: unknown }).brushPresets;
    engine.docSpec = () => { const { brushPresets: _drop, ...rest } = FakeEngine.prototype.docSpec.call(engine); return rest as ReturnType<FakeEngine['docSpec']>; };
    engine.addPixelLayer('B');
    await vi.advanceTimersByTimeAsync(100);
    expect((sock().json().filter((m) => m.t === 'doc').at(-1) as Extract<WebMessage, { t: 'doc' }>).brushPresets).toEqual([]);
  });

  it('doc carries the engine\'s presets; docState presets reach loadDocument', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
    const p = { id: 'p1', name: 'Mine', tip: 'round' as const, settings: { size: 10, opacity: 1, flow: 1, hardness: 1, spacing: 0.1 }, dynamics: { scatter: 0, scatterCount: 1, sizeJitter: 0, angleJitter: 0, hueJitter: 0, satJitter: 0, valJitter: 0, angle: 0, roundness: 1, seed: 1 } };
    engine.setBrushPresets([p]);
    await vi.advanceTimersByTimeAsync(100);
    const doc = sock().json().filter((m) => m.t === 'doc').at(-1) as Extract<WebMessage, { t: 'doc' }>;
    expect(doc.brushPresets).toEqual([p]);
    // loading
    start();
    connect({ hasDocument: true, rev: 2 });
    sock().tell({ ...(docState(2) as Extract<TdMessage, { t: 'docState' }>), brushPresets: [p] });
    await flush();
    expect(engine.loaded[0].brushPresets).toEqual([p]);
    expect(engine.brushPresets()).toEqual([p]);
  });

  it('the decoded layer preview frame is exactly what the engine receives (no copies of other buffers)', () => {
    const r = decodeFrame(layerFrame(2, 2, 9, 4));
    expect(r.ok && r.frame.type).toBe(FRAME_LAYER_PREVIEW);
  });
});

describe('v7: review fixes', () => {
  it('history is not restored when the page lost the active role while the download ran', async () => {
    start();
    await loadFromTd(7);
    sock().tell({ t: 'active', active: false });
    fm.to('/history')[0].settle(bytes(new Uint8Array([0x46, 0x48, 0x53, 0x54, 1, 123, 125]), { 'X-Doc-Rev': '7' }));
    await flush();
    expect(engine.restored).toEqual([]);
  });

  it('a null active layer is announced as {id:null} after a real id', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    vi.advanceTimersByTime(100);
    engine.activeLayerId = (() => null) as unknown as typeof engine.activeLayerId;
    engine.emit({ type: 'structure' });
    vi.advanceTimersByTime(100);
    expect(sock().json().filter((m) => m.t === 'activeLayer').at(-1)).toEqual({ t: 'activeLayer', id: null });
  });

  it('docSize voids every TD render and the page state; a 404 forgets the notice', async () => {
    start((e) => { e.addPixelLayer('A'); e.previewIds.add('L1'); });
    connect();
    await ackAll();
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 1 });
    await flush();
    fm.to('/layer')[0].settle(bytes(layerFrame(64, 48, 8, 1)));
    await flush();
    expect(engine.layerPreviews.get('L1')).toBeTruthy();
    const cleared = status.cleared;
    sock().tell({ t: 'docSize', w: 64, h: 48, hasInput: false, mode: 'input' });
    await flush();
    expect(status.cleared).toBe(cleared + 1);
    expect(engine.layerPreviews.get('L1')).toBeNull();
  });
});

describe('v7: privacy controls for the stored undo history', () => {
  const posts = () => fm.to('/history').filter((c) => c.init?.method === 'POST');
  beforeEach(async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
  });

  it('saveProject carries includeHistory when given, and false skips the history upload before the save', async () => {
    engine.emit({ type: 'history' });
    bridge.saveProject('/tmp/p.redoc', { includeHistory: false }).catch(() => {});
    await flush();
    const m = sock().json().find((x) => x.t === 'saveProject') as Extract<WebMessage, { t: 'saveProject' }>;
    expect(m).toMatchObject({ path: '/tmp/p.redoc', includeHistory: false });
    expect(posts()).toEqual([]);
  });

  it('includeHistory true is sent as is; without options the field is absent (TD defaults to including)', async () => {
    bridge.saveProject('/a', { includeHistory: true }).catch(() => {});
    bridge.saveProject('/b').catch(() => {});
    await flush();
    const msgs = sock().json().filter((x) => x.t === 'saveProject') as Array<Extract<WebMessage, { t: 'saveProject' }>>;
    expect(msgs[0].includeHistory).toBe(true);
    expect('includeHistory' in msgs[1]).toBe(false);
  });

  it('clearStoredHistory POSTs an empty body with the current rev and forgets the uploaded state', async () => {
    const p = bridge.clearStoredHistory();
    await flush();
    expect(posts().length).toBe(1);
    expect((posts()[0].init!.body as Uint8Array).byteLength).toBe(0);
    expect(new URL(posts()[0].url).searchParams.get('rev')).toBe(String(engine.docSpec().rev));
    posts()[0].settle(new Response(null, { status: 204 }));
    await expect(p).resolves.toBeUndefined();
    // a pending debounce is dropped; later edits upload again as usual
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(posts().length).toBe(2);
  });

  it('clearStoredHistory rejects on a server error, in standby and when offline', async () => {
    const p = bridge.clearStoredHistory();
    await flush();
    posts()[0].settle(new Response(null, { status: 500 }));
    await expect(p).rejects.toThrow(/500/);
    sock().tell({ t: 'active', active: false });
    await expect(bridge.clearStoredHistory()).rejects.toThrow(/active editor/);
    sock().close();
    await expect(bridge.clearStoredHistory()).rejects.toThrow(/Not connected/);
  });
});

describe('v7: a TD render older than the page\'s own pixels is dropped', () => {
  const frames = () => sock().sent.filter((x): x is Uint8Array => typeof x !== 'string').map((b) => { const r = decodeFrame(b); if (!r.ok) throw new Error(r.error); return r.frame; });
  beforeEach(async () => {
    start((e) => { e.addPixelLayer('A'); e.addPixelLayer('B'); e.addAdjustment('invert'); e.previewIds.add('L1'); e.previewIds.add('L3'); });
    connect();
    await ackAll();
    sock().sent.length = 0;
  });
  const paint = async (slot: number) => { engine.fillSurface(slot, { x: 0, y: 0, w: 4, h: 4 }, [9, 9, 9, 255]); await vi.advanceTimersByTimeAsync(100); };
  const notice = async (id: string, frameId: number) => {
    sock().tell({ t: 'layerPreview', layerId: id, frameId });
    await flush();
    const c = fm.to('/layer').at(-1)!;
    c.settle(bytes(layerFrame(64, 48, 7, frameId)));
    await flush();
  };

  it('a stroke on the layer is sent but not applied yet: the fetched preview is not handed to the engine; after `applied` the next one is', async () => {
    await paint(1); // slot 1 = layer L1
    const sent = frames();
    expect(sent.length).toBeGreaterThan(0);
    await notice('L1', 1);
    expect(engine.layerPreviews.has('L1')).toBe(false);
    expect(status.previews.filter((p) => p[1] === 'ready')).toEqual([]);
    sock().tell({ t: 'applied', frameId: sent.at(-1)!.frameId, tdFrame: 1 });
    await flush();
    await notice('L1', 2); // TD announces a newer render after it applied the strokes
    expect(engine.layerPreviews.get('L1')![0]).toBe(7);
  });

  it('applied lagging behind (an older frame id) keeps the layer pending; wrap-around frame ids are ordered', async () => {
    await paint(1);
    await paint(1);
    const ids = frames().map((f) => f.frameId);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    sock().tell({ t: 'applied', frameId: ids[0], tdFrame: 1 });
    await flush();
    await notice('L1', 1);
    expect(engine.layerPreviews.has('L1')).toBe(false);
    sock().tell({ t: 'applied', frameId: ids.at(-1)!, tdFrame: 2 });
    await flush();
    await notice('L1', 2);
    expect(engine.layerPreviews.has('L1')).toBe(true);
  });

  it('strokes on other layers do not hold back a pixel layer\'s preview', async () => {
    await paint(2); // layer L2
    await notice('L1', 1);
    expect(engine.layerPreviews.has('L1')).toBe(true);
  });

  it('adjustment layers (and groups) wait for ANY unacknowledged slot', async () => {
    await paint(2);
    await notice('L3', 1);
    expect(engine.layerPreviews.has('L3')).toBe(false);
    sock().tell({ t: 'applied', frameId: frames().at(-1)!.frameId, tdFrame: 1 });
    await flush();
    await notice('L3', 2);
    expect(engine.layerPreviews.has('L3')).toBe(true);
  });

  it('pixels still waiting in the send queue count as pending too', async () => {
    engine.fillSurface(1, { x: 0, y: 0, w: 4, h: 4 }, [1, 1, 1, 255]); // not flushed yet
    await notice('L1', 1);
    expect(engine.layerPreviews.has('L1')).toBe(false);
  });

  it('a reload / disconnect forgets unacknowledged frames', async () => {
    await paint(1);
    sock().tell({ t: 'reload', rev: 3 });
    await flush();
    await notice('L1', 1);
    expect(engine.layerPreviews.has('L1')).toBe(true);
  });
});

describe('v7: history revision headers (X-Doc-Rev gates, X-History-Rev is the blob\'s own revision)', () => {
  const blob = new Uint8Array([0x46, 0x48, 0x53, 0x54, 1, 123, 125]);

  it('restores with X-History-Rev when TD rebased the document revision (Open Project)', async () => {
    start();
    await loadFromTd(9);
    fm.to('/history')[0].settle(bytes(blob, { 'X-Doc-Rev': '9', 'X-History-Rev': '4' }));
    await flush();
    expect(engine.restored).toEqual([{ rev: 4, len: blob.length }]);
  });

  it('falls back to X-Doc-Rev without X-History-Rev; a different X-Doc-Rev never restores, whatever X-History-Rev says', async () => {
    start();
    await loadFromTd(9);
    fm.to('/history')[0].settle(bytes(blob, { 'X-Doc-Rev': '9' }));
    await flush();
    expect(engine.restored).toEqual([{ rev: 9, len: blob.length }]);
    bridge.dispose();
    start();
    await loadFromTd(9);
    fm.to('/history')[0].settle(bytes(blob, { 'X-Doc-Rev': '10', 'X-History-Rev': '9' }));
    await flush();
    expect(engine.restored).toEqual([]);
  });
});

describe('v7: reconnecting to a TD whose document moved to another revision', () => {
  /** A page that synced a document with TD (rev r), then loses the connection and reconnects. */
  async function reconnect(tdRev: number | null, opts: { offlineEdit?: boolean } = {}) {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(300);
    const synced = engine.docSpec().rev;
    sock().close(); // the socket drops
    if (opts.offlineEdit) engine.addPixelLayer('offline');
    await vi.advanceTimersByTimeAsync(600); // reconnect backoff
    const s2 = sock();
    s2.open();
    s2.tell(hello({ doc: { w: 64, h: 48 }, hasDocument: true, rev: tdRev ?? synced }));
    await vi.advanceTimersByTimeAsync(300);
    return { synced, s2 };
  }

  it('Open Project while the page was away (a different revision): no push, TD\'s document is requested and loaded', async () => {
    const { synced, s2 } = await reconnect(null); // placeholder, replaced below
    expect(synced).toBeGreaterThan(0);
    expect(s2.types()).not.toContain('requestDoc'); // same revision: the page keeps its document
    bridge.dispose();
    for (const other of [synced + 7, synced - 1]) {
      const r = await reconnect(other);
      expect(r.s2.types()).toContain('requestDoc');
      expect(r.s2.types()).not.toContain('doc');
      expect(r.s2.sent.filter((x) => typeof x !== 'string')).toHaveLength(0); // no SURFACE frames
      r.s2.tell(docState(other));
      await flush();
      expect(engine.loaded.length).toBe(1);
      expect(engine.loaded[0].rev).toBe(other);
      bridge.dispose();
    }
  });

  it('offline edits are discarded with a notice when TD moved on; they are pushed when TD still has the synced revision', async () => {
    const moved = await reconnect(999, { offlineEdit: true });
    expect(moved.s2.types()).toContain('requestDoc');
    expect(moved.s2.types()).not.toContain('doc');
    expect(status.notices.some((n) => /offline edits were discarded/.test(n))).toBe(true);
    bridge.dispose();
    const same = await reconnect(null, { offlineEdit: true });
    expect(same.s2.types()).not.toContain('requestDoc');
    expect(same.s2.json().filter((m) => m.t === 'doc').length).toBeGreaterThan(0); // the offline edit reaches TD
    expect(status.notices.some((n) => /offline edits were discarded/.test(n))).toBe(false);
  });
});
