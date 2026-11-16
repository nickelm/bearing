/**
 * The structures the bridge kit draws (decision 192), from the alignment
 * record: one per river crossing (the run of `Bridge` points around it) and
 * one per stretch of viaduct (runs of `Viaduct` points, cut into pieces of at
 * most `VIADUCT_PIECE` m so each can be culled and built on its own). Each run
 * takes its neighbors on the ground at both ends, so the deck meets the
 * formation. Pure: no three.js.
 */
import { Vec3d } from '../../../core/vec3d';
import { STRUCTURE } from '../../../worldgen/networks/alignment';
import { alignedPoint } from '../../../worldgen/networks/alignments';
import type { Alignments, NetworkBridges } from '../../../worldgen/networks/alignments';
import { CLASS_KEYS, CROSSING_FIELDS, NETWORK, UNROUTED } from '../../../worldgen/networks/link';
import { FORMATION_HALF_WIDTH } from '../../../worldgen/networks/pieces';
import { BridgeKind } from '../../../worldgen/strategic/graph';
import type { BridgeLine, BridgeStyle } from './bridgeKit';

export const VIADUCT_PIECE = 1200;

export interface BridgeRecord {
  line: BridgeLine;
  /** Middle of the structure (unit direction). */
  center: Vec3d;
  /** Length along the deck (m). */
  length: number;
  /** The crossing it bridges, or −1 for a viaduct. */
  crossing: number;
}

function runs(al: Alignments, k: number, kind: number): [number, number][] {
  const out: [number, number][] = [];
  const o = al.offsets[k]!;
  const e = al.offsets[k + 1]!;
  let i = o;
  while (i < e) {
    if (al.structure[i] !== kind) {
      i++;
      continue;
    }
    let j = i;
    while (j < e && al.structure[j] === kind) j++;
    out.push([Math.max(o, i - 1), Math.min(e - 1, j)]);
    i = j;
  }
  return out;
}

function lineOf(al: Alignments, k: number, i0: number, i1: number, style: BridgeStyle): BridgeLine {
  const points: Vec3d[] = [];
  const deck: number[] = [];
  const ground: number[] = [];
  for (let i = i0; i <= i1; i++) {
    points.push(alignedPoint(al, k, i));
    deck.push(al.design[i]!);
    ground.push(al.ground[i]!);
  }
  const c = al.cls[Math.min(i1, i0 + 1)]!;
  const key = c === UNROUTED ? 'secondary' : CLASS_KEYS[c]!;
  return {
    points,
    deck,
    ground,
    width: 2 * FORMATION_HALF_WIDTH[key],
    style,
    rail: al.network[k] === NETWORK.Rail,
  };
}

function measure(line: BridgeLine, R: number): { center: Vec3d; length: number } {
  let length = 0;
  for (let i = 1; i < line.points.length; i++)
    length += line.points[i]!.distanceTo(line.points[i - 1]!) * R;
  const center = new Vec3d();
  for (const p of line.points) center.add(p);
  return { center: center.normalize(), length };
}

/** The bridges and viaducts of `al`; with `nb`, matched bridges take their network kind. */
export function bridgeRecords(al: Alignments, nb: NetworkBridges | null = null): BridgeRecord[] {
  const R = al.radius;
  const out: BridgeRecord[] = [];
  const p = new Vec3d();
  for (let c = 0; c < al.crossingLink.length; c++) {
    const k = al.crossingLink[c]!;
    const o = c * CROSSING_FIELDS;
    p.set(al.crossings[o + 1]!, al.crossings[o + 2]!, al.crossings[o + 3]!);
    // The run of bridge points nearest the crossing.
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const [i0, i1] of runs(al, k, STRUCTURE.Bridge)) {
      for (let i = i0; i <= i1; i++) {
        const d = alignedPoint(al, k, i).distanceTo(p);
        if (d < bestD) {
          bestD = d;
          best = [i0, i1];
        }
      }
    }
    if (!best) continue;
    const rail = al.network[k] === NETWORK.Rail;
    const span = al.crossings[o + 6]!;
    let style: BridgeStyle = rail && span > 45 ? 'truss' : 'beam';
    const b = al.crossingBridge[c]!;
    if (nb && b >= 0) {
      const list = rail ? nb.rail : al.network[k] === NETWORK.Spur ? nb.spur : nb.road;
      const kind = list.kind[b];
      style =
        kind === BridgeKind.Truss || kind === BridgeKind.Suspension
          ? 'truss'
          : kind === BridgeKind.Viaduct
            ? 'viaduct'
            : 'beam';
    }
    const line = lineOf(al, k, best[0], best[1], style);
    out.push({ line, crossing: c, ...measure(line, R) });
  }
  for (let k = 0; k < al.count; k++) {
    for (const [i0, i1] of runs(al, k, STRUCTURE.Viaduct)) {
      // Pieces of at most VIADUCT_PIECE m, sharing their end points.
      let a = i0;
      let run = 0;
      for (let i = i0 + 1; i <= i1; i++) {
        run += alignedPoint(al, k, i).distanceTo(alignedPoint(al, k, i - 1)) * R;
        if (run >= VIADUCT_PIECE || i === i1) {
          const line = lineOf(al, k, a, i, 'viaduct');
          out.push({ line, crossing: -1, ...measure(line, R) });
          a = i;
          run = 0;
        }
      }
    }
  }
  return out;
}
