# Live validation — faster and isolated (plan)

`scripts/validate_td.py` drives a running TouchDesigner (via the td-mcp debug server) through ~60 steps. Today a full
run takes ~15–20 min in the user's open project; steps 50–53 (real page driven through a temporary Web Render TOP,
~11 min) dominate, plus ~100 fixed sleeps.

## Option 1 — cheaper runs (implemented)

Measured: full attach run ~25 min → ~9.5 min; `--tier smoke` ~25–30 s; steps 50–53 went from ~2–5 min each to 16–28 s.
`validate_td.run(steps, *, td_host, td_port, td_conn_file, page, tier, no_timing, skip_ui, no_build, json_path)` is the
per-process API used by `td_workers.py`; `--page webrender` remains for one release.


1. **Headless browser driver.** UI steps drive the real page with Playwright Chromium (already installed for the web
   e2e tests, `web/node_modules`) pointed at the master URL, instead of a Web Render TOP + `executeJavaScript` /
   `interactMouse` / `sendKey` (each frame-quantised). A small Node driver process (`scripts/page_driver.mjs`) speaks
   line-delimited JSON over stdio (`eval`, `mouse`, `key`, `goto`, `screenshot`), keeping the existing Python helper API
   (`js`, `js_result`, pointer/key helpers) so steps change minimally. The Web Render path stays available behind a flag
   for one release (`--page=webrender`).
2. **Event-driven waits.** Replace fixed `sleep`s with `wait_until(predicate, timeout)` polling (TD state, page hook
   state, frames received). Every step prints its duration; a summary table lists the slowest steps.
3. **Tiers.** `--tier smoke` (≤ ~2 min: build, server, page, one paint parity, one multi-editor check),
   `--tier affected` (steps mapped from `git diff --name-only` against a step → area table), `--tier full`.
   Timing-budget steps are tagged `timing` and can be skipped (`--no-timing`) or run last.
4. **Independence.** Each step declares its prerequisites (document size, layers, editors) and sets them up itself;
   any step runs alone with `--only N` and gives the same result.

## Option 2 — parallel, isolated TouchDesigner instances (implemented)

    .venv/bin/python scripts/td_workers.py                      # 3 isolated instances (capped by free RAM / CPUs), full suite
    .venv/bin/python scripts/td_workers.py --workers 1          # one isolated instance (the user's project is still untouched)
    .venv/bin/python scripts/td_workers.py --tier smoke --keep  # leave the instances running (debugging; kill with `kill -9 -<pid>`)
    .venv/bin/python scripts/td_workers.py --attach             # no launch: the user's TD on 8765 (today's behaviour)

Options: `--workers N`, `--tier smoke|affected|full`, `--only 5,7`, `--no-timing`, `--keep`, `--attach [--td-port]`, `--durations <json>`
(bin-packing input; default `.validate/last.json`, written by every full isolated run), `--json out.json`, `--page`, `--ready-timeout`.

**How it works**

1. `scripts/make_validate_toe.py` generates `.validate/validate.toe` (gitignored): `/project1/td_python_debug` (the td-mcp debug server)
   and nothing else. It runs in a scratch TD launched on its own port from the committed seed tox `tests/td/td_python_debug.tox`
   (self-contained, see `tests/td/README.md`); no other TD and no td-mcp checkout are needed. `--seed-from-attached` (optional) saves the
   seed read-only from the open TD's `/project1/td_python_debug` instead. The user's project is never modified or saved.
   The raster editor is built fresh from `dist/raster_editor.tox` by validation step 1 in every worker.
2. `td_workers.py` launches N processes (`TouchDesigner <copy of validate.toe>`, new session/process group) with
   `TD_MCP_PORT=<18770+i>` and `TD_MCP_CONNECTION=.validate/w<i>/connection.json` in their environment, waits until td-mcp answers
   (timeout 120 s; a worker that exits early or a modal dialog fails the run), then builds the editor in each worker **one at a time**
   (two editors starting together both claim the default web port 9980: the master's "port free" check is a connect probe, so the race is
   real) and gives each master its own `Port` (9990 + 20 i).
