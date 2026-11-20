/**
 * Followed campaign flights without a browser (R2.4, decision 252): plans an analytic
 * route for each asked type from one of its side's airbases (as the ATO would, without
 * the war), poses the flight at a moment of the route and renders the simulation view's
 * chase camera behind the lead on Dawn, as tools/freeflight.preview.ts renders Free
 * Flight: the lead in its full view, the wingmen instanced (TrafficLayer), both lifted
 * over the drawn ground as follow/ does. Each shot also writes the read-only HUD's frame
 * and the camera's matrices, so tools/freeflight.screens.mjs draws the HUD over it
 * (SHOTS=follow-<type>-<mission>).
 *
 *   npx vitest run --config vitest.tools.config.ts tools/follow.preview.ts
 *
 * Env: SEED (1983), GRES (1024), W, H, FLIGHTS (comma list of type:mission[:phase], default
 * f21:cap:ingress,vo35:cas:on-target,c150:airlift:ingress,f25:cap:ingress), TOD (hours, 11),
 * WEATHER (a preset, default fair), POST=0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { defaultCampaignStart, sunDirection, seasonPhase } from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import type { Dir } from '../src/core/greatCircle';
import { DEG } from '../src/core/units';
import { Quatd } from '../src/core/quat';
import { Vec3d } from '../src/core/vec3d';
import { flightStartTime } from '../src/freeflight/clock';
import { FlightWeather } from '../src/freeflight/flightWeather';
import { runwaysOf } from '../src/freeflight/ground';
import { drawnType, spinningRotors } from '../src/follow/campaignTraffic';
import {
  drawnAltitude,
  flightPoses,
  followedLook,
  followHudFrame,
  gearDown,
  liftedPose,
} from '../src/follow/followFlight';
import { AircraftView } from '../src/render/sim/aircraft/aircraftView';
import { TrafficLayer } from '../src/render/sim/aircraft/trafficLayer';
import { FAST_JET_RIG, rigFromBundle } from '../src/render/sim/camera/chaseCamera';
import { GlobeScene } from '../src/render/sim/globeScene';
import {
  AIRFIELD_FOOTPRINT,
  airfieldGrading,
  airfieldPads,
  globalMapSampler,
  globalMaskSampler,
} from '../src/render/sim/infra/airfieldGrading';
import { InfraScene } from '../src/render/sim/infra/infraScene';
import type { AnalyticPose } from '../src/sim/air/analyticPose';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../src/sim/air/bundles';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import type { Mission, MissionPhase, MissionType } from '../src/sim/air/mission';
import { planMissionRoute } from '../src/sim/air/missionRoute';
import { routeState } from '../src/sim/air/route';
import { WEATHER_PRESETS } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { buildWeatherClimate, meanGround } from '../src/sim/weather/climate';
import { WeatherGrid } from '../src/sim/weather/grid';
import { applyAtmosphere, readAtmosphere } from '../src/ui/atmosphereSettings';
import { DEFAULT_OPTIONS } from '../src/ui/flight/freeFlightMenu';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { siteAirfields } from '../src/worldgen/edits';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';
import { previewWorld } from './previewWorld';

const env = (k: string, d: string) => process.env[k] ?? d;

/** A point `km` from `p` along heading `h` (rad). */
function offset(p: Readonly<Dir>, h: number, km: number, R: number): Dir {
  const up = new Vec3d(...p).normalize();
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const a = (km * 1000) / R;
  const t = north.scale(Math.cos(h)).addScaled(east, Math.sin(h));
  const q = up.scale(Math.cos(a)).addScaled(t, Math.sin(a));
  return [q.x, q.y, q.z];
}

