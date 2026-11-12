/** Runway paint in TSL (decision 109) against its CPU twin, run as a compute kernel on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../../src/core/coords';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { encodeRunway, offsetPoint } from '../../src/render/sim/infra/infraScene';
import { markingAt, runwayMarks } from '../../src/render/sim/infra/runwayMarkings';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('runway paint (TSL on Dawn)', () => {
  it('matches the CPU layout', async () => {
    const R = PLANET_RADIUS;
    const L = 2800;
    const heading = 62 * DEG; // 06/24
    const center = latLonToDirection(48 * DEG, 11 * DEG);
    const code = Math.fround(encodeRunway(L, heading));
    // A lattice over both ends, the middle and the taxiway, offset off the marks' edges.
    const pts: [number, number][] = [];
    for (const [a0, a1] of [
      [-L / 2 - 10, -L / 2 + 380],
      [-30, 30],
      [L / 2 - 380, L / 2 + 10],
    ]) {
      for (let a = a0 + 0.173; a < a1; a += 1.31) {
        for (let c = -30.07; c < 31; c += 0.53) pts.push([a, c]);
      }
    }
    for (let a = -L / 2; a < L / 2; a += 7.3)
      for (let c = 170.1; c < 380; c += 0.41) pts.push([a, c]);
    const input = new Float32Array(pts.length * 4);
    pts.forEach(([a, c], i) => {
      const d = offsetPoint(center, heading, a, c, R);
      input.set([d.x, d.y, d.z, 0], i * 4);
    });
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const inBuf = instancedArray(input, 'vec4');
    const outBuf = instancedArray(pts.length, 'float');
    const kernel = Fn(() => {
      const p = inBuf.element(instanceIndex).xyz;
      const m = runwayMarks(
        p as Node<'vec3'>,
        vec3(center.x, center.y, center.z) as Node<'vec3'>,
        float(code) as Node<'float'>,
        R,
        float(0.02) as Node<'float'>,
      );
      outBuf.element(instanceIndex).assign(m);
    })().compute(pts.length);
    await head.renderer.computeAsync(kernel);
    const out = new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    let white = 0;
    let yellow = 0;
    let mismatch = 0;
    let gotWhite = 0;
    let gotYellow = 0;
    pts.forEach(([a, c], i) => {
      const want = markingAt(a, c, L, heading);
      // Within float32 precision (about 0.1 m) of an edge, either side counts.
      const near = new Set(
        [-0.15, 0, 0.15].flatMap((da) =>
          [-0.15, 0, 0.15].map((dc) => markingAt(a + da, c + dc, L, heading)),
        ),
      );
      const got = out[i]! > 0.5 ? 'white' : out[i]! < -0.5 ? 'yellow' : null;
      if (want === 'white') white++;
      if (want === 'yellow') yellow++;
      if (got === 'white') gotWhite++;
      if (got === 'yellow') gotYellow++;
      if (!near.has(got)) mismatch++;
    });
    expect(white).toBeGreaterThan(1000);
    expect(yellow).toBeGreaterThan(100);
    expect(mismatch).toBe(0);
    expect(Math.abs(gotWhite - white) / white).toBeLessThan(0.1);
    expect(Math.abs(gotYellow - yellow) / yellow).toBeLessThan(0.1);
  });
});
