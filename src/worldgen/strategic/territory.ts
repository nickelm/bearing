/**
 * Territory per coarse cell from the cast (milestone 5): who holds each land
 * cell, and how far it lies behind a front's start line.
 *
 * - Whole nodes go to their owner; neutral nodes and islands outside any
 *   node stay neutral.
 * - A split node is divided along its start line: the line is rasterized
 *   into cells, and each side floods (4-connected, so the 8-connected line
 *   blocks it) from the node's airbase sites and settlements, whose signed
 *   offsets from the line the graph records. Cells no flood reached (the
 *   line itself, enclosed pockets) take the side of the nearest reached cell.
 * - Depth behind the front is the distance over land from the line.
 */
import type { Cast, Side } from '../../campaign/cast';
import { MinHeap } from '../../core/heap';
import { Vec3d } from '../../core/vec3d';
import type { StrategicBuild } from './builder';

export const TERRITORY_SEA = -1;
export const TERRITORY_NEUTRAL = 0;
export const TERRITORY_ALLIANCE = 1;
export const TERRITORY_PACT = 2;

export function territoryCode(side: Side): number {
  return side === 'alliance' ? TERRITORY_ALLIANCE : TERRITORY_PACT;
}

export interface Territory {
  /** TERRITORY_* per cell. */
  owner: Int8Array;
  /** Land node per cell, −1 at sea and on islands outside any node. */
  node: Int32Array;
  /** Distance over land from the start line of the cell's front (m); Infinity off fronts. */
  frontDepth: Float32Array;
  /** Index into Cast.theaters of the cell's continental front, or −1. */
  frontTheater: Int16Array;
}

export function buildTerritory(build: StrategicBuild, cast: Cast): Territory {
  const { ctx, graph, nodes: nb } = build;
  const { grid, radius } = ctx;
  const label = ctx.labels.label;
  const n = grid.cellCount;
  const owner = new Int8Array(n).fill(TERRITORY_SEA);
  const node = new Int32Array(n).fill(-1);
  const frontDepth = new Float32Array(n).fill(Infinity);
  const frontTheater = new Int16Array(n).fill(-1);
  for (let c = 0; c < n; c++) {
    const lm = label[c]!;
    if (lm < 0) continue;
    const id = nb.nodeOfLandmass[lm]!;
    node[c] = id;
    const o = id >= 0 ? cast.owners[id]! : null;
    owner[c] = o?.kind === 'whole' ? territoryCode(o.side) : TERRITORY_NEUTRAL;
  }

  for (const t of cast.theaters) {
    if (t.kind !== 'continental-front') continue;
    const f = graph.fronts[t.front!]!;
    const o = cast.owners[f.node]!;
    if (o.kind !== 'split') continue;
    const line = graph.barrierLines[o.line]!;
    const lm = nb.members[f.node]![0]!;
    const codeOf = (off: number) =>
      (off < 0 ? 0 : 1) === o.pactSide ? TERRITORY_PACT : TERRITORY_ALLIANCE;

    // Rasterize the line.
    const onLine = new Uint8Array(n);
    const lineCells: number[] = [];
    const p = new Vec3d();
    const q = new Vec3d();
    const d = new Vec3d();
    const count = line.points.length / 3;
    const step = ctx.cellSize / 4 / radius;
    for (let i = 0; i + 1 < count; i++) {
      p.set(line.points[i * 3]!, line.points[i * 3 + 1]!, line.points[i * 3 + 2]!);
      q.set(line.points[i * 3 + 3]!, line.points[i * 3 + 4]!, line.points[i * 3 + 5]!);
      const k = Math.max(1, Math.ceil(Math.acos(Math.min(1, p.dot(q))) / step));
      for (let j = 0; j <= k; j++) {
        d.copy(p)
          .scale(1 - j / k)
          .addScaled(q, j / k)
          .normalize();
        const c = grid.cellOfDirection(d);
        if (label[c] === lm && !onLine[c]) {
          onLine[c] = 1;
          lineCells.push(c);
        }
      }
    }

    // Flood each side from cells with known offsets.
    const side = new Int8Array(n);
    const stack: number[] = [];
    const seed = (c: number, off: number) => {
      if (label[c] !== lm || onLine[c] || !Number.isFinite(off) || off === 0 || side[c]) return;
      side[c] = codeOf(off);
      stack.push(c);
    };
    const nodeData = graph.nodes[f.node]!;
    nodeData.airbases.cells.forEach((c, i) => seed(c, line.airbaseOffset[i]!));
    nodeData.ports.cells.forEach((c, i) => seed(c, line.portOffset[i]!));
    graph.settlements.cells.forEach((c, i) => seed(c, line.settlementOffset[i]!));
    while (stack.length) {
      const c = stack.pop()!;
      for (let k = 0; k < 4; k++) {
        const x = grid.neighbors4[c * 4 + k]!;
        if (label[x] !== lm || onLine[x] || side[x]) continue;
        side[x] = side[c]!;
        stack.push(x);
      }
    }
    // The rest takes the nearest flooded cell's side (breadth first, 8-connected).
    let frontier: number[] = [];
    for (let c = 0; c < n; c++) if (side[c]) frontier.push(c);
    while (frontier.length) {
      const next: number[] = [];
      for (const c of frontier) {
        for (let k = 0; k < 8; k++) {
          const x = grid.neighbors8[c * 8 + k]!;
          if (x < 0 || label[x] !== lm || side[x]) continue;
          side[x] = side[c]!;
          next.push(x);
        }
      }
      frontier = next;
    }

    // Depth behind the line over the landmass.
    const heap = new MinHeap(4096);
    for (const c of lineCells) {
      frontDepth[c] = 0;
      heap.push(0, c);
    }
    while (heap.size > 0) {
      const dd = heap.peekKey();
      const c = heap.pop();
      if (dd > frontDepth[c]!) continue;
      for (let k = 0; k < 8; k++) {
        const x = grid.neighbors8[c * 8 + k]!;
        if (x < 0 || label[x] !== lm) continue;
        const nd = dd + grid.angleBetween(c, x) * radius;
        if (nd < frontDepth[x]!) {
          frontDepth[x] = nd;
          heap.push(nd, x);
        }
      }
    }
    for (let c = 0; c < n; c++) {
      if (label[c] !== lm) continue;
      owner[c] = side[c] || TERRITORY_NEUTRAL;
      frontTheater[c] = t.id;
    }
  }
  return { owner, node, frontDepth, frontTheater };
}

/** Distance (m) from every cell to the nearest cell passing `source`, over land and sea. */
export function distanceFrom(
  build: StrategicBuild,
  source: (c: number) => boolean,
  through: (c: number) => boolean = () => true,
): Float32Array {
  const { grid, radius } = build.ctx;
  const out = new Float32Array(grid.cellCount).fill(Infinity);
  const heap = new MinHeap(4096);
  for (let c = 0; c < grid.cellCount; c++) {
    if (!source(c)) continue;
    out[c] = 0;
    heap.push(0, c);
  }
  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > out[c]!) continue;
    for (let k = 0; k < 8; k++) {
      const x = grid.neighbors8[c * 8 + k]!;
      if (x < 0 || !through(x)) continue;
      const nd = d + grid.angleBetween(c, x) * radius;
      if (nd < out[x]!) {
        out[x] = nd;
        heap.push(nd, x);
      }
    }
  }
  return out;
}
