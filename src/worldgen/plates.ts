/**
 * Stage: tectonic plates.
 *
 * Unsteered (decision 46): seeds are spread over the whole planet by
 * best-candidate sampling. Plates grow by a multi-source Dijkstra flood
 * fill. Each plate has its own growth rate, and a shared noise field
 * roughens the boundaries. Each plate rotates about its own Euler pole.
 * Plate types (continental or oceanic) are drawn after growth, in a random
 * order, until continental plates cover a margin above the land fraction;
 * the crust stage builds the continents from them.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { MinHeap } from '../core/heap';
import { Noise3 } from '../core/noise';
import { randomUnitVector } from '../core/coords';
import type { Rng } from '../core/rng';
import { Vec3d } from '../core/vec3d';
import { clamp, neighborAngles8 } from './fields';

export interface Plate {
  id: number;
  seed: Vec3d;
  /** Euler pole (unit vector) and angular speed in arbitrary units (sign gives sense). */
  pole: Vec3d;
  omega: number;
  /** Relative flood-fill growth rate. */
  growth: number;
  /** Continental (true) or oceanic plate; set by assignPlateTypes. */
  continental: boolean;
}

/** At least one continental and one oceanic plate. */
export const MIN_PLATES = 2;
export const MAX_PLATES = 64;
/**
 * Continental plates are drawn until they cover this multiple of the land
 * fraction, so the coastline threshold falls inside them (passive margins).
 */
export const CONTINENTAL_AREA_MARGIN = 1.35;
/** Upper bound on the continental plate area fraction. */
const MAX_CONTINENTAL_AREA = 0.9;

function minAngleTo(p: Readonly<Vec3d>, others: readonly Plate[]): number {
  let best = Infinity;
  for (const o of others) best = Math.min(best, Math.acos(clamp(p.dot(o.seed), -1, 1)));
  return best;
}

/** Best-candidate sample: the candidate farthest from all existing seeds. */
function bestCandidate(plates: readonly Plate[], k: number, sample: () => Vec3d): Vec3d {
  let best = sample();
  let bestD = minAngleTo(best, plates);
  for (let i = 1; i < k; i++) {
    const c = sample();
    const d = minAngleTo(c, plates);
    if (d > bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export function seedPlates(plateCount: number, r: Rng): Plate[] {
  const count = Math.round(clamp(plateCount, MIN_PLATES, MAX_PLATES));
  const plates: Plate[] = [];
  const add = (seed: Vec3d) => {
    plates.push({
      id: plates.length,
      seed,
      pole: randomUnitVector(r),
      omega: r.range(0.3, 1.0) * (r.chance(0.5) ? 1 : -1),
      growth: r.range(0.7, 1.3),
      continental: false,
    });
  };
  while (plates.length < count) {
    add(bestCandidate(plates, 24, () => randomUnitVector(r)));
  }
  return plates;
}

/** Assigns every cell to a plate by weighted multi-source flood fill. */
export function growPlates(grid: CubeGrid, plates: readonly Plate[], r: Rng): Uint8Array {
  const n = grid.cellCount;
  const noise = new Noise3(r.fork('boundary-noise'));
  const roughness = new Float32Array(n);
  const x = new Vec3d();
  for (let c = 0; c < n; c++) {
    grid.center(c, x);
    roughness[c] = 1 + 0.9 * (0.5 + 0.5 * noise.fbm(x.x * 4, x.y * 4, x.z * 4, 5));
  }
  const edges = neighborAngles8(grid);
  const dist = new Float64Array(n).fill(Infinity);
  const owner = new Uint8Array(n);
  const done = new Uint8Array(n);
  const heap = new MinHeap(4096);
  for (const p of plates) {
    const c = grid.cellOfDirection(p.seed);
    if (dist[c] === 0) continue; // two seeds in one cell: the first one keeps it
    dist[c] = 0;
    owner[c] = p.id;
    heap.push(0, c);
  }
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    const rate = plates[owner[c]]!.growth;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k];
      if (nb < 0 || done[nb]) continue;
      const nd = dist[c] + (edges[c * 8 + k] * roughness[nb]) / rate;
      if (nd < dist[nb]) {
        dist[nb] = nd;
        owner[nb] = owner[c];
        heap.push(nd, nb);
      }
    }
  }
  return owner;
}

/**
 * Marks plates continental in a random order until their area reaches
 * CONTINENTAL_AREA_MARGIN × the land fraction. At least one plate of each type.
 * Returns the continental area fraction.
 */
export function assignPlateTypes(
  grid: CubeGrid,
  plates: Plate[],
  plateOf: Uint8Array,
  landFraction: number,
  r: Rng,
): number {
  const area = new Float64Array(plates.length);
  let total = 0;
  for (let c = 0; c < grid.cellCount; c++) {
    area[plateOf[c]] += grid.areas[c];
    total += grid.areas[c];
  }
  const order = plates.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const target = Math.min(MAX_CONTINENTAL_AREA, landFraction * CONTINENTAL_AREA_MARGIN) * total;
  for (const p of plates) p.continental = false;
  let covered = 0;
  for (let k = 0; k < order.length; k++) {
    // Leave at least one oceanic plate; always take at least one continental one.
    if (k > 0 && (covered >= target || k === order.length - 1)) break;
    const p = plates[order[k]!]!;
    p.continental = true;
    covered += area[p.id];
  }
  return covered / total;
}

/** Surface velocity of a plate at unit position x: ω (pole × x). */
export function plateVelocity(p: Plate, x: Readonly<Vec3d>, out = new Vec3d()): Vec3d {
  return out.copy(p.pole).cross(x).scale(p.omega);
}
