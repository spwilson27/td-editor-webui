# Testing, validation and review

## 1. Test layers

| Layer | Tool | Location | Runs |
| --- | --- | --- | --- |
| Pure TS logic (codec, colour math, history bookkeeping, rect math, flood-fill on raw arrays, store reducers) | vitest (node) | `web/tests/unit` | `npm test` |
| Canvas code (surfaces, compositor + blend modes, brush/eraser/pencil/gradient output, move, selection clipping, undo patches) | vitest browser mode, Playwright chromium, headless | `web/tests/browser` | `npm run test:browser` |
| UI + end-to-end (tool switching, painting with the mouse, layers panel ops, colour panel drags, shortcuts, history, standby overlay, protocol round trip against a fake TD WebSocket server in node) | Playwright | `web/tests/e2e` | `npm run test:e2e` |
| Python pure modules (`protocol`, `frames`) and extension logic with fake TD objects | pytest | `td/tests` | `npm run test:py` (`.venv/bin/pytest td/tests`) |
| Live TouchDesigner validation | `scripts/validate_td.py` via td-mcp | — | manual / orchestrator |

`npm run check` = typecheck + lint + all of the above except live TD.

Shared protocol fixtures (`docs/fixtures`) are decoded by both TS and Python tests.

## 2. Required coverage

- Every module in `engine/`, `bridge/`, `td/raster_editor/` has tests. Line coverage
  ≥ 85 % for `engine` + `bridge` (vitest coverage, v8) and for `protocol.py` + `frames.py`.
- Pixel tests assert actual pixel values (with tolerance ≤ 2 per channel where blending is
  involved), not just "no throw".
- Every blend mode is checked against a reference formula on at least one pixel pair.
- Edge cases that must have tests: zero-size and out-of-bounds rects; brush stroke
  entirely outside the doc; single-click dab; fill on fully transparent layer; fill at
  tolerance 0 and 255; undo after resize; hidden/locked active layer; group opacity
  isolation; band splitting at exactly 2 MB; frame with wrong docW/H dropped; payload
  length mismatch; premultiply ⇄ unpremultiply round-trip incl. alpha 0 and 255;
  vertical flip; reconnect resends full frame; takeover switches active client.
- Performance tests (browser, skipped on CI-like slow runs with `PERF=0`): assert the
  budgets in DESIGN.md §6 for compositor and stroke dab throughput.

## 3. Live TD validation (`scripts/validate_td.py`)

Run with TouchDesigner open and td-mcp listening. Steps, each printing PASS/FAIL:

1. Build: run `td/build_component.py`; COMP exists, no operator errors under it.
2. Server: `GET http://127.0.0.1:<Port>/` returns the UI html.
3. Panel: `webrender.loaded` within 10 s; screenshot `webrender` to `dist/validate/ui.png`;
   image is not uniform (catches the white-page failure).
4. No input: `out1` is `Docw×Doch`.
5. Input: connect a Constant TOP (opaque red, 640×360) → after ≤ 2 s `out1` is 640×360 and
   centre pixel ≈ red (the composite came back through the editor, `out_switch.index == 1`).
6. Paint: select brush via key `b` (sendKey), set primary to blue via `executeJavaScript`
   hook `window.__editorTest.setPrimary('#0000ff')`, drag across the canvas centre with
   `interactMouse`; within 1 s centre pixel of `out1` ≈ blue, corner pixel still red.
7. Undo: `sendKey('z', ctrl/cmd)` → centre returns to red.
8. Layer: new layer + hide it via the test hook → output unchanged by hidden paint.
9. Disconnect input → `out1` returns to `Docw×Doch`.
10. Perf: report median and worst `Pump` time and composite receive time over 300 frames
    while dragging; fail if they exceed DESIGN.md §6.

`window.__editorTest` is a small test hook (installed only when the URL has `?test=1` or the
build flag `VITE_TEST_HOOKS` is on; the validation script sets `Devurl`-less builds with
hooks enabled via `?test=1` on the panel URL).

## 4. Review checklist (reviewer agents)

Reviewers read the diff and the code it touches and run the tests themselves. Report
findings ranked by severity, each with file:line and a concrete failure scenario.

1. Correctness: matches DESIGN/PROTOCOL/TD_COMPONENT; off-by-one in rects, flips,
   premultiply maths, banding; event ordering; state after errors and reconnects.
2. Tests: required coverage above present and meaningful (would fail if the code broke);
   missing edge cases listed explicitly.
3. Performance: no allocations or `getImageData` of whole doc in per-pointer-event or
   per-frame paths; dirty-rect discipline; no O(doc) work per dab; TD main thread never
   blocks (no sync readbacks, no unbounded loops in callbacks).
4. Robustness: CEF compatibility (no too-new APIs), exceptions contained, no leaks
   (listeners, canvases, websockets), locked/hidden layers respected.
5. Fidelity to `design/editor.html` for UI work (spot-check screenshots).
6. Simplicity: no dead code, no speculative abstraction, matches surrounding style.
