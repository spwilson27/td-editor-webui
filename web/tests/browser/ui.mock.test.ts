import { describe, expect, it } from 'vitest';
import { drawLandscape, startMockBridge } from '../../src/bridge/mockBridge';
import { FakeEngine } from './fakeEngine';

const px = (d: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

describe('mock bridge', () => {
  it('draws the landscape at any size, scaled from the mockup', () => {
    const c = document.createElement('canvas');
    c.width = 1920; c.height = 1080;
    const ctx = c.getContext('2d')!;
    drawLandscape(ctx, 1920, 1080);
    const d = ctx.getImageData(0, 0, 1920, 1080).data;
    expect(px(d, 1920, 1470, 282)).toEqual([0xf4, 0xc0, 0x4e, 255]); // sun
    expect(px(d, 1920, 441, 549)).toEqual([0x2f, 0x6b, 0x3a, 255]); // tree canopy
    expect(px(d, 1920, 100, 1060)).toEqual([0x2f, 0x5a, 0x2c, 255]); // grass strip
    expect(px(d, 1920, 1800, 900)[0]).toBe(0x4b); // far hill
    expect(px(d, 1920, 10, 10)[3]).toBe(255);
  });

  it('writes a full base frame, commits, and reports standalone', () => {
    const engine = new FakeEngine(320, 180);
    const log: string[] = [];
    const doc = { value: '' };
    const bridge = startMockBridge(engine, {
      setConnection: (c) => log.push('conn:' + c), setActive: (a) => log.push('active:' + a), setNotice: () => {}, docName: doc,
    });
    expect(engine.baseWrites).toEqual([{ rect: { x: 0, y: 0, w: 320, h: 180 }, len: 320 * 180 * 4 }]);
    expect(engine.commits).toBe(1);
    expect(log).toEqual(['conn:standalone', 'active:true']);
    expect(doc.value).toBe('landscape.png');
    bridge.takeover();
    bridge.dispose();
  });
});
