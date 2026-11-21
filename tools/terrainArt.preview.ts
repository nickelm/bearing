/**
 * Terrain art metrics (Proposal 0010, Phase 8; decisions 296–303): the proposal's
 * verification criteria measured over 20 seeds.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/terrainArt.preview.ts --disable-console-intercept --testTimeout=20000000
 *
 * Env: SEEDS (comma list) or FROM and COUNT (default seeds 1..20); GRES (default 256: the
 * eroded world per seed on the GPU, cached by tools/previewWorld.ts); TILES (level-7 tiles
 * per seed for rock dressing, default 6); OUT (default docs/reports/terrain-art-metrics.md).
 *
 * Per seed, as the app builds it (relief exaggeration 1.3 unless RELIEF is set):
 *
 *   - relief invariants at 1.0, 1.3 and 1.5 on the coarse world's finish (CPU): biomes,
 *     forest and zones identical; no river surface rising downstream; lakes level;
 *   - rock dressing on the level-7 tiles around the steepest ground: the share of cliff
 *     cells (sampled slope above 45°) with a piece within one cell, pieces per tile, and
 *     pieces whose foot stands above the ground at their own spot (floating);
 *   - waterfalls on the eroded world's rivers: falls, named falls, and major knickpoints
 *     (a river at least 20 m wide whose surface drops at least 15 m at 5% or steeper over
 *     about 300 m) with a fall within
 *     600 m;
 *   - points of interest: count per type, every one named; and the share of airfields
 *     with a landmark in view from an approach after composition;
 *   - determinism: the points of interest placed twice are the same.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'vitest';
import {
  tileForDirection,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { Vec3d } from '../src/core/vec3d';
import { LAPSE_RATE } from '../src/worldgen/climate';
import { riverInvariants } from '../src/worldgen/channels/invariants';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { finishWorld } from '../src/worldgen/finishWorld';
import type { FinishInput } from '../src/worldgen/finishWorld';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { exaggeratedHeight, exaggerateRelief } from '../src/worldgen/reliefExaggeration';
import { RiverIndex, RIVER_SEGMENT_FIELDS } from '../src/worldgen/riverIndex';
import { DRESSING_STRIDE, dressingSeed } from '../src/worldgen/rockDressing';
import { cellCenterDirection } from '../src/worldgen/rivers';
import { directionToCubeFace } from '../src/core/coords';
import { findWaterfalls } from '../src/worldgen/waterfalls';
import { POI_KINDS } from '../src/worldgen/poi/poi';
import type { PoiKind } from '../src/worldgen/poi/poi';
import { placeDressingTile } from '../src/render/sim/props/rockDressingLayer';
import { bearingPois } from '../src/render/sim/props/poiWorld';
import { previewWorld } from './previewWorld';

const SEEDS = process.env.SEEDS
  ? process.env.SEEDS.split(',')
  : Array.from({ length: Number(process.env.COUNT ?? 20) }, (_, i) =>
      String(Number(process.env.FROM ?? 1) + i),
    );
const GRES = Number(process.env.GRES ?? 256);
const TILES = Number(process.env.TILES ?? 6);
const OUT = process.env.OUT ?? join(import.meta.dirname, '../docs/reports/terrain-art-metrics.md');

interface Row {
  seed: string;
  invariants: { biomes: boolean; rises: number; lakes: boolean };
  rocks: { tiles: number; cliffCells: number; dressed: number; pieces: number; floating: number };
  falls: { all: number; named: number; knickpoints: number; withFall: number };
  pois: Record<string, number>;
  unnamed: number;
  coverage: number;
  airfields: number;
  deterministic: boolean;
  ms: number;
}

function invariants(seed: string): Row['invariants'] {
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const N = 64;
  const results = [1, 1.3, 1.5].map((e) => {
    const m = generateWorld(params, { resolution: N }).maps;
    const sea = new Float32Array(m.temperature.length);
    for (let c = 0; c < sea.length; c++)
      sea[c] = m.temperature[c]! + (LAPSE_RATE * Math.max(0, m.height[c]!)) / params.reliefScale;
    const input: FinishInput = {
      n: N,
      seed,
      height: m.height.slice(),
      runoff: m.runoff,
      precipitation: m.precipitation,
      seaLevelTemperature: sea,
      temperatureRange: m.temperatureRange,
      reliefScale: params.reliefScale,
      radius: params.radius,
      displayN: N / 2,
      tectonic:
        m.province && m.lithology
          ? { n: N, province: m.province, lithology: m.lithology }
          : undefined,
    };
    const finish = finishWorld(input);
    const before = input.height.slice();
    const lakes0 = finish.drainage.lakeDepth.slice();
    exaggerateRelief(input.height, finish, e);
    const index = new RiverIndex(finish.rivers, {
      height: input.height,
      radius: params.radius,
      lakeDepth: finish.drainage.lakeDepth,
    });
    const r = riverInvariants(index, finish.rivers.downstream, {
      radius: params.radius,
      cellSize: ((Math.PI / 2) * params.radius) / N,
    });
    let lakesLevel = true;
    for (let c = 0; c < before.length; c++) {
      if (lakes0[c]! <= 0) continue;
      const want = exaggeratedHeight(before[c]! + lakes0[c]!, e);
      if (Math.abs(input.height[c]! + finish.drainage.lakeDepth[c]! - want) > 0.5)
        lakesLevel = false;
    }
    return {
      biome: finish.biome,
      forest: finish.forest,
      rises: r.surfaceRises + r.junctionRises,
      lakesLevel,
    };
  });
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  return {
    biomes: results.every(
      (r) => same(r.biome, results[0]!.biome) && same(r.forest, results[0]!.forest),
    ),
    rises: results.reduce((s, r) => s + r.rises, 0),
    lakes: results.every((r) => r.lakesLevel),
  };
}

it('measures Proposal 0010 over the seeds', async () => {
  const { testGpu } = await import('../tests/gpu/device');
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const rows: Row[] = [];
  for (const seed of SEEDS) {
    const t0 = performance.now();
    const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
    const params = {
      ...DEFAULT_PLANET_PARAMS,
      seed: campaign.seed,
      ...(process.env.RELIEF ? { reliefExaggeration: Number(process.env.RELIEF) } : {}),
    };
    const { global } = await previewWorld(gpu, params, 256, GRES);
    const R = params.radius;
    const n = global.n;
    // Waterfalls and major knickpoints on the eroded world's rivers.
    const index = new RiverIndex(global.finish.rivers, {
      height: global.height,
      radius: R,
      lakeDepth: global.finish.drainage.lakeDepth,
      channels: global.finish.channels,
    });
    const drops = findWaterfalls(index, R, params.seed);
    const F = RIVER_SEGMENT_FIELDS;
    const d = index.segments.data;
    const knick: Vec3d[] = [];
    for (let k = 0; k + 1 < index.lines.length; k++) {
      const a = index.lines[k]!;
      const b = index.lines[k + 1]!;
      for (let s = a; s < b; s++) {
        if (d[s * F + 6]! < 20 || d[s * F + 8]! > 1e8) continue;
        // The smooth surface 300 m on.
        let run = 0;
        let e = s;
        while (e < b && run < 300) {
          const o = e * F;
          run +=
            R *
            Math.acos(
              Math.min(1, d[o]! * d[o + 3]! + d[o + 1]! * d[o + 4]! + d[o + 2]! * d[o + 5]!),
            );
          e++;
        }
        const drop = d[s * F + 8]! - d[(e - 1) * F + 9]!;
        // A major knickpoint: at least 15 m of drop at 5% or steeper over the run measured
        // (segments are often longer than 300 m: a gentle reach is no knickpoint).
        if (drop >= 15 && drop / Math.max(run, 1) >= 0.05) {
          knick.push(new Vec3d(d[s * F]!, d[s * F + 1]!, d[s * F + 2]!));
          s = e;
        }
      }
    }
    const falls = drops.falls.map((f) => new Vec3d(...f.lip));
    const withFall = knick.filter((p) => falls.some((f) => f.distanceTo(p) * R < 600)).length;
    // Points of interest, composed into the airfields' views.
    const world = {
      n,
      radius: R,
      height: global.height,
      biome: global.finish.biome,
      province: global.finish.province,
      lithology: global.finish.lithology,
      discharge: global.finish.drainage.discharge,
    };
    const fields = campaign.infrastructure.airbases.map((a) => ({
      point: a.point,
      heading: a.heading,
    }));
    const named = drops.falls
      .filter((f) => f.name)
      .map((f) => ({ dir: f.lip, height: f.top - f.bottom }));
    const poi = bearingPois(world, campaign.graph, fields, params.seed, named);
    const again = bearingPois(world, campaign.graph, fields, params.seed, named);
    const counts: Record<string, number> = {};
    for (const k of POI_KINDS) counts[k] = 0;
    for (const p of poi.pois) counts[p.kind]!++;
    // Rock dressing on the level-7 tiles around the steepest ground.
    const synth = new TileSynthesizer(global.grid, {
      seed: params.seed,
      reliefScale: params.reliefScale,
      radius: R,
      biome: global.finish.biome,
      lakeDepth: global.finish.drainage.lakeDepth,
      height: global.height,
      forest: global.finish.forest,
      treeline: global.finish.treeline,
      lithology: global.finish.lithology,
      basinCell: global.finish.drainage.basinCell,
      basinLevel: global.finish.drainage.basinLevel,
      index,
    });
    const steep: { c: number; s: number }[] = [];
    const h = global.height;
    for (let c = 0; c < h.length; c++) {
      if (h[c]! <= 0 || c % n === 0 || c % n === n - 1) continue;
      const s = Math.abs(h[c + 1]! - h[c - 1]!);
      steep.push({ c, s });
    }
    steep.sort((a, b) => b.s - a.s);
    const keys = new Map<string, TileKey>();
    for (const { c } of steep) {
      if (keys.size >= TILES) break;
      const face = Math.floor(c / (n * n));
      const r = c - face * n * n;
      const dir = new Vec3d();
      cellCenterDirection(n, face * n * n + r, dir);
      const k = tileForDirection(dir, 7);
      keys.set(tileKeyString(k), k);
    }
    const maps = {
      n,
      province: global.finish.province!,
      lithology: global.finish.lithology!,
      biome: global.finish.biome,
      karstWonders: [],
      pillarWonders: [],
    };
    const rocks = { tiles: 0, cliffCells: 0, dressed: 0, pieces: 0, floating: 0 };
    for (const data of await synth.generate([...keys.values()])) {
      rocks.tiles++;
      const placed = placeDressingTile(data, maps, dressingSeed(params.seed), R, undefined, 1);
      const size = TILE_TEXELS * (1 << 7);
      const sampleM = ((Math.PI / 2) * R) / size;
      const H = (sx: number, sy: number) =>
        data.height[
          (Math.min(TILE_TEXELS + 1, Math.max(-2, sy)) + TILE_BORDER) * TILE_STRIDE +
            Math.min(TILE_TEXELS + 1, Math.max(-2, sx)) +
            TILE_BORDER
        ]!;
      // Pieces by cell, from their base positions.
      const cells = TILE_TEXELS / DRESSING_STRIDE;
      const occupied = new Uint8Array(cells * cells);
      const origin = placed.origin;
      for (const list of placed.lists.values()) {
        for (let o = 0; o < list.length; o += 12) {
          rocks.pieces++;
          const p = new Vec3d(
            list[o]! + origin.x,
            list[o + 1]! + origin.y,
            list[o + 2]! + origin.z,
          ).normalize();
          const uv = directionToCubeFace(p);
          const sx = uv.u * size - data.key.x * TILE_TEXELS;
          const sy = uv.v * size - data.key.y * TILE_TEXELS;
          const cx = Math.floor(sx / DRESSING_STRIDE);
          const cy = Math.floor(sy / DRESSING_STRIDE);
          if (cx >= 0 && cy >= 0 && cx < cells && cy < cells) occupied[cy * cells + cx] = 1;
          // Floating: the foot above the ground at its own spot (bilinear in the samples).
          const foot = Math.hypot(list[o + 3]!, list[o + 4]!, list[o + 5]!);
          const x0 = Math.floor(sx);
          const y0 = Math.floor(sy);
          const tx = sx - x0;
          const ty = sy - y0;
          const low =
            (H(x0, y0) * (1 - tx) + H(x0 + 1, y0) * tx) * (1 - ty) +
            (H(x0, y0 + 1) * (1 - tx) + H(x0 + 1, y0 + 1) * tx) * ty;
          if (foot > low + 0.5) rocks.floating++;
        }
      }
      for (let cy = 0; cy < cells; cy++)
        for (let cx = 0; cx < cells; cx++) {
          const sx = cx * DRESSING_STRIDE + 1;
          const sy = cy * DRESSING_STRIDE + 1;
          const slope =
            Math.hypot(H(sx + 1, sy) - H(sx - 1, sy), H(sx, sy + 1) - H(sx, sy - 1)) /
            (2 * sampleM);
          if (slope <= 1 || H(sx, sy) <= 0) continue;
          rocks.cliffCells++;
          let near = false;
          for (let oy = -1; oy <= 1 && !near; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const x = cx + ox;
              const y = cy + oy;
              if (x >= 0 && y >= 0 && x < cells && y < cells && occupied[y * cells + x]) {
                near = true;
                break;
              }
            }
          if (near) rocks.dressed++;
        }
    }
    synth.dispose();
    global.grid.dispose();
    const row: Row = {
      seed: String(campaign.seed),
      invariants: invariants(seed),
      rocks,
      falls: { all: drops.falls.length, named: named.length, knickpoints: knick.length, withFall },
      pois: counts,
      unnamed: poi.pois.filter((p) => !p.name).length,
      coverage: poi.coverage,
      airfields: fields.length,
      deterministic: JSON.stringify(poi.pois) === JSON.stringify(again.pois),
      ms: performance.now() - t0,
    };
    rows.push(row);
    console.log(
      `seed ${seed}: rocks ${rocks.dressed}/${rocks.cliffCells} cliff cells, ${rocks.pieces} pieces, ${rocks.floating} floating; ` +
        `falls ${row.falls.all} (${row.falls.withFall}/${row.falls.knickpoints} knickpoints); ` +
        `pois ${poi.pois.length}, coverage ${(100 * poi.coverage).toFixed(0)}%; ${(row.ms / 1000).toFixed(0)} s`,
    );
  }
  writeReport(rows);
});

function writeReport(rows: Row[]): void {
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '—');
  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const lines: string[] = [];
  lines.push('# Terrain Art Metrics (Proposal 0010)', '');
  lines.push(
    `_Generated by \`tools/terrainArt.preview.ts\` over ${rows.length} seeds (${rows.map((r) => r.seed).join(', ')}), global grid ${GRES}² per face, relief exaggeration ${process.env.RELIEF ?? 1.3}._`,
    '',
  );
  lines.push('## Summary', '');
  lines.push('| Check | Result |', '|---|---|');
  lines.push(
    `| Relief invariants at 1.0, 1.3, 1.5 | biomes identical in ${rows.filter((r) => r.invariants.biomes).length}/${rows.length} seeds; ${sum((r) => r.invariants.rises)} surface rises; lakes level in ${rows.filter((r) => r.invariants.lakes).length}/${rows.length} |`,
  );
  lines.push(
    `| Rock dressing on cliffs (> 45°) | ${pct(
      sum((r) => r.rocks.dressed),
      sum((r) => r.rocks.cliffCells),
    )} of ${sum((r) => r.rocks.cliffCells)} cliff cells have a piece within one cell; ${sum((r) => r.rocks.floating)} of ${sum((r) => r.rocks.pieces)} pieces above the ground under them |`,
  );
  lines.push(
    `| Waterfalls at major knickpoints | ${pct(
      sum((r) => r.falls.withFall),
      sum((r) => r.falls.knickpoints),
    )} of ${sum((r) => r.falls.knickpoints)} knickpoints; ${sum((r) => r.falls.all)} falls, ${sum((r) => r.falls.named)} named |`,
  );
  const missing = POI_KINDS.filter((k) => rows.every((r) => (r.pois[k] ?? 0) === 0));
  lines.push(
    `| Structures by type | ${POI_KINDS.length - missing.length} of ${POI_KINDS.length} types appear${missing.length ? ` (none: ${missing.join(', ')})` : ''}; ${sum((r) => r.unnamed)} unnamed |`,
  );
  lines.push(
    `| Landmark in view of airfields | ${pct(
      sum((r) => r.coverage * r.airfields),
      sum((r) => r.airfields),
    )} of ${sum((r) => r.airfields)} airfields (lowest seed ${(100 * Math.min(...rows.map((r) => r.coverage))).toFixed(0)}%) |`,
  );
  lines.push(
    `| Determinism | ${rows.filter((r) => r.deterministic).length}/${rows.length} seeds place the same structures twice |`,
    '',
  );
  lines.push('## Per Seed', '');
  lines.push(
    '| Seed | Biomes same | Rises | Cliff cells dressed | Pieces | Floating | Falls | Knickpoints with a fall | Structures | Airfield coverage |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const total = Object.values(r.pois).reduce((a, b) => a + b, 0);
    lines.push(
      `| ${r.seed} | ${r.invariants.biomes ? 'yes' : 'no'} | ${r.invariants.rises} | ${pct(r.rocks.dressed, r.rocks.cliffCells)} of ${r.rocks.cliffCells} | ${r.rocks.pieces} | ${r.rocks.floating} | ${r.falls.all} | ${r.falls.withFall}/${r.falls.knickpoints} | ${total} | ${pct(r.coverage * r.airfields, r.airfields)} of ${r.airfields} |`,
    );
  }
  lines.push('', '## Structures by Type', '');
  lines.push(
    `| Type | ${rows.map((r) => r.seed).join(' | ')} |`,
    `|---|${rows.map(() => '---').join('|')}|`,
  );
  for (const k of POI_KINDS as readonly PoiKind[])
    lines.push(`| ${k} | ${rows.map((r) => r.pois[k] ?? 0).join(' | ')} |`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`wrote ${OUT}`);
}
