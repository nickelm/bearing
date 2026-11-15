/** The canopy height field's TSL twin agrees with the CPU (decision 148), on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, ivec3, uint, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { cellHash, canopyLump, canopySeed, standAt } from '../../src/worldgen/canopy';
import { cellHashNode, lumpNode, standNode } from '../../src/render/common/canopyNode';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

async function run(input: Float32Array, body: (row: Node<'vec4'>) => Node<'vec4'>) {
  const n = input.length / 4;
  const inBuf = instancedArray(input, 'vec4');
  const out = instancedArray(n, 'vec4');
  const head = await headlessRenderer(gpu!.device, 64, 64);
  const kernel = Fn(() => {
    out
      .element(instanceIndex)
      .assign(body(inBuf.element(instanceIndex) as unknown as Node<'vec4'>));
  })().compute(n);
  await head.renderer.computeAsync(kernel);
  const r = new Float32Array(await head.renderer.getArrayBufferAsync(out.value));
  head.dispose();
  return r;
}

describe.skipIf(!gpu)('canopy height field (TSL on Dawn)', () => {
  const R = 1_000_000;
  const seed = canopySeed(1983);
  // Points on the sea-level sphere, scattered over a few faces, rounded to float32 as the GPU holds them.
  const pts: number[] = [];
  for (let k = 0; k < 2000; k++) {
    const lat = Math.asin(((k * 0.618034) % 1) * 2 - 1);
    const lon = k * 2.399963;
    const v = [
      R * Math.cos(lat) * Math.sin(lon),
      R * Math.sin(lat),
      R * Math.cos(lat) * Math.cos(lon),
    ];
    pts.push(...v.map((c) => Math.fround(c)), (k % 10) / 10);
  }

  it('hashes cells to the same bits as the CPU', async () => {
    const cells = [
      [0, 0, 0],
      [1, 2, 3],
      [-1, -2, -3],
      [4545, -4545, 17],
      [-123456, 789, -4],
    ];
    const input = Float32Array.from(cells.flatMap((c) => [...c, 0]));
    const r = await run(input, (c) => {
      const h = cellHashNode(ivec3(c.xyz) as never, uint(seed));
      // Split into 16-bit halves: exact in float32.
      return vec4(h.shiftRight(uint(16)).toFloat(), h.bitAnd(uint(0xffff)).toFloat(), 0, 0);
    });
    expect(gpu!.errors).toEqual([]);
    cells.forEach((c, i) => {
      const h = cellHash(c[0]!, c[1]!, c[2]!, seed);
      expect([r[i * 4], r[i * 4 + 1]]).toEqual([h >>> 16, h & 0xffff]);
    });
  });

  it('picks the same stands, heights, shades and lumps as the CPU', async () => {
    const r = await run(Float32Array.from(pts), (c) => {
      const s = standNode(c.xyz as never, c.w as never, vec4(0).x as never, uint(seed));
      return vec4(s.x, s.y, s.z, lumpNode(c.xyz as never, uint(seed)));
    });
    expect(gpu!.errors).toEqual([]);
    let same = 0;
    let lumpErr = 0;
    const n = pts.length / 4;
    for (let k = 0; k < n; k++) {
      const [x, y, z, share] = pts.slice(k * 4, k * 4 + 4) as [number, number, number, number];
      const s = standAt(x, y, z, share, 0, seed);
      const gh = r[k * 4]!;
      if (
        Math.abs(gh - s.height) < 1e-3 &&
        r[k * 4 + 1] === s.conifer &&
        Math.abs(r[k * 4 + 2]! - s.shade) < 1e-5
      )
        same++;
      lumpErr = Math.max(lumpErr, Math.abs(r[k * 4 + 3]! - canopyLump(x, y, z, seed)));
    }
    // Only points within float32's reach of a stand boundary may differ.
    expect(same / n).toBeGreaterThan(0.995);
    // Float32 holds the lattice coordinate (about 22,000 cells out) to about 1e-3 of
    // a cell: a few millimeters of canopy.
    expect(lumpErr).toBeLessThan(5e-3);
  });
});
