import { describe, expect, it } from 'vitest';
import { useMockBridge } from '../../src/bridge/mockBridge';

describe('bridge selection', () => {
  it('uses the mock for ?standalone=1 anywhere', () => {
    expect(useMockBridge('?standalone=1', false)).toBe(true);
    expect(useMockBridge('?standalone=1&ws=ws://x/ws', false)).toBe(true);
  });
  it('uses the mock under the dev server unless a ws endpoint is given', () => {
    expect(useMockBridge('', true)).toBe(true);
    expect(useMockBridge('?test=1', true)).toBe(true);
    expect(useMockBridge('?ws=ws://127.0.0.1:9/ws', true)).toBe(false);
  });
  it('uses the TD bridge in production builds', () => {
    expect(useMockBridge('', false)).toBe(false);
    expect(useMockBridge('?standalone=0', false)).toBe(false);
  });
});
