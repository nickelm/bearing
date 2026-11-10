/**
 * The strategic graph (design, "Reading the World"; decision 52): the world in
 * the terms a commander uses, and the only view of the world that theater
 * detection, casting and the command layer get.
 *
 * Everything here is plain data: numbers, strings, arrays and typed arrays.
 * It survives structured cloning (postMessage, IndexedDB), and
 * `graphBuffers` lists the typed arrays a worker can transfer.
 *
 * Positions are unit directions from the planet center ([x, y, z] or
 * xyz-interleaved Float64Array). Distances are great-circle meters on the
 * planet's surface. Cell indices refer to the coarse grid the graph was built
 * on (`resolution` cells per face edge); campaign logic treats them as opaque
 * ids.
 */

export type Point = [number, number, number];

/** Candidate sites (airbases or ports), struct-of-arrays, best first. */
export interface SiteList {
  /** Coarse-grid cell of each site. */
  cells: Int32Array;
  /** Unit direction of each site, xyz interleaved. */
  points: Float64Array;
  /** Suitability 0..1. */
  scores: Float32Array;
}

/** Area fractions by terrain class (see worldgen/landmasses.ts). */
export interface TerrainMix {
  plains: number;
  hills: number;
  mountains: number;
  forest: number;
  desert: number;
  ice: number;
}

export type NodeKind = 'landmass' | 'archipelago';

/**
 * A landmass of at least LANDMASS_MIN_AREA, or a cluster of smaller islands
 * within strike range of each other (single linkage, coast to coast).
 */
export interface LandNode {
  id: number;
  kind: NodeKind;
  /** Land area (m²); for an archipelago, the sum over its islands. */
  area: number;
  centroid: Point;
  coastlineLength: number;
  latMin: number;
  latMax: number;
  terrain: TerrainMix;
  /** Number of islands (1 for a landmass). */
  islandCount: number;
  /** Radius of the smallest cap around the centroid that holds all of the node's land (m). */
  extent: number;
  /** Candidate port sites: sheltered coast with deep water close inshore. */
  ports: SiteList;
  /** Candidate airbase sites: flat, low land, at least AIRBASE_SPACING apart. */
  airbases: SiteList;
  /** Index into `StrategicGraph.fronts`, or −1 if the node has no barrier lines. */
  front: number;
}

/** Per-side statistics of a barrier line. Side 0 is the side toward the low end of the landmass axis. */
export interface LineSide {
  /** Land area on this side (m²). */
  area: number;
  /** Fraction of the landmass's area on this side. */
  fraction: number;
  centroid: Point;
  /** Distance from the line within which 90% of this side's land lies (m). */
  depth: number;
}

/**
 * A coast-to-coast line of high barrier strength across a landmass, from the
 * front generator.
 */
export interface BarrierLine {
  id: number;
  node: number;
  /** Polyline, xyz interleaved unit directions, coast to coast. */
  points: Float64Array;
  /** Barrier strength 0..1 at each point. */
  strength: Float32Array;
  /** Length-weighted mean barrier strength. */
  meanStrength: number;
  length: number;
  sides: [LineSide, LineSide];
  /**
   * Signed distance (m) of each of the node's airbase sites from the line:
   * negative on side 0, positive on side 1.
   */
  airbaseOffset: Float32Array;
  /** Signed distance of each of the node's port sites, as for airbases. */
  portOffset: Float32Array;
}

/** A weak segment of a barrier line, where an offensive would go through. */
export interface Corridor {
  line: number;
  /** Center of the weak segment on the line. */
  point: Point;
  /** Ends of the corridor axis, about CORRIDOR_DEPTH into side 0 and side 1. */
  from: Point;
  to: Point;
  /** Length of the weak segment along the line (m). */
  width: number;
  /** Mean barrier strength over the segment. */
  strength: number;
}

/**
 * The front generator's result for one landmass: its barrier lines in order
 * across the landmass axis, the strongest, and the start line.
 */
export interface FrontGeometry {
  node: number;
  /** Barrier line ids ordered from the side-0 end to the side-1 end. */
  lines: number[];
  /** Strongest line (highest mean strength). */
  strongest: number;
  /**
   * Start line: one line forward of the strongest, both sides holding at least
   * FRONT_MIN_SIDE of the landmass. −1 if no line qualifies.
   */
  start: number;
  /** The side of the start line away from the strongest line: the attacker's side. */
  forwardSide: 0 | 1;
  /** Weak segments of every line, strongest-first order not implied. */
  corridors: Corridor[];
}

