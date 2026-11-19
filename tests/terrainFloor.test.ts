import { describe, expect, it } from 'vitest';
import { arcDistance } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { aircraftType } from '../src/sim/air/aircraft';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { planMissionRoute } from '../src/sim/air/missionRoute';
import { routeEndFuel, routeState, routeTimeline } from '../src/sim/air/route';
import type { Route } from '../src/sim/air/route';
import { clearanceFor, GROUND_RAMP } from '../src/sim/air/terrainFloor';
import type { GroundSource } from '../src/sim/air/terrainFloor';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};
const base = dir(10, 0);
// A ridge 1,800 m high across the last part of the way to a target at longitude T (from
// 0.6 T to 0.75 T, where low-level routes are already low), a plateau of 600 m beyond.
const lonOf = (d: Readonly<Dir>) => Math.atan2(d[0], d[2]) / DEG;
const ridge =
  (T: number): GroundSource =>
  (d) => {
    const lon = lonOf(d);
    return lon > 0.6 * T && lon < 0.75 * T ? 1800 : lon >= 0.75 * T ? 600 : 0;
  };

function plan(
  typeId: string,
  mission: keyof typeof MISSION_PROFILES,
  target: Dir,
  g?: GroundSource,
) {
  const type = aircraftType(typeId);
  const profile = MISSION_PROFILES[mission];
  return planMissionRoute({
    type,
    loadout: type.loadouts.find((l) => l.id === profile.loadout) ?? type.loadouts[0]!,
    profile,
    radius: R,
    rangeFactor: 1,
    basePoint: () => base,
    carrierBased: false,
    target,
    launch: 1000,
    ground: g,
  })!;
}

/** Lowest height over the ground (less the clearance owed there) along a route's airborne time. */
function worstClearance(route: Route, clearance: number, ground: GroundSource): number {
  const fields = route.segments.filter((s) => s.kind === 'ground').map((s) => s.a);
  let worst = Infinity;
  const t0 = route.segments[0]!.t0;
  const t1 = route.segments[route.segments.length - 1]!.t1;
  for (let t = t0; t <= t1; t += 2) {
    const s = routeState(route, t, R);
    if (!s.airborne) continue;
    const near = Math.min(...fields.map((f) => arcDistance(s.point, f, R)));
    const owed = clearance * Math.min(1, near / GROUND_RAMP);
    worst = Math.min(worst, s.altitude - ground(s.point) - owed);
  }
  return worst;
}

describe('the terrain floor', () => {
  // The low-level profiles (MISSION_PROFILES' `low`), which flew through the ridge before.
  for (const [typeId, mission, T] of [
    ['f124', 'deep-strike', 12],
    ['rf34', 'recon', 12],
    ['c150', 'airdrop', 12],
    ['ah70', 'helo-cas', 3],
  ] as const) {
    it(`keeps a ${typeId} ${mission} route above the ridge, with its times and fuel`, () => {
      const target = dir(10, T);
      const ground = ridge(T);
      const flat = plan(typeId, mission, target);
      const floored = plan(typeId, mission, target, ground);
      expect(flat, typeId).not.toBeNull();
      // Without the floor the route goes through the ridge or the plateau.
      expect(worstClearance(flat, 0, ground)).toBeLessThan(0);
      // With it: nowhere below the ground plus the clearance owed (within a meter).
      expect(worstClearance(floored, clearanceFor(aircraftType(typeId)), ground)).toBeGreaterThan(
        -1,
      );
      expect(routeTimeline(floored)).toEqual(routeTimeline(flat));
      expect(routeEndFuel(floored)).toBeCloseTo(routeEndFuel(flat), 6);
      // Continuous in time and altitude, and fields on the ground's height.
      for (let i = 1; i < floored.segments.length; i++) {
        const a = floored.segments[i - 1]!;
        const b = floored.segments[i]!;
        expect(b.t0).toBe(a.t1);
        if (a.kind !== 'ground' && b.kind !== 'ground') expect(b.alt0).toBe(a.alt1);
      }
      for (const s of floored.segments) {
        if (s.kind === 'ground') expect(s.alt0).toBe(Math.max(0, ground(s.a)));
      }
    });
  }

  it('keeps a medium-altitude route clear too', () => {
    const ground = ridge(12);
    const floored = plan('a15', 'cas', dir(10, 12), ground);
    expect(worstClearance(floored, clearanceFor(aircraftType('a15')), ground)).toBeGreaterThan(-1);
  });

  it('leaves a route over the sea alone', () => {
    const target = dir(10, 2.5);
    const flat = plan('f21', 'cas', target);
    const floored = plan('f21', 'cas', target, () => 0);
    // Only the legs that came below the clearance near the ground change.
    expect(floored.segments.length).toBeGreaterThanOrEqual(flat.segments.length);
    expect(routeTimeline(floored)).toEqual(routeTimeline(flat));
  });
});
