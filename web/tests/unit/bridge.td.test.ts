import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_BASE, FRAME_COMPOSITE, decodeFrame, decodeWebMessage, encodeBands, encodeMessage,
  type Frame, type TdMessage,
} from '../../src/bridge/codec';
import { BACKPRESSURE_BYTES, installLogForwarding, httpOrigin, resolveClient, resolveToken, resolveWsUrl, TOKEN_EXPIRED_MESSAGE, startTdBridge, type Bridge, type Connection } from '../../src/bridge/tdBridge';
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
  binary(u: Uint8Array) { this.onmessage?.({ data: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) }); }
  json() { return this.sent.filter((s): s is string => typeof s === 'string').map((s) => decodeWebMessage(s)!); }
  frames(): Frame[] {
    return this.sent.filter((s): s is Uint8Array => typeof s !== 'string').map((b) => {
      const r = decodeFrame(b);
      if (!r.ok) throw new Error(r.error);
      return r.frame;
    });
  }
}

const hello = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}): TdMessage => ({ t: 'hello', protocol: 2, doc: { w: 64, h: 48 }, hasInput: false, maxSendFps: 30, active: true, clientId: 'c1', ...over });

let engine: FakeEngine;
let status: { conn: Connection[]; active: boolean[]; notices: string[]; setConnection(c: Connection): void; setActive(a: boolean): void; setNotice(m: string): void };
let bridge: Bridge;
const at = <T>(a: T[], i: number): T => a[a.length + i];
const sock = () => FakeSocket.all[FakeSocket.all.length - 1];

function start(w = 64, h = 48) {
  engine = new FakeEngine(w, h);
  status = {
    conn: [], active: [], notices: [],
    setConnection(c) { this.conn.push(c); }, setActive(a) { this.active.push(a); }, setNotice(m) { this.notices.push(m); },
  };
  bridge = startTdBridge(engine, status, { url: 'ws://td/ws', client: 'panel', token: 'tok-123', WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false });
}
function connectActive() { sock().open(); sock().tell(hello({ doc: { w: engine.width, h: engine.height } })); }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); FakeSocket.all = []; });
afterEach(() => { bridge?.dispose(); vi.useRealTimers(); });

