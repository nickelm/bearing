/**
 * Global-grid benchmark (TODO: "Benchmark erosion memory and time on a global
 * grid at 1024² and 2048² per face"). Runs the GPU stages on Dawn and prints
 * GPU memory held in grid maps and time per stage.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/bench.preview.ts
 *   env: SIZES (1024,2048), ITER (erosion iterations to time, 300)
 */
import { it } from 'vitest';
import { runDetailStage } from '../src/worldgen/gpu/detailStage';
import { EROSION_TUNING, runErosion } from '../src/worldgen/gpu/erosion';
import { GlobalGrid } from '../src/worldgen/gpu/globalGrid';
import { upsampleMap } from '../src/worldgen/gpu/upsample';
import { DEFAULT_PLANET_PARAMS as P } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { testGpu } from '../tests/gpu/device';

it('benchmark global grid', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No GPU adapter (Dawn)');
  const sizes = (process.env.SIZES ?? '1024,2048').split(',').map(Number);
  const iterations = Number(process.env.ITER ?? 300);
  const T = 256;
  let t0 = performance.now();
  const world = generateWorld(P, { resolution: T });
  const lines = [`tectonic ${T}: ${(performance.now() - t0).toFixed(0)} ms (CPU, Node)`];
  for (const n of sizes) {
    const g = new GlobalGrid(gpu, n);
    t0 = performance.now();
    runDetailStage(
      g,
      { n: T, height: world.maps.height, uplift: world.maps.uplift },
      P.seed,
      P.reliefScale,
    );
    upsampleMap(g, T, world.maps.precipitation, 'precipitation');
    await gpu.finish();
    const detail = performance.now() - t0;
    t0 = performance.now();
    await runErosion(g, {
      reliefScale: P.reliefScale,
      radius: P.radius,
      erosionStrength: iterations / EROSION_TUNING.iterations,
    });
    const erosion = performance.now() - t0;
    t0 = performance.now();
    await g.readF32('height');
    const readback = performance.now() - t0;
    const perIt = erosion / iterations;
    lines.push(
      `N ${n}: cells ${(g.cellCount / 1e6).toFixed(1)} M, peak maps ${(g.peakBytes / 2 ** 20).toFixed(0)} MiB, ` +
        `detail+upsample ${detail.toFixed(0)} ms, erosion ${perIt.toFixed(1)} ms/iteration ` +
        `(${((perIt * EROSION_TUNING.iterations) / 1000).toFixed(1)} s for ${EROSION_TUNING.iterations}, incl. initial fill), ` +
        `height readback ${readback.toFixed(0)} ms`,
    );
    if (gpu.errors.length) lines.push(`GPU errors: ${gpu.errors.join(' | ')}`);
    g.dispose();
  }
  console.log(lines.join('\n'));
  throw new Error(`BENCH\n${lines.join('\n')}`);
}, 1_800_000);
