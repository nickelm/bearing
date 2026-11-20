/**
 * R2.5's exit test: take over and hand back at every phase of a CAP mission's jump-in
 * window, flying at full fidelity in between, with the mission completing; losses and
 * expended stores carry over in both directions (full fidelity to the campaign at each
 * handback, the campaign to full fidelity at each promotion).
 *
 * The flight flies over sea level, not the world's terrain: its routes stand on the
 * coarse ground's floor (decision 240), so they clear it, and the drawn ground is the
 * renderer's. The player is stood in for by a route tracker on the player's aircraft,
 * flying through its own input source as mouse aim would.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR, MINUTE } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { analyticPose } from '../src/sim/air/analyticPose';
import { formationAt, slotPose } from '../src/sim/air/formation';
import { jumpInWindow, MISSION_PHASES, missionPhase, phaseTime } from '../src/sim/air/mission';
import type { Mission, MissionPhase } from '../src/sim/air/mission';
import { routeState } from '../src/sim/air/route';
import type { Route } from '../src/sim/air/route';
import { campaignInput } from '../src/sim/command/campaignInput';
import { missionPlugin } from '../src/sim/command/missions/registry';
import { PoseTracker, ROUTE_GAINS } from '../src/sim/flight/aiPilot';
import type { Reference } from '../src/sim/flight/aiPilot';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { PromotedFlight } from '../src/sim/flight/promotedFlight';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { kestrelSpec } from './helpers/flight';
import { seaLevel } from './helpers/promoted';
import { syntheticConfig } from './helpers/weatherWorld';

const R = DEFAULT_PLANET_PARAMS.radius;
const SPAN = 9.5;
const world = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
const make = (): SimWorld => createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });
const formations = missionPlugin('cap').formations;

function reference(route: () => Route): Reference {
  return (t) => {
    const p = analyticPose(route(), t, R);
    return { pos: new Vec3d(...p.pos), vel: new Vec3d(...p.velocity) };
  };
}

/** The flight promoted at t from its analytic poses, as the follow promotes it. */
function promote(get: () => Mission, t: number): PromotedFlight {
  const m = get();
  const lead = analyticPose(m.route, t, R);
  const f = formationAt(m.timeline, formations, t);
  const poses = Array.from({ length: m.aircraft }, (_, k) => slotPose(lead, k, f, SPAN));
  return new PromotedFlight(m, t, R, kestrelSpec(), poses, {
    lead: reference(() => get().route),
    formation: (u) => formationAt(get().timeline, formations, u),
    phase: (u) => routeState(get().route, u, R).phase,
    span: SPAN,
  });
}

describe('R2.5 exit: take over and hand back at every phase of a CAP', () => {
  it('completes the mission with losses and stores carried both ways', () => {
    const host = new SimHost(make, applyInput);
    host.seek(2 * HOUR);
    const caps = host.world
      .air!.liveMissions()
      .filter((m) => m.type === 'cap' && m.aircraft >= 3 && phaseTime(m, 'climb-out') > host.time)
      .sort((a, b) => phaseTime(a, 'climb-out') - phaseTime(b, 'climb-out'));
    expect(caps.length).toBeGreaterThan(0);
    const id = caps[0]!.id;
    const mission = () => host.world.air!.missions.get(id)!;
    /** The next phase of the window on the mission's current route after `done`, or null. */
    const next = (done: MissionPhase | null): MissionPhase | null => {
      const m = mission();
      const w = jumpInWindow(m);
      if (!w) return null;
      const order = MISSION_PHASES.indexOf(done ?? 'departure');
      const e = m.timeline.find(
        (x) =>
          x.time >= w.from &&
          x.time < w.to &&
          (done === null || MISSION_PHASES.indexOf(x.phase) > order),
      );
      return e?.phase ?? null;
    };
    let expectedAircraft = mission().aircraft;
    let fired = 0;
    const flown: MissionPhase[] = [];
    for (let phase = next(null), k = 0; phase !== null; phase = next(phase), k++) {
      const m0 = mission();
      const start = Math.max(phaseTime(m0, phase), host.time) + 20;
      host.seek(start);
      const m = mission();
      expect(missionPhase(m, host.time)).toBe(phase);
      // The campaign to full fidelity: the flight's aircraft and the lead's stores so far.
      const f = promote(mission, host.time);
      expect(f.aircraft).toHaveLength(expectedAircraft);
      expect(f.aircraft[0]!.stores.expended).toEqual(fired > 0 ? { 'aim-9': fired } : {});
      host.input({ kind: 'take-over', mission: id, slot: 0 });
      expect(mission().flown?.slot).toBe(0);
      // The player flies the lead on its route through its own input source.
      expect(f.takeOver(0)).toBe(true);
      const tracker = new PoseTracker(
        reference(() => m.route),
        ROUTE_GAINS,
      );
      const lead = f.aircraft[0]!;
      lead.flown.pilot = (_a, ctl, dt) =>
        void tracker.fly(lead.flown.airframe as unknown as FlightModel, f.time, ctl, dt);
      const t0 = host.time;
      for (let t = t0; t < t0 + 60; t += 1 / 30) f.advanceTo(t, seaLevel);
      // Full fidelity to the campaign: in the second session the last wingman crashes, and
      // each session the lead fires one store.
      if (k === 1) (f.aircraft[f.aircraft.length - 1]!.flown.airframe as FlightModel).crash('test');
      lead.stores.expended['aim-9'] = (lead.stores.expended['aim-9'] ?? 0) + 1;
      fired++;
      host.seek(t0 + 60);
      const h = f.handback();
      host.input({ kind: 'hand-back', mission: id, fix: h.fix, lost: h.lost, stores: h.stores });
      if (k === 1) expectedAircraft--;
      const after = mission();
      expect(after.flown).toBeUndefined();
      expect(after.aircraft).toBe(expectedAircraft);
      expect(after.expended?.[0]).toEqual({ 'aim-9': fired });
      // No phase runs backward: the rebuilt route carries on from the phase it was in.
      const now = missionPhase(after, host.time) as MissionPhase;
      expect(MISSION_PHASES.indexOf(now)).toBeGreaterThanOrEqual(MISSION_PHASES.indexOf(phase));
      flown.push(phase);
    }
    // Every phase of the window was flown: the climb-out, the station and the egress.
    expect(flown).toEqual(expect.arrayContaining(['climb-out', 'fence-in', 'on-target', 'egress']));
    const log = host.world.sim.log.entries;
    expect(log.filter((e) => e.kind === 'flight-session' && e.mission === id)).toHaveLength(
      flown.length,
    );
    expect(
      log.some((e) => e.kind === 'aircraft-lost' && e.mission === id && e.cause === 'test'),
    ).toBe(true);
    // The mission completes on its last rebuilt route.
    const end = mission().timeline[mission().timeline.length - 1]!.time;
    host.seek(end + MINUTE);
    expect(host.world.air!.missions.has(id)).toBe(false);
    expect(log.some((e) => e.kind === 'mission-resolved' && e.mission === id)).toBe(true);
  }, 300_000);
});
