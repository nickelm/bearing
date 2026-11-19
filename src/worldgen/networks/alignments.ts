/**
 * The alignment tier's stored record (decision 184): every aligned link of a
 * world in flat typed arrays, kept with the world in IndexedDB, and what the
 * renderer and the terrain read from it.
 *
 * Points are stored as float32 offsets (m) from a float64 origin per link (the
 * link's first point on the sphere): within a few hundred kilometers float32
 * keeps them to centimeters, at half the bytes.
 */
import { Vec3d } from '../../core/vec3d';
import { CORRIDOR_BANKS } from '../edits/corridor';
import type { CorridorEdit } from '../edits/corridor';
import { STRUCTURE } from './alignment';
import type { AlignedLink, ClassKey, Network } from './link';
import { CLASS_KEYS, CROSSING_FIELDS, NETWORK, UNROUTED } from './link';
import type { BridgeList } from '../strategic/graph';
import { FORMATION_HALF_WIDTH } from './pieces';

/** Version of the stored record and the stage that made it: a stored record of another is aligned anew. */
export const ALIGNMENT_VERSION = 3;

export interface Alignments {
  version: number;
  radius: number;
  count: number;
  network: Uint8Array;
  line: Int32Array;
  /** Point range of link k: [offsets[k], offsets[k + 1]). */
  offsets: Uint32Array;
  /** Per link: its first point × radius (m), xyz. */
  origin: Float64Array;
  /** Per point: position − origin (m), xyz. */
  offset: Float32Array;
  design: Float32Array;
  ground: Float32Array;
  structure: Uint8Array;
  cls: Uint8Array;
  /** Per link: pieces routed by a fallback class, by the last resort, and left on their chord. */
  fellBack: Uint16Array;
  forced: Uint16Array;
  unrouted: Uint16Array;
  /** Time the stage took (ms) and the tiles it synthesized. */
  ms: number;
  tiles: number;
  /**
   * River crossings (decision 190): CROSSING_FIELDS each (arc length along the
   * link, point, river index segment, width, span, deck elevation, |sin|), the
   * link of each, and the network bridge it is (`matchBridges`: index into its
   * network's bridge list), or −1 for a bridge the network tier does not know.
   */
  crossings: Float64Array;
  crossingLink: Int32Array;
  crossingBridge: Int32Array;
}

/** Packs aligned links (in any order) into the stored record, sorted by link id. */
export function packAlignments(
  links: readonly AlignedLink[],
  radius: number,
  stats: { ms: number; tiles: number },
): Alignments {
  const sorted = [...links].sort((a, b) => a.id - b.id);
  const count = sorted.length;
  let n = 0;
  let nc = 0;
  for (const l of sorted) {
    n += l.design.length;
    nc += l.crossings.length / CROSSING_FIELDS;
  }
  const al: Alignments = {
    version: ALIGNMENT_VERSION,
    radius,
    count,
    network: new Uint8Array(count),
    line: new Int32Array(count),
    offsets: new Uint32Array(count + 1),
    origin: new Float64Array(count * 3),
    offset: new Float32Array(n * 3),
    design: new Float32Array(n),
    ground: new Float32Array(n),
    structure: new Uint8Array(n),
    cls: new Uint8Array(n),
    fellBack: new Uint16Array(count),
    forced: new Uint16Array(count),
    unrouted: new Uint16Array(count),
    ms: stats.ms,
    tiles: stats.tiles,
    crossings: new Float64Array(nc * CROSSING_FIELDS),
    crossingLink: new Int32Array(nc),
    crossingBridge: new Int32Array(nc).fill(-1),
  };
  let o = 0;
  let c = 0;
  sorted.forEach((l, k) => {
    al.network[k] = l.network;
    al.line[k] = l.line;
    al.offsets[k] = o;
    al.crossings.set(l.crossings, c * CROSSING_FIELDS);
    for (let q = 0; q < l.crossings.length / CROSSING_FIELDS; q++) al.crossingLink[c++] = k;
    al.fellBack[k] = l.fellBack;
    al.forced[k] = l.forced;
    al.unrouted[k] = l.unrouted;
    const ox = l.points[0]! * radius;
    const oy = l.points[1]! * radius;
    const oz = l.points[2]! * radius;
    al.origin.set([ox, oy, oz], k * 3);
    for (let i = 0; i < l.design.length; i++, o++) {
      al.offset[o * 3] = l.points[i * 3]! * radius - ox;
      al.offset[o * 3 + 1] = l.points[i * 3 + 1]! * radius - oy;
      al.offset[o * 3 + 2] = l.points[i * 3 + 2]! * radius - oz;
      al.design[o] = l.design[i]!;
      al.ground[o] = l.ground[i]!;
      al.structure[o] = l.structure[i]!;
      al.cls[o] = l.cls[i]!;
    }
  });
  al.offsets[count] = o;
  return al;
}

