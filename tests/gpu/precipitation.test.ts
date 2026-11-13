/**
 * Precipitation and lightning on Dawn (weather/precipitation.ts, lightning.ts):
 * rain drawn into the pipeline's overlay over a sky and a ground, with a wall
 * right in front of the camera over the left half of the view. Checks that the
 * particles change the picture where the air is open, hide behind the wall,
 * and are gone, pass and all, at zero intensity; that a bolt shows against
 * the sky and not through the wall; and that a flash lights the ground near
 * it more than the ground far from it.
 */
import { describe, expect, it } from 'vitest';
import {
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from 'three/webgpu';
import { positionWorld, vec3 } from 'three/tsl';
import { DEG, KM, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { PlanetLighting } from '../../src/render/sim/lighting/planetLighting';
import { SimPipeline } from '../../src/render/sim/post/simPipeline';
import { Lightning, strikeAtPlace } from '../../src/render/sim/weather/lightning';
import { Precipitation } from '../../src/render/sim/weather/precipitation';
import type { ParticleKind } from '../../src/render/sim/weather/precipitation';
import { WeatherState } from '../../src/render/sim/weather/weatherState';
import type { WeatherReport } from '../../src/sim/weather/frame';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

const W = 256;
const H = 128;
/** The camera: 2 m above the ground where +Y leaves the planet, looking along −Z. */
const EYE = new Vec3d(0, PLANET_RADIUS + 2, 0);
const FORWARD = new Vec3d(0, 0, -1);

async function setup(sunElevation: number) {
  const head = await headlessRenderer(gpu!.device, W, H);
  const lighting = new PlanetLighting(PLANET_RADIUS);
  const sun = new Vec3d(0.3, Math.sin(sunElevation), Math.cos(sunElevation)).normalize();
  lighting.update(EYE, sun, new Vec3d(0, -1, 0));

  const scene = new Scene();
  scene.backgroundNode = vec3(0.02, 0.05, 0.2);
  const groundMaterial = new MeshBasicNodeMaterial();
  groundMaterial.colorNode = lighting.shadeDiffuse(vec3(0.1), vec3(0, 1, 0), positionWorld);
  const ground = new Mesh(new PlaneGeometry(60_000, 60_000), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  // A wall 0.8 m ahead over the left half of the view: nearer than any particle is drawn.
  const wallMaterial = new MeshBasicNodeMaterial({ side: DoubleSide });
  wallMaterial.colorNode = vec3(0.3, 0.05, 0.05);
  const wall = new Mesh(new PlaneGeometry(10, 10), wallMaterial);
  wall.position.set(-5, 0, -0.8);
  scene.add(ground, wall);
  const camera = new PerspectiveCamera(45, W / H, 0.5, 200_000);
  camera.updateProjectionMatrix();

  const pipeline = new SimPipeline(head.renderer);
  pipeline.bloom = pipeline.grading = pipeline.grain = pipeline.dither = false;
  pipeline.animateNoise = false;
  const weather = new WeatherState();
  weather.local = { cloudCover: 1, cloudBase: 600, visibility: 10_000 } as WeatherReport;
  const precipitation = new Precipitation(weather, lighting, pipeline.sceneDistance);
  const lightning = new Lightning(PLANET_RADIUS, weather, lighting, pipeline.sceneDistance);
  pipeline.overlay.add(precipitation.group, lightning.group);

  const draw = async (): Promise<Uint8Array> => {
    lightning.update({ view: null, eye: EYE, gameTime: 0, dt: 0.2, pixelAngle: (45 * DEG) / H });
    precipitation.update({
      eye: EYE,
      forward: FORWARD,
      dt: 0.2,
      fovY: 45 * DEG,
      aspect: W / H,
      viewportHeight: H,
      aboveGround: 2,
      near: camera.near,
    });
    pipeline.render(scene, camera);
    await gpu!.finish();
    return head.readRgb();
  };
  const dispose = () => {
    precipitation.dispose();
    lightning.dispose();
    pipeline.dispose();
    head.dispose();
  };
  return { head, lighting, weather, precipitation, lightning, pipeline, draw, dispose, wall };
}

/** Pixels of a column range that differ by more than `by` in any channel, as a fraction. */
function changed(a: Uint8Array, b: Uint8Array, x0: number, x1: number, by = 6): number {
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      if (
        Math.abs(a[i]! - b[i]!) > by ||
        Math.abs(a[i + 1]! - b[i + 1]!) > by ||
        Math.abs(a[i + 2]! - b[i + 2]!) > by
      ) {
        n++;
      }
    }
  }
  return n / (H * (x1 - x0));
}

describe.skipIf(!gpu)('precipitation and lightning on Dawn', () => {
  it('draws rain, snow and dust in open air, hides them behind a near wall, and nothing at zero', async () => {
    const s = await setup(35 * DEG);
    const clear = await s.draw();
    expect(gpu!.errors).toEqual([]);
    // Nothing to draw: no overlay pass.
    expect(s.pipeline.stats.passes).toBe(2);
    const set = (kind: ParticleKind, level: number) => {
      s.weather.rain.value = kind === 'rain' ? level : 0;
      s.weather.snow.value = kind === 'snow' ? level : 0;
      s.weather.dust.value = kind === 'dust' ? level : 0;
    };
    const open: Record<string, number> = {};
    for (const [kind, level] of [
      ['rain', 0.2],
      ['rain', 0.56],
      ['rain', 1],
      ['snow', 0.5],
      ['dust', 0.9],
    ] as const) {
      set(kind, level);
      s.weather.wind.value.set(kind === 'rain' ? 0 : 12, 0, 0);
      const image = await s.draw();
      expect(gpu!.errors).toEqual([]);
      expect(s.pipeline.stats.passes).toBe(3);
      expect(s.precipitation.counts[kind]).toBeGreaterThan(0);
      // The right half is open air: the particles show. The left half is the wall at 0.8 m:
      // no particle is drawn nearer than that, so nothing shows in front of it.
      const right = changed(image, clear, W / 2 + 8, W);
      const left = changed(image, clear, 0, W / 2 - 8);
      open[`${kind} ${level}`] = right;
      expect(right).toBeGreaterThan(kind === 'rain' && level < 0.5 ? 0.002 : 0.03);
      expect(left).toBeLessThan(0.004);
      expect(left).toBeLessThan(0.1 * right);
    }
    // Three strengths of rain, clearly apart.
    expect(open['rain 0.56']).toBeGreaterThan(2.5 * open['rain 0.2']!);
    expect(open['rain 1']).toBeGreaterThan(1.8 * open['rain 0.56']!);

    // Without the wall the left half fills with rain too: it was the wall that hid it.
    set('rain', 1);
    s.weather.wind.value.set(0, 0, 0);
    s.wall.visible = false;
    const bare = await s.draw();
    s.precipitation.enabled = false;
    const bareClear = await s.draw();
    s.precipitation.enabled = true;
    expect(changed(bare, bareClear, 0, W / 2 - 8)).toBeGreaterThan(0.03);
    s.wall.visible = true;

    // Above the cloud, and at zero intensity, the picture is the clear one again, bit for bit.
    s.weather.rain.value = 0;
    const dry = await s.draw();
    expect(s.pipeline.stats.passes).toBe(2);
    expect(changed(dry, clear, 0, W, 0)).toBe(0);
    expect(gpu!.errors).toEqual([]);
    s.dispose();
  }, 120_000);

  it('draws a bolt against the sky, not through the wall, and lights the ground near it', async () => {
    const s = await setup(-30 * DEG);
    const dark = await s.draw();
    // A strike 3 km ahead and a little to the right.
    const place = EYE.clone()
      .addScaled(FORWARD, 3 * KM)
      .addScaled(new Vec3d(1, 0, 0), 600);
    s.lightning.forced = { strike: strikeAtPlace(place, 5), age: 0.01 };
    const lit = await s.draw();
    expect(gpu!.errors).toEqual([]);
    expect(s.pipeline.stats.passes).toBe(3);
    expect(s.weather.flash.value).toBeGreaterThan(0.8);
    expect(s.lightning.bolt!.segments).toBeGreaterThan(64);
    const brightest = (image: Uint8Array, x0: number, x1: number, y0: number, y1: number) => {
      let best = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) best = Math.max(best, image[(y * W + x) * 3 + 1]!);
      }
      return best;
    };
    // The sky half above the horizon holds the bolt: nearly white pixels where it was dark.
    expect(brightest(dark, W / 2, W, 0, H / 2 - 4)).toBeLessThan(80);
    expect(brightest(lit, W / 2, W, 0, H / 2 - 4)).toBeGreaterThan(200);
    // The wall hides it, and is itself not lit (it is unlit paint).
    expect(changed(lit, dark, 0, W / 2 - 8)).toBe(0);
    // The ground is lit by the flash, and less by a strike far away.
    const groundLevel = (image: Uint8Array) => {
      let sum = 0;
      for (let x = W / 2 + 8; x < W; x++) sum += image[((H - 3) * W + x) * 3 + 1]!;
      return sum / (W / 2 - 8);
    };
    const distant = EYE.clone().addScaled(FORWARD, 24 * KM);
    s.lightning.forced = { strike: strikeAtPlace(distant, 5), age: 0.01 };
    const dim = await s.draw();
    expect(groundLevel(lit)).toBeGreaterThan(groundLevel(dark) + 60);
    expect(groundLevel(dim)).toBeGreaterThan(groundLevel(dark) + 5);
    expect(groundLevel(lit)).toBeGreaterThan(groundLevel(dim) + 30);

    // The strike over, everything is dark again and the overlay pass is gone.
    s.lightning.forced = null;
    const after = await s.draw();
    expect(s.pipeline.stats.passes).toBe(2);
    expect(changed(after, dark, 0, W, 0)).toBe(0);
    expect(gpu!.errors).toEqual([]);
    s.dispose();
  }, 120_000);
});
