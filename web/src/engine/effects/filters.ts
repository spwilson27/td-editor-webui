// Filters library engine (docs/DESIGN_V6.md section 1): blur pyramid planning, the spec expression language, parameter normalisation,
// data generators (curves / gradient / table / .cube) and the spec driven planner.  MIRRORS the "filter specs" part of
// td/raster_editor/effects.py -- shared/effects/vectors.json is checked against both.  Specs: shared/effects/<type>.filter.json.

export type PassFormat = 'u8' | 'f16' | 'f32';

/** RGBA8 data texture bound as input 2 of a pass (rows in texture order: row 0 = first row of `data`). */
export interface DataTex {
  w: number;
  h: number;
  data: Uint8Array;
  digest: string;
}

export interface EffectPass {
  shader: string;
  pid: number;
  /** uP0..uP3, 16 floats */
  u: number[];
  fmt: PassFormat;
  /** pyramid level of the OUTPUT (0 = full size; L > 0: ceil(size / 2^L) + 3) */
  level?: number;
  /** data texture (curve / gradient / LUT / table) bound as input 2 */
  data?: DataTex;
  /** input 2 = the chain's aux image (displace by another layer / input) */
  aux?: boolean;
}

export const MAX_BLUR_PX = 600; // blur filter kernel half width cap (px) = 3 * the old adjustment blur sigma max (200); only reachable through `sigma`
export const MAX_RADIUS = 200; // blur size cap (px); sizes above PYR_THRESHOLD run as a down-sample pyramid
export const PYR_THRESHOLD = 16;
export const GLOBAL_REACH = 1 << 20; // extent of a filter that reads anywhere in the document
export const SEED_MOD = 1 << 24; // seeds are reduced to 0..2^24-1 so the float uniform holds them exactly

export const round = (x: number): number => Math.floor(x + 0.5);
/** Only finite JS numbers count (numeric strings, booleans, null -> default); effects.py `_num` does the same. */
export const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- blur pyramid

export function pyrLevel(px: number): number {
  const r = Math.ceil(px);
  let lv = 0;
  while (Math.floor((r + (1 << lv) - 1) / (1 << lv)) > PYR_THRESHOLD) lv++;
  return lv;
}

/** Blur size (px) -> [sigma, kernel radius, level] of the passes that really run (see effects.py `_blur_plan`); `sigma` > 0 replaces px / 3. */
export function blurPlan(px: number, sigma = 0): [number, number, number] {
  px = Math.min(sigma > 0 ? MAX_BLUR_PX : MAX_RADIUS, Math.max(0, px));
  const r = Math.ceil(px);
  const lv = pyrLevel(px);
  const sg = sigma > 0 ? sigma : px / 3;
  if (lv === 0) return [sg, r, 0];
  const s = 1 << lv;
  return [Math.sqrt(Math.max(sg * sg - (s * s) / 4, 0)) / s, Math.floor((r + s - 1) / s), lv];
}

/**
 * Canonical migration of a v6 Blur adjustment `{type:'blur', radius: r}` (gaussian sigma = r px, 0..200, edge pixels held outside the document) to the
 * blur filter: `{type:'blur', radius: k, sigma: r, edge:'hold'}`, k = 4r while that is <= 16 px (exact path, no 3-sigma truncation error), else min(200, 3r) (`radius` = the kernel half width the planner uses, shown in the UI; `sigma` is what runs).
 * r < 0.05 (the old identity) -> radius 0 / sigma 0 = no-op.  Mirrored by effects.py `legacy_blur_to_filter`.
 */
export function legacyBlurToFilter(radius: number): { enabled: true; type: 'blur'; radius: number; sigma: number; edge: 'hold' } {
  const r = Math.min(200, Math.max(0, num(radius, 0)));
  if (r < 0.05) return { enabled: true, type: 'blur', radius: 0, sigma: 0, edge: 'hold' };
  return { enabled: true, type: 'blur', radius: Math.min(200, 4 * r <= 16 ? 4 * r : 3 * r), sigma: r, edge: 'hold' };
}

export function blurReach(px: number, sigma = 0): number {
  const [, r, lv] = blurPlan(px, sigma);
  return lv === 0 ? r : (r + 2) * (1 << lv);
}

// ---------------------------------------------------------------- expression language

type Tok = ['n', number] | ['i', string] | ['o', string];
type Node =
  | ['n', number]
  | ['v', string]
  | ['u', string, Node]
  | ['b', string, Node, Node]
  | ['f', string, Node[]];

