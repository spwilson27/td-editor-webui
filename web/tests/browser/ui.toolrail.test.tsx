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
  it('renders all 17 tools with the mockup labels', () => {
    const btns = document.querySelectorAll('[data-tool]');
    expect(btns.length).toBe(17);
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
    const disabled = TOOLS.filter((t) => !t.enabled).map((t) => t.id);
    expect(disabled.sort()).toEqual(['clone', 'crop', 'lasso', 'shape', 'smudge', 'text', 'wand']);
    for (const id of disabled) {
      const b = q(`[data-tool=${id}]`);
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.title).toContain('Not in this version');
      b.click();
    }
    await settle();
    expect(store.tool.value).toBe('brush');
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
