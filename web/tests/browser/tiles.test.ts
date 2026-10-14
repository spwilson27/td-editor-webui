import { describe, expect, it } from 'vitest';
import type { PixelLayer } from '../../src/engine/model';
import { createSurface } from '../../src/engine/surface';
import { TILE, TileBackup } from '../../src/engine/tiles';

function setup(w: number, h: number) {
  const layer = { surface: createSurface(w, h), x: 0, y: 0 } as unknown as PixelLayer;
  layer.surface.ctx.fillStyle = 'rgb(10,20,30)';
  layer.surface.ctx.fillRect(0, 0, w, h);
  const backup = createSurface(w, h);
  return { layer, tb: new TileBackup(layer, backup) };
}
const px = (l: PixelLayer, x: number, y: number) => Array.from(l.surface.ctx.getImageData(x, y, 1, 1).data);

describe('TileBackup', () => {
  it('has no patches until something is covered', () => {
    expect(setup(300, 300).tb.patches()).toEqual([]);
  });

  it('covers only the tiles a rect touches, clamped to the surface', () => {
    const { tb } = setup(300, 300);
    tb.cover({ x: 10, y: 10, w: 5, h: 5 });
    tb.cover({ x: 12, y: 12, w: 1, h: 1 }); // same tile: no duplicate
    tb.cover({ x: -50, y: -50, w: 10, h: 10 }); // outside: nothing
    tb.cover({ x: 290, y: 290, w: 100, h: 100 }); // partial last tile
    const p = tb.patches();
    expect(p.map((x) => x.rect)).toEqual([{ x: 0, y: 0, w: TILE, h: TILE }, { x: 256, y: 256, w: 44, h: 44 }]);
  });

  it('merges horizontally adjacent tiles into one run per tile row', () => {
    const { tb } = setup(400, 400);
    tb.cover({ x: 0, y: 0, w: 400, h: 400 });
    const p = tb.patches();
    expect(p).toHaveLength(4);
    expect(p[0].rect).toEqual({ x: 0, y: 0, w: 400, h: TILE });
    expect(p[3].rect).toEqual({ x: 0, y: 384, w: 400, h: 16 });
    // a row boundary never merges a run into the next row
    const t2 = setup(256, 256);
    t2.tb.cover({ x: 128, y: 0, w: 1, h: 1 });
    t2.tb.cover({ x: 0, y: 128, w: 1, h: 1 });
    expect(t2.tb.patches().map((x) => x.rect)).toEqual([{ x: 128, y: 0, w: 128, h: 128 }, { x: 0, y: 128, w: 128, h: 128 }]);
  });

  it('keeps the pre-edit pixels and reports post-edit pixels', () => {
    const { layer, tb } = setup(300, 300);
    tb.cover({ x: 130, y: 5, w: 2, h: 2 });
    layer.surface.ctx.fillStyle = 'rgb(200,0,0)';
    layer.surface.ctx.fillRect(130, 5, 2, 2);
    const [p] = tb.patches();
    const at = (img: ImageData, x: number, y: number) => Array.from(img.data.subarray(((y - p.rect.y) * p.rect.w + x - p.rect.x) * 4, ((y - p.rect.y) * p.rect.w + x - p.rect.x) * 4 + 4));
    expect(at(p.before, 130, 5)).toEqual([10, 20, 30, 255]);
    expect(at(p.after, 130, 5)).toEqual([200, 0, 0, 255]);
  });

  it('a tile is saved once: later covers do not capture already modified pixels', () => {
    const { layer, tb } = setup(200, 200);
    tb.cover({ x: 0, y: 0, w: 1, h: 1 });
    layer.surface.ctx.fillStyle = 'rgb(1,1,1)';
    layer.surface.ctx.fillRect(0, 0, 50, 50);
    tb.cover({ x: 20, y: 20, w: 1, h: 1 });
    expect(Array.from(tb.patches()[0].before.data.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it('restore puts the saved pixels back, saving untouched tiles first', () => {
    const { layer, tb } = setup(300, 300);
    tb.cover({ x: 0, y: 0, w: 10, h: 10 });
    layer.surface.ctx.fillStyle = 'rgb(255,255,255)';
    layer.surface.ctx.fillRect(0, 0, 10, 10);
    tb.restore({ x: 0, y: 0, w: 10, h: 10 });
    expect(px(layer, 5, 5)).toEqual([10, 20, 30, 255]);
    tb.restore({ x: 200, y: 200, w: 10, h: 10 }); // tile not covered before
    expect(px(layer, 205, 205)).toEqual([10, 20, 30, 255]);
    expect(tb.patches()).toHaveLength(2);
  });
});
