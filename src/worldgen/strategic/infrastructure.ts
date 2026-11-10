/**
 * Military infrastructure placed from the cast (milestone 5; pipeline step
 * 10): ports, airbases with spur roads, and industry and logistics targets.
 *
 * Settlements, the civilian road network and its bridges are world facts in
 * the strategic graph (built before casting). This stage reads the cast and
 * the coarse maps, so it lives with the graph builder (decision 52); its
 * result is plain data that campaign logic and the command layer may read.
 *
 * - **Ports:** every port region of the cast at its graph port site
 *   ('military'), plus up to COMMERCIAL_PORTS_PER_NODE more of each held
 *   node's best port sites ('commercial').
 * - **Airbases,** per side, in this order, at least AIRBASE_MIN_SPACING apart:
 *   1. island airfields on every island node a side holds in an island
 *      campaign or chokepoint theater;
 *   2. forward airfields at chokepoints: on the chokepoint island, or the
 *      best site within CHOKEPOINT_REACH of a strait on each side's land;
 *   3. strategic bomber bases (with a strategic theater): BOMBER_BASES per
 *      side, the flat sites farthest from enemy territory;
 *   4. the rest up to the side's target count, by suitability × a depth
 *      weight that peaks 100–400 km behind a front (lower on whole nodes) ×
 *      road access × a bonus inside the cast's base regions × a random
 *      factor. Bases within FORWARD_DEPTH of the line are 'forward'.
 * - **Spur roads** link every airbase and port off the network to the
 *   nearest road or settlement, with the civilian road search.
 * - **Targets:** factories and power plants in the cast's industry regions,
 *   one refinery per side, supply depots at road junctions 60–150 km behind
 *   each front, rail yards in the largest towns 150–400 km back, and fuel
 *   depots at military ports.
 *
 * Draws from rng(seed, "infrastructure") forks only.
 */
import type { Cast, Side } from '../../campaign/cast';
import { NameGenerator } from '../../core/names';
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import { Vec3d } from '../../core/vec3d';
import type { StrategicBuild } from './builder';
import {
  RoadClass,
  sitePoint,
  surfaceDistance,
  settlementPoint,
  SETTLEMENT_COAST,
  SETTLEMENT_PORT,
} from './graph';
import type { BridgeList, Point, RoadNetwork } from './graph';
import { findBridges, roadPolylines } from './roads';
import { airbaseSuitability } from './sites';
import {
  buildTerritory,
  distanceFrom,
  TERRITORY_ALLIANCE,
  TERRITORY_PACT,
  territoryCode,
} from './territory';
import type { Territory } from './territory';

export type AirbaseKind = 'main' | 'forward' | 'bomber' | 'island';
export type PortKind = 'military' | 'commercial';
export type TargetKind =
  'factory' | 'power-plant' | 'refinery' | 'rail-yard' | 'supply-depot' | 'fuel-depot';

export interface Airbase {
  id: number;
  name: string;
  kind: AirbaseKind;
  side: Side;
  /** Land node, or −1. */
  node: number;
  /** Theater it mainly serves (index into Cast.theaters), or −1. */
  theater: number;
  cell: number;
  point: Point;
  /** Runway heading, radians clockwise from north (0..π). */
  heading: number;
  runwayLength: number;
  /** Distance behind its front's start line (m), or −1 off fronts. */
  depth: number;
}

export interface Port {
  id: number;
  name: string;
  kind: PortKind;
  side: Side;
  node: number;
  cell: number;
  point: Point;
  /** Theaters whose port regions it fills. */
  theaters: number[];
  /** Sea lanes that end at it. */
  lanes: number[];
  /** Settlement at the port, or −1. */
  settlement: number;
}

export interface TargetSite {
  id: number;
  kind: TargetKind;
  name: string;
  side: Side;
  theater: number;
  cell: number;
  point: Point;
  /** Target value 0..1 for the ATO's priority score (decision 50). */
  value: number;
  settlement: number;
}

export interface Infrastructure {
  /** Holder of each settlement in graph order: 'alliance', 'pact' or null (neutral). */
  settlementSide: (Side | null)[];
  ports: Port[];
  airbases: Airbase[];
  targets: TargetSite[];
  /** Spur roads from airbases and ports to the civilian network (minor roads). */
  spurs: RoadNetwork;
  /** Bridges on the spur roads. */
  spurBridges: BridgeList;
  timings: { stage: string; ms: number }[];
}

