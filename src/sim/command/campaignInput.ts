/**
 * What the command layer needs from the campaign, extracted on the main
 * thread from the strategic graph, the cast and the placed infrastructure,
 * and sent to the sim worker with its init message. Plain structured-cloneable
 * data, small next to the graph. Reads only worldgen/strategic and the cast
 * (decision 52).
 */
import type { CarrierGroupCast, Cast, Side, Theater } from '../../campaign/cast';
import type { Dir } from '../../core/greatCircle';
import type { StrategicGraph } from '../../worldgen/strategic/graph';
import type { Airbase, Infrastructure, TargetSite } from '../../worldgen/strategic/infrastructure';
import { buildNetworkInput } from '../ground/network';
import type { NetworkInput } from '../ground/network';

/** Source lists of the road graph's bridges, in the order `campaignInput` gives them (R1.8). */
export const ROAD_BRIDGE_LISTS = ['road', 'spur'] as const;
export const RAIL_BRIDGE_LISTS = ['rail'] as const;

/** A continental front's start line, with a point deep on each side. */
export interface FrontInput {
  theater: number;
  /** The start line, unit directions, xyz interleaved. */
  points: number[];
  /** Barrier strength 0..1 at each point of the start line (terrain for the ground war, R2.3). */
  strength: number[];
  /** Centroid of the land each side holds. */
  centroid: Record<Side, Dir>;
  attacker: Side;
  /**
   * The start line's weak segments, where an offensive would go through (the
   * graph's corridors on that line): center, length along the line (m), mean
   * barrier strength, road crossings weighted by class, and name (R2.1).
   */
  corridors: { point: Dir; width: number; strength: number; roadScore: number; name: string }[];
}

/** A named place for briefings and need labels (R2.1): a settlement with its holder. */
export interface PlaceInput {
  name: string;
  point: Dir;
  population: number;
  side: Side | null;
}

/** Settlements smaller than this are left out of the campaign input's places. */
export const PLACE_MIN_POPULATION = 2_000;

export interface CampaignInput {
  radius: number;
  rangeFactor: number;
  theaters: Theater[];
  airbases: Airbase[];
  targets: TargetSite[];
  carriers: CarrierGroupCast[];
  fronts: FrontInput[];
  /** Settlements by name (PLACE_MIN_POPULATION and up), for named places (R2.1). */
  places: PlaceInput[];
  /** The civilian roads with the airbase and port spurs, and the railways, as graphs (R1.8). */
  roads: NetworkInput;
  rail: NetworkInput;
}

export function campaignInput(
  graph: StrategicGraph,
  cast: Cast,
  infra: Infrastructure,
): CampaignInput {
  const fronts: FrontInput[] = [];
  for (const t of cast.theaters) {
    if (t.kind !== 'continental-front' || t.front === undefined) continue;
    const f = graph.fronts[t.front]!;
    if (f.start < 0) continue;
    const line = graph.barrierLines[f.start]!;
    const pact = line.sides[f.forwardSide].centroid;
    const alliance = line.sides[f.forwardSide === 1 ? 0 : 1].centroid;
    fronts.push({
      theater: t.id,
      points: Array.from(line.points),
      strength: Array.from(line.strength),
      centroid: { pact: [...pact], alliance: [...alliance] },
      attacker: t.attacker === 'mutual' ? 'pact' : t.attacker,
      corridors: graph.fronts[t.front]!.corridors.filter((c) => c.line === f.start).map((c) => ({
        point: [...c.point],
        width: c.width,
        strength: c.strength,
        roadScore: c.roadScore,
        name: c.name,
      })),
    });
  }
  return {
    radius: graph.radius,
    rangeFactor: cast.rangeFactor,
    theaters: cast.theaters.map((t) => ({ ...t, nodes: [...t.nodes] })),
    airbases: infra.airbases.map((a) => ({ ...a, point: [...a.point] })),
    targets: infra.targets.map((x) => ({
      ...x,
      point: [...x.point],
      ...(x.bridge ? { bridge: { ...x.bridge } } : {}),
    })),
    carriers: (cast.carriers ?? []).map((c) => ({ ...c, track: [...c.track] })),
    fronts,
    places: places(graph, infra),
    roads: buildNetworkInput(
      'road',
      graph.radius,
      [graph.roads, infra.spurs],
      [graph.bridges, infra.spurBridges],
    ),
    rail: buildNetworkInput('rail', graph.radius, [graph.railways.lines], [graph.railways.bridges]),
  };
}

function places(graph: StrategicGraph, infra: Infrastructure): PlaceInput[] {
  const s = graph.settlements;
  const out: PlaceInput[] = [];
  for (let i = 0; i < s.names.length; i++) {
    if (s.population[i]! < PLACE_MIN_POPULATION) continue;
    out.push({
      name: s.names[i]!,
      point: [s.points[i * 3]!, s.points[i * 3 + 1]!, s.points[i * 3 + 2]!],
      population: s.population[i]!,
      side: infra.settlementSide[i] ?? null,
    });
  }
  return out;
}