/** Unit direction of point `i` of link `k`. */
export function alignedPoint(al: Alignments, k: number, i: number, out = new Vec3d()): Vec3d {
  return out
    .set(
      al.origin[k * 3]! + al.offset[i * 3]!,
      al.origin[k * 3 + 1]! + al.offset[i * 3 + 1]!,
      al.origin[k * 3 + 2]! + al.offset[i * 3 + 2]!,
    )
    .normalize();
}

/** Corridor priority per class: where two overlap, the larger class's formation wins. */
export const CLASS_PRIORITY: Record<ClassKey, number> = {
  motorway: 6,
  mainline: 5,
  trunk: 4,
  mountainRailway: 3,
  secondary: 2,
  mountainRoad: 1,
  track: 0,
};

/**
 * The corridor edits of every link (rule 13): one per run of points carried on
 * the ground in one class, its banks reaching as far as its deepest cut or
 * fill needs. Unrouted pieces, viaducts and tunnels get none.
 */
export function alignmentCorridors(al: Alignments): CorridorEdit[] {
  const out: CorridorEdit[] = [];
  const p = new Vec3d();
  const run = Math.max(CORRIDOR_BANKS.fillRun, CORRIDOR_BANKS.cutRun);
  for (let k = 0; k < al.count; k++) {
    const end = al.offsets[k + 1]!;
    let i = al.offsets[k]!;
    while (i < end) {
      const c = al.cls[i]!;
      if (al.structure[i] !== STRUCTURE.Corridor || c === UNROUTED) {
        i++;
        continue;
      }
      let j = i;
      let deep = 0;
      while (j < end && al.structure[j] === STRUCTURE.Corridor && al.cls[j] === c) {
        deep = Math.max(deep, Math.abs(al.design[j]! - al.ground[j]!));
        j++;
      }
      // The run ends where the next stretch begins, so the formation reaches it.
      const last = Math.min(j, end - 1);
      if (last > i) {
        const n = last - i + 1;
        const points = new Float64Array(n * 3);
        const elevation = new Float64Array(n);
        for (let q = 0; q < n; q++) {
          alignedPoint(al, k, i + q, p);
          points.set([p.x, p.y, p.z], q * 3);
          elevation[q] = al.design[i + q]!;
        }
        const key = CLASS_KEYS[c]!;
        const halfWidth = FORMATION_HALF_WIDTH[key];
        out.push({
          points,
          elevation,
          halfWidth,
          ...CORRIDOR_BANKS,
          reach: halfWidth + deep * run + CORRIDOR_BANKS.fade + 2,
          priority: CLASS_PRIORITY[key],
        });
      }
      i = j;
    }
  }
  return out;
}

/** The links of `network`, by polyline index. */
export function linksByLine(al: Alignments, network: Network): Map<number, number> {
  const m = new Map<number, number>();
  for (let k = 0; k < al.count; k++) if (al.network[k] === network) m.set(al.line[k]!, k);
  return m;
}

/** Summary numbers for logs and previews. */
export function alignmentStats(al: Alignments) {
  let km = 0;
  let viaduct = 0;
  let tunnel = 0;
  let unrouted = 0;
  let fellBack = 0;
  let forced = 0;
  const a = new Vec3d();
  const b = new Vec3d();
  for (let k = 0; k < al.count; k++) {
    unrouted += al.unrouted[k]!;
    fellBack += al.fellBack[k]!;
    forced += al.forced[k]!;
    for (let i = al.offsets[k]! + 1; i < al.offsets[k + 1]!; i++) {
      const d = alignedPoint(al, k, i, a).distanceTo(alignedPoint(al, k, i - 1, b)) * al.radius;
      km += d / 1000;
      if (al.structure[i] === STRUCTURE.Viaduct) viaduct += d / 1000;
      if (al.structure[i] === STRUCTURE.Tunnel) tunnel += d / 1000;
    }
  }
  return {
    links: al.count,
    points: al.design.length,
    km,
    viaduct,
    tunnel,
    unrouted,
    fellBack,
    forced,
    bytes:
      al.offset.byteLength +
      al.design.byteLength * 2 +
      al.structure.byteLength * 2 +
      al.origin.byteLength +
      al.offsets.byteLength,
  };
}

/** The network bridge lists the alignment's crossings are matched to. */
export interface NetworkBridges {
  road: BridgeList;
  rail: BridgeList;
  spur: BridgeList;
}

/**
 * Matches each network bridge to the nearest unmatched crossing of the link
 * that aligns its polyline, within `reach` m (decision 190, plan conflict 9),
 * and records it in `al.crossingBridge`. The network's bridges are the campaign's
 * targets; a crossing left unmatched is drawn but is no target.
 */
