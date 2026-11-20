import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { drawnLeadPose, drawnReference, FOLLOW_CLEARANCE } from '../src/follow/followFlight';
import {
  flightSpecOfType,
  FullFidelity,
  fullFidelityWanted,
  routeKey,
} from '../src/follow/fullFidelity';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { analyticPose } from '../src/sim/air/analyticPose';
import { formationAt, slotPose } from '../src/sim/air/formation';
import type { Mission } from '../src/sim/air/mission';
import { missionPlugin } from '../src/sim/command/missions/registry';
import type { FlightModel } from '../src/sim/flight/flightModel';
import type { WeatherView } from '../src/sim/weather/frame';
import { capMission, phaseStart, R, SPAN, seaLevel } from './helpers/promoted';

const flightData = (id: string) => MODEL_SPECS[id]?.flight;
const formations = missionPlugin('cap').formations;

/** The flight's poses at t as the view draws them over flat ground (no field shift, no lift). */
function poses(m: Mission, t: number) {
  const lead = analyticPose(m.route, t, R);
  const f = formationAt(m.timeline, formations, t);
  return Array.from({ length: m.aircraft }, (_, k) => slotPose(lead, k, f, SPAN));
}

function fullFlight(get: () => Mission, t: number): FullFidelity {
  const m = get();
  return new FullFidelity(
    {
      radius: R,
      mission: get,
      leadPose: (mm, u) => drawnLeadPose(mm, u, R),
      ground: seaLevel,
      formations,
      gearHeight: 2,
      clearance: FOLLOW_CLEARANCE,
      span: SPAN,
    },
    flightSpecOfType('f21', flightData)!,
    m,
    t,
    poses(m, t),
  );
}