const TOK = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)|(==|!=|<=|>=|&&|\|\||[-+*/<>!(),]))/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  src = src.replace(/\s+$/, '');
  let pos = 0;
  while (pos < src.length) {
    TOK.lastIndex = pos;
    const m = TOK.exec(src);
    if (!m) throw new Error(`bad expression ${src} at ${pos}`);
    pos = TOK.lastIndex;
    if (m[1] !== undefined) out.push(['n', parseFloat(m[1])]);
    else if (m[2] !== undefined) out.push(['i', m[2]]);
    else out.push(['o', m[3]]);
  }
  return out;
}

class Parser {
  i = 0;
  constructor(private t: Tok[]) {}
  peek(): Tok | [null, null] {
    return this.i < this.t.length ? this.t[this.i] : [null, null];
  }
  eat(v?: string): Tok {
    const tok = this.peek();
    if (v !== undefined && tok[1] !== v) throw new Error('expected ' + v);
    this.i++;
    return tok as Tok;
  }
  parse(): Node {
    const n = this.or();
    if (this.i !== this.t.length) throw new Error('trailing tokens');
    return n;
  }
  bin(ops: string[], sub: () => Node): Node {
    let n = sub();
    while (this.peek()[0] === 'o' && ops.includes(this.peek()[1] as string)) {
      const op = this.eat()[1] as string;
      n = ['b', op, n, sub()];
    }
    return n;
  }
  or = (): Node => this.bin(['||'], this.and);
  and = (): Node => this.bin(['&&'], this.cmp);
  cmp = (): Node => {
    const n = this.add();
    if (this.peek()[0] === 'o' && ['==', '!=', '<', '>', '<=', '>='].includes(this.peek()[1] as string)) {
      const op = this.eat()[1] as string;
      return ['b', op, n, this.add()];
    }
    return n;
  };
  add = (): Node => this.bin(['+', '-'], this.mul);
  mul = (): Node => this.bin(['*', '/'], this.un);
  un = (): Node => {
    if (this.peek()[0] === 'o' && ['-', '!'].includes(this.peek()[1] as string)) {
      const op = this.eat()[1] as string;
      return ['u', op, this.un()];
    }
    return this.prim();
  };
  prim(): Node {
    const [k, v] = this.eat();
    if (k === 'n') return ['n', v as number];
    if (k === 'i') {
      const nx = this.peek();
      if (nx[0] === 'o' && nx[1] === '(') {
        this.eat();
        const args: Node[] = [];
        const cl = this.peek();
        if (!(cl[0] === 'o' && cl[1] === ')')) {
          args.push(this.or());
          while (this.peek()[0] === 'o' && this.peek()[1] === ',') {
            this.eat();
            args.push(this.or());
          }
        }
        this.eat(')');
        return ['f', v as string, args];
      }
      return ['v', v as string];
    }
    if (k === 'o' && v === '(') {
      const n = this.or();
      this.eat(')');
      return n;
    }
    throw new Error('unexpected token ' + String(v));
  }
}

const AST = new Map<string, Node>();
const fin = (x: number): number => (Number.isFinite(x) ? x : 0);

const FUNCS: Record<string, (...a: number[]) => number> = {
  abs: Math.abs,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  floor: Math.floor,
  ceil: Math.ceil,
  round: (x) => Math.floor(x + 0.5),
  sqrt: (x) => (x > 0 ? Math.sqrt(x) : 0),
  pow: (a, b) => fin(Math.pow(a, b)),
  exp: (x) => (x < 700 ? Math.exp(x) : 0),
  log: (x) => (x > 0 ? Math.log(x) : 0),
  sin: Math.sin,
  cos: Math.cos,
  tan: (x) => fin(Math.tan(x)),
  atan2: (a, b) => Math.atan2(a, b),
  rad: (x) => (x * Math.PI) / 180,
  deg: (x) => (x * 180) / Math.PI,
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  mix: (a, b, t) => a + (b - a) * t,
  if: (c, a, b) => (c !== 0 ? a : b),
  mod: (a, b) => (b !== 0 ? a - b * Math.floor(a / b) : 0),
  sign: (x) => (x > 0 ? 1 : x < 0 ? -1 : 0),
  fract: (x) => x - Math.floor(x),
  pyrL: (px) => pyrLevel(Math.min(MAX_BLUR_PX, Math.max(0, px))),
  blurSig: (px, sg = 0) => blurPlan(px, sg)[0],
  blurR: (px, sg = 0) => blurPlan(px, sg)[1],
  blurReach: (px, sg = 0) => blurReach(px, sg),
};
const CONSTS: Record<string, number> = { pi: Math.PI, G: GLOBAL_REACH, MAXR: MAX_RADIUS, SEEDMOD: SEED_MOD };

