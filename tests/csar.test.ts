/**
 * Combat search and rescue (roadmap R2.9, decisions 352 and 353): a rescue for every
 * survivor at once, from the nearest base, with its escort and cover near the enemy;
 * the pickup, the pilots home on their rosters, a recall and a new attempt; crews
 * that rest and limit sorties.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { arcDistance, destination } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { HOUR, MINUTE } from '../src/core/units';
import { buildAirOverlays } from '../src/render/strategic/overlays/airModel';
import { aircraftType } from '../src/sim/air/aircraft';
import { CREW_REST, EJECTED } from '../src/sim/air/airOps';
import { isAirborne, missionEnd, phaseTime } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { routeState } from '../src/sim/air/route';
import { campaignInput } from '../src/sim/command/campaignInput';
import { createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

const R = DEFAULT_PLANET_PARAMS.radius;
const world = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
const make = (): SimWorld => createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });

/** A live airborne Alliance mission at `t` (not a rescue). */
function flying(w: SimWorld, t: number): Mission {
  const m = w
    .air!.liveMissions()
    .find((x) => x.side === 'alliance' && isAirborne(x, t) && !x.survivors && x.type !== 'rescap');
  if (!m) throw new Error('no airborne alliance flight');
  return m;
}

/** Shoots down one aircraft of an Alliance flight at `at` with its crew ejecting; returns the new survivors' ids. */
function downAt(w: SimWorld, at: Readonly<Dir>): number[] {
  const air = w.air!;
  const before = air.survivors.length;
  air.lose(flying(w, w.sim.time), 1, at, EJECTED, w.sim);
  return air.survivors.slice(before).map((s) => s.id);
}

function rescuesOf(w: SimWorld, ids: readonly number[]): Mission[] {
  return w.air!.liveMissions().filter((m) => m.survivors?.some((id) => ids.includes(id)));
}

const own = input.airbases.find((a) => a.side === 'alliance')!;

