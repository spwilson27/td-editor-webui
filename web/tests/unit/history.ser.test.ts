import { describe, expect, it } from 'vitest';
import { History } from '../../src/engine/history';
import { HISTORY_VERSION, hashString, peekBlob, readBlob, type Ser } from '../../src/engine/historyBlob';
import type { StructureSnapshot } from '../../src/engine/model';

const snap = (n: number) => ({ stamp: n, active: null, root: null }) as unknown as StructureSnapshot;
const struct = (a: number, b: number): Ser => ({ k: 'struct', before: snap(a), after: snap(b) });

describe('History persistence data', () => {
  it('keeps the first before and the latest after when steps coalesce', () => {
    const h = new History({ now: () => 1000 });
    h.push({ label: 'a', bytes: 10, undo() {}, redo() {}, coalesceKey: 'k', ser: struct(1, 2) });
    h.push({ label: 'a', bytes: 12, undo() {}, redo() {}, coalesceKey: 'k', ser: struct(2, 3) });
    expect(h.stored()).toHaveLength(1);
    const s = h.stored()[0].ser as Extract<Ser, { k: 'struct' }>;
    expect((s.before as { stamp: number }).stamp).toBe(1);
    expect((s.after as { stamp: number }).stamp).toBe(3);
    expect(h.bytes).toBe(12);
  });

  it('a coalesced step of mixed kinds is not persisted', () => {
    const h = new History({ now: () => 1 });
    h.push({ label: 'a', bytes: 1, undo() {}, redo() {}, coalesceKey: 'k', ser: struct(1, 2) });
    h.push({ label: 'a', bytes: 1, undo() {}, redo() {}, coalesceKey: 'k' });
    expect(h.stored()[0].ser).toBeUndefined();
  });

  it('load replaces the stacks and never coalesces into restored steps', () => {
    const h = new History({ now: () => 5 });
    const log: string[] = [];
    h.load([1, 2, 3].map((i) => ({ label: `s${i}`, bytes: 100, undo: () => log.push(`u${i}`), redo: () => log.push(`r${i}`), coalesceKey: 'k' })), 1);
    expect(h.index).toBe(1);
    expect(h.bytes).toBe(300);
    expect(h.entries().map((e) => e.label)).toEqual(['s1', 's2', 's3']);
    h.undo();
    h.redo();
    h.redo();
    expect(log).toEqual(['u2', 'r2', 'r3']);
    h.push({ label: 'n', bytes: 1, undo() {}, redo() {}, coalesceKey: 'k' });
    expect(h.entries()).toHaveLength(4);
  });
});

describe('history blob framing', () => {
  it('hashString is stable and sensitive', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('rejects anything that is not a blob of this version without touching the document', () => {
    const doc = null as never; // parsing fails before the document is used
    const good = new Uint8Array(16);
    good.set([0x52, 0x44, 0x48, 0x42], 0);
    new DataView(good.buffer).setUint32(4, HISTORY_VERSION, true);
    const bad: Uint8Array[] = [new Uint8Array(0), new Uint8Array(15), new Uint8Array(64), good, (() => { const b = good.slice(); b[4] = 2; return b; })()];
    for (const b of bad) {
      expect(peekBlob(b)).toBeNull();
      expect(() => readBlob(b, doc, 1, "x", {})).toThrow();
    }
  });
});
