/**
 * What the renderer draws of settlements, roads and airbases (milestone 5,
 * decision 65), derived on the CPU from the strategic graph and the
 * infrastructure:
 *
 * - `segments`: roads (civilian and spur) smoothed like rivers, or along
 *   their alignments where the world has them (decision 184), off viaducts
 *   and tunnels; railways along their alignments only, as concrete until N6
 *   shades ballast; and airfield pavement (runway, parallel taxiway, apron)
 *   with negative widths, which the road shader draws as concrete. Same
 *   8-field layout as RiverSegments.
 * - `lights`: night lights per settlement and airbase, 8 floats each
 *   (direction xyz, radius; intensity, built-up radius, kind, runway).
 *   The terrain draws the built-up area as a patch by day (decision 71):
 *   kind BUILT_TOWN or BUILT_INDUSTRY; radius 0 for none. A town's last float
 *   is 1 + its index in `outlines` (0: none), whose urban extent polygon then
 *   shapes the patch instead of the disk. Airbases have kind
 *   BUILT_AIRFIELD and their runway packed by `encodeRunway`, from which the
 *   terrain paints the runway markings.
 * - `sites`: footprints for building clusters (towns, airbases, industry).
 * - `clearings`: where trees must not stand (urban cores, airfields, roads).
 *
 * Nothing here touches the GPU, so tests run it in Node.
 */
import { tileForDirection, tileKeyString } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import { chaikin } from '../../../worldgen/riverIndex';
import type { RiverSegments } from '../../../worldgen/riverIndex';
import { ROAD_WIDTH, URBAN_VERTICES } from '../../../worldgen/strategic/graph';
import type { RoadNetwork, StrategicGraph } from '../../../worldgen/strategic/graph';
import type { Infrastructure } from '../../../worldgen/strategic/infrastructure';
import { STRUCTURE } from '../../../worldgen/networks/alignment';
import { alignedPoint, linksByLine } from '../../../worldgen/networks/alignments';
import type { Alignments } from '../../../worldgen/networks/alignments';
import { NETWORK } from '../../../worldgen/networks/link';

export type SiteKind = 'town' | 'airbase' | 'industry';

/** Tile level of the road index (the trees' tiles, decision 162). */
export const ROAD_TILE_LEVEL = 10;

/** A stretch of road for placing tree rows along it (decision 162). */
export interface RoadStretch {
  /** Unit directions of its ends. */
  a: Vec3d;
  b: Vec3d;
  /** Half the road's width plus its tree clearing (m): rows stand just outside. */
  clearing: number;
  /** The road's index, the same for all its stretches. */
  road: number;
  /** Distance (m) along the road to `a`. */
  along: number;
  /** Road class (0 motorway, 1 trunk, 2 secondary; spurs are 2). */
  roadClass: number;
}

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
  /**
   * Towns: the urban extent's radius (m) at URBAN_VERTICES evenly spaced bearings,
   * counterclockwise from east (decision 103); `radius` is their maximum.
   */
  outline?: Float32Array;
}

/** A town's built-up radius (m) toward unit direction `d`: its outline, or its radius. */
export function townRadiusToward(site: BuiltSite, d: Readonly<Vec3d>): number {
  const o = site.outline;
  if (!o) return site.radius;
  const { east, north } = localFrame(site.point);
  const dx = d.x - site.point.x;
  const dy = d.y - site.point.y;
  const dz = d.z - site.point.z;
  const e = dx * east.x + dy * east.y + dz * east.z;
  const n = dx * north.x + dy * north.y + dz * north.z;
  if (e === 0 && n === 0) return o[0]!;
  const k = o.length;
  const t = ((Math.atan2(n, e) / (2 * Math.PI) + 1) % 1) * k;
  const i = Math.floor(t) % k;
  const f = t - Math.floor(t);
  return o[i]! * (1 - f) + o[(i + 1) % k]! * f;
}

