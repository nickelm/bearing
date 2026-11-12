/**
 * Lists the landscape spots of a world (tools/landscapeSpots.ts) and writes
 * them to tools/out/spots-<seed>.json, for LAT/LON in relief.preview.ts and
 * SPOTS in render.preview.ts.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/spots.preview.ts --silent=false
 *   env: SEED (1983), TRES (256), GRES (1024)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { DEG } from '../src/core/units';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { testGpu } from '../tests/gpu/device';
import { findSpots } from './landscapeSpots';
import { previewWorld } from './previewWorld';

it('lists landscape spots', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const seed = Number(process.env.SEED ?? 1983);
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const { global } = await previewWorld(
    gpu,
    params,
    Number(process.env.TRES ?? 256),
    Number(process.env.GRES ?? 1024),
  );
  const out: Record<string, unknown> = {};
  for (const [kind, s] of await findSpots(global, params.radius)) {
    if (!s) {
      console.log(`${kind}: none`);
      continue;
    }
    const lat = Math.asin(s.point.y) / DEG;
    const lon = Math.atan2(s.point.x, s.point.z) / DEG;
    out[kind] = {
      lat,
      lon,
      facing: s.facing / DEG,
      height: s.height,
      pitch: s.pitch / DEG,
      note: s.note,
    };
    console.log(
      `${kind}: LAT=${lat.toFixed(3)} LON=${lon.toFixed(3)} facing ${(s.facing / DEG).toFixed(0)}° eye ${s.height.toFixed(0)} m — ${s.note}`,
    );
  }
  const dir = join(import.meta.dirname, 'out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `spots-${seed}.json`), JSON.stringify(out, null, 2));
});