describe('a rescue for every survivor', () => {
  it('is launched at once, from the nearest base, a pair, with no escort far from the enemy', () => {
    const w = make();
    w.sim.advanceTo(4 * HOUR);
    const ids = downAt(w, destination(own.point, 0.5, 8e3, R));
    w.sim.advanceTo(w.sim.time + 1);
    const pkg = rescuesOf(w, ids);
    expect(pkg.length).toBe(1);
    const m = pkg[0]!;
    expect(m.type).toBe('csar');
    expect(m.aircraft).toBe(2);
    expect(m.timeline[0]!.time - 4 * HOUR).toBeLessThanOrEqual(11 * MINUTE);
    // The side's base nearest the survivor, whichever squadron flies it.
    const s = w.air!.survivors[ids[0]!]!;
    const nearest = input.airbases
      .filter((a) => a.side === 'alliance')
      .reduce((b, a) =>
        arcDistance(a.point, s.point, R) < arcDistance(b.point, s.point, R) ? a : b,
      );
    expect(m.base).toEqual({ kind: 'airbase', id: nearest.id });
    expect(w.air!.liveMissions().some((x) => x.package === m.package && x.id !== m.id)).toBe(false);
  });

  it('brings an escort and cover near the enemy', () => {
    const w = make();
    w.sim.advanceTo(4 * HOUR);
    const g = w.ground!;
    const b = g.orbat.battalions.find((x) => x.side === 'pact' && x.kind === 'tank')!;
    const ids = downAt(w, g.battalionAnchor(b.id)!.point);
    w.sim.advanceTo(w.sim.time + 1);
    const lead = rescuesOf(w, ids)[0]!;
    const pkg = w.air!.liveMissions().filter((x) => x.package === lead.package);
    const types = pkg.map((x) => x.type).sort();
    expect(types).toContain('rescap');
    expect(types).toContain('csar');
    // An escort where the side has attack helicopters in reach.
    if (
      w.air!.squadrons.some(
        (s) => s.side === 'alliance' && aircraftType(s.type).role === 'attack-helicopter',
      )
    )
      expect(types).toContain('csar-escort');
  });

  it('picks the survivors up and lands them home, back on their rosters', () => {
    const w = make();
    w.sim.advanceTo(4 * HOUR);
    const ids = downAt(w, destination(own.point, 2, 15e3, R));
    w.sim.advanceTo(w.sim.time + 1);
    const m = rescuesOf(w, ids)[0]!;
    w.sim.advanceTo(missionEnd(m) + 1);
    for (const id of ids) {
      const s = w.air!.survivors[id]!;
      expect(s.state, `#${id}`).toBe('rescued');
      expect(s.carrier).toBe(m.id);
      expect(w.air!.squadrons[s.squadron]!.pilots).toContain(s.pilot);
    }
    const log = w.sim.log.entries.filter((e) => e.source === 'decision');
    expect(log.filter((e) => e.kind === 'survivor-picked-up').length).toBe(ids.length);
    expect(log.filter((e) => e.kind === 'survivor-rescued').length).toBe(ids.length);
  });

  it('stays on the map while landed at the pickup, and off it on its base (decision 371)', () => {
    const w = make();
    w.sim.advanceTo(4 * HOUR);
    const ids = downAt(w, destination(own.point, 2, 15e3, R));
    w.sim.advanceTo(w.sim.time + 1);
    const m = rescuesOf(w, ids)[0]!;
    const view = { side: 'alliance' as const, routes: false };
    const marks = (t: number) =>
      buildAirOverlays(w.air!.liveMissions(), w.air!.carriers, t, R, view).marks.filter(
        (x) => x.key === `mission:${m.id}`,
      );
    // On its base's ground time: no icon.
    const departing = m.timeline[0]!.time + 1;
    const onBase = routeState(m.route, departing, R);
    expect(onBase.airborne).toBe(false);
    expect(onBase.landed).toBe(false);
    expect(marks(departing)).toEqual([]);
    // Landed at the survivor: the icon stays, at the pickup, and the panel says so.
    const pickup = phaseTime(m, 'on-target') + 30;
    const down = routeState(m.route, pickup, R);
    expect(down.airborne).toBe(false);
    expect(down.landed).toBe(true);
    expect(down.speed).toBe(0);
    const [mark] = marks(pickup);
    expect(mark).toBeDefined();
    expect(arcDistance(mark!.point, w.air!.survivors[ids[0]!]!.point, R)).toBeLessThan(1);
    // In the air, on its way down to the pickup, it is airborne, not landed.
    const flying = routeState(m.route, phaseTime(m, 'on-target') - 60, R);
    expect(flying.airborne).toBe(true);
    expect(flying.landed).toBe(false);
  });

  it('turns home when its survivors are captured first, and tries again after a failure', () => {
    const w = make();
    w.sim.advanceTo(4 * HOUR);
    const air = w.air!;
    const ids = downAt(w, destination(own.point, 3, 20e3, R));
    w.sim.advanceTo(w.sim.time + 1);
    const first = rescuesOf(w, ids)[0]!;
    // Called off by hand: a new rescue goes out at the next tick, as a new attempt.
    air.abort(first, 'test', w.sim);
    w.sim.advanceTo(w.sim.time + HOUR);
    const second = rescuesOf(w, ids).find((m) => m.id !== first.id && !m.aborted)!;
    expect(second).toBeDefined();
    expect(air.survivors[ids[0]!]!.attempts).toBe(2);
    // All captured before it lands: the package turns home.
    for (const id of ids) air.survivorLost(air.survivors[id]!, 'captured', w.sim);
    expect(second.aborted).toBe('survivor lost');
  });
});

describe('crews', () => {
  it('rest after they land and never fly beyond the roster', () => {
    const w = make();
    const air = w.air!;
    let rested = 0;
    for (let t = 10 * MINUTE; t <= 26 * HOUR; t += 10 * MINUTE) {
      w.sim.advanceTo(t);
      for (const s of air.squadrons) {
        const crew = Math.max(1, aircraftType(s.type).crew);
        let seats = air.restingSeats(s.id, t);
        if (seats > 0) rested++;
        for (const m of air.liveMissions()) if (m.squadron === s.id) seats += m.aircraft * crew;
        expect(seats, s.name).toBeLessThanOrEqual(s.pilots.length);
      }
    }
    expect(rested).toBeGreaterThan(0);
    // A rest ends CREW_REST after the landing.
    for (const [, until] of air.resting) expect(until).toBeLessThanOrEqual(26 * HOUR + CREW_REST);
  });
});
