import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_TOP, encodeFrame, decodeWebMessage, encodeMessage, type TdMessage, type WebMessage,
} from '../../src/bridge/codec';
import { startTdBridge, type Bridge } from '../../src/bridge/tdBridge';
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
const hello = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}): TdMessage => ({
  t: 'hello', protocol: 8, doc: { w: 64, h: 48 }, hasInput: false, maxSendFps: 30, active: true, clientId: 'c1', hasDocument: false, rev: null, ...over,
});
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
function start(prep?: (e: FakeEngine) => void) {
  engine = new FakeEngine(64, 48);
  prep?.(engine);
  status = makeStatus();
  fm = new FetchMock();
  bridge = startTdBridge(engine, status, { url: 'ws://td:9980/ws', client: 'panel', token: 'tok-123', WebSocketCtor: FakeSocket as unknown as typeof WebSocket, forwardLogs: false, fetch: fm.fn, raf });
}
const connect = (over: Partial<Extract<TdMessage, { t: 'hello' }>> = {}) => { sock().open(); sock().tell(hello({ doc: { w: engine.width, h: engine.height }, ...over })); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); FakeSocket.all = []; });
afterEach(() => { bridge?.dispose(); vi.useRealTimers(); });

const topFrame = (v: number) => encodeFrame({ type: FRAME_TOP, frameEnd: true, slot: 0, frameId: 1, docW: 64, docH: 48, x: 0, y: 0, w: 64, h: 48 }, new Uint8Array(64 * 48 * 4).fill(v));
const lastReq = <T extends WebMessage['t']>(t: T) => sock().json().filter((m) => m.t === t).at(-1) as Extract<WebMessage, { t: T }>;
/** Answer the request with topReady, serve the image and let the bridge apply it. */
async function serve(requestId: string, v = 9) {
  sock().tell({ t: 'topReady', requestId, w: 64, h: 48 });
  await flush();
  const call = fm.to('/top').at(-1)!;
  expect(new URL(call.url).searchParams.get('requestId')).toBe(requestId);
  call.settle(bytes(topFrame(v)));
  await flush();
}

