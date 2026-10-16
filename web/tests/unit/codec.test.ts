import { describe, expect, it } from 'vitest';
import {
  decodeFrame, decodeTdMessage, normalizeLayer, decodeWebMessage, encodeBands, encodeFrame, encodeMessage, isStale, PROTOCOL_VERSION,
  FRAME_BASE, FRAME_SURFACE, FRAME_SURFACE_DUMP, FRAME_TOP, FRAME_VIEW, HEADER_BYTES, MAX_BAND_PAYLOAD, type FrameHeader,
} from '../../src/bridge/codec';

const hdr = (o: Partial<FrameHeader> = {}): FrameHeader => ({
  type: FRAME_BASE, frameEnd: true, slot: 1, frameId: 7, docW: 100, docH: 50, x: 10, y: 5, w: 4, h: 3, ...o,
});
const px = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 255);

describe('frame header', () => {
  it('encodes the exact little-endian layout', () => {
    const msg = encodeFrame(hdr({ frameId: 0x01020304, slot: 0x0102, type: FRAME_SURFACE }), px(48));
    expect(msg.length).toBe(HEADER_BYTES + 48);
    expect(Array.from(msg.subarray(0, 24))).toEqual([
      0x52, 0x45, 0x46, 0x31, 3, 1, 0x02, 0x01, 0x04, 0x03, 0x02, 0x01, 100, 0, 50, 0, 10, 0, 5, 0, 4, 0, 3, 0,
    ]);
    expect(Array.from(msg.subarray(24, 28))).toEqual([0, 1, 2, 3]);
  });

  it('round trips every field', () => {
    const h = hdr({ type: FRAME_SURFACE, slot: 65535, frameEnd: false, frameId: 0xffffffff, docW: 65535, docH: 65535, x: 65530, y: 65000, w: 5, h: 535 });
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
    ['bad-type', () => { const m = good(); m[4] = 2; return m; }], // COMPOSITE is invalid in v3
    ['bad-type', () => { const m = good(); m[4] = 8; return m; }],
    ['bad-rect', () => { const m = good(); m[20] = 0; m[21] = 0; return m; }], // w = 0
    ['bad-rect', () => { const m = good(); m[16] = 99; return m; }], // x + w > docW
    ['bad-rect', () => { const m = good(); m[18] = 49; return m; }], // y + h > docH
    ['bad-slot', () => { const m = good(); m[6] = 0; return m; }], // BASE slot = input index 1..8
    ['bad-slot', () => { const m = good(); m[6] = 9; return m; }],
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
    expect(() => encodeFrame(hdr({ type: 2 as 1 }), px(48))).toThrow(RangeError);
    expect(() => encodeFrame(hdr({ slot: 70000 }), px(48))).toThrow(RangeError);
    expect(() => encodeFrame(hdr({ slot: 0 }), px(48))).toThrow(RangeError); // BASE needs an input index
    expect(() => encodeFrame(hdr({ slot: 9 }), px(48))).toThrow(RangeError);
  });
});

describe('banding', () => {
  const run = (w: number, h: number, maxPayload?: number) => {
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7) & 255;
    const bands = Array.from(encodeBands({ type: FRAME_SURFACE, slot: 12, frameId: 3, docW: 2000, docH: 2000, rect: { x: 1, y: 2, w, h }, pixels, maxPayload }));
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
      expect(f.slot).toBe(12);
      expect(f.type).toBe(FRAME_SURFACE);
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
    const args = { type: FRAME_SURFACE, slot: 3, frameId: 1, docW: 1920, docH: 1080, rect: { x: 0, y: 0, w: 256, h: 256 }, pixels } as const;
    for (let i = 0; i < 20; i++) [...encodeBands(args)];
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) [...encodeBands(args)];
    expect((performance.now() - t0) / 200).toBeLessThan(1);
  });
});

describe('frame types', () => {
  it('SURFACE_DUMP and VIEW round trip with their slot', () => {
    for (const [type, slot] of [[FRAME_SURFACE_DUMP, 9], [FRAME_VIEW, 0]] as const) {
      const r = decodeFrame(encodeFrame(hdr({ type, slot }), px(48)));
      expect(r.ok && r.frame.type).toBe(type);
      expect(r.ok && r.frame.slot).toBe(slot);
    }
  });
});

