import { describe, expect, it } from 'vitest';
import { FRAME_VIEW_EXACT, FRAME_VIEW_FAST, MAGIC, decodeViewFrame, frameGeq, type WebMessage } from '../../src/bridge/codec';
import { ExactBuffer } from '../../src/bridge/exactBuffer';
import { TdViewClient, type FastImage, type ShownKind, type ViewSink } from '../../src/bridge/tdViewClient';
import { sameViewport, visibleDocRect } from '../../src/bridge/viewMath';
import { exactFull, exactTiles, fastFrame, solid } from '../helpers/viewFrames';

describe('decodeViewFrame', () => {
  it('parses a VIEW_FAST frame (two JPEGs, premultiplied RGB + alpha)', () => {
    const b = fastFrame({ frameId: 7, appliedFrameId: 42, x: 10.5, y: 20, w: 100, h: 50.25, pw: 200, ph: 100 }, 'red', 'a128');
    const r = decodeViewFrame(b);
    expect(r.ok).toBe(true);
    if (!r.ok || r.frame.kind !== 'fast') throw new Error('x');
    expect(r.frame).toMatchObject({ frameId: 7, appliedFrameId: 42, x: 10.5, y: 20, w: 100, h: 50.25, pw: 200, ph: 100 });
    expect(r.frame.rgb[0]).toBe(0xff); expect(r.frame.rgb[1]).toBe(0xd8); // JPEG SOI
    expect(r.frame.alpha![0]).toBe(0xff);
  });
  it('alphaLen 0 = opaque', () => {
    const r = decodeViewFrame(fastFrame());
    expect(r.ok && r.frame.kind === 'fast' && r.frame.alpha).toBe(null);
  });
  it('parses VIEW_EXACT headers (full and tiles)', async () => {
    const full = decodeViewFrame(await exactFull(4, 2, solid(4, 2, 1, 2, 3), 9, 5));
    expect(full.ok && full.frame).toMatchObject({ kind: 'exact', frameId: 9, appliedFrameId: 5, docW: 4, docH: 2, full: true });
    const t = decodeViewFrame(await exactTiles(128, 64, [{ tx: 1, ty: 0, w: 64, h: 64, rgba: solid(64, 64, 0, 0, 0) }], 3));
    expect(t.ok && t.frame).toMatchObject({ kind: 'exact', full: false, tile: 64, nTiles: 1, docW: 128, docH: 64 });
  });
  it('rejects malformed frames and ignores other types', () => {
    expect(decodeViewFrame(new Uint8Array(10))).toEqual({ ok: false, error: 'too-short' });
    expect(decodeViewFrame(new Uint8Array(40))).toEqual({ ok: false, error: 'bad-magic' });
    const unknown = new Uint8Array(24); unknown.set(MAGIC); unknown[4] = 99;
    expect(decodeViewFrame(unknown)).toEqual({ ok: false, error: 'bad-type' });
    const f = fastFrame();
    expect(decodeViewFrame(f.subarray(0, f.length - 3))).toMatchObject({ ok: false, error: 'bad-length' });
    const trunc = new Uint8Array(30); trunc.set(MAGIC); trunc[4] = FRAME_VIEW_FAST;
    expect(decodeViewFrame(trunc)).toMatchObject({ ok: false });
    const ex = new Uint8Array(40); ex.set(MAGIC); ex[4] = FRAME_VIEW_EXACT;
    expect(decodeViewFrame(ex)).toMatchObject({ ok: false, error: 'bad-header' }); // docW 0
  });
  it('frameGeq is u32 wrap-safe', () => {
    expect(frameGeq(5, 5)).toBe(true);
    expect(frameGeq(6, 5)).toBe(true);
    expect(frameGeq(5, 6)).toBe(false);
    expect(frameGeq(2, 0xfffffffe)).toBe(true);
    expect(frameGeq(0xffffffff, 3)).toBe(false); // "none" is older than everything
  });
});

