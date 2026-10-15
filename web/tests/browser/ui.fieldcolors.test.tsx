import { afterEach, describe, expect, it } from 'vitest';
import { store } from '../../src/state/store';
import { TOOLS } from '../../src/state/tools';
import { ContextBar } from '../../src/ui/ContextBar';
import { freshEngine, mount, settle, unmount } from './uiHelpers';

// Regression: the text tool's font-size field rendered its value in the browser's default black on the
// dark field background. Every typed value field in the context bar must use the light UI text colour.
afterEach(() => unmount());

describe('context bar value fields', () => {
  it('use light text on every tool', async () => {
    freshEngine();
    await mount(<ContextBar />);
    for (const t of TOOLS.filter((x) => x.enabled)) {
      store.setTool(t.id);
      await settle();
      for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input[type=number], input[type=text], input:not([type])'))) {
        expect(getComputedStyle(el).color, `${t.id} ${el.id || el.getAttribute('aria-label')}`).toBe('rgb(227, 227, 227)');
      }
    }
  });
});