export type Env = Record<string, number>;
/** Extra (non numeric) environment parts: normalised lists / texts, kept beside the numbers. */
export interface Ctx {
  v: Env;
  lists: Record<string, unknown>;
  texts: Record<string, string>;
}

function evalNode(n: Node, env: Env): number {
  switch (n[0]) {
    case 'n':
      return n[1];
    case 'v': {
      const name = n[1];
      if (name in env) return env[name];
      if (name in CONSTS) return CONSTS[name];
      throw new Error('unknown name ' + name);
    }
    case 'u': {
      const x = evalNode(n[2], env);
      return n[1] === '-' ? -x : x === 0 ? 1 : 0;
    }
    case 'b': {
      const op = n[1];
      const a = evalNode(n[2], env);
      const b = evalNode(n[3], env);
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b !== 0 ? a / b : 0;
        case '&&': return a !== 0 && b !== 0 ? 1 : 0;
        case '||': return a !== 0 || b !== 0 ? 1 : 0;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        default: return a >= b ? 1 : 0;
      }
    }
    default: {
      const fn = FUNCS[n[1]];
      if (!fn) throw new Error('unknown function ' + n[1]);
      return fin(fn(...n[2].map((a) => evalNode(a, env))));
    }
  }
}

/** Evaluates an expression string (numbers, names, + - * / comparisons && || !, functions) -> finite number. */
export function ev(src: string | number | boolean, env: Env): number {
  if (typeof src === 'boolean') return src ? 1 : 0;
  if (typeof src === 'number') return src;
  let ast = AST.get(src);
  if (!ast) {
    ast = new Parser(tokenize(src)).parse();
    AST.set(src, ast);
  }
  return fin(evalNode(ast, env));
}

// ---------------------------------------------------------------- spec types

export interface ParamSpec {
  kind?: 'num' | 'seed' | 'bool' | 'enum' | 'color' | 'points' | 'stops' | 'list' | 'text';
  default?: unknown;
  min?: number;
  max?: number;
  round?: boolean;
  values?: string[];
  len?: number;
  cube?: boolean;
  unit?: string;
  doc?: string;
}
export interface PassSpec {
  shader?: string;
  pass?: string | number;
  level?: string | number;
  fmt?: PassFormat;
  u?: (string | number)[];
  aux?: boolean;
  data?: { gen: 'curves' | 'gradient' | 'table' | 'cube'; args: string[] };
  when?: string;
  repeat?: { var: string; count: string };
  /** the passes of another spec with numeric parameter overrides (expressions) */
  sub?: string;
  with?: Record<string, string | number>;
  passes?: PassSpec[];
}
export interface FilterSpec {
  type: string;
  group?: string;
  doc?: string;
  /** false: no <type>.glsl of its own (reuses other filters' shaders) */
  glsl?: boolean;
  include?: string[];
  /** every pass of this shader gets input 2 (data texture / aux image / dummy) */
  in2?: boolean;
  reads?: 'point' | 'neighbourhood' | 'global';
  /** expression: nonzero -> reads is 'global' for those parameters */
  readsGlobal?: string;
  /** true / false / expression: the browser preview cannot match TD within tolerance -> UI shows TD's render */
  tdPreview?: boolean | string;
  /** maps fully transparent input pixels to fully transparent output pixels */
  preservesTransparent?: boolean;
  params?: Record<string, ParamSpec>;
  vars?: [string, string][];
  noop?: string;
  passes: PassSpec[];
  extent?: string[];
  samples?: Record<string, unknown>[];
  degenerate?: Record<string, unknown>[];
}

// ---------------------------------------------------------------- parameter normalisation

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampf = (v: number, lo?: number, hi?: number): number => {
  if (lo !== undefined) v = Math.max(lo, v);
  if (hi !== undefined) v = Math.min(hi, v);
  return v;
};
const comp = (c: unknown, k: string, d: number): number => {
  const v = c && typeof c === 'object' ? (c as Record<string, unknown>)[k] : undefined;
  return isNum(v) ? Math.min(255, Math.max(0, v)) : d;
};

