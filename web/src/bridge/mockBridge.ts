import type { EditorEngine } from '../engine/types';
import type { Bridge, BridgeStatus } from './tdBridge';

/** Standalone (mock) when ?standalone=1, or under the Vite dev server unless a ?ws= endpoint is given. */
export function useMockBridge(search: string, dev: boolean): boolean {
  const q = new URLSearchParams(search);
  return q.get('standalone') === '1' || (dev && !q.has('ws'));
}

/** The mockup landscape, scaled so the 640x360 scene fills w x h. */
export function drawLandscape(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const k = w / 640;
  ctx.save();
  ctx.scale(k, h / 360 === k ? k : h / 360);
  ctx.fillStyle = '#f4efe6';
  ctx.fillRect(0, 0, 640, 360);
  const sky = ctx.createLinearGradient(0, 0, 0, 260);
  sky.addColorStop(0, '#8fb9e0');
  sky.addColorStop(1, '#b9d6ee');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 640, 360);
  const ellipse = (cx: number, cy: number, rx: number, ry: number, c: string) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  ellipse(490, 94, 42, 42, '#f4c04e');
  ellipse(170, 350, 260, 150, '#6c9a5c');
  ellipse(520, 380, 280, 150, '#4b7843');
  ctx.fillStyle = '#2f5a2c';
  ctx.fillRect(0, 316, 640, 44);
  ctx.fillStyle = '#5a3d2b';
  ctx.fillRect(140, 200, 14, 120);
  ellipse(147, 183, 53, 53, '#2f6b3a');
  ctx.restore();
}

export function startMockBridge(engine: EditorEngine, status: BridgeStatus & { docName?: { value: string } }): Bridge {
  const c = document.createElement('canvas');
  c.width = engine.width;
  c.height = engine.height;
  const ctx = c.getContext('2d')!;
  drawLandscape(ctx, c.width, c.height);
  engine.setInputs([{ input: 1, w: c.width, h: c.height, connected: true }]);
  engine.writeInput(1, { x: 0, y: 0, w: c.width, h: c.height }, ctx.getImageData(0, 0, c.width, c.height).data);
  engine.commitInput(1);
  if (status.docName) status.docName.value = 'landscape.png';
  status.setConnection('standalone');
  status.setActive(true);
  const offline = () => Promise.reject(new Error('Not connected to TouchDesigner'));
  return { takeover() {}, dispose() {}, setView() {}, listTops: offline, importTop: offline, renderLayer: offline, renderLayers: offline, setCanvas: () => false, saveProject: offline, openProject: offline, exportPng: offline, chooseFile: offline, clearStoredHistory: offline };
}
