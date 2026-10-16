// v10 (DESIGN_V8): one live editor session at a time; a tab click tears the current session down cleanly and opens another.
// Pure state machine: everything environment-specific (engine, bridge, hash / history, fetch, timers) comes in through `deps`.
import { readEditorList, type EditorInfo, type EditorList } from './codec';
import type { FlushResult } from './tdBridge';
import { buildHash, editorsUrl, parseHash } from './urls';

export const TOKEN_EXPIRED = 'Reopen from TouchDesigner — session expired';
export const FLUSH_TIMEOUT_MS = 20000;
/** A requested editor missing from the list is only given up after this long or two consecutive lists without it (a master that just (re)started may publish an incomplete list). */
const ABSENT_GRACE_MS = 6000;
const LIST_TIMEOUT_MS = 8000, RETRY_MIN = 500, RETRY_MAX = 5000, WAIT_POLL_MS = 500;

/** What the controller needs from one running editor session (engine + bridge + store wiring). */
export interface EditorSession {
  /** The editor id the session's WebSocket and HTTP requests are bound to ('' = the master's own editor). */
  readonly editor: string;
  /** Send everything pending and upload the history (Bridge.flush). */
  flush(): Promise<FlushResult>;
  /** Edits exist that TD does not have (made while disconnected, or still queued). */
  hasUnsent?(): boolean;
  /** Close the WebSocket, abort fetches, dispose the engine. Called once, after flush. */
  end(): void;
}

export interface SessionHooks {
  /** The session's bridge got an `editors` message. */
  setEditors(list: EditorList): void;
  /** The session's WebSocket was closed with 4404. */
  onEditorGone(): void;
  /** The session got TD's hello (it is linked): the 4404 backoff of its editor starts over. */
  onLinked?(): void;
}

export interface NavPort {
  hash(): string;
  /** history.pushState / replaceState with a new hash (neither fires `hashchange`). */
  push(hash: string): void;
  replace(hash: string): void;
  /** The user changed the hash (back / forward / typing). Returns the unsubscribe function. */
  onChange(cb: () => void): () => void;
}

export interface ControllerDeps {
  origin: string;
  token: string;
  fetch: typeof fetch;
  nav: NavPort;
  startSession(editor: string, hooks: SessionHooks): EditorSession;
  /** Before the old session is flushed: commit floating selection / text / pending drafts. */
  prepare?(): void | Promise<void>;
  ui: {
    setEditors(list: EditorList): void;
    setCurrent(id: string): void;
    /** A switch is in progress (null = none): the UI blocks editing and shows "Switching to <name>…". `waiting` = held until TD is linked again. */
    setSwitching(info: { to: string; waiting: boolean } | null): void;
    /** The old editor has edits TD cannot receive now. 'cancel' = the signal was aborted (the switch was cancelled). */
    confirmDiscard(from: string, to: string, signal: AbortSignal): Promise<'wait' | 'discard' | 'cancel'>;
    notify(msg: string): void;
    fatal(msg: string): void;
  };
  sleep?(ms: number): Promise<void>;
  flushTimeoutMs?: number;
}

export type ControllerState = 'idle' | 'starting' | 'live' | 'switching' | 'recovering' | 'disposed';
type HashMode = 'push' | 'replace' | 'none';

export interface EditorController {
  start(): Promise<void>;
  /** Switch to another editor (tab click, hashchange). Resolves when the switch (and any later one queued meanwhile) is done. */
  switchTo(id: string, mode?: HashMode): Promise<void>;
  state(): ControllerState;
  /** The editor id of the live session ('' = the master's own editor, not known by id). */
  current(): string;
  dispose(): void;
}

/** The editor to show when the wanted one is not available: the master, else the first active one. */
export function pickMaster(list: EditorList | null): EditorInfo | undefined {
  if (!list) return undefined;
  return list.editors.find((e) => e.id === list.master && e.active) ?? list.editors.find((e) => e.active);
}

const q = (s: string) => `"${s}"`;

