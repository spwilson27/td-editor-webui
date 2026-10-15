# Raster Editor v3 — import, text, shapes, selections, parameter help

Builds on `DESIGN_V2.md` (tag `v0.2.0`). Protocol additions: `PROTOCOL.md` §6 (version 4).

## 1. Decisions (from the design Q&A)

| Topic | Decision |
| --- | --- |
| Component parameters | Keep all; every parameter gets help text (`par.help`) — what it does, units, default, when to change it. |
| Image import | File ▸ Place Image… (file picker), drag-and-drop onto the canvas, Ctrl/Cmd+V paste, and File ▸ Import from TouchDesigner… (TD lists the project's TOPs; the chosen TOP's current image is copied in once). Each import creates a new pixel layer above the active one. |
| Text and shapes | New editable layer kinds `text` and `shape`. Per-layer **Rasterize** checkbox: **off** = TD renders it live (Text TOP / shape GLSL), no pixel upload; **on** = the browser renders it into a pixel surface (exact match with the preview). Properties stay editable either way. **Flatten** (Layer ▸ Flatten Layer) converts it into a plain pixel layer (history entry). |
| Shapes | Rectangle (+ corner radius), ellipse, line / arrow, polygon / star. Fill and stroke. |
| Selections | Any-shape selection (pixel mask). Tools: rectangular marquee, freehand (lasso), flood select (wand). Modes New / Add / Subtract / Intersect (context bar; Shift = add, Alt = subtract, Shift+Alt = intersect). Feather radius + antialias. Flood select: tolerance, contiguous, sample current layer / all layers. Select menu: Select All, Deselect, Invert, Mask from Selection. |
| Fonts | TD enumerates the system font families (Text TOP `font` menu) and sends them; the text tool lists them; built-in fallback list when standalone. |

## 2. Engine (`web/src/engine`, contract in `types.ts`)

### 2.1 Selection

- Selection = doc-sized alpha mask (`Uint8` coverage, browser-only, never sent to TD) plus its bounding
  rect; `selection()` keeps returning the bounding `Rect | null` for existing callers; new
  `selectionMask()` returns `{ rect, alpha }`, `selectionPath()` an outline for marching ants
  (rect or polygon list; for flood/feathered selections a contour traced from the mask at 50 %).
- All paint tools, fill, gradient, eraser, move-pixels(n/a), adjustments preview etc. clip to the mask
  (multiply by coverage), not just the rect.
- Marquee / lasso / wand produce a shape mask, combined with the current one by mode, then feathered
  (gaussian, radius px) and antialiased (lasso polygon fill with AA; marquee AA is trivial).
- Wand: flood from the clicked pixel on the active surface or the composite (`sampleAll`), tolerance
  0–255 (max channel delta incl. alpha), contiguous or global.
- `selectAll`, `deselect`, `invertSelection`, `maskFromSelection(layerId)` (adds/replaces the layer's mask
  with the selection coverage; history entry). Selection changes are history entries (as in common editors).

### 2.2 Text and shape layers

```ts
interface TextSpec { text: string; font: string; size: number /*px*/; color: RGBA; align: 'left'|'center'|'right';
  bold: boolean; italic: boolean; lineHeight: number /*multiple*/; x: number; y: number /*top-left of box, doc px*/;
  boxWidth: number | null /*null = no wrap*/ }
type ShapeSpec =
  { type: 'rect'; x; y; w; h; radius: number; fill; stroke; rotation: number }
| { type: 'ellipse'; x; y; w; h; fill; stroke; rotation }
| { type: 'line'; x1; y1; x2; y2; stroke; arrowStart: boolean; arrowEnd: boolean }
| { type: 'polygon'; cx; cy; radius; sides: number /*3..64*/; innerRatio: number /*1 = polygon, <1 = star*/; fill; stroke; rotation }
// fill = { enabled: boolean; color: RGBA }, stroke = { enabled: boolean; color: RGBA; width: number }
```
- Layer kinds `text` and `shape` carry `text` / `shape` specs and `rasterize: boolean`.
  `rasterize = true` → the layer owns a surface slot rendered by the browser (Canvas 2D) whenever the
  spec changes (full-surface `surface` event, bounded to the shape's bbox ∪ previous bbox).
  `rasterize = false` → no slot; TD renders from the spec; the browser preview renders the same spec
  directly in the compositor (no surface).
- Masks, opacity, blend, visibility, groups work for text/shape layers like pixel layers.
- `flattenLayer(id)` → replaces the layer by a pixel layer with the rendered pixels (keeps mask, opacity,
  blend, name). Paint tools on a text/shape layer → notice "Flatten the layer to paint on it".
- Tools: **text** (click = new text layer at point and open the inline editor; click on an existing text
  layer's box = edit it; Esc/click-away commits; empty text deletes the new layer), **shape** (drag =
  bounds; Shift = constrain square/circle/45°; current shape type, fill/stroke from the context bar;
  primary colour = fill, secondary = stroke by default). Move tool moves text/shape layers by editing
  their spec position (not x/y offset) so TD renders crisply.

### 2.3 Image import

`importImage(rgba, w, h, name)` → new pixel layer above the active one, image centred; if larger than
the document it is scaled down to fit (aspect kept), with a notice. The UI decodes files/clipboard with
`createImageBitmap`; TD TOP snapshots arrive straight-alpha via protocol §6.

## 3. TouchDesigner

- **Text layers (rasterize off):** `text_<id>` Text TOP at doc resolution, transparent background,
  font/size/colour/alignment/bold/italic/line spacing/position/word-wrap width mapped from `TextSpec`;
  output → blend input 1 (masks/opacity/blend as usual). Font = family name from the TD font list.
- **Shape layers (rasterize off):** one GLSL TOP `shape_<id>` drawing the shape with an antialiased SDF
  (fill + stroke, rotation, rounded corners, arrows, star) at doc resolution.
- Parity with the browser preview is checked by coverage/bbox and colour rather than per pixel
  (font rasterisers differ): text bbox within ±2 px, glyph coverage IoU ≥ 0.9; shapes per-pixel ≤ 24
  at edges, exact in interiors.
- **Fonts:** `fonts` message after `hello` (from a Text TOP's `font` menu; cached).
- **TOP import:** `listTops` → TD lists every TOP in the project except those inside `raster_editor`
  (path, w, h); `importTop {path, requestId}` → TD reads the TOP with a delayed readback (no stall),
  converts to straight RGBA top-left in budgeted slices and announces `topReady`; the browser pulls
  `GET /top?requestId=` (frame type 6). Max 8192×8192.
- **Parameter help:** every custom parameter on `raster_editor` gets `help` text (and the page a short
  description). Read-only `Status` and `Viewmode` explain they are informational.

## 4. Validation additions

- Selections: unit/browser tests for modes, feather, AA, wand tolerance/contiguous/sample-all, lasso,
  invert, mask-from-selection, clipping of every paint tool.
- Text/shape: rasterize on/off toggle round trip; TD-rendered vs browser preview parity (bbox/IoU for
  text, per-pixel tolerance for shapes) in `validate_td.py`; flatten; undo.
- Import: file, paste, drag-drop in e2e (Playwright file chooser + synthetic clipboard/drag events);
  TOP import live (constant + ramp TOP, sizes larger than the doc → scaled).
- Parameter help: a live check that every custom parameter has non-empty `help`.
