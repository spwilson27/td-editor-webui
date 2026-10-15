import { describe, expect, it } from 'vitest';
import { BUILTIN_TIPS, DabSampler, DEFAULT_DYNAMICS, hash2, isPlainTip, jitterColor, mulberry32, sanitizeBrushPresets, sanitizeDynamics, tipAlpha, TIP_RES } from '../../src/engine/tools/tips';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const preset = (o: Record<string, unknown> = {}) => ({ id: 'a', name: 'A', settings: { size: 20, opacity: 1, flow: 1, hardness: 0.5, spacing: 0.15 }, tip: 'round', dynamics: { ...DEFAULT_DYNAMICS }, ...o });
const sum = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);

describe('tip masks', () => {
  it('are deterministic, sized and different per shape', () => {
    const sums = new Set<number>();
    for (const s of BUILTIN_TIPS) {
      const a = tipAlpha(s, 0.5);
      expect(a.length).toBe(TIP_RES * TIP_RES);
      expect(tipAlpha(s, 0.5)).toBe(a); // cached
      if (s !== 'square') expect(a[0]).toBe(0); // corner empty
      expect(sum(a)).toBeGreaterThan(2000);
      sums.add(sum(a));
    }
    expect(sums.size).toBe(BUILTIN_TIPS.length);
    expect(hash2(1, 2, 3)).toBe(hash2(1, 2, 3));
    expect(hash2(1, 2, 3)).not.toBe(hash2(2, 1, 3));
  });
  it('hardness softens the edge, round is a disc', () => {
    const hard = tipAlpha('round', 1);
    const soft = tipAlpha('round', 0);
    const mid = TIP_RES / 2;
    expect(hard[mid * TIP_RES + mid]).toBe(255);
    expect(hard[mid * TIP_RES + mid + 50]).toBe(255);
    expect(soft[mid * TIP_RES + mid + 32]).toBeGreaterThan(100);
    expect(soft[mid * TIP_RES + mid + 32]).toBeLessThan(160);
    expect(sum(soft)).toBeLessThan(sum(hard));
  });
});

describe('rng and sampler', () => {
  it('mulberry32 is seed-deterministic', () => {
    const a = mulberry32(5), b = mulberry32(5), c = mulberry32(6);
    const xa = [a(), a(), a()], xb = [b(), b(), b()];
    expect(xa).toEqual(xb);
    expect(xa).not.toEqual([c(), c(), c()]);
    expect(xa.every((v) => v >= 0 && v < 1)).toBe(true);
  });
  it('sampler draws a fixed number of values per dab', () => {
    const d = sanitizeDynamics({ ...DEFAULT_DYNAMICS, scatter: 1, sizeJitter: 0.5, angleJitter: 30, seed: 9 });
    const d0 = sanitizeDynamics({ seed: 9 });
    const s1 = new DabSampler(d), s0 = new DabSampler(d0);
    for (let i = 0; i < 5; i++) {
      const a = s1.next(20), b = s0.next(20);
      expect(Math.hypot(a.ox, a.oy)).toBeLessThanOrEqual(20.0001);
      expect(a.size).toBeGreaterThanOrEqual(10);
      expect(Math.abs(a.angle)).toBeLessThanOrEqual(30);
      expect(b).toMatchObject({ ox: 0, oy: 0, size: 20, angle: 0 });
    }
    const x = new DabSampler(d), y = new DabSampler(d);
    expect([x.next(20), x.next(20)]).toEqual([y.next(20), y.next(20)]);
  });
  it('clamps dynamics and detects the plain tip', () => {
    const d = sanitizeDynamics({ scatter: 9, scatterCount: 99, sizeJitter: -1, roundness: 0, angleJitter: 999, seed: -3, angle: 190 });
    expect(d).toMatchObject({ scatter: 4, scatterCount: 16, sizeJitter: 0, roundness: 0.05, angleJitter: 360, angle: -170 });
    expect(Number.isInteger(d.seed) && d.seed >= 0).toBe(true);
    expect(isPlainTip('round', DEFAULT_DYNAMICS)).toBe(true);
    expect(isPlainTip('round', { ...DEFAULT_DYNAMICS, roundness: 0.5 })).toBe(false);
    expect(isPlainTip('chalk', DEFAULT_DYNAMICS)).toBe(false);
  });
  it('jitters colour in HSV', () => {
    expect(jitterColor(255, 0, 0, 0, 0, 0)).toEqual([255, 0, 0]);
    expect(jitterColor(255, 0, 0, 1 / 3, 0, 0)).toEqual([0, 255, 0]);
    expect(jitterColor(255, 0, 0, 0, 0, -0.5)).toEqual([128, 0, 0]);
  });
});

describe('sanitizeBrushPresets', () => {
  it('drops junk, clamps, dedupes ids', () => {
    expect(sanitizeBrushPresets('x')).toEqual([]);
    const out = sanitizeBrushPresets([null, 5, preset({ id: 'a' }), preset({ id: 'a', name: 'x'.repeat(100), tip: 'nope', settings: { size: 5000, opacity: 2, flow: -1, hardness: 9, spacing: 0 } }), preset({ id: '' })]);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((p) => p.id)).size).toBe(3);
    expect(out[1].name.length).toBe(64);
    expect(out[1].tip).toBe('round');
    expect(out[1].settings).toEqual({ size: 1000, opacity: 1, flow: 0, hardness: 1, spacing: 0.01 });
    expect(sanitizeBrushPresets(Array.from({ length: 200 }, (_, i) => preset({ id: `p${i}` })))).toHaveLength(64);
  });
  it('keeps custom tips only when valid, at most 16', () => {
    const c = (o = {}) => preset({ tip: 'custom', customTip: { w: 4, h: 4, png: PNG, ...o } });
    expect(sanitizeBrushPresets([c()])[0]).toMatchObject({ tip: 'custom', customTip: { w: 4, h: 4 } });
    for (const bad of [{ w: 0 }, { w: 513 }, { h: 1.5 }, { png: 'data:image/jpeg;base64,xx' }, { png: PNG + 'A'.repeat(2_000_000) }]) {
      const p = sanitizeBrushPresets([c(bad)])[0];
      expect(p.tip).toBe('round');
      expect(p.customTip).toBeUndefined();
    }
    expect(sanitizeBrushPresets([preset({ tip: 'chalk', customTip: { w: 4, h: 4, png: PNG } })])[0].customTip).toBeUndefined();
    const many = sanitizeBrushPresets(Array.from({ length: 20 }, (_, i) => ({ ...c(), id: `c${i}` })));
    expect(many.filter((p) => p.tip === 'custom')).toHaveLength(16);
    expect(many.slice(16).every((p) => p.tip === 'round' && !p.customTip)).toBe(true);
  });
});
