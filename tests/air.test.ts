import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import {
  arcDistance,
  alongPolyline,
  destination,
  initialHeading,
  polylineStations,
  tangentHeading,
  vertex,
} from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { latLonToDirection } from '../src/core/coords';
import { DEG, HOUR, KM, MINUTE } from '../src/core/units';
import { buildAirOverlays } from '../src/render/strategic/overlays/airModel';
import {
  AIRCRAFT_ROLES,
  AIRCRAFT_TYPES,
  aircraftType,
  cruiseFlow,
  ONE_SIDED_ROLES,
} from '../src/sim/air/aircraft';
import { MISSION_PROFILES, phaseTime } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { planMissionRoute, timeOnTarget } from '../src/sim/air/missionRoute';
import { buildOrderOfBattle } from '../src/sim/air/orbat';
import { ORBIT_LEG, ORBIT_TURN, routeEndFuel, routeState } from '../src/sim/air/route';
import type { Route } from '../src/sim/air/route';
import { campaignInput } from '../src/sim/command/campaignInput';
import type { CampaignInput } from '../src/sim/command/campaignInput';
import { MAX_AIRBORNE } from '../src/sim/command/tasker';
import { carrierState, carrierTrack, PATROL_SPEED } from '../src/sim/naval/carrierGroup';
import { createSimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import type { CampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};

const worlds = new Map<number, CampaignWorld>();
function world(seed: number): CampaignWorld {
  let w = worlds.get(seed);
  if (!w) {
    w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { grid: new CubeGrid(64) });
    worlds.set(seed, w);
  }
  return w;
}
function input(seed: number): CampaignInput {
  const w = world(seed);
  return campaignInput(w.graph, w.campaign.cast, w.infrastructure);
}

describe('great circles', () => {
  it('measures headings clockwise from north', () => {
    const p = dir(0, 0);
    expect(initialHeading(p, dir(0, 10))).toBeCloseTo(Math.PI / 2, 6);
    expect(initialHeading(p, dir(10, 0))).toBeCloseTo(0, 6);
    expect(initialHeading(p, dir(0, -10))).toBeCloseTo(1.5 * Math.PI, 6);
  });

  it('goes where it heads', () => {
    const p = dir(20, 30);
    for (const h of [0, 1, 2.5, 4, 6]) {
      const q = destination(p, h, 300 * KM, R);
      expect(arcDistance(p, q, R)).toBeCloseTo(300 * KM, 0);
      expect(initialHeading(p, q)).toBeCloseTo(h, 6);
    }
  });

  it('walks a polyline by arc length', () => {
    const pts = [...dir(0, 0), ...dir(0, 10), ...dir(10, 10)];
    const s = polylineStations(pts, R);
    expect(s[2]).toBeCloseTo(arcDistance(dir(0, 0), dir(0, 10), R) * 2, 0);
    const mid = alongPolyline(pts, s, s[1]! / 2);
    expect(arcDistance(mid.point, dir(0, 5), R)).toBeLessThan(1);
    expect(tangentHeading(mid.point, mid.tangent)).toBeCloseTo(Math.PI / 2, 4);
  });
});

describe('aircraft types', () => {
  it('has unique ids and plausible SI values', () => {
    expect(new Set(AIRCRAFT_TYPES.map((t) => t.id)).size).toBe(AIRCRAFT_TYPES.length);
    for (const t of AIRCRAFT_TYPES) {
      expect(t.cruiseSpeed, t.id).toBeGreaterThan(30);
      expect(t.cruiseSpeed, t.id).toBeLessThan(700);
      expect(t.maxSpeed, t.id).toBeGreaterThanOrEqual(t.cruiseSpeed);
      expect(t.cruiseAltitude, t.id).toBeLessThan(t.ceiling);
      expect(t.combatRadius, t.id).toBeGreaterThan(50 * KM);
      expect(t.fuel, t.id).toBeGreaterThan(0);
      expect(cruiseFlow(t), t.id).toBeGreaterThan(0);
      expect(t.loadouts.length, t.id).toBeGreaterThan(0);
    }
  });

  it('covers every role for both sides, except the one-sided ones', () => {
    for (const role of AIRCRAFT_ROLES) {
      for (const side of ['alliance', 'pact'] as const) {
        const has = AIRCRAFT_TYPES.some((t) => t.role === role && t.side === side);
        const only = ONE_SIDED_ROLES[role];
        expect(has, `${side} ${role}`).toBe(only === undefined || only === side);
      }
    }
  });

  it('names model specs that exist', () => {
    for (const t of AIRCRAFT_TYPES) {
      if (t.model)
        expect(existsSync(`src/render/common/models/specs/${t.model}.json`), t.id).toBe(true);
    }
  });
});

