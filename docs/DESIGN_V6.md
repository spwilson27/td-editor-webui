# Raster Editor v6 — performance, filters, rough edges

Builds on `DESIGN_V5.md`. Phase A starts while v5 finishes (isolated files); phase B after v5 is committed.

## 1. Decisions (design Q&A)

| Topic | Decision |
| --- | --- |
| Performance (#1) | All five items: blur **downsampled pyramid** (no cap beyond 200 px; cost ~constant in radius), **bounding-box blending + skip empty layers + cache of the stack below the edited layer** (TD), **8-bit intermediates / merged Normal runs** where exact, **browser below-active composite cache** during strokes, **a one-time TD-view suggestion above ~8 MP (never automatic, see §4)** + **pre-warmed resample nodes**. |
| Filters | Four groups, each filter usable **both** as a per-layer effect and as an adjustment layer (one shared shader): **Blur & sharpen** (motion, radial, zoom, lens/bokeh, unsharp mask, high-pass); **Colour grading** (curves RGB/per-channel, gradient map, colour balance, vibrance, channel mixer, selective colour, posterize, duotone, LUT `.cube`); **Stylise & distort** (emboss, edge detect, Kuwahara/oil, pixelate, dither ordered/error-diffusion, CRT/scanlines, film grain, bloom; displace (noise or another layer/input), twirl, ripple/wave, lens distortion, polar, kaleidoscope, tile/mirror); **"Animated" set made static**: grain/noise (seeded), drift glitch, feedback/echo trails, colour cycling — **no time dependence**; iterative ones (feedback, glitch drift, echo) take an **iterations** parameter and are **recomputed only when their input or parameters change** (TD: no time-dependent nodes; cook only on input change). |
| Rough edges (#3) | Bold/italic for font-collection fonts in TD; **adjustment layers limited by the active selection** (auto mask, as Photoshop does when creating an adjustment with a selection); **effects on groups** (applied to the group's composite) and **on adjustment layers** (applied to the adjusted result before mixing); **brush presets** (save/load/rename/delete, persisted per document + per viewer) + **textured/scatter tips + colour jitter**; **undo across saves** (bounded history persisted with the document). |

## 2. Phase A (now)

- **Filters library** (owner: filters agent): shader sources under `shared/effects/` (same framework as v5
  effects: planner `plan_effect`/`planEffect`, `vectors.json`, WebGL2 runner, `EffectChain`), each filter
  a pass list; static-only; iterative filters with `iterations` (bounded, ≤ 64) and deterministic seeds;
  LUT `.cube` parsing in both Python and TS (3D LUT texture as a 2D atlas); displace-by-layer/input takes
  a second source (document the extra input in the chain API). Blur pyramid for all blur-type passes
  (shared effects/adjustments). Types are drafted in `shared/effects/filters.d.ts` (merged into
  `web/src/engine/types.ts` in phase B).
- **TD performance** (owner: network agent): bounding-box blends (per-layer content bounds, blend only the
  union rect via scissor/viewport offset or a cropped pass, pass-through outside), skip empty/fully
  transparent layers, cache the composite below the active (edited) layer so edits cook only the passes
  above it, 8-bit intermediates where results are exact (no adjustments/blur/effects above), merged
  multi-input pass for runs of plain Normal layers, pre-warmed resample/pool nodes, TD Blur TOP / pyramid
  for adjustment blur. Measured with `scripts/perf_td.py` at 4K/34 layers vs `docs/HARDENING.md`.

### 2.1 TD performance: implemented design (network.py / blend.glsl)

`DocNetwork(..., optimize=True)` (default; `optimize=False` = the v5 network, kept for A/B). Everything below is internal to
`network.py`; the ext-facing API is unchanged. Measured with `scripts/perf_td.py --ref WORKTREE [--no-opt] [--w 1920 --h 1080]`;
parity with `scripts/network_dev.py all` (new section `v6`: the v6 network against a second `optimize=False` network).

**What TD offers.** A TOP owns its output texture, there is no scissor / viewport / in-place update on a GLSL TOP, and the plain
GLSL TOP has at most 3 inputs. So a "cropped pass + composite back" costs the full-frame pass it tries to avoid. The savings
come from (a) fewer full-frame passes (merging) and (b) smaller *source* textures (cropping resample / shape passes), plus
shader early-outs outside each layer's rect.

* **Skip rules** (no blend pass; sources / surfaces stay, uncooked): hidden, opacity <= 0, pixel layer without slot / input layer
  on a disconnected input / singular matrix, content outside the canvas (or an empty content hint), text without printable
  characters or alpha 0, shape without enabled fill / stroke with alpha, empty group (or all children skipped), no-op adjustment
  (blur < 0.1 px, unknown type). Surfaces (`s<slot>`) and the text / shape nodes behind Flatten always exist.
* **Bounds.** `layer_box` = transformed surface rect (`affine_box`) clipped to the canvas, 1 px pad (partial coverage; with a hint
  also the filter reach); `shape_box` = rotated geometry + half stroke + arrowhead reach (1.1 x H) + 2 px AA, clipped; text / group /
  adjustment / input layers: whole canvas (input resolution is not known at plan time; text bounds need measured glyph widths: gap).
  A transformed pixel layer's resample pass `xf_L_<id>` renders only its box (custom resolution; `uA.xy` shifted by the box origin) and
  the blend places it at the integer box origin; a shape with a box < half the canvas (no mask / effects) renders into a second,
  cropped node `shapec_<id>` (same shader, shifted uniforms); the full-size `shape_<id>` stays the Flatten source (never cooked by
  the blend). Optional hint API: `set_content_bounds({id: (x0,y0,x1,y1)|None})` (layer pixels, must be a superset of the
  non-transparent pixels; takes effect at the next apply); `content_box(id)` reports the box used.
* **Merged passes.** Runs of consecutive plain layers (pixel / input / text / shape / group; any blend mode, masks, opacity, integer
  offsets; up to 8 layers, 7 masks) become ONE `mrg_L_<first id>` **GLSL Multi TOP** (`blend.glsl` uAdjust 8; slot uniforms
  `uL0..uL7` = (mode + 16 x mask input, opacity, x, y)). It always has 16 wired inputs (blank padding) because TD recompiles the
  shader whenever the input count changes (~15 ms). The accumulator stays float32 across the run; each slot reads only its own
  rect and skips transparent texels; Normal uses the division-free source-over. Adjustments end a run and keep their own pass; a
  single leftover layer keeps `blend_L_<id>`. Optional `set_active_layer(id)` splits runs around the layer being edited.
* **8 bit rule.** A pass's output is `rgba8fixed` iff everything downstream (later items of the chain, and for a group chain the
  group's own blend and everything above the group) is a plain Normal blend; Normal source-over never amplifies an input error and
  the browser canvas is 8 bit too. Anything that divides by alpha / colour (non-Normal modes, adjustments' unpremultiply, blur,
  effects) keeps `rgba16fixed` inputs (colour-burn amplifies an 8 bit step to > 4/255; tested). Cropped resample passes are 8 bit
  for Normal layers.
* **Blur pyramid.** Radius >= 7: `adj_L_<id>_dn` (GLSL, blend.glsl uAdjust 9: padded grid of ceil(w/s)+2k cells, each the mean of the
  s x s source block with coordinates clamped to the image = exact edge hold) -> `adj_L_<id>` (Blur TOP, size = r/s x 4.698, k = size+1
  pad cells so no extend mode is needed) -> `adj_L_<id>_up` (GLSL uAdjust 10, bilinear at ((x+.5)/s + k)), s = 2^floor(log2(r / 3.5)).
  Cost ~constant (4K: ~0.5 ms for r = 8..100, ~5 ms at r = 400 vs 4.4 / 12 / 245 ms). Parity vs a numpy gaussian with edge hold:
  <= 9/255 on test images (radii 7..200) and 5.5/255 with thin bright bands ON the document border (v5 Blur TOP: 4..9, and 131 on
  the border bands). Not converged with blurlib's variance-compensated pyramid.
* **Pre-warmed spares.** Spare GLSL TOPs (3 inputs) and Multi TOPs (16 inputs) are cooked once against a 16x16 constant
  (`warm_in`) from `tick()` after >= 0.3 s without `apply()`; their first real use no longer compiles the shader.
* **Cache of the stack below the edit.** TD already cooks only nodes downstream of a change; nothing else recooks the chain
  (checked: parameter sets touch only the edited node; idle cooks 0 nodes). Edit cost is therefore (passes from the edited layer
  up); fewer passes make it cheaper (table in the report). Remaining whole-chain triggers are inherent: a changed input wiring below,
  a format change, a resolution change, an inserted / removed / reordered layer (also shifts merge boundaries).

Gaps / follow-ups: text layers are not cropped (Flatten and metrics refresh need the document-size Text TOP; bounds need glyph
metrics); group results and adjustment / effect layers are full-canvas; the ext does not yet call `set_content_bounds` /
`set_active_layer`; the Script TOP upload (`OnSurfaceCook` copies the whole buffer) is ext-side and untouched.

## 3. Phase B (after v5 commit)

Engine (selection-limited adjustments, effects on groups/adjustments, brush presets + textured tips +
jitter, undo persistence, browser composite cache, filter adjustment layer kinds wired to the filters
library), UI (filter browser/menus, presets panel, tips, one-time "try TD view" notice above ~8 MP), protocol v7 (filters in
LayerSpec/adjustments, history blob persistence `GET/PUT /history`, presets in DocSpec), ext (history
persistence in doc_state/.redoc, TTC font faces), network integration of filter adjustments + group/
adjustment effects.

## 4. Decisions for unattended completion (2026-10-15)

- **Publishing:** tag `v0.5.0` / `v0.6.0` locally when each milestone is reviewed and live-validated; **do not push**.
- **Parity exceptions:** if a filter/effect cannot match TD in the browser within tolerance, the **Local preview
  shows TD's render of that layer** (per-layer TD render stream, fetched like the VIEW stream: notice + HTTP
  pull, only for layers flagged `tdPreview` by the planner) instead of computing its own.
- **Undo across saves:** persist the **last 50 steps, ≤ 256 MB** (oldest dropped beyond either limit).
- **Auto TD view for large documents:** **never automatic** — show a one-time notice suggesting TD view above
  ~8 MP instead.
