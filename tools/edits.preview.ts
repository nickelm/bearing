/**
 * Terrain edits against the rivers (decision 161, N1): which airfield pads of
 * the campaign world lie over a carved river channel, where the protected
 * channels now hold the ground at the carved height instead of filling it.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/edits.preview.ts
 *
 * Env: SEED (default 1983), GRES (global grid, default 1024), STEP (sample
 * spacing over each pad, m, default 25).
 */
import { it } from 'vitest';
import { offsetPoint } from '../src/render/sim/infra/infraScene';
import { InfraScene } from '../src/render/sim/infra/infraScene';
import { airfieldPads, globalMapSampler } from '../src/render/sim/infra/airfieldGrading';
import { tileForDirection } from '../src/core/tiles';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { channelHold, channelsForTile } from '../src/worldgen/edits';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';

it('lists airfield pads over carved river channels', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const t0 = performance.now();
  const campaign = generateCampaignWorld({
    ...DEFAULT_PLANET_PARAMS,
    seed: process.env.SEED ?? '1983',
  });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const R = params.radius;
  const { global } = await previewWorld(gpu, params, 256, Number(process.env.GRES ?? 1024));
  const rivers = new RiverIndex(global.finish.rivers, {
    height: global.height,
    radius: R,
    lakeDepth: global.finish.drainage.lakeDepth,
  });
  const infra = new InfraScene(campaign.graph, campaign.infrastructure, R);
  const pads = airfieldPads(infra, globalMapSampler(global.height, global.n));
  const step = Number(process.env.STEP ?? 25);
  const lists = new Map<string, number[]>();
  let hit = 0;
  for (const [k, pad] of pads.entries()) {
    let samples = 0;
    let held = 0;
    let heldOnPad = 0;
    for (let a = pad.along0 - pad.margin; a <= pad.along1 + pad.margin; a += step) {
      for (let c = pad.across0 - pad.margin; c <= pad.across1 + pad.margin; c += step) {
        const p = offsetPoint(pad.center, pad.heading, a, c, R);
        const t = tileForDirection(p, 7);
        const key = `${t.face}/${t.x}/${t.y}`;
        let ids = lists.get(key);
        if (!ids) lists.set(key, (ids = channelsForTile(rivers, t, R)));
        samples++;
        if (channelHold(rivers.segments, ids, p, R) <= 0) continue;
        held++;
        if (a >= pad.along0 && a <= pad.along1 && c >= pad.across0 && c <= pad.across1) heldOnPad++;
      }
    }
    if (held === 0) continue;
    hit++;
    const b = campaign.infrastructure.airbases[k]!;
    console.log(
      `${b.name} (${b.side}): ${held} of ${samples} samples in a channel's hold, ${heldOnPad} on the pad itself`,
    );
  }
  console.log(
    `seed ${campaign.seed}: ${hit} of ${pads.length} airfields reach a carved channel ` +
      `(${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  );
}, 3_600_000);