export function matchBridges(al: Alignments, nb: NetworkBridges, reach = 25_000) {
  al.crossingBridge.fill(-1);
  const byLink = new Map<number, number[]>();
  al.crossingLink.forEach((k, c) => {
    let l = byLink.get(k);
    if (!l) byLink.set(k, (l = []));
    l.push(c);
  });
  const p = new Vec3d();
  const q = new Vec3d();
  let networkBridges = 0;
  let matched = 0;
  for (const [network, list] of [
    [NETWORK.Road, nb.road],
    [NETWORK.Rail, nb.rail],
    [NETWORK.Spur, nb.spur],
  ] as const) {
    const links = linksByLine(al, network);
    const n = list.road.length;
    networkBridges += n;
    for (let b = 0; b < n; b++) {
      const k = links.get(list.road[b]!);
      if (k === undefined) continue;
      p.set(list.points[b * 3]!, list.points[b * 3 + 1]!, list.points[b * 3 + 2]!);
      let best = -1;
      let bestD = reach;
      for (const c of byLink.get(k) ?? []) {
        if (al.crossingBridge[c]! >= 0) continue;
        const o = c * CROSSING_FIELDS;
        q.set(al.crossings[o + 1]!, al.crossings[o + 2]!, al.crossings[o + 3]!);
        const d = p.distanceTo(q) * al.radius;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best >= 0) {
        al.crossingBridge[best] = b;
        matched++;
      }
    }
  }
  const crossings = al.crossingLink.length;
  return {
    networkBridges,
    matched,
    /** Network bridges with no crossing on their link within reach. */
    unmatchedNetwork: networkBridges - matched,
    /** Crossings the network tier does not know: drawn, no target. */
    unmatchedCrossings: crossings - matched,
    crossings,
  };
}

/** How a bridge's aim point was found (`bridgeAimPoints`). */
export const BridgeAim = {
  /** At the river crossing matched to it. */
  Matched: 0,
  /** At the nearest point of its aligned road or railway: no crossing matched. */
  OnRoute: 1,
  /** At its coarse point: its polyline has no aligned link. */
  Coarse: 2,
} as const;
export type BridgeAim = (typeof BridgeAim)[keyof typeof BridgeAim];

/** Aim points of one bridge list: unit directions, xyz interleaved, and how each was found. */
export interface BridgeAims {
  points: Float64Array;
  how: Uint8Array;
}

/**
 * Where each network bridge stands in the simulation view and where strikes
 * aim (owner decision 7, roadmap R1.8): at its matched crossing (`matchBridges`
 * must have run), else at the nearest point of the link that aligns its
 * polyline, else at its coarse point. Main thread only: the campaign keeps the
 * coarse point.
 */
export function bridgeAimPoints(
  al: Alignments,
  nb: NetworkBridges,
): Record<keyof NetworkBridges, BridgeAims> {
  const out = {} as Record<keyof NetworkBridges, BridgeAims>;
  const p = new Vec3d();
  const q = new Vec3d();
  for (const [key, network] of [
    ['road', NETWORK.Road],
    ['rail', NETWORK.Rail],
    ['spur', NETWORK.Spur],
  ] as const) {
    const list = nb[key];
    const n = list.road.length;
    const points = new Float64Array(n * 3);
    const how = new Uint8Array(n).fill(BridgeAim.Coarse);
    points.set(list.points.subarray(0, n * 3));
    const links = linksByLine(al, network);
    // Matched crossings first.
    for (let c = 0; c < al.crossingBridge.length; c++) {
      const b = al.crossingBridge[c]!;
      if (b < 0 || al.network[al.crossingLink[c]!] !== network) continue;
      const o = c * CROSSING_FIELDS;
      points.set([al.crossings[o + 1]!, al.crossings[o + 2]!, al.crossings[o + 3]!], b * 3);
      how[b] = BridgeAim.Matched;
    }
    for (let b = 0; b < n; b++) {
      if (how[b] === BridgeAim.Matched) continue;
      const k = links.get(list.road[b]!);
      if (k === undefined) continue;
      p.set(list.points[b * 3]!, list.points[b * 3 + 1]!, list.points[b * 3 + 2]!);
      let best = Infinity;
      for (let i = al.offsets[k]!; i < al.offsets[k + 1]!; i++) {
        alignedPoint(al, k, i, q);
        const d = p.distanceTo(q);
        if (d < best) {
          best = d;
          points.set([q.x, q.y, q.z], b * 3);
        }
      }
      how[b] = BridgeAim.OnRoute;
    }
    out[key] = { points, how };
  }
  return out;
}
