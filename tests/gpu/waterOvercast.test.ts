/**
 * Water under cloud (water/waterShading.ts) with the real lighting nodes on
 * Dawn: flat sea seen at a grazing angle mirrors the sky. Under a closed deck
 * that is the deck's gray underside, as bright as the even sky that gives the
 * ground the light it has there, not the clear sky behind the deck and not a
 * third of the deck.
 */
import { describe, expect, it } from 'vitest';
import { FloatType, NodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, float, instanceIndex, instancedArray, uniform, vec3, vec4 } from 'three/tsl';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { SKY_MARCH_STEPS_COARSE } from '../../src/render/sim/atmosphere/skyView';
import {
  OVERCAST_GAIN,
  OVERCAST_TINT,
  PlanetLighting,
} from '../../src/render/sim/lighting/planetLighting';
import { FLASH_MIRROR, WaterShading } from '../../src/render/sim/water/waterShading';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();
const R = PLANET_RADIUS;
type V3 = Node<'vec3'>;
type F = Node<'float'>;

const luma = (c: ArrayLike<number>) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

describe.skipIf(!gpu)('water under cloud (TSL on Dawn)', () => {
  it('mirrors a closed deck as bright as the light it sends down, and gray', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const lighting = new PlanetLighting(R);
    const overcast = uniform(0);
    const sunThrough = uniform(1);
    lighting.overcast = () => overcast as unknown as F;
    lighting.sunVisibility = () => sunThrough as unknown as F;
    // The camera 100 m over the sea on +Y; the sun 30° up toward +X.
    const eye = new Vec3d(0, R + 100, 0);
    lighting.update(eye, new Vec3d(Math.cos(30 * DEG), Math.sin(30 * DEG), 0));
    lighting.atmosphere.bakeSky(head.renderer);

    // Flat, deep, open sea 85° from the vertical, looking away from the sun.
    const water = new WaterShading(lighting);
    water.waveStrength.value = 0;
    water.foamStrength.value = 0;
    const incidence = 85 * DEG;
    const material = new NodeMaterial();
    material.fragmentNode = vec4(
      water.shade({
        albedo: vec3(0.2) as V3,
        bed: vec3(0.05) as V3,
        temperature: float(20) as F,
        normal: vec3(0, 1, 0) as V3,
        height: float(-500) as F,
        lake: float(-1) as F,
        river: float(0) as F,
        shore: float(5000) as F,
        up: vec3(0, 1, 0) as V3,
        relative: vec3(-100 * Math.tan(incidence), -100, 0) as V3,
        wavePosition: vec3(0) as V3,
      }),
      1,
    );
    const quad = new QuadMesh(material);
    const target = new RenderTarget(64, 4, { type: FloatType, depthBuffer: false });
    const seen = async (): Promise<number[]> => {
      const before = head.renderer.getRenderTarget();
      head.renderer.setRenderTarget(target);
      quad.render(head.renderer);
      head.renderer.setRenderTarget(before);
      await gpu!.finish();
      const pixels = (await head.renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        64,
        4,
      )) as Float32Array;
      return [pixels[0]!, pixels[1]!, pixels[2]!];
    };

    // The clear sky's radiance, cosine-weighted over the hemisphere: the radiance of the
    // even sky that would light level ground as this one does.
    const azimuths = 96;
    const elevations = 48;
    const directions = new Float32Array(azimuths * elevations * 4);
    for (let j = 0; j < elevations; j++) {
      const elevation = ((j + 0.5) / elevations) * (Math.PI / 2);
      for (let i = 0; i < azimuths; i++) {
        const azimuth = ((i + 0.5) / azimuths) * 2 * Math.PI;
        directions.set(
          [
            Math.cos(elevation) * Math.cos(azimuth),
            Math.sin(elevation),
            Math.cos(elevation) * Math.sin(azimuth),
            0,
          ],
          (j * azimuths + i) * 4,
        );
      }
    }
    const input = instancedArray(directions, 'vec4');
    const output = instancedArray(azimuths * elevations, 'vec4');
    const kernel = Fn(() => {
      const direction = input.element(instanceIndex).xyz as V3;
      output
        .element(instanceIndex)
        .assign(vec4(lighting.atmosphere.skyRadiance(direction, SKY_MARCH_STEPS_COARSE), 0));
    })().compute(azimuths * elevations);
    await head.renderer.computeAsync(kernel);
    const radiance = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    const mean = [0, 0, 0];
    let weights = 0;
    for (let j = 0; j < elevations; j++) {
      const elevation = ((j + 0.5) / elevations) * (Math.PI / 2);
      const weight = Math.cos(elevation) * Math.sin(elevation);
      for (let i = 0; i < azimuths; i++) {
        for (let c = 0; c < 3; c++) mean[c]! += radiance[(j * azimuths + i) * 4 + c]! * weight;
        weights += weight;
      }
    }
    const even = luma(mean.map((x) => x / weights));

    // Under the open sky the water is blue: it mirrors the sky near the horizon.
    const open = await seen();
    expect(open[2]!).toBeGreaterThan(1.15 * open[0]!);

    // Under a thin closed deck, the sun hidden: the mirror image of a gray sky as bright as
    // the light on the ground under it (the clear sky's times OVERCAST_GAIN). Fresnel's share
    // at 85°, and a few percent on top from the water's own body.
    overcast.value = 0.35;
    sunThrough.value = 0;
    const fresnel = 0.02 + 0.98 * (1 - Math.cos(incidence)) ** 5;
    const deck = even * OVERCAST_GAIN[0];
    const under = await seen();
    console.log(
      `  water at 85° under a thin deck: ${under.map((x) => x.toFixed(4)).join(', ')}; ` +
        `the deck's mirror image should be ${(fresnel * deck).toFixed(4)} (open sky: ${open.map((x) => x.toFixed(4)).join(', ')})`,
    );
    expect(luma(under)).toBeGreaterThan(0.9 * fresnel * deck);
    expect(luma(under)).toBeLessThan(1.2 * fresnel * deck);
    // Gray, with the deck's tint: no blue of the sky behind it.
    expect(under[2]! / under[0]!).toBeGreaterThan(0.98 * (OVERCAST_TINT[2] / OVERCAST_TINT[0]));
    expect(under[2]! / under[0]!).toBeLessThan(1.1 * (OVERCAST_TINT[2] / OVERCAST_TINT[0]));

    // Under the deepest storm it is darker by the storm's gain.
    overcast.value = 1;
    const storm = await seen();
    expect(luma(storm) / luma(under)).toBeGreaterThan(0.8 * (OVERCAST_GAIN[1] / OVERCAST_GAIN[0]));
    expect(luma(storm) / luma(under)).toBeLessThan(1.25 * (OVERCAST_GAIN[1] / OVERCAST_GAIN[0]));

    // A lightning flash right over the water, by day, in deep twilight and by night: the
    // water mirrors the cloud's glow, a share of the flash's light on surfaces, whatever the
    // hour. (That light was divided by the sky's gains on surfaces, which fall to zero by
    // night: the water under a storm turned white, 380 display units, in every flash.)
    const strongest = 0.6;
    for (const elevation of [30, -16, -30]) {
      lighting.update(eye, new Vec3d(Math.cos(elevation * DEG), Math.sin(elevation * DEG), 0));
      lighting.atmosphere.bakeSky(head.renderer);
      lighting.flashLight.value.set(0, 0, 0);
      const dark = await seen();
      lighting.flashPosition.value.set(-100 * Math.tan(incidence), R, 0);
      lighting.flashLight.value.set(strongest, strongest, strongest);
      const flashed = await seen();
      const added = luma(flashed) - luma(dark);
      console.log(
        `  a flash over the water, sun ${elevation}°: ${luma(dark).toFixed(4)} → ${luma(flashed).toFixed(4)}`,
      );
      expect(added).toBeGreaterThan(0.9 * fresnel * FLASH_MIRROR * strongest);
      expect(added).toBeLessThan(1.25 * fresnel * FLASH_MIRROR * strongest);
    }
    // By night it stays under the bloom's threshold there (0.3).
    expect(luma(await seen())).toBeLessThan(0.3);
    lighting.flashLight.value.set(0, 0, 0);
    expect(gpu!.errors).toEqual([]);
    target.dispose();
    material.dispose();
    head.dispose();
  }, 120_000);
});