describe('a followed flight at full fidelity', () => {
  it('has flight data for the F-21 alone among the fixed-wing types today', () => {
    const flown = AIRCRAFT_TYPES.filter((t) => flightSpecOfType(t.id, flightData) !== null).map(
      (t) => t.id,
    );
    expect(flown).toEqual(['f21']);
  });

  it('is wanted inside the jump-in window, at the flight cap or slower, never at the approach', () => {
    const m = capMission();
    const at = (t: number, rate = 1) => fullFidelityWanted(m, t, rate, poses(m, t));
    expect(at(phaseStart(m, 'departure') + 5)).toBe(false);
    expect(at(phaseStart(m, 'climb-out') + 5)).toBe(true);
    expect(at(phaseStart(m, 'on-target') + 60)).toBe(true);
    expect(at(phaseStart(m, 'on-target') + 60, 8)).toBe(true);
    expect(at(phaseStart(m, 'on-target') + 60, 16)).toBe(false);
    expect(at(phaseStart(m, 'approach') + 1)).toBe(false);
  });

  it('lifts the lead’s reference over the drawn ground, and not below the route', () => {
    const m = capMission();
    const t = phaseStart(m, 'climb-out') + 20;
    const p = analyticPose(m.route, t, R);
    const route = new Vec3d(...p.pos);
    const flat = drawnReference(
      (u) => analyticPose(m.route, u, R),
      () => 0,
      2,
    )(t)!;
    expect(flat.pos.distanceTo(route)).toBeLessThan(1e-6);
    const ridge = p.altitude + 400;
    const high = drawnReference(
      (u) => analyticPose(m.route, u, R),
      () => ridge,
      2,
    )(t)!;
    expect(high.pos.length() - R).toBeCloseTo(ridge + FOLLOW_CLEARANCE, 6);
  });

  it('takes the campaign’s losses off the highest slots and follows a new route', () => {
    let m = capMission();
    const t0 = phaseStart(m, 'on-target') + 300;
    const f = fullFlight(() => m, t0);
    let t = t0;
    for (; t < t0 + 10; t += 1 / 30) expect(f.advance(m, t)).toBe(true);
    // The worker's list replaces the mission: one aircraft lost in aggregate.
    m = { ...m, aircraft: 3 };
    f.advance(m, (t += 1 / 30));
    expect(f.flight.aircraft.map((a) => a.slot)).toEqual([0, 1, 2]);
    // A new route (here the same route a minute later) becomes the lead's reference.
    const key = routeKey(m);
    m = { ...m, route: { ...m.route, fuel: m.route.fuel - 1 } };
    expect(routeKey(m)).not.toBe(key);
    for (const end = t + 20; t < end; t += 1 / 30) f.advance(m, t);
    const lead = f.flight.aircraft[0]!.flown.airframe as FlightModel;
    expect(
      lead.pos.distanceTo(new Vec3d(...analyticPose(m.route, f.flight.time, R).pos)),
    ).toBeLessThan(400);
    // A clock far behind (a seek) asks for a new promotion.
    expect(f.advance(m, t + 60)).toBe(false);
  }, 60_000);

  it('hands back with the fix and the losses, the lead flying on until the rebuilt route arrives', () => {
    let m = capMission();
    const t0 = phaseStart(m, 'on-target') + 300;
    const f = fullFlight(() => m, t0);
    expect(f.flight.takeOver(0)).toBe(true);
    // The worker holds it: the list shows it flown.
    m = { ...m, flown: { slot: 0, since: t0 } };
    let t = t0;
    for (; t < t0 + 5; t += 1 / 30) f.advance(m, t);
    (f.flight.aircraft[3]!.flown.airframe as FlightModel).crash('test');
    const h = f.flight.handback();
    expect(h.fix.aircraft).toBe(3);
    expect(h.fix.airborne).toBe(true);
    expect(h.lost.map((l) => [l.slot, l.cause])).toEqual([[3, 'test']]);
    const lead = f.flight.aircraft[0]!.flown.airframe as FlightModel;
    const v = lead.vel.clone();
    f.handBack();
    expect(f.flight.playerSlot).toBeNull();
    // Still held: the reference is the lead's own track, not the old route.
    const ref = f.flight.pilots[0]!.reference(f.flight.time + 10)!;
    const ahead = lead.pos.clone().addScaled(v, 10);
    expect(ref.pos.distanceTo(ahead)).toBeLessThan(1e-6);
    // The rebuilt route arrives (the hold is gone): it is the reference again.
    m = { ...m, flown: undefined };
    f.advance(m, t + 1 / 30);
    const p = f.flight.pilots[0]!.reference(f.flight.time)!;
    expect(
      p.pos.distanceTo(new Vec3d(...analyticPose(m.route, f.flight.time, R).pos)),
    ).toBeLessThan(1);
  }, 60_000);

  it('hands back a flight with no aircraft left as lost where they fell', () => {
    const m = capMission();
    const f = fullFlight(() => m, phaseStart(m, 'fence-in') + 60);
    for (const a of f.flight.aircraft) (a.flown.airframe as FlightModel).crash('test');
    const h = f.flight.handback();
    expect(h.fix.aircraft).toBe(0);
    expect(h.lost).toHaveLength(4);
  });

  it('flies its route in a 25 m/s crosswind', () => {
    const m = capMission();
    const t0 = phaseStart(m, 'on-target') + 300;
    // A steady west wind everywhere, no gusts.
    const view = {
      ready: true,
      wind: (_p: unknown, _a: number, _t: number, out: { east: number; north: number }) => {
        out.east = 25;
        out.north = 0;
        return out;
      },
      report: () => ({ cloudCover: 0, storm: 0, cloudBase: 5000 }),
    } as unknown as WeatherView;
    const f = new FullFidelity(
      {
        radius: R,
        mission: () => m,
        leadPose: (mm, u) => drawnLeadPose(mm, u, R),
        ground: seaLevel,
        formations,
        gearHeight: 2,
        clearance: FOLLOW_CLEARANCE,
        span: SPAN,
        weather: () => view,
      },
      flightSpecOfType('f21', flightData)!,
      m,
      t0,
      poses(m, t0),
    );
    let worst = 0;
    for (let t = t0; t < t0 + 240; t += 1 / 30) {
      f.advance(m, t);
      if (t < t0 + 30) continue;
      const lead = f.flight.aircraft[0]!.flown.airframe as FlightModel;
      worst = Math.max(
        worst,
        lead.pos.distanceTo(new Vec3d(...analyticPose(m.route, f.flight.time, R).pos)),
      );
    }
    const lead = f.flight.aircraft[0]!.flown.airframe as FlightModel;
    // The air moves: airspeed and ground speed differ by the wind.
    expect(lead.wind.length()).toBeCloseTo(25, 3);
    expect(worst).toBeLessThan(600);
  }, 60_000);
});
