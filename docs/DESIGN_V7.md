# Raster Editor v7 — layer panel, flatten, multi-select, unified adjustments

Builds on `DESIGN_V6.md` (tag `v0.6.0`). Protocol: `PROTOCOL.md` §10 (version 8).

## 1. Decisions (design Q&A)

| Topic | Decision |
| --- | --- |
| Group visuals | Groups must read clearly as groups: folder icon open/closed + chevron, a tinted group header row, children indented with a vertical guide line in the group's colour spanning its children, a subtle tinted block behind the children, and a clear end of group. Collapsed groups show a child count. Dragging into/out of a group shows an insertion indicator at the right depth. |
| Multi-select | Click = select one; **Shift+click = range** (in display order, within the visible rows); **Cmd/Ctrl+click = toggle**. Selected rows highlighted; the *active* layer (paint target, panels) is the last clicked. Applies to the whole selection: **Delete** (one undo step), **eye / lock** clicks on any selected row, **drag to reorder / into groups**, **Layer ▸ Group Layers (Cmd/Ctrl+G)**, **Layer ▸ Merge Selected** (→ one pixel layer, TD-rendered). Selection is UI state (not in the document). |
| Flatten button | Every layer row gets a **Flatten** button (next to the lock) that bakes the layer into a plain pixel layer exactly as TD renders it: effects, mask, transform baked; **groups merged** into one pixel layer; **adjustment layers merged down** into the layer below (the adjustment's FX applied to that layer's content only). Undoable; disabled where meaningless (an adjustment with nothing below, an already-plain pixel layer with no effects/mask/transform, input layers). |
| Delete key | **Delete** removes the selected layers only when the key is not aimed at an input/button outside the layer list and no crop box or floating selection is open. With a pixel selection present it does nothing to layers (the engine has no clear op, so pixels are not cleared). |
| Locked layers | Locked layers are skipped by layer delete (key and footer button); if every selected layer is locked it is a no-op with a status message. Input layers (locked by default) stay deletable. |
| Merge across parents | **Merge Selected** across different parents ignores parent opacity and blend and places the result at the topmost selected layer's parent. Merge down is refused into an input layer or another adjustment; into a group it merges the group composite and the result takes the below layer's name. |
| Per-row FX button | Removed. The single Layer Effects button at the bottom of the layer list remains (opens the Effects panel for the active layer). The non-interactive **fx badge** stays on rows that have effects. |
| Adjustments vs FX | **Unified.** The six classic adjustments (Levels, Brightness/Contrast, Hue/Saturation, Blur, Invert, Threshold) become ordinary FX types in the shared filter library (same formulas as today; parity with v6 output). An **adjustment layer is an FX stack applied to everything below** (within its parent), mixed by opacity × mask; its `effects[]` is that stack. One "Add effect / filter" catalogue serves both layer FX and adjustment layers. Old documents migrate automatically: `adjustment: {type:'levels',…}` / `{type:'filter', effect}` → `effects: [...]` on the adjustment layer (+ the layer's former `effects[]` appended after). |

## 2. Model and contract (`web/src/engine/types.ts`)

- Adjustment layers: `kind: 'adjustment'`, `adjustment: null` (new docs), `effects: Effect[]` = the stack applied to the
  accumulated below. `AdjustmentSpec` stays only for reading old documents (migration in `loadDocument`/`parse_doc`).
- Classic adjustment FX types: `levels`, `brightnessContrast`, `hueSaturation`, `invert`, `threshold` (+ existing `blur`
  filter) — parameters as the v2 `AdjustmentSpec` variants (same units/ranges).
- Engine additions: `addAdjustmentLayer(effects, name?)` (selection-limited mask as before; supersedes
  `addAdjustment`/`addFilterAdjustment`, which remain as wrappers), batch ops `deleteLayers(ids)`,
  `setLayersProps(ids, props)`, `moveLayers(ids, parentId, index)`, `groupLayers(ids, name?)`, and
  `replaceLayersWithPixels(ids, rgba, w, h, name?)` (merge/flatten result from TD; one history entry).

## 3. TouchDesigner

- Adjustment layer = `EffectChain` over the accumulated below with the layer's `effects[]` (classic adjustments are now
  chain passes; the old blend-shader adjust modes may remain internally only if bit-identical, else removed).
