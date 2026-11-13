/**
 * Snow sparkle and wet ground (decision 139): LandShading's `snowSparkle`,
 * `wet` and `wetSheen` as compute kernels on Dawn. Glints are sparse points
 * that crowd toward the sun's reflection, change as the camera moves, vanish
 * in shadow and with distance, and are bright enough for the bloom.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  instanceIndex,
  instancedArray,
  length,
  normalize,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { DEG } from '../../src/core/units';
import { GRADE_BANDS } from '../../src/render/sim/post/grade';
import { LandShading, SPARKLE_RANGE } from '../../src/render/sim/terrain/landShading';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();
type F = Node<'float'>;
type V3 = Node<'vec3'>;

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe.skipIf(!gpu)('snow sparkle and wet ground (TSL on Dawn)', () => {
  it('glints toward a low sun, follows the camera, and needs sunlight and snow', async () => {
    const land = new LandShading();
    // A level snowfield seen from 5 m up: 128 × 128 points a pixel apart (2 cm at 26 m).
    const side = 128;
    const count = side * side;
    const footprintM = 0.02;
    const positions = new Float32Array(count * 4);
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        positions.set([i * footprintM, 0, j * footprintM, 0], (j * side + i) * 4);
      }
    }
    const input = instancedArray(positions, 'vec4');
    const out = instancedArray(count, 'vec4');
    const camera = uniform(new Vector3());
    const sun = uniform(new Vector3());
    const sunlight = uniform(new Vector3(1.2, 1.1, 1.0));
    const snow = uniform(1);
    const footprint = uniform(footprintM);
    /** Spreads the points, to keep them a pixel apart from farther away. */
    const spread = uniform(1);
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const kernel = Fn(() => {
      const p = input
        .element(instanceIndex)
        .xyz.mul(spread)
        .add(vec3(700, 300, 1200)) as V3;
      const toCamera = camera.sub(p);
      out.element(instanceIndex).assign(
        vec4(
          land.snowSparkle({
            snow: snow as unknown as F,
            wrapped: p,
            footprint: footprint as unknown as F,
            distance: length(toCamera) as F,
            normal: vec3(0, 1, 0) as V3,
            view: normalize(toCamera) as V3,
            up: vec3(0, 1, 0) as V3,
            sun: sun as unknown as V3,
            sunlight: sunlight as unknown as V3,
          }),
          0,
        ),
      );
    })().compute(count);
    const run = async () => {
      await head.renderer.computeAsync(kernel);
      const r = new Float32Array(await head.renderer.getArrayBufferAsync(out.value));
      const lit = new Set<number>();
      let peak = 0;
      for (let i = 0; i < count; i++) {
        const y = luma(r[i * 4]!, r[i * 4 + 1]!, r[i * 4 + 2]!);
        if (y > 0.5) lit.add(i);
        peak = Math.max(peak, y);
      }
      return { lit, peak, r };
    };
    const elevation = 12 * DEG;
    const toward = () => sun.value.set(Math.cos(elevation), Math.sin(elevation), 0);
    const away = () => sun.value.set(-Math.cos(elevation), Math.sin(elevation), 0);
    // The camera 26 m short of the patch, which lies toward +x.
    camera.value.set(700 - 26, 305, 1200 + 1.28);

    toward();
    const facing = await run();
    expect(gpu!.errors).toEqual([]);
    // Sparse points: between 0.2% and 6% of the pixels, not a sheet of light.
    expect(facing.lit.size / count).toBeGreaterThan(0.002);
    expect(facing.lit.size / count).toBeLessThan(0.06);
    // Bright enough for the bloom at its day threshold, with the sunlight's warmth.
    expect(facing.peak).toBeGreaterThan(2 * GRADE_BANDS.day.bloom);
    const first = [...facing.lit][0]!;
    expect(facing.r[first * 4]).toBeGreaterThan(facing.r[first * 4 + 2]!);

    // The same frame again: the same points (nothing moves when the camera does not).
    const again = await run();
    expect([...again.lit]).toEqual([...facing.lit]);

    // The camera half a meter to the side: other crystals catch the sun.
    camera.value.z += 0.5;
    const moved = await run();
    expect(moved.lit.size).toBeGreaterThan(0);
    const shared = [...moved.lit].filter((i) => facing.lit.has(i)).length;
    expect(shared).toBeLessThan(0.8 * Math.max(moved.lit.size, facing.lit.size));
    camera.value.z -= 0.5;

    // With the sun behind the camera the mirror direction is far from the surface: none.
    away();
    const behind = await run();
    expect(behind.lit.size).toBe(0);

    // No sunlight (shadow, overcast, night), no snow, or switched off: none.
    toward();
    sunlight.value.set(0, 0, 0);
    expect((await run()).peak).toBe(0);
    sunlight.value.set(1.2, 1.1, 1.0);
    snow.value = 0;
    expect((await run()).peak).toBe(0);
    snow.value = 1;
    land.sparkle.value = 0;
    expect((await run()).peak).toBe(0);
    land.sparkle.value = 1;

    // Far away the glints fade and stop: at 85% of the range they are faint, beyond it gone.
    const far = (distance: number) => {
      const pixel = (distance * 0.785) / 1080;
      footprint.value = pixel;
      spread.value = pixel / footprintM;
      camera.value.set(
        700 - distance * Math.cos(11 * DEG),
        300 + distance * Math.sin(11 * DEG),
        1200 + 64 * pixel,
      );
    };
    far(0.85 * SPARKLE_RANGE);
    const faint = await run();
    expect(faint.peak).toBeGreaterThan(0);
    expect(faint.peak).toBeLessThan(0.3 * facing.peak);
    far(1.05 * SPARKLE_RANGE);
    expect((await run()).peak).toBe(0);
    head.dispose();
  }, 120_000);

  it('darkens and saturates wet ground, and adds a sheen at grazing angles', async () => {
    const land = new LandShading();
    const colors = [
      [0.3, 0.22, 0.12],
      [0.2, 0.2, 0.2],
      [0.12, 0.3, 0.1],
    ];
    // With each color, the cosine of a view angle from the normal: 0°, 60°, 85°.
    const cosines = [1, 0.5, 0.0872];
    const input = instancedArray(
      Float32Array.from(colors.flatMap((c, i) => [...c, cosines[i]!])),
      'vec4',
    );
    const outWet = instancedArray(colors.length, 'vec4');
    const outSheen = instancedArray(colors.length, 'vec4');
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const kernel = Fn(() => {
      const c = input.element(instanceIndex).xyz as V3;
      outWet.element(instanceIndex).assign(vec4(land.wet(c), 0));
      const cosine = input.element(instanceIndex).w;
      const view = vec3(cosine.mul(cosine).oneMinus().sqrt(), cosine, 0);
      outSheen
        .element(instanceIndex)
        .assign(
          vec4(
            land.wetSheen(
              vec3(0, 1, 0) as V3,
              view as V3,
              vec3(0.2, 0.3, 0.5) as V3,
              vec4(1).x as F,
            ),
            0,
          ),
        );
    })().compute(colors.length);
    const run = async () => {
      await head.renderer.computeAsync(kernel);
      return {
        wet: new Float32Array(await head.renderer.getArrayBufferAsync(outWet.value)),
        sheen: new Float32Array(await head.renderer.getArrayBufferAsync(outSheen.value)),
      };
    };
    const dry = await run();
    expect(gpu!.errors).toEqual([]);
    colors.forEach((c, i) => {
      for (let k = 0; k < 3; k++) expect(dry.wet[i * 4 + k]).toBeCloseTo(c[k]!, 6);
      expect(dry.sheen[i * 4 + 2]).toBe(0);
    });
    land.wetness.value = 1;
    const wet = await run();
    const saturation = (r: number, g: number, b: number) =>
      (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
    colors.forEach((c, i) => {
      const [r, g, b] = [wet.wet[i * 4]!, wet.wet[i * 4 + 1]!, wet.wet[i * 4 + 2]!];
      // About 60% as bright, and no less saturated.
      expect(luma(r, g, b) / luma(c[0]!, c[1]!, c[2]!)).toBeCloseTo(0.6, 1);
      expect(saturation(r, g, b)).toBeGreaterThanOrEqual(saturation(c[0]!, c[1]!, c[2]!) - 1e-6);
    });
    // Earth and leaves gain saturation; gray stays gray.
    expect(saturation(wet.wet[0]!, wet.wet[1]!, wet.wet[2]!)).toBeGreaterThan(
      saturation(0.3, 0.22, 0.12) + 0.05,
    );
    expect(saturation(wet.wet[4]!, wet.wet[5]!, wet.wet[6]!)).toBeLessThan(1e-5);
    // The sheen: 4% of the sky head-on, more toward grazing angles, never more than the sky.
    expect(wet.sheen[2]).toBeCloseTo(0.04 * 0.5, 4);
    expect(wet.sheen[4 + 2]).toBeGreaterThan(wet.sheen[2]!);
    expect(wet.sheen[8 + 2]).toBeGreaterThan(4 * wet.sheen[2]!);
    expect(wet.sheen[8 + 2]).toBeLessThan(0.5);
    // Half wet: in between.
    land.wetness.value = 0.5;
    const half = await run();
    expect(half.wet[0]).toBeGreaterThan(wet.wet[0]!);
    expect(half.wet[0]).toBeLessThan(colors[0]![0]!);
    head.dispose();
  }, 120_000);
});
