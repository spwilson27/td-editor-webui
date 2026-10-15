import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legacyBlurToFilter } from '../../src/engine/effects/filters';

const vectors = JSON.parse(readFileSync(new URL('../../../shared/effects/legacy_blur_vectors.json', import.meta.url), 'utf8')) as Array<{ in: number; out: unknown }>;

describe('legacyBlurToFilter', () => {
  it('equals the shared vectors that effects.py and protocol.py legacy_blur_to_filter are checked against', () => {
    for (const v of vectors) expect(legacyBlurToFilter(v.in)).toEqual(v.out);
  });
});
