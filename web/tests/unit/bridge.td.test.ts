import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_TOP, decodeFrame, encodeFrame, decodeWebMessage, encodeBands, encodeMessage,
  type Frame, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';
import {
  BACKPRESSURE_BYTES, SURFACE_FETCH_CONCURRENCY, installLogForwarding, httpOrigin, latencyStats, resolveToken, resolveWsUrl, TOKEN_EXPIRED_MESSAGE,
  startTdBridge, type Bridge, type Connection, type LatencyStats, type ViewState,
} from '../../src/bridge/tdBridge';
import type { LayerSpec } from '../../src/engine/types';
import { FakeEngine } from '../browser/fakeEngine';
import { fastFrame, exactFull, exactTiles, solid } from '../helpers/viewFrames';
import type { ViewSink } from '../../src/bridge/tdViewClient';

type Sent = { json: WebMessage } | { frame: Frame };

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
  binary(u: Uint8Array) { this.onmessage?.({ data: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) }); }
  json() { return this.sent.filter((s): s is string => typeof s === 'string').map((s) => decodeWebMessage(s)!); }
  /** Everything sent, in order. */
  all(): Sent[] {
    return this.sent.map((s) => {
      if (typeof s === 'string') return { json: decodeWebMessage(s)! };
      const r = decodeFrame(s);
      if (!r.ok) throw new Error(r.error);
      return { frame: r.frame };
    });
  }
  frames(): Frame[] {
    return this.sent.filter((s): s is Uint8Array => typeof s !== 'string').map((b) => {
      const r = decodeFrame(b);
      if (!r.ok) throw new Error(r.error);
      return r.frame;
    });
  }
}

const hello = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}): TdMessage => ({
  t: 'hello', protocol: 12, doc: { w: 64, h: 48 }, hasInput: false, maxSendFps: 30, active: true, clientId: 'c1', hasDocument: false, rev: null, ...over,
});

interface TestStatus {
  conn: Connection[]; active: boolean[]; notices: string[]; latency: LatencyStats[]; viewLatency: LatencyStats[];
  loading: boolean[];
  setConnection(c: Connection): void; setActive(a: boolean): void; setNotice(m: string): void;
  setLoading(b: boolean): void;
  setLatency(s: LatencyStats): void; setViewLatency(s: LatencyStats): void;
}
const makeStatus = (): TestStatus => ({
  conn: [], active: [], notices: [], latency: [], viewLatency: [], loading: [],
  setLoading(b) { this.loading.push(b); },
  setConnection(c) { this.conn.push(c); }, setActive(a) { this.active.push(a); }, setNotice(m) { this.notices.push(m); },
  setLatency(s) { this.latency.push(s); }, setViewLatency(s) { this.viewLatency.push(s); },
});

let engine: FakeEngine;
let status: TestStatus;
let bridge: Bridge;
let fm: FetchMock | null = null;
const at = <T>(a: T[], i: number): T => a[a.length + i];
const sock = () => FakeSocket.all[FakeSocket.all.length - 1];
const raf = (cb: () => void) => setTimeout(cb, 16);

function start(w = 64, h = 48, prep?: (e: FakeEngine) => void, extra: Partial<Parameters<typeof startTdBridge>[2]> = {}) {
  engine = new FakeEngine(w, h);
  prep?.(engine);
  status = makeStatus();
  fm = new FetchMock();
  bridge = startTdBridge(engine, status, {
    url: 'ws://td:9980/ws', token: 'tok-123', WebSocketCtor: FakeSocket as unknown as typeof WebSocket,
    forwardLogs: false, fetch: fm.fn, raf, dpr: () => 1, ...extra,
  });
}
function connectActive(over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) { sock().open(); sock().tell(hello({ doc: { w: engine.width, h: engine.height }, ...over })); }
const withLayer = (e: FakeEngine) => { e.addPixelLayer('Layer 1'); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); FakeSocket.all = []; });
afterEach(() => { bridge?.dispose(); vi.useRealTimers(); });

describe('tdBridge session', () => {
  it('sends ready{protocol 7, fresh} after open', () => {
    start();
    expect(status.conn).toEqual(['reconnecting']);
    expect(sock().url).toBe('ws://td:9980/ws');
    expect(sock().binaryType).toBe('arraybuffer');
    sock().open();
    expect(sock().json()).toEqual([{ t: 'ready', protocol: 12, client: 'external', version: '0.1.0', token: 'tok-123', fresh: true }]);
  });

  it('becomes linked on hello and pushes doc + every surface in full when TD has no document', () => {
    start(64, 48, (e) => { withLayer(e); e.addMask('L1'); });
    connectActive();
    expect(at(status.conn, -1)).toBe('linked');
    expect(at(status.active, -1)).toBe(true);
    vi.advanceTimersByTime(100);
    const sent = sock().all();
    expect('json' in sent[1] && sent[1].json).toMatchObject({ t: 'doc', rev: engine.docSpec().rev });
    expect(('json' in sent[1] ? (sent[1].json as Extract<WebMessage, { t: 'doc' }>).layers : []).map((l) => l.id)).toEqual(['base', 'L1']);
    const frames = sock().frames();
    expect(frames.map((f) => f.slot).sort()).toEqual([1, 2]);
    for (const f of frames) expect(f).toMatchObject({ type: FRAME_SURFACE, frameEnd: true, docW: 64, docH: 48, x: 0, y: 0, w: 64, h: 48 });
    expect(new Set(frames.map((f) => f.frameId)).size).toBe(2); // one frameId per slot batch
    expect(sock().json().some((m) => m.t === 'doc')).toBe(true);
  });

  it('never sends COMPOSITE (type 2) frames or composite reads', () => {
    start(64, 48, withLayer);
    connectActive();
    engine.emit({ type: 'composite', rect: { x: 0, y: 0, w: 4, h: 4 } });
    engine.emit({ type: 'pixels', rect: { x: 0, y: 0, w: 4, h: 4 } });
    vi.advanceTimersByTime(300);
    expect(sock().frames().every((f) => f.type === FRAME_SURFACE)).toBe(true);
    expect(sock().sent.every((s) => typeof s === 'string' || s[4] !== 2)).toBe(true);
  });

  it('resizes the engine when hello or docSize disagree', () => {
    start(64, 48, withLayer);
    sock().open();
    sock().tell(hello({ doc: { w: 32, h: 16 } }));
    expect([engine.width, engine.height]).toEqual([32, 16]);
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true, mode: 'input' });
    expect([engine.width, engine.height]).toEqual([20, 10]);
    vi.advanceTimersByTime(100);
    // v5: the document size does not reallocate surfaces, so nothing is re-sent
    expect(sock().frames().filter((f) => f.docW === 20)).toEqual([]);
  });

  it('surfaces TD errors and ignores unknown or malformed messages', () => {
    start();
    sock().open();
    sock().tell({ t: 'error', msg: 'boom' });
    sock().onmessage?.({ data: '{"t":"future","x":1}' });
    sock().onmessage?.({ data: 'not json' });
    expect(status.notices).toEqual(['boom']);
  });

  it('reports a protocol mismatch without linking', () => {
    start();
    sock().open();
    sock().tell(hello({ protocol: 2 }));
    expect(at(status.conn, -1)).toBe('reconnecting');
    expect(status.notices[0]).toMatch(/mismatch/i);
  });
});