type Pt = [number, number];
function normPoints(v: unknown): Pt[] {
  const m = new Map<number, number>();
  const arr = Array.isArray(v) ? v.slice(0, 64) : [];
  for (let q of arr) {
    if (q && typeof q === 'object' && !Array.isArray(q)) q = [(q as Record<string, unknown>).x, (q as Record<string, unknown>).y];
    if (!(Array.isArray(q) && q.length >= 2 && isNum(q[0]) && isNum(q[1]))) continue;
    m.set(clamp01(q[0]), clamp01(q[1]));
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).slice(0, 32);
}
type Stop = [number, number[]];
function normStops(v: unknown, def: unknown): Stop[] {
  const out: Stop[] = [];
  const arr = Array.isArray(v) ? v.slice(0, 32) : [];
  for (const q of arr) {
    if (q && typeof q === 'object' && isNum((q as Record<string, unknown>).pos)) {
      const o = q as Record<string, unknown>;
      const c = o.color && typeof o.color === 'object' ? o.color : {};
      out.push([clamp01(o.pos as number), [...'rgba'].map((k) => comp(c, k, k === 'a' ? 255 : 0) / 255)]);
    }
  }
  if (!out.length) for (const [p, c] of (def as [number, unknown][]) ?? []) out.push([p, [...'rgba'].map((k) => comp(c, k, k === 'a' ? 255 : 0) / 255)]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** Effect object -> evaluation context (numbers by name, `colour.r` style components, normalised lists / texts). */
export function normParams(spec: FilterSpec, e: Record<string, unknown>): Ctx {
  const v: Env = {};
  const lists: Record<string, unknown> = {};
  const texts: Record<string, string> = {};
  for (const [name, d] of Object.entries(spec.params ?? {})) {
    const k = d.kind ?? 'num';
    const raw = e[name];
    if (k === 'num' || k === 'seed') {
      let x = num(raw, num(d.default, 0));
      if (d.round || k === 'seed') x = round(x);
      if (k === 'seed') x = ((x % SEED_MOD) + SEED_MOD) % SEED_MOD;
      v[name] = clampf(x, d.min, d.max);
    } else if (k === 'bool') {
      v[name] = raw === true ? 1 : raw === false ? 0 : d.default ? 1 : 0;
    } else if (k === 'enum') {
      const vals = d.values as string[];
      const i = typeof raw === 'string' ? vals.indexOf(raw) : -1;
      v[name] = i >= 0 ? i : vals.indexOf(d.default as string);
    } else if (k === 'color') {
      const dc = (d.default as Record<string, number>) ?? { r: 0, g: 0, b: 0, a: 255 };
      const c = raw && typeof raw === 'object' ? raw : {};
      for (const ch of 'rgba') v[name + '.' + ch] = comp(c, ch, dc[ch] ?? (ch === 'a' ? 255 : 0)) / 255;
    } else if (k === 'points') {
      const pts = Array.isArray(raw) ? normPoints(raw) : ((d.default as number[][]) ?? [[0, 0], [1, 1]]).map((p) => [p[0], p[1]] as Pt);
      lists[name] = pts;
      v[name + '.n'] = pts.length;
    } else if (k === 'stops') {
      lists[name] = normStops(raw, d.default ?? [[0, { r: 0, g: 0, b: 0 }], [1, { r: 255, g: 255, b: 255 }]]);
    } else if (k === 'list') {
      const n = d.len ?? 16;
      const lo = d.min ?? -1;
      const hi = d.max ?? 1;
      const vals = (Array.isArray(raw) ? raw.slice(0, n) : []).map((x) => (isNum(x) ? x : 0));
      const out = vals.map((x) => Math.min(hi, Math.max(lo, x)));
      while (out.length < n) out.push(0);
      lists[name] = out;
    } else if (k === 'text') {
      texts[name] = typeof raw === 'string' ? raw : '';
    } else throw new Error('param kind ' + k);
  }
  return { v, lists, texts };
}

// ---------------------------------------------------------------- data generators

const q8 = (x: number): number => Math.floor(Math.min(1, Math.max(0, x)) * 255 + 0.5);

let crcTable: Uint32Array | undefined;
function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeData(w: number, h: number, data: Uint8Array): DataTex {
  return { w, h, data, digest: `${w}x${h}:${crc32(data).toString(16).padStart(8, '0')}` };
}

function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  if (n === 2) return [d[0], d[0]];
  const m = new Array<number>(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] > 0) {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  const end = (h0: number, h1: number, d0: number, d1: number): number => {
    const v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (v > 0 !== d0 > 0 || v === 0) return 0;
    if (d0 > 0 !== d1 > 0 && Math.abs(v) > 3 * Math.abs(d0)) return 3 * d0;
    return v;
  };
  m[0] = end(h[0], h[1], d[0], d[1]);
  m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

/** 256 curve values (monotone cubic / PCHIP through the control points, flat outside the first / last point). */
export function curveEvalTable(points: Pt[]): number[] {
  const out: number[] = [];
  if (!points.length) {
    for (let i = 0; i < 256; i++) out.push(i / 255);
    return out;
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  if (points.length === 1) return new Array<number>(256).fill(ys[0]);
  const m = pchipSlopes(xs, ys);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    if (x <= xs[0]) out.push(ys[0]);
    else if (x >= xs[xs.length - 1]) out.push(ys[ys.length - 1]);
    else {
      let k = 0;
      while (xs[k + 1] < x) k++;
      const h = xs[k + 1] - xs[k];
      const t = (x - xs[k]) / h;
      const t2 = t * t;
      const t3 = t * t * t;
      const v = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
      out.push(Math.min(1, Math.max(0, v)));
    }
  }
  return out;
}

type Gen = (c: Ctx, args: string[]) => DataTex | null;
const genCurves: Gen = (c, args) => {
  const tabs = args.map((a) => curveEvalTable(c.lists[a] as Pt[]));
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const mi = Math.min(255, Math.max(0, Math.floor(tabs[0][i] * 255 + 0.5)));
    data[i * 4] = q8(tabs[1][mi]);
    data[i * 4 + 1] = q8(tabs[2][mi]);
    data[i * 4 + 2] = q8(tabs[3][mi]);
    data[i * 4 + 3] = 255;
  }
  return makeData(256, 1, data);
};
const genGradient: Gen = (c, args) => {
  const st = c.lists[args[0]] as Stop[];
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let col: number[];
    if (t <= st[0][0]) col = st[0][1];
    else if (t >= st[st.length - 1][0]) col = st[st.length - 1][1];
    else {
      let k = 0;
      while (st[k + 1][0] < t) k++;
      const p0 = st[k];
      const p1 = st[k + 1];
      const w = p1[0] > p0[0] ? (t - p0[0]) / (p1[0] - p0[0]) : 1;
      col = [0, 1, 2, 3].map((j) => p0[1][j] + (p1[1][j] - p0[1][j]) * w);
    }
    for (let j = 0; j < 4; j++) data[i * 4 + j] = q8(col[j]);
  }
  return makeData(256, 1, data);
};
/** Signed values -1..1 of a list parameter -> RGBA8 N/4 x 1 texture, byte = round((v + 1) * 127.5). */
const genTable: Gen = (c, args) => {
  const v = (c.lists[args[0]] as number[]).slice();
  while (v.length % 4) v.push(0);
  return makeData(v.length / 4, 1, Uint8Array.from(v.map((x) => Math.floor((x + 1) * 127.5 + 0.5))));
};

