/** A promoted F-21 CAP flight over a flat sea-level world, for the full-fidelity tests (R2.5). */
import { latLonToDirection } from '../../src/core/coords';
import type { Dir } from '../../src/core/greatCircle';
import { DEG } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { aircraftType } from '../../src/sim/air/aircraft';
import { analyticPose } from '../../src/sim/air/analyticPose';
import { formationAt, slotPose } from '../../src/sim/air/formation';
import { MISSION_PROFILES } from '../../src/sim/air/mission';
import type { Mission, MissionPhase } from '../../src/sim/air/mission';
import { planMissionRoute } from '../../src/sim/air/missionRoute';
import { routeState, routeTimeline } from '../../src/sim/air/route';
import type { Route } from '../../src/sim/air/route';
import type { Reference } from '../../src/sim/flight/aiPilot';
import type { GroundQuery } from '../../src/sim/flight/airframe';
import { PromotedFlight } from '../../src/sim/flight/promotedFlight';
import type { PromotedFlightOptions } from '../../src/sim/flight/promotedFlight';
import { missionPlugin } from '../../src/sim/command/missions/registry';
import { kestrelSpec } from './flight';

export const R = 1_000_000;
export const SPAN = 9.5;

export const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};

/** Flat ground at sea level, all field. */
export const seaLevel: GroundQuery = { height: () => 0, surface: () => 'field' };

export function capMission(type = 'f21'): Mission {
  const t = aircraftType(type);
  const route = planMissionRoute({
    type: t,
    loadout: t.loadouts[0]!,
    profile: MISSION_PROFILES.cap,
    radius: R,
    rangeFactor: 1,
    basePoint: () => dir(40, 10),
    carrierBased: false,
    target: dir(42, 13),
    launch: 0,
    stationTime: 25 * 60,
  })!;
  return {
    id: 7,
    type: 'cap',
    side: 'alliance',
    theater: 0,
    package: 1,
    squadron: 0,
    unit: 'Test Squadron',
    aircraftType: type,
    aircraft: 4,
    loadout: 'air-to-air',
    callsign: 'Test 1',
    base: { kind: 'airbase', id: 0 },
    target: { kind: 'station', id: -1, name: 'Station', point: dir(42, 13) },
    need: '',
    needKey: '',
    score: 0,
    seed: 1,
    route,
    timeline: routeTimeline(route),
  };
}

export function phaseStart(m: Mission, phase: MissionPhase): number {
  return m.timeline.find((e) => e.phase === phase)!.time;
}

/** The route's reference for the lead: the analytic pose's position and velocity. */
export function routeReference(route: Route): Reference {
  return (t) => {
    const p = analyticPose(route, t, R);
    return {
      pos: new Vec3d(p.pos[0], p.pos[1], p.pos[2]),
      vel: new Vec3d(p.velocity[0], p.velocity[1], p.velocity[2]),
    };
  };
}

export function promote(
  m: Mission,
  t: number,
  enemyDistance?: PromotedFlightOptions['enemyDistance'],
): PromotedFlight {
  const formations = missionPlugin(m.type).formations;
  const lead = analyticPose(m.route, t, R);
  const f = formationAt(m.timeline, formations, t);
  const poses = Array.from({ length: m.aircraft }, (_, k) => slotPose(lead, k, f, SPAN));
  return new PromotedFlight(m, t, R, kestrelSpec(), poses, {
    lead: routeReference(m.route),
    formation: (u) => formationAt(m.timeline, formations, u),
    phase: (u) => routeState(m.route, u, R).phase,
    span: SPAN,
    enemyDistance,
  });
}
