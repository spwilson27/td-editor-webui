import { describe, expect, it } from 'vitest';
import {
  decodeFrame, decodeTdMessage, decodeWebMessage, encodeBands, encodeFrame, encodeMessage, isStale,
  FRAME_BASE, FRAME_COMPOSITE, HEADER_BYTES, MAX_BAND_PAYLOAD, type FrameHeader,
} from '../../src/bridge/codec';

const hdr = (o: Partial<FrameHeader> = {}): FrameHeader => ({
  type: FRAME_BASE, frameEnd: true, frameId: 7, docW: 100, docH: 50, x: 10, y: 5, w: 4, h: 3, ...o,
});
const px = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 255);

describe('frame header', () => {
  it('encodes the exact little-endian layout', () => {
    const msg = encodeFrame(hdr({ frameId: 0x01020304 }), px(48));
    expect(msg.length).toBe(HEADER_BYTES + 48);
    expect(Array.from(msg.subarray(0, 24))).toEqual([
      0x52, 0x45, 0x46, 0x31, 1, 1, 0, 0, 0x04, 0x03, 0x02, 0x01, 100, 0, 50, 0, 10, 0, 5, 0, 4, 0, 3, 0,
    ]);
    expect(Array.from(msg.subarray(24, 28))).toEqual([0, 1, 2, 3]);
  });

  it('round trips every field', () => {
    const h = hdr({ type: FRAME_COMPOSITE, frameEnd: false, frameId: 0xffffffff, docW: 65535, docH: 65535, x: 65530, y: 65000, w: 5, h: 535 });
    const r = decodeFrame(encodeFrame(h, px(5 * 535 * 4)));
    expect(r.ok && { ...r.frame, payload: undefined }).toEqual({ ...h, payload: undefined });
    expect(r.ok && r.frame.payload.length).toBe(5 * 535 * 4);
  });

  it('frameId wraps at 2^32', () => {
    const r = decodeFrame(encodeFrame(hdr({ frameId: 2 ** 32 + 5 }), px(48)));
    expect(r.ok && r.frame.frameId).toBe(5);
  });

  it('decodes from ArrayBuffer and from an offset view', () => {
    const msg = encodeFrame(hdr(), px(48));
    const padded = new Uint8Array(msg.length + 10);
    padded.set(msg, 10);
    expect(decodeFrame(msg.buffer as ArrayBuffer).ok).toBe(true);
    const r = decodeFrame(padded.subarray(10));
    expect(r.ok && Array.from(r.frame.payload.subarray(0, 3))).toEqual([0, 1, 2]);
  });

  it('ignores reserved flag bits', () => {
    const msg = encodeFrame(hdr({ frameEnd: false }), px(48));
    msg[5] = 0b110;
    const r = decodeFrame(msg);
    expect(r.ok && r.frame.frameEnd).toBe(false);
  });
});

describe('decode validation', () => {
  const good = () => encodeFrame(hdr(), px(48));
  it.each([
    ['too-short', () => good().subarray(0, 23)],
    ['bad-magic', () => { const m = good(); m[0] = 0x58; return m; }],
    ['bad-type', () => { const m = good(); m[4] = 3; return m; }],
    ['bad-rect', () => { const m = good(); m[20] = 0; m[21] = 0; return m; }], // w = 0
    ['bad-rect', () => { const m = good(); m[16] = 99; return m; }], // x + w > docW
    ['bad-rect', () => { const m = good(); m[18] = 49; return m; }], // y + h > docH
    ['bad-length', () => good().subarray(0, 24 + 47)],
    ['bad-length', () => { const m = new Uint8Array(good().length + 1); m.set(good()); return m; }],
  ] as const)('%s', (error, make) => {
    expect(decodeFrame(make())).toEqual({ ok: false, error });
  });

  it('stale frames are detected by document size', () => {
    expect(isStale(hdr(), 100, 50)).toBe(false);
    expect(isStale(hdr(), 100, 51)).toBe(true);
    expect(isStale(hdr(), 99, 50)).toBe(true);
  });
});

describe('encode validation', () => {
  it('rejects bad rects and payloads', () => {
    expect(() => encodeFrame(hdr({ w: 0 }), px(0))).toThrow(RangeError);
    expect(() => encodeFrame(hdr({ x: 98 }), px(48))).toThrow(RangeError);
    expect(() => encodeFrame(hdr({ x: -1 }), px(48))).toThrow(RangeError);
    expect(() => encodeFrame(hdr({ docW: 70000 }), px(48))).toThrow(RangeError);
    expect(() => encodeFrame(hdr(), px(47))).toThrow(RangeError);
    expect(() => encodeFrame(hdr({ type: 9 as 1 }), px(48))).toThrow(RangeError);
  });
});

