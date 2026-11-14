/**
 * The app's wiring of the atmosphere on a real GlobeScene, on Dawn (decision
 * 143): what main.ts and Free Flight call each frame and on cuts, pauses and
 * view switches, run for GPU errors. The scene has no terrain (the debug
 * globe from the free camera); the weather is the standalone model's.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../../src/core/cubeGrid';
import { latLonToDirection } from '../../src/core/coords';
import { DEG, HOUR, KM } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { FlightWeather } from '../../src/freeflight/flightWeather';
import { VOLUMETRIC_QUALITY } from '../../src/render/sim/clouds/volumetrics';
import { GlobeScene } from '../../src/render/sim/globeScene';
import { wetnessTarget } from '../../src/render/sim/weather/weatherState';
import { applyAtmosphere, readAtmosphere } from '../../src/ui/atmosphereSettings';
import { RADIUS, syntheticConfig } from '../helpers/weatherWorld';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('the atmosphere as the app wires it', () => {
  it('pauses, resets, steps the quality down and survives a view switch', async () => {
    const head = await headlessRenderer(gpu!.device, 128, 72);
    const scene = new GlobeScene(head.renderer, {
      radius: RADIUS,
      grid: new CubeGrid(16),
      input: false,
    });
    scene.resize(head.width, head.height);
    const config = syntheticConfig();
    scene.planetOrbit = config.orbit;
    scene.calendar = config.calendar;
    scene.lightning.seed = config.seed;
    scene.weather.setGround(config.climate.ground.slice());
    // The free camera, 3 km over a place on land.
    const here = latLonToDirection(20 * DEG, 30 * DEG, new Vec3d());
    scene.orbit.lat = 20 * DEG;
    scene.orbit.lon = 30 * DEG;
    scene.orbit.altitude = scene.orbit.targetAltitude = 3 * KM;
    const weather = new FlightWeather(scene.weather, 'rain');
    weather.setWorld(config);
    const t = 100.25 * HOUR;
    const frame = async (dt: number) => {
      scene.gameTime = t;
      scene.clouds.time.value = t;
      scene.weatherView = weather.update(t, Infinity);
      scene.render(dt);
      await gpu!.finish();
    };
    const errors = gpu!.errors.length;
    const state = scene.weatherState;

    // A first frame in rain: the ground is as wet as this rain makes it, at once.
    await frame(1 / 60);
    const rain = weather.view!.report(here, t).precipitation;
    expect(rain).toBeGreaterThan(0);
    expect(state.rain.value).toBeGreaterThan(0.3);
    expect(state.wetness.value).toBeCloseTo(wetnessTarget(state.rain.value), 5);
    expect(scene.precipitation).not.toBeNull();
    const particles = scene.precipitation!;

    // Running: the animation clock and the falling rain move.
    const clock = state.clock.value;
    const lattice = particles.latticeOffset('rain').clone();
    await frame(1 / 60);
    expect(state.clock.value).toBeCloseTo(clock + 1 / 60, 5);
    expect(particles.latticeOffset('rain').distanceTo(lattice)).toBeGreaterThan(0.01);

    // Paused: both hold, while frames are still drawn.
    scene.paused = true;
    const heldClock = state.clock.value;
    const held = particles.latticeOffset('rain').clone();
    await frame(1 / 60);
    await frame(1 / 60);
    expect(state.clock.value).toBe(heldClock);
    expect(particles.latticeOffset('rain').distanceTo(held)).toBeLessThan(1e-9);
    scene.paused = false;

    // Another weather without a reset dries slowly; with a reset the ground is dry at once.
    weather.preset = 'clear';
    await frame(1 / 60);
    expect(state.rain.value).toBe(0);
    expect(state.wetness.value).toBeGreaterThan(0.5);
    scene.resetAtmosphere();
    await frame(1 / 60);
    expect(state.wetness.value).toBe(0);

    // The governor's steps through the panel's values, as main.ts applies them.
    weather.preset = 'storm';
    const audio = { volume: 0.8, muted: false };
    const settings = readAtmosphere(scene, audio, 'storm');
    expect(settings.quality).toBe('medium');
    expect(settings.post).toBe(true);
    expect(applyAtmosphere(settings, scene, audio, 2)).toBe(true);
    expect(scene.volumetrics.quality).toBe('low');
    expect(scene.pipeline!.volumetricScale).toBe(VOLUMETRIC_QUALITY.low.scale);
    expect(particles.density).toBe(0.5 * settings.particleDensity);
    await frame(1 / 60);
    await frame(1 / 60);
    expect(scene.volumetrics.stats.clouds).toBe(true);
    expect(applyAtmosphere(settings, scene, audio, 0)).toBe(true);
    expect(scene.volumetrics.quality).toBe('medium');
    await frame(1 / 60);

    // The switch to the map and back: the pipeline's targets are released and come back.
    scene.pipeline!.release();
    scene.resetAtmosphere();
    await frame(1 / 60);
    await frame(1 / 60);
    expect(scene.pipeline).not.toBeNull();
    const rgb = await head.readRgb();
    let lit = 0;
    for (let i = 0; i < rgb.length; i += 3) if (rgb[i]! + rgb[i + 1]! + rgb[i + 2]! > 12) lit++;
    expect(lit / (rgb.length / 3)).toBeGreaterThan(0.5);

    // Everything off, as the panel can set it: still a frame.
    Object.assign(settings, {
      post: false,
      particles: false,
      lightning: false,
      shadows: false,
      volumetricClouds: false,
      volumetricAir: false,
    });
    applyAtmosphere(settings, scene, audio, 0);
    await frame(1 / 60);
    expect(gpu!.errors.slice(errors)).toEqual([]);
    scene.dispose();
    head.dispose();
  }, 600_000);
});
