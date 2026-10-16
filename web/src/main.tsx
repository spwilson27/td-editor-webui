import { effect } from '@preact/signals';
import { render } from 'preact';
import { createEditorController, type EditorSession, type SessionHooks } from './bridge/editorSessions';
import { startMockBridge, useMockBridge } from './bridge/mockBridge';
import { resolveToken, resolveWsUrl, httpOrigin, startTdBridge, type BridgeStatus } from './bridge/tdBridge';
import { createDocument } from './state/boot';
import { installKeyboard } from './state/keyboard';
import { installDropGuard, installPaste } from './state/paste';
import { store } from './state/store';
import { installTestHook } from './state/testHook';
import { App } from './ui/App';
import './ui/styles.css';

const DEFAULT_W = 1920, DEFAULT_H = 1080;
const ENGINE_DISPOSE_DELAY_MS = 200; // the old App tree is unmounted by then

/** The App is keyed by the session epoch: a new editor session (new engine) remounts everything that bound to the old engine. */
function Root() {
  return <App key={store.sessionEpoch.value} />;
}

function statusFor(live: () => boolean): BridgeStatus {
  const gate = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { if (live()) fn(...a); };
  return {
    setConnection: gate(store.setConnection), setActive: gate(store.setActive), setNotice: gate(store.setNotice), setFatal: gate(store.setFatal),
    setLoading: gate(store.setLoading), setLatency: gate(store.setLatency), setViewLatency: gate(store.setViewLatency), setViewFrame: gate(store.setViewFrame),
    setFonts: gate(store.setFonts), setInputs: gate(store.setInputs), setFiles: gate(store.setFiles), onFileResult: gate(store.onFileResult),
    setLayerPreview: gate(store.setLayerPreview), clearLayerPreviews: gate(store.clearLayerPreviews),
  };
}

/** One editor session: a fresh engine attached to the store plus a bridge bound to `editor`. */
function startSession(editor: string, token: string, hooks: SessionHooks): EditorSession {
  const engine = createDocument(DEFAULT_W, DEFAULT_H);
  store.attach(engine);
  store.sessionEpoch.value++;
  let live = true;
  const base = statusFor(() => live);
  const status: BridgeStatus = { ...base, setConnection: (c) => { base.setConnection(c); if (live && c === 'linked') hooks.onLinked?.(); }, setEditors: (l) => { if (live) hooks.setEditors(l); }, onEditorGone: () => { if (live) hooks.onEditorGone(); } };
  const bridge = startTdBridge(engine, status, { editor, token });
  store.takeover = bridge.takeover;
  store.bridge = bridge;
  const stopView = effect(() => {
    const v = store.view.value, r = store.viewRect.value;
    bridge.setView({ mode: store.viewMode.value, zoom: v.zoom, panX: v.x, panY: v.y, rect: r });
  });
  return {
    editor,
    flush: () => bridge.flush?.() ?? Promise.resolve('ok' as const),
    hasUnsent: () => bridge.hasUnsent?.() ?? false,
    end() {
      live = false;
      stopView();
      store.endSessionState(); // the old engine is still attached here
      bridge.dispose();
      store.bridge = null;
      store.takeover = null;
      setTimeout(() => engine.dispose(), ENGINE_DISPOSE_DELAY_MS);
    },
  };
}

function boot() {
  installKeyboard(store);
  installPaste(store);
  installDropGuard();
  const root = document.getElementById('app')!;

  if (useMockBridge(location.search, import.meta.env.DEV)) {
    const engine = createDocument(DEFAULT_W, DEFAULT_H);
    store.attach(engine);
    store.sessionEpoch.value++;
    const bridge = startMockBridge(engine, { ...statusFor(() => true), docName: store.docName });
    store.takeover = bridge.takeover;
    store.bridge = bridge;
    effect(() => {
      const v = store.view.value, r = store.viewRect.value;
      bridge.setView({ mode: store.viewMode.value, zoom: v.zoom, panX: v.x, panY: v.y, rect: r });
    });
  } else {
    store.docName.value = 'raster_editor';
    const token = resolveToken(location.search, location.hash);
    const keep = () => location.pathname + location.search;
    const controller = createEditorController({
      origin: httpOrigin(resolveWsUrl(location.search, location)),
      token,
      fetch: (...a) => fetch(...a),
      nav: {
        hash: () => location.hash,
        push: (h) => history.pushState(null, '', keep() + h),
        replace: (h) => history.replaceState(null, '', keep() + h),
        onChange: (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); },
      },
      startSession: (editor, hooks) => startSession(editor, token, hooks),
      prepare: async () => { store.commitPending(); await new Promise<void>((r) => setTimeout(r, 40)); },
      ui: {
        setEditors: store.setEditorList,
        setCurrent: (id) => { store.editorId.value = id; },
        setSwitching: (info) => store.setSwitching(info),
        confirmDiscard: (from, to, signal) => store.askDiscard(from, to, signal),
        notify: (m) => store.holdNotice(m),
        fatal: store.setFatal,
      },
    });
    store.switchEditor = (id) => { void controller.switchTo(id); };
    void controller.start();
  }

  if (new URLSearchParams(location.search).get('test') === '1') installTestHook(store);
  render(<Root />, root);
}

boot();
