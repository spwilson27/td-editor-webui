// Shared engine contract. UI, state and bridge code depend only on these shapes and on
// the EditorEngine interface; the engine implements them. Change with care: it is the
// boundary between parallel workstreams (see docs/DESIGN.md §3).

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'hard-light'
  | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

export interface Rect { x: number; y: number; w: number; h: number }

export type LayerKind = 'pixel' | 'group' | 'base';

/** Read-only view of a layer for the UI. Thumbnails are drawn via EditorEngine.drawThumbnail. */
export interface LayerInfo {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blend: BlendMode;
  depth: number; // 0 = top level
  expanded?: boolean; // groups only
  parentId: string | null;
}

export type ToolId =
  | 'move' | 'marquee' | 'lasso' | 'wand' | 'crop' | 'brush' | 'pencil' | 'eraser'
  | 'fill' | 'gradient' | 'clone' | 'smudge' | 'text' | 'shape' | 'picker' | 'hand' | 'zoom';

export interface ToolPointer {
  x: number; // document px (float)
  y: number;
  pressure: number; // 0..1, mouse normalised to 1
  shift: boolean;
  alt: boolean;
  ctrl: boolean; // ctrl or cmd
}

export interface BrushSettings {
  size: number; // diameter px, 1..1000
  opacity: number; // 0..1, per stroke
  flow: number; // 0..1, per dab
  hardness: number; // 0..1
  spacing: number; // fraction of diameter, default 0.15
}

/** Colours are straight-alpha RGBA, components 0..255. */
export interface RGBA { r: number; g: number; b: number; a: number }

export interface ToolContext {
  primary: RGBA;
  secondary: RGBA;
  brush: BrushSettings;
  fillTolerance: number; // 0..255
}

export interface HistoryEntry { id: number; label: string }

export type EngineEvent =
  | { type: 'structure' } // layers added/removed/reordered/renamed/props changed, active layer changed
  | { type: 'pixels'; rect: Rect } // document pixels changed inside rect (composite pending)
  | { type: 'composite'; rect: Rect } // composite surface updated inside rect
  | { type: 'selection' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'history' }
  | { type: 'pick'; color: RGBA } // picker tool sampled a colour
  | { type: 'notice'; message: string }; // e.g. "Layer is locked"

export interface EditorEngine {
  readonly width: number;
  readonly height: number;

  on(listener: (e: EngineEvent) => void): () => void;

  // Document
  resize(width: number, height: number): void; // anchors top-left, clears history
  layers(): LayerInfo[]; // display order: top first, children after their group when expanded
  activeLayerId(): string | null;
  setActiveLayer(id: string): void;
  addPixelLayer(name?: string): string; // above the active layer
  addGroup(name?: string): string;
  deleteLayer(id: string): void; // base layer cannot be deleted
  moveLayer(id: string, targetParentId: string | null, index: number): void; // index within parent, 0 = top
  setLayerProps(id: string, props: Partial<Pick<LayerInfo, 'name' | 'visible' | 'locked' | 'opacity' | 'blend' | 'expanded'>>): void;
  flattenToNewLayer(): string;
  drawThumbnail(id: string, target: HTMLCanvasElement): void;

  // Base layer from TouchDesigner: straight RGBA8 rows, top-left origin. Records no history.
  writeBase(rect: Rect, rgba: Uint8Array | Uint8ClampedArray): void;
  commitBase(): void; // publish after FRAME_END

  // Composite output
  readComposite(rect: Rect, out?: Uint8ClampedArray): Uint8ClampedArray; // straight RGBA8
  compositeSource(): CanvasImageSource; // for the viewport to draw

  // Selection
  selection(): Rect | null;
  setSelection(rect: Rect | null): void;

  // Tools
  setTool(id: ToolId): void;
  setToolContext(ctx: ToolContext): void;
  pointerDown(p: ToolPointer): void;
  pointerMove(p: ToolPointer): void;
  pointerUp(p: ToolPointer): void;

  // History
  undo(): void;
  redo(): void;
  history(): { entries: HistoryEntry[]; index: number }; // index = last applied entry
  jumpTo(index: number): void;
  clearHistory(): void; // drop all undo/redo entries (document setup)

  dispose(): void;
}
