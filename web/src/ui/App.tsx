import { useEffect, useRef } from 'preact/hooks';
import { store } from '../state/store';
import { ContextBar } from './ContextBar';
import { DocTabs } from './DocTabs';
import { ImportTopDialog } from './ImportTopDialog';
import { LoadingOverlay, StandbyOverlay } from './StandbyOverlay';
import { Studio } from './Studio';
import { StatusBar } from './StatusBar';
import { ToolRail } from './ToolRail';
import { TopBar } from './TopBar';
import { Viewport } from './Viewport';

export function App() {
  const clear = store.tdPanel.value;
  const place = useRef<HTMLInputElement>(null);
  useEffect(() => {
    store.openPlace = () => place.current?.click();
    return () => { store.openPlace = null; };
  }, []);
  return (
    <div data-app-root style={`position:relative;width:100%;height:100vh;display:flex;flex-direction:column;background:${clear ? 'transparent' : '#262626'};color:#e3e3e3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;font-size:12px;overflow:hidden`}>
      <TopBar />
      <ContextBar />
      <div style="flex:1 1 auto;min-height:0;display:flex">
        <ToolRail />
        <div style={`flex:999 1 480px;min-width:0;display:flex;flex-direction:column;background:${clear ? 'transparent' : '#1c1c1c'}`}>
          <DocTabs />
          <Viewport />
        </div>
        <Studio />
      </div>
      <StatusBar />
      <input ref={place} type="file" accept="image/*" multiple hidden data-place-input aria-hidden="true" tabIndex={-1}
        onChange={(e) => { const i = e.target as HTMLInputElement; const files = [...(i.files ?? [])]; i.value = ''; void store.importFiles(files); }} />
      <ImportTopDialog />
      <LoadingOverlay />
      <StandbyOverlay />
    </div>
  );
}
