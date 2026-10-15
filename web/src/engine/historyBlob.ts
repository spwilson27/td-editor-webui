// Undo history persistence (docs/DESIGN_V6.md section 5 "Undo across saves", docs/PROTOCOL.md section 9).
//
// Blob layout (little endian):
//   0   'RDHB'
//   4   u32 version (1)
//   8   u32 jsonLen
//   12  u32 binLen
//   16  jsonLen bytes of UTF-8 JSON: header { rev, sig, w, h, cur, entries[], layers[], masks[], surfaces[] }
//   16+jsonLen  binLen bytes: raw pixel data (RGBA8 patch rows, orphan surface dumps, selection coverage), referenced by {off, len}
//
// Structural entries reference layers / masks / surfaces through three tables, so object identity is kept across entries:
//   layers   alive: the layer exists in the document at serialisation time (re-found by id after a reload); dead: re-created.
//   masks    same for Mask objects (slot + surface).
//   surfaces live ones (a layer's surface or mask, a TD input) are re-found; surfaces only history keeps alive carry their pixels.
// `sig` is a hash of the document spec the history belongs to: restore refuses a document that differs. Nothing in the document is
// touched while parsing: a corrupt or foreign blob throws before any engine state changes.
import type { Effect, Guides, Rect } from './types';
import type { AdjustmentLayer, Document, EditTarget, GroupLayer, Layer, Mask, NodeSnap, PixelLayer, StructureSnapshot, TextLayer, ShapeLayer } from './model';
import { layerXf } from './model';
import type { SelState } from './selection';
import { createSurface, releaseSurface, type Surface } from './surface';
import type { Patch } from './tiles';
import { sanitizeEffects } from './effectsSanitize';
import { ADJUSTMENT_NAMES, migrateAdjustmentEffects } from './adjustments';
import { sanitizeShape, sanitizeText } from './textShape';
import type { AdjustmentSpec, BlendMode, ShapeSpec, TextSpec } from './types';

export const HISTORY_VERSION = 1;
const MAGIC = [0x52, 0x44, 0x48, 0x42]; // 'RDHB'

export interface CanvasState { w: number; h: number; mode: 'input' | 'fixed'; guides: Guides; sel: SelState }

/** What an undo / redo step needs, as data (the engine builds the closures from it, at run time and after a restore). */
export type Ser =
  | { k: 'patch'; target: EditTarget; patches: Patch[] }
  | { k: 'struct'; before: StructureSnapshot; after: StructureSnapshot }
  | { k: 'guides'; before: Guides; after: Guides }
  | { k: 'sel'; before: SelState; after: SelState }
  | { k: 'fsel'; target: EditTarget; patches: Patch[]; before: SelState; after: SelState }
  | { k: 'canvas'; sBefore: StructureSnapshot; sAfter: StructureSnapshot; cBefore: CanvasState; cAfter: CanvasState };

export interface SerEntry { label: string; ser: Ser }

/** Content hash of a surface's pixels (FNV-1a over 32-bit words, plus size). */
export function surfaceHash(s: Surface): string {
  const d = s.ctx.getImageData(0, 0, s.width, s.height).data;
  const u = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return `${s.width}x${s.height}:${(h >>> 0).toString(16)}`;
}

/** FNV-1a (32 bit) of a string: identifies the document layout a history belongs to. */
export function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16) + ':' + s.length;
}

// ---- writer ----

interface LayerJ { id: string; kind: string; alive: 0 | 1; root?: 1; slot?: number | null; input?: number }
interface MaskJ { slot: number; surf: number; alive: 0 | 1; layer?: number }
interface SurfJ { w: number; h: number; t: 'L' | 'M' | 'I' | 'D'; layer?: number; input?: number; off?: number }
interface SelJ { x: number; y: number; w: number; h: number; off: number; len: number }
type SelRef = SelJ | null | { x: number; y: number; w: number; h: number; full: 1 };

