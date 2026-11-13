/**
 * Terrain-shadow figures (decision 139), on the campaign world's highest range:
 *
 * - how far the shadow bake's height sources are from the terrain the player
 *   sees: the global grid's atlas against level-7 tiles, and the near grid's
 *   lattice (every second level-7 sample, bilinear) against the level-7 mesh
 *   (every fourth sample, bilinear);
 * - what a bake costs here: the compute passes of a full bake, timed
 *   interleaved with an empty compute pass so other load falls on both, the
 *   CPU time of reading the two tile-fed grids, and a bake for a new sun
 *   alone, which reads none.
 *
 * Run: npx vitest run --disable-console-intercept --config vitest.tools.config.ts tools/shadow.preview.ts
 * Env: SEED (1983), GRES (1024), ROUNDS (5), SUN_EL (deg, default 6).
 */
import { it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { Fn, instanceIndex, instancedArray, uniform, vec4 } from 'three/tsl';
import { cubeFaceUvToDirection, directionToCubeFace } from '../src/core/coords';
import type { CubeFace } from '../src/core/coords';
import { tileKeyString, TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  buildHeightAtlas,
  PASSES_PER_GRID,
  sampleHeightAtlas,
  TerrainShadow,
} from '../src/render/sim/lighting/terrainShadow';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { previewWorld } from './previewWorld';

const env = (k: string, d: string) => process.env[k] ?? d;

it('measures the shadow bake', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const seed = Number(env('SEED', '1983'));
  const gres = Number(env('GRES', '1024'));
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const { global } = await previewWorld(gpu, params, 256, gres);
  const n = global.n;
  const R = params.radius;

  // The highest cell of the world, and the level-7 tiles within about 20 km of it.
  let top = 0;
  for (let c = 1; c < global.height.length; c++)
    if (global.height[c]! > global.height[top]!) top = c;
  const face = Math.floor(top / (n * n)) as CubeFace;
  const peak = cubeFaceUvToDirection(
    face,
    ((top % n) + 0.5) / n,
    ((Math.floor(top / n) % n) + 0.5) / n,
  );
  console.log(
    `peak: ${global.height[top]!.toFixed(0)} m at ${(Math.asin(peak.y) / DEG).toFixed(2)}°, ${(Math.atan2(peak.x, peak.z) / DEG).toFixed(2)}° (face ${face})`,
  );
  const riverIndex = new RiverIndex(global.finish.rivers, { height: global.height, radius: R });
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: R,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index: riverIndex,
  });
  const uv = directionToCubeFace(peak);
  const keys: TileKey[] = [];
  const at = (level: number, d: number) => {
    const size = 1 << level;
    const x = Math.floor(uv.u * size) + d;
    return Math.min(size - 1, Math.max(0, x));
  };
  for (const level of [7, 5]) {
    const seen = new Set<string>();
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const size = 1 << level;
        const key = {
          face,
          level,
          x: at(level, dx),
          y: Math.min(size - 1, Math.max(0, Math.floor(uv.v * size) + dy)),
        };
        if (seen.has(tileKeyString(key))) continue;
        seen.add(tileKeyString(key));
        keys.push(key);
      }
    }
  }
  const tiles = new Map<string, TileData>();
  for (const t of await synth.generate(keys)) tiles.set(tileKeyString(t.key), t);

  // Mismatch, over the level-7 tiles' samples.
  const atlas = buildHeightAtlas(global.height, n);
  const stats = (name: string, errors: number[]) => {
    errors.sort((a, b) => a - b);
    const rms = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
    const q = (p: number) => errors[Math.min(errors.length - 1, Math.floor(p * errors.length))]!;
    console.log(
      `${name}: rms ${rms.toFixed(1)} m, median |e| ${q(0.5).toFixed(1)} m, 95% ${q(0.95).toFixed(1)} m, max ${q(1).toFixed(1)} m (${errors.length} samples)`,
    );
  };
  const global7: number[] = [];
  const lattice7: number[] = [];
  const mesh7: number[] = [];
  const d = new Vec3d();
  let relief = 0;
  for (const t of tiles.values()) {
    if (t.key.level !== 7) continue;
    relief = Math.max(relief, t.maxHeight - t.minHeight);
    const h = (sx: number, sy: number) =>
      Math.max(0, t.height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER]!);
    /** Bilinear between every `step`-th sample: the near grid's lattice (2) or the mesh (4). */
    const coarse = (sx: number, sy: number, step: number) => {
      const x0 = Math.min(TILE_TEXELS - step, Math.floor(sx / step) * step);
      const y0 = Math.min(TILE_TEXELS - step, Math.floor(sy / step) * step);
      const fx = (sx - x0) / step;
      const fy = (sy - y0) / step;
      return (
        (h(x0, y0) * (1 - fx) + h(x0 + step, y0) * fx) * (1 - fy) +
        (h(x0, y0 + step) * (1 - fx) + h(x0 + step, y0 + step) * fx) * fy
      );
    };
    const size = TILE_TEXELS << 7;
    for (let sy = 0; sy <= TILE_TEXELS; sy += 3) {
      for (let sx = 0; sx <= TILE_TEXELS; sx += 3) {
        cubeFaceUvToDirection(
          face,
          (t.key.x * TILE_TEXELS + sx) / size,
          (t.key.y * TILE_TEXELS + sy) / size,
          d,
        );
        global7.push(Math.abs(sampleHeightAtlas(atlas, d) - h(sx, sy)));
        lattice7.push(Math.abs(coarse(sx, sy, 2) - h(sx, sy)));
        mesh7.push(Math.abs(coarse(sx, sy, 2) - coarse(sx, sy, 4)));
      }
    }
  }
  console.log(`relief within a level-7 tile (12 km): up to ${relief.toFixed(0)} m`);
  stats('global grid atlas against level-7 tile heights', global7);
  stats('near lattice (every 2nd sample) against level-7 tile heights', lattice7);
  stats('near lattice against the level-7 mesh (every 4th sample)', mesh7);

  // The bake's cost: all passes of a full bake against an empty compute pass of the same size.
  const head = await headlessRenderer(gpu.device, 64, 64);
  const sunUniform = uniform(new Vector3());
  const shadow = new TerrainShadow(sunUniform, R);
  shadow.setHeights(global.height, n);
  shadow.tiles = { dataTile: (key) => tiles.get(tileKeyString(key)) };
  const east = new Vec3d(0, 1, 0).cross(peak).normalize();
  const elevation = Number(env('SUN_EL', '6')) * DEG;
  const sun = peak.clone().scale(Math.sin(elevation)).addScaled(east, Math.cos(elevation));
  sunUniform.value.set(sun.x, sun.y, sun.z);
  const eye = peak.clone().scale(R + 6000);
  const sink = instancedArray(512 * 512, 'vec4');
  const empty = Fn(() => {
    sink.element(instanceIndex).assign(vec4(0));
  })().compute(512 * 512);
  shadow.bake(head.renderer, eye, sun); // compiles the kernels
  await head.renderer.computeAsync(empty);
  await gpu.finish();
  const rounds = Number(env('ROUNDS', '5'));
  const bakes: number[] = [];
  const empties: number[] = [];
  const fills: number[] = [];
  for (let r = 0; r < rounds; r++) {
    shadow.reset();
    let t0 = performance.now();
    shadow.bake(head.renderer, eye, sun);
    const cpu = performance.now() - t0;
    await gpu.finish();
    bakes.push(performance.now() - t0);
    fills.push(cpu);
    t0 = performance.now();
    for (let k = 0; k < 3 * PASSES_PER_GRID; k++) void head.renderer.compute(empty);
    await gpu.finish();
    empties.push(performance.now() - t0);
  }
  // A bake for a new sun alone: the windows and the tiles are the same, so no heights are read.
  const sunOnly: number[] = [];
  const rowsBefore = shadow.stats.sourceRows;
  for (let r = 0; r < rounds; r++) {
    const e = elevation - (r + 1) * DEG;
    const moved = peak.clone().scale(Math.sin(e)).addScaled(east, Math.cos(e));
    const t0 = performance.now();
    shadow.bake(head.renderer, eye, moved);
    await gpu.finish();
    sunOnly.push(performance.now() - t0);
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
  const passes = 3 * PASSES_PER_GRID;
  console.log(
    `bake for a new sun alone: median ${median(sunOnly).toFixed(0)} ms ` +
      `(${shadow.stats.sourceRows - rowsBefore} rows of tile heights read)`,
  );
  console.log(
    `full bake (${passes} passes of 512², both tile-fed grids read): median ${median(bakes).toFixed(0)} ms, ` +
      `${(median(bakes) / passes).toFixed(1)} ms per pass; CPU before the GPU finishes ${median(fills).toFixed(0)} ms; ` +
      `${passes} empty passes: ${median(empties).toFixed(0)} ms`,
  );
  console.log(`stats: ${JSON.stringify(shadow.stats)}`);
  shadow.dispose();
  head.dispose();
}, 600_000);
