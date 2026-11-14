/**
 * Views of the volumetric clouds, fog, dust and rain shafts (decision 141)
 * without a world: the simulation view's sky, the cloud layer and the
 * volumetric source under the app's post-processing pipeline, over a plain lit
 * ground that takes the cloud shadow and the overcast's light. A view takes a
 * few seconds where one of `tools/render.preview.ts` takes a minute, so this
 * is the tool for tuning shapes, density, light and color, and for timing the
 * march by itself; terrain, mountain shadows and precipitation particles need
 * the full preview (`WEATHER=<preset>` there).
 *
 *   npx vitest run --disable-console-intercept --config vitest.tools.config.ts tools/clouds.preview.ts
 *   env: OUT (tools/out), W × H per view (512 × 288), VIEWS a list of the names below (all),
 *        ALT camera height in m, PITCH and TURN in degrees and SUN (the sun's elevation in
 *        degrees) instead of the views' own,
 *        QUALITY low|medium|high (medium), SCALE the volumetric pass's divisor instead of the
 *        quality's, LAT and LON of the camera in degrees (40, 2), HOUR the weather's game hour (30),
 *        CIRRUS amount 0..1, AIR=0 without fog, dust and rain shafts, CLOUDS_3D=0 without clouds, BAKE interior texels per face of the coverage bake (512),
 *        FRAMES=n renders n more frames of each view with the clocks running (FRAME_DT real
 *        seconds each, default 1/30; TIME_RATE game seconds per real second, default 1) and
 *        prints how much each differs from the one before (noise, crawl, motion); STILL=1
 *        holds the clocks so only the march's noise is left,
 *        PERF=n times n interleaved rounds of every view without the volumetrics and with
 *        them at each quality, FLASH=x lights a discharge of that intensity FLASH_KM ahead (4),
 *        FLASH_TURN degrees to the right (0) and FLASH_ALT m above sea level (3500),
 *        VOL=0 draws without the volumetrics (the shell), POST=0 without the pipeline,
 *        FILTER=0 without the pipeline's 3 × 3 filter (the march as it is),
 *        COUNT=1 prints what the marches do per low-resolution pixel of each view (steps of
 *        the cloud march, those shaded, steps of the air march, texture reads): the cost
 *        that does not depend on the machine,
 *        TUNING='{"multiple":0.4}' overrides numbers of the cloud's light (CLOUD_LIGHT),
 *        TUNING_AIR='{"wispLight":0.5}' numbers of the look of fog, dust and rain (AIR_LOOK).
 *
 * Writes `clouds-<view>.png` per view and `clouds-sheet.png` with all of them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  AgXToneMapping,
  BufferAttribute,
  BufferGeometry,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  NodeMaterial,
  PerspectiveCamera,
  QuadMesh,
  RenderTarget,
  Scene,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  float,
  Fn,
  floor,
  fract,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  positionWorld,
  screenUV,
  sin,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { EARTH_ORBIT } from '../src/core/calendar';
import { celestialRotation, moonIlluminatedFraction } from '../src/core/moon';
import { DEG, HOUR, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { CloudLayer } from '../src/render/sim/clouds/cloudLayer';
import {
  AIR_LOOK,
  CLOUD_LIGHT,
  VOLUMETRIC_QUALITY,
  Volumetrics,
} from '../src/render/sim/clouds/volumetrics';
import type { VolumetricQuality } from '../src/render/sim/clouds/volumetrics';
import { WeatherTexture } from '../src/render/sim/clouds/weatherTexture';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import { SimPipeline } from '../src/render/sim/post/simPipeline';
import { WeatherState } from '../src/render/sim/weather/weatherState';
import { Channel, CHANNEL_COUNT, WeatherView, WIND_LEVELS } from '../src/sim/weather/frame';
import type { WeatherFrame } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';
import { presetFrame } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';

type V3 = Node<'vec3'>;

interface CloudView {
  name: string;
  /**
   * A weather preset; or 'dustwall', the dust storm with clear air west of a line 20 km east
   * of the camera; or 'front', the thunderstorm east of that line and fair weather west of it;
   * or 'hazy', fair weather in a haze of 9 km visibility (crepuscular rays).
   */
  weather: Exclude<WeatherPreset, 'live'> | 'dustwall' | 'front' | 'hazy';
  /** Camera height above sea level (m). */
  altitude: number;
  /** Where the camera looks: degrees above the horizon, and clockwise of the key light's azimuth. */
  pitch: number;
  turn: number;
  /** The sun's elevation (degrees). */
  sun: number;
  /** The moon's elevation (degrees); below the horizon if absent. */
  moon?: number;
  /** Vertical field of view (degrees; default 50). */
  fov?: number;
}

