/**
 * The ground map (sim/sensors/groundMap.ts, decision 226): radar shadow behind high
 * ground, bright slopes facing the aircraft, dark water, determinism, and its format.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { applyCommand, groundRadarRange, initialAvionics } from '../src/sim/avionics/avionics';
import { groundMap } from '../src/sim/sensors/groundMap';
import type { MapGround } from '../src/sim/sensors/groundMap';

const R = 1_000_000;
// The aircraft over latitude 0, longitude 0 (up +z), nose north (+y).
const pos = new Vec3d(0, 0, R + 3000);
const fwd = new Vec3d(0, 1, 0);
// Ground distance north of the aircraft along a unit direction.
const north = (d: Readonly<Vec3d>) => Math.atan2(d.y, d.z) * R;

const flat: MapGround = { height: () => 50, water: () => false };
/** A ridge 400 m high 10–11 km north; the sea beyond 25 km. */
const ridge: MapGround = {
  height: (d) => {
    const n = north(d);
    return n > 10_000 && n < 11_000 ? 50 + ((n - 10_000) / 1000) * 400 : 50;
  },
  water: (d) => north(d) > 25_000,
};
const row = (img: ReturnType<typeof groundMap>, ground: number) =>
  Math.min(img.rows - 1, Math.floor((ground / img.range) * img.rows));
const center = (img: ReturnType<typeof groundMap>, ground: number) => {
  const r = row(img, ground);
  let sum = 0;
  for (let i = img.cols / 2 - 3; i < img.cols / 2 + 3; i++) sum += img.values[r * img.cols + i]!;
  return sum / 6;
};

describe('the ground map (decision 226)', () => {
  it('paints flat ground evenly, and is the same every time', () => {
    const a = groundMap(pos, fwd, 30_000, Math.PI / 3, R, flat);
    expect(a.values).toHaveLength(a.cols * a.rows);
    expect(center(a, 5000)).toBeGreaterThan(30);
    expect(groundMap(pos, fwd, 30_000, Math.PI / 3, R, flat)).toEqual(a);
  });

  it('lights a slope facing the aircraft, shadows the ground behind it, darkens water', () => {
    const img = groundMap(pos, fwd, 30_000, Math.PI / 3, R, ridge);
    const plain = center(img, 6000);
    expect(center(img, 10_500)).toBeGreaterThan(plain * 1.5);
    // Just behind the ridge (whose shadow from 3,000 m reaches 12.7 km): radar shadow.
    expect(center(img, 11_800)).toBe(0);
    expect(center(img, 13_500)).toBeGreaterThan(0);
    // The sea far out is nearly black where it is not in shadow.
    const sea = center(img, 29_000);
    expect(sea).toBeLessThan(plain / 3);
  });

  it('steps its range in each skin, from the avionics', () => {
    let a = initialAvionics(false);
    expect(groundRadarRange('alliance', a.groundRadar.range)).toBe(20 * 1852);
    a = applyCommand(applyCommand(a, { type: 'ground-radar-range', delta: 1 }), {
      type: 'ground-radar-range',
      delta: 1,
    });
    expect(a.groundRadar.range).toBe(3);
    expect(groundRadarRange('pact', a.groundRadar.range)).toBe(80_000);
  });
});
