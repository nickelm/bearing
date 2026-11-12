/**
 * What the map draws of settlements and infrastructure besides the urban fill and the
 * city glyphs (visual-style Part II, Settlements and Infrastructure; decision 104):
 * roads, railways, bridges and site symbols, as lines and marks for the overlay layer
 * (overlays/militaryLayer.ts). Pure TypeScript: tests run it without a GPU.
 *
 * - **Roads.** Screen-space ribbons with a darker casing, colored and sized by class:
 *   motorways from the Theater band down (thin there), trunk and secondary roads in the
 *   Region band. Roads run through coarse-cell centers, so their polylines are
 *   smoothed (two rounds of Chaikin corner cutting, ends kept) before they are
 *   densified for draping.
 * - **Railways.** A thin dark line with cross-ticks (a wider line dashed to short
 *   ticks), in the Region band.
 * - **Bridges.** Two bars along the road or track either side of it, Region band.
 * - **Sites.** Airbases as runway glyphs (a ring with the runway along its heading)
 *   from the Theater band down; ports as piers, factories, power plants, refineries,
 *   supply and fuel depots and rail yards as distinct symbols in the Region band, in
 *   the holder's faction color; the railways' own yards in the rail color. Symbols at a
 *   town stand on its edge (1.5 built-up radii out, spread round it), not on its glyph.
 * - **Capitals.** A star in the side's color over each capital's glyph, from the
 *   Theater band down.
 */
import type { Side } from '../../../campaign/cast';
import { RoadClass, polylinePoint, roadPolyline } from '../../../worldgen/strategic/graph';
import type {
  BridgeList,
  Point,
  RoadNetwork,
  StrategicGraph,
} from '../../../worldgen/strategic/graph';
import type { Infrastructure, TargetKind } from '../../../worldgen/strategic/infrastructure';
import { builtUpRadius } from '../../../worldgen/strategic/urban';
import { densify, FACTION_COLORS } from '../overlays/militaryModel';
import type {
  LineStyle,
  MarkShape,
  MilitaryOverlays,
  OverlayLine,
  OverlayMark,
} from '../overlays/militaryModel';
import type { ZoomBand } from '../zoomBands';

export type InfraLayer = 'railways' | 'roads' | 'sites';
/** Draw order: railways under roads, symbols on top. */
export const INFRA_LAYERS: readonly InfraLayer[] = ['railways', 'roads', 'sites'];
export type InfraOverlays = MilitaryOverlays<InfraLayer>;

/** Part II's road colors and casings (sRGB), widest class first. */
export const ROAD_COLORS: readonly { ink: number; casing: number }[] = [
  { ink: 0xc0563a, casing: 0x6a2e20 },
  { ink: 0xd99a4e, casing: 0x7a5428 },
  { ink: 0xf2e6c8, casing: 0x8a7b62 },
];
/** Ink width and casing (CSS px) per class in the Region band; motorways at the Theater band. */
export const ROAD_WIDTHS: readonly { width: number; casing: number }[] = [
  { width: 3, casing: 0.8 },
  { width: 2.3, casing: 0.7 },
  { width: 1.4, casing: 0.55 },
];
export const THEATER_MOTORWAY = { width: 1.5, casing: 0.5 } as const;
export const RAIL_COLOR = 0x3e3a36;
export const RAIL = { width: 1.2, casing: 0.6, tickLength: 6, tickPeriod: 9, tickWidth: 1.5 };
/** Bridge marks and symbols (CSS px). */
export const BRIDGE_SIZE = 9;
export const BRIDGE_COLOR = 0x2a2a2a;
export const SYMBOL_SIZE = 12;
export const AIRBASE_SIZE = { theater: 11, region: 15 } as const;
export const STAR_SIZE = 15;

const THEATER_DOWN: readonly ZoomBand[] = ['theater', 'region'];
const REGION: readonly ZoomBand[] = ['region'];
const THEATER: readonly ZoomBand[] = ['theater'];

type V = Point;
const add = (a: V, b: V, s = 1): V => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Local east and north at a unit direction. */
function frame(p: V): { east: V; north: V } {
  let east = cross([0, 1, 0], p);
  if (Math.hypot(...east) < 1e-9) east = [1, 0, 0];
  east = unit(east);
  return { east, north: cross(p, east) };
}

