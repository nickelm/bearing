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
  /** The node's named feature (continent, island or archipelago) in `StrategicGraph.features`. */
  feature: number;
  /** Naming flavor of the node's region (decision 96; worldgen/names/flavors.ts). */
  flavor: number;
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
  /**
   * Signed distance of every settlement in `StrategicGraph.settlements` from
   * the line, as for airbases; NaN for settlements on other landmasses.
   */
  settlementOffset: Float32Array;
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
  /** Roads crossing the line within the segment. */
  roads: number;
  /** Crossings weighted by road class (highway 1, main 0.6, minor 0.3). */
  roadScore: number;
  /** Name from the toponymy stage, e.g. "the Kessar Gap" (decision 96). */
  name: string;
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

/**
 * Towns and cities (milestone 5), struct-of-arrays, in placement order. They
 * belong to the world, not to a side: casting derives ownership from
 * territory.
 */
export interface SettlementList {
  /** Coarse-grid cell of each settlement. */
  cells: Int32Array;
  /** Unit direction, xyz interleaved. */
  points: Float64Array;
  population: Float32Array;
  /** Land node, or −1 for islands in no node. */
  node: Int32Array;
  /** SETTLEMENT_PORT | SETTLEMENT_RIVER | SETTLEMENT_COAST. */
  flags: Uint8Array;
  names: string[];
}

export const SETTLEMENT_PORT = 1;
export const SETTLEMENT_RIVER = 2;
export const SETTLEMENT_COAST = 4;

export type SettlementKind = 'city' | 'town' | 'village';
/** Map classes of a settlement: a side's capital is drawn above its kind (decision 103). */
export type SettlementClass = SettlementKind | 'capital';

export function settlementKind(population: number): SettlementKind {
  return population >= 200_000 ? 'city' : population >= 40_000 ? 'town' : 'village';
}

/**
 * Road classes, widest first (decision 103): set by the gravity-model traffic each
 * road carries (roads.ts `classifyRoads`).
 */
export const RoadClass = { Motorway: 0, Trunk: 1, Secondary: 2 } as const;
export type RoadClass = (typeof RoadClass)[keyof typeof RoadClass];
export const ROAD_CLASS_NAMES: readonly string[] = ['motorway', 'trunk', 'secondary'];
/** Paved width per road class (m). */
export const ROAD_WIDTH: readonly number[] = [24, 12, 7];
/** Weight of a road class when scoring corridors. */
export const ROAD_CLASS_WEIGHT: readonly number[] = [1, 0.6, 0.3];

/**
 * A road network as polylines through coarse-cell centers. Polylines meet at
 * shared end cells (junctions, settlements), so the network is connected
 * wherever the roads are.
 */
export interface RoadNetwork {
  count: number;
  /** Point range of polyline k: [offsets[k], offsets[k + 1]). */
  offsets: Uint32Array;
  cells: Int32Array;
  /** Unit directions, xyz interleaved. */
  points: Float64Array;
  /** RoadClass per polyline (railways: 0). */
  roadClass: Uint8Array;
  /**
   * Gravity-model traffic over each polyline (decision 103): the summed flows
   * P_a · P_b / d² (people², d in km, at least TRAFFIC_MIN_DISTANCE) between pairs of
   * trunk settlements whose shortest road path uses it. 0 on railways and spurs.
   */
  traffic: Float32Array;
  /** Route (index into `StrategicGraph.routes`) each polyline belongs to, or −1. */
  route: Int32Array;
}

/** Kinds of route: numbered major roads, and named pass and coast roads. */
export const RouteKind = { Numbered: 0, Pass: 1, Coast: 2 } as const;
export type RouteKind = (typeof RouteKind)[keyof typeof RouteKind];

/**
 * Routes (decision 103): chains of road polylines that read as one road. Motorway and
 * trunk chains get route numbers ("M4", "R12"); notable chains through mountain passes
 * or along coasts get names ("the Kessar Pass Road"), whatever their class.
 */
