/**
 * One link of the network tier aligned whole (decision 184): its pieces routed
 * between fixed anchors, then one plan, one profile and one set of earthworks
 * along the link, so the anchors leave no kink and no level step.
 *
 * - **Pieces.** The link's polyline is cut at anchors (`linkTasks`); each
 *   piece is routed in its own gnomonic plane (`routePiece`) with the link's
 *   class, or its fallbacks in turn (down to the mountain class) where the
 *   class finds no route; near the anchors any ground may be cut or filled.
 *   Where no class finds one, the last is routed again over ground of any
 *   steepness at a high price (`forced`, counted for review), with the
 *   viaduct and tunnel thresholds of a trunk road, so a canyon gets a
 *   viaduct rather than a bank as tall as it is deep. A piece neither class can route keeps its straight chord, follows
 *   the ground and carries no corridor (`UNROUTED`).
 * - **Plan.** The pieces' corners join into one list of unit directions; each
 *   corner, the anchors' included, is rounded in a gnomonic frame at the
 *   corner (`roundCorner`; arcs are under a kilometer, so a local frame is
 *   exact enough), and the line is resampled every `step` m.
 * - **Profile and earthworks** run along the whole link, the grade bound and
 *   the thresholds per point from its piece's class; the ends are pinned to
 *   the ground at the link's ends, which all links meeting there share.
 * - **Thinning.** The samples are thinned for storage: a point goes where the
 *   line stays within `tolerance.plan` m across and `tolerance.profile` m
 *   in elevation of the chord without it, and no segment exceeds
 *   CORRIDOR_MAX_SEGMENT. Changes of structure or class are kept.
 *
 * Pure and deterministic: a link depends only on its anchors, its class and
 * the ground in its pieces' bands.
 */
import { Vec3d } from '../../core/vec3d';
import { CORRIDOR_MAX_SEGMENT } from '../edits/terrainEdits';
import { designProfile, EARTHWORK_LIMITS, roundCorner, STRUCTURE } from './alignment';
import { gnomonic, routePiece } from './pieces';
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { crossingCost, CROSSING_TUNING, PlaneRivers, riverSurface, spanOf } from './riverCrossings';
import { TASK_RIVER_FIELDS } from './riverCrossings';
import type { TaskRivers } from './riverCrossings';
import { COVER_WATER, coverForest } from './tileHeights';
import { ROUTE_CLASSES } from './router';

export type ClassKey = keyof typeof ROUTE_CLASSES;
/** Class codes stored per point (`AlignedLink.cls`); UNROUTED marks a piece no class could route. */
export const CLASS_KEYS: readonly ClassKey[] = [
  'mainline',
  'mountainRailway',
  'motorway',
  'trunk',
  'secondary',
  'mountainRoad',
  'track',
];
export const UNROUTED = 255;

/**
 * Router lattice spacing per class (m): the spike's (decision 181) coarsened
 * for the whole world (decision 184); the ground is 96 m samples, and the plan
 * rounds what the lattice leaves angular.
 */
export const ROUTE_SPACING: Record<ClassKey, number> = {
  mainline: 80,
  mountainRailway: 60,
  motorway: 80,
  trunk: 60,
  secondary: 40,
  mountainRoad: 25,
  track: 25,
};

/** Networks a link comes from. */
export const NETWORK = { Road: 0, Rail: 1, Spur: 2 } as const;
export type Network = (typeof NETWORK)[keyof typeof NETWORK];

export const LINK_TUNING = {
  /** Plan sample step (m). */
  step: 10,
  /** Search band half-width: at least `bandMin` m, else this share of the piece's chord. */
  bandMin: 1500,
  bandShare: 0.3,
  /** Router budget per piece (expansions). */
  maxExpansions: 3_000_000,
  /** Around each anchor, ground of any steepness may be cut or filled (m). */
  relax: 250,
  /** Weighted A*: paths at most this factor dearer, for a fraction of the search. */
  greed: 1.5,
  /** Structure thresholds on forced pieces, whatever their class: a canyon gets a viaduct, not a 100 m bank. */
  forcedLimits: { viaductFill: 15, tunnelCut: 30 },
  /** Thinning tolerances (m). */
  tolerance: { plan: 1, profile: 0.25 },
};

/** The band half-width (m) for a piece of chord `chord` m. */
export function bandFor(chord: number): number {
  return Math.max(LINK_TUNING.bandMin, LINK_TUNING.bandShare * chord);
}

