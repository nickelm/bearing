/**
 * Free Flight screenshots without a browser (decision 134): flies the scripted
 * test pilot from an airbase of a generated world and renders the simulation
 * view's chase camera, with the animated F-21 and its shadow, at five moments
 * (on the runway, at rotation, in the climb, on approach, after touchdown) on
 * Dawn, as tools/render.preview.ts does. Each shot also writes the HUD's frame
 * and the camera's matrices as JSON, so tools/freeflight.screens.mjs can draw
 * the real Canvas HUD over the render in Chromium.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/freeflight.preview.ts
 *
 * Env: SEED (default 1), GRES (global grid, default 1024), W, H, BASE (airbase id),
 * SHOTS (comma list of runway,rotation,climb,approach,touchdown), TOD (hours, 17),
 * WEATHER (a preset of sim/weather/presets.ts, default fair: the app's default), WIND=0
 * (still air for the aircraft), QUALITY (low, medium, high: the volumetric quality),
 * GOVERNOR (0..2: the performance governor's step, as ui/atmosphereSettings.ts applies it),
 * POST=0 (draw without the pipeline), SETTLE (seconds the scene runs on before each shot, at
 * ten frames a second: a shot is otherwise the first second after a camera cut), MSAA=4 (four samples per pixel, as the app draws; the
 * default is one), OUT (a suffix for the files' names, e.g. OUT=-storm
 * writes freeflight-runway-storm.png and .json, which freeflight.screens.mjs takes as the
 * shot "runway-storm").
 *
 * The weather, the flight's start time, the wind on the aircraft and the atmosphere's
 * settings go through the modules the app uses (freeflight/flightWeather.ts, clock.ts,
 * sim/flight/wind.ts, ui/atmosphereSettings.ts), so a shot is what Free Flight shows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { defaultCampaignStart, seasonPhase, sunDirection } from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import { moonAge } from '../src/core/moon';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { flightStartTime, freeFlightDay } from '../src/freeflight/clock';
import { FlightWeather } from '../src/freeflight/flightWeather';
import { AirfieldGround, runwaysOf } from '../src/freeflight/ground';
import { buildHudFrame, landingAid } from '../src/freeflight/hudFrame';
import { modelSpec } from '../src/render/common/models/library';
import { helicopterRig } from '../src/render/sim/camera/chaseCamera';
import { RotorcraftModel } from '../src/sim/flight/rotor/rotorcraftModel';
import { parseRotorcraftSpec } from '../src/sim/flight/rotor/rotorSpec';
import { AircraftView } from '../src/render/sim/aircraft/aircraftView';
import type { AircraftPose } from '../src/render/sim/aircraft/aircraftView';
import { GlobeScene } from '../src/render/sim/globeScene';
import {
  airfieldGrading,
  airfieldPads,
  globalMapSampler,
} from '../src/render/sim/infra/airfieldGrading';
import { InfraScene } from '../src/render/sim/infra/infraScene';
import { neutralControls } from '../src/sim/flight/controlLaws';
import { followAirframe } from '../src/render/sim/camera/chaseCamera';
import { FLIGHT_STEP, FlightModel } from '../src/sim/flight/flightModel';
import { parseFlightSpec } from '../src/sim/flight/flightSpec';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import { fromRunway, runwayEnds, runwayFrame } from '../src/sim/flight/runway';
import type { Runway } from '../src/sim/flight/runway';
import { spawnOnRunway } from '../src/sim/flight/spawn';
import { TestPilot } from '../src/sim/flight/testPilot';
import { airVelocity } from '../src/sim/flight/wind';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { WeatherGrid } from '../src/sim/weather/grid';
import { WEATHER_PRESETS } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { applyAtmosphere, governorStatus, readAtmosphere } from '../src/ui/atmosphereSettings';
import { touchdownLines } from '../src/ui/flight/flightCards';
import { DEFAULT_OPTIONS } from '../src/ui/flight/freeFlightMenu';
import { weatherLine } from '../src/ui/weatherLine';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';
import { previewWorld } from './previewWorld';

const env = (k: string, d: string) => process.env[k] ?? d;

interface Shot {
  name: string;
  /** Stop advancing when this holds. */
  when: (pilot: TestPilot, m: FlightModel, h: number) => boolean;
}

