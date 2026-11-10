/**
 * What the renderer draws of settlements, roads and airbases (milestone 5,
 * decision 65), derived on the CPU from the strategic graph and the
 * infrastructure:
 *
 * - `segments`: roads (civilian and spur) smoothed like rivers, plus airfield
 *   pavement (runway, parallel taxiway, apron) with negative widths, which
 *   the road shader draws as concrete. Same 8-field layout as RiverSegments.
 * - `lights`: night lights per settlement and airbase, 8 floats each
 *   (direction xyz, radius; intensity, 0, 0, 0).
 * - `sites`: footprints for building clusters (towns, airbases, industry).
 * - `clearings`: where trees must not stand (urban cores, airfields, roads).
 *
 * Nothing here touches the GPU, so tests run it in Node.
 */
import { tileForDirection, tileKeyString } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import { chaikin } from '../../worldgen/riverIndex';
import type { RiverSegments } from '../../worldgen/riverIndex';
import { ROAD_WIDTH } from '../../worldgen/strategic/graph';
import type { RoadNetwork, StrategicGraph } from '../../worldgen/strategic/graph';
import type { Infrastructure } from '../../worldgen/strategic/infrastructure';

export type SiteKind = 'town' | 'airbase' | 'industry';

export interface BuiltSite {
  kind: SiteKind;
  /** Unit direction. */
  point: Vec3d;
  /** Radius of the built-up area (m). */
  radius: number;
  population: number;
  /** Airbases: runway heading (rad clockwise from north) and length (m). */
  heading: number;
  runwayLength: number;
  /** Stable key for the site's random stream. */
  key: string;
}

/** Runway, taxiway and apron dimensions (m). */
export const RUNWAY_WIDTH = 45;
export const TAXIWAY_WIDTH = 23;
export const TAXIWAY_OFFSET = 190;
export const APRON_WIDTH = 140;
export const APRON_LENGTH = 600;
export const APRON_OFFSET = 420;

/** Urban radius (m) of a settlement: about 3.2 km at 100,000 people. */
export function urbanRadius(population: number): number {
  return Math.min(9000, Math.max(500, 10 * Math.sqrt(population)));
}

/** Local east and north unit vectors at a unit direction. */
export function localFrame(p: Readonly<Vec3d>): { east: Vec3d; north: Vec3d } {
  const east = new Vec3d(0, 1, 0).cross(p);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = p.clone().cross(east);
  return { east, north };
}

/** The unit direction `along` m forward on `heading` and `across` m to its right from p. */
export function offsetPoint(
  p: Readonly<Vec3d>,
  heading: number,
  along: number,
  across: number,
  radius: number,
): Vec3d {
  const { east, north } = localFrame(p);
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  // Right of heading: rotate (fx, fy) clockwise by 90°.
  const e = (fx * along + fy * across) / radius;
  const n = (fy * along - fx * across) / radius;
  return p.clone().addScaled(east, e).addScaled(north, n).normalize();
}

export interface Clearing {
  /** Circle (a = b) or capsule (segment a–b) with half-width `r` (m). */
  a: Vec3d;
  b: Vec3d;
  r: number;
  /** Roads and pavement (no buildings either), as opposed to built-up areas. */
  paved: boolean;
}

/** Clearings indexed by level-CLEARING_LEVEL tile, for tree placement. */
export const CLEARING_LEVEL = 7;

export class InfraScene {
  readonly segments: RiverSegments;
  readonly lights: Float32Array;
  readonly sites: BuiltSite[] = [];
  private readonly clearings = new Map<string, Clearing[]>();

  constructor(
    graph: StrategicGraph,
    infra: Infrastructure,
    readonly radius: number,
  ) {
    const segs: number[] = [];
    const addRoads = (r: RoadNetwork) => {
      for (let k = 0; k < r.count; k++) {
        const w = ROAD_WIDTH[r.roadClass[k]!]!;
        const pts: number[][] = [];
        for (let p = r.offsets[k]!; p < r.offsets[k + 1]!; p++) {
          pts.push([r.points[p * 3]!, r.points[p * 3 + 1]!, r.points[p * 3 + 2]!, w]);
        }
        const sm = chaikin(pts, 3);
        for (let i = 0; i + 1 < sm.length; i++) {
          const a = sm[i]!;
          const b = sm[i + 1]!;
          segs.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, w, w);
          this.clear(
            new Vec3d(a[0]!, a[1]!, a[2]!),
            new Vec3d(b[0]!, b[1]!, b[2]!),
            w / 2 + 8,
            true,
          );
        }
      }
    };
    addRoads(graph.roads);
    addRoads(infra.spurs);

