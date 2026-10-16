import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorInfo } from '../../src/bridge/codec';
import { store } from '../../src/state/store';
import { App } from '../../src/ui/App';
import { DocTabs } from '../../src/ui/DocTabs';
import { freshEngine, mount, q, settle, unmount } from './uiHelpers';

const ed = (id: string, over: Partial<EditorInfo> = {}): EditorInfo => ({ id, name: `Editor ${id}`, path: `/project1/${id}`, version: '0.8.0', active: true, ...over });
const tabs = () => [...document.querySelectorAll<HTMLElement>('[data-editor-tab]')];
let switched: string[];

beforeEach(() => {
  freshEngine(200, 100);
  store.editors.value = [];
  store.editorMaster.value = '';
  store.editorId.value = '';
  store.editorSwitching.value = false;
  store.notice.value = '';
  switched = [];
  store.switchEditor = (id) => { switched.push(id); };
});
afterEach(() => { unmount(); store.switchEditor = null; store.editors.value = []; store.editorId.value = ''; });

describe('document tab strip: standalone', () => {
  it('shows the single document tab, no tablist', async () => {
    store.docName.value = 'landscape.png';
    await mount(<DocTabs />);
    expect(document.querySelector('[data-editor-tabs]')).toBeNull();
    expect(document.body.textContent).toContain('landscape.png');
    expect(q('[data-doc-info]').textContent).toContain('200 × 100');
  });
});

describe('editor tabs (v10)', () => {
  beforeEach(() => {
    store.editors.value = [ed('a'), ed('b'), ed('c')];
    store.editorMaster.value = 'a';
    store.editorId.value = 'b';
  });

  it('one tab per editor: label = name, tooltip = path, the current one selected', async () => {
    await mount(<DocTabs />);
    expect(tabs().map((t) => q('[data-editor-name]', t).textContent)).toEqual(['Editor a', 'Editor b', 'Editor c']);
    expect(tabs().map((t) => t.title)).toEqual(['/project1/a', '/project1/b', '/project1/c']);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    const list = q('[data-editor-tabs]');
    expect(list.getAttribute('aria-label')).toBe('Editors');
  });

  it('only the selected tab shows the document info, like the old document tab', async () => {
    await mount(<DocTabs />);
    expect(document.querySelectorAll('[data-doc-info]').length).toBe(1);
    expect(tabs()[1].querySelector('[data-doc-info]')?.textContent).toContain('200 × 100');
  });

  it('marks the master editor', async () => {
    await mount(<DocTabs />);
    expect(tabs().map((t) => !!t.querySelector('[data-editor-master]'))).toEqual([true, false, false]);
    expect(q('[data-editor-master]').getAttribute('aria-label')).toBe('Master editor');
  });

  it('inactive editors are muted, aria-disabled, say so in the tooltip and cannot be opened', async () => {
    store.editors.value = [ed('a'), ed('b'), ed('c', { active: false })];
    await mount(<DocTabs />);
    const c = tabs()[2];
    expect(c.getAttribute('aria-disabled')).toBe('true');
    expect(c.title).toContain('inactive');
    expect(tabs()[0].getAttribute('aria-disabled')).toBe('false');
    c.click();
    await settle();
    expect(switched).toEqual([]);
    expect(store.notice.value).toMatch(/inactive/);
  });

  it('clicking another tab asks to switch; clicking the current one does not', async () => {
    await mount(<DocTabs />);
    tabs()[2].click();
    tabs()[1].click();
    await settle();
    expect(switched).toEqual(['c']);
  });

  it('while a switch is pending, clicking the current tab asks the controller (it cancels the switch)', async () => {
    await mount(<DocTabs />);
    store.setSwitching({ to: 'Editor c', waiting: true });
    await settle();
    tabs()[1].click();
    expect(switched).toEqual(['b']);
    store.setSwitching(null);
  });

  it('updates live: create, rename, delete, current editor change, activate', async () => {
    await mount(<DocTabs />);
    store.editors.value = [ed('a'), ed('b', { name: 'Renamed' }), ed('c'), ed('d')];
    await settle();
    expect(tabs().length).toBe(4);
    expect(tabs()[1].textContent).toContain('Renamed');
    store.editors.value = [ed('a'), ed('d')];
    store.editorId.value = 'a';
    await settle();
    expect(tabs().map((t) => t.getAttribute('data-editor-tab'))).toEqual(['a', 'd']);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('[data-doc-info]').length).toBe(1);
    store.editorMaster.value = 'd';
    await settle();
    expect(tabs().map((t) => !!t.querySelector('[data-editor-master]'))).toEqual([false, true]);
    store.editors.value = [];
    await settle();
    expect(document.querySelector('[data-editor-tabs]')).toBeNull(); // back to the single document tab
  });

  it('is busy while switching', async () => {
    await mount(<DocTabs />);
    expect(q('[data-editor-tabs]').getAttribute('aria-busy')).toBe('false');
    store.editorSwitching.value = true;
    await settle();
    expect(q('[data-editor-tabs]').getAttribute('aria-busy')).toBe('true');
  });

  it('keyboard: roving tabindex, arrows / Home / End move focus (wrapping), Enter / Space open', async () => {
    await mount(<DocTabs />);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    tabs()[1].focus();
    key(tabs()[1], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[2]);
    key(tabs()[2], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tabs()[2]);
    key(tabs()[2], 'Home');
    expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0], 'End');
    expect(document.activeElement).toBe(tabs()[2]);
    key(tabs()[2], 'Enter');
    key(tabs()[0], ' ');
    expect(switched).toEqual(['c', 'a']);
  });

  it('the strip lives in the App between the toolbars and the viewport and does not break the layout', async () => {
    await mount(<App />, 'width:1200px;height:700px');
    const strip = q('[data-editor-tabs]');
    const vp = q('[data-viewport]');
    expect(strip.getBoundingClientRect().bottom).toBeLessThanOrEqual(vp.getBoundingClientRect().top + 1);
    expect(strip.getBoundingClientRect().height).toBeLessThanOrEqual(31);
  });
});

