# Idle / performance-mode cost of a finished document (profiling spike, HEAD = v0.9.1)

What a *finished* document costs TouchDesigner per frame when **no browser is connected** (live performance use), to drive an optimization milestone. Nothing in the product was changed. Tool: `scripts/perf_idle.py` (reusable; see its docstring). Raw data of the run below: `.validate/perf_idle.json` (gitignored).

## Method

- One **isolated** TD instance per resolution (`td_workers.Fleet`; the user's TD on 8765 was never touched), TD 2025.32820 on Apple silicon (Metal through MoltenVK), component built from the repo into it, killed afterwards. The user's own TD was running at about 50 % CPU the whole time (GPU/CPU noise; 4K live scenarios are the most affected).
- Document applied through the extension's own `_apply_doc` (after `protocol.parse_doc`); the numpy surface buffers are filled directly with incompressible noise (macOS compresses idle pages, so patterned data would hide the footprint). No WebSocket client was ever connected (`clients == 0`).
- **Document (27 layers)**: 20 pixel layers with document-size surfaces (5 with masks, 10 blend modes mixed), 3 adjustments (hue/saturation, blur 8, levels), 2 shape + 2 text layers, 4 layers with effects (blur 12, drop shadow, drop shadow + blur 6, posterize). 25 surfaces, 48 generated network nodes in `doc` (76 children incl. DATs; 156 operators / 74 TOPs in the component), 7 effect chains.
- Output pulled every frame: a Null TOP outside the COMP is cooked in an Execute DAT's `onFrameEnd`. 300 frames per measurement.
- Python time: `frame_exec.onFrameStart` is timed as a whole (dispatch + `Pump`); per pump step by wrappers on the extension class (isolated instance only). Cookers = `totalCooks` diff over **every** operator under the COMP (plus the pulled null/noise). Cook times = `cpuCookTime`/`gpuCookTime` of the cookers, sampled per cook.
- Scenarios: **S1** static; **S2mid / S2bot / S2top** + a TD input layer fed by an animated Noise TOP (`tz = absTime.seconds * 0.5`, same resolution as the document) in the middle (above p9) / at the bottom / at the top of the stack; **S3top / S3mid** opacity of a layer (p19 / p9) animated *through the doc* each frame (`_apply_doc`). No filter in `shared/effects` has a time/seed-from-clock parameter (`filters.animated.d.ts`: "No time dependence"; grep for `absTime`/`uTime` in `shared/effects`, `network.py`, `effects.py` is empty), so S3 uses the opacity fallback.

### Read this first: two TD states, so compare only within one

The same project runs in two states, and the Python pump is **2.6x slower in the busy one**: *quiet* (fresh instance; process ~29 % of a core at 60 fps) and *busy* (~85 % of a core, same project, same document). The switch happened after toggling the Web Server DAT's `Active`, and once on its own at 4K. It is not caused by this component: with the component's `Active = 0` (pump a no-op) the process stays at ~83 %. It is not the network editor pane either (parking the pane on an empty COMP changed nothing); `sample` shows the time in MoltenVK/AGX render encoding, i.e. TD's own drawing. Consequences: absolute process-CPU numbers mean little; use A/B deltas and the pump timings *per state*. Quiet numbers are only available for S1 and the empty component; S2/S3 and the rate tests were measured busy.

## (a) Python per frame in the component (60 fps, no client)

| | 1920x1080 | 3840x2160 |
|---|---|---|
| `onFrameStart` mean, S1, **quiet** | 347 us (Pump 316: p99 687, max 811) | 295 us (Pump 290: p99 578, max 904) |
| `onFrameStart` mean, S1, **busy** | 770 us | 762 us |
| component with **no document** (quiet) | 264 us | 275 us |
| Pump as a no-op (`Active = 0`): dispatch floor | 41 us | |
| S2mid / S2bot / S2top (busy, input layer) | 802 / 858 / 896 us | 717 / 747 / 846 us |
| S3top / S3mid (busy, doc-driven animation) | 1372 / 1263 us (+ 6.4 ms `network.apply` per update, see below) | 1332 / 1355 us |

That is 2 % (quiet) to 4.6 % (busy) of a 16.7 ms frame, and it is **independent of document size and resolution** (an empty component costs the same): it is fixed per-frame bookkeeping, not document work. A/B on the whole process (60 fps, busy state, 2 alternating rounds): pump on 84.3/85.4 %, `frame_exec` off 80.1/80.9 %, pump + web server off 80.3/79.2 % (4K: 85.5/85.3, 80.4/80.0, 81.8/81.7), i.e. the pump is worth ~4.5 % of a core and the master web server is not measurable (< 1.5 %).

Where the pump time goes (S1, quiet, 1080; us per frame; nested steps in brackets, 4K is within 10 %):

| step | us | note |
|---|---|---|
| `_sync_doc_size` | 173 | every frame, before its own "nothing changed" key compare |
| &nbsp;&nbsp;`_ensure_input_ops` | 136 | `_count_in_ops` does up to 8 `self._opt("in<n>")` operator lookups per frame |
| &nbsp;&nbsp;`_scan_inputs` | 11 (S2: 200) | S2: `top.cook()` of the connected In TOP every frame |
| `_sync_hints` | 29 (S2: 64) | `_content_hints(layers)` rebuilt every frame |
| `_tick_network` / `network.tick()` | 16 / 13 | housekeeping, spare-pool top-up |
| `_update_switch` | 10 (S2: 21) | evaluates `out_switch.par.index` every frame |
| everything else (13 steps) | ~35 | each below 5 us |
| periodic: `_rescan` 5 s, `_check_server` 2 s, `_update_status` 0.25 s, module check 1 s | 0.8 + 0.2 + 1.0 + 1.6 | averages; spikes: `_rescan` 166-229 us, `_check_server` 26-48 us, `_router_tick` max 240 us |

Master web server with no client: `_router_tick` 2.4 us/frame average, `_check_server` 0.2 us. The Web Server DAT itself **cooks every frame** (`totalCooks` +1 per frame; `cookTime` mean 26 us, max 75 us) and is the only operator that cooks in S1. No Timer CHOP/Script TOP/other callback runs per frame (`frame_exec` is the only Execute DAT; 4 expression parameters).

Measured what-ifs (monkeypatched in the isolated instance, busy state, S1 1080, `onFrameStart` mean): baseline 716 us; `_count_in_ops` returning the cached `n_in` **371 us** (-345); `Pump` running fully only every 15th frame when idle (no clients, nothing dirty/importing) **72 us** (-90 %, p99 stays ~0.9 ms from the 4 Hz full pumps).

### Project cookRate 30 vs 60 vs uncapped (isolated instance only)

| S1 busy | fps | `onFrameStart` mean | process |
|---|---|---|---|
| 60 | 60.0 | 770 us | 85 % of a core |
| 30 | 30.0 | 726 us | 45.6 % |
| uncapped (1000) | 83.7 | 792 us | 107 % |
| back to 60 | 60.0 | 743 us | 85 % |

(4K S1: 762 / 728 / 757 us, 85 / 45.6 / 103 %.) Per-frame cost is independent of the rate; the per-second cost is proportional to it (30 fps halves the Python seconds and every-frame cooks). S2mid 1080: 60 fps 810 us, 30 fps 964 us, GPU 3.1 ms/frame at both (cooks scale with the rate). Uncapped TD reaches only ~84-88 fps here (TD's own frame cost, ~12 ms), so the headroom test is not informative.

## (b) What cooks every frame (output pulled every frame)

| scenario | cooking operators per frame | GPU (sum of node `gpuCookTime`) | CPU cook sum | achieved fps |
|---|---|---|---|---|
| S1 static | **only** `webserver` (DAT). 0 TOPs, 0 Script TOPs | 0 | 0 | 60.0 (both res) |
| S2top | 9: noise, In, select, 1 GLSL pass, doc out/null/switch/out/pull | 0.78 ms (4K 1.6-1.9) | 0.39 ms | 60 / 60 |
| S2mid | 18 (10 GLSL passes) | 3.15 ms (4K 9.6-12.9) | 1.2 ms | 60 / 41-55 |
| S2bot | 22 (14 GLSL passes) | 4.2-4.8 ms (4K 19.3) | 1.7-2.1 ms | 60 / 36 |
| S3top (opacity via doc) | 11 | 1.36 ms (4K 4.8) | 0.85 ms | 47.5-48 / 53.5 |
| S3mid | 17 | 2.98-3.1 ms (4K 7.8-8.0) | 1.2-1.5 ms | 49-52 / 51-52 |

- Only the **suffix of the chain above the changing layer** recooks; the static prefix below it is cached by TD itself (S2mid/S2top cookers are exactly the passes above the live layer). So a Cache TOP or locked TOPs on the static prefix add nothing: S1 already cooks nothing.
- (d) **Script TOP surfaces never recook or re-upload when nothing changes**: 0 `s<slot>` cooks over 300 frames in every scenario; `_cook_surfaces` costs 1.9 us/frame idle (`_dirty` empty).
- The network already merges up to 8 plain layers per pass (`mrg_*`, 3 merged passes / 14 merged layers in this document, `fmt8` for Normal-only successors). The 27 layers become 14 cooking GLSL passes in S2bot.
- Per-node GPU timers are approximate: the final `doc_out` Select shows 1.1-3.8 ms in the live scenarios, which is mostly waiting on its inputs, so the sums overstate somewhat; the frame rate is the sanity check (4K S2bot: 19.3 ms GPU, 36 fps).
- S3 (animation through the doc API) is not viable per frame: `network.apply` of one opacity change costs **6.4 ms** CPU, `_flush_doc_state` another **0.75 ms** (JSON-encoding all 27 layers each update), so 60 fps cannot be held (47-53 fps) before the GPU is the limit. Animated parameters would need a direct uniform path, not the doc.
- 4K live is GPU bound on this machine even for one live layer in the middle (41-55 fps), 4K S2bot 36 fps.

## (c) Memory

Surfaces (25 = 20 pixel + 5 mask, doc-size RGBA8): **207 MB (1080) / 829 MB (4K)** of numpy in `ext.surfaces`, duplicated 1:1 by the 25 Script TOPs on the GPU (209 / 836 MB). No other Python buffer above 1 MB is held without a client (`ext_big` empty: no BASE/VIEW frames, no undo caches).

TD-reported `gpuMemory` of the component (S1; "empty" = component without a document):

| | 1080 | 4K |
|---|---|---|
| total reported (naive width x height x bytes agrees within 4 %) | **630 MB** (empty 55) | **2506 MB** (empty 205) |
| Script TOP surfaces (8-bit) | 209 | 836 |
| GLSL TOPs (blend + effect chains, incl. `view_pack`) | 345 | 1369 |
| Multi TOPs (merged passes) | 51 | 202 |
| Text TOPs / `blank` constant | 17 / 8 | 67 / 33 |
| by format: 8-bit fixed / 16-bit fixed / 16-bit float / 32-bit float | 312 / 188 / 97 / 33 | 1248 / 739 / 386 / 134 |
| S2bot (adds In/Select and 7 more 16-bit passes) | 671 | 2669 |
| whole process footprint (`footprint`), empty -> S1 | 1925 -> 3108 MB | 2061 -> 5961 MB |
| GPU (`IOAccelerator`) footprint, empty -> S1 | 668 -> 1615 MB | 813 -> 3916 MB |

The OS-level GPU growth is 1.35-1.5x what `gpuMemory` reports (pools, staging). Nodes: 156 operators, 74 TOPs, 48 generated network nodes + 25 surfaces. `view_pack` (RGBA **32-bit float**) holds 33 MB / 134 MB although no client uses the TD view; 45 % of the document's GPU memory is 16-bit intermediates (284 / 1125 MB), 33 % the surfaces.

**Dropping the numpy buffers** (existing `Freeze()` locks every Script TOP with its pixels; then `ext.surfaces = {}`), measured: footprint -244 MB (1080) / -819 MB (4K) = the numpy bytes; `Freeze()` 97 ms / 352 ms; reading everything back (`numpyArray()` + `from_float`, the `Restore` path) is **byte-identical for all 25 slots** and costs 30 + 47 ms per slot (1080) / 113 + 222 ms per slot (4K), 3.0 s / 12.2 s for all. Side effect: every `numpyArray()` readback leaves a float32 staging buffer in GPU memory (+32 MB per slot at 1080, +1.4 GB for 25 slots; 4K reached the 10 GB IOAccelerator ceiling) that TD did not release.

## Findings outside the brief

1. **Bug (reproducible, HEAD v0.9.1)**: on a freshly built component, `_apply_doc(rev, [])`, wait about 8 s (0 s works), then `_apply_doc` of the 27-layer document (effect layers) raises `KeyError: 'fx_L_p4'` from `network._wire` (network.py:2540, `self._gen[n]`); subsequent applies then fail with `Operator .../doc/s1 has been deleted` (network `_note_companions`). Applying the document as the first apply works, and so does re-applying right after the empty doc. `PREWARM` is off, so it is something else the idle `tick()` does to the pool/fx state. `perf_idle.py` therefore never goes through an empty document. Not investigated further.
2. TD's own process state (quiet/busy above) changes the Python cost of an identical pump 2.6x; measure A/B within a state.
3. `numpyArray()` readbacks accumulate GPU memory (see (c)); relevant to any lazy rehydration design and to `Restore` of big documents.

## Optimization opportunities, ranked (value x safety)

| # | Change | Evidence / estimated saving | Risk |
|---|---|---|---|
| 1 | **Cache the input-op count and skip `_sync_doc_size` work when nothing changed** (`_count_in_ops` -> `n_in`, re-check every N frames or on child create/delete; `_sync_hints` and `_update_switch` behind dirty flags) | measured -345 us/frame busy (716 -> 371), about -130..-170 us quiet (`_ensure_input_ops` 136 of 316 us); a further 40-85 us from hints/switch | Low: invalidation when the user deletes/creates `in<n>` by hand |
| 2 | **Throttle `Pump` when idle** (no clients, nothing dirty/importing/held, no restore, no freeze): full pump at 4 Hz, a 3-comparison early-out otherwise | measured 716 -> 72 us (-90 %), about -4.4 points of a core at 60 fps; removes the 0.6-2.4 ms spikes on 14 of 15 frames | Low-medium: every wake source must bypass the throttle (WS/HTTP callbacks, par_exec, `BecomeMaster`/Active, input connect/disconnect (4 Hz is fine), TOP import, Freeze/Thaw, start-up) |
| 3 | **Event-driven, no per-frame Python in idle**: turn the `frame_exec` callback off when idle, 4 Hz tick via `run(..., delayMilliSeconds)`/Timer, wake from web-server callbacks | on top of #2 only the 41 us dispatch floor plus keeping Python off the cook thread; the Web Server DAT still cooks 26 us/frame | Medium: a missed wake-up looks like a hung editor |
| 4 | **Free `view_pack` while no TD-view subscriber** (resolution 1x1 / 8-bit) | -33 MB (1080) / -134 MB (4K) GPU, ~5 % of the document's GPU memory | Low: first-frame latency on subscribe |
| 5 | **Drop numpy buffers when idle and rehydrate per slot on first touch** (lock Script TOPs via the existing Freeze path) | -207 MB / -829 MB process memory (measured); rehydrate exact; 77 ms (1080) / 335 ms (4K) per edited slot, plus the staging-buffer growth above | Medium-high: a Script TOP that recooks without a buffer goes blank (must stay locked), resize/`/surface` dump/undo/export all read the buffers; check readback buffer release |
| 6 | **Static-prefix collapse above a live layer** (premultiplied over is associative for Normal-only runs: render the static layers above the live one into one cached image, composite it with one pass) | upper bound = S2bot vs S2top: **3.5-4.0 ms (1080) / 17-18 ms (4K)** GPU per frame; S2mid vs S2top: 2.4 / 8-11 ms; real saving is lower: only Normal-blend, non-adjustment, non-effect runs collapse (5 of the 10 modes used here are not Normal) and the network already merges up to 8 plain layers per pass; costs one extra texture (+17 / +67 MB) | High: blend-mode/mask/adjustment boundaries, invalidation on edits; only matters when a live input exists |
| 7 | **Cold standby**: no live input and idle for N s -> keep only the surfaces (locked) and one flattened `out`, destroy the generated chain | GPU 630 -> ~230 MB (1080), 2506 -> ~900 MB (4K) (the chain is 55 % of it, surfaces 33 %); with #5 the whole 207 / 829 MB of RAM too; per-frame cost 0 GPU. Wake = rebuild (`apply` 0.6-1.5 s measured + uploads, 4-8 s end to end for this document) | High: transition state machine, exactness of the locked flatten (8-bit `doc_out` itself locks bit-exactly), TD-side consumers of `out1` during the switch |
| 8 | 16-bit -> 8-bit textures where exact | at most half of the 284 / 1125 MB of 16-bit intermediates, but only passes followed solely by Normal blends are exact and the network already does that (`fmt8`); effects, adjustments, multiply/overlay etc. need the precision | Not worth it as a project; keep the current planner |
| 9 | Cache TOP / locked TOPs on the static subtree to save cooking | none: S1 already cooks nothing; TD does not recook clean nodes | n/a |
| 10 | Master web server tuning / `cookRate` | server idle < 1.5 % of a core (not measurable A/B), DAT cook 26 us; cookRate does not change per-frame cost | n/a |

Suggested milestone order: 1 and 2 together (about 90 % of the idle Python, a day of work, easily testable with a fake clock in `td/tests`), then 4; 5-7 are a separate design (`DESIGN_V12`) because they change the memory model; 3 only if #2 leaves a measurable cost. If animated parameters become a feature, give them a direct uniform path (S3: the doc path costs ~7 ms per update).

## Reproduce

```
.venv/bin/python scripts/perf_idle.py                      # both resolutions, all scenarios, ~40 min; launches and kills its own isolated TD
.venv/bin/python scripts/perf_idle.py --res 1080 --only S1,S2mid --frames 120 --no-rates --no-experiment   # quick
git checkout dist/raster_editor.tox                        # the build step rewrites it
```
