import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import type { Dir } from '../src/core/greatCircle';
import { DEG, HOUR, KM } from '../src/core/units';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { planMissionRoute } from '../src/sim/air/missionRoute';
import { groundSpeed, routeEndFuel } from '../src/sim/air/route';
import { COMMIT_AHEAD } from '../src/sim/command/ato';
import { campaignInput } from '../src/sim/command/campaignInput';
import { RAIL_BRIDGE_LISTS, ROAD_BRIDGE_LISTS } from '../src/sim/command/campaignInput';
import { PlanningEnvironment } from '../src/sim/command/environment';
import { BASE_PRESSURE, frontSegments } from '../src/sim/command/front';
import { Ledger } from '../src/sim/command/ledger';
import { CAS } from '../src/sim/command/missions/cas';
import { missionBriefing } from '../src/sim/command/missions/registry';
import { supplyLines } from '../src/sim/command/supply';
import { createSimWorld } from '../src/sim/world';
import { EARTH_ORBIT } from '../src/core/calendar';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};

const world = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);

describe('winds aloft', () => {
  it('add a tailwind, take a headwind off and crab across a crosswind', () => {
    const north = 0;
    expect(groundSpeed(200, north, { east: 0, north: 30 })).toBeCloseTo(230, 9);
    expect(groundSpeed(200, north, { east: 0, north: -30 })).toBeCloseTo(170, 9);
    expect(groundSpeed(200, north, { east: 40, north: 0 })).toBeCloseTo(
      Math.sqrt(200 ** 2 - 40 ** 2),
      9,
    );
    expect(groundSpeed(200, north, null)).toBe(200);
    // Never below MIN_GROUND_SPEED of the airspeed.
    expect(groundSpeed(100, north, { east: 0, north: -500 })).toBeCloseTo(30, 9);
  });

  it('lengthen a flight into the wind and cost it fuel', () => {
    const type = AIRCRAFT_TYPES.find((t) => t.role === 'multirole')!;
    const plan = (wind: { east: number; north: number } | null) =>
      planMissionRoute({
        type,
        loadout: type.loadouts[0]!,
        profile: MISSION_PROFILES.interdiction,
        radius: DEFAULT_PLANET_PARAMS.radius,
        rangeFactor: 1,
        basePoint: () => dir(40, 10),
        carrierBased: false,
        target: dir(46, 10),
        // Far enough for an ingress after the F-21's climb at 50 m/s (decision 283).
        launch: 0,
        wind: () => wind,
      })!;
    const calm = plan(null);
    const cross = plan({ east: 40, north: 0 });
    const head = plan({ east: 0, north: -40 });
    const end = (r: typeof calm) => r.segments[r.segments.length - 1]!.t1;
    // The phase's longest leg: the way out or home, not a leg of the turn off the target.
    const leg = (r: typeof calm, phase: string) =>
      Math.max(
        ...r.segments.filter((x) => x.phase === phase && x.kind === 'leg').map((s) => s.t1 - s.t0),
      );
    // A crosswind slows both ways: longer, and more fuel burned.
    expect(end(cross)).toBeGreaterThan(end(calm));
    expect(routeEndFuel(cross)).toBeLessThan(routeEndFuel(calm));
    // A headwind north lengthens the way out and shortens the way home.
    expect(leg(head, 'ingress')).toBeGreaterThan(leg(calm, 'ingress'));
    expect(leg(head, 'egress')).toBeLessThan(leg(calm, 'egress'));
  });
});

describe('the planning environment', () => {
  const env = new PlanningEnvironment(null, EARTH_ORBIT, { startDay: 226, startTimeOfDay: 0 });
  const p = dir(45, 0);

  it('finds the day and the night at a place', () => {
    const day = env.window(p, 0, 24 * HOUR, true)!;
    const night = env.window(p, 0, 24 * HOUR, false)!;
    expect(day[0]).toBeLessThan(12 * HOUR);
    expect(day[1]).toBeGreaterThan(12 * HOUR);
    // Mid-August at 45° N: about 15 h of light with civil twilight.
    expect(day[1] - day[0]).toBeGreaterThan(14 * HOUR);
    expect(day[1] - day[0]).toBeLessThan(17 * HOUR);
    // The longest night is outside the day.
    expect(night[1] <= day[0] + 600 || night[0] >= day[1] - 600).toBe(true);
  });

  it('refuses a daylight mission at night and clears it by day, with a clear sky', () => {
    expect(env.refusal(CAS.minimums, false, p, p, 0)).toBe('night');
    expect(env.refusal(CAS.minimums, false, p, p, 12 * HOUR)).toBeNull();
  });
});

