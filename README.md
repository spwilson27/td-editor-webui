# Raster Editor for TouchDesigner

A layered raster image editor with an Affinity-style web UI, packaged as one TouchDesigner component (`raster_editor.tox`). Wire TOPs into it, press **Open in Browser**, paint and compose in the browser, and the flattened result comes out of the component as a TOP in real time.

```
 input TOP(s) --> [ raster_editor COMP ] --> output TOP        browser (http://127.0.0.1:9980/)
                       ^   |                                         |
                       |   +---- web server (loopback) <------------+
                       +-- document, layers, effects run as a TD network (GPU)
```

## Features

- Layers: pixel, text, shape, group, adjustment and live TD input layers; masks (also on groups and input layers); 16 blend modes; per-layer transforms (move / scale / rotate / skew).
- Painting and selection tools: brushes with tips, dynamics and presets, pixel tool, eraser, fill, gradient, clone, smudge, blur/sharpen, dodge/burn, colour picker, marquee / lasso / flood selections, quick mask, crop, free transform.
- 40 filters and effects (blur, colour, distort, stylise, animated ...) as layer effects, adjustment layers or group effects. The same GLSL runs in TouchDesigner and in the browser preview.
- Multiple inputs (up to 8): connected TOPs become live input layers.
- Document size follows the first input or is fixed; undo history survives page reloads.
- Native project files (`.redoc`), PNG export, and export of the document as a `.tox`.
- Several editors in one project: one project web server (the master), one browser tab per editor, automatic failover, **Upgrade All Editors**.
- Low-latency TD view in the browser (JPEG preview while you edit, bit-exact frame when you stop).

## Requirements

- TouchDesigner 2025.32820 (tested on macOS; a free non-commercial licence is enough). Its bundled Python is 3.11 with numpy.
- A current Chromium-based browser (or Safari/Firefox with WebGL2) on the same machine, for the editing UI.
- To only use the component you need nothing else: `dist/raster_editor.tox` embeds the Python code and the built UI.
- To develop: Python 3.11+ (CI uses 3.11, development works on 3.14), Node 22+ and npm. See [DEVELOPMENT.md](DEVELOPMENT.md).

## Install

1. Open your TouchDesigner project.
2. Drag `dist/raster_editor.tox` into a network (for example `/project1`). A COMP named `raster_editor` appears.
3. Wire a TOP into its input (optional) and the COMP's output TOP wherever you need the result. With no input the document is the size set by *Doc Width/Height* (default 1920x1080).
4. Press **Open in Browser** on the component's *Raster Editor* parameter page. The editor opens at `http://127.0.0.1:9980/` (or the next free port, shown in *Status*).
5. Paint, add layers and effects. The output TOP updates as you work. The COMP's viewer shows its output.
6. Save your TouchDesigner project as usual: the document is stored inside the component.

Notes:

- The first editor that opens a browser becomes the project's **master** and runs the one web server. Further `raster_editor` COMPs (drag the .tox in again, or copy the COMP) are **slaves**: pressing Open in Browser on one opens the master's page with that editor's tab selected. The browser shows one tab per editor. If the master is deleted or deactivated another active editor takes over the same port; browsers reconnect by themselves.
- **Upgrade All Editors** replaces every older editor in the project with this build while keeping documents, wiring and parameter values. Newer editors are skipped and listed in *Status*.
- Only the master's `Port` parameter matters.
- The viewer-side preview cannot be faster than the project's cook rate; a 60 fps project roughly halves preview latency.

## Parameters

Page *Raster Editor*: `Version` (read-only), `Active`, `Port`, `Docsizemode` (Follow Input / Fixed), `Docw`, `Doch`, `Premultiplied`, `Maxsendfps`, `Maxinputfps`, `Maxviewfps`, `Viewmode`, `Devurl` (developers), `Openbrowser`, `Upgradeall`, `Exportpath` / `Exportdoc`, `Projectfile` / `Saveproject` / `Openproject`, `Pngfile` / `Exportpng`, `Status`. Every parameter has help text; details and behaviour in [docs/TD_COMPONENT.md](docs/TD_COMPONENT.md).

## Basic usage

- Tools are on the left rail (single-key shortcuts shown in the tooltips: `V` move, `M` marquee, `B` brush, `E` eraser, `T` text, `H` hand; `Cmd/Ctrl+Z` undo). Layers, colour, brushes, effects and history are panels on the right.
- Input layers (**Layer > Add Input Layer**) show a connected TOP live; you can move, scale, rotate, mask and apply effects to them.
- Files menu: save/open `.redoc` projects (path comes from the *Project File* parameter), export PNG (TouchDesigner's own flattened output), import images or TOPs as layers.
- Effects: Effects panel on a layer, or add an Adjustment layer for a filter that affects everything below it.

## Security notes

- The web server listens on `127.0.0.1` only. Requests from non-loopback peers and with a non-loopback `Host` header are refused (DNS-rebinding guard).
- A random per-project **token** authenticates every WebSocket and HTTP route. It is passed in the URL fragment (`#token=...`), so it never appears in server logs or Referer headers. (The master's record, including the token, lives in the project's storage so failover and project load can resume the same session; treat saved projects accordingly.) Do not paste "Open in Browser" URLs into chats or issue trackers.
- Cross-origin access is only granted to loopback origins (for the Vite dev server).
- Image data from TouchDesigner to the browser is pulled over HTTP, never pushed over the WebSocket, so a stalled browser tab cannot block TouchDesigner.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Browser shows "Reopen from TouchDesigner - session expired" | The token changed (server restarted). Press Open in Browser again. |
| `Status` shows `master :9981` | Port 9980 was busy (another app or TD instance); the master took the next free port. Use the URL in Status. |
| Page says protocol mismatch | The page and the component are different builds. Reload the page, or replace the component (drag in the current `dist/raster_editor.tox`, then Upgrade All Editors). |
| Output equals the input | *Active* is off, or nothing has been applied yet. |
| Page shows "Editing in another window" | Another browser tab took over this editor; only one tab edits at a time. Close the other or use it. |
| Output does not update while the project is paused | The editor works in the frame loop; the project's timeline/cooking must run. |
| Preview feels laggy | The TD view cannot be faster than the project's cook rate: raise the project to 60 fps, or lower *Max View FPS* if TouchDesigner is loaded. Set the View mode (Auto / Low latency / Accurate) in the editor's View menu. |
| Port in use by an old instance | Quit the other TouchDesigner or set *Port* on the master. |
| Exceptions | Printed once in the Textport and shown in *Status*. |

## Documentation

[docs/README.md](docs/README.md) indexes everything: protocol ([docs/PROTOCOL.md](docs/PROTOCOL.md)), component internals ([docs/TD_COMPONENT.md](docs/TD_COMPONENT.md)), testing and validation ([docs/TESTING.md](docs/TESTING.md), [docs/VALIDATION.md](docs/VALIDATION.md)), filters ([docs/FILTERS.md](docs/FILTERS.md)). Contributors: [DEVELOPMENT.md](DEVELOPMENT.md). AI coding agents: [AGENTS.md](AGENTS.md).
