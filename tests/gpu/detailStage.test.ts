import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../../src/core/cubeGrid';
import { neighborCell } from '../../src/core/faceAdjacency';
import { DETAIL_TUNING, octavesFor, runDetailStage } from '../../src/worldgen/gpu/detailStage';
import { GlobalGrid } from '../../src/worldgen/gpu/globalGrid';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { expectNoGpuErrors, testGpu } from './device';

const gpu = await testGpu();

describe('octavesFor', () => {
  it('stops before the wavelength drops below three cells', () => {
    const n = 1024;
    const o = octavesFor(60, n);
    const cell = Math.PI / 2 / n;
    expect((2 * Math.PI) / (60 * 2 ** (o - 1))).toBeGreaterThanOrEqual(3 * cell);
    expect((2 * Math.PI) / (60 * 2 ** o)).toBeLessThan(3 * cell);
    expect(octavesFor(60, 2048)).toBe(o + 1);
  });
});

describe.skipIf(!gpu)('detail stage (GPU)', () => {
  const T = 64;
  const N = 192;
  const params = { ...DEFAULT_PLANET_PARAMS, seed: 7 };
  const world = generateWorld(params, { resolution: T });
  const tectonic = { n: T, height: world.maps.height, uplift: world.maps.uplift };

  const run = async () => {
    const g = new GlobalGrid(gpu!, N);
    await expectNoGpuErrors(gpu!, async () => {
      runDetailStage(g, tectonic, params.seed, params.reliefScale);
    });
    const h = await g.readF32('height');
    const u = await g.readF32('uplift');
    g.dispose();
    return { h, u };
  };

  it('is finite, deterministic and keeps the land fraction', async () => {
    const a = await run();
    const b = await run();
    expect(Buffer.from(a.h.buffer).equals(Buffer.from(b.h.buffer))).toBe(true);
    const grid = new CubeGrid(N);
    let land = 0;
    let total = 0;
    for (let c = 0; c < grid.cellCount; c++) {
      expect(Number.isFinite(a.h[c]!)).toBe(true);
      total += grid.areas[c]!;
      if (a.h[c]! > 0) land += grid.areas[c]!;
    }
    expect(Math.abs(land / total - world.info.landFraction)).toBeLessThan(0.04);
  });

  it('follows the tectonic heights', async () => {
    const { h } = await run();
    // Box-average back down to T and correlate with the tectonic input.
    const k = N / T;
    const down = new Float64Array(6 * T * T);
    for (let c = 0; c < 6 * N * N; c++) {
      const face = Math.floor(c / (N * N));
      const r = c % (N * N);
      const j = Math.floor(r / N);
      const i = r % N;
      down[(face * T + Math.floor(j / k)) * T + Math.floor(i / k)]! += h[c]! / (k * k);
    }
    const x = world.maps.height;
    let sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0;
    const m = x.length;
    for (let c = 0; c < m; c++) {
      sx += x[c]!;
      sy += down[c]!;
      sxx += x[c]! ** 2;
      syy += down[c]! ** 2;
      sxy += x[c]! * down[c]!;
    }
    const corr = (sxy - (sx * sy) / m) / Math.sqrt((sxx - sx ** 2 / m) * (syy - sy ** 2 / m));
    expect(corr).toBeGreaterThan(0.9);
  });

  it('is continuous across face seams', async () => {
    const { h } = await run();
    let seam = 0,
      seamN = 0,
      inner = 0,
      innerN = 0;
    for (let c = 0; c < 6 * N * N; c++) {
      const r = c % (N * N);
      const i = r % N;
      const nb = neighborCell(N, c, 1, 0);
      const d = Math.abs(h[nb]! - h[c]!);
      if (i === N - 1) {
        seam += d;
        seamN++;
      } else {
        inner += d;
        innerN++;
      }
    }
    // Steps across a seam should look like steps anywhere else.
    expect(seam / seamN).toBeLessThan(1.5 * (inner / innerN));
  });

  it('exposes its tuning', () => {
    expect(DETAIL_TUNING.warpAmplitude).toBeGreaterThan(0);
  });
});