const spec = (over: Partial<LayerSpec> & { id: string }): LayerSpec => ({
  kind: 'pixel', parentId: null, name: over.id, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, rot: 0, kx: 0, ky: 0, input: null, effects: [], slot: null, mask: null, adjustment: null, text: null, shape: null, sx: 1, sy: 1, surfaceW: null, surfaceH: null, ...over,
});
const tdLayers: LayerSpec[] = [
  spec({ id: 'base', kind: 'input', input: 1 }),
  spec({ id: 'p1', slot: 1, mask: { slot: 2, enabled: true } }),
  spec({ id: 'a1', kind: 'adjustment', adjustment: { type: 'invert' }, mask: { slot: 3, enabled: false } }),
  spec({ id: 'p2', slot: 4 }), spec({ id: 'p3', slot: 5 }), spec({ id: 'p4', slot: 6 }),
];
const dump = (slot: number, w: number, h: number, v: number) =>
  encodeBands({ type: FRAME_SURFACE_DUMP, slot, frameId: 1, docW: w, docH: h, rect: { x: 0, y: 0, w, h }, pixels: new Uint8Array(w * h * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const flushP = () => vi.advanceTimersByTimeAsync(0);
const okBytes = (b: Uint8Array) => new Response(b as BufferSource, { status: 200 });
const docState = (rev = 7, layers = tdLayers): TdMessage => ({ t: 'docState', rev, layers, docW: 64, docH: 48, guides: { h: [], v: [] }, canvas: { mode: 'input' } });

describe('tdBridge document load', () => {
  it('a fresh page loads TD\'s document: requestDoc, loadDocument, GET /surface per slot (<=4 at a time), commit, no echo', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 7 });
    expect(sock().json()[0]).toMatchObject({ t: 'ready', fresh: true });
    expect(sock().json().map((m) => m.t)).toEqual(['ready', 'requestDoc']);
    expect(sock().sent.length).toBe(2); // no doc, no surfaces pushed
    sock().tell(docState());
    await flushP();
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]).toMatchObject({ rev: 7, width: 64, height: 48 });
    expect(engine.loaded[0].layers.map((l) => l.id)).toEqual(tdLayers.map((l) => l.id));
    // slots 1..6 -> 6 fetches, only 4 in flight
    expect(SURFACE_FETCH_CONCURRENCY).toBe(4);
    expect(fm!.calls.length).toBe(4);
    expect(fm!.calls[0].url).toBe('http://td:9980/surface?token=tok-123&client=c1&slot=1');
    fm!.calls[0].settle(okBytes(dump(1, 64, 48, 9)));
    await flushP();
    expect(fm!.calls.length).toBe(5);
    for (let k = 1; k < 6; k++) { fm!.calls[k].settle(okBytes(dump([2, 3, 4, 5, 6][k - 1], 64, 48, 5))); await flushP(); }
    expect(fm!.calls.filter((c) => c.url.includes('/surface')).map((c) => Number(new URL(c.url).searchParams.get('slot'))).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fm!.calls.filter((c) => c.url.includes('/history')).map((c) => c.url)).toEqual(['http://td:9980/history?token=tok-123&client=c1']); // v7: history after the load
    expect(engine.surfaceWrites.map((w) => w.slot).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(engine.surfaceCommits).toBe(1);
    expect(engine.surfaceWrites[0]).toMatchObject({ rect: { x: 0, y: 0, w: 64, h: 48 }, len: 64 * 48 * 4 });
    vi.advanceTimersByTime(500);
    expect(sock().json().map((m) => m.t)).toEqual(['ready', 'requestDoc', 'activeLayer']); // loading writes were not echoed back to TD (v7: only the active layer)
    expect(sock().frames()).toHaveLength(0);
    // editing afterwards works
    engine.fillSurface(1, { x: 1, y: 1, w: 2, h: 2 }, [1, 2, 3, 255]);
    vi.advanceTimersByTime(100);
    expect(sock().frames()).toHaveLength(1);
    expect(sock().frames()[0]).toMatchObject({ slot: 1, x: 1, y: 1, w: 2, h: 2 });
  });

  it('a reconnecting page (fresh=false) pushes its own document even when TD has one', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 3 }); // first connect: loads
    sock().tell(docState(3, [tdLayers[0]]));
    await flushP();
    sock().close();
    vi.advanceTimersByTime(500);
    sock().open();
    expect(sock().json()[0]).toMatchObject({ t: 'ready', fresh: false });
    sock().tell(hello({ hasDocument: true, rev: 3 }));
    vi.advanceTimersByTime(100);
    const kinds = sock().json().map((m) => m.t);
    expect(kinds).toContain('doc');
    expect(kinds).not.toContain('requestDoc');
  });

  it('a page that pushed once is no longer fresh on reconnect', () => {
    start(64, 48, withLayer);
    connectActive();
    sock().close();
    vi.advanceTimersByTime(500);
    sock().open();
    expect(sock().json()[0]).toMatchObject({ t: 'ready', fresh: false });
  });

  it('retries a failed surface once, skips a 404 slot, and still commits', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 1 });
    sock().tell(docState(1, tdLayers.slice(0, 2))); // slots 1, 2
    await flushP();
    fm!.calls[0].settle(new TypeError('net'));
    fm!.calls[1].settle(new Response('', { status: 404 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(fm!.calls.length).toBe(3); // slot 1 retried
    fm!.calls[2].settle(okBytes(dump(1, 64, 48, 2)));
    await flushP();
    expect(engine.surfaceWrites.map((w) => w.slot)).toEqual([1]);
    expect(engine.surfaceCommits).toBe(1);
  });

  it('a surface fetch that hangs is aborted after 10 s', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 1 });
    sock().tell(docState(1, [tdLayers[0], tdLayers[1]]));
    await flushP();
    expect(fm!.calls[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fm!.calls[0].signal?.aborted).toBe(true);
  });

  it('a stale-size surface body is dropped', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 1 });
    sock().tell(docState(1, [tdLayers[0], spec({ id: 'p1', slot: 1 })]));
    await flushP();
    fm!.calls[0].settle(okBytes(dump(1, 10, 10, 1)));
    await flushP();
    expect(engine.surfaceWrites).toEqual([]);
  });

  it('takeover: a standby page loads TD\'s document when it becomes active', async () => {
    start(64, 48, withLayer);
    connectActive({ active: false, hasDocument: true, rev: 4 });
    expect(sock().json().map((m) => m.t)).toEqual(['ready']);
    engine.emit({ type: 'docspec' });
    engine.fillSurface(1, { x: 0, y: 0, w: 2, h: 2 }, [1, 1, 1, 255]);
    vi.advanceTimersByTime(300);
    expect(sock().sent.length).toBe(1); // standby sends nothing
    bridge.takeover();
    expect(at(sock().json(), -1)).toEqual({ t: 'takeover' });
    sock().tell({ t: 'active', active: true });
    expect(at(sock().json(), -1)).toEqual({ t: 'requestDoc' });
    sock().tell(docState(4, [tdLayers[0], tdLayers[1]]));
    await flushP();
    expect(engine.loaded).toHaveLength(1);
    expect(fm!.calls.length).toBe(2);
    fm!.calls[0].settle(okBytes(dump(1, 64, 48, 1)));
    fm!.calls[1].settle(okBytes(dump(2, 64, 48, 1)));
    await flushP();
    expect(engine.surfaceCommits).toBe(1);
    vi.advanceTimersByTime(300);
    expect(sock().frames()).toEqual([]); // nothing echoed
    expect(sock().json().filter((m) => m.t === 'doc')).toEqual([]);
  });

  it('NEVER overwrites TD\'s document when TD is slow: keeps asking with backoff, sends nothing, stays locked', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 4 });
    expect(at(status.loading, -1)).toBe(true);
    engine.setLayerProps('L1', { opacity: 0.5 }); // an edit while waiting is not pushed
    engine.fillSurface(1, { x: 0, y: 0, w: 4, h: 4 }, [1, 2, 3, 255]);
    await vi.advanceTimersByTimeAsync(60000);
    const kinds = sock().json().map((m) => m.t);
    expect(kinds).not.toContain('doc');
    expect(sock().frames()).toEqual([]);
    expect(kinds.filter((k) => k === 'requestDoc').length).toBeGreaterThanOrEqual(4);
    expect(status.notices.some((n) => /Loading document from TouchDesigner/.test(n))).toBe(true);
    expect(at(status.loading, -1)).toBe(true);
    // TD finally answers (4 s+ late): the load completes and only then does the page become authoritative
    sock().tell(docState(4, [tdLayers[0], tdLayers[1]]));
    await flushP();
    fm!.calls[0].settle(okBytes(dump(1, 64, 48, 1)));
    fm!.calls[1].settle(okBytes(dump(2, 64, 48, 1)));
    await flushP();
    expect(at(status.loading, -1)).toBe(false);
    expect(engine.loaded).toHaveLength(1);
    expect(sock().json().some((m) => m.t === 'doc')).toBe(false);
    expect(sock().frames()).toEqual([]);
  });

  it('a takeover where TD stores no document falls back to pushing, but only after a longer wait', async () => {
    start(64, 48, withLayer);
    connectActive({ active: false, hasDocument: false });
    sock().tell({ t: 'active', active: true });
    await vi.advanceTimersByTimeAsync(9000);
    expect(sock().json().some((m) => m.t === 'doc')).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sock().json().some((m) => m.t === 'doc')).toBe(true);
    expect(at(status.loading, -1)).toBe(false);
    // a docState that arrives after the page pushed its own document is ignored (and logged)
    sock().tell(docState(9, [tdLayers[0]]));
    await flushP();
    expect(engine.loaded).toEqual([]);
    expect(sock().json().some((m) => m.t === 'log' && /ignored docState/.test(m.msg))).toBe(true);
  });

  it('a takeover where TD does have a document never falls back', async () => {
    start(64, 48, withLayer);
    connectActive({ active: false, hasDocument: true, rev: 2 });
    sock().tell({ t: 'active', active: true });
    await vi.advanceTimersByTimeAsync(120000);
    expect(sock().json().some((m) => m.t === 'doc')).toBe(false);
    expect(sock().frames()).toEqual([]);
  });

  describe('incomplete loads', () => {
    const failFirstLoad = async () => {
      start(64, 48, withLayer);
      connectActive({ hasDocument: true, rev: 5 });
      sock().tell(docState(5, [tdLayers[0], tdLayers[1], tdLayers[2]])); // slots 1, 2, 3
      await flushP();
      fm!.calls[0].settle(new Response('', { status: 500 })); // slot 1 fails (twice)
      await vi.advanceTimersByTimeAsync(500);
      fm!.calls.find((c, i) => i >= 3 && c.url.endsWith('slot=1'))!.settle(new Response('', { status: 500 }));
      for (const c of fm!.calls) if (c.url.endsWith('slot=2') || c.url.endsWith('slot=3')) c.settle(okBytes(dump(2, 64, 48, 1)));
      await flushP();
    };

    it('a 500 keeps the page non-authoritative, commits what loaded, and retries the load', async () => {
      await failFirstLoad();
      expect(engine.surfaceCommits).toBe(1);
      expect(at(status.loading, -1)).toBe(true);
      const requests = () => sock().json().filter((m) => m.t === 'requestDoc').length;
      const before = requests();
      await vi.advanceTimersByTimeAsync(5000);
      expect(requests()).toBeGreaterThan(before);
      engine.fillSurface(2, { x: 0, y: 0, w: 2, h: 2 }, [9, 9, 9, 255]);
      await vi.advanceTimersByTimeAsync(500);
      expect(sock().json().some((m) => m.t === 'doc')).toBe(false);
      expect(sock().frames()).toEqual([]);
    });

    it('docSize and resize after a failed load send no empty surfaces', async () => {
      await failFirstLoad();
      sock().tell({ t: 'docSize', w: 32, h: 24, hasInput: false, mode: 'input' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sock().frames()).toEqual([]);
      expect(sock().json().some((m) => m.t === 'doc')).toBe(false);
    });

    it('a reconnect after a failed load asks for the document again instead of pushing (fresh stays true)', async () => {
      await failFirstLoad();
      sock().close();
      await vi.advanceTimersByTimeAsync(500);
      sock().open();
      expect(sock().json()[0]).toMatchObject({ t: 'ready', fresh: true });
      sock().tell(hello({ hasDocument: true, rev: 5 }));
      await vi.advanceTimersByTimeAsync(100);
      expect(sock().json().map((m) => m.t)).toEqual(['ready', 'requestDoc']);
      expect(sock().frames()).toEqual([]);
    });

    it('if TD has lost its document, a reconnect pushes but never the slot that failed to load', async () => {
      await failFirstLoad();
      sock().close();
      await vi.advanceTimersByTimeAsync(500);
      sock().open();
      sock().tell(hello({ hasDocument: false }));
      await vi.advanceTimersByTimeAsync(100);
      expect(sock().json().some((m) => m.t === 'doc')).toBe(true);
      expect(sock().frames().map((f) => f.slot).sort()).toEqual([2, 3]);
    });
  });

  it('a 404 for a slot means TD has no pixels there: the load completes and the page may edit', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 1 });
    sock().tell(docState(1, tdLayers.slice(0, 2)));
    await flushP();
    fm!.calls[0].settle(new Response('', { status: 404 }));
    fm!.calls[1].settle(new Response('', { status: 404 }));
    await flushP();
    expect(at(status.loading, -1)).toBe(false);
    engine.fillSurface(1, { x: 0, y: 0, w: 2, h: 2 }, [5, 5, 5, 255]);
    vi.advanceTimersByTime(100);
    expect(sock().frames().map((f) => f.slot)).toEqual([1]);
  });

  it('a reconnect finding a newer TD rev reloads; the same rev pushes', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 3 });
    sock().tell(docState(3, [tdLayers[0], tdLayers[1]]));
    await flushP();
    fm!.calls[0].settle(okBytes(dump(1, 64, 48, 1)));
    fm!.calls[1].settle(okBytes(dump(2, 64, 48, 1)));
    await flushP();
    sock().close();
    await vi.advanceTimersByTimeAsync(500);
    sock().open();
    sock().tell(hello({ hasDocument: true, rev: 8 })); // someone else edited
    await vi.advanceTimersByTimeAsync(100);
    expect(sock().json().map((m) => m.t)).toEqual(['ready', 'requestDoc']);
    expect(sock().frames()).toEqual([]);

    sock().close();
    await vi.advanceTimersByTimeAsync(3000);
    sock().open();
    sock().tell(hello({ hasDocument: true, rev: 3 })); // incomplete reload -> still must load
    expect(sock().json().map((m) => m.t)).toEqual(['ready', 'requestDoc']);
  });

  it('a reconnect with an unchanged TD rev pushes the page\'s own document', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 3 });
    sock().tell(docState(3, [tdLayers[0], tdLayers[1]]));
    await flushP();
    fm!.calls[0].settle(okBytes(dump(1, 64, 48, 1)));
    fm!.calls[1].settle(okBytes(dump(2, 64, 48, 1)));
    await flushP();
    sock().close();
    await vi.advanceTimersByTimeAsync(500);
    sock().open();
    sock().tell(hello({ hasDocument: true, rev: 3 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(sock().json().some((m) => m.t === 'doc')).toBe(true);
    expect(sock().json().some((m) => m.t === 'requestDoc')).toBe(false);
  });

  it('moving a layer (nonzero x/y) sends a doc message only, no SURFACE frames', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(200);
    const frames = sock().frames().length, docs = sock().json().filter((m) => m.t === 'doc').length;
    engine.rev++;
    engine.emit({ type: 'docspec' });
    vi.advanceTimersByTime(300);
    expect(sock().json().filter((m) => m.t === 'doc').length).toBe(docs + 1);
    expect(sock().frames().length).toBe(frames);
  });

  it('ignores docState on a standby page', async () => {
    start(64, 48, withLayer);
    connectActive({ active: false });
    sock().tell(docState());
    await flushP();
    expect(engine.loaded).toEqual([]);
  });
});

describe('tdBridge doc messages', () => {
  it('coalesces docspec events to one doc message per animation frame, with the engine\'s layers', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    const n = () => sock().json().filter((m) => m.t === 'doc').length;
    const base = n();
    engine.setLayerProps('L1', { opacity: 0.5 });
    engine.setLayerProps('L1', { opacity: 0.4 });
    engine.addAdjustment('blur');
    expect(n()).toBe(base); // not yet: waits for the frame
    vi.advanceTimersByTime(16);
    expect(n()).toBe(base + 1);
    const m = at(sock().json().filter((x) => x.t === 'doc'), -1) as Extract<WebMessage, { t: 'doc' }>;
    expect(m.rev).toBe(engine.docSpec().rev);
    expect(m.layers.map((l) => l.kind)).toEqual(['input', 'pixel', 'adjustment']);
    vi.advanceTimersByTime(500);
    expect(n()).toBe(base + 1);
    engine.setLayerProps('L1', { opacity: 0.3 });
    vi.advanceTimersByTime(16);
    expect(n()).toBe(base + 2);
  });

  it('standby pages and loading pages send no doc', () => {
    start(64, 48, withLayer);
    connectActive({ active: false });
    engine.setLayerProps('L1', { opacity: 0.2 });
    vi.advanceTimersByTime(100);
    expect(sock().json().some((m) => m.t === 'doc')).toBe(false);
  });

  it('a new layer\'s doc is sent before its first surface tiles even within the same frame', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(200);
    const before = sock().sent.length;
    const id = engine.addPixelLayer('Layer 2');
    const slot = engine.layers().find((l) => l.id === id)!.slot!;
    engine.fillSurface(slot, { x: 0, y: 0, w: 3, h: 3 }, [9, 9, 9, 255]);
    vi.advanceTimersByTime(100);
    const s = sock().all().slice(before);
    const docIdx = s.findIndex((x) => 'json' in x && x.json.t === 'doc');
    const frameIdx = s.findIndex((x) => 'frame' in x && x.frame.slot === slot);
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(frameIdx).toBeGreaterThan(docIdx);
  });
});

