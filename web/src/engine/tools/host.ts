import type { EngineEvent, Rect, RGBA, SelectionOptions, ShapeSpec, TextSpec, ToolContext, ToolPointer } from '../types';
import type { Document, EditTarget, PixelLayer, StructureSnapshot, VectorLayer } from '../model';
import type { SelState } from '../selection';
import type { Surface } from '../surface';
import type { Patch } from '../tiles';

export interface Tool {
  down(p: ToolPointer): void;
  move(p: ToolPointer): void;
  up(p: ToolPointer): void;
}

/** Reusable surfaces shared by tools. (Stroke buffers and undo backups are per-edit and sized to the touched area.) */
export interface Scratch {
  stamp: Surface; // brush tip
}

/** What tools may use of the engine. */
export interface Host {
  readonly doc: Document;
  readonly scratch: Scratch;
  context(): ToolContext;
  emit(e: EngineEvent): void;
  /** What the paint tools edit now (pixels or mask of the active layer); otherwise emits a notice and returns null. */
  editableLayer(): EditTarget | null;
  /** Active pixel / text / shape layer for the move tool (the base layer is movable although locked); otherwise emits a notice and returns null. */
  movableLayer(): PixelLayer | VectorLayer | null;
  /** v4: snapping for the move tool: offset to add to a candidate document rect (zero when snapping is off). */
  snapMove(r: Rect, exclude: string): { dx: number; dy: number };
  /** Document-space rect changed: recomposite and notify. */
  changed(r: Rect): void;
  /** Pixels of `target` changed inside the layer-space rect `layerRect`: recomposite (mapped through the transform) and emit 'pixels' + 'surface'. */
  paintChanged(target: EditTarget, layerRect: Rect): void;
  /** A layer offset / spec changed (docSpec may differ): emits 'docspec' when it does. */
  docMoved(): void;
  /** Record a pixel edit as layer-space patches holding old and new pixels. */
  pushPatch(label: string, target: EditTarget, patches: Patch[]): void;
  /** Record a structural edit that was already applied since `before`. */
  commitStructure(label: string, before: StructureSnapshot, coalesceKey?: string, dirty?: Rect | null | false): void;
  sample(x: number, y: number): RGBA | null;

  // v3 selection
  selectionOptions(): SelectionOptions;
  selectionState(): SelState;
  /** Change the selection live (emits 'selection', no history). */
  previewSelection(s: SelState): void;
  /** Push one history entry from `before` to the current selection (no-op when unchanged). */
  commitSelection(label: string, before: SelState): void;
  /** Coverage of the current selection when it is not a plain rect (document-sized, read-only); else null. */
  selectionAlpha(): Uint8Array | null;
  /** Document-sized canvas whose alpha is the selection coverage; null when there is no selection or it is a plain rect. */
  selectionCanvas(): Surface | null;
  /** Grow-only scratch canvas of at least w x h (contents undefined, identity transform). One user at a time. */
  tempWindow(w: number, h: number): Surface;
  /** Document-sized straight RGBA for the wand: the active layer mapped through its transform, or the composite. */
  wandSource(sampleAll: boolean): Uint8ClampedArray | null;

  // v3 text / shape
  /** Set a text / shape layer's spec live: rerender (rasterized), recomposite, emit; no history. */
  respec(layer: VectorLayer, spec: TextSpec | ShapeSpec): void;
}
