// TypeScript port of td/raster_editor/shape.glsl (the SDF shape renderer of the TouchDesigner side), so the page's
// preview and rasterized surfaces are produced by the SAME maths as TD (docs/DESIGN_V3.md section 2.2 / 3).
//
// Everything below follows the shader line by line: TD pixel space (origin bottom-left, y up, pixel centres at
// +0.5; document y-down coordinates are flipped with q.y = docH - (py + 0.5)), rotation uniform = -radians(deg)
// (clockwise on screen), round-box / Eberly ellipse / polygon-star / triangle+body line union signed distances,
// stroke = centred band |d| - width/2 with round joins, coverage = clamp(0.5 - d, 0, 1) with 4x4 supersampling of
// the distance ramps within 1.5 px of an edge, stroke composited over the fill in premultiplied space.
// `shapeUniforms` mirrors td/raster_editor/network.py shape_uniforms.
//
// Speed: the field is 1-Lipschitz, so along a row a pixel whose |distance| is m >= 1.5 lets the next
// floor(m - 1.5) pixels be filled with the same flat colour without evaluating anything; only edge pixels pay
// for the 16 supersamples. The result is rendered into an ImageData over the (document-clipped) shape bounds and
// kept in a canvas cache keyed by the (immutable) spec object, so unchanged shapes are not re-rasterised.

import type { RGBA, ShapeSpec } from './types';
import type { Ctx2D, Surface } from './surface';
import { createSurface, releaseSurface } from './surface';
import { drawShape, shapeBounds, translateShape } from './textShape';

export type ShapeRenderer = 'sdf' | 'canvas';

export interface ShapeUniforms {
  type: number; // 1 rect, 2 ellipse, 3 line, 4 polygon
  rot: number; // radians, counter-clockwise in TD space
  fillOn: boolean;
  strokeOn: boolean;
  off: [number, number, number, number]; // uOffset
  a: [number, number, number, number]; // uA
  fill: [number, number, number, number]; // straight rgba 0..1
  stroke: [number, number, number, number];
}

const rgba01 = (c: RGBA | undefined): [number, number, number, number] => {
  const o = c ?? { r: 0, g: 0, b: 0, a: 255 };
  return [o.r / 255, o.g / 255, o.b / 255, o.a / 255];
};

/** ShapeSpec (document px, y down, degrees clockwise) -> shader uniforms (TD px, y up, radians counter-clockwise). */
export function shapeUniforms(spec: ShapeSpec, docH: number): ShapeUniforms {
  const t = spec.type;
  const sw = Math.max(0, spec.stroke?.width ?? 0);
  const fillOn = t !== 'line' && !!spec.fill?.enabled;
  const strokeOn = !!spec.stroke?.enabled && (sw > 0 || t === 'line');
  const u: ShapeUniforms = {
    type: t === 'rect' ? 1 : t === 'ellipse' ? 2 : t === 'line' ? 3 : 4,
    rot: t === 'line' ? 0 : -(((spec as { rotation?: number }).rotation || 0) * Math.PI) / 180,
    fillOn, strokeOn, off: [0, 0, 0, 0], a: [0, 0, sw, 0],
    fill: rgba01(t === 'line' ? undefined : spec.fill?.color), stroke: rgba01(spec.stroke?.color),
  };
  if (spec.type === 'rect' || spec.type === 'ellipse') {
    const w = Math.abs(spec.w);
    const h = Math.abs(spec.h);
    const x = spec.x + (spec.w < 0 ? spec.w : 0);
    const y = spec.y + (spec.h < 0 ? spec.h : 0);
    u.off = [x + w / 2, docH - (y + h / 2), w / 2, h / 2];
    if (spec.type === 'rect') u.a[0] = Math.max(0, Math.min(spec.radius || 0, w / 2, h / 2));
  } else if (spec.type === 'line') {
    u.off = [spec.x1, docH - spec.y1, spec.x2, docH - spec.y2];
    u.a[3] = (spec.arrowStart ? 1 : 0) + (spec.arrowEnd ? 2 : 0);
  } else {
    u.off = [spec.cx, docH - spec.cy, Math.max(0, spec.radius), Math.min(1, Math.max(0.05, spec.innerRatio))];
    u.a[1] = Math.min(64, Math.max(3, Math.round(spec.sides)));
  }
  return u;
}

