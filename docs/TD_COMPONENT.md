# TouchDesigner component: `raster_editor`

Target: TouchDesigner 2025.32820 (Python 3.11, numpy available). Verified API notes are
at the end; check anything else against the live TD through `scripts/td_call.py`.

## 1. Network inside the COMP

`raster_editor` is a **containerCOMP** with one TOP input and one TOP output.

| Operator | Type | Role |
| --- | --- | --- |
| `in1` | inTOP | the COMP's single input. May be unconnected. |
| `out1` | outTOP | the COMP's single output, fed by `out_switch` |
| `out_switch` | switchTOP | index 0 = `in1` passthrough (until the first composite arrives, or when `Active` is off); index 1 = `composite` |
| `composite` | scriptTOP | receives the flattened document from the web app; callbacks DAT `composite_callbacks` copies the extension's numpy buffer when dirty |
| `webserver` | webserverDAT | binds 127.0.0.1:`Port`, serves `ui_html` at `/` and `/index.html`, `404` elsewhere, hosts WebSocket at `/ws`; callbacks DAT `webserver_callbacks` delegate to the extension |
| `webrender` | webrenderTOP | loads `http://127.0.0.1:<Port>/?client=panel` (or `Devurl`), resolution = COMP `w`×`h`, DPI 1, `alwayscook` on; it is the COMP's **background TOP** so the panel shows the UI |
| `panel_exec` | panelexecuteDAT | watches panel values `u v lselect mselect rselect wheel` (`panelvalue` par) and forwards them to `webrender.interactMouse`; button state comes from the on/off *edges* (a fast click flips a button twice in one frame) |
| `keyboard` + `keyboard_callbacks` | keyboardinDAT + its callbacks | forwards keys to `webrender.sendKey` only while this COMP's panel has focus |
| `frame_exec` | executeDAT | `onFrameStart` → `ext.Pump()`; `onStart/onCreate` → `ext.Start()`; `onExit` → `ext.Stop()` |
| `par_exec` | parameterexecuteDAT | reacts to the custom parameters below (its `op` par must point at the COMP; callbacks arrive a frame later, not synchronously) |
| `RasterEditorExt` | textDAT | extension class (from `td/raster_editor/ext.py`) |
| `protocol`, `frames` | textDAT | python modules (from `td/raster_editor/*.py`), imported by the extension via `op('protocol').module` |
| `ui_html` | textDAT | the built single-file web app (`dist/ui/index.html`) |

The extension class is `RasterEditorExt` and is promoted, so other networks call e.g.
`op('raster_editor').GetStatus()`, `.GetStats()`, `.Pump()` (or `op(...).ext.RasterEditorExt`).
Callback DATs delegate with `parent().OnHTTPRequest(...)`, `.OnWebSocketText(...)` etc.

The container's panel shows the Web Render TOP as its background (`par.top = './webrender'`).
**The panel background is not enough to keep it alive**: a Web Render TOP that nothing pulls
never loads its page (the editor would not even connect), and `alwayscook` does not change
that. When no pane shows the COMP, `Pump` therefore forces a cook of `webrender` whenever its
`totalCooks` did not advance since the last frame (`_keep_panel_cooking`); when a viewer
pulls it, nothing extra is done. A forced cook with no new browser frame costs ~3 µs.
(Careful when debugging: reading `.width`/`.numpyArray()` of an unpulled TOP cooks it and
hides the problem; compare `cookAbsFrame` with `absTime.frame` instead.)

## 2. Custom parameters (page "Raster Editor")