export interface LinkTask {
  /** Index in the task list: results are stored in this order. */
  id: number;
  network: Network;
  /** Polyline in its network. */
  line: number;
  /** Anchors, unit directions, xyz interleaved (at least two). */
  anchors: Float64Array;
  cls: ClassKey;
  /** Tried in order where `cls` finds no route. */
  fallback: readonly ClassKey[];
}

/**
 * The ground a link is aligned over (decision 190). Only `height` is needed;
 * the rest make roads wander and bridge rivers.
 */
export interface AlignGround {
  /** Height (m) at a unit direction. */
  height: (d: Readonly<Vec3d>) => number;
  /** Cover byte (tileHeights.ts) at a unit direction. */
  cover?: (d: Readonly<Vec3d>) => number;
  /** The rendered rivers near the task. */
  rivers?: TaskRivers;
  /** The seeded ground field, 0..1, at a unit direction. */
  field?: (d: Readonly<Vec3d>) => number;
  /** The world's seed: with it, roads that wind wander (`WANDER_TUNING`). */
  seed?: WorldSeed;
}

/**
 * The lateral wander of the classes that wind (decision 190): amplitudes (m) and
 * wavelengths (m) of a seeded 1D noise along the link, a short octave and a long
 * one, well inside each class's curve radius (amplitude × (2π / wavelength)² is
 * under a tenth of 1 / radius). Motorways and railways keep their engineered straights.
 */
export const WANDER_TUNING: Record<
  ClassKey,
  { amp: number; wave: number; long: number; longWave: number }
> = {
  mainline: { amp: 0, wave: 1, long: 0, longWave: 1 },
  mountainRailway: { amp: 0, wave: 1, long: 0, longWave: 1 },
  motorway: { amp: 0, wave: 1, long: 0, longWave: 1 },
  trunk: { amp: 14, wave: 1600, long: 120, longWave: 7000 },
  secondary: { amp: 35, wave: 900, long: 250, longWave: 6000 },
  mountainRoad: { amp: 8, wave: 500, long: 0, longWave: 1 },
  track: { amp: 25, wave: 450, long: 40, longWave: 1500 },
};
/** Where the wander fades: within this of a link's ends and of a river crossing (m), and on side slopes steeper than `slope`. */
export const WANDER_FADE = { ends: 400, crossing: 450, slope: 0.08, smooth: 250 };

/** Ground costs per meter on top of 1 (decision 190). */
export const GROUND_TUNING = {
  /** At full forest density. */
  forest: 0.25,
  /** Open water (lakes, the sea) and river channels, per meter. */
  water: 60,
  /** The seeded field's share: 0..`field` on top. */
  field: 0.3,
  /** Its wavelengths (m): two octaves. */
  wavelength: 2500,
};

/** The seeded ground field (0..1) of a world: soil, field patterns and property lines, in one stream. */
export function groundField(seed: WorldSeed, radius: number): (d: Readonly<Vec3d>) => number {
  const noise = new Noise3(rng(seed, 'alignment').fork('ground'));
  const k = radius / GROUND_TUNING.wavelength;
  return (d) => {
    const n =
      noise.noise(d.x * k, d.y * k, d.z * k) +
      0.5 * noise.noise(d.x * k * 2.7, d.y * k * 2.7, d.z * k * 2.7);
    return Math.min(1, Math.max(0, 0.5 + 0.5 * n));
  };
}

/** Values per crossing record: s, point xyz, river (index segment id), width, span, deck elevation, |sin|. */
export const CROSSING_FIELDS = 9;

export interface AlignedLink {
  id: number;
  network: Network;
  line: number;
  /** Thinned points: unit directions, xyz interleaved. */
  points: Float64Array;
  /** Design and ground elevation (m), structure (STRUCTURE) and class code at each point. */
  design: Float32Array;
  ground: Float32Array;
  structure: Uint8Array;
  cls: Uint8Array;
  /** Pieces routed by a fallback class, by the last resort, and left on their chord. */
  fellBack: number;
  forced: number;
  unrouted: number;
  /** Corners rounded tighter than their class allows. */
  violations: number;
  expansions: number;
  /** Length (m). */
  length: number;
  /** The rivers it bridges (CROSSING_FIELDS each), along it. */
  crossings: Float64Array;
}

