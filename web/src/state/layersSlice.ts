// v7 layer panel state: multi-select (UI only, not in the document), batch actions, Flatten / Merge (docs/DESIGN_V7.md section 1).
import { signal } from '@preact/signals';
import type { LayerClip, LayerInfo } from '../engine/types';
import { layerBelow, topLevelOf } from './layerDrop';
import type { SliceCtx } from './slice';
import { isIdentity } from './transform';

export type FlattenMode = 'flatten' | 'mergeDown';
export interface FlattenInfo {
  mode: FlattenMode;
  /** Tooltip / aria label for this layer kind. */
  title: string;
  enabled: boolean;
  /** Why it is disabled (null when enabled). */
  reason: string | null;
}

/** Shown (and thrown) when the layers, the document or the undo history changed while TouchDesigner rendered. */
export const RENDER_STALE_MESSAGE = 'Layer changed during render — try again';
export const FLATTEN_TITLE = 'Flatten to pixels';
export const MERGE_GROUP_TITLE = 'Merge group';
export const MERGE_DOWN_TITLE = 'Merge down into layer below';

/** Text marker written to the system clipboard by Copy: paste then prefers the layer clipboard over an older system image. */
export const CLIP_MARKER = 'raster-editor-layers';

export function createLayersSlice(ctx: SliceCtx) {
  /** Selected layer ids in click order; the active layer is the last clicked. Pruned when layers disappear. */
  const sel = signal<string[]>([]);
  const flattening = signal<string | null>(null);
  /** v7.1: the one in-page layer clipboard snapshot (engine-owned pixels) and how many top-level layers it holds. */
  let clip: LayerClip | null = null;
  const clipCount = signal(0);
  let markerOk = true; // the system clipboard accepted our marker text (else the layer clipboard wins over any system image)
  let markerSeq = 0;
  let pasteHandledAt = -1e9;
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;
  let anchor: string | null = null;
  let fromPanel = false;

  const equal = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  const api = {
    flattening,
    layerSel: sel,
    /** True while a row click is changing the active layer (the Effects tab must not steal the panel then). */
    get fromPanelClick(): boolean { return fromPanel; },

    /** The selection (display order): the stored set when it contains the active layer, else just the active layer. */
    selectedIds(layersIn?: LayerInfo[], activeIn?: string | null): string[] {
      if (!ctx.hasEngine()) return [];
      const e = ctx.engine(), layers = layersIn ?? e.layers(), active = activeIn !== undefined ? activeIn : e.activeLayerId();
      const set = new Set(sel.value);
      const live = layers.filter((l) => set.has(l.id)).map((l) => l.id);
      if (!active) return live;
      return live.includes(active) ? live : [active];
    },
    isSelected(id: string): boolean { return api.selectedIds().includes(id); },
    /** Called on every structure change: drop vanished layers; a new active layer outside the selection resets it. */
    syncSelection() {
      if (!ctx.hasEngine()) return;
      const e = ctx.engine(), ids = new Set(e.layers().map((l) => l.id)), active = e.activeLayerId();
      let next = sel.peek().filter((id) => ids.has(id));
      if (active && !next.includes(active)) { next = [active]; anchor = active; }
      if (anchor && !ids.has(anchor)) anchor = active;
      if (!equal(next, sel.peek())) sel.value = next;
    },
    /** Click = select one; Shift = range (display order, visible rows) from the last plain click; Cmd/Ctrl = toggle. The clicked layer becomes active. */
    clickLayer(id: string, mods: { shift?: boolean; toggle?: boolean } = {}) {
      if (!ctx.hasEngine()) return;
      const e = ctx.engine(), layers = e.layers();
      if (!layers.some((l) => l.id === id)) return;
      const active = e.activeLayerId();
      const cur = api.selectedIds();
      const ordered = sel.peek().filter((x) => cur.includes(x));
      const stored = ordered.length === cur.length ? ordered : cur;
      let activate = id;
      if (mods.shift) {
        const a = anchor && layers.some((l) => l.id === anchor) ? anchor : active ?? id;
        const i = layers.findIndex((l) => l.id === a), j = layers.findIndex((l) => l.id === id);
        const range = layers.slice(Math.min(i, j), Math.max(i, j) + 1).map((l) => l.id);
        sel.value = [...range.filter((x) => x !== id), id];
      } else if (mods.toggle) {
        anchor = id;
        if (stored.includes(id)) {
          if (stored.length === 1) return;
          const rest = stored.filter((x) => x !== id);
          sel.value = rest;
          if (active !== id) return; // another layer stays active
          activate = rest[rest.length - 1];
        } else {
          sel.value = [...stored.filter((x) => x !== id), id];
        }
      } else {
        anchor = id;
        sel.value = [id];
      }
      fromPanel = true;
      try { e.setActiveLayer(activate); } finally { fromPanel = false; }
    },
    /** Replace the selection (tests, programmatic use); the last id becomes active. */
    selectLayers(ids: string[]) {
      if (!ctx.hasEngine() || !ids.length) return;
      sel.value = ids.slice();
      anchor = ids[ids.length - 1];
      fromPanel = true;
      try { ctx.engine().setActiveLayer(ids[ids.length - 1]); } finally { fromPanel = false; }
    },

    /** Eye / lock click: applies to the whole selection when the clicked row is part of a multi-selection. */
    setLayerFlag(id: string, props: { visible?: boolean; locked?: boolean }) {
      const e = ctx.engine(), ids = api.selectedIds();
      if (ids.length > 1 && ids.includes(id)) e.setLayersProps(ids, props);
      else e.setLayerProps(id, props);
    },
    /** Delete key / footer button: one undo step for the whole selection, no confirmation. */
    deleteSelected() {
      if (!ctx.hasEngine()) return;
      const e = ctx.engine(), layers = e.layers();
      const all = api.selectedIds(layers, e.activeLayerId());
      // locked layers are skipped (input layers are locked by default and stay deletable, v5)
      const ids = all.filter((id) => { const l = layers.find((x) => x.id === id); return l && (!l.locked || l.kind === 'input'); });
      if (!ids.length) { if (all.length) ctx.setNotice(all.length > 1 ? 'The selected layers are locked' : 'The layer is locked'); return; }
      e.deleteLayers(ids);
    },
    canGroupSelected: (): boolean => ctx.hasEngine() && api.selectedIds().length > 0,
    /** Layer ▸ Group Layers (Cmd/Ctrl+G): wraps the selection (stack order kept) in a new group. */
    groupSelected(): string | null {
      if (!ctx.hasEngine()) return null;
      const e = ctx.engine(), ids = topLevelOf(e.layers(), api.selectedIds());
      if (!ids.length) return null;
      const gid = e.groupLayers(ids);
      sel.value = [gid];
      anchor = gid;
      if (e.activeLayerId() !== gid) e.setActiveLayer(gid);
      return gid;
    },

    // ---- v7.1: copy / cut / paste / duplicate (docs/DESIGN_V7.md section 6) ----
    clipCount,
    /** True when the system clipboard could not take our marker text: then the layer clipboard wins over any system image. */
    markerWriteFailed: (): boolean => !markerOk,
    hasLayerClip: (): boolean => clipCount.value > 0,
    /** The selected layers that can be copied: top-level of the selection, TD Input layers excluded. */
    copyableIds(): string[] {
      if (!ctx.hasEngine()) return [];
      const layers = ctx.engine().layers();
      const byId = new Map(layers.map((l) => [l.id, l]));
      return topLevelOf(layers, api.selectedIds(layers)).filter((id) => byId.get(id)?.kind !== 'input');
    },
    canCopySelected: (): boolean => api.copyableIds().length > 0,
    canDuplicateSelected: (): boolean => api.copyableIds().length > 0,
    /** Cut removes what Delete would (locked layers stay) and cannot take input layers along. */
    cuttableIds(): string[] {
      if (!ctx.hasEngine()) return [];
      const byId = new Map(ctx.engine().layers().map((l) => [l.id, l]));
      return api.copyableIds().filter((id) => !byId.get(id)?.locked);
    },
    canCutSelected: (): boolean => api.cuttableIds().length > 0,
    /** Replace the layer clipboard (the previous snapshot's pixels are freed). */
    setLayerClip(next: LayerClip | null) {
      if (clip && ctx.hasEngine()) ctx.engine().releaseClip(clip);
      clip = next && next.count > 0 ? next : null;
      clipCount.value = clip ? clip.count : 0;
    },
    /** Snapshot `ids` into the layer clipboard and leave a marker on the system clipboard. Returns false when nothing was copyable. */
    copyIds(ids: string[], asCut = false): boolean {
      if (!ctx.hasEngine()) return false;
      // The old snapshot is freed BEFORE the new one is built, so the peak is one clip, not two. If the new copy then fails
      // (allocation), the layer clipboard is left empty.
      api.setLayerClip(null);
      const next = ctx.engine().copyLayers(ids, asCut);
      if (next.count === 0) { ctx.engine().releaseClip(next); return false; }
      api.setLayerClip(next);
      markerOk = false;
      try {
        const w = navigator.clipboard?.writeText(`${CLIP_MARKER}:${++markerSeq}`);
        if (w) w.then(() => { markerOk = true; }, () => { markerOk = false; });
      } catch { markerOk = false; }
      return true;
    },
    /** Edit > Copy (Cmd/Ctrl+C). */
    copySelected(): boolean {
      if (!ctx.hasEngine()) return false;
      if (api.copyableIds().length === 0) { if (api.selectedIds().length) ctx.setNotice('Input layers cannot be copied'); return false; }
      return api.copyIds(api.copyableIds());
    },
    /** Edit > Cut (Cmd/Ctrl+X): copy + delete in one undo step; locked layers and input layers stay. */
    cutSelected(): boolean {
      if (!ctx.hasEngine()) return false;
      const ids = api.cuttableIds();
      if (!ids.length) {
        const all = api.selectedIds();
        if (all.length) ctx.setNotice(api.copyableIds().length ? (all.length > 1 ? 'The selected layers are locked' : 'The layer is locked') : 'Input layers cannot be cut');
        return false;
      }
      if (!api.copyIds(ids, true)) return false;
      ctx.engine().deleteLayers(ids);
      return true;
    },
    /** Where Paste lands: into the active group (top), else directly below the active layer in its parent, else the top of the document. */
    pasteTarget(): { parentId: string | null; index: number } {
      const e = ctx.engine(), active = e.activeLayerId();
      if (!active) return { parentId: null, index: 0 };
      const spec = e.docSpec().layers, me = spec.find((l) => l.id === active);
      if (!me) return { parentId: null, index: 0 };
      if (me.kind === 'group') return { parentId: me.id, index: 0 };
      const sibs = spec.filter((l) => l.parentId === me.parentId).reverse(); // top first
      return { parentId: me.parentId, index: sibs.findIndex((l) => l.id === me.id) + 1 };
    },
    /** Paste the layer clipboard. Returns the new top-level ids (topmost first), [] when empty or refused. */
    pasteLayerClip(): string[] {
      if (!ctx.hasEngine() || !clip) return [];
      const e = ctx.engine(), at = api.pasteTarget();
      if (at.parentId) e.setLayerProps(at.parentId, { expanded: true });
      return api.selectNew(e.pasteLayers(clip, at.parentId, at.index));
    },
    /** Make freshly created layers (topmost first) the selection; the topmost is active. */
    selectNew(ids: string[]): string[] {
      if (!ids.length) return ids;
      sel.value = ids.slice().reverse();
      anchor = ids[0];
      const e = ctx.engine();
      if (e.activeLayerId() !== ids[0]) { fromPanel = true; try { e.setActiveLayer(ids[0]); } finally { fromPanel = false; } }
      return ids;
    },
    /** Layer > Duplicate (Cmd/Ctrl+J): copies land above their originals; the layer clipboard is untouched. */
    duplicateSelected(): string[] {
      if (!ctx.hasEngine()) return [];
      const ids = api.copyableIds();
      if (!ids.length) { if (api.selectedIds().length) ctx.setNotice('Input layers cannot be duplicated'); return []; }
      return api.selectNew(ctx.engine().duplicateLayers(ids));
    },
    /** Cmd/Ctrl+drag in the layers panel: copies `ids` to the drop position (the layer clipboard is untouched). */
    copyLayersTo(ids: string[], parentId: string | null, index: number): string[] {
      if (!ctx.hasEngine()) return [];
      const e = ctx.engine(), c = e.copyLayers(ids);
      try {
        if (c.count === 0) { ctx.setNotice('Input layers cannot be copied'); return []; }
        if (parentId) e.setLayerProps(parentId, { expanded: true });
        return api.selectNew(e.pasteLayers(c, parentId, index));
      } finally { e.releaseClip(c); }
    },
    /**
     * The keyboard fallback stamps its paste here; a paste event arriving within 500 ms after it (a late event for the same key press) must
     * do nothing. The paste event itself cancels the pending fallback, so only fallback-then-event needs deduplicating; two real pastes in a
     * row are never merged.
     */
    claimPaste(): boolean { pasteHandledAt = Date.now(); return true; },
    pasteRecentlyHandled: (): boolean => Date.now() - pasteHandledAt < 500,
    /**
     * Keyboard paste fallback: the paste event normally handles Cmd/Ctrl+V and runs before this 0 ms timer; forwarded keys (TouchDesigner) never fire
     * one, so the layers are pasted when the timer fires. `allowed` re-checks every guard at that moment (state may have changed since keydown).
     */
    armPasteFallback(allowed: () => boolean) {
      if (!clip) return;
      if (pasteTimer) clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        pasteTimer = null;
        try { if (clip && allowed() && api.claimPaste()) api.pasteLayerClip(); } catch (err) { ctx.setNotice(`Paste failed: ${err instanceof Error ? err.message : String(err)}`); }
      }, 0);
    },
    cancelPasteFallback() { if (pasteTimer) { clearTimeout(pasteTimer); pasteTimer = null; } },
    /** Move the dragged row (or the whole selection when the row belongs to a multi-selection). */
    dragIds(dragId: string): string[] {
      const ids = api.selectedIds();
      return ids.length > 1 && ids.includes(dragId) ? topLevelOf(ctx.engine().layers(), ids) : [dragId];
    },

    // ---- Merge Selected ----
    mergeBlock(): string | null {
      if (!ctx.hasEngine()) return 'No layers';
      if (api.selectedIds().length < 2) return 'Select two or more layers to merge';
      const b = ctx.bridge();
      if (!ctx.linked() || !b?.renderLayers) return 'Merge needs TouchDesigner';
      if (flattening.value !== null) return 'Another merge is running';
      return null;
    },
    canMergeSelected: (): boolean => api.mergeBlock() === null,
    async mergeSelected(): Promise<boolean> {
      const why = api.mergeBlock();
      if (why) { if (ctx.hasEngine() && api.selectedIds().length >= 2) ctx.setNotice(why === 'Merge needs TouchDesigner' ? 'Merge needs a TouchDesigner connection' : why); return false; }
      const e = ctx.engine(), ids = topLevelOf(e.layers(), api.selectedIds());
      flattening.value = '#merge';
      try {
        await ctx.bridge()!.renderLayers!(ids);
        return true;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.setNotice(m === RENDER_STALE_MESSAGE ? m : `Merge failed: ${m}`);
        return false;
      } finally {
        flattening.value = null;
      }
    },

    // ---- Flatten (per row) ----
    /** Button state for a layer row. `childCount` (groups) saves a document scan when the caller has it. */
    flattenInfo(l: LayerInfo | undefined, layers?: LayerInfo[], childCount?: number): FlattenInfo {
      if (!l) return { mode: 'flatten', title: FLATTEN_TITLE, enabled: false, reason: 'No layer' };
      const all = layers ?? (ctx.hasEngine() ? ctx.engine().layers() : []);
      const adj = l.kind === 'adjustment', group = l.kind === 'group';
      const title = adj ? MERGE_DOWN_TITLE : group ? MERGE_GROUP_TITLE : FLATTEN_TITLE;
      const mode: FlattenMode = adj ? 'mergeDown' : 'flatten';
      let reason: string | null = null;
      if (l.kind === 'input') reason = 'Input layers cannot be flattened';
      else if (adj && !layerBelow(all, l.id)) reason = 'Nothing below to merge into';
      else if (adj && layerBelow(all, l.id)!.kind === 'input') reason = 'Cannot merge down into an input layer';
      else if (adj && layerBelow(all, l.id)!.kind === 'adjustment') reason = 'Cannot merge down into another adjustment';
      else if (group && (childCount ?? (ctx.hasEngine() ? ctx.engine().docSpec().layers.filter((x) => x.parentId === l.id).length : 0)) === 0) reason = 'The group is empty';
      else if (l.kind === 'pixel' && !l.effects.length && !l.mask && isIdentity(l.transform)) reason = 'Already a plain pixel layer';
      return { mode, title, enabled: reason === null && api.flattenAvailable(), reason };
    },
    /** TouchDesigner is linked and idle. */
    flattenAvailable(): boolean { return ctx.linked() && !!ctx.bridge()?.renderLayer && flattening.value === null; },
    /** The tooltip: the kind's title, plus what is missing when there is no TouchDesigner. */
    flattenTooltip(l: LayerInfo | undefined, info: FlattenInfo = api.flattenInfo(l)): string {
      return !ctx.linked() || !ctx.bridge()?.renderLayer ? `${info.title} (needs TouchDesigner)` : info.title;
    },
    canFlatten(l: LayerInfo | undefined): boolean { return api.flattenInfo(l).enabled; },
    flattenTitle(l?: LayerInfo): string { return api.flattenTooltip(l); },
    async flattenLayer(id: string): Promise<boolean> {
      if (!ctx.hasEngine()) return false;
      const l = ctx.engine().layers().find((x) => x.id === id);
      if (!l) return false;
      const info = api.flattenInfo(l);
      if (!ctx.linked() || !ctx.bridge()?.renderLayer) { ctx.setNotice('Flatten needs a TouchDesigner connection'); return false; }
      if (!info.enabled) return false;
      flattening.value = id;
      try {
        await ctx.bridge()!.renderLayer!(id, info.mode);
        return true;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.setNotice(m === RENDER_STALE_MESSAGE ? m : `Flatten failed: ${m}`);
        return false;
      } finally {
        flattening.value = null;
      }
    },
  };
  return api;
}
