/**
 * The coarse pass (design, "World Generation Pipeline"): pipeline stages on a
 * 256² tectonic grid, enough to read the world and cast the campaign.
 *
 *   tectonic pipeline (plates … biomes) → drainage on the tectonic grid →
 *   strategic graph
 *
 * The coarse pass skips GPU erosion (decision 61): drainage runs on the
 * tectonic heights, which is enough for the rivers that make barrier lines
 * and port scores. It runs on the CPU, in the worldgen worker, in Node tools
 * and in tests.
 */
import { CubeGrid } from '../core/cubeGrid';
import { computeDrainage } from './drainage';
import type { PlanetParams } from './params';
import { generateWorld } from './pipeline';
import type { ProgressCallback, StageTiming, World } from './pipeline';
import { buildStrategicGraphWithContext } from './strategic/builder';
import type { StrategicBuild } from './strategic/builder';
import type { StrategicGraph } from './strategic/graph';

export const COARSE_RESOLUTION = 256;

export interface CoarseWorld {
  world: World;
  graph: StrategicGraph;
  /** Builder state for placement after casting; in-process only. */
  build: StrategicBuild;
  timings: StageTiming[];
}

export interface CoarseOptions {
  resolution?: number;
  grid?: CubeGrid;
  onProgress?: ProgressCallback;
}

export function coarsePass(params: PlanetParams, options: CoarseOptions = {}): CoarseWorld {
  const resolution = options.grid?.n ?? options.resolution ?? COARSE_RESOLUTION;
  const grid =
    options.grid && options.grid.n === resolution ? options.grid : new CubeGrid(resolution);
  const world = generateWorld(params, {
    resolution,
    grid,
    onProgress: (stage, f) => options.onProgress?.(stage, f * 0.8),
  });
  const timings = [...world.info.timings];
  const t0 = performance.now();
  options.onProgress?.('drainage', 0.8);
  const m = world.maps;
  const drainage = computeDrainage(resolution, m.height, m.runoff, params.radius);
  m.discharge = drainage.discharge;
  m.lakeDepth = drainage.lakeDepth;
  timings.push({ stage: 'coarse drainage', ms: performance.now() - t0 });
  options.onProgress?.('strategic graph', 0.85);
  const build = buildStrategicGraphWithContext({
    grid,
    height: m.height,
    biome: m.biome,
    discharge: drainage.discharge,
    lakeDepth: drainage.lakeDepth,
    receiver: drainage.receiver,
    reliefScale: params.reliefScale,
    radius: params.radius,
    seed: params.seed,
  });
  const graph = build.graph;
  timings.push(...graph.timings.map((t) => ({ stage: `graph: ${t.stage}`, ms: t.ms })));
  return { world, graph, build, timings };
}
