import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { ASCENT, fontString, layoutText } from '../engine/textShape';
import type { TextSpec } from '../engine/types';
import { store } from '../state/store';

let probe: CanvasRenderingContext2D | null = null;
/** CSS content-area ascent / descent of the layer's font at `size` px (what a CSS line box centres on). */
function cssMetrics(t: TextSpec, size: number): { a: number; d: number } {
  probe ??= document.createElement('canvas').getContext('2d')!;
  probe.font = fontString({ ...t, size });
  const m = probe.measureText('Hg');
  // Blink rounds ascent and descent individually before centring the line box.
  return { a: Math.round(m.fontBoundingBoxAscent ?? ASCENT * size), d: Math.round(m.fontBoundingBoxDescent ?? (1 - ASCENT) * size) };
}

export interface EditorGeometry { left: number; top: number; width: number; lineHeightPx: number; fontPx: number }
/** Placement so the textarea's glyph baselines coincide with the engine's (textShape.drawText) in view pixels. */
export function editorGeometry(t: TextSpec, view: { zoom: number; x: number; y: number }): EditorGeometry {
  const z = view.zoom, l = layoutText(t);
  const lineH = l.lineH * z, fontPx = t.size * z;
  const { a, d } = cssMetrics(t, fontPx);
  const engineBase = (lineH - fontPx) / 2 + ASCENT * fontPx; // baseline below the top of the first line
  const cssBase = (lineH - (a + d)) / 2 + a;
  const blockW = (t.boxWidth ?? l.blockW) * z, extra = 3;
  const dx = t.align === 'left' ? 0 : t.align === 'center' ? extra / 2 : extra;
  return { left: view.x + t.x * z - dx, top: view.y + t.y * z + engineBase - cssBase, width: Math.max(blockW, 1) + extra, lineHeightPx: lineH, fontPx };
}


/**
 * Inline text editor: a transparent textarea positioned over the text layer's box with the layer's font scaled by the view zoom.
 * In the local view the engine's own rendering shows the glyphs (the textarea only draws caret and selection); in the TD view
 * the preview is off, so the textarea draws the glyphs itself. It is page UI, so it shows in both modes.
 */
export function TextEditor() {
  store.docVersion.value;
  const ed = store.textEdit.value;
  const v = store.view.value;
  const td = store.viewMode.value === 'td';
  const ref = useRef<HTMLTextAreaElement>(null);
  const layer = ed ? store.engine.layers().find((l) => l.id === ed.id) : undefined;
  const t = layer?.text ?? null;

  useEffect(() => { if (ed && !t) store.textEdit.value = null; }); // the layer vanished (undo / delete)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [ed?.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(el.scrollHeight, 8)}px`;
  });
  const barPress = useRef(0);
  useEffect(() => {
    const down = (e: PointerEvent) => { barPress.current = (e.target as Element | null)?.closest?.('[data-context-bar]') ? performance.now() : 0; };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, []);
  if (!ed || !t) return null;
  const rgb = `rgba(${t.color.r},${t.color.g},${t.color.b},${t.color.a / 255})`;
  const g = editorGeometry(t, v);
  const wrap = t.boxWidth !== null;
  const style = [
    `position:absolute;box-sizing:border-box;margin:0;padding:0;border:0;resize:none;overflow:hidden;z-index:5;white-space:${wrap ? 'pre-wrap' : 'pre'}`,
    'background:transparent;outline:1px dashed #7fb2f0;outline-offset:2px',
    `left:${g.left}px;top:${g.top}px;width:${g.width}px`,
    `font:${fontString({ ...t, size: g.fontPx })};line-height:${g.lineHeightPx}px`,
    `text-align:${t.align}`,
    `color:${td ? rgb : 'transparent'};caret-color:${rgb}`,
  ].join(';');
  const stop = (e: Event) => e.stopPropagation(); // the viewport must not treat editor clicks as tool input
  return (
    <textarea ref={ref} key={ed.id} data-text-editor wrap={wrap ? 'soft' : 'off'} spellcheck={false} rows={1} aria-label="Text" style={style}
      defaultValue={t.text}
      onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onDblClick={stop}
      onInput={(e) => store.updateEditedText((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); store.commitText(); }
      }}
      onBlur={(e) => {
        if (store.textEdit.peek()?.id !== ed.id) return; // a replaced editor losing focus must not close its successor
        const to = e.relatedTarget as HTMLElement | null;
        if (to?.closest('[data-context-bar]') || performance.now() - barPress.current < 400) return; // the options bar keeps editing this layer
        store.commitText();
      }} />
  );
}
