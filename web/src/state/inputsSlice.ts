// v5 multiple TD inputs (docs/DESIGN_V5.md "Multiple inputs").
import { signal } from '@preact/signals';
import type { SliceCtx } from './slice';

export interface InputItem { input: number; w: number; h: number; connected: boolean }

export function createInputsSlice(ctx: SliceCtx) {
  const inputs = signal<InputItem[]>([]);
  return {
    inputs,
    /** From the bridge (`inputs` message / `hello.inputs`): the list for the Add Input Layer menu. The bridge calls engine.setInputs itself. */
    setInputs(items: InputItem[]) { inputs.value = items; },
    connectedInputs(): InputItem[] { return inputs.value.filter((i) => i.connected); },
    /** Connected inputs that have no layer yet (Layer ▸ Add Input Layer). */
    freeInputs(): InputItem[] {
      if (!ctx.hasEngine()) return [];
      const used = new Set(ctx.engine().layers().filter((l) => l.kind === 'input').map((l) => l.input));
      return inputs.value.filter((i) => i.connected && !used.has(i.input));
    },
    addInputLayer(n: number): string | null { return ctx.hasEngine() ? ctx.engine().addInputLayer(n) : null; },
  };
}
