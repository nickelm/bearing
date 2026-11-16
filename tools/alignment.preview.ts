/**
 * The alignment stage (decision 184) on a real world, inline on one core: the
 * same tasks, tiles and link assembly as the app's worker pool. Prints the
 * time per kilometer, tile synthesis, structures, fallbacks and the record's
 * size, and optionally saves the record next to a browser world.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/alignment.preview.ts
 *
 * Env: SEED (1983), GRES (1024), LIMIT (tasks, default all), FROM (first task),
 * NETWORKS (road,rail,spur), NEAR=lat,lon,km (only links with an anchor that
 * close), ROWS=1 (a line per link), SAVE=path (writes the record with
 * v8.serialize, for `ALIGNMENTS=path` in tools/render.preview.ts),
 * ALIGN_TUNING='{"greed":1.5,"spacing":{"secondary":40}}'.
 */
import { writeFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import { it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import {
  alignedPoint,
  alignmentCorridors,
  alignmentStats,
} from '../src/worldgen/networks/alignments';
import { buildAlignments } from '../src/worldgen/networks/build';
import {
  alignLink,
  CLASS_KEYS,
  LINK_TUNING,
  NETWORK,
  ROUTE_SPACING,
} from '../src/worldgen/networks/link';
import { linkTasks } from '../src/worldgen/networks/tasks';
import { tileHeightSampler } from '../src/worldgen/networks/tileHeights';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { TerrainEdits } from '../src/worldgen/edits';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';

const env = process.env;
// ALIGN_TUNING='{"greed":1.5,"spacing":{"secondary":40}}' overrides LINK_TUNING and ROUTE_SPACING.
if (env.ALIGN_TUNING) {
  const t = JSON.parse(env.ALIGN_TUNING) as Record<string, unknown>;
  Object.assign(ROUTE_SPACING, t.spacing ?? {});
  delete t.spacing;
  Object.assign(LINK_TUNING, t);
}

it('aligns the network of a world', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: env.SEED ?? '1983' });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const R = params.radius;
  const { global } = await previewWorld(gpu, params, 256, Number(env.GRES ?? 1024));
  const index = new RiverIndex(global.finish.rivers, {
    height: global.height,
    radius: R,
    lakeDepth: global.finish.drainage.lakeDepth,
    channels: global.finish.channels,
  });
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: R,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index,
  });
  const nets = (env.NETWORKS ?? 'road,rail,spur').split(',');
  const codes = nets.map((n) =>
    n === 'rail' ? NETWORK.Rail : n === 'spur' ? NETWORK.Spur : NETWORK.Road,
  );
  let tasks = linkTasks(campaign.graph, campaign.infrastructure.spurs, R).filter((t) =>
    codes.includes(t.network),
  );
  if (env.NEAR) {
    const [lat, lon, km] = env.NEAR.split(',').map(Number) as [number, number, number];
    const c = latLonToDirection(lat * DEG, lon * DEG);
    const cos = Math.cos((km * 1000) / R);
    tasks = tasks.filter((t) => {
      for (let i = 0; i < t.anchors.length; i += 3)
        if (t.anchors[i]! * c.x + t.anchors[i + 1]! * c.y + t.anchors[i + 2]! * c.z >= cos)
          return true;
      return false;
    });
  }
  const from = Number(env.FROM ?? 0);
  tasks = tasks.slice(from, env.LIMIT ? from + Number(env.LIMIT) : undefined);
  let synthMs = 0;
  let alignMs = 0;
  let missing = 0;
  const rows: string[] = [];
  let last = 0;
  const al = await buildAlignments({
    tasks,
    radius: R,
    workers: 1,
    synthesize: async (keys) => {
      const t0 = performance.now();
      const out = (await synth.generate(keys)).map((t) => t.height);
      synthMs += performance.now() - t0;
      return out;
    },
    run: (task, tiles) => {
      const t0 = performance.now();
      const ground = tileHeightSampler(new Map(tiles));
      const link = alignLink(task, ground.height, R);
      missing += ground.missing();
      alignMs += performance.now() - t0;
      rows.push(
        `  ${task.id} ${['road', 'rail', 'spur'][task.network]} ${task.line} (${task.cls}): ` +
          `${(link.length / 1000).toFixed(1)} km, ${link.design.length} points, ${link.fellBack} fell back, ` +
          `${link.forced} forced, ${link.unrouted} unrouted, ${link.violations} tight, ${(performance.now() - t0).toFixed(0)} ms`,
      );
      return Promise.resolve(link);
    },
    onProgress: (f, done, total) => {
      if (f - last >= 0.05 || done === total) {
        last = f;
        console.log(`${(f * 100).toFixed(0)}% (${done}/${total} links)`);
      }
    },
  });
  const s = alignmentStats(al);
  const classes = new Map<string, number>();
  for (const c of al.cls) {
    const k = CLASS_KEYS[c] ?? 'unrouted';
    classes.set(k, (classes.get(k) ?? 0) + 1);
  }
  if (env.ROWS === '1') console.log(rows.join('\n'));
  const t0 = performance.now();
  const corridors = alignmentCorridors(al);
  new TerrainEdits({ radius: R, corridors });
  console.log(
    `seed ${campaign.seed}: ${s.links} links, ${s.km.toFixed(0)} km in ${(al.ms / 1000).toFixed(1)} s ` +
      `(${(alignMs / s.km).toFixed(1)} ms/km aligning; tiles ${al.tiles} in ${(synthMs / 1000).toFixed(1)} s), ` +
      `${s.fellBack} pieces by a fallback class, ${s.forced} forced, ${s.unrouted} unrouted, viaducts ${s.viaduct.toFixed(1)} km, ` +
      `tunnels ${s.tunnel.toFixed(1)} km, ${s.points} points (${(s.bytes / 2 ** 20).toFixed(1)} MiB), ` +
      `${corridors.length} corridors indexed in ${(performance.now() - t0).toFixed(0)} ms, ${missing} lookups off the tiles`,
  );
  console.log('points per class', Object.fromEntries(classes));
  // Where to look: the 2 km of line with the most points (curves and grade breaks: switchbacks).
  {
    let best = 0;
    let at: [number, number] = [0, 0];
    const p = alignedPoint;
    for (let k = 0; k < al.count; k++) {
      const o = al.offsets[k]!;
      const e = al.offsets[k + 1]!;
      for (let i = o; i < e; i++) {
        const a = p(al, k, i);
        let j = i;
        while (j + 1 < e && p(al, k, j + 1).distanceTo(a) * R < 2000) j++;
        if (j - i > best) {
          best = j - i;
          const m = p(al, k, (i + j) >> 1);
          at = [Math.asin(m.y) / DEG, Math.atan2(m.x, m.z) / DEG];
        }
      }
    }
    console.log(`densest 2 km: ${best} points at ${at[0].toFixed(4)}, ${at[1].toFixed(4)}`);
  }
  if (env.SAVE) {
    writeFileSync(env.SAVE, serialize(al));
    console.log(`saved ${env.SAVE}`);
  }
}, 7_200_000);
