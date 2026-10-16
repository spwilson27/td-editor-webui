import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_BASE, FRAME_LAYER_PREVIEW, FRAME_SURFACE_DUMP, FRAME_TOP, decodeWebMessage, encodeBands, encodeMessage, type EditorList, type TdMessage, type WebMessage } from '../../src/bridge/codec';
import { startTdBridge, type Bridge } from '../../src/bridge/tdBridge';
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
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(d: string | Uint8Array) { this.sent.push(d); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
  tell(m: TdMessage) { this.onmessage?.({ data: encodeMessage(m) }); }
  json(): WebMessage[] { return this.sent.filter((s): s is string => typeof s === 'string').map((s) => decodeWebMessage(s)!); }
  types(): string[] { return this.json().map((m) => m.t); }
  frames() { return this.sent.filter((s): s is Uint8Array => typeof s !== 'string'); }
}

interface Call { url: string; init: RequestInit | undefined; settle: (r: Response | Error) => void }
class FetchMock {
  calls: Call[] = [];
  fn = ((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    this.calls.push({ url, init, settle: (r) => (r instanceof Error ? reject(r) : resolve(r)) });
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
const docState = (rev = 7): TdMessage => ({ t: 'docState', rev, layers: tdLayers, docW: 64, docH: 48, guides: { h: [], v: [] }, canvas: { mode: 'input' } });
const hello = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}): TdMessage => ({
  t: 'hello', protocol: 10, doc: { w: 64, h: 48 }, hasInput: false, maxSendFps: 30, active: true, clientId: 'c1', hasDocument: false, rev: null, ...over,
});
const frameBytes = (type: number, slot: number, w: number, h: number, v: number) =>
  encodeBands({ type: type as typeof FRAME_BASE, slot, frameId: 1, docW: w, docH: h, rect: { x: 0, y: 0, w, h }, pixels: new Uint8Array(w * h * 4).fill(v), maxPayload: 1 << 30 }).next().value as Uint8Array;
const bytes = (b: Uint8Array, headers: Record<string, string> = {}) => new Response(b as BufferSource, { status: 200, headers });

interface Status {
  notices: string[]; lists: EditorList[]; gone: number; conn: string[];
  setConnection(c: string): void; setActive(a: boolean): void; setNotice(m: string): void; setEditors(l: EditorList): void; onEditorGone(): void;
}
const makeStatus = (): Status => {
  const st: Status = {
    notices: [], lists: [], gone: 0, conn: [],
    setConnection: (c) => { st.conn.push(c); }, setActive: () => {}, setNotice: (m) => { st.notices.push(m); },
    setEditors: (l) => { st.lists.push(l); }, onEditorGone: () => { st.gone++; },
  };
  return st;
};

let engine: FakeEngine;
let status: Status;
let fm: FetchMock;
let bridge: Bridge;
const sock = () => FakeSocket.all[FakeSocket.all.length - 1];

function start(editor: string | undefined = 'ed2', url = 'ws://td:9980/ws', prep?: (e: FakeEngine) => void) {
  engine = new FakeEngine(64, 48);
  prep?.(engine);
  status = makeStatus();
  fm = new FetchMock();
  bridge = startTdBridge(engine, status, { url, ...(editor !== undefined ? { editor } : {}), token: 'tok-123', WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, fetch: fm.fn, raf });
}
const connect = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) => { sock().open(); sock().tell(hello({ doc: { w: engine.width, h: engine.height }, ...over })); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); FakeSocket.all = []; });
afterEach(() => { bridge?.dispose(); vi.useRealTimers(); });

describe('v10: editor parameter on the WebSocket URL', () => {
  it('adds editor=<id> to the ws url; none without an editor (master\'s own)', () => {
    start('ed2');
    expect(sock().url).toBe('ws://td:9980/ws?editor=ed2');
    bridge.dispose();
    start('');
    expect(sock().url).toBe('ws://td:9980/ws');
  });

  it('keeps the query of a ws= override and escapes the id', () => {
    start('a b&c', 'ws://127.0.0.1:1234/ws?x=1');
    expect(sock().url).toBe('ws://127.0.0.1:1234/ws?x=1&editor=a+b%26c');
  });

  it('ready: protocol 10, client external; the bridge reports its editor', () => {
    start('ed2');
    sock().open();
    expect(sock().json()[0]).toEqual({ t: 'ready', protocol: 10, client: 'external', version: '0.1.0', token: 'tok-123', fresh: true });
    expect(bridge.editor).toBe('ed2');
  });
});