describe('visibleDocRect', () => {
  it('whole document visible (fit): the document rect and zoom x dpr', () => {
    expect(visibleDocRect({ zoom: 0.5, x: 100, y: 50 }, 800, 400, 1000, 600, 2)).toEqual({ x: 0, y: 0, w: 1000, h: 600, scale: 1 });
  });
  it('zoomed in and panned: the visible part, rounded outwards', () => {
    // zoom 2, origin at (-300.5, -100): visible doc x from 150.25 -> 150, to (800+300.5)/2 = 550.25 -> 551
    expect(visibleDocRect({ zoom: 2, x: -300.5, y: -100 }, 800, 400, 1000, 600, 1)).toEqual({ x: 150, y: 50, w: 401, h: 200, scale: 2 });
  });
  it('clips to the document and handles offscreen / unmeasured', () => {
    expect(visibleDocRect({ zoom: 1, x: 700, y: 0 }, 800, 400, 1000, 600, 1)).toEqual({ x: 0, y: 0, w: 100, h: 400, scale: 1 });
    expect(visibleDocRect({ zoom: 1, x: 900, y: 0 }, 800, 400, 1000, 600, 1)).toBeNull();
    expect(visibleDocRect({ zoom: 1, x: 0, y: 0 }, 0, 400, 1000, 600, 1)).toBeNull();
  });
  it('sameViewport compares all fields', () => {
    const a = { x: 0, y: 0, w: 1, h: 1, scale: 1 };
    expect(sameViewport(a, { ...a })).toBe(true);
    expect(sameViewport(a, { ...a, scale: 2 })).toBe(false);
    expect(sameViewport(null, null)).toBe(true);
    expect(sameViewport(a, null)).toBe(false);
  });
});

describe('ExactBuffer', () => {
  const tile = (w: number, h: number, v: number) => solid(w, h, v, v, v, 255);
  it('full frame then tile patches only touch their rect (incl. semi-transparent pixels)', () => {
    const b = new ExactBuffer();
    const base = solid(130, 70, 10, 20, 30, 128);
    expect(b.applyFull(130, 70, base)).toMatchObject({ ok: true, dirty: [{ x: 0, y: 0, w: 130, h: 70 }] });
    const body = new Uint8Array(8 + 2 * 3 * 4);
    const dv = new DataView(body.buffer);
    dv.setUint16(0, 2, true); dv.setUint16(2, 1, true); dv.setUint16(4, 2, true); dv.setUint16(6, 3, true); // tile (2,1): x 128, y 64, 2 x 3? y 64..67 (docH 70)
    body.set(tile(2, 3, 200), 8);
    const r = b.applyTiles(130, 70, 64, 1, body);
    expect(r).toEqual({ ok: true, dirty: [{ x: 128, y: 64, w: 2, h: 3 }] });
    const px = (x: number, y: number) => Array.from(b.data.subarray((y * 130 + x) * 4, (y * 130 + x) * 4 + 4));
    expect(px(128, 64)).toEqual([200, 200, 200, 255]);
    expect(px(129, 66)).toEqual([200, 200, 200, 255]);
    expect(px(127, 64)).toEqual([10, 20, 30, 128]);
    expect(px(128, 67)).toEqual([10, 20, 30, 128]);
  });
  it('tiles without a buffer / for another size are refused and change nothing', () => {
    const b = new ExactBuffer();
    expect(b.applyTiles(64, 64, 64, 0, new Uint8Array(0))).toEqual({ ok: false, reason: 'no-buffer' });
    b.applyFull(64, 64, solid(64, 64, 1, 1, 1));
    expect(b.applyTiles(128, 64, 64, 1, new Uint8Array(8))).toEqual({ ok: false, reason: 'size' });
  });
  it('a malformed tile frame (bad length / rect outside) leaves the buffer untouched', () => {
    const b = new ExactBuffer();
    b.applyFull(64, 64, solid(64, 64, 1, 1, 1));
    const before = b.data.slice();
    const body = new Uint8Array(8 + 4);
    new DataView(body.buffer).setUint16(4, 1, true); new DataView(body.buffer).setUint16(6, 2, true); // 1x2 tile needs 8 bytes of pixels
    expect(b.applyTiles(64, 64, 64, 1, body)).toEqual({ ok: false, reason: 'length' });
    const out = new Uint8Array(8 + 64 * 64 * 4);
    new DataView(out.buffer).setUint16(0, 1, true); new DataView(out.buffer).setUint16(4, 64, true); new DataView(out.buffer).setUint16(6, 64, true);
    expect(b.applyTiles(64, 64, 64, 1, out)).toEqual({ ok: false, reason: 'tile' });
    expect(Array.from(b.data)).toEqual(Array.from(before));
  });
  it('a full frame of the wrong length invalidates; the same size reuses the allocation', () => {
    const b = new ExactBuffer();
    b.applyFull(8, 8, solid(8, 8, 1, 2, 3));
    const mem = b.data;
    b.applyFull(8, 8, solid(8, 8, 4, 5, 6));
    expect(b.data).toBe(mem);
    expect(b.applyFull(8, 8, new Uint8Array(10))).toEqual({ ok: false, reason: 'length' });
    expect(b.valid).toBe(false);
    b.applyFull(16, 8, solid(16, 8, 0, 0, 0));
    expect(b.data).not.toBe(mem);
    expect(b.w).toBe(16);
  });
});

