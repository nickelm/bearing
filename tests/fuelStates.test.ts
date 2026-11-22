/**
 * Joker, bingo and low fuel (decision 307): a mission's from its route, the strip's order
 * of the three, drop tanks counted.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { arcDistance } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { DEG } from '../src/core/units';
import { AIRCRAFT_TYPES, FUEL_RESERVE } from '../src/sim/air/aircraft';
import { fuelStates, JOKER_FIGHT } from '../src/sim/air/fuelStates';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { planMissionRoute } from '../src/sim/air/missionRoute';
import { routeState } from '../src/sim/air/route';
import { initialAvionics } from '../src/sim/avionics/avionics';
import { AVIONICS_PROFILES } from '../src/sim/avionics/profiles';
import type { AircraftSnapshot } from '../src/ui/displays/snapshot';
import { stripModel } from '../src/ui/displays/strip';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};
const type = AIRCRAFT_TYPES.find((t) => t.role === 'multirole' && t.side === 'alliance')!;
const base = dir(40, 10);
const route = planMissionRoute({
  type,
  loadout: type.loadouts[0]!,
  profile: MISSION_PROFILES.interdiction,
  radius: R,
  rangeFactor: 1,
  basePoint: () => base,
  carrierBased: false,
  target: dir(43, 14),
  launch: 0,
})!;

describe("a mission's fuel states (decision 307)", () => {
  it('keeps the reserve as low fuel, and bingo grows with the way home', () => {
    const near = fuelStates(route, dir(40.2, 10.2), base, R, type.cruiseSpeed);
    const far = fuelStates(route, dir(43, 14), base, R, type.cruiseSpeed);
    expect(near.low).toBeCloseTo(route.reserve, 6);
    expect(route.reserve).toBeCloseTo(FUEL_RESERVE * route.fuel, 0);
    expect(near.bingo).toBeGreaterThan(near.low);
    expect(far.bingo).toBeGreaterThan(near.bingo);
    expect(far.joker).toBeGreaterThan(far.bingo);
    // Joker is a fight's more than bingo, wherever the aircraft is.
    expect(far.joker - far.bingo).toBeCloseTo(near.joker - near.bingo, 6);
    expect(JOKER_FIGHT).toBeGreaterThan(0);
  });

  it('is met by the plan: over the target the route holds more than bingo, and lands above low', () => {
    const over = route.segments.find((s) => s.phase === 'on-target')!;
    const s = routeState(route, over.t1, R);
    const at = fuelStates(route, s.point, base, R, type.cruiseSpeed);
    expect(s.fuel).toBeGreaterThan(at.bingo);
    const last = route.segments[route.segments.length - 1]!;
    expect(routeState(route, last.t0, R).fuel).toBeGreaterThanOrEqual(at.low - 1e-6);
    expect(arcDistance(s.point, base, R)).toBeGreaterThan(50_000);
  });
});

function snap(mass: number, total?: number): AircraftSnapshot {
  return {
    time: 30,
    kind: 'jet',
    name: 'F-21 Kestrel',
    profile: AVIONICS_PROFILES['alliance-fighter']!,
    avionics: { ...initialAvionics(false) },
    position: { lat: 0.8, lon: 0.3, radius: R },
    destination: null,
    sensors: null,
    track: 0,
    heading: 0,
    onGround: false,
    cas: 220,
    groundSpeed: 220,
    radarAltitude: 3000,
    fuel: { mass, capacity: 2630, unlimited: false, joker: 1200, bingo: 800, low: 300, total },
    engine: { lever: 0.6, power: 0.7, afterburner: 0 },
    gear: { position: 0, down: false, fixed: false, overspeed: false },
    speedbrake: 0,
    brakes: false,
    parkingBrake: false,
    rotor: null,
    holds: [],
    control: 'mouse aim',
    mouseFree: false,
    messages: [],
  };
}

describe('the strip (decision 307)', () => {
  const fuelItems = (s: AircraftSnapshot) =>
    stripModel(s)
      .items.filter((i) => ['joker', 'bingo', 'low-fuel'].includes(i.id))
      .map((i) => [i.label, i.level]);

  it('shows JOKER, then BINGO, then LOW FUEL in its place', () => {
    expect(fuelItems(snap(1500))).toEqual([]);
    expect(fuelItems(snap(1000))).toEqual([['JOKER', 'caution']]);
    expect(fuelItems(snap(600))).toEqual([['BINGO', 'warning']]);
    expect(fuelItems(snap(200))).toEqual([['LOW FUEL', 'warning']]);
  });

  it('counts the fuel in the drop tanks', () => {
    expect(fuelItems(snap(1000, 1600))).toEqual([]);
  });
});
