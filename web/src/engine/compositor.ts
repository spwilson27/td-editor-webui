import type { BlendMode, Effect, Rect } from './types';
import { createSurface, releaseSurface, type Ctx2D, type Surface } from './surface';
import { floatingBounds, grow, isVector, layerExtent, specBounds, surfaceDocBounds, type AdjustmentLayer, type Document, type GroupLayer, type Layer, type Mask, type PixelLayer, type VectorLayer } from './model';
import { drawMapped, IDENT, isAligned, outerRect, type Xf } from './xform';
import { auxRef, applyEffectsSafe, effectIsTdPreview, effectsReach, effectsSourceRect, hasEffects, tdPreviewFlag, withoutTdPreview } from './effectsAdapter';
import { drawText } from './textShape';
import { drawShapeWith } from './shapeSdf';
import { clipToSize, intersect, union } from './rect';
import { adjustmentReach, isIdentity, pixRect, renderAdjusted } from './adjustments';

const OPS: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  'soft-light': 'soft-light', 'hard-light': 'hard-light', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

export const raf: (cb: () => void) => unknown =
  typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
export const cancelRaf: (h: unknown) => void =
  typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h as number) : (h) => clearTimeout(h as number);

interface FxEntry { sig: unknown[]; rect: Rect; surf: Surface }
/** Document-sized effect input / output pair per nesting level (a group's effects paint its children, which may have effects of their own). */
interface FxPair { src: Surface; out: Surface; pool: Surface[]; aux?: Surface }
/** Where a layer's effects come from this frame: computed here (`effects`), or TD's render of it (`preview`, doc sized). */
interface FxPlan { effects: readonly Effect[]; preview: Surface | null }
/** Composite of the root layers below the stroke's layer (see Compositor.holdBelow). */
interface BelowCache { surf: Surface; built: Set<number>; top: Layer; k: number }

const BELOW_TILE = 256;
/** Largest below-cache surface (bytes): bigger documents composite everything each frame. */
const BELOW_MAX_BYTES = 128 * 1024 * 1024;

/** A render target: a canvas context plus the document position of its top-left pixel. */
interface Target {
  ctx: Ctx2D;
  canvas: Surface['canvas'];
  ox: number;
  oy: number;
  k: number; // canvas pixels per document pixel (1, or the thumbnail scale)
  pool: Surface[]; // scratch windows for nested groups / masks / adjustments by depth, matching k
}

const round64 = (n: number): number => Math.ceil(n / 64) * 64;

/**
 * Flattens the layer tree into `surface`, redrawing only the pending dirty rect, at most once per frame.
 * Masks are applied with destination-in on a scratch copy of the layer; adjustments read the accumulated
 * result of their parent (see adjustments.ts). Blur widens the redrawn rect by its reach only.
 *
 * Scratch canvases are windows the size of the rect being drawn (a transform maps document coordinates
 * onto them): a document-sized scratch would be copied wholesale by the browser on every reuse.
 */
export class Compositor {
  surface: Surface;
  private pool: Surface[] = []; // scratch windows by nesting depth (full resolution passes)
  private tpool: Surface[] = []; // scratch windows of thumbnail passes: never shared with the main passes
  private padWin: Surface | null = null; // blur edge-hold source
  private thumb: Surface | null = null;
  private fxPairs: FxPair[] = []; // effects input / output surfaces by nesting level (document sized)
  private fxLevel = 0;
  /** v6: layer id -> TD's render of the layer after its effects (document sized, premultiplied canvas). `stale`: the layer or what it
   *  depends on changed since the image was made: the local render (without the flagged effects) shows until a newer image arrives. */
  private previews = new Map<string, { surf: Surface; stale: boolean; sig: unknown[] }>();
  private staling = true;
  private holdId: string | null = null; // v6: stroke in progress on this layer: the composite below it is cached
  private below: BelowCache | null = null;
  private belowOn = true;
  /** Test / perf counters of the below cache. */
  belowStats = { builds: 0, uses: 0 };
  private stage: Surface | null = null; // render target when blur needs source pixels beyond the output rect
  private dirty: Rect | null = null;
  private layerEpoch = new WeakMap<object, number>(); // per layer: strokes since the last global epoch bump
  private propsEpoch = 0; // property / transform edits (not pixels): stale group effect results
  private epoch = 0; // bumped by every invalidation that may change layer content (not by property / transform edits)
  private fxCache = new Map<object, FxEntry>(); // per layer: the effects output over a rect, valid while the signature matches
  private handle: unknown = null;
  private disposed = false;
  private enabled = true;

  constructor(private doc: Document, private onComposite: (r: Rect) => void) {
    this.surface = createSurface(doc.width, doc.height, true);
    this.invalidate(null);
  }

  get isEnabled(): boolean { return this.enabled; }
  /** Id of the layer a stroke is in progress on (the below cache is held for it), else null. */
  get held(): string | null { return this.holdId; }

  /** Mark a document-space rect dirty; null = whole document. */
  invalidate(r: Rect | null, propsOnly = false, activeOnly = false): void {
    if (this.disposed) return;
    if (!activeOnly) this.dropBelow(); // anything but a stroke on the held layer may change what lies below it
    if (propsOnly) this.propsEpoch++;
    else if (this.staling && this.previews.size) this.stalePreviews(r);
    if (!propsOnly) {
      // pixels changed somewhere: cached effect results are stale (a stroke on the held layer only stales that layer's own entry)
      const held = activeOnly && this.holdId ? this.doc.find(this.holdId) : null;
      if (held) this.layerEpoch.set(held, (this.layerEpoch.get(held) ?? 0) + 1);
      else this.epoch++;
    }
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const clipped = r ? clipToSize(r, full.w, full.h) : full;
    if (!clipped) return;
    this.dirty = union(this.dirty, clipped);
    if (this.enabled && this.handle === null) this.schedule();
  }