describe('tdBridge surface tiles', () => {
  it('batches dirty rects per slot (one frameId per slot batch) and sends at most maxSendFps', () => {
    start(64, 48, (e) => { withLayer(e); e.addPixelLayer('Layer 2'); });
    connectActive();
    vi.advanceTimersByTime(100);
    const base = sock().frames().length;

    engine.emit({ type: 'surface', slot: 1, rect: { x: 2, y: 3, w: 4, h: 4 } });
    vi.advanceTimersByTime(40);
    const afterFirst = sock().frames().length;
    expect(afterFirst).toBe(base + 1);
    engine.emit({ type: 'surface', slot: 1, rect: { x: 10, y: 20, w: 5, h: 5 } });
    engine.emit({ type: 'surface', slot: 1, rect: { x: 8, y: 18, w: 2, h: 2 } });
    engine.emit({ type: 'surface', slot: 2, rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(sock().frames().length).toBe(afterFirst); // throttled
    vi.advanceTimersByTime(40);
    const frames = sock().frames().slice(afterFirst);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ slot: 1, x: 8, y: 18, w: 7, h: 7, type: FRAME_SURFACE });
    expect(frames[1]).toMatchObject({ slot: 2, x: 0, y: 0, w: 1, h: 1 });
    expect(frames[1].frameId).toBe(frames[0].frameId + 1);
  });

  it('sends the pixels of the slot (readSurface), not a composite', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    engine.fillSurface(1, { x: 4, y: 5, w: 2, h: 2 }, [11, 22, 33, 44]);
    vi.advanceTimersByTime(100);
    const f = at(sock().frames(), -1);
    expect(f).toMatchObject({ slot: 1, x: 4, y: 5, w: 2, h: 2 });
    expect(Array.from(f.payload.subarray(0, 4))).toEqual([11, 22, 33, 44]);
  });

  it('clips dirty rects to the document and skips empty ones', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    engine.emit({ type: 'surface', slot: 1, rect: { x: 60, y: 44, w: 20, h: 20 } });
    vi.advanceTimersByTime(100);
    expect(at(sock().frames(), -1)).toMatchObject({ x: 60, y: 44, w: 4, h: 4 });
    engine.emit({ type: 'surface', slot: 1, rect: { x: 100, y: 100, w: 5, h: 5 } });
    vi.advanceTimersByTime(100);
    expect(sock().frames().length).toBe(n + 1);
  });

  it('rounds fractional dirty rects outward', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    engine.emit({ type: 'surface', slot: 1, rect: { x: 2.4, y: 3.6, w: 2.2, h: 1.1 } });
    vi.advanceTimersByTime(100);
    expect(at(sock().frames(), -1)).toMatchObject({ x: 2, y: 3, w: 3, h: 2 });
  });

  it('splits large surface frames into bands of at most 2 MB, only the last ending the frame', () => {
    start(1000, 1000, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    const frames = sock().frames();
    expect(frames.length).toBe(Math.ceil(4_000_000 / (Math.floor(2097152 / 4000) * 4000)));
    expect(frames.every((f) => f.payload.length <= 2 * 1024 * 1024 && f.slot === 1)).toBe(true);
    expect(frames.map((f) => f.frameEnd)).toEqual(frames.map((_, i) => i === frames.length - 1));
    expect(new Set(frames.map((f) => f.frameId)).size).toBe(1);
    expect(frames.reduce((a, f) => a + f.h, 0)).toBe(1000);
  });

  it('skips ticks while the socket is backed up and keeps accumulating', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    sock().bufferedAmount = BACKPRESSURE_BYTES + 1;
    engine.emit({ type: 'surface', slot: 1, rect: { x: 0, y: 0, w: 2, h: 2 } });
    vi.advanceTimersByTime(500);
    engine.emit({ type: 'surface', slot: 1, rect: { x: 5, y: 5, w: 2, h: 2 } });
    vi.advanceTimersByTime(500);
    expect(sock().frames().length).toBe(n);
    sock().bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(sock().frames().length).toBe(n + 1);
    expect(at(sock().frames(), -1)).toMatchObject({ x: 0, y: 0, w: 7, h: 7 });
  });

  it('sends nothing while on standby; doc + full surfaces after a takeover load', async () => {
    start(64, 48, withLayer);
    connectActive({ active: false });
    engine.emit({ type: 'surface', slot: 1, rect: { x: 0, y: 0, w: 4, h: 4 } });
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(0);
    sock().tell({ t: 'active', active: true });
    sock().tell({ t: 'active', active: false });
    engine.emit({ type: 'surface', slot: 1, rect: { x: 0, y: 0, w: 4, h: 4 } });
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(0);
  });

  it('v5: a docSize leaves surfaces alone: a pending tile is still sent as is, at the surface size', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    engine.emit({ type: 'surface', slot: 1, rect: { x: 50, y: 40, w: 10, h: 6 } });
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true, mode: 'input' });
    vi.advanceTimersByTime(200);
    const sent = sock().frames().slice(n);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ docW: 64, docH: 48, x: 50, y: 40, w: 10, h: 6 });
  });
});

describe('tdBridge reconnect', () => {
  it('backs off 0.5 s doubling up to 5 s, then re-pushes doc and surfaces', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const count = FakeSocket.all.length;
      sock().close();
      expect(at(status.conn, -1)).toBe('reconnecting');
      let t = 0;
      while (FakeSocket.all.length === count && t < 6000) { vi.advanceTimersByTime(100); t += 100; }
      delays.push(t);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000]);

    sock().open();
    sock().tell(hello());
    vi.advanceTimersByTime(100);
    expect(at(status.conn, -1)).toBe('linked');
    expect(sock().json()[0]).toMatchObject({ t: 'ready', fresh: false });
    expect(sock().json().some((m) => m.t === 'doc')).toBe(true);
    expect(sock().frames()[0]).toMatchObject({ slot: 1, w: 64, h: 48 });
  });

  it('resets backoff only after a valid hello, so accept-then-close loops keep backing off', () => {
    start();
    sock().close();
    vi.advanceTimersByTime(500);
    sock().open();
    sock().close(); // accepted then dropped: no hello
    let n = FakeSocket.all.length;
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(n + 1);

    sock().open();
    sock().tell(hello());
    sock().close();
    n = FakeSocket.all.length;
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(n + 1);
  });

  it('stops reconnecting after dispose', () => {
    start();
    sock().close();
    bridge.dispose();
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all.length).toBe(n);
  });

  it('survives a throwing WebSocket constructor and retries', () => {
    let fail = true;
    class Flaky extends FakeSocket { constructor(u: string) { if (fail) throw new Error('blocked'); super(u); } }
    engine = new FakeEngine(64, 48);
    status = makeStatus();
    bridge = startTdBridge(engine, status, { url: 'ws://td/ws', token: 't', WebSocketCtor: Flaky as unknown as typeof WebSocket, forwardLogs: false, raf });
    expect(FakeSocket.all.length).toBe(0);
    fail = false;
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('leaves no stray timers or listeners across many reconnects, and none after dispose', () => {
    start(64, 48, withLayer);
    const base = engine.listenerCount();
    for (let i = 0; i < 20; i++) {
      sock().open();
      sock().tell(hello());
      engine.emit({ type: 'surface', slot: 1, rect: { x: 0, y: 0, w: 2, h: 2 } });
      sock().close();
      vi.advanceTimersByTime(5000);
    }
    expect(engine.listenerCount()).toBe(base);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    bridge.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(engine.listenerCount()).toBe(0);
  });

  it('ignores messages and closes from superseded sockets', () => {
    start();
    const old = sock();
    old.open();
    old.close();
    vi.advanceTimersByTime(500);
    old.tell(hello({ active: true }));
    old.onclose?.();
    expect(status.conn[status.conn.length - 1]).toBe('reconnecting');
    expect(vi.getTimerCount()).toBe(1);   // only the new socket's connect timeout
  });

  it('goes back to active (no standby overlay) when the socket drops', () => {
    start();
    sock().open();
    sock().tell(hello({ active: false }));
    expect(at(status.active, -1)).toBe(false);
    sock().close();
    expect(at(status.active, -1)).toBe(true);
  });

  it('takeover while disconnected shows a notice instead of silently dropping', () => {
    start();
    bridge.takeover();
    expect(status.notices).toEqual(['Not connected to TouchDesigner']);
    expect(sock().sent.length).toBe(0);
  });

  it('a socket drop during a document load abandons it and the next hello is not stuck loading', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 1 });
    sock().tell(docState(1, [tdLayers[0], tdLayers[1]]));
    await flushP();
    sock().close();
    expect(fm!.calls[0].signal?.aborted).toBe(true);
    vi.advanceTimersByTime(500);
    sock().open();
    sock().tell(hello());
    vi.advanceTimersByTime(100);
    expect(sock().frames().length).toBeGreaterThan(0);
  });
});

describe('tdBridge latency', () => {
  it('measures send -> applied per SURFACE frameId (rolling median / p95)', () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    const ids: number[] = [];
    for (const wait of [10, 20, 30, 40, 100]) {
      engine.emit({ type: 'surface', slot: 1, rect: { x: 0, y: 0, w: 2, h: 2 } });
      vi.advanceTimersByTime(40);
      const id = at(sock().frames(), -1).frameId;
      ids.push(id);
      vi.advanceTimersByTime(wait);
      sock().tell({ t: 'applied', frameId: id, tdFrame: 1 });
    }
    expect(status.latency).toHaveLength(5);
    const last = at(status.latency, -1);
    expect(last).toMatchObject({ n: 5, last: 140, median: 70, p95: 140 }); // 40 ms until read + wait
    // unknown / repeated ids add nothing
    sock().tell({ t: 'applied', frameId: ids[0], tdFrame: 2 });
    sock().tell({ t: 'applied', frameId: 99999, tdFrame: 2 });
    expect(status.latency).toHaveLength(5);
  });

  it('latencyStats handles empty, single and unsorted samples', () => {
    expect(latencyStats([])).toMatchObject({ n: 0, median: 0 });
    expect(latencyStats([7])).toEqual({ n: 1, last: 7, median: 7, p95: 7 });
    expect(latencyStats([30, 10, 20])).toMatchObject({ median: 20, last: 20 });
  });
});

