import { describe, expect, it } from 'vitest';
import { PLANET_RADIUS } from '../src/core/units';
import { DELTA_FIELDS, DELTA_TUNING, MEANDER_TUNING, RiverIndex } from '../src/worldgen/riverIndex';
import { straightRiver } from './helpers/rivers';

const R = PLANET_RADIUS;

/** Path length (m) of the index's segments, and their first and last points. */
function path(index: RiverIndex): { length: number; first: number[]; last: number[] } {
  const d = index.segments.data;
  const n = index.segments.count;
  let length = 0;
  for (let s = 0; s < n; s++) {
    const o = s * 8;
    const dot = d[o]! * d[o + 3]! + d[o + 1]! * d[o + 4]! + d[o + 2]! * d[o + 5]!;
    length += Math.acos(Math.min(1, dot)) * R;
  }
  const o = (n - 1) * 8;
  return { length, first: [d[0]!, d[1]!, d[2]!], last: [d[o + 3]!, d[o + 4]!, d[o + 5]!] };
}

describe('landforms (decision 126)', () => {
  it('meanders lowland rivers and keeps their ends in place', () => {
    const rivers = straightRiver(60);
    const straight = path(new RiverIndex(rivers));
    // A flat bed: every point at the same height.
    const flat = path(new RiverIndex(rivers, { height: new Float32Array(8).fill(20), radius: R }));
    expect(flat.length).toBeGreaterThan(1.3 * straight.length);
    for (let k = 0; k < 3; k++) {
      expect(flat.first[k]).toBeCloseTo(straight.first[k]!, 9);
      expect(flat.last[k]).toBeCloseTo(straight.last[k]!, 9);
    }
  });

  it('keeps steep rivers straight, and bends within the amplitude', () => {
    const rivers = straightRiver(60);
    rivers.cells = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const steep = new Float32Array(8).map((_, i) => 800 - 100 * i);
    const straight = path(new RiverIndex(rivers));
    const kept = path(new RiverIndex(rivers, { height: steep, radius: R }));
    expect(kept.length).toBeCloseTo(straight.length, 0);
    // Lateral offset from the equator never exceeds the amplitude of the longest bend.
    const index = new RiverIndex(straightRiver(60), {
      height: new Float32Array(8).fill(20),
      radius: R,
    });
    const lambda = MEANDER_TUNING.wavelength * 60 * (1 + MEANDER_TUNING.wavelengthJitter);
    const limit = 1.2 * MEANDER_TUNING.amplitude * lambda;
    const d = index.segments.data;
    for (let s = 0; s < index.segments.count; s++) {
      expect(Math.abs(Math.asin(d[s * 8 + 1]!)) * R).toBeLessThan(limit);
    }
  });

  it('builds deltas only at the mouths of wide rivers', () => {
    expect(new RiverIndex(straightRiver(DELTA_TUNING.minWidth / 2)).deltas.length).toBe(0);
    const wide = new RiverIndex(straightRiver(200));
    expect(wide.deltas.length).toBe(DELTA_FIELDS);
    expect(wide.deltas[6]).toBeCloseTo(200, 3);
    expect(wide.deltas[7]).toBeCloseTo(
      Math.min(DELTA_TUNING.maxRadius, DELTA_TUNING.radiusWidths * 200),
      3,
    );
    // The seaward direction is a unit tangent pointing downstream (east along the equator).
    const dir = [wide.deltas[3]!, wide.deltas[4]!, wide.deltas[5]!];
    expect(Math.hypot(...dir)).toBeCloseTo(1, 6);
    const mouth = [wide.deltas[0]!, wide.deltas[1]!, wide.deltas[2]!];
    expect(mouth[0]! * dir[0]! + mouth[1]! * dir[1]! + mouth[2]! * dir[2]!).toBeCloseTo(0, 6);
  });
});
