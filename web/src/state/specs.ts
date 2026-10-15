import type { RGBA, ShapeSpec, ShapeType, TextSpec } from '../engine/types';

/** Context-bar settings of the text tool (colour = primary colour). */
export interface TextOptions {
  font: string; size: number; bold: boolean; italic: boolean; align: 'left' | 'center' | 'right'; lineHeight: number;
}
/** Context-bar settings of the shape tool (fill colour = primary, stroke colour = secondary). */
export interface ShapeOptions {
  type: ShapeType; fillOn: boolean; strokeOn: boolean; strokeWidth: number; radius: number;
  sides: number; innerRatio: number; arrowStart: boolean; arrowEnd: boolean;
}

export const DEFAULT_TEXT_OPTIONS: TextOptions = { font: 'Arial', size: 64, bold: false, italic: false, align: 'left', lineHeight: 1.2 };
export const DEFAULT_SHAPE_OPTIONS: ShapeOptions = {
  type: 'rect', fillOn: true, strokeOn: false, strokeWidth: 4, radius: 0, sides: 5, innerRatio: 1, arrowStart: false, arrowEnd: true,
};

export function newTextSpec(o: TextOptions, color: RGBA, x: number, y: number, text = ''): TextSpec {
  return { text, font: o.font, size: o.size, color, align: o.align, bold: o.bold, italic: o.italic, lineHeight: o.lineHeight, x: Math.round(x), y: Math.round(y), boxWidth: null };
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/** Shape from a drag (a line has one colour: the primary, passed as `fill`) (document px). Shift constrains: square / circle / 45 degree line. */
export function shapeFromDrag(o: ShapeOptions, fill: RGBA, stroke: RGBA, b: Bounds, shift: boolean): ShapeSpec | null {
  let { x0, y0, x1, y1 } = b;
  let dx = x1 - x0, dy = y1 - y0;
  if (Math.hypot(dx, dy) < 2) return null;
  const f = { enabled: o.fillOn, color: fill };
  const st = { enabled: o.strokeOn, color: stroke, width: o.strokeWidth };
  switch (o.type) {
    case 'rect':
    case 'ellipse': {
      if (shift) {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m;
        x1 = x0 + dx; y1 = y0 + dy;
      }
      const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.max(1, Math.abs(x1 - x0)), h = Math.max(1, Math.abs(y1 - y0));
      const base = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), fill: f, stroke: st, rotation: 0 };
      return o.type === 'rect' ? { type: 'rect', ...base, radius: o.radius } : { type: 'ellipse', ...base };
    }
    case 'line': {
      if (shift) {
        const step = Math.PI / 4, ang = Math.round(Math.atan2(dy, dx) / step) * step, len = Math.hypot(dx, dy);
        x1 = x0 + Math.cos(ang) * len; y1 = y0 + Math.sin(ang) * len;
      }
      return {
        type: 'line', x1: Math.round(x0), y1: Math.round(y0), x2: Math.round(x1), y2: Math.round(y1),
        stroke: { enabled: true, color: fill, width: Math.max(1, o.strokeWidth) }, arrowStart: o.arrowStart, arrowEnd: o.arrowEnd,
      };
    }
    case 'polygon':
      return {
        type: 'polygon', cx: Math.round(x0), cy: Math.round(y0), radius: Math.max(1, Math.round(Math.hypot(dx, dy))),
        sides: o.sides, innerRatio: o.innerRatio, fill: f, stroke: st, rotation: 0,
      };
  }
}

/** Outline points of a shape (document px) for the drag preview. */
export function shapePreviewPath(s: ShapeSpec): Array<Array<{ x: number; y: number }>> {
  switch (s.type) {
    case 'rect': return [[{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y }, { x: s.x + s.w, y: s.y + s.h }, { x: s.x, y: s.y + s.h }]];
    case 'ellipse': {
      const pts = [];
      for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push({ x: s.x + s.w / 2 + Math.cos(a) * s.w / 2, y: s.y + s.h / 2 + Math.sin(a) * s.h / 2 }); }
      return [pts];
    }
    case 'line': return [[{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]];
    case 'polygon': {
      const pts = [], n = s.sides * (s.innerRatio < 1 ? 2 : 1);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + s.rotation + (i / n) * Math.PI * 2;
        const r = s.innerRatio < 1 && i % 2 === 1 ? s.radius * s.innerRatio : s.radius;
        pts.push({ x: s.cx + Math.cos(a) * r, y: s.cy + Math.sin(a) * r });
      }
      return [pts];
    }
  }
}

/** Complete specs for programmatic callers (test hook); `over` is a shallow override. */
export function completeTextSpec(over: Partial<TextSpec> = {}): TextSpec {
  return { text: 'Text', font: 'Arial', size: 64, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: false, italic: false, lineHeight: 1.2, x: 0, y: 0, boxWidth: null, ...over };
}
export function completeShapeSpec(over: Partial<ShapeSpec> & { type: ShapeType }): ShapeSpec {
  const fill = { enabled: true, color: { r: 226, g: 104, b: 60, a: 255 } };
  const stroke = { enabled: false, color: { r: 255, g: 255, b: 255, a: 255 }, width: 4 };
  const base = { fill, stroke, rotation: 0 };
  switch (over.type) {
    case 'rect': return { x: 0, y: 0, w: 100, h: 100, radius: 0, ...base, ...over } as ShapeSpec;
    case 'ellipse': return { x: 0, y: 0, w: 100, h: 100, ...base, ...over } as ShapeSpec;
    case 'line': return { x1: 0, y1: 0, x2: 100, y2: 100, stroke: { ...stroke, enabled: true }, arrowStart: false, arrowEnd: false, ...over } as ShapeSpec;
    case 'polygon': return { cx: 50, cy: 50, radius: 50, sides: 5, innerRatio: 1, ...base, ...over } as ShapeSpec;
  }
}