export interface Cube {
  size: number;
  dmin: number[];
  dmax: number[];
  data: number[];
}
const NUM_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const INT_RE = /^[+-]?[0-9]+$/;
export const CUBE_MAX_CHARS = 12_000_000;
const CUBE_MAX_VALUES = 64 ** 3 * 3;
/**
 * Adobe / Resolve `.cube` (3D only) -> parsed LUT, or null when invalid / unsupported.  Same rules as effects.py parse_cube: optional BOM,
 * lines split on CRLF / CR / LF, tokens split on spaces / tabs, ASCII numbers only (no nan / inf / underscores), '#' comments,
 * LUT_3D_INPUT_RANGE a b = DOMAIN_MIN/MAX (a a a)/(b b b) (last one wins), text <= 12 MB, parsing stops at the first value beyond 64^3 * 3.
 */
export function parseCube(text: string): Cube | null {
  if (typeof text !== 'string' || text.length > CUBE_MAX_CHARS) return null;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let size = 0;
  let dmin = [0, 0, 0];
  let dmax = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.split('#', 1)[0].replace(/^[ \t]+|[ \t]+$/g, '');
    if (!line) continue;
    const w = line.split(/[ \t]+/);
    const key = w[0].toUpperCase();
    if (key === 'LUT_3D_SIZE') {
      if (w.length < 2 || !INT_RE.test(w[1])) return null;
      size = parseInt(w[1], 10);
    } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      if (w.length < 4 || !w.slice(1, 4).every((x) => NUM_RE.test(x))) return null;
      const v = w.slice(1, 4).map(Number);
      if (key === 'DOMAIN_MIN') dmin = v;
      else dmax = v;
    } else if (key === 'LUT_3D_INPUT_RANGE') {
      if (w.length < 3 || !w.slice(1, 3).every((x) => NUM_RE.test(x))) return null;
      dmin = [Number(w[1]), Number(w[1]), Number(w[1])];
      dmax = [Number(w[2]), Number(w[2]), Number(w[2])];
    } else if (key === 'LUT_1D_SIZE') return null;
    else if (key === 'TITLE' || key === 'LUT_1D_INPUT_RANGE') continue;
    else {
      if (w.length !== 3 || !w.every((x) => NUM_RE.test(x))) return null;
      vals.push(Number(w[0]), Number(w[1]), Number(w[2]));
      if (vals.length > CUBE_MAX_VALUES) return null;
    }
  }
  if (!(size >= 2 && size <= 64) || vals.length !== size ** 3 * 3) return null;
  if (![...vals, ...dmin, ...dmax].every(Number.isFinite)) return null;
  if (dmax.some((x, i) => x <= dmin[i])) return null;
  return { size, dmin, dmax, data: vals };
}

