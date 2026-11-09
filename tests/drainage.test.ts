import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { DAY, DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { computeDrainage, neighbors8 } from '../src/worldgen/drainage';

const R = 1_000_000;
const n = 32;
const grid = new CubeGrid(n);
const d = new Vec3d();

/** A circular island around `center` (angular radius `rad`), rising like a cone to `peak` m. */
function island(rad: number, peak: number, pit?: { at: Vec3d; radius: number; depth: number }) {
  const center = latLonToDirection(20 * DEG, 30 * DEG);
  const h = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    grid.center(c, d);
    const a = Math.acos(Math.min(1, d.dot(center)));
    h[c] = a < rad ? peak * (1 - a / rad) + 1 : -100;
    if (pit && h[c]! > 0) {
      const b = Math.acos(Math.min(1, d.dot(pit.at)));
      if (b < pit.radius) h[c] = Math.max(1, h[c]! - pit.depth * (1 - b / pit.radius));
    }
  }
  return { h, center };
}

describe('computeDrainage', () => {
  it('matches CubeGrid 8-neighborhoods', () => {
    const out = new Int32Array(8);
    for (let c = 0; c < grid.cellCount; c += 5) {
      neighbors8(n, c, out);
      for (let k = 0; k < 8; k++) expect(out[k]).toBe(grid.neighbors8[c * 8 + k] ?? -1);
    }
  });

  it('drains a cone outward to the sea and conserves runoff', () => {
    const { h, center } = island(25 * DEG, 1000);
    const runoff = new Float32Array(grid.cellCount).fill(500);
    const dr = computeDrainage(n, h, runoff, R);
    const cellArea = (4 * Math.PI * R * R) / grid.cellCount;
    const perCell = (0.5 * cellArea) / (365 * DAY);
    let landCells = 0;
    let toSea = 0;
    for (let c = 0; c < grid.cellCount; c++) {
      if (h[c]! <= 0) {
        expect(dr.receiver[c]).toBe(-1);
        continue;
      }
      landCells++;
      const r = dr.receiver[c]!;
      expect(r).toBeGreaterThanOrEqual(0);
      // Away from the summit, flow moves away from the center.
      grid.center(c, d);
      const a = d.dot(center);
      const b = new Vec3d();
      grid.center(r, b);
      expect(b.dot(center)).toBeLessThanOrEqual(a + 1e-12);
      if (h[r]! <= 0) toSea += dr.discharge[c]!;
      expect(dr.lakeDepth[c]).toBe(0);
    }
    expect(toSea).toBeCloseTo(landCells * perCell, 3);
  });

  it('turns a closed depression into a lake that still drains through its outlet', () => {
    const pitAt = latLonToDirection(20 * DEG, 38 * DEG);
    const { h } = island(25 * DEG, 1000, { at: pitAt, radius: 5 * DEG, depth: 600 });
    const runoff = new Float32Array(grid.cellCount).fill(500);
    const dr = computeDrainage(n, h, runoff, R);
    const pitCell = grid.cellOfDirection(pitAt);
    expect(dr.lakeDepth[pitCell]!).toBeGreaterThan(100);
    // Following receivers from the lake bottom reaches the sea.
    let c = pitCell;
    for (let steps = 0; steps < grid.cellCount && h[c]! > 0; steps++) c = dr.receiver[c]!;
    expect(h[c]!).toBeLessThanOrEqual(0);
  });

  it('accumulates more discharge downstream', () => {
    const { h } = island(25 * DEG, 1000);
    const runoff = new Float32Array(grid.cellCount).fill(300);
    const dr = computeDrainage(n, h, runoff, R);
    for (let c = 0; c < grid.cellCount; c++) {
      const r = dr.receiver[c]!;
      if (h[c]! > 0 && h[r]! > 0) expect(dr.discharge[r]!).toBeGreaterThan(dr.discharge[c]!);
    }
  });
});
