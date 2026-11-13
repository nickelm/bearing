/**
 * The headless Free Flight test (decision 134): the scripted test pilot takes
 * off from an airbase of a generated world, climbs to 1,000 m above the field,
 * flies a rectangular circuit and lands on the same runway in the touchdown
 * zone, through the same ground query, grading and runway records the app uses.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { AirfieldGround, runwaysOf } from '../src/freeflight/ground';
import { SurfaceGrading } from '../src/render/common/terrain/grading';
import { airfieldPads, globalMapSampler } from '../src/render/sim/infra/airfieldGrading';
import { InfraScene } from '../src/render/sim/infra/infraScene';
import { neutralControls } from '../src/sim/flight/controlLaws';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import type { FlightEvent } from '../src/sim/flight/outcomes';
import { fromRunway, runwayEnds, runwayFrame, TOUCHDOWN_ZONE } from '../src/sim/flight/runway';
import type { Runway } from '../src/sim/flight/runway';
import { spawnOnRunway } from '../src/sim/flight/spawn';
import { TestPilot } from '../src/sim/flight/testPilot';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { kestrel } from './helpers/flight';

const SEED = 1;
const N = 64;

describe('headless flight test on a generated airbase', () => {
  let ground: AirfieldGround;
  let runway: Runway;
  const R = DEFAULT_PLANET_PARAMS.radius;

  beforeAll(() => {
    const w = generateCampaignWorld(
      { ...DEFAULT_PLANET_PARAMS, seed: SEED },
      { grid: new CubeGrid(N) },
    );
    const infra = new InfraScene(w.graph, w.infrastructure, R);
    const sampler = globalMapSampler(w.world.maps.height, N);
    const pads = airfieldPads(infra, sampler);
    const grading = new SurfaceGrading(pads, R);
    const runways = runwaysOf(w.infrastructure, pads);
    ground = new AirfieldGround(runways, grading, (d) => grading.apply(d, sampler(d)), R);
    // The first Alliance main base whose circuit stays clear of high ground (within
    // 20 km nothing more than 500 m above the field).
    const clear = (r: Runway) => {
      const f = runwayFrame(r);
      for (let a = -20_000; a <= 20_000; a += 2000)
        for (let c = -20_000; c <= 20_000; c += 2000)
          if (ground.height(fromRunway(f, a, c, R)) > r.elevation + 500) return false;
      return true;
    };
    const pick =
      runways.find(
        (r, i) =>
          w.infrastructure.airbases[i]!.kind === 'main' && r.side === 'alliance' && clear(r),
      ) ?? runways.find(clear);
    expect(pick).toBeDefined();
    runway = pick!;
  }, 60_000);

  it('takes off, flies a circuit at 1,000 m and lands in the touchdown zone', () => {
    const m = kestrel();
    const end = runwayEnds(runway)[0];
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    const pilot = new TestPilot(runway, end, R);
    const monitor = new FlightMonitor(ground.runways, R);
    const events: FlightEvent[] = [];
    let maxHeight = 0;
    let maxSpeed = 0;
    const legs = new Set<string>();
    for (let i = 0; i < 900 / FLIGHT_STEP && !m.crashed && pilot.phase !== 'stopped'; i++) {
      pilot.fly(m, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
      events.push(...monitor.update(m, FLIGHT_STEP));
      maxHeight = Math.max(maxHeight, m.telemetry.altitude - runway.elevation);
      maxSpeed = Math.max(maxSpeed, m.telemetry.cas);
      legs.add(pilot.legLabel);
    }
    // Stand a few seconds, so the monitor sees the full stop.
    for (let i = 0; i < 3 / FLIGHT_STEP; i++) {
      pilot.fly(m, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
      events.push(...monitor.update(m, FLIGHT_STEP));
    }
    expect(m.crashed).toBeNull();
    expect(pilot.phase).toBe('stopped');
    expect(events.find((e) => e.kind === 'liftoff')).toBeDefined();
    expect(maxHeight).toBeGreaterThan(900);
    expect(maxHeight).toBeLessThan(1300);
    expect(maxSpeed / KNOT).toBeLessThan(330);
    for (const leg of ['upwind', 'crosswind', 'downwind', 'base', 'final', 'flare', 'rollout'])
      expect(legs.has(leg), leg).toBe(true);
    const tds = events.filter((e) => e.kind === 'touchdown');
    expect(tds).toHaveLength(1);
    const td = tds[0]!.kind === 'touchdown' ? tds[0]!.touchdown : null;
    expect(td).not.toBeNull();
    expect(td!.runway?.id).toBe(runway.id);
    expect(td!.end?.designator).toBe(end.designator);
    expect(td!.sinkRate).toBeLessThan(2);
    expect(td!.inZone).toBe(true);
    expect(td!.distance!).toBeGreaterThan(TOUCHDOWN_ZONE[0]);
    expect(td!.distance!).toBeLessThan(TOUCHDOWN_ZONE[1]);
    expect(Math.abs(td!.offset!)).toBeLessThan(5);
    const stop = events.find((e) => e.kind === 'stopped');
    expect(stop?.kind === 'stopped' && stop.runway?.id).toBe(runway.id);
  });

  it('places the wheels exactly on the graded pad the renderer draws', () => {
    const m = kestrel();
    spawnOnRunway(m, runway, runwayEnds(runway)[1]);
    const ctl = neutralControls();
    ctl.parkingBrake = true;
    for (let i = 0; i < 3 / FLIGHT_STEP; i++) m.step(ctl, ground);
    const up = m.pos.clone().normalize();
    expect(ground.height(up)).toBe(runway.elevation);
    expect(ground.surface(up)).toBe('runway');
    // The CG sits its gear height above the pad, less the struts' static compression.
    const h = m.pos.length() - R - runway.elevation;
    expect(h).toBeGreaterThan(m.gearHeight - 0.15);
    expect(h).toBeLessThan(m.gearHeight);
    void Vec3d;
  });
});
