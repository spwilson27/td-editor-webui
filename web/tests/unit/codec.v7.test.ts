import { describe, expect, it } from 'vitest';
import {
  FRAME_LAYER_PREVIEW, HEADER_BYTES, PROTOCOL_VERSION, decodeFrame, decodeTdMessage, decodeWebMessage, encodeBands, encodeFrame, encodeMessage, readBrushPresets, type FrameHeader,
} from '../../src/bridge/codec';
import type { BrushPreset, LayerSpec } from '../../src/engine/types';

const preset = (id: string): BrushPreset => ({
  id, name: `Brush ${id}`, tip: 'chalk',
  settings: { size: 40, opacity: 0.8, flow: 0.5, hardness: 0.6, spacing: 0.15 },
  dynamics: { scatter: 1, scatterCount: 3, sizeJitter: 0.2, angleJitter: 90, hueJitter: 0.1, satJitter: 0, valJitter: 0, angle: 10, roundness: 0.8, seed: 7 },
});
const layer = (id: string): LayerSpec => ({
  id, kind: 'pixel', parentId: null, name: id, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, slot: 1, mask: null, adjustment: null, text: null, shape: null,
  sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input: null, effects: [], surfaceW: 4, surfaceH: 4,
});

describe('protocol v7 frames', () => {
  const h = (o: Partial<FrameHeader> = {}): FrameHeader => ({ type: FRAME_LAYER_PREVIEW, frameEnd: true, slot: 0, frameId: 41, docW: 5, docH: 4, x: 0, y: 0, w: 5, h: 4, ...o });

  it('is protocol 7 and LAYER_PREVIEW is frame type 7', () => {
    expect(PROTOCOL_VERSION).toBe(7);
    expect(FRAME_LAYER_PREVIEW).toBe(7);
  });

  it('encodes and decodes a LAYER_PREVIEW frame (type byte 7, slot 0, doc sized)', () => {
    const pixels = Uint8Array.from({ length: 5 * 4 * 4 }, (_, i) => (i * 3) & 255);
    const msg = encodeFrame(h(), pixels);
    expect(msg[4]).toBe(7);
    expect(msg.length).toBe(HEADER_BYTES + pixels.length);
    const r = decodeFrame(msg);
    expect(r.ok && { ...r.frame, payload: undefined }).toEqual({ ...h(), payload: undefined });
    expect(r.ok && Array.from(r.frame.payload)).toEqual(Array.from(pixels));
  });

  it('rejects a LAYER_PREVIEW frame with a non-zero slot (encode and decode)', () => {
    expect(() => encodeFrame(h({ slot: 2 }), new Uint8Array(80))).toThrow(RangeError);
    const raw = encodeFrame(h(), new Uint8Array(80));
    raw[6] = 1;
    expect(decodeFrame(raw)).toEqual({ ok: false, error: 'bad-slot' });
  });

  it('keeps type 8 invalid and still validates rect and length of type 7', () => {
    const raw = encodeFrame(h(), new Uint8Array(80));
    const t8 = raw.slice(); t8[4] = 8;
    expect(decodeFrame(t8)).toEqual({ ok: false, error: 'bad-type' });
    expect(decodeFrame(raw.subarray(0, raw.length - 1))).toEqual({ ok: false, error: 'bad-length' });
    const wide = raw.slice(); wide[20] = 9;
    expect(decodeFrame(wide)).toEqual({ ok: false, error: 'bad-rect' });
  });

  it('splits like any frame (one band when it fits) and the last band has FRAME_END', () => {
    const bands = [...encodeBands({ type: FRAME_LAYER_PREVIEW, frameId: 3, docW: 5, docH: 4, rect: { x: 0, y: 0, w: 5, h: 4 }, pixels: new Uint8Array(80), maxPayload: 1 << 20 })];
    expect(bands.length).toBe(1);
    const r = decodeFrame(bands[0]);
    expect(r.ok && r.frame.frameEnd).toBe(true);
  });
});

describe('protocol v7 messages', () => {
  it('decodes the layerPreview notice (extra fields ignored) and rejects malformed ones', () => {
    expect(decodeTdMessage('{"t":"layerPreview","layerId":"L3","frameId":12,"docW":64,"docH":48}')).toEqual({ t: 'layerPreview', layerId: 'L3', frameId: 12 });
    expect(decodeTdMessage('{"t":"layerPreview","layerId":3,"frameId":12}')).toBeNull();
    expect(decodeTdMessage('{"t":"layerPreview","layerId":"L3"}')).toBeNull();
    expect(decodeTdMessage('{"t":"layerPreview","layerId":"L3","frameId":"x"}')).toBeNull();
  });

  it('encodes and decodes activeLayer (web to TD)', () => {
    expect(encodeMessage({ t: 'activeLayer', id: 'L7' })).toBe('{"t":"activeLayer","id":"L7"}');
    expect(decodeWebMessage('{"t":"activeLayer","id":"L7"}')).toEqual({ t: 'activeLayer', id: 'L7' });
    expect(decodeWebMessage('{"t":"activeLayer","id":5}')).toBeNull();
    expect(decodeWebMessage('{"t":"activeLayer"}')).toBeNull();
  });

  it('carries DocSpec.brushPresets in doc and docState', () => {
    const presets = [preset('a'), preset('b')];
    const doc = decodeWebMessage(JSON.stringify({ t: 'doc', rev: 3, layers: [layer('p')], guides: { h: [], v: [] }, canvas: { mode: 'input' }, brushPresets: presets }));
    expect(doc && doc.t === 'doc' && doc.brushPresets).toEqual(presets);
    const st = decodeTdMessage(JSON.stringify({ t: 'docState', rev: 3, layers: [layer('p')], docW: 4, docH: 4, guides: { h: [], v: [] }, canvas: { mode: 'input' }, brushPresets: presets }));
    expect(st && st.t === 'docState' && st.brushPresets).toEqual(presets);
  });

  it('a doc without brushPresets (v6 peer) has none; an empty list is kept (it clears TD\'s presets)', () => {
    const base = { t: 'doc', rev: 1, layers: [layer('p')], guides: { h: [], v: [] }, canvas: { mode: 'input' } };
    const none = decodeWebMessage(JSON.stringify(base));
    expect(none && none.t === 'doc' && 'brushPresets' in none).toBe(false);
    const empty = decodeWebMessage(JSON.stringify({ ...base, brushPresets: [] }));
    expect(empty && empty.t === 'doc' && empty.brushPresets).toEqual([]);
  });

  it('drops malformed presets and keeps the good ones', () => {
    const good = preset('ok');
    expect(readBrushPresets([good, null, 5, { id: 'x' }, { id: 'y', name: 'n', settings: {}, dynamics: {} }, { ...good, id: 7 }, 'str'])).toEqual([good]);
    expect(readBrushPresets('nope')).toEqual([]);
    expect(readBrushPresets(undefined)).toEqual([]);
  });

  it('round trips the encoded form of every v7 message', () => {
    const msgs = [{ t: 'activeLayer', id: 'abc' }, { t: 'layerPreview', layerId: 'abc', frameId: 9 }] as const;
    for (const m of msgs) expect(JSON.parse(encodeMessage(m as never))).toEqual(m);
  });
});
