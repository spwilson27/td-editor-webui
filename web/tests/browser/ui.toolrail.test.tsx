import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { TOOLS } from '../../src/state/tools';
import { ToolRail } from '../../src/ui/ToolRail';
import { freshEngine, mount, settle, unmount, q } from './uiHelpers';
import type { FakeEngine } from './fakeEngine';

let engine: FakeEngine;
beforeEach(async () => { engine = freshEngine(); store.tool.value = 'brush'; await mount(<ToolRail />, 'width:52px'); });
afterEach(unmount);

describe('ToolRail', () => {
  it('renders all 19 tools with the mockup labels', () => {
    const btns = document.querySelectorAll('[data-tool]');
    expect(btns.length).toBe(19);
    expect(q('[data-tool=brush]').getAttribute('aria-label')).toBe('Paint Brush (B)');
    expect(q('[data-tool=wand]').getAttribute('aria-label')).toBe('Flood Select (W)');
    expect(q('[data-tool=brush]').getAttribute('aria-pressed')).toBe('true');
  });

  it('switches tool on click and tells the engine', async () => {
    q('[data-tool=eraser]').click();
    await settle();
    expect(store.tool.value).toBe('eraser');
    expect(engine.tool).toBe('eraser');
    expect(q('[data-tool=eraser]').getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-tool=brush]').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the not-in-this-version state on disabled tools and ignores clicks', async () => {
    const crop = TOOLS.find((t) => t.id === 'crop')!;
    crop.enabled = false;
    try {
      await mount(<ToolRail />, 'width:52px');
      const b = q('[data-tool=crop]');
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.title).toContain('Not in this version');
      b.click();
      await settle();
      expect(store.tool.value).toBe('brush');
    } finally { crop.enabled = true; }
  });

  it('enables the v5 tools with icons, keys in the tooltip, and activates them', async () => {
    expect(TOOLS.filter((t) => !t.enabled)).toEqual([]);
    const want: Record<string, string> = { crop: 'C', clone: 'S', smudge: 'R', blur: 'Y', dodge: 'O' };
    for (const [id, key] of Object.entries(want)) {
      const b = q(`[data-tool=${id}]`);
      expect(b.getAttribute('aria-disabled')).toBe('false');
      expect(b.getAttribute('aria-label')).toMatch(new RegExp(`\\(${key}\\)$`));
      expect(b.querySelector('svg path')?.getAttribute('d')?.length).toBeGreaterThan(10);
      b.click();
      await settle();
      expect(store.tool.value).toBe(id);
      expect(engine.tool).toBe(id);
    }
  });

  it('keeps every tool key unique except the shared fill / gradient G', () => {
    const keys = new Map<string, string[]>();
    for (const t of TOOLS) keys.set(t.key, [...(keys.get(t.key) ?? []), t.id]);
    for (const [k, ids] of keys) if (ids.length > 1) expect([k, ids.sort()]).toEqual(['G', ['fill', 'gradient']]);
  });

  it('shows the primary and secondary swatches and swaps on secondary click', async () => {
    store.setPrimaryHex('#112233');
    store.secondary.value = '#ffeedd';
    await settle();
    q('[aria-label="Secondary colour"]').click();
    await settle();
    expect(store.primary.value).toBe('#ffeedd');
  });
});
