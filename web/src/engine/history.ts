import type { HistoryEntry } from './types';
import type { Ser } from './historyBlob';

export interface HistoryItem {
  label: string;
  bytes: number; // memory held by this entry, counted against the cap
  undo(): void;
  redo(): void;
  /** Consecutive pushes with the same key within `coalesceMs` merge into one entry (slider drags). */
  coalesceKey?: string;
  /** Marks entries a later step may discard again (quick mask strokes), see discardTrailing. */
  tag?: string;
  /** v6: the step as data, for persistence (serializeHistory); entries without it end the persisted window. */
  ser?: Ser;
}

interface Stored extends HistoryItem {
  id: number;
  time: number;
}

export type GroupEnd = 'dropped' | 'kept' | 'none';

export interface HistoryOptions {
  maxSteps?: number;
  maxBytes?: number;
  coalesceMs?: number;
  now?: () => number;
}

export class History {
  private items: Stored[] = [];
  private cur = -1;
  private nextId = 1;
  /** Bumped by every change of the stacks (push, undo, redo, jump, clear, load, discard): cheap change detection for persistence. */
  version = 0;
  private total = 0;
  private readonly maxSteps: number;
  private readonly maxBytes: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  /** v7.2: an open gesture (a scrub drag): every push until `endGroup` merges into one entry, whatever its key or timing. */
  private group: { entry: Stored | null; sig: string } | null = null;

  constructor(o: HistoryOptions = {}) {
    this.maxSteps = o.maxSteps ?? 100;
    this.maxBytes = o.maxBytes ?? 256 * 1024 * 1024;
    this.coalesceMs = o.coalesceMs ?? 1000;
    this.now = o.now ?? Date.now;
  }

  get index(): number {
    return this.cur;
  }

  get bytes(): number {
    return this.total;
  }

  entries(): HistoryEntry[] {
    return this.items.map((e) => ({ id: e.id, label: e.label }));
  }

  /** The item is already applied; this only records how to undo/redo it. */
  push(item: HistoryItem): void {
    this.version++;
    this.dropRedoTail();
    const t = this.now();
    const top = this.items[this.cur];
    const g = this.group;
    const sig = `${item.ser?.k ?? ''}|${item.coalesceKey ?? ''}|${item.label}`;
    // a push that is foreign to the open gesture's entry (another kind / key / label: a stroke, a delete, a remote edit) is its own
    // undoable entry and ends that entry's merging; later pushes of the gesture start a fresh entry
    const foreign = !!g && !!g.entry && top === g.entry && sig !== g.sig;
    if (foreign && g && g.entry) { g.entry.coalesceKey = undefined; g.entry.time = Number.NEGATIVE_INFINITY; g.entry = null; }
    const merge = g ? !foreign && !!g.entry && top === g.entry : !!item.coalesceKey && !!top && top.coalesceKey === item.coalesceKey && t - top.time < this.coalesceMs;
    if (merge && top) {
      this.total += item.bytes - top.bytes;
      top.redo = item.redo;
      // the merged step goes from the first `before` to the latest `after`
      if (top.ser && item.ser && top.ser.k === 'struct' && item.ser.k === 'struct') top.ser = { k: 'struct', before: top.ser.before, after: item.ser.after };
      else if (top.ser && item.ser && top.ser.k === 'guides' && item.ser.k === 'guides') top.ser = { k: 'guides', before: top.ser.before, after: item.ser.after };
      else top.ser = undefined;
      top.bytes = item.bytes;
      top.label = item.label;
      top.time = t;
      return;
    }
    const stored: Stored = { ...item, id: this.nextId++, time: t };
    this.items.push(stored);
    if (g && !foreign) { g.entry = stored; g.sig = sig; }
    this.total += item.bytes;
    this.cur = this.items.length - 1;
    while (this.items.length > 1 && (this.items.length > this.maxSteps || this.total > this.maxBytes)) {
      this.total -= this.items[0].bytes;
      this.items.shift();
      this.cur--;
    }
  }

  /** v7.2: a gesture (scrub drag) is open. */
  get groupOpen(): boolean { return this.group !== null; }

  /** Start a gesture: the pushes until `endGroup` become ONE undo step (the first never merges into an older entry). */
  beginGroup(): void {
    this.group = { entry: null, sig: '' };
  }

  /**
   * End the gesture. The entry stays closed to later coalescing. With `cancel` the gesture's entry is undone and dropped (no redo
   * step). Returns 'dropped' (cancelled and removed: the state is back at the gesture's start), 'kept' (it has an entry that stays: not
   * cancelled, or no longer the top step because of an external undo / foreign edit) or 'none' (nothing was pushed).
   */
  endGroup(cancel = false): GroupEnd {
    const g = this.group;
    this.group = null;
    const e = g?.entry;
    if (!e) return 'none';
    e.coalesceKey = undefined;
    e.time = Number.NEGATIVE_INFINITY;
    if (!cancel || this.items[this.cur] !== e) return 'kept';
    this.version++;
    e.undo();
    this.items.splice(this.cur, 1);
    this.total -= e.bytes;
    this.cur--;
    return 'dropped';
  }

  undo(): boolean {
    if (this.cur < 0) return false;
    this.version++;
    this.items[this.cur].undo();
    this.cur--;
    return true;
  }

  redo(): boolean {
    if (this.cur >= this.items.length - 1) return false;
    this.version++;
    this.cur++;
    this.items[this.cur].redo();
    return true;
  }

  /** Move so that `index` is the last applied entry (-1 = nothing applied). */
  jumpTo(index: number): void {
    const target = Math.max(-1, Math.min(this.items.length - 1, Math.trunc(index)));
    while (this.cur > target) this.undo();
    while (this.cur < target) this.redo();
  }

  /** Remove every entry carrying `tag`, wherever it is (the redo tail and the other entries are kept; returns how many went). */
  discardTagged(tag: string): number {
    this.version++;
    let removed = 0;
    let cur = this.cur;
    this.items = this.items.filter((it, i) => {
      if (it.tag !== tag) return true;
      this.total -= it.bytes;
      removed++;
      if (i <= this.cur) cur--;
      return false;
    });
    this.cur = cur;
    return removed;
  }

  /** The stored steps, oldest first (`cur` = index of the last applied one). */
  stored(): ReadonlyArray<{ label: string; bytes: number; tag?: string; ser?: Ser }> {
    return this.items;
  }

  /** Replace everything with restored steps (none of them can be coalesced into); `cur` = last applied index. */
  load(items: HistoryItem[], cur: number): void {
    this.version++;
    this.items = items.map((it) => ({ ...it, id: this.nextId++, time: Number.NEGATIVE_INFINITY }));
    this.cur = Math.max(-1, Math.min(this.items.length - 1, cur));
    this.total = this.items.reduce((n, it) => n + it.bytes, 0);
  }

  clear(): void {
    this.version++;
    this.items = [];
    this.cur = -1;
    this.total = 0;
  }

  private dropRedoTail(): void {
    for (let i = this.cur + 1; i < this.items.length; i++) this.total -= this.items[i].bytes;
    this.items.length = this.cur + 1;
  }
}
