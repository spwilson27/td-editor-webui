# Raster Editor v4 — transforms, canvas size, rulers/guides, TD-only text/shapes, export

Builds on `DESIGN_V3.md` (tag `v0.3.0`). Protocol: `PROTOCOL.md` §7 (version 5).

## 1. Decisions (design Q&A)

| Topic | Decision |
| --- | --- |
| Export | Replace **Save TOX** with an **Export Path** file parameter (TD file browser, `.tox`) and an **Export with Document** pulse (freeze → `comp.save(path)` via temp + rename → thaw). Help text on both. |
| Text/shapes | Remove the per-layer Rasterize toggle: text/shape layers are **always rendered by TD** (`rasterize` is gone; they never own a surface). The browser still draws them for the Local preview only. |
| Flatten | A **Flatten** button in the layer row next to the lock (text/shape layers). TD renders that layer's content alone at document resolution; the browser fetches the pixels and replaces the layer with a pixel layer (history entry). The Layer ▸ Flatten Layer menu item stays. |
| Scaling | **Non-destructive transforms** for every layer that has pixels (pixel layers, TD Input) — position + scale (`x, y, sx, sy`), stored in the document. TD applies them in the blend shader (GPU, bilinear when magnifying, mipmapped when minifying); the browser preview applies the same mapping. Text/shape layers scale by editing their geometry (stay sharp). **Layer ▸ Apply Transform** bakes a pixel layer's transform (resample into a new surface; history). |
| Painting on a transformed layer | Strokes are mapped into the layer's own pixel space (dab position via the inverse transform, dab size ÷ scale); selection clipping is transformed the same way. |
| TD Input | Movable and scalable like any layer; its transform is applied **inside TD** (base blend node). It stays locked for painting. |
| Canvas size | Set in the UI (**Document ▸ Canvas Size…**: W, H, 9-point anchor). The document **follows the input resolution until a size is set**; a **Follow Input Size** reset returns to following. Mode + size are stored in the document and mirrored in `Docw`/`Doch` + a new `Docsizemode` parameter (Follow Input / Fixed). Resizing the canvas never resamples pixels; layers keep their transforms (shifted by the anchor). |
| Rulers / guides | Pixel rulers (top/left, follow zoom/pan, show cursor position); drag from a ruler to create a guide, drag to move, drag back onto the ruler to delete; View ▸ Show Rulers / Show Guides / Snap. **Snapping** (to guides, canvas edges and centre, layer bounds) for move/transform, shapes, text placement and marquee. Guides are **saved with the document**. |

## 2. Surfaces and transforms

- A surface (pixel layer, mask, TD Input) has its **own size** `surfaceW × surfaceH`, no longer the document
  size. New empty pixel layers are document-sized with an identity transform. Imported images keep their
  native resolution (up to 8192²) and get a fit-to-canvas scale instead of being resampled. A mask has the
  size of its layer's surface and lives in layer space (it moves/scales with the layer).
- Layer → document mapping: `doc = (x, y) + (sx, sy) · layer` (layer pixel (0,0) top-left at doc (x, y)).
  `x, y` may be fractional; `sx, sy > 0` (flips are out of scope). Identity = `x=y=0, sx=sy=1`.
- The TD Input surface is the input TOP's resolution; its default transform when an input first connects
  in Follow Input mode is identity; in Fixed mode it is fitted (contain) and centred.
- Selection stays in document space.

## 3. Engine changes (contract: `web/src/engine/types.ts`)

- `LayerSpec` / `LayerInfo`: `rasterize` removed; `sx, sy` added; `surfaceW, surfaceH` added (pixel/base
  layers, `null` otherwise). `DocSpec` gains `guides: { h: number[]; v: number[] }` (doc px) and
  `canvas: { mode: 'input' | 'fixed' }`.
