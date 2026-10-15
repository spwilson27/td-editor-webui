// WebGL2 runner of the layer-effect shaders (shared/effects/*.glsl) on a shared OffscreenCanvas context.
// Mirrors what TouchDesigner does with the same sources (one pass = one GLSL TOP): see td/raster_editor/effects.py.
//   * Input 0 = effect input, input 1 = previous pass (all texelFetch, nearest), texture row 0 = bottom (UNPACK_FLIP_Y).
//   * Formats: u8 = RGBA8, f16 = RGBA16F, f32 = RGBA32F (needs EXT_color_buffer_float, present in Chromium 132 / TD's CEF).
//   * The final pass renders to the canvas' default framebuffer; the caller copies the region into a 2D surface.

import type { DataTex, EffectPass, PassFormat } from './filters';
import { WEBGL_ADAPTER, shaderBody } from './shaders';

type GLCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface Tex {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer | null;
  w: number;
  h: number;
  fmt: PassFormat;
}

interface Prog {
  prog: WebGLProgram;
  u: Record<'uP0' | 'uP1' | 'uP2' | 'uP3' | 'uPass' | 'uSize' | 'in0' | 'in1' | 'in2', WebGLUniformLocation | null>;
}

export class FxGL {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: GLCanvas;
  private progs = new Map<string, Prog>();
  private dataTex = new Map<string, Tex>();
  private pool: Tex[] = [];
  private vao: WebGLVertexArrayObject | null;
  lost = false;
  passesRun = 0;
  /** shader types whose compile / link failed (cached: the effect is skipped from then on) */
  readonly failed = new Map<string, string>();
  private poolBytes = 0;
  static readonly POOL_BUDGET = 256 * 1024 * 1024;

  constructor(gl: WebGL2RenderingContext, canvas: GLCanvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.vao = gl.createVertexArray();
    canvas.addEventListener?.('webglcontextlost', (ev: Event) => {
      ev.preventDefault();
      this.lost = true;
    });
  }

  /** Context + required extensions, or null. */
  static create(): FxGL | null {
    try {
      const canvas: GLCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
      const gl = canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null;
      if (!gl) return null;
      if (!gl.getExtension('EXT_color_buffer_float')) return null;
      return new FxGL(gl, canvas);
    } catch {
      return null;
    }
  }

  private program(type: string): Prog {
    let p = this.progs.get(type);
    if (p) return p;
    const bad = this.failed.get(type);
    if (bad) throw new Error(bad);
    try {
      return this.build(type);
    } catch (e) {
      this.failed.set(type, String((e as Error).message ?? e));
      throw e;
    }
  }