  private schedule(): void {
    this.handle = raf(() => {
      this.handle = null;
      this.flush();
    });
  }

  /** false = no automatic compositing: dirty rects accumulate until re-enabled. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      if (this.handle !== null) cancelRaf(this.handle);
      this.handle = null;
    } else if (this.dirty && this.handle === null && !this.disposed) {
      this.schedule();
    }
  }

  /** Composite pending dirty rect now (the rect is widened by the blur reach so every changed pixel is redrawn). */
  flush(): void {
    const r = this.disposed ? null : this.dirty;
    if (!r) return;
    this.dirty = null;
    const out = this.widen(r);
    this.renderRegion(out);
    this.pruneFxCache();
    this.onComposite(out);
  }

  /**
   * Make `r` (null = everything) of the surface current. Enabled: flush the dirty rect. Disabled: render just `r`
   * and leave the dirty union alone for when the preview is switched back on.
   */
  ensure(r: Rect | null): void {
    if (this.enabled) return this.flush();
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const want = r ? clipToSize(r, full.w, full.h) : full;
    if (want) this.renderRegion(want);
  }

  /** Doc size changed: reallocate (callers re-invalidate content via full dirty). */
  resize(): void {
    releaseSurface(this.surface);
    this.releaseScratch();
    this.surface = createSurface(this.doc.width, this.doc.height, true);
    this.dirty = null;
    this.invalidate(null);
  }

  dispose(): void {
    this.disposed = true;
    this.dirty = null;
    if (this.handle !== null) cancelRaf(this.handle);
    this.handle = null;
    releaseSurface(this.surface);
    this.releaseScratch();
  }

  /**
   * Render a group alone at thumbnail scale k (canvas pixels per document pixel). Returns a surface whose top-left
   * round(width*k) x round(height*k) pixels hold the result. Never touches the full-resolution scratch pool.
   */
  renderIsolated(group: GroupLayer, k: number): Surface {
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const pw = Math.max(1, Math.round(full.w * k));
    const ph = Math.max(1, Math.round(full.h * k));
    this.thumb = this.fit(this.thumb, pw, ph, 0, 0, k);
    this.thumb.ctx.clearRect(0, 0, full.w, full.h);
    this.renderGroup({ ctx: this.thumb.ctx, canvas: this.thumb.canvas, ox: 0, oy: 0, k, pool: this.tpool }, group, full, 1);
    return this.thumb;
  }

  /**
   * How far a change can show up from where it happened: the sum of the reach of all visible blur adjustments plus the
   * largest reach of the layer effects (a drop shadow / glow paints beyond the layer's own pixels).
   */
  reach(): number {
    let n = 0;
    let fx = 0;
    for (const l of this.doc.all()) {
      if (!l.visible || l.opacity <= 0) continue;
      const eff = l.effects.length && tdPreviewFlag(l.effects) ? (this.freshPreview(l) ? [] : withoutTdPreview(l.effects)) : l.effects; // a TD image needs no local reach
      if (l.kind === 'adjustment') n += adjustmentReach(l.adjustment) + (eff.length ? effectsReach(eff) : 0);
      else if (l.kind === 'group') n += eff.length ? effectsReach(eff) : 0; // v6: chained through the parent
      else if (eff.length) fx = Math.max(fx, effectsReach(eff));
    }
    return n + fx;
  }

  private widen(r: Rect): Rect {
    const e = this.reach();
    if (!e) return r;
    return clipToSize({ x: r.x - e, y: r.y - e, w: r.w + 2 * e, h: r.h + 2 * e }, this.doc.width, this.doc.height) as Rect;
  }

