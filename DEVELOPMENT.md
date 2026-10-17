# Development guide

Everything needed to build, test, change and release the Raster Editor from a fresh clone. User-facing docs: [README.md](README.md). Rules for AI agents: [AGENTS.md](AGENTS.md). Doc index: [docs/README.md](docs/README.md).

## Repo layout

```
td/
  build_component.py      builds /project1/raster_editor in a running TD and saves dist/raster_editor.tox (VERSION lives here)
  raster_editor/          the Python that runs inside TD (embedded as Text DATs)
    ext.py                RasterEditorExt: per-editor Session + master router, pump, view stream, files   (the big one)
    protocol.py           wire format (binary frames + JSON messages), PROTOCOL_VERSION; pure python
    frames.py             pixel maths (premultiply, bands, view/JPEG/tile encode); numpy
    network.py            DocNetwork: generates the document's TD network (Script TOP surfaces, blend.glsl, shape.glsl)
    effects.py            EffectChain: GLSL TOP chains for layer effects / filters; embeds shared/effects specs
    registry.py, upgrade.py   editor discovery (tag rasterEditor) and Upgrade All Editors
    blend.glsl, shape.glsl
  tests/                  pytest, no TouchDesigner needed (fake TD objects in faketd.py / fakenet.py)
web/                      the editor UI (Vite + TypeScript + Preact + @preact/signals)
  src/engine/             pixel engine: surfaces, compositor, tools, selection, history, effects (WebGL2)
  src/bridge/             codec.ts (wire format), tdBridge.ts (WebSocket/HTTP client), editorSessions.ts, mockBridge.ts, tdViewClient.ts
  src/state/              store + slices, keyboard, tools
  src/ui/                 Preact components
  tests/unit | browser | e2e | helpers
shared/effects/           effect/filter definitions used by BOTH TD and the browser: <type>.glsl, <type>.filter.json, *.d.ts, vectors
dist/                     COMMITTED build outputs: raster_editor.tox, ui/index.html (single file)
scripts/                  live-TD tooling (validate_td.py, td_workers.py, td_call.py, effects_dev.py, network_dev.py, ...) and make_fixtures.py
docs/                     see docs/README.md; docs/fixtures = shared protocol fixtures
tests/td/                 committed td-mcp debug tox used by validation (see tests/td/README.md)
design/editor.html        approved UI mockup
.validate/                gitignored: validation projects, worker dirs, run logs
```

## Architecture

```
 Browser (web/, one tab per editor)              TouchDesigner process
 +-------------------------------+   WebSocket   +--------------------------------------------------------------+
 | Preact UI                     |  JSON + binary|  master editor (raster_editor COMP) : Web Server DAT         |
 | pixel engine (Canvas2D/WebGL) |<------------->|    master router: routes by editor=<id>  (O(1) dict)         |
 | bridge/tdBridge.ts            |   HTTP GET    |        |                         |                           |
 | (surfaces up, notices down)   |<--------------|        v                         v                           |
 +-------------------------------+  (images are  |  Session of editor A        Session of editor B (slave: no   |
                                     pulled)     |  RasterEditorExt (ext.py)   server, called in-process)       |
                                                 |        v                                                     |
                                                 |  generated TD network: Script TOP surfaces -> blend.glsl     |
                                                 |  -> effects (GLSL TOP chains) -> doc_out -> out_switch -> out1|
                                                 +--------------------------------------------------------------+
```

Key ideas (details in [docs/PROTOCOL.md](docs/PROTOCOL.md), [docs/TD_COMPONENT.md](docs/TD_COMPONENT.md), [docs/DESIGN_V8.md](docs/DESIGN_V8.md), [docs/DESIGN_V9.md](docs/DESIGN_V9.md)):

