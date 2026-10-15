import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../src/state/store';
import { FakeEngine } from '../browser/fakeEngine';

let store: ReturnType<typeof createStore>;
let engine: FakeEngine;
beforeEach(() => { store = createStore(); engine = new FakeEngine(8, 8); store.attach(engine); });
afterEach(() => store.detach());

describe('inputs slice', () => {
  it('lists connected inputs and those without a layer', () => {
    const items = [{ input: 1, w: 8, h: 8, connected: true }, { input: 2, w: 4, h: 4, connected: true }, { input: 3, w: 0, h: 0, connected: false }];
    store.setInputs(items);
    expect(store.inputs.value).toEqual(items);
    expect(store.connectedInputs().map((i) => i.input)).toEqual([1, 2]);
    expect(store.freeInputs().map((i) => i.input)).toEqual([2]); // input 1 already has the default layer
    expect(store.addInputLayer(2)).toBe('in2');
    expect(engine.calls).toContain('addInputLayer:2');
    expect(store.freeInputs()).toEqual([]);
  });
});
