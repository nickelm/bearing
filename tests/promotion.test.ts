import { describe, expect, it } from 'vitest';
import { KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import { analyticPose } from '../src/sim/air/analyticPose';
import { formationAt, slotPose } from '../src/sim/air/formation';
import { routeState } from '../src/sim/air/route';
import { missionPlugin } from '../src/sim/command/missions/registry';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { flightFuel, routeFuelOf } from '../src/sim/flight/promotion';
import { aircraftType } from '../src/sim/air/aircraft';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { rejoinRoute } from '../src/sim/air/missionRoute';
import {
  capMission,
  dir,
  phaseStart,
  promote,
  R,
  routeReference,
  seaLevel,
  SPAN,
} from './helpers/promoted';

const m = capMission();
const formations = missionPlugin('cap').formations;
const lead = (a: { flown: { airframe: unknown } }) => a.flown.airframe as FlightModel;

describe('promotion', () => {
  it('places each aircraft at its drawn pose with the route’s share of fuel, gear up and power on', () => {
    const t = phaseStart(m, 'on-target') + 200;
    const f = promote(m, t);
    expect(f.aircraft).toHaveLength(4);
    const p = analyticPose(m.route, t, R);
    const fs = formationAt(m.timeline, formations, t);
    const share = routeState(m.route, t, R).fuel / m.route.fuel;
    f.aircraft.forEach((a, k) => {
      const s = slotPose(p, k, fs, SPAN);
      const model = lead(a);
      expect(model.pos.distanceTo(new Vec3d(...s.pos))).toBeLessThan(1e-6);
      expect(model.vel.distanceTo(new Vec3d(...s.velocity))).toBeLessThan(1e-6);
      expect(model.gear).toBe(0);
      expect(model.power).toBeGreaterThan(0);
      expect(model.fuel / model.spec.mass.fuel).toBeCloseTo(share, 9);
      expect(a.stores).toEqual({ loadout: 'air-to-air', expended: {} });
    });
  });

  it('folds back to the route’s state: where the lead is, its track, speed and fuel', () => {
    const t = phaseStart(m, 'on-target') + 200;
    const f = promote(m, t);
    const d = f.demote()!;
    const s = routeState(m.route, t, R);
    expect(d.aircraft).toBe(4);
    expect(d.lost).toEqual([]);
    expect(d.slot).toBe(0);
    const at = new Vec3d(...d.point).distanceTo(new Vec3d(...s.point)) * R;
    expect(at).toBeLessThan(1);
    expect(d.altitude).toBeCloseTo(s.altitude, 3);
    expect(
      Math.abs(Math.atan2(Math.sin(d.heading - s.heading), Math.cos(d.heading - s.heading))),
    ).toBeLessThan(0.02);
    expect(d.fuel).toBeCloseTo(s.fuel, 6);
    expect(d.airborne).toBe(true);
  });

  it('counts a crashed aircraft as lost and leads from the next', () => {
    const f = promote(m, phaseStart(m, 'fence-in') + 30);
    lead(f.aircraft[0]!).crash('test');
    const d = f.demote()!;
    expect(d.aircraft).toBe(3);
    expect(d.lost.map((l) => [l.slot, l.cause])).toEqual([[0, 'test']]);
    expect(d.slot).toBe(1);
  });

  it('maps fuel by share both ways', () => {
    expect(flightFuel(2900, 5800, 3200)).toBe(1600);
    expect(routeFuelOf(1600, 3200, 5800)).toBe(2900);
    expect(flightFuel(9000, 5800, 3200)).toBe(3200);
  });
});

describe('the AI pilots of a promoted CAP flight', () => {
  it('fly the route from the climb-out to the approach: the lead on its route, the wingmen on their slots', () => {
    // Two aircraft keep the test short; slots 2 and 3 fly the same law.
    const pair = { ...m, aircraft: 2 };
    const t0 = phaseStart(pair, 'climb-out') + 30;
    const t1 = phaseStart(pair, 'approach');
    const station = phaseStart(pair, 'on-target');
    const f = promote(pair, t0);
    const fuel0 = lead(f.aircraft[0]!).fuel;
    let worst = 0;
    let worstOnStation = 0;
    let worstWing = 0;
    for (let t = t0; t < t1; t += 1 / 30) {
      f.advanceTo(t, seaLevel);
      if (f.steps === 0) continue;
      const e = lead(f.aircraft[0]!).pos.distanceTo(
        new Vec3d(...analyticPose(pair.route, f.time, R).pos),
      );
      worst = Math.max(worst, e);
      // After the first straight leg of the racetrack, the station is held closely.
      if (f.time > station + 300 && f.time < phaseStart(pair, 'egress')) {
        worstOnStation = Math.max(worstOnStation, e);
        const w = f.pilots[1]!.state;
        worstWing = Math.max(worstWing, Math.hypot(w.behind, w.aside, w.below));
      }
    }
    expect(f.aircraft.map((a) => a.flown.crashed)).toEqual([null, null]);
    // The route climbs faster than the Kestrel can at its climb speed: it follows late, not stalled.
    expect(worst).toBeLessThan(5000);
    expect(worstOnStation).toBeLessThan(400);
    expect(worstWing).toBeLessThan(600);
    expect(lead(f.aircraft[0]!).fuel).toBeLessThan(fuel0);
  }, 120_000);

  it('keep formation on the player’s lead, and the lead flies its route again after the handback', () => {
    const t0 = phaseStart(m, 'on-target') + 400;
    const f = promote({ ...m, aircraft: 2 }, t0);
    expect(f.takeOver(0)).toBe(true);
    expect(f.playerSlot).toBe(0);
    // The player turns 60° off the route at 300 kt through its own input source (as mouse aim would).
    const player = lead(f.aircraft[0]!);
    const director = new FlightDirector();
    const course = analyticPose(m.route, t0, R).heading + Math.PI / 3;
    f.aircraft[0]!.flown.pilot = (_a, ctl, dt) =>
      director.fly(player, { course, gamma: 0, speed: 300 * KNOT, maxBank: Math.PI / 6 }, ctl, dt);
    let t = t0;
    for (; t < t0 + 90; t += 1 / 30) f.advanceTo(t, seaLevel);
    const w = f.pilots[1]!.state;
    expect(Math.hypot(w.behind, w.aside, w.below)).toBeLessThan(500);
    // A straight course leaves the racetrack: the player is kilometers off the route.
    const off = player.pos.distanceTo(new Vec3d(...analyticPose(m.route, f.time, R).pos));
    expect(off).toBeGreaterThan(5000);
    // The worker rebuilds the mission from where the flight is (the handback's demotion).
    const d = f.demote()!;
    const route = rejoinRoute({
      type: aircraftType('f21'),
      loadout: aircraftType('f21').loadouts[0]!,
      profile: MISSION_PROFILES.cap,
      radius: R,
      rangeFactor: 1,
      basePoint: () => dir(40, 10),
      carrierBased: false,
      target: m.target.point,
      route: m.route,
      fix: d,
    });
    f.handBack(routeReference(route));
    expect(f.playerSlot).toBeNull();
    let worstAfter = 0;
    for (; t < t0 + 330; t += 1 / 30) {
      f.advanceTo(t, seaLevel);
      const p = analyticPose(route, f.time, R).pos;
      worstAfter = Math.max(worstAfter, lead(f.aircraft[0]!).pos.distanceTo(new Vec3d(...p)));
    }
    // On its new route from the first second, through the turn back to the station.
    expect(worstAfter).toBeLessThan(800);
  }, 60_000);

  it('drops the highest slots the player does not fly when the campaign loses aircraft', () => {
    const f = promote(m, phaseStart(m, 'fence-in') + 10);
    f.takeOver(3);
    expect(f.remove(2)).toBe(2);
    expect(f.aircraft.map((a) => a.slot)).toEqual([0, 3]);
  });
});