// ---- distance functions (scalar, allocation free) ----

const hyp = (x: number, y: number): number => Math.sqrt(x * x + y * y); // Math.hypot is far slower in V8

function sdRoundBox(px: number, py: number, hx: number, hy: number, r: number): number {
  r = Math.min(r, Math.min(hx, hy));
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return hyp(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

let lastRoot = 0;

/** Same root as the shader's bisection (to ~1e-10), found with a bracketed Newton iteration (a few steps, not ~50). */
function eberlyRoot(r0: number, z0: number, z1: number, g: number): number {
  const n0 = r0 * z0;
  let s0 = z1 - 1;
  let s1 = g < 0 ? 0 : hyp(n0, z1) - 1;
  // start from the previous root when it lies in the bracket (neighbouring samples have nearly the same root)
  let s = lastRoot > s0 && lastRoot < s1 ? lastRoot : s0;
  for (let i = 0; i < 60; i++) {
    const ra = n0 / (s + r0);
    const rb = z1 / (s + 1);
    const gg = ra * ra + rb * rb - 1;
    if (gg > 0) s0 = s;
    else if (gg < 0) s1 = s;
    else break;
    const dg = -2 * ((ra * ra) / (s + r0) + (rb * rb) / (s + 1));
    let sn = s - gg / dg;
    if (!(sn > s0 && sn < s1)) sn = 0.5 * (s0 + s1);
    const done = Math.abs(sn - s) <= 1e-10 * (1 + Math.abs(s));
    s = sn;
    if (done) break;
  }
  lastRoot = s;
  return s;
}

function sdEllipse(px: number, py: number, rx: number, ry: number, margin: number): number {
  rx = Math.max(rx, 1e-3);
  ry = Math.max(ry, 1e-3);
  const qx = Math.abs(px);
  const qy = Math.abs(py);
  const rm = Math.min(rx, ry);
  if (hyp(qx, qy) < rm - margin) return hyp(qx, qy) - rm;
  if (qx > rx + margin || qy > ry + margin) return hyp(Math.max(qx - rx, 0), Math.max(qy - ry, 0));
  const sw = rx < ry;
  const ex = sw ? ry : rx;
  const ey = sw ? rx : ry;
  const yx = sw ? qy : qx;
  const yy = sw ? qx : qy;
  let dist: number;
  if (yy > 0) {
    if (yx > 0) {
      const zx = yx / ex;
      const zy = yy / ey;
      const g = zx * zx + zy * zy - 1;
      if (Math.abs(g) < 1e-9) dist = 0;
      else {
        const r0 = (ex / ey) * (ex / ey);
        const sb = eberlyRoot(r0, zx, zy, g);
        const x0 = (r0 * yx) / (sb + r0);
        const x1 = yy / (sb + 1);
        dist = hyp(x0 - yx, x1 - yy);
      }
    } else dist = Math.abs(yy - ey);
  } else {
    const numer0 = ex * yx;
    const denom0 = ex * ex - ey * ey;
    if (numer0 < denom0) {
      const xde0 = numer0 / denom0;
      const x0 = ex * xde0;
      const x1 = ey * Math.sqrt(Math.max(0, 1 - xde0 * xde0));
      dist = hyp(x0 - yx, x1);
    } else dist = Math.abs(yx - ex);
  }
  const kx = qx / rx;
  const ky = qy / ry;
  return kx * kx + ky * ky < 1 ? -dist : dist;
}

function sdTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const e0x = bx - ax, e0y = by - ay, e1x = cx - bx, e1y = cy - by, e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay, v1x = px - bx, v1y = py - by, v2x = px - cx, v2y = py - cy;
  const t0 = Math.min(1, Math.max(0, (v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y)));
  const t1 = Math.min(1, Math.max(0, (v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y)));
  const t2 = Math.min(1, Math.max(0, (v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y)));
  const p0x = v0x - e0x * t0, p0y = v0y - e0y * t0;
  const p1x = v1x - e1x * t1, p1y = v1y - e1y * t1;
  const p2x = v2x - e2x * t2, p2y = v2y - e2y * t2;
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const dx = Math.min(p0x * p0x + p0y * p0y, p1x * p1x + p1y * p1y, p2x * p2x + p2y * p2y);
  const dy = Math.min(s * (v0x * e0y - v0y * e0x), s * (v1x * e1y - v1y * e1x), s * (v2x * e2y - v2y * e2x));
  return -Math.sqrt(dx) * Math.sign(dy);
}

function sdBody(px: number, py: number, ax: number, ay: number, bx: number, by: number, hw: number): number {
  const bax = bx - ax;
  const bay = by - ay;
  const l = hyp(bax, bay);
  if (l < 1e-6) return 1e5;
  const ux = bax / l;
  const uy = bay / l;
  const qx0 = px - (ax + bx) * 0.5;
  const qy0 = py - (ay + by) * 0.5;
  return sdRoundBox(qx0 * ux + qy0 * uy, qx0 * -uy + qy0 * ux, l * 0.5, hw, 0);
}

/** Polygon / star vertices in TD space relative to the centre (flat x, y pairs, m entries, closed implicitly). */
export function polyVertices(n: number, R: number, inner: number, star: boolean): Float64Array {
  const m = star ? 2 * n : n;
  const v = new Float64Array(m * 2);
  for (let k = 0; k < m; k++) {
    const a = Math.PI * 0.5 - (k * 2 * Math.PI) / m;
    const r = star && (k & 1) === 1 ? R * inner : R;
    v[k * 2] = Math.cos(a) * r;
    v[k * 2 + 1] = Math.sin(a) * r;
  }
  return v;
}

/** The shader's O(m) polygon / star distance (kept as the reference for the folded version). */
export function sdPolygonFull(px: number, py: number, v: Float64Array): number {
  const m = v.length / 2;
  const v0x = v[0], v0y = v[1];
  let prevx = v0x, prevy = v0y;
  let d = (px - v0x) * (px - v0x) + (py - v0y) * (py - v0y);
  let s = 1;
  for (let i = 1; i <= m; i++) {
    const curx = i === m ? v0x : v[i * 2];
    const cury = i === m ? v0y : v[i * 2 + 1];
    const ex = prevx - curx, ey = prevy - cury;
    const wx = px - curx, wy = py - cury;
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c0 = py >= cury, c1 = py < prevy, c2 = ex * wy > ey * wx;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) s = -s;
    prevx = curx;
    prevy = cury;
  }
  return s * Math.sqrt(d);
}