describe('v8: renderLayer {mode} and renderLayers', () => {
  const effect = { type: 'invert', enabled: true } as never;

  it('flatten of a pixel layer: renderLayer {mode:"flatten"} -> topReady -> GET /top -> replaceLayersWithPixels([id])', async () => {
    start((e) => { e.addPixelLayer('A'); });
    connect();
    engine.setEffects('L1', [effect]);
    const p = bridge.renderLayer('L1', 'flatten');
    expect(lastReq('renderLayer')).toMatchObject({ t: 'renderLayer', layerId: 'L1', mode: 'flatten' });
    await serve(lastReq('renderLayer').requestId);
    await p;
    expect(engine.replacedMany).toMatchObject([{ ids: ['L1'], w: 64, h: 48, len: 64 * 48 * 4 }]);
    expect(engine.layers().find((l) => l.id === 'L1')).toBeUndefined(); // replaced by the new pixel layer
  });

  it('default mode is flatten; a text layer keeps the v5 replaceWithPixels path', async () => {
    start((e) => { e.addTextLayer({ text: 'Hi', font: 'Arial', size: 20, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 0, y: 0, boxWidth: null }); });
    connect();
    const p = bridge.renderLayer('L1');
    expect(lastReq('renderLayer').mode).toBe('flatten');
    await serve(lastReq('renderLayer').requestId);
    await p;
    expect(engine.replaced).toMatchObject([{ id: 'L1', w: 64, h: 48 }]);
    expect(engine.replacedMany).toHaveLength(0);
  });

  it('flatten of a group replaces the group (and its children) by one pixel layer', async () => {
    start((e) => { const g = e.addGroup('G'); e.moveLayer(e.addPixelLayer('c'), g, 0); });
    connect();
    const g = engine.layers().find((l) => l.kind === 'group')!.id;
    const p = bridge.renderLayer(g, 'flatten');
    await serve(lastReq('renderLayer').requestId);
    await p;
    expect(engine.replacedMany[0].ids).toEqual([g]);
    expect(engine.layers().map((l) => l.kind)).toEqual(['pixel', 'input']);
  });

  it('mergeDown: the adjustment and the layer below are replaced together', async () => {
    start((e) => { e.addPixelLayer('Below'); e.addAdjustmentLayer([effect], 'Adj'); });
    connect();
    const adj = engine.layers()[0].id, below = engine.layers()[1].id;
    const p = bridge.renderLayer(adj, 'mergeDown');
    expect(lastReq('renderLayer')).toMatchObject({ layerId: adj, mode: 'mergeDown' });
    await serve(lastReq('renderLayer').requestId);
    await p;
    expect(engine.replacedMany[0].ids).toEqual([adj, below]);
    expect(engine.layers().map((l) => l.name)).toEqual(['Below', 'TD Input 1']); // the result keeps the name of the layer below
  });

  it('mergeDown with nothing below, or on a non-adjustment, rejects without asking TD', async () => {
    start((e) => { const g = e.addGroup('G'); e.moveLayer(e.addAdjustmentLayer([effect]), g, 0); e.addPixelLayer('P'); });
    connect();
    const adj = engine.layers().find((l) => l.kind === 'adjustment')!.id;
    await expect(bridge.renderLayer(adj, 'mergeDown')).rejects.toThrow(/Nothing below/);
    await expect(bridge.renderLayer('L3', 'mergeDown')).rejects.toThrow(/Nothing below/);
    expect(sock().types()).not.toContain('renderLayer');
  });

  it('renderLayers sends the ids and replaces them by one pixel layer', async () => {
    start((e) => { e.addPixelLayer('A'); e.addPixelLayer('B'); e.addPixelLayer('C'); });
    connect();
    const p = bridge.renderLayers(['L3', 'L2']);
    expect(lastReq('renderLayers')).toMatchObject({ t: 'renderLayers', layerIds: ['L3', 'L2'] });
    await serve(lastReq('renderLayers').requestId);
    await p;
    expect(engine.replacedMany).toMatchObject([{ ids: ['L3', 'L2'], w: 64, h: 48 }]);
    expect(engine.layers().map((l) => l.name)).toEqual(['Merged', 'A', 'TD Input 1']);
  });

  it('topError rejects with TD\'s message; a change of the layers during the render rejects and replaces nothing; offline rejects', async () => {
    start((e) => { e.addPixelLayer('A'); e.addPixelLayer('B'); });
    connect();
    const p1 = bridge.renderLayers(['L2', 'L1']).catch((e: Error) => e.message);
    sock().tell({ t: 'topError', requestId: lastReq('renderLayers').requestId, msg: 'no such layer' });
    expect(await p1).toBe('no such layer');

    const p2 = bridge.renderLayers(['L2', 'L1']).catch((e: Error) => e.message);
    sock().tell({ t: 'topReady', requestId: lastReq('renderLayers').requestId, w: 64, h: 48 });
    await flush();
    engine.setLayerProps('L1', { visible: false }); // edited while TD rendered: the image is stale
    fm.to('/top').at(-1)!.settle(bytes(topFrame(1)));
    await flush();
    expect(await p2).toBe('Layer changed during render — try again');
    expect(status.notices.at(-1)).toBe('Layer changed during render — try again');
    expect(engine.replacedMany).toHaveLength(0);

    sock().close();
    await expect(bridge.renderLayers(['L1'])).rejects.toThrow(/Not connected/);
    await expect(bridge.renderLayer('L1', 'flatten')).rejects.toThrow(/Not connected/);
  });

  it('no layers: rejects without a request', async () => {
    start();
    connect();
    await expect(bridge.renderLayers([])).rejects.toThrow();
    expect(sock().types()).not.toContain('renderLayers');
  });
});