describe('banding', () => {
  const run = (w: number, h: number, maxPayload?: number) => {
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7) & 255;
    const bands = Array.from(encodeBands({ type: FRAME_COMPOSITE, frameId: 3, docW: 2000, docH: 2000, rect: { x: 1, y: 2, w, h }, pixels, maxPayload }));
    return { pixels, frames: bands.map((b) => { const r = decodeFrame(b); if (!r.ok) throw new Error(r.error); return r.frame; }) };
  };

  it('payload of exactly 2 MB is a single band', () => {
    const { frames } = run(512, 1024); // 512*1024*4 = 2 MiB
    expect(512 * 1024 * 4).toBe(MAX_BAND_PAYLOAD);
    expect(frames).toHaveLength(1);
    expect(frames[0].frameEnd).toBe(true);
  });

  it('one row over 2 MB splits into two bands', () => {
    const { frames } = run(512, 1025);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.h)).toEqual([1024, 1]);
    expect(frames.map((f) => f.frameEnd)).toEqual([false, true]);
    expect(frames[1].y).toBe(2 + 1024);
  });

  it('bands tile the rect without overlap and reassemble the pixels', () => {
    const { pixels, frames } = run(333, 700, 100_000);
    expect(frames.every((f) => f.payload.length <= 100_000)).toBe(true);
    let y = 2;
    const joined: number[] = [];
    for (const f of frames) {
      expect(f.y).toBe(y);
      expect(f.frameId).toBe(3);
      expect(f.x).toBe(1);
      y += f.h;
      joined.push(...Array.from(f.payload));
    }
    expect(y).toBe(2 + 700);
    expect(frames.filter((f) => f.frameEnd)).toEqual([frames[frames.length - 1]]);
    expect(joined).toEqual(Array.from(pixels));
  });

  it('1x1 rect and invalid inputs', () => {
    expect(run(1, 1).frames).toHaveLength(1);
    expect(() => run(10, 10, 39)).toThrow(RangeError);
    expect(() => [...encodeBands({ type: 1, frameId: 0, docW: 10, docH: 10, rect: { x: 0, y: 0, w: 2, h: 2 }, pixels: px(15) })]).toThrow(RangeError);
    expect(() => [...encodeBands({ type: 1, frameId: 0, docW: 10, docH: 10, rect: { x: 9, y: 0, w: 2, h: 2 }, pixels: px(16) })]).toThrow(RangeError);
  });

  it('encodes a dirty 256x256 frame quickly', () => {
    if (process.env.PERF === '0') return;
    const pixels = new Uint8Array(256 * 256 * 4);
    const args = { type: FRAME_COMPOSITE, frameId: 1, docW: 1920, docH: 1080, rect: { x: 0, y: 0, w: 256, h: 256 }, pixels } as const;
    for (let i = 0; i < 20; i++) [...encodeBands(args)];
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) [...encodeBands(args)];
    expect((performance.now() - t0) / 200).toBeLessThan(1);
  });
});

describe('json messages', () => {
  it('web messages round trip', () => {
    const msgs = [
      { t: 'ready', protocol: 1, client: 'panel', version: '0.1.0' },
      { t: 'takeover' },
      { t: 'requestBase' },
      { t: 'log', level: 'warn', msg: 'x' },
    ] as const;
    for (const m of msgs) expect(decodeWebMessage(encodeMessage(m))).toEqual(m);
  });

  it('td messages round trip and strip unknown fields', () => {
    const hello = { t: 'hello', protocol: 1, doc: { w: 1920, h: 1080 }, hasInput: true, maxSendFps: 30, active: false } as const;
    expect(decodeTdMessage(encodeMessage(hello))).toEqual(hello);
    expect(decodeTdMessage(JSON.stringify({ ...hello, extra: 1 }))).toEqual(hello);
    expect(decodeTdMessage('{"t":"docSize","w":4,"h":5,"hasInput":false}')).toEqual({ t: 'docSize', w: 4, h: 5, hasInput: false });
    expect(decodeTdMessage('{"t":"active","active":true}')).toEqual({ t: 'active', active: true });
    expect(decodeTdMessage('{"t":"error","msg":"nope"}')).toEqual({ t: 'error', msg: 'nope' });
  });

  it('ignores unknown types and malformed input', () => {
    for (const s of ['{"t":"future"}', 'not json', '[]', 'null', '{"x":1}', '"hello"']) {
      expect(decodeTdMessage(s)).toBeNull();
      expect(decodeWebMessage(s)).toBeNull();
    }
  });

  it('rejects non-integer or non-positive sizes in hello and docSize', () => {
    const hello = (w: number, h: number) => JSON.stringify({ t: 'hello', protocol: 1, doc: { w, h }, hasInput: true, maxSendFps: 30, active: true });
    expect(decodeTdMessage(hello(1920, 1080))).not.toBeNull();
    for (const [w, h] of [[0, 10], [10, 0], [-5, 10], [10.5, 10], [10, 1e9]]) {
      expect(decodeTdMessage(hello(w, h))).toBeNull();
      expect(decodeTdMessage(JSON.stringify({ t: 'docSize', w, h, hasInput: false }))).toBeNull();
    }
  });

  it('rejects messages with missing or wrong-typed fields', () => {
    expect(decodeTdMessage('{"t":"hello","protocol":1}')).toBeNull();
    expect(decodeTdMessage('{"t":"docSize","w":"4","h":5,"hasInput":false}')).toBeNull();
    expect(decodeTdMessage('{"t":"active"}')).toBeNull();
    expect(decodeTdMessage('{"t":"error","msg":3}')).toBeNull();
    expect(decodeWebMessage('{"t":"ready","protocol":1,"client":"other","version":"1"}')).toBeNull();
    expect(decodeWebMessage('{"t":"log","level":"debug","msg":"x"}')).toBeNull();
  });
});