/** Aligns link `task` over `ground` (or a height function) on a planet of `radius` m. */
export function alignLink(
  task: LinkTask,
  groundIn: AlignGround | ((d: Readonly<Vec3d>) => number),
  radius: number,
): AlignedLink {
  const G: AlignGround = typeof groundIn === 'function' ? { height: groundIn } : groundIn;
  const height = G.height;
  /** Crossings the routed pieces made: river index, and a point near it. */
  const routedCrossings: { river: number; at: Vec3d }[] = [];
  const anchors: Vec3d[] = [];
  for (let i = 0; i < task.anchors.length; i += 3)
    anchors.push(new Vec3d(task.anchors[i]!, task.anchors[i + 1]!, task.anchors[i + 2]!));
  // 1. Route each piece; collect corners with the class code of the straight they end.
  const verts: Vec3d[] = [anchors[0]!];
  const vcls: number[] = [CLASS_KEYS.indexOf(task.cls)];
  const vforced: boolean[] = [false];
  let fellBack = 0;
  let unrouted = 0;
  let forced = 0;
  let expansions = 0;
  for (let p = 0; p + 1 < anchors.length; p++) {
    const a = anchors[p]!;
    const b = anchors[p + 1]!;
    const chord = a.distanceTo(b) * radius;
    if (chord < 1) continue;
    // Each class in turn; where none finds a route, the last over ground of any
    // steepness at a high price (forced: cut and filled).
    const classes = [task.cls, ...task.fallback];
    // The ground's costs and the rivers in the piece's plane (the frame routePiece uses).
    const mid = new Vec3d(a.x + b.x, a.y + b.y, a.z + b.z).normalize();
    const frame = gnomonic(mid, radius);
    const band = bandFor(chord);
    const rivers =
      G.rivers && G.rivers.ids.length
        ? new PlaneRivers(G.rivers, frame, mid, 0.5 * chord + band + 2000, radius)
        : null;
    const at = new Vec3d();
    const factor =
      G.cover || G.field || rivers
        ? (x: number, y: number) => {
            frame.toSphere(x, y, at);
            let f = 1;
            if (G.cover) {
              const c = G.cover(at);
              if (c & COVER_WATER) return 1 + GROUND_TUNING.water;
              f += GROUND_TUNING.forest * coverForest(c);
            }
            if (rivers?.inside(x, y)) return 1 + GROUND_TUNING.water;
            if (G.field) f += GROUND_TUNING.field * G.field(at);
            return f;
          }
        : undefined;
    const extra = rivers
      ? (x0: number, y0: number, x1: number, y1: number) => {
          const c = rivers.crossing(x0, y0, x1, y1);
          return c ? crossingCost(c) : 0;
        }
      : undefined;
    let r: ReturnType<typeof routePiece> = null;
    let code = CLASS_KEYS.indexOf(task.cls);
    let isForced = false;
    for (let c = 0; c <= classes.length && !r; c++) {
      const key = classes[Math.min(c, classes.length - 1)]!;
      r = routePiece(a, b, height, radius, {
        cls: ROUTE_CLASSES[key],
        spacing: ROUTE_SPACING[key],
        band: bandFor(chord),
        maxExpansions: LINK_TUNING.maxExpansions,
        relax: LINK_TUNING.relax,
        greed: LINK_TUNING.greed,
        anyGrade: c === classes.length,
        factor,
        extra,
      });
      if (!r) continue;
      expansions += r.expansions;
      code = CLASS_KEYS.indexOf(key);
      isForced = c === classes.length;
      if (isForced) forced++;
      else if (c > 0) fellBack++;
    }
    if (r && rivers)
      for (let i = 1; i < r.plane.length; i++) {
        const [x0, y0] = r.plane[i - 1]!;
        const [x1, y1] = r.plane[i]!;
        // Every river the simplified path crosses between these corners.
        let from = 0;
        for (;;) {
          const fx = x0 + (x1 - x0) * from;
          const fy = y0 + (y1 - y0) * from;
          const cr = crossAlong(rivers, fx, fy, x1, y1);
          if (!cr) break;
          const t = from + (1 - from) * cr.t;
          routedCrossings.push({
            river: cr.river,
            at: frame.toSphere(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t),
          });
          from = t + 1e-6;
          if (from >= 1) break;
        }
      }
    const piece = r ? r.vertices : [a, b];
    if (!r) {
      code = UNROUTED;
      unrouted++;
    }
    for (let i = 1; i < piece.length; i++) {
      verts.push(piece[i]!);
      vcls.push(code);
      vforced.push(isForced);
    }
  }
  if (verts.length < 2) {
    verts.push(anchors[anchors.length - 1]!);
    vcls.push(vcls[0]!);
    vforced.push(false);
  }
  // 2. The plan: round each corner in a frame at it, then resample.
  const minRadius = (code: number) =>
    code === UNROUTED ? 0 : ROUTE_CLASSES[CLASS_KEYS[code]!].minRadius;
  const dense: Vec3d[] = [verts[0]!];
  const dcls: number[] = [vcls[1]!];
  const dforced: boolean[] = [vforced[1]!];
  let used = 0;
  let violations = 0;
  const step = LINK_TUNING.step;
  for (let i = 1; i + 1 < verts.length; i++) {
    const frame = gnomonic(verts[i]!, radius);
    const r = Math.min(minRadius(vcls[i]!), minRadius(vcls[i + 1]!));
    const c =
      r > 0
        ? roundCorner(
            frame.toPlane(verts[i - 1]!),
            [0, 0],
            frame.toPlane(verts[i + 1]!),
            r,
            used,
            step,
          )
        : null;
    if (!c) {
      dense.push(verts[i]!);
      dcls.push(vcls[i + 1]!);
      dforced.push(vforced[i + 1]!);
      used = 0;
      continue;
    }
    // The tangent point ends the straight into the corner; the arc takes the next straight's class.
    dense.push(frame.toSphere(c.points[0]![0], c.points[0]![1]));
    dcls.push(vcls[i]!);
    dforced.push(vforced[i]!);
    for (let k = 1; k < c.points.length; k++) {
      dense.push(frame.toSphere(c.points[k]![0], c.points[k]![1]));
      dcls.push(vcls[i + 1]!);
      dforced.push(vforced[i + 1]!);
    }
    if (c.violation !== null) violations++;
    used = c.tangent;
  }
  dense.push(verts[verts.length - 1]!);
  dcls.push(vcls[vcls.length - 1]!);
  dforced.push(vforced[vforced.length - 1]!);
  // Resample every `step` m (chords: under a millimeter short of the arc at these lengths).
  const s0 = [0];
  for (let i = 1; i < dense.length; i++)
    s0.push(s0[i - 1]! + dense[i]!.distanceTo(dense[i - 1]!) * radius);
  const total = s0[s0.length - 1]!;
  const n = Math.max(1, Math.ceil(total / step));
  const points: Vec3d[] = [];
  const s: number[] = [];
  const cls: number[] = [];
  const forcedAt: boolean[] = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const sk = (k / n) * total;
    while (j < dense.length - 2 && s0[j + 1]! < sk) j++;
    const span = s0[j + 1]! - s0[j]!;
    const f = span > 0 ? Math.min(1, Math.max(0, (sk - s0[j]!) / span)) : 0;
    const a = dense[j]!;
    const b = dense[j + 1]!;
    points.push(
      new Vec3d(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f).normalize(),
    );
    s.push(sk);
    cls.push(dcls[j + 1]!);
    forcedAt.push(dforced[j + 1]!);
  }
  // 2b. Roads that wind wander a little off the routed line (decision 190).
  if (G.seed !== undefined) {
    wander(points, s, cls, routedCrossings, G, task, radius);
    for (let i = 1; i < points.length; i++)
      s[i] = s[i - 1]! + points[i]!.distanceTo(points[i - 1]!) * radius;
  }
  // 3. Profile and earthworks along the whole link.
  const ground = points.map((p) => height(p));
  const grade = cls.map((c) => (c === UNROUTED ? 10 : ROUTE_CLASSES[CLASS_KEYS[c]!].maxGrade));
  const design = designProfile(ground, s, grade, {
    startZ: ground[0],
    endZ: ground[ground.length - 1],
  });
  // Bridges: the crossings the pieces made, found again on the plan, with their decks.
  const bridge = new Uint8Array(points.length);
  const crossings: number[] = [];
  if (G.rivers)
    for (const rc of routedCrossings) {
      const found = crossingOnPlan(points, s, rc.river, rc.at, G.rivers, radius);
      if (!found) continue;
      // Two pieces can report one crossing at their shared anchor.
      if (
        crossings.some((_, q) => q % CROSSING_FIELDS === 0 && Math.abs(crossings[q]! - found.s) < 1)
      )
        continue;
      const c = cls[found.i]!;
      const key = c === UNROUTED ? task.cls : CLASS_KEYS[c]!;
      const half = 0.5 * found.span;
      const sAt = (target: number) => {
        let k = found.i;
        while (k > 0 && s[k]! > target) k--;
        while (k + 1 < s.length && s[k + 1]! <= target) k++;
        return k;
      };
      const lo = sAt(found.s - half);
      const hi = Math.min(points.length - 1, sAt(found.s + half) + 1);
      const banks = Math.max(ground[lo]!, ground[hi]!);
      let floor = Infinity;
      for (let k = lo; k <= hi; k++) floor = Math.min(floor, ground[k]!);
      const surface = riverSurface(G.rivers, rc.river, found.u) ?? floor;
      const deck = Math.max(surface + CROSSING_TUNING.clearance[key], banks + 1);
      for (let k = lo; k <= hi; k++) {
        design[k] = Math.max(design[k]!, deck);
        bridge[k] = 1;
      }
      // The approaches climb to the deck within the grade (an embankment, or a viaduct).
      for (let k = hi + 1; k < points.length; k++) {
        const z = design[k - 1]! - grade[k]! * (s[k]! - s[k - 1]!);
        if (design[k]! >= z) break;
        design[k] = z;
      }
      for (let k = lo - 1; k >= 0; k--) {
        const z = design[k + 1]! - grade[k]! * (s[k + 1]! - s[k]!);
        if (design[k]! >= z) break;
        design[k] = z;
      }
      crossings.push(
        found.s,
        found.point.x,
        found.point.y,
        found.point.z,
        G.rivers.ids[rc.river]!,
        found.width,
        found.span,
        deck,
        found.sin,
      );
    }
  const structure = design.map((z, i) => {
    const c = cls[i]!;
    if (bridge[i]) return STRUCTURE.Bridge;
    if (c === UNROUTED) return STRUCTURE.Corridor;
    const lim = forcedAt[i] ? LINK_TUNING.forcedLimits : EARTHWORK_LIMITS[CLASS_KEYS[c]!];
    const d = z - ground[i]!;
    if (d > lim.viaductFill) return STRUCTURE.Viaduct;
    if (-d > lim.tunnelCut) return STRUCTURE.Tunnel;
    return STRUCTURE.Corridor;
  });
  // 4. Thin for storage.
  const keep = thin(
    points,
    s,
    design,
    (i) => structure[i] !== structure[i - 1] || cls[i] !== cls[i - 1],
    radius,
  );
  const m = keep.length;
  const out: AlignedLink = {
    id: task.id,
    network: task.network,
    line: task.line,
    points: new Float64Array(m * 3),
    design: new Float32Array(m),
    ground: new Float32Array(m),
    structure: new Uint8Array(m),
    cls: new Uint8Array(m),
    fellBack,
    forced,
    unrouted,
    violations,
    expansions,
    length: s[s.length - 1]!,
    crossings: sortCrossings(crossings),
  };
  keep.forEach((i, k) => {
    out.points[k * 3] = points[i]!.x;
    out.points[k * 3 + 1] = points[i]!.y;
    out.points[k * 3 + 2] = points[i]!.z;
    out.design[k] = design[i]!;
    out.ground[k] = ground[i]!;
    out.structure[k] = structure[i]!;
    out.cls[k] = cls[i]!;
  });
  return out;
}