  /** Draw the output rect `r` into the main surface. */
  private renderRegion(r: Rect): void {
    const ctx = this.surface.ctx;
    const e = this.reach();
    const main: Target = { ctx, canvas: this.surface.canvas, ox: 0, oy: 0, k: 1, pool: this.pool };
    const bk = this.belowIndex();
    if (!e) {
      if (bk >= 0) this.ensureBelow(r, bk);
      ctx.clearRect(r.x, r.y, r.w, r.h);
      if (bk >= 0) {
        ctx.drawImage((this.below as BelowCache).surf.canvas as CanvasImageSource, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        this.belowStats.uses++;
        this.renderGroup(main, this.doc.root, r, 0, bk);
      } else this.renderGroup(main, this.doc.root, r, 0);
      return;
    }
    // Blur reads pixels around the output rect: render the widened rect off to the side, keep only `r`.
    const rr = clipToSize({ x: r.x - e, y: r.y - e, w: r.w + 2 * e, h: r.h + 2 * e }, this.doc.width, this.doc.height) as Rect;
    if (bk >= 0) this.ensureBelow(rr, bk);
    this.stage = this.fit(this.stage, rr.w, rr.h, rr.x, rr.y, 1);
    this.stage.ctx.clearRect(rr.x, rr.y, rr.w, rr.h);
    const st: Target = { ctx: this.stage.ctx, canvas: this.stage.canvas, ox: rr.x, oy: rr.y, k: 1, pool: this.pool };
    if (bk >= 0) {
      this.stage.ctx.drawImage((this.below as BelowCache).surf.canvas as CanvasImageSource, rr.x, rr.y, rr.w, rr.h, rr.x, rr.y, rr.w, rr.h);
      this.belowStats.uses++;
      this.renderGroup(st, this.doc.root, rr, 0, bk);
    } else this.renderGroup(st, this.doc.root, rr, 0);
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(this.stage.canvas as CanvasImageSource, r.x - rr.x, r.y - rr.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }

  // ---- v6: cache of the composite below the layer being painted ----

  /**
   * A stroke starts on layer `id` (null = it ended): while held, the root layers below the one containing `id` are composited once
   * (lazily, per 256 px tile) into a cache and every frame only draws that layer and the ones above over it. Any invalidation other than
   * `invalidate(r, false, true)` (a paint on the held layer) drops the cache, so it can never show stale pixels.
   */
  holdBelow(id: string | null): void {
    if (id === this.holdId) return;
    this.holdId = id;
    this.dropBelow();
  }

  setBelowCache(on: boolean): void {
    this.belowOn = on;
    if (!on) this.dropBelow();
  }

  private dropBelow(): void {
    if (!this.below) return;
    releaseSurface(this.below.surf);
    this.below = null;
  }

  /** The valid aux sources (document-space extents of the layers / inputs visible layers displace by); broken references are ignored. */
  private auxSources(): Rect[] {
    const out: Rect[] = [];
    const docRect = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const add = (fx: readonly Effect[]): void => {
      const ref = auxRef(fx);
      if (!ref) return;
      if (ref.kind === 'input') {
        const st = this.doc.inputs.get(ref.input);
        if (st && st.connected) out.push({ x: 0, y: 0, w: st.surface.width, h: st.surface.height });
        return;
      }
      const t = this.doc.find(ref.id);
      if (t && t.kind !== 'adjustment' && t.kind !== 'group') out.push(layerExtent(t, docRect) ?? docRect);
    };
    for (const l of this.doc.all()) {
      if (!l.visible || l.opacity <= 0) continue;
      add(l.effects);
      if (l.kind === 'adjustment' && l.adjustment.type === 'filter') add([l.adjustment.effect]);
    }
    return out;
  }

  /** Does any visible layer take an aux image? */
  hasAux(): boolean { return this.auxSources().length > 0; }

  /** Index (in root.children) of the layer holding the stroke when caching pays off, else -1. Allocates the cache surface on first use. */
  private belowIndex(): number {
    if (!this.holdId || !this.belowOn || this.disposed || this.hasAux()) return -1;
    const kids = this.doc.root.children;
    let k = -1;
    const has = (g: GroupLayer, id: string): boolean => g.children.some((c) => c.id === id || (c.kind === 'group' && has(c, id)));
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].id === this.holdId || (kids[i].kind === 'group' && has(kids[i] as GroupLayer, this.holdId))) { k = i; break; }
    }
    if (k < 0 || k >= kids.length - 1) return -1;
    if (this.below && (this.below.top !== kids[k] || this.below.k !== k)) this.dropBelow();
    if (!this.below) {
      if (this.doc.width * this.doc.height * 4 > BELOW_MAX_BYTES) return -1;
      // worth it only when the layers below cost something: effects / adjustments / groups count triple
      let cost = 0;
      const walk = (l: Layer): void => {
        if (!l.visible || l.opacity <= 0) return;
        cost += l.kind === 'group' || l.kind === 'adjustment' || l.effects.length ? 3 : 1;
        if (l.kind === 'group') l.children.forEach(walk);
      };
      for (let i = k + 1; i < kids.length; i++) walk(kids[i]);
      if (cost < 3) return -1;
      this.below = { surf: createSurface(this.doc.width, this.doc.height), built: new Set(), top: kids[k], k };
    }
    return k;
  }

  /** Make the cache current over `r` (document space): composite the not yet built 256 px tiles of it. */
  private ensureBelow(r: Rect, k: number): void {
    const b = this.below as BelowCache;
    const W = this.doc.width;
    const H = this.doc.height;
    const cols = Math.ceil(W / BELOW_TILE);
    let miss: Rect | null = null;
    const x1 = Math.min(Math.ceil(W / BELOW_TILE) - 1, Math.floor((r.x + r.w - 1) / BELOW_TILE));
    const y1 = Math.min(Math.ceil(H / BELOW_TILE) - 1, Math.floor((r.y + r.h - 1) / BELOW_TILE));
    for (let ty = Math.max(0, Math.floor(r.y / BELOW_TILE)); ty <= y1; ty++) {
      for (let tx = Math.max(0, Math.floor(r.x / BELOW_TILE)); tx <= x1; tx++) {
        if (b.built.has(ty * cols + tx)) continue;
        const t = { x: tx * BELOW_TILE, y: ty * BELOW_TILE, w: Math.min(BELOW_TILE, W - tx * BELOW_TILE), h: Math.min(BELOW_TILE, H - ty * BELOW_TILE) };
        miss = union(miss, t);
      }
    }
    if (!miss) return;
    const R = miss;
    const kids = this.doc.root.children;
    const e = this.reach();
    const ctx = b.surf.ctx;
    this.belowStats.builds++;
    if (!e) {
      ctx.clearRect(R.x, R.y, R.w, R.h);
      this.renderGroup({ ctx, canvas: b.surf.canvas, ox: 0, oy: 0, k: 1, pool: this.pool }, this.doc.root, R, 0, kids.length - 1, k + 1);
    } else {
      const rr = clipToSize({ x: R.x - e, y: R.y - e, w: R.w + 2 * e, h: R.h + 2 * e }, W, H) as Rect;
      this.stage = this.fit(this.stage, rr.w, rr.h, rr.x, rr.y, 1);
      this.stage.ctx.clearRect(rr.x, rr.y, rr.w, rr.h);
      this.renderGroup({ ctx: this.stage.ctx, canvas: this.stage.canvas, ox: rr.x, oy: rr.y, k: 1, pool: this.pool }, this.doc.root, rr, 0, kids.length - 1, k + 1);
      ctx.clearRect(R.x, R.y, R.w, R.h);
      ctx.drawImage(this.stage.canvas as CanvasImageSource, R.x - rr.x, R.y - rr.y, R.w, R.h, R.x, R.y, R.w, R.h);
    }
    for (let ty = Math.floor(R.y / BELOW_TILE); ty * BELOW_TILE < R.y + R.h; ty++) {
      for (let tx = Math.floor(R.x / BELOW_TILE); tx * BELOW_TILE < R.x + R.w; tx++) b.built.add(ty * cols + tx);
    }
  }

  // ---- v6: TD renders of layers the browser cannot match ----

  /** Show `s` (document-sized surface, ownership passes here) as the post-effects content of layer `id`; null removes it. At most 16 previews are kept (hidden layers go first). */
  setPreview(id: string, s: Surface | null): void {
    const old = this.previews.get(id);
    if (old) releaseSurface(old.surf);
    this.previews.delete(id);
    if (s) {
      const l = this.doc.find(id);
      this.previews.set(id, { surf: s, stale: false, sig: l ? this.previewSig(l) : [] });
      while (this.previews.size > 16) {
        let drop: string | null = null;
        for (const k of this.previews.keys()) {
          if (k === id) continue;
          if (drop === null) drop = k;
          if (!this.doc.find(k)?.visible) { drop = k; break; }
        }
        if (drop === null) break;
        releaseSurface((this.previews.get(drop) as { surf: Surface }).surf);
        this.previews.delete(drop);
      }
    }
    this.staling = false; // an image arriving does not make the others stale
    try { this.invalidate(null); } finally { this.staling = true; }
  }

  /** True while a current (not stale) TD image of the layer is held. */
  hasPreview(id: string): boolean {
    const l = this.doc.find(id);
    return !!l && this.freshPreview(l) !== null;
  }

  /** What a TD image of `l` depends on besides pixels (compared by identity at draw time). */
  private previewSig(l: Layer): unknown[] {
    const kids: unknown[] = [];
    if (l.kind === 'group') {
      // a group's image is its children's composite: their order, visibility, opacity, blend and own content signatures
      const walk = (g: GroupLayer): void => {
        for (const c of g.children) {
          kids.push(c, c.visible, c.opacity, c.blend, ...this.ownSig(c));
          if (c.kind === 'group') walk(c);
        }
      };
      walk(l);
    }
    return [...kids, ...this.ownSig(l)];
  }

  private ownSig(l: Layer): unknown[] {
    const px = l.kind === 'pixel' || l.kind === 'input' ? l : null;
    return [l.effects, px?.x, px?.y, px?.sx, px?.sy, px?.rot, px?.kx, px?.ky, px?.surface, l.kind === 'group' ? null : l.mask, l.kind === 'group' ? null : l.mask?.enabled,
      l.kind === 'adjustment' ? l.adjustment : null, l.kind === 'text' || l.kind === 'shape' ? l.spec : null];
  }

  /** Does a pixel change inside `r` (null = everywhere) change what layer `l`'s TD image shows? */
  private hits(l: Layer, r: Rect | null): boolean {
    if (!r || l.kind === 'adjustment') return true; // an adjustment's image depends on everything below
    const ext = layerExtent(l, { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
    return !ext || intersect(r, ext) !== null;
  }

  private stalePreviews(r: Rect | null): void {
    this.previews.forEach((p, id) => {
      const l = this.doc.find(id);
      if (l && !p.stale && this.hits(l, r)) p.stale = true;
    });
  }

  /** The current TD image of a flagged layer, or null (none yet, stale, or the layer changed since it was made). */
  private freshPreview(l: Layer): Surface | null {
    const p = this.previews.get(l.id);
    if (!p || p.stale) return null;
    const now = this.previewSig(l);
    if (now.length !== p.sig.length || now.some((x, i) => x !== p.sig[i])) {
      p.stale = true;
      return null;
    }
    return p.surf;
  }

  private releaseScratch(): void {
    for (const s of [...this.pool, ...this.tpool, this.stage, this.padWin, this.thumb]) if (s) releaseSurface(s);
    for (const p of this.fxPairs) {
      releaseSurface(p.src);
      releaseSurface(p.out);
      p.pool.forEach(releaseSurface);
      if (p.aux) releaseSurface(p.aux);
    }
    this.fxPairs = [];
    this.fxCache.forEach((c) => releaseSurface(c.surf));
    this.fxCache.clear();
    this.previews.forEach((p) => releaseSurface(p.surf));
    this.previews.clear();
    this.dropBelow();
    this.pool = [];
    this.tpool = [];
    this.stage = null;
    this.padWin = null;
    this.thumb = null;
  }

  /** A canvas of at least pw x ph pixels (and not much bigger) whose context maps document coordinates (scale k, origin tx,ty) onto it. */
  private fit(s: Surface | null, pw: number, ph: number, tx: number, ty: number, k: number): Surface {
    pw = Math.ceil(pw);
    ph = Math.ceil(ph);
    if (!s || s.width < pw || s.height < ph || s.width * s.height > 4 * pw * ph + 4096) {
      if (s) releaseSurface(s);
      s = createSurface(round64(pw), round64(ph), true);
    }
    s.ctx.setTransform(k, 0, 0, k, -tx * k, -ty * k);
    return s;
  }

  /** Target for the scratch window at `depth` covering `r`, at the parent's scale. */
  private scratch(parent: Target, depth: number, r: Rect): Target {
    const s = (parent.pool[depth] = this.fit(parent.pool[depth] ?? null, r.w * parent.k, r.h * parent.k, r.x, r.y, parent.k));
    return { ctx: s.ctx, canvas: s.canvas, ox: r.x, oy: r.y, k: parent.k, pool: parent.pool };
  }

  private padTarget(p: Rect, k: number): { ctx: Ctx2D; canvas: Surface['canvas']; ox: number; oy: number; k: number } {
    this.padWin = this.fit(this.padWin, p.w * k, p.h * k, p.x, p.y, k);
    return { ctx: this.padWin.ctx, canvas: this.padWin.canvas, ox: p.x, oy: p.y, k };
  }

  /** Effect surfaces of nesting level `level` (document sized, re-created when the document size changed). */
  private pair(level: number): FxPair {
    const W = this.doc.width;
    const H = this.doc.height;
    let p = this.fxPairs[level];
    if (p && (p.src.width !== W || p.src.height !== H)) {
      releaseSurface(p.src);
      releaseSurface(p.out);
      p.pool.forEach(releaseSurface);
      if (p.aux) releaseSurface(p.aux);
      p = undefined as unknown as FxPair;
    }
    if (!p) p = this.fxPairs[level] = { src: createSurface(W, H, true), out: createSurface(W, H, true), pool: [] };
    return p;
  }

  /**
   * How `l`'s effects are produced this frame (null = none / thumbnail). A stack holding a planner-flagged effect (`tdPreview`)
   * shows TD's render once it has arrived (setPreview) and otherwise everything the browser can compute without the flagged ones.
   */
  private fxOf(l: Layer, k: number): FxPlan | null {
    if (k !== 1 || !l.effects.length) return null;
    if (tdPreviewFlag(l.effects)) {
      const p = this.freshPreview(l);
      if (p) return { effects: l.effects, preview: p };
      const rest = withoutTdPreview(l.effects);
      return hasEffects(rest) ? { effects: rest, preview: null } : null;
    }
    return hasEffects(l.effects) ? { effects: l.effects, preview: null } : null;
  }

  /** The chain an adjustment layer runs after its own adjustment: the filter of a filter adjustment, then the layer's effects. */
  private adjFx(l: AdjustmentLayer, k: number): FxPlan | null {
    if (k !== 1) return null;
    const spec = l.adjustment;
    const own: readonly Effect[] = spec.type === 'filter' ? [spec.effect] : [];
    if (!own.length && !l.effects.length) return null;
    const flagged = tdPreviewFlag(l.effects) || (own.length > 0 && effectIsTdPreview(own[0]));
    if (flagged) {
      const p = this.freshPreview(l);
      if (p) return { effects: [], preview: p };
    }
    const all = own.concat(l.effects);
    const chain = flagged ? all.filter((e) => !effectIsTdPreview(e)) : all;
    return hasEffects(chain) ? { effects: chain, preview: null } : null;
  }

  private renderGroup(tgt: Target, group: GroupLayer, r: Rect, depth: number, from = group.children.length - 1, to = 0): void {
    const ctx = tgt.ctx;
    for (let i = from; i >= to; i--) {
      const l = group.children[i];
      if (!l.visible || l.opacity <= 0) continue;
      if (l.kind === 'group') {
        const f = this.fxOf(l, tgt.k);
        if (f) {
          this.drawGroupFx(tgt, l, r, f);
          continue;
        }
        const s = this.scratch(tgt, depth, r);
        s.ctx.clearRect(r.x, r.y, r.w, r.h);
        this.renderGroup(s, l, r, depth + 1);
        this.blit(ctx, s.canvas, pixRect(s, r), r, l.opacity, l.blend);
      } else if (l.kind === 'adjustment') {
        if (this.adjusts(l, tgt.k)) this.applyAdjustment(tgt, l, r, depth);
      } else if (isVector(l)) {
        this.drawVector(tgt, l, r, depth);
      } else {
        this.drawPixel(tgt, l as PixelLayer, r, depth);
      }
    }
  }

  /** Does the adjustment layer change anything at this scale (identity adjustments without effects are skipped)? */
  private adjusts(l: AdjustmentLayer, k: number): boolean {
    if (l.adjustment.type !== 'filter' && !isIdentity(l.adjustment)) return true;
    return this.adjFx(l, k) !== null;
  }

  /** A group with effects: its isolated composite goes through the effects (document space) before it is blended. */
  private drawGroupFx(tgt: Target, g: GroupLayer, r: Rect, f: FxPlan): void {
    const W = this.doc.width;
    const H = this.doc.height;
    const ext = f.preview ? { x: 0, y: 0, w: W, h: H } : layerExtent(g, { x: 0, y: 0, w: W, h: H });
    const vis = ext && intersect(r, ext);
    if (!vis) return;
    let sum = 0;
    let aux = false; // a descendant displaces by a layer outside the group: its result depends on pixels this signature cannot see
    const walk = (x: GroupLayer): void => { for (const c of x.children) { sum += this.layerEpoch.get(c) ?? 0; if (auxRef(c.effects) || (c.kind === 'adjustment' && c.adjustment.type === 'filter' && auxRef([c.adjustment.effect]))) aux = true; if (c.kind === 'group') walk(c); } };
    walk(g);
    const res = this.fxResult(g, [this.propsEpoch, sum, this.doc.shapeRenderer], vis, f, (c, cr, p) => {
      this.renderGroup({ ctx: c, canvas: p.src.canvas, ox: 0, oy: 0, k: 1, pool: p.pool }, g, cr, 0);
    }, !aux);
    if (res) this.blit(tgt.ctx, res.src, res.s, res.d, g.opacity, g.blend);
  }

  /**
   * A pixel / input layer under its transform. Pixel-aligned layers (scale 1, whole-pixel position, no rotation or skew)
   * are copied; others are resampled by drawImage (bilinear, 'high' quality when minifying) under the layer's full affine,
   * clipped to the visible rect; masks use the same mapping. Layers with enabled effects go through a scratch window and
   * the effects module (see effectsAdapter.ts) before they are blended.
   */
  private drawPixel(tgt: Target, pl: PixelLayer, r: Rect, depth: number): void {
    if (!this.doc.inputConnected(pl)) return; // a disconnected TD input renders nothing (the layer keeps its placement)
    const f = this.fxOf(pl, tgt.k);
    const own = outerRect(surfaceDocBounds(pl));
    const vis = f?.preview ? intersect(r, { x: 0, y: 0, w: this.doc.width, h: this.doc.height }) : intersect(r, f ? grow(own, effectsReach(f.effects)) : own);
    if (!vis) {
      this.drawFloating(tgt, pl, r);
      return;
    }
    const ctx = tgt.ctx;
    const masked = pl.mask && pl.mask.enabled;
    if (!masked && !f) {
      if (isAligned(pl)) {
        const src: Rect = { x: vis.x - pl.x, y: vis.y - pl.y, w: vis.w, h: vis.h };
        this.blit(ctx, pl.surface.canvas, src, vis, pl.opacity, pl.blend);
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(vis.x, vis.y, vis.w, vis.h);
        ctx.clip();
        ctx.globalAlpha = pl.opacity;
        ctx.globalCompositeOperation = OPS[pl.blend];
        drawMapped(ctx, pl.surface.canvas as CanvasImageSource, pl.surface.width, pl.surface.height, pl, vis);
        ctx.restore();
      }
      this.drawFloating(tgt, pl, r);
      return;
    }
    if (f) {
      // (the mask is applied BEFORE the effects, as in TD; a TD preview image already contains it)
      const res = this.fxResult(pl, [this.layerEpoch.get(pl), pl.surface, pl.mask, pl.mask?.enabled, pl.x, pl.y, pl.sx, pl.sy, pl.rot, pl.kx, pl.ky], vis, f, (c, cr) => {
        drawMapped(c, pl.surface.canvas as CanvasImageSource, pl.surface.width, pl.surface.height, pl, cr);
        if (masked) this.maskIn(c, pl.mask as Mask, pl, cr);
      });
      if (res) this.blit(ctx, res.src, res.s, res.d, pl.opacity, pl.blend);
      this.drawFloating(tgt, pl, r);
      return;
    }
    const s = this.scratch(tgt, depth, r);
    s.ctx.clearRect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.save();
    s.ctx.beginPath();
    s.ctx.rect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.clip();
    drawMapped(s.ctx, pl.surface.canvas as CanvasImageSource, pl.surface.width, pl.surface.height, pl, vis);
    s.ctx.restore();
    if (masked) this.maskIn(s.ctx, pl.mask as Mask, pl, vis);
    this.blit(tgt.ctx, s.canvas, pixRect(s, vis), vis, pl.opacity, pl.blend);
    this.drawFloating(tgt, pl, r);
  }

  /** A text / shape layer: rendered straight from its spec into a scratch window, then masked, given its effects and blended. */
  private drawVector(tgt: Target, l: VectorLayer, r: Rect, depth: number): void {
    const f = this.fxOf(l, tgt.k);
    const vis = f?.preview ? intersect(r, { x: 0, y: 0, w: this.doc.width, h: this.doc.height }) : intersect(r, f ? grow(specBounds(l), effectsReach(f.effects)) : specBounds(l));
    if (!vis) return;
    if (f) {
      const res = this.fxResult(l, [this.layerEpoch.get(l), l.spec, l.mask, l.mask?.enabled, this.doc.shapeRenderer], vis, f, (c, cr) => {
        if (l.kind === 'text') drawText(c, l.spec);
        else drawShapeWith(this.doc.shapeRenderer, c, l.spec, this.doc.width, this.doc.height);
        if (l.mask && l.mask.enabled) this.maskIn(c, l.mask, IDENT, cr);
      });
      if (res) this.blit(tgt.ctx, res.src, res.s, res.d, l.opacity, l.blend);
      return;
    }
    const s = this.scratch(tgt, depth, r);
    s.ctx.clearRect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.save();
    s.ctx.beginPath();
    s.ctx.rect(vis.x, vis.y, vis.w, vis.h);
    s.ctx.clip();
    if (l.kind === 'text') drawText(s.ctx, l.spec);
    else drawShapeWith(this.doc.shapeRenderer, s.ctx, l.spec, this.doc.width, this.doc.height);
    s.ctx.restore();
    if (l.mask && l.mask.enabled) this.maskIn(s.ctx, l.mask, IDENT, vis);
    this.blit(tgt.ctx, s.canvas, pixRect(s, vis), vis, l.opacity, l.blend);
  }

  /**
   * Layer effects run in DOCUMENT space (TouchDesigner does the same): the layer's masked, transformed content is painted
   * into a document-sized surface over `vis` grown by the effects' reach, effects.applyEffects(src, effects, vis, out) runs
   * with document-space surfaces and rect, and the rewritten part of `out` inside `vis` is what the caller blends (`s` = the
   * pixels of `src` canvas, `d` = where they go in the document). With a TD preview image there is nothing to compute.
   * `sig` keys the result cache (layer content that is not in the epoch); `cache` false = never cache (groups: their content depends
   * on children's properties that do not bump the epoch).
   */
  private fxResult(layer: object, sig: unknown[], vis: Rect, f: FxPlan, paint: (c: Ctx2D, cr: Rect, p: FxPair) => void, cache = true): { src: Surface['canvas']; s: Rect; d: Rect } | null {
    const W = this.doc.width;
    const H = this.doc.height;
    const v = clipToSize(vis, W, H);
    if (!v) return null;
    if (f.preview) return { src: f.preview.canvas, s: v, d: v };
    const effects = f.effects as Effect[];
    const cr = effectsSourceRect(effects, v, W, H) ?? grow(v, effectsReach(effects));
    const full = [this.epoch, W, H, effects, ...sig];
    if (auxRef(effects)) cache = false; // depends on another layer's pixels
    const hit = cache ? this.fxCache.get(layer) : undefined;
    if (hit && hit.sig.length === full.length && hit.sig.every((x, i) => x === full[i]) && hit.rect.x <= v.x && hit.rect.y <= v.y
      && hit.rect.x + hit.rect.w >= v.x + v.w && hit.rect.y + hit.rect.h >= v.y + v.h) {
      // opacity / blend (or a smaller dirty rect) changed only: re-blend the cached effects output
      return { src: hit.surf.canvas, s: { x: v.x - hit.rect.x, y: v.y - hit.rect.y, w: v.w, h: v.h }, d: v };
    }
    const level = this.fxLevel;
    const p = this.pair(level);
    const src = p.src;
    const out = p.out;
    src.ctx.setTransform(1, 0, 0, 1, 0, 0);
    src.ctx.clearRect(cr.x, cr.y, cr.w, cr.h);
    src.ctx.save();
    src.ctx.beginPath();
    src.ctx.rect(cr.x, cr.y, cr.w, cr.h);
    src.ctx.clip();
    this.fxLevel = level + 1;
    try {
      paint(src.ctx, cr, p);
    } finally {
      this.fxLevel = level;
    }
    src.ctx.restore();
    const aux = auxRef(effects) ? this.auxSurface(effects, layer, level) : null;
    const valid = applyEffectsSafe(src, effects, v, out, aux);
    const from = valid ? out : src;
    const got = valid ? intersect(valid, v) : v;
    if (!got) return null;
    if (valid && cache) { // keep the result (v is what was asked for; got ⊇ v unless clipped)
      const old = this.fxCache.get(layer);
      if (old) releaseSurface(old.surf);
      const surf = createSurface(got.w, got.h);
      surf.ctx.drawImage(from.canvas as CanvasImageSource, got.x, got.y, got.w, got.h, 0, 0, got.w, got.h);
      this.fxCache.set(layer, { sig: full, rect: got, surf });
    }
    return { src: from.canvas, s: got, d: got };
  }

  private auxStack = new Set<object>();

  /**
   * The aux image of a chain: the referenced layer's document-space content after its own effects and mask, before opacity / blend
   * (TD: that layer's content node), or the first layer showing the referenced TD input. null (= no displacement) when the reference
   * is missing, is the layer itself, adjustment, or part of a cycle. Rendered over the whole document into the level's aux surface.
   */
  private auxSurface(effects: readonly Effect[], self: object, level: number): Surface | null {
    const ref = auxRef(effects);
    if (!ref) return null;
    const W = this.doc.width;
    const H = this.doc.height;
    if (ref.kind === 'input') {
      // TD: the raw COMP input at 1:1, anchored top-left in document space (not the input layer's transform); disconnected = nothing
      const st = this.doc.inputs.get(ref.input);
      if (!st || !st.connected) return null;
      const p = this.pair(level);
      if (!p.aux) p.aux = createSurface(W, H, true);
      p.aux.ctx.setTransform(1, 0, 0, 1, 0, 0);
      p.aux.ctx.clearRect(0, 0, W, H);
      p.aux.ctx.drawImage(st.surface.canvas as CanvasImageSource, 0, 0);
      return p.aux;
    }
    const target = this.doc.find(ref.id);
    // only pixel, input, text and shape layers can be a displacement map (not groups, not adjustments)
    if (!target || target === self || target.kind === 'adjustment' || target.kind === 'group' || this.auxStack.has(target)) return null;
    const p = this.pair(level);
    if (!p.aux) p.aux = createSurface(W, H, true);
    const a = p.aux;
    a.ctx.setTransform(1, 0, 0, 1, 0, 0);
    a.ctx.clearRect(0, 0, W, H);
    const clone = { ...target, opacity: 1, blend: 'normal', visible: true } as Layer;
    const holder = { children: [clone] } as unknown as GroupLayer;
    this.auxStack.add(self);
    this.auxStack.add(target);
    this.fxLevel = level + 1;
    try {
      this.renderGroup({ ctx: a.ctx, canvas: a.canvas, ox: 0, oy: 0, k: 1, pool: p.pool }, holder, { x: 0, y: 0, w: W, h: H }, 0);
    } finally {
      this.fxLevel = level;
      this.auxStack.delete(self);
      this.auxStack.delete(target);
    }
    return a;
  }

  /** Forget cached effect results of layers that are gone (called after every flush). */
  private pruneFxCache(): void {
    if (this.previews.size) {
      const flagged = new Set(this.doc.all().filter((l) => tdPreviewFlag(l.effects) || (l.kind === 'adjustment' && l.adjustment.type === 'filter' && effectIsTdPreview(l.adjustment.effect))).map((l) => l.id));
      this.previews.forEach((p, id) => {
        if (!flagged.has(id)) { // gone, or no longer needs TD
          releaseSurface(p.surf);
          this.previews.delete(id);
        }
      });
    }
    if (!this.fxCache.size) return;
    const live = new Set<object>(this.doc.all());
    let total = 0;
    this.fxCache.forEach((c, k) => {
      if (!live.has(k)) {
        releaseSurface(c.surf);
        this.fxCache.delete(k);
      } else total += c.surf.width * c.surf.height * 4;
    });
    if (total > 512 * 1024 * 1024) {
      this.fxCache.forEach((c) => releaseSurface(c.surf));
      this.fxCache.clear();
    }
  }

  /** The floating selection of `pl` (lifted pixels under their own transform), drawn right above the layer. */
  private drawFloating(tgt: Target, pl: PixelLayer, r: Rect): void {
    const f = this.doc.floating;
    if (!f || f.layer !== pl) return;
    const vis = intersect(r, outerRect(floatingBounds(f)));
    if (!vis) return;
    const ctx = tgt.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vis.x, vis.y, vis.w, vis.h);
    ctx.clip();
    ctx.globalAlpha = pl.opacity;
    ctx.globalCompositeOperation = OPS[pl.blend];
    drawMapped(ctx, f.buf.canvas as CanvasImageSource, f.buf.width, f.buf.height, f.t, vis);
    ctx.restore();
  }

  /** dst = dst * mask over the document rect `dst` of ctx; the mask is drawn under `t` (the layer's mapping; identity for document-space masks). */
  private maskIn(ctx: Ctx2D, mask: Mask, t: Xf, dst: Rect): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-in';
    drawMapped(ctx, mask.surface.canvas as CanvasImageSource, mask.surface.width, mask.surface.height, t, dst);
    ctx.restore();
  }

  /**
   * target = mix(target, effects(adjusted(target)), opacity * mask) over r, in premultiplied RGBA. `adjusted` is the layer's adjustment
   * (a filter adjustment runs its filter in the effects chain); the layer's own effects (v6) run on the adjusted result before the mix.
   */
  private applyAdjustment(tgt: Target, l: AdjustmentLayer, r: Rect, depth: number): void {
    const spec = l.adjustment;
    const opacity = l.opacity;
    const mask = l.mask && l.mask.enabled ? l.mask : null;
    const tmp = this.scratch(tgt, depth, r);
    const f = this.adjFx(l, tgt.k);
    if (f?.preview) {
      // TD's adjusted + filtered result of this layer (document space)
      tmp.ctx.clearRect(r.x, r.y, r.w, r.h);
      tmp.ctx.drawImage(f.preview.canvas as CanvasImageSource, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    } else {
      if (spec.type !== 'filter' && !isIdentity(spec)) renderAdjusted(spec, tgt, tmp, r, { w: this.doc.width, h: this.doc.height }, (p) => this.padTarget(p, tgt.k));
      else {
        const fp = pixRect(tgt, r);
        tmp.ctx.clearRect(r.x, r.y, r.w, r.h);
        tmp.ctx.drawImage(tgt.canvas as CanvasImageSource, fp.x, fp.y, fp.w, fp.h, r.x, r.y, r.w, r.h);
      }
      if (f) this.fxInPlace(tmp, f.effects as Effect[], r, l);
    }
    if (mask) this.maskIn(tmp.ctx, mask, IDENT, r); // adjusted * mask
    const ctx = tgt.ctx;
    // below * (1 - opacity * mask) ...
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-out';
    if (mask) {
      ctx.globalAlpha = opacity;
      ctx.drawImage(mask.surface.canvas as CanvasImageSource, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    } else {
      ctx.fillStyle = `rgba(0,0,0,${opacity})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // ... + adjusted * opacity * mask
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'lighter';
    const tp = pixRect(tmp, r);
    ctx.drawImage(tmp.canvas as CanvasImageSource, tp.x, tp.y, tp.w, tp.h, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  /**
   * Run `effects` over the window `w` (a scratch target at scale 1, content valid over `r`) in place: the window is copied into the
   * document-sized effects input (transparent beyond `r`: the margin the caller widened the dirty rect by absorbs the edge), the
   * effects render over `r`, and that part is copied back.
   */
  private fxInPlace(w: { ctx: Ctx2D; canvas: Surface['canvas']; ox: number; oy: number; k: number }, effects: Effect[], r: Rect, self: object): void {
    const W = this.doc.width;
    const H = this.doc.height;
    const level = this.fxLevel;
    const p = this.pair(level);
    const cr = effectsSourceRect(effects, r, W, H) ?? r;
    p.src.ctx.setTransform(1, 0, 0, 1, 0, 0);
    p.src.ctx.clearRect(cr.x, cr.y, cr.w, cr.h);
    const wp = pixRect(w, r);
    p.src.ctx.drawImage(w.canvas as CanvasImageSource, wp.x, wp.y, wp.w, wp.h, r.x, r.y, r.w, r.h);
    const aux = auxRef(effects) ? this.auxSurface(effects, self, level) : null;
    const valid = applyEffectsSafe(p.src, effects, r, p.out, aux);
    if (!valid) return;
    const got = intersect(valid, r);
    if (!got) return;
    w.ctx.clearRect(got.x, got.y, got.w, got.h);
    w.ctx.drawImage(p.out.canvas as CanvasImageSource, got.x, got.y, got.w, got.h, got.x, got.y, got.w, got.h);
  }

  /** Draw `s` (pixels of src) onto the document rect `d` of ctx. */
  private blit(ctx: Ctx2D, src: Surface['canvas'], s: Rect, d: Rect, alpha: number, blend: BlendMode): void {
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = OPS[blend];
    ctx.drawImage(src as CanvasImageSource, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
