# Raster Editor v2 — compositing in TouchDesigner

Supersedes the compositing/output parts of `DESIGN.md` (v1 is tag `v0.1.0`). Everything not
mentioned here (tools, UI look, security, base-frame HTTP pull, test layers) stays as in v1.
Wire protocol: `PROTOCOL.md` (version 3).

## 1. Decisions (from the design Q&A)

| Topic | Decision |
| --- | --- |
| Stroke rasterisation | Browser paints (existing engine); TD composites. Each paint surface is one Script TOP. |
| Compositing | TD node network generated inside the COMP; the browser no longer sends a flattened image. |
| Viewport | Two modes, toggled in the UI: **Local** (browser preview composite) and **TD** (TouchDesigner's output). Both work in the panel and in an external browser. A latency readout is shown in both. |
| Ownership | UI is the source of truth for the layer stack; the TD network is generated to mirror it. Manual edits inside the generated `doc` COMP are overwritten. |
| Layer kinds | Pixel, group, base (TD input), **adjustment** (Levels, Brightness/Contrast, Hue/Saturation, Blur, Invert, Threshold), **masks** on pixel and adjustment layers. No external-TOP layers. |
| Persistence | The document (layer stack + all surfaces) is saved inside the `.toe` / `.tox` and restored on open. History is not persisted. |

## 2. Data flow

```
 browser engine (authoritative stack + surface pixels, history, tools)
   │  doc {layers…}  (JSON, on every structural/prop change)
   │  SURFACE tiles  (binary, per surface slot, dirty rects only)
   ▼
 raster_editor COMP
   ext.py ── surface buffers (numpy, premultiplied, TD row order) ─► doc/s<slot> Script TOPs
   network.py ── diff(stack) ─► doc/ generated network:
        base(in1) → blend_<id> → blend_<id> → … → out   (GLSL blend per layer, isolated groups,
                                                         adjustment TOPs, mask inputs)
   out ─► out_switch ─► out1 (component output)
   out ─► view_panel (panel TD-view overlay)  /  GET /view (external TD-view)
```

- No COMPOSITE (type 2) messages any more: TD's output is the generated network.
- BASE frames still flow TD → browser (HTTP pull) because the browser needs the input for the Local
  preview, the picker and flood fill; in TD-view mode they may be rate-limited harder (`Maxinputfps`).
- TD sends `applied {frameId}` (≤ once per TD frame) after surface tiles are uploaded so the browser can
  show stroke → TD latency in both modes.

## 3. Engine changes (browser) — contract in `web/src/engine/types.ts`

- **Surfaces and slots.** Every pixel buffer that TD mirrors is a *surface* with a numeric `slot`
  (u16, unique within a document, never reused within a document, persisted). A pixel layer has one
  pixel surface; a mask is a second surface. Groups, adjustments and base have no pixel surface.
- **Events.** `{type:'surface', slot, rect}` is emitted for every pixel change of a surface (paint,
  fill, undo/redo patch, move does NOT change pixels — it changes `x,y` in the stack). The bridge sends
  dirty tiles per slot, coalesced per animation frame.
- **Masks.** `addMask(layerId)` (white = fully visible), `deleteMask`, `setMaskEnabled`,
  `setPaintTarget(layerId, 'pixels'|'mask')`. Stored internally as RGBA with rgb = 255 and alpha =
  mask value so preview compositing is `destination-in`; `readSurface` returns it as grey RGBA
  (r=g=b=mask, a=255) on the wire. Painting on a mask uses the luminance of the paint colour; the eraser
  paints black (hides); fill uses luminance. Masks apply to the layer's own content (pixel layer) or to
  the adjustment's effect (adjustment layer).
- **Adjustment layers.** `addAdjustment(type)` above the active layer. `AdjustmentSpec`:
  - `levels {inLow, inHigh, gamma, outLow, outHigh}` (0..1, gamma 0.1..10)
  - `brightnessContrast {brightness -1..1, contrast -1..1}`
  - `hueSaturation {hue -180..180 (deg), saturation 0..2, value 0..2}`
  - `blur {radius 0..200 px}`
  - `invert {}`
  - `threshold {level 0..1}` (luminance ≥ level → white else black, alpha preserved)
  An adjustment applies to the accumulated result **below it within its parent** (inside a group only to
  the group's content below it), mixed by `opacity × mask`. Param edits are coalesced into one history
  entry per 1 s like opacity.
- **Preview compositor (Local mode).** Same as v1 plus masks (`destination-in`) and adjustments
  (`ctx.filter` for blur / hue / saturate / brightness / contrast / invert; levels and threshold applied
  in JS on the dirty rect). The preview approximates TD within the tolerances in §7; TD is the truth.
- **TD-view mode.** `setPreviewEnabled(false)` stops the compositor's automatic work (no recomposite
  during strokes). `readComposite` / picker still composite on demand for the requested rect.
- **Document I/O.** `docSpec(): DocSpec` (the stack as sent to TD), `readSurface(slot, rect, out?)`,
  `loadDocument(spec)` (replaces everything, allocates surfaces empty, clears history) followed by
  `writeSurface(slot, rect, rgba)` (no history) and `commitSurfaces()`.
- **Base layer** is no longer paintable (always locked); its pixels in TD come straight from `in1`.

## 4. TouchDesigner network

All generated nodes live in `raster_editor/doc` (a baseCOMP). `network.py` owns everything in it.

### 4.1 Per-layer nodes (names use the layer's `slot` or a sanitised id)

| Layer | Nodes |
| --- | --- |
| base | `in1` (or `blank` constantTOP, transparent, doc size, when no input) → `blend_base` |
| pixel | `s<slot>` scriptTOP (surface, cooked by ext.py) → `blend_<id>` input 1 |
| mask | `s<maskSlot>` scriptTOP → `blend_<id>` input 2 (shader reads `.r`) |
| group | own chain starting at `blank` → … → group result → `blend_<groupId>` input 1 (isolated group) |
| adjustment | `adj_<id>` = Level / HSV Adjust / Blur / Threshold TOP (or a short chain) whose input is the accumulated result below → `blend_<id>` input 1, with `adjust=1` so it mixes instead of blending |

`blend_<id>` is a GLSL TOP using the shared pixel shader `td/raster_editor/blend.glsl` (embedded as
`doc/blend_glsl` text DAT). Inputs: 0 = below (accumulated), 1 = source, 2 = mask (optional).
Uniforms: `uMode` (int, BlendMode index in the order of `types.ts`), `uOpacity`, `uOffset` (layer x,y in
doc px, applied to inputs 1 and 2; outside the source = transparent), `uHasMask`, `uAdjust`.
- `uAdjust = 0`: W3C *source-over with blend mode* (Compositing and Blending Level 1, separable and
  non-separable modes), premultiplied in/out. This is exactly what Canvas 2D does for
  `globalCompositeOperation`, so Local and TD match.
- `uAdjust = 1`: `out = mix(below, adjusted, opacity × mask)` with `adjusted` = input 1.
- Hidden layer → `blend_<id>.bypass = True` (passes input 0).
Chain order is bottom → top within each parent; the root chain's last node feeds `doc/out` (null TOP).
The network is cooked lazily by TD; painting layer *k* recooks only blends *k..N*.

### 4.2 Diffing

`DocNetwork.apply(spec)` compares the new stack with the previous one and only creates / destroys /
rewires / sets parameters as needed (no full rebuild on a prop change). Node positions are laid out
in columns per depth so the network is readable. Unknown nodes inside `doc` are destroyed.
Surfaces whose slot disappears are destroyed after a 2 s grace (undo of a delete restores them
quickly without re-upload — the browser resends their pixels anyway).

### 4.3 Viewport in TD-view mode

- **Panel:** the panel background becomes `panel_view` = Over(webrender, `doc_view`). `doc_view` is
  a Transform of `doc/out` into panel resolution using the browser's `view` message
  (`zoom`, `panX`, `panY`, viewport rect in panel px), over a checkerboard limited to the document rect,
  transparent elsewhere. The Web Render TOP has `transparent` on; in TD-view mode the page draws the
  surround, shadow and overlays (cursor, marching ants) but leaves the document rect transparent.
  Local mode: panel background is `webrender` as in v1.
- **External browser:** TD streams `doc/out` back with the base-frame mechanism (notice `view` +
  `GET /view`, newest frame only, ≤ `Maxviewfps` (default 30), only to clients that sent
  `view {mode:"td"}`), converted incrementally like base frames. The viewport draws that image.

### 4.4 Persistence

- `doc_state` text DAT holds the last applied `DocSpec` JSON (+ `rev`).
- Surface Script TOPs are **locked** while the project/component is saved so their pixels are stored in
  the file: Execute DAT `onProjectPreSave` → `ext.Freeze()` (upload current buffers, lock all surface
  TOPs), `onProjectPostSave` → `ext.Thaw()` (unlock). Component export uses the same pair
  (`ext.SaveTox(path)`).
- On start: `ext.Restore()` reads `doc_state`, rebuilds the network, reads each surface's locked
  image back into its numpy buffer (`numpyArray()`), then unlocks.
- A connecting **fresh** page (empty document) whose `hello.hasDocument` is true loads the document
  from TD (`docState` + `GET /surface` per slot). A reconnecting page that already has a document
  re-sends its full stack and all surfaces (it is authoritative). Takeover: the new active client
  loads the document from TD first (standby clients cannot edit, so nothing is lost).
- `build_component.py` preserves `doc` + `doc_state` of an existing COMP across rebuilds.

### 4.5 Parameters (additions)

`Maxviewfps` (int, 30), `Viewmode` (menu Local/TD, read-only mirror of the active client's choice,
for display), `Savetox` (pulse: export via `ext.SaveTox`).

## 5. UI changes

- Layers panel: mask thumbnail next to the layer thumbnail (click = paint on mask, highlighted;
  Shift-click = disable/enable mask, red cross when disabled); footer **Add mask** enabled for pixel and
  adjustment layers; **Adjustment** footer button opens a menu: Levels, Brightness/Contrast,
  Hue/Saturation, Blur, Invert, Threshold. Adjustment rows show an adjustment icon instead of a
  thumbnail.
- Studio: a contextual **Adjustment** panel (tab next to Layers/History, auto-selected when an
  adjustment layer becomes active) with the sliders for that type, editing live.
- Status bar: segmented toggle **Local | TD** and the latency readout (`stroke → TD 34 ms`; in TD mode
  also `view age` for the external stream). View menu has the same toggle.

## 6. Performance budgets (additions to DESIGN §6)

| Item | Budget |
| --- | --- |
| Surface tile paste + Script TOP upload for a dirty 1080p surface | < 3 ms per TD frame (median) |
| Network GPU cook, 20 layers incl. 3 adjustments + 3 masks @1080p | < 4 ms |
| `DocNetwork.apply` for a prop change | < 2 ms; structural change (add/delete) < 10 ms |
| Stroke → TD output (`applied` latency, local loopback) | median ≤ 3 TD frames |
| TD-view in panel: stroke visible in panel | ≤ 4 TD frames |
| TD-view external stream @1080p | ≥ 20 fps, age ≤ 120 ms median |
| Browser in TD-view mode during strokes | no compositor work beyond on-demand picker |

## 7. Validation additions (TESTING §3)

- **Blend parity:** for each of the 16 blend modes and each adjustment type, a scripted document is
  composited by TD and by the browser preview; max per-channel difference ≤ 3 (blend modes) and
  ≤ 8 (adjustments; blur ≤ 12 at edges), reported per mode.
- **Masks:** painted mask hides exactly the masked pixels in TD output.
- **Persistence:** paint, `Savetox` to a temp path, load that `.tox` into a fresh COMP, verify the
  document (stack + pixels) and TD output are identical; also `Freeze/Thaw` round trip. Never save
  the user's `.toe`.
- **Latency:** report median/p95 `applied` latency and panel TD-view latency while dragging, and the
  external TD-view stream fps and age.
- **Reconnect / takeover:** fresh page loads TD's document; reconnect re-sends; takeover loads.

## 8. Python module boundary (TD side)

Two modules, two owners; `ext.py` is the only caller of `network.py`.

```python
# td/raster_editor/network.py — owns everything inside raster_editor/doc and the panel_view overlay
class DocNetwork:
    def __init__(self, comp, blend_glsl: str): ...       # comp = raster_editor COMP; creates doc/ if missing
    def apply(self, layers: list[dict], doc_w: int, doc_h: int) -> None
        # LayerSpec dicts (PROTOCOL §3). Diff-apply; creates one Script TOP `doc/s<slot>` per pixel/mask
        # slot (resolution doc_w x doc_h, callbacks DAT = doc/surface_callbacks which calls
        # parent.RasterEditor.OnSurfaceCook(scriptOp)), destroys removed ones after a 2 s grace.
    def surface_top(self, slot: int)  # -> scriptTOP | None
    def slots(self) -> list[int]
    def output(self)                  # -> doc/out (null TOP); ext wires out_switch input 1 to it
    def set_view(self, view: dict | None, panel_w: int, panel_h: int) -> None
        # view = PROTOCOL `view` message of the panel client when mode == "td", else None (local mode).
        # Builds/updates doc_view + panel_view; returns nothing; ext sets the COMP background TOP to
        # panel_view() when view is not None, else to webrender.
    def panel_view(self)              # -> TOP for the COMP background in TD-view mode
    def freeze(self) -> None          # lock every surface Script TOP (pixels saved with the file)
    def thaw(self) -> None            # unlock them
    def read_locked(self) -> dict[int, "np.ndarray"]   # slot -> float32 (h, w, 4) TD row order, from locked TOPs
    def stats(self) -> dict           # node counts, last apply ms
```

`ext.py` owns: protocol v3 handling, surface numpy buffers (`slot -> uint8[h, w, 4]`, TD row order,
premultiplied), tile paste, `OnSurfaceCook` (`copyNumpyArray` when that slot is dirty), `applied`
reports, `doc_state` storage, `docState` / `GET /surface` / `GET /view` (+ incremental conversion of
`doc/out` for the external TD-view stream, same budgeted pipeline as base frames), `Freeze/Thaw/Restore/SaveTox`,
view-mode switching of the COMP background, and `build_component.py`.