const SHOTS: Shot[] = [
  { name: 'runway', when: (p) => p.phase === 'takeoff' },
  { name: 'rotation', when: (p, m) => p.phase === 'rotate' && m.telemetry.pitch > 6 * DEG },
  { name: 'climb', when: (p, _m, h) => p.phase === 'climb' && h > 250 },
  { name: 'approach', when: (p, _m, h) => p.phase === 'final' && h < 200 },
  { name: 'touchdown', when: (p, m) => p.phase === 'rollout' && m.telemetry.groundSpeed < 55 },
];

it('renders Free Flight shots', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const seed = env('SEED', '1');
  const gres = Number(env('GRES', '1024'));
  const width = Number(env('W', '1280'));
  const height = Number(env('H', '720'));
  const wanted = env('SHOTS', '').split(',').filter(Boolean);
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const R = params.radius;
  const { world, global } = await previewWorld(gpu, params, 256, gres);
  const infra = new InfraScene(campaign.graph, campaign.infrastructure, R);
  // The app antialiases with four samples (`antialias: true`); the previews draw one unless asked.
  const head = await headlessRenderer(gpu.device, width, height, Number(env('MSAA', '0')));
  const scene = new GlobeScene(head.renderer, { radius: R, grid: new CubeGrid(256), input: false });
  scene.resize(width, height);
  scene.globe.setWorld(world);
  scene.climate.setWorld(world);
  scene.climate.setValleyFloor(global.finish.display.valleyFloor ?? null, world.maps.height);
  scene.terrain.buildBudgetMs = 10_000;
  scene.terrain.budgetMiB = 600;
  const rivers = new RiverIndex(global.finish.rivers, {
    height: global.height,
    radius: R,
    lakeDepth: global.finish.drainage.lakeDepth,
    channels: global.finish.channels,
  });
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: R,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index: rivers,
  });
  const edits = airfieldGrading(infra, global.height, global.n, rivers);
  scene.terrain.setWorld({
    synth,
    seed: params.seed,
    radius: R,
    reliefScale: params.reliefScale,
    rivers,
    infra,
    edits,
  });
  scene.setInfrastructure(infra);
  scene.structures.enabled = true;
  scene.terrainReady = true;
  // As main.ts wires a world: mountain shadows, the lightning's seed, the ground under the weather.
  scene.shadows.setHeights(global.height, global.n);
  scene.lightning.seed = String(campaign.seed);
  const climate = buildWeatherClimate(
    { ...world.maps, resolution: world.info.resolution, reliefScale: world.info.reliefScale },
    new WeatherGrid(),
    R,
  );
  scene.weather.setGround(climate.ground.slice());
  if (process.env.POST === '0') scene.postEnabled = false;
  // The atmosphere's settings as the app applies them, with the governor's step if asked for.
  const settings = readAtmosphere(scene, { volume: 0, muted: true }, DEFAULT_OPTIONS.weather);
  if (process.env.QUALITY) {
    settings.quality = process.env.QUALITY as typeof settings.quality;
    settings.autoQuality = process.env.GOVERNOR !== undefined;
  }
  const governorLevel = Number(env('GOVERNOR', '0'));
  applyAtmosphere(settings, scene, { volume: 0, muted: true }, governorLevel);
  console.log(
    `Atmosphere: ${governorStatus(settings, governorLevel)}, volumetrics ${scene.volumetrics.quality}, ` +
      `particles ×${scene.precipitation?.density ?? 0}, post ${scene.postEnabled && scene.pipeline ? 'on' : 'off'}`,
  );

  // Runways and the ground, as the app builds them.
  const sampler = globalMapSampler(global.height, global.n);
  const runways = runwaysOf(campaign.infrastructure, airfieldPads(infra, sampler));
  const ground = new AirfieldGround(
    runways,
    edits,
    (d) => edits.apply(d, sampler(d)),
    R,
    (d) => scene.terrain.displaySurfaceAt(d),
  );
  const clear = (r: Runway) => {
    const f = runwayFrame(r);
    for (let a = -20_000; a <= 20_000; a += 2000)
      for (let c = -20_000; c <= 20_000; c += 2000)
        if (
          Math.max(0, edits.apply(fromRunway(f, a, c, R), sampler(fromRunway(f, a, c, R)))) >
          r.elevation + 500
        )
          return false;
    return true;
  };
  const baseEnv = process.env.BASE;
  const runway =
    (baseEnv !== undefined ? runways.find((r) => r.id === Number(baseEnv)) : undefined) ??
    runways.find(
      (r, i) =>
        campaign.infrastructure.airbases[i]!.kind === 'main' && r.side === 'alliance' && clear(r),
    ) ??
    runways[0]!;
  const end = runwayEnds(runway)[0];
  console.log(
    `Base ${runway.id}: ${runway.name}, runway ${end.designator}, elevation ${runway.elevation.toFixed(0)} m, ` +
      `latitude ${(Math.asin(runway.center.clone().normalize().y) / DEG).toFixed(1)}°, ` +
      `longitude ${(Math.atan2(runway.center.x, runway.center.z) / DEG).toFixed(1)}°`,
  );

  const spec = modelSpec('alliance-fighter');
  const fs = parseFlightSpec(spec.flight, spec.id);
  const m = new FlightModel(fs, R);
  spawnOnRunway(m, runway, end);
  const ctl = neutralControls();
  const pilot = new TestPilot(runway, end, R);
  const monitor = new FlightMonitor(runways, R);
  const view = new AircraftView(spec, fs.cg, scene.lighting);
  view.planetRadius = R;
  scene.vehicles.add(view.group, view.shadowMesh);
  const pose: AircraftPose = {
    pos: m.pos,
    q: m.q,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    gear: 1,
    speedbrake: 0,
    afterburner: 0,
    flaps: 1,
    groundHeight: 0,
    ground: (d) => ground.height(d),
  };
  scene.beforeDraw = (eye) => view.update(pose, eye);
  scene.cameraMode = 'chase';

  const main = new Vec3d(...world.info.mainContinent);
  const calendar = defaultCampaignStart(main, params);
  const lon = Math.atan2(runway.center.x, runway.center.z);
  // The flight's start as the app sets it: the chosen local time on Free Flight's day.
  let gameTime = flightStartTime(lon, Number(env('TOD', '17')), params, calendar);
  scene.planetOrbit = params;
  scene.calendar = calendar;
  // The weather: the world's model on this thread, shown as the preset (flightWeather.ts).
  const preset = env('WEATHER', DEFAULT_OPTIONS.weather) as WeatherPreset;
  if (!WEATHER_PRESETS.includes(preset)) {
    throw new RangeError(`WEATHER must be one of ${WEATHER_PRESETS.join(', ')}`);
  }
  const weather = new FlightWeather(scene.weather, preset);
  weather.setWorld({
    seed: String(campaign.seed),
    radius: R,
    orbit: params,
    calendar,
    climate,
  });
  weather.finish(gameTime);
  const temperatureShift = weather.temperatureShift(runway.center, gameTime);
  scene.terrain.land.temperatureOffset.value = temperatureShift;
  const windOn = process.env.WIND !== '0';
  // The sun's elevation through Free Flight's day at this base, to choose TOD by.
  {
    const up = runway.center.clone().normalize();
    const sun = new Vec3d();
    const row: string[] = [];
    for (let h = 0; h < 24; h += 1.5) {
      sunDirection(flightStartTime(lon, h, params, calendar), params, calendar, sun);
      row.push(`${h}h ${(Math.asin(sun.dot(up)) / DEG).toFixed(0)}°`);
    }
    console.log(`Sun by local time: ${row.join(', ')}`);
  }
  console.log(
    `Day ${freeFlightDay(params, calendar)} (moon ${moonAge(gameTime, params, calendar).toFixed(1)} days old), ` +
      `weather ${preset}: ${weatherLine(weather.view, runway.center, gameTime)}; ` +
      `land temperature shift ${temperatureShift.toFixed(1)} °C`,
  );
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const messages: { t: number; lines: string[] }[] = [];

  // Helicopters (HELO=scout|utility): hovering beside the runway's middle, or over the
  // steepest nearby slope (SLOPE=1), at each of HELO_HEIGHTS (m over the ground), rotor
  // turning, framed by the helicopter rig: the shadow on the ground (decision 170).
  const heloKind = process.env.HELO;
  if (heloKind) {
    const id = heloKind === 'utility' ? 'alliance-utility-helo' : 'alliance-scout-helo';
    const hs = modelSpec(id);
    const hf = parseRotorcraftSpec(hs.flight, id);
    const h = new RotorcraftModel(hf, R);
    const hview = new AircraftView(hs, hf.cg, scene.lighting);
    hview.planetRadius = R;
    view.group.visible = false;
    view.shadowMesh.visible = false;
    scene.vehicles.add(hview.group, hview.shadowMesh);
    const f = runwayFrame(runway);
    let spot = fromRunway(f, 0, 75, R);
    if (process.env.SLOPE === '1') {
      // The steepest ground under 30° within SLOPE_KM (15) of the runway, from the graded
      // global heights over 200 m.
      let best = -1;
      const reach = Number(env('SLOPE_KM', '15')) * 1000;
      for (let a = -reach; a <= reach; a += 250)
        for (let c = -reach; c <= reach; c += 250) {
          const d = fromRunway(f, a, c, R);
          const hh = (x: number, y: number) => Math.max(0, edits.apply(fromRunway(f, x, y, R), sampler(fromRunway(f, x, y, R))));
          if (hh(a, c) <= 1) continue;
          const g = Math.hypot(hh(a + 100, c) - hh(a - 100, c), hh(a, c + 100) - hh(a, c - 100)) / 200;
          if (g < Math.tan(30 * DEG) && g > best) {
            best = g;
            spot = d;
          }
        }
      console.log(`Slope spot: ${(Math.atan(best) / DEG).toFixed(1)}° over 200 m`);
    }
    const hpose: AircraftPose = { ...pose, pos: h.pos, q: h.q, flaps: 0 };
    scene.beforeDraw = (eye) => hview.update(hpose, eye);
    scene.chase.rig = helicopterRig(hf.main.radius);
    for (const hover of env('HELO_HEIGHTS', '3,15').split(',').map(Number)) {
      const gh = ground.height(spot);
      // The sun on the right (SUN_SIDE=tail: behind), so the shadow falls beside the
      // helicopter, in the picture.
      sunDirection(gameTime, params, calendar, scene.sun);
      const north = new Vec3d(0, 1, 0).addScaled(spot, -spot.y).normalize();
      const east = north.clone().cross(spot);
      const away =
        Math.atan2(scene.sun.dot(east), scene.sun.dot(north)) +
        (process.env.SUN_SIDE === 'tail' ? Math.PI : -Math.PI / 2);
      h.place(spot.clone().scale(R + gh + h.gearHeight + hover), new Vec3d(), away, hf.main.shaftTilt);
      h.updateAttitude(ground);
      hpose.groundHeight = gh;
      hpose.rotors = [
        { azimuth: 0.4, speed: 1, tiltForward: 0, tiltRight: 0 },
        { azimuth: 0.2, speed: 1, tiltForward: 0, tiltRight: 0 },
      ];
      sunDirection(gameTime, params, calendar, scene.sun);
      hview.sun.copy(scene.sun);
      scene.terrain.land.seasonPhase.value = seasonPhase(gameTime, params, calendar);
      scene.gameTime = gameTime;
      scene.clouds.time.value = gameTime;
      scene.weatherView = weather.finish(gameTime);
      scene.resetAtmosphere();
      followAirframe(scene.chase.target, h);
      scene.chase.reset();
      hview.radPerPixel = (60 * DEG) / height;
      let stable = 0;
      let last = '';
      for (let fr = 0; fr < 300 && stable < 3; fr++) {
        scene.render(1 / 60);
        await gpu.finish();
        await new Promise((r) => setTimeout(r, 2));
        const st = scene.terrain.stats;
        const sig = `${st.drawn}/${st.deepest}/${st.meshes}`;
        stable = st.pending === 0 && scene.structures.stats.pending === 0 && sig === last ? stable + 1 : 0;
        last = sig;
      }
      // The drawn ground has loaded now: measure the hover height from it, not from the
      // coarse global heights the first query fell back to.
      const drawn = ground.height(spot);
      if (Math.abs(drawn - gh) > 0.01) {
        h.place(spot.clone().scale(R + drawn + h.gearHeight + hover), new Vec3d(), away, hf.main.shaftTilt);
        h.updateAttitude(ground);
        hpose.groundHeight = drawn;
        followAirframe(scene.chase.target, h);
        scene.chase.reset();
      }
      for (let fr = 0; fr < 30; fr++) scene.render(1 / 60);
      const rgb = await head.readRgb();
      const name = `helo-${heloKind}-${hover}m${process.env.SLOPE === '1' ? '-slope' : ''}`;
      const file = join(outDir, `freeflight-${name}${env('OUT', '')}.png`);
      writeFileSync(file, encodePng(width, height, rgb));
      console.log(
        `${name}: sun ${(scene.lighting.sunElevation / DEG).toFixed(1)}°, ground ${drawn.toFixed(1)} m (first query ${gh.toFixed(1)} m), ` +
          `shadow ${hview.shadowMesh.visible ? 'shown' : 'hidden'} → ${file}`,
      );
    }
    hview.dispose();
  }

  for (const shot of heloKind ? [] : SHOTS) {
    // Fly to the shot's moment, in the weather's wind and gusts as the app's aircraft does.
    for (let i = 0; i < 1200 / FLIGHT_STEP; i++) {
      const h = pilot.coords(m).h;
      if (shot.when(pilot, m, h) || m.crashed) break;
      if (i % 120 === 0) weather.update(gameTime, Infinity);
      pilot.fly(m, ctl, FLIGHT_STEP);
      if (windOn) {
        airVelocity(
          weather.view,
          m.pos,
          R,
          gameTime,
          Math.max(0, m.telemetry.radarAltitude),
          m.wind,
        );
      }
      m.step(ctl, ground);
      gameTime += FLIGHT_STEP;
      for (const e of monitor.update(m, FLIGHT_STEP)) {
        if (e.kind === 'liftoff') messages.push({ t: gameTime, lines: ['AIRBORNE'] });
        if (e.kind === 'touchdown')
          messages.push({
            t: gameTime,
            lines: [
              `TOUCHDOWN: ${e.touchdown.grade.toUpperCase()}`,
              ...touchdownLines(e.touchdown),
            ],
          });
      }
    }
    if (m.crashed) throw new Error(`crashed before ${shot.name}: ${m.crashed}`);
    if (wanted.length && !wanted.includes(shot.name)) continue;
    // Pose, sun, camera.
    const t = m.telemetry;
    pose.elevator = t.laws.elevator;
    pose.aileron = t.laws.aileron;
    pose.rudder = t.laws.rudder;
    pose.gear = m.gear;
    pose.speedbrake = m.speedbrake;
    pose.afterburner = m.afterburner;
    pose.flaps = m.gear;
    pose.groundHeight = ground.height(m.pos.clone().normalize());
    sunDirection(gameTime, params, calendar, scene.sun);
    view.sun.copy(scene.sun);
    scene.terrain.land.seasonPhase.value = seasonPhase(gameTime, params, calendar);
    // The frame's clock and weather, as main.ts sets them; each shot is a camera cut.
    scene.gameTime = gameTime;
    scene.clouds.time.value = gameTime;
    scene.weatherView = weather.finish(gameTime);
    scene.resetAtmosphere();
    followAirframe(scene.chase.target, m);
    scene.chase.reset();
    view.radPerPixel = (50 * DEG) / height;
    let stable = 0;
    let last = '';
    const t0 = performance.now();
    for (let f = 0; f < 300 && stable < 3; f++) {
      scene.render(1 / 60);
      await gpu.finish();
      await new Promise((r) => setTimeout(r, 2));
      const s = scene.terrain.stats;
      const sig = `${s.drawn}/${s.deepest}/${s.meshes}`;
      stable =
        s.pending === 0 && scene.structures.stats.pending === 0 && sig === last ? stable + 1 : 0;
      last = sig;
    }
    // A last few frames for the camera's springs to settle.
    for (let f = 0; f < 30; f++) scene.render(1 / 60);
    // The weather's own clock runs on from the cut: drifting fog and veils take seconds to arrive.
    for (let f = 0; f < Number(env('SETTLE', '0')) * 10; f++) scene.render(0.1);
    scene.render(1 / 60);
    const rgb = await head.readRgb();
    const file = join(outDir, `freeflight-${shot.name}${env('OUT', '')}.png`);
    writeFileSync(file, encodePng(width, height, rgb));
    const frame = buildHudFrame(m, ctl, {
      aid: landingAid(m, runways, scene.chase.eye),
      mode: 'autopilot',
      control: null,
      timing: null,
    });
    writeFileSync(
      join(outDir, `freeflight-${shot.name}${env('OUT', '')}.json`),
      JSON.stringify({
        width,
        height,
        frame,
        // As in the app, messages show for a few seconds.
        messages: messages.filter((x) => x.t > gameTime - 8).map((x) => x.lines),
        view: Array.from(scene.camera.matrixWorldInverse.elements),
        projection: Array.from(scene.camera.projectionMatrix.elements),
      }),
    );
    const state = scene.weatherState;
    const drawn = scene.precipitation?.counts;
    console.log(
      `${shot.name}: ${(t.cas / 0.514444).toFixed(0)} KIAS, ${pilot.coords(m).h.toFixed(0)} m, pitch ${(t.pitch / DEG).toFixed(1)}°, ${scene.terrain.stats.drawn} tiles, ${((performance.now() - t0) / 1000).toFixed(0)} s → ${file}\n` +
        `  sun ${(scene.lighting.sunElevation / DEG).toFixed(1)}°, wind on the aircraft ${m.wind.length().toFixed(1)} m/s, ` +
        `rain ${state.rain.value.toFixed(2)} snow ${state.snow.value.toFixed(2)} dust ${state.dust.value.toFixed(2)} ` +
        `storm ${state.storm.value.toFixed(2)} fog ${(state.fog.value * 1000).toFixed(2)}/km wetness ${state.wetness.value.toFixed(2)}, ` +
        `particles ${drawn ? `${drawn.rain}/${drawn.snow}/${drawn.dust}` : 'none'}, ` +
        `volumetrics clouds ${scene.volumetrics.stats.clouds} air ${scene.volumetrics.stats.air}, ` +
        `shadow strength ${scene.shadows.strength.value.toFixed(2)}, pipeline passes ${scene.pipeline?.stats.passes ?? 0}`,
    );
  }
  if (gpu.errors.length) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  view.dispose();
  scene.dispose();
  synth.dispose();
  global.grid.dispose();
  head.dispose();
});
