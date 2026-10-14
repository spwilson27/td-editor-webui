import { afterEach, describe, expect, it } from 'vitest';
import type { BlendMode } from '../../src/engine/types';
import { collect, drawRect, newEngine, near, nextFrame, px, setBase, type Px } from './engineTestUtils';
import type { Engine } from '../../src/engine';

let e: Engine;
afterEach(() => e?.dispose());

// ---- W3C compositing reference (opaque backdrop and source, channels 0..1) ----
type C = [number, number, number];
const sep: Partial<Record<BlendMode, (cb: number, cs: number) => number>> = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b)),
  'hard-light': (b, s) => (s <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b)),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'soft-light': (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};
const lum = (c: C) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clipColor = (c: C): C => {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  let r = c;
  if (n < 0) r = r.map((v) => l + ((v - l) * l) / (l - n)) as C;
  if (x > 1) r = r.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as C;
  return r;
};
const setLum = (c: C, l: number): C => { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]); };
const sat = (c: C) => Math.max(...c) - Math.min(...c);
const setSat = (c: C, s: number): C => {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const out: C = [0, 0, 0];
  const [mn, md, mx] = idx;
  if (c[mx] > c[mn]) {
    out[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]);
    out[mx] = s;
  }
  return out;
};
const nonSep: Partial<Record<BlendMode, (cb: C, cs: C) => C>> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

function reference(mode: BlendMode, b: Px, s: Px): Px {
  const cb = [b[0] / 255, b[1] / 255, b[2] / 255] as C;
  const cs = [s[0] / 255, s[1] / 255, s[2] / 255] as C;
  let r: C;
  if (mode === 'normal') r = cs;
  else if (sep[mode]) r = cb.map((v, i) => (sep[mode] as (a: number, b: number) => number)(v, cs[i])) as C;
  else r = (nonSep[mode] as (a: C, b: C) => C)(cb, cs);
  return [...r.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), 255] as Px;
}

const MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'darken', 'lighten', 'color-dodge',
  'color-burn', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];
const PAIRS: [Px, Px][] = [
  [[200, 100, 50, 255], [60, 160, 220, 255]],
  [[30, 180, 120, 255], [220, 90, 140, 255]],
];

describe('blend modes match the W3C reference formulas', () => {
  for (const mode of MODES) {
    it(mode, () => {
      e = newEngine(4, 4);
      const id = e.addPixelLayer();
      for (const [b, s] of PAIRS) {
        setBase(e, b);
        drawRect(e, id, { x: 0, y: 0, w: 4, h: 4 }, `rgb(${s[0]},${s[1]},${s[2]})`);
        e.setLayerProps(id, { blend: mode });
        const got = px(e, 2, 2);
        const want = reference(mode, b, s);
        expect(near(got, want, 2), `${mode} got ${got} want ${want}`).toBe(true);
      }
    });
  }
});

