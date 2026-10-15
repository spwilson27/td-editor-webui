# Raster Editor v5 — tools, free transform, selection extras, files, layer effects, multiple inputs

Builds on `DESIGN_V4.md` (tag `v0.4.0`). Protocol: `PROTOCOL.md` §8 (version 6).

## 1. Decisions (design Q&A)

| Topic | Decision |
| --- | --- |
| Tools (5) | Enable **Crop** (drag a rect / handles; Enter applies = canvas resize to the rect, layers keep transforms, nothing resampled; Esc cancels), **Clone** (Alt-click source; aligned / non-aligned; sample current layer or all), **Smudge** (strength), **Blur / Sharpen** brush (strength), **Dodge / Burn** (range shadows/midtones/highlights, exposure). Clone/smudge/blur/dodge are browser brushes like the paint brush (dab-based, tile undo, selection clipping, scaled/rotated layers). |
| Free transform (6) | Non-destructive **rotate + skew** for pixel and input layers: transform = translate(x,y) · rotate(rot) · skew(kx,ky) · scale(sx,sy), about the layer surface's top-left (the UI keeps the visual pivot by adjusting x,y). Transform box gains rotate handles (outside corners) and skew (Ctrl-drag edge handles). TD applies the full affine in the resample pass; the preview matches. **Transform Selection**: lifts the selected pixels of the active layer into a floating selection with its own affine box; Enter commits (resample into the layer), Esc cancels. |
| Selection extras (8) | **Quick Mask** mode (Q): the selection shown as a red overlay you paint with any brush (white adds, black removes); Q again converts back. Select ▸ **Grow / Shrink / Smooth / Feather / Border** (px). |
| Files (9) | Written/read **by TD** through file parameters (work in the panel and the external browser): **Project File** (+ **Save Project** / **Open Project** pulses) and **PNG File** (+ **Export PNG** pulse = TD's flattened output). The UI's File menu sends `saveProject` / `openProject` / `exportPng` (path = parameter value, editable in a small dialog that writes the parameter). Native format `.redoc` (zip): `doc.json` (DocSpec incl. text/shape/adjustment specs, guides, effects, canvas) + `surfaces/<slot>.png` (straight RGBA8) + `meta.json` (format version). TD Inputs are live and not stored. Opening replaces the document (history cleared) and all pages reload it. No PSD. |
| Layer effects (11) | Per-layer effect stack (pixel, text, shape, input layers; not groups/adjustments in v5), each effect enable-able, applied to the layer's masked content before blending: **Drop Shadow**, **Outer Glow**, **Inner Glow**, **Stroke** (inside/centre/outside), **Bevel**, **Colour Overlay**, and experimental **Pixel Sort**, **Glitch**, **Chromatic Aberration**, **Halftone**. Rendered by TD (GPU); the Local preview runs **the same GLSL** in WebGL2 (shared shader sources with a thin TD/WebGL adapter) so the two match. |
| Multiple inputs | The COMP's inputs grow as you connect: there is always one spare input connector (up to 8). Each connected input auto-creates a locked **TD Input N** layer (if no layer references it yet), movable/scalable/rotatable with masks, blend, effects; layers referencing a disconnected input stay (render transparent, marked "disconnected") so placement survives reconnection. **Layer ▸ Add Input Layer** re-adds one. Input 1 drives the canvas in Follow Input mode. Input layers can be reordered and deleted. |

## 2. Data model (contract: `web/src/engine/types.ts`)

- `LayerKind`: `'base'` is replaced by **`'input'`** with `input: number` (1..8). Documents with a `base`
  layer are migrated on load (→ input 1, id kept).
- Transform: `LayerTransform` gains `rot` (degrees, clockwise on screen), `kx`, `ky` (skew degrees).
  LayerSpec carries `rot, kx, ky` next to `x, y, sx, sy`.
- `effects: Effect[]` on LayerSpec/LayerInfo (see `types.ts` for the `Effect` union).
- Floating selection, quick mask and crop are UI/engine session state (not in DocSpec).

## 3. TouchDesigner

- **Inputs:** `in1..in8` In TOPs created on demand (always one spare connector); per *referenced* input a `src_in<N>`
  Select (`../in<N>` while connected, else `blank`) inside `doc` (replaces `base_src`); BASE frames per input (`slot` header
  field = input index; `GET /base?input=N`); an `inputs` message lists `{input, w, h, connected}` (replaces `baseSize`).
  `DocNetwork` interface (ext calls): `set_inputs(connected)` -- `{input: bool}` or the protocol's `[{input, connected, ...}]`
  list, partial updates allowed, repoints the Selects at once and re-plans on the next `apply()`; `set_input_connected(flag)`
  stays as input 1 shorthand; `input_connected(n)`. `apply()` also reads the COMP's input connectors itself (they win where
  they exist; `set_inputs` is the fallback for inputs without a connector). **One-frame caveat:** `set_inputs` only re-points the Selects; the input layers' transform / resample /
  effects / mask wiring are rebuilt by the NEXT `apply()`, so the ext must call `apply(last stack)` right after `set_inputs`
  (until then a newly connected input is shown with the old, untransformed plan). Layers `kind: 'input'` (`input` 1..8, clamped; a
  legacy `base` layer = input 1) read their Select; any number of input layers per input, any position, with blend /
  opacity / mask (mask size = the input layer's `surfaceW/H`) / transform. A disconnected input renders transparent: no
  resample pass, no effects, and the transform is kept (it applies again on reconnection with no spec change).
  `blend_base` / `base_src` no longer exist: every layer is `blend_L_<id>`, input layers use `src_in<N>`.
- **Affine resample:** `doc = T(x,y)·R(rot)·K(kx,ky)·S(sx,sy)·layer` (rot clockwise on screen, K = [[1, tan kx],[tan ky, 1]],
  document y down, about the surface's top-left; skew clamped to ±85° (`MAX_SKEW` in `web/src/engine/xform.ts`; TD `SKEW_MAX` uses the same value); a singular matrix renders the layer transparent).
  Only the resample pass (`xf_L_<id>`, `uAdjust = 7`) takes the transform: `uXform` = (m00, m01, m10, m11), the INVERSE
  of the linear part (doc offset → layer pixels), `uA.xy` = (x, y); the blend pass keeps `uXform = (x, y, 1, 1)` and only ever
  places an integer offset at scale 1 (bit exact, no resample node, unchanged). Coverage = area of the document pixel's
  parallelogram footprint inside the source rect (Sutherland–Hodgman clip in the shader; axis aligned footprints take the
  old separable formula); colour = linear / trilinear sample at the pixel centre, extend hold. **lod =
  max(0, −½·log2|det A| − ½)** with A the forward linear part, i.e. the geometric mean of the singular values -- NOT the
  minimal one: this equals the v4 fit for pure scales (`sx=2, sy=.5` stays lod 0) and is Skia's `sqrt(area scale)` rule for
  rotated / skewed draws. The node is `mipmap` only while |det A| < 0.5, `linear` otherwise. Mip only on surfaces and
  `src_in<N>` (unchanged rule). A transform edit is ≤ 6 uniform sets (+ one `inputfiltertype` set when crossing |det| = ½).
  Preview: `ctx.setTransform(A00, A10, A01, A11, x, y); drawImage(img, 0, 0, w, h)` with `imageSmoothingQuality = 'medium'`
  matches (measured: interiors ≤ 2/255 for rotation/skew with magnification, ≤ 5/255 minified).
- **Effects:** per layer an effect chain (`effects.EffectChain`: one GLSL TOP per pass, shader sources shared with the web preview)
  applied to the layer's masked, resampled content before its blend node. `DocNetwork(comp, blend, shape_glsl=, effects=,
  effect_shaders=)`: `effects` = the `effects.py` module (default: DAT `effects` in the COMP, else the sibling file),
  `effect_shaders` = `effects.load_shader_texts()` result (default: loaded by the module); without them layer effects are
  disabled (`stats()["fx_error"]` says why). Wiring per pixel / input layer with at least one effect that draws: the layer is
  ALWAYS staged through `xf_L_<id>` (also for an integer offset: the shader's exact texelFetch branch, so the content is
  bit exact and the mask is applied before the effects), the chain reads `xf_L_<id>` and its last pass is input 1 of the blend
  (no mask, identity mapping there). Text / shape layers: the chain reads the shape / text node (when masked, an identity
  `xf_L_<id>` pass applies the mask first). Groups / adjustments ignore `effects`; a disconnected input has none. Chain nodes
  come from (and return reset to) the spare GLSL pool; shader text DATs `fxsrc_<type>` live in `doc` and are shared;
  a parameter edit is only `par` sets on the chain's nodes; toggling effects on/off builds / removes the chain in < 1 ms
  with a warm pool. A failing chain falls back to the layer without effects (`fx_error`). **Flatten (`render_layer_source`) is
  content only: effects are not included.**
- **Files:** `Projectfile` (File), `Saveproject`, `Openproject` (pulses), `Pngfile` (File), `Exportpng`
  (pulse) parameters with help; TD writes/reads `.redoc` from its own surface buffers (budgeted, off the
  main thread where possible: PNG encode in a worker thread), PNG from `out1` (`TOP.save`).

## 4. Validation additions

Tool behaviour (unit/browser), affine parity TD vs preview (rotation/skew incl. masks), floating selection
commit, quick mask round trip, selection grow/shrink/smooth/border maths, effects parity TD vs WebGL preview
per effect (≤ 3/255 for deterministic effects, documented tolerance for pixel sort), `.redoc` save → open
round trip (pixels, specs, effects, guides identical), PNG export equals out1, multiple inputs: connect
2–3 TOPs (sizes differ), layers appear, reorder/transform, disconnect/reconnect keeps placement,
Follow Input uses input 1, and the always-one-spare-connector rule.
