import { describe, expect, it } from 'vitest';
import { History } from '../../src/engine/history';

function setup(opts = {}) {
  const h = new History(opts);
  let v = 0;
  const log: string[] = [];
  const edit = (label: string, to: number, bytes = 10, coalesceKey?: string) => {
    const from = v;
    v = to;
    h.push({ label, bytes, coalesceKey, undo: () => { v = from; log.push(`u${label}`); }, redo: () => { v = to; log.push(`r${label}`); } });
  };
  return { h, edit, get v() { return v; }, log };
}

describe('History', () => {
  it('starts empty and undo/redo are no-ops', () => {
    const { h } = setup();
    expect(h.index).toBe(-1);
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
    expect(h.entries()).toEqual([]);
  });

  it('undo / redo walk the stack', () => {
    const s = setup();
    s.edit('a', 1);
    s.edit('b', 2);
    expect(s.h.index).toBe(1);
    s.h.undo();
    expect([s.v, s.h.index]).toEqual([1, 0]);
    s.h.undo();
    expect([s.v, s.h.index]).toEqual([0, -1]);
    s.h.redo();
    s.h.redo();
    expect([s.v, s.h.index]).toEqual([2, 1]);
    expect(s.h.redo()).toBe(false);
  });

  it('pushing after undo discards the redo tail', () => {
    const s = setup();
    s.edit('a', 1);
    s.edit('b', 2);
    s.h.undo();
    s.edit('c', 5);
    expect(s.h.entries().map((e) => e.label)).toEqual(['a', 'c']);
    expect(s.h.bytes).toBe(20);
    expect(s.h.redo()).toBe(false);
  });

  it('entries get unique increasing ids', () => {
    const s = setup();
    s.edit('a', 1);
    s.edit('b', 2);
    const ids = s.h.entries().map((e) => e.id);
    expect(ids[1]).toBeGreaterThan(ids[0]);
  });

  it('jumpTo moves in both directions and clamps', () => {
    const s = setup();
    for (let i = 1; i <= 5; i++) s.edit(`e${i}`, i);
    s.h.jumpTo(1);
    expect([s.v, s.h.index]).toEqual([2, 1]);
    s.h.jumpTo(4);
    expect([s.v, s.h.index]).toEqual([5, 4]);
    s.h.jumpTo(-1);
    expect([s.v, s.h.index]).toEqual([0, -1]);
    s.h.jumpTo(99);
    expect(s.h.index).toBe(4);
    s.h.jumpTo(-50);
    expect(s.h.index).toBe(-1);
  });

  it('caps at 100 steps dropping the oldest', () => {
    const s = setup();
    for (let i = 1; i <= 130; i++) s.edit(`e${i}`, i);
    expect(s.h.entries()).toHaveLength(100);
    expect(s.h.entries()[0].label).toBe('e31');
    expect(s.h.index).toBe(99);
    s.h.jumpTo(-1);
    expect(s.v).toBe(30); // can no longer reach the start
  });

  it('caps by bytes, always keeping the newest entry', () => {
    const s = setup({ maxBytes: 100 });
    s.edit('a', 1, 40);
    s.edit('b', 2, 40);
    s.edit('c', 3, 40);
    expect(s.h.entries().map((e) => e.label)).toEqual(['b', 'c']);
    expect(s.h.bytes).toBe(80);
    s.edit('huge', 4, 500);
    expect(s.h.entries().map((e) => e.label)).toEqual(['huge']);
    expect(s.h.index).toBe(0);
  });

  it('default byte cap is 256 MB', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.edit(`e${i}`, i, 100 * 1024 * 1024);
    expect(s.h.entries()).toHaveLength(2);
  });

  it('coalesces same-key pushes inside the window only', () => {
    let t = 0;
    const s = setup({ now: () => t });
    s.edit('op', 1, 10, 'k');
    t = 500;
    s.edit('op', 2, 10, 'k');
    expect(s.h.entries()).toHaveLength(1);
    s.h.undo();
    expect(s.v).toBe(0); // undo goes back to before the first change
    s.h.redo();
    expect(s.v).toBe(2);
    t = 5000;
    s.edit('op', 3, 10, 'k');
    expect(s.h.entries()).toHaveLength(2);
    s.edit('op', 4, 10, 'other');
    expect(s.h.entries()).toHaveLength(3);
  });

  it('does not coalesce into an entry that was undone', () => {
    let t = 0;
    const s = setup({ now: () => t });
    s.edit('op', 1, 10, 'k');
    s.h.undo();
    s.edit('op', 2, 10, 'k');
    expect(s.h.entries()).toHaveLength(1);
    s.h.undo();
    expect(s.v).toBe(0);
  });

  it('clear resets everything', () => {
    const s = setup();
    s.edit('a', 1);
    s.h.clear();
    expect([s.h.index, s.h.bytes, s.h.entries().length]).toEqual([-1, 0, 0]);
  });
});
