import { ContextBar } from './ContextBar';
import { DocTabs } from './DocTabs';
import { StandbyOverlay } from './StandbyOverlay';
import { Studio } from './Studio';
import { StatusBar } from './StatusBar';
import { ToolRail } from './ToolRail';
import { TopBar } from './TopBar';
import { Viewport } from './Viewport';

export function App() {
  return (
    <div style="position:relative;width:100%;height:100vh;min-height:720px;display:flex;flex-direction:column;background:#262626;color:#e3e3e3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;font-size:12px;overflow:hidden">
      <TopBar />
      <ContextBar />
      <div style="flex:1 1 auto;min-height:0;display:flex">
        <ToolRail />
        <div style="flex:999 1 480px;min-width:0;display:flex;flex-direction:column;background:#1c1c1c">
          <DocTabs />
          <Viewport />
        </div>
        <Studio />
      </div>
      <StatusBar />
      <StandbyOverlay />
    </div>
  );
}
