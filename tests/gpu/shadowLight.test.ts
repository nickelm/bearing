/**
 * Light in the shadows (decision 139), with the real lighting nodes on Dawn:
 * ground the terrain shades keeps a cool sky-lit fill, several stops under
 * ground that faces a low sun but far from black, and the sky's light leans
 * toward the sun, so facets in shadow still differ.
 */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, normalize, select, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { PlanetLighting } from '../../src/render/sim/lighting/planetLighting';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();
const R = PLANET_RADIUS;
type V3 = Node<'vec3'>;

const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

describe.skipIf(!gpu)('light in the shadows (TSL on Dawn)', () => {
  it('keeps shaded ground cool and readable, and leans the sky light toward the sun', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const lighting = new PlanetLighting(R);
    // The camera 100 m over a point on +Y; the sun toward +X.
    const eye = new Vec3d(0, R + 100, 0);
    const tilt = 20 * DEG;
    // Level ground, a facet leaning toward the sun's azimuth, one leaning away, one across,
    // and a slope that faces a low sun squarely.
    const normals = [
      [0, 1, 0],
      [Math.sin(tilt), Math.cos(tilt), 0],
      [-Math.sin(tilt), Math.cos(tilt), 0],
      [0, Math.cos(tilt), Math.sin(tilt)],
      [Math.cos(5 * DEG), Math.sin(5 * DEG), 0],
    ];
    const count = normals.length * 2;
    // The second half of the points lies in a mountain's shadow.
    lighting.terrainShadow = () =>
      select(instanceIndex.greaterThanEqual(normals.length), float(0), float(1)) as Node<'float'>;
    const input = instancedArray(
      Float32Array.from([...normals, ...normals].flatMap((n) => [...n, 0])),
      'vec4',
    );
    const output = instancedArray(count, 'vec4');
    const kernel = Fn(() => {
      const normal = normalize(input.element(instanceIndex).xyz) as V3;
      // The surface 100 m below the camera, camera-relative.
      const relative = vec3(0, -100, 0) as V3;
      output
        .element(instanceIndex)
        .assign(vec4(lighting.shadeDiffuse(vec3(1) as V3, normal, relative), 1));
    })().compute(count);
    const run = async (elevation: number, lean = lighting.skyLean.value) => {
      lighting.skyLean.value = lean;
      lighting.update(eye, new Vec3d(Math.cos(elevation), Math.sin(elevation), 0));
      await head.renderer.computeAsync(kernel);
      const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
      const at = (i: number) => [out[i * 4]!, out[i * 4 + 1]!, out[i * 4 + 2]!];
      return {
        lit: normals.map((_, i) => at(i)),
        shade: normals.map((_, i) => at(normals.length + i)),
      };
    };

    const low = await run(5 * DEG);
    expect(gpu!.errors).toEqual([]);
    const [level, toward, away, across, facing] = low.shade;
    // Shaded ground is lit by the sky alone: blue, where sunlit ground is warm.
    expect(level![2]).toBeGreaterThan(1.5 * level![0]!);
    expect(low.lit[4]![0]).toBeGreaterThan(1.5 * low.lit[4]![2]!);
    // Deep: 3 to 5 stops under a slope that faces the low sun. Not crushed: over 3% of it.
    const stops = Math.log2(luma(low.lit[4]!) / luma(level!));
    expect(stops).toBeGreaterThan(3);
    expect(stops).toBeLessThan(5);
    // Sunlit level ground at 5° takes little direct light: its shadow is about a stop under it.
    const flat = Math.log2(luma(low.lit[0]!) / luma(level!));
    expect(flat).toBeGreaterThan(0.6);
    expect(flat).toBeLessThan(2.5);
    // The sky leans toward the sun: facets in shadow differ by which way they tilt.
    expect(luma(toward!)).toBeGreaterThan(1.1 * luma(across!));
    expect(luma(away!)).toBeLessThan(0.9 * luma(across!));
    expect(luma(away!)).toBeGreaterThan(0.5 * luma(level!));
    // A slope in shadow that faces the sun's side of the sky is the brightest of them.
    expect(luma(facing!)).toBeGreaterThan(0.6 * luma(level!));

    // Without the lean a facet's tilt direction does not matter, and level ground is the same.
    const plain = await run(5 * DEG, 0);
    expect(luma(plain.shade[1]!)).toBeCloseTo(luma(plain.shade[2]!), 5);
    expect(luma(plain.shade[0]!)).toBeCloseTo(luma(level!), 6);

    // A high sun: the lean fades (the sky is brightest overhead), and the shadow is deep.
    const high = await run(60 * DEG, 0.5);
    const spread = luma(high.shade[1]!) / luma(high.shade[2]!);
    expect(spread).toBeGreaterThan(1);
    expect(spread).toBeLessThan(luma(toward!) / luma(away!));
    const noon = Math.log2(luma(high.lit[0]!) / luma(high.shade[0]!));
    expect(noon).toBeGreaterThan(3);
    expect(noon).toBeLessThan(5.5);

    // Under a low sun surfaces are exposed over the sky (decision 139): the sun's light
    // and the sky's on them alike, so the shadow keeps its depth; under a high sun not at all.
    // Without the night's floor of starlight, which the exposure leaves alone.
    lighting.nightLight.value = 0;
    const exposed = await run(5 * DEG, 0.5);
    const gain = lighting.surfaceGain.value;
    expect(gain).toBeGreaterThan(1.6);
    lighting.lowSunExposure = 1;
    const plain5 = await run(5 * DEG, 0.5);
    expect(lighting.surfaceGain.value).toBe(1);
    for (const k of [0, 4]) {
      expect(luma(exposed.lit[k]!) / luma(plain5.lit[k]!)).toBeCloseTo(gain, 2);
      expect(luma(exposed.shade[k]!) / luma(plain5.shade[k]!)).toBeCloseTo(gain, 2);
    }
    lighting.nightLight.value = 0.02;
    const plain60 = await run(60 * DEG, 0.5);
    expect(luma(plain60.lit[0]!)).toBeCloseTo(luma(high.lit[0]!), 5);
    expect(luma(plain60.shade[0]!)).toBeCloseTo(luma(high.shade[0]!), 6);
    lighting.atmosphere.dispose();
    head.dispose();
  }, 120_000);
});
