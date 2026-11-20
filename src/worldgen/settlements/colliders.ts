/**
 * Building colliders (proposal 0009, decision 268): one oriented box per building, from
 * its footprint and height, for line of sight, landings on roofs and plazas, and later
 * ground combat. Heights are above the ground under the building, which the caller
 * supplies, since the drawn ground is finer than the plan's.
 */
import { SpatialHash } from './geom';
import { BUILDING_FIELDS } from './pack';
import type { PackedPlan } from './pack';

export interface BuildingCollider {
  x: number;
  y: number;
  angle: number;
  halfLength: number;
  halfWidth: number;
  /** Top of the walls, and of the roof (m above the ground). */
  wall: number;
  top: number;
  building: number;
}

export function buildingColliders(plan: PackedPlan): BuildingCollider[] {
  const b = plan.buildings;
  const out: BuildingCollider[] = [];
  for (let i = 0; i < b.length / BUILDING_FIELDS; i++) {
    const o = i * BUILDING_FIELDS;
    out.push({
      x: b[o]!,
      y: b[o + 1]!,
      angle: b[o + 2]!,
      halfLength: b[o + 3]!,
      halfWidth: b[o + 4]!,
      wall: b[o + 5]!,
      top: b[o + 5]! + b[o + 6]!,
      building: i,
    });
  }
  return out;
}

export class ColliderIndex {
  private readonly hash = new SpatialHash<number>(60);

  constructor(readonly boxes: BuildingCollider[]) {
    boxes.forEach((c, i) => {
      const r = Math.hypot(c.halfLength, c.halfWidth);
      this.hash.addBox(c.x - r, c.y - r, c.x + r, c.y + r, i);
    });
  }

  /** The collider over local (x, y), or −1. */
  at(x: number, y: number): number {
    let found = -1;
    this.hash.near(x, y, 0, (i) => {
      const c = this.boxes[i]!;
      const dx = x - c.x;
      const dy = y - c.y;
      const u = dx * Math.cos(c.angle) + dy * Math.sin(c.angle);
      const v = -dx * Math.sin(c.angle) + dy * Math.cos(c.angle);
      if (Math.abs(u) <= c.halfLength && Math.abs(v) <= c.halfWidth) {
        found = i;
        return true;
      }
      return false;
    });
    return found;
  }

  /**
   * The first building the segment a → b (local x, y and height above the sea, m)
   * passes through: its parameter along the segment and index, or null. `ground(x, y)`
   * is the ground's height there. Boxes are tested to their wall tops (roofs count as
   * walls, conservatively).
   */
  segmentHit(
    a: [number, number, number],
    b: [number, number, number],
    ground: (x: number, y: number) => number,
  ): { t: number; building: number } | null {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / 30));
    const seen = new Set<number>();
    let best: { t: number; building: number } | null = null;
    for (let s = 0; s <= steps; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / steps;
      const y = a[1] + ((b[1] - a[1]) * s) / steps;
      this.hash.near(x, y, 30, (i) => {
        if (seen.has(i)) return false;
        seen.add(i);
        const c = this.boxes[i]!;
        // Slab test in the box's frame.
        const cs = Math.cos(c.angle);
        const sn = Math.sin(c.angle);
        const toU = (px: number, py: number) => (px - c.x) * cs + (py - c.y) * sn;
        const toV = (px: number, py: number) => -(px - c.x) * sn + (py - c.y) * cs;
        const u0 = toU(a[0], a[1]);
        const v0 = toV(a[0], a[1]);
        const du = toU(b[0], b[1]) - u0;
        const dv = toV(b[0], b[1]) - v0;
        let t0 = 0;
        let t1 = 1;
        for (const [p0, d, h] of [
          [u0, du, c.halfLength],
          [v0, dv, c.halfWidth],
        ] as const) {
          if (Math.abs(d) < 1e-12) {
            if (Math.abs(p0) > h) return false;
          } else {
            let ta = (-h - p0) / d;
            let tb = (h - p0) / d;
            if (ta > tb) [ta, tb] = [tb, ta];
            t0 = Math.max(t0, ta);
            t1 = Math.min(t1, tb);
          }
        }
        if (t0 > t1) return false;
        // Height: the segment's lowest point inside the footprint against the wall top.
        const z0 = a[2] + (b[2] - a[2]) * t0;
        const z1 = a[2] + (b[2] - a[2]) * t1;
        const top = ground(c.x, c.y) + c.wall;
        if (Math.min(z0, z1) <= top && (!best || t0 < best.t))
          best = { t: t0, building: c.building };
        return false;
      });
    }
    return best;
  }

  /** Height (m above the ground) a helicopter can set down on at (x, y): a flat roof, or 0 off buildings. */
  landingHeight(x: number, y: number, flatOnly = true): number | null {
    const i = this.at(x, y);
    if (i < 0) return 0;
    const c = this.boxes[i]!;
    if (flatOnly && c.top > c.wall + 0.05) return null;
    return c.wall;
  }
}
