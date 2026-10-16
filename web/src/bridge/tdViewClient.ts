// v11 TD view client: VIEW_FAST (two JPEGs) and VIEW_EXACT (deflate RGBA, full / tiles) frames -> a ViewSink (the WebGL compositor).
// Pure of sockets and DOM except createImageBitmap / DecompressionStream, which are injectable.
import type { ViewExactFrame, ViewFastFrame, WebMessage } from './codec';
import { NO_FRAME, decodeViewFrame, frameGeq } from './codec';
import { ExactBuffer, type DirtyRect } from './exactBuffer';

export type ShownKind = 'fast' | 'exact';

export interface FastImage {
  rgb: ImageBitmap;
  alpha: ImageBitmap | null;
  /** document rect the image covers */
  x: number; y: number; w: number; h: number;
}

/** Where decoded frames go. The sink takes the bitmaps' ownership (it closes them, also when it cannot draw). */
export interface ViewSink {
  /** false = not drawn (context lost / WebGL unavailable) */
  fast(img: FastImage): boolean | void;
  /** `dirty` = changed rects of `buf.data` (document px) to upload. false = the exact picture cannot be shown (document larger than the GPU's textures, context lost). */
  exact(buf: ExactBuffer, dirty: DirtyRect[]): boolean | void;
  show(kind: ShownKind | null): void;
  clear(): void;
  /** Largest exact document edge the GPU can hold. */
  maxExactDim?(): number;
}

export interface TdViewClientDeps {
  send(m: WebMessage): void;
  sink: ViewSink;
  /** GET /view?exact=1&frameId=: the frame bytes, null when TD has no such frame any more / the fetch failed. */
  fetchExact?(frameId: number): Promise<ArrayBuffer | null>;
  decodeJpeg?(bytes: Uint8Array): Promise<ImageBitmap>;
  now?(): number;
  /** A frame reached the screen (first time for its applied id): for the stroke -> view latency. */
  onDisplayed?(kind: ShownKind, appliedFrameId: number): void;
  /** What is on screen changed; `ageMs` = arrival -> composited. */
  onShown?(kind: ShownKind | null, ageMs: number): void;
  onError?(msg: string): void;
  /** A message for the user (once per cause). */
  onNotice?(msg: string): void;
  decodeTimeoutMs?: number;
}

/** Refuse exact documents above this many pixels (8192 x 8192 = 256 MB of RGBA). */
export const MAX_EXACT_PIXELS = 8192 * 8192;
export const RESET_REARM_MS = 2000, RESET_REARM_REFUSED_MS = 500, DECODE_TIMEOUT_MS = 2000;
const TILE_BYTES = 8 + 64 * 64 * 4;

const defaultDecode = (bytes: Uint8Array): Promise<ImageBitmap> =>
  createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });

/** zlib inflate with an output cap (a hostile stream cannot allocate more than `maxOut`). */
export class Inflater {
  scratch = new Uint8Array(1 << 20);

  private async run(body: Uint8Array, maxOut: number, sink: (chunk: Uint8Array, at: number) => void): Promise<number> {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const written = writer.write(body as Uint8Array<ArrayBuffer>).then(() => writer.close());
    written.catch(() => { /* the reader sees the error */ });
    const reader = ds.readable.getReader();
    let n = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (n + value.length > maxOut) { void reader.cancel().catch(() => {}); void writer.abort().catch(() => {}); throw new Error('inflated data exceeds the expected size'); }
      sink(value, n);
      n += value.length;
    }
    await written;
    return n;
  }

  /** Into the reusable scratch buffer (grown up to `maxOut`). */
  async inflate(body: Uint8Array, maxOut: number): Promise<Uint8Array> {
    const n = await this.run(body, maxOut, (chunk, at) => {
      if (at + chunk.length > this.scratch.length) {
        const bigger = new Uint8Array(Math.min(maxOut, Math.max(this.scratch.length * 2, at + chunk.length)));
        bigger.set(this.scratch.subarray(0, at));
        this.scratch = bigger;
      }
      this.scratch.set(chunk, at);
    });
    return this.scratch.subarray(0, n);
  }

  /** Straight into `target` (no copy); returns the bytes written, throws when the stream is longer than `target`. */
  inflateInto(body: Uint8Array, target: Uint8Array): Promise<number> {
    return this.run(body, target.length, (chunk, at) => target.set(chunk, at));
  }
}

