import { describe, expect, it } from 'vitest';
import { defaultCampaignStart } from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { campaignInput } from '../src/sim/command/campaignInput';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
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
});