/**
 * Polygons and stars are n-fold rotationally symmetric with mirror lines through the vertices: fold the point into the
 * wedge [0, pi/n] around vertex 0 (the nearest boundary point of a point inside a mirror-bounded wedge lies in that
 * wedge) and measure the distance to the single edge V0 -> E there. Same value as `sdPolygonFull`, O(1) per sample.
 * `sd` also leaves the analytic gradient (`gx`, `gy`, polygon frame) and `planar`: true when the nearest boundary
 * point is strictly inside the edge and no mirror line (a possible distance ridge) is within 0.6 px, i.e. the field is
 * exactly a plane (|grad| = 1) over the whole 0.54 px sample footprint of the pixel.
 */
/** atan2 to ~1e-4 rad (polynomial); only used to pick a sector, which is then verified exactly. */
function fastAtan2(y: number, x: number): number {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const mx = ax > ay ? ax : ay;
  if (mx === 0) return 0;
  const a = (ax > ay ? ay : ax) / mx;
  const q = a * a;
  let r = (((-0.0464964749 * q + 0.15931422) * q - 0.327622764) * q * a) + a;
  if (ay > ax) r = Math.PI / 2 - r;
  if (x < 0) r = Math.PI - r;
  return y < 0 ? -r : r;
}

export class FoldedPolygon {
  private sector: number;
  private n: number;
  private v0x: number;
  private ex: number;
  private ey: number;
  private sO: number;
  private cosK: Float64Array;
  private sinK: Float64Array;
  private cb: number;
  private sb: number;
  private c2: number;
  private s2: number;
  private star: boolean;
  private hm: number;
  readonly edgeLen: number;
  gx = 0;
  gy = 0;
  planar = false;