export class TdViewClient {
  readonly exactBuf = new ExactBuffer();
  private readonly inflater = new Inflater();
  private readonly decode: (b: Uint8Array) => Promise<ImageBitmap>;
  private readonly now: () => number;
  private epoch = 0;
  private disposed = false;
  private active = true;
  // fast: one decode at a time, the newest waiting frame replaces an older waiting one
  private decoding = false;
  private waiting: { f: ViewFastFrame; at: number; seq: number } | null = null;
  // arrival order = TD's send order: what was sent last wins, whatever finishes decoding first
  private seq = 0;
  private shownSeq = 0;
  // exact: strictly ordered
  private exactChain: Promise<void> = Promise.resolve();
  private resetSent = false;
  private resetAt = -Infinity;
  private noticed = new Set<string>();
  private shown: ShownKind | null = null;
  private fastApplied = NO_FRAME; // applied id of the newest fast frame composited
  private exactApplied = NO_FRAME;
  private haveFast = false;
  private haveExact = false;
  private lastDisplayed = -1;
  /** diagnostics for tests */
  readonly stats = { fastIn: 0, fastShown: 0, fastDropped: 0, fastStale: 0, exactIn: 0, exactShown: 0, resets: 0, errors: 0, refused: 0 };

  constructor(private readonly deps: TdViewClientDeps) {
    this.decode = deps.decodeJpeg ?? defaultDecode;
    this.now = deps.now ?? (() => performance.now());
  }

  get on(): ShownKind | null { return this.shown; }

  /** The page shows the TD view. While it does not (Local), frames are acknowledged and dropped without decoding or uploading. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (!on) this.reset();
  }

  /** A binary WebSocket message. Returns false when it was not a view frame. */
  handleBinary(data: ArrayBuffer | ArrayBufferView): boolean {
    if (this.disposed) return false;
    const r = decodeViewFrame(data);
    if (!r.ok) return this.onBad(data);
    if (!this.active) { this.deps.send({ t: 'viewAck', frameId: r.frame.frameId }); return true; }
    if (r.frame.kind === 'fast') this.onFast(r.frame);
    else this.enqueueExact(Promise.resolve(r.frame), r.frame.frameId, ++this.seq);
    return true;
  }

  /** An unparsable frame still holds a slot in TD's window: ack what can be read; a damaged / unknown exact frame also desyncs the exact buffer. */
  private onBad(data: ArrayBuffer | ArrayBufferView): boolean {
    const b = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (b.length < 24 || b[0] !== 0x52 || b[1] !== 0x45 || b[2] !== 0x46 || b[3] !== 0x31) return false;
    const type = b[4];
    if (type >= 1 && type <= 7) return false; // other frame kinds are not ours
    const id = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(8, true);
    this.deps.onError?.(`unparsable view frame (type ${type})`);
    if (type !== 8 && this.active) this.requestReset(false);
    this.deps.send({ t: 'viewAck', frameId: id });
    return true;
  }

  /** `viewExact {frameId,size}`: a frame too large for the socket, fetched over HTTP (kept in order with the socket frames). */
  handleExactNotice(frameId: number): void {
    if (this.disposed || !this.deps.fetchExact) return;
    if (!this.active) { this.deps.send({ t: 'viewAck', frameId }); return; }
    const p = this.deps.fetchExact(frameId).then((buf) => {
      if (!buf) return null;
      const r = decodeViewFrame(buf);
      return r.ok && r.frame.kind === 'exact' ? r.frame : null;
    }, () => null);
    this.enqueueExact(p, frameId, ++this.seq, true);
  }

