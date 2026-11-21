import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { arcDistance } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { rng } from '../src/core/rng';
import { DEG, HOUR, MINUTE } from '../src/core/units';
import { AIRCRAFT_TYPES, aircraftType } from '../src/sim/air/aircraft';
import { calibrationSource, combatValues } from '../src/sim/air/calibration';
import { MISSION_PROFILES, missionEnd } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { planMissionRoute } from '../src/sim/air/missionRoute';
import { strikeResolver } from '../src/sim/air/resolvers';
import { returnRoute, routeEndFuel, routeState, routeTimeline } from '../src/sim/air/route';
import { campaignInput } from '../src/sim/command/campaignInput';
import { AIRLIFT } from '../src/sim/command/missions/airlift';
import { isPending } from '../src/sim/command/missions/plugin';
import { createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

const R = DEFAULT_PLANET_PARAMS.radius;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};
const world = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
const make = (): SimWorld => createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });

/** Aircraft on strength = available + flying + in turnaround, for every squadron. */
function conserved(w: SimWorld): void {
  const air = w.air!;
  const flying = new Map<number, number>();
  for (const m of air.liveMissions())
    flying.set(m.squadron, (flying.get(m.squadron) ?? 0) + m.aircraft);
  air.squadrons.forEach((s, i) => {
    expect(s.available + (flying.get(i) ?? 0) + air.turnaround[i]!, s.name).toBe(s.aircraft);
  });
}

describe('combat values', () => {
  it('come from a prior until calibration fits them, and value better radars', () => {
    for (const t of AIRCRAFT_TYPES) {
      const v = combatValues(t.id);
      expect(calibrationSource(t.id)).toBe('prior');
      for (const x of [v.air, v.strike, v.survival]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1.5);
      }
    }
    const fighters = AIRCRAFT_TYPES.filter((t) => t.role === 'air-superiority' && !t.carrier);
    const alliance = fighters.find((t) => t.side === 'alliance')!;
    expect(combatValues(alliance.id).air).toBeGreaterThan(
      combatValues(AIRCRAFT_TYPES.find((t) => t.role === 'cas')!.id).air,
    );
  });
});

describe('turning home', () => {
  const type = AIRCRAFT_TYPES.find((t) => t.role === 'multirole')!;
  const route = planMissionRoute({
    type,
    loadout: type.loadouts[0]!,
    profile: MISSION_PROFILES.interdiction,
    radius: R,
    rangeFactor: 1,
    basePoint: () => dir(40, 10),
    carrierBased: false,
    target: dir(43, 10),
    launch: 0,
  })!;

  it('cuts the route where the flight is and flies it home with the fuel it has', () => {
    const leg = route.segments.find((s) => s.kind === 'leg' && s.phase !== 'climb-out')!;
    const t = (leg.t0 + leg.t1) / 2;
    const back = returnRoute(route, t, dir(40, 10), type, R, 480);
    const before = routeState(route, t, R);
    const after = routeState(back, t, R);
    expect(arcDistance(before.point, after.point, R)).toBeLessThan(1);
    expect(after.fuel).toBeCloseTo(before.fuel, 6);
    const end = back.segments[back.segments.length - 1]!;
    expect(arcDistance(routeState(back, end.t1, R).point, dir(40, 10), R)).toBeLessThan(1000);
    const phases = routeTimeline(back).map((e) => e.phase);
    expect(phases.slice(0, 2)).toEqual(['departure', 'climb-out']);
    expect(phases.slice(-4)).toEqual(['egress', 'approach', 'recovery', 'complete']);
    expect(phases).not.toContain('on-target');
    // Home sooner than the full mission, with more fuel left.
    expect(end.t1).toBeLessThan(route.segments[route.segments.length - 1]!.t1);
    expect(routeEndFuel(back)).toBeGreaterThan(routeEndFuel(route));
  });
});

describe('the strike resolver', () => {
  it('damages a target by the survivors and does nothing for a flight that turned home', () => {
    const bridge = input.targets.find((x) => x.kind === 'bridge')!;
    const type = AIRCRAFT_TYPES.find((t) => t.role === 'multirole')!;
    const m = {
      id: 1,
      type: 'interdiction',
      aircraftType: type.id,
      aircraft: 4,
      target: { kind: 'site', id: bridge.id, name: bridge.name, point: bridge.point },
      timeline: [],
    } as unknown as Mission;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const o = strikeResolver.resolve(m, {
        air: null!,
        input,
        now: 0,
        rng: rng(1, `s${i}`),
        onStation: 60,
      });
      expect(o.effect).toBeGreaterThanOrEqual(0);
      expect(o.effect).toBeLessThan(1);
      total += o.effect;
    }
    // Four aircraft at strike 0.6 × P_HIT 0.5: 1.2 hits of 0.35 on average, about 0.37 damage.
    expect(total / 400).toBeGreaterThan(0.25);
    expect(total / 400).toBeLessThan(0.5);
    const home = strikeResolver.resolve({ ...m, aborted: 'losses' } as Mission, {
      air: null!,
      input,
      now: 0,
      rng: rng(1, 'x'),
      onStation: 0,
    });
    expect(home.effect).toBe(0);
  });
});

