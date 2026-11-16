/**
 * River invariants on the eroded worlds (decision 161, N2): the measurements
 * of `worldgen/channels/invariants.ts` on each seed's global rivers, as the
 * app builds its `RiverIndex`, printed as a table.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/riverInvariants.preview.ts
 *
 * Env: SEEDS (comma list, default 1983), GRES (global grid, default 1024).
 * Worlds are cached on disk (tools/previewWorld.ts); a new one takes about
 * ten minutes on lavapipe.
 */
import { it } from 'vitest';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { median, riverInvariants } from '../src/worldgen/channels/invariants';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';

it('measures river invariants on eroded worlds', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const gres = Number(process.env.GRES ?? 1024);
  const rows: string[] = [
    '| seed | km | rises | junction rises | gaps | bed humps | on grid (uniform) | stair-steps / 1000 km | sinuosity median (n) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of (process.env.SEEDS ?? '1983').split(',')) {
    const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: s });
    const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
    const R = params.radius;
    const { global } = await previewWorld(gpu, params, 256, gres);
    const t0 = performance.now();
    const index = new RiverIndex(global.finish.rivers, {
      height: global.height,
      radius: R,
      lakeDepth: global.finish.drainage.lakeDepth,
      planform: process.env.SIGMA === undefined ? {} : { sigma: Number(process.env.SIGMA) },
    });
    const r = riverInvariants(index, global.finish.rivers.downstream, {
      radius: R,
      cellSize: ((Math.PI / 2) * R) / global.n,
    });
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
    rows.push(
      `| ${s} | ${Math.round(r.length / 1000)} | ${r.surfaceRises} (max ${r.maxSurfaceRise.toFixed(3)} m) | ` +
        `${r.junctionRises} | ${r.junctionGaps} | ${r.bedMaxima} (max ${r.maxBedHump.toFixed(3)} m) | ` +
        `${pct(r.gridAligned)} (${pct(r.gridAlignedUniform)}) | ${r.stairStepsPer1000Km.toFixed(1)} | ` +
        `${median(r.sinuosity).toFixed(2)} (${r.sinuosity.length}) |`,
    );
    console.log(`seed ${s}: index and measures in ${Math.round(performance.now() - t0)} ms`);
  }
  console.log(rows.join('\n'));
}, 7_200_000);
