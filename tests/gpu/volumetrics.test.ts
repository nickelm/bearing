/**
 * The volumetric source (clouds/volumetrics.ts) on Dawn, evaluated per pixel
 * of a small float target as the pipeline's volumetric pass does: clear air
 * costs nothing and returns nothing, a slab of cloud and even fog follow
 * Beer–Lambert, the noise volumes repeat and interpolate, the shadow the
 * clouds cast on the ground lies under the clouds the march draws, and the
 * marches stay within their step budgets (the counts are printed).
 */
import { describe, expect, it } from 'vitest';
import { FloatType, NodeMaterial, QuadMesh, RenderTarget, Vector3 } from 'three/webgpu';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { float, Fn, instanceIndex, instancedArray, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { DEG, HOUR, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { CloudLayer } from '../../src/render/sim/clouds/cloudLayer';
import { cloudNoise, SHAPE_SIZE } from '../../src/render/sim/clouds/noiseVolume';
import {
  CLOUD_EXTINCTION,
  VOLUMETRIC_QUALITY,
  Volumetrics,
} from '../../src/render/sim/clouds/volumetrics';
import { WeatherTexture } from '../../src/render/sim/clouds/weatherTexture';
import { PlanetLighting } from '../../src/render/sim/lighting/planetLighting';
import { WeatherState } from '../../src/render/sim/weather/weatherState';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

/** Width and height of the target the source is evaluated into: whole 3 × 3 tiles of its sample offsets. */
const W = 64;
const H = 6;

/** A cloud layer, its weather and a volumetric source, with the frame's updates and a way to evaluate rays. */
function rig(renderer: WebGPURenderer, count = false) {
  const lighting = new PlanetLighting();
  const weather = new WeatherTexture();
  // A coarse bake: the tests' weather is uniform, and the detail's cells are 17 km.
  const clouds = new CloudLayer(PLANET_RADIUS, lighting, weather, 192);
  lighting.sunVisibility = (p) => clouds.shadow(p);
  lighting.overcast = (p) => clouds.overcast(p);
  const state = new WeatherState();
  const volumetrics = new Volumetrics({ lighting, clouds, weather, state, count });
  volumetrics.cirrus.value = 0;
  const direction = uniform(new Vector3(0, 0, -1));
  const sceneDistance = uniform(1e9);
  const material = new NodeMaterial();
  material.fragmentNode = volumetrics.source.build({
    rayDirection: direction as unknown as Node<'vec3'>,
    sceneDistance: sceneDistance as unknown as Node<'float'>,
    uv: vec2(0.5, 0.5) as Node<'vec2'>,
    jitter: float(0.5) as Node<'float'>,
  });
  const quad = new QuadMesh(material);
  const target = new RenderTarget(W, H, { type: FloatType, depthBuffer: false });
  let clock = 0;
  const up = new Vec3d(0.027, 0.643, 0.766).normalize();
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const eye = new Vec3d();
  return {
    lighting,
    weather,
    clouds,
    volumetrics,
    up,
    east,
    north,
    /** Places the camera `altitude` above sea level, `x` m east and `y` m north of the reference point. */
    frame(altitude: number, sun: Vec3d, x = 0, y = 0): Vec3d {
      eye
        .copy(up)
        .scale(PLANET_RADIUS)
        .addScaled(east, x)
        .addScaled(north, y)
        .normalize()
        .scale(PLANET_RADIUS + altitude);
      clouds.time.value = 30.5 * HOUR;
      clouds.volumetric = true;
      clouds.update(eye);
      lighting.update(eye, sun, new Vec3d(0, -1, 0));
      state.update(null, eye, altitude, 0, 0);
      volumetrics.update(eye, 0);
      clouds.bake(renderer, (clock += 1000));
      lighting.atmosphere.bakeSky(renderer);
      return eye;
    },
    /** The source's result along a ray: every pixel of the target, as RGBA floats. */
    async march(dir: Vec3d, distance = 1e9): Promise<Float32Array> {
      direction.value.set(dir.x, dir.y, dir.z).normalize();
      sceneDistance.value = distance;
      const before = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      quad.render(renderer);
      renderer.setRenderTarget(before);
      await gpu!.finish();
      return (await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H)) as Float32Array;
    },
    dispose(): void {
      target.dispose();
      material.dispose();
    },
  };
}

/** The mean of one channel over the first 3 × 3 pixels: one of each sample offset, as the pipeline's filter takes. */
function tileMean(pixels: Float32Array, channel: number): number {
  let sum = 0;
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) sum += pixels[(y * W + x) * 4 + channel]!;
  return sum / 9;
}