// ---- client bookkeeping ----

interface Ev { k: string; [key: string]: unknown }
function setup(opts: { decodeFail?: boolean; fetchExact?: (id: number) => Promise<ArrayBuffer | null>; exactOk?: boolean; maxDim?: number; decodeTimeoutMs?: number } = {}) {
  const notices: string[] = [];
  const clock = { t: 0 };
  const sent: WebMessage[] = [];
  const events: Ev[] = [];
  const shown: (ShownKind | null)[] = [];
  const displayed: number[] = [];
  const decodes: { resolve: () => void }[] = [];
  let hold = false;
  let closed = 0;
  const sink: ViewSink = {
    fast: (i: FastImage) => { events.push({ k: 'fast', x: i.x, w: i.w, alpha: i.alpha !== null }); i.rgb.close(); i.alpha?.close(); },
    exact: (b, d) => { events.push({ k: 'exact', dirty: d, first: Array.from(b.data.subarray(0, 4)) }); return opts.exactOk ?? true; },
    maxExactDim: opts.maxDim === undefined ? undefined : () => opts.maxDim!,
    show: (k) => events.push({ k: 'show', kind: k }),
    clear: () => events.push({ k: 'clear' }),
  };
  const bitmap = () => ({ width: 16, height: 16, close: () => { closed++; } }) as unknown as ImageBitmap;
  const client = new TdViewClient({
    send: (m) => sent.push(m), sink,
    decodeJpeg: () => (opts.decodeFail ? Promise.reject(new Error('bad jpeg')) : hold ? new Promise<ImageBitmap>((res) => decodes.push({ resolve: () => res(bitmap()) })) : Promise.resolve(bitmap())),
    fetchExact: opts.fetchExact,
    onShown: (k) => shown.push(k), onDisplayed: (_k, a) => displayed.push(a),
    onNotice: (m) => notices.push(m), now: () => clock.t, decodeTimeoutMs: opts.decodeTimeoutMs,
  });
  return { client, notices, clock, sent, events, shown, displayed, decodes, hold: (v: boolean) => { hold = v; }, closed: () => closed };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = () => new Promise<void>((r) => setTimeout(r, 25)); // DecompressionStream needs a few macrotasks
const acks = (s: WebMessage[]) => s.filter((m) => m.t === 'viewAck').map((m) => (m as { frameId: number }).frameId);

describe('TdViewClient: fast frames', () => {
  it('decodes both JPEGs, hands them to the sink and acks after the decode', async () => {
    const t = setup();
    t.client.handleBinary(fastFrame({ frameId: 5, appliedFrameId: 9, x: 4, w: 30 }, 'red', 'a128'));
    expect(acks(t.sent)).toEqual([]); // not before the decode
    await tick();
    expect(acks(t.sent)).toEqual([5]);
    expect(t.events.filter((e) => e.k === 'fast')).toEqual([{ k: 'fast', x: 4, w: 30, alpha: true }]);
    expect(t.client.on).toBe('fast');
    expect(t.shown).toEqual(['fast']);
    expect(t.displayed).toEqual([9]);
  });
  it('one decode at a time: the newest waiting frame replaces an older one, which is acked at once', async () => {
    const t = setup();
    t.hold(true);
    t.client.handleBinary(fastFrame({ frameId: 1 }));
    t.client.handleBinary(fastFrame({ frameId: 2 }));
    t.client.handleBinary(fastFrame({ frameId: 3 }));
    expect(acks(t.sent)).toEqual([2]); // 2 was replaced by 3 before it was ever decoded
    t.decodes[0].resolve(); await tick();
    expect(acks(t.sent)).toEqual([2, 1]);
    t.decodes[1].resolve(); await tick();
    expect(acks(t.sent)).toEqual([2, 1, 3]);
    expect(t.events.filter((e) => e.k === 'fast')).toHaveLength(2); // frames 1 and 3
    expect(t.client.stats.fastDropped).toBe(1);
  });
  it('a failed decode still acks (TD must not stall) and nothing is shown', async () => {
    const t = setup({ decodeFail: true });
    t.client.handleBinary(fastFrame({ frameId: 8 }));
    await tick();
    expect(acks(t.sent)).toEqual([8]);
    expect(t.client.on).toBeNull();
    expect(t.client.stats.errors).toBe(1);
  });
  it('unknown / malformed binary messages are ignored', () => {
    const t = setup();
    expect(t.client.handleBinary(new Uint8Array(5))).toBe(false);
    const unknown = new Uint8Array(40); unknown.set(MAGIC); unknown[4] = 77;
    expect(t.client.handleBinary(unknown)).toBe(true); // unknown view-range type: acked, buffer desync assumed
    expect(t.sent.map((m) => m.t)).toEqual(['viewExactReset', 'viewAck']);
  });
  it('reset() drops a decode that finishes afterwards (tab switch) and releases its bitmaps', async () => {
    const t = setup();
    t.hold(true);
    t.client.handleBinary(fastFrame({ frameId: 1 }, 'red', 'a128'));
    t.client.reset();
    t.decodes[0].resolve(); t.decodes[1].resolve();
    await tick();
    expect(t.events.filter((e) => e.k === 'fast')).toEqual([]);
    expect(acks(t.sent)).toEqual([1]);
    expect(t.closed()).toBe(2);
    expect(t.client.on).toBeNull();
  });
});

describe('TdViewClient: exact frames', () => {
  it('a full frame fills the buffer and replaces the fast frame when applied >= the fast one', async () => {
    const t = setup();
    t.client.handleBinary(fastFrame({ frameId: 1, appliedFrameId: 10 }));
    await tick();
    t.client.handleBinary(await exactFull(4, 2, solid(4, 2, 9, 8, 7, 6), 2, 10));
    await settle();
    expect(t.client.on).toBe('exact');
    expect(t.events.find((e) => e.k === 'exact')).toMatchObject({ dirty: [{ x: 0, y: 0, w: 4, h: 2 }], first: [9, 8, 7, 6] });
    expect(t.client.exactBuf.valid).toBe(true);
  });
  it('an exact frame OLDER than the fast one updates the buffer but the fast frame stays on screen', async () => {
    const t = setup();
    t.client.handleBinary(fastFrame({ frameId: 1, appliedFrameId: 12 }));
    await tick();
    t.client.handleBinary(await exactFull(4, 2, solid(4, 2, 1, 1, 1), 2, 11));
    await settle();
    expect(t.client.on).toBe('fast');
    expect(t.client.exactBuf.valid).toBe(true);
  });
  it('a fast frame older than the exact one on screen is dropped; a newer one replaces it', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(4, 2, solid(4, 2, 1, 1, 1), 1, 20));
    await settle();
    expect(t.client.on).toBe('exact');
    t.client.handleBinary(fastFrame({ frameId: 2, appliedFrameId: 19 }));
    await tick();
    expect(t.client.on).toBe('exact');
    expect(t.client.stats.fastStale).toBe(1);
    expect(acks(t.sent)).toEqual([1, 2]); // the exact frame, then the stale fast one: both acked
    t.client.handleBinary(fastFrame({ frameId: 3, appliedFrameId: 21 }));
    await tick();
    expect(t.client.on).toBe('fast');
  });
  it('tile patches apply to the persistent buffer; only the tiles are uploaded', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(128, 64, solid(128, 64, 5, 5, 5, 99), 1, 1));
    await settle();
    t.client.handleBinary(await exactTiles(128, 64, [{ tx: 1, ty: 0, w: 64, h: 64, rgba: solid(64, 64, 200, 100, 50, 7) }], 2, 2));
    await settle();
    const ex = t.events.filter((e) => e.k === 'exact');
    expect(ex[1]).toMatchObject({ dirty: [{ x: 64, y: 0, w: 64, h: 64 }] });
    const b = t.client.exactBuf;
    expect(Array.from(b.data.subarray(63 * 4, 63 * 4 + 4))).toEqual([5, 5, 5, 99]);
    expect(Array.from(b.data.subarray(64 * 4, 64 * 4 + 4))).toEqual([200, 100, 50, 7]);
    expect(t.sent.filter((m) => m.t === 'viewExactReset')).toHaveLength(0);
  });
  it('tiles with no buffer, or for another document size, send viewExactReset (once) and wait for a full frame', async () => {
    const t = setup();
    const tiles = (w: number, h: number) => exactTiles(w, h, [{ tx: 0, ty: 0, w: 64, h: 64, rgba: solid(64, 64, 1, 1, 1) }], 3, 3);
    t.client.handleBinary(await tiles(64, 64));
    t.client.handleBinary(await tiles(64, 64));
    await settle();
    expect(t.sent.filter((m) => m.t === 'viewExactReset')).toHaveLength(1);
    expect(t.events.filter((e) => e.k === 'exact')).toHaveLength(0);
    t.client.handleBinary(await exactFull(64, 64, solid(64, 64, 2, 2, 2), 4, 4)); // TD answers with a full frame
    await settle();
    t.client.handleBinary(await tiles(128, 64)); // the document was resized and TD still diffs against the old buffer
    await settle();
    expect(t.sent.filter((m) => m.t === 'viewExactReset')).toHaveLength(2);
  });
  it('a corrupt deflate stream invalidates the buffer and asks for a full frame', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(8, 8, solid(8, 8, 1, 1, 1), 1, 1));
    await settle();
    const bad = await exactFull(8, 8, solid(8, 8, 2, 2, 2), 2, 2);
    for (let i = 40; i < bad.length; i++) bad[i] ^= 0x5a;
    t.client.handleBinary(bad);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sent.filter((m) => m.t === 'viewExactReset')).toHaveLength(1);
    expect(t.client.exactBuf.valid).toBe(false);
  });
  it('viewExact notices fetch over HTTP and apply in order with socket frames', async () => {
    const fetched: number[] = [];
    const t = setup({ fetchExact: async (id) => { fetched.push(id); return (await exactFull(4, 2, solid(4, 2, 77, 0, 0), id, 3)).slice().buffer; } });
    t.client.handleExactNotice(33);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched).toEqual([33]);
    expect(t.events.find((e) => e.k === 'exact')).toMatchObject({ first: [77, 0, 0, 255] });
    // a 404 (null) is ignored
    const t2 = setup({ fetchExact: async () => null });
    t2.client.handleExactNotice(1);
    await settle();
    expect(t2.events).toEqual([]);
  });
  it('reset() forgets the buffer (leaving TD mode: TD diffs against what it last sent, which the page no longer holds)', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(4, 2, solid(4, 2, 1, 1, 1), 1, 1));
    await settle();
    t.client.reset();
    expect(t.client.exactBuf.valid).toBe(false);
    expect(t.client.on).toBeNull();
    expect(t.events.filter((e) => e.k === 'clear')).toHaveLength(1);
    t.client.handleBinary(await exactTiles(4, 2, [{ tx: 0, ty: 0, w: 4, h: 2, rgba: solid(4, 2, 9, 9, 9) }], 2, 2)); // a later tile frame -> reset + full
    await settle();
    expect(t.sent.filter((m) => m.t === 'viewExactReset')).toHaveLength(1);
  });
});