describe('switching overlay and discard dialog (v10 review)', () => {
  beforeEach(() => {
    store.editors.value = [ed('a'), ed('b')];
    store.editorMaster.value = 'a';
    store.editorId.value = 'a';
    store.setSwitching(null);
  });
  afterEach(() => { store.setSwitching(null); });

  it('while a switch is pending: a visible "Switching to <name>…" status, the regions are inert, the tab strip is not', async () => {
    await mount(<App />, 'width:1200px;height:700px');
    expect(document.querySelector('[data-switching]')).toBeNull();
    expect([...document.querySelectorAll('[data-app-root] > div[style*="contents"], [data-app-root] div[style*="contents"]')].some((d) => (d as HTMLElement).inert)).toBe(false);
    store.setSwitching({ to: 'Editor b', waiting: false });
    await settle();
    const ov = q('[data-switching]');
    expect(ov.getAttribute('role')).toBe('status');
    expect(q('[data-switching-title]').textContent).toBe('Switching to Editor b…');
    expect(document.querySelector('[data-switching-wait]')).toBeNull();
    const inert = [...document.querySelectorAll<HTMLElement>('[data-app-root] div')].filter((d) => d.inert);
    expect(inert.length).toBeGreaterThanOrEqual(4); // toolbars, tool rail, viewport, panels
    expect(inert.some((d) => d.contains(q('[data-editor-tabs]')))).toBe(false);
    expect(q('[data-editor-tabs]').getAttribute('aria-busy')).toBe('true');
    // the tab strip is above the overlay: the current tab is clickable (cancel)
    const r = q('[data-editor-tab=a]').getBoundingClientRect();
    expect(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-editor-tab=a]')).toBeTruthy();
    store.setSwitching({ to: 'Editor b', waiting: true });
    await settle();
    expect(q('[data-switching-wait]').textContent).toMatch(/Waiting for TouchDesigner/);
    store.setSwitching(null);
    await settle();
    expect(document.querySelector('[data-switching]')).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('[data-app-root] div')].some((d) => d.inert)).toBe(false);
  });

  it('keys do nothing while switching', async () => {
    await mount(<App />, 'width:1200px;height:700px');
    store.setSwitching({ to: 'x', waiting: false });
    store.setTool('brush');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    await settle();
    expect(store.tool.value).toBe('brush');
  });

  it('the discard dialog has Wait / Discard & switch and the message of the spec', async () => {
    await mount(<App />, 'width:1200px;height:700px');
    const ctl = new AbortController();
    const p = store.askDiscard('Editor a', 'Editor b', ctl.signal);
    await settle();
    const d = q('[data-discard-dialog]');
    expect(d.getAttribute('role')).toBe('alertdialog');
    expect(d.textContent).toContain('This editor has unsent changes and TouchDesigner is reconnecting.');
    expect(q('[data-discard-wait]').textContent).toBe('Wait');
    expect(q('[data-discard-discard]').textContent).toBe('Discard & switch');
    q('[data-discard-wait]').click();
    expect(await p).toBe('wait');
    await settle();
    expect(document.querySelector('[data-discard-dialog]')).toBeNull();
    const p2 = store.askDiscard('a', 'b', ctl.signal);
    await settle();
    q('[data-discard-discard]').click();
    expect(await p2).toBe('discard');
  });
});
