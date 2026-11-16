/**
 * The alignment stage's work list (decision 184): one task per polyline of the
 * network tier (roads, railway lines, spur roads), its anchors fixed so every
 * piece depends only on them (plan, conflict 8).
 *
 * Anchors are the polyline's ends (settlements and junctions, shared by every
 * link meeting there) and the first coarse-cell center after each
 * `pieceLength` m of the polyline, so pieces are 12–20 km long. Classes map
 * from the network: railways are mainlines with the mountain railway as their
 * fallback; roads keep their class and fall back to the mountain road (a
 * motorway to a trunk road first); spurs to the mountain road, then a track.
 *
 * Tasks are ordered along a space-filling curve, so consecutive tasks share
 * tiles (the stage's tile cache); results are stored in task order.
 */
import { directionToCubeFace } from '../../core/coords';
import { Vec3d } from '../../core/vec3d';
import type { RoadNetwork, StrategicGraph } from '../strategic/graph';
import { RoadClass } from '../strategic/graph';
import type { ClassKey, LinkTask, Network } from './link';
import { NETWORK } from './link';

/** Classes a road falls back to where its own finds no route: a pass road keeps its rank but climbs in hairpins. */
const ROAD_FALLBACK: Partial<Record<ClassKey, readonly ClassKey[]>> = {
  motorway: ['trunk', 'mountainRoad'],
  trunk: ['mountainRoad'],
  secondary: ['mountainRoad'],
};

export const TASK_TUNING = {
  /** Polyline length between interior anchors (m). */
  pieceLength: 12_000,
};

function anchorsOf(net: RoadNetwork, k: number, radius: number): Float64Array {
  const out: number[] = [];
  const p0 = net.offsets[k]!;
  const p1 = net.offsets[k + 1]!;
  let run = 0;
  for (let p = p0; p < p1; p++) {
    const x = net.points[p * 3]!;
    const y = net.points[p * 3 + 1]!;
    const z = net.points[p * 3 + 2]!;
    if (p > p0)
      run +=
        Math.hypot(
          x - net.points[p * 3 - 3]!,
          y - net.points[p * 3 - 2]!,
          z - net.points[p * 3 - 1]!,
        ) * radius;
    if (p === p0 || p === p1 - 1 || run >= TASK_TUNING.pieceLength) {
      out.push(x, y, z);
      run = 0;
    }
  }
  return Float64Array.from(out);
}

/** A 2D Hilbert index of (x, y) on a 2^order grid. */
function hilbert(x: number, y: number, order: number): number {
  let d = 0;
  for (let s = 1 << (order - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return d;
}

/** The tasks for the graph's roads and railways and the spur roads, in curve order. */
export function linkTasks(
  graph: StrategicGraph,
  spurs: RoadNetwork | null,
  radius: number,
): LinkTask[] {
  const tasks: Omit<LinkTask, 'id'>[] = [];
  const add = (
    net: RoadNetwork,
    network: Network,
    cls: (k: number) => ClassKey,
    fallback: (k: number) => readonly ClassKey[],
  ) => {
    for (let k = 0; k < net.count; k++) {
      if (net.offsets[k + 1]! - net.offsets[k]! < 2) continue;
      tasks.push({
        network,
        line: k,
        anchors: anchorsOf(net, k, radius),
        cls: cls(k),
        fallback: fallback(k),
      });
    }
  };
  const roadCls = (c: number): ClassKey =>
    c === RoadClass.Motorway ? 'motorway' : c === RoadClass.Trunk ? 'trunk' : 'secondary';
  add(
    graph.roads,
    NETWORK.Road,
    (k) => roadCls(graph.roads.roadClass[k]!),
    (k) => ROAD_FALLBACK[roadCls(graph.roads.roadClass[k]!)]!,
  );
  add(
    graph.railways.lines,
    NETWORK.Rail,
    () => 'mainline',
    () => ['mountainRailway'],
  );
  if (spurs)
    add(
      spurs,
      NETWORK.Spur,
      () => 'secondary',
      () => ['mountainRoad', 'track'],
    );
  const ORDER = 10;
  const key = (t: Omit<LinkTask, 'id'>) => {
    const m = (t.anchors.length / 3) >> 1;
    const uv = directionToCubeFace(
      new Vec3d(t.anchors[m * 3]!, t.anchors[m * 3 + 1]!, t.anchors[m * 3 + 2]!),
    );
    const n = 1 << ORDER;
    const x = Math.min(n - 1, Math.floor(uv.u * n));
    const y = Math.min(n - 1, Math.floor(uv.v * n));
    return uv.face * n * n + hilbert(x, y, ORDER);
  };
  const keyed = tasks.map((t, i) => ({ t, i, k: key(t) }));
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  return keyed.map(({ t }, id) => ({ ...t, id }));
}
