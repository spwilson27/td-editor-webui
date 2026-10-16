# Raster Editor for TouchDesigner — Design

A raster image editor with an Affinity-style web UI, packaged as one TouchDesigner
component. The UI is TypeScript + Canvas 2D, rendered inside TouchDesigner by a
Web Render TOP and developed standalone in a normal browser.

Visual reference: `design/editor.html` (approved mockup; the UI must match it).
Wire protocol: `docs/PROTOCOL.md`. TouchDesigner component: `docs/TD_COMPONENT.md`.
Testing and review: `docs/TESTING.md`.

## 1. Goals

- One COMP, `raster_editor`, with exactly one TOP input and one TOP output.
- Input TOP (optional) becomes the editor's base layer and sets document size.
- Output TOP is the flattened document (all visible layers composited), at document size.
- The editor UI is shown in the COMP's panel and is fully usable with mouse + keyboard
  forwarded from TouchDesigner. It is also reachable from an external browser at
  `http://127.0.0.1:<Port>/` for comfortable editing and debugging.
- The web app runs without TouchDesigner (mock bridge) for fast development.

Non-goals for v1: vector layers, text engine, masks, live adjustments, layer effects,
file save/load, multiple documents, tablet tilt. Their UI buttons exist but are disabled
(see §5).

## 2. Architecture

```
            ┌──────────────────────── raster_editor (containerCOMP) ─────────────────────────┐
 input TOP ─┤ in1 (inTOP) ──► RasterEditorExt.pump() ──► base frames (WS binary) ─┐          │
            │                                                                     ▼          │
            │  webserver (webserverDAT, 127.0.0.1:Port) ◄──── WebSocket ────► Web app (JS)   │
            │        ▲ serves ui_html DAT                                         │          │
            │        │                                   composite frames (WS) ◄──┘          │
            │  composite (scriptTOP) ◄── numpy buffer ◄── RasterEditorExt.on_ws_binary       │
            │        │                                                                       │
            │  out_switch (switchTOP: in1 passthrough until first composite) ──► out1 (outTOP)┤─► output TOP
            │                                                                                │
            │  webrender (webrenderTOP, panel-sized) = COMP background; panel/keyboard       │
            │  events forwarded with interactMouse / sendKey                                 │
            └────────────────────────────────────────────────────────────────────────────────┘
```

The browser owns the document: layers, pixels, history. TouchDesigner owns I/O:
it pushes the base layer in and receives the flattened composite back. Both
directions move only changed rectangles of straight-alpha RGBA8.

### 2.1 Repository layout

```
raster-editor/
  design/editor.html        approved mockup (reference only, not shipped)
  docs/                     these documents
  web/                      Vite + TypeScript + Preact app
    src/
      engine/               document model, compositor, tools, history (no DOM UI)
      bridge/               protocol codec, TD WebSocket bridge, mock bridge
      ui/                   Preact components matching the mockup
      state/                app store (signals) joining UI ↔ engine
      main.tsx
    tests/
      unit/                 vitest, node environment (pure logic)
      browser/              vitest browser mode (chromium) for canvas code
      e2e/                  Playwright against `vite preview` + fake TD server
  td/
    raster_editor/          python package embedded into the COMP
      protocol.py           frame header encode/decode (mirror of web codec)
      frames.py             numpy conversions: flip, premultiply, rect paste, banding
      ext.py                RasterEditorExt extension class (TD glue, thin)
    build_component.py      builds the COMP inside a running TD, saves dist/raster_editor.tox
    tests/                  pytest with fake TD objects
  scripts/                  td_call.py + td_client.py (td-mcp client wrapper, self-contained), validate_td.py
  dist/                     build outputs (ui single-file html, .tox)
```

## 3. Web app

### 3.1 Stack

- Vite + TypeScript (strict), Preact + @preact/signals for UI state.
- `vite-plugin-singlefile` so the production build is ONE html file (inlined JS/CSS)
  that TouchDesigner stores in a Text DAT and serves from the Web Server DAT.
- No runtime network access except the TD WebSocket. No web fonts; system UI font stack.
- Target: the Chromium inside TouchDesigner's Web Render TOP (CEF). Use ES2020, no
  bleeding-edge APIs. `OffscreenCanvas` is allowed but every use must have an
  `HTMLCanvasElement` fallback created through one factory (`engine/surface.ts`).

### 3.2 Engine (`src/engine`) — no Preact imports

Core types (authoritative shapes live in `src/engine/types.ts`):

