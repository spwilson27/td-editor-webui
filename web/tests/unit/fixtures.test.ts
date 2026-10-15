import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, isStale, type FrameHeader } from '../../src/bridge/codec';
import { slotSizesOf } from '../../src/bridge/tdBridge';

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

  it('covers every frame type (TOP_IMAGE = 6, v7 LAYER_PREVIEW = 7) and rejects the v1/v2 COMPOSITE type', () => {
    const types = new Set(manifest.messages.filter((m) => m.valid).map((m) => m.header!.type));
    expect([...types].sort()).toEqual(expect.arrayContaining([1, 3, 4, 5]));
    for (const t of types) expect([1, 3, 4, 5, 6, 7]).toContain(t);
    expect(types.has(7)).toBe(true);
    for (const m of manifest.messages.filter((x) => x.valid && x.header!.type === 6)) {
      expect({ x: m.header!.x, y: m.header!.y, slot: m.header!.slot, end: m.header!.frameEnd }).toEqual({ x: 0, y: 0, slot: 0, end: true });
    }
    for (const m of manifest.messages.filter((x) => x.valid && x.header!.type === 7)) {
      expect({ x: m.header!.x, y: m.header!.y, slot: m.header!.slot, end: m.header!.frameEnd }).toEqual({ x: 0, y: 0, slot: 0, end: true });
    }
    expect(manifest.messages.find((m) => m.name === 'invalid_layer_preview_slot')?.valid).toBe(false);
    expect(manifest.messages.find((m) => m.name === 'invalid_type_2')?.valid).toBe(false);
    expect(manifest.messages.some((m) => m.valid && m.header!.slot > 0)).toBe(true);
  });

  it('v5: SURFACE / SURFACE_DUMP docW/docH are the slot\'s surface size (stale check per slot), BASE docW/docH the input size', () => {
    for (const m of manifest.messages.filter((x) => x.valid && (x.header!.type === 3 || x.header!.type === 4))) {
      const h = m.header!;
      const layers = [{ id: 'p', kind: 'pixel', slot: h.slot, mask: null, surfaceW: h.docW, surfaceH: h.docH }] as never;
      const sz = slotSizesOf(layers, 9999, 9999).get(h.slot)!;
      expect(isStale(h, sz.w, sz.h)).toBe(false);
      expect(isStale(h, h.docW + 1, h.docH)).toBe(true);
      expect(h.x + h.w).toBeLessThanOrEqual(h.docW); // rects lie inside the surface
      expect(h.y + h.h).toBeLessThanOrEqual(h.docH);
    }
    for (const m of manifest.messages.filter((x) => x.valid && x.header!.type === 1)) {
      expect(m.header!.x + m.header!.w).toBeLessThanOrEqual(m.header!.docW);
    }
  });

  it('slotSizesOf: a mask has its layer\'s surface size; layers without a surface fall back to the document size', () => {
    const sizes = slotSizesOf([
      { id: 'a', kind: 'pixel', slot: 1, mask: { slot: 2, enabled: true }, surfaceW: 20, surfaceH: 10 },
      { id: 'b', kind: 'adjustment', slot: null, mask: { slot: 3, enabled: true }, surfaceW: null, surfaceH: null },
    ] as never, 64, 48);
    expect(sizes.get(1)).toEqual({ w: 20, h: 10 });
    expect(sizes.get(2)).toEqual({ w: 20, h: 10 });
    expect(sizes.get(3)).toEqual({ w: 64, h: 48 });
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