describe('exact frames are acked, in order', () => {
  it('acks after applying, also when TD must be told to reset', async () => {
    const t = setup();
    t.client.handleBinary(await exactTiles(64, 64, [{ tx: 0, ty: 0, w: 64, h: 64, rgba: solid(64, 64, 1, 1, 1) }], 6, 1)); // no buffer
    t.client.handleBinary(await exactFull(64, 64, solid(64, 64, 1, 1, 1), 7, 2));
    await settle();
    expect(acks(t.sent)).toEqual([6, 7]);
    expect(t.sent.map((m) => m.t)).toEqual(['viewExactReset', 'viewAck', 'viewAck']);
  });
});

describe('zero-tile exact frames', () => {
  it('re-announce the unchanged exact picture after fast frames (a viewport change leaves the exact image as it was)', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(64, 64, solid(64, 64, 4, 5, 6), 1, 7));
    await settle();
    t.client.handleBinary(fastFrame({ frameId: 2, appliedFrameId: 7 })); // same applied id as the exact frame: a viewport-only fast frame
    await settle();
    expect(t.client.on).toBe('fast');
    t.client.handleBinary(await exactTiles(64, 64, [], 3, 7));
    await settle();
    expect(t.client.on).toBe('exact');
    expect(t.sent.filter((m) => m.t === 'viewExactReset')).toHaveLength(0);
    expect(Array.from(t.client.exactBuf.data.subarray(0, 4))).toEqual([4, 5, 6, 255]);
  });
});