/** Runway, taxiway and apron dimensions (m). */
/** Trees stay this far beyond a road's edge (m); rows of trees stand just outside (decision 162). */
export const ROAD_CLEARING = 8;
/** Width of a railway's ballast bed as drawn (m), single track. */
export const RAIL_WIDTH = 4;
export const RUNWAY_WIDTH = 45;
export const TAXIWAY_WIDTH = 23;
export const TAXIWAY_OFFSET = 190;
export const APRON_WIDTH = 140;
export const APRON_LENGTH = 600;
export const APRON_OFFSET = 420;
/** Links from the taxiway to the apron, this far either side of the apron's middle (m). */
export const APRON_LINK_ALONG = 200;

/** How far a town's outline may reach beyond its light radius (m): inside LightTables' reach. */
export const OUTLINE_REACH = 1500;
/**
 * Where the shell's cut of a built-up patch ends at the widest edge noise, as a share of
 * its radius: the shader cuts at a cover of 0.3, 0.925 of the drawn radius, which the
 * noise widens to 1.25 times a disk's radius and 1.1 times an outline's (decision 166).
 */
const BUILT_REACH = 1.25 * 0.925;
const OUTLINE_CUT = 1.1 * 0.925;

/** Built-up kinds in the light records. */
export const BUILT_TOWN = 0;
export const BUILT_INDUSTRY = 1;
export const BUILT_AIRFIELD = 2;

/** Packs runway length (m) and heading (rad, folded to 0..π) into one float of a light record. */
export function encodeRunway(length: number, heading: number): number {
  const h = ((heading % Math.PI) + Math.PI) % Math.PI;
  return Math.round(length) + h / 4;
}

