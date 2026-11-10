/** Draws the strategic graph (and, when given, the cast) onto an offline map. */
import type { RoadNetwork, StrategicGraph } from '../src/worldgen/strategic/graph';
import type { Infrastructure } from '../src/worldgen/strategic/infrastructure';
import {
  polylinePoint,
  settlementKind,
  settlementPoint,
  sitePoint,
} from '../src/worldgen/strategic/graph';
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

const ROAD: readonly Rgb[] = [
  [1, 0.8, 0.35],
  [0.92, 0.92, 0.92],
  [0.62, 0.62, 0.62],
];
const ROAD_PX = [2, 1.3, 0.8];
const TOWN: Rgb = [1, 1, 1];
const BRIDGE: Rgb = [0.1, 0.1, 0.1];

/** Roads, minor first so major roads draw on top. */
export function drawRoads(c: MapCanvas, roads: RoadNetwork, color?: Rgb): void {
  for (const cls of [2, 1, 0]) {
    for (let k = 0; k < roads.count; k++) {
      if (roads.roadClass[k] !== cls) continue;
      const pts = roads.points.subarray(roads.offsets[k]! * 3, roads.offsets[k + 1]! * 3);
      c.polyline(pts, ROAD_PX[cls]!, () => color ?? ROAD[cls]!);
    }
  }
}

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
  drawRoads(c, g.roads);
  for (let i = 0; i < g.bridges.cells.length; i++) {
    c.square(
      [g.bridges.points[i * 3]!, g.bridges.points[i * 3 + 1]!, g.bridges.points[i * 3 + 2]!],
      1,
      BRIDGE,
    );
  }
  const s = g.settlements;
  for (let i = 0; i < s.cells.length; i++) {
    const kind = settlementKind(s.population[i]!);
    c.dot(settlementPoint(s, i), kind === 'city' ? 3 : kind === 'town' ? 2 : 1.2, TOWN);
  }
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

const SIDE_COLOR: Record<'alliance' | 'pact', Rgb> = {
  alliance: [0.35, 0.65, 1],
  pact: [1, 0.35, 0.3],
};
const TARGET: Rgb = [1, 0.55, 0];

/** Airbases (squares; bomber bases larger, forward and island ones smaller), ports, targets. */
export function drawInfrastructure(c: MapCanvas, x: Infrastructure): void {
  drawRoads(c, x.spurs, [0.75, 0.75, 0.55]);
  for (const t of x.targets) c.dot(t.point, 2, TARGET);
  for (const p of x.ports) c.square(p.point, p.kind === 'military' ? 4 : 2.5, PORT);
  for (const a of x.airbases) {
    const half = a.kind === 'bomber' ? 5 : a.kind === 'main' ? 3.5 : 2.5;
    c.square(a.point, half + 1, [0, 0, 0]);
    c.square(a.point, half, SIDE_COLOR[a.side]);
  }
}