  private build(type: string): Prog {
    const gl = this.gl;
    const mk = (t: number, src: string): WebGLShader => {
      const sh = gl.createShader(t)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`effect shader ${type}: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }');
    const fs = mk(gl.FRAGMENT_SHADER, WEBGL_ADAPTER + shaderBody(type));
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`effect program ${type}: ${gl.getProgramInfoLog(prog)}`);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const L = (n: string) => gl.getUniformLocation(prog, n);
    const p: Prog = { prog, u: { uP0: L('uP0'), uP1: L('uP1'), uP2: L('uP2'), uP3: L('uP3'), uPass: L('uPass'), uSize: L('uSize'), in0: L('sTD2DInputs[0]'), in1: L('sTD2DInputs[1]'), in2: L('sTD2DInputs[2]') } };
    this.progs.set(type, p);
    return p;
  }

  private glFormat(fmt: PassFormat): [number, number, number] {
    const gl = this.gl;
    return fmt === 'u8' ? [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE] : fmt === 'f16' ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA32F, gl.RGBA, gl.FLOAT];
  }

  /** A texture of the given size / format from the pool (contents undefined). */
  alloc(w: number, h: number, fmt: PassFormat): Tex {
    const i = this.pool.findIndex((t) => t.w === w && t.h === h && t.fmt === fmt);
    if (i >= 0) {
      const t = this.pool.splice(i, 1)[0];
      this.poolBytes -= FxGL.bytes(t);
      return t;
    }
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const [ifmt] = this.glFormat(fmt);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, fbo: null, w, h, fmt };
  }

  static bytes(t: Tex): number {
    return t.w * t.h * (t.fmt === 'u8' ? 4 : t.fmt === 'f16' ? 8 : 16);
  }

  /** Back to the pool; the pool is capped by total bytes (oldest first). */
  free(t: Tex): void {
    this.pool.push(t);
    this.poolBytes += FxGL.bytes(t);
    while (this.poolBytes > FxGL.POOL_BUDGET && this.pool.length) this.drop(this.pool.shift()!, true);
  }

  private drop(t: Tex, pooled: boolean): void {
    if (pooled) this.poolBytes -= FxGL.bytes(t);
    if (t.fbo) this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  /** Idle: free pooled textures and shrink the drawing buffer. */
  releaseIdle(): void {
    for (const t of this.dataTex.values()) this.drop(t, false);
    this.dataTex.clear();
    while (this.pool.length) this.drop(this.pool.pop()!, true);
    this.poolBytes = 0;
    if (this.canvas.width > 1 || this.canvas.height > 1) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
  }

  /** Texture holding `source` (a canvas), premultiplied, row 0 = bottom. */
  upload(source: TexImageSource, w: number, h: number, bw = w, bh = h): Tex {
    const t = this.alloc(bw, bh, 'u8'); // (bw, bh) >= (w, h); the caller guarantees the padding of `source` is transparent
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return t;
  }

  /** RGBA8 texture of a pass' data (curve / gradient / LUT / table), cached by digest (small LRU). Row 0 = first row of `d.data`. */
  data(d: DataTex): Tex {
    const hit = this.dataTex.get(d.digest);
    if (hit) {
      this.dataTex.delete(d.digest);
      this.dataTex.set(d.digest, hit);
      return hit;
    }
    const gl = this.gl;
    const t = this.alloc(d.w, d.h, 'u8');
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, d.w, d.h, gl.RGBA, gl.UNSIGNED_BYTE, d.data);
    this.dataTex.set(d.digest, t);
    while (this.dataTex.size > 6) {
      const k = this.dataTex.keys().next().value as string;
      this.drop(this.dataTex.get(k)!, false);
      this.dataTex.delete(k);
    }
    return t;
  }

  private bindTarget(target: Tex | null, w: number, h: number): void {
    const gl = this.gl;
    if (target === null) {
      if (this.canvas.width < w || this.canvas.height < h) {
        this.canvas.width = Math.max(this.canvas.width, w);
        this.canvas.height = Math.max(this.canvas.height, h);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      if (!target.fbo) {
        target.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
    }
    gl.viewport(0, 0, w, h);
  }

  /** One pass: reads in0 / in1, renders into `target` (null: canvas' default framebuffer, bottom-left w x h). */
  run(pass: EffectPass, in0: Tex, in1: Tex, in2: Tex | null, target: Tex | null, originX: number, originY: number, logicalW = 0, logicalH = 0,
    docW = 0, docH = 0, auxMissing = false): void {
    const gl = this.gl;
    const p = this.program(pass.shader);
    gl.useProgram(p.prog);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, in0.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, in1.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, (in2 ?? in1).tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.in0, 0);
    gl.uniform1i(p.u.in1, 1);
    gl.uniform1i(p.u.in2, 2);
    const u = pass.u;
    gl.uniform4f(p.u.uP0, u[0], u[1], u[2], u[3]);
    gl.uniform4f(p.u.uP1, u[4], u[5], u[6], u[7]);
    gl.uniform4f(p.u.uP2, u[8], u[9], u[10], u[11]);
    gl.uniform4f(p.u.uP3, u[12], u[13], u[14], u[15]);
    gl.uniform4f(p.u.uPass, pass.pid, originX, originY, (pass.level ?? 0) + (auxMissing ? 0.5 : 0));
    gl.uniform4f(p.u.uSize, logicalW, logicalH, docW, docH); // 0 = the whole texture / the texture is the document
    this.bindTarget(target, target ? target.w : in0.w, target ? target.h : in0.h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passesRun++;
  }

  /** Free everything and lose the context (so a replaced runner does not keep GPU memory alive). */
  dispose(): void {
    try {
      for (const t of this.pool) this.drop(t, false);
      for (const t of this.dataTex.values()) this.drop(t, false);
      this.dataTex.clear();
      this.pool = [];
      this.poolBytes = 0;
      for (const p of this.progs.values()) this.gl.deleteProgram(p.prog);
      this.progs.clear();
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* context already gone */
    }
  }
}
