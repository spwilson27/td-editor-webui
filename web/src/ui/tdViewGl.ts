// v11: WebGL compositor for the TD view. Fast frames: premultiplied RGB + (1-a)·checkerboard; the exact RGBA8 buffer: straight alpha over
// the checkerboard. Both are drawn at the current pan / zoom, so a frame keeps its place in the document while the view moves.
import type { ExactBuffer, DirtyRect } from '../bridge/exactBuffer';
import type { FastImage, ShownKind, ViewSink } from '../bridge/tdViewClient';

const VS = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

// Checkerboard as viewportDraw.checkerTile: 8 px cells (screen px), white / #cfcfcf, anchored at the document origin.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uFast;
uniform sampler2D uAlpha;
uniform sampler2D uExact;
uniform sampler2D uPm;      // exact, premultiplied, with mipmaps (zoomed out)
uniform int uMode;          // 0 nothing, 1 fast, 2 exact (straight, nearest), 3 exact (premultiplied mips)
uniform vec2 uOrigin;       // document origin, device px from the top-left
uniform vec2 uScale;        // device px per document px
uniform vec2 uCanvas;       // canvas size, device px
uniform vec4 uRect;         // fast frame rect, document px
uniform vec4 uFastTx;       // image / allocation ratio (xy), half texel (zw)
uniform vec4 uAlphaTx;
uniform vec2 uDoc;
uniform float uHasAlpha;
uniform float uExactValid;  // an exact buffer is available to fill what the fast frame does not cover
uniform vec2 uCell;         // checker cell, device px
out vec4 o;
void main(){
  vec2 frag = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 d = (frag - uOrigin) / uScale;
  if (d.x < 0.0 || d.y < 0.0 || d.x >= uDoc.x || d.y >= uDoc.y) { o = vec4(0.0); return; }
  vec2 cell = floor((frag - uOrigin) / uCell);
  float ck = mod(cell.x + cell.y, 2.0) < 0.5 ? 207.0 / 255.0 : 1.0;
  vec3 col = vec3(ck);
  if (uMode == 1) {
    vec2 uv = (d - uRect.xy) / uRect.zw;
    if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x < 1.0 && uv.y < 1.0) {
      vec2 t = clamp(uv * uFastTx.xy, uFastTx.zw, uFastTx.xy - uFastTx.zw);
      vec3 c = texture(uFast, t).rgb;
      float a = 1.0;
      if (uHasAlpha > 0.5) a = texture(uAlpha, clamp(uv * uAlphaTx.xy, uAlphaTx.zw, uAlphaTx.xy - uAlphaTx.zw)).r;
      col = c + (1.0 - a) * vec3(ck);
    } else if (uExactValid > 0.5) {
      vec4 t = texture(uExact, d / uDoc);
      col = t.rgb * t.a + (1.0 - t.a) * vec3(ck);
    }
  } else if (uMode == 2) {
    vec4 t = texture(uExact, d / uDoc);
    col = t.rgb * t.a + (1.0 - t.a) * vec3(ck);
  } else if (uMode == 3) {
    vec4 t = texture(uPm, d / uDoc);
    col = t.rgb + (1.0 - t.a) * vec3(ck);
  }
  o = vec4(col, 1.0);
}`;

// Premultiplies the exact texture into the mip-mapped texture (filtering straight alpha leaves dark halos).
const PM_FS = `#version 300 es
precision highp float;
uniform sampler2D uExact;
out vec4 o;
void main(){ vec4 t = texelFetch(uExact, ivec2(gl_FragCoord.xy), 0); o = vec4(t.rgb * t.a, t.a); }`;

export interface DrawParams {
  /** viewport size in CSS px, its backing store in device px, and the document origin / zoom inside it */
  vw: number; vh: number;
  cw: number; ch: number;
  view: { zoom: number; x: number; y: number };
  docW: number; docH: number;
}

export interface DrawResult {
  /** the on-screen part of the document in canvas device px; null = nothing drawn */
  rect: { x: number; y: number; w: number; h: number } | null;
}

interface Size { w: number; h: number }
const ZOOMED_OUT = 0.75; // below this device-px-per-doc-px the exact picture is minified through the premultiplied mip chain

export class TdViewGl implements ViewSink {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext | null;
  /** why the compositor cannot work (no WebGL2, shader error), or null */
  failure: string | null = null;
  private prog: WebGLProgram | null = null;
  private pmProg: WebGLProgram | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private fastTex: WebGLTexture | null = null;
  private alphaTex: WebGLTexture | null = null;
  private exactTex: WebGLTexture | null = null;
  private pmTex: WebGLTexture | null = null;
  private pmFbo: WebGLFramebuffer | null = null;
  private fastAlloc: Size = { w: 0, h: 0 };
  private fastImg: Size = { w: 0, h: 0 };
  private alphaAlloc: Size = { w: 0, h: 0 };
  private alphaImg: Size = { w: 0, h: 0 };
  private exactSize: Size = { w: 0, h: 0 };
  private exactSrc: ExactBuffer | null = null;
  private pmDirty = false;
  private fastRect = { x: 0, y: 0, w: 1, h: 1 };
  private hasAlpha = false;
  private shown: ShownKind | null = null;
  private haveFast = false;
  private haveExact = false;
  private lost = false;
  /** Something to repaint (frame uploaded, kind changed, context lost / restored). */
  onChange: (() => void) | null = null;
  /** The GPU context was lost (`true`) or came back (`false`, state rebuilt, exact buffer re-uploaded). */
  onLostChange: ((lost: boolean) => void) | null = null;
  readonly stats = { fastUploads: 0, exactUploads: 0, draws: 0, restores: 0 };

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // lets the browser restore the context
      this.lost = true;
      this.onLostChange?.(true);
      this.onChange?.();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.stats.restores++;
      this.setup();
      const src = this.exactSrc;
      if (this.available && src?.valid) this.exact(src, [{ x: 0, y: 0, w: src.w, h: src.h }]);
      this.shown = this.haveExact ? 'exact' : null; // fast content did not survive; a fresh fast frame is requested by the owner
      this.onLostChange?.(false);
      this.onChange?.();
    });
    this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    if (!this.gl) this.failure = 'WebGL 2 is not available';
    else this.setup();
  }

  /** Can draw right now (false while the context is lost). */
  get available(): boolean { return this.gl !== null && this.prog !== null && !this.lost && !this.gl.isContextLost(); }
  /** WebGL2 and the shaders work at all (a lost context may come back). */
  get usable(): boolean { return this.gl !== null && this.failure === null; }
  get isLost(): boolean { return this.lost; }
  /** What is actually drawn, or null. */
  get kind(): ShownKind | null { return this.hasContent ? this.shown : null; }
  get hasContent(): boolean { return this.available && (this.shown === 'fast' ? this.haveFast : this.shown === 'exact' ? this.haveExact : false); }

  maxExactDim(): number { return this.gl && !this.gl.isContextLost() ? (this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number) : 16384; }

  private program(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const pr = gl.createProgram()!;
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(pr, 0, 'p');
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) ?? 'link');
    return pr;
  }

  /** (Re)build every GPU resource; contents are gone. */
  private setup(): void {
    const gl = this.gl!;
    this.prog = this.pmProg = null;
    this.fastTex = this.alphaTex = this.exactTex = this.pmTex = null;
    this.pmFbo = null;
    this.fastAlloc = { w: 0, h: 0 }; this.fastImg = { w: 0, h: 0 }; this.alphaAlloc = { w: 0, h: 0 }; this.alphaImg = { w: 0, h: 0 };
    this.exactSize = { w: 0, h: 0 };
    this.haveFast = this.haveExact = false;
    this.pmDirty = false;
    try {
      this.prog = this.program(gl, FS);
      this.pmProg = this.program(gl, PM_FS);
      gl.useProgram(this.prog);
      for (const n of ['uFast', 'uAlpha', 'uExact', 'uPm', 'uMode', 'uOrigin', 'uScale', 'uCanvas', 'uRect', 'uFastTx', 'uAlphaTx', 'uDoc', 'uHasAlpha', 'uExactValid', 'uCell']) this.u[n] = gl.getUniformLocation(this.prog, n);
      gl.uniform1i(this.u.uFast, 0); gl.uniform1i(this.u.uAlpha, 1); gl.uniform1i(this.u.uExact, 2); gl.uniform1i(this.u.uPm, 3);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); // the exact buffer is straight alpha and must reach the texture untouched
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      this.fastTex = this.newTex(gl, 0, gl.LINEAR, gl.LINEAR);
      this.alphaTex = this.newTex(gl, 1, gl.LINEAR, gl.LINEAR);
      this.exactTex = this.newTex(gl, 2, gl.NEAREST, gl.NEAREST);
      this.failure = null;
    } catch (e) {
      this.prog = null;
      this.failure = `WebGL setup failed: ${(e as Error).message}`;
    }
  }

  private newTex(gl: WebGL2RenderingContext, unit: number, min: number, mag: number): WebGLTexture {
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Grow-only: a smaller image goes into the corner of the existing allocation (texSubImage2D). */
  private upload(unit: number, tex: WebGLTexture, alloc: Size, img: Size, bmp: ImageBitmap): void {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (bmp.width > alloc.w || bmp.height > alloc.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      alloc.w = bmp.width; alloc.h = bmp.height;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    img.w = bmp.width; img.h = bmp.height;
  }

  // ---- ViewSink ----

  fast(img: FastImage): boolean {
    try {
      if (!this.available) return false;
      this.upload(0, this.fastTex!, this.fastAlloc, this.fastImg, img.rgb);
      this.hasAlpha = img.alpha !== null;
      if (img.alpha) this.upload(1, this.alphaTex!, this.alphaAlloc, this.alphaImg, img.alpha);
      this.fastRect = { x: img.x, y: img.y, w: img.w, h: img.h };
      this.haveFast = true;
      this.stats.fastUploads++;
      return true;
    } finally { img.rgb.close(); img.alpha?.close(); }
  }

  /** false = the picture cannot be held (bigger than the GPU's textures, or no usable context). */
  exact(buf: ExactBuffer, dirty: DirtyRect[]): boolean {
    const gl = this.gl;
    if (!gl || this.prog === null) return false;
    if (!this.available) { this.exactSrc = buf; return true; } // context lost: re-uploaded when it is restored
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (buf.w > max || buf.h > max) { this.haveExact = false; return false; }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.exactTex);
    let all = dirty;
    if (this.exactSize.w !== buf.w || this.exactSize.h !== buf.h) {
      // immutable storage cannot be resized: a fresh texture for a new document size
      gl.deleteTexture(this.exactTex);
      this.freePm(gl);
      this.exactTex = this.newTex(gl, 2, gl.NEAREST, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, buf.w, buf.h);
      this.exactSize = { w: buf.w, h: buf.h };
      all = [{ x: 0, y: 0, w: buf.w, h: buf.h }];
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, buf.w);
    for (const r of all) {
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, buf.data);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    this.exactSrc = buf;
    this.pmDirty = true;
    this.haveExact = true;
    this.stats.exactUploads++;
    return true;
  }

  show(kind: ShownKind | null): void {
    this.shown = kind;
    this.onChange?.();
  }

  /** Tab / editor switch: nothing is shown and the exact picture's GPU memory is released. */
  clear(): void {
    this.shown = null;
    this.haveFast = this.haveExact = false;
    this.exactSrc = null;
    const gl = this.gl;
    if (gl && this.available) {
      this.freePm(gl);
      if (this.exactSize.w) { gl.deleteTexture(this.exactTex); this.exactTex = this.newTex(gl, 2, gl.NEAREST, gl.NEAREST); }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fastTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.alphaTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.fastAlloc = { w: 1, h: 1 }; this.alphaAlloc = { w: 1, h: 1 };
    }
    this.exactSize = { w: 0, h: 0 };
    this.onChange?.();
  }

  private freePm(gl: WebGL2RenderingContext): void {
    if (this.pmTex) gl.deleteTexture(this.pmTex);
    if (this.pmFbo) gl.deleteFramebuffer(this.pmFbo);
    this.pmTex = null; this.pmFbo = null; this.pmDirty = false;
  }

  /** Premultiplied copy of the exact picture with a full mip chain, built only when the view is zoomed out and the picture changed. */
  private buildPm(gl: WebGL2RenderingContext): void {
    const { w, h } = this.exactSize;
    if (!this.pmTex) {
      this.pmTex = this.newTex(gl, 3, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
      this.pmFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pmFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pmTex, 0);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, this.pmFbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pmProg);
    gl.uniform1i(gl.getUniformLocation(this.pmProg!, 'uExact'), 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.pmTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.useProgram(this.prog);
    this.pmDirty = false;
  }

  // ---- drawing ----

  /** Render the document at the current view into `canvas` (sized to the viewport in device px). */
  draw(p: DrawParams): DrawResult {
    const gl = this.gl;
    if (!gl || !this.available) return { rect: null };
    const cw = Math.max(1, p.cw), ch = Math.max(1, p.ch);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const sx = cw / p.vw, sy = ch / p.vh;
    const scale = p.view.zoom * Math.min(sx, sy);
    let mode = this.shown === 'exact' && this.haveExact ? 2 : this.shown === 'fast' && this.haveFast ? 1 : 0;
    if (mode === 2 && scale < ZOOMED_OUT) {
      if (this.pmDirty || !this.pmTex) this.buildPm(gl);
      mode = 3;
    }
    gl.viewport(0, 0, cw, ch);
    gl.useProgram(this.prog);
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform2f(this.u.uOrigin, p.view.x * sx, p.view.y * sy);
    gl.uniform2f(this.u.uScale, p.view.zoom * sx, p.view.zoom * sy);
    gl.uniform2f(this.u.uCanvas, cw, ch);
    gl.uniform2f(this.u.uDoc, p.docW, p.docH);
    gl.uniform4f(this.u.uRect, this.fastRect.x, this.fastRect.y, this.fastRect.w, this.fastRect.h);
    const tx = (img: Size, alloc: Size): [number, number, number, number] => alloc.w ? [img.w / alloc.w, img.h / alloc.h, 0.5 / alloc.w, 0.5 / alloc.h] : [1, 1, 0, 0];
    gl.uniform4fv(this.u.uFastTx, tx(this.fastImg, this.fastAlloc));
    gl.uniform4fv(this.u.uAlphaTx, tx(this.alphaImg, this.alphaAlloc));
    gl.uniform1f(this.u.uHasAlpha, this.hasAlpha ? 1 : 0);
    gl.uniform1f(this.u.uExactValid, this.haveExact && this.exactSize.w === p.docW && this.exactSize.h === p.docH ? 1 : 0);
    gl.uniform2f(this.u.uCell, 8 * sx, 8 * sy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.draws++;
    const x0 = Math.max(0, Math.floor(p.view.x * sx)), y0 = Math.max(0, Math.floor(p.view.y * sy));
    const x1 = Math.min(cw, Math.ceil((p.view.x + p.docW * p.view.zoom) * sx)), y1 = Math.min(ch, Math.ceil((p.view.y + p.docH * p.view.zoom) * sy));
    return { rect: x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null };
  }

  /** Test helper: the exact texture's level 0 read back (straight RGBA8, top row first). */
  readExact(): Uint8Array | null {
    const gl = this.gl;
    if (!gl || !this.available || !this.exactTex || !this.exactSize.w) return null;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.exactTex, 0);
    const out = new Uint8Array(this.exactSize.w * this.exactSize.h * 4);
    gl.readPixels(0, 0, this.exactSize.w, this.exactSize.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return out;
  }

  /** Test helper: the canvas pixels (premultiplied RGBA8, row 0 = top) right after `draw`. */
  readCanvas(): Uint8Array {
    const gl = this.gl!;
    const w = this.canvas.width, h = this.canvas.height;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }
}

let shared: TdViewGl | null = null;
/** The page's one compositor (created on first use). */
export function sharedTdViewGl(): TdViewGl {
  if (!shared) shared = new TdViewGl();
  return shared;
}
export const peekTdViewGl = (): TdViewGl | null => shared;