    const pave = (
      p: Vec3d,
      h: number,
      along0: number,
      along1: number,
      across: number,
      w: number,
    ) => {
      const a = offsetPoint(p, h, along0, across, radius);
      const b = offsetPoint(p, h, along1, across, radius);
      segs.push(a.x, a.y, a.z, b.x, b.y, b.z, -w, -w);
    };
    const lights: number[] = [];
    for (const base of infra.airbases) {
      const p = new Vec3d(...base.point);
      const h = base.heading;
      const L = base.runwayLength;
      pave(p, h, -L / 2, L / 2, 0, RUNWAY_WIDTH);
      pave(p, h, -L / 2 + 150, L / 2 - 150, TAXIWAY_OFFSET, TAXIWAY_WIDTH);
      // Links from the taxiway to the runway ends.
      for (const end of [-L / 2 + 150, L / 2 - 150]) {
        const a = offsetPoint(p, h, end, 0, radius);
        const b = offsetPoint(p, h, end, TAXIWAY_OFFSET, radius);
        segs.push(a.x, a.y, a.z, b.x, b.y, b.z, -TAXIWAY_WIDTH, -TAXIWAY_WIDTH);
      }
      pave(p, h, -APRON_LENGTH / 2, APRON_LENGTH / 2, APRON_OFFSET, APRON_WIDTH);
      this.clear(
        offsetPoint(p, h, -L / 2 - 300, 200, radius),
        offsetPoint(p, h, L / 2 + 300, 200, radius),
        700,
        true,
      );
      this.sites.push({
        kind: 'airbase',
        point: p,
        radius: L / 2 + 800,
        population: 0,
        heading: h,
        runwayLength: L,
        key: `airbase-${base.id}`,
      });
      lights.push(p.x, p.y, p.z, 1500, 0.35, 0, 0, 0);
    }
    this.segments = { count: segs.length / 8, data: Float64Array.from(segs) };

    const s = graph.settlements;
    for (let i = 0; i < s.cells.length; i++) {
      const p = new Vec3d(s.points[i * 3]!, s.points[i * 3 + 1]!, s.points[i * 3 + 2]!);
      const pop = s.population[i]!;
      const r = urbanRadius(pop);
      this.sites.push({
        kind: 'town',
        point: p,
        radius: r,
        population: pop,
        heading: 0,
        runwayLength: 0,
        key: `town-${i}`,
      });
      this.clear(p, p, 0.6 * r, false);
      lights.push(p.x, p.y, p.z, 1.6 * r, Math.min(1, 0.25 + Math.sqrt(pop / 1e6)), 0, 0, 0);
    }
    const seen = new Set<number>();
    for (const t of infra.targets) {
      if (t.kind !== 'factory' && t.kind !== 'refinery' && t.kind !== 'power-plant') continue;
      if (seen.has(t.cell)) continue;
      seen.add(t.cell);
      // Industry on the town's edge, 1.5 urban radii out, toward the cell's east.
      const town = t.settlement >= 0 ? urbanRadius(s.population[t.settlement]!) : 1000;
      const p = offsetPoint(new Vec3d(...t.point), Math.PI / 2 + t.id, 1.3 * town + 800, 0, radius);
      this.sites.push({
        kind: 'industry',
        point: p,
        radius: 900,
        population: 0,
        heading: t.id * 0.7,
        runwayLength: 0,
        key: `industry-${t.id}`,
      });
      this.clear(p, p, 1000, false);
      lights.push(p.x, p.y, p.z, 1200, 0.4, 0, 0, 0);
    }
    this.lights = Float32Array.from(lights);
  }

  private clear(a: Vec3d, b: Vec3d, r: number, paved: boolean): void {
    const keys = new Set<string>();
    const reach = r / this.radius;
    for (const p of [a, b, a.clone().add(b).normalize()]) {
      const { east, north } = localFrame(p);
      for (let k = -1; k < 8; k++) {
        const q = p.clone();
        if (k >= 0) {
          const ang = (k / 8) * 2 * Math.PI;
          q.addScaled(east, reach * Math.cos(ang))
            .addScaled(north, reach * Math.sin(ang))
            .normalize();
        }
        keys.add(tileKeyString(tileForDirection(q, CLEARING_LEVEL)));
      }
    }
    for (const key of keys) {
      let l = this.clearings.get(key);
      if (!l) this.clearings.set(key, (l = []));
      l.push({ a, b, r, paved });
    }
  }

  /** True if a unit direction lies in a clearing: no trees; with `pavedOnly`, no buildings. */
  isClear(d: Readonly<Vec3d>, pavedOnly = false): boolean {
    const list = this.clearings.get(tileKeyString(tileForDirection(d, CLEARING_LEVEL)));
    if (!list) return false;
    const R = this.radius;
    for (const c of list) {
      if (pavedOnly && !c.paved) continue;
      // Distance to the segment in the tangent approximation (clearings are small).
      const abx = c.b.x - c.a.x;
      const aby = c.b.y - c.a.y;
      const abz = c.b.z - c.a.z;
      const len2 = abx * abx + aby * aby + abz * abz;
      let t = 0;
      if (len2 > 0) {
        t = ((d.x - c.a.x) * abx + (d.y - c.a.y) * aby + (d.z - c.a.z) * abz) / len2;
        t = Math.min(1, Math.max(0, t));
      }
      const dx = d.x - (c.a.x + abx * t);
      const dy = d.y - (c.a.y + aby * t);
      const dz = d.z - (c.a.z + abz * t);
      if ((dx * dx + dy * dy + dz * dz) * R * R < c.r * c.r) return true;
    }
    return false;
  }

  /** Sites whose footprint reaches within `margin` m of direction `d`'s cap of angle `angle`. */
  sitesNear(d: Readonly<Vec3d>, reach: number): BuiltSite[] {
    return this.sites.filter(
      (s) => Math.acos(Math.min(1, s.point.dot(d))) * this.radius <= reach + s.radius,
    );
  }
}
