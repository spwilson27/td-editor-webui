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

- **Inputs:** `in1..in8` In TOPs created on demand (always one spare connector); per input a `src_in<N>`
  Select; BASE frames per input (`slot` header field = input index; `GET /base?input=N`); an `inputs`
  message lists `{input, w, h, connected}` (replaces `baseSize`).
- **Affine resample:** `uXform` becomes a 2×3 matrix (inverse mapping) + source size; lod from the
  matrix's minimal singular value; mip only on surfaces (unchanged rule).
- **Effects:** per layer an effect chain (one GLSL TOP per enabled effect, shader sources in
  `td/raster_editor/effects/*.glsl` shared with the web preview) applied to the layer's masked, resampled
  content before its blend node. Drop shadow/glow use a separable blur (Blur TOP or GLSL), pixel sort a
  bounded multi-pass GPU sort (document the algorithm and its limits), glitch seeded/deterministic.
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