describe('a day of resolved war', () => {
  const w = make();
  const seen = new Map<number, Mission>();
  for (let t = 10 * MINUTE; t <= 26 * HOUR; t += 10 * MINUTE) {
    w.sim.advanceTo(t);
    for (const m of w.air!.liveMissions()) seen.set(m.id, m);
    conserved(w);
  }
  const air = w.air!;
  const log = w.sim.log.entries;

  it('loses aircraft on both sides, with survivors and the pilots off the roster', () => {
    for (const side of ['alliance', 'pact'] as const)
      expect(air.lost[side], side).toBeGreaterThan(0);
    const losses = log.filter((e) => e.source === 'decision' && e.kind === 'aircraft-lost');
    const ejected = losses.reduce((s, e) => s + (e.kind === 'aircraft-lost' ? e.ejected : 0), 0);
    const killed = losses.reduce((s, e) => s + (e.kind === 'aircraft-lost' ? e.killed : 0), 0);
    expect(air.survivors.length).toBe(ejected);
    expect(air.killed.alliance + air.killed.pact).toBe(killed);
    const names = new Set(air.squadrons.flatMap((s) => s.pilots));
    for (const s of air.survivors) {
      expect(names.has(s.pilot) && air.squadrons[s.squadron]!.pilots.includes(s.pilot)).toBe(false);
    }
  });

  it('damages targets and bridges, attacks troops and delivers airlift', () => {
    const dmg = w.damage!;
    expect(dmg.damaged().length).toBeGreaterThan(0);
    expect(dmg.attacks.length).toBeGreaterThan(0);
    const res = w.resolution!.stats;
    expect(res.alliance.deliveries + res.pact.deliveries).toBeGreaterThan(0);
    expect(res.alliance.resolved).toBeGreaterThan(20);
    const resolved = log.filter((e) => e.source === 'decision' && e.kind === 'mission-resolved');
    expect(resolved.length).toBe(res.alliance.resolved + res.pact.resolved);
  });

  it('drop tanks for fights, which do not come back to the base (decision 294)', () => {
    const tanksOf = (m: Mission) => air.tanksHome({ ...m, expended: [] }) / Math.max(1, m.aircraft);
    const fought = [...seen.values()].filter(
      // Flights in a fight: their tanks count as expended (a target's `engaged` marks a look).
      (m) => tanksOf(m) > 0 && (m.expended?.length ?? 0) > 0,
    );
    expect(fought.length).toBeGreaterThan(0);
    for (const m of fought) expect(air.tanksHome(m), m.callsign).toBe(0);
    const tanks = (x: SimWorld) =>
      x.air!.orbat.bases.reduce((n, b) => n + (b.stocks.tanks ?? 0), 0);
    const hanging = [...air.liveMissions()].reduce((n, m) => n + air.tanksHome(m), 0);
    expect(tanks(w) + hanging).toBeLessThan(tanks(make()));
  });

  it('brings aborted flights home and never resolves a mission twice', () => {
    const aborted = [...seen.values()].filter((m) => m.aborted);
    for (const m of aborted) {
      const end = missionEnd(m);
      if (end > 26 * HOUR) continue;
      const home = air.basePoint(m.base, end);
      expect(arcDistance(routeState(m.route, end, R).point, home, R)).toBeLessThan(20e3);
    }
    const ids = log
      .filter((e) => e.source === 'decision' && e.kind === 'mission-resolved')
      .map((e) => (e.kind === 'mission-resolved' ? e.mission : -1));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('revisions read the outcomes', () => {
  it('stop striking a target that is out of use', () => {
    const w = make();
    w.sim.advanceTo(26 * HOUR);
    const dmg = w.damage!;
    const out = new Set(
      dmg
        .damaged()
        .filter((x) => x.damage >= (input.targets[x.id]!.bridge ? 0.5 : 0.8))
        .map((x) => x.id),
    );
    for (const side of ['alliance', 'pact'] as const) {
      for (const s of w.ato!.orders[side]!.planned) {
        if (s.mission.type === 'interdiction' && s.mission.target.kind === 'site') {
          expect(out.has(s.mission.target.id), s.key).toBe(false);
        }
      }
    }
  });

  it('cancel the sorties of a squadron that lost its aircraft', () => {
    const w = make();
    w.sim.advanceTo(1);
    const order = w.ato!.orders.alliance!;
    // A squadron with sorties planned after the revision and none of its aircraft away.
    const s = order.planned.find((x) => {
      const q = w.air!.squadrons[x.mission.squadron]!;
      return x.departure > 3 * HOUR && q.available === q.aircraft;
    })!;
    const sq = w.air!.squadrons[s.mission.squadron]!;
    // The squadron's aircraft are lost on the ground (as a strike on its base would do, R4).
    sq.aircraft -= sq.available;
    sq.available = 0;
    w.sim.advanceTo(2 * HOUR + 1);
    const after = w.ato!.orders.alliance!.planned;
    expect(after.some((x) => x.mission.squadron === sq.id && x.departure > 3 * HOUR)).toBe(false);
    expect(w.ato!.stats.alliance.cancelled.aircraft ?? 0).toBeGreaterThan(0);
  });

  it('ask for more airlift where stocks are low', () => {
    const w = make();
    w.sim.advanceTo(1);
    const field = input.airbases.find(
      (a) => a.side === 'alliance' && (a.kind === 'forward' || a.kind === 'island'),
    )!;
    const planner = AIRLIFT.planner;
    if (isPending(planner)) throw new Error('airlift planner');
    const count = () =>
      planner(w.ato!.context('alliance', 1, 0)).find((n) => n.key === `airlift:${field.id}`)!.tots!
        .length;
    expect(count()).toBe(1);
    const st = w.air!.base({ kind: 'airbase', id: field.id }).stocks;
    st.fuel *= 0.4;
    expect(count()).toBe(3);
    expect(aircraftType(AIRCRAFT_TYPES[0]!.id)).toBeDefined();
  });
});