describe('arrival order decides what stays on screen', () => {
  it('a fast frame that arrived BEFORE an exact frame but finishes decoding after it does not cover it', async () => {
    const t = setup();
    t.hold(true);
    t.client.handleBinary(fastFrame({ frameId: 1, appliedFrameId: 5 }));
    t.hold(false);
    t.client.handleBinary(await exactFull(8, 8, solid(8, 8, 1, 1, 1), 2, 5)); // same applied id, sent later
    await settle();
    expect(t.client.on).toBe('exact');
    t.decodes[0].resolve(); // the slow fast-frame decode completes now
    await settle();
    expect(t.client.on).toBe('exact');
    expect(t.client.stats.fastStale).toBe(1);
    expect(acks(t.sent)).toContain(1);
  });
  it('an exact frame that arrived before a fast frame already on screen does not cover it', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(8, 8, solid(8, 8, 1, 1, 1), 1, 5));
    t.client.handleBinary(fastFrame({ frameId: 2, appliedFrameId: 5 }));
    await settle();
    expect(t.client.on).toBe('fast'); // sent last
  });
});

const resets = (s: WebMessage[]) => s.filter((m) => m.t === 'viewExactReset').length;

describe('review fixes: exact buffer desync', () => {
  it('a failed or empty fetch for a viewExact-announced frame asks for a full frame (but not after a reset or dispose)', async () => {
    const t = setup({ fetchExact: async () => null });
    t.client.handleExactNotice(5);
    await settle();
    expect(resets(t.sent)).toBe(1);
    expect(acks(t.sent)).toEqual([5]);
    const t2 = setup({ fetchExact: () => new Promise(() => {}) });
    t2.client.handleExactNotice(1);
    t2.client.reset();
    const t3 = setup({ fetchExact: async () => { await tick(); return null; } });
    t3.client.handleExactNotice(1);
    t3.client.dispose();
    await settle();
    expect(resets(t3.sent)).toBe(0);
  });
  it('an unparsable fast frame is acked; an unparsable or unknown exact frame also resets', async () => {
    const t = setup();
    const f = fastFrame({ frameId: 21 });
    expect(t.client.handleBinary(f.subarray(0, f.length - 3))).toBe(true);
    expect(acks(t.sent)).toEqual([21]);
    expect(resets(t.sent)).toBe(0);
    const ex = await exactFull(8, 8, solid(8, 8, 1, 1, 1), 22, 1);
    ex[24 + 13] = 7; // tile != 64
    t.client.handleBinary(ex);
    expect(acks(t.sent)).toEqual([21, 22]);
    expect(resets(t.sent)).toBe(1);
    expect(t.client.exactBuf.valid).toBe(false);
    expect(t.client.handleBinary(new Uint8Array(12))).toBe(false); // no magic: nothing to read
  });
  it('frames that arrive in Local mode are acked and dropped without decoding or uploading', async () => {
    const t = setup();
    t.client.setActive(false);
    t.client.handleBinary(fastFrame({ frameId: 3 }));
    t.client.handleBinary(await exactFull(8, 8, solid(8, 8, 1, 1, 1), 4, 1));
    t.client.handleExactNotice(5);
    await settle();
    expect(acks(t.sent).sort()).toEqual([3, 4]);
    expect(t.events.filter((e) => e.k === 'fast' || e.k === 'exact')).toEqual([]);
    expect(t.client.stats.fastIn).toBe(0);
  });
});

