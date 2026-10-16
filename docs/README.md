# Documentation index

Start with the top-level [README.md](../README.md) (install and use), [DEVELOPMENT.md](../DEVELOPMENT.md) (build, test, release) and [AGENTS.md](../AGENTS.md) (rules for AI coding agents).

## Reference (kept current)

| Doc | What it covers |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | TD <-> web wire protocol, current version 11: binary frame header, JSON messages, HTTP pull endpoints, session flow, and a numbered section per version's additions. |
| [TD_COMPONENT.md](TD_COMPONENT.md) | The `raster_editor` COMP: network, custom parameters, extension behaviour (session, master router, election, failover, pump), build and install, verified TD API notes, per-version additions. |
| [TESTING.md](TESTING.md) | Test layers and commands, required coverage, live-validation quick reference, reviewer checklist. |
| [VALIDATION.md](VALIDATION.md) | Live validation design and measurements: tiers, headless page driver, isolated parallel TouchDesigner workers and their safety model. |
| [FILTERS.md](FILTERS.md) | Filter/effect library: how the shared specs work, planner flags, generated table of all filters with parity status. |
| [HARDENING.md](HARDENING.md) | Hardening and performance report measured at v0.4.0: CI, import, large-document budgets. A measurement record; re-measure with `web/tests/browser/perf.hardening.test.ts` and `scripts/perf_td.py`. |
| `fixtures/` | Shared protocol fixtures (`*.bin`, `fixtures.json`, `view_v11.json`) decoded by both the TypeScript and Python tests; regenerate with `scripts/make_fixtures.py`. |

## Design history (one doc per milestone; kept as history, not rewritten)

Each records the decisions of its milestone (Q&A table), architecture changes and validation additions. Where a later doc contradicts an earlier one, the later one wins; the reference docs above are the current truth.

| Doc | Milestone |
|---|---|
| [DESIGN.md](DESIGN.md) | v1: goals, architecture, performance budgets (section 6), original in-TD panel design |
| [DESIGN_V2.md](DESIGN_V2.md) | v2: compositing in TouchDesigner (supersedes the compositing parts of DESIGN.md) |
| [DESIGN_V3.md](DESIGN_V3.md) | v3: import, text, shapes, selections, parameter help (protocol 4) |
| [DESIGN_V4.md](DESIGN_V4.md) | v4: transforms, canvas size, rulers/guides, TD-only text/shapes, export (protocol 5) |
| [DESIGN_V5.md](DESIGN_V5.md) | v5: tools, free transform, selection extras, files, layer effects, multiple inputs (protocol 6) |
| [DESIGN_V6.md](DESIGN_V6.md) | v6: performance, filters, tdPreview, brushes, history persistence (protocol 7) |
| [DESIGN_V7.md](DESIGN_V7.md) | v7: layer panel, groups, flatten, multi-select, unified adjustments (protocols 8, 9) |
| [DESIGN_V8.md](DESIGN_V8.md) | v8: multiple editors per project, master/slave, Upgrade All Editors (protocol 10) |
| [DESIGN_V9.md](DESIGN_V9.md) | v9: fast TD preview and exact refine (protocol 11) |

New milestone: add `DESIGN_Vn.md` before implementing, then a numbered section in PROTOCOL.md and TD_COMPONENT.md, and a row here.