| Name | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `Active` | toggle | on | off → server stopped, output = input passthrough |
| `Port` | int | 9980 | Web Server DAT port; changing restarts the server and reloads `webrender` |
| `Docsizemode` | menu | Follow Input | `input` (Follow Input): document = input size (`Docw`x`Doch` with no input); `fixed`: always `Docw`x`Doch` (§8) |
| `Docw`, `Doch` | int | 1920, 1080 | document size when `Docsizemode` is Fixed, or Follow Input with no input |
| `Premultiplied` | toggle | on | treat TD TOP data as premultiplied alpha (unpremultiply input, premultiply output) |
| `Maxsendfps` | int | 30 | sent to the web app in `hello` |
| `Maxinputfps` | int | 30 | max BASE frame rate for time-dependent inputs |
| `Devurl` | str | "" | when set, `webrender` loads this URL with `?ws=ws://127.0.0.1:<Port>/ws&client=panel` (Vite dev server workflow) |
| `Panelquery` | str | "" | extra query string appended to the panel URL, e.g. `test=1` (installs `window.__editorTest`; it also enables the test-only `POST /__test` back-channel, see §5) |
| `Exportpath` | file | "" | target of `Exportdoc`; empty = `raster_editor_export.tox` in the project folder (§8) |
| `Exportdoc` | pulse | | **Export with Document** (§8); replaces the old `Savetox` |
| `Openbrowser` | pulse | | opens `http://127.0.0.1:<Port>/?client=external&token=<token>` in the system browser |
| `Reloadui` | pulse | | reloads `webrender` |
| `Status` | str (read-only) | | e.g. `panel active · 1920×1080 · 24 fps out` |

COMP `w`/`h` (Layout page) define the UI resolution; default 1280×800.

## 3. Extension behaviour (`RasterEditorExt`)

Keep TD glue thin. All pixel math lives in `frames.py`, all byte layout in
`protocol.py`; both are pure python + numpy and fully unit tested without TD.

- **Security**: the Web Server DAT has no bind-address parameter (it listens on all interfaces), so the
  extension refuses non-loopback peers (`clientAddress`, WebSocket peer) and HTTP requests whose `Host`
  is not loopback (DNS rebinding). Every `ready` must carry the per-start `token` that is put in the
  panel URL and in the **Open in Browser** URL (docs/PROTOCOL.md). `POST /__test` exists only when
  `Panelquery` has the exact parameter `test=1`; bodies are capped at 64 KB.
- **State**: clients `{id: {kind, active}}`, active client id, `doc_w/doc_h/has_input`,
  output buffer `np.uint8[h, w, 4]` in **TD order** (bottom row first, premultiplied if
  `Premultiplied`), `dirty` flag, `got_composite` flag, last input signature, timing stats.
- **Web server callbacks**: HTTP GET `/` → `ui_html.text` (or 404), `GET /base` → the stored BASE frame; WS open → register;
  WS text → JSON dispatch (`ready`, `takeover`, `requestBase`, `log`); WS binary →
  `protocol.decode_frame` → `frames.paste_band(buffer, x, y, w, h, payload, premultiply)` →
  on `FRAME_END` set `dirty`, `got_composite` (the Pump then does one `composite.cook(force=True)`
  per frame, so several FRAME_ENDs in one frame cost a single 8 MB upload);
  WS close → unregister; if it was active, promote the most recent remaining client.
- **Script TOP `onCook`**: always `scriptOp.copyNumpyArray(buffer)` (the Script TOP only cooks when
  forced by the Pump or on first load) and clear `dirty`. The buffer is reused, never reallocated
  except on resize.
- **Pump (each frame start)**:
  - doc size = `in1` size if connected else `Docw×Doch`; if changed → reallocate buffer,
    `docSize` to all clients, mark base resend.
  - input change detection: connected and `in1.totalCooks` advanced (`in1.cook()` first, which
    is a no-op when clean); rate-limit by `Maxinputfps` (trailing edge is never lost); no
    readback while no client is ready. Readback is the two-step `in1.numpyArray(delayed=True)`
    (first call issues the GPU read and returns None, the next returns it: no stall).
    `frames.WireConverter.convert_rows` then converts ≤ 4 ms of rows per pump (flip to
    top-left, float→uint8, unpremultiply; 1080p ≈ 27 ms total). The finished image is published as
    one immutable `bytes` BASE message (`protocol.encode_message`, one copy, ~3 ms for 1080p) that
    `GET /base` serves, and each client gets a tiny `base` notice (at most one un-fetched notice per
    client; no fetch for 10 s → stalled, no more notices; docs/PROTOCOL.md §4). Nothing large is ever
    written to a WebSocket. New clients, `requestBase` and resizes re-notify from the stored frame.
  - each Pump step (module check, panel keep-alive, mouse flush, doc size, input, notify, cook, switch) is
    isolated: one failing step is reported and the others still run;
  - update `Status`, `out_switch.par.index` (`Active` off → index 0, composite forgotten).
