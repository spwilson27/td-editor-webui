import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, type FrameHeader } from '../../src/bridge/codec';

const dir = new URL('../../../docs/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('fixtures.json', dir), 'utf8')) as {
  messages: { name: string; file: string; valid: boolean; size: number; error?: string; header?: FrameHeader & { flags: number }; payloadSha256?: string }[];
};
const load = (f: string) => new Uint8Array(readFileSync(new URL(f, dir)));

describe('shared fixtures (docs/fixtures)', () => {
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
          type: h.type, frameEnd: h.frameEnd, frameId: h.frameId, docW: h.docW, docH: h.docH, x: h.x, y: h.y, w: h.w, h: h.h, payload: undefined,
        });
        expect(h.flags).toBe(h.frameEnd ? 1 : 0);
        expect(createHash('sha256').update(r.frame.payload).digest('hex')).toBe(m.payloadSha256);
        expect(Array.from(encodeFrame(r.frame, r.frame.payload))).toEqual(Array.from(bytes));
      });
    } else {
      it(`${m.name}: is rejected (${m.error})`, () => {
        const r = decodeFrame(load(m.file));
        expect(r.ok).toBe(false);
      });
    }
  }
});