- The browser owns the pixels it paints. It uploads changed 256 px tiles of layer **surfaces** (binary WebSocket frames) and the document description (JSON `doc`). TouchDesigner composites the whole stack on the GPU and emits the output TOP.
- **TD never writes image data to a WebSocket** (it would block the cook thread when a peer stops reading). Images going to the browser (BASE input frames, surface dumps, TOP imports, layer previews) are announced with a small JSON notice and pulled with HTTP GET. The one exception is the v11 view stream below, which is bounded (at most 2 frames in flight, newest wins).
- **Master / slave routing**: every `raster_editor` COMP is complete and can be the project master. Only the master has an active Web Server DAT; it routes all HTTP/WebSocket traffic to the target editor's Session by `editor=<id>`. Failover moves the server to the next active editor on the same port and token.
- **Fast / exact view stream** (protocol 11): in the editor's TD view mode, *fast* frames are JPEG colour + JPEG alpha of the visible viewport region, pushed over the WebSocket every tick; *exact* frames are bit-exact full-resolution RGBA (deflate, 64 px tile diffs) sent once after changes stop (Auto) or continuously (Accurate).
- **Idle-aware streaming** (protocol 12, [docs/DESIGN_V10.md](docs/DESIGN_V10.md)): an idle page (hidden tab, or 10 s without input; the status-bar *Keep live* toggle disables this) sends `streams {paused: true}` and TD stops BASE, view and layer-preview work for that client; any input resumes with fresh state.
- **Shared effects**: each effect/filter is a `shared/effects/<type>.glsl` + `<type>.filter.json` spec rendered by the same shader source in TD (GLSL TOP chain, `effects.py`) and in the browser (WebGL2, `web/src/engine/effects`). Planners in Python and TS are checked against the same vectors.
- The component is **self-contained**: `build_component.py` embeds Python sources, shaders and `dist/ui/index.html` as DATs; no repo checkout is needed at runtime.
- Auth: per-project random token (URL fragment), loopback-only peers and Host header.

## Dev setup (fresh clone)

```bash
git clone <repo-url> td-raster-editor && cd td-raster-editor
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt     # pytest + numpy, pinned
cd web && npm ci && npx playwright install chromium && cd ..
```

Requirements: Python 3.11+ (CI runs 3.11; 3.14 works), Node 22+ (CI uses 22), Chromium via Playwright. TouchDesigner is only needed for live work (building the component, validation); `TD_BIN` selects the executable, otherwise the standard install location is used. The td-mcp debug component ships in `tests/td/td_python_debug.tox`; no td-mcp checkout is needed.

Quick sanity: `.venv/bin/pytest td/tests -q` (about 20 s) and `cd web && npm test` (a few seconds).

## Edit, build, test loop

| You changed | Do |
|---|---|
| `web/src/**` | `cd web && npm run build` writes the single-file UI to `dist/ui/index.html` (`tsc --noEmit && vite build`). Then rebuild the component (below) so the new UI is embedded. |
| `td/raster_editor/*.py`, `*.glsl`, `shared/effects/*` | rebuild the component |
| protocol | see "Changing the protocol" |

**Web UI without TouchDesigner**: `cd web && npm run dev` serves Vite on its default port with the mock bridge (a fake landscape document); `?standalone=1` forces the mock. **Web UI against real TD with hot reload**: run `npm run dev`, then set the editor's `Devurl` parameter to the Vite URL (for example `http://127.0.0.1:5173/`); *Open in Browser* then opens the dev server page with `ws=ws://127.0.0.1:<Port>/ws` and the token in the fragment (Vite's origin is allowed by CORS because it is loopback).

**Rebuild the component in a running TouchDesigner**:

```bash
.venv/bin/python td/build_component.py          # embeds sources, saves dist/raster_editor.tox
.venv/bin/python td/build_component.py --dev    # DATs file-synced to the repo files: edits to td/raster_editor/*.py, *.glsl and dist/ui/index.html reload live; the .tox is NOT saved
```

The script forwards itself to the TouchDesigner named by `$TD_MCP_CONNECTION` (else `~/.td-mcp/connection.json`) through the td-mcp debug component. It only touches `/project1/raster_editor` and a temporary `/project1/_re_tox_build`; the document inside an existing editor survives rebuilds. **Do not point it at a TouchDesigner holding a project you care about**; use an isolated instance:

```bash
.venv/bin/python scripts/td_workers.py --workers 1 --tier smoke --keep     # launches a private TD, leaves it running
export TD_MCP_CONNECTION=$PWD/.validate/w0/connection.json                 # aim td_call.py / build_component.py at it
.venv/bin/python td/build_component.py --dev
# ...iterate; stop it with the kill command printed by td_workers (kill -9 -<pid>), or `unset TD_MCP_CONNECTION` and close it
```

Run anything in a TD: `.venv/bin/python scripts/td_call.py --exec file.py [--td-conn CONNFILE | --td-port PORT]`, or pipe code on stdin. The code runs on TD's main thread: never sleep or loop inside it; return and poll from outside.

## Tests

Run from the repo root unless noted. `npm run check` (in `web/`) = typecheck + unit + browser + e2e + pytest.