/**
 * Indices of the samples kept (see the module comment): both ends, every `hard`
 * index and the one before it, and as few others as the tolerances allow.
 */
export function thin(
  points: readonly Vec3d[],
  s: readonly number[],
  z: readonly number[],
  hard: (i: number) => boolean,
  radius: number,
): number[] {
  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  for (let i = 1; i < n; i++)
    if (hard(i)) {
      keep[i] = 1;
      keep[i - 1] = 1;
    }
  const { plan, profile } = LINK_TUNING.tolerance;
  const normal = new Vec3d();
  const stack: [number, number][] = [];
  let a = 0;
  for (let b = 1; b < n; b++) {
    if (!keep[b]) continue;
    stack.push([a, b]);
    a = b;
  }
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    if (i1 - i0 < 2) continue;
    const pa = points[i0]!;
    const pb = points[i1]!;
    normal.copy(pa).cross(pb);
    const nl = normal.length();
    const span = s[i1]! - s[i0]!;
    let worst = 0;
    let at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const across = nl > 0 ? (Math.abs(points[i]!.dot(normal)) / nl) * radius : 0;
      const t = span > 0 ? (s[i]! - s[i0]!) / span : 0;
      const dz = Math.abs(z[i]! - (z[i0]! + (z[i1]! - z[i0]!) * t));
      const e = Math.max(across / plan, dz / profile);
      if (e > worst) {
        worst = e;
        at = i;
      }
    }
    if (span > CORRIDOR_MAX_SEGMENT && worst <= 1) at = (i0 + i1) >> 1;
    if (at >= 0 && (worst > 1 || span > CORRIDOR_MAX_SEGMENT)) {
      keep[at] = 1;
      stack.push([i0, at], [at, i1]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** The first crossing from (x0, y0) toward (x1, y1), split into moves of at most a bucket. */
function crossAlong(rivers: PlaneRivers, x0: number, y0: number, x1: number, y1: number) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(L / (0.5 * CROSSING_TUNING.cell)));
  for (let k = 0; k < n; k++) {
    const ax = x0 + ((x1 - x0) * k) / n;
    const ay = y0 + ((y1 - y0) * k) / n;
    const bx = x0 + ((x1 - x0) * (k + 1)) / n;
    const by = y0 + ((y1 - y0) * (k + 1)) / n;
    const c = rivers.crossing(ax, ay, bx, by);
    if (c) return { ...c, t: (k + c.t) / n };
  }
  return null;
}

