import { describe, expect, it } from 'vitest';
import {
  blendedCoastDistance,
  SHORE_BLEND_HI,
  SHORE_BLEND_LO,
  COASTLINE_PX,
  DEEP_DEPTH,
  lineCoverage,
  SHELF_DEPTH,
  waterBandWeights,
} from '../src/render/strategic/mapWater';

describe('map water bands', () => {
  it('picks shelf, mid-depth and deep water by reference depth', () => {
    expect(waterBandWeights(50)).toEqual([1, 0, 0]);
    expect(waterBandWeights(1000)).toEqual([0, 1, 0]);
    expect(waterBandWeights(5000)).toEqual([0, 0, 1]);
  });

  it('antialiases each band edge over one pixel and always sums to one', () => {
    const perPx = 40; // m of reference depth per pixel
    const at = waterBandWeights(SHELF_DEPTH, perPx);
    expect(at[0]).toBeCloseTo(0.5, 12);
    expect(at[1]).toBeCloseTo(0.5, 12);
    expect(waterBandWeights(SHELF_DEPTH - perPx, perPx)).toEqual([1, 0, 0]);
    expect(waterBandWeights(DEEP_DEPTH + perPx, perPx)).toEqual([0, 0, 1]);
    for (let d = 0; d < 6000; d += 37) {
      const w = waterBandWeights(d, perPx);
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 12);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('coastline', () => {
  it('draws a line about 1.2 px wide, fully dark at its center', () => {
    expect(lineCoverage(0)).toBe(1);
    expect(lineCoverage(0.5)).toBeCloseTo(0.6, 12);
    expect(lineCoverage(2)).toBe(0);
    // Integrated coverage across the line equals its width.
    let sum = 0;
    const step = 0.01;
    for (let d = -5; d <= 5; d += step) sum += lineCoverage(d) * step;
    expect(sum).toBeCloseTo(COASTLINE_PX, 2);
  });
});

describe('coast distance for the halo and coastal lines', () => {
  it('follows the per-vertex estimate near the coast and the texture farther out', () => {
    expect(blendedCoastDistance(800, 2000)).toBe(800);
    expect(blendedCoastDistance(SHORE_BLEND_LO, 9000)).toBe(SHORE_BLEND_LO);
    // The per-vertex estimate is clamped at 5 km: beyond the blend, the texture rules.
    expect(blendedCoastDistance(5000, 23_000)).toBe(23_000);
    const mid = blendedCoastDistance((SHORE_BLEND_LO + SHORE_BLEND_HI) / 2, 10_000);
    expect(mid).toBeGreaterThan(3500);
    expect(mid).toBeLessThan(10_000);
  });
});
