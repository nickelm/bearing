/**
 * Urban extents (decision 103): a built-up polygon per settlement, grown from
 * its center.
 *
 * - **Area.** A disk of `builtUpRadius(population)` (about 3.2 km at 100,000
 *   people, the simulation view's built-up radius).
 * - **Growth.** A radial profile over URBAN_VERTICES directions: towns grow out
 *   along the roads that leave them (a lobe per road, wider for busier classes),
 *   plus a little seeded unevenness (three low harmonics). Growth slows uphill
 *   (1 / (1 + 3 × slope) at the rim) and stops short of the sea and lakes on the
 *   coarse grid. The profile is scaled to the disk's area before water cuts it.
 *
 * Draws from rng(seed, "urban"), six numbers per settlement in settlement order.
 */
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { Vec3d } from '../../core/vec3d';
import { URBAN_VERTICES } from './graph';
import type { RoadNetwork, SettlementList, UrbanExtents } from './graph';
import type { StrategicContext } from './input';

/** Built-up radius (m) of a settlement: 10 m × √population, 0.5 to 9 km. */
export function builtUpRadius(population: number): number {
  return Math.min(9000, Math.max(500, 10 * Math.sqrt(population)));
}

/** Growth lobe strength along a road of each class, and its angular width (rad). */
const ROAD_LOBE = [0.7, 0.5, 0.3];
const LOBE_WIDTH = 0.45;
/** Largest amplitude of the h-th harmonic of the unevenness is HARMONIC / h. */
const HARMONIC = 0.16;
/** Samples along each ray when checking for water. */
const RAY_STEPS = 6;

export function urbanExtents(
  ctx: StrategicContext,
  s: SettlementList,
  roads: RoadNetwork,
  seed: WorldSeed,
): UrbanExtents {
  const { grid, radius } = ctx;
  const label = ctx.labels.label;
  const c3 = grid.centers;
  const r = rng(seed, 'urban');
  const n = s.cells.length;
  const K = URBAN_VERTICES;
  const out: UrbanExtents = { points: new Float64Array(n * K * 3), area: new Float32Array(n) };
  // Roads leaving each settlement cell: (next cell, class).
  const leaving = new Map<number, { to: number; cls: number }[]>();
  for (let k = 0; k < roads.count; k++) {
    const o = roads.offsets[k]!;
    const e = roads.offsets[k + 1]! - 1;
    if (e <= o) continue;
    const step = Math.min(2, e - o);
    for (const [at, to] of [
      [roads.cells[o]!, roads.cells[o + step]!],
      [roads.cells[e]!, roads.cells[e - step]!],
    ] as const) {
      let l = leaving.get(at);
      if (!l) leaving.set(at, (l = []));
      l.push({ to, cls: roads.roadClass[k]! });
    }
  }
  const p = new Vec3d();
  const east = new Vec3d();
  const north = new Vec3d();
  const q = new Vec3d();
  const wet = (c: number) => label[c]! < 0 || ctx.lakeDepth[c]! > 0;
  const prof = new Float64Array(K);
  const limit = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const cell = s.cells[i]!;
    p.set(s.points[i * 3]!, s.points[i * 3 + 1]!, s.points[i * 3 + 2]!);
    east.set(0, 1, 0).cross(p);
    if (east.length() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    north.copy(p).cross(east);
    const harmonics = [1, 2, 3].map((h) => ({
      h,
      a: (r.nextFloat() * HARMONIC) / h,
      phi: r.nextFloat() * 2 * Math.PI,
    }));
    const dirs = (leaving.get(cell) ?? []).map(({ to, cls }) => {
      const dx = c3[to * 3]! - p.x;
      const dy = c3[to * 3 + 1]! - p.y;
      const dz = c3[to * 3 + 2]! - p.z;
      return {
        theta: Math.atan2(
          dx * north.x + dy * north.y + dz * north.z,
          dx * east.x + dy * east.y + dz * east.z,
        ),
        w: ROAD_LOBE[cls] ?? 0.3,
      };
    });
    const r0 = builtUpRadius(s.population[i]!);
    let area = 0;
    for (let k = 0; k < K; k++) {
      const theta = (k / K) * 2 * Math.PI;
      let f = 1;
      for (const d of dirs) {
        const dt = Math.atan2(Math.sin(theta - d.theta), Math.cos(theta - d.theta));
        f += d.w * Math.exp(-((dt / LOBE_WIDTH) ** 2));
      }
      for (const h of harmonics) f += h.a * Math.cos(h.h * theta + h.phi);
      // Slower growth uphill, measured at the rim.
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const at = (d: number) => {
        q.copy(p)
          .addScaled(east, (ux * d) / radius)
          .addScaled(north, (uy * d) / radius)
          .normalize();
        return grid.cellOfDirection(q);
      };
      f /= 1 + 3 * ctx.slope[at(r0 * f)]!;
      prof[k] = Math.max(0.35, f) * r0;
      // Water within reach stops growth short of it.
      limit[k] = Infinity;
      const reach = 2.5 * r0;
      for (let j = 1; j <= RAY_STEPS; j++) {
        const d = (reach * j) / RAY_STEPS;
        const c = at(d);
        if (c !== cell && wet(c)) {
          limit[k] = Math.max(0.3 * r0, d - reach / RAY_STEPS);
          break;
        }
      }
    }
    // Scale to the disk's area, then cut at the water.
    let raw = 0;
    for (let k = 0; k < K; k++) raw += prof[k]! * prof[(k + 1) % K]!;
    raw *= 0.5 * Math.sin((2 * Math.PI) / K);
    const scale = Math.sqrt((Math.PI * r0 * r0) / Math.max(raw, 1e-9));
    for (let k = 0; k < K; k++) prof[k] = Math.min(prof[k]! * scale, limit[k]!);
    for (let k = 0; k < K; k++) {
      const theta = (k / K) * 2 * Math.PI;
      const d = prof[k]! / radius;
      q.copy(p)
        .addScaled(east, Math.cos(theta) * d)
        .addScaled(north, Math.sin(theta) * d)
        .normalize();
      out.points.set([q.x, q.y, q.z], (i * K + k) * 3);
      area += prof[k]! * prof[(k + 1) % K]!;
    }
    out.area[i] = area * 0.5 * Math.sin((2 * Math.PI) / K);
  }
  return out;
}