describe('mission routes', () => {
  const base = dir(10, 0);
  const plan = (typeId: string, mission: keyof typeof MISSION_PROFILES, target: Dir, rf = 1) => {
    const type = aircraftType(typeId);
    const profile = MISSION_PROFILES[mission];
    return planMissionRoute({
      type,
      loadout: type.loadouts.find((l) => l.id === profile.loadout) ?? type.loadouts[0]!,
      profile,
      radius: R,
      rangeFactor: rf,
      basePoint: () => base,
      carrierBased: false,
      target,
      launch: 1000,
    });
  };

  const checkContinuity = (route: Route) => {
    for (let i = 1; i < route.segments.length; i++) {
      const s = route.segments[i]!;
      const prev = route.segments[i - 1]!;
      expect(s.t0).toBeCloseTo(prev.t1, 6);
      const a = routeState(route, s.t0 - 1e-6, R);
      const b = routeState(route, s.t0 + 1e-6, R);
      expect(arcDistance(a.point, b.point, R), `segment ${i}`).toBeLessThan(5);
      expect(Math.abs(a.altitude - b.altitude)).toBeLessThan(1);
    }
  };

  it('flies a strike out and back within the climb rate and the fuel', () => {
    const type = aircraftType('f124');
    const route = plan('f124', 'deep-strike', destination(base, 1, 600 * KM, R))!;
    expect(route).not.toBeNull();
    checkContinuity(route);
    const first = route.segments[0]!;
    const last = route.segments[route.segments.length - 1]!;
    expect(arcDistance(routeState(route, first.t0, R).point, base, R)).toBeLessThan(1);
    expect(arcDistance(routeState(route, last.t1, R).point, base, R)).toBeLessThan(1);
    for (const s of route.segments) {
      const rate = Math.abs(s.alt1 - s.alt0) / Math.max(s.t1 - s.t0, 1e-9);
      expect(rate).toBeLessThanOrEqual(Math.max(type.climbRate, 15) + 1e-6);
      expect(Math.max(s.alt0, s.alt1)).toBeLessThanOrEqual(type.ceiling);
    }
    // Low level over the target.
    const atTarget = routeState(route, timeOnTarget(route) + 1, R);
    expect(atTarget.altitude).toBeLessThan(200);
    expect(routeEndFuel(route)).toBeGreaterThanOrEqual(route.reserve);
    expect(route.segments.map((s) => s.phase)).toEqual(
      expect.arrayContaining([
        'departure',
        'climb-out',
        'ingress',
        'fence-in',
        'on-target',
        'egress',
        'approach',
        'recovery',
      ]),
    );
  });

  it('refuses targets beyond the radius the range factor allows', () => {
    const type = aircraftType('f21');
    const far = destination(base, 2, type.combatRadius * 0.9, R);
    expect(plan('f21', 'interdiction', far, 1)).not.toBeNull();
    expect(plan('f21', 'interdiction', far, 0.35)).toBeNull();
  });

  it('holds a racetrack on station and cuts station time to the fuel', () => {
    const station = destination(base, 0.5, 200 * KM, R);
    const near = plan('f25', 'cap', station)!;
    checkContinuity(near);
    const orbit = near.segments.find((s) => s.kind === 'orbit')!;
    for (let t = orbit.t0; t <= orbit.t1; t += 60) {
      const p = routeState(near, t, R).point;
      expect(arcDistance(p, station, R)).toBeLessThan(ORBIT_LEG / 2 + ORBIT_TURN + 10);
    }
    expect(orbit.t1 - orbit.t0).toBeCloseTo(MISSION_PROFILES.cap.stationTime[1], 0);
    const far = plan('f25', 'cap', destination(base, 0.5, 700 * KM, R))!;
    const farOrbit = far.segments.find((s) => s.kind === 'orbit')!;
    expect(farOrbit.t1 - farOrbit.t0).toBeLessThan(orbit.t1 - orbit.t0);
    expect(farOrbit.t1 - farOrbit.t0).toBeGreaterThanOrEqual(MISSION_PROFILES.cap.stationTime[0]);
    expect(routeEndFuel(far)).toBeGreaterThanOrEqual(far.reserve - 1e-6);
  });
});

