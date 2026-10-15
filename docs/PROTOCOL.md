# TD ⇄ Web protocol (version 5; see §6–7 for the v4/v5 additions)

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
