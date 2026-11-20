import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR, MINUTE } from '../src/core/units';
import { jumpInOpen, missionPhase, phaseTime } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { routeState } from '../src/sim/air/route';
import { campaignInput } from '../src/sim/command/campaignInput';
import type { HandbackFix } from '../src/sim/eventLog';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
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

/** The first CAP of `side` whose window opens after `after`, and the time its fence-in starts. */
function nextCap(w: SimWorld, after: number): Mission {
  const caps = w
    .air!.liveMissions()
    .filter((m) => m.type === 'cap' && m.aircraft >= 2 && phaseTime(m, 'fence-in') > after)
    .sort((a, b) => phaseTime(a, 'fence-in') - phaseTime(b, 'fence-in'));
  expect(caps.length).toBeGreaterThan(0);
  return caps[0]!;
}

/** The flight's state on its route at t, as a faithful AI's demotion would give it. */
function fixOf(m: Mission, t: number): HandbackFix {
  const s = routeState(m.route, t, R);
  return {
    time: t,
    point: s.point,
    altitude: s.altitude,
    heading: s.heading,
    fuel: s.fuel,
    aircraft: m.aircraft,
    airborne: s.airborne,
  };
}

describe('taking over and handing back in the worker', () => {
  it('holds a flown CAP, then rebuilds it from the fix with its crash lost, and the mission completes', () => {
    const host = new SimHost(make, applyInput);
    host.seek(2 * HOUR);
    const m0 = nextCap(host.world, host.time);
    const id = m0.id;
    const take = phaseTime(m0, 'fence-in') + MINUTE;
    host.seek(take);
    let m = host.world.air!.missions.get(id)!;
    expect(jumpInOpen(m, host.time)).toBe(true);
    host.input({ kind: 'take-over', mission: id, slot: 0 });
    expect(m.flown).toEqual({ slot: 0, since: take });
    // Held: its phases wait, even past the old route's end.
    const end = m.timeline[m.timeline.length - 1]!.time;
    host.seek(end + 10 * MINUTE);
    expect(host.world.air!.missions.get(id)).toBe(m);
    expect(m.resolved).toBeFalsy();
    // Handed back 20 min after the take-over, on station, with #2 crashed. The seek goes
    // back from a checkpoint, so the world (and the mission object) is a new one.
    const back = take + 20 * MINUTE;
    host.seek(back);
    m = host.world.air!.missions.get(id)!;
    expect(m.flown?.slot).toBe(0);
    const strength = host.world.air!.squadrons[m.squadron]!.aircraft;
    const before = m.aircraft;
    host.input({
      kind: 'hand-back',
      mission: id,
      fix: { ...fixOf(m, back), aircraft: before - 1 },
      lost: [{ slot: 1, point: routeState(m.route, back, R).point, cause: 'crash' }],
    });
    expect(m.flown).toBeUndefined();
    expect(m.aircraft).toBe(before - 1);
    expect(host.world.air!.squadrons[m.squadron]!.aircraft).toBe(strength - 1);
    const log = host.world.sim.log.entries;
    expect(
      log.some((e) => e.kind === 'aircraft-lost' && e.mission === id && e.cause === 'crash'),
    ).toBe(true);
    expect(log.some((e) => e.kind === 'mission-rejoined' && e.mission === id)).toBe(true);
    // It goes on from where it was handed back and completes.
    expect(missionPhase(m, host.time)).not.toBe('complete');
    const done = m.timeline[m.timeline.length - 1]!.time;
    expect(done).toBeGreaterThan(back);
    host.seek(done + MINUTE);
    expect(host.world.air!.missions.has(id)).toBe(false);
    expect(log.some((e) => e.kind === 'mission-resolved' && e.mission === id)).toBe(true);
  }, 120_000);

  it('replays to the same state from a checkpoint before the take-over', () => {
    const run = (seekBack: boolean) => {
      const host = new SimHost(make, applyInput);
      host.seek(2 * HOUR);
      const m0 = nextCap(host.world, host.time);
      const take = phaseTime(m0, 'fence-in') + MINUTE;
      host.seek(take);
      host.input({ kind: 'take-over', mission: m0.id, slot: 0 });
      const back = take + 15 * MINUTE;
      host.seek(back);
      const m = host.world.air!.missions.get(m0.id)!;
      host.input({ kind: 'hand-back', mission: m0.id, fix: fixOf(m, back), lost: [] });
      host.seek(back + 2 * HOUR);
      if (seekBack) {
        host.seek(HOUR);
        host.seek(back + 2 * HOUR);
      }
      return host.world.sim.hash();
    };
    expect(run(true)).toBe(run(false));
  }, 240_000);

  it('refuses a take-over outside the window or twice', () => {
    const host = new SimHost(make, applyInput);
    host.seek(2 * HOUR);
    const m = nextCap(host.world, host.time);
    // Before the climb-out: not yet.
    host.input({ kind: 'take-over', mission: m.id, slot: 0 });
    expect(m.flown).toBeUndefined();
    host.seek(phaseTime(m, 'fence-in'));
    host.input({ kind: 'take-over', mission: m.id, slot: 1 });
    host.input({ kind: 'take-over', mission: m.id, slot: 0 });
    expect(m.flown?.slot).toBe(1);
  }, 120_000);
});