describe('protocol v3 messages', () => {
  it('is protocol version 11', () => { expect(PROTOCOL_VERSION).toBe(11); });

  it('decodes a base notice and rejects incomplete ones', () => {
    const n = { t: 'base', frameId: 4000000000, input: 3, docW: 1920, docH: 1080, x: 0, y: 0, w: 1920, h: 1080 } as const;
    expect(decodeTdMessage(encodeMessage(n))).toEqual(n);
    expect(decodeTdMessage('{"t":"base","frameId":1}')).toBeNull();
    expect(decodeTdMessage('{"t":"base","frameId":1,"docW":4,"docH":2,"x":0,"y":0,"w":4,"h":2}')).toEqual({ t: 'base', frameId: 1, input: 1, docW: 4, docH: 2, x: 0, y: 0, w: 4, h: 2 }); // input defaults to 1
    expect(decodeTdMessage('{"t":"base","frameId":"1","docW":1,"docH":1,"x":0,"y":0,"w":1,"h":1}')).toBeNull();
  });

  it('hello carries hasDocument and rev (defaults false / null) and clientId (empty when absent)', () => {
    const h = { t: 'hello', protocol: 4, doc: { w: 4, h: 4 }, hasInput: false, maxSendFps: 30, active: true };
    expect(decodeTdMessage(JSON.stringify({ ...h, clientId: 'abc', hasDocument: true, rev: 12 }))).toEqual({ ...h, clientId: 'abc', hasDocument: true, rev: 12 });
    expect(decodeTdMessage(JSON.stringify({ ...h, rev: null }))).toEqual({ ...h, clientId: '', hasDocument: false, rev: null });
    expect(decodeWebMessage('{"t":"ack","frameId":1}')).toBeNull();
  });

  it('docState, view notice and applied', () => {
    const layers = [{ id: 'p', kind: 'pixel', rot: 0, kx: 0, ky: 0, input: null, effects: [] }];
    expect(decodeTdMessage(JSON.stringify({ t: 'docState', rev: 3, layers, docW: 8, docH: 4 }))).toEqual({ t: 'docState', rev: 3, layers, docW: 8, docH: 4, guides: { h: [], v: [] }, canvas: { mode: 'input' } });
    expect(decodeTdMessage(JSON.stringify({ t: 'docState', rev: 3, layers, docW: 8, docH: 4, guides: { h: [1, 'x', 2.5], v: 'no' }, canvas: { mode: 'fixed' } })))
      .toEqual({ t: 'docState', rev: 3, layers, docW: 8, docH: 4, guides: { h: [1, 2.5], v: [] }, canvas: { mode: 'fixed' } });
    expect(decodeTdMessage(JSON.stringify({ t: 'docState', rev: 3, layers: 'x', docW: 8, docH: 4 }))).toBeNull();
    expect(decodeTdMessage(JSON.stringify({ t: 'docState', rev: 3, layers, docW: 0, docH: 4 }))).toBeNull();
    const v = { t: 'viewExact', frameId: 9, size: 5000000 } as const;
    expect(decodeTdMessage(encodeMessage(v))).toEqual(v);
    expect(decodeTdMessage('{"t":"viewExact","frameId":9}')).toBeNull();
    expect(decodeTdMessage('{"t":"view","frameId":9,"docW":8,"docH":4,"w":8,"h":4}')).toBeNull(); // the v3 notice is gone
    expect(decodeTdMessage('{"t":"applied","frameId":5,"tdFrame":100}')).toEqual({ t: 'applied', frameId: 5, tdFrame: 100 });
    expect(decodeTdMessage('{"t":"applied"}')).toBeNull();
  });
});

