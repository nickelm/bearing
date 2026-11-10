/**
 * The climate texture's TSL lookup, run as a compute kernel by three's
 * WebGPURenderer on Dawn: the shader face/uv must match core/coords.ts, and
 * sampling at cell centers must return the cells' climate.
 */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import {
  cubeFaceUvToDirection,
  directionToCubeFace,
  randomUnitVector,
} from '../../src/core/coords';
import type { CubeFace } from '../../src/core/coords';
import { rng } from '../../src/core/rng';
import { Vec3d } from '../../src/core/vec3d';
import { ClimateTexture, climateTexels, cubeFaceUv } from '../../src/render/climateTexture';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';
import type { HeadlessRenderer } from './renderer';

const gpu = await testGpu();

/** Runs `body(direction) → vec4` over `dirs` on the GPU and returns the results. */
async function evaluate(
  dirs: Float32Array,
  body: (d: Node<'vec4'>) => Node<'vec4'>,
  shared?: HeadlessRenderer,
): Promise<Float32Array> {
  const head = shared ?? (await headlessRenderer(gpu!.device, 64, 64));
  const count = dirs.length / 4;
  const input = instancedArray(dirs, 'vec4');
  const output = instancedArray(count, 'vec4');
  const kernel = Fn(() => {
    output.element(instanceIndex).assign(body(input.element(instanceIndex)));
  })().compute(count);
  await head.renderer.computeAsync(kernel);
  const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
  if (!shared) head.dispose();
  return out;
}

describe.skipIf(!gpu)('climate texture (TSL on Dawn)', () => {
  it('maps directions to the same cube face and (u, v) as core/coords', async () => {
    const r = rng(1, 'test/cube-face-uv');
    const n = 4096;
    const dirs = new Float32Array(n * 4);
    const d = new Vec3d();
    for (let i = 0; i < n; i++) {
      randomUnitVector(r, d);
      dirs.set([d.x, d.y, d.z, 0], i * 4);
    }
    const out = await evaluate(dirs, (p) => {
      const { face, uv } = cubeFaceUv(p.xyz);
      return vec4(uv, float(face), 0) as Node<'vec4'>;
    });
    let checked = 0;
    for (let i = 0; i < n; i++) {
      d.set(dirs[i * 4]!, dirs[i * 4 + 1]!, dirs[i * 4 + 2]!);
      // Skip near-ties between axes, where float32 may pick the other face.
      const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)].sort((x, y) => y - x);
      if (a[0]! - a[1]! < 1e-5) continue;
      const ref = directionToCubeFace(d);
      expect(out[i * 4 + 2]).toBe(ref.face);
      expect(out[i * 4]).toBeCloseTo(ref.u, 5);
      expect(out[i * 4 + 1]).toBeCloseTo(ref.v, 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(n * 0.99);
  });

  it('returns each cell’s climate at its center', async () => {
    const world = generateWorld({ ...DEFAULT_PLANET_PARAMS, seed: 5 }, { resolution: 16 });
    const n = world.info.resolution;
    const climate = new ClimateTexture();
    climate.setWorld(world);
    const texels = climateTexels(world);
    const cells = 6 * n * n;
    const dirs = new Float32Array(cells * 4);
    const d = new Vec3d();
    for (let c = 0; c < cells; c++) {
      const face = Math.floor(c / (n * n)) as CubeFace;
      cubeFaceUvToDirection(face, ((c % n) + 0.5) / n, ((Math.floor(c / n) % n) + 0.5) / n, d);
      dirs.set([d.x, d.y, d.z, 0], c * 4);
    }
    const out = await evaluate(dirs, (p) => climate.sample(p.xyz));
    for (let c = 0; c < cells; c++) {
      for (let k = 0; k < 4; k++) {
        const want = texels[c * 4 + k]!;
        // Half floats: about 3 significant digits.
        expect(Math.abs(out[c * 4 + k]! - want)).toBeLessThan(0.02 + Math.abs(want) * 2e-3);
      }
    }
  });

  it('resizes when a world arrives after the placeholder was already on the GPU', async () => {
    // The app draws before any world exists, so the 1×1 placeholder is uploaded first.
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const climate = new ClimateTexture();
    const probe = new Float32Array([0, 0, 1, 0]);
    await evaluate(probe, (p) => climate.sample(p.xyz), head);
    const before = gpu!.errors.length;
    const world = generateWorld({ ...DEFAULT_PLANET_PARAMS, seed: 5 }, { resolution: 16 });
    climate.setWorld(world);
    const n = world.info.resolution;
    const c = (4 * n + n / 2) * n + n / 2; // a cell on face +Z
    const d = cubeFaceUvToDirection(4, (n / 2 + 0.5) / n, (n / 2 + 0.5) / n);
    const out = await evaluate(
      new Float32Array([d.x, d.y, d.z, 0]),
      (p) => climate.sample(p.xyz),
      head,
    );
    head.dispose();
    expect(gpu!.errors.slice(before)).toEqual([]);
    expect(out[0]).toBeCloseTo(climateTexels(world)[c * 4]!, 1);
  });
});