describe('carrier groups', () => {
  it('are cast at sea for theaters at sea and none without', () => {
    const w7 = world(7);
    const kinds = w7.campaign.cast.theaters.map((t) => t.kind);
    expect(kinds).toContain('sea-lane');
    expect(w7.campaign.cast.carriers.length).toBeGreaterThan(0);
    expect(w7.campaign.cast.carriers.some((c) => c.side === 'alliance')).toBe(true);
    const w1 = world(1);
    if (
      !w1.campaign.cast.theaters.some((t) =>
        ['sea-lane', 'chokepoint', 'island-campaign'].includes(t.kind),
      )
    )
      expect(w1.campaign.cast.carriers).toEqual([]);
  });

  it('patrol their lanes at patrol speed', () => {
    const w = world(7);
    const lanes = w.graph.lanes;
    for (const c of w.campaign.cast.carriers) {
      const lane = lanes[c.lane]!;
      const track = carrierTrack(c, R);
      // The track lies on the lane.
      for (let i = 0; i < c.track.length / 3; i++) {
        let best = Infinity;
        for (let j = 0; j < lane.points.length / 3; j++) {
          best = Math.min(best, arcDistance(vertex(c.track, i), vertex(lane.points, j), R));
        }
        const s = polylineStations(lane.points, R);
        expect(best).toBeLessThan(Math.max(...Array.from(s.slice(1), (x, k) => x - s[k]!)) + 1);
      }
      for (const t of [0, 3 * HOUR, 20 * HOUR, 100 * HOUR]) {
        const a = carrierState(track, t);
        const b = carrierState(track, t + 60);
        expect(arcDistance(a.point, b.point, R)).toBeLessThanOrEqual(PATROL_SPEED * 60 + 1);
      }
    }
  });
});

describe('order of battle', () => {
  it('bases squadrons at their own side and wings on carriers', () => {
    const inp = input(7);
    const o = buildOrderOfBattle(inp, 7);
    inp.airbases.forEach((a, i) => expect(a.id).toBe(i));
    for (const s of o.squadrons) {
      const t = aircraftType(s.type);
      expect(t.side).toBe(s.side);
      if (s.base.kind === 'airbase') {
        expect(inp.airbases[s.base.id]!.side).toBe(s.side);
        expect(t.carrier).toBe(false);
      } else {
        expect(inp.carriers[s.base.id]!.side).toBe(s.side);
        expect(t.carrier).toBe(true);
      }
    }
    for (const side of ['alliance', 'pact'] as const) {
      const roles = new Set(
        o.squadrons.filter((s) => s.side === side).map((s) => aircraftType(s.type).role),
      );
      for (const r of [
        'aew',
        'tanker',
        'airlift',
        'recon',
        'sead',
        'deep-strike',
        'cas',
        'air-superiority',
      ] as const)
        expect(roles.has(r), `${side} ${r}`).toBe(true);
    }
    expect(JSON.stringify(buildOrderOfBattle(inp, 7))).toBe(JSON.stringify(o));
  });
});