| Layer | Command | What / where |
|---|---|---|
| Python (no TD) | `.venv/bin/pytest td/tests -q` | protocol, frames, ext (fake TD), network, effects, upgrade, workers/validate helpers, portability (`test_portable.py`: tracked files must not contain machine paths). About 1400 tests, ~20 s. |
| Typecheck | `cd web && npx tsc --noEmit` (or `npm run typecheck`) | |
| Web unit (node) | `cd web && npm test` | `web/tests/unit`: codec, colour, history, selection maths, store, bridge. |
| Web browser (vitest + headless Chromium) | `cd web && npm run test:browser` | `web/tests/browser`: engine, compositor, tools, effects parity, UI components, perf budgets. Needs `npx playwright install chromium` and WebGL2. |
| E2E (Playwright) | `cd web && npm run test:e2e` | `web/tests/e2e`: builds and serves the app on port 4173 itself (`npm run build && npm run preview`), uses a fake TD WebSocket server (`fakeTd.ts`). Note the build rewrites `dist/ui/index.html`. |
| Coverage | `cd web && npm run test:coverage` | v8 coverage of `src/engine` and `src/bridge`. |
| Live TouchDesigner (isolated) | `.venv/bin/python scripts/td_workers.py [--workers N] [--tier smoke\|affected\|full] [--only 5,7] [--no-timing]` | Launches N private TD instances; details in [docs/VALIDATION.md](docs/VALIDATION.md). Smoke tier about 30 s, full suite 3-7 min. |
| Live TouchDesigner (attach) | `.venv/bin/python scripts/validate_td.py --td-conn <connection file> [--tier ... --only ...]` | Runs steps against an already open TD (an isolated one you kept with `--keep`). Never against a project you care about. `td_workers.py --attach` uses the TD on 8765, i.e. someone's real project: avoid. |
| Effects / network harnesses (live TD) | `scripts/effects_dev.py [parity\|stress\|perf\|sync\|report\|all]`, `scripts/network_dev.py [all\|blend\|...]`, `scripts/upgrade_dev.py`, `scripts/perf_td.py` | Create and destroy scratch COMPs (`/project1/_fxdev`, `_netdev`, `_upg_box`, `_hard_perf`) in the TD of the connection file. See each script's docstring. |

Test environment variables: `PERF=0` / `VITE_PERF=0` skip the machine-dependent perf budget tests (CI sets both); `REGEN_EFFECT_VECTORS=1` rewrites `shared/effects/vectors.json` from the Python planner when running `td/tests/test_effects.py`.

### Known flaky / load-sensitive tests

- Perf budget tests (`web/tests/browser/perf*.test.ts`, plus the "SDF performance" test in `shapesdf.test.ts`) assert absolute millisecond budgets; on a busy laptop (TouchDesigner open) 5 of them failed in a full `npm run test:browser` run while everything else passed: run them on an idle machine, skip with `PERF=0 VITE_PERF=0`. They also print `PERF ...` measurement lines.
- Live validation **timing steps** (7 view fps/age, 8 stroke latency, 12 network + apply budgets, 16 stalled clients) are tagged `timing`: they run last, are skipped by `--no-timing`, and fail on loaded machines (for example three parallel workers). If one fails, rerun it alone: `td_workers.py --workers 1 --only 12`.
- A few non-timing steps (14, 19, 20, 52) have shown run-to-run differences in timing-sensitive waits; the same results appeared with 1 and 3 workers. Rerun the failing step alone before suspecting your change.
- Validation runs rebuild `dist/raster_editor.tox` and the web test runs write under `web/` (`.vitest`, `test-results`, `coverage`): restore or leave out of commits (`git checkout dist/raster_editor.tox` unless you meant to rebuild it).

## Changing the protocol

The wire format is implemented twice and tested against shared fixtures: `web/src/bridge/codec.ts` and `td/raster_editor/protocol.py`; specified in [docs/PROTOCOL.md](docs/PROTOCOL.md).

1. Write the design first: a `docs/DESIGN_Vn.md` (or a section) and a new numbered section in `docs/PROTOCOL.md`.
2. Additive changes (new optional field, new message type, both sides ignore unknown types/fields) normally still bump `PROTOCOL_VERSION` when a client or server must know about them. Bump it in **both** `protocol.py` (`PROTOCOL_VERSION`) and `codec.ts`. `MIN_PROTOCOL` in `protocol.py` is the oldest client TD still serves; raise it only when dropping an old path. A mismatch shows "Protocol mismatch" in the page.
3. Implement both sides, then regenerate fixtures: `.venv/bin/python scripts/make_fixtures.py` (writes `docs/fixtures/*.bin`, `fixtures.json`, `view_v11.json`; imports `td/raster_editor/protocol.py`). Add TS and Python decode tests; both read the same fixtures. Commit the regenerated fixtures.
4. Update `docs/TD_COMPONENT.md` (extension behaviour) and add or adjust live validation steps in `scripts/validate_td.py`.
5. Rebuild `dist/ui` and the component (below).