const VIEWS: CloudView[] = [
  // Fair-weather cumulus: from the ground at noon, toward the sun and away from it.
  { name: 'fair-below', weather: 'fair', altitude: 30, pitch: 22, turn: 140, sun: 55 },
  { name: 'fair-sunward', weather: 'fair', altitude: 30, pitch: 24, turn: 15, sun: 35 },
  // At cloud level, from the side.
  { name: 'fair-side', weather: 'fair', altitude: 1900, pitch: 2, turn: 100, sun: 40 },
  // Looking down on them from 5 km, and to the horizon from 12 km.
  { name: 'fair-above', weather: 'fair', altitude: 5000, pitch: -24, turn: 120, sun: 45 },
  { name: 'fair-high', weather: 'fair', altitude: 12_000, pitch: -9, turn: 60, sun: 30 },
  // Golden hour and sunset through broken cloud with cirrus.
  { name: 'fair-golden', weather: 'fair', altitude: 30, pitch: 14, turn: 20, sun: 5 },
  { name: 'fair-sunset', weather: 'fair', altitude: 30, pitch: 12, turn: 10, sun: 0.5 },
  { name: 'fair-dusk', weather: 'fair', altitude: 2500, pitch: 4, turn: 25, sun: -3 },
  // Haze under broken cloud, toward a low sun and across it: the shafts between the shadows.
  { name: 'rays', weather: 'hazy', altitude: 30, pitch: 16, turn: 6, sun: 16 },
  { name: 'rays-side', weather: 'hazy', altitude: 800, pitch: 2, turn: 70, sun: 12 },
  // Overcast: from below, and above the deck at sunset.
  { name: 'overcast-below', weather: 'overcast', altitude: 30, pitch: 12, turn: 90, sun: 40 },
  { name: 'overcast-above', weather: 'overcast', altitude: 11_000, pitch: -8, turn: 30, sun: 3 },
  { name: 'overcast-top', weather: 'overcast', altitude: 3200, pitch: -6, turn: 120, sun: 35 },
  // Rain: under the layer.
  { name: 'rain-below', weather: 'rain', altitude: 30, pitch: 8, turn: 90, sun: 40 },
  // Storm: from outside at golden hour, from below, from above.
  { name: 'storm-golden', weather: 'storm', altitude: 6000, pitch: 3, turn: 110, sun: 6 },
  { name: 'storm-below', weather: 'storm', altitude: 30, pitch: 14, turn: 90, sun: 40 },
  { name: 'storm-above', weather: 'storm', altitude: 14_000, pitch: -10, turn: 70, sun: 25 },
  // Under the storm at dusk and at night, and a night of drizzle: what a flash lights (FLASH).
  { name: 'storm-dusk', weather: 'storm', altitude: 30, pitch: 10, turn: 60, sun: -2 },
  { name: 'storm-night', weather: 'storm', altitude: 30, pitch: 10, turn: 60, sun: -30, moon: 30 },
  {
    name: 'drizzle-night',
    weather: 'drizzle',
    altitude: 30,
    pitch: 10,
    turn: 60,
    sun: -30,
    moon: 30,
  },
  // A storm front from the fair side: towers and rain shafts, at golden hour and at noon.
  { name: 'front-golden', weather: 'front', altitude: 2500, pitch: 5, turn: 180, sun: 7 },
  { name: 'front-noon', weather: 'front', altitude: 300, pitch: 9, turn: 150, sun: 50 },
  { name: 'front-side', weather: 'front', altitude: 7000, pitch: 0, turn: 120, sun: 20 },
  // Fog: at dawn from the ground and seen from above.
  { name: 'fog-dawn', weather: 'fog', altitude: 30, pitch: 4, turn: 12, sun: 4 },
  { name: 'fog-above', weather: 'fog', altitude: 1500, pitch: -12, turn: 60, sun: 8 },
  // Dust: from inside and from above its top.
  { name: 'dust-inside', weather: 'duststorm', altitude: 30, pitch: 22, turn: 10, sun: 35 },
  { name: 'dust-above', weather: 'duststorm', altitude: 4000, pitch: -10, turn: 80, sun: 35 },
  // Its wall from outside, in clear air: looking east at it, at noon and with a low sun behind the camera.
  { name: 'dust-wall', weather: 'dustwall', altitude: 300, pitch: 4, turn: 180, sun: 40 },
  { name: 'dust-wall-low', weather: 'dustwall', altitude: 1500, pitch: -2, turn: 200, sun: 12 },
  // Snow, and a moonlit night with cloud.
  { name: 'blizzard', weather: 'blizzard', altitude: 30, pitch: 5, turn: 90, sun: 30 },
  { name: 'moonlit', weather: 'fair', altitude: 30, pitch: 18, turn: 20, sun: -30, moon: 35 },
  { name: 'clear', weather: 'clear', altitude: 30, pitch: 10, turn: 60, sun: 40 },
];