describe('air operations', () => {
  const run = (seed: number, hours: number, step: number) => {
    const w = createSimWorld({ ...syntheticConfig(seed), campaign: input(seed) });
    for (let t = step; t <= hours * HOUR + 1e-6; t += step)
      w.sim.advanceTo(Math.min(t, hours * HOUR));
    w.sim.advanceTo(hours * HOUR);
    return w;
  };

  it('flies missions for both sides under the cap, conserving aircraft', () => {
    const w = createSimWorld({ ...syntheticConfig(7), campaign: input(7) });
    const air = w.air!;
    const seen = new Map<number, Mission>();
    const airborne: number[] = [];
    for (let t = 10 * MINUTE; t <= 30 * HOUR; t += 10 * MINUTE) {
      w.sim.advanceTo(t);
      for (const m of air.liveMissions()) seen.set(m.id, m);
      if (t > 3 * HOUR) airborne.push(air.airborneAt('alliance', t) + air.airborneAt('pact', t));
      for (const side of ['alliance', 'pact'] as const) {
        expect(air.airborneAt(side, t)).toBeLessThanOrEqual(MAX_AIRBORNE);
      }
      // Conservation: available + on missions + in turnaround = strength.
      const flying = new Map<number, number>();
      for (const m of air.liveMissions())
        flying.set(m.squadron, (flying.get(m.squadron) ?? 0) + m.aircraft);
      air.squadrons.forEach((s, i) => {
        expect(s.available + (flying.get(i) ?? 0) + air.turnaround[i]!).toBe(s.aircraft);
      });
    }
    expect(air.completed.alliance).toBeGreaterThan(20);
    expect(air.completed.pact).toBeGreaterThan(20);
    // C2: 20–50 aircraft in the air once the war is under way.
    const mean = airborne.reduce((a, b) => a + b, 0) / airborne.length;
    expect(mean).toBeGreaterThanOrEqual(20);
    expect(Math.max(...airborne)).toBeLessThanOrEqual(2 * MAX_AIRBORNE);
    // Every mission lands back at its base, carriers included (at the landing time:
    // the group sails on while the flight is recovered).
    for (const m of seen.values()) {
      const end = phaseTime(m, 'recovery');
      const at = routeState(m.route, end, R).point;
      expect(
        arcDistance(at, air.basePoint(m.base, end), R),
        `${m.callsign} ${m.type}`,
      ).toBeLessThan(2 * KM);
      expect(routeEndFuel(m.route)).toBeGreaterThanOrEqual(m.route.reserve - 1e-6);
      expect(m.need.length).toBeGreaterThan(0);
    }
    const types = new Set([...seen.values()].map((m) => m.type));
    for (const t of ['cap', 'cas', 'support'] as const) expect(types.has(t), t).toBe(true);
    expect([...seen.values()].some((m) => m.base.kind === 'carrier')).toBe(true);
  });

  it('is deterministic at any step size', () => {
    const a = run(7, 18, 37 * MINUTE).sim.hash();
    const b = run(7, 18, 3 * HOUR).sim.hash();
    const c = run(7, 18, 18 * HOUR).sim.hash();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('draws flights, trails and carriers for the viewing side', () => {
    const w = run(7, 6, HOUR);
    const air = w.air!;
    const t = 6 * HOUR;
    const missions = air.liveMissions();
    const airborne = missions.filter((m) => routeState(m.route, t, R).airborne);
    const both = buildAirOverlays(missions, air.carriers, t, R, { side: 'both', routes: true });
    expect(both.marks.filter((m) => m.layer === 'flights').length).toBe(airborne.length);
    expect(both.marks.filter((m) => m.layer === 'carriers').length).toBe(air.carriers.length);
    expect(both.lines.some((l) => l.layer === 'routes')).toBe(true);
    const pact = buildAirOverlays(missions, air.carriers, t, R, { side: 'pact', routes: false });
    expect(pact.marks.filter((m) => m.layer === 'flights').length).toBe(
      airborne.filter((m) => m.side === 'pact').length,
    );
    expect(pact.lines.some((l) => l.layer === 'routes')).toBe(false);
    // Icons are badges (decision 133): discs in the side's color, keyed for picking.
    for (const m of both.marks) {
      expect(m.badge?.shape).toBe('disc');
      expect(m.badge!.size).toBeGreaterThanOrEqual(24);
      expect(m.key).toMatch(/^(mission|carrier):\d+$/);
    }
    // Selecting a flight draws its route alone, enlarges its badge and puts it on top.
    const pick = airborne[0]!;
    const sel = buildAirOverlays(missions, air.carriers, t, R, {
      side: 'both',
      routes: false,
      selected: `mission:${pick.id}`,
    });
    expect(sel.lines.filter((l) => l.layer === 'routes').length).toBe(1);
    const last = sel.marks[sel.marks.length - 1]!;
    expect(last.key).toBe(`mission:${pick.id}`);
    expect(last.badge!.size).toBeGreaterThan(
      both.marks.find((m) => m.key === last.key)!.badge!.size,
    );
  });
});