describe('tdBridge view messages (protocol 12)', () => {
  const view = (o: Partial<ViewState> = {}): ViewState => ({ mode: 'local', zoom: 1, panX: 10, panY: 20, rect: { x: 5, y: 6, w: 700, h: 500 }, ...o });
  const views = () => sock().json().filter((m) => m.t === 'view');

  it('local: one {mode:local}; panning and zooming in Local sends nothing more', () => {
    start();
    connectActive();
    bridge.setView(view());
    bridge.setView(view({ zoom: 2 }));
    vi.advanceTimersByTime(16);
    expect(views()).toEqual([{ t: 'view', mode: 'local' }]);
    bridge.setView(view({ panX: 99 }));
    vi.advanceTimersByTime(300);
    expect(views()).toHaveLength(1);
  });

  it('td: quality + the visible document rect + device-pixel scale; mode and quality changes go out at once', () => {
    start(640, 480);
    connectActive();
    bridge.setView(view({ mode: 'td', zoom: 2, panX: 0, panY: 0, rect: { x: 0, y: 0, w: 400, h: 300 }, quality: 'fast' }));
    vi.advanceTimersByTime(16);
    expect(at(views(), -1)).toEqual({ t: 'view', mode: 'td', quality: 'fast', viewport: { x: 0, y: 0, w: 200, h: 150, scale: 2 } });
    bridge.setView(view({ mode: 'td', zoom: 2, panX: 0, panY: 0, rect: { x: 0, y: 0, w: 400, h: 300 }, quality: 'exact' }));
    vi.advanceTimersByTime(16);
    expect(views()).toHaveLength(2);
    expect(at(views(), -1)).toMatchObject({ quality: 'exact' });
  });

  it('viewport updates are throttled to 10 Hz with a trailing send of the newest state', () => {
    start(640, 480);
    connectActive();
    const td = (panX: number) => view({ mode: 'td', zoom: 1, panX, panY: 0, rect: { x: 0, y: 0, w: 100, h: 100 } });
    bridge.setView(td(0));
    vi.advanceTimersByTime(16);
    expect(views()).toHaveLength(1);
    for (let i = 1; i <= 5; i++) { bridge.setView(td(-i * 10)); vi.advanceTimersByTime(16); }
    expect(views()).toHaveLength(1); // 80 ms since the first send
    vi.advanceTimersByTime(30);
    expect(views()).toHaveLength(2);
    expect(at(views(), -1)).toMatchObject({ viewport: { x: 50, w: 100 } }); // the newest state, not an intermediate one
    for (let i = 6; i <= 40; i++) { bridge.setView(td(-i * 10)); vi.advanceTimersByTime(16); }
    expect(views().length).toBeLessThanOrEqual(2 + Math.ceil((35 * 16) / 100) + 1);
  });

  it('an unchanged viewport is not re-sent', () => {
    start(640, 480);
    connectActive();
    bridge.setView(view({ mode: 'td' }));
    vi.advanceTimersByTime(16);
    bridge.setView(view({ mode: 'td' }));
    vi.advanceTimersByTime(300);
    expect(views()).toHaveLength(1);
  });

  it('leaving TD mode sends {mode:local}', () => {
    start(640, 480);
    connectActive();
    bridge.setView(view({ mode: 'td' }));
    vi.advanceTimersByTime(16);
    bridge.setView(view({ mode: 'local' }));
    vi.advanceTimersByTime(16);
    expect(at(views(), -1)).toEqual({ t: 'view', mode: 'local' });
  });

  it('sends view while a document load is pending and after a failed load', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 1 });
    bridge.setView(view({ mode: 'td' }));
    vi.advanceTimersByTime(60);
    expect(views()).toHaveLength(1); // still waiting for docState
    sock().tell(docState(1, [tdLayers[0], tdLayers[1]]));
    await flushP();
    bridge.setView(view({ mode: 'td', zoom: 4, panX: 0, panY: 0 })); // mid-load
    vi.advanceTimersByTime(160);
    expect(views()).toHaveLength(2);
    fm!.calls[0].settle(new Response('', { status: 500 }));
    fm!.calls[1].settle(new Response('', { status: 500 }));
    await vi.advanceTimersByTimeAsync(600);
    fm!.calls[2].settle(new Response('', { status: 500 }));
    fm!.calls[3].settle(new Response('', { status: 500 }));
    await flushP();
    expect(views().length).toBeGreaterThanOrEqual(3); // re-sent when the load ended (failed)
  });

  it('does not stall when requestAnimationFrame never fires (hidden page)', () => {
    engine = new FakeEngine(64, 48);
    engine.addPixelLayer('Layer 1');
    status = makeStatus();
    fm = new FetchMock();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 't', WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, fetch: fm.fn, raf: () => {} });
    connectActive();
    bridge.setView(view({ mode: 'td' }));
    bridge.setView(view({ mode: 'td', zoom: 2 }));
    vi.advanceTimersByTime(60);
    expect(views()).toHaveLength(1);
    vi.advanceTimersByTime(100);
    bridge.setView(view({ mode: 'td', zoom: 3 }));
    vi.advanceTimersByTime(160);
    expect(views()).toHaveLength(2);
    const docs = () => sock().json().filter((m) => m.t === 'doc').length;
    const n = docs();
    engine.setLayerProps('L1', { opacity: 0.5 });
    vi.advanceTimersByTime(60);
    expect(docs()).toBe(n + 1);
  });

  it('ignores an unmeasured viewport (w = h = 0)', () => {
    start();
    connectActive();
    bridge.setView(view({ rect: { x: 0, y: 0, w: 0, h: 0 } }));
    vi.advanceTimersByTime(50);
    expect(sock().json().some((m) => m.t === 'view')).toBe(false);
  });

  it('re-sends the current view after a (re)connect hello', () => {
    start();
    connectActive();
    bridge.setView(view({ mode: 'td' }));
    vi.advanceTimersByTime(16);
    sock().close();
    vi.advanceTimersByTime(500);
    sock().open();
    sock().tell(hello());
    expect(views()).toHaveLength(1);
  });

  it('a view set while disconnected is sent on the next hello, nothing is sent offline', () => {
    start();
    bridge.setView(view());
    vi.advanceTimersByTime(16);
    expect(sock().sent.length).toBe(0);
    connectActive();
    expect(views()).toHaveLength(1);
  });
});

/** Controllable fetch: every call stays pending until the test settles it. */
class FetchMock {
  calls: { url: string; signal: AbortSignal | undefined; settle: (r: Response | Error) => void }[] = [];
  fn = ((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    this.calls.push({ url, signal, settle: (r) => (r instanceof Error ? reject(r) : resolve(r)) });
  })) as unknown as typeof fetch;
}
const flush = flushP;
const baseFrame = (docW: number, docH: number, v: number, frameId = 1, input = 1) =>
  encodeBands({ type: FRAME_BASE, slot: input, frameId, docW, docH, rect: { x: 0, y: 0, w: docW, h: docH }, pixels: new Uint8Array(docW * docH * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const notice = (frameId: number, w = 64, h = 48, input = 1): TdMessage => ({ t: 'base', frameId, input, docW: w, docH: h, x: 0, y: 0, w, h });

describe('tdBridge base pull (HTTP)', () => {
  let fm: FetchMock;
  const ok = okBytes;
  const startF = () => {
    fm = new FetchMock();
    engine = new FakeEngine(64, 48);
    status = makeStatus();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 'tok 1', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive();
  };

  it('fetches /base on the ws host with token, client id and notice frame id', async () => {
    startF();
    sock().tell(notice(5));
    await flush();
    expect(fm.calls.map((c) => c.url)).toEqual(['http://td:9980/base?token=tok%201&client=c1&frameId=5&input=1']);
  });

  it('applies a fetched frame and commits once; header frameId may be newer than the notice', async () => {
    startF();
    sock().tell(notice(5));
    await flush();
    fm.calls[0].settle(ok(baseFrame(64, 48, 9, 8)));
    await flush();
    expect(engine.inputWrites).toEqual([{ input: 1, rect: { x: 0, y: 0, w: 64, h: 48 }, len: 64 * 48 * 4 }]);
    expect(engine.inputCommits.length).toBe(1);
  });

  it('drops stale-size and malformed bodies', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    fm.calls[0].settle(ok(new Uint8Array(30)));
    await flush();
    sock().tell(notice(2));
    await flush();
    fm.calls[1].settle(ok(baseFrame(64, 48, 1).slice(0, 40)));
    await flush();
    sock().tell(notice(3));
    await flush();
    fm.calls[2].settle(ok(new Uint8Array(5)));
    await flush();
    expect(engine.inputWrites.length).toBe(0);
    expect(engine.inputCommits.length).toBe(0);
  });

  it('ignores 404 quietly (no retry, no notice, no fatal)', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    fm.calls[0].settle(new Response('', { status: 404 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.calls.length).toBe(1);
    expect(status.notices).toEqual([]);
    expect(engine.inputWrites.length).toBe(0);
  });

  it('treats 403 like a token error: fatal message, no reconnecting', async () => {
    startF();
    const fatal: string[] = [];
    (status as unknown as { setFatal: (m: string) => void }).setFatal = (m) => fatal.push(m);
    sock().tell(notice(1));
    await flush();
    fm.calls[0].settle(new Response('', { status: 403 }));
    await flush();
    expect(fatal).toEqual([TOKEN_EXPIRED_MESSAGE]);
    sock().close();
    const n = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.all.length).toBe(n);
  });

  it('retries a network error once after 500 ms, then waits (and later asks TD again)', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    fm.calls[0].settle(new TypeError('network'));
    await vi.advanceTimersByTimeAsync(499);
    expect(fm.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fm.calls.length).toBe(2);
    fm.calls[1].settle(new TypeError('network'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fm.calls.length).toBe(2);
    expect(sock().json().filter((m) => m.t === 'requestBase').length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sock().json().filter((m) => m.t === 'requestBase').length).toBe(1);
    expect(fm.calls.length).toBe(2);
  });

  it('a retry that succeeds applies the frame', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    fm.calls[0].settle(new TypeError('network'));
    await vi.advanceTimersByTimeAsync(500);
    fm.calls[1].settle(ok(baseFrame(64, 48, 3)));
    await flush();
    expect(engine.inputCommits.length).toBe(1);
  });

  it('keeps one fetch in flight; notices arriving meanwhile cause exactly one more fetch with the newest id', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().tell(notice(2));
    sock().tell(notice(3));
    await flush();
    expect(fm.calls.length).toBe(1);
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(fm.calls.length).toBe(2);
    expect(fm.calls[1].url).toContain('frameId=3');
    fm.calls[1].settle(ok(baseFrame(64, 48, 2)));
    await flush();
    expect(fm.calls.length).toBe(2);
    expect(engine.inputCommits.length).toBe(2);
  });

  it('a docSize while fetching voids the in-flight result, even at an unchanged size, and fetches again (TD counted it as fetched)', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().tell({ t: 'docSize', w: 64, h: 48, hasInput: true, mode: 'input' });
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(engine.inputCommits.length).toBe(0);
    expect(fm.calls.length).toBe(2); // re-fetch without waiting for a notice
    fm.calls[1].settle(ok(baseFrame(64, 48, 2)));
    await flush();
    expect(engine.inputCommits.length).toBe(1);
    expect(fm.calls.length).toBe(2); // exactly one more, no loop
  });

  it('a discarded result followed by a 404 re-fetch just waits for the next notice', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true, mode: 'input' });
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    fm.calls[1].settle(new Response('', { status: 404 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.calls.length).toBe(2);
    sock().tell(notice(2, 20, 10));
    await flush();
    fm.calls[2].settle(ok(baseFrame(20, 10, 3)));
    await flush();
    expect(engine.inputCommits.length).toBe(1);
  });

  it('aborts a hung fetch after 10 s and treats it as a network error (retry once, then requestBase)', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    expect(fm.calls[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fm.calls[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fm.calls[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fm.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fm.calls[1].signal?.aborted).toBe(true);
    expect(sock().json().filter((m) => m.t === 'requestBase').length).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sock().json().filter((m) => m.t === 'requestBase').length).toBe(1);
    expect(fm.calls.length).toBe(2);
    // the single-flight slot is free again
    sock().tell(notice(2));
    await flush();
    expect(fm.calls.length).toBe(3);
  });

  it('a fetch that completes in time clears its timeout (no late abort)', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    await vi.advanceTimersByTimeAsync(20000);
    expect(fm.calls[0].signal?.aborted).toBe(false);
  });

  it('aborts the in-flight fetch on socket close and on dispose', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().close();
    expect(fm.calls[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    sock().open();
    sock().tell(hello());
    sock().tell(notice(2));
    await flush();
    expect(fm.calls[1].signal?.aborted).toBe(false);
    bridge.dispose();
    expect(fm.calls[1].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fm.calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a docSize to a new size drops the old-size result and applies the new-size one', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true, mode: 'input' });
    sock().tell(notice(2, 20, 10));
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(engine.inputWrites.length).toBe(0);
    fm.calls[1].settle(ok(baseFrame(20, 10, 4)));
    await flush();
    expect(engine.inputWrites).toEqual([{ input: 1, rect: { x: 0, y: 0, w: 20, h: 10 }, len: 800 }]);
  });

  it('drops a result that arrives after the socket was lost or the bridge disposed', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().close();
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(engine.inputCommits.length).toBe(0);
    vi.advanceTimersByTime(500);
    sock().open();
    sock().tell(hello());
    sock().tell(notice(2));
    await flush();
    bridge.dispose();
    fm.calls[1].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(engine.inputCommits.length).toBe(0);
  });

  it('never acks and ignores binary WebSocket messages from TD', async () => {
    startF();
    const f = baseFrame(64, 48, 1);
    sock().binary(f);
    sock().tell(notice(1));
    await flush();
    expect(engine.inputWrites.length).toBe(0);
    expect(sock().json().some((m) => (m as { t: string }).t === 'ack')).toBe(false);
  });

  it('derives the http origin from the ws url', () => {
    expect(httpOrigin('ws://127.0.0.1:9980/ws')).toBe('http://127.0.0.1:9980');
    expect(httpOrigin('wss://h.example/ws?x=1')).toBe('https://h.example');
  });
});

describe('tdBridge token', () => {
  it('resolves the token verbatim from the query string, empty when absent', () => {
    expect(resolveToken('?token=a%2Bb-_9&x=1')).toBe('a+b-_9');
    expect(resolveToken('?x=1')).toBe('');
    expect(resolveToken('')).toBe('');
  });

  it('v10: the token comes from the URL hash, which wins over a query token', () => {
    expect(resolveToken('', '#token=a%2Bb-_9&e=ed2')).toBe('a+b-_9');
    expect(resolveToken('?token=q', '#token=h&e=x')).toBe('h');
    expect(resolveToken('?token=q', '#e=x')).toBe('q');
    expect(resolveToken('', '')).toBe('');
  });

  it('a token rejection shows a persistent message and stops reconnecting', () => {
    start();
    const fatal: string[] = [];
    (status as unknown as { setFatal: (m: string) => void }).setFatal = (m) => fatal.push(m);
    sock().open();
    sock().tell({ t: 'error', msg: 'bad token' });
    sock().close();
    expect(fatal).toEqual([TOKEN_EXPIRED_MESSAGE]);
    expect(TOKEN_EXPIRED_MESSAGE).toBe('Reopen from TouchDesigner — session expired');
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all.length).toBe(n);
  });

  it('other errors are transient notices and reconnecting continues', () => {
    start();
    sock().open();
    sock().tell({ t: 'error', msg: 'protocol mismatch' });
    sock().close();
    expect(status.notices).toEqual(['protocol mismatch']);
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all.length).toBe(n + 1);
  });
});