// ---- Tuning ----

export const AIRBASE_MIN_SPACING = 40e3;
/** Airbases per side: MIN_AIRBASES plus one per AIRBASE_AREA of held land, at most MAX_AIRBASES. */
export const MIN_AIRBASES = 15;
export const MAX_AIRBASES = 45;
const AIRBASE_AREA = 80_000e6;
export const BOMBER_BASES = 2;
const BOMBER_SPACING = 250e3;
/** Bases closer than this to the start line are forward airfields (m). */
export const FORWARD_DEPTH = 120e3;
const CHOKEPOINT_REACH = 200e3;
const COMMERCIAL_PORTS_PER_NODE = 3;
const RUNWAY_LENGTH: Record<AirbaseKind, number> = {
  main: 2700,
  forward: 2000,
  bomber: 3600,
  island: 2200,
};
/** Spur roads give up beyond this much route cost (m of flat road). */
const SPUR_MAX_COST = 400e3;

const SIDES: readonly Side[] = ['alliance', 'pact'];

/** Depth weight for airbases behind a front: densest 100–400 km back. */
export function airbaseDepthWeight(depth: number): number {
  if (depth < 50e3) return 0.25;
  if (depth < 100e3) return 0.25 + (0.75 * (depth - 50e3)) / 50e3;
  if (depth <= 400e3) return 1;
  if (depth < 800e3) return 1 - (0.65 * (depth - 400e3)) / 400e3;
  return 0.3;
}

function cellPoint(build: StrategicBuild, c: number): Point {
  const g = build.ctx.grid.centers;
  return [g[c * 3]!, g[c * 3 + 1]!, g[c * 3 + 2]!];
}

function sideOf(code: number): Side | null {
  return code === TERRITORY_ALLIANCE ? 'alliance' : code === TERRITORY_PACT ? 'pact' : null;
}

/** Unique names: a repeated base name gets a compass suffix or a number. */
class Namer {
  private readonly used = new Map<string, number>();
  name(base: string): string {
    const k = this.used.get(base) ?? 0;
    this.used.set(base, k + 1);
    if (k === 0) return base;
    const suffix = ['North', 'South', 'East', 'West'][k - 1] ?? String(k + 1);
    return `${base} ${suffix}`;
  }
}