  constructor(n: number, R: number, inner: number, star: boolean) {
    this.n = n;
    this.star = star;
    this.sector = (2 * Math.PI) / n;
    this.v0x = R;
    const ang = star ? this.sector / 2 : this.sector;
    const rad = star ? R * inner : R;
    this.ex = Math.cos(ang) * rad;
    this.ey = Math.sin(ang) * rad;
    this.sO = Math.sign(this.ey * R); // origin side of the edge line
    this.edgeLen = hyp(this.ex - R, this.ey);
    this.hm = 0.7 / Math.max(this.edgeLen, 1e-9);
    this.cosK = new Float64Array(n);
    this.sinK = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cosK[i] = Math.cos(i * this.sector);
      this.sinK[i] = Math.sin(i * this.sector);
    }
    this.cb = Math.cos(this.sector / 2);
    this.sb = Math.sin(this.sector / 2);
    this.c2 = Math.cos(this.sector);
    this.s2 = Math.sin(this.sector);
  }

  // state of the last `sd` call, consumed by `analyse`
  private sc = 0;
  private ss = 0;
  private refl = false;
  private fx = 0;
  private fy = 0;
  private ddx = 0;
  private ddy = 0;
  private dist = 0;
  private inside = false;
  private hRaw = 0;

  /** px, py in the frame of the polygon (TD space, rotation removed, centre at the origin). */
  sd(px: number, py: number): number {
    // u: vertex 0 (pointing up in TD space) along +x
    const ux = py;
    const uy = -px;
    let k = Math.floor(fastAtan2(uy, ux) / this.sector); // ~1e-4 rad: the sector is verified below
    let idx = k < 0 ? (k % this.n) + this.n : k % this.n;
    let c = this.cosK[idx];
    let s = this.sinK[idx];
    let vx = ux * c + uy * s; // rotate by -k * sector
    let vy = -ux * s + uy * c;
    const off = vy < 0 ? -1 : vy * this.c2 - vx * this.s2 > 0 ? 1 : 0; // landed in a neighbouring sector
    if (off !== 0) {
      k += off;
      idx = k < 0 ? (k % this.n) + this.n : k % this.n;
      c = this.cosK[idx];
      s = this.sinK[idx];
      vx = ux * c + uy * s;
      vy = -ux * s + uy * c;
    }
    const refl = vy * this.cb - vx * this.sb > 0; // beyond the bisector: mirror it back
    if (refl) {
      const nx = vx * this.c2 + vy * this.s2;
      vy = vx * this.s2 - vy * this.c2;
      vx = nx;
    }
    const ax = this.ex - this.v0x;
    const wx = vx - this.v0x;
    const hRaw = (wx * ax + vy * this.ey) / (ax * ax + this.ey * this.ey);
    const h = hRaw < 0 ? 0 : hRaw > 1 ? 1 : hRaw;
    const dx = wx - ax * h;
    const dy = vy - this.ey * h;
    const dist = hyp(dx, dy);
    const inside = Math.sign(ax * vy - this.ey * wx) === this.sO;
    this.sc = c; this.ss = s; this.refl = refl; this.fx = vx; this.fy = vy; this.ddx = dx; this.ddy = dy;
    this.dist = dist; this.inside = inside; this.hRaw = hRaw;
    return inside ? -dist : dist;
  }

  /** Gradient (`gx`, `gy`) and `planar` of the last `sd` call (see the class comment). */
  analyse(): boolean {
    const dist = this.dist;
    if (!(dist > 1e-9)) return (this.planar = false);
    let gfx = (this.inside ? -this.ddx : this.ddx) / dist;
    let gfy = (this.inside ? -this.ddy : this.ddy) / dist;
    if (this.refl) {
      const nx = gfx * this.c2 + gfy * this.s2;
      gfy = gfx * this.s2 - gfy * this.c2;
      gfx = nx;
    }
    const rx = gfx * this.sc - gfy * this.ss; // rotate by +k * sector
    const ry = gfx * this.ss + gfy * this.sc;
    this.gx = -ry; // back from u = (py, -px)
    this.gy = rx;
    // perpendicular distance to the vertex ray (after folding) and to the bisector line
    const ridge = this.fy;
    const bis = -(this.fy * this.cb - this.fx * this.sb);
    return (this.planar = this.hRaw > this.hm && this.hRaw < 1 - this.hm && ridge > 0.6 && (!this.star || bis > 0.6));
  }
}

