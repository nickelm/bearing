import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { computeDrainage } from '../src/worldgen/drainage';
import { cellCenterDirection, extractRivers, riverWidth } from '../src/worldgen/rivers';

const n = 48;
const grid = new CubeGrid(n);
const R = 1_000_000;

function world() {
  // A tilted plane of land with ridges, so several rivers form and merge before the coast.
  const h = new Float32Array(grid.cellCount);
  const d = new Vec3d();
  const center = latLonToDirection(10 * DEG, 0);
  for (let c = 0; c < grid.cellCount; c++) {
    grid.center(c, d);
    const lat = Math.asin(d.y);
    const lon = Math.atan2(d.x, d.z);
    const inside = Math.acos(Math.min(1, d.dot(center))) < 35 * DEG;
    h[c] = inside ? 50 + (2000 * (lat / DEG + 25)) / 70 + 150 * Math.abs(Math.sin(lon * 9)) : -200;
  }
  return h;
}

describe('extractRivers', () => {
  const h = world();
  const runoff = new Float32Array(grid.cellCount).fill(600);
  const dr = computeDrainage(n, h, runoff, R);
  const rivers = extractRivers(n, h, dr.receiver, dr.discharge, {
    minDischarge: 30,
    widthCoefficient: 4,
  });

  it('finds rivers whose points follow the receivers', () => {
    expect(rivers.count).toBeGreaterThan(3);
    for (let k = 0; k < rivers.count; k++) {
      const a = rivers.offsets[k]!;
      const b = rivers.offsets[k + 1]!;
      expect(b - a).toBeGreaterThanOrEqual(2);
      for (let p = a; p + 1 < b; p++)
        expect(dr.receiver[rivers.cells[p]!]).toBe(rivers.cells[p + 1]);
    }
  });

  it('joins tributaries at the first cell of the downstream river, or ends at the sea', () => {
    let toSea = 0;
    for (let k = 0; k < rivers.count; k++) {
      const last = rivers.cells[rivers.offsets[k + 1]! - 1]!;
      const ds = rivers.downstream[k]!;
      if (ds < 0) {
        expect(h[last]!).toBeLessThanOrEqual(0);
        toSea++;
      } else {
        expect(rivers.cells[rivers.offsets[ds]!]).toBe(last);
      }
    }
    expect(toSea).toBeGreaterThan(0);
  });

  it('widens downstream with w = a·√Q and stores cell-center directions', () => {
    const d = new Vec3d();
    for (let k = 0; k < rivers.count; k++) {
      for (let p = rivers.offsets[k]!; p < rivers.offsets[k + 1]! - 1; p++) {
        expect(rivers.width[p]).toBeCloseTo(riverWidth(rivers.discharge[p]!), 3);
        if (p > rivers.offsets[k]!) {
          expect(rivers.discharge[p]!).toBeGreaterThanOrEqual(rivers.discharge[p - 1]!);
        }
        cellCenterDirection(n, rivers.cells[p]!, d);
        expect(rivers.points[p * 3]).toBe(d.x);
      }
    }
    expect(riverWidth(100)).toBeCloseTo(40, 6);
  });
});
