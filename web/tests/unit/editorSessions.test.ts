import { beforeEach, describe, expect, it } from 'vitest';
import type { EditorInfo, EditorList } from '../../src/bridge/codec';
import type { FlushResult } from '../../src/bridge/tdBridge';
import { createEditorController, FLUSH_TIMEOUT_MS, pickMaster, TOKEN_EXPIRED, type EditorController, type EditorSession, type SessionHooks } from '../../src/bridge/editorSessions';
import { buildHash, parseHash } from '../../src/bridge/urls';

const ed = (id: string, over: Partial<EditorInfo> = {}): EditorInfo => ({ id, name: `Name-${id}`, path: `/project1/${id}`, version: '0.8.0', active: true, ...over });
const list = (master: string, ...eds: EditorInfo[]): EditorList => ({ master, editors: eds });

interface FakeSession extends EditorSession { hooks: SessionHooks; flushes: number; ended: boolean; unsent: boolean; flushImpl: () => Promise<FlushResult> }
interface Confirm { from: string; to: string; resolve: (v: 'wait' | 'discard' | 'cancel') => void; aborted: boolean }

class Harness {
  log: string[] = [];
  sessions: FakeSession[] = [];
  hash: string;
  hashListeners = new Set<() => void>();
  pushes: string[] = [];
  replaces: string[] = [];
  server: EditorList | 'forbidden' | 'down' | null;
  fetches = 0;
  uiList: EditorList | null = null;
  current = '';
  switching: boolean[] = [];
  switchInfos: Array<{ to: string; waiting: boolean } | null> = [];
  confirms: Confirm[] = [];
  sleepMs: number[] = [];
  notices: string[] = [];
  fatals: string[] = [];
  flushImpl: () => Promise<FlushResult> = () => Promise.resolve('ok');
  sleeps: Array<() => void> = [];
  ctrl: EditorController;
  fetchCalls: string[] = [];

  constructor(hash: string, server: EditorList | 'forbidden' | 'down' | null) {
    this.hash = hash;
    this.server = server;
    this.ctrl = createEditorController({
      origin: 'http://td:9980',
      token: 'tok',
      fetch: (async (url: string) => {
        this.fetches++;
        this.fetchCalls.push(String(url));
        if (this.server === 'down' || this.server === null) throw new TypeError('network');
        if (this.server === 'forbidden') return new Response('', { status: 403 });
        return new Response(JSON.stringify(this.server), { status: 200 });
      }) as unknown as typeof fetch,
      nav: {
        hash: () => this.hash,
        push: (h) => { this.hash = h; this.pushes.push(h); },
        replace: (h) => { this.hash = h; this.replaces.push(h); },
        onChange: (cb) => { this.hashListeners.add(cb); return () => this.hashListeners.delete(cb); },
      },
      startSession: (editor, hooks) => {
        const s: FakeSession = {
          editor, hooks, flushes: 0, ended: false, unsent: false, flushImpl: () => this.flushImpl(), hasUnsent: () => s.unsent,
          flush: () => { s.flushes++; this.log.push(`flush:${editor}`); return s.flushImpl(); },
          end: () => { s.ended = true; this.log.push(`end:${editor}`); },
        };
        this.sessions.push(s);
        this.log.push(`start:${editor}`);
        return s;
      },
      prepare: () => { this.log.push('prepare'); },
      ui: {
        setEditors: (l) => { this.uiList = l; },
        setCurrent: (id) => { this.current = id; },
        setSwitching: (info) => { this.switching.push(info !== null); this.switchInfos.push(info); },
        confirmDiscard: (from, to, signal) => new Promise((resolve) => {
          const c: Confirm = { from, to, resolve, aborted: false };
          signal.addEventListener('abort', () => { c.aborted = true; resolve('cancel'); });
          this.confirms.push(c);
        }),
        notify: (m) => { this.notices.push(m); },
        fatal: (m) => { this.fatals.push(m); },
      },
      sleep: (ms) => new Promise<void>((r) => { this.sleepMs.push(ms); this.sleeps.push(r); }),
    });
  }