describe('v10: editor parameter on every HTTP route', () => {
  const q = (c: Call) => new URL(c.url).searchParams;
  const expectIdentity = (c: Call) => {
    const p = q(c);
    expect(p.get('token')).toBe('tok-123');
    expect(p.get('client')).toBe('c1');
    expect(p.get('editor')).toBe('ed2');
  };

  it('/surface and /history (GET) while loading a document', async () => {
    start();
    connect({ hasDocument: true, rev: 7 });
    sock().tell(docState(7));
    await flush();
    const s = fm.to('/surface');
    expect(s.length).toBe(1);
    expectIdentity(s[0]);
    expect(q(s[0]).get('slot')).toBe('1');
    s[0].settle(bytes(frameBytes(FRAME_SURFACE_DUMP, 1, 64, 48, 5)));
    await flush();
    const h = fm.to('/history');
    expect(h.length).toBe(1);
    expectIdentity(h[0]);
    expect(h[0].url).toBe('http://td:9980/history?token=tok-123&client=c1&editor=ed2');
  });

  it('/history (POST), also the empty clearing POST', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
    engine.emit({ type: 'history' });
    await vi.advanceTimersByTimeAsync(2100);
    const posts = fm.to('/history').filter((c) => c.init?.method === 'POST');
    expect(posts.length).toBe(1);
    expectIdentity(posts[0]);
    expect(q(posts[0]).get('rev')).toBe(String(engine.docSpec().rev));
    posts[0].settle(new Response(null, { status: 204 }));
    await flush();
    const clear = bridge.clearStoredHistory();
    await flush();
    const posts2 = fm.to('/history').filter((c) => c.init?.method === 'POST');
    expect(posts2.length).toBe(2);
    expectIdentity(posts2[1]);
    posts2[1].settle(new Response(null, { status: 204 }));
    await clear;
  });

  it('/base, /view and /layer', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); e.previewIds.add('L1'); });
    connect();
    await flush();
    sock().tell({ t: 'base', frameId: 5, input: 1, docW: 64, docH: 48, x: 0, y: 0, w: 64, h: 48 });
    sock().tell({ t: 'layerPreview', layerId: 'L1', frameId: 3 });
    sock().tell({ t: 'view', frameId: 9, docW: 64, docH: 48, w: 64, h: 48, appliedFrameId: -1 });
    await flush();
    for (const path of ['/base', '/layer', '/view']) {
      const c = fm.to(path);
      expect(c.length, path).toBe(1);
      expectIdentity(c[0]);
    }
    expect(fm.to('/base')[0].url).toBe('http://td:9980/base?token=tok-123&client=c1&editor=ed2&frameId=5&input=1');
    expect(fm.to('/layer')[0].url).toBe('http://td:9980/layer?token=tok-123&client=c1&editor=ed2&layerId=L1&frameId=3');
    expect(fm.to('/view')[0].url).toBe('http://td:9980/view?token=tok-123&client=c1&editor=ed2&frameId=9');
    void FRAME_LAYER_PREVIEW;
  });

  it('/top (importTop)', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await flush();
    const p = bridge.importTop('/project1/noise1');
    await flush();
    const imp = sock().json().find((m) => m.t === 'importTop') as Extract<WebMessage, { t: 'importTop' }>;
    sock().tell({ t: 'topReady', requestId: imp.requestId, w: 4, h: 4 });
    await flush();
    const t = fm.to('/top');
    expect(t.length).toBe(1);
    expectIdentity(t[0]);
    t[0].settle(bytes(frameBytes(FRAME_TOP, 0, 4, 4, 9)));
    await p;
  });

  it('without an editor no editor parameter is sent (the master\'s own editor)', async () => {
    start('');
    connect({ hasDocument: true, rev: 7 });
    sock().tell(docState(7));
    await flush();
    expect(fm.to('/surface')[0].url).toBe('http://td:9980/surface?token=tok-123&client=c1&slot=1');
  });
});

