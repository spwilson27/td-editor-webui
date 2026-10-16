import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExactBuffer } from '../../src/bridge/exactBuffer';
import { TdViewClient } from '../../src/bridge/tdViewClient';
import { TdViewGl, type DrawParams } from '../../src/ui/tdViewGl';
import { SOLID_RGB } from '../helpers/jpegs';
import { exactFull, exactTiles, fastFrame, solid } from '../helpers/viewFrames';

// The compositor draws the document at the current view into its canvas; readCanvas() returns premultiplied RGBA with row 0 = top.
let gl: TdViewGl;
beforeAll(() => { gl = new TdViewGl(); });
afterAll(() => { gl.clear(); });

const params = (o: Partial<DrawParams> & { docW: number; docH: number }, vw = o.docW, vh = o.docH): DrawParams =>
  ({ vw, vh, cw: vw, ch: vh, view: { zoom: 1, x: 0, y: 0 }, ...o });
const CK = (x: number, y: number) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 207 : 255); // checkerboard at the document origin
const at = (px: Uint8Array, w: number, x: number, y: number) => Array.from(px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
const near = (a: number[], b: number[], tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** An ImageBitmap with exactly these RGBA bytes (no premultiplication, no colour conversion). */
const bitmap = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const d = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.data.set(f(x, y), (y * w + x) * 4);
  return createImageBitmap(d, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
};

describe('TdViewGl: WebGL2 is available', () => {
  it('creates a program', () => { expect(gl.available).toBe(true); });
});

describe('fast frames: premultiplied RGB + (1 - alpha) x checkerboard', () => {
  it('composites colour and alpha planes over the checkerboard at the right pixels', async () => {
    const W = 32, H = 24;
    // premultiplied colour: alpha 0 -> black, alpha 128 -> (100,50,0) (= straight (200,100,0) at 50 %), alpha 255 -> (10,200,30)
    const rgb = await bitmap(W, H, (x) => (x < 8 ? [0, 0, 0, 255] : x < 16 ? [100, 50, 0, 255] : [10, 200, 30, 255]));
    const alpha = await bitmap(W, H, (x) => { const a = x < 8 ? 0 : x < 16 ? 128 : 255; return [a, a, a, 255]; });
    gl.fast({ rgb, alpha, x: 0, y: 0, w: W, h: H });
    gl.show('fast');
    const r = gl.draw(params({ docW: W, docH: H }));
    expect(r.rect).toEqual({ x: 0, y: 0, w: W, h: H });
    const px = gl.readCanvas();
    for (const [x, y] of [[2, 2], [0, 0], [4, 18], [7, 23]]) {
      const ck = CK(x, y);
      expect(near(at(px, W, x, y), [ck, ck, ck, 255]), `transparent (${x},${y})`).toBe(true);
    }
    for (const [x, y] of [[9, 2], [11, 10], [14, 20]]) {
      const ck = CK(x, y), a = 128 / 255;
      expect(near(at(px, W, x, y), [100 + (1 - a) * ck, 50 + (1 - a) * ck, (1 - a) * ck, 255], 2), `half (${x},${y})`).toBe(true);
    }
    expect(near(at(px, W, 20, 5), [10, 200, 30, 255])).toBe(true);
    expect(near(at(px, W, 31, 23), [10, 200, 30, 255])).toBe(true);
  });

  it('without an alpha plane the frame is opaque', async () => {
    const rgb = await bitmap(8, 8, () => [255, 0, 0, 255]);
    gl.fast({ rgb, alpha: null, x: 0, y: 0, w: 16, h: 16 });
    gl.draw(params({ docW: 16, docH: 16 }));
    expect(near(at(gl.readCanvas(), 16, 3, 3), [255, 0, 0, 255])).toBe(true);
  });

  it('keeps its place in the document while the view pans and zooms between frames', async () => {
    // a 16x16 frame for the document rect (8,8)-(24,24) of a 32x24 document, shown at zoom 2 with the origin at (10,6)
    const rgb = await bitmap(16, 16, () => [0, 0, 255, 255]);
    gl.fast({ rgb, alpha: null, x: 8, y: 8, w: 16, h: 16 });
    gl.show('fast');
    const d = (x: number, y: number) => ({ vw: 100, vh: 80, cw: 100, ch: 80, docW: 32, docH: 24, view: { zoom: 2, x, y } });
    gl.draw(d(10, 6));
    let px = gl.readCanvas();
    expect(near(at(px, 100, 10 + 2 * 8 + 1, 6 + 2 * 8 + 1), [0, 0, 255, 255])).toBe(true); // inside the frame's rect
    expect(near(at(px, 100, 10 + 2 * 24 - 2, 6 + 2 * 24 - 2), [0, 0, 255, 255])).toBe(true);
    const out = at(px, 100, 10 + 2 * 4, 6 + 2 * 4); // inside the document, outside the frame: checkerboard only
    expect(out[2]).not.toBe(255 - 0 === out[2] && out[0] === 0 ? 255 : -1);
    expect(near(out, [CK(8, 8), CK(8, 8), CK(8, 8), 255])).toBe(true);
    expect(at(px, 100, 5, 5)).toEqual([0, 0, 0, 0]); // outside the document: transparent
    // pan by (+30, +14): the same document pixel moves with the view
    gl.draw(d(40, 20));
    px = gl.readCanvas();
    expect(near(at(px, 100, 40 + 2 * 8 + 1, 20 + 2 * 8 + 1), [0, 0, 255, 255])).toBe(true);
    expect(near(at(px, 100, 10 + 2 * 8 + 1, 6 + 2 * 8 + 1), [0, 0, 0, 0], 0) || at(px, 100, 27, 23)[3] === 0).toBe(true);
  });
});

describe('exact frames: straight alpha, bit-exact', () => {
  const noise = (w: number, h: number, seed = 1) => {
    const o = new Uint8Array(w * h * 4);
    let s = seed;
    for (let i = 0; i < o.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; o[i] = s >>> 24; }
    return o;
  };

  it('the uploaded texture reads back identical to the buffer, incl. semi-transparent pixels and colours under alpha 0', () => {
    const W = 70, H = 66;
    const buf = new ExactBuffer();
    const data = noise(W, H, 7);
    data[0] = 200; data[1] = 100; data[2] = 50; data[3] = 0;     // colour under alpha 0 must survive
    data[4] = 13; data[5] = 99; data[6] = 250; data[7] = 1;
    buf.applyFull(W, H, data);
    gl.exact(buf, [{ x: 0, y: 0, w: W, h: H }]);
    expect(Array.from(gl.readExact()!)).toEqual(Array.from(data));
  });

  it('tile patches update only their rect and the readback stays equal', async () => {
    const W = 130, H = 70;
    const buf = new ExactBuffer();
    buf.applyFull(W, H, noise(W, H, 3));
    gl.exact(buf, [{ x: 0, y: 0, w: W, h: H }]);
    const patch = noise(4, 1, 9).subarray(0, 16); // 4 px = 2 wide x 2 high
    const t = new Uint8Array(8 + patch.length);
    const dv = new DataView(t.buffer);
    dv.setUint16(0, 2, true); dv.setUint16(2, 1, true); dv.setUint16(4, 2, true); dv.setUint16(6, 2, true);
    t.set(patch, 8);
    const r = buf.applyTiles(W, H, 64, 1, t);
    if (!r.ok) throw new Error('tile');
    gl.exact(buf, r.dirty);
    expect(Array.from(gl.readExact()!)).toEqual(Array.from(buf.data));
    expect(at(gl.readExact()!, W, 129, 65)).toEqual(Array.from(patch.subarray(12, 16)));
  });

  it('displays opaque pixels exactly and blends semi-transparent ones with the checkerboard (zoom 1)', () => {
    const W = 48, H = 40;
    const buf = new ExactBuffer();
    const data = noise(W, H, 5);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    // a semi-transparent row
    for (let x = 0; x < W; x++) { const o = (10 * W + x) * 4; data[o] = 255; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 64; }
    buf.applyFull(W, H, data);
    gl.exact(buf, [{ x: 0, y: 0, w: W, h: H }]);
    gl.show('exact');
    gl.draw(params({ docW: W, docH: H }));
    const px = gl.readCanvas();
    for (let y = 0; y < H; y++) {
      if (y === 10) continue;
      for (let x = 0; x < W; x++) expect(at(px, W, x, y), `(${x},${y})`).toEqual(at(data, W, x, y));
    }
    const a = 64 / 255;
    for (const x of [1, 9, 20, 40]) {
      const ck = CK(x, 10);
      expect(near(at(px, W, x, 10), [255 * a + (1 - a) * ck, (1 - a) * ck, (1 - a) * ck, 255], 1), `blend x=${x}`).toBe(true);
    }
  });

  it('zoomed in the pixels stay crisp (nearest); zoomed out it filters (mip) without crashing', () => {
    const W = 4, H = 4;
    const buf = new ExactBuffer();
    const d = new Uint8Array(W * H * 4);
    for (let i = 0; i < 16; i++) d.set([i * 16, 0, 255 - i * 16, 255], i * 4);
    buf.applyFull(W, H, d);
    gl.exact(buf, [{ x: 0, y: 0, w: W, h: H }]);
    gl.show('exact');
    gl.draw({ vw: 40, vh: 40, cw: 40, ch: 40, docW: W, docH: H, view: { zoom: 10, x: 0, y: 0 } });
    const px = gl.readCanvas();
    expect(at(px, 40, 5, 5)).toEqual([0, 0, 255, 255]);
    expect(at(px, 40, 15, 5)).toEqual([16, 0, 239, 255]);
    expect(at(px, 40, 35, 35)).toEqual([240, 0, 15, 255]);
    gl.draw({ vw: 40, vh: 40, cw: 40, ch: 40, docW: W, docH: H, view: { zoom: 0.5, x: 2, y: 2 } });
    expect(at(gl.readCanvas(), 40, 3, 3)[3]).toBe(255);
  });

  it('a device-pixel-ratio-2 backing store is used 1:1 (canvas twice the CSS size)', () => {
    const W = 16, H = 16;
    const buf = new ExactBuffer();
    buf.applyFull(W, H, solid(W, H, 9, 8, 7));
    gl.exact(buf, [{ x: 0, y: 0, w: W, h: H }]);
    gl.show('exact');
    const r = gl.draw({ vw: 20, vh: 20, cw: 40, ch: 40, docW: W, docH: H, view: { zoom: 1, x: 2, y: 2 } });
    expect(r.rect).toEqual({ x: 4, y: 4, w: 32, h: 32 });
    expect(at(gl.readCanvas(), 40, 20, 20)).toEqual([9, 8, 7, 255]);
    expect(at(gl.readCanvas(), 40, 2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('end to end through the client (real JPEG decode, real deflate)', () => {
  it('fast frame, then an exact frame with applied >= takes over; badge kinds follow', async () => {
    const kinds: (string | null)[] = [];
    const client = new TdViewClient({ send: () => {}, sink: gl, onShown: (k) => kinds.push(k) });
    gl.clear();
    client.handleBinary(fastFrame({ frameId: 1, appliedFrameId: 4, x: 0, y: 0, w: 16, h: 16 }, 'green'));
    await new Promise((r) => setTimeout(r, 100));
    expect(client.on).toBe('fast');
    gl.draw(params({ docW: 16, docH: 16 }));
    expect(near(at(gl.readCanvas(), 16, 8, 8), [0, 255, 0, 255], 6)).toBe(true); // JPEG tolerance
    client.handleBinary(await exactFull(16, 16, solid(16, 16, 1, 2, 3), 2, 4));
    await new Promise((r) => setTimeout(r, 100));
    expect(client.on).toBe('exact');
    gl.draw(params({ docW: 16, docH: 16 }));
    expect(at(gl.readCanvas(), 16, 8, 8)).toEqual([1, 2, 3, 255]);
    client.handleBinary(await exactTiles(16, 16, [{ tx: 0, ty: 0, w: 16, h: 16, rgba: solid(16, 16, 50, 60, 70) }], 3, 5));
    await new Promise((r) => setTimeout(r, 100));
    gl.draw(params({ docW: 16, docH: 16 }));
    expect(at(gl.readCanvas(), 16, 8, 8)).toEqual([50, 60, 70, 255]);
    expect(kinds).toEqual(['fast', 'exact', 'exact']);
    void SOLID_RGB;
  });
});

describe('review fixes', () => {
  const ext = () => gl.gl!.getExtension('WEBGL_lose_context')!;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('context loss: nothing is drawn or claimed while lost; on restore the exact buffer is re-uploaded and the owner is told', async () => {
    const buf = new ExactBuffer();
    buf.applyFull(16, 16, solid(16, 16, 9, 8, 7));
    gl.clear();
    expect(gl.exact(buf, [{ x: 0, y: 0, w: 16, h: 16 }])).toBe(true);
    gl.show('exact');
    expect(gl.kind).toBe('exact');
    const events: boolean[] = [];
    gl.onLostChange = (l) => events.push(l);
    const lose = ext(); // the extension object stays usable after the loss
    lose.loseContext();
    await wait(50);
    expect(gl.isLost).toBe(true);
    expect(gl.available).toBe(false);
    expect(gl.hasContent).toBe(false);
    expect(gl.kind).toBeNull();
    expect(gl.draw(params({ docW: 16, docH: 16 })).rect).toBeNull(); // guarded, no throw
    const bmp = await bitmap(4, 4, () => [1, 2, 3, 255]);
    expect(gl.fast({ rgb: bmp, alpha: null, x: 0, y: 0, w: 16, h: 16 })).toBe(false);
    expect(gl.exact(buf, [{ x: 0, y: 0, w: 16, h: 16 }])).toBe(true); // remembered for the restore
    lose.restoreContext();
    await wait(100);
    expect(gl.isLost).toBe(false);
    expect(events).toEqual([true, false]);
    expect(gl.kind).toBe('exact'); // the exact picture came back without a new frame
    gl.draw(params({ docW: 16, docH: 16 }));
    expect(at(gl.readCanvas(), 16, 8, 8)).toEqual([9, 8, 7, 255]);
    gl.onLostChange = null;
  });

  it('exact() reports failure for a document larger than the GPU textures; fast frames still work', async () => {
    const big = new ExactBuffer();
    big.w = gl.maxExactDim() + 1; big.h = 1;
    expect(gl.exact(big, [])).toBe(false);
    const bmp = await bitmap(8, 8, () => [0, 255, 0, 255]);
    expect(gl.fast({ rgb: bmp, alpha: null, x: 0, y: 0, w: 8, h: 8 })).toBe(true);
    gl.show('fast');
    expect(gl.kind).toBe('fast');
  });

  it('outside the fast frame\'s rect the exact buffer is drawn when it is valid (not the checkerboard)', async () => {
    const W = 32, H = 16;
    const buf = new ExactBuffer();
    buf.applyFull(W, H, solid(W, H, 10, 20, 30));
    gl.clear();
    gl.exact(buf, [{ x: 0, y: 0, w: W, h: H }]);
    gl.fast({ rgb: await bitmap(4, 4, () => [200, 0, 0, 255]), alpha: null, x: 16, y: 0, w: 16, h: 16 });
    gl.show('fast');
    gl.draw(params({ docW: W, docH: H }));
    const px = gl.readCanvas();
    expect(at(px, W, 4, 4)).toEqual([10, 20, 30, 255]);
    expect(near(at(px, W, 24, 8), [200, 0, 0, 255])).toBe(true);
    gl.clear();
    gl.fast({ rgb: await bitmap(4, 4, () => [200, 0, 0, 255]), alpha: null, x: 16, y: 0, w: 16, h: 16 });
    gl.show('fast');
    gl.draw(params({ docW: W, docH: H }));
    expect(near(at(gl.readCanvas(), W, 4, 4), [CK(4, 4), CK(4, 4), CK(4, 4), 255])).toBe(true); // no exact buffer: checkerboard
  });

  it('a smaller fast frame after a larger one reuses the texture (sub-upload) and still maps correctly', async () => {
    gl.clear();
    gl.fast({ rgb: await bitmap(64, 64, () => [255, 0, 0, 255]), alpha: null, x: 0, y: 0, w: 32, h: 32 });
    gl.show('fast');
    gl.fast({ rgb: await bitmap(8, 8, (x) => (x < 4 ? [0, 0, 255, 255] : [0, 255, 0, 255])), alpha: null, x: 0, y: 0, w: 32, h: 32 });
    gl.draw(params({ docW: 32, docH: 32 }));
    const px = gl.readCanvas();
    expect(near(at(px, 32, 2, 16), [0, 0, 255, 255], 3)).toBe(true);
    expect(near(at(px, 32, 29, 16), [0, 255, 0, 255], 3)).toBe(true);
    expect(near(at(px, 32, 31, 31), [0, 255, 0, 255], 3)).toBe(true); // no stale red column from the bigger allocation
  });

  it('zoomed out, semi-transparent pixels filter premultiplied: no dark / coloured halo around a transparent area', () => {
    const W = 64, H = 64;
    const buf = new ExactBuffer();
    const d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(x < 32 ? [255, 255, 255, 255] : [255, 0, 0, 0], (y * W + x) * 4); // right half: red under alpha 0
    buf.applyFull(W, H, d);
    gl.clear();
    gl.exact(buf, [{ x: 0, y: 0, w: W, h: H }]);
    gl.show('exact');
    gl.draw({ vw: 16, vh: 16, cw: 16, ch: 16, docW: W, docH: H, view: { zoom: 0.25, x: 0, y: 0 } });
    const px = gl.readCanvas();
    for (let y = 2; y < 14; y++) {
      const edge = at(px, 16, 8, y); // straddles the white / transparent boundary
      const ck = CK(8 * 4, y * 4); // checkerboard is in screen px: cell size 8 px
      void ck;
      expect(edge[0] - edge[1], `y=${y} tinted red: ${edge}`).toBeLessThanOrEqual(2); // straight filtering would leak red from the hidden colour
    }
  });

  it('clear() releases the exact texture memory', () => {
    const buf = new ExactBuffer();
    buf.applyFull(64, 64, solid(64, 64, 1, 2, 3));
    gl.exact(buf, [{ x: 0, y: 0, w: 64, h: 64 }]);
    expect(gl.readExact()).not.toBeNull();
    gl.clear();
    expect(gl.readExact()).toBeNull();
    expect(gl.hasContent).toBe(false);
  });
});

// ---- performance: decode + composite at 720p ----

describe('performance (720p, main thread)', () => {
  const W = 1280, H = 720;

  async function jpeg(draw: (c: CanvasRenderingContext2D) => void, gray = false): Promise<Uint8Array> {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    draw(g);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', gray ? 0.9 : 0.75));
    return new Uint8Array(await blob.arrayBuffer());
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];

  it('fast frame: createImageBitmap x2 (off the main thread) + upload + composite submit <= 8 ms of main-thread work', async () => {
    const rgb = await jpeg((g) => { const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#f40'); gr.addColorStop(1, '#04f'); g.fillStyle = gr; g.fillRect(0, 0, W, H); for (let i = 0; i < 200; i++) { g.fillStyle = `hsl(${i * 7},70%,50%)`; g.fillRect((i * 37) % W, (i * 91) % H, 60, 40); } });
    const alpha = await jpeg((g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#888'; g.beginPath(); g.arc(W / 2, H / 2, 200, 0, 7); g.fill(); }, true);
    const decode = (b: Uint8Array) => createImageBitmap(new Blob([b as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const sync: number[] = [], wall: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const [a, b] = await Promise.all([decode(rgb), decode(alpha)]);
      const t1 = performance.now();
      gl.fast({ rgb: a, alpha: b, x: 0, y: 0, w: W, h: H });
      const tu = performance.now();
      gl.show('fast');
      gl.draw({ vw: W, vh: H, cw: W, ch: H, docW: W, docH: H, view: { zoom: 1, x: 0, y: 0 } });
      const t2 = performance.now();
      if (i === 20) console.log(`PERF breakdown upload ${(tu - t1).toFixed(2)} show+draw ${(t2 - tu).toFixed(2)}`);
      gl.gl!.finish(); // wait for the GPU so wall time is honest (not counted as main-thread work)
      const t3 = performance.now();
      if (i >= 5) { sync.push(t2 - t1); wall.push(t3 - t0); }
    }
    console.log(`PERF renderer: ${(() => { const g = gl.gl!, e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()}`);
    console.log(`PERF fast 720p: main-thread upload+composite median ${median(sync).toFixed(2)} ms p95 ${p95(sync).toFixed(2)} ms; decode+composite wall incl. GPU median ${median(wall).toFixed(2)} ms p95 ${p95(wall).toFixed(2)} ms`);
    expect(median(sync)).toBeLessThanOrEqual(8);
  });

  it('exact: full 1080p upload and a tile patch; inflate time of a full frame', async () => {
    const w = 1920, h = 1080;
    const buf = new ExactBuffer();
    const img = new Uint8Array(w * h * 4);
    for (let i = 0; i < img.length; i++) img[i] = (i * 31 + (i >> 8)) & 255;
    const body = await exactFull(w, h, img, 1, 1);
    let t = performance.now();
    const c = new TdViewClient({ send: () => {}, sink: { fast() {}, exact: () => {}, show() {}, clear() {} } });
    c.handleBinary(body);
    while (!c.exactBuf.valid) await new Promise((r) => setTimeout(r, 2));
    const inflateMs = performance.now() - t;
    buf.applyFull(w, h, img);
    const full: number[] = [], tile: number[] = [];
    for (let i = 0; i < 10; i++) {
      t = performance.now();
      gl.exact(buf, [{ x: 0, y: 0, w, h }]);
      full.push(performance.now() - t);
      t = performance.now();
      gl.exact(buf, [{ x: 64, y: 64, w: 64, h: 64 }, { x: 128, y: 64, w: 64, h: 64 }]);
      tile.push(performance.now() - t);
    }
    console.log(`PERF exact 1080p: inflate+apply (zlib body ${(body.length / 1e6).toFixed(1)} MB) ${inflateMs.toFixed(1)} ms; full upload median ${median(full).toFixed(2)} ms; 2-tile upload median ${median(tile).toFixed(2)} ms`);
    expect(median(tile)).toBeLessThanOrEqual(4);
  });
});