/**
 * A patch of level ground around the camera, out to the horizon: rings of
 * vertices on the sea-level sphere, placed relative to the camera in float64
 * (rule 4).
 */
function groundPatch(eye: Vec3d, east: Vec3d, north: Vec3d, up: Vec3d): BufferGeometry {
  const rings = 56;
  const spokes = 96;
  const positions = new Float32Array((rings * spokes + 1) * 3);
  const foot = up.clone().scale(PLANET_RADIUS);
  positions.set([foot.x - eye.x, foot.y - eye.y, foot.z - eye.z], 0);
  const p = new Vec3d();
  for (let r = 0; r < rings; r++) {
    // From 15 m to 700 km, each ring 22% farther.
    const angle = Math.min(1.2, (15 * 1.22 ** r) / PLANET_RADIUS);
    for (let s = 0; s < spokes; s++) {
      const azimuth = (2 * Math.PI * (s + 0.5 * (r % 2))) / spokes;
      p.set(0, 0, 0)
        .addScaled(up, Math.cos(angle))
        .addScaled(north, Math.sin(angle) * Math.cos(azimuth))
        .addScaled(east, Math.sin(angle) * Math.sin(azimuth))
        .scale(PLANET_RADIUS);
      positions.set([p.x - eye.x, p.y - eye.y, p.z - eye.z], (1 + r * spokes + s) * 3);
    }
  }
  const index: number[] = [];
  for (let s = 0; s < spokes; s++) index.push(0, 1 + ((s + 1) % spokes), 1 + s);
  for (let r = 0; r + 1 < rings; r++) {
    for (let s = 0; s < spokes; s++) {
      const a = 1 + r * spokes + s;
      const b = 1 + r * spokes + ((s + 1) % spokes);
      const c = a + spokes;
      const d = b + spokes;
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

it('renders the volumetrics', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const outDir = process.env.OUT ?? join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const width = Number(process.env.W ?? 512);
  const height = Number(process.env.H ?? 288);
  const wanted = process.env.VIEWS?.split(',');
  const views = wanted
    ? wanted.map((name) => {
        const v = VIEWS.find((x) => x.name === name);
        if (!v)
          throw new RangeError(
            `VIEWS: ${name} is not one of ${VIEWS.map((x) => x.name).join(', ')}`,
          );
        return v;
      })
    : VIEWS;
  // ALT (m above sea level), PITCH, TURN and SUN (degrees) override every chosen view's own.
  for (let k = 0; k < views.length; k++) {
    views[k] = {
      ...views[k]!,
      ...(process.env.ALT ? { altitude: Number(process.env.ALT) } : {}),
      ...(process.env.PITCH ? { pitch: Number(process.env.PITCH) } : {}),
      ...(process.env.TURN ? { turn: Number(process.env.TURN) } : {}),
      ...(process.env.SUN ? { sun: Number(process.env.SUN) } : {}),
    };
  }

  // TUNING='{"multiple":0.4}' overrides numbers of the cloud's light.
  if (process.env.TUNING) Object.assign(CLOUD_LIGHT, JSON.parse(process.env.TUNING));
  // TUNING_AIR='{"wispLight":0.5}' overrides numbers of the look of fog, dust and rain.
  if (process.env.TUNING_AIR) Object.assign(AIR_LOOK, JSON.parse(process.env.TUNING_AIR));
  const head = await headlessRenderer(gpu.device, width, height);
  const renderer = head.renderer;
  renderer.toneMapping = AgXToneMapping;
  const lighting = new PlanetLighting();
  const weather = new WeatherTexture();
  const clouds = new CloudLayer(
    PLANET_RADIUS,
    lighting,
    weather,
    process.env.BAKE ? Number(process.env.BAKE) : undefined,
  );
  lighting.sunVisibility = (p) => clouds.shadow(p);
  lighting.overcast = (p) => clouds.overcast(p);
  const state = new WeatherState();
  const volumetrics = new Volumetrics({ lighting, clouds, weather, state });
  if (process.env.QUALITY) volumetrics.quality = process.env.QUALITY as VolumetricQuality;
  if (process.env.CIRRUS) volumetrics.cirrus.value = Number(process.env.CIRRUS);
  if (process.env.AIR === '0') volumetrics.airEnabled = false;
  if (process.env.CLOUDS_3D === '0') volumetrics.cloudsEnabled = false;
  const pipeline = process.env.POST === '0' ? null : new SimPipeline(renderer);
  if (pipeline) {
    volumetrics.attach(pipeline);
    volumetrics.skipWarmUp();
    if (process.env.SCALE) pipeline.volumetricScale = 1 / Number(process.env.SCALE);
    pipeline.volumetricsEnabled = process.env.VOL !== '0';
    pipeline.volumetricFilter = process.env.FILTER !== '0';
  }

  // COUNT=1: a second source that returns what the marches did, evaluated per low-resolution
  // pixel along the camera's rays down to sea level.
  const counter =
    process.env.COUNT === '1'
      ? new Volumetrics({ lighting, clouds, weather, state, count: true })
      : null;
  const countAxes = {
    forward: uniform(new Vector3()),
    right: uniform(new Vector3()),
    top: uniform(new Vector3()),
  };
  let countQuad: QuadMesh | null = null;
  let countTarget: RenderTarget | null = null;
  if (counter) {
    counter.quality = volumetrics.quality;
    counter.cirrus.value = volumetrics.cirrus.value;
    counter.airEnabled = volumetrics.airEnabled;
    counter.cloudsEnabled = volumetrics.cloudsEnabled;
    const divisor = process.env.SCALE
      ? Number(process.env.SCALE)
      : Math.round(1 / VOLUMETRIC_QUALITY[counter.quality].scale);
    countTarget = new RenderTarget(Math.ceil(width / divisor), Math.ceil(height / divisor), {
      type: FloatType,
      depthBuffer: false,
    });
    const tan = Math.tan((25 * Math.PI) / 180);
    const x = screenUV.x
      .mul(2)
      .sub(1)
      .mul(tan * (width / height));
    const y = float(1).sub(screenUV.y.mul(2)).mul(tan);
    const material = new NodeMaterial();
    material.fragmentNode = counter.source.build({
      rayDirection: normalize(
        countAxes.forward.add(countAxes.right.mul(x)).add(countAxes.top.mul(y)),
      ) as V3,
      sceneDistance: float(1e9) as Node<'float'>,
      uv: screenUV as Node<'vec2'>,
      jitter: float(0.5) as Node<'float'>,
    });
    countQuad = new QuadMesh(material);
  }

  const scene = new Scene();
  scene.backgroundNode = lighting.atmosphere.skyNode();
  scene.add(clouds.group);
  // The ground: fields of a few hundred meters in muted greens and tans, lit like the terrain.
  const material = new MeshBasicNodeMaterial();
  const inscatter = varyingProperty('vec3', 'vGroundInscatter');
  const transmittance = varyingProperty('vec3', 'vGroundTransmittance');
  material.positionNode = Fn(() => {
    const ap = lighting.atmosphere.aerialPerspective(
      modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz as V3,
      6,
    );
    inscatter.assign(ap.inscatter);
    transmittance.assign(ap.transmittance);
    return positionLocal;
  })();
  {
    const p = lighting.planetPosition(positionWorld as V3);
    const cell = floor(p.div(900));
    const tone = fract(
      sin(cell.x.mul(12.9898).add(cell.y.mul(78.233)).add(cell.z.mul(37.719))).mul(43758.5453),
    );
    // GROUND=plain draws the ground in one color (to tell its fields from artifacts in the air).
    const albedo =
      process.env.GROUND === 'plain'
        ? vec3(0.22, 0.25, 0.12)
        : mix(vec3(0.12, 0.2, 0.08), vec3(0.34, 0.3, 0.16), tone);
    material.colorNode = lighting.applyAerial(
      lighting.shadeDiffuse(albedo as V3, normalize(p) as V3, positionWorld as V3),
      inscatter as V3,
      transmittance as V3,
    );
  }
  const ground = new Mesh(new BufferGeometry(), material);
  ground.frustumCulled = false;
  scene.add(ground);
  const camera = new PerspectiveCamera(50, width / height, 1, 2_000_000);

  // Where the camera stands, and the frame there.
  const lat = Number(process.env.LAT ?? 40) * DEG;
  const lon = Number(process.env.LON ?? 2) * DEG;
  const up = new Vec3d(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const toward = (elevation: number, azimuth: number) =>
    new Vec3d()
      .addScaled(up, Math.sin(elevation))
      .addScaled(north, Math.cos(elevation) * Math.cos(azimuth))
      .addScaled(east, Math.cos(elevation) * Math.sin(azimuth));

  // The weather: a preset over a calm, clear frame with a steady wind.
  const grid = new WeatherGrid();
  const hour = Number(process.env.HOUR ?? 30);
  const live = (h: number): WeatherFrame => {
    const data = new Float32Array(CHANNEL_COUNT * grid.count);
    data.fill(60_000, Channel.Visibility * grid.count, (Channel.Visibility + 1) * grid.count);
    data.fill(3000, Channel.CloudBase * grid.count, (Channel.CloudBase + 1) * grid.count);
    data.fill(10, Channel.Temperature * grid.count, (Channel.Temperature + 1) * grid.count);
    for (let k = 0; k < WIND_LEVELS.length; k++) {
      const c = (Channel.WindEast0 + 2 * k) * grid.count;
      data.fill(5 + 3 * k, c, c + grid.count);
      data.fill(2 + k, c + grid.count, c + 2 * grid.count);
    }
    return { hour: h, data };
  };
  const view = new WeatherView(grid);
  let shown: string | null = null;
  let bakeClock = 0;
  let gameTime = (hour + 0.5) * HOUR;
  const frameOf = (kind: CloudView['weather'], h: number): WeatherFrame => {
    if (kind === 'hazy') {
      const frame = presetFrame('fair', live(h), grid);
      const n = grid.count;
      frame.data.fill(9000, Channel.Visibility * n, (Channel.Visibility + 1) * n);
      return frame;
    }
    if (kind !== 'dustwall' && kind !== 'front') return presetFrame(kind, live(h), grid);
    const frame = presetFrame(kind === 'front' ? 'storm' : 'duststorm', live(h), grid);
    const west = presetFrame('fair', live(h), grid);
    const n = grid.count;
    for (let s = 0; s < n; s++) {
      const e =
        grid.directions[s * 3]! * east.x +
        grid.directions[s * 3 + 1]! * east.y +
        grid.directions[s * 3 + 2]! * east.z;
      if (e >= 0.02) continue;
      if (kind === 'front') {
        for (let c = 0; c < CHANNEL_COUNT; c++) frame.data[c * n + s] = west.data[c * n + s]!;
      } else {
        frame.data[Channel.Dust * n + s] = 0;
        frame.data[Channel.Visibility * n + s] = 60_000;
      }
    }
    return frame;
  };
  const show = (preset: CloudView['weather']) => {
    if (shown === preset) return;
    shown = preset;
    view.clear();
    view.add(frameOf(preset, hour));
    view.add(frameOf(preset, hour + 1));
    weather.setFrames(view);
    state.reset();
    volumetrics.reset();
  };

  const moonHidden = toward(-60 * DEG, 1);
  let timing = false;
  let patchOf: CloudView | null = null;
  const frame = (v: CloudView, dt: number) => {
    const eye = up.clone().scale(PLANET_RADIUS + v.altitude);
    const sunAzimuth = -Math.PI / 2;
    const sun = toward(v.sun * DEG, sunAzimuth);
    const moon = v.moon === undefined ? moonHidden : toward(v.moon * DEG, 2.2);
    const keyAzimuth = v.sun < -6 && v.moon !== undefined ? 2.2 : sunAzimuth;
    const forward = toward(v.pitch * DEG, keyAzimuth + v.turn * DEG);
    const top = up.clone().addScaled(forward, -forward.dot(up)).normalize();
    camera.fov = v.fov ?? 50;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, 0);
    camera.up.set(top.x, top.y, top.z);
    camera.lookAt(forward.x, forward.y, forward.z);
    camera.updateMatrixWorld();
    show(v.weather);
    weather.update(view, gameTime);
    clouds.time.value = gameTime;
    // While timing, the shell stays hidden without the volumetrics too: the frame without
    // either is what their cost is measured against.
    clouds.volumetric = timing || (pipeline !== null && pipeline.volumetricsEnabled);
    clouds.update(eye);
    lighting.update(eye, sun, moon);
    state.update(view, eye, v.altitude, gameTime, dt);
    const flash = Number(process.env.FLASH ?? 0);
    if (flash > 0) {
      // FLASH_KM ahead (4), FLASH_TURN degrees to the right of the view's center (0), FLASH_ALT m up (3500).
      const side = forward.clone().cross(up).normalize();
      const turn = Number(process.env.FLASH_TURN ?? 0) * DEG;
      const at = eye
        .clone()
        .addScaled(forward, Number(process.env.FLASH_KM ?? 4) * KM * Math.cos(turn))
        .addScaled(side, Number(process.env.FLASH_KM ?? 4) * KM * Math.sin(turn))
        .normalize()
        .scale(PLANET_RADIUS + Number(process.env.FLASH_ALT ?? 3500));
      state.flash.value = flash;
      state.flashPosition.value.set(at.x, at.y, at.z);
    }
    volumetrics.update(eye, dt);
    if (counter) {
      counter.update(eye, 0);
      const right = forward.clone().cross(top).normalize();
      countAxes.forward.value.set(forward.x, forward.y, forward.z);
      countAxes.right.value.set(right.x, right.y, right.z);
      countAxes.top.value.set(top.x, top.y, top.z);
    }
    lighting.atmosphere.sky.setCelestial(
      lighting.sunElevation,
      lighting.night,
      moonIlluminatedFraction(sun, moon),
      celestialRotation(0, EARTH_ORBIT, { startDay: 226, startTimeOfDay: 0 }),
      state.clock.value,
    );
    if (patchOf !== v) {
      ground.geometry.dispose();
      ground.geometry = groundPatch(eye, east, north, up);
      patchOf = v;
    }
    // Every frame may bake: the bake's own clock decides.
    clouds.bake(renderer, (bakeClock += 1000));
    lighting.atmosphere.bakeSky(renderer);
    if (pipeline) {
      pipeline.sunElevation.value = lighting.sunElevation;
      pipeline.morning.value = -1;
      pipeline.render(scene, camera);
    } else {
      renderer.render(scene, camera);
    }
  };
  const draw = async (v: CloudView, dt = 0): Promise<Uint8Array> => {
    frame(v, dt);
    await gpu.finish();
    return head.readRgb();
  };

  const columns = Math.min(views.length, 4);
  const rows = Math.ceil(views.length / columns);
  const sheet = new Uint8Array(columns * width * rows * height * 3);
  const frames = Number(process.env.FRAMES ?? 0);
  const frameDt = Number(process.env.FRAME_DT ?? 1 / 30);
  const rate = process.env.STILL === '1' ? 0 : Number(process.env.TIME_RATE ?? 1);
  for (let k = 0; k < views.length; k++) {
    const v = views[k]!;
    const start = gameTime;
    const t0 = performance.now();
    await draw(v);
    // Twice: the first frame of a weather bakes the coverage its shadows and march read.
    const rgb = await draw(v);
    const local = state.local;
    const s = volumetrics.stats;
    console.log(
      `${v.name}: ${(performance.now() - t0).toFixed(0)} ms; clouds ${s.clouds ? `${s.bottom.toFixed(0)}–${s.top.toFixed(0)} m` : 'off'}, ` +
        `air ${s.air ? `to ${s.airTop.toFixed(0)} m` : 'off'}` +
        (local
          ? `; at the camera: cover ${local.cloudCover.toFixed(2)}, base ${local.cloudBase.toFixed(0)} m, ` +
            `visibility ${local.visibility.toFixed(0)} m, rain ${state.rain.value.toFixed(2)}, snow ${state.snow.value.toFixed(2)}, ` +
            `dust ${state.dust.value.toFixed(2)}, storm ${state.storm.value.toFixed(2)}`
          : ''),
    );
    if (counter && countQuad && countTarget) {
      renderer.setRenderTarget(countTarget);
      countQuad.render(renderer);
      renderer.setRenderTarget(null);
      await gpu.finish();
      const px = (await renderer.readRenderTargetPixelsAsync(
        countTarget,
        0,
        0,
        countTarget.width,
        countTarget.height,
      )) as Float32Array;
      const n = px.length / 4;
      const mean = [0, 0, 0, 0];
      const most = [0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 4; c++) {
          mean[c]! += px[i * 4 + c]! / n;
          if (px[i * 4 + c]! > most[c]!) most[c] = px[i * 4 + c]!;
        }
      }
      console.log(
        `  count ${v.name} (${counter.quality}, ${countTarget.width} × ${countTarget.height}): ` +
          `cloud steps ${mean[0]!.toFixed(1)} (most ${most[0]}), shaded ${mean[1]!.toFixed(1)} (most ${most[1]}), ` +
          `air steps ${mean[2]!.toFixed(1)} (most ${most[2]}), reads ${mean[3]!.toFixed(1)} (most ${most[3]})`,
      );
    }
    writeFileSync(join(outDir, `clouds-${v.name}.png`), encodePng(width, height, rgb));
    const cx = (k % columns) * width;
    const cy = Math.floor(k / columns) * height;
    for (let y = 0; y < height; y++) {
      sheet.set(
        rgb.subarray(y * width * 3, (y + 1) * width * 3),
        ((cy + y) * columns * width + cx) * 3,
      );
    }
    if (frames > 0) {
      let before = rgb;
      for (let f = 1; f <= frames; f++) {
        gameTime += frameDt * rate;
        const now = await draw(v, process.env.STILL === '1' ? 0 : frameDt);
        let sum = 0;
        let worst = 0;
        let over = 0;
        for (let i = 0; i < now.length; i++) {
          const d = Math.abs(now[i]! - before[i]!);
          sum += d;
          if (d > worst) worst = d;
          if (d > 6) over++;
        }
        console.log(
          `  frame ${f}: mean difference ${(sum / now.length).toFixed(2)}, largest ${worst}, ` +
            `${((100 * over) / now.length).toFixed(2)}% of values over 6`,
        );
        writeFileSync(join(outDir, `clouds-${v.name}-f${f}.png`), encodePng(width, height, now));
        before = now;
      }
      gameTime = start;
    }
  }
  if (views.length > 1) {
    const file = join(outDir, 'clouds-sheet.png');
    writeFileSync(file, encodePng(columns * width, rows * height, sheet));
    console.log(`${views.length} views → ${file}`);
  }

  // PERF=n: every view without the volumetrics and with them at each quality, interleaved.
  const rounds = Number(process.env.PERF ?? 0);
  if (rounds > 0 && pipeline) {
    const levels = Object.keys(VOLUMETRIC_QUALITY) as VolumetricQuality[];
    const modes: [string, () => void][] = [['off', () => (pipeline.volumetricsEnabled = false)]];
    for (const level of levels) {
      modes.push([
        level,
        () => {
          pipeline.volumetricsEnabled = true;
          volumetrics.quality = level;
        },
      ]);
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
    timing = true;
    for (const v of views) {
      const times: Record<string, number[]> = {};
      for (let round = -1; round < rounds; round++) {
        for (const [name, set] of modes) {
          set();
          // A new quality's shader is compiled and drawn a few frames before the source may
          // rest in clear air.
          for (let k = 0; k < 3; k++) {
            frame(v, 0);
            await gpu.finish();
          }
          const t0 = performance.now();
          frame(v, 0);
          await gpu.finish();
          // Round −1 compiles each mode's shaders.
          if (round >= 0) (times[name] ??= []).push(performance.now() - t0);
        }
      }
      const off = median(times.off!);
      const least = Math.min(...times.off!);
      const signed = (x: number) => (x < 0 ? '−' : '+') + Math.abs(x).toFixed(1);
      console.log(
        `perf ${v.name} at ${width} × ${height} (ms/frame, median of ${rounds} and least): ` +
          `off ${off.toFixed(1)} (${least.toFixed(1)}); ` +
          levels
            .map(
              (l) =>
                `${l} ${signed(median(times[l]!) - off)} (${signed(Math.min(...times[l]!) - least)})`,
            )
            .join(', '),
      );
    }
  }
  pipeline?.dispose();
  head.dispose();
}, 3_600_000);