- **Mouse**: `interactMouse(u, v, left=..., middle=..., right=..., wheel=...)` with the
  panel's `u`,`v` **unchanged** — both the panel and `interactMouse` use a bottom-left
  origin (verified with `comp.click()` on a tool button; passing `1 - v` mirrors clicks).
- **Keyboard**: `keyboard` (Keyboard In DAT, `panels` = this COMP so it only fires while the panel has
  focus) → `onKey(dat, keyInfo)` → `sendKey(key, char=, shift=, alt=, ctrl=, cmd=)`; key-down only,
  modifier-only keys skipped.
- Exceptions inside callbacks are caught, printed once per distinct message, and
  shown in `Status`; they never escape into TD's callback machinery repeatedly per frame.

## 4. Build & install

`td/build_component.py` runs inside TD (`scripts/td_call.py --exec td/build_component.py`):

1. Reads `dist/ui/index.html` and the python sources.
2. Destroys and recreates `/project1/raster_editor` (keeps node position if it existed),
   builds the network above, sets parameters, wires the extension.
3. Never touches operators outside the COMP (validation creates its own test TOPs and
   removes them afterwards).
4. Saves `dist/raster_editor.tox`.

Run it with `.venv/bin/python td/build_component.py [--dev]` (forwards itself to TD) or
`scripts/td_call.py --exec /absolute/path/td/build_component.py`.

`--dev` mode: DATs use `file` + `syncfile` pointing at the repo instead of embedding, so
python edits reload live.

## 5. Verified API notes (TD 2025.32820, Python 3.11.10, numpy 2.1.2)