/** A prepared shape: `field(qx, qy)` writes the fill / stroke signed distances to `fd` / `sd`. */
class Field {
  fd = 1e5;
  sd = 1e5;
  d = 1e5; // the shape's own signed distance (rect / ellipse / polygon), before fill / stroke
  /** Analytic plane at the last evaluation (polygons / stars): gradient of `d` in q space, valid when `planar`. */
  polyUsed = false; // the last evaluation went through the exact folded polygon distance
  pgx = 0;
  pgy = 0;
  /** Analyse the last (polygon) evaluation: true when the field is an exact plane around it; sets pgx / pgy (q space). */
  planarHere(): boolean {
    const P = this.poly;
    if (!this.analytic || !this.polyUsed || !P || !P.analyse()) return false;
    // l = (cr dx + sr dy, -sr dx + cr dy)  =>  grad_q = J^T grad_l
    this.pgx = this.cr * P.gx - this.sr * P.gy;
    this.pgy = this.sr * P.gx + this.cr * P.gy;
    return true;
  }
  /** The analytic polygon plane may be used (stroke wide enough that |d| kinks are saturated). */
  analytic = false;
  private cr: number;
  private sr: number;
  private poly: FoldedPolygon | null = null;
  /** The 5-sample planar shortcut may be used (false for hairlines, thin and spiky features). */
  fast = true;
  private lineT: { ux: number; uy: number; nx: number; ny: number; H: number; hw: number; t0: number; t1: number; arrowS: boolean; arrowE: boolean; len: number } | null = null;
  private sw: number;
  private strokeOn: boolean;

  constructor(private u: ShapeUniforms) {
    this.cr = Math.cos(u.rot);
    this.sr = Math.sin(u.rot);
    this.sw = u.a[2];
    this.strokeOn = u.strokeOn && (this.sw > 0 || u.type === 3);
    if (this.strokeOn && this.sw < 2) this.fast = false;
    if (u.type === 1 || u.type === 2) {
      const a = Math.max(u.off[2], u.off[3]);
      const b = Math.min(u.off[2], u.off[3]);
      if (b < 4 || (u.type === 2 && (b * b) / a < 3)) this.fast = false; // thin boxes / sharp ellipse ends
    }
    if (u.type === 4) {
      const n = Math.min(64, Math.max(3, Math.trunc(u.a[1] + 0.5)));
      const star = u.off[3] < 1;
      this.poly = new FoldedPolygon(n, u.off[2], u.off[3], star);
      this.fast = u.off[2] >= 8 && this.poly.edgeLen >= 4 && (!star || u.off[3] >= 0.35);
      this.analytic = !this.strokeOn || this.sw >= 2;
    } else if (u.type === 3) {
      const [ax, ay, bx, by] = u.off;
      const len = hyp(bx - ax, by - ay);
      if (this.strokeOn && len > 1e-6) {
        const arrowS = u.a[3] % 2 >= 1;
        const arrowE = u.a[3] >= 2;
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        const H = Math.min(Math.max(8, 4 * this.sw), arrowS && arrowE ? len * 0.5 : len);
        if (len < 3 * H || this.sw < 2) this.fast = false;
        this.lineT = {
          ux, uy, nx: -uy, ny: ux, H, hw: 0.4 * H, t0: arrowS ? H * 0.5 : 0, t1: len - (arrowE ? H * 0.5 : 0), arrowS, arrowE, len,
        };
      }
    }
  }

