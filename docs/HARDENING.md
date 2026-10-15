# Hardening report (measured at tag v0.4.0)

Machine: dev Mac, TouchDesigner 2025.32820, headless Chromium (Playwright). Reproduce:
`web/tests/browser/perf.hardening.test.ts` (browser engine, `VITE_PERF` unset) and
`.venv/bin/python scripts/perf_td.py [--ref v0.4.0|WORKTREE]` (TD, scratch COMP `/project1/_hard_perf`).

## 1. CI (`.github/workflows/ci.yml`)

Two jobs. `web` (Node 22, `npm ci` from the tracked `web/package-lock.json`, `tsc --noEmit`, vitest unit, vitest
browser, `npm run build`, `playwright test`; npm and Playwright browsers cached; `VITE_PERF=0 PERF=0` so perf budget
tests skip) and `python` (3.11, `pip install pytest numpy`, `pytest td/tests -q`).

Dry run in a clean clone at v0.4.0 with the exact commands: tsc OK; unit 341 pass; browser 678 pass / 21 skipped;
build OK; playwright 76 pass; pytest 735 pass. At HEAD (b1a3168, contract-only v5 commit) `tsc --noEmit` fails
(tests/unit/xform.test.ts: `LayerTransform` gained rot/kx/ky) - expected mid-v5.

Risks: `effects.test.ts` has a hard `expect(effectsAvailable()).toBe(true)` (WebGL2 + float render targets). Headless
Chromium on ubuntu-latest normally has SwiftShader WebGL2, but if it fails there that test hard-fails (suggest
`it.skipIf(!effectsAvailable())` guards for CI; not changed here). The e2e `webServer` runs `npm run build` itself.

## 2. File import inside the TD Web Render TOP (panel)

Probe page served from localhost, loaded in a throwaway Web Render TOP (v0.4.0 .tox, `/project1/_hard_import`,
destroyed afterwards). UA is Chrome 132; `showOpenFilePicker` exists. Real mouse events via `interactMouse`
(note: pixel `v` is measured from the BOTTOM).

| Probe | Result |
| --- | --- |
| click on button -> `input[type=file].click()` (trusted, user activation true) | `click`/`focus` events fire, `f.click()` returns, **no dialog appears, no `change`, no `cancel` ever** |
| click on `<label for=input>` | same: focus + click only |
| `showOpenFilePicker()` | rejects immediately with `AbortError` |
| page-internal HTML5 drag (draggable div) | `dragstart` fires, but no `dragenter`/`drop` reach the drop zone |
| OS file drag onto the panel | cannot reach the page: CEF windowless rendering has no native drag target; TD's window receives the drop (and TD has no API to forward OS file drags to Web Render). Not testable headlessly; by construction not available. |

Conclusion: in panel mode **File > Place Image (input type=file) and OS drag-and-drop do not work** (silently do
nothing). Clipboard paste of image data is the separately-handled path; the external browser (Open in Browser)
works normally.