```ts
type BlendMode = 'normal'|'multiply'|'screen'|'overlay'|'soft-light'|'hard-light'
               |'darken'|'lighten'|'color-dodge'|'color-burn'|'difference'|'exclusion'
               |'hue'|'saturation'|'color'|'luminosity';
interface Rect { x: number; y: number; w: number; h: number }      // integer px, doc space
type LayerKind = 'pixel' | 'group' | 'base';
interface LayerBase { id: string; name: string; kind: LayerKind; visible: boolean;
                      locked: boolean; opacity: number /*0..1*/; blend: BlendMode; }
interface PixelLayer extends LayerBase { kind: 'pixel'|'base'; surface: Surface; x: number; y: number }
interface GroupLayer extends LayerBase { kind: 'group'; children: Layer[]; expanded: boolean }
```

- `Document`: `width`, `height`, `root: GroupLayer`, `activeLayerId`, `selection: Rect|null`.
  All mutation goes through `Document` methods that emit change events
  (`'structure' | 'pixels' (with dirty Rect) | 'selection' | 'resize'`).
- `Surface`: wraps a canvas sized to the document; `getContext('2d', {willReadFrequently})`
  only on surfaces that are read often (base layer, fill/picker sampling).
- Base layer: `kind: 'base'`, always bottom-most, name "TD Input", locked by default
  (user can unlock and paint on it; a new frame from TD replaces its pixels and records
  no history). When TD reports a new input size the document resizes (layers are
  re-allocated, content anchored top-left) and history is cleared.
  No input → document size comes from TD's `Docw`/`Doch` parameters (default 1920×1080)
  and the base layer is transparent.
- `Compositor`: flattens visible layers bottom→top into a composite surface using
  Canvas 2D `globalCompositeOperation` for blend modes and `globalAlpha` for opacity.
  Groups composite into a scratch surface then blend as a unit (isolated group).
  Recomposites ONLY dirty rects (union of pending dirties, clipped to doc), at most once
  per animation frame. Exposes `onComposite(rect)` for the viewport and the bridge.
- Tools (`engine/tools/*`), each implementing
  `{ id; onPointerDown(p: ToolPointer); onPointerMove(p); onPointerUp(p); cursor(): CursorSpec }`
  where `ToolPointer = { x, y /*doc px, float*/, pressure /*0..1*/, shift, alt, ctrl }`:
  - `brush`: stamped dabs (radial gradient by hardness), spacing 15% of diameter,
    interpolated between events, stroke drawn into a stroke buffer then merged with
    layer at `opacity`, `flow` per dab. Mouse pressure (0 or 0.5) is treated as 1.
  - `pencil` (Pixel tool): aliased 1px-grid square dabs, no AA (Bresenham between points).
  - `eraser`: brush with `destination-out`.
  - `fill`: scanline flood fill on the active layer (or sample "all layers" option off in v1),
    tolerance 0–255 on max channel delta, contiguous.
  - `gradient`: linear primary→secondary from drag start to end.
  - `picker`: sample composite at point → primary colour (Alt with paint tools = picker).
  - `move`: drag active layer offset (integer px).
  - `marquee`: rectangular selection; Shift add / Alt subtract are v1-out (New only);
    when a selection exists all paint tools clip to it. Ctrl/Cmd+D deselects.
  - `hand`, `zoom`: view only (no document change).
  - lasso, wand, crop, clone, smudge, text, shape: listed in the tool rail, disabled.
  Locked or hidden active layer → paint tools do nothing and the status bar says why.
- `History`: undo/redo of
  - pixel edits: patch of the dirty rect before/after (`ImageData`), captured at stroke start/end;
  - structural edits: command objects (add/delete/reorder/rename/visibility/opacity/blend/lock/move).
  Memory cap 256 MB of patch data (oldest dropped); max 100 steps. History panel lists entries
  and clicking one jumps there.

### 3.3 Viewport

- A `<canvas>` sized to the canvas column (devicePixelRatio aware) draws the composite
  with the view transform (zoom 1–3200%, pan), checkerboard under transparency,
  selection marching ants, brush cursor outline (diameter × zoom).
- Pointer Events with pointer capture; coalesced events when available.
- Space-drag pans with any tool; wheel zooms around cursor (Ctrl/Cmd+wheel also).
- "Fit" zoom on first load and on document resize.

### 3.4 UI (`src/ui`)

