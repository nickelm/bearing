/**
 * Writes a generated world as two files that tools/browser.smoke.mjs puts into the
 * browser's world cache (IndexedDB, worldgen/worldStore.ts), so the app loads the world
 * instead of generating it:
 *
 *   npx vitest run --config vitest.tools.config.ts tools/browser.world.preview.ts
 *   WORLD=tools/out/browser/world-1983 node tools/browser.smoke.mjs
 *
 * This is for machines without a GPU. The app's global pass takes over a quarter of an hour
 * in Chromium on lavapipe (launch.mjs) and never ends on SwiftShader; here it runs on
 * Node's Dawn, once, and is cached on disk as for every other tool (previewWorld.ts).
 *
 * Env: SEED (1983), GRES (global grid, 1024: the app's default; a URL with another `gres`
 * finds no cached world), OUT (directory, default tools/out/browser). Writes
 * world-<seed>.json (the record without its arrays) and world-<seed>.bin (the arrays).
 *
 * The record is what the app stores after generating the seed: the coarse pass with its
 * validity retries, the tectonic world of the seed that passed, and the global pass. One
 * difference: the app rounds the relief scale to three decimals for its debug panel
 * (0.157 for 0.15696) and this tool takes the default as the other tools do, so the
 * heights of the global grid are 0.03% lower than in a world the app generates itself.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { testGpu } from '../tests/gpu/device';
import { generateCampaignWorld, strategicWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { GENERATOR_VERSION, worldKey } from '../src/worldgen/worldStore';
import type { StoredWorld } from '../src/worldgen/worldStore';
import { previewWorld } from './previewWorld';

/** A value as JSON; typed arrays go to `chunks` and leave a reference. */
function flatten(value: unknown, chunks: Uint8Array[], size: { bytes: number }): unknown {
  const walk = (v: unknown): unknown => {
    if (v === undefined) return { $undefined: true };
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $number: String(v) };
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) {
      // Aligned to 8 bytes, so the page can view every element type in place.
      const pad = (8 - (size.bytes % 8)) % 8;
      if (pad) chunks.push(new Uint8Array(pad));
      const offset = size.bytes + pad;
      chunks.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      size.bytes = offset + v.byteLength;
      return { $array: v.constructor.name, offset, bytes: v.byteLength };
    }
    if (v instanceof Map) return { $map: [...v].map(([k, x]) => [walk(k), walk(x)]) };
    if (v instanceof Set) return { $set: [...v].map(walk) };
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value);
}

it('writes a world for the browser', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const seed = process.env.SEED ?? '1983';
  const gres = Number(process.env.GRES ?? 1024);
  const out = process.env.OUT ?? join(import.meta.dirname, 'out', 'browser');
  // As the app's worldgen worker does: the coarse pass with retries, at 256 cells per edge.
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const { global } = await previewWorld(
    gpu,
    { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed },
    256,
    gres,
  );
  // The key the app looks the world up by: its parameters as the debug panel holds them.
  const key = worldKey(
    {
      ...DEFAULT_PLANET_PARAMS,
      seed,
      reliefScale: Number(DEFAULT_PLANET_PARAMS.reliefScale.toFixed(3)),
    },
    256,
    gres,
  );
  const record: StoredWorld = {
    key,
    version: GENERATOR_VERSION,
    savedAt: Date.now(),
    tectonic: campaign.world,
    strategic: strategicWorld(campaign),
    global: { n: global.n, height: global.height, uplift: global.uplift, finish: global.finish },
  };
  const chunks: Uint8Array[] = [];
  const size = { bytes: 0 };
  const tree = flatten(record, chunks, size);
  const bin = new Uint8Array(size.bytes);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  mkdirSync(out, { recursive: true });
  const base = join(out, `world-${seed}`);
  writeFileSync(`${base}.json`, JSON.stringify(tree));
  writeFileSync(`${base}.bin`, bin);
  console.log(
    `world ${key} (seed ${String(campaign.seed)} after ${campaign.retries} retries): ` +
      `${(size.bytes / 2 ** 20).toFixed(0)} MiB → ${base}.json and .bin`,
  );
  global.grid.dispose();
});
