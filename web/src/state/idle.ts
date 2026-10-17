// v10 (DESIGN_V10): idle detection. A page is idle when its tab is hidden, or after IDLE_MS without user input while visible.
// Pure of the store: environment (document, window, timers) comes in as arguments so it can be tested with fake timers.

export const IDLE_MS = 10_000;
/** Per-viewer "never idle" toggle. */
export const KEEP_LIVE_KEY = 'raster-editor.keepLive';

export function loadKeepLive(): boolean {
  try { return localStorage.getItem(KEEP_LIVE_KEY) === '1'; } catch { return false; }
}
export function saveKeepLive(on: boolean): void {
  try { localStorage.setItem(KEEP_LIVE_KEY, on ? '1' : '0'); } catch { /* storage may be blocked */ }
}

/** Events that count as user input. */
export const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'keyup', 'wheel', 'touchstart', 'touchmove'] as const;

export interface IdleEnv {
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

export interface IdleDetector {
  idle(): boolean;
  dispose(): void;
}

/** Calls `onChange(idle)` only when the idle state flips. Starts active (the page was just loaded / opened). */
export function createIdleDetector(onChange: (idle: boolean) => void, env?: Partial<IdleEnv>, timeoutMs = IDLE_MS): IdleDetector {
  const doc = env?.doc ?? document, win = env?.win ?? window;
  const setT = env?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)), clearT = env?.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let idle = false, timer: unknown = null;
  const set = (v: boolean) => { if (v !== idle) { idle = v; onChange(v); } };
  const arm = () => {
    if (timer !== null) clearT(timer);
    timer = setT(() => { timer = null; set(true); }, timeoutMs);
  };
  const onActivity = () => {
    if (doc.visibilityState === 'hidden') return; // synthetic / background input in a hidden tab does not wake it
    set(false);
    arm();
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      if (timer !== null) { clearT(timer); timer = null; }
      set(true);
    } else {
      set(false);
      arm();
    }
  };
  for (const e of ACTIVITY_EVENTS) win.addEventListener(e, onActivity, { capture: true, passive: true } as AddEventListenerOptions);
  doc.addEventListener('visibilitychange', onVisibility);
  if (doc.visibilityState === 'hidden') set(true); else arm();
  return {
    idle: () => idle,
    dispose() {
      if (timer !== null) clearT(timer);
      timer = null;
      for (const e of ACTIVITY_EVENTS) win.removeEventListener(e, onActivity, { capture: true } as EventListenerOptions);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