describe('tdBridge helpers', () => {
  it('resolves the ws url from the query string', () => {
    expect(resolveWsUrl('', { protocol: 'http:', host: '127.0.0.1:9980' })).toBe('ws://127.0.0.1:9980/ws');
    expect(resolveWsUrl('', { protocol: 'https:', host: 'h' })).toBe('wss://h/ws');
    expect(resolveWsUrl('?ws=ws://x:1/y', { protocol: 'http:', host: 'h' })).toBe('ws://x:1/y');
  });

  it('forwards console.error and window errors, rate limited to 20 per second', () => {
    const sent: unknown[] = [];
    const listeners = new Map<string, (e: unknown) => void>();
    const win = { addEventListener: (t: string, f: (e: unknown) => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) };
    const orig = console.error;
    const quiet = vi.fn();
    console.error = quiet;
    let now = 0;
    const stop = installLogForwarding((m) => sent.push(m), () => now, win as unknown as Window);
    console.error('bad', { a: 1 });
    expect(quiet).toHaveBeenCalledWith('bad', { a: 1 });
    expect(sent[0]).toEqual({ t: 'log', level: 'error', msg: 'bad {"a":1}' });
    listeners.get('error')!({ message: 'oops', filename: 'a.js', lineno: 3, colno: 4 });
    expect((sent[1] as { msg: string }).msg).toBe('oops (a.js:3:4)');
    for (let i = 0; i < 50; i++) console.error('spam');
    expect(sent.length).toBe(20);
    now = 1000;
    console.error('later');
    expect(sent.length).toBe(21);
    stop();
    expect(console.error).toBe(quiet);
    expect(listeners.size).toBe(0);
    console.error = orig;
  });
});


describe('tdBridge v4: fonts and TOP import', () => {
  let fm: FetchMock;
  let fonts: string[][];
  const startV4 = () => {
    fm = new FetchMock();
    engine = new FakeEngine(64, 48);
    status = Object.assign(makeStatus(), { setFonts(f: string[]) { fonts.push(f); } });
    fonts = [];
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 'tok-123', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive();
  };
  const topFrame = (w: number, h: number, v: number) =>
    encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: w, docH: h, x: 0, y: 0, w, h }, new Uint8Array(w * h * 4).fill(v));
  const last = <T extends WebMessage['t']>(t: T) => sock().json().filter((m) => m.t === t).pop() as Extract<WebMessage, { t: T }>;

  it('forwards the fonts message to the status sink', () => {
    startV4();
    sock().tell({ t: 'fonts', families: ['Arial', 'Menlo'] });
    expect(fonts).toEqual([['Arial', 'Menlo']]);
  });

  it('listTops sends a request id and resolves with the tops reply; unrelated ids are ignored', async () => {
    startV4();
    const p = bridge.listTops();
    const req = last('listTops');
    expect(req.requestId).toBeTruthy();
    sock().tell({ t: 'tops', requestId: 'other', items: [] });
    sock().tell({ t: 'tops', requestId: req.requestId, items: [{ path: '/project1/ramp1', w: 100, h: 50 }] });
    await expect(p).resolves.toEqual([{ path: '/project1/ramp1', w: 100, h: 50 }]);
  });

  it('listTops times out after 10 s and rejects when not connected', async () => {
    startV4();
    const p = bridge.listTops();
    const caught = p.catch((e: Error) => e.message);
    vi.advanceTimersByTime(10001);
    expect(await caught).toMatch(/did not answer/);
    sock().close();
    await expect(bridge.listTops()).rejects.toThrow(/Not connected/);
  });

  it('importTop: importTop message, topReady, GET /top with token, client and requestId, then engine.importImage', async () => {
    startV4();
    const p = bridge.importTop('/project1/noise1');
    const req = last('importTop');
    expect(req).toMatchObject({ t: 'importTop', path: '/project1/noise1' });
    expect(fm.calls.length).toBe(0); // nothing is fetched before topReady
    sock().tell({ t: 'topReady', requestId: req.requestId, w: 8, h: 4 });
    await flushP();
    expect(fm.calls.map((c) => c.url)).toEqual([`http://td:9980/top?token=tok-123&client=c1&requestId=${req.requestId}`]);
    fm.calls[0].settle(okBytes(topFrame(8, 4, 77)));
    const id = await p;
    expect(engine.imported).toEqual([{ w: 8, h: 4, name: 'noise1', len: 8 * 4 * 4 }]);
    expect(engine.layers().find((l) => l.id === id)?.name).toBe('noise1');
  });

  it('a TOP larger than the document is passed through at its own size (the engine scales it)', async () => {
    startV4();
    const p = bridge.importTop('/big');
    sock().tell({ t: 'topReady', requestId: last('importTop').requestId, w: 200, h: 100 });
    await flushP();
    fm.calls[0].settle(okBytes(topFrame(200, 100, 1)));
    await p;
    expect(engine.imported[0]).toMatchObject({ w: 200, h: 100 });
  });

  it('topError rejects, raises a notice and fetches nothing', async () => {
    startV4();
    const p = bridge.importTop('/nope');
    const caught = p.catch((e: Error) => e.message);
    sock().tell({ t: 'topError', requestId: last('importTop').requestId, msg: 'not a TOP' });
    expect(await caught).toBe('not a TOP');
    expect(status.notices).toContain('not a TOP');
    expect(fm.calls.length).toBe(0);
    expect(engine.imported.length).toBe(0);
  });

  it('retries a failed /top once, then reports; a 404 (expired) is final and a 403 is a token error', async () => {
    startV4();
    let p = bridge.importTop('/a');
    let caught = p.catch((e: Error) => e.message);
    sock().tell({ t: 'topReady', requestId: last('importTop').requestId, w: 2, h: 2 });
    await flushP();
    fm.calls[0].settle(new Response(null, { status: 500 }));
    await flushP();
    vi.advanceTimersByTime(600);
    await flushP();
    expect(fm.calls.length).toBe(2);
    fm.calls[1].settle(okBytes(topFrame(2, 2, 3)));
    await p;
    expect(engine.imported.length).toBe(1);

    p = bridge.importTop('/b');
    caught = p.catch((e: Error) => e.message);
    sock().tell({ t: 'topReady', requestId: last('importTop').requestId, w: 2, h: 2 });
    await flushP();
    fm.calls[2].settle(new Response(null, { status: 404 }));
    expect(await caught).toMatch(/expired/);
    expect(fm.calls.length).toBe(3);
  });

  it('a /top fetch that hangs is aborted after 10 s', async () => {
    startV4();
    const p = bridge.importTop('/a');
    const caught = p.catch((e: Error) => e.message);
    sock().tell({ t: 'topReady', requestId: last('importTop').requestId, w: 2, h: 2 });
    await flushP();
    expect(fm.calls[0].signal?.aborted).toBe(false);
    vi.advanceTimersByTime(10001);
    expect(fm.calls[0].signal?.aborted).toBe(true);
    await flushP();
    vi.advanceTimersByTime(600);
    await flushP();
    vi.advanceTimersByTime(10001);
    await flushP();
    expect(await caught).toBeTruthy();
    expect(engine.imported.length).toBe(0);
  });

  it('importTop waits at most 30 s for topReady and a disconnect rejects pending requests', async () => {
    startV4();
    const a = bridge.importTop('/slow').catch((e: Error) => e.message);
    vi.advanceTimersByTime(30001);
    expect(await a).toMatch(/did not answer/);
    const b = bridge.listTops().catch((e: Error) => e.message);
    sock().close();
    expect(await b).toMatch(/Disconnected/);
  });

  it('the imported layer reaches TD like any new pixel layer (doc + SURFACE)', async () => {
    startV4();
    vi.advanceTimersByTime(100);
    const before = sock().sent.length;
    const p = bridge.importTop('/p/x');
    sock().tell({ t: 'topReady', requestId: last('importTop').requestId, w: 4, h: 4 });
    await flushP();
    fm.calls[0].settle(okBytes(topFrame(4, 4, 9)));
    const id = await p;
    vi.advanceTimersByTime(100);
    const docs = sock().json().filter((m) => m.t === 'doc');
    expect(sock().sent.length).toBeGreaterThan(before);
    expect((docs[docs.length - 1] as Extract<WebMessage, { t: 'doc' }>).layers.map((l) => l.id)).toContain(id);
  });
});

describe('tdBridge v4 review fixes', () => {
  const textLayer = (over: Partial<LayerSpec> = {}) => spec({
    id: 't1', kind: 'text', slot: null,
    text: { text: 'Hi', font: 'Arial', size: 20, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 0, y: 0, boxWidth: null }, ...over,
  });
  const loadLayers = [spec({ id: 'base', kind: 'input', input: 1 }), spec({ id: 'p1', slot: 1 }), textLayer()];

  it('v5: a load never fetches or pushes anything for text / shape layers (they own no surface)', async () => {
    start(64, 48);
    connectActive({ hasDocument: true, rev: 7 });
    sock().tell(docState(7, loadLayers));
    await flushP();
    expect(fm!.calls.map((c) => new URL(c.url).searchParams.get('slot'))).toEqual(['1']);
    fm!.calls[0].settle(okBytes(dump(1, 64, 48, 9)));
    await flushP();
    vi.advanceTimersByTime(200);
    expect(sock().frames()).toHaveLength(0); // the loaded pixel slot is not echoed either
  });

  it('an INCOMPLETE load (surface keeps failing) pushes nothing', async () => {
    start(64, 48);
    connectActive({ hasDocument: true, rev: 7 });
    sock().tell(docState(7, loadLayers));
    await flushP();
    fm!.calls[0].settle(new Response(null, { status: 500 }));
    await flushP();
    vi.advanceTimersByTime(600);
    await flushP();
    fm!.calls[1].settle(new Response(null, { status: 500 }));
    await flushP();
    vi.advanceTimersByTime(300);
    expect(sock().frames()).toHaveLength(0);
  });

  it('listTops rejects immediately on a topError for its request id', async () => {
    start(64, 48);
    connectActive();
    const p = bridge.listTops().catch((e: Error) => e.message);
    const req = sock().json().filter((m) => m.t === 'listTops').pop() as Extract<WebMessage, { t: 'listTops' }>;
    sock().tell({ t: 'topError', requestId: req.requestId, msg: 'listing failed' });
    expect(await p).toBe('listing failed');
  });

  it('importTop drops its result when the document was reloaded/resized meanwhile', async () => {
    start(64, 48);
    connectActive();
    const p = bridge.importTop('/a').catch((e: Error) => e.message);
    const req = sock().json().filter((m) => m.t === 'importTop').pop() as Extract<WebMessage, { t: 'importTop' }>;
    sock().tell({ t: 'topReady', requestId: req.requestId, w: 2, h: 2 });
    await flushP();
    sock().tell({ t: 'docSize', w: 32, h: 16, hasInput: false, mode: 'input' });
    fm!.calls[0].settle(okBytes(encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: 2, docH: 2, x: 0, y: 0, w: 2, h: 2 }, new Uint8Array(16))));
    expect(await p).toMatch(/document changed/);
    expect(engine.imported).toHaveLength(0);
  });
});