class Writer {
  layers: LayerJ[] = [];
  masks: MaskJ[] = [];
  surfaces: SurfJ[] = [];
  private layerIdx = new Map<Layer, number>();
  private maskIdx = new Map<Mask, number>();
  private surfIdx = new Map<Surface, number>();
  private chunks: Uint8Array[] = [];
  binLen = 0;
  private live = new Set<Layer>();
  private liveSurf = new Map<Surface, { t: 'L' | 'M' | 'I'; layer: Layer; input?: number }>();
  private maskOwner = new Map<Mask, Layer>();

  constructor(private doc: Document) {
    for (const l of doc.all()) {
      this.live.add(l);
      if (l.kind === 'pixel') this.liveSurf.set(l.surface, { t: 'L', layer: l });
      else if (l.kind === 'input') this.liveSurf.set(l.surface, { t: 'I', layer: l, input: l.input ?? 1 });
      if (l.mask) {
        this.maskOwner.set(l.mask, l);
        this.liveSurf.set(l.mask.surface, { t: 'M', layer: l });
      }
    }
  }

  put(data: Uint8Array): number {
    const off = this.binLen;
    this.chunks.push(data);
    this.binLen += data.length;
    return off;
  }

  /** Copy the pixel chunks into `out` at `at` (written straight into the final buffer: peak memory ~ the chunks + the blob). */
  copyBin(out: Uint8Array, at: number): void {
    let o = at;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.chunks = [];
  }

  layer(l: Layer): number {
    let i = this.layerIdx.get(l);
    if (i !== undefined) return i;
    i = this.layers.length;
    this.layerIdx.set(l, i);
    const j: LayerJ = { id: l.id, kind: l.kind, alive: this.live.has(l) || l === this.doc.root ? 1 : 0 };
    if (l === this.doc.root) j.root = 1;
    if (l.kind === 'pixel') j.slot = l.slot;
    if (l.kind === 'input') j.input = l.input ?? 1;
    this.layers.push(j);
    return i;
  }