export interface RouteList {
  count: number;
  /** Road polylines of route k, in order along it: roads[offsets[k], offsets[k + 1]). */
  offsets: Uint32Array;
  roads: Int32Array;
  /** Widest class on the route. */
  roadClass: Uint8Array;
  kind: Uint8Array;
  /** Length along the route (m). */
  length: Float32Array;
  /** Naming region (land node) of the route, −1 if none. */
  region: Int32Array;
  /** "M4", "R12", or "" for unnumbered routes (named secondary roads). */
  numbers: string[];
  /** "the Kessar Pass Road", or "" for routes with a number only. */
  names: string[];
}

/**
 * Urban extents (decision 103): one polygon per settlement, `URBAN_VERTICES` unit
 * directions around it in counterclockwise order seen from above, grown from the
 * settlement's built-up area along its roads and held back by water and steep ground.
 */
export interface UrbanExtents {
  /** xyz interleaved, URBAN_VERTICES points per settlement in settlement order. */
  points: Float64Array;
  /** Built-up area of each polygon (m²). */
  area: Float32Array;
}

export const URBAN_VERTICES = 24;

/**
 * Railways (decision 103) between major cities, ports and the largest towns of each
 * landmass, as polylines like roads (all `roadClass` 0), with their bridges and yards.
 */
export interface RailNetwork {
  lines: RoadNetwork;
  bridges: BridgeList;
  /** Settlements with a station, in settlement order. */
  stations: Int32Array;
  /** Rail yards: the stations of cities and rail junctions, targetable features. */
  yards: SiteList;
  /** Settlement at each yard, or −1 at a junction outside towns. */
  yardSettlement: Int32Array;
}

/** Road bridges over rivers at least BRIDGE_MIN_WIDTH wide: targetable features. */
export interface BridgeList {
  cells: Int32Array;
  points: Float64Array;
  /** Width of the river spanned (m). */
  riverWidth: Float32Array;
  /** Polyline of the road carried (in the network the bridge belongs to). */
  road: Int32Array;
  roadClass: Uint8Array;
}

// ---- Named features (design pipeline steps 7 and 8; decisions 95, 96) ----

/** Kinds of named feature. Codes are stored in `FeatureList.kind`. */
export const FeatureKind = {
  Continent: 0,
  Island: 1,
  Archipelago: 2,
  Ocean: 3,
  Sea: 4,
  Bay: 5,
  Strait: 6,
  Lake: 7,
  Range: 8,
  Peak: 9,
  Hills: 10,
  Plain: 11,
  Plateau: 12,
  Desert: 13,
  Forest: 14,
  Wetland: 15,
  River: 16,
} as const;
export type FeatureKind = (typeof FeatureKind)[keyof typeof FeatureKind];
export const FEATURE_KIND_COUNT = 17;
export const FEATURE_KIND_NAMES: readonly string[] = [
  'continent',
  'island',
  'archipelago',
  'ocean',
  'sea',
  'bay',
  'strait',
  'lake',
  'range',
  'peak',
  'hills',
  'plain',
  'plateau',
  'desert',
  'forest',
  'wetland',
  'river',
];

export type FeatureGeometry = 'point' | 'polyline' | 'polygon';

/**
 * Geometry per kind. Polygons are rasters on the coarse grid: a feature's cells are
 * those whose entry in its layer (`FEATURE_LAYER`) holds its id; an archipelago is
 * the union of its islands (features whose `parent` is the archipelago). Their
 * polyline (`offsets`, `points`) is a label axis: the longest chord through the
 * anchor along the feature's principal direction. Points have no polyline.
 */
export const FEATURE_GEOMETRY: readonly FeatureGeometry[] = [
  'polygon', // continent
  'polygon', // island
  'polygon', // archipelago (union of its islands)
  'polygon', // ocean
  'polygon', // sea
  'polygon', // bay
  'point', // strait
  'polygon', // lake
  'polygon', // range (with its ridge line as the polyline)
  'point', // peak
  'polygon', // hills
  'polygon', // plain
  'polygon', // plateau
  'polygon', // desert
  'polygon', // forest
  'polygon', // wetland
  'polyline', // river
];

