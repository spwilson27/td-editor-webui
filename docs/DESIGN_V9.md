# Raster Editor v9 — fast TD preview: low-latency and accurate modes

Builds on `DESIGN_V8.md` (tag `v0.8.0`). Protocol: `PROTOCOL.md` §13 (version 11). Evidence: two spikes (2026-10-15) —
image frames over the WebSocket vs WebRTC (TD 2025.32820, macOS, Apple Silicon).

## 1. Decisions

| Topic | Decision |
| --- | --- |
| Modes | The TD view has three settings: **Auto** (default), **Low latency**, **Accurate**. Auto = low-latency frames while anything changes (surface edits, doc changes, viewport pan/zoom, live inputs), then **one exact frame** after ~200 ms without changes. Low latency / Accurate pin one behaviour. The UI shows which kind of frame is on screen (e.g. a small "≈" / "exact" badge). |
| Low latency transport | **JPEG colour + JPEG alpha** pushed over the editor's **WebSocket as binary** (no notice + GET), sent in the same TD tick the output is ready; **≤ 2 frames in flight** (newest wins, client acks). Colour is **premultiplied** RGB (no hidden colours under alpha 0); alpha is a separate greyscale JPEG (q≈90). The browser decodes both (`createImageBitmap`) and composites in WebGL. |
| Low latency size | The output is downscaled **on the GPU** (Resolution TOP) to the **viewport's visible region at device pixels** (crop to what is on screen when zoomed in; never larger than the document), reported by the client on pan/zoom/resize. |
| Low latency encode | `cv2.imencode` (TD's Python ships OpenCV 4.11 with libjpeg-turbo) on an 8-bit readback (`saveByteArray('.bmp')`; alpha via a second small TOP since the bmp alpha byte is junk). Quality adaptive: q≈75 default, lower if a frame exceeds the budget. Inline on the main thread (≈ 2 ms at 720p); worker threads are slower because of TD's GIL for multi-call work. |
| Accurate | **Bit-exact, full document resolution, straight alpha**, delivered as raw RGBA **deflate**-compressed (zlib level 1, browser `DecompressionStream('deflate')`). PNG/WebP are not exact through browser decode (premultiplication), so they are not used. The client keeps a persistent exact buffer; after the first full frame TD sends **only changed 64 px tiles** (diffed against the last exact frame it sent to that client); > ~30 % changed → full frame. Heavy encodes run as a single C call in a worker thread so the main thread only pays the readback (~3 ms at 1080p). |
| Pipeline order | Fix the current ordering (`_poll_view` before `_cook_surfaces` costs ~3 ticks): publish after the surfaces are cooked, in the same pump. |
| Old path | The v3 `view` notice + `GET /view` raw path stays for protocol < 11 clients only (removed later). |
| WebRTC | **Dropped.** On macOS TD's WebRTC video is software VP8 (~1.7 Mbps cap, encoder-chosen resolution 480×270 → 1440×810, mirrored image, ~90 ms) — slower and worse than JPEG over the WebSocket. Revisit only for Windows/NVIDIA hardware encode. |
| Cook rate | Never changed by the component. Status/help and docs note that a 60 fps project roughly halves preview latency. |

## 2. Expected numbers (spike, 720p, cook rate 30)

Capture → display ≈ 15 ms, 30 fps (64 fps at 60), ≈ 9 ms TD main thread per frame, 50–160 KB per frame.
Edit → display estimate ≈ 50–70 ms at 30 fps (≈ 30–40 ms at 60). Exact 1080p refine: ≈ 3 ms main thread +
40–130 ms off-thread deflate (full frame), a few ms for typical tile diffs. Current: 6.5–15 fps, ~180–460 ms.

## 3. Validation

`validate_td.py` step 7 is rewritten: low-latency fps ≥ 25 at 720p and edit→display p50 ≤ 100 ms (cook rate 30);
Auto refines to an exact frame (byte-identical to `out1` readback, straight alpha) within 500 ms of the last change;
tile-diff refine after a small edit sends < 10 % of a full frame; alpha correctness (separate plane, hard edges within
JPEG tolerance); multiple editors each streaming. Page tests: decode/composite, mode switching, badge, exact buffer
patching, in-flight limit, viewport-size reporting.
