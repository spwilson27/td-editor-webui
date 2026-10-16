# TouchDesigner component: `raster_editor`

Target: TouchDesigner 2025.32820 (Python 3.11, numpy available). Verified API notes are
at the end; check anything else against the live TD through `scripts/td_call.py`.

**Status: current as of tag v0.9.0 (protocol 11).** Sections 1–4 describe the current component (v8 layout: multiple editors,
master/slave, no in-TD panel; v11 view stream in §3/§13). Section 4 build commands: `td/build_component.py [--dev]`. Sections 5
onwards are an append-only record per protocol version (API notes, v3–v11 additions): where they mention the Web Render panel,
`Panelquery` or `Reloadui`, the v8 rules in sections 1–3 win. How to build, test and release: `DEVELOPMENT.md`; index of all docs: `docs/README.md`.

## 1. Network inside the COMP (v8)

`raster_editor` is a **containerCOMP** with one TOP input (more spare ones appear as you connect) and one TOP output. It carries the
tag `rasterEditor`. **The COMP's viewer shows its output TOP** (`par.top = ./out1`); there is no editor UI inside TD: editing happens in an
external browser (**Open in Browser**). Every editor is complete and can be the project master (docs/DESIGN_V8.md).

| Operator | Type | Role |
| --- | --- | --- |
| `in1`..`in8` | inTOP | the COMP's inputs (names are kept by Upgrade All Editors) |
| `out1` | outTOP | the COMP's output, fed by `out_switch` |
| `out_switch` | switchTOP | index 0 = `in1` passthrough (inactive / nothing applied), index 1 = `doc_out` |
| `doc`, `doc_state` | baseCOMP, textDAT | the generated document network (locked surface Script TOPs) and the stored document: **data children**, survive a rebuild / upgrade (`registry.DATA_CHILDREN`) |
| `webserver` | webserverDAT | **active only on the master editor** (port from `Port`, falling back to the next free one up to +50); callbacks delegate to the extension, which routes by `editor=<id>` |
| `frame_exec` | executeDAT | `onFrameStart` -> `ext.Pump()`; `onStart/onCreate` -> `ext.Start()`; `onExit` -> `ext.Stop()`; project pre/post save -> Freeze/Thaw |
| `par_exec` | parameterexecuteDAT | custom parameters -> `ext.OnParChange` (callbacks arrive a frame later) |
| `RasterEditorExt` | textDAT | extension (`td/raster_editor/ext.py`): per-editor session + master router |
| `protocol`, `frames`, `registry`, `upgrade`, `network`, `effects` | textDAT | python modules (`op('registry').module` ...) |
| `ui_html` | textDAT | the built single-file web app, served by the master |

The Web Render TOP, the panel mouse / keyboard forwarding (`panel_exec`, `keyboard`) and the panel TD-view overlay of v0.7 are gone.

**Runtime-created child operators** (anything the extension creates while running, e.g. `_imp_sel*`, `_imp_res*`, `_imp_mov*`,
`_font_probe_tmp`, `_view_crop<n>` / `_view_rs<n>` / `_view_px<n>`) must (1) start with `_` and (2) be tagged `reRuntime`: Upgrade All Editors never copies such operators into
a target. `doc` and `doc_state` are preserved, `in<N>` / `out<N>` keep their names.

## 2. Custom parameters (page "Raster Editor")

| Name | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `Version` | str (read-only) | build | semver of the build, stamped by `build_component.py` (`VERSION`) |
| `Active` | toggle | on | off: this editor's browser tabs are disconnected, output = input passthrough; if it was the master another active editor takes over the server |
| `Port` | int | 9980 | **master only**: the project web server's port; busy -> next free (up to +50, shown in `Status`); a slave ignores it; changing it on the master restarts the server |
| `Docsizemode` | menu | Follow Input | `input` / `fixed` (§8) |
| `Docw`, `Doch` | int | 1920, 1080 | document size when Fixed, or Follow Input with no input |
| `Premultiplied` | toggle | on | TD data is premultiplied alpha |
| `Maxsendfps`, `Maxinputfps`, `Maxviewfps` | int | 30 | rate limits (§3); the TD view can not be faster than the project's cook rate (§13) |
| `Viewmode` | menu (read-only) | Local | the active browser tab's view mode |
| `Devurl` | str | "" | developer: Open in Browser opens this URL (a Vite dev server) with `ws=ws://127.0.0.1:<Port>/ws` instead of the built-in page |
| `Openbrowser` | pulse | | **Open in Browser**: with a live master the browser opens the master's page with this editor's tab (`http://127.0.0.1:<Port>/#token=<token>&e=<editorId>`); otherwise this editor becomes the master first |
| `Upgradeall` | pulse | | **Upgrade All Editors** (`upgrade.upgrade_all`): replaces every older editor of the project with this build; summary in `Status` |
| `Exportpath`, `Exportdoc` | file, pulse | | Export with Document (§8) |
| `Projectfile`, `Saveproject`, `Openproject`, `Pngfile`, `Exportpng` | | | project / PNG files (§9) |
| `Status` | str (read-only) | | e.g. `master :9980 · external active · 1920x1080 ...` or `slave of raster_editor · ...` |

