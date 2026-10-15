// Raster Editor v6 filters -- TYPE DRAFT (merged into web/src/engine/types.ts in phase B).  See docs/DESIGN_V6.md section 1.
//
// A filter has the same shape as a v5 Effect: `{ enabled: boolean, type: <discriminant>, ...params }`.  The union `Filter` is the sum of the
// group files (filters.blur.d.ts, filters.color.d.ts, filters.stylise.d.ts, filters.distort.d.ts, filters.animated.d.ts); every
// parameter documents unit and range, out-of-range values are CLAMPED by the planner (td/raster_editor/effects.py plan_effect ==
// web/src/engine/effects/plan.ts planEffect, driven by shared/effects/<type>.filter.json), wrong types fall back to the default.
//
// Using filters
//   * per-layer effect: put the filter in a layer's `effects` list (same chain as the v5 effects, executed in list order);
//   * adjustment layer: apply the filter to the document-sized composite BELOW the layer (the chain input is that composite; for the web
//     preview `applyEffects(composite, [filter], rect, out)`, for TD `EffectChain.apply([filter], below_top, w, h)`);
//   * second image (displace by layer / input): pass `aux` -- web `applyEffects(src, fx, rect, out, auxSurface)`, TD
//     `EffectChain.apply(fx, input, w, h, aux=top)`; the aux image is document sized like the input; without it the displace is a no-op.
//
// Common conventions
//   * Lengths in document px, angles in degrees (clockwise on screen unless stated), fractions 0..1, percentages 0..100,
//     colours straight RGBA 0..255 (alpha multiplies the filter's strength where it makes sense).
//   * Filters work on the premultiplied layer content in the stored (sRGB encoded) values, alpha is preserved unless a filter says otherwise.
//   * Seeds are integers (reduced modulo 2^24); every random value is a hash of (seed, document position, index): deterministic and
//     independent of the rendered region.  No filter depends on time.
//   * `iterations` parameters (feedback, echo, drift glitch, colour cycling) are clamped to 1..64.
//
// Blur quality (pyramid)
//   Blur radii (px) up to 16 run as one exact full-resolution separable gaussian (sigma = radius / 3, kernel half width = radius).  Above
//   16 px (up to the 200 px cap) every blur-type pass (blur, shadow, glows, bevel, bloom, unsharp, high-pass, lens blur ...) runs as a
//   DOWN-SAMPLE PYRAMID: box down-sample by s = 2^L (L = 1..4, smallest with ceil(radius / s) <= 16), gaussian at low resolution with
//   sigma_low^2 = (sigma^2 - s^2/4) / s^2, bilinear up-sample.  Cost is ~constant in the radius (the low-res kernel never exceeds 16 px
//   and the work shrinks by s^2).  Measured quality vs an exact gaussian: see docs in web/tests/browser/effects.filters.test.ts
//   ("pyramid quality"): max error <= ~1.5/255 on a hard edge, mean error < 0.3/255.  The block grid is aligned to document coordinates.

