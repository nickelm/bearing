/**
 * Land nodes of the strategic graph: every landmass of at least
 * LANDMASS_MIN_AREA, plus archipelago nodes that merge smaller islands lying
 * within ARCHIPELAGO_LINK of each other, coast to coast (single linkage).
 */
import { LANDMASS_MIN_AREA } from '../pipeline';
import type { LandmassStats } from '../landmasses';
import { ARCHIPELAGO_LINK } from './graph';
import type { LandNode, Point, SiteList, TerrainMix } from './graph';
import type { StrategicContext } from './input';
import { mergeSites } from './sites';
import type { PortSites } from './sites';

/** Archipelagos smaller than this in total are not nodes (their islands can still be chokepoints). */
export const ARCHIPELAGO_MIN_AREA = 1000e6;

export interface NodeBuild {
  nodes: LandNode[];
  /** Node id per landmass label, −1 for islands in no node. */
  nodeOfLandmass: Int32Array;
  /** Per node: sea cells of its port sites, in `ports` order. */
  portSea: Int32Array[];
  /** Per node: landmass labels it contains. */
  members: number[][];
}

function dot(a: Readonly<Point>, b: Readonly<Point>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Union–find with path halving; the root is the smallest index, so results are order-independent. */
class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]!]!;
      i = p[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

export function buildNodes(
  ctx: StrategicContext,
  airbases: SiteList[],
  ports: PortSites[],
): NodeBuild {
  const { grid, labels, stats, radius } = ctx;
  const lms = labels.landmasses;
  const cellsOf: number[][] = lms.map(() => []);
  for (let c = 0; c < grid.cellCount; c++) {
    const id = labels.label[c]!;
    if (id >= 0) cellsOf[id]!.push(c);
  }
  const extentOf = (centroid: Point, cells: number[]): number => {
    let minDot = 1;
    for (const c of cells) {
      minDot = Math.min(
        minDot,
        dot(centroid, [grid.centers[c * 3]!, grid.centers[c * 3 + 1]!, grid.centers[c * 3 + 2]!]),
      );
    }
    return Math.acos(Math.max(-1, Math.min(1, minDot))) * radius;
  };

  // Small islands: single linkage by coast-to-coast distance (cells are small, so all cells).
  const small = lms.filter((m) => m.area < LANDMASS_MIN_AREA).map((m) => m.id);
  const uf = new UnionFind(lms.length);
  const ext = new Float64Array(lms.length);
  for (const id of small) ext[id] = extentOf(stats[id]!.centroid, cellsOf[id]!);
  const linkAngle = ARCHIPELAGO_LINK / radius;
  const linkDot = Math.cos(linkAngle);
  for (let x = 0; x < small.length; x++) {
    const a = small[x]!;
    for (let y = x + 1; y < small.length; y++) {
      const b = small[y]!;
      const gap =
        Math.acos(Math.max(-1, Math.min(1, dot(stats[a]!.centroid, stats[b]!.centroid)))) * radius;
      if (gap - ext[a]! - ext[b]! > ARCHIPELAGO_LINK + ctx.cellSize) continue;
      if (uf.find(a) === uf.find(b)) continue;
      let linked = false;
      for (const ca of cellsOf[a]!) {
        for (const cb of cellsOf[b]!) {
          const d =
            grid.centers[ca * 3]! * grid.centers[cb * 3]! +
            grid.centers[ca * 3 + 1]! * grid.centers[cb * 3 + 1]! +
            grid.centers[ca * 3 + 2]! * grid.centers[cb * 3 + 2]!;
          if (d >= linkDot) {
            linked = true;
            break;
          }
        }
        if (linked) break;
      }
      if (linked) uf.union(a, b);
    }
  }
  const clusters = new Map<number, number[]>();
  for (const id of small) {
    const r = uf.find(id);
    let list = clusters.get(r);
    if (!list) clusters.set(r, (list = []));
    list.push(id);
  }

  // Groups of landmass labels that become nodes: big landmasses first (by area, as labeled),
  // then archipelagos by total area (ties by smallest member label).
  const groups: { kind: LandNode['kind']; members: number[] }[] = lms
    .filter((m) => m.area >= LANDMASS_MIN_AREA)
    .map((m) => ({ kind: 'landmass' as const, members: [m.id] }));
  const archipelagos = [...clusters.values()]
    .map((members) => ({
      members,
      area: members.reduce((s, id) => s + lms[id]!.area, 0),
    }))
    .filter((c) => c.area >= ARCHIPELAGO_MIN_AREA)
    .sort((a, b) => b.area - a.area || a.members[0]! - b.members[0]!);
  for (const a of archipelagos) groups.push({ kind: 'archipelago', members: a.members });

  const nodeOfLandmass = new Int32Array(lms.length).fill(-1);
  const nodes: LandNode[] = [];
  const portSea: Int32Array[] = [];
  groups.forEach((g, id) => {
    for (const m of g.members) nodeOfLandmass[m] = id;
    const st: LandmassStats[] = g.members.map((m) => stats[m]!);
    const area = st.reduce((s, x) => s + x.area, 0);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const x of st) {
      cx += x.centroid[0] * x.area;
      cy += x.centroid[1] * x.area;
      cz += x.centroid[2] * x.area;
    }
    const len = Math.hypot(cx, cy, cz) || 1;
    const centroid: Point = [cx / len, cy / len, cz / len];
    const terrain: TerrainMix = { plains: 0, hills: 0, mountains: 0, forest: 0, desert: 0, ice: 0 };
    for (const x of st) {
      for (const k of Object.keys(terrain) as (keyof TerrainMix)[]) {
        terrain[k] += (x.terrain[k] * x.area) / area;
      }
    }
    // Ports and airbases of an archipelago: each island's, larger islands first.
    nodes.push({
      id,
      kind: g.kind,
      area,
      centroid,
      coastlineLength: st.reduce((s, x) => s + x.coastlineLength, 0),
      latMin: Math.min(...st.map((x) => x.latMin)),
      latMax: Math.max(...st.map((x) => x.latMax)),
      terrain,
      islandCount: g.members.length,
      extent: extentOf(
        centroid,
        g.members.flatMap((m) => cellsOf[m]!),
      ),
      ports: mergeSites(g.members.map((m) => ports[m]!.list)),
      airbases: mergeSites(g.members.map((m) => airbases[m]!)),
      front: -1,
      feature: -1,
      flavor: 0,
    });
    const seas = g.members.map((m) => ports[m]!.sea);
    const sea = new Int32Array(seas.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of seas) {
      sea.set(a, o);
      o += a.length;
    }
    portSea.push(sea);
  });
  return { nodes, nodeOfLandmass, portSea, members: groups.map((g) => g.members) };
}
