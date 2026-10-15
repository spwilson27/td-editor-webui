import type { EditorEngine, LayerInfo } from '../engine/types';
import type { StoreBridge } from './store';

/** What a store slice may use from the store core (keeps the slices free of an import cycle with store.ts). */
export interface SliceCtx {
  engine(): EditorEngine;
  hasEngine(): boolean;
  setNotice(msg: string): void;
  bridge(): StoreBridge | null;
  activeLayer(): LayerInfo | undefined;
  linked(): boolean;
  setLayerTab(t: 'layers' | 'history' | 'adjust' | 'fx'): void;
}
