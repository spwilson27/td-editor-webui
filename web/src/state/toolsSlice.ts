// v5 tool state: clone / retouch options, crop box, quick mask, floating selection (Transform Selection), selection ops.
import { signal } from '@preact/signals';
import type { CloneOptions, DodgeBurnRange, Rect } from '../engine/types';
import type { SliceCtx } from './slice';

export type SelectionOp = 'grow' | 'shrink' | 'smooth' | 'feather' | 'border';
export interface RetouchOptions { strength: number; sharpen: boolean; burn: boolean; range: DodgeBurnRange; exposure: number }

/** Intersect `r` with the canvas, at least 1×1. */
export function clampCrop(r: Rect, cw: number, ch: number): Rect {
  const x0 = Math.min(Math.max(0, Math.min(r.x, r.x + r.w)), cw - 1), y0 = Math.min(Math.max(0, Math.min(r.y, r.y + r.h)), ch - 1);
  const x1 = Math.max(x0 + 1, Math.min(cw, Math.max(r.x, r.x + r.w))), y1 = Math.max(y0 + 1, Math.min(ch, Math.max(r.y, r.y + r.h)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function createToolsSlice(ctx: SliceCtx) {
  const cloneOpts = signal<CloneOptions>({ aligned: true, sampleAll: false });
  const retouch = signal<RetouchOptions>({ strength: 0.5, sharpen: false, burn: false, range: 'midtones', exposure: 0.5 });
  /** Crop tool box in doc px (null = none drawn yet). */
  const cropBox = signal<Rect | null>(null);
  /** Select ▸ Grow / Shrink / Smooth / Feather / Border… dialog (null = closed). */
  const selOpDialog = signal<SelectionOp | null>(null);
  /** Bumped when floating selection / quick mask state may have changed (engine 'selection' events do not say). */
  const floatVersion = signal(0);
  /** Set by beginTransformSelection(); the viewport (or keyboard) answers it by switching to the Move tool. */
  const wantMove = signal(false);
  let floatLayer: string | null = null;
  /** True only while liftSelection() runs: its synchronous events must not make syncTool commit the fresh lift. */
  let lifting = false;
  return {
    cloneOpts, retouch, cropBox, selOpDialog, floatVersion, wantMove,
    setCloneOpts(p: Partial<CloneOptions>) { cloneOpts.value = { ...cloneOpts.peek(), ...p }; if (ctx.hasEngine()) ctx.engine().setCloneOptions(cloneOpts.peek()); },
    setRetouch(p: Partial<RetouchOptions>) { retouch.value = { ...retouch.peek(), ...p }; if (ctx.hasEngine()) ctx.engine().setRetouchOptions(retouch.peek()); },
    // Quick Mask (Q)
    quickMaskOn(): boolean { return ctx.hasEngine() && ctx.engine().quickMask(); },
    toggleQuickMask() { if (ctx.hasEngine()) { const e = ctx.engine(); e.setQuickMask(!e.quickMask()); floatVersion.value++; } },
    // Select ▸ Grow / Shrink / …
    openSelectionOp(op: SelectionOp) { if (ctx.hasEngine() && ctx.engine().selection()) selOpDialog.value = op; },
    applySelectionOp(op: SelectionOp, px: number) { selOpDialog.value = null; if (ctx.hasEngine() && px >= 0) ctx.engine().modifySelection(op, px); },
    canModifySelection(): boolean { return ctx.hasEngine() && !!ctx.engine().selection(); },
    // Transform Selection (Select ▸ Transform Selection, Ctrl+T with a selection)
    canTransformSelection(): boolean {
      if (!ctx.hasEngine()) return false;
      const l = ctx.activeLayer();
      return !!ctx.engine().selection() && !!l && l.kind === 'pixel' && !l.locked && !ctx.engine().floating();
    },
    beginTransformSelection(): boolean {
      if (!ctx.hasEngine()) return false;
      const e = ctx.engine();
      if (e.floating()) return true;
      // liftSelection() emits its events synchronously; the viewport's syncTool (tool still != move) must not commit the fresh
      // lift, so a non-reactive guard covers the call. wantMove (reactive: the viewport switches to Move on it) is only set on
      // success, so a failed lift leaves the tool alone.
      lifting = true;
      let ok = false;
      try { ok = e.liftSelection(); } finally { lifting = false; }
      if (!ok) { ctx.setNotice('Nothing to transform'); return false; }
      wantMove.value = true;
      floatLayer = e.activeLayerId();
      cropBox.value = null;
      floatVersion.value++;
      return true;
    },
    /** Tool / layer / crop housekeeping, run by the viewport on tool or structure changes: a floating selection is committed
     *  when leaving the Move tool or changing layer, and the crop box is dropped when leaving the Crop tool. */
    syncTool(tool: string) {
      if (tool !== 'crop' && cropBox.peek()) cropBox.value = null;
      if (!ctx.hasEngine() || wantMove.peek() || lifting) return;
      const e = ctx.engine();
      if (!e.floating()) { floatLayer = null; return; }
      const id = e.activeLayerId();
      if (floatLayer === null) floatLayer = id;
      if (tool !== 'move' || id !== floatLayer) { floatLayer = null; e.commitFloating(); floatVersion.value++; }
    },
    /** Crop box edit in doc px, clamped to the canvas (min 1 px). null drops it. */
    setCropBox(r: Rect | null) {
      if (!r || !ctx.hasEngine()) { cropBox.value = null; return; }
      cropBox.value = clampCrop(r, ctx.engine().width, ctx.engine().height);
    },
    isFloating(): boolean { return ctx.hasEngine() && ctx.engine().floating() !== null; },
    commitFloating() { floatLayer = null; if (ctx.hasEngine()) { ctx.engine().commitFloating(); floatVersion.value++; } },
    cancelFloating() { floatLayer = null; if (ctx.hasEngine()) { ctx.engine().cancelFloating(); floatVersion.value++; } },
    /** Crop tool: apply the box (integer rect clamped to the canvas) / cancel. */
    applyCrop(): boolean {
      const b = cropBox.peek();
      if (!b || !ctx.hasEngine()) return false;
      const e = ctx.engine();
      const x0 = Math.max(0, Math.round(b.x)), y0 = Math.max(0, Math.round(b.y));
      const x1 = Math.min(e.width, Math.round(b.x + b.w)), y1 = Math.min(e.height, Math.round(b.y + b.h));
      cropBox.value = null;
      if (x1 - x0 < 1 || y1 - y0 < 1) return false;
      e.cropTo({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      return true;
    },
    cancelCrop() { cropBox.value = null; },
  };
}