- New methods: `setTransform(id, t)`, `applyTransform(id)`, `layerBounds(id)` (doc-space rect),
  `setCanvasSize(w, h, anchor)`, `setCanvasMode(mode)`, guides (`addGuide`, `moveGuide`, `removeGuide`,
  `guides()`), `setSnap(opts)`, `snapPoint(x, y)`/`snapRect(r)`, `replaceWithPixels(id, rgba, w, h)` (used by
  Flatten when TD's pixels arrive). `setRasterize` is removed.
- Move tool: dragging moves the active layer (pixel/base → transform x/y; text/shape → geometry); a
  transform box with 8 handles scales (Shift = keep aspect, Alt = from centre); snapping applies to the
  box edges/centre. Context bar shows X/Y/W/H/scale % fields.

## 4. TouchDesigner

- **Resample pass + blend pass** (`blend.glsl`): `uOffset` became `uXform = (x, y, sx, sy)`
  (`doc = (x, y) + (sx, sy) · layer`). A pixel/base layer whose transform is **not** an integer offset at scale 1
  gets an extra GLSL TOP `xf_L_<id>` (`uAdjust = 7`, document-size output, inputs: surface, mask or the surface
  again, surface) that renders surface × coverage × mask into document space; the blend node then reads it with
  `texelFetch` (identity mapping, no mask). Integer offsets at scale 1 have no extra node: the blend pass places the
  surface itself (bit exact). TD builds mip chains for *all* inputs of a mipmap-filtered GLSL TOP (and keeps doing
  so), so only `xf_L_*` nodes ever use `inputfiltertype = mipmap`, and their inputs are surfaces or `base_src`
  (never the doc-size accumulator); every blend/shape node is `nearest`. The pass is created/removed (pool node,
  3 connects) when a transform enters/leaves the integer-offset case; a transform edit otherwise is 4 uniform sets
  (+ one `inputfiltertype` set when crossing the mip threshold).
- Sampling in the resample pass: linear; trilinear mip level `lod = max(0, -log2(sqrt(sx·sy)) - 0.5)`, i.e. the
  **geometric mean** of the two scales (anisotropic scales are not mipped by the larger factor), minus half a
  level. This was fitted against Chromium/Skia `drawImage` with `imageSmoothingQuality = 'medium'` (best lod vs
  scale for isotropic and anisotropic cases): `sx=2, sy=0.5` is lod 0, `sx=0.5, sy=0.25` is lod 1. The filter is
  `mipmap` only while `lod > 0` (`sx·sy < 0.5`). Input extend = hold; outside the source rect = transparent; edge
  pixels get fractional coverage (the browser canvas snaps the rect to whole pixels: 1 px fringe difference at
  fractional positions). Preview parity: use `imageSmoothingQuality = 'medium'` (`'low'` aliases when
  minifying, `'high'` is bicubic when magnifying and differs by up to ~30/255). The base layer's resample/blend
  node gets the TD Input's transform (only while an input is connected; the input keeps its own resolution;
  `blank`/the output stay canvas sized). Surface Script TOPs `s<slot>` are allocated at `surfaceW × surfaceH`
  (mask: its layer's surface size; masks of adjustment/group/text/shape layers: document size; missing sizes:
  document size).
- Text/shape layers are always TD rendered at document size (`rasterize` and any slot on them are ignored).
- `DocNetwork` interface additions (see DESIGN_V2 §8): `surface_size(slot) -> (w, h) | None` (also for slots in
  their grace period), Flatten API (called by the ext **every frame** while a request is in flight, all cheap
  lookups): `render_layer_source(layer_id) -> TOP | None` (the text/shape source node at document resolution,
  transparent background, premultiplied, independent of opacity/mask/blend/visibility; `None` = layer gone / not a
  text-shape layer; the transparent `blank` TOP for a layer without a spec), `render_layer_status(layer_id) ->
  'ready' | 'pending' | 'failed' | None` (does at most `FLATTEN_BUDGET` = 200 Text TOP measurement cooks per call,
  so polling converges; `'failed'` = the layout fell back to the 0.5 em estimate and is retried with back-off),
  `render_layer_ready(layer_id) -> bool`, `render_layer_token(layer_id)` (changes on every real `apply()`, when the
  node behind the layer is replaced or its layout is refined; `None` = gone; compare before cooking and after the
  readback, drop the result if it differs). `set_input_connected()` also re-plans the base transform on the next
  `apply()`. A surface size change is 2 parameter sets on the existing Script TOP (the ext must re-upload).
- Flatten: `renderLayer {requestId, layerId}` → TD renders the text/shape source node alone at doc
  resolution (premultiplied → straight), served like a TOP import (`topReady` + `GET /top`).
- Canvas: `setCanvas {w, h, mode}` from the active client updates `Docsizemode`/`Docw`/`Doch`; in
  Follow Input mode the doc size = input size (or `Docw/Doch` with no input); TD output is always the
  document size.
- Parameters: `Exportpath` (File, `.tox`), `Exportdoc` (pulse) replace `Savetox`; new `Docsizemode`
  (menu). All with help text.

## 5. Validation additions

Transform parity TD vs preview (scale up/down, fractional positions, masks on transformed layers, base
transform); painting on a scaled layer lands where the cursor is; Apply Transform; canvas resize with
anchors and Follow Input reset (input resolution change while following / fixed); Flatten of text and shape
equals TD's own rendering; guides persisted through Export with Document → load; snapping unit tests;
`Exportpath`/`Exportdoc` round trip.