// ---------------------------------------------------------------------------------------------------------------------------------------
// Filter specs (authoring contract).  A filter = `<type>.filter.json` + `<type>.glsl`, nothing else; the planner for Python
// (td/raster_editor/effects.py, embedded copy) and TypeScript (web/src/engine/effects/filters.ts) is generic and evaluates the spec.
//
//   "type"       discriminant of the Filter union (camelCase, == file stem).     "group": blur | color | stylise | distort | animated
//   "doc"        one paragraph: what it does, exact formula/units.               "glsl": false = no own shader (reuses other shaders)
//   "include"    GLSL libraries after common.glsl (default ["filterlib"]; blurs: ["filterlib","blurlib"])
//   "in2"        true when the shader reads sTD2DInputs[2] (data texture or aux image): then EVERY pass of that shader has input 2
//   "reads"      "point" (out(x,y) depends on in(x,y) only) | "neighbourhood" | "global" (any pixel);  "readsGlobal": expression -> global
//   "tdPreview"  true / expression: the browser cannot match TouchDesigner within 3/255 (UI then shows TD's render).  Set by the library
//                owner after measuring; leave out.
//   "preservesTransparent"  true ONLY if the output alpha at a pixel is 0 whenever the input alpha at that pixel is 0 AND nothing spreads from
//                neighbours (so the content bounding box can never grow): per-pixel colour ops, alpha-preserving local ops. False for blurs, trails,
//                displacements, glows, bezels... (informs bbox / caching)
//   "params"     name -> {kind, default, min, max, round, unit, doc, ...}; kinds
//                  num   finite number, else default; "round": floor(x+0.5); clamped to min/max          -> variable `name`
//                  seed  integer mod 2^24                                                                 -> `name`
//                  bool  true/false (anything else -> default)                                            -> 0/1
//                  enum  {"values": [...], "default": "x"}                                                -> index of the value
//                  color {"default": {r,g,b,a}} straight 0..255                                           -> `name.r` `name.g` `name.b` `name.a` (0..1)
//                  points / stops / list / text   (curves control points, gradient stops, signed number table, .cube text): data only, see generators
//   "vars"       [[name, expr], ...] evaluated in order after the params
//   "noop"       expression; non-zero = the filter does nothing (no passes)
//   "passes"     list of  {"shader": type (default), "pass": expr, "level": expr (pyramid level of the OUTPUT, 0 = full), "fmt": "f16"|"f32"
//                (default f16; the chain's last pass becomes u8 automatically), "u": [up to 16 expressions -> uP0..uP3],
//                "aux": true (input 2 = the chain's aux image), "data": {"gen": "curves"|"gradient"|"table"|"cube", "args": [param names]},
//                "when": expr (include only if non-zero)}
//                or {"repeat": {"var": "i", "count": expr (<= 256)}, "passes": [...]}  or  {"sub": "blur", "with": {"radius": expr}} (the passes of another spec)
//                The LAST pass must be level 0 and produce the final premultiplied rgba.  Pass k reads input 0 = the filter's input, input 1 = pass k-1
//                (pass 0: the input again).  Rule of thumb: <= 8 passes at 1080p.
//   "extent"     [rx, ry, ax, ay] expressions: px an output pixel reads around itself (use "G" for the whole document), ax/ay alignment (0 normally).
//                MUST be conservative: the generic test renders a sub-rectangle and requires it to equal the full render.
//   "samples"    >= 1 typical parameter sets (the generic tests render the first; they must visibly change the test image); "degenerate": >= 4
//                nasty sets ({}, zeros, huge, negative, wrong types, unknown enums) -- they only have to plan without throwing / NaN.
//
// Expression language (identical in Python and TS): numbers, names (params, vars, `colour.r`), + - * / (x/0 = 0), comparisons, && || !, constants pi G MAXR,
// functions abs min max floor ceil round(floor(x+.5)) sqrt pow exp log sin cos tan atan2 rad deg clamp mix if(c,a,b) mod sign fract and the blur planner
// helpers pyrL blurSig blurR blurReach.  Non-finite results become 0.  All values are doubles; uniforms are then float32 on both hosts.
//
// Data generators ("data" in a pass, bound as sTD2DInputs[2] RGBA8, read with fxData(x, y)): curves (args master,r,g,b : points -> 256x1 LUT),
// gradient (stops -> 256x1), table (list -> N/4 x 1, byte = round((v+1)*127.5)), cube (text with "cube": true -> atlas; spec vars `name.n`, `name.g`,
// `name.min.r` .. `name.max.b`, `name.ok` are defined for it).  Param kinds "points"/"stops"/"list"/"text" are defined in filters.ts normParams.
//
// Shader conventions: see the headers of common.glsl, filterlib.glsl and blurlib.glsl.  Input is PREMULTIPLIED rgba; unpremultiply with fxStraight()
// for colour work and write fxOut(fxPm(rgb, a)).  Use only fxHash-based randomness of (document position, seed, index).

export interface RGBA { r: number; g: number; b: number; a: number }

import type { BlurFilter } from './filters.blur';
import type { ColorFilter } from './filters.color';
import type { StyliseFilter } from './filters.stylise';
import type { DistortFilter } from './filters.distort';
import type { AnimatedFilter } from './filters.animated';

export type Filter = { enabled: boolean } & (BlurFilter | ColorFilter | StyliseFilter | DistortFilter | AnimatedFilter);
export type FilterType = Filter['type'];

/** How a filter reads its input (planner: effectReads / effect_reads). */
export type FilterReads = 'point' | 'neighbourhood' | 'global';