  get live(): FakeSession | undefined { return this.sessions.filter((s) => !s.ended).at(-1); }
  userHash(h: string) { this.hash = h; for (const l of [...this.hashListeners]) l(); }
}

const L3 = list('a', ed('a'), ed('b'), ed('c'));
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
let h: Harness;
beforeEach(() => { h = undefined as unknown as Harness; });

describe('pickMaster', () => {
  it('the master, else the first active editor', () => {
    expect(pickMaster(list('b', ed('a'), ed('b')))?.id).toBe('b');
    expect(pickMaster(list('b', ed('a'), ed('b', { active: false })))?.id).toBe('a');
    expect(pickMaster(list('x', ed('a', { active: false })))).toBeUndefined();
    expect(pickMaster(null)).toBeUndefined();
  });
});

describe('start', () => {
  it('opens the editor of the hash at once (before the list arrives) and loads GET /editors with the token', async () => {
    h = new Harness('#token=tok&e=b', L3);
    const p = h.ctrl.start();
    expect(h.log).toEqual(['start:b']); // no waiting for the list
    await p;
    expect(h.fetchCalls).toEqual(['http://td:9980/editors?token=tok']);
    expect(h.uiList).toEqual(L3);
    expect(h.current).toBe('b');
    expect(h.ctrl.state()).toBe('live');
    expect(h.notices).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('without e= the master\'s own editor is opened and its tab selected when the list arrives; the hash gets e=<master>', async () => {
    h = new Harness('#token=tok', L3);
    await h.ctrl.start();
    expect(h.sessions.map((s) => s.editor)).toEqual(['']);
    expect(h.current).toBe('a');
    expect(parseHash(h.hash)).toEqual({ token: 'tok', editor: 'a' });
    expect(h.replaces.length).toBe(1);
  });

  it('an unknown editor in the hash: the master\'s editor with a notice, hash corrected, nothing to flush', async () => {
    h = new Harness('#token=tok&e=zzz', L3);
    await h.ctrl.start();
    expect(h.log).toEqual(['start:zzz']);           // one list without it: maybe transient, the requested id is kept
    expect(parseHash(h.hash).editor).toBe('zzz');
    h.live!.hooks.setEditors(L3);                    // a second list without it: given up
    await tick();
    expect(h.log).toEqual(['start:zzz', 'end:zzz', 'start:a']);
    expect(h.notices.length).toBe(1);
    expect(h.notices[0]).toMatch(/"zzz" no longer exists.*"Name-a"/);
    expect(parseHash(h.hash).editor).toBe('a');
    expect(h.current).toBe('a');
    expect(h.pushes).toEqual([]); // no history entry for the correction
  });

  it('a token rejection (403) is fatal', async () => {
    h = new Harness('#token=tok&e=a', 'forbidden');
    await h.ctrl.start();
    expect(h.fatals).toEqual([TOKEN_EXPIRED]);
  });

  it('a server that is not reachable yet still opens the session; the tabs come with the editors message', async () => {
    h = new Harness('#token=tok&e=a', 'down');
    await h.ctrl.start();
    expect(h.uiList).toBeNull();
    expect(h.live?.editor).toBe('a');
    h.live!.hooks.setEditors(L3);
    expect(h.uiList).toEqual(L3);
    expect(h.ctrl.state()).toBe('live');
  });
});

describe('switching tabs', () => {
  beforeEach(async () => {
    h = new Harness('#token=tok&e=a', L3);
    await h.ctrl.start();
    h.log.length = 0;
  });

  it('prepare, flush the old session, end it, then open the new one; the hash is pushed', async () => {
    await h.ctrl.switchTo('b');
    expect(h.log).toEqual(['prepare', 'flush:a', 'end:a', 'start:b']);
    expect(h.ctrl.current()).toBe('b');
    expect(h.current).toBe('b');
    expect(h.pushes).toEqual([buildHash({ token: 'tok', editor: 'b' })]);
    expect(h.switching).toEqual([true, false]);
    expect(h.ctrl.state()).toBe('live');
  });

  it('the new session does not start before the flush finished (edits in flight are never dropped)', async () => {
    let release!: () => void;
    h.flushImpl = () => new Promise<FlushResult>((r) => { release = () => r('ok'); });
    const p = h.ctrl.switchTo('b');
    await tick();
    expect(h.log).toEqual(['prepare', 'flush:a']);
    expect(h.ctrl.state()).toBe('switching');
    expect(h.live?.editor).toBe('a');
    release();
    await p;
    expect(h.log).toEqual(['prepare', 'flush:a', 'end:a', 'start:b']);
  });

  it('a flush that never finishes is abandoned after the timeout', async () => {
    h.flushImpl = () => new Promise<FlushResult>(() => {});
    const p = h.ctrl.switchTo('b');
    await tick();
    expect(h.log).toEqual(['prepare', 'flush:a']);
    expect(FLUSH_TIMEOUT_MS).toBeGreaterThan(1000);
    h.sleeps.shift()!(); // the timeout elapses
    await p;
    expect(h.log).toEqual(['prepare', 'flush:a', 'end:a', 'start:b']);
  });

  it('a failing flush does not block the switch', async () => {
    h.flushImpl = () => Promise.reject(new Error('upload failed'));
    await h.ctrl.switchTo('b');
    expect(h.log.at(-1)).toBe('start:b');
  });

  it('switching to the current editor does nothing', async () => {
    await h.ctrl.switchTo('a');
    expect(h.log).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('a request that arrives during a switch wins; the intermediate editor is never opened', async () => {
    let release!: () => void;
    h.flushImpl = () => new Promise<FlushResult>((r) => { release = () => r('ok'); });
    const p1 = h.ctrl.switchTo('b');
    await tick();
    const p2 = h.ctrl.switchTo('c');
    release();
    await Promise.all([p1, p2]);
    expect(h.log).toEqual(['prepare', 'flush:a', 'end:a', 'start:c']);
    expect(h.current).toBe('c');
  });

  it('after b and then back to a, each session is its own object (queues are bound to one editor)', async () => {
    await h.ctrl.switchTo('b');
    await h.ctrl.switchTo('a');
    expect(h.sessions.map((s) => [s.editor, s.ended])).toEqual([['a', true], ['b', true], ['a', false]]);
  });

  it('an inactive editor cannot be opened (notice, no switch)', async () => {
    h.live!.hooks.setEditors(list('a', ed('a'), ed('b', { active: false })));
    h.log.length = 0;
    await h.ctrl.switchTo('b');
    expect(h.log).toEqual([]);
    expect(h.notices.at(-1)).toMatch(/inactive/);
    expect(h.ctrl.current()).toBe('a');
  });

  it('a tab that vanished from the list falls back to the master with a notice', async () => {
    await h.ctrl.switchTo('b');
    h.live!.hooks.setEditors(list('a', ed('a'), ed('b')));
    h.log.length = 0;
    await h.ctrl.switchTo('gone');
    expect(h.log).toEqual(['prepare', 'flush:b', 'end:b', 'start:a']);
    expect(h.notices.at(-1)).toMatch(/"gone" no longer exists/);
  });

  it('events of a closed session are ignored', async () => {
    const old = h.live!;
    await h.ctrl.switchTo('b');
    old.hooks.onEditorGone();
    old.hooks.setEditors(list('a', ed('a'))); // b is not in it: would force a fallback if it counted
    await tick();
    expect(h.live?.editor).toBe('b');
    expect(h.ctrl.state()).toBe('live');
    expect(h.uiList).toEqual(L3);
  });
});

describe('editor deleted / deactivated while open', () => {
  beforeEach(async () => {
    h = new Harness('#token=tok&e=b', L3);
    await h.ctrl.start();
    h.log.length = 0;
  });

  it('an editors message without the current editor switches to the master with a notice (no flush: the editor is gone)', async () => {
    h.live!.hooks.setEditors(list('a', ed('a'), ed('c')));
    await tick();
    expect(h.log).toEqual([]);                       // a single list: maybe a master that has not rescanned yet
    h.live!.hooks.setEditors(list('a', ed('a'), ed('c')));
    await tick();
    expect(h.log).toEqual(['end:b', 'start:a']);
    expect(h.notices.at(-1)).toMatch(/"Name-b" no longer exists.*"Name-a"/);
    expect(parseHash(h.hash).editor).toBe('a');
    expect(h.pushes).toEqual([]);
    expect(h.current).toBe('a');
  });

  it('deactivating the current editor does the same', async () => {
    h.live!.hooks.setEditors(list('a', ed('a'), ed('b', { active: false }), ed('c')));
    h.live!.hooks.setEditors(list('a', ed('a'), ed('b', { active: false }), ed('c')));
    await tick();
    expect(h.log).toEqual(['end:b', 'start:a']);
    expect(h.notices.at(-1)).toMatch(/deactivated/);
  });

  it('if the master itself is the one that went, the first active editor is shown', async () => {
    h.live!.hooks.setEditors(list('c', ed('b'), ed('c')));
    await tick();
    expect(h.log).toEqual([]); // b is still there and active
    h.live!.hooks.setEditors(list('c', ed('c')));
    h.live!.hooks.setEditors(list('c', ed('c')));
    await tick();
    expect(h.log).toEqual(['end:b', 'start:c']);
  });

  it('a requested editor missing from ONE list is kept; it is only given up after two lists, and re-selected when it is back', async () => {
    h.live!.hooks.setEditors(list('a', ed('a'), ed('c')));
    await tick();
    expect(h.log).toEqual([]);
    h.live!.hooks.setEditors(L3);                    // it is listed again: the counter starts over
    h.live!.hooks.setEditors(list('a', ed('a'), ed('c')));
    await tick();
    expect(h.log).toEqual([]);
    h.live!.hooks.setEditors(list('a', ed('a'), ed('c')));
    await tick();
    expect(h.log).toEqual(['end:b', 'start:a']);     // fallback after two consecutive lists
    h.log.length = 0;
    h.live!.hooks.setEditors(L3);                    // b reappears: the user's choice is selected again
    await tick(20);
    expect(h.log.slice(-2)).toEqual(['end:a', 'start:b']);
    expect(parseHash(h.hash).editor).toBe('b');
  });

  it('a master change alone (failover) keeps the session', async () => {
    h.live!.hooks.setEditors(list('c', ed('a'), ed('b'), ed('c')));
    await tick();
    expect(h.log).toEqual([]);
    expect(h.uiList?.master).toBe('c');
  });

  it('close code 4404: the list is fetched again and the master\'s editor is shown', async () => {
    h.server = list('a', ed('a'), ed('c'));
    h.live!.hooks.onEditorGone();
    await tick(20);
    expect(h.log).toEqual([]);                       // first list without it: asks once more
    h.sleeps.shift()!();
    await tick(20);
    expect(h.log).toEqual(['end:b', 'start:a']);
    expect(h.notices.at(-1)).toMatch(/Name-b|"b"/);
    expect(h.ctrl.state()).toBe('live');
  });

  it('4404 while the server cannot be asked yet: keeps asking with backoff, then falls back', async () => {
    h.server = 'down';
    h.live!.hooks.onEditorGone();
    await tick(20);
    expect(h.ctrl.state()).toBe('recovering');
    expect(h.log).toEqual([]);
    h.server = list('a', ed('a'));
    h.sleeps.shift()!();
    await tick(20);
    h.sleeps.shift()!();
    await tick(20);
    expect(h.log).toEqual(['end:b', 'start:a']);
    expect(h.ctrl.state()).toBe('live');
  });

  it('4404 although the editor is in the list again: reconnects the same editor', async () => {
    h.server = L3;
    h.live!.hooks.onEditorGone();
    await tick(20);
    expect(h.log).toEqual([]); // backs off first
    h.sleeps.shift()!();
    await tick(20);
    expect(h.log).toEqual(['end:b', 'start:b']);
    expect(h.notices).toEqual([]);
  });

  it('a click on another tab while recovering wins', async () => {
    h.server = 'down';
    h.live!.hooks.onEditorGone();
    await tick(20);
    await h.ctrl.switchTo('c');
    expect(h.live?.editor).toBe('c');
    expect(h.ctrl.state()).toBe('live');
  });
});

describe('hash changes by the user (back / forward / typing)', () => {
  beforeEach(async () => {
    h = new Harness('#token=tok&e=a', L3);
    await h.ctrl.start();
    h.log.length = 0;
  });

  it('switch without writing another history entry', async () => {
    h.userHash('#token=tok&e=c');
    await tick(10);
    expect(h.log).toEqual(['prepare', 'flush:a', 'end:a', 'start:c']);
    expect(h.pushes).toEqual([]);
    expect(h.replaces).toEqual([]);
    expect(h.current).toBe('c');
  });

  it('the same editor, or a token-only hash, does nothing', async () => {
    h.userHash('#token=tok&e=a');
    h.userHash('#token=tok');
    await tick(10);
    expect(h.log).toEqual([]);
  });

  it('an unknown editor: the master is shown and the hash is corrected', async () => {
    await h.ctrl.switchTo('b');
    h.log.length = 0;
    h.userHash('#token=tok&e=nope');
    await tick(10);
    expect(h.log).toEqual(['prepare', 'flush:b', 'end:b', 'start:a']);
    expect(parseHash(h.hash).editor).toBe('a');
    expect(h.notices.at(-1)).toMatch(/"nope" no longer exists/);
  });

  it('typing garbage for the current editor corrects the hash', async () => {
    h.userHash('#token=tok&e=nope');
    await tick(10);
    expect(h.log).toEqual([]); // a is the master and already shown
    expect(parseHash(h.hash).editor).toBe('a');
  });

  it('stops listening after dispose', async () => {
    h.ctrl.dispose();
    expect(h.hashListeners.size).toBe(0);
    expect(h.live).toBeUndefined();
    expect(h.ctrl.state()).toBe('disposed');
    await h.ctrl.switchTo('b');
    expect(h.log).toEqual(['end:a']);
  });
});

describe('v10 review: unsent changes while TouchDesigner is not linked', () => {
  beforeEach(async () => {
    h = new Harness('#token=tok&e=a', L3);
    await h.ctrl.start();
    h.log.length = 0;
  });

  it('a flush that could not send asks first: the old session stays open while the dialog is up', async () => {
    h.flushImpl = () => Promise.resolve('dropped');
    const p = h.ctrl.switchTo('b');
    await tick(10);
    expect(h.confirms.length).toBe(1);
    expect(h.confirms[0]).toMatchObject({ from: 'Name-a', to: 'Name-b' });
    expect(h.log).toEqual(['prepare', 'flush:a']); // nothing closed yet
    expect(h.live?.editor).toBe('a');
    h.confirms[0].resolve('discard');
    await p;
    expect(h.log).toEqual(['prepare', 'flush:a', 'end:a', 'start:b']);
    expect(h.notices.at(-1)).toMatch(/Unsent changes of "Name-a" were discarded/);
  });

  it('Wait: stays, shows the waiting state, flushes again when linked and then switches by itself', async () => {
    let linked = false;
    h.flushImpl = () => Promise.resolve(linked ? 'ok' : 'dropped');
    const p = h.ctrl.switchTo('b');
    await tick(10);
    h.confirms[0].resolve('wait');
    await tick(10);
    expect(h.switchInfos.at(-1)).toEqual({ to: 'Name-b', waiting: true });
    expect(h.log).toEqual(['prepare', 'flush:a']);
    h.sleeps.pop()!(); // poll: still not linked
    await tick(10);
    expect(h.log.filter((x) => x === 'flush:a').length).toBe(2);
    expect(h.live?.editor).toBe('a');
    linked = true;
    h.sleeps.pop()!();
    await p;
    expect(h.log.slice(-2)).toEqual(['end:a', 'start:b']);
    expect(h.confirms.length).toBe(1); // asked once
    expect(h.switchInfos.at(-1)).toBeNull();
    expect(h.notices).toEqual([]); // nothing was lost
  });

  it('going back to the current tab while waiting cancels the switch (no reload, dialog closed)', async () => {
    h.flushImpl = () => Promise.resolve('dropped');
    const p = h.ctrl.switchTo('b');
    await tick(10);
    const back = h.ctrl.switchTo('a');
    await Promise.all([p, back]);
    expect(h.confirms[0].aborted).toBe(true);
    expect(h.log).toEqual(['prepare', 'flush:a']);
    expect(h.live?.editor).toBe('a');
    expect(h.sessions.length).toBe(1);
    expect(h.ctrl.state()).toBe('live');
    expect(h.switchInfos.at(-1)).toBeNull();
    expect(h.pushes).toEqual([]);
  });

  it('A -> B -> A during a slow flush cancels instead of reopening A', async () => {
    let release!: () => void;
    h.flushImpl = () => new Promise<FlushResult>((r) => { release = () => r('ok'); });
    const p = h.ctrl.switchTo('b');
    await tick(10);
    const back = h.ctrl.switchTo('a');
    release();
    await Promise.all([p, back]);
    expect(h.log).toEqual(['prepare', 'flush:a']);
    expect(h.sessions.length).toBe(1);
    expect(h.ctrl.current()).toBe('a');
  });

  it('a flush timeout tells the user and switches anyway', async () => {
    h.flushImpl = () => new Promise<FlushResult>(() => {});
    const p = h.ctrl.switchTo('b');
    await tick(10);
    h.sleeps.shift()!();
    await p;
    expect(h.notices.at(-1)).toMatch(/did not confirm the changes of "Name-a" in time/);
    expect(h.live?.editor).toBe('b');
  });

  it('the switching state names the target', async () => {
    await h.ctrl.switchTo('c');
    expect(h.switchInfos[0]).toEqual({ to: 'Name-c', waiting: false });
    expect(h.switchInfos.at(-1)).toBeNull();
  });

  it('a fallback that drops unsent edits says so', async () => {
    h.live!.unsent = true;
    h.live!.hooks.setEditors(list('b', ed('b'), ed('c')));
    h.live!.hooks.setEditors(list('b', ed('b'), ed('c')));
    await tick(10);
    expect(h.log).toEqual(['end:a', 'start:b']);
    expect(h.notices.at(-1)).toMatch(/no longer exists.*unsent changes of "Name-a" were lost/);
  });

  it('4404 backoff per editor id grows on consecutive 4404s and a hello resets it', async () => {
    h.server = L3; // the editor is listed but its socket keeps being closed with 4404
    const gone = async () => { h.live!.hooks.onEditorGone(); await tick(20); };
    await gone();
    expect(h.sleepMs).toEqual([500]);
    h.sleeps.shift()!();
    await tick(20);
    expect(h.log).toEqual(['end:a', 'start:a']);
    await gone();
    expect(h.sleepMs).toEqual([500, 1000]);
    h.sleeps.shift()!();
    await tick(20);
    await gone();
    expect(h.sleepMs.at(-1)).toBe(2000);
    h.sleeps.shift()!();
    await tick(20);
    h.live!.hooks.onLinked!(); // hello: the editor is fine again
    await gone();
    expect(h.sleepMs.at(-1)).toBe(500);
    // other editors have their own backoff
    h.sleeps.shift()!();
    await tick(20);
    await h.ctrl.switchTo('b');
    await gone();
    expect(h.sleepMs.at(-1)).toBe(500);
  });
});
