/**
 * Railways (decision 103): lines between major cities, ports and the largest
 * towns of each landmass, before any war is cast.
 *
 * - **Stations.** Settlements of at least RAIL_CITY_POPULATION, port towns of at
 *   least RAIL_PORT_POPULATION, and the RAIL_NODE_STATIONS largest settlements of
 *   every land node with at least RAIL_NODE_MIN_SETTLEMENTS of them.
 * - **Links.** The stations' relative neighborhood graph and minimum spanning tree
 *   per landmass (`settlementLinks`, as for trunk roads), routed most important
 *   first by the road search over `railCost`, so later lines share track with
 *   earlier ones and junctions form where they meet.
 * - **Bridges and yards.** Bridges where the lines cross rivers that need one;
 *   rail yards at city stations and at stations where three or more lines meet.
 *
 * Deterministic: no random numbers; ties break by cell and settlement index.
 */
import { SETTLEMENT_PORT } from './graph';
import type { RailNetwork, SettlementList } from './graph';
import type { StrategicContext } from './input';
import { railCost } from './movement';
import {
  findBridges,
  RoadBuilder,
  roadPolylines,
  routeSettlementLinks,
  settlementLinks,
} from './roads';

export const RAIL_CITY_POPULATION = 100_000;
export const RAIL_PORT_POPULATION = 15_000;
const RAIL_NODE_STATIONS = 2;
const RAIL_NODE_MIN_SETTLEMENTS = 6;

export function railStations(s: SettlementList): Set<number> {
  const out = new Set<number>();
  const byNode = new Map<number, number[]>();
  for (let i = 0; i < s.cells.length; i++) {
    const pop = s.population[i]!;
    if (pop >= RAIL_CITY_POPULATION) out.add(i);
    if (s.flags[i]! & SETTLEMENT_PORT && pop >= RAIL_PORT_POPULATION) out.add(i);
    const node = s.node[i]!;
    if (node < 0) continue;
    let l = byNode.get(node);
    if (!l) byNode.set(node, (l = []));
    l.push(i);
  }
  for (const l of byNode.values()) {
    if (l.length < RAIL_NODE_MIN_SETTLEMENTS) continue;
    l.sort((a, b) => s.population[b]! - s.population[a]! || a - b);
    for (const i of l.slice(0, RAIL_NODE_STATIONS)) out.add(i);
  }
  return out;
}

export function buildRailways(ctx: StrategicContext, s: SettlementList): RailNetwork {
  const stations = railStations(s);
  const builder = new RoadBuilder(ctx, railCost(ctx));
  routeSettlementLinks(
    builder,
    s,
    settlementLinks(ctx, s, (i) => stations.has(i)),
  );
  const stationCells = new Set([...stations].map((i) => s.cells[i]!));
  const lines = roadPolylines(ctx, builder.edges, stationCells);
  lines.roadClass.fill(0);
  lines.traffic.fill(0);
  const bridges = findBridges(ctx, builder.rivers, builder.edges, lines);
  bridges.roadClass.fill(0);
  // Yards: city stations, and stations where three or more lines meet.
  const degree = new Map<number, number>();
  for (let k = 0; k < lines.count; k++) {
    for (const p of [lines.offsets[k]!, lines.offsets[k + 1]! - 1]) {
      const c = lines.cells[p]!;
      degree.set(c, (degree.get(c) ?? 0) + 1);
    }
  }
  const sorted = [...stations].sort((a, b) => a - b);
  const yards = sorted.filter(
    (i) =>
      (degree.get(s.cells[i]!) ?? 0) > 0 &&
      (s.population[i]! >= RAIL_CITY_POPULATION || (degree.get(s.cells[i]!) ?? 0) >= 3),
  );
  const maxPop = Math.max(1, ...yards.map((i) => s.population[i]!));
  return {
    lines,
    bridges,
    stations: Int32Array.from(sorted.filter((i) => degree.has(s.cells[i]!))),
    yards: {
      cells: Int32Array.from(yards, (i) => s.cells[i]!),
      points: Float64Array.from(yards.flatMap((i) => [...s.points.subarray(i * 3, i * 3 + 3)])),
      scores: Float32Array.from(yards, (i) => 0.4 + 0.6 * Math.sqrt(s.population[i]! / maxPop)),
    },
    yardSettlement: Int32Array.from(yards),
  };
}
