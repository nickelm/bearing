/**
 * R2.7's flyable jets at full fidelity: a Vo-31 CAP and Vo-35 and A-15 close air support
 * flights promoted from their routes fly them from the climb-out to the approach
 * through the same AI pilots, director and flight model as the F-21's (rule 12), without a
 * crash, the lead near its route, the gear up and fuel burned.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { analyticPose } from '../src/sim/air/analyticPose';
import { MIL_DETENT } from '../src/sim/flight/controlLaws';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { flightSpecOf } from './helpers/flight';
import { capMission, phaseStart, promote, R, seaLevel } from './helpers/promoted';

const lead = (a: { flown: { airframe: unknown } }) => a.flown.airframe as FlightModel;

describe.each([
  ['vo31', 'pact-fighter', 'cap'],
  ['vo35', 'pact-strike', 'cas'],
  ['a15', 'a15', 'cas'],
] as const)('a promoted %s flight', (type, bundle, mission) => {
  it(`flies its ${mission} route from the climb-out to the approach`, () => {
    const m = { ...capMission(type, mission), aircraft: 2 };
    const t0 = phaseStart(m, 'climb-out') + 30;
    const t1 = phaseStart(m, 'approach');
    const spec = flightSpecOf(bundle);
    const f = promote(m, t0, undefined, spec);
    const fuel0 = lead(f.aircraft[0]!).fuel;
    let worst = 0;
    let worstLate = 0;
    let lever = 0;
    const late = phaseStart(m, 'on-target') + 300;
    for (let t = t0; t < t1; t += 1 / 30) {
      f.advanceTo(t, seaLevel);
      if (f.steps === 0) continue;
      lever = Math.max(lever, (f.aircraft[0]!.flown.controls as { throttle: number }).throttle);
      const e = lead(f.aircraft[0]!).pos.distanceTo(
        new Vec3d(...analyticPose(m.route, f.time, R).pos),
      );
      worst = Math.max(worst, e);
      if (f.time > late) worstLate = Math.max(worstLate, e);
    }
    expect(f.aircraft.map((a) => a.flown.crashed)).toEqual([null, null]);
    for (const a of f.aircraft) {
      expect(lead(a).gear).toBe(0);
      expect(lead(a).gearDamaged).toBe(false);
    }
    // The lead keeps to 90% of military power outside combat (decisions 310, 311).
    expect(lever).toBeLessThanOrEqual(0.9 * MIL_DETENT + 1e-9);
    // Today: the Vo-31 3.4 km behind in the climb, 0.4 km on station; the Vo-35 1.4 km.
    expect(worst).toBeLessThan(6000);
    expect(worstLate).toBeLessThan(2000);
    expect(lead(f.aircraft[0]!).fuel).toBeLessThan(fuel0);
  }, 180_000);
});