  /** Tab / editor switch, reconnect, leaving TD mode: forget what is on screen and in flight, and the exact buffer (TD's tile diffs would no longer match it). */
  reset(): void {
    this.epoch++;
    if (this.waiting) { this.deps.send({ t: 'viewAck', frameId: this.waiting.f.frameId }); this.waiting = null; }
    this.shown = null;
    this.haveFast = this.haveExact = false;
    this.fastApplied = this.exactApplied = NO_FRAME;
    this.resetSent = false;
    this.shownSeq = this.seq;
    this.exactBuf.invalidate();
    this.deps.sink.clear();
    this.deps.onShown?.(null, 0);
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.waiting = null;
    this.exactBuf.invalidate();
  }

  private notice(key: string, msg: string): void {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.deps.onNotice?.(msg);
  }

  // ---- fast ----

  private onFast(f: ViewFastFrame): void {
    this.stats.fastIn++;
    const at = this.now(), seq = ++this.seq;
    if (this.decoding) {
      if (this.waiting) { this.stats.fastDropped++; this.deps.send({ t: 'viewAck', frameId: this.waiting.f.frameId }); } // newest wins; the replaced frame is acked so TD's window moves on
      this.waiting = { f, at, seq };
      return;
    }
    void this.runFast({ f, at, seq });
  }

