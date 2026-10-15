import { describe, expect, it } from 'vitest';
import type { LayerInfo } from '../../src/engine/types';
import { computeDrop, dropZone } from '../../src/state/layerDrop';

const L = (id: string, kind: LayerInfo['kind'], parentId: string | null = null): LayerInfo => ({
  id, name: id, kind, visible: true, locked: false, opacity: 1, blend: 'normal', depth: parentId ? 1 : 0, parentId, slot: null, mask: null, adjustment: null, text: null, shape: null, transform: { x: 0, y: 0, sx: 1, sy: 1, rot: 0, kx: 0, ky: 0 }, input: null, inputConnected: null, effects: [], surfaceW: null, surfaceH: null,
});
// display order (top first): G { a, b }, c, base
const layers = [L('G', 'group'), L('a', 'pixel', 'G'), L('b', 'pixel', 'G'), L('c', 'pixel'), L('base', 'input')];

describe('layer drop targets', () => {
  it('drops before / after a root layer', () => {
    expect(computeDrop(layers, 'c', 'G', 'before')).toEqual({ parentId: null, index: 0 });
    expect(computeDrop(layers, 'G', 'c', 'after')).toEqual({ parentId: null, index: 1 }); // siblings w/o G: c, base
  });

  it('drops into a group at the top, and next to children', () => {
    expect(computeDrop(layers, 'c', 'G', 'into')).toEqual({ parentId: 'G', index: 0 });
    expect(computeDrop(layers, 'c', 'b', 'after')).toEqual({ parentId: 'G', index: 2 });
    expect(computeDrop(layers, 'c', 'a', 'before')).toEqual({ parentId: 'G', index: 0 });
  });

  it('counts siblings excluding the dragged layer when moving within a parent', () => {
    expect(computeDrop(layers, 'a', 'b', 'after')).toEqual({ parentId: 'G', index: 1 });
  });

  it('rejects itself and cycles; input layers move freely (v5)', () => {
    expect(computeDrop(layers, 'c', 'c', 'before')).toBeNull();
    expect(computeDrop(layers, 'G', 'a', 'before')).toBeNull();
    expect(computeDrop(layers, 'base', 'c', 'before')).toEqual({ parentId: null, index: 1 });
    expect(computeDrop(layers, 'c', 'base', 'after')).toEqual({ parentId: null, index: 2 });
    expect(computeDrop(layers, 'c', 'base', 'before')).toEqual({ parentId: null, index: 1 });
    expect(computeDrop(layers, 'nope', 'c', 'before')).toBeNull();
  });

  it('chooses zones by pointer height', () => {
    expect(dropZone(layers[0], 0.5)).toBe('into');
    expect(dropZone(layers[0], 0.1)).toBe('before');
    expect(dropZone(layers[0], 0.9)).toBe('after');
    expect(dropZone(layers[3], 0.5)).toBe('after');
    expect(dropZone(layers[3], 0.49)).toBe('before');
  });
});