Matches `design/editor.html` exactly (layout, colours, sizes, icons, copy). Components:
`TopBar`, `ContextBar` (per tool), `ToolRail`, `DocTabs`, `Viewport`, `ColourPanel`
(wheel + SV square interactive by drag, H/S/L/A sliders draggable, hex field editable,
recent swatches), `SwatchesPanel`, `BrushesPanel` (presets set brush params),
`LayersPanel` (select, visibility, lock, rename on double-click, drag to reorder,
group expand, blend mode + opacity of selected layer, footer: new pixel layer, new group,
delete; mask/adjustment/fx disabled), `HistoryPanel`, `StatusBar`
(tool hint, active layer, TD connection state: "TouchDesigner linked" / "Standalone" /
"Reconnecting…").

Menus in the top bar: v1 implements File ▸ New layer, Flatten (to a new pixel layer),
Edit ▸ Undo/Redo, Select ▸ Deselect, View ▸ Zoom in/out/Fit/100%. Other items disabled.
Workspace switch (Paint/Adjust/Output): Paint only active in v1; others disabled.

Keyboard: tool keys from the mockup (V M L W C B N E G S R T U I H Z), `[`/`]` brush size,
`X` swap colours, `D` default colours, Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z / Ctrl+Y redo,
Ctrl/Cmd+D deselect, Space hold = pan, `0` fit, `1` 100%. Shortcuts ignored while
typing in an input.

### 3.5 State

`src/state/store.ts`: signals for tool, colours (primary/secondary as `#rrggbb` + alpha),
brush settings, view transform, panel tabs, connection status, and a `docVersion`
counter bumped on engine events so Preact re-renders layer lists. UI never touches
surfaces directly; it calls engine methods.

### 3.6 Bridge (`src/bridge`)

- `codec.ts`: encode/decode PROTOCOL.md messages (pure, unit tested, shared fixtures with python).
- `tdBridge.ts`: connects to `ws://<location.host>/ws` (or `?ws=` query override, used when
  the UI is served by the Vite dev server). Reconnect with backoff 0.5→5 s.
  On `hello` → document setup. On base frames → write to base layer (rect).
  Outbound: subscribes to compositor; accumulates the union dirty rect and sends at
  most `maxSendFps` (from hello, default 30) composite frames; each frame split into
  bands of ≤ 2 MB payload. Sends a full frame after (re)connect.
  Backpressure: if `ws.bufferedAmount` > 8 MB skip the tick (dirty rect keeps accumulating).
- `mockBridge.ts`: used when no TD (`?standalone=1`, or first connect fails in dev):
  creates a 1920×1080 doc with a generated base image (the mockup landscape) so the
  UI is fully usable; status "Standalone".

## 4. TouchDesigner side

See `docs/TD_COMPONENT.md`. Summary: one containerCOMP with an extension class,
Web Server DAT serving the embedded single-file UI and hosting the WebSocket, Script TOP
holding the composite, Switch TOP falling back to the input until the first composite
arrives, Web Render TOP as the panel background with mouse/keyboard forwarding.

## 5. Scope v1 (what "done" means)

Working: tools move, marquee (new rect), brush, pencil, eraser, fill, gradient, picker,
hand, zoom; colour panel fully interactive; swatches; brush presets; layers (add pixel
layer, add group, delete, reorder by drag, rename, visibility, lock, opacity, blend mode,
group expand); undo/redo + history panel; TD base layer in; composite out; keyboard
shortcuts; TD connection status.

Present but disabled (tooltip "Not in this version"): lasso, wand, crop, clone, smudge,
text, shape tools; masks, adjustments, fx buttons; Adjust/Output workspaces; unimplemented
menu items.

## 6. Performance budgets

Measured in Chromium on the dev machine; TD numbers in TD 2025 on the same machine.

| Item | Budget |
| --- | --- |
| Brush stroke on 1920×1080 doc, 10 layers, 64 px brush | ≥ 55 fps pointer-to-screen, no frame > 32 ms |
| Recomposite of a 256×256 dirty rect, 10 layers | < 2 ms |
| Full recomposite 1920×1080, 10 layers | < 25 ms |
| Composite frame encode (dirty 256×256) | < 1 ms |
| TD: paste a 256×256 band into buffer + Script TOP upload | < 2 ms main thread |
| TD: full 1920×1080 frame receive → out1 | < 40 ms, never blocks a frame > 50 ms |
| TD: input readback when input changes, 1920×1080 | < 15 ms; rate-limited to `Maxinputfps` |
| Bundle (single html) | < 400 KB |

No per-frame allocations in the hot paths (dab stamping, compositor, codec): reuse
buffers and scratch canvases.