- Render requests for flatten/merge (served like TOP import: `topReady` + `GET /top`, doc-sized):
  `renderLayer {requestId, layerId, mode: 'flatten'|'mergeDown'}` and `renderLayers {requestId, layerIds}` (isolated
  composite of the given layers in stack order, effects/masks/transforms/blend modes applied, as one group would).

## 4. Validation additions

Migration of v6 docs with adjustment specs → identical TD output and page preview (≤ 1/255 vs v6); classic adjustment FX
parity TD vs page; flatten of each kind and merge-selected equal TD's composite of those layers; multi-select delete/
hide/lock/move/group round trips; group visuals (UI tests + screenshot).

## 5. Engine notes (web/src/engine)

- **Legacy history blobs.** `loadDocument` remembers the layout hash of the *incoming* (pre-migration) spec when it holds a legacy
  `adjustment`; `restoreHistory` accepts a blob signed with either the current or that legacy hash, and the blob's snapshots are
  migrated on read (`adj` -> front of the node's `fx`). This relies on the file spec being byte-identical (key order) to the spec the
  blob was signed from; a re-serialised or edited spec simply fails the signature and history starts empty (restoreHistory = false).
- **Group thumbnails** (compositor scale k < 1) apply the classic point adjustments (JS maths) but skip every other adjustment-layer
  effect (blur, filters): running the GL effects module at document resolution for a thumbnail is not cheap. Thumbnails of groups
  containing a blur adjustment therefore show the unblurred composite.
- **Classic adjustments in the page** run as JS LUT / HSV maths on the canvas (8-bit straight pixels) rather than through the effects
  module (cheaper than a GL round trip). On translucent pixels the unpremultiply rounding differs from the module's float maths by
  up to ~32 straight-channel levels at alpha 8/255, which is about 1 premultiplied unit (test: v7.engine.test.ts, <= 1.5 incl. readout
  rounding). Opaque pixels agree within 1/255.
- `groupLayers` skips recompositing only for a contiguous run of normal-blend layers without adjustment layers; otherwise it redraws.

## 6. v7.1 — layer copy / paste / duplicate

| Topic | Decision |
| --- | --- |
| Copy (Cmd/Ctrl+C, Edit ▸ Copy) | Copies the **selected layers** (multi-select aware; a selected group copies its subtree; a child whose ancestor is selected is not copied twice) into an in-page layer clipboard as a **snapshot** (pixels, masks, effects, text/shape specs, blend/opacity/visibility/lock/transform), so paste works after the source is edited or deleted. TD Input layers are skipped (one layer per input); copying only inputs shows a notice. Also writes a small text marker to the system clipboard when the Clipboard API allows, so a later system image copy can win. Not undoable (no document change). |
| Cut (Cmd/Ctrl+X) | Copy + `deleteLayers` (one undo step), same lock rules as Delete. |
| Paste (Cmd/Ctrl+V, Edit ▸ Paste) | If the system clipboard holds an image newer than our marker (i.e. no marker text, image present) → existing image import. Otherwise, with a non-empty layer clipboard → paste the layers: **into the active group (at its top) when the active layer is a group, else directly below the active layer** in its parent; no active layer → top of the document. Pasted layers keep stack order, get new ids/slots and " copy" names, and become the selection (active = topmost). One undo step. Clipboard read failure (e.g. TD Web Render) → layer clipboard if non-empty, else the old notice. |
| Duplicate (Cmd/Ctrl+J, Layer ▸ Duplicate) | Copy + paste **above** each original's block in one undo step, without touching the layer clipboard. |
| Cmd/Ctrl+drag in the layers panel | Dragging selected rows with Cmd/Ctrl held at drop time **copies** them to the drop position instead of moving (cursor/indicator shows "+ copy"); a Cmd/Ctrl+click without movement still toggles selection. Dropping into a group/ at depth uses the same drop rules as move; illegal targets (into a copied group's own subtree) are fine for copies — the copy lands there, the original is untouched. |
| Keyboard guards | Same as Delete: ignored while typing, in curve editors, during floating selection/crop. Cmd+C/V with a pixel selection still act on layers (pixel copy is not implemented). |
| Engine | `copyLayers(ids): LayerClip` (opaque snapshot) and `pasteLayers(clip, parentId, index): string[]` (one history entry; returns new ids top-first); `duplicateLayers(ids): string[]`. TD sees ordinary new layers/surfaces through the existing doc/surface sync (no protocol change). |

## 7. v7.2 — scrubbable dropdowns and font size

| Topic | Decision |
| --- | --- |
| Dropdown scrub | Every option dropdown (blend mode, font, text align, effect enums, brush presets, …) becomes a shared `ScrubSelect`. Press and drag (≥ 4 px) steps through the options live: **down / right = next, up / left = previous**, one option per 12 px along the dominant axis (clamped at the ends, disabled options skipped). Each step applies immediately (same handler as choosing the option). A press-release without movement opens the list as before; keyboard and wheel-less behaviour unchanged. **Escape** during a drag reverts to the value at press. Cursor `ns-resize`/`ew-resize` while scrubbing; a small tooltip shows the current option. |
| Font size scrub | The font-size box is a `ScrubNumber`: drag **up = larger, down = smaller** (1 pt per 2 px; Shift ×10, Alt ×0.1), clamped to the field range. Every move re-renders the text **live** (rAF-throttled; no debounce / settle). A click without drag focuses the box for typing; typed values also apply live on each valid input. Escape reverts. Reusable for other numeric boxes later. |
| History | One drag = **one undo step** (coalesced by field + layer key, ended on release). |
| TD | No protocol change: live edits flow through the normal doc sync (existing throttling). |
| Implementation | `web/src/ui/Scrub.tsx`: `ScrubSelect` is a drop-in native `<select>` (same props / children / `change` events, so every call site and the keyboard behave as before). The press is taken over (`pointerdown` + `mousedown` preventDefault, pointer capture, touch left native); a release under 4 px calls `select.showPicker()` (Chromium >= 121; TD's Web Render TOP is CEF/Chromium 132 and paints the native popup in the panel), falling back to a small custom listbox (`[data-scrub-list]`, arrows / Enter / Escape) when the engine lacks or refuses it (`data-scrub-opened="native"\|"list"` records which). `ScrubNumber` wraps `<input type=number>` (rAF-throttled live apply, typed values live, Escape reverts). History: `Engine.beginGesture()/endGesture(cancel)` -> `History.beginGroup()/endGroup()` merge every push of a drag into one entry whatever its key or timing (the 1 s coalescing window alone would split a slow drag); a cancelled or net-zero gesture drops its entry. Converted call sites: blend mode (layers panel), font family (text options), effect / filter enum fields (`EnumField`), displace source, selective-colour range, brush preset "save in", swatches palette, zoom; the font-size box is the `ScrubNumber`. Text alignment is a toggle group, not a dropdown. |

## 8. v7.3 — masks on groups and TD input layers

| Topic | Decision |
| --- | --- |
| Input layer masks | Enabled in the UI (Add mask button, Layer ▸ Add mask, mask thumbnail, mask edit mode, enable/disable, delete). The mask is in the **input layer's own space** (size = the input's surface size, follows the layer's move/scale/rotate/skew like a pixel layer's mask). The input stays unpaintable; only its mask is painted. A disconnected input keeps its mask; when the input's resolution changes the mask **keeps its pixels and is stretched to the new input size** (sampled in normalised layer UVs). Effects see the masked content (mask before effects, as for pixel layers). |
| Group masks | A group can have a **document-sized mask** applied to the group's composite **before** the group's effects, matching pixel layers (mask → effects → opacity/blend). Painting/fill/selection-to-mask tools work on it in mask edit mode. Flatten/merge of a group bakes the mask; Merge Selected ignores the parent's mask (as for opacity). Groups with a mask always composite isolated (no merged-run pass-through). Group thumbnails unchanged (folder icon) but the row shows the mask thumbnail. |
| Copy/paste/duplicate | Masks of groups are copied like any mask (a group's subtree carries them). TD Input layers are never copied (one layer per input), so their masks are not copied either. |
| Protocol | **Version 9**: `mask` allowed on `group` and `input` layers (`PROTOCOL.md` §11). Older TD rejects with the existing version-mismatch notice. |
| Validation | Page vs TD parity for: masked input (with transform), masked group (with group effects and a blend-mode child), mask edit painting on both, flatten group with mask, undo. `validate_td.py` step 53. |
