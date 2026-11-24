/**
 * Survivors (roadmap R2.9, decision 351): their records, the capture hazard near the
 * enemy, and the watch that captures them or lets them die.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { arcDistance, destination } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { rng } from '../src/core/rng';
import { HOUR } from '../src/core/units';
import type { Side } from '../src/campaign/cast';
import type { AirOps } from '../src/sim/air/airOps';
import {
  CAPTURE_NEAR,
  captureHazard,
  CHECK_PERIOD,
  DRIFT_MAX,
  DRIFT_MIN,
  newSurvivor,
  SURVIVAL,
  SurvivorWatch,
  territoryAt,
} from '../src/sim/air/survivors';
import type { BattalionSource, Survivor } from '../src/sim/air/survivors';
import { campaignInput } from '../src/sim/command/campaignInput';
import { Simulation } from '../src/sim/simulation';
import { createSimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

const R = DEFAULT_PLANET_PARAMS.radius;
const world = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
const base = { side: 'alliance' as Side, pilot: 'A. Pilot', squadron: 0, mission: 0, theater: 0 };
const home = input.airbases.find((a) => a.side === 'alliance')!.point;

function survivor(id: number, at: Readonly<Dir>, water = false): Survivor {
  return newSurvivor(rng(1, 'survivors'), { ...base, id, time: 0 }, at, R, () => water);
}

describe('a survivor record', () => {
  it('drifts from the loss, draws its injury and timer from its own fork, the same every time', () => {
    const counts = { none: 0, light: 0, serious: 0 };
    for (let id = 0; id < 400; id++) {
      const s = survivor(id, home);
      const d = arcDistance(s.point, home, R);
      expect(d).toBeGreaterThanOrEqual(DRIFT_MIN - 1e-6);
      expect(d).toBeLessThanOrEqual(DRIFT_MAX + 1e-6);
      expect(s.until).toBe(SURVIVAL.land[s.injury]);
      expect(s.state).toBe('down');
      expect(survivor(id, home)).toEqual(s);
      counts[s.injury]++;
    }
    // About 55%, 33% and 12%.
    expect(counts.none).toBeGreaterThan(180);
    expect(counts.light).toBeGreaterThan(100);
    expect(counts.serious).toBeGreaterThan(25);
    const wet = survivor(3, home, true);
    expect(wet.water).toBe(true);
    expect(wet.until).toBe(SURVIVAL.water[wet.injury]);
  });
});

describe('the capture hazard', () => {
  const enemy = input.airbases.find((a) => a.side === 'pact')!.point;
  const near: BattalionSource = { battalions: () => [{ side: 'pact', point: enemy }] };

  it('falls with distance from the enemy, rises with injury and is none in the water', () => {
    const at = (km: number) => destination(enemy, 1, km * 1000, R);
    const h0 = captureHazard(input, near, 'alliance', at(0.1), 'none', false);
    const h5 = captureHazard(input, near, 'alliance', at(5), 'none', false);
    const h30 = captureHazard(input, near, 'alliance', at(30), 'none', false);
    expect(h0).toBeGreaterThan(h5);
    expect(h5).toBeGreaterThan(h30);
    expect(h0).toBeGreaterThan(0.9 * CAPTURE_NEAR);
    expect(captureHazard(input, near, 'alliance', at(5), 'serious', false)).toBeGreaterThan(h5);
    expect(captureHazard(input, near, 'alliance', at(0.1), 'none', true)).toBe(0);
    // Its own side's battalion is no danger.
    expect(captureHazard(input, near, 'pact', enemy, 'none', false)).toBe(0);
  });

  it('knows whose ground a point is by the nearest held place', () => {
    expect(territoryAt(input, home)).toBe('alliance');
    expect(territoryAt(input, enemy)).toBe('pact');
  });
});

describe('the survivor watch', () => {
  function watchOf(survivors: Survivor[], ground: BattalionSource | null) {
    const lost: [number, string][] = [];
    const air = {
      survivors,
      survivorLost(s: Survivor, state: 'captured' | 'died') {
        s.state = state;
        lost.push([s.id, state]);
      },
    } as unknown as AirOps;
    return { watch: new SurvivorWatch(air, input, 7, ground), lost };
  }

  it('lets a survivor die past its timer and captures one beside the enemy', () => {
    const enemy = input.airbases.find((a) => a.side === 'pact')!.point;
    const ground: BattalionSource = { battalions: () => [{ side: 'pact', point: enemy }] };
    const far = { ...survivor(0, home), until: 2 * HOUR };
    const close = { ...survivor(1, enemy), id: 1, injury: 'serious' as const, until: 99 * HOUR };
    const { watch, lost } = watchOf([far, close], ground);
    const sim = new Simulation(0);
    for (let k = 1; k * CHECK_PERIOD <= 12 * HOUR; k++) watch.step(k * CHECK_PERIOD, k, sim);
    expect(far.state).toBe('died');
    expect(close.state).toBe('captured');
    expect(lost.map((x) => x[0]).sort()).toEqual([0, 1]);
  });

  it('decides the same fates stepped every ten minutes and in one jump', () => {
    const states = (jump: boolean) => {
      const w = createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });
      if (jump) w.sim.advanceTo(26 * HOUR);
      else for (let t = 0; t <= 26 * HOUR; t += 10 * 60) w.sim.advanceTo(t);
      return w.air!.survivors.map((s) => `${s.id}:${s.state}:${s.changed}`);
    };
    const a = states(false);
    expect(a.length).toBeGreaterThan(0);
    expect(states(true)).toEqual(a);
  });
});
