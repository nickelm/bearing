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
}

/** Aligns link `task` over ground `height` (m at a unit direction) on a planet of `radius` m. */
export function alignLink(
  task: LinkTask,
  height: (d: Readonly<Vec3d>) => number,
  radius: number,
): AlignedLink {
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
      });
      if (!r) continue;
      expansions += r.expansions;
      code = CLASS_KEYS.indexOf(key);
      isForced = c === classes.length;
      if (isForced) forced++;
      else if (c > 0) fellBack++;
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
  // 3. Profile and earthworks along the whole link.
  const ground = points.map((p) => height(p));
  const grade = cls.map((c) => (c === UNROUTED ? 10 : ROUTE_CLASSES[CLASS_KEYS[c]!].maxGrade));
  const design = designProfile(ground, s, grade, {
    startZ: ground[0],
    endZ: ground[ground.length - 1],
  });
  const structure = design.map((z, i) => {
    const c = cls[i]!;
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
    length: total,
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
