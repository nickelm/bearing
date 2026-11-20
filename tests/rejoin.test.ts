import { describe, expect, it } from 'vitest';
import { arcDistance, destination, initialHeading } from '../src/core/greatCircle';
import { DEG } from '../src/core/units';
import { aircraftType } from '../src/sim/air/aircraft';
import { MISSION_PHASES, MISSION_PROFILES } from '../src/sim/air/mission';
import type { MissionPhase } from '../src/sim/air/mission';
import { LEAST_REJOIN_STATION, rejoinRoute } from '../src/sim/air/missionRoute';
import type { FlightFix, RejoinInput } from '../src/sim/air/missionRoute';
import { routeFeasible, routeState, routeTimeline } from '../src/sim/air/route';
import type { Route } from '../src/sim/air/route';
import { capMission, dir, phaseStart, R } from './helpers/promoted';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const m = capMission();
const type = aircraftType('f21');

function input(fix: FlightFix, route: Route = m.route): RejoinInput {
  return {
    type,
    loadout: type.loadouts[0]!,
    profile: MISSION_PROFILES.cap,
    radius: R,
    rangeFactor: 1,
    basePoint: () => dir(40, 10),
    carrierBased: false,
    target: m.target.point,
    route,
    fix,
  };
}

/** The route's own state at t as a fix. */
function onRoute(t: number): FlightFix {
  const s = routeState(m.route, t, R);
  return { time: t, point: s.point, altitude: s.altitude, heading: s.heading, fuel: s.fuel };
}

/** The largest change of heading from one segment to the next after time t, until the approach. */
function worstCorner(route: Route, t: number): number {
  const segs = route.segments.filter((s) => s.t0 >= t && s.kind !== 'ground');
  const end = (s: Route['segments'][number]) =>
    s.kind === 'leg'
      ? initialHeading(s.b, s.a) + Math.PI
      : routeState(route, s.t1 - 0.5, R).heading;
  const start = (s: Route['segments'][number]) =>
    s.kind === 'leg' ? initialHeading(s.a, s.b) : routeState(route, s.t0 + 0.5, R).heading;
  let worst = 0;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i]!.phase === 'approach') break;
    worst = Math.max(worst, Math.abs(wrap(start(segs[i]!) - end(segs[i - 1]!))));
  }
  return worst;
}

const order = (p: MissionPhase) => MISSION_PHASES.indexOf(p);

describe('the rejoin route (handback)', () => {
  it('keeps the route as flown until the fix and goes on from the fix', () => {
    for (const phase of ['climb-out', 'fence-in', 'on-target', 'egress'] as const) {
      const t = phaseStart(m, phase) + 40;
      const r = rejoinRoute(input(onRoute(t)));
      // Before the fix it is the old route; at and after it, the new one from the fix.
      expect(
        arcDistance(routeState(r, t - 20, R).point, routeState(m.route, t - 20, R).point, R),
      ).toBeLessThan(1e-3);
      expect(arcDistance(routeState(r, t, R).point, onRoute(t).point, R)).toBeLessThan(1);
      const tl = routeTimeline(r);
      for (let i = 1; i < tl.length; i++)
        expect(order(tl[i]!.phase)).toBeGreaterThan(order(tl[i - 1]!.phase));
      expect(tl[tl.length - 1]!.phase).toBe('complete');
      expect(routeFeasible(r), phase).toBe(true);
    }
  });

  it('returns a flight taken off its station to it for the station time left, through real turns', () => {
    const t = phaseStart(m, 'on-target') + 300;
    // The player flew 25 km off the station's side, heading away from it.
    const s = routeState(m.route, t, R);
    const away = initialHeading(m.target.point, s.point);
    const point = destination(s.point, away, 25e3, R);
    const fix: FlightFix = { time: t, point, altitude: 8000, heading: away, fuel: s.fuel - 150 };
    const r = rejoinRoute(input(fix));
    const orbits = r.segments.filter((x) => x.kind === 'orbit' && x.t0 >= t);
    expect(orbits).toHaveLength(1);
    const o = orbits[0]!;
    const old = m.route.segments.find((x) => x.kind === 'orbit')!;
    expect(o.a).toEqual(old.a);
    expect(o.heading).toBe(old.heading);
    // The station time left, give or take the way back.
    expect(o.t1 - o.t0).toBeCloseTo(old.t1 - t, 6);
    expect(worstCorner(r, t)).toBeLessThan(25 * DEG);
  });

  it('goes home when the station has under a minute left, or the fuel is short', () => {
    const end = phaseStart(m, 'egress');
    const late = rejoinRoute(input(onRoute(end - LEAST_REJOIN_STATION / 2)));
    expect(late.segments.filter((x) => x.kind === 'orbit' && x.t0 >= end - 30)).toHaveLength(0);
    const t = phaseStart(m, 'fence-in') + 10;
    const thin = { ...onRoute(t), fuel: m.route.reserve * 1.6 };
    const short = rejoinRoute(input(thin));
    const station = short.segments.filter((x) => x.kind === 'orbit' && x.t0 >= t);
    const planned = m.route.segments.find((x) => x.kind === 'orbit')!;
    // Cut to what the fuel allows, or none.
    for (const o of station) expect(o.t1 - o.t0).toBeLessThan(planned.t1 - planned.t0);
  });
});

describe('the racetrack join', () => {
  it('joins the racetrack running the way the flight arrives: no reversal at its entry', () => {
    // From the base side, as every CAP planned toward its station.
    const leg = m.route.segments.find((s) => s.kind === 'orbit')!;
    const i = m.route.segments.indexOf(leg);
    const entry = m.route.segments[i - 1]!;
    const arrive = initialHeading(entry.b, entry.a) + Math.PI;
    const join = routeState(m.route, leg.t0 + 0.5, R).heading;
    expect(Math.abs(wrap(join - arrive))).toBeLessThan(30 * DEG);
  });
});
