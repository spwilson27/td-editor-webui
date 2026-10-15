import { describe, expect, it } from 'vitest';
import { createDocument } from '../../src/state/boot';

describe('startup document', () => {
  it('has an active, unlocked empty Layer 1 above the locked TD Input and no history', () => {
    const e = createDocument(64, 48);
    const layers = e.layers();
    expect(layers.map((l) => l.name)).toEqual(['Layer 1', 'TD Input']);
    expect(layers[0]).toMatchObject({ kind: 'pixel', locked: false, visible: true, opacity: 1 });
    expect(layers[1]).toMatchObject({ kind: 'input', input: 1, locked: true });
    expect(e.activeLayerId()).toBe(layers[0].id);
    expect(e.history()).toEqual({ entries: [], index: -1 });
  });

  it('first stroke paints without a "locked" notice and creates exactly one history entry', () => {
    const e = createDocument(64, 48);
    const notices: string[] = [];
    e.on((ev) => { if (ev.type === 'notice') notices.push(ev.message); });
    e.setTool('pencil');
    e.setToolContext({ primary: { r: 255, g: 0, b: 0, a: 255 }, secondary: { r: 0, g: 0, b: 0, a: 255 }, brush: { size: 4, opacity: 1, flow: 1, hardness: 1, spacing: 0.15 }, fillTolerance: 0 });
    const p = (x: number) => ({ x, y: 10, pressure: 1, shift: false, alt: false, ctrl: false });
    e.pointerDown(p(10)); e.pointerMove(p(20)); e.pointerUp(p(20));
    expect(notices).toEqual([]);
    expect(e.history().entries.length).toBe(1);
    expect(Array.from(e.readComposite({ x: 15, y: 10, w: 1, h: 1 }))).toEqual([255, 0, 0, 255]);
  });
});
