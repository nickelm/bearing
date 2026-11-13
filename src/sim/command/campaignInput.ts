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

/** A continental front's start line, with a point deep on each side. */
export interface FrontInput {
  theater: number;
  /** The start line, unit directions, xyz interleaved. */
  points: number[];
  /** Centroid of the land each side holds. */
  centroid: Record<Side, Dir>;
  attacker: Side;
}

export interface CampaignInput {
  radius: number;
  rangeFactor: number;
  theaters: Theater[];
  airbases: Airbase[];
  targets: TargetSite[];
  carriers: CarrierGroupCast[];
  fronts: FrontInput[];
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
      centroid: { pact: [...pact], alliance: [...alliance] },
      attacker: t.attacker === 'mutual' ? 'pact' : t.attacker,
    });
  }
  return {
    radius: graph.radius,
    rangeFactor: cast.rangeFactor,
    theaters: cast.theaters.map((t) => ({ ...t, nodes: [...t.nodes] })),
    airbases: infra.airbases.map((a) => ({ ...a, point: [...a.point] })),
    targets: infra.targets.map((x) => ({ ...x, point: [...x.point] })),
    carriers: (cast.carriers ?? []).map((c) => ({ ...c, track: [...c.track] })),
    fronts,
  };
}