  /** createImageBitmap with a timeout (a decode that never settles must not block the stream); a late result is released. */
  private decodeWithTimeout(bytes: Uint8Array): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; reject(new Error('JPEG decode timed out')); }, this.deps.decodeTimeoutMs ?? DECODE_TIMEOUT_MS);
      this.decode(bytes).then((b) => { clearTimeout(timer); if (timedOut) b.close(); else resolve(b); }, (e) => { clearTimeout(timer); if (!timedOut) reject(e); });
    });
  }

  private async runFast(first: { f: ViewFastFrame; at: number; seq: number }): Promise<void> {
    this.decoding = true;
    let cur: { f: ViewFastFrame; at: number; seq: number } | null = first;
    while (cur) {
      const { f, at, seq } = cur, epoch = this.epoch;
      let rgb: ImageBitmap | null = null, alpha: ImageBitmap | null = null;
      try {
        const [a, b] = await Promise.allSettled([this.decodeWithTimeout(f.rgb), f.alpha ? this.decodeWithTimeout(f.alpha) : Promise.resolve(null)]);
        if (a.status === 'fulfilled') rgb = a.value;
        if (b.status === 'fulfilled') alpha = b.value;
        if (a.status === 'rejected' || b.status === 'rejected') throw (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason);
        if (this.disposed || epoch !== this.epoch || !this.active) { rgb!.close(); alpha?.close(); rgb = alpha = null; }
        else if (seq < this.shownSeq || (this.shown === 'exact' && this.haveExact && !frameGeq(f.appliedFrameId, this.exactApplied))) {
          this.stats.fastStale++; // an exact frame sent after it is already on screen, or it is older than the exact frame on screen
          rgb!.close(); alpha?.close(); rgb = alpha = null;
        } else {
          const ok = this.deps.sink.fast({ rgb: rgb!, alpha, x: f.x, y: f.y, w: f.w, h: f.h }) !== false;
          rgb = alpha = null; // owned by the sink
          if (ok) {
            this.haveFast = true;
            this.fastApplied = f.appliedFrameId;
            this.stats.fastShown++;
            this.display('fast', f.appliedFrameId, at, seq);
          }
        }
      } catch (e) {
        rgb?.close(); alpha?.close();
        this.stats.errors++;
        this.deps.onError?.(`view frame decode failed: ${(e as Error).message}`);
      }
      this.deps.send({ t: 'viewAck', frameId: f.frameId });
      cur = this.waiting;
      this.waiting = null;
    }
    this.decoding = false;
  }

  // ---- exact ----

  /** Exact frames are applied strictly in order and acknowledged like fast frames (TD's window of un-acked frames is shared). `fetched`: a null frame is a failed HTTP fetch, which desyncs the buffer. */
  private enqueueExact(frame: Promise<ViewExactFrame | null>, ackId: number, seq: number, fetched = false): void {
    const epoch = this.epoch;
    this.exactChain = this.exactChain.then(async () => {
      try {
        const f = await frame;
        if (this.disposed || epoch !== this.epoch) return;
        if (!f) { if (fetched) this.requestReset(false); return; }
        await this.applyExact(f, epoch, seq);
      } catch (e) {
        this.stats.errors++;
        this.deps.onError?.(`view exact frame failed: ${(e as Error).message}`);
        if (!this.disposed && epoch === this.epoch) this.requestReset(false);
      } finally {
        if (!this.disposed) this.deps.send({ t: 'viewAck', frameId: ackId });
      }
    });
  }

  /** Invalidate the buffer and ask TD for a full frame. Re-armed after 2 s (a lost answer must not wedge the stream), sooner when TD still sends tiles (`refused`). */
  private requestReset(refused: boolean): void {
    this.exactBuf.invalidate();
    const t = this.now();
    if (this.resetSent && t - this.resetAt < (refused ? RESET_REARM_REFUSED_MS : RESET_REARM_MS)) return;
    this.resetSent = true;
    this.resetAt = t;
    this.stats.resets++;
    this.deps.send({ t: 'viewExactReset' });
  }

  private async applyExact(f: ViewExactFrame, epoch: number, seq: number): Promise<void> {
    this.stats.exactIn++;
    const at = this.now();
    if (f.full) this.resetSent = false; // any full frame answers a reset request (if it fails, the failure asks again)
    const maxDim = this.deps.sink.maxExactDim?.() ?? 16384;
    if (f.docW > maxDim || f.docH > maxDim || f.docW * f.docH > MAX_EXACT_PIXELS) {
      this.stats.refused++;
      this.notice('big', `The document (${f.docW} x ${f.docH}) is too large for exact frames in this browser; showing the low-latency preview`);
      this.exactBuf.invalidate();
      return;
    }
    const grid = Math.ceil(f.docW / f.tile) * Math.ceil(f.docH / f.tile);
    if (!f.full) {
      if (!(this.exactBuf.valid && this.exactBuf.w === f.docW && this.exactBuf.h === f.docH)) { this.requestReset(true); return; }
      if (f.nTiles > grid) { this.requestReset(false); return; }
    }
    let dirty: DirtyRect[];
    if (f.full) {
      const target = this.exactBuf.beginFull(f.docW, f.docH);
      const n = await this.inflater.inflateInto(f.body, target);
      if (this.disposed || epoch !== this.epoch) { this.exactBuf.invalidate(); return; }
      if (n !== target.length) { this.requestReset(false); return; }
      this.exactBuf.commitFull();
      dirty = [{ x: 0, y: 0, w: f.docW, h: f.docH }];
    } else {
      const raw = await this.inflater.inflate(f.body, f.nTiles * TILE_BYTES);
      if (this.disposed || epoch !== this.epoch) return;
      const res = this.exactBuf.applyTiles(f.docW, f.docH, f.tile, f.nTiles, raw);
      if (!res.ok) { this.requestReset(false); return; }
      dirty = res.dirty;
    }
    this.exactApplied = f.appliedFrameId;
    this.stats.exactShown++;
    const ok = this.deps.sink.exact(this.exactBuf, dirty) !== false;
    this.haveExact = ok;
    if (!ok) {
      this.notice('exact', 'This browser cannot show exact frames for this document; showing the low-latency preview');
      return;
    }
    // exact replaces what is on screen when it was sent after it and is at least as new as the fast frame shown
    if (seq > this.shownSeq && (this.shown !== 'fast' || !this.haveFast || frameGeq(f.appliedFrameId, this.fastApplied))) this.display('exact', f.appliedFrameId, at, seq);
  }

  private display(kind: ShownKind, applied: number, at: number, seq: number): void {
    this.shown = kind;
    this.shownSeq = seq;
    this.deps.sink.show(kind);
    if (applied !== NO_FRAME && applied !== this.lastDisplayed) { this.lastDisplayed = applied; this.deps.onDisplayed?.(kind, applied); }
    this.deps.onShown?.(kind, Math.max(0, this.now() - at));
  }
}