describe('opacity, visibility, order', () => {
  it('layer opacity mixes with the backdrop', () => {
    e = newEngine(4, 4);
    setBase(e, [255, 255, 255, 255]);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 4, h: 4 }, '#000');
    e.setLayerProps(id, { opacity: 0.25 });
    expect(near(px(e, 1, 1), [191, 191, 191, 255], 2)).toBe(true);
    e.setLayerProps(id, { opacity: 0 });
    expect(px(e, 1, 1)).toEqual([255, 255, 255, 255]);
  });

  it('hidden layers are skipped; stacking order is top-first', () => {
    e = newEngine(4, 4);
    const a = e.addPixelLayer();
    drawRect(e, a, { x: 0, y: 0, w: 4, h: 4 }, '#f00');
    const b = e.addPixelLayer(); // above a
    drawRect(e, b, { x: 0, y: 0, w: 4, h: 4 }, '#00f');
    expect(px(e, 0, 0)).toEqual([0, 0, 255, 255]);
    e.setLayerProps(b, { visible: false });
    expect(px(e, 0, 0)).toEqual([255, 0, 0, 255]);
    e.setLayerProps(b, { visible: true });
    e.moveLayer(b, null, 1); // below a
    expect(px(e, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('transparent output where nothing is drawn', () => {
    e = newEngine(4, 4);
    expect(px(e, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('a layer offset by move only covers its translated area', () => {
    e = newEngine(10, 10);
    const id = e.addPixelLayer();
    drawRect(e, id, { x: 0, y: 0, w: 4, h: 4 }, '#0f0');
    (e.doc.find(id) as { x: number }).x = 6;
    e.changed({ x: 0, y: 0, w: 10, h: 10 });
    expect(px(e, 6, 0)).toEqual([0, 255, 0, 255]);
    expect(px(e, 9, 3)).toEqual([0, 255, 0, 255]);
    expect(px(e, 2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('groups', () => {
  it('group blend is isolated: a multiply child does not see layers below the group', () => {
    e = newEngine(4, 4);
    setBase(e, [255, 0, 0, 255]);
    const g = e.addGroup();
    const l = e.addPixelLayer();
    e.moveLayer(l, g, 0);
    drawRect(e, l, { x: 0, y: 0, w: 4, h: 4 }, '#0f0');
    e.setLayerProps(l, { blend: 'multiply' });
    // not isolated would give red*green = black
    expect(px(e, 1, 1)).toEqual([0, 255, 0, 255]);
  });

  it('group opacity applies to the group as a unit (overlapping children do not double-mix)', () => {
    e = newEngine(10, 10);
    setBase(e, [255, 255, 255, 255]);
    const g = e.addGroup();
    const a = e.addPixelLayer();
    e.moveLayer(a, g, 0);
    drawRect(e, a, { x: 0, y: 0, w: 10, h: 5 }, '#f00');
    const b = e.addPixelLayer();
    e.moveLayer(b, g, 0);
    drawRect(e, b, { x: 0, y: 0, w: 10, h: 10 }, '#00f');
    e.setLayerProps(g, { opacity: 0.5 });
    // child b fully covers a: group looks like solid blue at 50% over white
    expect(near(px(e, 5, 2), [128, 128, 255, 255], 2)).toBe(true);
  });

  it('group blend mode applies to the flattened group', () => {
    e = newEngine(4, 4);
    setBase(e, [200, 100, 50, 255]);
    const g = e.addGroup();
    const l = e.addPixelLayer();
    e.moveLayer(l, g, 0);
    drawRect(e, l, { x: 0, y: 0, w: 4, h: 4 }, 'rgb(60,160,220)');
    e.setLayerProps(g, { blend: 'multiply' });
    expect(near(px(e, 1, 1), reference('multiply', [200, 100, 50, 255], [60, 160, 220, 255]), 2)).toBe(true);
  });

  it('hidden group hides children; nested groups composite', () => {
    e = newEngine(4, 4);
    const g1 = e.addGroup();
    const g2 = e.addGroup();
    e.moveLayer(g2, g1, 0);
    const l = e.addPixelLayer();
    e.moveLayer(l, g2, 0);
    drawRect(e, l, { x: 0, y: 0, w: 4, h: 4 }, '#ff0');
    expect(px(e, 0, 0)).toEqual([255, 255, 0, 255]);
    e.setLayerProps(g1, { visible: false });
    expect(px(e, 0, 0)).toEqual([0, 0, 0, 0]);
    e.setLayerProps(g1, { visible: true, opacity: 0 });
    expect(px(e, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('dirty rect discipline', () => {
  it('recomposites only the dirty rect', () => {
    e = newEngine(100, 100);
    setBase(e, [255, 255, 255, 255]);
    e.flush();
    const id = e.addPixelLayer();
    e.flush();
    const events = collect(e);
    drawRect(e, id, { x: 10, y: 20, w: 5, h: 6 }, '#000');
    e.flush();
    const comp = events.filter((x) => x.type === 'composite');
    expect(comp).toEqual([{ type: 'composite', rect: { x: 10, y: 20, w: 5, h: 6 } }]);
    expect(px(e, 12, 22)).toEqual([0, 0, 0, 255]);
    expect(px(e, 9, 22)).toEqual([255, 255, 255, 255]);
  });

  it('multiple invalidations in one frame union into one composite event', async () => {
    e = newEngine(100, 100);
    await nextFrame();
    const id = e.addPixelLayer();
    await nextFrame();
    await nextFrame();
    const events = collect(e);
    drawRect(e, id, { x: 0, y: 0, w: 5, h: 5 }, '#000');
    drawRect(e, id, { x: 50, y: 60, w: 5, h: 5 }, '#000');
    expect(events.filter((x) => x.type === 'composite')).toHaveLength(0);
    await nextFrame();
    await nextFrame();
    expect(events.filter((x) => x.type === 'composite')).toEqual([{ type: 'composite', rect: { x: 0, y: 0, w: 55, h: 65 } }]);
  });

  it('rects outside or partly outside the document are clipped; empty rects do nothing', () => {
    e = newEngine(20, 20);
    e.flush();
    const events = collect(e);
    e.changed({ x: 100, y: 100, w: 5, h: 5 });
    e.changed({ x: 0, y: 0, w: 0, h: 5 });
    e.flush();
    expect(events.filter((x) => x.type === 'composite')).toHaveLength(0);
    e.changed({ x: 15, y: -5, w: 20, h: 10 });
    e.flush();
    expect(events.filter((x) => x.type === 'composite')).toEqual([{ type: 'composite', rect: { x: 15, y: 0, w: 5, h: 5 } }]);
  });
});