3. Steps (minus step 1 and the tail) are split by longest-processing-time-first bin packing over the recorded durations (equal split
   without records); every shard is `validate_td.py --only 1,<steps> --no-build --td-conn <worker conn file> --json ...` in its own process.
   The tail -- the `timing` steps (`--no-timing` drops them) and then step 99, which deletes the component -- runs afterwards on a
   **freshly relaunched, idle instance** (worker 0 is killed and started again: a failed/odd step in a shard otherwise leaves state the
   timing steps trip over). Results are merged into one table + JSON (`.validate/runs/<ts>/summary.json`).
4. Teardown: always (normal exit, exception, Ctrl-C/SIGTERM/SIGHUP, atexit) by SIGTERM then SIGKILL of **only the process groups it
   launched** (group = launcher pid; checked before every signal; every TD running at start and the owner of port 8765 are a protected set).
   `--keep` skips it. A signal during teardown is ignored until it finishes; every launched instance is recorded in `.validate/pids`
   (pid, start time, command) and the next start offers to kill leftovers of a crashed run whose pid + start time + command still match
   (`--clean-orphans` = yes). Validator subprocesses run in their own session, have a timeout (estimate x 3 + 300 s) and are killed too.
   `~/.td-mcp/connection.json` is hashed before the launch and re-checked; if it changed (a worker with an old plugin) the run aborts and the
   file is restored. Every requested step without a result is reported as a failure; the exit code is non-zero for any failure; an unknown
   `--only` step exits 2. The seed tox and the toe keep a blank `Token` (each worker generates its own); connection files are mode 600;
   tokens are scrubbed from logs; `last.json` ignores failed and zero-duration results.

**Measured facts** (macOS 15, 16 cores, 64 GB, TouchDesigner 2025.32820, td-mcp as of this change)

| Question | Result |
|---|---|
| Second / third TD process at the same time | Works: `TouchDesigner <file>` run directly (the binary does not fork or hand over to the running one). The user already ran two TDs side by side. Started with `start_new_session`, so the instance is its own process group (the web-render helpers inherit it). `open -n -a` was not needed (and cannot pass env). |
| Licence | No dialog, no limit hit: 3 extra instances start, cook and answer td-mcp (a modal dialog would have blocked td-mcp readiness, which fails the run with a timeout and the log path). No licence/consent dialog had to be clicked. |
| td-mcp port | Default 8765 is hard-coded in the toe's `Port` parameter, and the plugin writes `~/.td-mcp/connection.json` (so a second instance would **overwrite the user's connection file**, and its port bind would fail/clash). Fix (td-mcp, 3 small edits): `TD_MCP_PORT` overrides the port, `TD_MCP_CONNECTION` redirects the connection file (plugin and client). The toe itself stores 18765, never 8765. |
| Startup to td-mcp ready | 6.5-7 s per instance (3 in parallel: 6.6 s each). |
| RAM per instance (TD + web-render helpers) | ~1.5 GB idle after start; 2-3 GB peak during the suite (2.0-3.0 GB measured, avg CPU 24-37 % of one core). `--workers` is capped by free RAM (3 GB each, 8 GB reserve) and CPUs (4 per instance). |
| GPU | `ioreg` device utilisation 19 % (user's TD only) -> 21-24 % with 3 workers; in-use system GPU memory ~4.5 -> ~5 GB. Not a bottleneck. |
| Editor web ports | Not safe to leave to the fallback when instances build at once (see 2.); worker i serves on 9990 + 20 i. |
| Wall time, full suite | attach (the user's TD, one at a time): ~15-20 min. `--workers 1` isolated: 374-427 s. `--workers 3`: 186-206 s (shards estimate 118 s, ran ~125 s; tail ~55 s incl. relaunch). |

Results differ run to run for a few steps (14, 19, 20, 52, and the budget step 12 under load); the same failures appear with 1 and 3
workers, so they are not sharding artefacts.

`--attach` keeps today's behaviour for debugging a single step in the user's own TD (it builds, drives and removes its temporary operators
there).
