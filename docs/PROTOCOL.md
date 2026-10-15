# TD ⇄ Web protocol (version 6; see §6–8 for the v4/v5/v6 additions)

One WebSocket per browser client, served by the COMP's Web Server DAT at
`ws://127.0.0.1:<Port>/ws`. Text messages are JSON; binary WebSocket messages are SURFACE tiles
(web → TD) only. **TD never writes image data to a WebSocket** (`webSocketSendBinary` blocks TD's cook
thread when a peer stops reading): TD → web images are announced with a small JSON notice and pulled
with HTTP `GET` (§4), whose responses are written on the server's own threads.
Both sides MUST ignore unknown JSON message types and unknown fields.

Version history: v1 banded WebSocket BASE + COMPOSITE; v2 BASE over HTTP pull; **v3** removes
COMPOSITE (TD composites the layer stack itself, see `DESIGN_V2.md`), adds the document stack, surface
tiles, document load, the TD view stream and latency reports.

Implementations: `web/src/bridge/codec.ts` and `td/raster_editor/protocol.py`.
Shared fixtures: `docs/fixtures/*.bin` + `docs/fixtures/fixtures.json`.

## 1. Binary frame messages

Little-endian. 24-byte header followed by the payload.

| Offset | Type | Field | Notes |
| --- | --- | --- | --- |
| 0 | 4 bytes | magic | ASCII `REF1` |
| 4 | u8 | type | `1` BASE (TD → web, `GET /base`), `3` SURFACE (web → TD, WebSocket), `4` SURFACE_DUMP (TD → web, `GET /surface`), `5` VIEW (TD → web, `GET /view`). `2` (v1/v2 COMPOSITE) is invalid in v3 |
| 5 | u8 | flags | bit 0 `FRAME_END`: last band of this frame; other bits 0 |
| 6 | u16 | slot | surface slot for SURFACE / SURFACE_DUMP; 0 for BASE and VIEW |
| 8 | u32 | frameId | increments per frame per sender, wraps at 2^32 |
| 12 | u16 | docW | document width the sender believes is current |
| 14 | u16 | docH | document height |
| 16 | u16 | x | band rect, document pixels, top-left origin |
| 18 | u16 | y | |
| 20 | u16 | w | ≥ 1 |
| 22 | u16 | h | ≥ 1 |
| 24 | bytes | payload | `w*h*4` bytes RGBA8, **straight (non-premultiplied) alpha**, row-major, top row first |

Rules:

- Rect must lie inside `docW × docH`; payload length must equal `w*h*4`. Violations → drop, log once
  per frameId.
- `docW/docH` ≠ receiver's current document → drop silently (stale).
- SURFACE frames: one or more bands sharing `frameId` (one `frameId` per coalesced batch of dirty rects of
  ONE slot), last band has `FRAME_END`, each WebSocket message ≤ 2 MB payload. A SURFACE frame for a
  slot TD does not know (not in the last `doc`) is dropped. Mask surfaces are sent as grey RGBA
  (`r=g=b=mask`, `a=255`); TD uses `r`.
- HTTP-delivered frames (BASE, SURFACE_DUMP, VIEW) are always one band covering the whole document
  with `FRAME_END` set.
