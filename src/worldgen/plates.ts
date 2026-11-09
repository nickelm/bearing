/**
 * Stage: tectonic plates.
 *
 * Seeding is steered (decision 18): three plate seeds inside the main
 * continent and two inside the second, so collisions raise ranges inside
 * both. The remaining seeds are spread over the planet by best-candidate
 * sampling. Plates grow by a multi-source Dijkstra flood fill. Each plate
 * has its own growth rate, and a shared noise field roughens the
 * boundaries. Each plate rotates about its own Euler pole.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { MinHeap } from '../core/heap';
import { Noise3 } from '../core/noise';
import { randomUnitVector } from '../core/coords';
import type { Rng } from '../core/rng';
import { Vec3d } from '../core/vec3d';
import type { ContinentLayout } from './continents';
import { clamp, neighborAngles8 } from './fields';

export interface Plate {
  id: number;
  seed: Vec3d;
  /** Euler pole (unit vector) and angular speed in arbitrary units (sign gives sense). */
  pole: Vec3d;
  omega: number;
  /** Relative flood-fill growth rate. */
  growth: number;
}

export const MAIN_CONTINENT_PLATES = 3;
export const SECOND_CONTINENT_PLATES = 2;
export const MIN_PLATES = MAIN_CONTINENT_PLATES + SECOND_CONTINENT_PLATES + 1;
export const MAX_PLATES = 64;

/** Random direction within `maxAngle` of `center`, uniform over the cap. */
function randomInCap(r: Rng, center: Readonly<Vec3d>, maxAngle: number): Vec3d {
  const cosT = 1 - r.nextFloat() * (1 - Math.cos(maxAngle));
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const t = randomUnitVector(r);
  t.addScaled(center, -t.dot(center));
  if (t.lengthSq() < 1e-12) t.set(center.y, -center.x, center.z === 0 ? 1 : 0);
  t.normalize();
  return center.clone().scale(cosT).addScaled(t, sinT).normalize();
}

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

export function seedPlates(plateCount: number, layout: ContinentLayout, r: Rng): Plate[] {
  const count = Math.round(clamp(plateCount, MIN_PLATES, MAX_PLATES));
  const plates: Plate[] = [];
  const add = (seed: Vec3d) => {
    plates.push({
      id: plates.length,
      seed,
      pole: randomUnitVector(r),
      omega: r.range(0.3, 1.0) * (r.chance(0.5) ? 1 : -1),
      growth: r.range(0.7, 1.3),
    });
  };
  for (let i = 0; i < MAIN_CONTINENT_PLATES; i++) {
    add(bestCandidate(plates, 8, () => randomInCap(r, layout.main, layout.mainRadius * 0.65)));
  }
  for (let i = 0; i < SECOND_CONTINENT_PLATES; i++) {
    add(bestCandidate(plates, 8, () => randomInCap(r, layout.second, layout.secondRadius * 0.6)));
  }
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

/** Surface velocity of a plate at unit position x: ω (pole × x). */
export function plateVelocity(p: Plate, x: Readonly<Vec3d>, out = new Vec3d()): Vec3d {
  return out.copy(p.pole).cross(x).scale(p.omega);
}
