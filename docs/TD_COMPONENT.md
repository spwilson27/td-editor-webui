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
| `Docw`, `Doch` | int | 1920, 1080 | document size when `in1` has no input |
| `Premultiplied` | toggle | on | treat TD TOP data as premultiplied alpha (unpremultiply input, premultiply output) |
| `Maxsendfps` | int | 30 | sent to the web app in `hello` |
| `Maxinputfps` | int | 30 | max BASE frame rate for time-dependent inputs |
| `Devurl` | str | "" | when set, `webrender` loads this URL with `?ws=ws://127.0.0.1:<Port>/ws&client=panel` (Vite dev server workflow) |
| `Panelquery` | str | "" | extra query string appended to the panel URL, e.g. `test=1` (installs `window.__editorTest`; it also enables the test-only `POST /__test` back-channel, see §5) |
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
