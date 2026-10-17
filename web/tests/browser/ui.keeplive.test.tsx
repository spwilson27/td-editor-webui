import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEEP_LIVE_KEY } from '../../src/state/idle';
import { store } from '../../src/state/store';
import { StatusBar } from '../../src/ui/StatusBar';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

const toggle = () => q<HTMLButtonElement>('[data-keep-live]');
const badge = () => document.querySelector('[data-status=paused]');
function reset() { store.setConnection('linked'); store.setIdle(false); store.keepLive.value = false; try { localStorage.removeItem(KEEP_LIVE_KEY); } catch { /* */ } }
beforeEach(() => { freshEngine(64, 48); reset(); });
afterEach(() => { unmount(); reset(); });

describe('v10 Keep live toggle and Paused (idle) badge', () => {
  it('toggle sits right after the view-quality selector, default off, persists in localStorage', async () => {
    await mount(<StatusBar />);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    toggle().click();
    await settle();
    expect(store.keepLive.value).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(KEEP_LIVE_KEY)).toBe('1');
    toggle().click();
    await settle();
    expect(localStorage.getItem(KEEP_LIVE_KEY)).toBe('0');
  });

  it('badge shows while idle and linked; Keep live (or activity) hides it and the streams stay unpaused', async () => {
    await mount(<StatusBar />);
    expect(badge()).toBeNull();
    store.setIdle(true);
    await settle();
    expect(store.streamsPaused.value).toBe(true);
    expect(badge()?.textContent).toBe('Paused (idle)');
    toggle().click();
    await settle();
    expect(store.streamsPaused.value).toBe(false);
    expect(badge()).toBeNull();
    toggle().click();
    await settle();
    expect(badge()).not.toBeNull();
    store.setIdle(false);
    await settle();
    expect(badge()).toBeNull();
  });

  it('no badge when not connected to TouchDesigner', async () => {
    store.setConnection('standalone');
    store.setIdle(true);
    await mount(<StatusBar />);
    expect(badge()).toBeNull();
  });
});
