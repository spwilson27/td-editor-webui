import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultEffect, effectLabel } from '../../src/state/effectDefaults';
import {
  ALL_FILTER_TYPES, filterFields, filterGroups, inspectCube, isFilterType, readCurve, readStops, stopColorAt, curveIsIdentity, type NumField,
} from '../../src/state/filterSchema';
import { createStore } from '../../src/state/store';
import { FakeEngine } from '../browser/fakeEngine';

const dir = new URL('../../../shared/effects/', import.meta.url);
const specs = readdirSync(dir).filter((f) => f.endsWith('.filter.json')).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { type: string; group: string; params: Record<string, Record<string, unknown>> });

describe('filter schema (generated from shared/effects/*.filter.json)', () => {
  it('knows every filter of the library, in the five menu groups', () => {
    expect(specs.length).toBe(40); // 35 filters + the five classic adjustments
    expect(filterGroups().map((g) => g.label)).toEqual(['Blur & sharpen', 'Colour', 'Stylise', 'Distort', 'Static animated']);
    expect(filterGroups().map((g) => g.types.length)).toEqual([7, 14, 8, 7, 4]);
    expect([...ALL_FILTER_TYPES()].sort()).toEqual(specs.map((s) => s.type).sort());
    for (const g of filterGroups()) for (const t of g.types) expect(specs.find((s) => s.type === t)!.group).toBe(g.id);
  });

  it('every parameter has an editor whose range is the spec\'s range, and the default is in range', () => {
    for (const s of specs) {
      const fx = defaultEffect(s.type) as unknown as Record<string, unknown>;
      expect(fx.type).toBe(s.type);
      expect(fx.enabled).toBe(true);
      const fields = filterFields(s.type);
      if (s.type !== 'invert') expect(fields.length, s.type).toBeGreaterThan(0); // invert has no parameters
      for (const [key, p] of Object.entries(s.params)) {
        if (p.kind === 'num') {
          const f = fields.find((x) => x.kind === 'num' && x.key === key) as NumField;
          expect(f, `${s.type}.${key}`).toBeTruthy();
          expect([f.min, f.max]).toEqual([p.min, p.max]);
          expect(fx[key] as number).toBeGreaterThanOrEqual(f.min);
          expect(fx[key] as number).toBeLessThanOrEqual(f.max);
          if (p.round) expect(f.step).toBe(1);
        } else if (p.kind === 'enum') {
          const f = fields.find((x) => (x.kind === 'enum' || x.kind === 'aux') && x.key === key);
          expect(f, `${s.type}.${key}`).toBeTruthy();
          expect(p.values as string[]).toContain(fx[key]);
          if (f!.kind === 'enum') expect(f!.options.map((o) => o[0])).toEqual(p.values);
        } else if (p.kind === 'color') {
          expect(fields.some((x) => x.kind === 'color' && x.key === key)).toBe(true);
          expect(Object.keys(fx[key] as object).sort()).toEqual(['a', 'b', 'g', 'r']);
        } else if (p.kind === 'bool') expect(typeof fx[key]).toBe('boolean');
        else if (p.kind === 'seed') expect(fields.some((x) => x.kind === 'seed' && x.key === key)).toBe(true);
      }
    }
  });

  it('special editors: curves (one editor for the four channels), gradient stops, selective colour list, LUT text, displace source', () => {
    expect(filterFields('curves')).toEqual([{ kind: 'curves', key: 'curves', label: 'Curves', keys: ['master', 'red', 'green', 'blue'] }]);
    expect(filterFields('gradientMap').map((f) => f.kind)).toEqual(['stops', 'bool', 'num']);
    expect(filterFields('selectiveColor').map((f) => f.kind)).toEqual(['list', 'bool']);
    expect(filterFields('lut').map((f) => f.kind)).toEqual(['lut', 'num']);
    expect(filterFields('displace')[0]).toEqual({ kind: 'aux', key: 'source', label: 'Source' });
    expect(filterFields('nope')).toEqual([]);
  });

  it('defaults: gradient stops are {pos,color} objects, the selective colour table is 36 zeros, LUT text is empty, curves are identity', () => {
    const g = defaultEffect('gradientMap') as unknown as { stops: Array<{ pos: number; color: Record<string, number> }>; amount: number };
    expect(g.stops).toEqual([{ pos: 0, color: { r: 0, g: 0, b: 0, a: 255 } }, { pos: 1, color: { r: 255, g: 255, b: 255, a: 255 } }]);
    expect(g.amount).toBe(100);
    expect((defaultEffect('selectiveColor') as unknown as { adjust: number[] }).adjust).toEqual(new Array(36).fill(0));
    expect((defaultEffect('lut') as unknown as { cube: string }).cube).toBe('');
    expect((defaultEffect('curves') as unknown as { master: number[][] }).master).toEqual([[0, 0], [1, 1]]);
    // v5 effects keep their exact defaults
    expect(defaultEffect('stroke')).toMatchObject({ type: 'stroke', width: 2, position: 'outside' });
    expect(effectLabel('stroke')).toBe('Stroke');
    expect(effectLabel('motionBlur')).toBe('Motion blur');
    expect(isFilterType('motionBlur')).toBe(true);
    expect(isFilterType('stroke')).toBe(false);
  });

  it('defaults are independent copies (editing one never changes the next)', () => {
    const a = defaultEffect('curves') as unknown as { master: number[][] };
    a.master[1][1] = 0.2;
    expect((defaultEffect('curves') as unknown as { master: number[][] }).master[1][1]).toBe(1);
  });
});