describe('tdBridge session', () => {
  it('sends ready with client and protocol after open', () => {
    start();
    expect(status.conn).toEqual(['reconnecting']);
    expect(sock().url).toBe('ws://td/ws');
    expect(sock().binaryType).toBe('arraybuffer');
    sock().open();
    expect(sock().json()).toEqual([{ t: 'ready', protocol: 2, client: 'panel', version: '0.1.0', token: 'tok-123' }]);
  });

  it('becomes linked on hello and sends a full composite frame', () => {
    start();
    connectActive();
    expect(at(status.conn, -1)).toBe('linked');
    expect(at(status.active, -1)).toBe(true);
    vi.advanceTimersByTime(100);
    const [f] = sock().frames();
    expect(f).toMatchObject({ type: FRAME_COMPOSITE, frameEnd: true, docW: 64, docH: 48, x: 0, y: 0, w: 64, h: 48 });
    expect(Array.from(f.payload.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it('resizes the engine when hello or docSize disagree', () => {
    start();
    sock().open();
    sock().tell(hello({ doc: { w: 32, h: 16 } }));
    expect([engine.width, engine.height]).toEqual([32, 16]);
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true });
    expect([engine.width, engine.height]).toEqual([20, 10]);
    vi.advanceTimersByTime(100);
    expect(at(sock().frames(), -1)).toMatchObject({ docW: 20, docH: 10, w: 20, h: 10 });
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
    sock().tell(hello({ protocol: 1 }));
    expect(at(status.conn, -1)).toBe('reconnecting');
    expect(status.notices[0]).toMatch(/mismatch/i);
  });
});

describe('tdBridge outbound frames', () => {
  it('coalesces dirty rects and sends at most maxSendFps', () => {
    start();
    connectActive();
    vi.advanceTimersByTime(100);
    const base = sock().frames().length;

    engine.emit({ type: 'composite', rect: { x: 2, y: 3, w: 4, h: 4 } });
    vi.advanceTimersByTime(40);
    const afterFirst = sock().frames().length;
    expect(afterFirst).toBe(base + 1);
    engine.emit({ type: 'composite', rect: { x: 10, y: 20, w: 5, h: 5 } });
    engine.emit({ type: 'composite', rect: { x: 8, y: 18, w: 2, h: 2 } });
    expect(sock().frames().length).toBe(afterFirst); // throttled
    vi.advanceTimersByTime(40);
    const frames = sock().frames();
    expect(frames.length).toBe(afterFirst + 1);
    expect(at(frames, -1)).toMatchObject({ x: 8, y: 18, w: 7, h: 7 });
    expect(at(frames, -1)!.frameId).toBe(at(frames, -2)!.frameId + 1);
  });

  it('clips dirty rects to the document and skips empty ones', () => {
    start();
    connectActive();
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    engine.emit({ type: 'composite', rect: { x: 60, y: 44, w: 20, h: 20 } });
    vi.advanceTimersByTime(100);
    expect(at(sock().frames(), -1)).toMatchObject({ x: 60, y: 44, w: 4, h: 4 });
    engine.emit({ type: 'composite', rect: { x: 100, y: 100, w: 5, h: 5 } });
    vi.advanceTimersByTime(100);
    expect(sock().frames().length).toBe(n + 1);
  });

  it('splits large frames into bands of at most 2 MB, only the last ending the frame', () => {
    start(1000, 1000);
    connectActive();
    vi.advanceTimersByTime(100);
    const frames = sock().frames();
    expect(frames.length).toBe(Math.ceil(4_000_000 / (Math.floor(2097152 / 4000) * 4000)));
    expect(frames.every((f) => f.payload.length <= 2 * 1024 * 1024)).toBe(true);
    expect(frames.map((f) => f.frameEnd)).toEqual(frames.map((_, i) => i === frames.length - 1));
    expect(new Set(frames.map((f) => f.frameId)).size).toBe(1);
    expect(frames.reduce((a, f) => a + f.h, 0)).toBe(1000);
  });

  it('skips ticks while the socket is backed up and keeps accumulating', () => {
    start();
    connectActive();
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    sock().bufferedAmount = BACKPRESSURE_BYTES + 1;
    engine.emit({ type: 'composite', rect: { x: 0, y: 0, w: 2, h: 2 } });
    vi.advanceTimersByTime(500);
    engine.emit({ type: 'composite', rect: { x: 5, y: 5, w: 2, h: 2 } });
    vi.advanceTimersByTime(500);
    expect(sock().frames().length).toBe(n);
    sock().bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(sock().frames().length).toBe(n + 1);
    expect(at(sock().frames(), -1)).toMatchObject({ x: 0, y: 0, w: 7, h: 7 });
  });

  it('sends nothing while on standby; full frame and takeover when taking over', () => {
    start();
    sock().open();
    sock().tell(hello({ active: false }));
    expect(at(status.active, -1)).toBe(false);
    engine.emit({ type: 'composite', rect: { x: 0, y: 0, w: 4, h: 4 } });
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(0);

    bridge.takeover();
    expect(at(sock().json(), -1)).toEqual({ t: 'takeover' });
    sock().tell({ t: 'active', active: true });
    vi.advanceTimersByTime(100);
    expect(sock().frames()[0]).toMatchObject({ x: 0, y: 0, w: 64, h: 48 });
    sock().tell({ t: 'active', active: false });
    engine.emit({ type: 'composite', rect: { x: 0, y: 0, w: 4, h: 4 } });
    vi.advanceTimersByTime(200);
    expect(sock().frames().length).toBe(1);
  });
});

describe('tdBridge reconnect', () => {
  it('backs off 0.5 s doubling up to 5 s, then resends a full frame', () => {
    start();
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
    expect(sock().json()[0]).toMatchObject({ t: 'ready' });
    expect(sock().frames()[0]).toMatchObject({ w: 64, h: 48 });
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
    status = { conn: [], active: [], notices: [], setConnection(c) { this.conn.push(c); }, setActive(a) { this.active.push(a); }, setNotice(m) { this.notices.push(m); } };
    bridge = startTdBridge(engine, status, { url: 'ws://td/ws', client: 'panel', token: 't', WebSocketCtor: Flaky as unknown as typeof WebSocket, forwardLogs: false });
    expect(FakeSocket.all.length).toBe(0);
    fail = false;
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('leaves no stray timers or listeners across many reconnects, and none after dispose', () => {
    start();
    const base = engine.listenerCount();
    for (let i = 0; i < 20; i++) {
      sock().open();
      sock().tell(hello());
      engine.emit({ type: 'composite', rect: { x: 0, y: 0, w: 2, h: 2 } });
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
});

describe('tdBridge dirty tracking', () => {
  it('rounds fractional dirty rects outward before encoding', () => {
    start();
    connectActive();
    vi.advanceTimersByTime(100);
    engine.emit({ type: 'composite', rect: { x: 2.4, y: 3.6, w: 2.2, h: 1.1 } });
    vi.advanceTimersByTime(100);
    expect(at(sock().frames(), -1)).toMatchObject({ x: 2, y: 3, w: 3, h: 2 });
  });

  it('a docSize with a composite pending sends one full frame at the new size, never the stale rect', () => {
    start();
    connectActive();
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    engine.emit({ type: 'composite', rect: { x: 50, y: 40, w: 10, h: 6 } });
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true });
    vi.advanceTimersByTime(200);
    const sent = sock().frames().slice(n);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ docW: 20, docH: 10, x: 0, y: 0, w: 20, h: 10 });
  });

  it('standby discards pending dirty rects and docSize while standing by sends nothing', () => {
    start();
    connectActive();
    vi.advanceTimersByTime(100);
    const n = sock().frames().length;
    engine.emit({ type: 'composite', rect: { x: 1, y: 1, w: 3, h: 3 } });
    sock().tell({ t: 'active', active: false });
    vi.advanceTimersByTime(300);
    expect(sock().frames().length).toBe(n);
    sock().tell({ t: 'docSize', w: 30, h: 20, hasInput: false });
    vi.advanceTimersByTime(300);
    expect(sock().frames().length).toBe(n);
    expect([engine.width, engine.height]).toEqual([30, 20]);
    sock().tell({ t: 'active', active: true });
    vi.advanceTimersByTime(100);
    const sent = sock().frames().slice(n);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ docW: 30, docH: 20, w: 30, h: 20 });
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
const flush = () => vi.advanceTimersByTimeAsync(0);
const baseFrame = (docW: number, docH: number, v: number, frameId = 1) =>
  encodeBands({ type: FRAME_BASE, frameId, docW, docH, rect: { x: 0, y: 0, w: docW, h: docH }, pixels: new Uint8Array(docW * docH * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const ok = (bytes: Uint8Array) => new Response(bytes as BufferSource, { status: 200 });
const notice = (frameId: number, w = 64, h = 48): TdMessage => ({ t: 'base', frameId, docW: w, docH: h, x: 0, y: 0, w, h });

describe('tdBridge base pull (HTTP)', () => {
  let fm: FetchMock;
  const startF = () => {
    fm = new FetchMock();
    engine = new FakeEngine(64, 48);
    status = { conn: [], active: [], notices: [], setConnection(c) { this.conn.push(c); }, setActive(a) { this.active.push(a); }, setNotice(m) { this.notices.push(m); } };
    bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', client: 'panel', token: 'tok 1', fetch: fm.fn, WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false });
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
    fm.calls[0].settle(ok(baseFrame(100, 100, 1)));
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
    sock().tell({ t: 'docSize', w: 64, h: 48, hasInput: true });
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
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true });
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
    sock().tell({ t: 'docSize', w: 20, h: 10, hasInput: true });
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