describe('review fixes: inflate bomb and size caps', () => {
  it('a full frame that inflates beyond docW x docH x 4 is cut off and resets; the buffer never grows past it', async () => {
    const t = setup();
    const huge = await exactFull(8, 8, new Uint8Array(8 * 8 * 4 + 5_000_000), 1, 1); // 8x8 header, 5 MB of data
    t.client.handleBinary(huge);
    await settle();
    expect(resets(t.sent)).toBe(1);
    expect(t.client.exactBuf.valid).toBe(false);
    expect(t.client.exactBuf.data.length).toBe(8 * 8 * 4);
    expect(t.events.filter((e) => e.k === 'exact')).toEqual([]);
  });
  it('a short full frame is a failure too', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(8, 8, new Uint8Array(10), 1, 1));
    await settle();
    expect(resets(t.sent)).toBe(1);
  });
  it('a tile frame is capped by nTiles x tile bytes', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(64, 64, solid(64, 64, 1, 1, 1), 1, 1));
    await settle();
    t.client.handleBinary(await exactTiles(64, 64, [], 2, 2).then((b) => { const c = b.slice(); return c; }));
    await settle();
    expect(resets(t.sent)).toBe(0);
    // 1 tile announced, 3 tiles of data
    const body = await exactTiles(64, 64, [{ tx: 0, ty: 0, w: 64, h: 64, rgba: new Uint8Array(64 * 64 * 4 * 3) }], 3, 3);
    t.client.handleBinary(body);
    await settle();
    expect(resets(t.sent)).toBe(1);
    expect(t.client.exactBuf.valid).toBe(false);
  });
  it('a document beyond the pixel budget or the GPU texture size is refused before inflating: notice once, no reset, fast frames stay', async () => {
    const t = setup({ maxDim: 4096 });
    t.client.handleBinary(fastFrame({ frameId: 1, appliedFrameId: 1 }));
    await settle();
    t.client.handleBinary(await exactFull(5000, 8, new Uint8Array(0), 2, 2)); // body is never inflated
    t.client.handleBinary(await exactFull(5000, 8, new Uint8Array(0), 3, 3));
    await settle();
    expect(t.notices).toHaveLength(1);
    expect(t.client.stats.refused).toBe(2);
    expect(resets(t.sent)).toBe(0);
    expect(t.client.on).toBe('fast');
    const t2 = setup();
    t2.client.handleBinary(await exactFull(9000, 9000, new Uint8Array(0), 1, 1));
    await settle();
    expect(t2.client.stats.refused).toBe(1);
  });
  it('more tiles than the document has is refused', async () => {
    const t = setup();
    t.client.handleBinary(await exactFull(64, 64, solid(64, 64, 1, 1, 1), 1, 1));
    await settle();
    const tiles = [0, 1].map((tx) => ({ tx, ty: 0, w: 64, h: 64, rgba: solid(64, 64, 0, 0, 0) }));
    t.client.handleBinary(await exactTiles(64, 64, tiles, 2, 2));
    await settle();
    expect(resets(t.sent)).toBe(1);
  });
});