/**
 * Where the plan crosses task river `river` near `at`: the sample before it, the
 * arc length and point of the crossing, where along the river, its width, |sin|
 * and span. Searches the plan within 800 m of `at`, against that river segment
 * and its neighbors in the task's list; null if the plan no longer crosses there.
 */
function crossingOnPlan(
  points: readonly Vec3d[],
  s: readonly number[],
  river: number,
  at: Readonly<Vec3d>,
  rivers: TaskRivers,
  radius: number,
) {
  const frame = gnomonic(at, radius);
  const near = Math.cos(800 / radius);
  const d = rivers.data;
  const F = TASK_RIVER_FIELDS;
  let best: {
    i: number;
    s: number;
    point: Vec3d;
    u: number;
    width: number;
    sin: number;
    span: number;
    dist: number;
  } | null = null;
  const ra = new Vec3d();
  const rb = new Vec3d();
  for (const q of [river - 1, river, river + 1]) {
    if (q < 0 || q >= rivers.ids.length) continue;
    // Neighbors in the list only count if they continue the same river.
    if (q !== river && Math.abs(rivers.ids[q]! - rivers.ids[river]!) !== 1) continue;
    ra.set(d[q * F]!, d[q * F + 1]!, d[q * F + 2]!);
    rb.set(d[q * F + 3]!, d[q * F + 4]!, d[q * F + 5]!);
    const [ax, ay] = frame.toPlane(ra);
    const [bx, by] = frame.toPlane(rb);
    const ex = bx - ax;
    const ey = by - ay;
    let prev: [number, number] | null = null;
    for (let i = 0; i < points.length; i++) {
      if (points[i]!.dot(at) < near) {
        prev = null;
        continue;
      }
      const cur = frame.toPlane(points[i]!);
      if (prev && i > 0) {
        const mx = cur[0] - prev[0];
        const my = cur[1] - prev[1];
        const den = mx * ey - my * ex;
        if (den !== 0) {
          const qx = ax - prev[0];
          const qy = ay - prev[1];
          const t = (qx * ey - qy * ex) / den;
          const u = (qx * my - qy * mx) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            const px = prev[0] + mx * t;
            const py = prev[1] + my * t;
            const dist = Math.hypot(px, py);
            if (!best || dist < best.dist) {
              const width = d[q * F + 6]! + (d[q * F + 7]! - d[q * F + 6]!) * u;
              const sin = Math.abs(den) / (Math.hypot(mx, my) * Math.hypot(ex, ey));
              best = {
                i: i - 1,
                s: s[i - 1]! + (s[i]! - s[i - 1]!) * t,
                point: frame.toSphere(px, py),
                u,
                width,
                sin,
                span: spanOf(width, sin),
                dist,
              };
            }
          }
        }
      }
      prev = cur;
    }
  }
  return best;
}