/** A least-cost route over the coarse ocean grid between port sites of two nodes. */
export interface SeaLane {
  id: number;
  /** Node ids, a < b. */
  a: number;
  b: number;
  /** Port site index within each node's `ports`. */
  portA: number;
  portB: number;
  /** Route from port A to port B, xyz interleaved unit directions. */
  points: Float64Array;
  length: number;
  /** Narrowest water along the route away from its ends (m); Infinity in open ocean. */
  minWidth: number;
  /** Where the route is narrowest. */
  narrowest: Point;
  /** Fraction of the route through sea ice. */
  ice: number;
}

export type ChokepointKind = 'strait' | 'island';

/**
 * A strait narrower than STRAIT_MAX_WIDTH on a sea lane, or an island that
 * could host an airfield within ISLAND_REACH of a lane.
 */
export interface Chokepoint {
  id: number;
  kind: ChokepointKind;
  point: Point;
  /** Strait width (m); for islands, the distance from the island to the nearest lane. */
  width: number;
  /** Node the island belongs to (an archipelago or small landmass), or −1. */
  node: number;
  /** Island land area (m²); 0 for straits. */
  islandArea: number;
  /** Airbase sites on the island; 0 for straits. */
  airfields: number;
  /** Sea lanes the chokepoint controls. */
  lanes: number[];
}

export interface StrategicGraph {
  /** Coarse grid cells per face edge the graph was built on. */
  resolution: number;
  radius: number;
  nodes: LandNode[];
  lanes: SeaLane[];
  chokepoints: Chokepoint[];
  barrierLines: BarrierLine[];
  fronts: FrontGeometry[];
  /**
   * Coast-to-coast sea distance between nodes (m), row-major nodes × nodes;
   * Infinity where no sea route exists, 0 on the diagonal.
   */
  nodeDistance: Float32Array;
  /** Total airbase sites over all nodes. */
  airbaseCapacity: number;
  timings: { stage: string; ms: number }[];
}

// ---- Tuning (design, "Reading the World") ----

/** Minimum distance between candidate airbase sites (m). */
export const AIRBASE_SPACING = 40e3;
/** Minimum distance between candidate port sites (m). */
export const PORT_SPACING = 120e3;
/** Islands closer than this, coast to coast, merge into one archipelago (m). */
export const ARCHIPELAGO_LINK = 300e3;
/** Straits narrower than this are chokepoints (m). */
export const STRAIT_MAX_WIDTH = 150e3;
/** Airfield islands within this distance of a lane are chokepoints (m). */
export const ISLAND_REACH = 300e3;
/** Each side of a front's start line holds at least this fraction of the landmass. */
export const FRONT_MIN_SIDE = 0.35;
/** Landmasses smaller than this get no barrier lines (m²). */
export const FRONT_MIN_AREA = 250_000e6;
/** Corridor axis half-length into each side (m). */
export const CORRIDOR_DEPTH = 100e3;

// ---- Helpers ----

export function sitePoint(list: SiteList, i: number): Point {
  return [list.points[i * 3]!, list.points[i * 3 + 1]!, list.points[i * 3 + 2]!];
}

export function siteCount(list: SiteList): number {
  return list.cells.length;
}

export function polylinePoint(points: Float64Array, i: number): Point {
  return [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
}

/** Great-circle distance between unit directions (m). */
export function surfaceDistance(a: Readonly<Point>, b: Readonly<Point>, radius: number): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return radius * Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), dot);
}

/** Latitude and longitude (rad) of a unit direction (+Y north, +Z lon 0, +X lon 90° E). */
export function pointLatLon(p: Readonly<Point>): { lat: number; lon: number } {
  return { lat: Math.asin(Math.max(-1, Math.min(1, p[1]))), lon: Math.atan2(p[0], p[2]) };
}

/** Shortest surface distance from a point to a polyline (m), by sampling segments. */
export function distanceToPolyline(
  p: Readonly<Point>,
  points: Float64Array,
  radius: number,
): number {
  let best = Infinity;
  const count = points.length / 3;
  for (let i = 0; i < count; i++) {
    best = Math.min(best, surfaceDistance(p, polylinePoint(points, i), radius));
  }
  return best;
}

export function nodeDistance(g: StrategicGraph, a: number, b: number): number {
  return g.nodeDistance[a * g.nodes.length + b]!;
}

/** Every typed array in the graph, for a postMessage transfer list. */
export function graphBuffers(g: StrategicGraph): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [g.nodeDistance.buffer];
  for (const n of g.nodes) {
    for (const s of [n.ports, n.airbases])
      out.push(s.cells.buffer, s.points.buffer, s.scores.buffer);
  }
  for (const l of g.lanes) out.push(l.points.buffer);
  for (const l of g.barrierLines) {
    out.push(l.points.buffer, l.strength.buffer, l.airbaseOffset.buffer, l.portOffset.buffer);
  }
  // A buffer may appear only once in a transfer list.
  return [...new Set(out)] as ArrayBuffer[];
}