describe('review fixes: resetSent', () => {
  it('is cleared by any full frame (even a failing one, which asks again), and re-armed after 2 s', async () => {
    const t = setup();
    const tiles = () => exactTiles(64, 64, [{ tx: 0, ty: 0, w: 64, h: 64, rgba: solid(64, 64, 1, 1, 1) }], 9, 9);
    t.client.handleBinary(await tiles());
    await settle();
    expect(resets(t.sent)).toBe(1);
    t.client.handleBinary(await exactFull(64, 64, new Uint8Array(10), 10, 10)); // the answer is broken
    await settle();
    expect(resets(t.sent)).toBe(2);
    // TD never answers: after 2 s another reset is allowed; a refused tile frame re-arms after 0.5 s
    t.clock.t = 400;
    t.client.handleBinary(await tiles()); await settle();
    expect(resets(t.sent)).toBe(2);
    t.clock.t = 600;
    t.client.handleBinary(await tiles()); await settle();
    expect(resets(t.sent)).toBe(3);
    t.client.handleBinary(new Uint8Array(0));
    const bad = await exactFull(8, 8, solid(8, 8, 1, 1, 1), 11, 11); bad[24 + 13] = 9;
    t.clock.t = 2700;
    t.client.handleBinary(bad);
    expect(resets(t.sent)).toBe(4);
  });
});

