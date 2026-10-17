import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_MS, createIdleDetector, type IdleEnv } from '../../src/state/idle';

// v10 idle detection with fake timers and a fake document / window.
class Target {
  l = new Map<string, Set<() => void>>();
  visibilityState: 'visible' | 'hidden' = 'visible';
  addEventListener(t: string, f: () => void) { (this.l.get(t) ?? this.l.set(t, new Set()).get(t)!).add(f); }
  removeEventListener(t: string, f: () => void) { this.l.get(t)?.delete(f); }
  fire(t: string) { for (const f of [...(this.l.get(t) ?? [])]) f(); }
  count() { let n = 0; for (const s of this.l.values()) n += s.size; return n; }
}
let doc: Target, win: Target, changes: boolean[];
const make = () => createIdleDetector((v) => changes.push(v), { doc: doc as unknown as IdleEnv['doc'], win: win as unknown as IdleEnv['win'] });
beforeEach(() => { vi.useFakeTimers(); doc = new Target(); win = new Target(); changes = []; });
afterEach(() => vi.useRealTimers());

describe('idle detector', () => {
  it('becomes idle after 10 s without input, and any input resumes', () => {
    const d = make();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(d.idle()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(d.idle()).toBe(true);
    expect(changes).toEqual([true]);
    win.fire('pointermove');
    expect(d.idle()).toBe(false);
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(IDLE_MS);
    expect(changes).toEqual([true, false, true]);
  });

  it('every input kind restarts the 10 s countdown', () => {
    make();
    for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      vi.advanceTimersByTime(IDLE_MS - 1000);
      win.fire(e);
    }
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(IDLE_MS);
    expect(changes).toEqual([true]);
  });

  it('a hidden tab is idle immediately; becoming visible resumes (and re-arms the timer)', () => {
    const d = make();
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(d.idle()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(changes).toEqual([true]); // no timer churn while hidden
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    expect(d.idle()).toBe(false);
    vi.advanceTimersByTime(IDLE_MS);
    expect(changes).toEqual([true, false, true]);
  });

  it('input in a hidden tab does not wake it; a page that loads hidden starts idle', () => {
    doc.visibilityState = 'hidden';
    const d = make();
    expect(changes).toEqual([true]);
    win.fire('pointermove');
    expect(d.idle()).toBe(true);
  });

  it('dispose removes the listeners and the timer', () => {
    const d = make();
    d.dispose();
    expect(win.count() + doc.count()).toBe(0);
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(changes).toEqual([]);
  });

  it('dragover counts as input', () => {
    make();
    vi.advanceTimersByTime(IDLE_MS - 1000);
    win.fire('dragover');
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true]);
  });

  it('pending TD work is activity: the timer re-arms instead of going idle, idle follows once it is done', () => {
    let busy = true;
    const d = createIdleDetector((v) => changes.push(v), { doc: doc as unknown as IdleEnv['doc'], win: win as unknown as IdleEnv['win'], busy: () => busy });
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(d.idle()).toBe(false);
    busy = false;
    vi.advanceTimersByTime(IDLE_MS);
    expect(changes).toEqual([true]);
  });

  it('input only stores a timestamp: a pointermove storm does not touch the timer', () => {
    const calls: number[] = [];
    const real = globalThis.setTimeout;
    const d = createIdleDetector((v) => changes.push(v), { doc: doc as unknown as IdleEnv['doc'], win: win as unknown as IdleEnv['win'], setTimeout: (fn, ms) => { calls.push(ms); return real(fn, ms); } });
    for (let i = 0; i < 500; i++) { vi.advanceTimersByTime(10); win.fire('pointermove'); }
    expect(calls.length).toBe(1);                       // 5 s of movement: still the single armed timer
    vi.advanceTimersByTime(IDLE_MS - 5000 - 1);
    expect(d.idle()).toBe(false);                      // ...and it re-armed for the rest when it expired (the last move was just now)
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(d.idle()).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('a visibilitychange to visible while the page is already active and the timer armed changes nothing and re-arms from now', () => {
    const d = make();
    vi.advanceTimersByTime(IDLE_MS - 1000);
    doc.fire('visibilitychange');                      // (still visible)
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(d.idle()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true]);
  });
});
