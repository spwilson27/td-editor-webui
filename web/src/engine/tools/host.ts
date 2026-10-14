import type { EngineEvent, Rect, RGBA, ToolContext, ToolPointer } from '../types';
import type { Document, EditTarget, PixelLayer, StructureSnapshot } from '../model';
import type { Surface } from '../surface';
import type { Patch } from '../tiles';

export interface Tool {
  down(p: ToolPointer): void;
  move(p: ToolPointer): void;
  up(p: ToolPointer): void;
}

/** Document-sized reusable surfaces shared by tools. */
export interface Scratch {
  stroke: Surface; // dabs of the stroke in progress, document space
  backup: Surface; // pre-edit pixels of the tiles an edit touched, layer space (see TileBackup)
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
  /** Active pixel layer for the move tool; otherwise emits a notice and returns null. */
  movableLayer(): PixelLayer | null;
  /** Document-space rect changed: recomposite and notify. */
  changed(r: Rect): void;
  /** Pixels of `target` changed inside the document-space rect: recomposite and emit 'pixels' + 'surface'. */
  paintChanged(target: EditTarget, docRect: Rect): void;
  /** A layer offset changed (docSpec may differ): emits 'docspec' when it does. */
  docMoved(): void;
  /** Record a pixel edit as layer-space patches holding old and new pixels. */
  pushPatch(label: string, target: EditTarget, patches: Patch[]): void;
  /** Record a structural edit that was already applied since `before`. */
  commitStructure(label: string, before: StructureSnapshot, coalesceKey?: string, dirty?: Rect | null | false): void;
  sample(x: number, y: number): RGBA | null;
}