describe('tdBridge v5: canvas, base size, per-slot sizes, flatten', () => {
  let fm: FetchMock;
  const startV5 = (prep?: (e: FakeEngine) => void, over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) => {
    fm = new FetchMock();
    engine = new FakeEngine(64, 48);
    prep?.(engine);
    status = makeStatus();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 'tok-123', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive(over);
  };
  const last = <T extends WebMessage['t']>(t: T) => sock().json().filter((m) => m.t === t).pop() as Extract<WebMessage, { t: T }>;
  const topFrame = (w: number, h: number, v: number) =>
    encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: w, docH: h, x: 0, y: 0, w, h }, new Uint8Array(w * h * 4).fill(v));
  /** a pixel layer with its own surface size */
  const sized = (e: FakeEngine, w: number, h: number) => {
    const id = e.addPixelLayer('Big');
    const l = (e as unknown as { store: { id: string; surfaceW: number | null; surfaceH: number | null }[] }).store.find((x) => x.id === id)!;
    l.surfaceW = w; l.surfaceH = h;
    return id;
  };

  it('the doc message carries guides and the canvas mode', () => {
    startV5((e) => { e.addGuide('h', 10); e.addGuide('v', 20); e.setCanvasMode('fixed'); });
    vi.advanceTimersByTime(100);
    expect(last('doc')).toMatchObject({ guides: { h: [10], v: [20] }, canvas: { mode: 'fixed' } });
  });

  it('guide edits and transforms send a doc only, never SURFACE tiles', () => {
    startV5(withLayer);
    vi.advanceTimersByTime(100);
    const n = sock().frames().length, docs = sock().json().filter((m) => m.t === 'doc').length;
    engine.addGuide('h', 5);
    engine.setTransform('L1', { x: 3, y: 4, sx: 2, sy: 2, rot: 30, kx: 0, ky: 0 });
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(n);
    expect(sock().json().filter((m) => m.t === 'doc').length).toBeGreaterThan(docs);
    expect(last('doc').layers.find((l) => l.id === 'L1')).toMatchObject({ x: 3, y: 4, sx: 2, sy: 2, rot: 30 });
    expect(last('doc').guides.h).toEqual([5]);
  });

  it('a canvas resize sends a doc only (surfaces keep their size)', () => {
    startV5(withLayer);
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    engine.setCanvasSize(100, 80, 'tl');
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(n);
    expect(last('doc')).toMatchObject({ canvas: { mode: 'fixed' } });
  });

  it('setCanvas sends fixed size or follow-input (w,h 0) and only from an active, loaded page', () => {
    startV5();
    expect(bridge.setCanvas(100, 50, 'fixed')).toBe(true);
    expect(last('setCanvas')).toEqual({ t: 'setCanvas', w: 100, h: 50, mode: 'fixed' });
    expect(bridge.setCanvas(100, 50, 'input')).toBe(true);
    expect(last('setCanvas')).toEqual({ t: 'setCanvas', w: 0, h: 0, mode: 'input' });
    sock().tell({ t: 'active', active: false });
    const n = sock().sent.length;
    expect(bridge.setCanvas(10, 10, 'fixed')).toBe(false);
    expect(sock().sent.length).toBe(n);
  });

  it('docSize and hello keep the engine canvas mode in sync, without echoing setCanvas', () => {
    startV5();
    sock().tell({ t: 'docSize', w: 80, h: 60, hasInput: true, mode: 'fixed' });
    expect(engine.canvasMode()).toBe('fixed');
    expect([engine.width, engine.height]).toEqual([80, 60]);
    sock().tell({ t: 'docSize', w: 30, h: 20, hasInput: true, mode: 'input' });
    expect(engine.canvasMode()).toBe('input');
    expect(sock().json().some((m) => m.t === 'setCanvas')).toBe(false);
    sock().tell(hello({ doc: { w: 30, h: 20, mode: 'fixed' } }));
    expect(engine.canvasMode()).toBe('fixed');
  });

  it('inputs go to engine.setInputs (copy) and status.setInputs; BASE frames correct a differing size', async () => {
    startV5();
    const seen: unknown[] = [];
    (status as unknown as { setInputs: (i: unknown) => void }).setInputs = (i) => seen.push(i);
    const items = [{ input: 1, w: 128, h: 96, connected: true }, { input: 2, w: 0, h: 0, connected: false }];
    sock().tell({ t: 'inputs', items });
    expect(engine.calls.filter((c) => c.startsWith('setInputs:')).slice(-1)[0]).toBe(`setInputs:${JSON.stringify(items)}`);
    expect(seen).toEqual([items]);
    const n = engine.calls.filter((c) => c.startsWith('setInputs:')).length;
    sock().tell({ t: 'base', frameId: 1, input: 1, docW: 200, docH: 100, x: 0, y: 0, w: 200, h: 100 });
    await flushP();
    fm.calls[0].settle(okBytes(baseFrame(200, 100, 5)));
    await flushP();
    const calls = engine.calls.filter((c) => c.startsWith('setInputs:'));
    expect(calls).toHaveLength(n + 1); // corrected once
    expect(calls.slice(-1)[0]).toBe(`setInputs:${JSON.stringify([{ input: 1, w: 200, h: 100, connected: true }, items[1]])}`);
    expect(engine.inputWrites).toEqual([{ input: 1, rect: { x: 0, y: 0, w: 200, h: 100 }, len: 200 * 100 * 4 }]);
    expect(engine.inputCommits).toEqual([1]);
    // a frame of the announced size does not touch the list again
    sock().tell({ t: 'base', frameId: 2, input: 1, docW: 200, docH: 100, x: 0, y: 0, w: 200, h: 100 });
    await flushP();
    fm.calls[1].settle(okBytes(baseFrame(200, 100, 6, 2)));
    await flushP();
    expect(engine.calls.filter((c) => c.startsWith('setInputs:'))).toHaveLength(n + 1);
    expect(engine.inputCommits).toEqual([1, 1]);
  });

  it('an inputs message while a BASE fetch is in flight voids that result and fetches again', async () => {
    startV5();
    sock().tell(notice(1));
    await flushP();
    sock().tell({ t: 'inputs', items: [{ input: 1, w: 10, h: 10, connected: true }] });
    fm.calls[0].settle(okBytes(baseFrame(64, 48, 1)));
    await flushP();
    expect(engine.inputWrites).toHaveLength(0);
    expect(fm.calls).toHaveLength(2);
  });

  it('SURFACE frames use the slot\'s own size: full push, clipping, masks follow their layer', () => {
    startV5((e) => { const id = sized(e, 20, 10); e.addMask(id); });
    vi.advanceTimersByTime(100);
    const frames = sock().frames();
    expect(frames.map((f) => f.slot).sort()).toEqual([1, 2]);
    for (const f of frames) expect(f).toMatchObject({ docW: 20, docH: 10, x: 0, y: 0, w: 20, h: 10 });
    const n = frames.length;
    engine.emit({ type: 'surface', slot: 1, rect: { x: 15, y: 5, w: 30, h: 30 } });
    vi.advanceTimersByTime(200);
    expect(sock().frames().slice(n)[0]).toMatchObject({ docW: 20, docH: 10, x: 15, y: 5, w: 5, h: 5 });
    engine.emit({ type: 'surface', slot: 1, rect: { x: 40, y: 40, w: 4, h: 4 } }); // outside the 20x10 surface
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(n + 1);
  });

  it('loading a document: per-slot stale checks use the spec sizes and the guides / canvas reach the engine', async () => {
    startV5(undefined, { hasDocument: true, rev: 7 });
    const layers = [spec({ id: 'base', kind: 'input', input: 1, surfaceW: 64, surfaceH: 48 }), spec({ id: 'p1', slot: 1, surfaceW: 20, surfaceH: 10, mask: { slot: 2, enabled: true } })];
    sock().tell({ ...(docState(3, layers) as Extract<TdMessage, { t: 'docState' }>), guides: { h: [4], v: [8] }, canvas: { mode: 'fixed' } });
    await flushP();
    expect(engine.loaded[0]).toMatchObject({ guides: { h: [4], v: [8] }, canvas: { mode: 'fixed' } });
    expect(fm.calls).toHaveLength(2);
    fm.calls[0].settle(okBytes(dump(1, 20, 10, 9)));
    fm.calls[1].settle(okBytes(dump(2, 64, 48, 9))); // wrong size for a mask of a 20x10 layer
    await flushP();
    expect(engine.surfaceWrites.map((w) => w.slot)).toEqual([1]);
  });

  it('renderLayer: renderLayer message, topReady, GET /top, then engine.replaceWithPixels at document size', async () => {
    startV5((e) => { e.addTextLayer({ text: 'Hi', font: 'Arial', size: 20, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 0, y: 0, boxWidth: null }); });
    const p = bridge.renderLayer('L1');
    const req = last('renderLayer');
    expect(req).toMatchObject({ t: 'renderLayer', layerId: 'L1' });
    expect(fm.calls.length).toBe(0);
    sock().tell({ t: 'topReady', requestId: req.requestId, w: 64, h: 48 });
    await flushP();
    expect(fm.calls.map((c) => c.url)).toEqual([`http://td:9980/top?token=tok-123&client=c1&requestId=${req.requestId}`]);
    fm.calls[0].settle(okBytes(topFrame(64, 48, 33)));
    await p;
    expect(engine.replaced).toEqual([{ id: 'L1', w: 64, h: 48, len: 64 * 48 * 4 }]);
    expect(engine.layers().find((l) => l.id === 'L1')?.kind).toBe('pixel');
  });

  it('renderLayer: topError rejects with TD\'s message, a layer that changed is not replaced, and offline rejects', async () => {
    startV5((e) => { e.addTextLayer({ text: 'Hi', font: 'Arial', size: 20, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 0, y: 0, boxWidth: null }); });
    const p = bridge.renderLayer('L1').catch((e: Error) => e.message);
    sock().tell({ t: 'topError', requestId: last('renderLayer').requestId, msg: 'layer not renderable' });
    expect(await p).toBe('layer not renderable');
    expect(fm.calls).toHaveLength(0);

    const p2 = bridge.renderLayer('L1').catch((e: Error) => e.message);
    sock().tell({ t: 'topReady', requestId: last('renderLayer').requestId, w: 64, h: 48 });
    await flushP();
    engine.deleteLayer('L1');
    fm.calls[0].settle(okBytes(topFrame(64, 48, 1)));
    expect(await p2).toMatch(/changed/);
    expect(engine.replaced).toHaveLength(0);

    sock().close();
    await expect(bridge.renderLayer('L1')).rejects.toThrow(/Not connected/);
  });
});

describe('tdBridge v5 review fixes', () => {
  const startR = (prep?: (e: FakeEngine) => void, over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) => {
    engine = new FakeEngine(64, 48);
    prep?.(engine);
    status = makeStatus();
    fm = new FetchMock();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 'tok-123', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive(over);
  };
  const setCanvases = () => sock().json().filter((m) => m.t === 'setCanvas') as Extract<WebMessage, { t: 'setCanvas' }>[];
  const textSpec = { text: 'Hi', font: 'Arial', size: 20, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 0, y: 0, boxWidth: null } as const;

  it('canvas changes from the engine (dialog, undo, redo) are sent once each; TD-originated ones are not echoed', () => {
    startR();
    engine.setCanvasSize(100, 80, 'tl');
    expect(setCanvases()).toEqual([{ t: 'setCanvas', w: 100, h: 80, mode: 'fixed' }]);
    bridge.setCanvas(100, 80, 'fixed'); // the store's explicit call right after: already known to TD
    expect(setCanvases()).toHaveLength(1);
    engine.undo();
    expect(setCanvases().slice(-1)[0]).toEqual({ t: 'setCanvas', w: 0, h: 0, mode: 'input' }); // back to following the input
    expect(setCanvases()).toHaveLength(2);
    sock().tell({ t: 'docSize', w: 64, h: 48, hasInput: true, mode: 'input' });
    sock().tell({ t: 'docSize', w: 30, h: 20, hasInput: true, mode: 'fixed' });
    expect(setCanvases()).toHaveLength(2);
  });

  it('a canvas change while on standby or loading is not sent', () => {
    startR();
    sock().tell({ t: 'active', active: false });
    engine.setCanvasSize(100, 80, 'tl');
    expect(setCanvases()).toHaveLength(0);
  });

  it('a docSize that arrives while the document loads is applied after the load, never mid-load', async () => {
    startR(undefined, { hasDocument: true, rev: 7 });
    sock().tell(docState(7));
    await flushP();
    expect(engine.loaded).toHaveLength(1);
    const before = engine.calls.length;
    sock().tell({ t: 'docSize', w: 30, h: 20, hasInput: true, mode: 'fixed' });
    expect(engine.calls.slice(before).some((c) => c.startsWith('adoptCanvas') || c.startsWith('resize'))).toBe(false);
    for (let i = 0; i < 4; i++) {
      for (const c of [...fm!.calls]) c.settle(okBytes(dump(Number(new URL(c.url).searchParams.get('slot')), 64, 48, 1)));
      await flushP();
    }
    expect(engine.calls.slice(before)).toContain('adoptCanvas:30x20:fixed');
    expect(setCanvases()).toHaveLength(0);
  });

  it('Flatten flushes a pending doc first and aborts when the layer changed while TD rendered', async () => {
    startR((e) => { e.addTextLayer(textSpec); });
    vi.advanceTimersByTime(100);
    const text = engine.layers().find((l) => l.kind === 'text')!;
    engine.setText(text.id, { ...textSpec, text: 'Edited' }); // pending doc, not yet sent (raf not run)
    const docsBefore = sock().json().filter((m) => m.t === 'doc').length;
    const p = bridge.renderLayer(text.id).catch((e: Error) => e.message);
    const all = sock().json();
    const iDoc = all.map((m) => m.t).lastIndexOf('doc'), iRender = all.map((m) => m.t).lastIndexOf('renderLayer');
    expect(all.filter((m) => m.t === 'doc').length).toBe(docsBefore + 1);
    expect(iDoc).toBeLessThan(iRender);
    const req = all[iRender] as Extract<WebMessage, { t: 'renderLayer' }>;
    sock().tell({ t: 'topReady', requestId: req.requestId, w: 64, h: 48 });
    await flushP();
    engine.setText(text.id, { ...textSpec, text: 'Changed again' });
    fm!.calls[0].settle(okBytes(encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: 64, docH: 48, x: 0, y: 0, w: 64, h: 48 }, new Uint8Array(64 * 48 * 4))));
    expect(await p).toMatch(/changed/);
    expect(engine.replaced).toHaveLength(0);
  });

  it('hello.inputs updates the inputs (an input removed while the page was away)', () => {
    startR(undefined, { inputs: [{ input: 1, w: 0, h: 0, connected: false }] });
    expect(engine.calls.filter((c) => c.startsWith('setInputs:'))).toEqual(['setInputs:[{"input":1,"w":0,"h":0,"connected":false}]']);
    sock().tell(hello({ doc: { w: 64, h: 48 }, inputs: [{ input: 1, w: 100, h: 50, connected: true }] }));
    expect(engine.calls.filter((c) => c.startsWith('setInputs:')).slice(-1)[0]).toBe('setInputs:[{"input":1,"w":100,"h":50,"connected":true}]');
  });

  it('hello.inputs and inputs are deferred while the document loads', async () => {
    startR(undefined, { hasDocument: true, rev: 7, inputs: [{ input: 1, w: 100, h: 50, connected: true }] });
    sock().tell({ t: 'inputs', items: [{ input: 1, w: 100, h: 50, connected: true }, { input: 2, w: 8, h: 8, connected: true }] });
    expect(engine.calls.some((c) => c.startsWith('setInputs:'))).toBe(false);
    sock().tell(docState(7));
    await flushP();
    expect(engine.calls.some((c) => c.startsWith('setInputs:'))).toBe(false); // still loading surfaces
    for (let i = 0; i < 4; i++) {
      for (const c of [...fm!.calls]) c.settle(okBytes(dump(Number(new URL(c.url).searchParams.get('slot')), 64, 48, 1)));
      await flushP();
    }
    const calls = engine.calls.filter((c) => c.startsWith('setInputs:'));
    expect(calls).toEqual(['setInputs:[{"input":1,"w":100,"h":50,"connected":true},{"input":2,"w":8,"h":8,"connected":true}]']); // newest list only
  });
});

