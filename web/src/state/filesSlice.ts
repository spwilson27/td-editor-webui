// v5 files: Save Project / Open Project / Export PNG through TouchDesigner (docs/DESIGN_V5.md §1 "Files").
import { signal } from '@preact/signals';
import type { SliceCtx } from './slice';

export type FileOp = 'saveProject' | 'openProject' | 'exportPng';
export interface FileResult { op: FileOp; ok: boolean; path: string; msg?: string }
export const FILE_LABELS: Record<FileOp, string> = { saveProject: 'Save Project', openProject: 'Open Project', exportPng: 'Export PNG' };

export function createFilesSlice(ctx: SliceCtx) {
  /** Current TD `files` message values. */
  const files = signal<{ projectFile: string; pngFile: string }>({ projectFile: '', pngFile: '' });
  /** The open dialog (null = closed). `busy` while a request is in flight; `result` the last outcome. */
  const fileDialog = signal<{ op: FileOp; path: string; busy: boolean; result: FileResult | null; includeHistory: boolean } | null>(null);
  /** Per session: the last choice of the Save dialog's "Include undo history" box (default on). */
  let includeHistory = true;
  return {
    files, fileDialog,
    setFiles(f: { projectFile: string; pngFile: string }) { files.value = f; },
    /** Files need TouchDesigner (they are written/read by TD). */
    canUseFiles(): boolean { return ctx.linked() && ctx.bridge() !== null && !!ctx.bridge()!.saveProject; },
    fileTitle(): string | undefined { return ctx.linked() ? undefined : 'Needs TouchDesigner'; },
    openFileDialog(op: FileOp) {
      if (!ctx.linked()) return;
      const f = files.peek();
      fileDialog.value = { op, path: op === 'exportPng' ? f.pngFile : f.projectFile, busy: false, result: null, includeHistory };
    },
    setIncludeHistory(on: boolean) { includeHistory = on; const d = fileDialog.peek(); if (d) fileDialog.value = { ...d, includeHistory: on }; },
    /** File ▸ Clear stored undo history. */
    async clearStoredHistory(): Promise<boolean> {
      const b = ctx.bridge();
      if (!b?.clearStoredHistory || !ctx.linked()) return false;
      try { await b.clearStoredHistory(); ctx.setNotice('Stored undo history cleared'); return true; } catch (err) { ctx.setNotice(`Could not clear the stored history: ${err instanceof Error ? err.message : String(err)}`); return false; }
    },
    closeFileDialog() { fileDialog.value = null; },
    setFilePath(path: string) { const d = fileDialog.peek(); if (d) fileDialog.value = { ...d, path }; },
    /** Send the request; the dialog shows the outcome. */
    async runFileOp(): Promise<FileResult | null> {
      const d = fileDialog.peek(), b = ctx.bridge();
      if (!d || d.busy || !b) return null;
      const call = d.op === 'saveProject' ? b.saveProject : d.op === 'openProject' ? b.openProject : b.exportPng;
      if (!call) return null;
      if ((d.op === 'saveProject' || d.op === 'exportPng') && ctx.hasEngine()) {
        // TD must get the committed document: no floating selection, no Quick Mask
        const e = ctx.engine();
        if (e.floating()) { e.commitFloating(); ctx.setNotice('Floating selection committed'); }
        if (e.quickMask()) { e.setQuickMask(false); ctx.setNotice('Quick Mask exited'); }
      }
      fileDialog.value = { ...d, busy: true, result: null };
      let result: FileResult;
      try {
        result = d.op === 'saveProject' ? await b.saveProject!(d.path.trim() || undefined, { includeHistory: d.includeHistory }) : await call(d.path.trim() || undefined);
      } catch (err) {
        result = { op: d.op, ok: false, path: d.path, msg: err instanceof Error ? err.message : String(err) };
      }
      const cur = fileDialog.peek();
      if (cur) fileDialog.value = { ...cur, busy: false, result };
      return result;
    },
    /** Browse… is enabled when idle and the bridge can choose a file (the dialog shows it for panel clients only). */
    canBrowse(): boolean {
      const d = fileDialog.peek();
      return !!d && !d.busy && !!(ctx.bridge() as { chooseFile?: unknown } | null)?.chooseFile;
    },
    async browseFile() {
      const d = fileDialog.peek(), b = ctx.bridge() as { chooseFile?: (op: FileOp) => Promise<string | null> } | null;
      if (!d || d.busy || !b?.chooseFile) return;
      try {
        const p = await b.chooseFile(d.op);
        const cur = fileDialog.peek();
        if (p && cur) fileDialog.value = { ...cur, path: p, result: null };
      } catch (err) {
        const cur = fileDialog.peek();
        if (cur) fileDialog.value = { ...cur, result: { op: cur.op, ok: false, path: cur.path, msg: err instanceof Error ? err.message : String(err) } };
      }
    },
    /** A fileResult that did not come from this page's dialog (TD pulses): shown as a notice. */
    onFileResult(r: FileResult) {
      const cur = fileDialog.peek();
      if (cur && cur.busy) return;
      ctx.setNotice(r.ok ? `${FILE_LABELS[r.op]}: ${r.path}` : `${FILE_LABELS[r.op]} failed${r.msg ? `: ${r.msg}` : ''}`);
    },
  };
}
