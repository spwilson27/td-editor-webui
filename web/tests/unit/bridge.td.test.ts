import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_TOP, FRAME_VIEW, decodeFrame, encodeFrame, decodeWebMessage, encodeBands, encodeMessage,
  type Frame, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';
import {
  BACKPRESSURE_BYTES, SURFACE_FETCH_CONCURRENCY, installLogForwarding, httpOrigin, latencyStats, resolveClient, resolveToken, resolveWsUrl, TOKEN_EXPIRED_MESSAGE,
  startTdBridge, type Bridge, type Connection, type LatencyStats, type ViewState,
} from '../../src/bridge/tdBridge';
import type { LayerSpec } from '../../src/engine/types';
import { FakeEngine } from '../browser/fakeEngine';

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
  t: 'hello', protocol: 5, doc: { w: 64, h: 48 }, hasInput: false, maxSendFps: 30, active: true, clientId: 'c1', hasDocument: false, rev: null, ...over,
});

interface TestStatus {
  conn: Connection[]; active: boolean[]; notices: string[]; latency: LatencyStats[]; viewLatency: LatencyStats[];
  loading: boolean[];
  viewFrames: { w: number; h: number; first: number[]; age: number }[];
  setConnection(c: Connection): void; setActive(a: boolean): void; setNotice(m: string): void;
  setLoading(b: boolean): void;
  setLatency(s: LatencyStats): void; setViewLatency(s: LatencyStats): void; setViewFrame(w: number, h: number, d: Uint8ClampedArray, age: number): void;
}
const makeStatus = (): TestStatus => ({
  conn: [], active: [], notices: [], latency: [], viewLatency: [], viewFrames: [], loading: [],
  setLoading(b) { this.loading.push(b); },
  setConnection(c) { this.conn.push(c); }, setActive(a) { this.active.push(a); }, setNotice(m) { this.notices.push(m); },
  setLatency(s) { this.latency.push(s); }, setViewLatency(s) { this.viewLatency.push(s); },
  setViewFrame(w, h, d, age) { this.viewFrames.push({ w, h, first: Array.from(d.subarray(0, 4)), age }); },
});

let engine: FakeEngine;
let status: TestStatus;
let bridge: Bridge;
let fm: FetchMock | null = null;
const at = <T>(a: T[], i: number): T => a[a.length + i];
const sock = () => FakeSocket.all[FakeSocket.all.length - 1];
const raf = (cb: () => void) => setTimeout(cb, 16);

function start(w = 64, h = 48, prep?: (e: FakeEngine) => void) {
  engine = new FakeEngine(w, h);
  prep?.(engine);
  status = makeStatus();
  fm = new FetchMock();
  bridge = startTdBridge(engine, status, {
    url: 'ws://td:9980/ws', client: 'panel', token: 'tok-123', WebSocketCtor: FakeSocket as unknown as typeof WebSocket,
    forwardLogs: false, fetch: fm.fn, raf,
  });
}
function connectActive(over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) { sock().open(); sock().tell(hello({ doc: { w: engine.width, h: engine.height }, ...over })); }
const withLayer = (e: FakeEngine) => { e.addPixelLayer('Layer 1'); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); FakeSocket.all = []; });
afterEach(() => { bridge?.dispose(); vi.useRealTimers(); });