describe('json messages', () => {
  it('web messages round trip', () => {
    const spec = { id: 'a', kind: 'adjustment', parentId: null, name: 'Levels', visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, rot: 0, kx: 0, ky: 0, input: null, effects: [], slot: null, mask: { slot: 4, enabled: true }, adjustment: { type: 'invert' } };
    const msgs = [
      { t: 'ready', protocol: 11, client: 'external', version: '0.1.0', token: 'abc', fresh: true },
      { t: 'doc', rev: 5, layers: [spec], guides: { h: [10], v: [] }, canvas: { mode: 'fixed' } },
      { t: 'setCanvas', w: 800, h: 600, mode: 'fixed' },
      { t: 'setCanvas', w: 0, h: 0, mode: 'input' },
      { t: 'renderLayer', requestId: 'r1', layerId: 'L3' },
      { t: 'requestDoc' },
      { t: 'saveProject', requestId: 'f1' },
      { t: 'saveProject', requestId: 'f2', path: '/tmp/a.redoc' },
      { t: 'openProject', requestId: 'f3', path: '/tmp/a.redoc' },
      { t: 'exportPng', requestId: 'f4' },
      { t: 'view', mode: 'td', quality: 'auto', viewport: { x: 12, y: 3, w: 900, h: 700, scale: 2 } },
      { t: 'view', mode: 'local' },
      { t: 'viewAck', frameId: 7 },
      { t: 'viewExactReset' },
      { t: 'takeover' },
      { t: 'requestBase' },
      { t: 'log', level: 'warn', msg: 'x' },
    ] as const;
    for (const m of msgs) expect(decodeWebMessage(encodeMessage(m as never))).toEqual(m);
  });

  it('v4: TOP_IMAGE frames (type 6) use the TOP size as the document size', () => {
    const top = hdr({ type: FRAME_TOP, slot: 0, docW: 4, docH: 3, x: 0, y: 0, w: 4, h: 3 });
    const bytes = encodeFrame(top, px(48));
    const r = decodeFrame(bytes);
    expect(r.ok && r.frame.type).toBe(6);
    expect(r.ok && [r.frame.w, r.frame.h]).toEqual([4, 3]);
    expect(Array.from(bytes.subarray(4, 6))).toEqual([6, 1]);
  });

  it('v4: fonts / tops / topReady / topError decode, listTops / importTop round trip', () => {
    expect(decodeTdMessage('{"t":"fonts","families":["Arial","Zapf",3]}')).toEqual({ t: 'fonts', families: ['Arial', 'Zapf'] });
    expect(decodeTdMessage('{"t":"fonts"}')).toBeNull();
    const tops = { t: 'tops', requestId: 'r1', items: [{ path: '/project1/noise1', w: 1280, h: 720 }, { path: '/b', w: 8, h: 8 }] };
    expect(decodeTdMessage(encodeMessage(tops as never))).toEqual(tops);
    expect(decodeTdMessage('{"t":"tops","requestId":"r1","items":[{"path":"/a"},{"path":"/b","w":2,"h":3},5]}')).toEqual({ t: 'tops', requestId: 'r1', items: [{ path: '/b', w: 2, h: 3 }] });
    expect(decodeTdMessage('{"t":"tops","items":[]}')).toBeNull();
    const ready = { t: 'topReady', requestId: 'r2', w: 640, h: 480 } as const;
    expect(decodeTdMessage(encodeMessage(ready))).toEqual(ready);
    expect(decodeTdMessage('{"t":"topReady","requestId":"r2","w":0,"h":4}')).toBeNull();
    expect(decodeTdMessage('{"t":"topError","requestId":"r3","msg":"too large"}')).toEqual({ t: 'topError', requestId: 'r3', msg: 'too large' });
    expect(decodeTdMessage('{"t":"topError"}')).toBeNull();
    for (const m of [{ t: 'listTops', requestId: 'a' }, { t: 'importTop', requestId: 'b', path: '/p1/x' }] as const) expect(decodeWebMessage(encodeMessage(m))).toEqual(m);
    expect(decodeWebMessage('{"t":"importTop","requestId":"b"}')).toBeNull();
    expect(decodeWebMessage('{"t":"listTops"}')).toBeNull();
    expect(decodeWebMessage('{"t":"setCanvas","w":0,"h":10,"mode":"fixed"}')).toBeNull();
    expect(decodeWebMessage('{"t":"setCanvas","w":0,"h":0,"mode":"input"}')).toEqual({ t: 'setCanvas', w: 0, h: 0, mode: 'input' });
    expect(decodeWebMessage('{"t":"renderLayer","requestId":"r"}')).toBeNull();
  });

  it('rejects malformed v3 web messages', () => {
    expect(decodeWebMessage('{"t":"doc","rev":1}')).toBeNull();
    expect(decodeWebMessage('{"t":"view","mode":"x","zoom":1,"panX":0,"panY":0,"rect":{"x":0,"y":0,"w":1,"h":1}}')).toBeNull();
    expect(decodeWebMessage('{"t":"view","mode":"td","zoom":1,"panX":0,"panY":0}')).toBeNull();
    expect(decodeWebMessage('{"t":"ready","protocol":4,"client":"external","version":"1"}')).toEqual({ t: 'ready', protocol: 4, client: 'external', version: '1', token: '', fresh: false });
  });

  it('td messages round trip and strip unknown fields', () => {
    const hello = { t: 'hello', protocol: 4, doc: { w: 1920, h: 1080 }, hasInput: true, maxSendFps: 30, active: false, clientId: 'c1', hasDocument: false, rev: null } as const;
    expect(decodeTdMessage(encodeMessage(hello))).toEqual(hello);
    expect(decodeTdMessage(JSON.stringify({ ...hello, extra: 1 }))).toEqual(hello);
    expect(decodeTdMessage('{"t":"docSize","w":4,"h":5,"hasInput":false}')).toEqual({ t: 'docSize', w: 4, h: 5, hasInput: false, mode: 'input' });
    expect(decodeTdMessage('{"t":"docSize","w":4,"h":5,"hasInput":false,"mode":"fixed"}')).toEqual({ t: 'docSize', w: 4, h: 5, hasInput: false, mode: 'fixed' });
    expect(decodeTdMessage('{"t":"hello","protocol":5,"doc":{"w":4,"h":4,"mode":"fixed"},"hasInput":true,"maxSendFps":30,"active":true}'))
      .toMatchObject({ doc: { w: 4, h: 4, mode: 'fixed' } });
    expect(decodeTdMessage('{"t":"active","active":true}')).toEqual({ t: 'active', active: true });
    expect(decodeTdMessage('{"t":"error","msg":"nope"}')).toEqual({ t: 'error', msg: 'nope' });
  });

  it('v6: hello may carry inputs (0x0 = unconnected); malformed lists are dropped; baseSize is gone', () => {
    const h = { t: 'hello', protocol: 11, doc: { w: 4, h: 4 }, hasInput: true, maxSendFps: 30, active: true };
    const items = [{ input: 1, w: 1280, h: 720, connected: true }, { input: 2, w: 0, h: 0, connected: false }];
    expect(decodeTdMessage(JSON.stringify({ ...h, inputs: items }))).toMatchObject({ inputs: items });
    expect(decodeTdMessage(JSON.stringify({ ...h, inputs: [] }))).toMatchObject({ inputs: [] });
    for (const bad of [[{ input: 0, w: 1, h: 1, connected: true }], [{ input: 9, w: 1, h: 1, connected: true }], [{ input: 1, w: -1, h: 1, connected: true }], [{ input: 1, w: 1, h: 1 }], 'x', [5]]) {
      expect('inputs' in decodeTdMessage(JSON.stringify({ ...h, inputs: bad }))!).toBe(false);
    }
    expect('inputs' in decodeTdMessage(JSON.stringify(h))!).toBe(false);
    expect('baseSize' in decodeTdMessage(JSON.stringify({ ...h, baseSize: { w: 5, h: 5 } }))!).toBe(false);
    expect(decodeTdMessage('{"t":"baseSize","w":1280,"h":720}')).toBeNull();
  });

  it('v6: inputs, fileResult, reload and files', () => {
    const inputs = { t: 'inputs', items: [{ input: 1, w: 640, h: 360, connected: true }, { input: 4, w: 0, h: 0, connected: false }] } as const;
    expect(decodeTdMessage(encodeMessage(inputs as never))).toEqual(inputs);
    expect(decodeTdMessage('{"t":"inputs","items":[]}')).toEqual({ t: 'inputs', items: [] });
    expect(decodeTdMessage('{"t":"inputs"}')).toBeNull();
    expect(decodeTdMessage('{"t":"inputs","items":[{"input":1,"w":1}]}')).toBeNull();
    const fr = { t: 'fileResult', requestId: 'f1', op: 'saveProject', ok: false, path: '/x.redoc', msg: 'disk full' } as const;
    expect(decodeTdMessage(encodeMessage(fr))).toEqual(fr);
    expect(decodeTdMessage('{"t":"fileResult","op":"exportPng","ok":true,"path":"/a.png"}')).toEqual({ t: 'fileResult', op: 'exportPng', ok: true, path: '/a.png' });
    expect(decodeTdMessage('{"t":"fileResult","op":"wipe","ok":true,"path":"/a"}')).toBeNull();
    expect(decodeTdMessage('{"t":"fileResult","op":"saveProject","ok":"yes","path":"/a"}')).toBeNull();
    expect(decodeTdMessage('{"t":"fileResult","op":"saveProject","ok":true}')).toBeNull();
    expect(decodeTdMessage('{"t":"reload","rev":12}')).toEqual({ t: 'reload', rev: 12 });
    expect(decodeTdMessage('{"t":"reload"}')).toBeNull();
    expect(decodeTdMessage('{"t":"files","projectFile":"/a.redoc","pngFile":"/a.png"}')).toEqual({ t: 'files', projectFile: '/a.redoc', pngFile: '/a.png' });
    expect(decodeTdMessage('{"t":"files","projectFile":"/a.redoc"}')).toBeNull();
    expect(decodeWebMessage('{"t":"saveProject"}')).toBeNull();
    expect(decodeWebMessage('{"t":"exportPng","requestId":3}')).toBeNull();
  });

  it('v6: chooseFile / fileChosen', () => {
    for (const purpose of ['saveProject', 'openProject', 'exportPng'] as const) {
      const m = { t: 'chooseFile', requestId: 'c1', purpose } as const;
      expect(decodeWebMessage(encodeMessage(m))).toEqual(m);
    }
    expect(decodeWebMessage('{"t":"chooseFile","requestId":"c1","purpose":"deleteAll"}')).toBeNull();
    expect(decodeWebMessage('{"t":"chooseFile","requestId":"c1","purpose":"readText"}')).toBeNull(); // panel-only purposes are gone
    expect(decodeWebMessage('{"t":"chooseFile","requestId":"c1","purpose":"placeImage"}')).toBeNull();
    expect(decodeWebMessage('{"t":"chooseFile","requestId":"c1"}')).toBeNull();
    expect(decodeWebMessage('{"t":"chooseFile","purpose":"placeImage"}')).toBeNull();
    expect(decodeTdMessage('{"t":"fileChosen","requestId":"c1","path":"/a/b.png"}')).toEqual({ t: 'fileChosen', requestId: 'c1', path: '/a/b.png' });
    expect(decodeTdMessage('{"t":"fileChosen","requestId":"c1","path":null}')).toEqual({ t: 'fileChosen', requestId: 'c1', path: null });
    expect(decodeTdMessage('{"t":"fileChosen","requestId":"c1"}')).toBeNull();
    expect(decodeTdMessage('{"t":"fileChosen","requestId":"c1","path":5}')).toBeNull();
    expect(decodeTdMessage('{"t":"fileChosen","path":null}')).toBeNull();
  });

  it('v6: layers are normalised (v5 base -> input 1, missing rot/kx/ky/effects defaulted)', () => {
    const v5 = { id: 'base', kind: 'base', parentId: null, name: 'Base', visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, slot: 1, mask: null, adjustment: null, text: null, shape: null, sx: 1, sy: 1, surfaceW: 8, surfaceH: 4 };
    const st = decodeTdMessage(JSON.stringify({ t: 'docState', rev: 1, layers: [v5, { ...v5, id: 'p', kind: 'pixel', slot: 2 }, { ...v5, id: 'i', kind: 'input', input: 3, rot: 15, kx: 2, ky: -2, effects: [{ enabled: true, type: 'invert' }] }], docW: 8, docH: 4 }));
    if (st?.t !== 'docState') throw new Error('docState expected');
    expect(st.layers[0]).toMatchObject({ kind: 'input', input: 1, rot: 0, kx: 0, ky: 0, effects: [] });
    expect(st.layers[1]).toMatchObject({ kind: 'pixel', input: null, rot: 0, effects: [] });
    expect(st.layers[2]).toMatchObject({ kind: 'input', input: 3, rot: 15, kx: 2, ky: -2, effects: [{ enabled: true, type: 'invert' }] });
    const doc = decodeWebMessage(JSON.stringify({ t: 'doc', rev: 2, layers: [v5] }));
    expect(doc?.t === 'doc' && doc.layers[0]).toMatchObject({ kind: 'input', input: 1 });
    // idempotent; a pixel layer with a stray input loses it; an input layer with a bad index falls back to 1
    expect(normalizeLayer(normalizeLayer(v5 as never))).toEqual(normalizeLayer(v5 as never));
    expect(normalizeLayer({ ...v5, kind: 'pixel', input: 5 } as never).input).toBeNull();
    expect(normalizeLayer({ ...v5, kind: 'input', input: 99 } as never).input).toBe(1);
  });

  it('ignores unknown types and malformed input', () => {
    for (const s of ['{"t":"future"}', 'not json', '[]', 'null', '{"x":1}', '"hello"']) {
      expect(decodeTdMessage(s)).toBeNull();
      expect(decodeWebMessage(s)).toBeNull();
    }
  });

  it('rejects non-integer or non-positive sizes in hello and docSize', () => {
    const hello = (w: number, h: number) => JSON.stringify({ t: 'hello', protocol: 4, doc: { w, h }, hasInput: true, maxSendFps: 30, active: true });
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