/** Raster layers of polygon features; each cell belongs to at most one feature per layer. */
export type FeatureLayer = 'land' | 'water' | 'relief' | 'cover';
export const FEATURE_LAYER: readonly (FeatureLayer | null)[] = [
  'land',
  'land',
  null,
  'water',
  'water',
  'water',
  null,
  'water',
  'relief',
  null,
  'relief',
  'relief',
  'relief',
  'cover',
  'cover',
  'cover',
  null,
];

/**
 * The world's named geography, struct-of-arrays in id order (decision 95).
 *
 * Per-kind meaning of `height` and `measure`:
 *
 * | Kind | height (m, physical) | measure |
 * |---|---|---|
 * | peak | summit height | prominence (m, physical) |
 * | range, hills, plateau | highest point | mean height (m) |
 * | river | source height | discharge at the mouth (m³/s) |
 * | strait | 0 | width of water (m) |
 * | sea, bay, ocean | 0 | greatest distance from land (m) |
 * | lake | surface height | greatest depth (m) |
 * | desert | highest point | hot (sand) share of its cells, 0..1 |
 * | others | highest point | 0 |
 */
export interface FeatureList {
  count: number;
  kind: Uint8Array;
  /** 0..1, comparable across kinds: labels rank by it. */
  importance: Float32Array;
  /** Label anchor, xyz interleaved unit directions: a point inside the feature. */
  anchor: Float64Array;
  /** Radius of a cap around the anchor that holds the feature (m). */
  extent: Float32Array;
  /** Area (m²) of polygons, length (m) of rivers, 0 for points. */
  size: Float32Array;
  height: Float32Array;
  measure: Float32Array;
  /** Enclosing feature: a peak's range, an island's archipelago; −1 if none. */
  parent: Int32Array;
  /** Naming region: the land node the feature lies on or next to (−1 if none). */
  region: Int32Array;
  /** Polyline of feature k: points [offsets[k], offsets[k + 1]). */
  offsets: Uint32Array;
  /** Unit directions, xyz interleaved. */
  points: Float64Array;
  /** Feature id per coarse cell in each raster layer, −1 for none. */
  layers: Record<FeatureLayer, Int16Array>;
  names: string[];
}

export interface StrategicGraph {
  /** Coarse grid cells per face edge the graph was built on. */
  resolution: number;
  radius: number;
  nodes: LandNode[];
  settlements: SettlementList;
  /**
   * Habitability 0..255 per coarse cell (fertile, flat, watered lowland
   * high): where people live outside towns. Drives rural night lights.
   */
  habitability: Uint8Array;
  roads: RoadNetwork;
  bridges: BridgeList;
  /** Numbered and named roads (decision 103). */
  routes: RouteList;
  railways: RailNetwork;
  /** Urban extent polygons per settlement (decision 103). */
  urban: UrbanExtents;
  /** Named geography (decision 95). */
  features: FeatureList;
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
    out.push(
      l.points.buffer,
      l.strength.buffer,
      l.airbaseOffset.buffer,
      l.portOffset.buffer,
      l.settlementOffset.buffer,
    );
  }
  const s = g.settlements;
  out.push(s.cells.buffer, s.points.buffer, s.population.buffer, s.node.buffer, s.flags.buffer);
  out.push(g.habitability.buffer);
  out.push(...roadBuffers(g.roads), ...bridgeBuffers(g.bridges), ...featureBuffers(g.features));
  const rt = g.routes;
  out.push(rt.offsets.buffer, rt.roads.buffer, rt.roadClass.buffer, rt.kind.buffer);
  out.push(rt.length.buffer, rt.region.buffer);
  const rw = g.railways;
  out.push(...roadBuffers(rw.lines), ...bridgeBuffers(rw.bridges), rw.stations.buffer);
  out.push(rw.yards.cells.buffer, rw.yards.points.buffer, rw.yards.scores.buffer);
  out.push(rw.yardSettlement.buffer, g.urban.points.buffer, g.urban.area.buffer);
  // A buffer may appear only once in a transfer list.
  return [...new Set(out)] as ArrayBuffer[];
}

export function roadBuffers(r: RoadNetwork): ArrayBufferLike[] {
  return [
    r.offsets.buffer,
    r.cells.buffer,
    r.points.buffer,
    r.roadClass.buffer,
    r.traffic.buffer,
    r.route.buffer,
  ];
}

