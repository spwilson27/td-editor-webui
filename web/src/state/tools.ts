import type { BlendMode, BrushSettings, ShapeType, ToolId } from '../engine/types';

export interface ToolInfo {
  id: ToolId; name: string; key: string; hint: string; d: string; sep?: boolean; enabled: boolean;
}

export const TOOLS: ToolInfo[] = [
  { id: 'move', name: 'Move Tool', key: 'V', enabled: true, hint: 'Drag to move the selected layer. Shift constrains to axis.', d: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3' },
  { id: 'marquee', name: 'Rectangular Marquee', key: 'M', sep: true, enabled: true, hint: 'Drag to select. Ctrl+D deselects.', d: 'M4 4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M4 7V4' },
  { id: 'lasso', name: 'Freehand Selection', key: 'L', enabled: true, hint: 'Drag to draw a freehand selection. Release to close. Shift adds, Alt subtracts.', d: 'M12 4c5 0 8 2.5 8 5.5S16.5 15 12 15 4 12.5 4 9.5 7 4 12 4zM7 14c-1 2 0 4 2 4s2 2 1 3' },
  { id: 'wand', name: 'Flood Select', key: 'W', enabled: true, hint: 'Click to select similar colours. Shift adds, Alt subtracts, Shift+Alt intersects.', d: 'M4 20L15 9M14 3v2M20 9h-2M18.5 4.5L17 6M9.5 4.5l1 1M18.5 13.5l-1-1' },
  { id: 'crop', name: 'Crop Tool', key: 'C', enabled: false, hint: 'Drag handles to crop. Enter to apply.', d: 'M6 2v16h16M2 6h16v16' },
  { id: 'brush', name: 'Paint Brush', key: 'B', sep: true, enabled: true, hint: 'Drag to paint. Alt picks a colour. [ ] resize.', d: 'M18 3l3 3-9 9-3-3 9-9zM9 12c-3 0-5 2-5 5 0 1.5-1 3-2 3 4 1 9 0 9-5' },
  { id: 'pencil', name: 'Pixel Tool', key: 'N', enabled: true, hint: 'Drag to paint hard-edged pixels.', d: 'M16 3l5 5L8 21H3v-5L16 3zM13 6l5 5' },
  { id: 'eraser', name: 'Erase Brush', key: 'E', enabled: true, hint: 'Drag to erase to transparency.', d: 'M15 4l5 5-10 10H6l-3-3L15 4zM9 10l5 5M10 20h11' },
  { id: 'fill', name: 'Flood Fill', key: 'G', enabled: true, hint: 'Click to fill similar colours with the primary colour.', d: 'M5 11l7-7 8 8-7 7a2 2 0 01-3 0l-5-5a2 2 0 010-3zM5 12h15M20 16c0 1.5 1 2.5 1 3.5a1 1 0 01-2 0c0-1 1-2 1-3.5' },
  { id: 'gradient', name: 'Gradient Tool', key: 'G', enabled: true, hint: 'Drag to draw a gradient from primary to secondary.', d: 'M4 4h16v16H4zM8 16l8-8' },
  { id: 'clone', name: 'Clone Brush', key: 'S', enabled: false, hint: 'Alt-click to set the source, then drag to paint.', d: 'M9 3h6v5l-1 3h4v4H6v-4h4L9 8zM5 21h14' },
  { id: 'smudge', name: 'Smudge Brush', key: 'R', enabled: false, hint: 'Drag to push and blend pixels.', d: 'M9 11V5a2 2 0 014 0v6M13 10a2 2 0 014 0v2M17 12a2 2 0 014 0v3a6 6 0 01-6 6h-2a6 6 0 01-5-3l-3-5a2 2 0 013-2l2 2' },
  { id: 'text', name: 'Text Tool', key: 'T', sep: true, enabled: true, hint: 'Click to place text, or click a text layer to edit it. Esc commits.', d: 'M5 5h14M12 5v14M9 19h6' },
  { id: 'shape', name: 'Shape Tool', key: 'U', enabled: true, hint: 'Drag to draw a shape layer. Shift constrains. Click the corner for more shapes.', d: 'M4 4h9v9H4zM11 16a5 5 0 1010 0 5 5 0 10-10 0' },
  { id: 'picker', name: 'Colour Picker', key: 'I', enabled: true, hint: 'Click to sample a colour into the primary swatch.', d: 'M14 4l6 6M17 7L7 17l-3 1 1-3L15 5' },
  { id: 'hand', name: 'View Tool', key: 'H', sep: true, enabled: true, hint: 'Drag to pan. Hold Space with any tool.', d: 'M8 13V5a1.5 1.5 0 013 0v6M11 10V3.5a1.5 1.5 0 013 0V10M14 10V5a1.5 1.5 0 013 0v6M17 9a1.5 1.5 0 013 0v5a7 7 0 01-7 7h-1a7 7 0 01-6-3l-3-5a1.5 1.5 0 012.5-1.5L8 14' },
  { id: 'zoom', name: 'Zoom Tool', key: 'Z', enabled: true, hint: 'Click to zoom in, Alt-click to zoom out.', d: 'M10 3a7 7 0 100 14 7 7 0 000-14zM15 15l6 6M7 10h6M10 7v6' },
];

export const toolInfo = (id: ToolId): ToolInfo => TOOLS.find((t) => t.id === id) || TOOLS[0];
export const PAINT_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['brush', 'pencil', 'eraser', 'clone', 'smudge']);

