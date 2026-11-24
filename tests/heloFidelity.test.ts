/**
 * R2.9's exit, its second half (decision 357): a followed CSAR helicopter flight at full
 * fidelity flies from its base to the survivor, lands its lead at a landing zone clear of
 * trees, slopes and water near the survivor, waits out the pickup and takes off again,
 * flown by the AI helicopter pilots through the rotary director (rule 12). Headless: the
 * coarse world's ground stands in for the drawn one.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { arcDistance, destination } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { EJECTED } from '../src/sim/air/airOps';
import { isAirborne, phaseTime } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { campaignInput } from '../src/sim/command/campaignInput';
import { missionPlugin } from '../src/sim/command/missions/registry';
import type { GroundQuery } from '../src/sim/flight/contact';
import { createSimWorld } from '../src/sim/world';
import { HeloFidelity, heloFidelityWanted, rotorSpecOfType } from '../src/follow/heloFidelity';
import { flightPoses, HELICOPTER_CLEARANCE } from '../src/follow/followFlight';
import { flightSpecOfType } from '../src/follow/fullFidelity';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { globalMapSampler } from '../src/worldgen/edits/airfields';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';
import utilityJson from '../src/data/models/aircraft/alliance-utility-helo.json';

const R = DEFAULT_PLANET_PARAMS.radius;
const world = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
const sample = globalMapSampler(world.world.maps.height, world.world.info.resolution);
/** The coarse ground, the sea at 0 (water). */
const ground: GroundQuery = {
  height: (d) => Math.max(0, sample(d)),
  surface: (d) => (sample(d) < 0 ? 'water' : 'field'),
};
const flight = (id: string) =>
  id === 'alliance-utility-helo' ? (utilityJson as { flight: unknown }).flight : undefined;

/** A rescue launched for a crew downed `km` from an Alliance base, and the world. */
function rescue(km: number): { m: Mission; survivor: Dir } {
  const w = createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });
  w.sim.advanceTo(4 * HOUR);
  const own = input.airbases.find(
    (a) => a.side === 'alliance' && sample(new Vec3d(...a.point)) > 0,
  )!;
  const air = w.air!;
  const victim = air.liveMissions().find((x) => x.side === 'alliance' && isAirborne(x, 4 * HOUR))!;
  const before = air.survivors.length;
  air.lose(victim, 1, destination(own.point, 1, km * 1000, R), EJECTED, w.sim);
  w.sim.advanceTo(w.sim.time + 1);
  const ids = air.survivors.slice(before).map((s) => s.id);
  const m = air
    .liveMissions()
    .find((x) => x.type === 'csar' && x.survivors?.some((id) => ids.includes(id)))!;
  return { m: structuredClone(m), survivor: air.survivors[ids[0]!]!.point };
}

describe('a followed CSAR helicopter at full fidelity', () => {
  it('has rotorcraft flight data for the UH-68 and none for a jet', () => {
    expect(rotorSpecOfType('uh68', flight)).not.toBeNull();
    expect(flightSpecOfType('uh68', flight)).toBeNull();
    expect(rotorSpecOfType('f21', () => undefined)).toBeNull();
  });

  it('flies to the survivor, lands clear of the trees, waits out the pickup and takes off', () => {
    const { m, survivor } = rescue(18);
    const spec = rotorSpecOfType(m.aircraftType, flight)!;
    const t0 = m.timeline[0]!.time;
    expect(heloFidelityWanted(m, t0 + 1, 8)).toBe(true);
    expect(heloFidelityWanted(m, t0 + 1, 16)).toBe(false);
    const formations = missionPlugin(m.type).formations;
    const pose = (mm: Readonly<Mission>, u: number, slot: number) =>
      flightPoses(mm, u, R, [], formations, 14)[slot] ?? null;
    // A forest over the survivor's spot: the zone must be found outside it.
    const forest = (d: Readonly<Dir>) => (arcDistance(d, survivor, R) < 120 ? 0.8 : 0);
    const f = new HeloFidelity(
      {
        radius: R,
        mission: () => m,
        pose,
        ground,
        site: (d) => ({ forest: forest(d), water: sample(new Vec3d(d[0], d[1], d[2])) < 0 }),
        gearHeight: 1,
        clearance: HELICOPTER_CLEARANCE,
      },
      spec,
      m,
      t0 + 1,
      [0, 1].map((k) => pose(m, t0 + 1, k)!),
    );
    expect(f.aircraft.length).toBe(m.aircraft);
    const egress = phaseTime(m, 'egress');
    const lead = f.aircraft[0]!;
    const states = new Set<string>();
    let t = t0 + 1;
    while (t < egress + 10 * 60) {
      t += 0.3;
      expect(f.advance(m, t)).toBe(true);
      states.add(lead.pilot.state);
      if (lead.pilot.state === 'track' && lead.pilot.touchdown && t > egress + 60) break;
    }
    for (const a of f.aircraft) expect(a.model.crashed, `slot ${a.slot}`).toBeNull();
    const lz = f.lz!;
    expect(lz).not.toBeNull();
    expect(lz.forest).toBeLessThanOrEqual(0.15);
    expect(arcDistance(lz.point, survivor, R)).toBeGreaterThan(100);
    expect(arcDistance(lz.point, survivor, R)).toBeLessThan(600);
    const td = lead.pilot.touchdown!;
    expect(td, 'touched down').not.toBeNull();
    expect(td.sink).toBeLessThan(1.5);
    expect(td.miss).toBeLessThan(5);
    // On the ground through the pickup, up again after it.
    expect(states).toContain('wait');
    expect(states).toContain('takeoff');
    expect(lead.pilot.state).toBe('track');
    expect(lead.model.onGround).toBe(false);
  }, 120_000);
});
