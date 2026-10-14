import { describe, expect, it } from 'vitest';
import { hslToRgb, hsvToRgb, parseHex, rgbToHsl, rgbToHsv, toHex } from '../../src/state/colour';

describe('colour maths', () => {
  it('parses 3 and 6 digit hex with or without #, rejects junk', () => {
    expect(parseHex('#e2683c')).toEqual({ r: 226, g: 104, b: 60 });
    expect(parseHex('FA0')).toEqual({ r: 255, g: 170, b: 0 });
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('zzzzzz')).toBeNull();
    expect(parseHex('')).toBeNull();
  });

  it('formats hex, clamping channels', () => {
    expect(toHex({ r: 0, g: 128, b: 255 })).toBe('#0080ff');
    expect(toHex({ r: -5, g: 300, b: 1.4 })).toBe('#00ff01');
  });

  it('round-trips rgb through hsv and hsl for every 17th channel combination', () => {
    for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
      expect(hsvToRgb(rgbToHsv({ r, g, b }))).toEqual({ r, g, b });
      expect(hslToRgb(rgbToHsl({ r, g, b }))).toEqual({ r, g, b });
    }
  });

  it('matches known values', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBe(240);
    const grey = rgbToHsl({ r: 128, g: 128, b: 128 });
    expect(grey.s).toBe(0);
    expect(grey.l).toBeCloseTo(0.502, 2);
    expect(hslToRgb({ h: 120, s: 1, l: 0.5 })).toEqual({ r: 0, g: 255, b: 0 });
  });
});
