# AGENTS.md

Operating rules for AI coding agents in this repo (learned the hard way). Human docs: [README.md](README.md), [DEVELOPMENT.md](DEVELOPMENT.md), [docs/README.md](docs/README.md).

## What this is
A raster editor shipped as the TouchDesigner component `dist/raster_editor.tox`: web UI (`web/`, TypeScript/Preact) <-> WebSocket/HTTP protocol (`docs/PROTOCOL.md`) <-> TD extension (`td/raster_editor/ext.py`) <-> generated TD network. `dist/` holds COMMITTED build outputs.

## Commands you will use
```
.venv/bin/pytest td/tests -q                      # fast Python suite (~20 s, no TD)
cd web && npx tsc --noEmit && npm test            # typecheck + unit
cd web && npm run test:browser                    # vitest browser (perf tests are load sensitive, see DEVELOPMENT.md)
cd web && npm run test:e2e                        # playwright; rebuilds dist/ui itself
.venv/bin/python scripts/td_workers.py --workers 1 --tier smoke    # isolated live TD validation (~30 s)
```
Setup from scratch: `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt; cd web && npm ci && npx playwright install chromium`.

## TouchDesigner safety (non-negotiable)
- **Never save, close or modify the user's open TouchDesigner project (.toe).** Never call `project.save()`, never change the project's `cookRate` or `time.play`.
- **Prefer isolated validation** (`scripts/td_workers.py`, which launches private TD instances with their own port and connection file) over `--attach` / `td_call.py` against the default connection. Anything that talks to the TD in `~/.td-mcp/connection.json` or on port 8765 is the user's session: do it only when asked, and only through scripts that use scratch COMPs.
- **Only kill TD processes you launched.** Never kill the TD listening on port 8765 or any TD that was already running. td_workers records the pids/process groups it started (`kill -9 -<pid>` as printed with `--keep`; it refuses to signal protected pids). Check `ps` before any manual kill.
- **Wrap every TD call in a timeout** (`timeout 120 .venv/bin/python ...`). Never `sleep` or loop inside code that runs in TD (it runs on the main thread and blocks every request); return, then poll from outside.
- Runs launched with `--keep` must be cleaned up by you before you finish.
- Recovery when TD hangs (no td-mcp answer, steps timing out): check for a modal dialog in your own instance; if it is one you launched, kill its process group and relaunch (td_workers `--clean-orphans` removes leftovers of a crashed run). Never fix it by touching the user's instance; report instead.
- Point scripts at an isolated instance with `TD_MCP_CONNECTION=<repo>/.validate/w0/connection.json` or `--td-conn`. `~/.td-mcp/connection.json` is hashed and re-checked by td_workers; do not overwrite it.

## Git and hygiene
- Stage explicit paths (`git add path1 path2`); **never `git commit -a` / `git add -A`**.
- Validation and test runs dirty tracked files. Before committing, check `git status` and restore the churn: `git checkout dist/raster_editor.tox` (validation step 1 rebuilds it) unless you intentionally rebuilt the component; discard `web/.vitest`, `web/test-results`, `web/coverage` changes. `dist/ui/index.html` is rewritten by every `npm run build` / `test:e2e`; commit it only if the sources it came from changed.
- **Do not push, and do not push tags, unless the user explicitly asks.** Tag releases locally only (`git tag vX.Y.Z`).
- Never put tokens (project token, td-mcp tokens, `connection.json`, `#token=` URLs) in commits, docs or logs. `.validate/` is gitignored; keep it so.
- No machine-specific absolute paths in any tracked file: `td/tests/test_portable.py` scans tracked files for them. Run it (`.venv/bin/pytest td/tests/test_portable.py -q`) after writing docs or scripts.
- Commit messages end with the `Co-Authored-By:` trailer your harness specifies.

## Working method
- For multi-part changes write the design first: `docs/DESIGN_Vn.md` (decisions, architecture, validation additions) and the `docs/PROTOCOL.md` section, then implement. Questions to the user come before building.
- Implementer + reviewer workflow: one pass implements with tests; a separate reviewer pass reads the diff, runs the tests and reports findings by severity with file:line (checklist in `docs/TESTING.md` section 4). Validate live in an isolated TD before calling a TD-facing change done.
- Protocol changes touch both sides: `web/src/bridge/codec.ts` and `td/raster_editor/protocol.py`, then `scripts/make_fixtures.py`, tests on both sides, version bump (see DEVELOPMENT.md).
- Changing `td/raster_editor/*`, `shared/effects/*` or `web/src/**` that the component embeds requires rebuilding `dist/ui` and `dist/raster_editor.tox` before a release.
- Runtime-created operators inside the COMP: names start with `_` and tag `reRuntime`.
- Timing-only live failures (steps 7, 8, 12, 16 and load-sensitive perf tests) are not regressions until they fail alone on an idle machine.

## Where the important code lives
| Path | What |
|---|---|
| `td/raster_editor/ext.py` | extension: Session per editor, master router, pump loop, view stream, files, upgrade hooks |
| `td/raster_editor/protocol.py` | wire format + `PROTOCOL_VERSION` (pure python) |
| `td/raster_editor/frames.py` | pixel maths, band/tile/JPEG/deflate encoders |
| `td/raster_editor/network.py` | generated document network (`DocNetwork`), `blend.glsl`, `shape.glsl` |
| `td/raster_editor/effects.py` | `EffectChain`, embedded filter specs, planner shared with TS |
| `td/raster_editor/registry.py`, `upgrade.py` | editor discovery, Upgrade All Editors |
| `td/build_component.py` | component builder, `VERSION`, parameters, HELP texts |
| `web/src/bridge/codec.ts`, `tdBridge.ts`, `editorSessions.ts` | protocol client |
| `web/src/engine/` | compositor, surfaces, tools, selection, history, `effects/` (WebGL2 shared with TD) |
| `web/src/state/`, `web/src/ui/` | store/slices, Preact UI |
| `shared/effects/` | GLSL + `*.filter.json` specs + test vectors used by both sides |
| `scripts/validate_td.py` | live validation steps (STEPS table, TIMING, SMOKE, tiers) |
| `scripts/td_workers.py` | parallel isolated TD runner; `make_validate_toe.py` builds its project |
| `scripts/td_call.py`, `td_client.py`, `page_driver.*` | run code in TD, built-in td-mcp client, headless page driver |
| `scripts/make_fixtures.py` | protocol fixtures in `docs/fixtures` |
| `dist/` | committed outputs: `raster_editor.tox`, `ui/index.html` |
