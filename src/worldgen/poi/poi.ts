/**
 * Points of interest (Proposal 0010, *Structures*; decision 302): structures placed
 * where they would plausibly be built, scored by site suitability on the global grid
 * (prominence, view, access, defensibility, and nearness to settlements, routes,
 * coasts and passes), named, and exported as plain records.
 *
 * Game-agnostic (owner's addendum; rule 20's spirit): this module knows no sides, no
 * war and no campaign. It reads the eroded world's maps and, from the caller, plain
 * `places` (settlements as points with a size) and `routes` (polylines). A game layer
 * decides what a radar station or a dam means; the kit itself is the caller's choice
 * (`PoiOptions.kinds`), so a fantasy game can ask for lighthouses and observatories and
 * leave the radars out.
 *
 * Each type has a site score (0 = unsuitable), a spacing, a count per land area, a
 * name pattern and the model the renderer draws; access roads and pads are left to the
 * terrain networks (planned).
 */
import { directionToCubeFace } from '../../core/coords';
import type { CubeFaceUv } from '../../core/coords';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { Vec3d } from '../../core/vec3d';
import { Biome } from '../biomes';
import { neighbors8 } from '../drainage';
import { cellCenterDirection } from '../rivers';
import { isLayered } from '../lithology';
import { Toponymy } from '../names/toponymy';
import { Province } from '../provinces';
import { landmarkCoverage, lineOfSight } from '../viewshed';
import type { Viewpoint } from '../viewshed';

export const POI_KINDS = [
  'radar-station',
  'early-warning-radar',
  'relay-tower',
  'bunker-complex',
  'coastal-battery',
  'observation-post',
  'dam',
  'lighthouse',
  'observatory',
  'quarry',
  'oil-field',
  'power-line',
] as const;
export type PoiKind = (typeof POI_KINDS)[number];

/** The world's maps a site score reads (the global grid, n per face; heights as drawn). */
export interface PoiWorld {
  n: number;
  radius: number;
  height: Float32Array;
  biome: Uint8Array;
  province?: Uint8Array;
  lithology?: Uint8Array;
  /** Discharge per cell (m³/s), for dams. */
  discharge: Float32Array;
}

export interface PoiPlace {
  /** Unit direction. */
  dir: readonly [number, number, number];
  /** Population or any size measure; larger places draw more. */
  size: number;
}

export interface PoiOptions {
  /** The kit to place (default all). */
  kinds?: readonly PoiKind[];
  /** Settlements and routes from the caller (any game's; none is fine). */
  places?: readonly PoiPlace[];
  routes?: readonly (readonly [number, number, number][])[];
  /** Places of interest a game wants composition to favor (viewsheds; Phase 7): a score per cell 0..1. */
  viewshed?: Float32Array;
  /** Multiplies every type's count. */
  density?: number;
}

export interface PointOfInterest {
  kind: PoiKind;
  /** Unit direction of the site, and the global cell. */
  dir: [number, number, number];
  cell: number;
  name: string;
  /** Site score 0..1 (how good a place it is). */
  score: number;
  /** Heading the structure faces (rad, clockwise from north): toward the view, the sea or across the river. */
  facing: number;
  /** For a power line: the polyline of its pylons' corridor (unit directions). */
  path?: [number, number, number][];
}

/** Per type: count per million km² of land, least spacing (m), and the name pattern. */
export const POI_TYPES: Readonly<
  Record<PoiKind, { perArea: number; spacing: number; name: (p: string) => string }>