Environment
- Web Render TOP is **Chromium/CEF 132.0.0.0** (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36`), `devicePixelRatio` 1,
  `OffscreenCanvas` available.
- The `td_call.py` namespace has no TD globals beyond `op`; start scripts with `from td import *`
  (and `import sys` etc.). `__file__` is only set by `--exec`.

Web Server DAT (`webserverDAT`; pars `active port restart callbacks`)
- Callbacks: `onHTTPRequest(dat, request, response)` (return `response`),
  `onWebSocketOpen(dat, client, uri)`, `onWebSocketClose(dat, client)`,
  `onWebSocketReceiveText(dat, client, data: str)`, `onWebSocketReceiveBinary(dat, client, data: bytes)`,
  `onWebSocketReceivePing/Pong(dat, client, data)`, `onServerStart/Stop(dat)`.
- `client` is a string `"127.0.0.1:63520"`; `uri` in `onWebSocketOpen` includes the query string.
- `request` keys: `method`, `uri` (path only), `pars` (dict of query parameters), `clientAddress`,
  `serverAddress`, `data` (bytes, empty for GET) and every HTTP header as a top-level key
  (`Host`, `Accept-Encoding`, ...). `response`: `statusCode`, `statusReason`, `data`, plus any header
  name (`response['content-type'] = 'text/html; charset=utf-8'` is honoured).
- Methods: `webSocketSendBinary(client, data: bytes)`, `webSocketSendText(client, str)`,
  `webSocketSendPong`, `webSocketClose(client)`, `webSocketConnections` (list of client strings).
- Large messages work in both directions: 2 MB binary echo 70 ms round trip, 8 MB 210 ms, and
  1080p COMPOSITE bands of ~2 MB from a client are received intact. Sending 2 MB from a callback
  costs 5–10 ms of main thread.

Web Render TOP (`webrenderTOP`)
- `interactMouse(u, v, leftClick=0, middleClick=0, rightClick=0, left=False, middle=False, right=False, wheel=0, pixels=False)`; `left=True` first time = mouse down, repeated = drag, `left=False` = up/move. Origin bottom-left.
- `sendKey(key, char=None, shift=False, alt=False, ctrl=False, cmd=False)`; key names match the Keyboard In DAT (verified `b`, `z`+`cmd`). `sendString(str)`. `executeJavaScript(line)` returns nothing; to get values back have the page `fetch('/__test', {method:'POST', body: ...})` (enabled only with `Panelquery` containing `test=1`; stored in `ext.test_result`).
- Pars: `source`=`urlorfile`, `url`, `outputresolution`=`custom`, `resolutionw/h`, `dpiscale`, `alwayscook`, `transparent`, `maxrenderrate` (default 30; set 60), `reloadsrc` pulse. Attribute `loaded`.
- **`active` is off on a freshly created Web Render TOP** (nothing loads); set `par.active = 1`.
- An unpulled Web Render TOP never loads its page (see §1); `Pump` keeps it cooking.

Cooking / readback
- `TOP.numpyArray(delayed=False)` returns float32 `(h, w, 4)`, bottom row first. With `delayed=True` the first call returns `None` and issues the read; later calls return the previously requested data.
- `op.cook()` (not forced) cooks only if dirty; `op.totalCooks` is a monotonic counter (use it for change detection); `cookAbsFrame` is the absolute frame of the last cook.
- `scriptTOP.copyNumpyArray(arr)`: shape `(h, w, 4)`, dtype uint8/uint16/float32. Row 0 is the **bottom** row. `composite.cook(force=True)` runs `onCook` and the 1080p upload measured 0.2–0.6 ms.

Panels / DATs
- `containerCOMP.par.top` takes a path relative to the COMP itself: `'./webrender'` (plain `'webrender'` and `op('webrender')` expressions do not resolve).
- Extensions: `comp.par.ext0object = "op('./RasterEditorExt').module.RasterEditorExt(me)"`, `ext0name`, `ext0promote = 1`, then `comp.initializeExtensions()`. Promoted methods are bound at init: monkeypatching the instance does not affect `comp.Method()`.
- Panel Execute DAT: `panelvalue` = space-separated panel value names; `panels` is the COMP being watched (default parent). Panel values on a container include `u v lselect mselect rselect wheel inside insideu insidev rollover select ...`. A simulated `comp.click(u, v)` produces `onOffToOn` and `onOnToOff` for `lselect` in the same frame, both with `val == 0`.
- Keyboard In DAT callbacks: `onKey(dat, keyInfo)`; `keyInfo.key/.character/.state/.shift/.alt/.ctrl/.cmd`; its `panels` par restricts events to when one of the listed panels has focus.
- Parameter Execute DAT only fires if its `op` par is set to the COMP; callbacks are not synchronous with the par assignment.
- `Execute DAT` `onFrameStart` fires every frame (Pump median 0.04 ms idle, 0.1–0.2 ms while streaming).

Why BASE frames are pulled over HTTP (measured)
- `webSocketSendBinary` is **synchronous on the cook thread**: when the peer's socket buffer is full it blocks
  until the peer reads. A client that never reads (a test client with a 4 KB receive buffer; a frozen tab) froze
  TouchDesigner completely three times (cook thread in a Web Server DAT `pthread_join`/send, td-mcp port 8765 and
  the UI stop answering until TD is killed). Per-frame acks and a 1x1 probe only narrowed it: a client that acked
  the probe and then froze would still block on the next ≤ 2 MB write.
- Web Server DAT **HTTP responses are not written on the cook thread**: a client that sent `GET` for a 32 MB
  `response['data']` (bytes) and never read the body left TD fully responsive for 30 s (870 frames advanced, td_call
  round trips 60 ms), and it recovered after the client reset. `bytes` bodies work; an 8 MB GET from a normal reader
  takes 28 ms, 32 MB 124 ms. So protocol v2 (docs/PROTOCOL.md §4) sends only tiny JSON `base` notices over the
  WebSocket and serves the frame from `GET /base`. The stored frame is one immutable `bytes` object (one 8 MB copy
  per published frame), so the HTTP thread can never see a half-rewritten buffer. Remaining risk: tiny JSON writes
  (`hello`, `docSize`, `active`, `base` notices; capped to one notice per client) cannot fill a socket buffer
  unless a client is dead for a very long time.


## 6. Protocol v3 / document network (supersedes the COMPOSITE parts above)

- **Removed:** `composite` Script TOP, COMPOSITE path, single output buffer. `out_switch`: input 0 = `in1`, input 1 =
  `doc_out` (a Select TOP on `doc/out`; wires cannot enter a child COMP). Index 1 once a stack was applied (a default
  base-only stack is applied at start), 0 while `Active` is off or the network failed.
- **New operators:** `network` (DocNetwork, network.py), `blend_glsl`, `doc_state` (text DAT, JSON `{rev, layers, docW,
  docH}`), `view_pack` + `view_pack_glsl` (GPU unpremultiply/flip/scale to exact 0..255 float32 for the VIEW stream: the CPU
  only casts, 2.4 ms instead of ~27 ms at 1080p), `doc` (generated network, preserved across rebuilds). The COMP has
  parent shortcut `RasterEditor` (`doc/surface_callbacks` call `parent.RasterEditor.OnSurfaceCook(scriptOp)`).
- **New parameters:** `Maxviewfps` (30), `Viewmode` (read-only mirror of the active client's mode), `Savetox` pulse (replaced by `Exportpath` / `Exportdoc`, §8).
- **Surfaces:** `surfaces[slot]` uint8 `[h, w, 4]` TD order, premultiplied (masks grey, a=255), allocated from `doc`
  messages and docSize (anchored top-left). A slot new to a `doc` always starts zeroed. Removed slots keep their buffer
  5 s. SURFACE tiles paste in place; on FRAME_END the slot is marked dirty; Pump force-cooks each dirty slot once
  (`OnSurfaceCook` copies the buffer on EVERY cook) and then sends `applied` (<= 1 per TD frame and client).
- **HTTP:** `GET /surface?slot=` (SURFACE_DUMP, straight alpha), `GET /view` (subscribed external clients only),
  same auth/CORS/notice/stall rules as `/base`. `view` notices carry `appliedFrameId` (-1 = none yet), the newest SURFACE
  frameId uploaded before the readback was issued.
- **Readback pipeline** (base and view, `_Pipe`): one `numpyArray(delayed=True)` call per frame both returns the previous
  read and issues the next (1 frame per pump when the source changes), leaky-bucket rate limit.
- **Persistence:** Execute DAT `onProjectPreSave/PostSave` -> `Freeze()/Thaw()`; `Start()` -> `Restore()` (stored
  stack -> network -> `read_locked()` -> buffers -> `thaw()`; finished by the first successful network apply, uploads are
  held until then). `SaveTox(path)` freezes around `comp.save`. `build_component.py` rebuilds in place, keeping `doc` and
  `doc_state` (Freeze first), and exports `dist/raster_editor.tox` from a clean throw-away build.
- **View messages:** panel client -> `DocNetwork.set_view` + COMP background `./panel_view`
  (back to `./webrender` for `local` or panel disconnect). The Web Render TOP's `transparent` is permanently on (toggling it
  reloads the page and drops the WebSocket); the page paints an opaque background in Local mode; external client `mode: td` -> VIEW stream.
- A rebuild with `Active` toggled off/on or a restart keeps pixels (buffers carried over when nothing was locked).
- **Restore safety:** while a restore is pending (the network's first apply failed) the locked images are the only copy:
  `Freeze/Thaw` leave them alone, `SaveTox` is refused, tiles / docs / requestDocs are held and replayed (a few ms per pump) and
  `/surface` answers 503. A client that overflows the 64 MB hold queue gets an `error` and, after the restore, `active:false`
  then `active:true` (the page reloads TD's document). Surface uploads are round robin and budgeted (~4 ms/pump); a dirty
  slot without a Script TOP is dropped after 3 s. `Freeze` first re-encodes slots still waiting for a `Premultiplied` toggle.

## 7. Protocol v4 additions (DESIGN_V3)

(Superseded in v5, §8: `rasterize` is gone, text / shape layers never have a surface slot; `SaveTox` is `ExportDoc`.)

Extension (`ext.py`), all on the main thread, bounded per pump, nothing large on a WebSocket:

- **Text / shape layers:** `protocol.parse_doc` validates `text` / `shape` specs, `rasterize` and requires a surface `slot`
  exactly when `rasterize` is true (then it is a pixel layer for TD). The stack is handed to `DocNetwork.apply` unchanged
  (the network renders `rasterize: false` layers; network.py).
- **Fonts:** after `hello` the extension sends `fonts {families}`. The list comes from the `font` menu of the hidden
  Text TOP `font_probe` (built by `build_component.py`; a temporary one is created if it is missing), reduced to
  family names by `ext.font_families` (trailing style words such as Bold / Italic are dropped), sorted and de-duplicated, cached
  for the session. A failure sends `[]` (the web app falls back to its built-in list).
- **TOP import:** `listTops` walks `/project1` for TOPs outside `raster_editor` (path, w, h; at most 2000, at most 50000
  scanned). Nothing is cooked to list: a custom resolution is read from its parameters, other sizes are read once per cook count and
  cached, a TOP that has never cooked reports 0x0. `importTop {requestId, path}`: the path must be a TOP outside the component (the
  resolved `op.path` is checked again, so wildcards / `..` cannot reach internals), at most 8192 x 8192 (known sizes are refused before anything is read).
  One import runs at a time (all clients), at most `TOP_QUEUE_MAX` (2) wait behind it, one per client: a newer request from the same
  client replaces its queued one or cancels its running one (`topError` "superseded") and is never refused for room; otherwise a full queue answers
  `topError "busy"`. **Memory:** the image is first shrunk on the GPU (a temporary Select + Resolution TOP, destroyed afterwards, filter
  mipmap) to fit `min(8192, 2*docW) x min(8192, 2*docH)` (aspect kept, never enlarged) and 32 Mpx (`protocol.import_target_size`); the
  reduced size is what `topReady` and the type-6 header report. Peak memory is therefore the float32 readback (at most 512 MB at 32 Mpx, typically
  34 MB for a 1080p document and a 4096x2160 source -> 3840x2025 is 124 MB) plus one header + RGBA8 buffer (at most 128 MB) that the converter writes into directly (no extra copy).
  The readback is the same two-step `numpyArray(delayed=True)` as BASE / VIEW (the first result is ignored, a late or wrong-sized
  read is repeated, 10 s timeout); rows are converted within 4 ms per pump (flip to top-left, un-premultiply per `Premultiplied`, read once per import).
  The finished buffer is the held message: 30 s, or 5 s after its last successful `GET /top`; at most 2 per client and 640 MB in total (oldest evicted).
  `Active` off, `Stop` and a `Port` change release all imports, temporaries and held images. `GET /top` (same token / loopback / `Host` /
  CORS / `no-store` rules as `/surface`) needs `client` and `requestId`; `404` for unknown or expired.
- **Parameter help:** `build_component.HELP` gives every custom parameter its `help`; the component's `comment` carries a
  short description (TD has no per-page description). The live step 17 of `scripts/validate_td.py` asserts that no
  custom parameter has an empty help.

## 8. Protocol v5 additions (DESIGN_V4)

`protocol.py` / `ext.py`; `docs/PROTOCOL.md` §7 is the wire contract.

- **Per-surface sizes.** Every slot's buffer is `surfaceW x surfaceH` of its layer (`protocol.slot_sizes`; a mask has its layer's
  size; a surface without a size in the spec -- adjustment / group masks, v4 documents -- keeps its existing buffer's size, else
  the document size). Buffers are allocated for slots new to a `doc` and **reallocated only when the spec size of that slot
  changes** (pixels kept top-left until the engine's resend); a canvas / document resize never touches them. SURFACE tiles are
  dropped as stale when their `docW/docH` differ from the slot's current buffer, SURFACE_DUMP carries the surface size, BASE
  frames the input size (`baseSize` message + the `base` notice). Freeze checks each locked TOP against its own slot size;
  restore, carried-over buffers and held tiles use per-slot sizes too.
- **Canvas.** `Docsizemode` Follow Input: document = input size (`Docw x Doch` with no input); Fixed: `Docw x Doch`. `setCanvas`
  from the *active* client sets the parameters (`mode:"fixed"` writes `Docw/Doch`; `"input"` ignores w/h); `docSize {w,h,hasInput,mode}`
  goes to every other client (and to the sender only when the result differs from its request, e.g. the input's size). A user
  edit of `Docsizemode/Docw/Doch` is pushed the same way; flipping Follow Input -> Fixed with the parameter alone keeps the current
  size (copied into `Docw/Doch` unless those were edited in the same step). `hello.doc.mode`/`hello.baseSize` carry the state on
  connect. `doc_state` stores `{rev, layers, guides, canvas:{mode}}`; a restore puts the stored mode back into `Docsizemode`
  (the parameter is the single source of truth while running: the `canvas` of an incoming `doc` is informational). Before a client
  sent a document the network gets a default base layer (surface = input size; Fixed mode: fitted and centred).
- **Flatten.** `renderLayer {requestId, layerId}` (active client): `network.render_layer_source(layerId)` -> TOP, read back through
  the same budgeted two-step pipeline as a TOP import (shrunk/stretched on the GPU only if its size differs from the document),
  un-premultiplied per `Premultiplied`, served as a type-6 frame of the *document* size (`topReady` + `GET /top`; errors `topError`:
  not a text/shape layer, restoring, document too large (> 32 Mpx), document resized meanwhile). It shares the import queue
  (one job per client, newest wins).
- **Export with Document.** `Exportdoc` (pulse) -> `ExportDoc()`: refuse while a restore is pending, `Exportpath` made absolute
  (relative = project folder, `.tox` appended, folder must exist), `Freeze()` -> `comp.save(<name>.part.tox)` -> rename -> `Thaw()`
  (always). The outcome stays in `Status` for 10 s ("exported with document to ..." / "export failed: ..."); a success clears the
  previous error. `Exportpath` is a File parameter; TD 2025.32820 has no file-type filter for custom File parameters (no `Par.fileTypes`), so a missing `.tox` ending is added on export.
- **Build.** `export_tox` builds the clean `.tox` in `/project1/_re_tox_build` and always destroys that COMP (also when the build
  or the save fails, and any leftover first).
- **Deleting the COMP.** The Web Server DAT (Poco) blocks TD's main thread on destruction until every idle HTTP keep-alive connection
  times out (10 s each; a browser page always holds some), so every response carries `Connection: close`. TD calls the extension's
  `onDestroyTD()` before destroying a deleted COMP (Execute DAT `onExit`/`onDestroy` are not called; on extension re-initialisation
  it is called on the OLD instance, which `_superseded()` detects and ignores): it closes the WebSocket clients, stops the server and
  the panel's browser and drops imports. TD's undo snapshot of the delete is taken *before* that hook (a lock taken in it is not in
  the snapshot), so the surface pixels are saved by a worker thread to a side cache (`<tmp>/raster_editor_undo/` -- mode 0700, owned by
  us -- `<hash of path>_<pid>_<hash of the stored doc_state text>/`: npy + an atomically written `meta.json` that also names the layer
  behind each slot; skipped above 256 MiB, pruned after 6 h on start and delete). The recreated instance's `Restore()` reads it only
  when the document text hash matches exactly and only for slots whose layer id and size match and that the locked images did not
  already provide (an immediate undo waits for the writer); `Premultiplied` is converted; any mismatch or damage removes the cache, as
  does a restore without a stored document. Ctrl+Z after a delete therefore brings the document back. A delete while a restore is
  pending leaves the locked images alone. Undo only works in the same TD session.
