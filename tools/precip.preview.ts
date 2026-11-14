/**
 * Rain, snow, dust and lightning on a scene that costs almost nothing to draw
 * (src/render/sim/weather/precipitation.ts, lightning.ts): a ground plane, a
 * dark hangar and a box the size of a fighter 25 m ahead, under a plain sky.
 * For judging the particles' look and for timing them on their own;
 * `tools/render.preview.ts` (`WEATHER=`, `RAIN=`, `LIGHTNING=`) shows them in
 * the real scene.
 *
 *   npx vitest run --disable-console-intercept --config vitest.tools.config.ts tools/precip.preview.ts
 *   env: W × H (640 × 360), CASES comma list of <kind>:<level>[:<wind m/s>[:<camera m/s>]]
 *        (default drizzle, rain, skyfall, snow, blizzard, dust and rain from a moving camera),
 *        SUN_EL sun elevation in degrees (25), DENSITY the quality factor (1),
 *        BOLT=<s> adds a strike 3 km ahead that many seconds after it began (BOLT_KM; BOLT_SEED
 *        picks its shape),
 *        ROUNDS=n times each case against the empty overlay, interleaved over n rounds,
 *        OUT=dir (tools/out)
 *
 * Output: precip-<kind>-<level>[-w<wind>][-v<speed>].png, and per case the
 * instance count, an estimate of the particle fragments shaded per screen
 * pixel (overdraw) and, with ROUNDS, the median frame times.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  AgXToneMapping,
  BoxGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from 'three/webgpu';
import { positionWorld, vec3 } from 'three/tsl';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import { SimPipeline } from '../src/render/sim/post/simPipeline';
import { Lightning, strikeAtPlace } from '../src/render/sim/weather/lightning';
import {
  anchorWindow,
  LAYER_SIDES,
  MAX_HALF_STREAK,
  MAX_HALF_STREAK_ANGLE,
  particleAnchor,
  particleLook,
  Precipitation,
} from '../src/render/sim/weather/precipitation';
import type { ParticleKind } from '../src/render/sim/weather/precipitation';
import { WeatherState } from '../src/render/sim/weather/weatherState';
import type { WeatherReport } from '../src/sim/weather/frame';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';

const DEFAULT_CASES =
  'rain:0.2,rain:0.55,rain:1:12,snow:0.33:2,snow:0.51:24,dust:0.92:22,rain:0.55:5:90';

/**
 * Particle fragments shaded per screen pixel, estimated by sampling
 * particles as the vertex shader lays them out: an anchor in the view, a
 * place in the cube around it. Without the fades, so an upper bound.
 */
function overdraw(
  kind: ParticleKind,
  level: number,
  count: number,
  wind: number,
  speed: number,
  fovY: number,
  aspect: number,
  height: number,
): { fragments: number; onScreen: number } {
  const look = particleLook(kind, level, wind);
  const pixel = fovY / height;
  const tanY = Math.tan(fovY / 2);
  const tanX = tanY * aspect;
  let state = 12345;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const samples = 20_000;
  let area = 0;
  let shown = 0;
  LAYER_SIDES.forEach((side, k) => {
    const share = k === 2 ? 0.5 : 0.25;
    let sum = 0;
    let visible = 0;
    for (let i = 0; i < samples; i++) {
      const [ax, ay, az] = particleAnchor([next(), next(), next()], k, tanX, tanY);
      const offset: [number, number, number] = [
        (next() - 0.5) * side,
        (next() - 0.5) * side,
        (next() - 0.5) * side,
      ];
      // Right, up and ahead of the camera.
      const x = ax + offset[0];
      const y = ay + offset[1];
      const z = az + offset[2];
      const d = Math.hypot(x, y, z);
      if (
        anchorWindow(offset, side) < 0.004 ||
        d < 0.5 ||
        z <= 0 ||
        Math.abs(x) > z * tanX ||
        Math.abs(y) > z * tanY
      ) {
        continue;
      }
      visible++;
      const s = 0.75 + 0.5 * next();
      // Velocity relative to the camera: wind to the right, fall downward, the camera ahead.
      const vx = wind * (look.carried + look.strewn * s);
      const vy = -look.fallSpeed * s;
      const vz = -speed;
      const along = (vx * x + vy * y + vz * z) / d;
      const across = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - along * along));
      const size = look.sizeMin + (look.sizeMax - look.sizeMin) * next() ** 2;
      const radius = Math.max(size / 2, (pixel * d * 1.25) / 2);
      const half =
        Math.min(
          MAX_HALF_STREAK,
          look.stretch * radius,
          MAX_HALF_STREAK_ANGLE * d,
          (across * look.exposure) / 2,
        ) + radius;
      sum += (4 * half * radius) / (d * d * pixel * pixel);
    }
    area += (sum / samples) * share * count;
    shown += (visible / samples) * share;
  });
  return { fragments: area / (height * height * aspect), onScreen: shown };
}