export function placeInfrastructure(
  build: StrategicBuild,
  cast: Cast,
  seed: WorldSeed,
): Infrastructure {
  const timings: { stage: string; ms: number }[] = [];
  let t0 = performance.now();
  const lap = (stage: string) => {
    const now = performance.now();
    timings.push({ stage, ms: now - t0 });
    t0 = now;
  };
  const { ctx, graph } = build;
  const R = ctx.radius;
  const r = rng(seed, 'infrastructure');
  const territory = buildTerritory(build, cast);
  const s = graph.settlements;
  const settlementSide = Array.from(s.cells, (c) => sideOf(territory.owner[c]!));
  lap('territory');

  const nearestSettlement = (p: Readonly<Point>, side: Side | null, within: number) => {
    let best = -1;
    let bestD = within;
    for (let i = 0; i < s.cells.length; i++) {
      if (side && settlementSide[i] !== side) continue;
      const d = surfaceDistance(p, settlementPoint(s, i), R);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const ports = placePorts(build, cast, territory, nearestSettlement);
  lap('ports');
  const airbases = placeAirbases(build, cast, territory, r.fork('airbases'), nearestSettlement);
  lap('airbases');

  // Spur roads to the civilian network.
  const roads = build.roads;
  const civilian = new Set(roads.edges.keys());
  const onNetwork = new Set<number>([...roads.cellsOnRoad(), ...s.cells]);
  for (const c of [...airbases.map((a) => a.cell), ...ports.map((p) => p.cell)]) {
    if (onNetwork.has(c)) continue;
    const path = roads.route(c, -1, (x) => onNetwork.has(x), SPUR_MAX_COST);
    if (!path) continue;
    roads.addPath(path, 0);
    for (const x of path) onNetwork.add(x);
  }
  const spurEdges = new Map<number, number>();
  for (const [k, v] of roads.edges) if (!civilian.has(k)) spurEdges.set(k, v);
  const spurs = roadPolylines(ctx, spurEdges);
  const known = new Set(graph.bridges.cells);
  const all = findBridges(ctx, roads.rivers, spurEdges, spurs);
  const keep = [...all.cells.keys()].filter((i) => !known.has(all.cells[i]!));
  const spurBridges: BridgeList = {
    cells: Int32Array.from(keep, (i) => all.cells[i]!),
    points: Float64Array.from(keep.flatMap((i) => [...all.points.subarray(i * 3, i * 3 + 3)])),
    riverWidth: Float32Array.from(keep, (i) => all.riverWidth[i]!),
    road: Int32Array.from(keep, (i) => all.road[i]!),
    roadClass: Uint8Array.from(keep, () => RoadClass.Minor),
  };
  lap('spur roads');

  const targets = placeTargets(build, cast, territory, settlementSide, ports, r.fork('targets'));
  lap('targets');
  return { settlementSide, ports, airbases, targets, spurs, spurBridges, timings };
}

type NearestSettlement = (p: Readonly<Point>, side: Side | null, within: number) => number;

function placePorts(
  build: StrategicBuild,
  cast: Cast,
  territory: Territory,
  nearestSettlement: NearestSettlement,
): Port[] {
  const { graph } = build;
  const R = graph.radius;
  const ports: Port[] = [];
  const byKey = new Map<string, Port>();
  const namer = new Namer();
  const add = (nodeId: number, site: number, kind: PortKind, side: Side, theater: number) => {
    const key = `${nodeId}:${site}`;
    const existing = byKey.get(key);
    if (existing) {
      if (theater >= 0 && !existing.theaters.includes(theater)) existing.theaters.push(theater);
      return;
    }
    const n = graph.nodes[nodeId]!;
    const point = sitePoint(n.ports, site);
    const settlement = nearestSettlement(point, null, 30e3);
    const lanes = graph.lanes
      .filter((l) => (l.a === nodeId && l.portA === site) || (l.b === nodeId && l.portB === site))
      .map((l) => l.id);
    const town = settlement >= 0 ? graph.settlements.names[settlement]! : cast.nodeNames[nodeId]!;
    const port: Port = {
      id: ports.length,
      name: namer.name(`Port of ${town.replace(/^the /, '')}`),
      kind,
      side,
      node: nodeId,
      cell: n.ports.cells[site]!,
      point,
      theaters: theater >= 0 ? [theater] : [],
      lanes,
      settlement,
    };
    ports.push(port);
    byKey.set(key, port);
  };
  // Military ports at the cast's port regions (each centered on a port site).
  for (const reg of cast.regions) {
    if (reg.kind !== 'port') continue;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    graph.nodes.forEach((n, id) => {
      for (let i = 0; i < n.ports.cells.length; i++) {
        const d = surfaceDistance(reg.point, sitePoint(n.ports, i), R);
        if (d < bestD) {
          bestD = d;
          best = [id, i];
        }
      }
    });
    if (best && bestD <= reg.radius) add(best[0], best[1], 'military', reg.side, reg.theater);
  }
  // Commercial ports: each held node's best remaining port sites, per side.
  graph.nodes.forEach((n, id) => {
    const taken: Record<Side, number> = { alliance: 0, pact: 0 };
    for (let i = 0; i < n.ports.cells.length; i++) {
      const side = sideOf(territory.owner[n.ports.cells[i]!]!);
      if (!side || taken[side] >= COMMERCIAL_PORTS_PER_NODE) continue;
      if (byKey.has(`${id}:${i}`)) continue;
      taken[side]++;
      add(id, i, 'commercial', side, -1);
    }
  });
  return ports;
}

function placeAirbases(
  build: StrategicBuild,
  cast: Cast,
  territory: Territory,
  r: Rng,
  nearestSettlement: NearestSettlement,
): Airbase[] {
  const { ctx, graph, walker } = build;
  const { grid, radius } = ctx;
  const n = grid.cellCount;
  const owner = territory.owner;

  // Candidate cells and their attributes.
  const suit = new Float32Array(n).fill(-1);
  for (let c = 0; c < n; c++) if (sideOf(owner[c]!)) suit[c] = airbaseSuitability(ctx, c);
  const roadCells = build.roads.cellsOnRoad();
  const settlementCells = new Set(graph.settlements.cells);
  const land = (c: number) => ctx.labels.label[c]! >= 0;
  const roadDist = distanceFrom(build, (c) => roadCells.has(c) || settlementCells.has(c), land);
  const enemyDist: Record<Side, Float32Array> = {
    alliance: distanceFrom(build, (c) => owner[c] === TERRITORY_PACT),
    pact: distanceFrom(build, (c) => owner[c] === TERRITORY_ALLIANCE),
  };
  // One random factor per cell, drawn in cell order whatever is kept.
  const jitter = new Float32Array(n);
  for (let c = 0; c < n; c++) jitter[c] = r.nextFloat();
  const headings = r.fork('headings');

  const blocked: Record<Side, Uint8Array> = {
    alliance: new Uint8Array(n),
    pact: new Uint8Array(n),
  };
  const out: Airbase[] = [];
  const namer = new Namer();
  const fallbackNames = new NameGenerator(r.fork('names'));
  const regionTheater = (c: number, side: Side): number => {
    if (territory.frontTheater[c]! >= 0) return territory.frontTheater[c]!;
    const p = cellPoint(build, c);
    let best = -1;
    let bestD = Infinity;
    for (const reg of cast.regions) {
      if (reg.side !== side || reg.theater < 0 || reg.kind !== 'base') continue;
      const d = surfaceDistance(p, reg.point, radius);
      if (d < bestD) {
        bestD = d;
        best = reg.theater;
      }
    }
    return best;
  };
  const add = (c: number, side: Side, kind: AirbaseKind, theater: number, spacing: number) => {
    const point = cellPoint(build, c);
    const town = nearestSettlement(point, side, 60e3);
    const base = town >= 0 ? graph.settlements.names[town]! : fallbackNames.short();
    const depth = Number.isFinite(territory.frontDepth[c]!) ? territory.frontDepth[c]! : -1;
    out.push({
      id: out.length,
      name: namer.name(`${base} ${kind === 'main' || kind === 'bomber' ? 'Air Base' : 'Airfield'}`),
      kind,
      side,
      node: territory.node[c]!,
      theater: theater >= 0 ? theater : regionTheater(c, side),
      cell: c,
      point,
      // Runways roughly along the prevailing (zonal) winds.
      heading: Math.PI / 2 + headings.range(-0.6, 0.6),
      runwayLength: RUNWAY_LENGTH[kind],
      depth,
    });
    walker.walk(c, Math.max(spacing, 1.5 * ctx.cellSize) / radius, (x) => (blocked[side][x] = 1));
  };
  const free = (c: number, side: Side) =>
    suit[c]! >= 0 && !blocked[side][c] && sideOf(owner[c]!) === side;
  const best = (cells: Iterable<number>, side: Side, key: (c: number) => number): number => {
    let b = -1;
    let bk = -Infinity;
    for (const c of cells) {
      if (!free(c, side)) continue;
      const k = key(c);
      if (k > bk || (k === bk && c < b)) {
        bk = k;
        b = c;
      }
    }
    return b;
  };
  const cellsOfNode = new Map<number, number[]>();
  for (let c = 0; c < n; c++) {
    const id = territory.node[c]!;
    if (id < 0) continue;
    let l = cellsOfNode.get(id);
    if (!l) cellsOfNode.set(id, (l = []));
    l.push(c);
  }

  // 1. Island airfields.
  for (const t of cast.theaters) {
    if (t.kind !== 'island-campaign' && t.kind !== 'chokepoint') continue;
    for (const id of t.nodes) {
      const o = cast.owners[id];
      if (o?.kind !== 'whole') continue;
      const node = graph.nodes[id]!;
      const want = Math.max(1, Math.min(4, Math.round(node.area / 25_000e6)));
      for (let k = 0; k < want; k++) {
        const c = best(cellsOfNode.get(id) ?? [], o.side, (x) => suit[x]! + 0.3 * jitter[x]!);
        if (c < 0) break;
        add(c, o.side, 'island', t.id, AIRBASE_MIN_SPACING);
      }
    }
  }
  // 2. Forward airfields at strait chokepoints, on each side's shore.
  for (const t of cast.theaters) {
    if (t.kind !== 'chokepoint') continue;
    const cp = graph.chokepoints[t.chokepoint!]!;
    if (cp.kind !== 'strait') continue;
    for (const side of SIDES) {
      const near: number[] = [];
      walker.walk(grid.cellOfDirection(new Vec3d(...cp.point)), CHOKEPOINT_REACH / radius, (c) =>
        near.push(c),
      );
      const c = best(
        near,
        side,
        (x) => suit[x]! - surfaceDistance(cp.point, cellPoint(build, x), radius) / CHOKEPOINT_REACH,
      );
      if (c >= 0) add(c, side, 'forward', t.id, AIRBASE_MIN_SPACING);
    }
  }
  // 3. Strategic bomber bases, far from the enemy.
  if (cast.theaters.some((t) => t.kind === 'strategic')) {
    const strategic = cast.theaters.find((t) => t.kind === 'strategic')!.id;
    for (const side of SIDES) {
      const bombers: Point[] = [];
      for (let k = 0; k < BOMBER_BASES; k++) {
        const c = best(range(n), side, (x) => {
          const p = cellPoint(build, x);
          if (bombers.some((b) => surfaceDistance(b, p, radius) < BOMBER_SPACING)) return -Infinity;
          return suit[x]! * Math.min(1, enemyDist[side][x]! / 1500e3) + 0.05 * jitter[x]!;
        });
        if (c < 0) break;
        bombers.push(cellPoint(build, c));
        add(c, side, 'bomber', strategic, AIRBASE_MIN_SPACING);
      }
    }
  }
  // 4. Main and forward bases up to each side's target count.
  const baseRegions = cast.regions.filter((x) => x.kind === 'base');
  for (const side of SIDES) {
    const code = territoryCode(side);
    let area = 0;
    for (let c = 0; c < n; c++) if (owner[c] === code) area += grid.areas[c]!;
    area *= radius * radius;
    const target = Math.min(MAX_AIRBASES, Math.round(MIN_AIRBASES + area / AIRBASE_AREA));
    const regions = baseRegions.filter((x) => x.side === side);
    const score = new Float32Array(n);
    const cands: number[] = [];
    for (let c = 0; c < n; c++) {
      if (suit[c]! < 0 || owner[c] !== code) continue;
      const depth = territory.frontDepth[c]!;
      const w = Number.isFinite(depth) ? airbaseDepthWeight(depth) : 0.45;
      const road = 1 - 0.6 * smooth(10e3, 60e3, roadDist[c]!);
      const p = cellPoint(build, c);
      const inRegion = regions.some((x) => surfaceDistance(p, x.point, radius) <= x.radius);
      score[c] =
        (0.3 + 0.7 * suit[c]!) * w * road * (inRegion ? 1.6 : 1) * (0.75 + 0.5 * jitter[c]!);
      cands.push(c);
    }
    cands.sort((a, b) => score[b]! - score[a]! || a - b);
    let have = out.filter((a) => a.side === side).length;
    for (const spacing of [AIRBASE_MIN_SPACING, AIRBASE_MIN_SPACING / 2]) {
      for (const c of cands) {
        if (have >= target) break;
        if (!free(c, side)) continue;
        const depth = territory.frontDepth[c]!;
        add(
          c,
          side,
          Number.isFinite(depth) && depth < FORWARD_DEPTH ? 'forward' : 'main',
          -1,
          spacing,
        );
        have++;
      }
      if (have >= Math.min(target, MIN_AIRBASES)) break;
    }
  }
  return out;
}

function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function placeTargets(
  build: StrategicBuild,
  cast: Cast,
  territory: Territory,
  settlementSide: (Side | null)[],
  ports: Port[],
  r: Rng,
): TargetSite[] {
  const { ctx, graph } = build;
  const R = ctx.radius;
  const s = graph.settlements;
  const out: TargetSite[] = [];
  const strategic = cast.theaters.find((t) => t.kind === 'strategic')?.id ?? -1;
  const maxPop = Math.max(1, ...s.population);
  const add = (
    kind: TargetKind,
    side: Side,
    theater: number,
    cell: number,
    settlement: number,
    value: number,
  ) => {
    const place = settlement >= 0 ? s.names[settlement]! : 'field';
    out.push({
      id: out.length,
      kind,
      name: `${place} ${kind.replace('-', ' ')}`,
      side,
      theater,
      cell,
      point: cellPoint(build, cell),
      value: Math.min(1, Math.max(0, value)),
      settlement,
    });
  };
  const popValue = (i: number) => 0.4 + 0.6 * Math.sqrt(s.population[i]! / maxPop);

  // Industry in the cast's industry regions.
  for (const reg of cast.regions) {
    if (reg.kind !== 'industry') continue;
    const towns = [...s.cells.keys()]
      .filter(
        (i) =>
          settlementSide[i] === reg.side &&
          surfaceDistance(reg.point, settlementPoint(s, i), R) <= reg.radius + 20e3,
      )
      .sort((a, b) => s.population[b]! - s.population[a]! || a - b)
      .slice(0, 3);
    towns.forEach((i, k) => {
      add('factory', reg.side, strategic, s.cells[i]!, i, popValue(i));
      if (k === 0) add('power-plant', reg.side, strategic, s.cells[i]!, i, 0.8);
    });
  }
  // One refinery per side: its largest coastal town, preferring one in an industry region.
  for (const side of SIDES) {
    let best = -1;
    let bestKey = -Infinity;
    for (let i = 0; i < s.cells.length; i++) {
      if (settlementSide[i] !== side || !(s.flags[i]! & (SETTLEMENT_COAST | SETTLEMENT_PORT)))
        continue;
      const p = settlementPoint(s, i);
      const inRegion = cast.regions.some(
        (x) =>
          x.kind === 'industry' &&
          x.side === side &&
          surfaceDistance(p, x.point, R) <= x.radius + 40e3,
      );
      const key = s.population[i]! * (inRegion ? 3 : 1) * (0.9 + 0.2 * r.nextFloat());
      if (key > bestKey) {
        bestKey = key;
        best = i;
      }
    }
    if (best >= 0) add('refinery', side, strategic, s.cells[best]!, best, 0.9);
  }
  // Logistics behind each front.
  const roads = graph.roads;
  const degree = new Map<number, number>();
  const classAt = new Map<number, number>();
  for (let k = 0; k < roads.count; k++) {
    for (const p of [roads.offsets[k]!, roads.offsets[k + 1]! - 1]) {
      const c = roads.cells[p]!;
      degree.set(c, (degree.get(c) ?? 0) + 1);
    }
    for (let p = roads.offsets[k]!; p < roads.offsets[k + 1]!; p++) {
      const c = roads.cells[p]!;
      classAt.set(c, Math.min(classAt.get(c) ?? 3, roads.roadClass[k]!));
    }
  }
  for (const t of cast.theaters) {
    if (t.kind !== 'continental-front') continue;
    for (const side of SIDES) {
      const code = territoryCode(side);
      const inBand = (c: number, lo: number, hi: number) =>
        territory.owner[c] === code &&
        territory.frontTheater[c] === t.id &&
        territory.frontDepth[c]! >= lo &&
        territory.frontDepth[c]! <= hi;
      // Supply depots at junctions: busier and better roads first.
      const junctions = [...degree.keys()]
        .filter((c) => inBand(c, 60e3, 150e3))
        .map((c) => ({ c, key: degree.get(c)! * 2 + (3 - (classAt.get(c) ?? 2)) }))
        .sort((a, b) => b.key - a.key || a.c - b.c);
      const depots: number[] = [];
      for (const j of junctions) {
        if (depots.length >= 3) break;
        const p = cellPoint(build, j.c);
        if (depots.some((d) => surfaceDistance(p, cellPoint(build, d), R) < 60e3)) continue;
        depots.push(j.c);
        add('supply-depot', side, t.id, j.c, nearestIn(s, p, R, 30e3), 0.6);
      }
      // Rail yards in the largest towns 150–400 km back.
      const towns = [...s.cells.keys()]
        .filter((i) => inBand(s.cells[i]!, 150e3, 400e3))
        .sort((a, b) => s.population[b]! - s.population[a]! || a - b)
        .slice(0, 2);
      for (const i of towns) add('rail-yard', side, t.id, s.cells[i]!, i, 0.5 + 0.3 * popValue(i));
    }
  }
  // Fuel depots at military ports.
  for (const p of ports) {
    if (p.kind !== 'military') continue;
    add('fuel-depot', p.side, p.theaters[0] ?? strategic, p.cell, p.settlement, 0.55);
  }
  return out;
}

function nearestIn(
  s: StrategicBuild['graph']['settlements'],
  p: Readonly<Point>,
  R: number,
  within: number,
): number {
  let best = -1;
  let bestD = within;
  for (let i = 0; i < s.cells.length; i++) {
    const d = surfaceDistance(p, settlementPoint(s, i), R);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Typed arrays of an Infrastructure, for a transfer list. */
export function infrastructureBuffers(x: Infrastructure): ArrayBufferLike[] {
  const r = x.spurs;
  const b = x.spurBridges;
  return [
    r.offsets.buffer,
    r.cells.buffer,
    r.points.buffer,
    r.roadClass.buffer,
    r.traffic.buffer,
    b.cells.buffer,
    b.points.buffer,
    b.riverWidth.buffer,
    b.road.buffer,
    b.roadClass.buffer,
  ];
}