> = {
  'radar-station': { perArea: 6, spacing: 60_000, name: (p) => `${p} Radar Station` },
  'early-warning-radar': {
    perArea: 2,
    spacing: 150_000,
    name: (p) => `${p} Early Warning Station`,
  },
  'relay-tower': { perArea: 10, spacing: 30_000, name: (p) => `${p} Relay` },
  'bunker-complex': { perArea: 4, spacing: 50_000, name: (p) => `${p} Bunker Complex` },
  'coastal-battery': { perArea: 4, spacing: 50_000, name: (p) => `${p} Battery` },
  'observation-post': { perArea: 8, spacing: 25_000, name: (p) => `${p} Observation Post` },
  dam: { perArea: 4, spacing: 40_000, name: (p) => `${p} Dam` },
  lighthouse: { perArea: 8, spacing: 30_000, name: (p) => `${p} Point Light` },
  observatory: { perArea: 1, spacing: 200_000, name: (p) => `${p} Observatory` },
  quarry: { perArea: 5, spacing: 30_000, name: (p) => `${p} Quarry` },
  'oil-field': { perArea: 3, spacing: 60_000, name: (p) => `${p} Field` },
  'power-line': { perArea: 3, spacing: 40_000, name: (p) => `${p} Line` },
};

const ARID: ReadonlySet<number> = new Set([
  Biome.HotDesert,
  Biome.ColdDesert,
  Biome.RockyDesert,
  Biome.RedRockDesert,
  Biome.FogDesert,
  Biome.Shrubland,
]);