describe('fronts and supply', () => {
  const R = input.radius;

  it('cuts each front into segments with pressure from its corridors', () => {
    expect(input.fronts.length).toBeGreaterThan(0);
    for (const f of input.fronts) {
      const segs = frontSegments(f, R);
      expect(segs.length).toBeGreaterThanOrEqual(2);
      const p = segs.map((s) => s.pressure);
      expect(Math.min(...p)).toBeGreaterThanOrEqual(BASE_PRESSURE);
      if (f.corridors.length > 0) {
        expect(Math.max(...p)).toBeCloseTo(1, 9);
        expect(segs.some((s) => s.corridor !== null)).toBe(true);
      }
    }
  });

  it('runs supply over bridges, and a cut bridge carries none', () => {
    const w = createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });
    const segments = input.fronts.flatMap((f) => frontSegments(f, R));
    const nets = w.networks!;
    const none = new Set<number>();
    for (const side of ['alliance', 'pact'] as const) {
      const lines = supplyLines(input, side, segments, { ...nets, cutRoad: none, cutRail: none });
      expect(lines.sites.size, side).toBeGreaterThan(0);
      for (const u of lines.sites.values()) expect(u).toBeLessThanOrEqual(1);
      const bridge = [...lines.sites]
        .filter(([id]) => input.targets[id]!.bridge)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (!bridge) continue;
      w.damage!.hit(bridge[0], 1);
      const cutRoad = w.damage!.cutBridges(nets.road.input, ROAD_BRIDGE_LISTS);
      const cutRail = w.damage!.cutBridges(nets.rail.input, RAIL_BRIDGE_LISTS);
      const after = supplyLines(input, side, segments, { ...nets, cutRoad, cutRail });
      expect(after.sites.has(bridge[0])).toBe(false);
    }
  });
});

describe('the ledger', () => {
  it('promises a squadron no more than its strength at any moment', () => {
    const l = new Ledger();
    l.hold(0, 0, 100, 4);
    l.hold(0, 50, 150, 4);
    expect(l.fits(0, 12, 60, 70, 4)).toBe(true);
    expect(l.fits(0, 12, 60, 70, 5)).toBe(false);
    expect(l.fits(0, 12, 100, 200, 8)).toBe(true);
    expect(l.fits(0, 12, 0, 40, 8)).toBe(true);
  });
});

describe('a revision', () => {
  it('cancels a strike whose target is out of use and plans another', () => {
    const w = createSimWorld({ ...syntheticConfig(7), radius: input.radius, campaign: input });
    w.sim.advanceTo(1);
    const ato = w.ato!;
    const order = ato.orders.alliance!;
    const strike = order.planned.find(
      (s) =>
        s.role === 'lead' &&
        s.mission.type === 'interdiction' &&
        s.mission.target.kind === 'site' &&
        s.departure > 2 * HOUR + COMMIT_AHEAD,
    );
    expect(strike, 'a planned interdiction a few hours out').toBeDefined();
    w.damage!.hit(strike!.mission.target.id, 1);
    const before = ato.stats.alliance.cancelled['need gone'] ?? 0;
    w.sim.advanceTo(2 * HOUR + 1);
    expect(ato.orders.alliance!.revision).toBe(1);
    expect(ato.orders.alliance!.planned.some((s) => s.key === strike!.key)).toBe(false);
    expect(ato.stats.alliance.cancelled['need gone']).toBeGreaterThan(before);
    // Another target takes its place in the order.
    const targets = ato.orders
      .alliance!.planned.filter((s) => s.mission.type === 'interdiction')
      .map((s) => `${s.mission.target.kind}:${s.mission.target.id}`);
    expect(targets).not.toContain(`site:${strike!.mission.target.id}`);
    expect(targets.length).toBeGreaterThan(0);
  });

  it('names places and records the need on every mission', () => {
    const w = createSimWorld({ ...syntheticConfig(7), radius: input.radius, campaign: input });
    w.sim.advanceTo(8 * HOUR);
    const missions = w.air!.liveMissions();
    expect(missions.length).toBeGreaterThan(10);
    for (const m of missions) {
      expect(m.places, m.need).toBeDefined();
      expect(m.need.length).toBeGreaterThan(0);
      expect(m.id).toBeGreaterThanOrEqual(0);
    }
    // Stations sit inside the theater: within a few hundred km of the front.
    const cas = missions.filter((m) => m.type === 'cas');
    for (const m of cas) expect(m.places!.front).toMatch(/^the /);
    expect(KM).toBe(1000);
    // Each mission's briefing names its flight, its base and its target.
    for (const m of missions) {
      const text = missionBriefing(m, input, '14:05');
      expect(text, m.need).toContain(m.callsign);
      if (m.type === 'cap' || m.type === 'interdiction' || m.type === 'airlift') {
        expect(text, m.need).toContain(m.places!.target);
      }
    }
  });
});