it('renders precipitation on a plain scene', async () => {
  const gpu = await testGpu();
  if (!gpu) return;
  const width = Number(process.env.W ?? 640);
  const height = Number(process.env.H ?? 360);
  const rounds = Number(process.env.ROUNDS ?? 0);
  const outDir = process.env.OUT ?? 'tools/out';
  mkdirSync(outDir, { recursive: true });
  const head = await headlessRenderer(gpu.device, width, height);
  const renderer = head.renderer;
  renderer.toneMapping = AgXToneMapping;

  // The camera stands 2 m above the ground at the planet's "north pole", looking along −Z.
  const eye = new Vec3d(0, PLANET_RADIUS + 2, 0);
  const lighting = new PlanetLighting(PLANET_RADIUS);
  const elevation = Number(process.env.SUN_EL ?? 25) * DEG;
  const sun = new Vec3d(0.4 * Math.cos(elevation), Math.sin(elevation), -Math.cos(elevation));
  lighting.update(eye, sun.normalize(), new Vec3d(0, -1, 0));
  lighting.atmosphere.sky.setCelestial(lighting.sunElevation, lighting.night, 0.5, 0, 0);

  const scene = new Scene();
  // The scene's own sky and light, so the particles are judged against the real exposure.
  scene.backgroundNode = lighting.atmosphere.skyNode();
  const flat = (r: number, g: number, b: number) => {
    const m = new MeshBasicNodeMaterial();
    m.colorNode = lighting.shadeDiffuse(vec3(r, g, b), vec3(0, 1, 0), positionWorld);
    return m;
  };
  const ground = new Mesh(new PlaneGeometry(40_000, 40_000), flat(0.16, 0.2, 0.1));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  const apron = new Mesh(new PlaneGeometry(60, 400), flat(0.2, 0.2, 0.21));
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(0, -1.98, -200);
  const hangar = new Mesh(new BoxGeometry(40, 12, 30), flat(0.05, 0.06, 0.07));
  hangar.position.set(-45, 4, -90);
  const aircraft = new Mesh(new BoxGeometry(10, 3, 15), flat(0.09, 0.1, 0.12));
  aircraft.position.set(4, 0, -25);
  scene.add(ground, apron, hangar, aircraft);
  // NEAR (m) sets the near plane: the free camera's is a tenth of its height above the ground.
  const camera = new PerspectiveCamera(
    45,
    width / height,
    Number(process.env.NEAR ?? 0.5),
    200_000,
  );
  camera.updateProjectionMatrix();

  const pipeline = new SimPipeline(renderer);
  pipeline.animateNoise = false;
  pipeline.sunElevation.value = elevation;
  const weather = new WeatherState();
  const precipitation = new Precipitation(weather, lighting, pipeline.sceneDistance);
  precipitation.density = Number(process.env.DENSITY ?? 1);
  const lightning = new Lightning(PLANET_RADIUS, weather, lighting, pipeline.sceneDistance);
  pipeline.overlay.add(precipitation.group, lightning.group);
  const fovY = camera.fov * DEG;
  const forward = new Vec3d(0, 0, -1);

  const frame = (dt: number) => {
    lightning.update({ view: null, eye, gameTime: 0, dt, pixelAngle: fovY / height });
    precipitation.update({
      eye,
      forward,
      dt,
      fovY,
      aspect: width / height,
      viewportHeight: height,
      aboveGround: 2,
      near: camera.near,
    });
    lighting.atmosphere.bakeSky(renderer);
    pipeline.render(scene, camera);
  };

  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
  for (const spec of (process.env.CASES ?? DEFAULT_CASES).split(',')) {
    const [kind, levelText, windText = '0', speedText = '0'] = spec.split(':') as [
      ParticleKind,
      string,
      string?,
      string?,
    ];
    const level = Number(levelText);
    const wind = Number(windText);
    const speed = Number(speedText);
    weather.rain.value = kind === 'rain' ? level : 0;
    weather.snow.value = kind === 'snow' ? level : 0;
    weather.dust.value = kind === 'dust' ? level : 0;
    weather.wind.value.set(wind, 0, 0);
    weather.local = {
      cloudCover: kind === 'dust' ? 0.1 : 1,
      cloudBase: 500,
      visibility: 5000,
    } as WeatherReport;
    precipitation.velocityOverride = new Vec3d(0, 0, -speed);
    if (process.env.BOLT) {
      const place = eye.clone().addScaled(forward, Number(process.env.BOLT_KM ?? 3) * KM);
      lightning.forced = {
        strike: strikeAtPlace(place, Number(process.env.BOLT_SEED ?? 7)),
        age: Number(process.env.BOLT),
      };
    }
    // Let the air move for a while, so that the picture is not the lattice's first state.
    for (let i = 0; i < 4; i++) frame(0.37);
    await gpu.finish();
    const rgb = await head.readRgb();
    const name =
      `precip-${kind}-${levelText}` +
      (wind ? `-w${windText}` : '') +
      (speed ? `-v${speedText}` : '');
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, encodePng(width, height, rgb));
    const count = precipitation.counts[kind];
    const over = overdraw(kind, level, count, wind, speed, fovY, width / height, height);
    let timing = '';
    if (rounds > 0) {
      const times: Record<string, number[]> = { without: [], with: [] };
      for (let round = -1; round < rounds; round++) {
        for (const mode of ['without', 'with'] as const) {
          precipitation.enabled = mode === 'with';
          frame(0);
          await gpu.finish();
          const t0 = performance.now();
          frame(0);
          await gpu.finish();
          if (round >= 0) times[mode].push(performance.now() - t0);
        }
      }
      precipitation.enabled = true;
      timing = `, ${median(times.without).toFixed(1)} ms without, ${median(times.with).toFixed(1)} ms with (median of ${rounds})`;
    }
    console.log(
      `${name}: ${count} instances, ${(100 * over.onScreen).toFixed(0)}% on screen, ` +
        `about ${over.fragments.toFixed(3)} fragments per pixel${timing} → ${file}`,
    );
  }
  if (gpu.errors.length > 0) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  precipitation.dispose();
  lightning.dispose();
  pipeline.dispose();
  head.dispose();
});
