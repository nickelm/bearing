import { describe, expect, it } from 'vitest';
import {
  GRID_LINE_PX,
  gridCoverage,
  hash12,
  patternLevels,
  STIPPLE_RADIUS,
  stippleCoverage,
} from '../src/render/strategic/patterns';

describe('screen-stable pattern levels', () => {
  it('keeps both periods within half and twice the target on screen', () => {
    for (const footprint of [3, 47, 150, 900, 6000, 31_000]) {
      const { period0, period1, t } = patternLevels(footprint, 8);
      expect(period1).toBe(2 * period0);
      expect(period0 / footprint).toBeGreaterThan(4 - 1e-9);
      expect(period0 / footprint).toBeLessThanOrEqual(8 + 1e-9);
      expect(period1 / footprint).toBeLessThanOrEqual(16 + 1e-9);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
      expect(Math.log2(period0)).toBe(Math.round(Math.log2(period0)));
    }
  });

  it('fades continuously across a power of two', () => {
    // Just below a doubling the coarse period dominates; just above, the same period is the fine one.
    const below = patternLevels(127.999 / 8, 8);
    const above = patternLevels(128.001 / 8, 8);
    expect(below.period1).toBe(above.period0);
    expect(below.t).toBeGreaterThan(0.999);
    expect(above.t).toBeLessThan(0.001);
  });
});

describe('pattern shapes', () => {
  it('hashes cells into [0, 1)', () => {
    for (let i = -50; i < 50; i++) {
      const h = hash12(i * 7.0, i * -13.0 + 4000);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it('covers about π r² of the plane with stipple dots, and stays within 0..1', () => {
    const P = 100;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < 2000; y += 3.7)
      for (let x = 0; x < 2000; x += 3.3) {
        const c = stippleCoverage(x + 1e6, y - 3e5, P, 0.01);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        sum += c;
        n++;
      }
    expect(sum / n).toBeCloseTo(Math.PI * STIPPLE_RADIUS ** 2, 1);
  });

  it('draws grid lines one pixel wide at the period', () => {
    const P = 64;
    const f = 4; // m per px
    // On a line, off it, and the covered share of a row across the lines.
    expect(gridCoverage(3 * P, 10, P, f)).toBe(1);
    expect(gridCoverage(3.5 * P, 0.5 * P, P, f)).toBe(0);
    let sum = 0;
    const steps = 6400;
    for (let i = 0; i < steps; i++) sum += gridCoverage((i * 10 * P) / steps, 0.5 * P, P, f);
    expect(sum / steps).toBeCloseTo((GRID_LINE_PX * f) / P, 2);
  });
});