export const MODES = [
  { id: 'paint', label: 'Paint', enabled: true, d: 'M18 3l3 3-9 9-3-3 9-9zM9 12c-3 0-5 2-5 5 0 1.5-1 3-2 3 4 1 9 0 9-5' },
  { id: 'adjust', label: 'Adjust', enabled: false, d: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4' },
  { id: 'export', label: 'Output', enabled: false, d: 'M12 3v12M7 10l5 5 5-5M4 19h16' },
];

export const PALETTE = ['#1b1b1b', '#3a3a3a', '#6b6b6b', '#9e9e9e', '#cfcfcf', '#ffffff', '#f4efe6', '#e8d9b5',
  '#7a2e1f', '#b4472c', '#e2683c', '#f0955a', '#f4c04e', '#f7dc8a', '#c9b458', '#8a7a2e',
  '#1f3d2a', '#2f6b3a', '#4b7843', '#6c9a5c', '#9cc08a', '#3d9a8f', '#2a6f7a', '#1d4a5e',
  '#1f2d5c', '#3d6fb4', '#6f9bd6', '#9cc3e4', '#5b3f8c', '#8b6cc0', '#b85c8c', '#e39ab8'];

export const GREYS = Array.from({ length: 16 }, (_, i) => {
  const v = Math.round((i / 15) * 255).toString(16).padStart(2, '0');
  return '#' + v + v + v;
});

export interface BrushPreset extends Omit<BrushSettings, 'spacing'> { id: string; name: string; sw: number; op: number }
export const BRUSHES: BrushPreset[] = [
  { id: 'round', name: 'Round — soft', size: 64, opacity: 1, flow: 0.72, hardness: 0.4, sw: 6, op: 0.55 },
  { id: 'hard', name: 'Round — hard', size: 24, opacity: 1, flow: 1, hardness: 1, sw: 4, op: 1 },
  { id: 'ink', name: 'Ink pen', size: 8, opacity: 1, flow: 1, hardness: 1, sw: 2, op: 1 },
  { id: 'chalk', name: 'Dry chalk', size: 48, opacity: 0.8, flow: 0.4, hardness: 0.6, sw: 7, op: 0.4 },
  { id: 'gouache', name: 'Gouache', size: 96, opacity: 0.9, flow: 0.8, hardness: 0.7, sw: 9, op: 0.8 },
  { id: 'airbrush', name: 'Airbrush', size: 200, opacity: 1, flow: 0.25, hardness: 0, sw: 12, op: 0.25 },
];

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', 'soft-light': 'Soft Light',
  'hard-light': 'Hard Light', darken: 'Darken', lighten: 'Lighten', 'color-dodge': 'Colour Dodge',
  'color-burn': 'Colour Burn', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue',
  saturation: 'Saturation', color: 'Colour', luminosity: 'Luminosity',
};
export const BLEND_MODES = Object.keys(BLEND_LABELS) as BlendMode[];

export const RECENT_DEFAULT = ['#e2683c', '#f4c04e', '#2f6b3a', '#9cc3e4', '#4b7843', '#3d6fb4', '#f4efe6', '#1b1b1b', '#b85c8c', '#6c9a5c', '#ffffff', '#7a2e1f'];

export interface ShapeKind { id: ShapeType; name: string; d: string }
export const SHAPE_KINDS: ShapeKind[] = [
  { id: 'rect', name: 'Rectangle', d: 'M4 6h16v12H4z' },
  { id: 'ellipse', name: 'Ellipse', d: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z' },
  { id: 'line', name: 'Line / Arrow', d: 'M5 19L19 5M19 5h-6M19 5v6' },
  { id: 'polygon', name: 'Polygon / Star', d: 'M12 3l2.6 6 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.2 1.4-6.3L3 9.6 9.4 9z' },
];
export const shapeKind = (id: ShapeType): ShapeKind => SHAPE_KINDS.find((k) => k.id === id) || SHAPE_KINDS[0];

/** Built-in font families offered when no TouchDesigner font list is available. */
export const FALLBACK_FONTS = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact'];
