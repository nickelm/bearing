/** The campaign as the sensors see it (decision 303). */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  campaignDatalink,
  campaignTargets,
  emitterLabel,
  SAM_TRACK,
} from '../src/follow/campaignSensors';
import { aircraftType } from '../src/sim/air/aircraft';
import { analyticPose } from '../src/sim/air/analyticPose';
import { routeState } from '../src/sim/air/route';
import { TYPE_PROFILES } from '../src/sim/avionics/profiles';
import { campaignInput } from '../src/sim/command/campaignInput';
import { SimHost } from '../src/sim/host';
import { SensorModel } from '../src/sim/sensors/sensors';
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

describe('campaign contacts (decision 303)', () => {
  const host = new SimHost(make, applyInput);
  host.seek(3 * HOUR);
  const t = host.time;
  const missions = host.world.air!.liveMissions();
  const airborne = missions.filter((m) => routeState(m.route, t, R).airborne);
  const own = airborne.find((m) => m.side === 'alliance')!;
  const p = analyticPose(own.route, t, R);
  const pos = new Vec3d(...p.pos);

  it('makes every airborne flight in reach a target at its lead, the other side’s radars emitters', () => {
    const targets = campaignTargets(
      missions,
      t,
      R,
      { id: 'own', side: 'alliance', pos, exclude: own.id },
      [],
      () => 0,
    );
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.some((x) => x.id === `m${own.id}`)).toBe(false);
    for (const x of targets) {
      const m = missions.find((y) => `m${y.id}` === x.id)!;
      expect(x.side).toBe(m.side);
      expect(x.pos.distanceTo(pos)).toBeLessThan(400_000 + 20_000);
      const radar = TYPE_PROFILES[m.aircraftType]?.radar;
      expect(x.emitter !== null).toBe(!!radar && m.side === 'pact');
      if (x.emitter) expect(x.emitter.kind).toBe(emitterLabel(aircraftType(m.aircraftType).name));
    }
    expect(emitterLabel('Vo-31 Strizh')).toBe('31');
  });

  it('gives the other side’s defended places surface-to-air radars that track within 25 km', () => {
    const near = pos.clone().normalize();
    const dir: [number, number, number] = [near.x, near.y, near.z];
    const sites = [
      { id: 'site:1', side: 'pact' as const, point: dir },
      { id: 'site:2', side: 'alliance' as const, point: dir },
    ];
    const targets = campaignTargets(
      missions,
      t,
      R,
      { id: 'own', side: 'alliance', pos, exclude: own.id },
      sites,
      () => 0,
    );
    const sam = targets.find((x) => x.id === 'site:1')!;
    expect(targets.some((x) => x.id === 'site:2')).toBe(false);
    expect(sam.emitter!.ground).toBe(true);
    expect(sam.emitter!.state).toBe(sam.pos.distanceTo(pos) < SAM_TRACK ? 'track' : 'search');
  });

  it('feeds the datalink only while an early warning aircraft of the side flies', () => {
    const targets = campaignTargets(
      missions,
      t,
      R,
      { id: 'own', side: 'alliance', pos, exclude: own.id },
      [],
      () => 0,
    );
    const aew = airborne.some(
      (m) => m.side === 'alliance' && aircraftType(m.aircraftType).role === 'aew',
    );
    const feed = campaignDatalink(missions, t, R, 'alliance', targets);
    expect(feed !== null).toBe(aew);
    if (feed) expect(feed.targets.every((x) => x.side === 'pact')).toBe(true);
  });

  it('shows a flight ahead to the radar as a contact keyed as the seeker and the kills key it', () => {
    const other = airborne.find((m) => m.id !== own.id)!;
    const q = analyticPose(other.route, t, R);
    const target = new Vec3d(...q.pos);
    // Our aircraft 20 km short of it, nose on it.
    const fwd = target.clone().sub(pos).normalize();
    const at = target.clone().addScaled(fwd, -20_000);
    const up = at.clone().normalize();
    const side = fwd.clone().cross(up).normalize();
    const upBody = side.cross(fwd).normalize();
    const targets = campaignTargets(
      missions,
      t,
      R,
      { id: 'own', side: 'alliance', pos: at, exclude: own.id },
      [],
      () => 0,
    );
    const s = new SensorModel();
    s.update(
      {
        id: 'own',
        side: 'alliance',
        pos: at,
        vel: fwd.clone().scale(250),
        forward: fwd,
        up: upBody,
        radar: TYPE_PROFILES.f21!.radar!,
        radarOn: true,
        radarMode: 'rws',
        lock: null,
        rwr: true,
        datalink: false,
      },
      targets,
      { time: t, visibility: 30_000, daylight: 1, lineOfSight: () => true },
      null,
    );
    expect(s.picture.contacts.some((c) => c.id === `m${other.id}`)).toBe(true);
  });
});