  field(qx: number, qy: number): void {
    const u = this.u;
    let fd = 1e5;
    let sd = 1e5;
    const sw = this.sw;
    if (u.type === 3) {
      const t = this.lineT;
      if (t) {
        const [ax, ay, bx, by] = u.off;
        if (sw > 0 && t.t1 > t.t0) sd = sdBody(qx, qy, ax + t.ux * t.t0, ay + t.uy * t.t0, ax + t.ux * t.t1, ay + t.uy * t.t1, 0.5 * sw);
        if (t.arrowE) {
          sd = Math.min(sd, sdTriangle(qx, qy, bx, by, bx - t.ux * t.H + t.nx * t.hw, by - t.uy * t.H + t.ny * t.hw, bx - t.ux * t.H - t.nx * t.hw, by - t.uy * t.H - t.ny * t.hw));
        }
        if (t.arrowS) {
          sd = Math.min(sd, sdTriangle(qx, qy, ax, ay, ax + t.ux * t.H + t.nx * t.hw, ay + t.uy * t.H + t.ny * t.hw, ax + t.ux * t.H - t.nx * t.hw, ay + t.uy * t.H - t.ny * t.hw));
        }
      }
      this.fd = fd;
      this.sd = sd;
      return;
    }
    const dx = qx - u.off[0];
    const dy = qy - u.off[1];
    const lx = this.cr * dx + this.sr * dy;
    const ly = -this.sr * dx + this.cr * dy;
    this.polyUsed = false;
    let d = 1e5;
    if (u.type === 1) d = sdRoundBox(lx, ly, u.off[2], u.off[3], u.a[0]);
    else if (u.type === 2) d = sdEllipse(lx, ly, u.off[2], u.off[3], 0.5 * sw + 3);
    else {
      const R = u.off[2];
      d = hyp(lx, ly) - R;
      if (R < 1e-3) d = 1e5;
      else if (d <= sw + 2) {
        const P = this.poly as FoldedPolygon;
        d = P.sd(lx, ly);
        this.polyUsed = true;
      }
    }
    this.d = d;
    if (u.fillOn) fd = d;
    if (this.strokeOn) sd = Math.abs(d) - 0.5 * sw;
    this.fd = fd;
    this.sd = sd;
  }
}

const cl01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Render the shape into straight RGBA bytes over the document-pixel rect `r` (x, y, w, h; top-left origin).
 * `flatColour` mirrors the shader's output (premultiplied there, converted to straight bytes here).
 */