export function bridgeBuffers(b: BridgeList): ArrayBufferLike[] {
  return [b.cells.buffer, b.points.buffer, b.riverWidth.buffer, b.road.buffer, b.roadClass.buffer];
}

export function settlementPoint(s: SettlementList, i: number): Point {
  return [s.points[i * 3]!, s.points[i * 3 + 1]!, s.points[i * 3 + 2]!];
}

export function settlementCount(s: SettlementList): number {
  return s.cells.length;
}

export function featureBuffers(f: FeatureList): ArrayBufferLike[] {
  return [
    f.kind.buffer,
    f.importance.buffer,
    f.anchor.buffer,
    f.extent.buffer,
    f.size.buffer,
    f.height.buffer,
    f.measure.buffer,
    f.parent.buffer,
    f.region.buffer,
    f.offsets.buffer,
    f.points.buffer,
    f.layers.land.buffer,
    f.layers.water.buffer,
    f.layers.relief.buffer,
    f.layers.cover.buffer,
  ];
}

export function featureAnchor(f: FeatureList, i: number): Point {
  return [f.anchor[i * 3]!, f.anchor[i * 3 + 1]!, f.anchor[i * 3 + 2]!];
}

/** The polyline of feature i (a subarray view, xyz interleaved). */
export function featurePolyline(f: FeatureList, i: number): Float64Array {
  return f.points.subarray(f.offsets[i]! * 3, f.offsets[i + 1]! * 3);
}

/** Feature ids of the given kinds. */
export function featuresOfKind(f: FeatureList, ...kinds: FeatureKind[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < f.count; i++) if (kinds.includes(f.kind[i] as FeatureKind)) out.push(i);
  return out;
}

/** The feature of a layer at a coarse cell, or −1. */
export function featureAt(f: FeatureList, layer: FeatureLayer, cell: number): number {
  return f.layers[layer][cell]!;
}

/** Display text of a name on the map: cartographic labels drop the leading article. */
export function labelText(name: string): string {
  return name.startsWith('the ') ? name.slice(4) : name;
}

/** The feature of the given kinds whose anchor is nearest to `p`, within `within` (m), or −1. */
export function nearestFeature(
  g: StrategicGraph,
  p: Readonly<Point>,
  kinds: readonly FeatureKind[],
  within = Infinity,
): number {
  const f = g.features;
  let best = -1;
  let bestD = within;
  for (let i = 0; i < f.count; i++) {
    if (!kinds.includes(f.kind[i] as FeatureKind)) continue;
    const d = surfaceDistance(p, featureAnchor(f, i), g.radius);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Features of the given kinds that run along a polyline: at least `share` of the
 * feature's own polyline (its anchor, for points) lies within `within` (m) of the
 * line. Most important first.
 */
export function featuresAlong(
  g: StrategicGraph,
  line: Float64Array,
  kinds: readonly FeatureKind[],
  within: number,
  share = 0.3,
): number[] {
  const f = g.features;
  const out: number[] = [];
  for (let i = 0; i < f.count; i++) {
    if (!kinds.includes(f.kind[i] as FeatureKind)) continue;
    const own = featurePolyline(f, i);
    const pts = own.length > 0 ? own : f.anchor.subarray(i * 3, i * 3 + 3);
    const n = pts.length / 3;
    let near = 0;
    for (let k = 0; k < n; k++) {
      if (distanceToPolyline(polylinePoint(pts, k), line, g.radius) <= within) near++;
    }
    if (near >= share * n) out.push(i);
  }
  return out.sort((a, b) => f.importance[b]! - f.importance[a]! || a - b);
}

/** The urban extent polygon of settlement i (a subarray view, xyz interleaved). */
export function urbanPolygon(u: UrbanExtents, i: number): Float64Array {
  return u.points.subarray(i * URBAN_VERTICES * 3, (i + 1) * URBAN_VERTICES * 3);
}

/** The points of road polyline k (a subarray view, xyz interleaved). */
export function roadPolyline(r: RoadNetwork, k: number): Float64Array {
  return r.points.subarray(r.offsets[k]! * 3, r.offsets[k + 1]! * 3);
}
