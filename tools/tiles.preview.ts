/**
 * Offline preview of synthesized detail tiles: a mosaic of tiles around a
 * river on the main continent, hillshaded, with rivers in blue and seams
 * between tiles left visible only if something is wrong.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/tiles.preview.ts
 *   env: SEED (1983), GRES (1024), LEVEL (6), SPAN tiles per side (4)
 *
 * Output: tools/out/tiles-<seed>-L<level>.png (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { tileForDirection, tileKey, tileSampleIndex, TILE_TEXELS } from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { Vec3d } from '../src/core/vec3d';
import { BIOME_COLORS } from '../src/render/common/palette';
import { finishWorld } from '../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../src/worldgen/globalPipeline';
import { sampleSpacing, TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { encodePng } from './png';

it('render tile mosaic', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No GPU adapter (Dawn)');
  const seed = process.env.SEED ?? String(DEFAULT_PLANET_PARAMS.seed);
  const gres = Number(process.env.GRES ?? 1024);
  const level = Number(process.env.LEVEL ?? 6);
  const span = Number(process.env.SPAN ?? 4);
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const world = generateWorld(params, { resolution: 256 });
  const g = await buildGlobalWorld(gpu, params, world, {
    n: gres,
    finish: async (input) => finishWorld(input),
  });
  const synth = new TileSynthesizer(g.grid, {
    seed,
    reliefScale: params.reliefScale,
    radius: params.radius,
    biome: g.finish.biome,
    lakeDepth: g.finish.drainage.lakeDepth,
    height: g.height,
    forest: g.finish.forest,
    treeline: g.finish.treeline,
    index: new RiverIndex(g.finish.rivers),
  });

  // Center on the largest river point within 600 km of the main continent's center.
  const main = new Vec3d(...world.info.mainContinent);
  const rv = g.finish.rivers;
  let best = -1;
  let bestQ = 0;
  const d = new Vec3d();
  for (let p = 0; p < rv.discharge.length; p++) {
    d.set(rv.points[p * 3]!, rv.points[p * 3 + 1]!, rv.points[p * 3 + 2]!);
    if (Math.acos(Math.min(1, d.dot(main))) * params.radius > 600e3) continue;
    if (rv.discharge[p]! > bestQ && rv.discharge[p]! < 400) {
      bestQ = rv.discharge[p]!;
      best = p;
    }
  }
  if (best >= 0) d.set(rv.points[best * 3]!, rv.points[best * 3 + 1]!, rv.points[best * 3 + 2]!);
  else d.copy(main);
  const c = tileForDirection(d, level);
  const size = 1 << level;
  const keys: TileKey[] = [];
  for (let ty = 0; ty < span; ty++) {
    for (let tx = 0; tx < span; tx++) {
      const x = Math.min(size - 1, Math.max(0, c.x - (span >> 1) + tx));
      const y = Math.min(size - 1, Math.max(0, c.y - (span >> 1) + ty));
      keys.push(tileKey(c.face, level, x, y));
    }
  }
  const t0 = performance.now();
  const tiles = await synth.generate(keys);
  const ms = performance.now() - t0;
  if (gpu.errors.length) throw new Error(gpu.errors.join(' | '));

  const W = span * TILE_TEXELS;
  const img = new Uint8Array(W * W * 3);
  const spacing = sampleSpacing(level, params.radius);
  const exaggeration = 4;
  tiles.forEach((t, k) => {
    const ox = (k % span) * TILE_TEXELS;
    // Image rows run top-down, v runs up.
    const oy = (span - 1 - Math.floor(k / span)) * TILE_TEXELS;
    for (let sy = 0; sy < TILE_TEXELS; sy++) {
      for (let sx = 0; sx < TILE_TEXELS; sx++) {
        const i = tileSampleIndex(sx, sy);
        const h = t.height[i]!;
        const m = t.material[i]!;
        let [r, gg, b] = h <= 0 ? [0.16, 0.36, 0.62] : BIOME_COLORS[m & 0xff]!;
        if (h > 0) {
          // Light from the northwest.
          const dx =
            t.height[tileSampleIndex(sx + 1, sy)]! - t.height[tileSampleIndex(sx - 1, sy)]!;
          const dy =
            t.height[tileSampleIndex(sx, sy + 1)]! - t.height[tileSampleIndex(sx, sy - 1)]!;
          const shade = Math.min(
            1.6,
            Math.max(0.3, 1 + ((-dx + dy) * exaggeration) / (2 * spacing)),
          );
          r *= shade;
          gg *= shade;
          b *= shade;
        }
        const cover = ((m >> 8) & 0xff) / 255;
        if (cover > 0) {
          r = r * (1 - cover) + 0.12 * cover;
          gg = gg * (1 - cover) + 0.32 * cover;
          b = b * (1 - cover) + 0.85 * cover;
        }
        const o = ((oy + (TILE_TEXELS - 1 - sy)) * W + ox + sx) * 3;
        img[o] = Math.round(Math.min(1, r) * 255);
        img[o + 1] = Math.round(Math.min(1, gg) * 255);
        img[o + 2] = Math.round(Math.min(1, b) * 255);
      }
    }
  });
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `tiles-${seed}-L${level}.png`);
  writeFileSync(file, encodePng(W, W, img));
  writeFileSync(
    join(outDir, `tiles-${seed}-L${level}.txt`),
    `${keys.length} tiles at level ${level} (${spacing.toFixed(0)} m samples) in ${ms.toFixed(0)} ms; ` +
      `octaves ${synth.octavesAt(level)}; centered on river Q=${bestQ.toFixed(0)} m3/s\n`,
  );
  synth.dispose();
  g.grid.dispose();
}, 1_800_000);
