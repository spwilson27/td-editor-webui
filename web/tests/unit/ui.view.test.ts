import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, fitView, screenToDoc, zoomAbout } from '../../src/state/view';

describe('view transform', () => {
  it('fits the document centred with padding', () => {
    const v = fitView(1920, 1080, 1000, 600);
    expect(v.zoom).toBeCloseTo(Math.min(936 / 1920, 536 / 1080), 6);
    expect(v.x + (1920 * v.zoom) / 2).toBeCloseTo(500, 6);
    expect(v.y + (1080 * v.zoom) / 2).toBeCloseTo(300, 6);
  });

  it('clamps fit zoom for tiny documents', () => {
    expect(fitView(2, 2, 4000, 4000).zoom).toBe(MAX_ZOOM);
    expect(fitView(60000, 60000, 100, 100).zoom).toBe(MIN_ZOOM);
  });

  it('keeps the point under the cursor fixed when zooming', () => {
    const v = { zoom: 0.5, x: 40, y: 20 };
    const before = screenToDoc(v, 300, 200);
    const z = zoomAbout(v, 2, 300, 200);
    const after = screenToDoc(z, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(z.zoom).toBe(2);
  });

  it('clamps zoom range', () => {
    expect(zoomAbout({ zoom: 1, x: 0, y: 0 }, 1000, 0, 0).zoom).toBe(MAX_ZOOM);
    expect(zoomAbout({ zoom: 1, x: 0, y: 0 }, 0, 0, 0).zoom).toBe(MIN_ZOOM);
  });
});

describe('formatZoom', () => {
  it('prints whole numbers plainly and one decimal otherwise, like the mockup', async () => {
    const { formatZoom } = await import('../../src/state/view');
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(0.5)).toBe('50%');
    expect(formatZoom(2 / 3)).toBe('66.7%');
    expect(formatZoom(0.6219)).toBe('62.2%');
    expect(formatZoom(32)).toBe('3200%');
  });
});