Recommended UI change: when `client=panel` (the page already knows this from the query), File > Place Image should
not use the file input. Preferred: new protocol message `chooseFile {purpose:'place'}` -> the ext calls
`ui.chooseFile(load=True, fileTypes=['png','jpg','jpeg','webp','gif','bmp','tif'], title='Place Image')` on the main thread
(blocking, but only for the user's interaction) and streams the picked file back through the existing import path
(TD reads the file with PIL/`TOP.loadByPath`, sends it as an input/import layer). The v5 `FileDialog` (typed path)
is an acceptable fallback. Minimum: disable the item in panel mode with the hint "Use Import from TouchDesigner, paste
(Ctrl/Cmd+V) or open in browser". Also ignore the drop-zone hint text in panel mode.

## 3. Large-document performance (3840x2160, 34 layers)

Document: base + 6 full-size pixel layers, 8 1920x1080 layers scaled 2x, 8 800x600 layers (0.5x / 1.5x), 4 masks,
3 adjustments (hue/sat, blur r=8, levels), 4 text, 4 shapes. 349 MB of canvas backing (browser), 317 MB RGBA8
surface data (TD).

### 3a. Browser engine (Chromium headless, software-composited canvas)

| Measure | Result | Budget (1080p / 10 layers) |
| --- | --- | --- |
| Build doc incl. imports | 505 ms; JS heap ~10 MB (pixels live in canvas backing stores, not visible to `performance.memory`) | - |
| Recomposite 256^2 dirty, no blur in the area | 2.2 ms median, p99 2.7 | < 2 ms |
| Recomposite 256^2 dirty, centre (blur + all layers) | 7.4 ms median, p99 10.7 | < 2 ms (10 layers) |
| Recomposite 1024^2 | 70 ms | - |
| Full 3840x2160 recomposite | 375 ms (4x pixels of 1080p; budget 25 ms @1080p/10 layers) | - |
| readComposite 256^2 / 1024^2 | 0.10 / 1.0 ms | < 1 ms encode |
| 64 px stroke on 2x layer: events/s, p99, max | 909/s, 4.9 ms, 7.9 ms | >= 55 fps, no frame > 32 ms: pass |
| 256 px stroke on full-size 4K layer | 225/s, p99 13.7, max 16.8 ms | pass |
| 64 px stroke with blur(8) in the stack | median 1.3, p99 2.3 ms | pass |
| Document load (docSpec / loadDocument / refill 299 MB / first full composite) | 0 / 4 / 50 / 401 ms | - |

Strokes meet budget even at 4K/34 layers (they composite only the dab rect over a cached below/above split). The
numbers that miss the 10-layer budget are the dirty-rect recomposite through many layers and any full-frame
recomposite (e.g. first paint, undo of a big step, zoom-level changes).

### 3b. TouchDesigner network @3840x2160, 34 layers (92 nodes, 98 TOPs)

| Measure | Result | Budget (DESIGN_V2 §6, 1080p/20 layers) |
| --- | --- | --- |
| Cold `apply()` build | 763 ms (one-off) | - |
| Idle per-frame cost | 0 nodes cooked, 0 ms GPU; `tick()` 0.001 ms | pass |
| Full-chain GPU cook (lowest layer changes) | 14.8 ms (36 nodes cooked); CPU cook 1.2 ms | < 4 ms @1080p; ~16 ms at 4x pixels is ~4 ms/1080p-equivalent, i.e. at budget, but blur alone is 4.1 ms |
| One layer updates: 3840x2160 layer p5 / bottom layer / 2x layer / small 800x600 layer | 13.5 / 14.2 / 12.3 / 5.4 ms GPU | the whole chain above the changed layer recooks, so cost ~ layers above x frame size |
| `apply()` prop change (opacity, blend, visibility, offset, scale, hue, blur radius, shape/text move/colour) | 0.60-0.71 ms median; worst single 20 ms (first creation of a resample node) | < 2 ms: pass |
| `apply()` identical stack | 0.2 ms | - |
| `apply()` add 800x600 layer / add shape layer / delete | 3.8 / 2.1 / 0.6 ms | < 10 ms: pass |
| Memory (estimate w*h*bytes/pixel over all TOPs) | ~3.96 GB GPU textures: 58 blend nodes at 16-bit fixed RGBA (66 MB each at 4K = 3.3 GB), 39 at 8-bit, surfaces 319 MB, text TOPs 127 MB; TD RSS 4.4 GB | no budget; 4K x 34 layers is near the VRAM limit of 8 GB GPUs |

Worst offenders (GPU, delta vs baseline 14.6 ms): blur radius 8 = +4.5 ms (one `blurTOP`, 3.7-4.1 ms, plus its blend
0.5 ms); blur 100 = +12 ms; **blur 400 = +246 ms** (blurTOP cost is ~linear in radius). Shapes+text (8 layers) =
+2.6 ms (~0.33 ms each, mostly the blend pass for a full-doc-size texture). Resample/mipmapped layers: +2.4 ms for the
7 scaled/offset layers vs exact path; minifying 6 full-size layers adds only +0.7 ms. Masks: ~0 (-0.2 ms noise).
Each normal blend node costs 0.40-0.60 ms at 4K regardless of layer content: the per-layer full-frame pass is the
dominant cost (28 passes of ~0.45 ms = 11 ms).

## 4. Ranked recommendations

1. **Cap/clamp blur radius** (UI + protocol validation + network): 400 px costs 246 ms/frame at 4K, a visible TD
   stall. Clamp to ~64-100 (or switch to a separable/downsampled blur above a radius, rendering at 1/2 - 1/4
   res for r > 32). Highest value, smallest change.
2. **Cut full-frame blend passes**: skip fully transparent/empty layers (track per-layer content bounds from the
   dirty rects; a layer with 800x600 content should blend only its bbox via a cropped/custom-resolution GLSL node,
   as small layers currently cost the same ~0.45 ms as 4K ones). Also cache the stack below and above the active
   layer in a Null/Cache TOP so editing a layer recooks only the layer + the passes above it ("flatten below" cache).
3. **Reduce intermediate precision/memory**: 58 blend nodes use 16-bit fixed (66 MB each at 4K). Use 8-bit fixed for
   chains that don't contain adjustments/blur, or 16-bit only at adjustment boundaries; halves-to-quarters VRAM and
   bandwidth. Alternatively merge N consecutive plain `normal`-blend layers into one multi-input GLSL pass.
4. **Browser: tile- or layer-bounds-aware recomposite** for large documents: the 256^2 dirty-rect cost grows with
   layers touching the rect (2.2 -> 7.4 ms); clip each layer draw to its bounds (already partly), cache the
   below-active composite as an ImageBitmap/canvas during strokes, and recomposite in rAF-batched 512^2 tiles
   for 1024^2+ dirty areas (70 ms) and full frames (375 ms); show a low-res preview while zoomed out.
5. **Panel mode at 4K**: cap `Maxsendfps`/panel resolution and auto-fall back to TD-view at doc areas > 1080p; the
   panel frame cost is dominated by the above network cook.
6. **Pre-warm resample nodes** (the 20 ms first-use spike on `apply()` for the first scale of a layer): create the
   `xf_L` node lazily one frame early or from the spare pool.
7. CI: guard WebGL2-dependent tests with `skipIf` so a software-GL-less runner doesn't hard-fail.
