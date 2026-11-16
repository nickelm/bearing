/** River coverage in TSL (decision 46), run as a compute kernel on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../../src/core/coords';
import { tileForDirection } from '../../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { RiverShading } from '../../src/render/common/water/riverShading';
import { offsetPoint } from '../../src/render/sim/infra/infraScene';
import { RiverTables } from '../../src/render/common/water/riverTables';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { straightRiver } from '../helpers/rivers';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('river coverage (TSL on Dawn)', () => {
  it('covers the river by its width, crisp at fine footprints, faded when sub-pixel', async () => {
    const R = PLANET_RADIUS;
    const tables = new RiverTables(new RiverIndex(straightRiver(40)), R);
    const shading = new RiverShading(tables, R);
    // Physical coverage for the checks (the app draws thin rivers more legibly).
    shading.legibility.value = 0;
    shading.minPixels.value = 1;
    // Smooth banks for exact edges; natural banks are tested below.
    shading.natural.value = 0;
    const range = tables.rangeFor(tileForDirection(latLonToDirection(0, 10.25 * DEG), 9));
    // Points north of the river (at lon 10.25°), at these distances (m), with footprints (m/px).
    const cases: [number, number][] = [
      [0, 1],
      [15, 1],
      [19.4, 1],
      [20.6, 1],
      [30, 1],
      [0, 400],
      [300, 400],
    ];
    const input = new Float32Array(cases.length * 4);
    cases.forEach(([dist, fp], i) => {
      const d = latLonToDirection(dist / R, 10.25 * DEG).scale(R + 50);
      input.set([d.x, d.y, d.z, fp], i * 4);
    });
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const inBuf = instancedArray(input, 'vec4');
    const run = async () => {
      const outBuf = instancedArray(cases.length, 'vec4');
      const kernel = Fn(() => {
        const p = inBuf.element(instanceIndex);
        const c = shading.coverage(
          p.xyz,
          float(range.start) as Node<'float'>,
          float(range.count) as Node<'float'>,
          p.w,
        );
        outBuf.element(instanceIndex).assign(vec4(c.x, c.y, 0, 0));
      })().compute(cases.length);
      await head.renderer.computeAsync(kernel);
      return new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
    };
    const out = await run();
    // As the app draws them: at least 2 px wide, at 0.8 strength.
    shading.legibility.value = 0.8;
    shading.minPixels.value = 2;
    const legible = await run();
    head.dispose();
    const cover = cases.map((_, i) => out[i * 4]!);
    // With legibility 0, drawn and true coverage agree.
    cases.forEach((_, i) => expect(out[i * 4 + 1]).toBeCloseTo(out[i * 4]!, 6));
    // Drawn legibly, the sub-pixel river covers most of its widened line; its true
    // fraction, which alone reflects the sun (decision 120), stays about 40/800.
    expect(legible[5 * 4]).toBeGreaterThan(0.5);
    expect(legible[5 * 4 + 1]).toBeGreaterThan(0.02);
    expect(legible[5 * 4 + 1]).toBeLessThan(0.15);
    expect(gpu!.errors).toEqual([]);
    expect(cover[0]).toBeCloseTo(1, 3); // on the centerline
    expect(cover[1]).toBeCloseTo(1, 3); // inside the 20 m half-width
    expect(cover[2]).toBeGreaterThan(0.8); // just inside the bank
    expect(cover[3]).toBeLessThan(0.2); // just outside
    expect(cover[4]).toBe(0);
    // A 40 m river in 400 m pixels: about 40/400 of the pixel, not 0 or 1.
    expect(cover[5]).toBeGreaterThan(0.05);
    expect(cover[5]).toBeLessThan(0.2);
    // Under a pixel from the river: only the antialiasing ramp's tail.
    expect(cover[6]).toBeLessThan(0.05);
  });

  it('draws natural banks: wandering, swelling and ragged, smooth along the river (decision 167)', async () => {
    const R = PLANET_RADIUS;
    // An oblique river (not along an axis or the equator), where a float32 side test
    // against the segment's plane would flip at random: 8.4 km from C heading 35°.
    const C = latLonToDirection(37 * DEG, 23 * DEG);
    const H = 35 * DEG;
    const river = straightRiver(40);
    for (let i = 0; i < 8; i++) {
      const q = offsetPoint(C, H, i * 1200, 0, R);
      river.points.set([q.x, q.y, q.z], i * 3);
    }
    const tables = new RiverTables(new RiverIndex(river), R);
    const shading = new RiverShading(tables, R);
    shading.legibility.value = 0;
    shading.minPixels.value = 1;
    const range = tables.rangeFor(tileForDirection(offsetPoint(C, H, 2400, 0, R), 9));
    // 160 stations 5 m apart along the river, each sampled across it every 0.5 m out to 80 m.
    const stations = 160;
    const across = 321;
    const input = new Float32Array(stations * across * 4);
    for (let k = 0; k < stations; k++) {
      for (let j = 0; j < across; j++) {
        const d = offsetPoint(C, H, 2000 + k * 5, -80 + 0.5 * j, R).scale(R + 50);
        input.set([d.x, d.y, d.z, 0.25], (k * across + j) * 4);
      }
    }
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const inBuf = instancedArray(input, 'vec4');
    const run = async () => {
      const outBuf = instancedArray(stations * across, 'vec4');
      const kernel = Fn(() => {
        const p = inBuf.element(instanceIndex);
        const c = shading.coverage(
          p.xyz,
          float(range.start) as Node<'float'>,
          float(range.count) as Node<'float'>,
          p.w,
        );
        outBuf.element(instanceIndex).assign(vec4(c.x, c.w, 0, 0));
      })().compute(stations * across);
      await head.renderer.computeAsync(kernel);
      return new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
    };
    const out = await run();
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    // Each station's banks: the first and last samples drawn as water.
    const left: number[] = [];
    const right: number[] = [];
    for (let k = 0; k < stations; k++) {
      let lo = -1;
      let hi = -1;
      for (let j = 0; j < across; j++) {
        if (out[(k * across + j) * 4]! < 0.5) continue;
        if (lo < 0) lo = j;
        hi = j;
      }
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeLessThan(across - 1);
      // One channel: no dry gap between the banks (the river must not split).
      for (let j = lo; j <= hi; j++) expect(out[(k * across + j) * 4]!).toBeGreaterThan(0.2);
      left.push(-80 + 0.5 * lo);
      right.push(-80 + 0.5 * hi);
    }
    const width = left.map((l, k) => right[k]! - l);
    console.log('natural banks', {
      width: [Math.min(...width), Math.max(...width)],
      center: [
        Math.min(...left.map((l, k) => 0.5 * (l + right[k]!))),
        Math.max(...left.map((l, k) => 0.5 * (l + right[k]!))),
      ],
    });
    const center = left.map((l, k) => 0.5 * (l + right[k]!));
    const sd = (xs: number[]) => {
      const m = xs.reduce((a, x) => a + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
    };
    // Within the bounds the noise allows (it stays within about ±0.6): half-width 20 m,
    // swell 0.6, wander 40 m, rough 0.35 + 0.18 of the half-width.
    for (let k = 0; k < stations; k++) {
      expect(width[k]).toBeGreaterThan(2 * (20 * (1 - 0.36) - 6.4) - 1);
      expect(width[k]).toBeLessThan(2 * (20 * (1 + 0.36) + 6.4) + 1);
      expect(Math.abs(center[k]!)).toBeLessThan(0.6 * 40 + 6.4 + 1);
    }
    // It does vary: the width and the course both move along the river.
    expect(sd(width)).toBeGreaterThan(2);
    expect(sd(center)).toBeGreaterThan(3);
    // And smoothly: banks 5 m apart along the river move by little.
    for (let k = 1; k < stations; k++) {
      expect(Math.abs(left[k]! - left[k - 1]!)).toBeLessThan(5);
      expect(Math.abs(right[k]! - right[k - 1]!)).toBeLessThan(5);
    }
    // A dark bank band lies outside the water at some stations on each side.
    let banked = 0;
    for (let k = 0; k < stations; k++) {
      const j = Math.round((left[k]! - 2 + 80) / 0.5);
      if (j >= 0 && out[(k * across + j) * 4 + 1]! > 0.5) banked++;
    }
    expect(banked).toBeGreaterThan(stations / 2);
  });

  it('keeps distant and widened rivers smooth', async () => {
    const R = PLANET_RADIUS;
    const tables = new RiverTables(new RiverIndex(straightRiver(40)), R);
    const shading = new RiverShading(tables, R);
    const range = tables.rangeFor(tileForDirection(latLonToDirection(0, 10.25 * DEG), 9));
    // A 40 m river seen at 30 m per pixel, at points across it along 1 km.
    const n = 400;
    const input = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const d = latLonToDirection(
        ((i % 20) * 6 - 57) / R,
        10.25 * DEG + (Math.floor(i / 20) * 50) / R,
      );
      d.scale(R + 50);
      input.set([d.x, d.y, d.z, 30], i * 4);
    }
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const inBuf = instancedArray(input, 'vec4');
    const run = async () => {
      const outBuf = instancedArray(n, 'vec4');
      const kernel = Fn(() => {
        const p = inBuf.element(instanceIndex);
        outBuf
          .element(instanceIndex)
          .assign(
            shading.coverage(
              p.xyz,
              float(range.start) as Node<'float'>,
              float(range.count) as Node<'float'>,
              p.w,
            ),
          );
      })().compute(n);
      await head.renderer.computeAsync(kernel);
      return new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
    };
    const natural = await run();
    shading.natural.value = 0;
    const smooth = await run();
    head.dispose();
    for (let i = 0; i < n * 4; i++) expect(natural[i]).toBeCloseTo(smooth[i]!, 5);
  });
});
