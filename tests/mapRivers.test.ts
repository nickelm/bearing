import { describe, expect, it } from 'vitest';
import { riverLinePx } from '../src/render/strategic/mapRivers';

describe('map river lines', () => {
  it('keeps every river at least a pixel wide and widens with discharge', () => {
    expect(riverLinePx(5)).toBe(1);
    expect(riverLinePx(25)).toBe(1);
    expect(riverLinePx(100)).toBeCloseTo(2, 12);
    expect(riverLinePx(400)).toBeCloseTo(3, 12);
    expect(riverLinePx(5000)).toBe(3.5);
    let prev = 0;
    for (let w = 1; w < 3000; w *= 1.3) {
      expect(riverLinePx(w)).toBeGreaterThanOrEqual(prev);
      prev = riverLinePx(w);
    }
  });
});
