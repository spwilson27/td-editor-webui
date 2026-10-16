import type { ToolId } from '../engine/types';
import type { Store } from './store';
import { TOOLS, toolInfo } from './tools';

export interface KeyLike {
  key: string; repeat?: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
  target: unknown; preventDefault(): void; defaultPrevented?: boolean;
}

const TEXT_INPUT = /^(text|search|number|email|url|tel|password)$/i;

export function isTyping(target: unknown): boolean {
  const t = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toUpperCase();
  if (tag === 'INPUT') return TEXT_INPUT.test(t.type || 'text');
  return tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
}

/** Space must keep activating focused buttons and links. */
function isActivatable(target: unknown): boolean {
  const t = target as { tagName?: string; getAttribute?: (n: string) => string | null } | null;
  const tag = t?.tagName?.toUpperCase();
  return tag === 'BUTTON' || tag === 'A' || t?.getAttribute?.('role') === 'button';
}

/** Delete removes layers only when the key was not meant for something else: page, canvas or the layer list. */
export function deleteKeyTarget(target: unknown): boolean {
  const t = target as { tagName?: string; closest?: (s: string) => unknown } | null;
  if (!t || !t.tagName) return true;
  const tag = t.tagName.toUpperCase();
  return tag === 'BODY' || tag === 'HTML' || tag === 'CANVAS' || !!t.closest?.('[data-layer-list]');
}

function inLayerList(target: unknown): boolean {
  const t = target as { closest?: (s: string) => unknown } | null;
  return !!t?.closest?.('[data-layer-list]');
}

const toolKeys = new Map<string, ToolId[]>();
for (const t of TOOLS) toolKeys.set(t.key.toLowerCase(), [...(toolKeys.get(t.key.toLowerCase()) || []), t.id]);

export function onKeyDown(store: Store, e: KeyLike): void {
  if (store.editorSwitching.peek()) return; // v10: editing is blocked while the editor switch is pending
  if (store.textEdit.peek()) { // forwarded TD keys arrive as normal key events: the inline text editor owns them
    if (e.key === 'Escape') { store.commitText(); e.preventDefault(); }
    return;
  }
  if (store.topDialog.peek() || store.canvasDialog.peek() || store.fileDialog.peek() || store.selOpDialog.peek()) return; // dialogs own the keyboard (they close themselves on Escape)
  if (isTyping(e.target) || store.loadingDoc.peek()) return; // locked while loading TD's document
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (e.repeat && !mod && key !== '[' && key !== ']' && key !== ' ') return; // toggles must not retrigger

  if (mod && !e.altKey && !e.shiftKey && (key === 'c' || key === 'x' || key === 'v' || key === 'j')) {
    // layer clipboard. Copy / cut / duplicate use the Delete guards (not typing, not aimed at another control, no floating selection / crop box);
    // paste works from any non-typing target (a focused toolbar button must not block it).
    if (!store.hasEngine() || e.defaultPrevented || store.layerKeysBlocked()) return;
    if (key !== 'v' && !deleteKeyTarget(e.target)) return;
    if (e.repeat) { e.preventDefault(); return; } // a held key acts once (and a held V must not fire a paste event per repeat)
    if (key === 'v') {
      // the paste event (system images, layer marker) normally pastes first; this covers forwarded keys that never fire one
      store.armPasteFallback(() => store.layerKeysAllowed() && !isTyping(typeof document === 'undefined' ? null : document.activeElement));
      return;
    }
    if (key === 'c') store.copySelected();
    else if (key === 'x') store.cutSelected();
    else store.duplicateSelected();
    e.preventDefault();
    return;
  }
  if (mod) {
    if (key === 'z') { e.shiftKey ? store.redo() : store.undo(); }
    else if (key === 'y') store.redo();
    else if (key === 'd') store.deselect();
    else if (key === 'a') store.selectAll();
    else if (key === 'g' && !e.shiftKey) { if (store.hasEngine()) store.groupSelected(); }
    else if (key === 'i' && e.shiftKey) store.invertSelection();
    else if (key === 't' && !e.shiftKey) {
      if (!store.hasEngine() || !store.canTransformSelection()) return;
      if (store.beginTransformSelection()) { store.setTool('move'); store.wantMove.value = false; }
    }
    else return;
    e.preventDefault();
    return;
  }
  if (e.altKey) return;

  if (key === ' ') {
    store.spaceHeld.value = true;
    store.spaceSeenAt = performance.now();
    if (!isActivatable(e.target)) e.preventDefault();
    return;
  }
  if (!store.hasEngine()) return;

  switch (key) {
    case 'Enter':
      if (store.isFloating()) { store.commitFloating(); e.preventDefault(); }
      else if (store.tool.peek() === 'crop' && store.cropBox.peek()) { store.applyCrop(); e.preventDefault(); }
      return;
    case 'Escape':
      if (store.isFloating()) { store.cancelFloating(); e.preventDefault(); }
      else if (store.cropBox.peek()) { store.cancelCrop(); e.preventDefault(); }
      return;
    case 'Delete':
    case 'Backspace': // the Mac "delete" key
      if (e.defaultPrevented || !deleteKeyTarget(e.target)) return;
      if (store.isFloating() || store.cropBox.peek()) return;
      // A pixel selection keeps the layers when the key was aimed at the canvas (the engine has no clear op); focus in the layer list
      // (a row was just clicked) means the layers.
      if (store.engine.selection() && !inLayerList(e.target)) return;
      store.deleteSelected();
      e.preventDefault();
      return;
    case 'q': store.toggleQuickMask(); return;
    case '[': store.nudgeSize(-1); return;
    case ']': store.nudgeSize(1); return;
    case 'x': store.swapColours(); return;
    case 'd': store.defaultColours(); return;
    case '0': store.fit(); return;
    case '1': store.zoomTo(1); return;
    case '+': case '=': store.zoomStep(1); return;
    case '-': store.zoomStep(-1); return;
    default: break;
  }
  const ids = toolKeys.get(key);
  if (!ids) return;
  const enabled = ids.filter((id) => toolInfo(id).enabled);
  if (!enabled.length) {
    store.setNotice(`${toolInfo(ids[0]).name} is not available in this version`);
    return;
  }
  const cur = enabled.indexOf(store.tool.peek());
  store.setTool(enabled[(cur + 1) % enabled.length]);
}

export function onKeyUp(store: Store, e: Pick<KeyLike, 'key'>): void {
  if (e.key === ' ') store.spaceHeld.value = false;
}

export function installKeyboard(store: Store, win: Window = window): () => void {
  const down = (e: KeyboardEvent) => onKeyDown(store, e);
  const up = (e: KeyboardEvent) => onKeyUp(store, e);
  const blur = () => { store.spaceHeld.value = false; };
  win.addEventListener('keydown', down);
  win.addEventListener('keyup', up);
  win.addEventListener('blur', blur);
  return () => {
    win.removeEventListener('keydown', down);
    win.removeEventListener('keyup', up);
    win.removeEventListener('blur', blur);
  };
}