export function createEditorController(deps: ControllerDeps): EditorController {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let state: ControllerState = 'idle';
  let session: EditorSession | null = null;
  let current = '';
  let gen = 0; // identifies the live session: hook calls from older ones are ignored
  let list: EditorList | null = null;
  let pending: { id: string; mode: HashMode; skipFlush: boolean; force: boolean } | null = null;
  let draining: Promise<void> | null = null;
  let offNav: (() => void) | null = null;
  let cancelled = false; // the user went back to the editor that is still open: the pending switch is dropped
  let abortSwitch: AbortController | null = null;
  let missingLists = 0; // consecutive lists without the current editor (or listing it inactive)
  let missingTimer: ReturnType<typeof setTimeout> | null = null;
  let wantedId = ''; // the editor the user asked for (URL hash / tab click): re-selected when it reappears after a fallback
  let fellBack = false;
  const goneDelay = new Map<string, number>(); // per editor id: backoff for consecutive 4404s, reset by a hello
  const token = deps.token;

  const nameOf = (id: string) => list?.editors.find((e) => e.id === id)?.name ?? id;
  const byId = (id: string) => list?.editors.find((e) => e.id === id);

  async function fetchList(): Promise<EditorList | 'forbidden' | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
    try {
      const res = await deps.fetch(editorsUrl(deps.origin, token), { cache: 'no-store', signal: ctrl.signal });
      if (res.status === 403) return 'forbidden';
      if (!res.ok) return null;
      return readEditorList(await res.json());
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  function setList(next: EditorList) {
    list = next;
    deps.ui.setEditors(next);
  }

  function writeHash(id: string, mode: HashMode) {
    if (mode === 'none') return;
    const h = buildHash({ token, editor: id });
    if (h === deps.nav.hash()) return;
    if (mode === 'push') deps.nav.push(h); else deps.nav.replace(h);
  }

  function open(id: string, mode: HashMode) {
    const g = ++gen;
    const hooks: SessionHooks = {
      setEditors: (l) => { if (g === gen) onEditors(l); },
      onEditorGone: () => { if (g === gen) onGone(); },
      onLinked: () => { if (g === gen) goneDelay.delete(id); },
    };
    session = deps.startSession(id, hooks);
    current = id;
    deps.ui.setCurrent(id || list?.master || '');
    writeHash(id || list?.master || '', mode);
    state = 'live';
  }

  /** The editor to open for `wanted`, with the notice to show when it had to be replaced by the master's. */
  function resolve(wanted: string): { id: string; notice?: string } {
    const m = pickMaster(list);
    if (!list) return { id: wanted };
    if (wanted) {
      const e = byId(wanted);
      if (e && e.active) return { id: wanted };
      if (!m || m.id === wanted) return { id: m?.id ?? wanted };
      return { id: m.id, notice: e ? `Editor ${q(e.name)} is inactive - showing ${q(m.name)}` : `Editor ${q(wanted)} no longer exists - showing ${q(m.name)}` };
    }
    return { id: m?.id ?? '' };
  }

  let startP: Promise<void> | null = null;
  /** Opens the session for the editor in the URL hash at once (an unknown one is closed by TD with 4404 / missing from the list: then the master's is shown), and loads the tab list in parallel. */
  function start(): Promise<void> {
    if (state !== 'idle') return startP ?? Promise.resolve();
    state = 'starting';
    offNav = deps.nav.onChange(onHashChange);
    wantedId = parseHash(deps.nav.hash()).editor;
    open(wantedId, 'none');
    return (startP = (async () => {
      const got = await fetchList();
      if ((state as ControllerState) === 'disposed') return;
      if (got === 'forbidden') { deps.ui.fatal(TOKEN_EXPIRED); return; }
      if (got) onEditors(got);
      await settle();
    })());
  }

  type Request = { id: string; mode: HashMode; skipFlush: boolean; force: boolean };
  interface Plan { target: string; mode: HashMode; skipFlush: boolean }

  /** What a request comes to: the editor to open (the master's when the wanted one is gone / inactive) and how to write the hash; null = nothing to do. */
  function plan(req: Request, reopen = false): Plan | null {
    let target = req.id;
    let mode = req.mode;
    const r = resolve(req.id);
    if (r.id !== req.id) { target = r.id; mode = 'replace'; if (r.notice) deps.ui.notify(r.notice); }
    if (!reopen && !req.force && target === current && state === 'live') {
      if (mode !== 'none' || r.id !== req.id) writeHash(current || list?.master || '', 'replace'); // e.g. an invalid hash typed by the user
      return null;
    }
    return { target, mode, skipFlush: req.skipFlush };
  }

  const flushBounded = async (old: EditorSession): Promise<FlushResult> =>
    Promise.race([old.flush().catch((): FlushResult => 'ok'), sleep(deps.flushTimeoutMs ?? FLUSH_TIMEOUT_MS).then((): FlushResult => 'timeout')]);

  /** Held switch: poll until the old session can flush (TD linked again) or the switch is cancelled. */
  async function flushWhenLinked(old: EditorSession, signal: AbortSignal): Promise<FlushResult> {
    for (;;) {
      await sleep(WAIT_POLL_MS);
      if (signal.aborted || state === 'disposed') return 'ok';
      const r = await old.flush().catch((): FlushResult => 'ok');
      if (r !== 'dropped') return r;
    }
  }

  async function doSwitch(req: Request): Promise<void> {
    let p = plan(req);
    if (!p) return;
    state = 'switching';
    cancelled = false;
    const ctl = (abortSwitch = new AbortController());
    deps.ui.setSwitching({ to: nameOf(p.target), waiting: false });
    let aftermath = '';
    try {
      const old = session;
      if (old) {
        const oldName = nameOf(current);
        if (!p.skipFlush) {
          try { await deps.prepare?.(); } catch { /* best effort */ }
          let res = await flushBounded(old);
          if (res === 'timeout') aftermath = `TouchDesigner did not confirm the changes of ${q(oldName)} in time - switched anyway`;
          while (res === 'dropped' && !cancelled && state === 'switching') {
            const choice = await deps.ui.confirmDiscard(oldName, nameOf(p.target), ctl.signal);
            if (choice === 'discard') { aftermath = `Unsent changes of ${q(oldName)} were discarded`; break; }
            if (choice === 'cancel' || cancelled || state !== 'switching') break;
            deps.ui.setSwitching({ to: nameOf(p.target), waiting: true });
            res = await flushWhenLinked(old, ctl.signal);
            deps.ui.setSwitching({ to: nameOf(p.target), waiting: false });
          }
        }
        if (state !== 'switching') return; // disposed meanwhile
        if (cancelled) return; // back on the editor that is still open: nothing was closed
        session = null;
        gen++; // events of the closing session are void
        old.end();
      }
      // a newer request arrived while the old session was flushed: open that one directly
      if (pending) {
        const next = pending;
        pending = null;
        p = plan(next, true) ?? p;
      }
      open(p.target, p.mode);
      if (aftermath) deps.ui.notify(aftermath);
    } finally {
      if (abortSwitch === ctl) abortSwitch = null;
      if (state === 'switching') state = 'live';
      deps.ui.setSwitching(null);
    }
  }

  function settle(): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
      await Promise.resolve(); // `draining` must be assigned before the loop can finish
      try {
        while (pending && state !== 'disposed') {
          const p = pending;
          pending = null;
          await doSwitch(p);
        }
      } finally {
        draining = null;
      }
      verifyCurrent();
    })();
    return draining;
  }

  function switchTo(id: string, mode: HashMode = 'push'): Promise<void> {
    if (state === 'disposed') return Promise.resolve();
    // A -> B -> A while B is still pending: the old session is still open, so the switch is simply cancelled (no reload)
    if (state === 'switching' && session && id === current) {
      pending = null;
      cancelled = true;
      abortSwitch?.abort();
      return draining ?? Promise.resolve();
    }
    wantedId = id;
    fellBack = false;
    pending = { id, mode, skipFlush: false, force: false };
    if (state === 'starting') return startP ?? Promise.resolve(); // run() settles it once the first session is open
    return settle();
  }

  /** The live session's editor was deleted / deactivated: go to the master's. */
  function clearMissing() {
    missingLists = 0;
    if (missingTimer) { clearTimeout(missingTimer); missingTimer = null; }
  }

  /** `newList`: called for a freshly received list (counts as one more miss); the grace timer calls it with `grace`. */
  function verifyCurrent(newList = false, grace = false) {
    if (state !== 'live' || !list || !current) return;
    const e = byId(current);
    if (e && e.active) { clearMissing(); return; }
    if (!grace) {
      if (newList) missingLists++;
      if (missingLists < 2) {   // maybe transient: look again at the next list, or when the grace period is over
        if (!missingTimer) missingTimer = setTimeout(() => { missingTimer = null; verifyCurrent(false, true); }, ABSENT_GRACE_MS);
        return;
      }
    }
    clearMissing();
    const m = pickMaster(list);
    if (!m) return; // nothing to show: wait for the next list
    const lost = session?.hasUnsent?.() ? ` (unsent changes of ${q(e?.name ?? nameGone)} were lost)` : '';
    deps.ui.notify((e ? `Editor ${q(e.name)} was deactivated - showing ${q(m.name)}` : `Editor ${q(nameGone)} no longer exists - showing ${q(m.name)}`) + lost);
    fellBack = true;
    pending = { id: m.id, mode: 'replace', skipFlush: true, force: false };
    void settle();
  }
  let nameGone = '';

  function onEditors(next: EditorList) {
    const prevName = current ? nameOf(current) : '';
    setList(next);
    if (current && byId(current)) nameGone = '';
    else if (current && !nameGone) nameGone = prevName;   // (the first list without it knows the name; later ones do not)
    if (!current && state === 'live') { // the session is bound to "the master's own editor": show its tab
      deps.ui.setCurrent(next.master);
      writeHash(next.master, 'replace');
    }
    if (state === 'live') {
      if (fellBack && wantedId && wantedId !== current) {   // the editor the user asked for is back: return to it
        const w = byId(wantedId);
        if (w && w.active) {
          fellBack = false;
          deps.ui.notify(`Editor ${q(w.name)} is back`);
          pending = { id: wantedId, mode: 'replace', skipFlush: false, force: false };
          void settle();
          return;
        }
      }
      verifyCurrent(true);
    }
  }

  /** 4404 on the current session's socket. */
  function onGone() {
    if (state !== 'live') return;
    const goneId = current;
    nameGone = nameOf(goneId);
    state = 'recovering';
    const goneAt = Date.now();
    missingLists = 0;
    const grown = Math.min(RETRY_MAX, (goneDelay.get(goneId) ?? RETRY_MIN / 2) * 2); // consecutive 4404s of one editor back off; a hello resets it
    goneDelay.set(goneId, grown);
    void (async () => {
      let delay = RETRY_MIN;
      for (;;) {
        const got = await fetchList();
        if (state !== 'recovering') return;
        if (got === 'forbidden') { deps.ui.fatal(TOKEN_EXPIRED); return; }
        if (got) {
          setList(got);
          const e = byId(goneId);
          if (e && e.active) { // it is listed again: reconnect, but not faster than the backoff of this editor allows
            await sleep(grown);
            if (state !== 'recovering') return;
            state = 'live';
            pending = { id: goneId, mode: 'none', skipFlush: true, force: true };
            void settle();
            return;
          }
          if (pickMaster(got)) {
            missingLists++;   // not listed (yet): only give it up after two lists or the grace period
            if (missingLists >= 2 || Date.now() - goneAt >= ABSENT_GRACE_MS) { state = 'live'; missingLists = 1; verifyCurrent(true); return; }
          }
          // no editor to fall back to yet: keep asking
        }
        await sleep(delay);
        delay = Math.min(RETRY_MAX, delay * 2);
      }
    })();
  }

  function onHashChange() {
    if (state === 'disposed' || state === 'idle' || state === 'starting') return;
    const wanted = parseHash(deps.nav.hash()).editor || pickMaster(list)?.id || '';
    if (wanted && wanted !== (current || list?.master)) void switchTo(wanted, 'none');
  }

  return {
    start,
    switchTo,
    state: () => state,
    current: () => current,
    dispose() {
      if (state === 'disposed') return;
      state = 'disposed';
      offNav?.();
      abortSwitch?.abort();
      clearMissing();
      const s = session;
      session = null;
      gen++;
      s?.end();
    },
  };
}
