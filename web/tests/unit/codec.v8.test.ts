import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type WebMessage, decodeTdMessage, decodeWebMessage, encodeMessage } from '../../src/bridge/codec';

describe('protocol v8 messages', () => {
  it('is protocol 8 (hello / ready)', () => {
    expect(PROTOCOL_VERSION).toBe(8);
    expect(decodeWebMessage(encodeMessage({ t: 'ready', protocol: 8, client: 'panel', version: '1', token: 't', fresh: true }))).toMatchObject({ t: 'ready', protocol: 8 });
    expect(decodeTdMessage('{"t":"hello","protocol":8,"doc":{"w":4,"h":4},"hasInput":true,"maxSendFps":30,"active":true,"clientId":"c","hasDocument":false,"rev":null}')).toMatchObject({ t: 'hello', protocol: 8 });
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
