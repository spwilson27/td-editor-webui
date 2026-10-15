import type { SelectionMode, ToolPointer } from '../types';
import { clipToSize, fromPoints, isEmpty } from '../rect';
import { combine, feather, fillPolygon, NO_SEL, rectSel, wandSelect, type Pt, type SelState } from '../selection';
import type { Host, Tool } from './host';

/** Shift = add, Alt = subtract, Shift + Alt = intersect (decided at pointer down); otherwise the option's mode. */
export function modeFor(p: ToolPointer, option: SelectionMode): SelectionMode {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return option;
}

/** Rectangular marquee: integer-snapped rect, feathered, combined by mode; one history entry per drag. */
export class MarqueeTool implements Tool {
  private sx = 0;
  private sy = 0;
  private before: SelState = NO_SEL;
  private mode: SelectionMode = 'new';
  private on = false;

  constructor(private host: Host) {}

  down(p: ToolPointer): void {
    this.sx = p.x;
    this.sy = p.y;
    this.before = this.host.selectionState();
    this.mode = modeFor(p, this.host.selectionOptions().mode);
    this.on = true;
  }

  move(p: ToolPointer, final = false): void {
    if (!this.on) return;
    const { doc } = this.host;
    const r = fromPoints(Math.round(this.sx), Math.round(this.sy), Math.round(p.x), Math.round(p.y));
    const clipped = isEmpty(r) ? null : clipToSize(r, doc.width, doc.height);
    // the live preview is the plain rect; the feather is applied once, on release
    const shape = final ? feather(rectSel(clipped), this.host.selectionOptions().feather, doc.width, doc.height) : rectSel(clipped);
    this.host.previewSelection(combine(this.before, shape, this.mode, doc.width, doc.height));
  }

  up(p: ToolPointer): void {
    if (!this.on) return;
    this.move(p, true);
    this.on = false;
    this.host.commitSelection('Rectangular marquee', this.before);
  }
}

/** Freehand lasso: polygon through the dragged points (non-zero winding), antialiased, feathered, combined by mode. */
export class LassoTool implements Tool {
  private pts: Pt[] = [];
  private before: SelState = NO_SEL;
  private mode: SelectionMode = 'new';
  private on = false;
  private lastPreview = 0;

  constructor(private host: Host) {}

  down(p: ToolPointer): void {
    this.pts = [{ x: p.x, y: p.y }];
    this.before = this.host.selectionState();
    this.mode = modeFor(p, this.host.selectionOptions().mode);
    this.on = true;
    this.lastPreview = 0;
  }

  move(p: ToolPointer): void {
    if (!this.on) return;
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
    this.pts.push({ x: p.x, y: p.y });
    const now = performance.now();
    if (now - this.lastPreview < 24) return; // live outline at ~40 Hz at most; the release computes the exact result
    this.lastPreview = now;
    this.apply(false);
  }

  up(p: ToolPointer): void {
    if (!this.on) return;
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 1) this.pts.push({ x: p.x, y: p.y });
    this.on = false;
    this.apply(true);
    this.host.commitSelection('Lasso', this.before);
    this.pts = [];
  }

  private apply(final: boolean): void {
    const { doc } = this.host;
    const o = this.host.selectionOptions();
    let shape = fillPolygon(this.pts, doc.width, doc.height, final ? o.antialias : false);
    if (final) shape = feather(shape, o.feather, doc.width, doc.height);
    this.host.previewSelection(combine(this.before, shape, this.mode, doc.width, doc.height));
  }
}

/** Magic wand: flood select from the clicked pixel; the whole edit happens on pointer down. */
export class WandTool implements Tool {
  constructor(private host: Host) {}

  down(p: ToolPointer): void {
    const { doc } = this.host;
    const o = this.host.selectionOptions();
    const before = this.host.selectionState();
    const data = this.host.wandSource(o.wandSampleAll);
    if (!data) return;
    let shape = wandSelect(data, doc.width, doc.height, Math.floor(p.x), Math.floor(p.y), o.wandTolerance, o.wandContiguous);
    shape = feather(shape, o.feather, doc.width, doc.height);
    this.host.previewSelection(combine(before, shape, modeFor(p, o.mode), doc.width, doc.height));
    this.host.commitSelection('Magic wand', before);
  }
  move(): void {}
  up(): void {}
}