describe('tdBridge session', () => {
  it('sends ready{protocol 5, fresh} after open', () => {
    start();
    expect(status.conn).toEqual(['reconnecting']);
    expect(sock().url).toBe('ws://td:9980/ws');
    expect(sock().binaryType).toBe('arraybuffer');
    sock().open();
    expect(sock().json()).toEqual([{ t: 'ready', protocol: 5, client: 'panel', version: '0.1.0', token: 'tok-123', fresh: true }]);
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
  kind: 'pixel', parentId: null, name: over.id, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, slot: null, mask: null, adjustment: null, text: null, shape: null, sx: 1, sy: 1, surfaceW: null, surfaceH: null, ...over,
});
const tdLayers: LayerSpec[] = [
  spec({ id: 'base', kind: 'base' }),
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
    expect(fm!.calls.map((c) => Number(new URL(c.url).searchParams.get('slot'))).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(engine.surfaceWrites.map((w) => w.slot).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(engine.surfaceCommits).toBe(1);
    expect(engine.surfaceWrites[0]).toMatchObject({ rect: { x: 0, y: 0, w: 64, h: 48 }, len: 64 * 48 * 4 });
    vi.advanceTimersByTime(500);
    expect(sock().sent.length).toBe(2); // loading writes were not echoed back to TD
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
    await vi.advanceTimersByTimeAsync(5000);
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
    expect(m.layers.map((l) => l.kind)).toEqual(['base', 'pixel', 'adjustment']);
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
    bridge = startTdBridge(engine, status, { url: 'ws://td/ws', client: 'panel', token: 't', WebSocketCtor: Flaky as unknown as typeof WebSocket, forwardLogs: false, raf });
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
    expect(vi.getTimerCount()).toBe(0);
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

describe('tdBridge view messages', () => {
  const view = (o: Partial<ViewState> = {}): ViewState => ({ mode: 'local', zoom: 1, panX: 10, panY: 20, rect: { x: 5, y: 6, w: 700, h: 500 }, ...o });

  it('sends view at most once per animation frame with the latest state', () => {
    start();
    connectActive();
    const n = () => sock().json().filter((m) => m.t === 'view').length;
    bridge.setView(view());
    bridge.setView(view({ zoom: 2 }));
    bridge.setView(view({ zoom: 3, mode: 'td' }));
    expect(n()).toBe(0);
    vi.advanceTimersByTime(16);
    expect(n()).toBe(1);
    expect(at(sock().json(), -1)).toEqual({ t: 'view', mode: 'td', zoom: 3, panX: 10, panY: 20, rect: { x: 5, y: 6, w: 700, h: 500 } });
    bridge.setView(view({ panX: 99 }));
    vi.advanceTimersByTime(16);
    expect(n()).toBe(2);
  });

  it('sends view while a document load is pending and after a failed load', async () => {
    start(64, 48, withLayer);
    connectActive({ hasDocument: true, rev: 1 });
    bridge.setView(view({ mode: 'td' }));
    vi.advanceTimersByTime(60);
    expect(sock().json().filter((m) => m.t === 'view')).toHaveLength(1); // still waiting for docState
    sock().tell(docState(1, [tdLayers[0], tdLayers[1]]));
    await flushP();
    bridge.setView(view({ mode: 'td', zoom: 4 })); // mid-load
    vi.advanceTimersByTime(60);
    expect(sock().json().filter((m) => m.t === 'view')).toHaveLength(2);
    fm!.calls[0].settle(new Response('', { status: 500 }));
    fm!.calls[1].settle(new Response('', { status: 500 }));
    await vi.advanceTimersByTimeAsync(600);
    fm!.calls[2].settle(new Response('', { status: 500 }));
    fm!.calls[3].settle(new Response('', { status: 500 }));
    await flushP();
    expect(sock().json().filter((m) => m.t === 'view').length).toBeGreaterThanOrEqual(3); // re-sent when the load ended (failed)
  });

  it('does not stall when requestAnimationFrame never fires (hidden page)', () => {
    engine = new FakeEngine(64, 48);
    engine.addPixelLayer('Layer 1');
    status = makeStatus();
    fm = new FetchMock();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', client: 'panel', token: 't', WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, fetch: fm.fn, raf: () => {} });
    connectActive();
    bridge.setView(view());
    bridge.setView(view({ zoom: 2 }));
    vi.advanceTimersByTime(60);
    expect(sock().json().filter((m) => m.t === 'view')).toHaveLength(1);
    bridge.setView(view({ zoom: 3 }));
    vi.advanceTimersByTime(60);
    expect(sock().json().filter((m) => m.t === 'view')).toHaveLength(2);
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
    expect(sock().json().filter((m) => m.t === 'view')).toHaveLength(1);
  });

  it('a view set while disconnected is sent on the next hello, nothing is sent offline', () => {
    start();
    bridge.setView(view());
    vi.advanceTimersByTime(16);
    expect(sock().sent.length).toBe(0);
    connectActive();
    expect(sock().json().filter((m) => m.t === 'view')).toHaveLength(1);
  });
});

const viewBody = (w: number, h: number, v: number) =>
  encodeBands({ type: FRAME_VIEW, frameId: 1, docW: w, docH: h, rect: { x: 0, y: 0, w, h }, pixels: new Uint8Array(w * h * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const viewNotice = (frameId: number, applied = -1, w = 64, h = 48): TdMessage => ({ t: 'view', frameId, docW: w, docH: h, w, h, appliedFrameId: applied });

describe('tdBridge view stream (external client)', () => {
  it('fetches /view on a notice and hands the straight RGBA image to the status sink', async () => {
    start();
    connectActive();
    sock().tell(viewNotice(3));
    await flushP();
    expect(fm!.calls.map((c) => c.url)).toEqual(['http://td:9980/view?token=tok-123&client=c1&frameId=3']);
    vi.advanceTimersByTime(30);
    fm!.calls[0].settle(okBytes(viewBody(64, 48, 77)));
    await flushP();
    expect(status.viewFrames).toEqual([{ w: 64, h: 48, first: [77, 77, 77, 77], age: 30 }]);
    expect(engine.baseWrites).toEqual([]);
  });

  it('keeps one fetch in flight; newer notices cause exactly one more with the newest id', async () => {
    start();
    connectActive();
    sock().tell(viewNotice(1));
    await flushP();
    sock().tell(viewNotice(2));
    sock().tell(viewNotice(3));
    await flushP();
    expect(fm!.calls.length).toBe(1);
    fm!.calls[0].settle(okBytes(viewBody(64, 48, 1)));
    await flushP();
    expect(fm!.calls.length).toBe(2);
    expect(fm!.calls[1].url).toContain('frameId=3');
    fm!.calls[1].settle(okBytes(viewBody(64, 48, 2)));
    await flushP();
    expect(fm!.calls.length).toBe(2);
    expect(status.viewFrames).toHaveLength(2);
  });

  it('drops stale-size, wrong-type and malformed bodies; 404 is quiet', async () => {
    start();
    connectActive();
    for (const [i, body] of [okBytes(viewBody(10, 10, 1)), okBytes(dump(0, 64, 48, 1)), okBytes(new Uint8Array(4)), new Response('', { status: 404 })].entries()) {
      sock().tell(viewNotice(i + 1));
      await flushP();
      fm!.calls[i].settle(body);
      await flushP();
    }
    expect(status.viewFrames).toEqual([]);
    expect(status.notices).toEqual([]);
  });

  it('computes stroke -> view latency from appliedFrameId', async () => {
    start(64, 48, withLayer);
    connectActive();
    vi.advanceTimersByTime(100);
    engine.emit({ type: 'surface', slot: 1, rect: { x: 0, y: 0, w: 2, h: 2 } });
    vi.advanceTimersByTime(40);
    const id = at(sock().frames(), -1).frameId;
    vi.advanceTimersByTime(60);
    sock().tell(viewNotice(1, id));
    await flushP();
    vi.advanceTimersByTime(10);
    fm!.calls[0].settle(okBytes(viewBody(64, 48, 3)));
    await flushP();
    expect(status.viewLatency).toHaveLength(1);
    expect(status.viewLatency[0].median).toBe(110);
  });

  it('a failed view fetch re-subscribes (view message) after 2 s so TD re-announces', async () => {
    start();
    connectActive();
    bridge.setView({ mode: 'td', zoom: 1, panX: 0, panY: 0, rect: { x: 0, y: 0, w: 10, h: 10 } });
    vi.advanceTimersByTime(16);
    const n = () => sock().json().filter((m) => m.t === 'view').length;
    const before = n();
    sock().tell(viewNotice(1));
    await flushP();
    fm!.calls[0].settle(new TypeError('net'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(n()).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(n()).toBe(before + 1);
  });

  it('aborts the in-flight view fetch on socket close and ignores late results', async () => {
    start();
    connectActive();
    sock().tell(viewNotice(1));
    await flushP();
    sock().close();
    expect(fm!.calls[0].signal?.aborted).toBe(true);
    fm!.calls[0].settle(okBytes(viewBody(64, 48, 1)));
    await flushP();
    expect(status.viewFrames).toEqual([]);
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
const baseFrame = (docW: number, docH: number, v: number, frameId = 1) =>
  encodeBands({ type: FRAME_BASE, frameId, docW, docH, rect: { x: 0, y: 0, w: docW, h: docH }, pixels: new Uint8Array(docW * docH * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const notice = (frameId: number, w = 64, h = 48): TdMessage => ({ t: 'base', frameId, docW: w, docH: h, x: 0, y: 0, w, h });

describe('tdBridge base pull (HTTP)', () => {
  let fm: FetchMock;
  const ok = okBytes;
  const startF = () => {
    fm = new FetchMock();
    engine = new FakeEngine(64, 48);
    status = makeStatus();
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', client: 'panel', token: 'tok 1', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
    connectActive();
  };

  it('fetches /base on the ws host with token, client id and notice frame id', async () => {
    startF();
    sock().tell(notice(5));
    await flush();
    expect(fm.calls.map((c) => c.url)).toEqual(['http://td:9980/base?token=tok%201&client=c1&frameId=5']);
  });

  it('applies a fetched frame and commits once; header frameId may be newer than the notice', async () => {
    startF();
    sock().tell(notice(5));
    await flush();
    fm.calls[0].settle(ok(baseFrame(64, 48, 9, 8)));
    await flush();
    expect(engine.baseWrites).toEqual([{ rect: { x: 0, y: 0, w: 64, h: 48 }, len: 64 * 48 * 4 }]);
    expect(engine.commits).toBe(1);
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
    expect(engine.baseWrites.length).toBe(0);
    expect(engine.commits).toBe(0);
  });

  it('ignores 404 quietly (no retry, no notice, no fatal)', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    fm.calls[0].settle(new Response('', { status: 404 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.calls.length).toBe(1);
    expect(status.notices).toEqual([]);
    expect(engine.baseWrites.length).toBe(0);
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
    expect(engine.commits).toBe(1);
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
    expect(engine.commits).toBe(2);
  });

  it('a docSize while fetching voids the in-flight result, even at an unchanged size, and fetches again (TD counted it as fetched)', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().tell({ t: 'docSize', w: 64, h: 48, hasInput: true, mode: 'input' });
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(engine.commits).toBe(0);
    expect(fm.calls.length).toBe(2); // re-fetch without waiting for a notice
    fm.calls[1].settle(ok(baseFrame(64, 48, 2)));
    await flush();
    expect(engine.commits).toBe(1);
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
    expect(engine.commits).toBe(1);
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
    expect(engine.baseWrites.length).toBe(0);
    fm.calls[1].settle(ok(baseFrame(20, 10, 4)));
    await flush();
    expect(engine.baseWrites).toEqual([{ rect: { x: 0, y: 0, w: 20, h: 10 }, len: 800 }]);
  });

  it('drops a result that arrives after the socket was lost or the bridge disposed', async () => {
    startF();
    sock().tell(notice(1));
    await flush();
    sock().close();
    fm.calls[0].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(engine.commits).toBe(0);
    vi.advanceTimersByTime(500);
    sock().open();
    sock().tell(hello());
    sock().tell(notice(2));
    await flush();
    bridge.dispose();
    fm.calls[1].settle(ok(baseFrame(64, 48, 1)));
    await flush();
    expect(engine.commits).toBe(0);
  });

  it('never acks and ignores binary WebSocket messages from TD', async () => {
    startF();
    const f = baseFrame(64, 48, 1);
    sock().binary(f);
    sock().tell(notice(1));
    await flush();
    expect(engine.baseWrites.length).toBe(0);
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
  it('resolves ws url and client from the query string', () => {
    expect(resolveWsUrl('', { protocol: 'http:', host: '127.0.0.1:9980' })).toBe('ws://127.0.0.1:9980/ws');
    expect(resolveWsUrl('', { protocol: 'https:', host: 'h' })).toBe('wss://h/ws');
    expect(resolveWsUrl('?ws=ws://x:1/y', { protocol: 'http:', host: 'h' })).toBe('ws://x:1/y');
    expect(resolveClient('')).toBe('external');
    expect(resolveClient('?client=panel')).toBe('panel');
    expect(resolveClient('?client=weird')).toBe('external');
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
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', client: 'panel', token: 'tok-123', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
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
  const loadLayers = [spec({ id: 'base', kind: 'base' }), spec({ id: 'p1', slot: 1 }), textLayer()];

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
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', client: 'panel', token: 'tok-123', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
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
    engine.setTransform('L1', { x: 3, y: 4, sx: 2, sy: 2 });
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(n);
    expect(sock().json().filter((m) => m.t === 'doc').length).toBeGreaterThan(docs);
    expect(last('doc').layers.find((l) => l.id === 'L1')).toMatchObject({ x: 3, y: 4, sx: 2, sy: 2 });
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

  it('baseSize resizes the base surface (once), 0x0 means no input, and BASE frames carry the base size', async () => {
    startV5();
    sock().tell({ t: 'baseSize', w: 128, h: 96 });
    sock().tell({ t: 'baseSize', w: 128, h: 96 });
    sock().tell({ t: 'baseSize', w: 0, h: 0 }); // no input any more: forwarded, the engine keeps a placeholder
    sock().tell({ t: 'baseSize', w: 0, h: 0 });
    expect(engine.baseSizes).toEqual([{ w: 128, h: 96 }, { w: 0, h: 0 }]);
    sock().tell({ t: 'base', frameId: 1, docW: 200, docH: 100, x: 0, y: 0, w: 200, h: 100 });
    await flushP();
    fm.calls[0].settle(okBytes(baseFrame(200, 100, 5)));
    await flushP();
    expect(engine.baseSizes[engine.baseSizes.length - 1]).toEqual({ w: 200, h: 100 });
    expect(engine.baseWrites).toEqual([{ rect: { x: 0, y: 0, w: 200, h: 100 }, len: 200 * 100 * 4 }]);
    expect(engine.commits).toBe(1);
  });

  it('a baseSize while a BASE fetch is in flight voids that result and fetches again', async () => {
    startV5();
    sock().tell(notice(1));
    await flushP();
    sock().tell({ t: 'baseSize', w: 10, h: 10 });
    fm.calls[0].settle(okBytes(baseFrame(64, 48, 1)));
    await flushP();
    expect(engine.baseWrites).toHaveLength(0);
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
    const layers = [spec({ id: 'base', kind: 'base', surfaceW: 64, surfaceH: 48 }), spec({ id: 'p1', slot: 1, surfaceW: 20, surfaceH: 10, mask: { slot: 2, enabled: true } })];
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
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', client: 'panel', token: 'tok-123', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, raf });
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
});
