/** The canopy height field (decision 148): stands, lumps and cover on the CPU. */
import { describe, expect, it } from 'vitest';
import {
  CANOPY_THRESHOLD,
  canopyHeight,
  canopyLump,
  canopySeed,
  cellHash,
  edgeDraw,
  fieldAt,
  hedgeShare,
  CONIFER_T,
  coniferShare,
  EDGE_RISE,
  EDGE_TREES,
  edgeRise,
  LUMP,
  pineShare,
  STAND_CELL,
  STAND_HEIGHTS,
  standAt,
  YOUNG_HEIGHT,
} from '../src/worldgen/canopy';

const R = 1_000_000;
const seed = canopySeed(1983);

/** Points on the sea-level sphere along a line of latitude 45°, `step` m apart. */
function line(n: number, step: number): [number, number, number][] {
  const lat = Math.PI / 4;
  return Array.from({ length: n }, (_, k) => {
    const lon = (k * step) / (R * Math.cos(lat));
    return [
      R * Math.cos(lat) * Math.sin(lon),
      R * Math.sin(lat),
      R * Math.cos(lat) * Math.cos(lon),
    ];
  });
}

describe('canopy height field', () => {
  it('hashes lattice cells to 32-bit values, deterministically and per seed', () => {
    expect(cellHash(1, 2, 3, 7)).toBe(cellHash(1, 2, 3, 7));
    expect(cellHash(1, 2, 3, 7)).not.toBe(cellHash(1, 2, 3, 8));
    expect(cellHash(-5, 2, 3, 7)).not.toBe(cellHash(5, 2, 3, 7));
    const h = cellHash(-123456, 789, -4, 0xdeadbeef);
    expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    expect(canopySeed(1983)).toBe(canopySeed(1983));
    expect(canopySeed(1983)).not.toBe(canopySeed(1984));
  });

  it('cuts forests into stands a few hundred meters across', () => {
    // 20 km in 5 m steps: count stand changes.
    const pts = line(4000, 5);
    let changes = 0;
    let prev = '';
    for (const [x, y, z] of pts) {
      const s = standAt(x, y, z, 0.5, 0, seed);
      const key = s.cell.join(',');
      if (prev && key !== prev) changes++;
      prev = key;
    }
    const mean = 20_000 / (changes + 1);
    expect(mean).toBeGreaterThan(0.4 * STAND_CELL);
    expect(mean).toBeLessThan(2 * STAND_CELL);
  });

  it('draws kind, height and shade per stand within their bounds', () => {
    let conifers = 0;
    let young = 0;
    const pts = line(2000, 50);
    for (const [x, y, z] of pts) {
      const s = standAt(x, y, z, 0.3, 0, seed);
      conifers += s.conifer;
      const kind = s.conifer ? STAND_HEIGHTS.conifer : STAND_HEIGHTS.broadleaf;
      const lo = kind[0] * YOUNG_HEIGHT;
      const hi = kind[0] + kind[1];
      expect(s.height).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(s.height).toBeLessThanOrEqual(hi + 1e-9);
      if (s.height < kind[0]) young++;
      expect(s.shade).toBeGreaterThanOrEqual(0.86);
      expect(s.shade).toBeLessThanOrEqual(1.14 + 1e-9);
    }
    // Shares follow the climate's conifer share (0.3) and the young share (0.15), per point.
    expect(conifers / pts.length).toBeGreaterThan(0.18);
    expect(conifers / pts.length).toBeLessThan(0.42);
    expect(young / pts.length).toBeGreaterThan(0.05);
    expect(young / pts.length).toBeLessThan(0.28);
    // All conifer in the cold, all broadleaf in the warmth; tropical stands are tall.
    const [x, y, z] = pts[0]!;
    expect(standAt(x, y, z, 1, 0, seed).conifer).toBe(1);
    expect(standAt(x, y, z, 0, 0, seed).conifer).toBe(0);
    expect(standAt(x, y, z, 0, 1, seed).height).toBeGreaterThanOrEqual(
      STAND_HEIGHTS.tropical[0] * YOUNG_HEIGHT - 1e-9,
    );
  });

  it('lumps the canopy smoothly within ±LUMP of its height', () => {
    const pts = line(2000, 2);
    let lo = Infinity;
    let hi = -Infinity;
    let prev: number | null = null;
    for (const [x, y, z] of pts) {
      const v = canopyLump(x, y, z, seed);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      if (prev !== null) expect(Math.abs(v - prev)).toBeLessThan(0.2);
      prev = v;
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.5);
  });

  it('is zero in the open, lower at the edge and the lumpy stand height inside', () => {
    const [x, y, z] = line(1, 1)[0]!;
    expect(canopyHeight(x, y, z, CANOPY_THRESHOLD - 0.01, 10, seed)).toBe(0);
    const s = standAt(x, y, z, 0, 0, seed);
    const edge = canopyHeight(x, y, z, CANOPY_THRESHOLD, 10, seed);
    const inside = canopyHeight(x, y, z, CANOPY_THRESHOLD + EDGE_RISE, 10, seed);
    expect(edge).toBeCloseTo(inside * EDGE_TREES, 9);
    expect(inside).toBeGreaterThanOrEqual(s.height * (1 - LUMP) - 1e-9);
    expect(inside).toBeLessThanOrEqual(s.height * (1 + LUMP) + 1e-9);
    expect(edgeRise(CANOPY_THRESHOLD)).toBe(0);
    expect(edgeRise(CANOPY_THRESHOLD + EDGE_RISE)).toBe(1);
  });

  it('makes the cold all conifer, all firs, and lets pines into warmer conifer forest (decision 151)', () => {
    expect(coniferShare(CONIFER_T[1])).toBe(1);
    expect(coniferShare(0)).toBe(1);
    expect(coniferShare(CONIFER_T[0])).toBe(0);
    expect(pineShare(2)).toBe(0);
    expect(pineShare(10)).toBeCloseTo(0.4, 9);
  });

  it('hedges temperate maritime farmland, not continental plains or the tropics (decision 162)', () => {
    // Normandy: half-range about 6 K, wet, mean 11 °C, rolling. The Midwest: 14.5 K.
    expect(hedgeShare(6, 0.7, 11, 0.04, 0.7)).toBeGreaterThan(0.8);
    expect(hedgeShare(14.5, 0.45, 10, 0.01, 0.7)).toBeLessThanOrEqual(0.12);
    expect(hedgeShare(14.5, 0.45, 10, 0.01, 0.7)).toBeGreaterThan(0);
    // The tropics have small seasonal ranges too, and no bocage.
    expect(hedgeShare(2, 0.8, 26, 0.04, 0.7)).toBe(0);
    // A region of the same climate with another tradition.
    expect(hedgeShare(6, 0.7, 11, 0.04, 0.2)).toBe(0);
  });

  it('finds field boundaries, the same seen from either field (decision 162)', () => {
    const pts = line(3000, 1);
    let near = 0;
    let prev: string | null = null;
    for (const [x, y, z] of pts) {
      const f = fieldAt(x, y, z, seed);
      expect(f.edge).toBeGreaterThanOrEqual(-1e-6);
      const key = f.cell.join(',');
      // Where the field changes, the point is on (within a step of) the boundary.
      if (prev !== null && key !== prev) expect(f.edge).toBeLessThan(1.5);
      if (f.edge < 1) near++;
      prev = key;
      expect(edgeDraw(f.cell, f.cell2, seed)).toBe(edgeDraw(f.cell2, f.cell, seed));
    }
    expect(near).toBeGreaterThan(0);
  });
});
