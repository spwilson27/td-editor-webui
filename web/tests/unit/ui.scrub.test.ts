import { describe, expect, it } from 'vitest';
import { SCRUB_STEP_PX, scrubIndex, scrubValue } from '../../src/ui/Scrub';

const none = [false, false, false, false, false];

describe('scrubIndex (dropdown step math)', () => {
  it('one option per 12 px, truncated toward zero, 0 steps inside the first 12 px', () => {
    expect(SCRUB_STEP_PX).toBe(12);
    expect(scrubIndex(none, 2, 0)).toBe(2);
    expect(scrubIndex(none, 2, 11.9)).toBe(2);
    expect(scrubIndex(none, 2, 12)).toBe(3);
    expect(scrubIndex(none, 2, 23.9)).toBe(3);
    expect(scrubIndex(none, 2, 24)).toBe(4);
    expect(scrubIndex(none, 2, -11.9)).toBe(2);
    expect(scrubIndex(none, 2, -12)).toBe(1);
    expect(scrubIndex(none, 2, -25)).toBe(0);
  });

  it('clamps at both ends', () => {
    expect(scrubIndex(none, 3, 500)).toBe(4);
    expect(scrubIndex(none, 1, -500)).toBe(0);
    expect(scrubIndex(none, 0, -12)).toBe(0);
    expect(scrubIndex(none, 4, 12)).toBe(4);
  });

  it('skips disabled options without charging distance, and stops before a disabled tail', () => {
    const d = [false, true, true, false, false, true];
    expect(scrubIndex(d, 0, 12)).toBe(3);
    expect(scrubIndex(d, 3, -12)).toBe(0);
    expect(scrubIndex(d, 3, 24)).toBe(4);
    expect(scrubIndex(d, 4, 120)).toBe(4); // option 5 is disabled: clamp on the last enabled one
    expect(scrubIndex([true, false, true], 1, 120)).toBe(1);
  });
});

describe('scrubValue (number step math)', () => {
  const no = {};
  it('up (positive dy) is larger, 0.5 per px', () => {
    expect(scrubValue(40, 10, 0.5, no, 1, 1000)).toBe(45);
    expect(scrubValue(40, -10, 0.5, no, 1, 1000)).toBe(35);
  });
  it('Shift x10 and Alt x0.1', () => {
    expect(scrubValue(40, 10, 0.5, { shift: true }, 1, 1000)).toBe(90);
    expect(scrubValue(40, 10, 0.5, { alt: true }, 1, 1000)).toBeCloseTo(40.5, 9);
  });
  it('clamps to the field range', () => {
    expect(scrubValue(990, 100, 0.5, { shift: true }, 1, 1000)).toBe(1000);
    expect(scrubValue(3, -100, 0.5, no, 1, 1000)).toBe(1);
  });
});