export function renderShapeBytes(spec: ShapeSpec, docH: number, r: { x: number; y: number; w: number; h: number }, opts: { exact?: boolean } = {}): Uint8ClampedArray {
  const u = shapeUniforms(spec, docH);
  const F = new Field(u);
  const allowFast = F.fast && !opts.exact;
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  const out32 = new Uint32Array(out.buffer);
  const [fr, fg, fb, fa0] = u.fill;
  const [sr, sg, sb, sa0] = u.stroke;
  const colour = (cx: number, cy: number): number => {
    const fa = fa0 * cx;
    const sa = sa0 * cy;
    const a = sa + fa * (1 - sa);
    if (a <= 0) return 0;
    const k = 1 / a;
    const R = Math.round(cl01((sr * sa + fr * fa * (1 - sa)) * k) * 255);
    const G = Math.round(cl01((sg * sa + fg * fa * (1 - sa)) * k) * 255);
    const B = Math.round(cl01((sb * sa + fb * fa * (1 - sa)) * k) * 255);
    const A = Math.round(cl01(a) * 255);
    return ((A << 24) | (B << 16) | (G << 8) | R) >>> 0;
  };
  const exactColour = (px: number, py: number): number => {
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        F.field(px + (i - 1.5) * 0.25, py + (j - 1.5) * 0.25);
        cx += cl01(0.5 - F.fd * 4);
        cy += cl01(0.5 - F.sd * 4);
      }
    }
    return colour(cx / 16, cy / 16);
  };
  const LIN_TOL = 0.003; // px: curvature / twist below this -> the 16 samples follow a plane to < 1/255
  const edgeColour = (px: number, py: number, fd0: number, sd0: number): number => {
    // Cheap path: the 16 samples of a locally planar field are computed from its 4 corner samples (5 evaluations
    // instead of 16). Curved / pinched regions fail the planarity test and take the exact 16-sample path.
    if (!opts.exact && F.planarHere()) {
      const gx = F.pgx, gy = F.pgy;
      const ss = F.d < 0 ? -1 : 1;
      // |g.o| <= 0.54 px over the sample footprint: a field further than 0.66 px from its edge is flat (0 or 1)
      let cx = fd0 <= -0.66 ? 16 : 0;
      let cy = sd0 <= -0.66 ? 16 : 0;
      const doF = Math.abs(fd0) < 0.66;
      const doS = Math.abs(sd0) < 0.66;
      if (doF || doS) {
        for (let j = 0; j < 4; j++) {
          const oy = gy * ((j - 1.5) * 0.25);
          for (let i = 0; i < 4; i++) {
            const o = gx * ((i - 1.5) * 0.25) + oy;
            if (doF) cx += cl01(0.5 - (fd0 + o) * 4);
            if (doS) cy += cl01(0.5 - (sd0 + ss * o) * 4);
          }
        }
      }
      return colour(cx / 16, cy / 16);
    }
    if (!allowFast) return exactColour(px, py);
    F.field(px - 0.375, py - 0.375);
    const f00 = F.fd, s00 = F.sd;
    F.field(px + 0.375, py - 0.375);
    const f10 = F.fd, s10 = F.sd;
    F.field(px - 0.375, py + 0.375);
    const f01 = F.fd, s01 = F.sd;
    F.field(px + 0.375, py + 0.375);
    const f11 = F.fd, s11 = F.sd;
    // planar = no curvature / twist, and a unit gradient (a distance field has |grad| = 1 away from ridges and kinks)
    const flat = (d0: number, a: number, b: number, c: number, d: number): boolean => {
      if (Math.abs(d0) > 1e4) return true; // disabled field
      if (Math.abs(d0 - (a + b + c + d) / 4) >= LIN_TOL || Math.abs(a + d - b - c) >= LIN_TOL) return false;
      const gx = (b - a + d - c) / 1.5;
      const gy = (c - a + d - b) / 1.5;
      const g = gx * gx + gy * gy;
      return g > 0.9 && g < 1.1;
    };
    if (flat(fd0, f00, f10, f01, f11) && flat(sd0, s00, s10, s01, s11)) {
      const fgx = (f10 - f00 + f11 - f01) / 1.5, fgy = (f01 - f00 + f11 - f10) / 1.5;
      const sgx = (s10 - s00 + s11 - s01) / 1.5, sgy = (s01 - s00 + s11 - s10) / 1.5;
      let cx = 0;
      let cy = 0;
      for (let j = 0; j < 4; j++) {
        const oy = (j - 1.5) * 0.25;
        for (let i = 0; i < 4; i++) {
          const ox = (i - 1.5) * 0.25;
          cx += cl01(0.5 - (fd0 + fgx * ox + fgy * oy) * 4);
          cy += cl01(0.5 - (sd0 + sgx * ox + sgy * oy) * 4);
        }
      }
      return colour(cx / 16, cy / 16);
    }
    return exactColour(px, py);
  };
  for (let y = 0; y < r.h; y++) {
    const qy = docH - (r.y + y + 0.5);
    let x = 0;
    while (x < r.w) {
      const qx = r.x + x + 0.5;
      F.field(qx, qy);
      const m = Math.min(Math.abs(F.fd), Math.abs(F.sd));
      if (m < 1.5) {
        out32[y * r.w + x] = edgeColour(qx, qy, F.fd, F.sd);
        x++;
      } else {
        const c = colour(cl01(0.5 - F.fd), cl01(0.5 - F.sd));
        const run = Math.min(r.w - x, Math.floor(m - 1.5) + 1); // the field is 1-Lipschitz
        if (c !== 0) out32.fill(c, y * r.w + x, y * r.w + x + run);
        x += run;
      }
    }
  }
  return out;
}

// ---- canvas cache + drawing ----
//
// Shapes whose raster lies fully inside the document are cached position-normalised: the key is the spec translated
// so that its anchor (x,y / x1,y1 / cx,cy) has a fractional part only, the raster is blitted at the integer offset.
// An integer move therefore never re-rasterises (and gives bit-identical pixels). Shapes touching the document
// border are rasterised clipped to the document and keyed by absolute position.

