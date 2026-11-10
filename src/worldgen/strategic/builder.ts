/**
 * Builds the strategic graph from the coarse pass (design, "Reading the
 * World"; decision 52). This module and its stages are the only campaign-facing
 * code that reads world maps.
 *
 *   landmasses and statistics → airbase and port sites → land nodes
 *   (landmasses and archipelagos) → ocean grid, sea lanes, chokepoints and
 *   node distances → barrier map and fronts
 *
 * Deterministic: no randomness, ties broken by cell and node index.
 */
import { labelLandmasses, landmassStats, referenceSlope } from '../landmasses';
import { barrierMap, buildFronts } from './fronts';
import type { StrategicGraph } from './graph';
import { CapWalker, forestDensity } from './input';
import type { StrategicContext, StrategicInput } from './input';
import { buildNodes } from './nodes';
import { buildSeaLanes } from './ocean';
import { airbaseSites, portSites } from './sites';

export function strategicContext(input: StrategicInput): StrategicContext {
  const { grid, height, biome, reliefScale, radius } = input;
  const labels = labelLandmasses(grid, height, radius);
  const slope = referenceSlope(grid, height, reliefScale, radius);
  const stats = landmassStats(grid, labels, height, biome, slope, reliefScale, radius);
  return {
    ...input,
    labels,
    stats,
    slope,
    forest: forestDensity(biome),
    cellSize: (radius * Math.PI) / 2 / grid.n,
  };
}

export function buildStrategicGraph(input: StrategicInput): StrategicGraph {
  const timings: { stage: string; ms: number }[] = [];
  let t0 = performance.now();
  const lap = (stage: string) => {
    const now = performance.now();
    timings.push({ stage, ms: now - t0 });
    t0 = now;
  };
  const ctx = strategicContext(input);
  const walker = new CapWalker(ctx.grid);
  lap('landmasses');
  const airbases = airbaseSites(ctx, walker);
  const ports = portSites(ctx, walker);
  lap('sites');
  const nb = buildNodes(ctx, airbases, ports);
  lap('nodes');
  const ocean = buildSeaLanes(ctx, nb);
  lap('sea lanes');
  const barrier = barrierMap(ctx, walker);
  const { lines, fronts } = buildFronts(ctx, nb.nodes, nb.members, barrier);
  lap('fronts');
  return {
    resolution: ctx.grid.n,
    radius: ctx.radius,
    nodes: nb.nodes,
    lanes: ocean.lanes,
    chokepoints: ocean.chokepoints,
    barrierLines: lines,
    fronts,
    nodeDistance: ocean.nodeDistance,
    airbaseCapacity: nb.nodes.reduce((s, n) => s + n.airbases.cells.length, 0),
    timings,
  };
}
