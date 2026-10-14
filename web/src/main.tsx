import { render } from 'preact';
import { startMockBridge, useMockBridge } from './bridge/mockBridge';
import { startTdBridge, type Bridge } from './bridge/tdBridge';
import { createDocument } from './state/boot';
import { installKeyboard } from './state/keyboard';
import { store } from './state/store';
import { installTestHook } from './state/testHook';
import { App } from './ui/App';
import './ui/styles.css';

const DEFAULT_W = 1920, DEFAULT_H = 1080;

function boot() {
  const engine = createDocument(DEFAULT_W, DEFAULT_H);
  store.attach(engine);
  installKeyboard(store);

  const status = {
    setConnection: store.setConnection, setActive: store.setActive, setNotice: store.setNotice, setFatal: store.setFatal,
    docName: store.docName,
  };
  let bridge: Bridge;
  if (useMockBridge(location.search, import.meta.env.DEV)) {
    bridge = startMockBridge(engine, status);
  } else {
    store.docName.value = 'raster_editor';
    bridge = startTdBridge(engine, status);
  }
  store.takeover = bridge.takeover;

  if (new URLSearchParams(location.search).get('test') === '1') installTestHook(store);
  render(<App />, document.getElementById('app')!);
}

boot();
