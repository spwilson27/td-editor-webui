import { useEffect, useRef } from 'preact/hooks';
import { store } from '../state/store';
import { ContextBar } from './ContextBar';
import { DocTabs } from './DocTabs';
import { BigDocNotice } from './BigDocNotice';
import { CanvasSizeDialog } from './CanvasSizeDialog';
import { FileDialog } from './FileDialog';
import { SelectionOpDialog } from './SelectionOpDialog';
import { ImportTopDialog } from './ImportTopDialog';
import { LoadingOverlay, StandbyOverlay } from './StandbyOverlay';
import { Studio } from './Studio';
import { DiscardDialog, SwitchOverlay } from './SwitchOverlay';
import { StatusBar } from './StatusBar';
import { ToolRail } from './ToolRail';
import { TopBar } from './TopBar';
import { ViewportFrame } from './Rulers';

export function App() {
  const sw = store.editorSwitching.value;
  const inert = { style: 'display:contents', ...({ inert: sw } as object) };
  const place = useRef<HTMLInputElement>(null);
  useEffect(() => {
    store.openPlace = () => place.current?.click();
    return () => { store.openPlace = null; };
  }, []);
  return (
    <div data-app-root style={`position:relative;width:100%;height:100vh;display:flex;flex-direction:column;background:#262626;color:#e3e3e3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;font-size:12px;overflow:hidden`}>
      <div {...inert}><TopBar /></div>
      <div {...inert}><ContextBar /></div>
      <BigDocNotice />
      <div style="flex:1 1 auto;min-height:0;display:flex">
        <div {...inert}><ToolRail /></div>
        <div style={`flex:999 1 480px;min-width:0;display:flex;flex-direction:column;background:#1c1c1c`}>
          <DocTabs />
          <div {...inert}><ViewportFrame /></div>
        </div>
        <div {...inert}><Studio /></div>
      </div>
      <StatusBar />
      <input ref={place} type="file" accept="image/*" multiple hidden data-place-input aria-hidden="true" tabIndex={-1}
        onChange={(e) => { const i = e.target as HTMLInputElement; const files = [...(i.files ?? [])]; i.value = ''; void store.importFiles(files); }} />
      <ImportTopDialog />
      <CanvasSizeDialog />
      <SelectionOpDialog />
      <FileDialog />
      <LoadingOverlay />
      <StandbyOverlay />
      <SwitchOverlay />
      <DiscardDialog />
    </div>
  );
}
