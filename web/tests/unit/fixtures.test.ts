import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, isStale, type FrameHeader } from '../../src/bridge/codec';

const dir = new URL('../../../docs/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('fixtures.json', dir), 'utf8')) as {
  messages: { name: string; file: string; valid: boolean; size: number; error?: string; header?: FrameHeader & { flags: number }; payloadSha256?: string; currentDoc?: { w: number; h: number }; knownSlots?: number[] }[];
};
const load = (f: string) => new Uint8Array(readFileSync(new URL(f, dir)));

describe('shared fixtures (docs/fixtures)', () => {
  it('includes the stale-docsize and zero-size-rect fixtures', () => {
    expect(manifest.messages.find((m) => m.name === 'stale_docsize')?.currentDoc).toBeTruthy();
    expect(manifest.messages.find((m) => m.name === 'invalid_zero_size_rect')?.valid).toBe(false);
  });

  it('covers every v3 frame type and rejects the v1/v2 COMPOSITE type', () => {
    const types = new Set(manifest.messages.filter((m) => m.valid).map((m) => m.header!.type));
    expect([...types].sort()).toEqual([1, 3, 4, 5]);
    expect(manifest.messages.find((m) => m.name === 'invalid_type_2')?.valid).toBe(false);
    expect(manifest.messages.some((m) => m.valid && m.header!.slot > 0)).toBe(true);
  });

  it('manifest is non-empty and covers valid and invalid messages', () => {
    expect(manifest.messages.some((m) => m.valid)).toBe(true);
    expect(manifest.messages.some((m) => !m.valid)).toBe(true);
  });

  for (const m of manifest.messages) {
    if (m.valid) {
      it(`${m.name}: decodes to the documented fields and re-encodes to identical bytes`, () => {
        const bytes = load(m.file);
        expect(bytes.length).toBe(m.size);
        const r = decodeFrame(bytes);
        if (!r.ok) throw new Error(r.error);
        const h = m.header as FrameHeader & { flags: number };
        expect({ ...r.frame, payload: undefined }).toEqual({
          type: h.type, frameEnd: h.frameEnd, slot: h.slot, frameId: h.frameId, docW: h.docW, docH: h.docH, x: h.x, y: h.y, w: h.w, h: h.h, payload: undefined,
        });
        expect(h.flags).toBe(h.frameEnd ? 1 : 0);
        expect(createHash('sha256').update(r.frame.payload).digest('hex')).toBe(m.payloadSha256);
        expect(Array.from(encodeFrame(r.frame, r.frame.payload))).toEqual(Array.from(bytes));
        if (m.currentDoc) expect(isStale(r.frame, m.currentDoc.w, m.currentDoc.h)).toBe(m.currentDoc.w !== h.docW || m.currentDoc.h !== h.docH);
        else expect(isStale(r.frame, h.docW, h.docH)).toBe(false);
      });
    } else {
      it(`${m.name}: is rejected (${m.error})`, () => {
        const r = decodeFrame(load(m.file));
        expect(r.ok).toBe(false);
      });
    }
  }
});