it('renders followed flights', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const seed = env('SEED', '1983');
  const gres = Number(env('GRES', '1024'));
  const width = Number(env('W', '1280'));
  const height = Number(env('H', '720'));
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const R = params.radius;
  const { world, global } = await previewWorld(gpu, params, 256, gres);
  const sited = siteAirfields(
    campaign.infrastructure,
    R,
    AIRFIELD_FOOTPRINT,
    globalMapSampler(global.height, global.n),
    globalMaskSampler(global.finish.drainage.lakeDepth, global.n),
  ).infrastructure;
  const infra = new InfraScene(campaign.graph, sited, R);
  const head = await headlessRenderer(gpu.device, width, height, 0);
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
    lithology: global.finish.lithology,
    basinCell: global.finish.drainage.basinCell,
    basinLevel: global.finish.drainage.basinLevel,
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
  scene.shadows.setHeights(global.height, global.n);
  scene.lightning.seed = String(campaign.seed);
  const climate = buildWeatherClimate(
    { ...world.maps, resolution: world.info.resolution, reliefScale: world.info.reliefScale },
    new WeatherGrid(),
    R,
  );
  scene.weather.setGround(meanGround(new WeatherGrid(), globalMapSampler(global.height, global.n)));
  if (process.env.POST === '0') scene.postEnabled = false;
  applyAtmosphere(
    readAtmosphere(scene, { volume: 0, muted: true }, DEFAULT_OPTIONS.weather),
    scene,
    { volume: 0, muted: true },
    0,
  );
  const sampler = globalMapSampler(global.height, global.n);
  const runways = runwaysOf(sited, airfieldPads(infra, sampler));
  const main = new Vec3d(...world.info.mainContinent);
  const calendar = defaultCampaignStart(main, params);
  scene.planetOrbit = params;
  scene.calendar = calendar;
  const preset = env('WEATHER', DEFAULT_OPTIONS.weather) as WeatherPreset;
  if (!WEATHER_PRESETS.includes(preset)) throw new RangeError(`WEATHER: ${preset}`);
  const weather = new FlightWeather(scene.weather, preset);
  weather.setWorld({ seed: String(campaign.seed), radius: R, orbit: params, calendar, climate });
  scene.cameraMode = 'chase';
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  const layer = new TrafficLayer(scene.lighting);
  scene.vehicles.add(layer.group);
  const flights = env(
    'FLIGHTS',
    'f21:cap:ingress,vo35:cas:on-target,c150:airlift:ingress,f25:cap:ingress',
  ).split(',');
  for (const f of flights) {
    const [typeId, missionType, phaseName] = f.split(':') as [string, MissionType, string?];
    const b = bundleOfType(typeId);
    const type = b.airWar!;
    const base = runways.find((r, i) => r.side === type.side && sited.airbases[i]!.kind === 'main');
    if (!base) throw new Error(`no ${type.side} main base`);
    const bp = base.center.clone().normalize();
    const basePoint: Dir = [bp.x, bp.y, bp.z];
    const route = planMissionRoute({
      type,
      loadout: type.loadouts[0]!,
      profile: MISSION_PROFILES[missionType],
      radius: R,
      rangeFactor: 1,
      basePoint: () => basePoint,
      carrierBased: false,
      target: offset(basePoint, 60 * DEG, 150, R),
      launch: 0,
    });
    if (!route) throw new Error(`no route for ${f}`);
    const phase = (phaseName ?? 'ingress') as MissionPhase;
    const segs = route.segments.filter((s) => s.phase === phase);
    if (segs.length === 0) throw new Error(`${f}: the route has no ${phase}`);
    const t = (segs[0]!.t0 + segs[segs.length - 1]!.t1) / 2;
    const mission = { aircraft: type.flightSize, route } as unknown as Mission;
    const look = followedLook(b, AIRCRAFT_BUNDLES);
    const drawn = drawnType(typeId);
    const rig = look.rig
      ? look.rig.kind === 'helicopter'
        ? rigFromBundle(look.rig, drawn.spec.rotors?.[0]?.radius ?? 7)
        : rigFromBundle(look.rig)
      : FAST_JET_RIG;
    scene.chase.rig = rig;
    scene.chase.zoom = 1;
    scene.chase.resetView();
    const view = new AircraftView(drawn.spec, [0, 0, 0], scene.lighting);
    view.planetRadius = R;
    scene.vehicles.add(view.group, view.shadowMesh);
    // The game time: the route's moment, on a day whose local time there is TOD.
    const lon = Math.atan2(basePoint[0], basePoint[2]);
    const gameTime = flightStartTime(lon, Number(env('TOD', '11')), params, calendar) + t;
    sunDirection(gameTime, params, calendar, scene.sun);
    scene.terrain.land.seasonPhase.value = seasonPhase(gameTime, params, calendar);
    scene.gameTime = gameTime;
    scene.clouds.time.value = gameTime;
    weather.finish(gameTime);
    scene.weatherView = weather.finish(gameTime);
    scene.resetAtmosphere();
    const groundAt = (p: AnalyticPose) =>
      scene.terrain.displaySurfaceAt(new Vec3d(...p.pos).normalize(), false);
    let poses: AnalyticPose[] = [];
    const pose = () => {
      poses = flightPoses(mission, t, R).map((p) =>
        liftedPose(p, drawnAltitude(p, groundAt(p), drawn.gearHeight)),
      );
      const p = poses[0]!;
      const c = scene.chase.target;
      c.pos.set(...p.pos);
      c.forward.set(...p.forward);
      c.up.set(...p.up);
      c.velocity.set(...p.velocity);
      c.onGround = !p.airborne;
    };
    scene.beforeDraw = (eye) => {
      const p = poses[0]!;
      const fwd = new Vec3d(...p.forward);
      const up = new Vec3d(...p.up);
      const right = fwd.clone().cross(up).normalize();
      const ground = Math.max(0, groundAt(p) ?? 0);
      const gear = gearDown(p, p.altitude - ground) ? 1 : 0;
      view.sun.copy(scene.sun);
      view.radPerPixel = (rig.fov / DEG / 50) * ((50 * DEG) / height);
      view.update(
        {
          pos: new Vec3d(...p.pos),
          q: Quatd.fromAxes(fwd, right, up.clone().scale(-1)),
          elevator: 0,
          aileron: 0,
          rudder: 0,
          gear,
          speedbrake: 0,
          afterburner: 0,
          flaps: gear,
          groundHeight: ground,
          rotors: spinningRotors(drawn.spec, 1234),
        },
        eye,
      );
      layer.update(
        poses.slice(1).map((w) => ({
          spec: drawn.spec,
          scheme: drawn.scheme,
          gearDown: gear === 1,
          pos: w.pos,
          forward: w.forward,
          up: w.up,
        })),
        eye,
      );
    };
    pose();
    scene.chase.reset();
    let stable = 0;
    let last = '';
    const t0 = performance.now();
    for (let k = 0; k < 300 && stable < 3; k++) {
      pose();
      scene.render(1 / 60);
      await gpu.finish();
      await new Promise((r) => setTimeout(r, 2));
      const s = scene.terrain.stats;
      const sig = `${s.drawn}/${s.deepest}/${s.meshes}`;
      stable = s.pending === 0 && sig === last ? stable + 1 : 0;
      last = sig;
    }
    for (let k = 0; k < 30; k++) {
      pose();
      scene.render(1 / 60);
    }
    const rgb = await head.readRgb();
    const name = `follow-${typeId}-${missionType}`;
    writeFileSync(join(outDir, `freeflight-${name}.png`), encodePng(width, height, rgb));
    const p = poses[0]!;
    const ground = Math.max(0, groundAt(p) ?? 0);
    const frame = followHudFrame({
      pose: p,
      fuel: routeState(route, t, R).fuel,
      radarAltitude: p.altitude - ground,
      gear: gearDown(p, p.altitude - ground) ? 1 : 0,
      gearDown: gearDown(p, p.altitude - ground),
      afterburner: 0,
    });
    writeFileSync(
      join(outDir, `freeflight-${name}.json`),
      JSON.stringify({
        width,
        height,
        frame,
        messages: [],
        view: Array.from(scene.camera.matrixWorldInverse.elements),
        projection: Array.from(scene.camera.projectionMatrix.elements),
      }),
    );
    const eyeH = scene.chase.height;
    const to = scene.chase.target.pos.clone().sub(scene.chase.eye);
    const off = Math.acos(to.dot(scene.chase.forward) / to.length()) / DEG;
    console.log(
      `${name}: ${look.standIn ? `stand-in ${look.drawn}` : look.drawn}, ${p.phase}, ` +
        `${p.altitude.toFixed(0)} m (${(p.altitude - ground).toFixed(0)} m over the ground), bank ` +
        `${(p.bank / DEG).toFixed(0)}°, camera ${to.length().toFixed(0)} m back, ${eyeH.toFixed(0)} m up, ` +
        `${off.toFixed(1)}° off axis, wingmen ${layer.stats.aircraft} in ${layer.stats.draws} draws, ` +
        `${((performance.now() - t0) / 1000).toFixed(0)} s`,
    );
    scene.vehicles.remove(view.group, view.shadowMesh);
    view.dispose();
  }
  if (gpu.errors.length) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  layer.dispose();
  scene.dispose();
  synth.dispose();
  global.grid.dispose();
  head.dispose();
});
