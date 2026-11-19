/**
 * Where the map opens on a new campaign (decision 246): over the war, at the
 * Theater band. The middle of the first continental front's start line if the
 * cast has one, else the centroid of the first theater's land nodes, else the
 * largest landmass.
 */
import type { Cast } from '../../campaign/cast';
import { KM } from '../../core/units';
import type { Meters } from '../../core/units';
import type { StrategicGraph } from '../../worldgen/strategic/graph';

/** Eye altitude the map opens at: the Theater band, a front across the screen. */
export const START_ALTITUDE: Meters = 1000 * KM;

/** Unit direction of the map's opening focus, or null for an empty graph. */
export function startFocus(graph: StrategicGraph, cast: Cast | null): [number, number, number] | null {
  const theaters = cast?.theaters ?? [];
  const front = theaters.find((t) => t.kind === 'continental-front' && t.front !== undefined);
  const line =
    front !== undefined ? graph.barrierLines[graph.fronts[front.front!]?.start ?? -1] : undefined;
  if (line && line.points.length >= 3) {
    const i = Math.floor(line.points.length / 6);
    return unit(line.points[i * 3]!, line.points[i * 3 + 1]!, line.points[i * 3 + 2]!);
  }
  const nodes = theaters[0]?.nodes.map((n) => graph.nodes[n]).filter((n) => n !== undefined) ?? [];
  const pick = nodes.length > 0 ? nodes : [...graph.nodes].sort((a, b) => b.area - a.area).slice(0, 1);
  let x = 0;
  let y = 0;
  let z = 0;
  for (const n of pick) {
    x += n.centroid[0] * n.area;
    y += n.centroid[1] * n.area;
    z += n.centroid[2] * n.area;
  }
  return unit(x, y, z);
}

function unit(x: number, y: number, z: number): [number, number, number] | null {
  const l = Math.hypot(x, y, z);
  return l > 0 ? [x / l, y / l, z / l] : null;
}