describe('review fixes: sink failures, reset and decode timeouts', () => {
  it('when the sink cannot show the exact picture, the fast frame and the "≈" badge stay and the user is told once', async () => {
    const t = setup({ exactOk: false });
    t.client.handleBinary(fastFrame({ frameId: 1, appliedFrameId: 4 }));
    await settle();
    t.client.handleBinary(await exactFull(8, 8, solid(8, 8, 1, 1, 1), 2, 4));
    t.client.handleBinary(await exactFull(8, 8, solid(8, 8, 1, 1, 1), 3, 4));
    await settle();
    expect(t.client.on).toBe('fast');
    expect(t.shown.at(-1)).toBe('fast');
    expect(t.notices).toHaveLength(1);
    t.client.handleBinary(fastFrame({ frameId: 4, appliedFrameId: 5 })); // later fast frames are not dropped as "older than exact"
    await settle();
    expect(t.client.stats.fastShown).toBe(2);
  });
  it('reset() acks the frame that was waiting for the decoder', async () => {
    const t = setup();
    t.hold(true);
    t.client.handleBinary(fastFrame({ frameId: 1 }));
    t.client.handleBinary(fastFrame({ frameId: 2 }));
    t.client.handleBinary(fastFrame({ frameId: 3 }));
    expect(acks(t.sent)).toEqual([2]);
    t.client.reset();
    expect(acks(t.sent)).toEqual([2, 3]);
  });
  it('a createImageBitmap that never settles times out, is acked, and the next frame decodes', async () => {
    const t = setup({ decodeTimeoutMs: 30 });
    t.hold(true);
    t.client.handleBinary(fastFrame({ frameId: 1 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(acks(t.sent)).toEqual([1]);
    expect(t.client.stats.errors).toBe(1);
    t.hold(false);
    t.client.handleBinary(fastFrame({ frameId: 2 }));
    await settle();
    expect(t.client.on).toBe('fast');
    t.decodes[0].resolve(); // the late bitmap of the timed-out frame is released
    await tick();
    expect(t.closed()).toBeGreaterThanOrEqual(1);
  });
});
