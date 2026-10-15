# Raster Editor v6 — performance, filters, rough edges

Builds on `DESIGN_V5.md`. Phase A starts while v5 finishes (isolated files); phase B after v5 is committed.

## 1. Decisions (design Q&A)

| Topic | Decision |
| --- | --- |
| Performance (#1) | All five items: blur **downsampled pyramid** (no cap beyond 200 px; cost ~constant in radius), **bounding-box blending + skip empty layers + cache of the stack below the edited layer** (TD), **8-bit intermediates / merged Normal runs** where exact, **browser below-active composite cache** during strokes, **auto TD-view at 4K in the panel** + **pre-warmed resample nodes**. |
| Filters | Four groups, each filter usable **both** as a per-layer effect and as an adjustment layer (one shared shader): **Blur & sharpen** (motion, radial, zoom, lens/bokeh, unsharp mask, high-pass); **Colour grading** (curves RGB/per-channel, gradient map, colour balance, vibrance, channel mixer, selective colour, posterize, duotone, LUT `.cube`); **Stylise & distort** (emboss, edge detect, Kuwahara/oil, pixelate, dither ordered/error-diffusion, CRT/scanlines, film grain, bloom; displace (noise or another layer/input), twirl, ripple/wave, lens distortion, polar, kaleidoscope, tile/mirror); **"Animated" set made static**: grain/noise (seeded), drift glitch, feedback/echo trails, colour cycling — **no time dependence**; iterative ones (feedback, glitch drift, echo) take an **iterations** parameter and are **recomputed only when their input or parameters change** (TD: no time-dependent nodes; cook only on input change). |
| Rough edges (#3) | Bold/italic for font-collection fonts in TD; **adjustment layers limited by the active selection** (auto mask, as Photoshop does when creating an adjustment with a selection); **effects on groups** (applied to the group's composite) and **on adjustment layers** (applied to the adjusted result before mixing); **brush presets** (save/load/rename/delete, persisted per document + per viewer) + **textured/scatter tips + colour jitter**; **undo across saves** (bounded history persisted with the document). |

## 2. Phase A (now)

- **Filters library** (owner: filters agent): shader sources under `shared/effects/` (same framework as v5
  effects: planner `plan_effect`/`planEffect`, `vectors.json`, WebGL2 runner, `EffectChain`), each filter
  a pass list; static-only; iterative filters with `iterations` (bounded, ≤ 64) and deterministic seeds;
  LUT `.cube` parsing in both Python and TS (3D LUT texture as a 2D atlas); displace-by-layer/input takes
  a second source (document the extra input in the chain API). Blur pyramid for all blur-type passes
  (shared effects/adjustments). Types are drafted in `shared/effects/filters.d.ts` (merged into
  `web/src/engine/types.ts` in phase B).
- **TD performance** (owner: network agent): bounding-box blends (per-layer content bounds, blend only the
  union rect via scissor/viewport offset or a cropped pass, pass-through outside), skip empty/fully
  transparent layers, cache the composite below the active (edited) layer so edits cook only the passes
  above it, 8-bit intermediates where results are exact (no adjustments/blur/effects above), merged
  multi-input pass for runs of plain Normal layers, pre-warmed resample/pool nodes, TD Blur TOP / pyramid
  for adjustment blur. Measured with `scripts/perf_td.py` at 4K/34 layers vs `docs/HARDENING.md`.

## 3. Phase B (after v5 commit)

Engine (selection-limited adjustments, effects on groups/adjustments, brush presets + textured tips +
jitter, undo persistence, browser composite cache, filter adjustment layer kinds wired to the filters
library), UI (filter browser/menus, presets panel, tips, auto TD-view at 4K), protocol v7 (filters in
LayerSpec/adjustments, history blob persistence `GET/PUT /history`, presets in DocSpec), ext (history
persistence in doc_state/.redoc, TTC font faces), network integration of filter adjustments + group/
adjustment effects.

## 4. Decisions for unattended completion (2026-10-15)

- **Publishing:** tag `v0.5.0` / `v0.6.0` locally when each milestone is reviewed and live-validated; **do not push**.
- **Parity exceptions:** if a filter/effect cannot match TD in the browser within tolerance, the **Local preview
  shows TD's render of that layer** (per-layer TD render stream, fetched like the VIEW stream: notice + HTTP
  pull, only for layers flagged `tdPreview` by the planner) instead of computing its own.
- **Undo across saves:** persist the **last 50 steps, ≤ 256 MB** (oldest dropped beyond either limit).
- **Auto TD view for large documents:** **never automatic** — show a one-time notice suggesting TD view above
  ~8 MP instead.