Removed in v8: `Panelquery` (the validation back channel `POST /__test` / `testPath` is enabled by COMP storage `reTest`, and the
test page URL carries `?test=1`) and `Reloadui` (it reloaded the in-TD panel; an external browser tab reloads itself).

## 3. Extension behaviour (`RasterEditorExt`)

Keep TD glue thin. All pixel math lives in `frames.py`, all byte layout in `protocol.py`.

- **Session** (every editor): the per-editor protocol state (clients, document, surfaces, TOP requests, notices, history) is transport
  agnostic: `_ws_open/_ws_text/_ws_binary/_ws_close` and `_session_http`. It sends through the master's Web Server DAT.
- **Master router** (`OnHTTPRequest`, `OnWebSocket*`; only the master's callbacks fire): serves `/` and `GET /editors?token=` and routes
  everything else by `editor=<id>` (missing = the master's own editor) with a dict lookup (O(1) per message). An unknown / inactive
  editor: HTTP 404 `{"error":"no such editor"}`; a WebSocket gets `{"t":"gone"}` and is closed (the Web Server DAT cannot close with
  code 4404; the page treats `gone` plus the close like 4404). `editors` is pushed to every open page when the list changes.
- **Master record** (root storage `rasterEditorMaster`: path, id, port, token, orphan, failed, hold): found and validated (`_live_master`) by Open in
  Browser, the failover and project load. The project token belongs to the master and is inherited by the next master.
- **Election**: Open in Browser on any editor: live master -> open its page; else this editor becomes master (`BecomeMaster`).
  **Project load**: only the editor named in the record resumes as master (same port, same token). **Failover** (delete -> `onDestroyTD`,
  `Active` off, server failing in `_check_server`, or a slave's health check every 2 s): the next active editor in path order takes over
  on the same port (it waits up to 3 s for the old server to release it). No active editor left -> the server stops and the record is
  marked `orphan`; the first editor activated again resumes. A slave costs one timestamp compare per frame.
  Ports: an election uses `Port` (then +1 .. +50); **project-load resume tries the configured `Port` first, then the record's**; a
  failover or an in-place upgrade / rebuild keeps the record's port (the record's `hold`, written by `PrepareUpgrade()` / `Stop()`,
  tells everybody - also the NEW extension instance - that the master is only restarting). Open in Browser during such a takeover joins
  it (opens the record's port) instead of starting a second server. A project with no free port backs off (10 s, three tries) instead
  of retrying every frame. `_check_server` counts only "not active" and bind-class errors as failures, restarts on the record's port
  if it is free (else the next free one) and, after three failures, hands over; the failed editor is remembered in the record
  (`failed`) so a successor with the same error is not handed back to. The master's editor list is polled every 5 s (renames); create /
  delete / Active / Start are event driven; an editor that is not started is neither listed nor routable, and no list is published by a
  master that has not rescanned since it (re)started. Stopping a server closes its WebSockets first (switching the DAT off does not
  reliably close them).
- **Identity**: the `editorId` is kept in COMP storage and survives undo of a delete, cut / paste, a .tox saved and loaded after the
  original is gone, and project load. A copy / paste / duplicate / loaded .tox of a LIVE editor carries the id of a second live editor:
  the newcomer takes a new id (`was_copied`), adopts the original's pixels while it runs and otherwise shows "copied without pixels".
- **Upgrade hooks** (called by `upgrade.py`): `PrepareUpgrade()` (flush the document, keep the master role for 15 s), `Freeze()`, `Stop()`,
  `Start()` (idempotent; a master resumes with the same port / token), `OnEditorsChanged()` (refresh list + election).
- **Pump (each frame start)**: module check, router tick, doc size, hints, input / output / layer previews, notices, TOP requests,
  surfaces, **view11** (v11 fast / exact view frames, §13), files, replay, network, doc state, switch.
- Exceptions inside callbacks are caught, printed once per distinct message and shown in `Status`.

*Sections 5 onwards describe earlier protocol versions; wherever they mention the panel, the Web Render TOP, `Panelquery` or
`Reloadui`, read the v8 rules above.*

## 4. Build & install

`td/build_component.py` runs inside TD (`scripts/td_call.py --exec td/build_component.py`):

1. Reads `dist/ui/index.html` and the python sources.
2. Destroys and recreates `/project1/raster_editor` (keeps node position if it existed),
   builds the network above, sets parameters, wires the extension.
3. Never touches operators outside the COMP (validation creates its own test TOPs and
   removes them afterwards).
4. Saves `dist/raster_editor.tox`.

Run it with `.venv/bin/python td/build_component.py [--dev]` (forwards itself to the TD named by `$TD_MCP_CONNECTION` or
`~/.td-mcp/connection.json`) or `scripts/td_call.py --exec <path>/td/build_component.py`. Use an isolated instance (`scripts/td_workers.py --keep`)
rather than a TD with a project you care about.

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
- **Flatten / merge (v8).** `renderLayer {requestId, layerId, mode?: flatten|mergeDown}` and `renderLayers {requestId, layerIds}` (active
  client). The job opens a render request on the network (`network.render_open(key, ...)`: a temporary network `rqout_q<n>` planned together
  with the document from a synthetic copy of the requested layers, sharing the surfaces; closed again when the job ends), then reads
  `network.render_source(key)` back through the same budgeted two-step pipeline as a TOP import, un-premultiplied per `Premultiplied`,
  and serves it as a type-6 frame of the *document* size (`topReady` + `GET /top`). `flatten` = the layer alone (opacity 1, Normal, visible;
  mask, transform, effects kept; a group with its children); an adjustment layer flattens as `mergeDown` = the layer below it (as flatten)
  with the adjustment's stack mixed by its opacity x mask; `renderLayers` = those layers in stack order, each with its own opacity / blend /
  visibility (a selected group's children come with it). `network.render_token(key)` (request layers' specs, document size, node identity,
  text layouts, cook counters of the surfaces read) is checked before and after the readback ("layer changed"). `topError`: restoring,
  unknown layer, nothing below the adjustment, document too large (> 32 Mpx), document resized meanwhile. Shares the import queue (one job
  per client, newest wins).
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


## 9. Protocol v6 additions (DESIGN_V5): inputs, files, effects (`ext.py`, `protocol.py`, `frames.py`)

`docs/PROTOCOL.md` §8 / §8.1 is the wire contract; this is the component side.

- **Inputs.** `in1..in8` In TOPs, `Connector Order` = N (verified in TD 2025.32820: the order parameter decides which connector an In TOP
  takes; node position and creation order do not). `_ensure_input_ops` (each pump) keeps exactly one spare unconnected connector behind the
  highest connected input (max 8); the spare In TOP is created on demand, a trailing In TOP beyond it is removed 2 s after it became unneeded
  and a connected one never. The build creates `in1` and, on a rebuild, as many In TOPs as there were wires (+1) and reconnects every wire.
  Per input a `_Pipe` (`ext.bases[n]`): change detection by `in<N>.totalCooks`, `Maxinputfps`, delayed two-step readback, budgeted conversion
  (one input converts per pump, round robin; readbacks of all), one immutable BASE message per input served by `GET /base?input=N`, per client and
  input notice / stall bookkeeping (`_Client.bases`). `network.set_inputs(items)` is called on every change, followed by `apply` in the same pump.
  A COMP input reporting 0x0 while it restarts keeps its last known size.
- **Files.** `Projectfile` / `Pngfile` (File parameters), `Saveproject` / `Openproject` / `Exportpng` (pulses), all with help; same code path as
  the web messages. `.redoc` writer / reader and the PNG codec live in `frames.py` (no PIL / cv2 needed: zlib + zipfile + numpy; the writer uses
  the Sub filter, the reader handles 8-bit RGB / RGBA, non-interlaced, all five filters -- Average / Paeth are a slow per-pixel loop, our own
  files never use them). Worker threads (`_run_worker`) only touch plain numpy copies and the filesystem; results come back through
  `_file_results` and are handled by the pump (`_tick_files`). Limits: a PNG over 8192x8192 px, a project over ~3 GiB declared size or 5000
  entries, `doc.json` over 64 MB are refused; an inflated size that disagrees with the PNG header is refused.
- **Effects.** `build_component` embeds `td/raster_editor/effects.py` as DAT `effects` and every `shared/effects/*.glsl` as DAT `fx_<stem>`
  (`fx_common`, `fx_blurlib`, `fx_filterlib`, `fx_in2lib`, `fx_dropShadow`, ... : every file, libraries included). The extension hands
  `DocNetwork(..., effects=<module>, effect_shaders=effects.load_shader_texts_from({stem: DAT text}))`, i.e. exactly what `load_shader_texts`
  builds from the repo (common + each shader's include libraries + the shader; a missing DAT is reported and effects stay off). Filter parameters
  are not validated by `parse_doc` beyond `type` (name pattern) / `enabled`: TD clamps them with `effects.norm_params` (a COMP without them lets the network look for the repo files; `Status` shows `effects unavailable: ...` when it cannot).
- **chooseFile.** See PROTOCOL.md §8.1; `ext._choose_dialog` / `ext._make_movie` are the TD-only seams.

## 10. Protocol v7 additions (DESIGN_V6 phase B): `ext.py`, `protocol.py`, `frames.py`

See `PROTOCOL.md` section 9 for the wire details. Extension behaviour:

- **Documents.** `parse_doc(msg, fx)` accepts filter-library types in `effects[]`, `adjustment: {type:"filter", effect}`, effects on group /
  adjustment layers and `brushPresets`; filter parameters are checked for JSON sanity and run through `effects.norm_params` (never range-rejected).
  The stored document (`doc_state`, `.redoc` `doc.json`) carries `brushPresets`.
- **tdPreview layer streams** (`_poll_layer_previews`): per flagged layer a `_Pipe` (frame type 7) fed from `network.layer_preview_source`,
  change token `network.layer_preview_token`; notices per client + layer (`_Client.lp`), `GET /layer`. Pipes exist only while an editor is
  active; stats `lpreadback / lpconvert / lppublish`.
- **History**: COMP storage key `raster_history` = `(rev, bytes)`; see PROTOCOL.md. `.redoc` gets `history.bin` and `meta.historyRev`.
- **Hints**: `_sync_hints` (pump step before the uploads) forwards `activeLayer` and the content bounds tracked from SURFACE tiles to
  `network.set_active_layer` / `set_content_bounds` and re-applies the stack once when either changed.
- **`chooseFile readText`**: file dialog + UTF-8 read (<= 12 MB) in the pump, `fileChosen.text`.
- Tests: `td/tests/test_ext_v7.py`, `test_protocol_v7.py`; live: `scripts/validate_td.py` steps 39-47.

## 11. Protocol v8 additions (DESIGN_V7): unified adjustments, render requests

- **Adjustment layers = effect stacks.** `protocol.parse_doc` migrates every v2..v7 `adjustment` spec (classic `levels` / `brightnessContrast` /
  `hueSaturation` / `invert` / `threshold` / `blur`, or `{type:"filter", effect}`) to `adjustment: null` + the spec's effect prepended to
  `effects[]` (blur through `effects.legacy_blur_to_filter`); this also runs on `.redoc` files. In the network an adjustment layer is an
  `EffectChain` (`fx_<id>_*`) over the accumulated image `acc`, mixed by `blend_L_<id>` (blend.glsl uAdjust 1: `mix(below, chain(acc),
  opacity x mask)`). The old special passes (`adj_L_*` Blur TOPs, blur pyramid, `adjx_L_*`, blend.glsl uAdjust 2..6 / 9 / 10) are gone. An
  adjustment whose stack draws nothing is skipped (`noop`) or mixes the image with itself. Adjustments still break merged runs and need
  16 bit inputs.
- **Render requests** (see "Flatten / merge" above): `network.render_open / render_source / render_token / render_status / render_close`.
- Tests: `td/tests/test_v8.py`; live: `scripts/network_dev.py v8` (chain vs the v0.6.0 passes, requests vs layers composited alone),
  `scripts/validate_td.py` steps 48-50.

## 12. Protocol v9 additions (DESIGN_V7 8): masks on groups and input layers

- `PROTOCOL_VERSION = 9`. `parse_doc` always accepted a `mask` on any layer; v9 only changes what the page may send (group and input masks) and the
  slot sizing rules in `protocol.slot_sizes`: a **group / adjustment / text / shape** mask is document sized (a leftover buffer size is never
  inherited), an **input** mask is `surfaceW x surfaceH` of the input layer (the page sends the input's size), else the buffer's size, else the
  document's. The mask of a disconnected input stays allocated (it is just not wired) and comes back with the input.
- **Input mask** (`network.py`, `ext.py`): the mask surface of an input layer is `surfaceW x surfaceH` of the layer; the ext states that size
  for masked input layers (`_fill_input_sizes`: spec, else the live input size, else the mask buffer's size, else the document's -- the same
  answer for `protocol.slot_sizes` and the network, also after a canvas resize). When the input's resolution changes (`_adjust_inputs`), or a
  `doc` states a new input size, the mask buffer is **stretched** (`frames.stretch_buffer`, bilinear, normalised coordinates), not padded; the
  page's exact mask follows. A SURFACE frame produced for a size the slot does not have yet (the page's `doc` still in flight) is kept
  (bounded, `_early`) and replayed after the next doc. `.redoc` input masks saved for another input size are resampled on load (other masks
  must still match). A connected masked input keeps the exact path (mask rides on the blend / merged pass) while the mask has the live input's
  size; it goes through the resample pass (`xf_L_<id>`, mask sampled in normalised layer UVs) only when the mask size is unknown or differs from
  the In TOP's size, when it is transformed, or has effects. Hidden / opacity-0 inputs build no resample node.
- **Group mask**: the group's isolated composite is multiplied by the mask (document space) before its effects (`xf_L_<id>` identity pass when the
  group has effects; the group's blend pass `uHasMask` otherwise), then opacity / blend. A masked group without effects never joins a merged run
  (`solo` in `_emit`; its mask is not a merged-pass mask input); with effects the mask is baked first and the group is an ordinary merge member.
- **Render requests**: `renderLayer` flatten of a group bakes its mask (the request keeps the layer's mask, drops opacity / blend / visibility);
  `renderLayers` takes the selected layers as roots, so a parent's mask is ignored; mergeDown is unchanged. Request layers share the mask slots.
- tdPreview layers show the masked content (the chain's input is already masked).
- Tests: `td/tests/test_network.py` (v9 block), `test_protocol_v7.py`, `test_ext.py` (v9 block); live: `scripts/network_dev.py v9` (masked input with
  integer offset / rotation / skew and a half-size mask, with an effect, disconnect + resolution change; masked group with a multiply child,
  group effects, between plain layers, flatten, renderLayers), `scripts/validate_td.py` step 53.

## 13. Protocol v11 additions (DESIGN_V9): fast / exact TD view (`ext.py` v11 view stream, `frames.py`, `protocol.py`)

Wire format: `PROTOCOL.md` section 13 (golden files `docs/fixtures/view_*.bin` + `view_v11.json`, written by `scripts/make_fixtures.py`).

- **Per client state** (`_Client.v*`): quality (`auto` / `fast` / `exact`), viewport `{x, y, w, h, scale}` (+ serial), un-acked frames
  (`v_inflight`, <= `VIEW_MAX_INFLIGHT` = 2; an entry older than `VIEW_ACK_TIMEOUT_S` = 2 s expires, 10 s without any ack shows `stalled`
  in Status), frame counter, JPEG quality, dirty flags, the last exact frame sent to that client (`v_prev`, the base of tile diffs) and
  `v_showing` (`fast` | `exact`). `ready.protocol` 10 is still accepted (`hello.protocol` echoes it) and keeps the v3 notice + `GET /view`
  path (`_poll_view`, `_Pipe` `out`); `_view_subscribers()` = those, `_view11_subscribers()` = protocol >= 11.
- **Pump order**: the step `view11` runs after `surfaces` (the uploads of this tick) so the frame contains the edit that
  `appliedFrameId` names. Change token = `doc_out.totalCooks` (+ size + Premultiplied) after `doc_out.cook()`; a changed token or a
  viewport / quality change marks the client dirty.
- **Fast frames** (`_send_fast`): per client with fast quality a lazily created GPU chain inside the COMP: `doc_out` -> **Crop TOP**
  (integer document region of the viewport, never more than the document) -> **Resolution TOP** (device pixel size, `rgba8fixed`,
  mipmap filter, capped at `FAST_MAX_PIXELS` = 2.4 M) -> **GLSL TOP** (`view_fast_glsl`: colour | alpha as grey side by side, rows top-first,
  premultiplies when `Premultiplied` is off). One `saveByteArray('.bmp')` readback (the BMP alpha byte is junk, hence the alpha half),
  `cv2.cvtColor` / `extractChannel`, two `cv2.imencode` JPEGs (colour q75 adaptive 40..75 by `FAST_BYTES_BUDGET`, alpha q90; alpha
  omitted when fully opaque), `webSocketSendBinary` in the same tick. Rate: `Maxviewfps` leaky bucket; when two frames are un-acked
  nothing is captured (the next frame is captured after the ack, so it is always the newest). Chains are named `_view_crop<n>`,
  `_view_rs<n>`, `_view_px<n>` (tag `reRuntime`), exist only while a client takes fast frames and are destroyed on `view local`, on
  disconnect and by `Stop`. At most `VIEW_MAX_CHAINS` = 4 chains per editor; further clients (or no OpenCV) get exact frames only.
  A slave editor creates its chains only when one of its own clients subscribes.
- **Exact frames**: the existing `view_pack` GLSL TOP (float32, straight alpha, flipped, `floor(c*255+0.5)` — the same semantics
  as `GET /view` of v3) is read with the budgeted two-step `numpyArray(delayed=True)` pipe `vx` (`_poll_pipe`, sink = `_vx_sink`
  instead of publishing a message): ~1 + 2.5 ms main thread per 1080p frame. Dispatch gates (`_exact_takes`): `auto` = fast frames are
  flushed, nothing is un-acked, `VIEW_IDLE_S` = 0.2 s without a change and the frame was read after the last change; `exact` = on change,
  at most every `VIEW_EXACT_PERIOD_S` = 0.1 s (a frame read before the latest change is sent and followed by another read).
  The worker thread (`_exact_work`, one `ThreadPoolExecutor` thread; `_sync_view_workers` runs it inline in tests) does the tile diff
  per distinct previous frame (`frames.plan_exact`: > 30 % of the 64 px tiles changed, no previous frame or another size -> full) and
  `zlib.compress(raw, 1)` (a single C call that releases the GIL). The pump sends the results: <= 4 MB inline over the WebSocket, larger
  ones are stored per client (`v_big`) and announced with `viewExact {frameId, size}` for `GET /view?exact=1&frameId=`. A tile frame is only
  sent if the client's `v_prev` is still the frame it was diffed against. An unchanged picture is not sent again (a client that was last
  sent a fast frame gets an empty tile frame, `nTiles` 0: "your exact buffer is current"). `viewExactReset` drops `v_prev`.
- **Animated / live sources**: while the output keeps changing (a moving input, a generative layer) `auto` stays in fast mode, because
  the idle timer never expires; choose Accurate (`exact`) to get exact frames of moving content (rate limited to 10 per second).
  Failures: a chain that cannot be created or read is retried after `VCHAIN_BACKOFF_S` = 5 s (the client gets exact frames meanwhile);
  an ack timeout puts the client back into slow start (`v_acked` False: one low-quality fast frame at a time, exact frames announced
  with `viewExact`, next exact frame full). An exact result is dropped (and recomputed) when a newer fast frame, an output change or a
  canvas resize happened while the worker ran. Viewport numbers are clamped (`parse_view11` and `_fast_geometry`).
- **Cook rate**: the view can not be faster than the project's cook rate (frames are produced in the tick the output was cooked).
  A 60 fps project roughly halves the preview latency of a 30 fps one. The component never changes the cook rate; `Status` shows
  `(preview latency follows the 30 fps cook rate)` while a client is in TD view and the rate is below 45 fps, and the `Maxviewfps` help
  says so.
- **Stats** (`GetStats`): `vfast` (main thread per fast frame) = `vfastcap` (capture) + `vfastenc` (JPEG), `vfastrs` (readback),
  `vfastflip` (BGRA split), `vxmain` (main thread per exact tick while exact work is pending), `vxreadback` / `vxconvert` / `vxpublish`
  (the `vx` pipe), `vxenc` (worker time per exact job).
- **Tests**: `td/tests/test_v11view.py` (codecs vs the golden fixtures, tile diffs, state machine on fakes, router); live: `scripts/validate_td.py`
  step 7 (needs OpenCV inside TD only; JPEG content is decoded in TD, the exact buffer is compared band by band with `out1`).