describe('tdBridge v6 inputs (per-input BASE)', () => {
  let fmv: FetchMock;
  const startI = () => {
    fmv = new FetchMock();
    engine = new FakeEngine(64, 48);
    status = makeStatus();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 't', fetch: fmv.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive({ inputs: [{ input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 32, h: 16, connected: true }] });
  };
  const inputOf = (c: { url: string }) => Number(new URL(c.url).searchParams.get('input'));

  it('hello.inputs reach the engine; each input is fetched with its own input query param', async () => {
    startI();
    expect(engine.calls.filter((c) => c.startsWith('setInputs:'))).toHaveLength(1);
    sock().tell(notice(4, 64, 48, 1));
    sock().tell(notice(9, 32, 16, 2));
    await flushP();
    expect(fmv.calls.map((c) => c.url)).toEqual([
      'http://td:9980/base?token=t&client=c1&frameId=4&input=1',
      'http://td:9980/base?token=t&client=c1&frameId=9&input=2',
    ]);
  });

  it('two inputs interleave: results land in their own input and commit once each', async () => {
    startI();
    sock().tell(notice(1, 64, 48, 1));
    sock().tell(notice(2, 32, 16, 2));
    await flushP();
    fmv.calls[1].settle(okBytes(baseFrame(32, 16, 7, 2, 2))); // input 2 finishes first
    await flushP();
    expect(engine.inputWrites).toEqual([{ input: 2, rect: { x: 0, y: 0, w: 32, h: 16 }, len: 32 * 16 * 4 }]);
    expect(engine.inputCommits).toEqual([2]);
    fmv.calls[0].settle(okBytes(baseFrame(64, 48, 8, 1, 1)));
    await flushP();
    expect(engine.inputWrites.map((w) => w.input)).toEqual([2, 1]);
    expect(engine.inputCommits).toEqual([2, 1]);
    expect(engine.calls.filter((c) => c.startsWith('setInputs:'))).toHaveLength(1); // sizes matched the announcement
  });

  it('single flight per input, newest notice wins; the other input is not blocked', async () => {
    startI();
    sock().tell(notice(1, 64, 48, 1));
    sock().tell(notice(2, 64, 48, 1));
    sock().tell(notice(3, 64, 48, 1));
    sock().tell(notice(10, 32, 16, 2));
    await flushP();
    expect(fmv.calls.map(inputOf)).toEqual([1, 2]);
    fmv.calls[0].settle(okBytes(baseFrame(64, 48, 1)));
    await flushP();
    expect(fmv.calls).toHaveLength(3);
    expect(fmv.calls[2].url).toContain('frameId=3&input=1');
    fmv.calls[2].settle(okBytes(baseFrame(64, 48, 2)));
    fmv.calls[1].settle(okBytes(baseFrame(32, 16, 2, 10, 2)));
    await flushP();
    expect(fmv.calls).toHaveLength(3);
    expect(engine.inputCommits.slice().sort()).toEqual([1, 1, 2]);
  });

  it('drops a frame whose header slot is not the requested input', async () => {
    startI();
    sock().tell(notice(1, 64, 48, 1));
    await flushP();
    fmv.calls[0].settle(okBytes(baseFrame(64, 48, 1, 1, 2)));
    await flushP();
    expect(engine.inputWrites).toEqual([]);
    expect(engine.inputCommits).toEqual([]);
  });

  it('a BASE frame of another size updates the known list (connected stays true) and an unknown input is added', async () => {
    startI();
    sock().tell(notice(1, 40, 30, 2));
    sock().tell(notice(1, 8, 8, 3));
    await flushP();
    fmv.calls[0].settle(okBytes(baseFrame(40, 30, 1, 1, 2)));
    await flushP();
    fmv.calls[1].settle(okBytes(baseFrame(8, 8, 1, 1, 3)));
    await flushP();
    const last = engine.calls.filter((c) => c.startsWith('setInputs:')).slice(-1)[0];
    expect(JSON.parse(last.slice('setInputs:'.length))).toEqual([
      { input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 40, h: 30, connected: true }, { input: 3, w: 8, h: 8, connected: true },
    ]);
  });

  it('a socket loss resets per-input state: a late result is dropped and a new notice fetches again', async () => {
    startI();
    sock().tell(notice(1, 64, 48, 1));
    await flushP();
    sock().close();
    fmv.calls[0].settle(okBytes(baseFrame(64, 48, 1)));
    await flushP();
    expect(engine.inputCommits).toEqual([]);
    vi.advanceTimersByTime(500);
    sock().open();
    sock().tell(hello({ inputs: [{ input: 1, w: 64, h: 48, connected: true }] }));
    sock().tell(notice(2, 64, 48, 1));
    await flushP();
    expect(fmv.calls).toHaveLength(2);
    fmv.calls[1].settle(okBytes(baseFrame(64, 48, 1, 2)));
    await flushP();
    expect(engine.inputCommits).toEqual([1]);
  });

  it('a v5 peer (protocol 5 hello) is refused', () => {
    startI();
    const before = status.notices.length;
    sock().tell(hello({ protocol: 5 }));
    expect(status.notices.length).toBe(before + 1);
    expect(status.notices.slice(-1)[0]).toMatch(/mismatch/i);
  });
});