/** Two rounds of Chaikin corner cutting on unit directions, ends kept. */
export function smoothPolyline(points: Float64Array, rounds = 2): Float64Array {
  let pts: V[] = [];
  for (let i = 0; i < points.length / 3; i++) pts.push(polylinePoint(points, i));
  for (let r = 0; r < rounds && pts.length > 2; r++) {
    const next: V[] = [pts[0]!];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (i > 0) next.push(unit(add(add([0, 0, 0], a, 0.75), b, 0.25)));
      if (i + 2 < pts.length) next.push(unit(add(add([0, 0, 0], a, 0.25), b, 0.75)));
    }
    next.push(pts[pts.length - 1]!);
    pts = next;
  }
  return Float64Array.from(pts.flat());
}

function roadStyle(cls: number, w: { width: number; casing: number }): LineStyle {
  const c = ROAD_COLORS[cls] ?? ROAD_COLORS[RoadClass.Secondary]!;
  return {
    color: c.ink,
    width: w.width,
    casing: w.casing,
    casingOpacity: 1,
    casingColor: c.casing,
    dash: 0,
    duty: 1,
    roundEnds: true,
    teeth: null,
  };
}

/** Unit tangent of a polyline near point p (from its nearest vertex), in p's tangent plane. */
function tangentAt(points: Float64Array, p: V): V {
  const n = points.length / 3;
  let best = 0;
  let bestDot = -2;
  for (let i = 0; i < n; i++) {
    const d = dot(polylinePoint(points, i), p);
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  const a = polylinePoint(points, Math.max(0, best - 1));
  const b = polylinePoint(points, Math.min(n - 1, best + 1));
  const t = sub(b, a);
  return unit(sub(t, [p[0] * dot(t, p), p[1] * dot(t, p), p[2] * dot(t, p)]));
}

/** The unit direction `d` m from p on a heading (rad clockwise from north). */
function offsetOnHeading(p: V, heading: number, d: number, radius: number): V {
  const { east, north } = frame(p);
  const s = d / radius;
  return unit(add(add(p, east, Math.sin(heading) * s), north, Math.cos(heading) * s));
}

const TARGET_SHAPES: Record<TargetKind, MarkShape> = {
  factory: 'factory',
  'power-plant': 'power-plant',
  refinery: 'refinery',
  'rail-yard': 'rail-yard',
  'supply-depot': 'supply-depot',
  'fuel-depot': 'fuel-depot',
};

function symbol(
  shape: MarkShape,
  point: V,
  color: number,
  size: number,
  bands: readonly ZoomBand[],
  axis: V = [0, 0, 0],
): OverlayMark<InfraLayer> {
  return {
    layer: 'sites',
    shape,
    point,
    axis,
    length: size,
    width: size,
    color,
    outline: 0,
    casing: 1.4,
    bands,
  };
}

export function buildInfraOverlays(
  graph: StrategicGraph,
  infra: Infrastructure | null,
): InfraOverlays {
  const lines: OverlayLine<InfraLayer>[] = [];
  const marks: OverlayMark<InfraLayer>[] = [];
  const R = graph.radius;
  const smooth = new Map<RoadNetwork, Float64Array[]>();
  const smoothed = (net: RoadNetwork) => {
    let list = smooth.get(net);
    if (!list) {
      list = [];
      for (let k = 0; k < net.count; k++) list.push(densify(smoothPolyline(roadPolyline(net, k))));
      smooth.set(net, list);
    }
    return list;
  };

  // Railways: the track, then its ticks.
  const rails = smoothed(graph.railways.lines);
  for (const points of rails) {
    lines.push({
      layer: 'railways',
      points,
      style: {
        color: RAIL_COLOR,
        width: RAIL.width,
        casing: RAIL.casing,
        casingOpacity: 0.6,
        dash: 0,
        duty: 1,
        roundEnds: true,
        teeth: null,
      },
      bands: REGION,
    });
  }
  for (const points of rails) {
    lines.push({
      layer: 'railways',
      points,
      style: {
        color: RAIL_COLOR,
        width: RAIL.tickLength,
        casing: 0,
        casingOpacity: 0,
        dash: RAIL.tickPeriod,
        duty: RAIL.tickWidth / RAIL.tickPeriod,
        roundEnds: false,
        teeth: null,
      },
      bands: REGION,
    });
  }

  // Roads, secondary first so wider classes draw over them; spurs are secondary roads.
  const nets: RoadNetwork[] = [graph.roads, ...(infra ? [infra.spurs] : [])];
  for (const cls of [RoadClass.Secondary, RoadClass.Trunk, RoadClass.Motorway]) {
    for (const net of nets) {
      const pts = smoothed(net);
      for (let k = 0; k < net.count; k++) {
        if (net.roadClass[k] !== cls) continue;
        lines.push({
          layer: 'roads',
          points: pts[k]!,
          style: roadStyle(cls, ROAD_WIDTHS[cls]!),
          bands: REGION,
        });
        if (cls === RoadClass.Motorway) {
          lines.push({
            layer: 'roads',
            points: pts[k]!,
            style: roadStyle(cls, THEATER_MOTORWAY),
            bands: THEATER,
          });
        }
      }
    }
  }

  // Bridges on roads and railways.
  const bridgeMarks = (b: BridgeList, net: RoadNetwork, color: number) => {
    const pts = smoothed(net);
    for (let i = 0; i < b.cells.length; i++) {
      const p: V = [b.points[i * 3]!, b.points[i * 3 + 1]!, b.points[i * 3 + 2]!];
      const road = b.road[i]!;
      if (road < 0) continue;
      const axis = tangentAt(pts[road]!, p);
      marks.push({ ...symbol('bridge', p, color, BRIDGE_SIZE, REGION, axis), casing: 1 });
    }
  };
  bridgeMarks(graph.bridges, graph.roads, BRIDGE_COLOR);
  if (infra) bridgeMarks(infra.spurBridges, infra.spurs, BRIDGE_COLOR);
  bridgeMarks(graph.railways.bridges, graph.railways.lines, RAIL_COLOR);

  // Symbols at a town stand on its edge, spread round it (east first).
  const s = graph.settlements;
  const atTown = new Map<number, number>();
  const edgeOf = (settlement: number, p: V): V => {
    if (settlement < 0) return p;
    const k = atTown.get(settlement) ?? 0;
    atTown.set(settlement, k + 1);
    const r = 1.5 * builtUpRadius(s.population[settlement]!);
    return offsetOnHeading(p, Math.PI / 2 + k * (Math.PI / 3), r, R);
  };
  const yardTargets = new Set<number>();
  if (infra) {
    for (const a of infra.airbases) {
      const { east, north } = frame(a.point);
      const axis = unit(add(add([0, 0, 0], north, Math.cos(a.heading)), east, Math.sin(a.heading)));
      const color = FACTION_COLORS[a.side];
      marks.push(symbol('airbase', a.point, color, AIRBASE_SIZE.theater, THEATER, axis));
      marks.push(symbol('airbase', a.point, color, AIRBASE_SIZE.region, REGION, axis));
    }
    for (const p of infra.ports) {
      marks.push(symbol('port', p.point, FACTION_COLORS[p.side], SYMBOL_SIZE, REGION));
    }
    for (const t of infra.targets) {
      if (t.kind === 'rail-yard' && t.settlement >= 0) yardTargets.add(t.settlement);
      const point = edgeOf(t.settlement, t.point);
      marks.push(symbol(TARGET_SHAPES[t.kind], point, FACTION_COLORS[t.side], SYMBOL_SIZE, REGION));
    }
  }
  const yards = graph.railways.yards;
  for (let i = 0; i < yards.cells.length; i++) {
    const town = graph.railways.yardSettlement[i]!;
    if (yardTargets.has(town)) continue;
    const p: V = [yards.points[i * 3]!, yards.points[i * 3 + 1]!, yards.points[i * 3 + 2]!];
    marks.push(symbol('rail-yard', edgeOf(town, p), RAIL_COLOR, SYMBOL_SIZE - 1, REGION));
  }
  if (infra) {
    for (const side of ['alliance', 'pact'] as Side[]) {
      const cap = infra.capitals[side];
      if (cap < 0) continue;
      const p: V = [s.points[cap * 3]!, s.points[cap * 3 + 1]!, s.points[cap * 3 + 2]!];
      marks.push({
        ...symbol('star', p, FACTION_COLORS[side], STAR_SIZE, THEATER_DOWN),
        casing: 1.6,
      });
    }
  }
  return { lines, marks };
}