describe('v10: editors message, 4404 and reconnect', () => {
  it('an editors message reaches the status', () => {
    start();
    connect();
    sock().tell({ t: 'editors', master: 'ed1', editors: [{ id: 'ed1', name: 'Main', path: '/project1/main', version: '0.8.0', active: true }] });
    expect(status.lists).toEqual([{ master: 'ed1', editors: [{ id: 'ed1', name: 'Main', path: '/project1/main', version: '0.8.0', active: true }] }]);
  });

  it('close code 4404: onEditorGone once, and the socket is not reopened', async () => {
    start();
    sock().open();
    sock().close(4404);
    expect(status.gone).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('a `gone` message (TD cannot send 4404) followed by a plain close is treated like 4404', async () => {
    start();
    sock().open();
    sock().tell({ t: 'gone' });
    sock().close(1005);
    expect(status.gone).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('the older error "no such editor" followed by a close also means gone; other errors do not', async () => {
    start();
    sock().open();
    sock().tell({ t: 'error', msg: 'no such editor' });
    sock().close(1006);
    expect(status.gone).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('an unrelated error does not stop the reconnect loop', async () => {
    start();
    sock().open();
    sock().tell({ t: 'error', msg: 'something else' });
    sock().close(1006);
    expect(status.gone).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.all.length).toBeGreaterThan(1);
  });

  it('a handshake that hangs (still CONNECTING after 4 s) is abandoned and retried on the same url', async () => {
    start();
    expect(FakeSocket.all.length).toBe(1);          // never opens
    await vi.advanceTimersByTimeAsync(3900);
    expect(FakeSocket.all.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);        // timeout -> close -> backoff -> a new socket
    expect(FakeSocket.all.length).toBeGreaterThan(1);
    expect(FakeSocket.all[1].url).toBe(FakeSocket.all[0].url);
    expect(status.gone).toBe(0);
  });

  it('an open socket that never gets a hello (a stopped server accepted it) is closed after 8 s and retried', async () => {
    start();
    sock().open();
    await vi.advanceTimersByTimeAsync(7900);
    expect(FakeSocket.all.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all.length).toBeGreaterThan(1);
  });

  it('a hello cancels the hello timeout', async () => {
    start();
    sock().open();
    sock().tell(hello());
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeSocket.all.length).toBe(1);
  });

  it('any other close keeps retrying the SAME url with growing backoff', async () => {
    start();
    sock().open();
    sock().close(1006);
    expect(status.gone).toBe(0);
    expect(status.conn.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.all.length).toBe(2);
    sock().close(1006);
    await vi.advanceTimersByTimeAsync(900);
    expect(FakeSocket.all.length).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeSocket.all.length).toBe(3);
    expect(new Set(FakeSocket.all.map((s) => s.url))).toEqual(new Set(['ws://td:9980/ws?editor=ed2']));
  });

  it('after a reconnect whose document moved on, the page asks TD for the document again (requestDoc)', async () => {
    start();
    connect({ hasDocument: true, rev: 7 });
    sock().tell(docState(7));
    await flush();
    fm.to('/surface')[0].settle(bytes(frameBytes(FRAME_SURFACE_DUMP, 1, 64, 48, 5)));
    await flush();
    sock().close(1006);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeSocket.all.length).toBe(2);
    sock().open();
    sock().tell(hello({ hasDocument: true, rev: 12, clientId: 'c2' }));
    expect(sock().types()).toContain('requestDoc');
  });
});

describe('v10: flush before a session is closed', () => {
  it('sends the pending doc, dirty surfaces and the active layer at once (no timers needed)', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    const before = sock().frames().length;
    const slot = engine.surfaceSlots()[0];
    engine.fillSurface(slot, { x: 0, y: 0, w: 4, h: 4 }, [1, 2, 3, 255]);
    engine.addPixelLayer('B'); // a doc change, not yet sent (raf pending)
    const done = bridge.flush!();
    // synchronous part: everything is already on the socket
    expect(sock().frames().length).toBeGreaterThan(before);
    expect(sock().types().filter((t) => t === 'doc').length).toBeGreaterThanOrEqual(2);
    await flush();
    for (const c of fm.to('/history')) c.settle(new Response(null, { status: 204 })); // the layer change also made history: it is uploaded before flush resolves
    await done;
  });

  it('uploads a pending history change and resolves after the POST was answered', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    engine.emit({ type: 'history' });
    let resolved = false;
    const done = bridge.flush!().then(() => { resolved = true; });
    await flush();
    const posts = fm.to('/history').filter((c) => c.init?.method === 'POST');
    expect(posts.length).toBe(1);
    expect(new URL(posts[0].url).searchParams.get('editor')).toBe('ed2');
    expect(resolved).toBe(false);
    posts[0].settle(new Response(null, { status: 204 }));
    await done;
    expect(resolved).toBe(true);
    // the debounce timer must not upload it a second time
    await vi.advanceTimersByTimeAsync(5000);
    expect(fm.to('/history').filter((c) => c.init?.method === 'POST').length).toBe(1);
  });

  it('is a no-op while loading / offline and never rejects', async () => {
    start();
    await bridge.flush!(); // not connected
    connect({ hasDocument: true, rev: 4 }); // waiting for TD's document: nothing may be sent
    await bridge.flush!();
    expect(sock().types()).not.toContain('doc');
  });

  it('after dispose, late async results never reach the engine or the status', async () => {
    start('ed2');
    connect({ hasDocument: true, rev: 7 });
    sock().tell(docState(7));
    await flush();
    const notices = status.notices.length;
    bridge.dispose();
    fm.to('/surface')[0]?.settle(bytes(frameBytes(FRAME_SURFACE_DUMP, 1, 64, 48, 5)));
    await vi.advanceTimersByTimeAsync(20000);
    expect(status.notices.length).toBe(notices);
    expect(FakeSocket.all.length).toBe(1);
  });
});