  surf(s: Surface): number {
    let i = this.surfIdx.get(s);
    if (i !== undefined) return i;
    i = this.surfaces.length;
    this.surfIdx.set(s, i);
    const lv = this.liveSurf.get(s);
    const j: SurfJ = { w: s.width, h: s.height, t: 'D' };
    this.surfaces.push(j);
    if (lv) {
      j.t = lv.t;
      if (lv.t === 'I') j.input = lv.input;
      else j.layer = this.layer(lv.layer);
    } else {
      const d = s.ctx.getImageData(0, 0, s.width, s.height).data;
      j.off = this.put(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    }
    return i;
  }

  mask(m: Mask): number {
    let i = this.maskIdx.get(m);
    if (i !== undefined) return i;
    i = this.masks.length;
    this.maskIdx.set(m, i);
    const j: MaskJ = { slot: m.slot, surf: -1, alive: 0 };
    this.masks.push(j);
    const owner = this.maskOwner.get(m);
    if (owner) {
      j.alive = 1;
      j.layer = this.layer(owner);
    }
    j.surf = this.surf(m.surface);
    return i;
  }

  sel(s: SelState): SelRef {
    if (!s.rect) return null;
    const r = s.rect;
    if (!s.alpha) return { x: r.x, y: r.y, w: r.w, h: r.h, full: 1 };
    return { x: r.x, y: r.y, w: r.w, h: r.h, off: this.put(s.alpha), len: s.alpha.length };
  }

  node(n: NodeSnap): Record<string, unknown> {
    return {
      l: this.layer(n.layer), name: n.name, vis: n.visible, lock: n.locked, op: n.opacity, bl: n.blend,
      x: n.x, y: n.y, sx: n.sx, sy: n.sy, rot: n.rot, kx: n.kx, ky: n.ky, fx: n.effects, sw: n.sw, sh: n.sh,
      surf: n.surface ? this.surf(n.surface) : -1, mask: n.mask ? this.mask(n.mask) : -1, me: n.maskEnabled,
      adj: n.adjustment, spec: n.spec, kids: n.children ? n.children.map((c) => this.node(c)) : null,
    };
  }

  snap(s: StructureSnapshot): Record<string, unknown> {
    return { active: s.active, root: this.node(s.root) };
  }

  target(t: EditTarget): Record<string, unknown> {
    return { layer: this.layer(t.layer), mask: t.isMask, surf: this.surf(t.surface), slot: t.slot };
  }

  patches(ps: Patch[]): unknown[] {
    return ps.map((p) => {
      const b = p.before.data;
      const a = p.after.data;
      const off = this.put(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      this.put(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      return { x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h, off };
    });
  }

  canvas(c: CanvasState): Record<string, unknown> {
    return { w: c.w, h: c.h, mode: c.mode, guides: c.guides, sel: this.sel(c.sel) };
  }

  entry(e: SerEntry): Record<string, unknown> {
    const s = e.ser;
    switch (s.k) {
      case 'patch': return { k: 'patch', label: e.label, target: this.target(s.target), patches: this.patches(s.patches) };
      case 'struct': return { k: 'struct', label: e.label, before: this.snap(s.before), after: this.snap(s.after) };
      case 'guides': return { k: 'guides', label: e.label, before: s.before, after: s.after };
      case 'sel': return { k: 'sel', label: e.label, before: this.sel(s.before), after: this.sel(s.after) };
      case 'fsel': return { k: 'fsel', label: e.label, target: this.target(s.target), patches: this.patches(s.patches), before: this.sel(s.before), after: this.sel(s.after) };
      case 'canvas': return { k: 'canvas', label: e.label, sBefore: this.snap(s.sBefore), sAfter: this.snap(s.sAfter), cBefore: this.canvas(s.cBefore), cAfter: this.canvas(s.cAfter) };
    }
  }
}

/** Serialise `entries` (oldest first; `cur` = index of the last applied one, -1 = none) of the document `doc` whose docSpec hash is `sig`. */
export function writeBlob(doc: Document, rev: number, sig: string, entries: SerEntry[], cur: number, hashes: Record<string, string> = {}): Uint8Array {
  const w = new Writer(doc);
  const ej = entries.map((e) => w.entry(e));
  const head = { rev, sig, hashes, w: doc.width, h: doc.height, cur, entries: ej, layers: w.layers, masks: w.masks, surfaces: w.surfaces };
  const json = new TextEncoder().encode(JSON.stringify(head));
  const out = new Uint8Array(16 + json.length + w.binLen);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, HISTORY_VERSION, true);
  dv.setUint32(8, json.length, true);
  dv.setUint32(12, w.binLen, true);
  out.set(json, 16);
  w.copyBin(out, 16 + json.length);
  return out;
}

/** Header of the blob (rev, sig, version) without building anything; null when it is not a history blob of this version. */
export function peekBlob(blob: Uint8Array): { rev: number; sig: string } | null {
  try {
    const p = parseFrame(blob);
    return typeof p.head.rev === 'number' && typeof p.head.sig === 'string' ? { rev: p.head.rev, sig: p.head.sig } : null;
  } catch {
    return null;
  }
}

// ---- reader ----

type J = Record<string, unknown>;
const MAX_ENTRIES = 1000;
const MAX_TABLE = 100000;
const MAX_DIM = 16384;

function bad(m: string): never {
  throw new Error('history blob: ' + m);
}
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : bad(`bad number ${what}`));
const int = (v: unknown, what: string, lo = 0, hi = 2 ** 31): number => {
  const n = num(v, what);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : bad(`bad integer ${what}`);
};
const str = (v: unknown, what: string): string => (typeof v === 'string' && v.length < 4096 ? v : bad(`bad string ${what}`));
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : bad(`bad boolean ${what}`));
const arr = (v: unknown, what: string, max = MAX_TABLE): unknown[] => (Array.isArray(v) && v.length <= max ? v : bad(`bad array ${what}`));

function parseFrame(blob: Uint8Array): { head: J; bin: Uint8Array } {
  if (!(blob instanceof Uint8Array) || blob.length < 16) bad('too short');
  for (let i = 0; i < 4; i++) if (blob[i] !== MAGIC[i]) bad('bad magic');
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dv.getUint32(4, true) !== HISTORY_VERSION) bad('unknown version');
  const jl = dv.getUint32(8, true);
  const bl = dv.getUint32(12, true);
  if (16 + jl + bl !== blob.length) bad('bad lengths');
  const head = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(blob.subarray(16, 16 + jl))) as unknown;
  if (!isObj(head)) bad('bad header');
  return { head, bin: blob.subarray(16 + jl) };
}

