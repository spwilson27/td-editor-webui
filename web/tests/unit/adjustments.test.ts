import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_NAMES, ADJUSTMENT_TYPES, adjustmentReach, brightnessContrastLut, clampAdjustment, defaultAdjustment, filterFor, hsvAdjust, isIdentity, levelsLut,
  luminance, sameAdjustment,
} from '../../src/engine/adjustments';
import type { AdjustmentSpec } from '../../src/engine/types';

describe('adjustment defaults and validation', () => {
  it('every type has a default and a name; identity ones are identities', () => {
    for (const t of ADJUSTMENT_TYPES) {
      const d = defaultAdjustment(t);
      expect(d.type).toBe(t);
      expect(ADJUSTMENT_NAMES[t]).toBeTruthy();
      expect(clampAdjustment(d)).toEqual(d);
    }
    expect(isIdentity(defaultAdjustment('levels'))).toBe(true);
    expect(isIdentity(defaultAdjustment('brightnessContrast'))).toBe(true);
    expect(isIdentity(defaultAdjustment('hueSaturation'))).toBe(true);
    expect(isIdentity(defaultAdjustment('invert'))).toBe(false);
    expect(isIdentity(defaultAdjustment('threshold'))).toBe(false);
    expect(isIdentity(defaultAdjustment('blur'))).toBe(false);
    expect(isIdentity({ type: 'blur', radius: 0 })).toBe(true);
  });

  it('clamps every parameter into its documented range and repairs missing fields', () => {
    expect(clampAdjustment({ type: 'levels', inLow: -1, inHigh: 5, gamma: 100, outLow: -3, outHigh: 9 })).toEqual({
      type: 'levels', inLow: 0, inHigh: 1, gamma: 10, outLow: 0, outHigh: 1,
    });
    const l = clampAdjustment({ type: 'levels', inLow: 0.9, inHigh: 0.2, gamma: 0, outLow: 0, outHigh: 1 }) as Extract<AdjustmentSpec, { type: 'levels' }>;
    expect(l.inHigh).toBeCloseTo(l.inLow + 1e-4, 9);
    expect(l.gamma).toBe(0.1);
    expect(clampAdjustment({ type: 'brightnessContrast', brightness: 4, contrast: -4 })).toEqual({ type: 'brightnessContrast', brightness: 1, contrast: -1 });
    expect(clampAdjustment({ type: 'hueSaturation', hue: 400, saturation: 9, value: -1 })).toEqual({ type: 'hueSaturation', hue: 180, saturation: 2, value: 0 });
    expect(clampAdjustment({ type: 'blur', radius: 999 })).toEqual({ type: 'blur', radius: 200 });
    expect(clampAdjustment({ type: 'blur', radius: NaN })).toEqual({ type: 'blur', radius: 0 });
    expect(clampAdjustment({ type: 'threshold', level: 3 })).toEqual({ type: 'threshold', level: 1 });
    expect(clampAdjustment({ type: 'invert' })).toEqual({ type: 'invert' });
    expect(clampAdjustment({ type: 'threshold' } as AdjustmentSpec)).toEqual({ type: 'threshold', level: 0.5 });
  });

  it('sameAdjustment compares by value', () => {
    expect(sameAdjustment({ type: 'blur', radius: 3 }, { type: 'blur', radius: 3 })).toBe(true);
    expect(sameAdjustment({ type: 'blur', radius: 3 }, { type: 'blur', radius: 4 })).toBe(false);
    expect(sameAdjustment({ type: 'invert' }, { type: 'threshold', level: 1 })).toBe(false);
  });

  it('blur reach is 3 sigma, others have none', () => {
    expect(adjustmentReach({ type: 'blur', radius: 10 })).toBe(30);
    expect(adjustmentReach({ type: 'blur', radius: 0 })).toBe(0);
    expect(adjustmentReach({ type: 'invert' })).toBe(0);
  });

  it('only blur uses a CSS filter', () => {
    expect(filterFor({ type: 'blur', radius: 6 })).toBe('blur(6px)');
    for (const t of ADJUSTMENT_TYPES.filter((x) => x !== 'blur')) expect(filterFor(defaultAdjustment(t))).toBeNull();
  });

  it('brightness / contrast LUT: identity, brightness multiplies, contrast pivots on mid grey', () => {
    const id = brightnessContrastLut({ type: 'brightnessContrast', brightness: 0, contrast: 0 });
    for (let i = 0; i < 256; i++) expect(id[i]).toBe(i);
    const l = brightnessContrastLut({ type: 'brightnessContrast', brightness: 0.2, contrast: 0.5 });
    expect(l[100]).toBe(Math.round(255 * ((100 / 255 * 1.2 - 0.5) * 1.5 + 0.5)));
    expect(l[255]).toBe(255);
    expect(l[0]).toBe(0);
    const flat = brightnessContrastLut({ type: 'brightnessContrast', brightness: 0, contrast: -1 });
    expect(new Set(flat).size).toBe(1);
    expect(flat[0]).toBe(128);
  });

  it('hue / saturation / value is a true HSV edit (td/raster_editor/network.py)', () => {
    const f = (c: number[], hue: number, sat: number, val: number): number[] => {
      const o = [0, 0, 0];
      hsvAdjust(c[0], c[1], c[2], hue, sat, val, o);
      return o;
    };
    expect(f([100, 150, 200], 0, 1, 1)).toEqual([100, 150, 200]); // identity
    expect(f([100, 150, 200], 0, 0, 1)).toEqual([200, 200, 200]); // S' = 0 keeps V = max
    expect(f([100, 150, 200], 0, 1, 0.5)).toEqual([50, 75, 100]);
    expect(f([255, 0, 0], 120, 1, 1)).toEqual([0, 255, 0]);
    expect(f([255, 0, 0], -120, 1, 1)).toEqual([0, 0, 255]);
    expect(f([255, 0, 0], 90, 1, 1)).toEqual([128, 255, 0]);
    expect(f([200, 100, 100], 0, 2, 1)).toEqual([200, 0, 0]); // S' = min(1, S * 2)
    expect(f([100, 50, 50], 0, 1, 2)).toEqual([200, 100, 100]); // V' = V * 2
    expect(f([200, 100, 100], 0, 1, 2)).toEqual([255, 200, 200]); // channels clamp
    expect(f([0, 0, 0], 90, 2, 2)).toEqual([0, 0, 0]);
    expect(f([128, 128, 128], 77, 2, 1)).toEqual([128, 128, 128]); // grey has no hue / saturation
    expect(f([0, 255, 0], 0, 1, 1)).toEqual([0, 255, 0]);
    expect(f([0, 0, 255], 180, 1, 1)).toEqual([255, 255, 0]);
  });

  it('levels LUT: identity, input/output range, gamma', () => {
    const id = levelsLut({ type: 'levels', inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 });
    for (let i = 0; i < 256; i++) expect(id[i]).toBe(i);
    const r = levelsLut({ type: 'levels', inLow: 0.25, inHigh: 0.75, gamma: 1, outLow: 0, outHigh: 1 });
    expect(r[0]).toBe(0);
    expect(r[64]).toBe(0);
    expect(r[255]).toBe(255);
    expect(r[128]).toBe(Math.round(255 * ((128 / 255 - 0.25) / 0.5)));
    const g = levelsLut({ type: 'levels', inLow: 0, inHigh: 1, gamma: 2, outLow: 0.1, outHigh: 0.9 });
    expect(g[0]).toBe(Math.round(0.1 * 255));
    expect(g[255]).toBe(Math.round(0.9 * 255));
    expect(g[128]).toBe(Math.round(255 * (0.1 + Math.sqrt(128 / 255) * 0.8)));
  });

  it('luminance uses Rec.709 weights', () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(255, 3);
    expect(luminance(255, 0, 0)).toBeCloseTo(54.2, 1);
    expect(luminance(0, 255, 0)).toBeCloseTo(182.4, 1);
  });
});
