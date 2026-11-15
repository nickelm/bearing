import { describe, expect, it } from 'vitest';
import { PLANET_RADIUS } from '../src/core/units';
import {
  DELTA_FIELDS,
  DELTA_TUNING,
  MEANDER_TUNING,
  RIVER_SEGMENT_FIELDS as F,
  RiverIndex,
} from '../src/worldgen/riverIndex';
import { straightRiver } from './helpers/rivers';

const R = PLANET_RADIUS;

/** Path length (m) of the index's segments, and their first and last points. */
function path(index: RiverIndex): { length: number; first: number[]; last: number[] } {
  const d = index.segments.data;
  const n = index.segments.count;
  let length = 0;
  for (let s = 0; s < n; s++) {
    const o = s * F;
    const dot = d[o]! * d[o + 3]! + d[o + 1]! * d[o + 4]! + d[o + 2]! * d[o + 5]!;
    length += Math.acos(Math.min(1, dot)) * R;
  }
  const o = (n - 1) * F;
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
      expect(Math.abs(Math.asin(d[s * F + 1]!)) * R).toBeLessThan(limit);
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

  it('gives rivers water surfaces that never rise downstream (decision 146)', () => {
    // A bed that falls, then rises 30 m (the interpolated terrain over a spur), then falls.
    const rivers = straightRiver(30);
    rivers.cells = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const height = Float32Array.from([120, 110, 100, 130, 95, 90, 85, 80]);
    const index = new RiverIndex(rivers, { height, radius: R });
    const d = index.segments.data;
    let prev = Infinity;
    for (let s = 0; s < index.segments.count; s++) {
      const o = s * F;
      for (const k of [8, 9, 10, 11]) expect(d[o + k]!).toBeLessThanOrEqual(prev + 1e-9);
      expect(d[o + 9]!).toBeLessThanOrEqual(d[o + 8]! + 1e-9);
      expect(d[o + 11]!).toBeLessThanOrEqual(d[o + 10]! + 1e-9);
      expect(d[o + 10]!).toBeLessThanOrEqual(d[o + 8]! + 1e-9);
      prev = Math.min(d[o + 9]!, d[o + 8]!);
    }
    // Starts half a meter below the first cell, ends below the last.
    expect(d[8]).toBeCloseTo(119.5, 6);
    expect(d[(index.segments.count - 1) * F + 9]).toBeLessThanOrEqual(79.5 + 1e-9);
  });

  it("meets a tributary at the main river's surface and steps steep reaches", () => {
    // Tributary 0 (cells 0..2) joins main river 1 (cells 2..5) at cell 2.
    const pts = [
      [0, 10],
      [0, 10.05],
      [0, 10.1],
      [0, 10.15],
      [0, 10.2],
      [0, 10.25],
    ];
    const rivers = straightRiver(30);
    const dirs = new Float64Array(7 * 3);
    const order = [0, 1, 2, 2, 3, 4, 5];
    order.forEach((p, i) => {
      const lat = (pts[p]![0]! * Math.PI) / 180;
      const lon = (pts[p]![1]! * Math.PI) / 180;
      dirs.set(
        [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)],
        i * 3,
      );
    });
    rivers.count = 2;
    rivers.offsets = Uint32Array.from([0, 3, 7]);
    rivers.cells = Int32Array.from(order);
    rivers.points = dirs;
    rivers.width = new Float32Array(7).fill(30);
    rivers.discharge = new Float32Array(7).fill(56);
    rivers.downstream = Int32Array.from([1, -1]);
    // Steep: 1,000 m down to 400 m over about 28 km (about 2% gradient), cell 2 raised.
    const height = Float32Array.from([1000, 900, 950, 700, 550, 400]);
    const index = new RiverIndex(rivers, { height, radius: R });
    const d = index.segments.data;
    // The tributary's last segment ends where the main river's first begins.
    const j = [dirs[6]!, dirs[7]!, dirs[8]!];
    const at = (o: number) =>
      Math.hypot(d[o]! - j[0]!, d[o + 1]! - j[1]!, d[o + 2]! - j[2]!) < 1e-12;
    let tribEnd = -1;
    let mainStart = -1;
    for (let s = 0; s < index.segments.count; s++) {
      if (at(s * F + 3)) tribEnd = s;
      if (at(s * F) && mainStart < 0) mainStart = s;
    }
    expect(tribEnd).toBeGreaterThanOrEqual(0);
    expect(d[tribEnd * F + 9]).toBeCloseTo(d[mainStart * F + 8]!, 9);
    expect(d[tribEnd * F + 11]).toBeCloseTo(d[mainStart * F + 10]!, 9);
    // The raised junction cell is cut down to the tributary's lower (smoothed) surface.
    expect(d[mainStart * F + 8]!).toBeLessThan(949.5 - 30);
    // Steep reaches step: the stepped surface sits in pools at multiples of the strata.
    let pooled = 0;
    let total = 0;
    for (let s = mainStart; s < index.segments.count; s++) {
      const p = d[s * F + 10]!;
      total++;
      if (Math.abs(p / 75 - Math.round(p / 75)) < 0.02) pooled++;
    }
    expect(pooled / total).toBeGreaterThan(0.5);
  });
});