/** Crossing records sorted by arc length. */
function sortCrossings(flat: number[]): Float64Array {
  const recs: number[][] = [];
  for (let i = 0; i < flat.length; i += CROSSING_FIELDS)
    recs.push(flat.slice(i, i + CROSSING_FIELDS));
  recs.sort((a, b) => a[0]! - b[0]!);
  return Float64Array.from(recs.flat());
}

/**
 * Displaces the plan sideways by a seeded noise per link (WANDER_TUNING), faded
 * at the link's ends, near river crossings (bridges stay square), on side slopes
 * (the routed shelf stays where the slope put it) and where it would go into
 * open water. The fade is smoothed over WANDER_FADE.smooth m, so it bends nothing sharply.
 */
function wander(
  points: Vec3d[],
  s: readonly number[],
  cls: readonly number[],
  crossings: readonly { at: Vec3d }[],
  G: AlignGround,
  task: LinkTask,
  radius: number,
): void {
  const n = points.length;
  if (n < 3) return;
  const total = s[n - 1]!;
  const r = rng(G.seed!, 'alignment').fork(`wander/${task.network}/${task.line}`);
  // Two octaves of 1D gradient noise, by arc length over the class's wavelength.
  const grads = Array.from({ length: 3 }, () =>
    Float64Array.from({ length: Math.ceil(total / 200) + 4 }, () => r.range(-1, 1)),
  );
  const noise1 = (g: Float64Array, x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = g[i % g.length]! * f;
    const b = g[(i + 1) % g.length]! * (f - 1);
    const t = f * f * (3 - 2 * f);
    return 2 * (a + (b - a) * t);
  };
  const normal = (i: number, out: Vec3d) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(n - 1, i + 1)]!;
    return out
      .set(b.x - a.x, b.y - a.y, b.z - a.z)
      .cross(points[i]!)
      .normalize();
  };
  const nrm = new Vec3d();
  const q = new Vec3d();
  const side = (p: Readonly<Vec3d>, d: Readonly<Vec3d>, m: number) =>
    q.set(p.x + (d.x * m) / radius, p.y + (d.y * m) / radius, p.z + (d.z * m) / radius).normalize();
  // The mask: 1 where the road may wander.
  const mask = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = cls[i]!;
    const tw = c === UNROUTED ? null : WANDER_TUNING[CLASS_KEYS[c]!];
    const w = tw ? tw.amp + tw.long : 0;
    if (w === 0) continue;
    let m = smooth(0, WANDER_FADE.ends, Math.min(s[i]!, total - s[i]!));
    for (const cr of crossings)
      m = Math.min(m, smooth(150, WANDER_FADE.crossing, cr.at.distanceTo(points[i]!) * radius));
    if (m > 0) {
      normal(i, nrm);
      const hl = G.height(side(points[i]!, nrm, -60));
      const hr = G.height(side(points[i]!, nrm, 60));
      m *= Math.max(0, 1 - Math.abs(hr - hl) / 120 / WANDER_FADE.slope);
      if (m > 0 && G.cover) {
        if (G.cover(side(points[i]!, nrm, w)) & COVER_WATER) m = 0;
        else if (G.cover(side(points[i]!, nrm, -w)) & COVER_WATER) m = 0;
      }
    }
    mask[i] = m;
  }
  // Smooth the mask (a running mean over the fade length), so it never kinks the line.
  const k = Math.max(1, Math.round(WANDER_FADE.smooth / Math.max(1, s[1]! - s[0]!)));
  const sm = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n + k; i++) {
    if (i < n) acc += mask[i]!;
    if (i - 2 * k - 1 >= 0) acc -= mask[i - 2 * k - 1]!;
    const c = i - k;
    if (c >= 0 && c < n) sm[c] = acc / (Math.min(n - 1, i) - Math.max(0, i - 2 * k) + 1);
  }
  const shifted: Vec3d[] = [];
  for (let i = 0; i < n; i++) {
    const c = cls[i]!;
    const t = c === UNROUTED ? null : WANDER_TUNING[CLASS_KEYS[c]!];
    const m = sm[i]!;
    if (!t || t.amp + t.long === 0 || m <= 0 || i === 0 || i === n - 1) {
      shifted.push(points[i]!);
      continue;
    }
    const x = s[i]! / t.wave;
    const off =
      m *
      (t.amp * (noise1(grads[0]!, x) + 0.35 * noise1(grads[1]!, 2.3 * x)) +
        t.long * noise1(grads[2]!, s[i]! / t.longWave));
    normal(i, nrm);
    shifted.push(side(points[i]!, nrm, off).clone());
  }
  for (let i = 0; i < n; i++) points[i] = shifted[i]!;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
