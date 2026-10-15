import { hasFiles, imageFiles } from './importImage';
import { isTyping } from './keyboard';
import type { Store } from './store';

/** Ctrl/Cmd+V: image items on the clipboard become a new layer. Text fields and the text editor keep their own paste. */
export function installPaste(store: Store, win: Window = window): () => void {
  const onPaste = (e: ClipboardEvent) => {
    if (isTyping(e.target) || store.textEdit.peek() || store.loadingDoc.peek() || !store.hasEngine()) return;
    const files = imageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void store.importFiles(files);
  };
  win.addEventListener('paste', onPaste);
  return () => win.removeEventListener('paste', onPaste);
}

/**
 * Dropping a file anywhere on the page must never navigate the (CEF) browser away. Only the viewport imports dropped images
 * (its own handler runs first); drops on panels and bars are swallowed with a "not allowed" cursor.
 */
export function installDropGuard(win: Window = window): () => void {
  const inViewport = (e: Event) => !!(e.target as Element | null)?.closest?.('[data-viewport]');
  const over = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer && !inViewport(e)) e.dataTransfer.dropEffect = 'none';
  };
  const drop = (e: DragEvent) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); };
  win.addEventListener('dragover', over);
  win.addEventListener('drop', drop);
  return () => { win.removeEventListener('dragover', over); win.removeEventListener('drop', drop); };
}
