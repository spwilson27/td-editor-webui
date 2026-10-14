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
| `panel_exec` | panelexecuteDAT | forwards `u`, `v`, `lselect`, `mselect`, `rselect`, `wheel` to `webrender.interactMouse` |
| `keyboard` + `keyboard_callbacks` | keyboardinDAT + its callbacks | forwards keys to `webrender.sendKey` only while this COMP's panel has focus |
| `frame_exec` | executeDAT | `onFrameStart` → `ext.Pump()`; `onStart/onCreate` → `ext.Start()`; `onExit` → `ext.Stop()` |
| `par_exec` | parameterexecuteDAT | reacts to the custom parameters below |
| `RasterEditorExt` | textDAT | extension class (from `td/raster_editor/ext.py`) |
| `protocol`, `frames` | textDAT | python modules (from `td/raster_editor/*.py`), imported by the extension via `op('protocol').module` |
| `ui_html` | textDAT | the built single-file web app (`dist/ui.html`) |

The extension is promoted (`ext.RasterEditor`), so other networks can call e.g.
`op('raster_editor').RasterEditor.Status()`.

The container's panel shows the Web Render TOP as its background. A viewer is not
required for cooking: `webrender` must be pulled every frame (the panel background
and `alwayscook` do this; verify — a Web Render TOP that nothing pulls renders white
and only cooks once).

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
| `Openbrowser` | pulse | | opens `http://127.0.0.1:<Port>/` in the system browser |
| `Reloadui` | pulse | | reloads `webrender` |
| `Status` | str (read-only) | | e.g. `panel active · 1920×1080 · 24 fps out` |

COMP `w`/`h` (Layout page) define the UI resolution; default 1280×800.

## 3. Extension behaviour (`RasterEditorExt`)

Keep TD glue thin. All pixel math lives in `frames.py`, all byte layout in
`protocol.py`; both are pure python + numpy and fully unit tested without TD.

- **State**: clients `{id: {kind, active}}`, active client id, `doc_w/doc_h/has_input`,
  output buffer `np.uint8[h, w, 4]` in **TD order** (bottom row first, premultiplied if
  `Premultiplied`), `dirty` flag, `got_composite` flag, last input signature, timing stats.
- **Web server callbacks**: HTTP GET `/` → `ui_html.text` (or 404); WS open → register;
  WS text → JSON dispatch (`ready`, `takeover`, `requestBase`, `log`); WS binary →
  `protocol.decode_frame` → `frames.paste_band(buffer, header, payload, premultiply)` →
  on `FRAME_END` set `dirty`, `got_composite`, `composite.cook(force=True)`;
  WS close → unregister; if it was active, promote the most recent remaining client.
- **Script TOP `onCook`**: if `dirty`, `scriptOp.copyNumpyArray(buffer)`; clear `dirty`.
  The buffer is reused, never reallocated except on resize.
- **Pump (each frame start)**:
  - doc size = `in1` size if connected else `Docw×Doch`; if changed → reallocate buffer,
    `docSize` to all clients, mark base resend.
  - input change detection: connected and (`in1` cooked this frame or size changed);
    rate-limit by `Maxinputfps`; readback `in1.numpyArray(delayed=True)` (no GPU stall;
    one frame latency is fine) → `frames.to_wire(arr, unpremultiply)` (flip to top-left,
    float→uint8, unpremultiply) → `protocol.encode_frames(BASE, ...)` bands → send to
    every client (standby clients keep their base current too).
  - update `Status`, `out_switch.par.index`.
- **Mouse**: `interactMouse(u, v, left=..., middle=..., right=..., wheel=...)` with the
  panel's `u`,`v` **unchanged** — both the panel and `interactMouse` use a bottom-left
  origin (verified: passing `1 - v` mirrors clicks vertically).
- **Keyboard**: map Keyboard In DAT key names to `sendKey(key, char=, shift=, alt=, ctrl=, cmd=)`.
- Exceptions inside callbacks are caught, printed once per distinct message, and
  shown in `Status`; they never escape into TD's callback machinery repeatedly per frame.

## 4. Build & install

`td/build_component.py` runs inside TD (`scripts/td_call.py --exec td/build_component.py`):

1. Reads `dist/ui.html` and the python sources.
2. Destroys and recreates `/project1/raster_editor` (keeps node position if it existed),
   builds the network above, sets parameters, wires the extension.
3. Never touches operators outside the COMP (validation creates its own test TOPs and
   removes them afterwards).
4. Saves `dist/raster_editor.tox`.

`--dev` mode: DATs use `file` + `syncfile` pointing at the repo instead of embedding, so
python edits reload live.

## 5. Verified API notes (TD 2025.32820)

- `webrenderTOP.interactMouse(u, v, leftClick=0, middleClick=0, rightClick=0, left=False, middle=False, right=False, wheel=0, pixels=False)`; `left=True` first time = mouse down, repeated = drag, `left=False` = up/move. Origin bottom-left.
- `webrenderTOP.sendKey(key, char=None, shift=False, alt=False, ctrl=False, cmd=False)`; key names match the Keyboard In DAT. `sendString(str)`. `executeJavaScript(line)`.
- `webrenderTOP` params: `source`=`urlorfile`, `url`, `outputresolution`=`custom`, `resolutionw/h`, `dpiscale`, `alwayscook`, `transparent`, `maxrenderrate` (default 30 — set 60), `reloadsrc` pulse. Attribute `loaded`.
- `webserverDAT`: `webSocketSendBinary(client, data)`, `webSocketSendText(client, text)`, `webSocketConnections`, `webSocketClose(client)`.
- `scriptTOP.copyNumpyArray(arr)`: shape `(h, w, 4)`, dtype uint8/uint16/float32. Row 0 is the **bottom** row.
- `TOP.numpyArray(delayed=False)` returns float32 `(h, w, 4)`, bottom row first.
- A Web Render TOP not pulled by anything stays white and cooks only once.
