import { effect } from '@preact/signals';
import { render } from 'preact';
import { startMockBridge, useMockBridge } from './bridge/mockBridge';
import { resolveClient, startTdBridge, type Bridge } from './bridge/tdBridge';
import { createDocument } from './state/boot';
import { installKeyboard } from './state/keyboard';
import { installDropGuard, installPaste } from './state/paste';
import { store } from './state/store';
import { installTestHook } from './state/testHook';
import { App } from './ui/App';
import './ui/styles.css';

const DEFAULT_W = 1920, DEFAULT_H = 1080;

function boot() {
  const engine = createDocument(DEFAULT_W, DEFAULT_H);
  store.attach(engine);
  installKeyboard(store);
  installPaste(store);
  installDropGuard();

  const status = {
    setConnection: store.setConnection, setActive: store.setActive, setNotice: store.setNotice, setFatal: store.setFatal,
    setLoading: store.setLoading, setLatency: store.setLatency, setViewLatency: store.setViewLatency, setViewFrame: store.setViewFrame,
    setFonts: store.setFonts, docName: store.docName,
    setInputs: store.setInputs, setFiles: store.setFiles, onFileResult: store.onFileResult,
  };
  store.clientKind.value = resolveClient(location.search);
  let bridge: Bridge;
  if (useMockBridge(location.search, import.meta.env.DEV)) {
    bridge = startMockBridge(engine, status);
  } else {
    store.docName.value = 'raster_editor';
    bridge = startTdBridge(engine, status);
  }
  store.takeover = bridge.takeover;
  store.bridge = bridge;
  effect(() => {
    const v = store.view.value, r = store.viewRect.value;
    bridge.setView({ mode: store.viewMode.value, zoom: v.zoom, panX: v.x, panY: v.y, rect: r });
  });
  effect(() => { document.documentElement.toggleAttribute('data-td-panel', store.tdPanel.value); });

  if (new URLSearchParams(location.search).get('test') === '1') installTestHook(store);
  render(<App />, document.getElementById('app')!);
}

boot();
