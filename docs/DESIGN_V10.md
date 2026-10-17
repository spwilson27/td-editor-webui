# Raster Editor v10 — idle-aware streaming (TD does only its own rendering when the page is idle)

Builds on `DESIGN_V9.md` (tag `v0.9.1`). Protocol: `PROTOCOL.md` §14 (version 12).

TD already renders everything itself (compositing, blend modes, masks, transforms, effects, adjustments, text, shapes,
live inputs — see `docs/PERF_IDLE.md`); the browser's pipeline is a local preview. While a page is connected, TD still
copies frames out through Python every frame for that page: the BASE input stream (live TD input → page), the TD view
stream (fast / exact frames) and layer previews (`tdPreview`). v10 pauses them when the page is idle.

## Decisions

| Topic | Decision |
| --- | --- |
| Idle | A page is idle when its tab is **hidden** (`document.visibilityState`), or after **10 s without user input** (pointer, key, wheel, touch) while visible. |
| Paused streams | An idle page sends `streams {paused: true}`; TD stops, for that client, BASE frames, VIEW_FAST / VIEW_EXACT frames and layer previews, and does **no per-frame readback or Python image work** for it. When every connected client is paused (or none is connected) TD's per-frame work is exactly the no-browser case. Doc edits already sent are unaffected. |
| Resume | The first input (or the tab becoming visible) sends `streams {paused: false}`; TD resumes and immediately sends fresh frames (newest BASE frame, an exact view refresh in auto / exact mode, current layer previews). The page shows the last frame while paused. |
| Override | A **Keep live** toggle in the status bar (next to the Local / TD view switch) disables idling entirely (also when the tab is hidden). Persisted per viewer (`localStorage`, try/catch), default off. |
| Indicator | While paused the status bar shows a small "Paused (idle)" badge; any input resumes. |
| Editing safety | Pausing never drops edits: pending surface uploads, doc changes and history persistence flush as usual; paused only affects TD → page streams. |

## Validation

Live (isolated workers): with a live input and TD view mode, a paused page → zero BASE / view / preview readbacks and no
per-frame Python image work for that client (cook / readback counters); resume → frames within 200 ms and an exact refresh;
Keep live → no pause after the idle timeout and with a hidden tab; two clients, one paused, one live. Page tests for idle
detection, visibility, the toggle and the badge.
