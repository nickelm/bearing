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
 * SHOTS (comma list of runway,rotation,climb,approach,touchdown), TOD (hours, 17).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  defaultCampaignStart,
  seasonPhase,
  sunDirection,
  withLocalTime,
} from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import { DAY, DEG, HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { AirfieldGround, runwaysOf } from '../src/freeflight/ground';
import { buildHudFrame, landingAid } from '../src/freeflight/hudFrame';
import { modelSpec } from '../src/render/common/models/library';
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
import { FLIGHT_STEP, FlightModel } from '../src/sim/flight/flightModel';
import { parseFlightSpec } from '../src/sim/flight/flightSpec';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import { fromRunway, runwayEnds, runwayFrame } from '../src/sim/flight/runway';
import type { Runway } from '../src/sim/flight/runway';
import { spawnOnRunway } from '../src/sim/flight/spawn';
import { TestPilot } from '../src/sim/flight/testPilot';
import { touchdownLines } from '../src/ui/flight/flightCards';
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
  const head = await headlessRenderer(gpu.device, width, height);
  const scene = new GlobeScene(head.renderer, { radius: R, grid: new CubeGrid(256), input: false });
  scene.resize(width, height);
  scene.globe.setWorld(world);
  scene.climate.setWorld(world);
  scene.climate.setValleyFloor(global.finish.display.valleyFloor ?? null, world.maps.height);
  scene.terrain.buildBudgetMs = 10_000;
  scene.terrain.budgetMiB = 600;
  const rivers = new RiverIndex(global.finish.rivers, { height: global.height, radius: R });
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
  const grading = airfieldGrading(infra, global.height, global.n);
  scene.terrain.setWorld({
    synth,
    seed: params.seed,
    radius: R,
    reliefScale: params.reliefScale,
    rivers,
    infra,
    grading,
  });
  scene.setInfrastructure(infra);
  scene.structures.enabled = true;
  scene.terrainReady = true;

  // Runways and the ground, as the app builds them.
  const sampler = globalMapSampler(global.height, global.n);
  const runways = runwaysOf(campaign.infrastructure, airfieldPads(infra, sampler));
  const ground = new AirfieldGround(
    runways,
    grading,
    (d) => grading.apply(d, sampler(d)),
    R,
    (d) => scene.terrain.displaySurfaceAt(d),
  );
  const clear = (r: Runway) => {
    const f = runwayFrame(r);
    for (let a = -20_000; a <= 20_000; a += 2000)
      for (let c = -20_000; c <= 20_000; c += 2000)
        if (
          Math.max(0, grading.apply(fromRunway(f, a, c, R), sampler(fromRunway(f, a, c, R)))) >
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
    `Base ${runway.id}: ${runway.name}, runway ${end.designator}, elevation ${runway.elevation.toFixed(0)} m`,
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
  };
  scene.beforeDraw = (eye) => view.update(pose, eye);
  scene.cameraMode = 'chase';

  const main = new Vec3d(...world.info.mainContinent);
  const calendar = defaultCampaignStart(main, params);
  const lon = Math.atan2(runway.center.x, runway.center.z);
  let gameTime = withLocalTime(DAY, lon, Number(env('TOD', '17')) * HOUR, params, calendar);
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const messages: string[][] = [];

  for (const shot of SHOTS) {
    // Fly to the shot's moment.
    for (let i = 0; i < 1200 / FLIGHT_STEP; i++) {
      const h = pilot.coords(m).h;
      if (shot.when(pilot, m, h) || m.crashed) break;
      pilot.fly(m, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
      gameTime += FLIGHT_STEP;
      for (const e of monitor.update(m, FLIGHT_STEP)) {
        if (e.kind === 'liftoff') messages.push(['AIRBORNE']);
        if (e.kind === 'touchdown')
          messages.push([
            `TOUCHDOWN: ${e.touchdown.grade.toUpperCase()}`,
            ...touchdownLines(e.touchdown),
          ]);
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
    scene.clouds.enabled.value = 0;
    const ch = scene.chase.target;
    ch.pos.copy(m.pos);
    m.bodyAxis(0, ch.forward);
    m.bodyAxis(2, ch.up).scale(-1);
    ch.velocity.copy(m.vel);
    ch.onGround = m.onGround;
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
    scene.render(1 / 60);
    const rgb = await head.readRgb();
    const file = join(outDir, `freeflight-${shot.name}.png`);
    writeFileSync(file, encodePng(width, height, rgb));
    const frame = buildHudFrame(m, ctl, {
      aid: landingAid(m, runways, scene.chase.eye),
      mode: 'autopilot',
      aim: null,
      timing: null,
    });
    writeFileSync(
      join(outDir, `freeflight-${shot.name}.json`),
      JSON.stringify({
        width,
        height,
        frame,
        messages: messages.slice(-2),
        view: Array.from(scene.camera.matrixWorldInverse.elements),
        projection: Array.from(scene.camera.projectionMatrix.elements),
      }),
    );
    console.log(
      `${shot.name}: ${(t.cas / 0.514444).toFixed(0)} KIAS, ${pilot.coords(m).h.toFixed(0)} m, pitch ${(t.pitch / DEG).toFixed(1)}°, ${scene.terrain.stats.drawn} tiles, ${((performance.now() - t0) / 1000).toFixed(0)} s → ${file}`,
    );
  }
  if (gpu.errors.length) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  view.dispose();
  scene.dispose();
  synth.dispose();
  global.grid.dispose();
  head.dispose();
});