describe('v8: stale renders are discarded', () => {
  const effect = { type: 'invert', enabled: true } as never;
  const stale = 'Layer changed during render — try again';
  /** Start a render, let TD answer, run `change`, then deliver the image. */
  async function race(start_: () => Promise<void>, kind: 'renderLayer' | 'renderLayers', change: () => void) {
    const p = start_().catch((e: Error) => e.message);
    sock().tell({ t: 'topReady', requestId: lastReq(kind).requestId, w: 64, h: 48 });
    await flush();
    change();
    fm.to('/top').at(-1)!.settle(bytes(topFrame(3)));
    await flush();
    return p;
  }

  it('a change to a child of the group being flattened', async () => {
    start((e) => { const g = e.addGroup('G'); e.moveLayer(e.addPixelLayer('c'), g, 0); });
    connect();
    const g = engine.layers().find((l) => l.kind === 'group')!.id, child = engine.layers().find((l) => l.parentId === g)!.id;
    expect(await race(() => bridge.renderLayer(g, 'flatten'), 'renderLayer', () => engine.setEffects(child, [effect]))).toBe(stale);
    expect(engine.replacedMany).toHaveLength(0);
    expect(status.notices).toContain(stale);
  });

  it('a stroke (history entry) during Merge Selected', async () => {
    start((e) => { e.addPixelLayer('A'); e.addPixelLayer('B'); });
    connect();
    expect(await race(() => bridge.renderLayers(['L2', 'L1']), 'renderLayers', () => { engine.pointerDown({ x: 1, y: 1, pressure: 1, shift: false, alt: false, ctrl: false }); engine.pointerUp({ x: 2, y: 2, pressure: 1, shift: false, alt: false, ctrl: false }); })).toBe(stale);
    expect(engine.replacedMany).toHaveLength(0);
  });

  it('a change to the layer below during mergeDown', async () => {
    start((e) => { e.addPixelLayer('Below'); e.addAdjustmentLayer([effect], 'Adj'); });
    connect();
    const adj = engine.layers()[0].id, below = engine.layers()[1].id;
    expect(await race(() => bridge.renderLayer(adj, 'mergeDown'), 'renderLayer', () => engine.setEffects(below, [effect]))).toBe(stale);
    expect(engine.replacedMany).toHaveLength(0);
  });

  it('mergeDown into an input layer or another adjustment is refused without asking TD', async () => {
    start((e) => { e.addAdjustmentLayer([effect], 'A1'); e.addAdjustmentLayer([effect], 'A2'); });
    connect();
    await expect(bridge.renderLayer(engine.layers()[0].id, 'mergeDown')).rejects.toThrow(/another adjustment/);
    await expect(bridge.renderLayer(engine.layers()[1].id, 'mergeDown')).rejects.toThrow(/input layer/);
    expect(sock().types()).not.toContain('renderLayer');
  });

  it('mergeDown into a group is allowed (the group composite is merged)', async () => {
    start((e) => { const g = e.addGroup('G'); e.moveLayer(e.addPixelLayer('c'), g, 0); e.setActiveLayer(g); e.addAdjustmentLayer([effect], 'Adj'); });
    connect();
    const adj = engine.layers()[0].id, g = engine.layers().find((l) => l.kind === 'group')!.id;
    const p = bridge.renderLayer(adj, 'mergeDown');
    await serve(lastReq('renderLayer').requestId);
    await p;
    expect(engine.replacedMany[0].ids).toEqual([adj, g]);
  });
});

describe('v8: protocol mismatch notices', () => {
  it('an old TouchDesigner component (protocol 7) tells the user to update it', () => {
    start();
    sock().open();
    sock().tell(hello({ protocol: 7 }));
    expect(status.notices.at(-1)).toMatch(/Protocol mismatch.*protocol 8.*speaks 7.*update the component/);
  });

  it('a newer component (protocol 9) tells the user to reload the page', () => {
    start();
    sock().open();
    sock().tell(hello({ protocol: 9 }));
    expect(status.notices.at(-1)).toMatch(/Protocol mismatch.*protocol 9.*reload the page/);
  });
});