const BLENDS = new Set<string>(['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

export interface Restored {
  entries: SerEntry[];
  cur: number;
  /** pixels / objects created for layers and surfaces only history knows (released by `discard` when the caller cannot use them) */
  created: Surface[];
  deadInputLayers: PixelLayer[];
}

/**
 * Parse `blob` against the (already loaded) document. Throws on anything unexpected, after releasing what it created; the document is
 * only read (alive layers / surfaces are looked up, never modified). `rev` / `sig` must match the blob's.
 */
export function readBlob(blob: Uint8Array, doc: Document, rev: number, sig: string, hashes: Record<string, string>): Restored {
  const { head, bin } = parseFrame(blob);
  if (head.rev !== rev) bad('another document revision');
  if (head.sig !== sig) bad('another document layout');
  if (JSON.stringify(head.hashes) !== JSON.stringify(hashes)) bad('surface pixels differ from the saved document');
  if (head.w !== doc.width || head.h !== doc.height) bad('another document size');
  const created: Surface[] = [];
  const deadInputLayers: PixelLayer[] = [];
  try {
    return readTables(head, bin, doc, created, deadInputLayers);
  } catch (err) {
    created.forEach(releaseSurface);
    throw err;
  }
}

const MAX_ALLOC = 512 * 1024 * 1024;

function readTables(head: J, bin: Uint8Array, doc: Document, created: Surface[], deadInputLayers: PixelLayer[]): Restored {
  // Every pixel range of the blob may be claimed once: the sum of claims is bounded by the blob itself (no amplification by pointing many
  // tables at the same bytes), allocations additionally by MAX_ALLOC. Overlaps are rejected after parsing.
  const ranges: Array<[number, number]> = [];
  let claimed = 0;
  let alloc = 0;
  const claim = (off: number, len: number, what: string): void => {
    claimed += len;
    alloc += len;
    if (claimed > bin.length || alloc > MAX_ALLOC) bad('pixel data over-claimed by ' + what);
    ranges.push([off, off + len]);
  };
  const alive = new Map<string, Layer>();
  for (const l of doc.all()) alive.set(l.id, l);
  // ---- layers ----
  const lj = arr(head.layers, 'layers');
  const layers: Layer[] = lj.map((v) => {
    if (!isObj(v)) bad('layer');
    const id = str(v.id, 'layer id');
    const kind = str(v.kind, 'layer kind');
    if (v.root === 1) return doc.root;
    if (v.alive === 1) {
      const l = alive.get(id);
      if (!l || l.kind !== kind) bad(`layer ${id} differs`);
      if (kind === 'pixel' && (l as PixelLayer).slot !== v.slot) bad(`slot of ${id} differs`);
      if (kind === 'input' && (l as PixelLayer).input !== v.input) bad(`input of ${id} differs`);
      return l;
    }
    return makeDead(doc, id, kind, v, deadInputLayers);
  });
  const layerAt = (i: unknown, what: string): Layer => layers[int(i, what, 0, layers.length - 1)] ?? bad('layer index');
  // ---- surfaces ----
  const sj = arr(head.surfaces, 'surfaces');
  const surfaces: Surface[] = sj.map((v) => {
    if (!isObj(v)) bad('surface');
    const w = int(v.w, 'surface w', 1, MAX_DIM);
    const h = int(v.h, 'surface h', 1, MAX_DIM);
    if (w * h > 8192 * 8192) bad('surface too large');
    if (v.t === 'D') {
      const off = int(v.off, 'surface offset', 0, bin.length);
      if (off + w * h * 4 > bin.length) bad('surface data out of range');
      claim(off, w * h * 4, 'surface');
      const s = createSurface(w, h);
      created.push(s);
      s.ctx.putImageData(new ImageData(new Uint8ClampedArray(bin.slice(off, off + w * h * 4).buffer as ArrayBuffer), w, h), 0, 0);
      return s;
    }
    let s: Surface | null = null;
    if (v.t === 'I') {
      s = doc.inputs.get(int(v.input, 'input', 1, 8))?.surface ?? null;
    } else if (v.t === 'L' || v.t === 'M') {
      const l = layerAt(v.layer, 'surface layer');
      s = v.t === 'L' ? (l.kind === 'pixel' ? l.surface : null) : l.mask ? l.mask.surface : null;
    } else bad('surface kind');
    if (!s || s.width !== w || s.height !== h) bad('live surface differs');
    return s;
  });
  const surfAt = (i: unknown): Surface => surfaces[int(i, 'surface index', 0, surfaces.length - 1)] ?? bad('surface index');
  // ---- masks ----
  const mj = arr(head.masks, 'masks');
  const masks: Mask[] = mj.map((v) => {
    if (!isObj(v)) bad('mask');
    const slot = int(v.slot, 'mask slot', 0, 65535);
    if (v.alive === 1) {
      const l = layerAt(v.layer, 'mask layer');
      if (!l.mask || l.mask.slot !== slot) bad('mask differs');
      return l.mask;
    }
    return { slot, surface: surfAt(v.surf), enabled: true };
  });
  const maskAt = (i: number): Mask => masks[int(i, 'mask index', 0, masks.length - 1)] ?? bad('mask index');
  // ---- helpers over the tables ----
  let dw = doc.width; // size of the document a selection belongs to (changes across canvas steps)
  let dh = doc.height;
  const readSel = (v: unknown): SelState => {
    if (v === null) return { rect: null, alpha: null };
    if (!isObj(v)) bad('selection');
    const rect: Rect = { x: int(v.x, 'sel x', -MAX_DIM, MAX_DIM), y: int(v.y, 'sel y', -MAX_DIM, MAX_DIM), w: int(v.w, 'sel w', 1, MAX_DIM), h: int(v.h, 'sel h', 1, MAX_DIM) };
    if (v.full === 1) return { rect, alpha: null };
    const off = int(v.off, 'sel off', 0, bin.length);
    const len = int(v.len, 'sel len', 0, bin.length);
    if (off + len > bin.length) bad('selection data out of range');
    if (len !== dw * dh || rect.x + rect.w > dw || rect.y + rect.h > dh || rect.x < 0 || rect.y < 0) bad('selection does not fit its document');
    claim(off, len, 'selection');
    return { rect, alpha: bin.slice(off, off + len) };
  };
  let seenL = new Set<Layer>();
  let seenId = new Set<string>();
  const readNode = (v: unknown, depth: number): NodeSnap => {
    if (!isObj(v) || depth > 64) bad('node');
    const layer = layerAt(v.l, 'node layer');
    if (seenL.has(layer) || seenId.has(layer.id)) bad('layer twice in one snapshot');
    seenL.add(layer);
    seenId.add(layer.id);
    let fx = sanitizeEffects(v.fx) as Effect[];
    const kids = v.kids === null ? null : arr(v.kids, 'children', MAX_TABLE).map((c) => readNode(c, depth + 1));
    if ((layer.kind === 'group') !== (kids !== null)) bad('children of a non-group');
    const surfI = int(v.surf, 'node surface', -1, surfaces.length);
    const maskI = int(v.mask, 'node mask', -1, masks.length);
    const blend = str(v.bl, 'blend');
    // v7: blobs written before the adjustment/FX unification carry the adjustment spec: it migrates into the front of the node's effects
    // (the same rule as loadDocument); a spec that cannot be understood refuses the blob (restoreHistory returns false, history starts empty).
    if (layer.kind === 'adjustment' && v.adj != null) {
      if (!isObj(v.adj) || typeof v.adj.type !== 'string' || !(v.adj.type in ADJUSTMENT_NAMES)) bad('adjustment');
      fx = migrateAdjustmentEffects(v.adj as unknown as AdjustmentSpec, fx);
    }
    const adj = null;
    const spec = v.spec === null ? null : layer.kind === 'text' ? sanitizeText(v.spec as TextSpec) : layer.kind === 'shape' ? sanitizeShape(v.spec as ShapeSpec) : bad('spec');
    if ((layer.kind === 'text' || layer.kind === 'shape') && !spec) bad('vector spec');
    if (layer.kind === 'pixel' && surfI < 0) bad('pixel surface');
    return {
      layer, name: str(v.name, 'name'), visible: bool(v.vis, 'visible'), locked: bool(v.lock, 'locked'),
      opacity: Math.min(1, Math.max(0, num(v.op, 'opacity'))), blend: (BLENDS.has(blend) ? blend : 'normal') as BlendMode,
      x: num(v.x, 'x'), y: num(v.y, 'y'), sx: num(v.sx, 'sx'), sy: num(v.sy, 'sy'), rot: num(v.rot, 'rot'), kx: num(v.kx, 'kx'), ky: num(v.ky, 'ky'),
      effects: fx, sw: int(v.sw, 'sw', 0, MAX_DIM), sh: int(v.sh, 'sh', 0, MAX_DIM),
      surface: surfI >= 0 ? surfAt(surfI) : null, mask: maskI >= 0 ? maskAt(maskI) : null, maskEnabled: bool(v.me, 'mask enabled'),
      adjustment: adj, children: kids, spec,
    };
  };
  const readSnap = (v: unknown): StructureSnapshot => {
    if (!isObj(v)) bad('snapshot');
    seenL = new Set();
    seenId = new Set();
    const root = readNode(v.root, 0);
    if (root.layer !== doc.root) bad('snapshot root');
    return { stamp: 0, active: v.active === null ? null : str(v.active, 'active'), root }; // stamp 0: layers TD created since are all kept
  };
  const readGuides = (v: unknown): Guides => {
    if (!isObj(v)) bad('guides');
    const g = (a: unknown): number[] => arr(a, 'guides', 512).map((n) => num(n, 'guide'));
    return { h: g(v.h), v: g(v.v) };
  };
  const readTarget = (v: unknown): EditTarget => {
    if (!isObj(v)) bad('target');
    const layer = layerAt(v.layer, 'target layer');
    if (layer.kind === 'group' && v.mask !== true) bad('target is a group');
    const slot = v.slot === null ? null : int(v.slot, 'target slot', 0, 65535);
    return { layer, isMask: bool(v.mask, 'target mask'), surface: surfAt(v.surf), slot, tf: layerXf(layer) };
  };
  const readPatches = (v: unknown, target: EditTarget): Patch[] =>
    arr(v, 'patches', 100000).map((p) => {
      if (!isObj(p)) bad('patch');
      const rect: Rect = { x: int(p.x, 'patch x', 0, MAX_DIM), y: int(p.y, 'patch y', 0, MAX_DIM), w: int(p.w, 'patch w', 1, MAX_DIM), h: int(p.h, 'patch h', 1, MAX_DIM) };
      if (rect.x + rect.w > target.surface.width || rect.y + rect.h > target.surface.height) bad('patch outside its surface');
      const n = rect.w * rect.h * 4;
      const off = int(p.off, 'patch off', 0, bin.length);
      if (off + 2 * n > bin.length) bad('patch data out of range');
      claim(off, 2 * n, 'patch');
      const mk = (o: number): ImageData => new ImageData(new Uint8ClampedArray(bin.slice(o, o + n).buffer as ArrayBuffer), rect.w, rect.h);
      return { rect, before: mk(off), after: mk(off + n) };
    });
  const readCanvas = (v: unknown): CanvasState => {
    if (!isObj(v)) bad('canvas state');
    const w = int(v.w, 'canvas w', 1, MAX_DIM);
    const h = int(v.h, 'canvas h', 1, MAX_DIM);
    const keep = [dw, dh];
    dw = w;
    dh = h;
    const sel = readSel(v.sel);
    [dw, dh] = keep;
    return { w, h, mode: v.mode === 'fixed' ? 'fixed' : 'input', guides: readGuides(v.guides), sel };
  };
  // ---- entries ----
  const ej = arr(head.entries, 'entries', MAX_ENTRIES);
  // document size in force at each step (canvas steps change it), for validating selection coverage
  const cur0 = int(head.cur, 'cur', -1, ej.length - 1);
  const dims: Array<[number, number]> = new Array(ej.length);
  const cdim = (e: unknown, k: string): [number, number] => {
    const c = isObj(e) && isObj(e[k]) ? (e[k] as J) : bad('canvas state');
    return [int(c.w, 'canvas w', 1, MAX_DIM), int(c.h, 'canvas h', 1, MAX_DIM)];
  };
  let cw = doc.width;
  let ch = doc.height;
  for (let i = cur0 + 1; i < ej.length; i++) {
    if (isObj(ej[i]) && (ej[i] as J).k === 'canvas') [cw, ch] = cdim(ej[i], 'cAfter');
    dims[i] = [cw, ch];
  }
  cw = doc.width;
  ch = doc.height;
  for (let i = cur0; i >= 0; i--) {
    dims[i] = [cw, ch];
    if (isObj(ej[i]) && (ej[i] as J).k === 'canvas') [cw, ch] = cdim(ej[i], 'cBefore');
  }
  const entries: SerEntry[] = ej.map((v, ei) => {
    if (!isObj(v)) bad('entry');
    [dw, dh] = dims[ei];
    const label = str(v.label, 'label');
    switch (v.k) {
      case 'patch': { const target = readTarget(v.target); return { label, ser: { k: 'patch', target, patches: readPatches(v.patches, target) } }; }
      case 'struct': return { label, ser: { k: 'struct', before: readSnap(v.before), after: readSnap(v.after) } };
      case 'guides': return { label, ser: { k: 'guides', before: readGuides(v.before), after: readGuides(v.after) } };
      case 'sel': return { label, ser: { k: 'sel', before: readSel(v.before), after: readSel(v.after) } };
      case 'fsel': { const target = readTarget(v.target); return { label, ser: { k: 'fsel', target, patches: readPatches(v.patches, target), before: readSel(v.before), after: readSel(v.after) } }; }
      case 'canvas': return { label, ser: { k: 'canvas', sBefore: readSnap(v.sBefore), sAfter: readSnap(v.sAfter), cBefore: readCanvas(v.cBefore), cAfter: readCanvas(v.cAfter) } };
      default: return bad('entry kind');
    }
  });
  const cur = int(head.cur, 'cur', -1, entries.length - 1);
  ranges.sort((a, c) => a[0] - c[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) bad('overlapping pixel data');
  return { entries, cur, created, deadInputLayers };
}

/** A layer object that exists only in history (deleted / replaced since): every mutable field is overwritten by the snapshot that restores it. */
function makeDead(doc: Document, id: string, kind: string, v: J, deadInputLayers: PixelLayer[]): Layer {
  const common = { id, name: id, visible: true, locked: false, opacity: 1, blend: 'normal' as BlendMode, effects: [] as Effect[] };
  switch (kind) {
    case 'group': return { ...common, kind: 'group', children: [], expanded: true, mask: null } as GroupLayer;
    case 'adjustment': return { ...common, kind: 'adjustment', adjustment: null, mask: null } as AdjustmentLayer;
    case 'text': return { ...common, kind: 'text', spec: sanitizeText({} as TextSpec), mask: null } as TextLayer;
    case 'shape': return { ...common, kind: 'shape', spec: sanitizeShape({} as ShapeSpec), mask: null } as ShapeLayer;
    case 'pixel': {
      const slot = v.slot === null ? null : int(v.slot, 'slot', 0, 65535);
      return { ...common, kind: 'pixel', surface: createSurface(1, 1), x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, slot, mask: null } as PixelLayer;
    }
    case 'input': {
      const n = int(v.input, 'input', 1, 8);
      const st = doc.inputs.get(n);
      const l = { ...common, kind: 'input', input: n, locked: true, surface: st ? st.surface : createSurface(1, 1), x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0, slot: null, mask: null } as PixelLayer;
      deadInputLayers.push(l);
      return l;
    }
    default: return bad('layer kind ' + kind);
  }
}
