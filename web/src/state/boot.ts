import { createEngine } from '../engine';
import type { EditorEngine } from '../engine/types';

/** A new document: the locked base layer plus an empty, active "Layer 1", with no undo history. */
export function createDocument(width: number, height: number): EditorEngine {
  const engine = createEngine(width, height);
  engine.addPixelLayer('Layer 1');
  engine.clearHistory();
  return engine;
}
