import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHAPE_RENDERER_KEY, store } from '../../src/state/store';
import { TopBar } from '../../src/ui/TopBar';
import type { FakeEngine } from './fakeEngine';
import { freshEngine, mount, settle, unmount } from './uiHelpers';

let engine: FakeEngine;
beforeEach(() => { localStorage.removeItem(SHAPE_RENDERER_KEY); store.shapeRenderer.value = 'sdf'; engine = freshEngine(); });
afterEach(() => { unmount(); localStorage.removeItem(SHAPE_RENDERER_KEY); });

const items = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].filter((b) => b.textContent!.includes('Shape antialiasing'));

describe('View > Shape antialiasing', () => {
  beforeEach(async () => { await mount(<TopBar />, 'width:1200px'); });
  const openView = async () => { [...document.querySelectorAll<HTMLElement>('.menu')].find((b) => b.textContent === 'View')!.click(); await settle(); };

  it('offers two radio-style items, Exact checked by default; choosing Browser canvas switches the engine and persists', async () => {
    await openView();
    const [exact, canvas] = items();
    expect(exact.textContent).toContain('Exact (matches TouchDesigner)');
    expect(exact.getAttribute('aria-checked')).toBe('true');
    expect(canvas.getAttribute('aria-checked')).toBe('false');
    canvas.click();
    await settle();
    expect(engine.shapeRenderer()).toBe('canvas');
    expect(localStorage.getItem(SHAPE_RENDERER_KEY)).toBe('canvas');
    await openView();
    expect(items()[1].getAttribute('aria-checked')).toBe('true');
    expect(items()[0].getAttribute('aria-checked')).toBe('false');
    items()[0].click();
    await settle();
    expect(engine.shapeRenderer()).toBe('sdf');
    expect(localStorage.getItem(SHAPE_RENDERER_KEY)).toBe('sdf');
  });
});

describe('persistence', () => {
  it('the stored choice is applied when an engine is attached (boot); default is sdf', async () => {
    store.attach(engine);
    expect(engine.shapeRenderer()).toBe('sdf');
    localStorage.setItem(SHAPE_RENDERER_KEY, 'canvas');
    const { createStore } = await import('../../src/state/store');
    const s = createStore();
    expect(s.shapeRenderer.value).toBe('canvas');
    const e2 = freshEngine();
    s.attach(e2);
    expect(e2.shapeRenderer()).toBe('canvas');
    s.detach();
  });

  it('blocked storage falls back to sdf and setting still works', async () => {
    const orig = Storage.prototype.getItem, origSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
    try {
      const { createStore } = await import('../../src/state/store');
      const s = createStore();
      expect(s.shapeRenderer.value).toBe('sdf');
      s.attach(engine);
      expect(() => s.setShapeRenderer('canvas')).not.toThrow();
      expect(engine.shapeRenderer()).toBe('canvas');
      s.detach();
    } finally { Storage.prototype.getItem = orig; Storage.prototype.setItem = origSet; }
  });

  it('the test hook switches the renderer', async () => {
    const { installTestHook } = await import('../../src/state/testHook');
    store.attach(engine);
    installTestHook(store);
    expect((window as unknown as { __editorTest: { setShapeRenderer(m: string): string } }).__editorTest.setShapeRenderer('canvas')).toBe('canvas');
  });
});