interface Entry { key: string; surface: Surface; x: number; y: number; w: number; h: number; bytes: number }
const cache = new Map<string, Entry>();
let cacheBytes = 0;
let renders = 0;
const MIN_CACHE = 192 * 1024 * 1024;
const MAX_CACHE = 768 * 1024 * 1024;
let budget = MIN_CACHE;

/** Tell the cache how many bytes the visible shape layers need (their bbox rasters): the cap follows, so a working
 * set that fits the hard maximum is never evicted cyclically. */
export function setShapeCacheBudget(liveBytes: number): void {
  budget = Math.min(MAX_CACHE, Math.max(MIN_CACHE, Math.ceil(liveBytes * 1.5)));
}

/** Cache statistics (tests): rasterisations done so far, entries and bytes held, current cap. */
export function shapeCacheStats(): { renders: number; entries: number; bytes: number; cap: number } {
  return { renders, entries: cache.size, bytes: cacheBytes, cap: budget };
}

/** Drop all cached shape rasters. */
export function clearShapeCache(): void {
  for (const e of cache.values()) releaseSurface(e.surface);
  cache.clear();
  cacheBytes = 0;
}

function anchorOf(spec: ShapeSpec): [number, number] {
  if (spec.type === 'line') return [spec.x1, spec.y1];
  if (spec.type === 'polygon') return [spec.cx, spec.cy];
  return [spec.x, spec.y];
}

function evict(extra: number): void {
  for (const old of Array.from(cache.values())) {
    if (cacheBytes + extra <= budget) break;
    cache.delete(old.key);
    cacheBytes -= old.bytes;
    releaseSurface(old.surface);
  }
}

function entryFor(spec: ShapeSpec, docW: number, docH: number): { e: Entry; ox: number; oy: number } | null {
  const b = shapeBounds(spec);
  const inside = b.x - 1 >= 0 && b.y - 1 >= 0 && b.x + b.w + 1 <= docW && b.y + b.h + 1 <= docH;
  let norm = spec;
  let ox = 0;
  let oy = 0;
  let key: string;
  if (inside) {
    const [ax, ay] = anchorOf(spec);
    ox = Math.floor(ax);
    oy = Math.floor(ay);
    norm = translateShape(spec, -ox, -oy);
    key = `n${JSON.stringify(norm)}`;
  } else key = `a${docW}x${docH}${JSON.stringify(spec)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh recency
    cache.set(key, hit);
    return { e: hit, ox, oy };
  }
  const nb = inside ? shapeBounds(norm) : b;
  const x0 = inside ? nb.x - 1 : Math.max(0, nb.x - 1);
  const y0 = inside ? nb.y - 1 : Math.max(0, nb.y - 1);
  const x1 = inside ? nb.x + nb.w + 1 : Math.min(docW, nb.x + nb.w + 1);
  const y1 = inside ? nb.y + nb.h + 1 : Math.min(docH, nb.y + nb.h + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const size = w * h * 4;
  evict(size * 2); // the transient ImageData copy lives alongside the canvas while uploading
  renders++;
  const bytes = renderShapeBytes(norm, docH, { x: x0, y: y0, w, h });
  const surface = createSurface(w, h);
  surface.ctx.putImageData(new ImageData(bytes as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  const e: Entry = { key, surface, x: x0, y: y0, w, h, bytes: size };
  cache.set(key, e);
  cacheBytes += size;
  return { e, ox, oy };
}

/** Draw a shape with the SDF renderer (canvas ctx honours its own transform, e.g. thumbnail scale). */
export function drawShapeSdf(ctx: Ctx2D, spec: ShapeSpec, docW: number, docH: number): void {
  const hit = entryFor(spec, docW, docH);
  if (hit) ctx.drawImage(hit.e.surface.canvas as CanvasImageSource, hit.e.x + hit.ox, hit.e.y + hit.oy);
}

/** The one entry point used by the compositor / engine: the active renderer decides. */
export function drawShapeWith(mode: ShapeRenderer, ctx: Ctx2D, spec: ShapeSpec, docW: number, docH: number): void {
  if (mode === 'sdf') drawShapeSdf(ctx, spec, docW, docH);
  else drawShape(ctx, spec);
}
