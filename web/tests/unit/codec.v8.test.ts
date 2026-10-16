import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type WebMessage, decodeTdMessage, normalizeLayer, decodeWebMessage, encodeMessage } from '../../src/bridge/codec';

describe('protocol v8 messages', () => {
  it('is protocol 11 (hello / ready)', () => {
    expect(PROTOCOL_VERSION).toBe(11);
    expect(decodeWebMessage(encodeMessage({ t: 'ready', protocol: 11, client: 'external', version: '1', token: 't', fresh: true }))).toMatchObject({ t: 'ready', protocol: 11 });
    expect(decodeTdMessage('{"t":"hello","protocol":11,"doc":{"w":4,"h":4},"hasInput":true,"maxSendFps":30,"active":true,"clientId":"c","hasDocument":false,"rev":null}')).toMatchObject({ t: 'hello', protocol: 11 });
  });

  it('renderLayer carries mode flatten | mergeDown; without a mode (v7 shape) it still decodes', () => {
    for (const mode of ['flatten', 'mergeDown'] as const) {
      const m: WebMessage = { t: 'renderLayer', requestId: 'r1', layerId: 'L3', mode };
      expect(decodeWebMessage(encodeMessage(m))).toEqual(m);
    }
    expect(decodeWebMessage('{"t":"renderLayer","requestId":"r","layerId":"L"}')).toEqual({ t: 'renderLayer', requestId: 'r', layerId: 'L' });
    expect(decodeWebMessage('{"t":"renderLayer","requestId":"r","layerId":"L","mode":"nope"}')).toBeNull();
  });

  it('renderLayers {requestId, layerIds} round-trips; empty / non-string ids are rejected', () => {
    const m: WebMessage = { t: 'renderLayers', requestId: 'm4', layerIds: ['L2', 'L5', 'g1'] };
    expect(decodeWebMessage(encodeMessage(m))).toEqual(m);
    expect(decodeWebMessage('{"t":"renderLayers","requestId":"m","layerIds":[]}')).toBeNull();
    expect(decodeWebMessage('{"t":"renderLayers","requestId":"m","layerIds":["a",3]}')).toBeNull();
    expect(decodeWebMessage('{"t":"renderLayers","layerIds":["a"]}')).toBeNull();
    expect(decodeWebMessage('{"t":"renderLayers","requestId":"m"}')).toBeNull();
  });
});

describe('protocol v9 layer masks', () => {
  it('a group / input LayerSpec with a mask survives normalizeLayer (v9 allows it)', () => {
    for (const kind of ['group', 'input'] as const) {
      const l = normalizeLayer({ id: 'x', kind, parentId: null, name: 'x', visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, input: kind === 'input' ? 1 : null, effects: [], slot: null, mask: { slot: 7, enabled: false }, adjustment: null, text: null, shape: null, surfaceW: null, surfaceH: null } as never);
      expect(l.mask).toEqual({ slot: 7, enabled: false });
    }
  });
});