describe('v10 review: flush result and unsent edits', () => {
  it('ok when linked, nothing offline; hasUnsent follows the queue', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    for (const c of fm.to('/history')) c.settle(new Response(null, { status: 204 }));
    await flush();
    engine.fillSurface(engine.surfaceSlots()[0], { x: 0, y: 0, w: 2, h: 2 }, [1, 2, 3, 255]);
    expect(bridge.hasUnsent!()).toBe(true); // dirty surface not sent yet
    const done = bridge.flush!();
    await flush();
    for (const c of fm.to('/history')) c.settle(new Response(null, { status: 204 }));
    expect(await done).toBe('ok');
    expect(bridge.hasUnsent!()).toBe(false);
  });

  it('dropped when the page was edited while disconnected', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    sock().close(1006);
    expect(bridge.hasUnsent!()).toBe(false);
    engine.fillSurface(engine.surfaceSlots()[0], { x: 0, y: 0, w: 2, h: 2 }, [9, 9, 9, 255]);
    expect(bridge.hasUnsent!()).toBe(true);
    expect(await bridge.flush!()).toBe('dropped');
  });

  it('ok when disconnected without edits; back to false after the reconnect pushed the edits', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    sock().close(1006);
    expect(await bridge.flush!()).toBe('ok');
    engine.fillSurface(engine.surfaceSlots()[0], { x: 0, y: 0, w: 2, h: 2 }, [9, 9, 9, 255]);
    await vi.advanceTimersByTimeAsync(600);
    sock().open();
    sock().tell(hello({ clientId: 'c2', doc: { w: 64, h: 48 } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(bridge.hasUnsent!()).toBe(false);
  });

  it('a running TOP import lands first: flush waits for it (bounded) and sends the imported layer', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    for (const c of fm.to('/history')) c.settle(new Response(null, { status: 204 }));
    const imp = bridge.importTop('/project1/noise1');
    await flush();
    const req = sock().json().find((m) => m.t === 'importTop') as Extract<WebMessage, { t: 'importTop' }>;
    let flushed = false;
    const f = bridge.flush!().then((r) => { flushed = true; return r; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushed).toBe(false); // waits for the import
    sock().tell({ t: 'topReady', requestId: req.requestId, w: 4, h: 4 });
    await flush();
    fm.to('/top')[0].settle(bytes(frameBytes(FRAME_TOP, 0, 4, 4, 9)));
    await imp;
    await flush();
    for (const c of fm.to('/history').filter((x) => x.init?.method === 'POST')) c.settle(new Response(null, { status: 204 }));
    expect(await f).toBe('ok');
  });

  it('a flush does not wait forever for a stuck import', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    for (const c of fm.to('/history')) c.settle(new Response(null, { status: 204 }));
    void bridge.importTop('/project1/stuck').catch(() => {});
    await flush();
    let done = false;
    const f = bridge.flush!().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(9000);
    for (const c of fm.to('/history').filter((x) => x.init?.method === 'POST')) c.settle(new Response(null, { status: 204 }));
    await f;
    expect(done).toBe(true);
  });

  it('an operation of an ended session fails with "Bridge closed" and never touches the status', async () => {
    start('ed2', 'ws://td:9980/ws', (e) => { e.addPixelLayer('A'); });
    connect();
    await vi.advanceTimersByTimeAsync(200);
    const imp = bridge.importTop('/project1/noise1');
    const err = imp.catch((e: Error) => e.message);
    await flush();
    const req = sock().json().find((m) => m.t === 'importTop') as Extract<WebMessage, { t: 'importTop' }>;
    sock().tell({ t: 'topReady', requestId: req.requestId, w: 4, h: 4 });
    await flush();
    const notices = status.notices.length;
    bridge.dispose();
    fm.to('/top')[0]?.settle(bytes(frameBytes(FRAME_TOP, 0, 4, 4, 9)));
    expect(await err).toBe('Bridge closed');
    expect(status.notices.length).toBe(notices);
  });
});
