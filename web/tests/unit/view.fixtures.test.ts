import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeViewFrame, type ViewExactFrame, type ViewFastFrame } from '../../src/bridge/codec';
import { ExactBuffer } from '../../src/bridge/exactBuffer';

// Golden files written by the TD side (scripts/make_fixtures.py); described in docs/fixtures/view_v11.json.
const dir = new URL('../../../docs/fixtures/', import.meta.url);
const load = (f: string) => new Uint8Array(readFileSync(new URL(f, dir)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(readFileSync(new URL('view_v11.json', dir), 'utf8')) as { messages: Record<string, any>[] };
const entry = (name: string) => manifest.messages.find((m) => m.name === name)!;

const fast = (name: string): ViewFastFrame => { const r = decodeViewFrame(load(`${name}.bin`)); if (!r.ok || r.frame.kind !== 'fast') throw new Error(name); return r.frame; };
const exact = (name: string): ViewExactFrame => { const r = decodeViewFrame(load(`${name}.bin`)); if (!r.ok || r.frame.kind !== 'exact') throw new Error(name); return r.frame; };

describe('view fixtures (protocol 11)', () => {
  it('view_fast: header fields, rect and both JPEGs byte-for-byte', () => {
    const m = entry('view_fast'), f = fast('view_fast');
    expect(f).toMatchObject({ frameId: m.frameHeader.frameId, appliedFrameId: m.applied, pw: m.pw, ph: m.ph });
    expect([f.x, f.y, f.w, f.h]).toEqual(m.rect);
    expect(f.rgb.length).toBe(m.rgbLen);
    expect(f.alpha!.length).toBe(m.alphaLen);
    expect(sha(f.rgb)).toBe(m.rgbSha256);
    expect(sha(f.alpha!)).toBe(m.alphaSha256);
    expect(Array.from(f.rgb.subarray(0, 2))).toEqual([0xff, 0xd8]);
  });
  it('view_fast_opaque: no alpha plane, applied 0xFFFFFFFF = none', () => {
    const m = entry('view_fast_opaque'), f = fast('view_fast_opaque');
    expect(f.alpha).toBeNull();
    expect(f.appliedFrameId).toBe(0xffffffff);
    expect(f.frameId).toBe(m.frameHeader.frameId);
    expect(sha(f.rgb)).toBe(m.rgbSha256);
  });
  it('view_exact_full inflates to the documented pixels', () => {
    const m = entry('view_exact_full'), f = exact('view_exact_full');
    expect(f).toMatchObject({ frameId: m.frameHeader.frameId, appliedFrameId: m.applied, docW: 70, docH: 66, full: true, tile: 64 });
    const raw = new Uint8Array(inflateSync(f.body));
    expect(raw.length).toBe(m.inflatedSize);
    expect(sha(raw)).toBe(m.pixelsSha256);
    const b = new ExactBuffer();
    expect(b.applyFull(f.docW, f.docH, raw).ok).toBe(true);
    expect(sha(b.data)).toBe(m.pixelsSha256);
  });
  it('view_exact_tiles patches the buffer left by view_exact_full to the documented result', () => {
    const m = entry('view_exact_tiles'), full = exact('view_exact_full'), f = exact('view_exact_tiles');
    expect(f).toMatchObject({ frameId: m.frameHeader.frameId, appliedFrameId: m.applied, full: false, nTiles: 2, docW: 70, docH: 66 });
    const b = new ExactBuffer();
    b.applyFull(70, 66, new Uint8Array(inflateSync(full.body)));
    const raw = new Uint8Array(inflateSync(f.body));
    expect(raw.length).toBe(m.inflatedSize);
    const r = b.applyTiles(f.docW, f.docH, f.tile, f.nTiles, raw);
    expect(r).toEqual({ ok: true, dirty: [{ x: 64, y: 0, w: 6, h: 64 }, { x: 0, y: 64, w: 64, h: 2 }] });
    expect(sha(b.data)).toBe(m.pixelsAfterSha256);
  });
  it('the invalid_view_* files are rejected', () => {
    for (const n of ['invalid_view_fast_short', 'invalid_view_fast_rect', 'invalid_view_exact_kind', 'invalid_view_exact_tile']) {
      expect(decodeViewFrame(load(`${n}.bin`)), n).toMatchObject({ ok: false });
    }
  });
});