describe('curve, gradient and LUT helpers', () => {
  it('readCurve accepts pairs and {x,y}, sorts, clamps, and falls back to identity', () => {
    expect(readCurve([{ x: 1, y: 0 }, [0, 1]])).toEqual([[0, 1], [1, 0]]);
    expect(readCurve([[2, -1], [-1, 5]])).toEqual([[0, 1], [1, 0]]);
    expect(readCurve([[0.5, 0.5]])).toEqual([[0, 0], [1, 1]]);
    expect(readCurve('bad')).toEqual([[0, 0], [1, 1]]);
    expect(curveIsIdentity(readCurve(undefined))).toBe(true);
  });

  it('readStops sorts, clamps and defaults; stopColorAt interpolates and clamps at the ends', () => {
    const stops = readStops([{ pos: 1, color: { r: 255, g: 0, b: 0, a: 255 } }, { pos: 0, color: { r: 0, g: 0, b: 255, a: 255 } }]);
    expect(stops.map((s) => s.pos)).toEqual([0, 1]);
    expect(stopColorAt(stops, 0.5)).toEqual({ r: 128, g: 0, b: 128, a: 255 });
    expect(stopColorAt(stops, -1)).toEqual(stops[0].color);
    expect(stopColorAt(stops, 2)).toEqual(stops[1].color);
    expect(readStops('x').length).toBe(2);
    expect(readStops([{ pos: 'a' }, null])).toHaveLength(2);
  });

  it('inspectCube validates LUT_3D_SIZE and the number of rows; 1D LUTs and garbage are unusable', () => {
    const cube = (n: number, rows = n * n * n) => `TITLE "Warm"\n# comment\nLUT_3D_SIZE ${n}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${Array.from({ length: rows }, () => '0.1 0.2 0.3').join('\n')}\n`;
    expect(inspectCube(cube(2))).toEqual({ ok: true, size: 2, title: 'Warm' });
    expect(inspectCube(cube(17)).ok).toBe(true);
    expect(inspectCube(cube(2, 5))).toMatchObject({ ok: false, size: 2 });
    expect(inspectCube(cube(1, 1)).ok).toBe(false);
    expect(inspectCube(cube(65, 3)).ok).toBe(false);
    expect(inspectCube('LUT_1D_SIZE 4\n0 0 0\n1 1 1\n').reason).toMatch(/1D/);
    expect(inspectCube('').ok).toBe(false);
    expect(inspectCube('hello').ok).toBe(false);
  });
});

describe('store: filter adjustments and effect panel rules', () => {
  let store: ReturnType<typeof createStore>;
  let engine: FakeEngine;
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16)); store = createStore(); engine = new FakeEngine(64, 48); store.attach(engine); });
  afterEach(() => { store.detach(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('addAdjustment creates an adjustment layer whose FX stack is the catalogue entry with defaults, named after it', () => {
    const id = store.addAdjustment('motionBlur');
    const l = engine.layers().find((x) => x.id === id)!;
    expect(l.kind).toBe('adjustment');
    expect(l.name).toBe('Motion blur');
    expect(l.adjustment).toBeNull();
    expect(l.effects).toEqual([defaultEffect('motionBlur')]);
    expect(engine.calls.filter((c) => c.startsWith('add'))).toEqual(['addAdjustmentLayer:motionBlur']); // one engine call, one history entry
    expect(store.addFilterAdjustment('twirl')).toBeTruthy(); // alias
  });

  it('effects are allowed on pixel, text, shape, input, group and adjustment layers', () => {
    expect(['pixel', 'text', 'shape', 'input', 'group', 'adjustment'].every((k) => store.canHaveEffects(k))).toBe(true);
    expect(store.canHaveEffects('unknown')).toBe(false);
  });
});