/** The local terrain at a cell, from the global grid. */
interface Terrain {
  h: number;
  /** Height above the lowest ground within the ring (m). */
  prominence: number;
  /** Share of ring samples more than 100 m below (0..1): the view. */
  view: number;
  /** Share of near samples at sea (0..1). */
  sea: number;
  /** A saddle: higher on two opposite sides, lower on the other two (0..1). */
  saddle: number;
  /** How narrow the valley across a river cell is (0..1). */
  gorge: number;
  /** Compass heading of the lowest ring sample (rad). */
  downhill: number;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The site score of a type at a cell, 0 where it cannot stand. */
export function siteScore(
  kind: PoiKind,
  t: Terrain,
  biome: number,
  province: number,
  lithology: number,
  discharge: number,
  nearRoute: number,
  nearPlace: number,
): number {
  if (t.h <= 0 && kind !== 'lighthouse') return 0;
  const high = smooth(400, 2500, t.h);
  switch (kind) {
    case 'radar-station':
      return smooth(200, 900, t.prominence) * smooth(0.4, 0.9, t.view) * (0.4 + 0.6 * high);
    case 'early-warning-radar':
      return smooth(0.1, 0.4, t.sea) * smooth(150, 700, t.prominence) * smooth(0.5, 0.9, t.view);
    case 'relay-tower':
      return smooth(100, 500, t.prominence) * nearRoute * smooth(0.3, 0.7, t.view);
    case 'bunker-complex':
      return (
        Math.max(t.saddle, t.gorge * 0.7) * Math.max(nearRoute, nearPlace) * smooth(200, 800, t.h)
      );
    case 'coastal-battery':
      return smooth(0.3, 0.6, t.sea) * smooth(30, 200, t.prominence) * (0.5 + 0.5 * nearPlace);
    case 'observation-post':
      return smooth(150, 600, t.prominence) * smooth(0.5, 0.85, t.view) * (1 - high * 0.5);
    case 'dam':
      return smooth(30, 300, discharge) * t.gorge * smooth(100, 1500, t.h);
    case 'lighthouse':
      return t.h > -5 ? smooth(0.45, 0.7, t.sea) * (0.4 + 0.6 * nearPlace) : 0;
    case 'observatory':
      return (
        smooth(1800, 3500, t.h) *
        smooth(0.5, 0.9, t.view) *
        (ARID.has(biome) || biome === Biome.Alpine ? 1 : 0.15)
      );
    case 'quarry':
      return (
        smooth(300, 1500, t.h) *
        smooth(100, 500, t.prominence) *
        nearRoute *
        (isLayered(lithology) || ARID.has(biome) ? 1 : 0.5)
      );
    case 'oil-field':
      return ARID.has(biome) && province === Province.SedimentaryBasin
        ? smooth(1, 0, t.prominence / 300)
        : 0;
    case 'power-line':
      return t.gorge > 0 ? smooth(100, 800, discharge) * t.gorge * nearPlace : 0;
  }
}

/** Places the points of interest of a world. Deterministic: a function of the inputs and the seed. */
export function placePointsOfInterest(
  w: PoiWorld,
  seed: WorldSeed,
  opts: PoiOptions = {},
): PointOfInterest[] {
  const kinds = opts.kinds ?? POI_KINDS;
  if (kinds.length === 0 || (opts.density ?? 1) <= 0) return [];
  const n = w.n;
  const R = w.radius;
  const count = 6 * n * n;
  const cell = ((Math.PI / 2) * R) / n;
  const nb = new Int32Array(8);
  // Land area, for the counts.
  let land = 0;
  for (let c = 0; c < count; c++) if (w.height[c]! > 0) land++;
  const landKm2 = (land * cell * cell) / 1e6;
  // Nearness to the caller's places and routes, 0..1 (1 within a few km), from a
  // breadth-first distance in cells over the grid: one pass each, not a search per site.
  const placePts = (opts.places ?? []).map((p) => new Vec3d(...p.dir));
  const routeCells: number[] = [];
  for (const r of opts.routes ?? [])
    for (const p of r) routeCells.push(cellOfDirection(n, new Vec3d(...p)));
  const placeCells = placePts.map((p) => cellOfDirection(n, p));
  const steps = (sources: readonly number[], limit: number): Uint16Array => {
    const dist = new Uint16Array(count).fill(65535);
    let frontier: number[] = [];
    for (const c of sources)
      if (dist[c] !== 0) {
        dist[c] = 0;
        frontier.push(c);
      }
    for (let k = 1; k <= limit && frontier.length; k++) {
      const next: number[] = [];
      for (const c of frontier) {
        neighbors8(n, c, nb);
        for (const m of nb)
          if (m >= 0 && dist[m] === 65535) {
            dist[m] = k;
            next.push(m);
          }
      }
      frontier = next;
    }
    return dist;
  };
  const routeReach = 8000;
  const placeReach = 25_000;
  const routeDist = routeCells.length ? steps(routeCells, Math.ceil(routeReach / cell) + 1) : null;
  const placeDist = placeCells.length ? steps(placeCells, Math.ceil(placeReach / cell) + 1) : null;
  const nearness = (dist: Uint16Array | null, c: number, reach: number) =>
    dist ? 1 - smooth(reach * 0.25, reach, dist[c]! * cell) : 0.5;
  // Ring samples around a cell: 16 directions at 5 km.
  const d = new Vec3d();
  const s = new Vec3d();
  const east = new Vec3d();
  const north = new Vec3d();
  const heightAt = (dir: Vec3d) => w.height[cellOfDirection(n, dir)]!;
  const terrainAt = (c: number): Terrain => {
    cellCenterDirection(n, c, d);
    east.set(0, 1, 0).cross(d);
    if (east.length() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    north.copy(d).cross(east);
    const h = w.height[c]!;
    let low = h;
    let lowAt = 0;
    let below = 0;
    let sea = 0;
    const ring = Math.max(5000, 2.5 * cell);
    const arms: number[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      s.copy(d)
        .addScaled(north, (ring * Math.cos(a)) / R)
        .addScaled(east, (ring * Math.sin(a)) / R)
        .normalize();
      const hs = heightAt(s);
      if (hs < low) {
        low = hs;
        lowAt = a;
      }
      if (hs < h - 100) below++;
      arms.push(hs);
    }
    neighbors8(n, c, nb);
    for (const m of nb) if (m >= 0 && w.height[m]! <= 0) sea++;
    // Saddle: the arms along one axis higher, along the other lower.
    let saddle = 0;
    for (let k = 0; k < 8; k++) {
      const along = (arms[k]! + arms[k + 8]!) / 2 - h;
      const acrossK = (arms[(k + 4) % 16]! + arms[(k + 12) % 16]!) / 2 - h;
      saddle = Math.max(saddle, smooth(50, 400, along) * smooth(50, 400, -acrossK));
    }
    // Gorge: both arms across higher by a lot within a short distance.
    let gorge = 0;
    for (let k = 0; k < 8; k++) {
      const rise = Math.min(arms[k]!, arms[k + 8]!) - h;
      gorge = Math.max(gorge, smooth(150, 700, rise));
    }
    return {
      h,
      prominence: h - Math.max(0, low),
      view: below / 16,
      sea: sea / 8,
      saddle,
      gorge,
      downhill: lowAt,
    };
  };
  // Candidates: every few cells (the grid is 1.5 km; sites a few km apart are enough),
  // with their terrain measured once for every type.
  const stride = Math.max(1, Math.round(3000 / cell));
  const sites: { c: number; t: Terrain; route: number; place: number }[] = [];
  for (let face = 0; face < 6; face++)
    for (let j = stride >> 1; j < n; j += stride)
      for (let i = stride >> 1; i < n; i += stride) {
        const c = (face * n + j) * n + i;
        const h = w.height[c]!;
        if (h < -20) continue;
        sites.push({
          c,
          t: terrainAt(c),
          route: nearness(routeDist, c, routeReach),
          place: nearness(placeDist, c, placeReach),
        });
      }
  const out: PointOfInterest[] = [];
  const names = new Toponymy(rng(seed, 'poi'));
  const jitter = rng(seed, 'poi').fork('order');
  const taken: Vec3d[] = [];
  for (const kind of kinds) {
    const type = POI_TYPES[kind];
    const want = Math.max(1, Math.round((type.perArea * landKm2 * (opts.density ?? 1)) / 1e6));
    const cand: { c: number; score: number; facing: number }[] = [];
    for (const site of sites) {
      const { c, t } = site;
      if (kind === 'lighthouse' ? t.h > 400 : t.h <= 0) continue;
      let score = siteScore(
        kind,
        t,
        w.biome[c]!,
        w.province?.[c] ?? 0,
        w.lithology?.[c] ?? 0,
        w.discharge[c]!,
        site.route,
        site.place,
      );
      if (score <= 0.05) continue;
      // Composition (decision 303): seen sites score higher.
      if (opts.viewshed) score *= 0.6 + 0.8 * opts.viewshed[c]!;
      cand.push({ c, score: score + 1e-3 * jitter.nextFloat(), facing: t.downhill });
    }
    cand.sort((a, b) => b.score - a.score || a.c - b.c);
    let placed = 0;
    for (const k of cand) {
      if (placed >= want) break;
      const p = cellCenterDirection(n, k.c, new Vec3d());
      const ownSpacing = out.some(
        (o) => o.kind === kind && p.distanceTo(new Vec3d(...o.dir)) * R < type.spacing,
      );
      const crowded = taken.some((q) => p.distanceTo(q) * R < 3000);
      if (ownSpacing || crowded) continue;
      const poi: PointOfInterest = {
        kind,
        dir: [p.x, p.y, p.z],
        cell: k.c,
        name: type.name(names.proper(0)),
        score: Math.min(1, k.score),
        facing: k.facing,
      };
      if (kind === 'power-line') {
        // To the nearest place: a straight corridor of pylons (the router aligns it later).
        let best: Vec3d | null = null;
        let bestD = Infinity;
        for (const q of placePts) {
          const dd = q.distanceTo(p);
          if (dd < bestD) {
            bestD = dd;
            best = q;
          }
        }
        if (!best || bestD * R > 80_000) continue;
        const pylons = Math.max(2, Math.ceil((bestD * R) / 400));
        const path: [number, number, number][] = [];
        for (let i = 0; i <= pylons; i++) {
          const q = p
            .clone()
            .scale(1 - i / pylons)
            .addScaled(best, i / pylons)
            .normalize();
          path.push([q.x, q.y, q.z]);
        }
        poi.path = path;
      }
      taken.push(p);
      out.push(poi);
      placed++;
    }
  }
  return out;
}

/** The global cell holding a unit direction (n per face). */
function cellOfDirection(n: number, d: Readonly<Vec3d>): number {
  directionToCubeFace(d, UV);
  const i = Math.min(n - 1, Math.max(0, Math.floor(UV.u * n)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(UV.v * n)));
  return (UV.face * n + j) * n + i;
}
const UV: CubeFaceUv = { face: 0, u: 0, v: 0 };

/**
 * Height of each type's structure above its ground where it reads as a landmark (m);
 * types not listed are not landmarks (decision 303).
 */
export const LANDMARK_HEIGHT: Partial<Record<PoiKind, number>> = {
  'radar-station': 40,
  'early-warning-radar': 50,
  'relay-tower': 60,
  lighthouse: 35,
  observatory: 30,
  dam: 80,
};

/**
 * Composition (Proposal 0010, decision 303): every viewpoint that sees no landmark
 * (`others`: wonders, named falls, any the caller adds, and the landmark POIs already
 * placed) gets one on the most prominent ground it does see within `reach` m: a relay
 * tower, if the kit has one. Returns the added points; `pois` is left as it is.
 */
export function composeLandmarks(
  w: PoiWorld,
  pois: readonly PointOfInterest[],
  viewpoints: readonly Viewpoint[],
  seed: WorldSeed,
  opts: {
    kinds?: readonly PoiKind[];
    others?: readonly { dir: readonly [number, number, number]; height: number }[];
    reach?: number;
  } = {},
): PointOfInterest[] {
  const kinds = opts.kinds ?? POI_KINDS;
  if (!kinds.includes('relay-tower')) return [];
  const reach = opts.reach ?? 20_000;
  const n = w.n;
  const R = w.radius;
  const cell = ((Math.PI / 2) * R) / n;
  const marks = [
    ...(opts.others ?? []),
    ...pois
      .filter((p) => LANDMARK_HEIGHT[p.kind] !== undefined)
      .map((p) => ({ dir: p.dir, height: LANDMARK_HEIGHT[p.kind]! })),
  ];
  const { seen } = landmarkCoverage(w, viewpoints, marks);
  const names = new Toponymy(rng(seed, 'poi').fork('landmarks'));
  const added: PointOfInterest[] = [];
  const eye = new Vec3d();
  const target = new Vec3d();
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const steps = Math.ceil(reach / cell);
  viewpoints.forEach((v, k) => {
    if (seen[k]) return;
    eye.set(...v.dir);
    // A landmark added for an earlier viewpoint may already be in view.
    if (added.some((a) => landmarkCoverage(w, [v], [{ dir: a.dir, height: 60 }]).share > 0)) return;
    const c0 = cellOfDirection(n, eye);
    directionToCubeFace(eye, uv);
    const face = uv.face;
    const i0 = c0 % n;
    const j0 = Math.floor((c0 - face * n * n) / n);
    const eyeH = Math.max(0, w.height[c0]!) + v.above;
    let best = -1;
    let bestScore = 0;
    for (let j = j0 - steps; j <= j0 + steps; j++) {
      if (j < 1 || j >= n - 1) continue;
      for (let i = i0 - steps; i <= i0 + steps; i++) {
        if (i < 1 || i >= n - 1) continue;
        const c = (face * n + j) * n + i;
        const h = w.height[c]!;
        if (h <= 0) continue;
        cellCenterDirection(n, c, target);
        const dist = target.distanceTo(eye) * R;
        if (dist > reach || dist < 3000) continue;
        // Prominence over the four neighbors, and nearer is better.
        const around =
          (w.height[c - 1]! + w.height[c + 1]! + w.height[c - n]! + w.height[c + n]!) / 4;
        const score = (h - around + 50) * (1 - 0.5 * (dist / reach));
        if (score <= bestScore) continue;
        if (!lineOfSight(w, eye, eyeH, target, h + 60)) continue;
        best = c;
        bestScore = score;
      }
    }
    if (best < 0) return;
    const p = cellCenterDirection(n, best, new Vec3d());
    added.push({
      kind: 'relay-tower',
      dir: [p.x, p.y, p.z],
      cell: best,
      name: POI_TYPES['relay-tower'].name(names.proper(0)),
      score: 1,
      facing: Math.atan2(
        eye
          .clone()
          .sub(p)
          .dot(new Vec3d(0, 1, 0).cross(p).normalize()),
        1,
      ),
    });
  });
  return added;
}
