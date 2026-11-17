/**
 * Airbases against the eroded world (decision 220): for each airbase of a
 * campaign world, the eroded height over its graded pad (center, mean, least),
 * the share of the pad under water and its grading RMS, at the coarse point and
 * after siting (worldgen/edits/siting.ts). Prints the bases that siting moved
 * and any it could not keep dry, and a summary over the seeds.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/airbaseWater.preview.ts
 *
 * Env: SEEDS (comma list, default 1983), GRES (1024), ALL=1 (every base, not just moved ones).
 */
import { it } from 'vitest';
import { directionToCubeFace } from '../src/core/coords';
import type { CubeFaceUv } from '../src/core/coords';
import { Vec3d } from '../src/core/vec3d';
import { AIRFIELD_FOOTPRINT, globalMapSampler } from '../src/render/sim/infra/airfieldGrading';
import { offsetPoint } from '../src/render/sim/infra/infraScene';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { siteAirfields } from '../src/worldgen/edits';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import type { Airbase } from '../src/worldgen/strategic/infrastructure';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';

it('sites airbases on the eroded world', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('no adapter');
  const seeds = (process.env.SEEDS ?? '1983').split(',').map((s) => s.trim());
  const gres = Number(process.env.GRES ?? 1024);
  const R = DEFAULT_PLANET_PARAMS.radius;
  const summary = [
    '| seed | bases | bad before | moved | bad after | wet left | max move km |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const seed of seeds) {
    const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
    const { global } = await previewWorld(
      gpu,
      { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed },
      256,
      gres,
    );
    const n = global.n;
    const h = globalMapSampler(global.height, n);
    const lake = global.finish.drainage.lakeDepth;
    const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
    const lakeAt = (d: Readonly<Vec3d>) => {
      directionToCubeFace(d, uv);
      const i = Math.min(n - 1, Math.floor(uv.u * n));
      const j = Math.min(n - 1, Math.floor(uv.v * n));
      return lake[(uv.face * n + j) * n + i]! > 0;
    };
    const measure = (b: Airbase) => {
      const p = new Vec3d(...b.point);
      let sum = 0,
        sum2 = 0,
        min = Infinity,
        wet = 0,
        cnt = 0;
      const L = b.runwayLength;
      const { overrun, across0, across1 } = AIRFIELD_FOOTPRINT;
      for (let a = 0; a <= 16; a++) {
        for (let c = 0; c <= 4; c++) {
          const d = offsetPoint(
            p,
            b.heading,
            -L / 2 - overrun + ((L + 2 * overrun) * a) / 16,
            across0 + ((across1 - across0) * c) / 4,
            R,
          );
          const v = h(d);
          sum += v;
          sum2 += v * v;
          min = Math.min(min, v);
          cnt++;
          if (v <= 0 || lakeAt(d)) wet++;
        }
      }
      const mean = sum / cnt;
      return {
        center: h(p),
        mean,
        min,
        wet: wet / cnt,
        rms: Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)),
      };
    };
    const t0 = performance.now();
    const sited = siteAirfields(campaign.infrastructure, R, AIRFIELD_FOOTPRINT, h, lakeAt);
    const ms = performance.now() - t0;
    const rows = [
      '| id | name | kind | before: center / mean / min m, wet %, rms m | moved km, turn ° | after: center / mean / min m, wet %, rms m |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    let badBefore = 0,
      badAfter = 0,
      movedCount = 0,
      maxMove = 0;
    const bad = (m: ReturnType<typeof measure>) => m.wet > 0 || m.rms > 60;
    const fmt = (m: ReturnType<typeof measure>) =>
      `${m.center.toFixed(0)} / ${m.mean.toFixed(0)} / ${m.min.toFixed(0)}, ${(100 * m.wet).toFixed(0)}%, ${m.rms.toFixed(0)}`;
    campaign.infrastructure.airbases.forEach((b, i) => {
      const a = sited.infrastructure.airbases[i]!;
      const m0 = measure(b);
      const m1 = measure(a);
      if (bad(m0)) badBefore++;
      if (bad(m1)) badAfter++;
      const km = sited.moved[i]! / 1000;
      if (a !== b) movedCount++;
      maxMove = Math.max(maxMove, km);
      if (a !== b || bad(m1) || process.env.ALL === '1')
        rows.push(
          `| ${b.id} | ${b.name} | ${b.kind} | ${fmt(m0)} | ${km.toFixed(1)}, ${(((a.heading - b.heading) * 180) / Math.PI).toFixed(0)} | ${fmt(m1)} |`,
        );
    });
    console.log(`\nseed ${seed} (world ${campaign.seed}): siting took ${ms.toFixed(0)} ms`);
    console.log(rows.join('\n'));
    summary.push(
      `| ${seed} | ${campaign.infrastructure.airbases.length} | ${badBefore} | ${movedCount} | ${badAfter} | ${sited.wet.length} | ${maxMove.toFixed(1)} |`,
    );
  }
  console.log('\n' + summary.join('\n'));
}, 36_000_000);
