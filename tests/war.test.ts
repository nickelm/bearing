import { describe, expect, it } from 'vitest';
import { defaultCampaignStart } from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { campaignInput } from '../src/sim/command/campaignInput';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { WeatherGrid } from '../src/sim/weather/grid';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

// The campaign as the app starts it (main.ts, startSim), on a small generated world
// with its own climate (R1.3): tests/air.test.ts uses a synthetic climate.
describe('a generated world at war', () => {
  const params = { ...DEFAULT_PLANET_PARAMS, seed: 7 };
  const w = generateCampaignWorld(params, { grid: new CubeGrid(64) });
  const climate = buildWeatherClimate(
    { ...w.world.maps, resolution: w.world.info.resolution, reliefScale: w.world.info.reliefScale },
    new WeatherGrid(),
    params.radius,
  );
  const config = {
    seed: String(w.seed),
    radius: params.radius,
    orbit: params,
    calendar: defaultCampaignStart(new Vec3d(...w.world.info.mainContinent), params),
    climate,
    campaign: campaignInput(w.graph, w.campaign.cast, w.infrastructure),
    ground: { height: w.world.maps.height, n: w.world.info.resolution },
  };
  const make = () => createSimWorld({ ...config, climate: structuredClone(climate) });

  it('runs 12 hours at 64× into the state of one jump, with missions on both sides', () => {
    const stepped = new SimHost(make, applyInput);
    stepped.rate = 64;
    while (stepped.time < 12 * HOUR) stepped.step(1 / 30);
    const jump = new SimHost(make, applyInput);
    jump.seek(stepped.time);
    expect(stepped.world.sim.hash()).toBe(jump.world.sim.hash());
    const air = stepped.world.air!;
    expect(air.launched.alliance).toBeGreaterThan(10);
    expect(air.launched.pact).toBeGreaterThan(10);
    expect(air.completed.alliance + air.completed.pact).toBeGreaterThan(10);
    // The weather runs on the world's climate: systems exist and the fields are finite.
    expect(stepped.world.weather.systems.length).toBeGreaterThan(0);
    const frame = stepped.world.weather.frameData(stepped.world.weather.hour);
    expect(frame.every(Number.isFinite)).toBe(true);
  });

  // R2.1's exit: the orders are the same at any time acceleration and for either viewing side.
  it('issues the same orders at 1× steps, at 64× and in one jump, whichever side the player takes', () => {
    const end = 26 * HOUR;
    const orders = (host: SimHost<SimWorld>) => {
      const w = host.world;
      return JSON.stringify({ ato: w.ato!.save(), air: w.air!.save() });
    };
    // 1×: the worker's frame step at real time, here in 1 s steps (a frame is 1/30 s;
    // 1 s already splits every hour into thousands of steps).
    const slow = new SimHost(make, applyInput);
    slow.input({ kind: 'side', side: 'alliance' });
    for (let t = 1; t <= end; t += 1) slow.world.sim.advanceTo(t);
    const fast = new SimHost(make, applyInput);
    fast.input({ kind: 'side', side: 'pact' });
    fast.rate = 64;
    fast.autoSlowdown = false;
    while (fast.time < end) fast.step(Math.min(1 / 30, (end - fast.time) / 64));
    const jump = new SimHost(make, applyInput);
    jump.seek(end);
    expect(fast.time).toBe(end);
    expect(orders(fast)).toBe(orders(slow));
    expect(orders(jump)).toBe(orders(slow));
    const ato = jump.world.ato!;
    for (const side of ['alliance', 'pact'] as const) {
      expect(ato.stats[side].orders, side).toBe(2);
      expect(ato.stats[side].revisions, side).toBeGreaterThan(2);
      // Each revision is a logged decision (rule 19).
      const logged = jump.world.sim.log.entries.filter(
        (e) => e.source === 'decision' && e.kind === 'ato-revised' && e.side === side,
      );
      expect(logged.length).toBe(ato.stats[side].revisions);
    }
  });
});