describe('tdBridge v6 files and reload', () => {
  let fmf: FetchMock;
  const startF6 = (prep?: (e: FakeEngine) => void, over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) => {
    fmf = new FetchMock();
    engine = new FakeEngine(64, 48);
    prep?.(engine);
    status = makeStatus();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 't', fetch: fmf.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive(over);
  };
  const lastOf = <K extends WebMessage['t']>(t: K) => sock().json().filter((m) => m.t === t).slice(-1)[0] as Extract<WebMessage, { t: K }>;
  const finishLoad = async () => {
    for (let i = 0; i < 4; i++) {
      for (const c of [...fmf.calls]) if (!c.signal?.aborted) c.settle(okBytes(dump(Number(new URL(c.url).searchParams.get('slot')), 64, 48, 1)));
      await flushP();
    }
  };

  it('files updates status.setFiles', () => {
    startF6();
    const got: unknown[] = [];
    (status as unknown as { setFiles: (f: unknown) => void }).setFiles = (f) => got.push(f);
    sock().tell({ t: 'files', projectFile: '/a.redoc', pngFile: '/a.png' });
    expect(got).toEqual([{ projectFile: '/a.redoc', pngFile: '/a.png' }]);
  });

  it.each([['saveProject'], ['openProject'], ['exportPng']] as const)('%s: request with a requestId, resolved by the matching fileResult (also when ok is false)', async (op) => {
    startF6();
    const p = bridge[op]('/x/y');
    const req = lastOf(op);
    expect(req).toMatchObject({ t: op, path: '/x/y' });
    expect(req.requestId).toMatch(/^f\d+$/);
    sock().tell({ t: 'fileResult', requestId: req.requestId, op, ok: false, path: '/x/y', msg: 'nope' });
    await expect(p).resolves.toEqual({ op, ok: false, path: '/x/y', msg: 'nope' });
    const p2 = bridge[op]();
    const req2 = lastOf(op);
    expect('path' in req2).toBe(false);
    expect(req2.requestId).not.toBe(req.requestId);
    sock().tell({ t: 'fileResult', requestId: req2.requestId, op, ok: true, path: '/default' });
    await expect(p2).resolves.toEqual({ op, ok: true, path: '/default' });
  });

  it('a fileResult nobody waits for (pulse in TD) goes to status.onFileResult; a matched one does not', async () => {
    startF6();
    const got: unknown[] = [];
    (status as unknown as { onFileResult: (r: unknown) => void }).onFileResult = (r) => got.push(r);
    sock().tell({ t: 'fileResult', op: 'exportPng', ok: true, path: '/p.png' });
    sock().tell({ t: 'fileResult', requestId: 'f999', op: 'saveProject', ok: true, path: '/q' });
    expect(got).toEqual([{ op: 'exportPng', ok: true, path: '/p.png' }, { op: 'saveProject', ok: true, path: '/q' }]);
    const p = bridge.saveProject();
    sock().tell({ t: 'fileResult', requestId: lastOf('saveProject').requestId, op: 'saveProject', ok: true, path: '/r' });
    await p;
    expect(got).toHaveLength(2);
  });

  it('rejects when not connected, on a 60 s timeout, and on disconnect', async () => {
    startF6();
    const p = bridge.exportPng().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(59999);
    sock().tell({ t: 'files', projectFile: '', pngFile: '' }); // unrelated traffic
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatch(/did not answer/);
    const p2 = bridge.openProject().catch((e: Error) => e.message);
    sock().close();
    expect(await p2).toMatch(/Disconnected/);
    await expect(bridge.saveProject()).rejects.toThrow(/Not connected/);
    await expect(bridge.openProject()).rejects.toThrow(/Not connected/);
    await expect(bridge.exportPng()).rejects.toThrow(/Not connected/);
  });

  it('save / export first send the pending doc and every dirty surface (rate limit ignored), then the request; open does not', async () => {
    startF6(withLayer);
    vi.advanceTimersByTime(100);
    await flushP();
    const base = sock().sent.length;
    engine.setLayerProps('L1', { opacity: 0.5 }); // doc pending (raf not run yet)
    engine.fillSurface(1, { x: 1, y: 1, w: 2, h: 2 }, [1, 2, 3, 255]); // dirty, rate limited
    const p = bridge.saveProject();
    const sent = sock().all().slice(base);
    expect(sent.map((s) => ('json' in s ? s.json.t : `frame${s.frame.slot}`))).toEqual(['doc', 'frame1', 'saveProject']);
    const docMsg = (sent[0] as { json: Extract<WebMessage, { t: 'doc' }> }).json;
    expect(docMsg.layers.find((l) => l.id === 'L1')?.opacity).toBe(0.5);
    sock().tell({ t: 'fileResult', requestId: lastOf('saveProject').requestId, op: 'saveProject', ok: true, path: '/s' });
    await p;
    // nothing is sent twice afterwards
    vi.advanceTimersByTime(500);
    expect(sock().all().slice(base).map((s) => ('json' in s ? s.json.t : 'frame'))).toEqual(['doc', 'frame', 'saveProject']);
    // export also syncs; openProject does not
    engine.fillSurface(1, { x: 5, y: 5, w: 1, h: 1 }, [9, 9, 9, 255]);
    void bridge.exportPng().catch(() => {});
    expect(sock().all().slice(-2).map((s) => ('json' in s ? s.json.t : 'frame'))).toEqual(['frame', 'exportPng']);
    engine.fillSurface(1, { x: 6, y: 6, w: 1, h: 1 }, [9, 9, 9, 255]);
    void bridge.openProject().catch(() => {});
    expect(at(sock().all(), -1)).toMatchObject({ json: { t: 'openProject' } });
  });

  it('a standby or loading page sends no doc / surfaces before a save', async () => {
    startF6(withLayer, { active: false, hasDocument: true, rev: 2 });
    engine.fillSurface(1, { x: 0, y: 0, w: 2, h: 2 }, [1, 1, 1, 255]);
    const p = bridge.saveProject().catch(() => {});
    expect(sock().json().map((m) => m.t)).toEqual(['ready', 'saveProject']);
    expect(sock().frames()).toEqual([]);
    void p;
  });

  it('reload: an active page drops its document and reloads via requestDoc with the loading state', async () => {
    startF6(withLayer, { hasDocument: true, rev: 7 });
    sock().tell(docState(7, [tdLayers[0], tdLayers[1]]));
    await flushP();
    await finishLoad();
    expect(at(status.loading, -1)).toBe(false);
    expect(engine.loaded).toHaveLength(1);
    const req = sock().json().filter((m) => m.t === 'requestDoc').length;
    engine.fillSurface(1, { x: 0, y: 0, w: 2, h: 2 }, [1, 1, 1, 255]); // dirty, never to be sent after the reload
    sock().tell({ t: 'reload', rev: 8 });
    expect(at(status.loading, -1)).toBe(true);
    expect(sock().json().filter((m) => m.t === 'requestDoc').length).toBe(req + 1);
    vi.advanceTimersByTime(500);
    expect(sock().frames()).toEqual([]);
    const docs = sock().json().filter((m) => m.t === 'doc').length;
    engine.setLayerProps('p1', { opacity: 0.2 }); // locked while loading: nothing pushed
    vi.advanceTimersByTime(500);
    expect(sock().json().filter((m) => m.t === 'doc').length).toBe(docs);
    sock().tell(docState(8, [tdLayers[0], tdLayers[1]]));
    await flushP();
    await finishLoad();
    expect(engine.loaded).toHaveLength(2);
    expect(engine.loaded[1].rev).toBe(8);
    expect(at(status.loading, -1)).toBe(false);
    expect(sock().frames()).toEqual([]);
  });

  it('reload during a load cancels it: the old document is not completed', async () => {
    startF6(withLayer, { hasDocument: true, rev: 7 });
    sock().tell(docState(7, [tdLayers[0], tdLayers[1]]));
    await flushP();
    const commits = engine.surfaceCommits;
    sock().tell({ t: 'reload', rev: 9 });
    for (const c of fmf.calls) c.settle(okBytes(dump(Number(new URL(c.url).searchParams.get('slot')), 64, 48, 1)));
    await flushP();
    expect(engine.surfaceWrites).toEqual([]);
    expect(at(status.loading, -1)).toBe(true);
    expect(engine.surfaceCommits).toBe(commits);
    sock().tell(docState(9, [tdLayers[0]]));
    await flushP();
    expect(engine.loaded).toHaveLength(2);
    expect(at(status.loading, -1)).toBe(false);
  });

  it('inputs applied at load completion that auto-create layers are pushed to TD as a doc', async () => {
    startF6(undefined, { hasDocument: true, rev: 7, inputs: [{ input: 1, w: 64, h: 48, connected: true }, { input: 2, w: 8, h: 8, connected: true }] });
    sock().tell(docState(7, [tdLayers[0], tdLayers[1]])); // TD's document has input 1 only
    await flushP();
    expect(sock().json().some((m) => m.t === 'doc')).toBe(false); // nothing pushed while loading
    await finishLoad();
    const docs = sock().json().filter((m): m is Extract<WebMessage, { t: 'doc' }> => m.t === 'doc');
    expect(docs).toHaveLength(1);
    expect(docs[0].layers.some((l) => l.kind === 'input' && l.input === 2)).toBe(true);
    expect(docs[0].rev).toBe(engine.docSpec().rev);
  });

  it('reload re-applies the known inputs (engine + status) once the reload load completes, incl. a pending inputs message', async () => {
    startF6(undefined, { hasDocument: true, rev: 7, inputs: [{ input: 1, w: 64, h: 48, connected: true }] });
    const seen: unknown[] = [];
    (status as unknown as { setInputs: (i: unknown) => void }).setInputs = (i) => seen.push(i);
    sock().tell(docState(7, [tdLayers[0], tdLayers[1]]));
    await flushP();
    await finishLoad();
    const setCalls = () => engine.calls.filter((c) => c.startsWith('setInputs:')).length;
    const n = setCalls(), m = seen.length;
    sock().tell({ t: 'reload', rev: 8 });
    expect(setCalls()).toBe(n); // not before the load completes
    sock().tell(docState(8, [tdLayers[0], tdLayers[1]]));
    await flushP();
    expect(setCalls()).toBe(n);
    await finishLoad();
    expect(setCalls()).toBe(n + 1);
    expect(seen.length).toBe(m + 1);
    expect(seen[seen.length - 1]).toEqual([{ input: 1, w: 64, h: 48, connected: true }]);
    // an inputs message arriving during the reload is applied instead (and only once)
    sock().tell({ t: 'reload', rev: 9 });
    sock().tell({ t: 'inputs', items: [{ input: 1, w: 64, h: 48, connected: false }] });
    expect(setCalls()).toBe(n + 1);
    sock().tell(docState(9, [tdLayers[0], tdLayers[1]]));
    await flushP();
    await finishLoad();
    expect(setCalls()).toBe(n + 2);
    expect(engine.calls.filter((c) => c.startsWith('setInputs:')).slice(-1)[0]).toBe('setInputs:[{"input":1,"w":64,"h":48,"connected":false}]');
  });

  it('reload on a standby page defers: the next takeover loads TD\'s document', async () => {
    startF6(withLayer, { active: false, hasDocument: true, rev: 3 });
    sock().tell({ t: 'reload', rev: 4 });
    expect(sock().json().map((m) => m.t)).toEqual(['ready']);
    expect(status.loading).not.toContain(true);
    sock().tell({ t: 'active', active: true });
    expect(at(sock().json(), -1)).toEqual({ t: 'requestDoc' });
    expect(at(status.loading, -1)).toBe(true);
  });
});

describe('tdBridge v6 chooseFile', () => {
  let fmc: FetchMock;
  const startC = () => {
    fmc = new FetchMock();
    engine = new FakeEngine(64, 48);
    status = makeStatus();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', token: 't', fetch: fmc.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive();
  };
  const lastChoose = () => sock().json().filter((m) => m.t === 'chooseFile').slice(-1)[0] as Extract<WebMessage, { t: 'chooseFile' }>;

  it.each(['saveProject', 'openProject', 'exportPng'] as const)('chooseFile(%s) resolves with the path or null when cancelled', async (purpose) => {
    startC();
    const p = bridge.chooseFile(purpose);
    expect(lastChoose()).toMatchObject({ t: 'chooseFile', purpose });
    sock().tell({ t: 'fileChosen', requestId: lastChoose().requestId, path: '/x/a.redoc' });
    await expect(p).resolves.toBe('/x/a.redoc');
    const p2 = bridge.chooseFile(purpose);
    sock().tell({ t: 'fileChosen', requestId: lastChoose().requestId, path: null });
    await expect(p2).resolves.toBeNull();
  });

  it('chooseFile rejects when offline, on disconnect and after 5 minutes', async () => {
    startC();
    const p = bridge.chooseFile('openProject').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(299999);
    sock().tell({ t: 'files', projectFile: '', pngFile: '' });
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatch(/did not answer/);
    const p2 = bridge.chooseFile('exportPng').catch((e: Error) => e.message);
    sock().close();
    expect(await p2).toMatch(/Disconnected/);
    await expect(bridge.chooseFile('saveProject')).rejects.toThrow(/Not connected/);
  });



});

// ---- v11: VIEW_FAST / VIEW_EXACT over the socket ----

describe('tdBridge v11 view frames', () => {
  const bmp = () => ({ width: 16, height: 16, close() {} }) as unknown as ImageBitmap;
  const decodeJpeg = () => Promise.resolve(bmp());
  const log: string[] = [];
  const shown: (string | null)[] = [];
  const sink: ViewSink = { fast: (i) => { log.push(`fast ${i.x},${i.y},${i.w},${i.h}`); }, exact: (b, d) => { log.push(`exact ${d.length} ${b.w}x${b.h}`); }, show: (k) => log.push(`show ${k}`), clear: () => log.push('clear') };
  const startV = () => {
    log.length = 0; shown.length = 0;
    start(64, 48, withLayer, { decodeJpeg });
    // the sink is read from the status object at construction: rebuild with it
    bridge.dispose();
    engine = new FakeEngine(64, 48); withLayer(engine);
    status = Object.assign(makeStatus(), { viewSink: sink, setViewShown: (k: string | null) => shown.push(k) });
    fm = new FetchMock();
    bridge = startTdBridge(engine, status as never, { url: 'ws://td:9980/ws', token: 'tok-123', WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, fetch: fm.fn, raf, dpr: () => 1, decodeJpeg });
    connectActive();
    bridge.setView({ mode: 'td', zoom: 1, panX: 0, panY: 0, rect: { x: 0, y: 0, w: 64, h: 48 } });
    vi.advanceTimersByTime(20);
    log.length = 0; shown.length = 0;
  };
  const acks = () => sock().json().filter((m) => m.t === 'viewAck').map((m) => (m as { frameId: number }).frameId);

  it('a binary VIEW_FAST frame is decoded, shown and acked; the stroke -> view latency comes from appliedFrameId', async () => {
    startV();
    engine.emit({ type: 'surface', slot: 1, rect: { x: 0, y: 0, w: 2, h: 2 } });
    vi.advanceTimersByTime(40);
    const id = at(sock().frames(), -1).frameId;
    vi.advanceTimersByTime(60);
    sock().binary(fastFrame({ frameId: 4, appliedFrameId: id, x: 1, y: 2, w: 30, h: 20 }));
    await flushP();
    expect(log).toEqual(['fast 1,2,30,20', 'show fast']);
    expect(acks()).toEqual([4]);
    expect(shown).toEqual(['fast']);
    expect(status.viewLatency).toHaveLength(1);
    expect(status.viewLatency[0].median).toBeGreaterThanOrEqual(80);
    expect(status.viewLatency[0].median).toBeLessThanOrEqual(100);
  });

  /** DecompressionStream runs on real macrotasks: wait for a condition with real timers while the fake clock stays installed. */
  const until = async (cond: () => boolean) => {
    vi.useRealTimers();
    try { for (let i = 0; i < 200 && !cond(); i++) await new Promise<void>((r) => setTimeout(r, 10)); } finally { vi.useFakeTimers(); vi.setSystemTime(100000); }
  };

  it('exact frames (socket) apply, and a tile frame without a buffer asks for a reset', async () => {
    startV();
    sock().binary(await exactTiles(64, 48, [{ tx: 0, ty: 0, w: 64, h: 48, rgba: solid(64, 48, 1, 2, 3) }]));
    await until(() => sock().json().some((m) => m.t === 'viewExactReset'));
    expect(sock().json().filter((m) => m.t === 'viewExactReset')).toHaveLength(1);
    sock().binary(await exactFull(64, 48, solid(64, 48, 1, 2, 3), 5, 1));
    await until(() => log.includes('exact 1 64x48'));
    expect(log).toContain('exact 1 64x48');
    expect(shown.at(-1)).toBe('exact');
    expect(acks()).toEqual([2, 5]); // both exact frames are acked (default tile frame id 2)
  });

  it('a viewExact notice is fetched with GET /view?exact=1&frameId=', async () => {
    startV();
    sock().tell({ t: 'viewExact', frameId: 12, size: 9e6 });
    await flushP();
    expect(fm!.calls.map((c) => c.url)).toEqual(['http://td:9980/view?token=tok-123&client=c1&exact=1&frameId=12']);
  });

  it('leaving TD mode and a socket close reset the view state; unknown frame types are ignored', async () => {
    startV();
    sock().binary(fastFrame({ frameId: 1 }));
    await flushP();
    log.length = 0;
    bridge.setView({ mode: 'local', zoom: 1, panX: 0, panY: 0, rect: { x: 0, y: 0, w: 64, h: 48 } });
    vi.advanceTimersByTime(20);
    expect(log).toEqual(['clear']);
    log.length = 0;
    const junk = new Uint8Array(40); junk.set([0x52, 0x45, 0x46, 0x31, 99]);
    sock().binary(junk);
    await flushP();
    expect(log).toEqual([]);
    sock().close();
    expect(log).toEqual(['clear']);
  });
});