- Receivers publish on `FRAME_END` only (TD: upload the slot's Script TOP; web: commit).
- Colour: sRGB 8-bit. TD converts premultiplied ⇄ straight at its edge (`Premultiplied` parameter);
  the web side only ever sees straight alpha.

## 2. JSON messages

All have a string field `t`.

### Web → TD

| `t` | Fields | Meaning |
| --- | --- | --- |
| `ready` | `protocol: 3`, `client: "panel" \| "external"`, `version`, `token`, `fresh: bool` | first message. `fresh` = the page has no document of its own yet (just loaded). Token rules as v2 |
| `doc` | `rev: number`, `layers: LayerSpec[]` | full layer stack (§3), sent by the active client after any structural / property change, coalesced to ≤ 1 per animation frame. TD applies it to the generated network and stores it |
| `requestDoc` | — | ask TD for its stored document (`docState` reply, then `GET /surface` per slot) |
| `view` | `mode: "local" \| "td"`, `zoom`, `panX`, `panY`, `rect: {x, y, w, h}` | viewport state: `rect` is the canvas element's rect in CSS px within the page (= panel px, DPI 1); `panX/panY` = document origin offset within `rect` in CSS px. Sent on change, ≤ 1 per animation frame. Panel client: drives the TD-view overlay. External client: `mode:"td"` subscribes to `view` notices |
| `takeover` | — | become the active editor |
| `requestBase` | — | re-announce the stored base frame |
| `log` | `level`, `msg` | as v2 |

### TD → Web

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `protocol: 3`, `doc: {w, h}`, `hasInput`, `maxSendFps`, `active`, `clientId`, `hasDocument: bool`, `rev: number \| null` | reply to `ready`. `hasDocument` = TD holds a stored document (`rev` of it) |
| `docState` | `rev`, `layers: LayerSpec[]`, `docW`, `docH` | reply to `requestDoc`. The client calls `loadDocument`, then fetches every surface slot listed (pixel + mask) with `GET /surface` |
| `base` | `frameId`, `docW`, `docH`, `x:0`, `y:0`, `w`, `h` | as v2: fetch with `GET /base` |
| `view` | `frameId`, `docW`, `docH`, `w`, `h`, `appliedFrameId` | a newer TD output frame can be fetched with `GET /view` (external clients in TD mode only; at most one un-fetched notice per client). `appliedFrameId` = newest SURFACE frameId from this client reflected in that output |
| `applied` | `frameId`, `tdFrame` | newest SURFACE frameId from this client that TD has uploaded to its Script TOP; sent at most once per TD frame, only when it changed (latency measurement) |
| `docSize` | `w`, `h`, `hasInput` | as v2 (web resizes, clears history, TD reallocates surfaces anchored top-left) |
| `active` | `active` | as v2 |
| `error` | `msg` | as v2 |

## 3. LayerSpec

`layers` is a flat list in **stack order: bottom first**, children listed after their group in their own
bottom-first order (i.e. a depth-first walk, bottom → top, group before its children).

```ts
interface LayerSpec {
  id: string;                    // stable engine id
  kind: 'base' | 'pixel' | 'group' | 'adjustment';
  parentId: string | null;
  name: string;
  visible: boolean;
  opacity: number;               // 0..1
  blend: BlendMode;              // ignored for adjustment layers
  x: number; y: number;          // integer offset, pixel layers (0 otherwise)
  slot: number | null;           // pixel surface slot (pixel layers only)
  mask: { slot: number; enabled: boolean } | null;   // pixel + adjustment layers
  adjustment: AdjustmentSpec | null;                 // adjustment layers only
}
type AdjustmentSpec =
  | { type: 'levels'; inLow: number; inHigh: number; gamma: number; outLow: number; outHigh: number }
  | { type: 'brightnessContrast'; brightness: number; contrast: number }
  | { type: 'hueSaturation'; hue: number; saturation: number; value: number }
  | { type: 'blur'; radius: number }
  | { type: 'invert' }
  | { type: 'threshold'; level: number };
```

Exactly one `base` layer, first in the list, `parentId: null`. Locked state and group expansion are UI
only and not sent. BlendMode index order (for the shader's `uMode`) is the order of the `BlendMode`
union in `web/src/engine/types.ts`: normal=0 … luminosity=15.

## 4. HTTP pull endpoints

All require `token=<token>&client=<hello.clientId>` query parameters, loopback peer and loopback
`Host`; `403` otherwise. Responses are `application/octet-stream` with one frame message,
`Cache-Control: no-store`; loopback `Origin` is echoed in `Access-Control-Allow-Origin` (+ `Vary: Origin`)
for the Vite dev workflow.

| Endpoint | Body | Notes |
| --- | --- | --- |
| `GET /base?…&frameId=` | BASE frame | as v2 (newest stored input frame; `404` none yet) |
| `GET /surface?…&slot=` | SURFACE_DUMP of that slot (current TD buffer, straight alpha; masks grey) | `404` unknown slot. Used for document load |
| `GET /view?…&frameId=` | VIEW frame: newest converted `doc/out` image | only for clients subscribed with `view {mode:"td"}`; `404` none yet |

Notice rules (`base`, `view`): newest-only, at most one un-fetched notice per client and kind, a client
that has not fetched for 10 s is stalled (no further notices of that kind until it fetches),
`requestBase` / a new `view {mode:"td"}` re-announce and clear the stall, a `404` clears the notice,
`docSize` voids outstanding notices.

## 5. Session flow

1. Web opens socket, sends `ready` (with `fresh`).
2. TD replies `hello` (+ active assignment, panel priority as v2) and a `base` notice when it has input.
3. Active client:
   - `fresh` page and `hello.hasDocument` → `requestDoc`; on `docState`: `loadDocument`, fetch all
     surfaces, commit; then normal editing.
   - otherwise (fresh page without TD document, or reconnecting page with its own document) → send
     `doc` and every surface in full (SURFACE frames), then dirty tiles while editing.
4. Standby clients keep only a view (overlay "Editing in another window"); on `takeover` → TD makes it
   active → it sends `requestDoc` and loads TD's document before editing.
5. Every `doc` from the active client is applied by TD; SURFACE tiles are pasted and the slot's Script
   TOP is uploaded on `FRAME_END`; TD replies `applied` once per TD frame.
6. Viewport: the client sends `view` on mode/zoom/pan/resize changes; panel clients in TD mode get the
   TD overlay; external clients in TD mode receive `view` notices and fetch `GET /view`.
7. Input change in TD: as v2 (`docSize` / `base` notices).
8. Disconnect: TD keeps the document and its output. Reconnect → step 1 with `fresh: false`.

## 6. Version 4 additions (DESIGN_V3)

`ready.protocol` / `hello.protocol` = **4**. Everything in §1–5 is unchanged except:

- LayerSpec (`§3`): `kind` may also be `'text' | 'shape'`; new fields `text: TextSpec | null`,
  `shape: ShapeSpec | null`, `rasterize: boolean` (false for other kinds). A text/shape layer has a
  `slot` only when `rasterize` is true (then TD treats it exactly like a pixel layer); with
  `rasterize: false` TD renders it from the spec. Specs: `DESIGN_V3.md` §2.2 (RGBA colours are
  `{r,g,b,a}` 0..255, straight).
- Frame type `6` TOP_IMAGE (TD → web, `GET /top`): one band, `x=y=0`, `w×h` = the TOP's size,
  `docW/docH` = the same `w/h` (not the document size), `slot` 0, `FRAME_END`.

| Direction | `t` | Fields | Meaning |
| --- | --- | --- | --- |
| TD → web | `fonts` | `families: string[]` | sent after `hello`; sorted, de-duplicated font family names |
| web → TD | `listTops` | `requestId` | list importable TOPs |
| TD → web | `tops` | `requestId`, `items: [{path, w, h}]` | every TOP in the project outside `raster_editor`, ≤ 2000 items |
| web → TD | `importTop` | `requestId`, `path` | snapshot that TOP once |
| TD → web | `topReady` | `requestId`, `w`, `h` | fetch with `GET /top?token&client&requestId=` (frame type 6; `404` unknown/expired after 30 s) |
| TD → web | `topError` | `requestId`, `msg` | path invalid, not a TOP, too large (> 8192²), or readback failed |

## 7. Version 5 additions (DESIGN_V4)

`ready.protocol` / `hello.protocol` = **5**. Changes to §1–6:

- **LayerSpec:** `rasterize` removed (text/shape layers never have a `slot`; TD renders them from the
  spec). New fields `sx`, `sy` (scale, > 0; 1 = identity) for every layer (used by pixel and base layers;
  1 for others) and `surfaceW`, `surfaceH` (size of the layer's pixel surface for pixel and base layers,
  `null` otherwise; a mask has the same size as its layer's surface). `x`, `y` (may be fractional) are
  the doc-space position of the surface's top-left pixel; mapping `doc = (x,y) + (sx,sy)·layer`. The
  base layer's `x, y, sx, sy` are the TD Input transform; its `surfaceW/H` are the input size.
- **DocSpec message `doc`:** adds `guides: {h: number[], v: number[]}` and `canvas: {mode: "input" |
  "fixed"}`; stored in `doc_state`, returned in `docState`.
- **SURFACE / SURFACE_DUMP frames:** `docW/docH` header fields carry the **surface** size (stale check:
  a frame whose size differs from that slot's current surface size is dropped). Rects lie inside the
  surface.
- **BASE frames:** `docW/docH` = the input's size (the base surface size), not the document size.
- **`docSize`** keeps its meaning (document/canvas size) and gains `mode: "input" | "fixed"`; it no longer
  implies reallocating surfaces. A base-size change (input resolution) is announced by the next BASE
  notice's `docW/docH` and a `baseSize {w, h}` message.

| Direction | `t` | Fields | Meaning |
| --- | --- | --- | --- |
| web → TD | `setCanvas` | `w`, `h`, `mode` | active client sets the canvas size / mode (`mode:"input"` = follow input; `w,h` ignored) |
| TD → web | `baseSize` | `w`, `h` | TD Input resolution changed (or input (dis)connected: 0×0 = no input) |
| web → TD | `renderLayer` | `requestId`, `layerId` | Flatten: render that text/shape layer alone at doc size; reply `topReady` / `topError` and `GET /top` as §6 (frame type 6, `docW/docH` = doc size) |

Further v5 details (TD implementation):

- **`hello`** carries the canvas state: `doc: {w, h, mode}` (`mode` = `"input"` | `"fixed"`, the `Docsizemode` parameter) and
  `baseSize: {w, h}` (the input resolution, 0x0 = no input). `docState` also carries `guides` and `canvas: {mode}`.
- **`docSize`** is sent to every client when the document size, mode or `hasInput` changes (parameter edit, input change,
  `setCanvas`); the *sender* of a `setCanvas` only gets it when the result differs from its request (clamped, or the input's size for
  `mode:"input"`). It never reallocates surfaces. `baseSize` is sent whenever the input resolution changes or the input is
  (dis)connected, together with a fresh `base` notice whose `docW/docH` are the input size.
- **`renderLayer`** is answered with `topError` for: a non-active client, a restore in progress, a layer that is not a text / shape
  layer of TD's document, a document > 32 Mpx, a document resize during the render, and `"layer changed"` when the layer's
  operator was replaced or a newer `doc` was applied before the readback finished (the client may simply retry).
- A surface without `surfaceW/H` in the spec (adjustment / group masks, v4 documents) keeps the size of its existing buffer, else the
  document size; the engine should send `surfaceW/H` for pixel layers (masks follow their layer) to be exact.

## 8. Version 6 additions (DESIGN_V5)

`ready.protocol` / `hello.protocol` = **6**. Changes to §1–7:

- **LayerSpec:** `kind: 'base'` → **`'input'`** with `input: number` (1..8); a doc may contain several
  input layers, anywhere in the stack, or none. Pixel and input layers carry `rot`, `kx`, `ky` (degrees)
  next to `x, y, sx, sy`: `doc = T(x,y)·R(rot)·K(kx,ky)·S(sx,sy)·layer` (rotation clockwise on screen,
  K = [[1, tan kx],[tan ky, 1]]), about the surface's top-left. New field `effects: Effect[]` (shape in
  `web/src/engine/types.ts`). A v5 `base` layer is read as `input: 1`.
- **BASE frames:** header `slot` = input index (1..8). `base` notices carry `input`; fetch
  `GET /base?…&input=N`. Each input has its own newest frame and notice bookkeeping.
- **`baseSize` replaced by `inputs`:** TD → web `{t:"inputs", items:[{input, w, h, connected}]}` after
  `hello` and on any input change (connect/disconnect/resolution). `hello` carries the same `inputs` list.

| Direction | `t` | Fields | Meaning |
| --- | --- | --- | --- |
| web → TD | `saveProject` | `requestId`, `path?` | write the current document as `.redoc` (path omitted = `Projectfile` parameter; a given path is written to the parameter first) |
| web → TD | `openProject` | `requestId`, `path?` | read a `.redoc`, replace TD's document, then broadcast `reload` |
| web → TD | `exportPng` | `requestId`, `path?` | save TD's flattened output to PNG (`Pngfile`) |
| TD → web | `fileResult` | `requestId`, `op`, `ok`, `path`, `msg?` | outcome of the above (also sent, without `requestId`, when the pulses are used in TD) |
| TD → web | `reload` | `rev` | the stored document was replaced (Open Project): every client drops its document and reloads via `requestDoc` |
| TD → web | `files` | `projectFile`, `pngFile` | current parameter values (after `hello` and on change) for the UI's dialogs |

### 8.1 TD implementation details (v6)

- **`inputs`** lists every TD input connector that exists (`in1..inN`: the connected ones, the disconnected ones and the one spare
  unconnected connector behind the last connected one), `{input, w, h, connected}` sorted by input; a disconnected input is `0x0`. An input
  that is not listed no longer exists (treat it as disconnected). `hello.inputs` is the same list; `baseSize` is gone.
  `hello.hasInput` / `docSize.hasInput` = **input 1** is connected (Follow Input uses input 1 only).
- **BASE** (`GET /base?token&client&input=N`, default 1): frame header `slot` = N (1..8, validated: a BASE frame with slot 0 or > 8 is
  invalid), `docW/docH` = that input's size. Per input: newest frame only, at most one un-fetched `base` notice per client and input,
  a client that has not fetched an input's notice for 10 s is stalled for **that input** only (fetching it resumes), `404` for an
  unconnected input (clears that input's notice). `requestBase {input?}` re-announces one input (or all). A resolution change or
  (re)connect starts a new stream and notice for that input; a disconnect drops its frame.
- **Input layers in TD's stored document:** an input's resolution change updates the stored layer's `surfaceW/H` (and, for Fixed canvas or
  any input but 1, rescales `sx/sy` so the displayed box is kept); a reconnect after a disconnect keeps `x, y, sx, sy, rot, kx, ky`
  and only takes the new surface size. Switching to Follow Input resets input 1's transform (x, y, rot, kx, ky = 0, sx, sy = 1).
  `docState` fills in missing input surface sizes with the live input size. Before any client sent a document TD's default stack
  has one input layer (`id: "input<N>"`) per connected input (input 1 alone when none is connected).
- **`parse_doc` validation:** `kind: "base"` is migrated to `input: 1` (id kept); `input` must be 1..8 and an input layer has no `slot`;
  `rot` any finite number; `kx, ky` finite and **clamped to ±85°**; `effects` only on pixel / input / text / shape layers (≤ 32 per layer),
  every field of the effect's type is required and range-checked (colours RGBA 0..255, `opacity` 0..1, bevel `depth` 0..100, pixelSort
  `low/high` 0..1, glitch `amount` 0..100 and integer `seed`, `blockSize` 1..4096, lengths ≥ 0 and ≤ 512 (TD clamps to 128), `position` /
  `direction` / `key` / `shape` enums). An invalid doc is answered with `error` and changes nothing.
- **Files.** Paths: `path` (or the `Projectfile` / `Pngfile` parameter when omitted) is absolute or relative to the project folder; the
  ending `.redoc` / `.png` is added when missing; a given path is written to the parameter first (and `files` is broadcast). The
  operations run one at a time and are refused (`fileResult ok:false`, `msg`) while TD restores the document, while another file
  operation runs, or when the editor is inactive. `fileResult` goes to the requester only (to every client for a pulse).
  - `saveProject`: snapshot on TD's main thread, PNG encode + zip + atomic rename in a worker. `openProject`: read / validate /
    decode in a worker (damaged or invalid files change nothing), then TD replaces its document (rev = max(old, file) + 1, canvas mode
    and Docw/Doch from the file, input layers' surface sizes follow the live inputs) and sends `reload {rev}` to **every** client; until a
    client sends `requestDoc` TD ignores its `doc` messages and SURFACE tiles (they were produced for the old document). `exportPng`:
    TD's output (`out1`, document size) read back with the budgeted delayed readback, un-premultiplied per `Premultiplied`, written as
    8-bit RGBA PNG.
  - `.redoc` = zip: `meta.json {format: 1, app, version, slots}`, `doc.json {rev, layers (with surfaceW/H), guides, canvas:{mode},
    width, height}`, `surfaces/<slot>.png` (straight RGBA8, masks grey). Readers refuse `format` > 1.
- **`chooseFile {requestId, purpose}`** (`placeImage | openProject | saveProject | exportPng`; web → TD) and **`fileChosen {requestId, path}`**
  (TD → web; `path: null` = cancelled / no dialog available). The windowless panel browser cannot open file pickers, so the page asks TD:
  the pump (not the server callback) calls TD's native `ui.chooseFile` -- **modal: it blocks TD's main thread (output cook, all clients) until
  the user answers**. One pending dialog per client (a second request is answered with `path: null`). For `openProject` / `saveProject` /
  `exportPng` the page then sends the matching file message with that path. For `placeImage` TD, after `fileChosen`, loads the image with a
  temporary Movie File In TOP (png jpg jpeg tif tiff bmp gif tga exr hdr webp psd, ≤ 512 MB; 10 s to load) and serves it as a TOP import:
  `topReady {requestId, w, h}` + `GET /top?...&requestId=` (frame type 6), or `topError {requestId, msg}`.
  Test-only: with `Panelquery` containing `test=1` the message may carry `testPath` (string, or null = cancel) which replaces the dialog.
- `Status` shows file results for 10 s and `effects unavailable: ...` when the network could not load the layer effects.

## 9. Version 7 additions (DESIGN_V6 §5)

`ready.protocol` / `hello.protocol` = **7**.
- LayerSpec: `effects[]` may contain filter-library types (any `^[A-Za-z][A-Za-z0-9]{0,47}$` type; params per
  `shared/effects/filters*.d.ts`); adjustment layers may be `adjustment: {type:"filter", effect: Effect}`; group and
  adjustment layers may carry non-empty `effects[]`. `DocSpec.brushPresets: BrushPreset[]` (see `types.ts`).
- Frame type `7` LAYER_PREVIEW (TD → web, `GET /layer?token&client&layerId=`): one band, doc-sized, straight RGBA8,
  `slot` 0. Notice `{t:"layerPreview", layerId, frameId}` (one outstanding per client+layer; same stall/404 rules as `view`),
  sent only for layers TD's planner flags `tdPreview`.
- `{t:"activeLayer", id}` web → TD (active client; drives `set_active_layer`).
- History: `POST /history?token&client&rev` (body: history blob, ≤ 256 MB) → `204`; `GET /history?token&client` → `200`
  blob with header `X-Doc-Rev`, or `404`. Stored in COMP storage and in `.redoc` (`history.bin`).
- **tdPreview stream (TD side).** One stream per layer the network lists in `preview_layers()` (planner-flagged `tdPreview` effect /
  filter adjustment; visible layers only), only while an editor is active and only to the active client. TD reads
  `network.layer_preview_source(id)` back with the budgeted delayed readback (as VIEW; one layer converts per pump), re-reading only when
  `network.layer_preview_token(id)` changes (a static layer costs nothing). `layerPreview` carries `docW/docH` too; `GET /layer?...&layerId=`
  always serves the NEWEST frame of that layer (404 = no frame: not flagged / not active client / no source). When TD answers `requestDoc`
  it forgets what it announced (the page drops its previews while loading), so the newest frames are announced again.
- **History** (details). `POST /history` needs the active editor (`409` otherwise), `rev` = non-negative integer (`400`), body <= 256 MB
  (`413`; measured: 256 MB takes ~4 s end to end, the main thread stalls < 0.4 s), an empty body clears it. The blob is stored with `rev`
  in COMP storage (`raster_history`) as ONE object (atomic replace). It is dropped when a `doc` arrives with a lower rev than the stored
  history (a fresh document) and on Open Project (the file's `history.bin`, if any, is stored at the new rev). Save Project writes
  `history.bin` (+ `meta.historyRev`) only when the stored history belongs to the saved rev. `OPTIONS /history` answers the CORS preflight
  for loopback dev origins; `X-Doc-Rev` is exposed.
- **`activeLayer {id|null}`**: only the active client's value is used; TD calls `network.set_active_layer` (and re-plans once) when it changes.
  TD also tracks the painted bounds of every pixel slot from SURFACE tiles and calls `network.set_content_bounds` (empty layer -> `None`;
  transformed layers get a padded 64-px-grid box that grows only when the paint leaves it; restored / opened surfaces: no hint).
- **`DocSpec.brushPresets`**: validated (<= 64 presets, <= 16 custom tips, PNG data URLs <= 2 MB, tips <= 512 px), stored with the document,
  returned in `docState` (always, `[]` when none), written to `doc.json` of a `.redoc`. A `doc` without the field keeps the stored list.
- **`chooseFile` purpose `readText`** (for `.cube` LUTs): `{t:"chooseFile", requestId, purpose:"readText", fileTypes?:["cube"]}`; TD opens its
  file dialog, reads the file as UTF-8 and answers `fileChosen {requestId, path, text}`; failure (> 12 MB, binary, not UTF-8, unreadable)
  -> `fileChosen {requestId, path, error}` (no `text`); cancel -> `path: null`. Same one-dialog-per-client rule and `testPath` stub as the
  other purposes.
- **`saveProject.includeHistory`** (default true when absent): `false` writes the `.redoc` without `history.bin` / `meta.historyRev`; the history
  stored in the COMP is untouched. An empty `POST /history` body clears the stored history (`GET /history` then answers `404`).
- **Open Project rev / history revs.** The document rev is always monotonic: Open Project sets `max(TD rev, file rev) + 1`, so a stale page
  that was disconnected during the Open cannot win (its `hello.rev` differs: reload). History is stored as `(docRev, histRev, blob)`:
  `docRev` = the document rev it is served for, `histRev` = the rev embedded in the blob. `GET /history` answers `X-Doc-Rev: <docRev>`
  and `X-History-Rev: <histRev>` (the page loads the history when `X-Doc-Rev` equals the rev it loaded and passes `X-History-Rev` to its
  restore). `POST /history?rev=R` stores `(R, R, blob)`. Open Project stores the file's `history.bin` as `(newRev, meta.historyRev, blob)`
  ONLY when `meta.historyRev` equals the file's document rev, and drops the previous history only after the document was replaced.
  Save Project writes `history.bin` + `meta.historyRev = histRev` only when `docRev` equals the saved document's rev.
- **Export with Document / SaveTox** never embeds the stored history (it is unstored around the save and restored). The `.toe` project
  save does keep it (that is the point). Memory: a 256 MB upload peaks at about the body once (the server's bytes object is the stored object);
  replacing an existing history holds both until the old one is released (~2x). An oversize body is refused by `Content-Length` when the
  server passes the header on, otherwise after it was read (`413`). `readText` decodes `utf-8-sig`. Brush preset names that are missing,
  empty or too long are normalised by TD (`"Brush preset"`, 256 chars) instead of rejecting the document. Layer-preview notice records are
  created only for layers that have a stream.

## 10. Version 8 additions (DESIGN_V7)

`ready.protocol` / `hello.protocol` = **8**.
- Adjustment layers: `adjustment: null` and `effects[]` = the FX stack applied to everything below. A layer with a
  non-null legacy `adjustment` (v2–v7 docs) is migrated on read: classic spec → `{type:<same name>, enabled:true, …params}`
  effect; `{type:'filter', effect}` → that effect; prepended to the layer's existing `effects[]`.
- New effect types `levels`, `brightnessContrast`, `hueSaturation`, `invert`, `threshold` (params as the former
  `AdjustmentSpec` variants).
- `renderLayer` gains `mode: "flatten" | "mergeDown"` (default `"flatten"`; v7 `renderLayer` on text/shape = flatten).
- New `renderLayers {requestId, layerIds: string[]}` → isolated composite of those layers (stack order) → `topReady` /
  `topError`, fetched with `GET /top` (frame type 6, doc-sized).
