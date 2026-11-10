/** Draws the strategic graph (and, when given, the cast) onto an offline map. */
import type { StrategicGraph } from '../src/worldgen/strategic/graph';
import { polylinePoint, sitePoint } from '../src/worldgen/strategic/graph';
import type { MapCanvas, Rgb } from './mapCanvas';

const LANE: Rgb = [0.3, 0.85, 1];
const LANDMASS: Rgb = [1, 1, 1];
const ARCHIPELAGO: Rgb = [0.6, 1, 0.6];
const STRAIT: Rgb = [1, 0.3, 1];
const ISLAND: Rgb = [1, 0.75, 0.2];
const START: Rgb = [1, 0.1, 0.1];
const CORRIDOR: Rgb = [1, 1, 0.2];
const PORT: Rgb = [0.2, 0.6, 1];
const AIRBASE: Rgb = [0.85, 0.85, 0.85];

/** Barrier strength 0..1 as orange (weak) to dark red (strong). */
export function barrierColor(s: number): Rgb {
  return [1 - 0.4 * s, 0.75 * (1 - s), 0.1];
}

export function drawGraph(
  c: MapCanvas,
  g: StrategicGraph,
  options: { sites?: boolean } = {},
): void {
  if (options.sites) {
    for (const n of g.nodes) {
      for (let i = 0; i < n.airbases.cells.length; i++)
        c.dot(sitePoint(n.airbases, i), 0.8, AIRBASE, 0.6);
    }
  }
  for (const lane of g.lanes) c.polyline(lane.points, 2, () => LANE);
  for (const line of g.barrierLines) {
    const front = g.fronts.find((f) => f.lines.includes(line.id))!;
    const isStart = front.start === line.id;
    c.polyline(line.points, isStart ? 5 : 3, (i) =>
      isStart ? START : barrierColor(line.strength[i]!),
    );
  }
  for (const f of g.fronts) {
    for (const k of f.corridors) {
      if (k.line !== f.start) continue;
      c.segment(k.from, k.point, 2, CORRIDOR);
      c.segment(k.point, k.to, 2, CORRIDOR);
      c.dot(k.to, 3, CORRIDOR);
    }
  }
  for (const n of g.nodes) {
    for (let i = 0; i < n.ports.cells.length; i++) c.dot(sitePoint(n.ports, i), 2, PORT);
    c.dot(
      n.centroid,
      n.kind === 'landmass' ? 6 : 4,
      n.kind === 'landmass' ? LANDMASS : ARCHIPELAGO,
    );
  }
  for (const k of g.chokepoints) c.square(k.point, 6, k.kind === 'strait' ? STRAIT : ISLAND);
  void polylinePoint;
}
