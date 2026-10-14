import { Engine } from './engine';
import type { EditorEngine } from './types';

export function createEngine(width: number, height: number): EditorEngine {
  return new Engine(width, height);
}

export { Engine };
export type * from './types';
