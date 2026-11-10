/**
 * Builds the strategic graph from the coarse pass (design, "Reading the
 * World"; decision 52). This module and its stages are the only campaign-facing
 * code that reads world maps.
 *
 *   landmasses and statistics → airbase and port sites → land nodes
 *   (landmasses and archipelagos) → ocean grid, sea lanes, chokepoints and
 *   node distances → settlements → movement cost, roads and bridges →
 *   barrier map and fronts (corridors use the roads)
 *
 * Deterministic: settlements draw from rng(seed, "settlements"); every other
 * stage is free of randomness, with ties broken by cell and node index.
 */
import { labelLandmasses, landmassStats, referenceSlope } from '../landmasses';
import { barrierMap, buildFronts } from './fronts';
import type { StrategicGraph } from './graph';
import { CapWalker, forestDensity, steepestDescent } from './input';
import type { StrategicContext, StrategicInput } from './input';
import { movementCost } from './movement';
import { buildNodes } from './nodes';
import type { NodeBuild } from './nodes';
import { buildRoads } from './roads';
import type { RoadBuilder } from './roads';
import { placeSettlements } from './settlements';
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
    receiver: input.receiver ?? steepestDescent(grid, height),
  };
}

export function buildStrategicGraph(input: StrategicInput): StrategicGraph {
  return buildStrategicGraphWithContext(input).graph;
}

/**
 * What the builder knows beyond the graph, for placement after casting
 * (infrastructure.ts). In-process only: not stored or transferred.
 */
export interface StrategicBuild {
  graph: StrategicGraph;
  ctx: StrategicContext;
  nodes: NodeBuild;
  /** The road builder with the civilian network's edges, for spur roads. */
  roads: RoadBuilder;
  walker: CapWalker;
}

export function buildStrategicGraphWithContext(input: StrategicInput): StrategicBuild {
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
  const { settlements, habitability } = placeSettlements(
    ctx,
    nb.nodes,
    nb.nodeOfLandmass,
    walker,
    input.seed ?? 0,
  );
  lap('settlements');
  const roads = buildRoads(ctx, settlements, movementCost(ctx));
  lap('roads');
  const barrier = barrierMap(ctx, walker);
  const { lines, fronts } = buildFronts(ctx, nb.nodes, nb.members, barrier, {
    settlements,
    roads: roads.network,
  });
  lap('fronts');
  const graph: StrategicGraph = {
    resolution: ctx.grid.n,
    radius: ctx.radius,
    nodes: nb.nodes,
    settlements,
    habitability,
    roads: roads.network,
    bridges: roads.bridges,
    lanes: ocean.lanes,
    chokepoints: ocean.chokepoints,
    barrierLines: lines,
    fronts,
    nodeDistance: ocean.nodeDistance,
    airbaseCapacity: nb.nodes.reduce((s, n) => s + n.airbases.cells.length, 0),
    timings,
  };
  return { graph, ctx, nodes: nb, roads: roads.builder, walker };
}