export function cubeAtlasLayout(n: number): [number, number, number] {
  const g = Math.ceil(Math.sqrt(n));
  return [g, g * n, g * n];
}

export interface CubeAtlas {
  tex: DataTex;
  size: number;
  g: number;
  dmin: number[];
  dmax: number[];
}
const cubeCache = new Map<string, CubeAtlas | null>();
const CUBE_CACHE_SIZE = 32;
/** Atlas of a `.cube` text (cached): g x g tiles of n x n texels, tile b = blue slice (tile column b % g, row floor(b / g)), texel (red, green). */
export function cubeAtlas(text: string): CubeAtlas | null {
  if (cubeCache.has(text)) {
    const hit = cubeCache.get(text)!;
    cubeCache.delete(text); // LRU: most recently used last
    cubeCache.set(text, hit);
    return hit;
  }
  const c = parseCube(text);
  let res: CubeAtlas | null = null;
  if (c) {
    const n = c.size;
    const [g, w, h] = cubeAtlasLayout(n);
    const buf = new Uint8Array(w * h * 4);
    for (let b = 0; b < n; b++) {
      const tx = b % g;
      const ty = Math.floor(b / g);
      for (let gg = 0; gg < n; gg++)
        for (let r = 0; r < n; r++) {
          const o = ((ty * n + gg) * w + tx * n + r) * 4;
          const s = ((b * n + gg) * n + r) * 3;
          buf[o] = q8(c.data[s]);
          buf[o + 1] = q8(c.data[s + 1]);
          buf[o + 2] = q8(c.data[s + 2]);
          buf[o + 3] = 255;
        }
    }
    res = { tex: makeData(w, h, buf), size: n, g, dmin: c.dmin, dmax: c.dmax };
  }
  cubeCache.set(text, res);
  while (cubeCache.size > CUBE_CACHE_SIZE) cubeCache.delete(cubeCache.keys().next().value as string);
  return res;
}
const genCube: Gen = (c, args) => cubeAtlas(c.texts[args[0]])?.tex ?? null;

const GENS: Record<string, Gen> = { curves: genCurves, gradient: genGradient, table: genTable, cube: genCube };

// ---------------------------------------------------------------- planning from a spec

const specModules = import.meta.glob('../../../../shared/effects/*.filter.json', { eager: true, import: 'default' }) as Record<string, FilterSpec>;
/** type -> spec (shared/effects/<type>.filter.json) */
export const FILTER_SPECS: Record<string, FilterSpec> = {};
for (const sp of Object.values(specModules)) FILTER_SPECS[sp.type] = sp;

export const isFilterType = (t: unknown): boolean => typeof t === 'string' && Object.prototype.hasOwnProperty.call(FILTER_SPECS, t);

const enabled = (e: Record<string, unknown>): boolean => !!e && e.enabled !== false;