export function decodeRunway(code: number): { length: number; heading: number } {
  const length = Math.floor(code);
  return { length, heading: (code - length) * 4 };
}

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
  /**
   * Towns' urban extent radii (m), URBAN_VERTICES per town at evenly spaced
   * bearings counterclockwise from east (decision 103), indexed from the
   * light records; capped so the patch stays inside the light's tile lists.
   */
  readonly outlines: Float32Array;
  readonly sites: BuiltSite[] = [];
  /** Habitability per coarse cell and that grid's resolution, for the rural glow. */
  readonly habitability: Uint8Array;
  readonly habitabilityResolution: number;
  private readonly clearings = new Map<string, Clearing[]>();
  /** Towns and industry by level-CLEARING_LEVEL tile, for the canopy shell (decision 166). */
  private readonly builtTiles = new Map<string, BuiltSite[]>();
  private readonly roadTiles = new Map<string, RoadStretch[]>();

  constructor(
    graph: StrategicGraph,
    infra: Infrastructure,
    readonly radius: number,
    alignments: Alignments | null = null,
  ) {
    this.habitability = graph.habitability;
    this.habitabilityResolution = graph.resolution;
    const segs: number[] = [];
    let roadIndex = 0;
    // Aligned links (decision 184) replace the coarse polylines they align.
    const aligned = {
      road: alignments ? linksByLine(alignments, NETWORK.Road) : null,
      spur: alignments ? linksByLine(alignments, NETWORK.Spur) : null,
      rail: alignments ? linksByLine(alignments, NETWORK.Rail) : null,
    };
    const addRoads = (r: RoadNetwork, kind: 'road' | 'spur' | 'rail') => {
      for (let k = 0; k < r.count; k++) {
        // Railways: the ballast bed, drawn as concrete until N6 shades it.
        const w = kind === 'rail' ? RAIL_WIDTH : ROAD_WIDTH[r.roadClass[k]!]!;
        const road = roadIndex++;
        let along = 0;
        const link = aligned[kind]?.get(k);
        let sm: number[][];
        // Segment i → i + 1 is drawn on the ground unless a viaduct or tunnel carries it.
        let onGround = (_i: number) => true;
        if (link !== undefined && alignments) {
          const o = alignments.offsets[link]!;
          const n = alignments.offsets[link + 1]! - o;
          const p = new Vec3d();
          sm = [];
          for (let i = 0; i < n; i++) {
            alignedPoint(alignments, link, o + i, p);
            sm.push([p.x, p.y, p.z, w]);
          }
          // Bridges are painted across the water until the bridge kit draws them (N7, decision 190).
          onGround = (i) => {
            const st = alignments.structure[o + i + 1];
            return st === STRUCTURE.Corridor || st === STRUCTURE.Bridge;
          };
        } else if (kind === 'rail') {
          continue;
        } else {
          const pts: number[][] = [];
          for (let p = r.offsets[k]!; p < r.offsets[k + 1]!; p++) {
            pts.push([r.points[p * 3]!, r.points[p * 3 + 1]!, r.points[p * 3 + 2]!, w]);
          }
          sm = chaikin(pts, 3);
        }
        const drawn = kind === 'rail' ? -w : w;
        for (let i = 0; i + 1 < sm.length; i++) {
          const a = sm[i]!;
          const b = sm[i + 1]!;
          const va = new Vec3d(a[0]!, a[1]!, a[2]!);
          const vb = new Vec3d(b[0]!, b[1]!, b[2]!);
          const length = va.distanceTo(vb) * radius;
          if (!onGround(i)) {
            along += length;
            continue;
          }
          segs.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, drawn, drawn);
          this.clear(va, vb, w / 2 + ROAD_CLEARING, true);
          if (kind === 'rail') {
            along += length;
            continue;
          }
          const stretch: RoadStretch = {
            a: va,
            b: vb,
            clearing: w / 2 + ROAD_CLEARING,
            road,
            along,
            roadClass: kind === 'spur' ? 2 : r.roadClass[k]!,
          };
          along += length;
          // The tiles the road and its rows reach: along it, and 40 m to either side, since a
          // road on a tile's edge has a row in the tile next door.
          const keys = new Set<string>();
          const steps = Math.max(1, Math.ceil(length / 300));
          const across = va.clone().cross(vb.clone().sub(va)).normalize();
          for (let q = 0; q <= steps; q++) {
            const d = va
              .clone()
              .scale(1 - q / steps)
              .addScaled(vb, q / steps)
              .normalize();
            for (const side of [-1, 0, 1]) {
              const e = d
                .clone()
                .addScaled(across, (side * 40) / radius)
                .normalize();
              keys.add(tileKeyString(tileForDirection(e, ROAD_TILE_LEVEL)));
            }
          }
          for (const key of keys) {
            let l = this.roadTiles.get(key);
            if (!l) this.roadTiles.set(key, (l = []));
            l.push(stretch);
          }
        }
      }
    };
    addRoads(graph.roads, 'road');
    addRoads(infra.spurs, 'spur');
    addRoads(graph.railways.lines, 'rail');

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
    const outlines: number[] = [];
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
      // Links from the taxiway to the apron.
      for (const along of [-APRON_LINK_ALONG, APRON_LINK_ALONG]) {
        const a = offsetPoint(p, h, along, TAXIWAY_OFFSET, radius);
        const b = offsetPoint(p, h, along, APRON_OFFSET, radius);
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
      lights.push(p.x, p.y, p.z, 1500, 0.35, 0, BUILT_AIRFIELD, encodeRunway(L, h));
    }
    this.segments = { count: segs.length / 8, data: Float64Array.from(segs) };

    const s = graph.settlements;
    for (let i = 0; i < s.cells.length; i++) {
      const p = new Vec3d(s.points[i * 3]!, s.points[i * 3 + 1]!, s.points[i * 3 + 2]!);
      const pop = s.population[i]!;
      const r = urbanRadius(pop);
      // Buildings fill the town's urban extent polygon (decision 106).
      let outline: Float32Array | undefined;
      const u = graph.urban?.points;
      if (u && u.length >= (i + 1) * URBAN_VERTICES * 3) {
        outline = new Float32Array(URBAN_VERTICES);
        for (let k = 0; k < URBAN_VERTICES; k++) {
          const o = (i * URBAN_VERTICES + k) * 3;
          const dot = p.x * u[o]! + p.y * u[o + 1]! + p.z * u[o + 2]!;
          outline[k] = Math.acos(Math.min(1, dot)) * radius;
        }
      }
      this.sites.push({
        kind: 'town',
        point: p,
        radius: outline ? Math.max(...outline) : r,
        population: pop,
        heading: 0,
        runwayLength: 0,
        key: `town-${i}`,
        outline,
      });
      this.clear(p, p, 0.6 * r, false);
      this.indexBuilt(this.sites[this.sites.length - 1]!);
      let shape = 0;
      if (outline) {
        shape = outlines.length / URBAN_VERTICES + 1;
        for (const o of outline) outlines.push(Math.min(o, 2 * r + OUTLINE_REACH));
      }
      lights.push(
        p.x,
        p.y,
        p.z,
        2 * r,
        Math.min(1.2, 0.3 + Math.sqrt(pop / 7e5)),
        r,
        BUILT_TOWN,
        shape,
      );
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
      this.indexBuilt(this.sites[this.sites.length - 1]!);
      lights.push(p.x, p.y, p.z, 1200, 0.4, 900, BUILT_INDUSTRY, 0);
    }
    this.lights = Float32Array.from(lights);
    this.outlines = Float32Array.from(outlines.length ? outlines : [0]);
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

  /** Index a town or industry site under every level-CLEARING_LEVEL tile its built-up area reaches. */
  private indexBuilt(site: BuiltSite): void {
    const keys = new Set<string>([tileKeyString(tileForDirection(site.point, CLEARING_LEVEL))]);
    const { east, north } = localFrame(site.point);
    const reach = (1.25 * site.radius) / this.radius;
    for (const ring of [0.25, 0.5, 0.75, 1]) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * 2 * Math.PI;
        const q = site.point
          .clone()
          .addScaled(east, ring * reach * Math.cos(ang))
          .addScaled(north, ring * reach * Math.sin(ang))
          .normalize();
        keys.add(tileKeyString(tileForDirection(q, CLEARING_LEVEL)));
      }
    }
    for (const key of keys) {
      let l = this.builtTiles.get(key);
      if (!l) this.builtTiles.set(key, (l = []));
      l.push(site);
    }
  }

  /**
   * True if a unit direction lies within `extra` m of a town's or industry's built-up
   * patch as the shell cuts it (the outline or disk at its widest edge noise), so the
   * shell can slope down before it (decision 166).
   */
  isBuiltUp(d: Readonly<Vec3d>, extra = 0): boolean {
    const list = this.builtTiles.get(tileKeyString(tileForDirection(d, CLEARING_LEVEL)));
    if (!list) return false;
    for (const s of list) {
      const dist = Math.acos(Math.min(1, s.point.dot(d))) * this.radius;
      if (dist > BUILT_REACH * s.radius + extra) continue;
      const r = s.outline ? OUTLINE_CUT * townRadiusToward(s, d) : BUILT_REACH * s.radius;
      if (dist < r + extra) return true;
    }
    return false;
  }

  /** The road stretches that pass through a level-ROAD_TILE_LEVEL tile (by its key string). */
  roadsInTile(key: string): readonly RoadStretch[] {
    return this.roadTiles.get(key) ?? [];
  }

  /**
   * True if a unit direction lies in a clearing: no trees; with `pavedOnly`, no
   * buildings. `extra` widens every clearing by that many meters.
   */
  isClear(d: Readonly<Vec3d>, pavedOnly = false, extra = 0): boolean {
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
      const r = c.r + extra;
      if ((dx * dx + dy * dy + dz * dz) * R * R < r * r) return true;
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