describe.skipIf(!gpu)('volumetrics (TSL on Dawn)', () => {
  it('returns nothing in clear air, and marches nothing', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const r = rig(head.renderer);
    const sun = r.up.clone().addScaled(r.east, 1).normalize();
    r.weather.fill(0);
    r.frame(1200, sun);
    expect(r.volumetrics.stats.clouds).toBe(false);
    expect(r.volumetrics.stats.air).toBe(false);
    const horizontal = await r.march(r.north);
    const upward = await r.march(r.up);
    for (const pixels of [horizontal, upward]) {
      for (let i = 0; i < W * H; i++) {
        expect([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2], pixels[i * 4 + 3]]).toEqual([
          0, 0, 0, 1,
        ]);
      }
    }
    // Fog alone turns the air march on and leaves the cloud march off.
    r.weather.fill(0, 0, { fog: 0.002 });
    r.frame(30, sun);
    expect(r.volumetrics.stats.clouds).toBe(false);
    expect(r.volumetrics.stats.air).toBe(true);
    const fogged = await r.march(r.north);
    expect(tileMean(fogged, 3)).toBeLessThan(0.5);
    expect(tileMean(fogged, 0)).toBeGreaterThan(0);
    r.dispose();
    head.dispose();
    expect(gpu!.errors).toEqual([]);
  }, 180_000);

  it('follows Beer–Lambert through a slab of cloud and through even fog', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const r = rig(head.renderer);
    const sun = r.up.clone().addScaled(r.east, 1).normalize();
    // Without the noise's structure a deck is a slab of full density.
    r.volumetrics.structure.value = 0;
    r.weather.fill(1, 0, { base: 1000 });
    r.frame(1400, sun);
    expect(r.volumetrics.stats.clouds).toBe(true);
    // A wall at each distance, seen from inside the slab along a level ray: every pixel,
    // whatever its sample offset, to within 2% of the optical depth.
    const depths: number[] = [];
    for (const distance of [90, 180, 315]) {
      const pixels = await r.march(r.north, distance);
      const expected = CLOUD_EXTINCTION * distance;
      for (let i = 0; i < W * H; i++) {
        const depth = -Math.log(pixels[i * 4 + 3]!);
        expect(Math.abs(depth - expected)).toBeLessThan(0.02 * expected);
      }
      depths.push(-Math.log(tileMean(pixels, 3)));
    }
    // Twice the way, twice the optical depth.
    expect(depths[1]! / depths[0]!).toBeCloseTo(2, 1);
    // The sunlit side of the wall's cloud is brighter than nothing and not blown out.
    const lit = tileMean(await r.march(r.north, 315), 0);
    expect(lit).toBeGreaterThan(0.01);
    expect(lit).toBeLessThan(10);

    // Even fog under its level: 500 m at an extinction of 0.002 / m, within 1%.
    r.weather.fill(0, 0, { fog: 0.002 });
    r.frame(30, sun);
    const fog = await r.march(r.north, 500);
    for (let i = 0; i < W * H; i++) {
      expect(Math.abs(-Math.log(fog[i * 4 + 3]!) - 1)).toBeLessThan(0.01);
    }
    r.dispose();
    head.dispose();
    expect(gpu!.errors).toEqual([]);
  }, 180_000);

  it('samples noise volumes that repeat and interpolate finer than 8 bits', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const noise = cloudNoise();
    const count = 64;
    const output = instancedArray(count * 2, 'vec4');
    const kernel = Fn(() => {
      // Along x in sixteenths of a voxel, and the same a whole tile further on.
      const i = instanceIndex.mod(count);
      const tile = float(instanceIndex.div(count));
      const x = float(i).div(16).add(0.5).div(SHAPE_SIZE).add(tile.mul(3));
      output
        .element(instanceIndex)
        .assign(noise.sampleShape(vec3(x, 10.5 / SHAPE_SIZE, 20.5 / SHAPE_SIZE) as Node<'vec3'>));
    })().compute(count * 2);
    await head.renderer.computeAsync(kernel);
    const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    const distinct = new Set<number>();
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 4; c++) {
        expect(out[(count + i) * 4 + c]!).toBeCloseTo(out[i * 4 + c]!, 4);
      }
      distinct.add(Math.round(out[i * 4]! * 65536));
    }
    // Four voxels in 64 samples: bytes filtered to bytes would show a handful of levels.
    expect(distinct.size).toBeGreaterThan(40);
  }, 120_000);

  it('casts the cloud shadow where the march draws the cloud', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const r = rig(head.renderer);
    // Scattered cumulus, the sun 55° up in the east.
    const sun = r.up
      .clone()
      .scale(Math.sin(55 * DEG))
      .addScaled(r.east, Math.cos(55 * DEG));
    r.weather.fill(0.45, 0, { base: 1300 });
    const side = 9;
    const spacing = 1400;
    const points = side * side;
    const positions = new Float32Array(points * 4);
    const through: number[] = [];
    for (let k = 0; k < points; k++) {
      const x = ((k % side) - (side - 1) / 2) * spacing;
      const y = (Math.floor(k / side) - (side - 1) / 2) * spacing;
      const eye = r.frame(2, sun, x, y);
      positions.set([eye.x, eye.y, eye.z, 0], k * 4);
      // What the march lets through toward the sun from this spot on the ground.
      through.push(tileMean(await r.march(sun), 3));
    }
    // The shadow and the overcast measure at the same spots, with the camera in their middle.
    r.frame(2, sun);
    const input = instancedArray(positions, 'vec4');
    const output = instancedArray(points, 'vec4');
    const kernel = Fn(() => {
      const p = input.element(instanceIndex).xyz as Node<'vec3'>;
      output.element(instanceIndex).assign(vec4(r.clouds.shadow(p), r.clouds.overcast(p), 0, 0));
    })().compute(points);
    await head.renderer.computeAsync(kernel);
    const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    const shadow = Array.from({ length: points }, (_, k) => out[k * 4]!);

    const under = shadow.filter((_, k) => through[k]! < 0.2);
    const open = shadow.filter((_, k) => through[k]! > 0.9);
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    // The field has both cloud and gaps here, and the shadow tells them apart.
    expect(under.length).toBeGreaterThan(5);
    expect(open.length).toBeGreaterThan(5);
    expect(mean(under)).toBeLessThan(0.5);
    expect(mean(open)).toBeGreaterThan(0.9);
    // Between heaps the sky's light is the clear sky's.
    expect(mean(Array.from({ length: points }, (_, k) => out[k * 4 + 1]!))).toBeLessThan(0.35);

    // Under a closed deck the sun is all but gone and the overcast measure is up.
    r.weather.fill(1, 0, { base: 900 });
    r.frame(2, sun);
    await head.renderer.computeAsync(kernel);
    const deck = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    for (let k = 0; k < points; k++) {
      expect(deck[k * 4]!).toBeLessThan(0.2);
      expect(deck[k * 4 + 1]!).toBeGreaterThan(0.3);
    }
    r.dispose();
    head.dispose();
    expect(gpu!.errors).toEqual([]);
  }, 300_000);

  it('stays within its budget of steps', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const r = rig(head.renderer, true);
    const sun = r.up
      .clone()
      .scale(Math.sin(40 * DEG))
      .addScaled(r.east, Math.cos(40 * DEG));
    const level = VOLUMETRIC_QUALITY[r.volumetrics.quality];
    const weathers: [string, () => void][] = [
      ['clear', () => r.weather.fill(0)],
      ['fair', () => r.weather.fill(0.45, 0, { base: 1300 })],
      ['overcast', () => r.weather.fill(1, 0, { base: 900, fog: 3e-4 })],
      ['storm', () => r.weather.fill(1, 2, { base: 600, storm: 0.9, fog: 4e-3 })],
      ['fog', () => r.weather.fill(0, 0, { fog: 0.02 })],
    ];
    // A fan of rays from the ground and from 6 km: degrees above the horizon, at three headings.
    const rays: Vec3d[] = [];
    for (const elevation of [-20, -8, -2, 3, 8, 15, 30, 60]) {
      for (const heading of [0, 100, 215]) {
        rays.push(
          new Vec3d()
            .addScaled(r.up, Math.sin(elevation * DEG))
            .addScaled(r.north, Math.cos(elevation * DEG) * Math.cos(heading * DEG))
            .addScaled(r.east, Math.cos(elevation * DEG) * Math.sin(heading * DEG)),
        );
      }
    }
    for (const [name, set] of weathers) {
      set();
      for (const altitude of [30, 1700, 6000]) {
        r.frame(altitude, sun);
        const sum = [0, 0, 0];
        const most = [0, 0, 0];
        for (const ray of rays) {
          // A ray into the ground ends there.
          const pixels = await r.march(ray, ray.dot(r.up) < 0 ? altitude / -ray.dot(r.up) : 1e9);
          for (let c = 0; c < 3; c++) {
            const mean = tileMean(pixels, c);
            sum[c]! += mean / rays.length;
            for (let i = 0; i < W * H; i++) most[c] = Math.max(most[c]!, pixels[i * 4 + c]!);
          }
        }
        console.log(
          `steps per pixel, ${name} from ${altitude} m: cloud ${sum[0]!.toFixed(1)} (most ${most[0]}), ` +
            `shaded ${sum[1]!.toFixed(1)} (most ${most[1]}), air ${sum[2]!.toFixed(1)} (most ${most[2]})`,
        );
        // The caps hold for every pixel, and the means stay well under them.
        expect(most[0]!).toBeLessThanOrEqual(level.cloudSteps);
        expect(most[2]!).toBeLessThanOrEqual(level.airSteps);
        expect(sum[1]!).toBeLessThan(16);
        if (name === 'clear') expect(sum[0]! + sum[2]!).toBe(0);
        if (name === 'fog') expect(sum[0]!).toBe(0);
      }
    }
    r.dispose();
    head.dispose();
    expect(gpu!.errors).toEqual([]);
  }, 300_000);
});