function specEnv(spec: FilterSpec, e: Record<string, unknown>): Ctx {
  const c = normParams(spec, e);
  for (const [name, d] of Object.entries(spec.params ?? {})) {
    if (d.kind === 'text' && d.cube) {
      const r = cubeAtlas(c.texts[name]);
      c.v[name + '.ok'] = r ? 1 : 0;
      c.v[name + '.n'] = r ? r.size : 0;
      c.v[name + '.g'] = r ? r.g : 0;
      [...'rgb'].forEach((ch, i) => {
        c.v[name + '.min.' + ch] = r ? r.dmin[i] : 0;
        c.v[name + '.max.' + ch] = r ? r.dmax[i] : 1;
      });
    }
  }
  for (const [name, expr] of spec.vars ?? []) c.v[name] = ev(expr, c.v);
  return c;
}

const padU = (u: number[]): number[] => {
  if (u.length > 16) throw new Error('a pass has at most 16 uniform floats');
  return u.concat(new Array(16 - u.length).fill(0));
};

function expand(spec: FilterSpec, ents: PassSpec[], ctx: Ctx, out: EffectPass[]): void {
  for (const ent of ents) {
    if (ent.when !== undefined && ev(ent.when, ctx.v) === 0) continue;
    if (ent.sub) {
      // the passes of another spec (e.g. "blur") with numeric parameter overrides
      const sp = FILTER_SPECS[ent.sub];
      const ov: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(ent.with ?? {})) ov[k] = ev(x, ctx.v);
      const c2 = specEnv(sp, ov);
      if (!(sp.noop && ev(sp.noop, c2.v) !== 0)) expand(sp, sp.passes, c2, out);
      continue;
    }
    if (ent.repeat) {
      const n = Math.max(0, Math.min(256, Math.floor(ev(ent.repeat.count, ctx.v))));
      for (let i = 0; i < n; i++) expand(spec, ent.passes ?? [], { ...ctx, v: { ...ctx.v, [ent.repeat.var]: i } }, out);
      continue;
    }
    const u = (ent.u ?? []).map((x) => ev(x, ctx.v));
    let data: DataTex | undefined;
    if (ent.data) {
      const d = GENS[ent.data.gen](ctx, ent.data.args);
      if (!d) continue;
      data = d;
    }
    const p: EffectPass = {
      shader: ent.shader ?? spec.type,
      pid: Math.trunc(ev(ent.pass ?? 0, ctx.v)),
      u: padU(u),
      fmt: ent.fmt ?? 'f16',
    };
    const lv = Math.trunc(ev(ent.level ?? 0, ctx.v));
    if (lv) p.level = lv;
    if (data) p.data = data;
    if (ent.aux) p.aux = true;
    out.push(p);
  }
}

export function planFilter(e: Record<string, unknown>): EffectPass[] {
  const spec = e ? FILTER_SPECS[e.type as string] : undefined;
  if (!spec || !enabled(e)) return [];
  const ctx = specEnv(spec, e);
  if (spec.noop && ev(spec.noop, ctx.v) !== 0) return [];
  const out: EffectPass[] = [];
  expand(spec, spec.passes, ctx, out);
  return out;
}

export function filterExtent(e: Record<string, unknown>): [number, number, number, number] {
  const spec = FILTER_SPECS[e.type as string];
  const ctx = specEnv(spec, e);
  const x = spec.extent ?? ['0', '0', '0', '0'];
  return x.map((s) => Math.max(0, Math.ceil(ev(s, ctx.v)))) as [number, number, number, number];
}

/** shader name -> does every pass need input 2 */
export function shaderUsesInput2(name: string): boolean {
  return !!FILTER_SPECS[name]?.in2;
}

/** Sync part of the `tdPreview` / `reads` API (the v5 effects are handled in plan.ts). */
export function filterTdPreview(e: Record<string, unknown>, hasPasses: boolean): boolean {
  const spec = e ? FILTER_SPECS[e.type as string] : undefined;
  if (!spec || !hasPasses) return false;
  const v = spec.tdPreview ?? false;
  return typeof v === 'string' ? ev(v, specEnv(spec, e).v) !== 0 : !!v;
}

export function filterReads(e: Record<string, unknown>): 'point' | 'neighbourhood' | 'global' {
  const spec = FILTER_SPECS[e.type as string];
  if (spec.readsGlobal && ev(spec.readsGlobal, specEnv(spec, e).v) !== 0) return 'global';
  return spec.reads ?? 'point';
}