## Adding an effect or filter

Filters are data-driven; see [docs/FILTERS.md](docs/FILTERS.md) for the spec format.

1. Add `shared/effects/<type>.glsl` and `shared/effects/<type>.filter.json` (parameters with kind/default/min/max/unit, `reads`, `passes`, `samples`, optional `include` of `filterlib`/`blurlib`). Copy a similar existing filter. Update the `*.d.ts` types (`shared/effects/filters.<group>.d.ts`) and the web UI schema if the filter needs a custom editor (`web/src/state/filterSchema.ts`, `web/src/ui/FilterEditors.tsx`).
2. Embed the specs for TD: `.venv/bin/python scripts/effects_dev.py sync` (rewrites the embedded JSON block in `td/raster_editor/effects.py`; the component ships no spec files). `effects.py` and `web/src/engine/effects/{filters,plan}.ts` must plan identically.
3. Regenerate planner vectors: `REGEN_EFFECT_VECTORS=1 .venv/bin/pytest td/tests/test_effects.py -q`, then rerun without it; web tests `web/tests/browser/effects*.test.ts` check that every sample renders and partial == full rendering.
4. Prove TD/browser parity in a live TD: `.venv/bin/python scripts/effects_dev.py parity --only <type>` (max diff <= 3/255). `stress` and `perf` modes are optional. Regenerate the catalogue with `effects_dev.py report --results DIR` into docs/FILTERS.md.
5. Rebuild `dist/ui` and the component; run validation steps 38-40.

## Releasing

1. Everything green: pytest, typecheck, unit, browser, e2e, and at least `td_workers.py --tier smoke` (ideally the full suite).
2. Bump `VERSION` in `td/build_component.py` (stamped into the read-only `Version` parameter; **Upgrade All Editors compares it** and only replaces editors older than the one you are using). Bump `PROTOCOL_VERSION` per the section above if the wire format changed.
3. Rebuild the UI (`cd web && npm run build`) and the component in an isolated TD (`td/build_component.py`); commit `dist/ui/index.html` and `dist/raster_editor.tox` together with the sources. Run the live Upgrade steps (48, 59) so older editors still upgrade.
4. Add `docs/DESIGN_Vn.md` and the PROTOCOL/TD_COMPONENT sections; update `docs/README.md`.
5. Commit with a message in the style `vN: <summary>` and tag locally: `git tag vX.Y.Z`. Tags so far: v0.1.0 ... v0.9.0. Pushing (`git push --tags`) is a separate, deliberate step.

## td-mcp dependency

Live tooling talks to TouchDesigner through the td-mcp debug component (`tests/td/td_python_debug.tox`, wire client in `scripts/td_client.py`). To refresh the committed copy after td-mcp changes, rebuild the tox in the td-mcp repo (`python scripts/build_tox.py`) and copy `tox/td_python_debug.tox` and `tox/td_python_debug.manifest.json` to `tests/td/`; regenerate `.validate/validate.toe` with `scripts/make_validate_toe.py`.

## Conventions

- One design doc per milestone: `docs/DESIGN_Vn.md` records decisions (Q&A table), architecture changes and validation additions *before* the work; `docs/PROTOCOL.md` gets a numbered section per protocol version; `docs/TD_COMPONENT.md` documents the component. Per-milestone docs are history; keep them, add a new one rather than rewriting old ones.
- Keep TD glue thin: pixel maths in `frames.py`, byte layout in `protocol.py`, network generation in `network.py`.
- Runtime-created child operators inside the COMP must start with `_` and be tagged `reRuntime` (Upgrade All Editors never copies them).
- No machine-specific absolute paths in any tracked file (`td/tests/test_portable.py`); use `$PWD`-relative commands or `<path>` placeholders.
- Never block TouchDesigner's main thread: no synchronous readbacks in per-frame paths, no unbounded loops in callbacks.
- Commit messages: `vN: summary` for milestones, short imperative otherwise; implementer and reviewer work happens in separate passes (see AGENTS.md).
