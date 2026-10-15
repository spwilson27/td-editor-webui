import { describe, expect, it } from 'vitest';
import { PAINT_TOOLS, TOOLS, toolInfo } from '../../src/state/tools';
import { clampCrop } from '../../src/state/toolsSlice';

describe('tools table (v5)', () => {
  it('every tool is enabled', () => { expect(TOOLS.filter((t) => !t.enabled)).toEqual([]); });
  it('adds blur (Y) and dodge (O) with icons and key hints', () => {
    expect(toolInfo('blur')).toMatchObject({ key: 'Y', enabled: true });
    expect(toolInfo('dodge')).toMatchObject({ key: 'O', enabled: true });
    expect(toolInfo('blur').d.length).toBeGreaterThan(10);
    expect(toolInfo('dodge').d.length).toBeGreaterThan(10);
    expect(toolInfo('crop').key).toBe('C'); expect(toolInfo('clone').key).toBe('S'); expect(toolInfo('smudge').key).toBe('R');
  });
  it('the brush-like set includes clone, smudge, blur and dodge', () => {
    for (const id of ['brush', 'pencil', 'eraser', 'clone', 'smudge', 'blur', 'dodge'] as const) expect(PAINT_TOOLS.has(id)).toBe(true);
    for (const id of ['crop', 'move', 'fill', 'marquee'] as const) expect(PAINT_TOOLS.has(id)).toBe(false);
  });
  it('keys are unique except fill / gradient sharing G', () => {
    const seen = new Map<string, string[]>();
    for (const t of TOOLS) seen.set(t.key, [...(seen.get(t.key) ?? []), t.id]);
    for (const [k, ids] of seen) if (ids.length > 1) expect([k, ids]).toEqual(['G', ['fill', 'gradient']]);
    expect(seen.has('Q')).toBe(false); // Q is Quick Mask
    expect(seen.has('D')).toBe(false); // D is default colours
  });
  it('clampCrop intersects with the canvas and keeps at least 1 px', () => {
    expect(clampCrop({ x: -10, y: -5, w: 50, h: 30 }, 100, 80)).toEqual({ x: 0, y: 0, w: 40, h: 25 });
    expect(clampCrop({ x: 90, y: 70, w: 50, h: 50 }, 100, 80)).toEqual({ x: 90, y: 70, w: 10, h: 10 });
    expect(clampCrop({ x: 50, y: 50, w: -20, h: -10 }, 100, 80)).toEqual({ x: 30, y: 40, w: 20, h: 10 });
    expect(clampCrop({ x: 200, y: 200, w: 5, h: 5 }, 100, 80)).toEqual({ x: 99, y: 79, w: 1, h: 1 });
  });
});
