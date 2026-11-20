/**
 * A settlement's plan (proposal 0009, decisions 260–265): streets, blocks, parcels,
 * districts, buildings, landmarks and candidate targets, from its input alone.
 *
 * - **Cities and towns**: an old core of wards where the style has one, streets traced
 *   through the tensor field round it, blocks from the street graph's faces, districts,
 *   parcels and one building per parcel; towns trace wider and with fewer districts.
 * - **Villages**: a street village or a green, with strip parcels along the frontage.
 * - **Farmsteads** round villages and towns at field corners.
 *
 * Streams (each forked by the settlement's key, so plans are independent of the order
 * they are built in): `settlements/streets`, `settlements/districts`,
 * `settlements/parcels`, `settlements/buildings`, `settlements/landmarks`,
 * `settlements/farmsteads`.
 */
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import { blocksFromFaces } from './blocks';
import {
  DISTRICT_RULES,
  microdistrictSlabs,
  parcelBuilding,
  STYLE_PARCEL,
  boxInside,
} from './buildings';
import { assignDistricts, districtGround } from './districts';
import type { BlockContext } from './districts';
import { SettlementFrame } from './frame';
import {
  boxCorners,
  Lattice,
  LineSet,
  lineAngleDiff,
  minAreaBox,
  pointInPoly,
  polyArea,
  polyCentroid,
  polylineDist,
  polylineLength,
  segDist,
  segIntersect,
  simplify,
  SpatialHash,
} from './geom';
import type { Poly } from './geom';
import { buildGraph, faces } from './graph';
import type { GraphLine } from './graph';
import { landmarkName } from './landmarks';
import { oldCore } from './oldCore';
import { subdivideBlock } from './parcels';
import { traceStreets } from './streets';
import { PALETTES } from './styles';
import { GroundCache, TensorField } from './tensorField';
import {
  BuildingKind,
  District,
  Ground,
  LandmarkKind,
  Roof,
  STREET_HALF_WIDTH,
  StreetKind,
  Style,
  TargetKind,
  Tier,
} from './types';
import type {
  Block,
  Building,
  CandidateTarget,
  Landmark,
  Pad,
  Parcel,
  SiteAnchor,
  PlanMetrics,
  SettlementInput,
  SettlementPlan,
  Street,
} from './types';
import { farmstead, fieldCorner, plotBuildings, stripParcels, VILLAGE_PLOT } from './village';

/** Vehicle streets steeper than this become paths, and than STAIRS_GRADE stairs. */
export const GRADE_LIMIT = 0.1;
export const STAIRS_GRADE = 0.25;
/** Streets stop on ground steeper than this. */
const STEEP = 0.3;

type B = Omit<Building, 'parcel' | 'block' | 'landmark'>;

export interface PlanOptions {
  /** The world's canopy seed, for field corners (decision 162); none skips farmsteads. */
  fieldSeed?: number;
  radius: number;
}

class Context {
  readonly frame: SettlementFrame;
  readonly ground: GroundCache;
  readonly palette;
  readonly outline: number[];
  private readonly rivers = new SpatialHash<[number, number, number, number, number]>(100);
  readonly streets: Street[] = [];
  readonly blocks: Block[] = [];
  readonly parcels: Parcel[] = [];
  readonly buildings: Building[] = [];
  readonly landmarks: Landmark[] = [];
  readonly targets: CandidateTarget[] = [];
  readonly plumes: number[] = [];
  /** Buildings given way to landmarks and sites, dropped by `compact` at the end. */
  readonly removed = new Set<number>();
  /** Original class of each street before the grade check (for the slope metric). */
  readonly traced: StreetKind[] = [];
  dropped = 0;
  coreRadius = 0;
  /** The ground's water on a 10 m lattice, and the lines the districts measure to. */
  private readonly wet: Lattice<boolean>;
  readonly lineSets: { rails: LineSet; water: LineSet; arterials: LineSet };
  private streetSet: LineSet | null = null;

  constructor(
    readonly input: SettlementInput,
    readonly seed: WorldSeed,
    readonly opts: PlanOptions,
  ) {
    this.frame = new SettlementFrame(input.center, opts.radius);
    this.ground = new GroundCache(input.ground, 30);
    this.palette = PALETTES[input.style]!;
    this.outline = Array.from(input.outline);
    this.wet = new Lattice(10, (x, y) => input.ground.water(x, y));
    this.lineSets = {
      rails: new LineSet(input.rails, 250),
      water: new LineSet([...input.rivers, ...input.coasts], 250),
      arterials: new LineSet(input.arterials, 250),
    };
    for (const rv of input.rivers) {
      const p = rv.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        this.rivers.addBox(
          Math.min(p[i]!, p[i + 2]!) - rv.halfWidth,
          Math.min(p[i + 1]!, p[i + 3]!) - rv.halfWidth,
          Math.max(p[i]!, p[i + 2]!) + rv.halfWidth,
          Math.max(p[i + 1]!, p[i + 3]!) + rv.halfWidth,
          [p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!, rv.halfWidth],
        );
      }
    }
  }

  stream(name: string): Rng {
    return rng(this.seed, `settlements/${name}`).fork(this.input.key);
  }

  /** Extent radius (m) toward bearing `a`. */
  extent(a: number): number {
    const k = this.outline.length;
    const t = ((((a / (2 * Math.PI)) % 1) + 1) % 1) * k;
    const i = Math.floor(t) % k;
    const f = t - Math.floor(t);
    return this.outline[i]! * (1 - f) + this.outline[(i + 1) % k]! * f;
  }

  share(x: number, y: number): number {
    return Math.hypot(x, y) / Math.max(1, this.extent(Math.atan2(y, x)));
  }

  water(x: number, y: number, margin = 3): boolean {
    if (this.wet.nearest(x, y)) return true;
    return this.rivers.near(
      x,
      y,
      margin + 60,
      ([ax, ay, bx, by, hw]) => segDist(x, y, ax, ay, bx, by).d < hw + margin,
    );
  }

  slope(x: number, y: number): number {
    const [gx, gy] = this.ground.gradient(x, y);
    return Math.hypot(gx, gy);
  }

  /** Distance (m) to the nearest line of a set, up to 2 km (else 2 km). */
  distTo(set: LineSet, x: number, y: number): number {
    return Math.min(2000, set.nearest(x, y, 2000).d);
  }

  /** The streets as a line set, built once the streets are in. */
  streetLines(): LineSet {
    this.streetSet ??= new LineSet(
      this.streets.map((s) => ({ points: s.points, weight: STREET_HALF_WIDTH[s.kind]! })),
      150,
    );
    return this.streetSet;
  }

  /** Distance (m) from (x, y) to the nearest street's edge. */
  streetClearance(x: number, y: number): number {
    const n = this.streetLines().nearest(x, y, 200);
    return n.d - n.weight;
  }

  addBuilding(b: B, parcel: number, block: number, landmark = -1): number {
    // Terrain fit: no building over water, none on ground steeper than 45%.
    const c = boxCorners(b.x, b.y, b.angle, b.halfLength, b.halfWidth);
    for (let i = 0; i < 4; i++) if (this.water(c[i * 2]!, c[i * 2 + 1]!, 1)) return -1;
    if (this.slope(b.x, b.y) > 0.45) return -1;
    this.buildings.push({ ...b, parcel, block, landmark });
    return this.buildings.length - 1;
  }

  addLandmark(l: Omit<Landmark, 'name'>, r: Rng): number {
    const name = landmarkName(l.kind, this.input.name, this.input.flavor, this.input.style, r);
    this.landmarks.push({ ...l, name });
    const i = this.landmarks.length - 1;
    if (l.kind === LandmarkKind.Smokestack || l.kind === LandmarkKind.CoolingTower)
      this.plumes.push(i);
    return i;
  }

  /** Graph edges become streets; vehicle streets steeper than the limit become paths or stairs. */
  addStreets(edges: { kind: number; points: number[] }[]): void {
    for (const e of edges) {
      const pts = e.points;
      let grade = 0;
      let wet = false;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const L = Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!);
        const n = Math.max(1, Math.ceil(L / 25));
        let h0 = this.ground.height(pts[i]!, pts[i + 1]!);
        for (let k = 1; k <= n; k++) {
          const x = pts[i]! + ((pts[i + 2]! - pts[i]!) * k) / n;
          const y = pts[i + 1]! + ((pts[i + 3]! - pts[i + 1]!) * k) / n;
          const h1 = this.ground.height(x, y);
          grade = Math.max(grade, Math.abs(h1 - h0) / (L / n));
          h0 = h1;
          if (e.kind !== StreetKind.Arterial && this.water(x, y, 0)) wet = true;
        }
      }
      if (wet) continue;
      let kind = e.kind as StreetKind;
      if (kind !== StreetKind.Arterial && kind <= StreetKind.Lane && grade > GRADE_LIMIT) {
        kind = grade > STAIRS_GRADE ? StreetKind.Stairs : StreetKind.Path;
      }
      this.streets.push({ kind, points: pts, grade });
      this.traced.push(e.kind as StreetKind);
    }
  }

  metrics(ms: number): PlanMetrics {
    const streetLength = [0, 0, 0, 0, 0, 0];
    let slopedMinor = 0;
    let slopedMinorAlong = 0;
    let steepVehicle = 0;
    let inWater = 0;
    this.streets.forEach((s, k) => {
      streetLength[s.kind] = (streetLength[s.kind] ?? 0) + polylineLength(s.points);
      if (
        s.kind !== StreetKind.Arterial &&
        s.kind <= StreetKind.Lane &&
        s.grade > GRADE_LIMIT + 1e-9
      )
        steepVehicle++;
      if (this.traced[k] !== StreetKind.Minor) return;
      const p = s.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const L = Math.hypot(p[i + 2]! - p[i]!, p[i + 3]! - p[i + 1]!);
        const n = Math.max(1, Math.ceil(L / 25));
        const angle = Math.atan2(p[i + 3]! - p[i + 1]!, p[i + 2]! - p[i]!);
        for (let q = 0; q < n; q++) {
          const x = p[i]! + ((p[i + 2]! - p[i]!) * (q + 0.5)) / n;
          const y = p[i + 1]! + ((p[i + 3]! - p[i + 1]!) * (q + 0.5)) / n;
          const [gx, gy] = this.ground.gradient(x, y);
          if (Math.hypot(gx, gy) <= 0.1) continue;
          slopedMinor += L / n;
          if (lineAngleDiff(angle, Math.atan2(gy, gx) + Math.PI / 2) < Math.PI / 6)
            slopedMinorAlong += L / n;
        }
      }
    });
    let outsideParcel = 0;
    for (const b of this.buildings) {
      const c = boxCorners(b.x, b.y, b.angle, b.halfLength, b.halfWidth);
      for (let i = 0; i < 4; i++)
        if (this.water(c[i * 2]!, c[i * 2 + 1]!, 0)) {
          inWater++;
          break;
        }
      if (b.parcel < 0) continue;
      const poly = this.parcels[b.parcel]!.polygon;
      // A hair of tolerance for corners on the parcel's own edge.
      const sh = boxCorners(b.x, b.y, b.angle, b.halfLength * 0.999, b.halfWidth * 0.999);
      for (let i = 0; i < 4; i++) {
        if (!pointInPoly(sh[i * 2]!, sh[i * 2 + 1]!, poly)) {
          outsideParcel++;
          break;
        }
      }
    }
    const noFrontage = this.parcels.filter(
      (p) => Math.hypot(p.frontage[2] - p.frontage[0], p.frontage[3] - p.frontage[1]) < 1,
    ).length;
    return {
      streetLength,
      slopedMinor,
      slopedMinorAlong,
      steepVehicle,
      outsideParcel,
      noFrontage,
      inWater,
      droppedBlocks: this.dropped,
      ms,
    };
  }
}

/** Plans one settlement. Pure and deterministic in (input, seed). */
export function planSettlement(
  input: SettlementInput,
  seed: WorldSeed,
  opts: PlanOptions,
): SettlementPlan {
  const t0 = performance.now();
  const ctx = new Context(input, seed, opts);
  if (input.tier === Tier.Village) planVillage(ctx);
  else planTown(ctx);
  if (input.tier !== Tier.City && opts.fieldSeed !== undefined) addFarmsteads(ctx);
  addBridges(ctx);
  placeAnchors(ctx);
  compact(ctx);
  const pads = largePads(ctx);
  const ms = performance.now() - t0;
  return {
    key: input.key,
    name: input.name,
    tier: input.tier,
    style: input.style,
    center: input.center,
    coreRadius: ctx.coreRadius,
    streets: ctx.streets,
    blocks: ctx.blocks,
    parcels: ctx.parcels,
    buildings: ctx.buildings,
    landmarks: ctx.landmarks,
    targets: ctx.targets,
    plumes: ctx.plumes,
    pads,
    metrics: ctx.metrics(ms),
  };
}

function meanRadius(ctx: Context): number {
  return ctx.outline.reduce((a, b) => a + b, 0) / ctx.outline.length;
}

function planTown(ctx: Context): void {
  const { input, palette } = ctx;
  const city = input.tier === Tier.City;
  const R = meanRadius(ctx);
  const rs = ctx.stream('streets');
  // The old core.
  let core = null;
  if (palette.oldCore) {
    const rc = city
      ? Math.min(900, Math.max(300, 0.16 * R))
      : Math.min(420, Math.max(180, 0.2 * R));
    core = oldCore(rc, city ? 45 : 18, (x, y) => ctx.water(x, y), rs.fork('core'));
    ctx.coreRadius = rc;
  }
  // The field.
  const main = input.arterials.slice().sort((a, b) => a.roadClass - b.roadClass)[0];
  const baseAngle =
    main && main.points.length >= 4
      ? Math.atan2(main.points[3]! - main.points[1]!, main.points[2]! - main.points[0]!)
      : rs.nextFloat() * Math.PI;
  const boundaries = [
    ...input.rivers.map((r) => ({ points: r.points, weight: 1.2 })),
    ...input.coasts.map((c) => ({ points: c.points, weight: 1.2 })),
    ...input.rails.map((r) => ({ points: r.points, weight: 0.8 })),
  ];
  const field = new TensorField(
    {
      arterials: input.arterials.map((a) => ({
        points: a.points,
        weight: [1.3, 1.1, 0.9][a.roadClass] ?? 0.9,
      })),
      boundaries,
    },
    ctx.ground,
    {
      baseAngle,
      arterialReach: city ? 600 : 400,
      radialWeight: palette.radial * (city ? 1 : 0.5),
      radialReach: 0.6 * R,
      boundaryReach: 250,
      contourWeight: 6,
    },
  );
  const rc = ctx.coreRadius;
  const inside = new Lattice(
    8,
    (x, y) =>
      ctx.share(x, y) < 1 &&
      Math.hypot(x, y) > rc + 5 &&
      !ctx.water(x, y, 4) &&
      ctx.slope(x, y) < STEEP,
  );
  const domain = { inside: (x: number, y: number) => inside.nearest(x, y) };
  const sp = palette.spacing;
  const separation: [number, number] = city ? [240 * sp, 95 * sp] : [280 * sp, 115 * sp];
  const seeds: [number, number][] = [];
  if (core)
    for (let i = 0; i < core.ring.length - 2; i += 8)
      seeds.push([core.ring[i]! * 1.05, core.ring[i + 1]! * 1.05]);
  seeds.push([0, 0], [R * 0.3, 0], [-R * 0.3, 0], [0, R * 0.3], [0, -R * 0.3]);
  const traced = traceStreets(
    field,
    domain,
    input.arterials.map((a) => a.points),
    seeds,
    {
      separation,
      minLength: [150, 60],
      step: 10,
      maxSteps: 600,
      maxLines: city ? 1500 : 500,
      // Streets space out toward the edge: suburbs have longer blocks than the center.
      scale: (x, y) => 1 + 0.9 * Math.min(1, Math.max(0, (ctx.share(x, y) - 0.3) / 0.7)),
      // On slopes above the grade limit, minor streets keep to the contours: a step
      // within 60° of the fall line ends the line (majors, paths and stairs cross).
      accept: (x, y, vx, vy, level) => {
        if (level === 0) return true;
        const [gx, gy] = ctx.ground.gradient(x, y);
        const g = Math.hypot(gx, gy);
        return g <= GRADE_LIMIT || Math.abs(vx * gx + vy * gy) / g < 0.5;
      },
    },
    rs,
  );
  // The graph.
  const lines: GraphLine[] = [
    ...input.arterials.map((a) => ({ kind: StreetKind.Arterial, points: a.points, extend: false })),
    ...traced.map((t) => ({
      kind: t.level === 0 ? StreetKind.Major : StreetKind.Minor,
      points: t.points,
      extend: true,
    })),
  ];
  if (core) {
    lines.push({ kind: StreetKind.Major, points: core.ring, extend: false });
    for (const l of core.lanes) lines.push({ kind: StreetKind.Lane, points: l, extend: true });
  }
  const graph = buildGraph(lines, 0.45 * separation[1]);
  ctx.addStreets(graph.edges);
  // Blocks.
  const { polygons, dropped } = blocksFromFaces(faces(graph));
  ctx.dropped = dropped;
  const contexts: BlockContext[] = [];
  const kept: Poly[] = [];
  for (const poly of polygons) {
    const [cx, cy] = polyCentroid(poly);
    if (ctx.water(cx, cy, 0) || ctx.share(cx, cy) > 1.15) {
      ctx.dropped++;
      continue;
    }
    let slope = ctx.slope(cx, cy);
    for (let i = 0; i < poly.length; i += 2)
      slope = Math.max(slope, ctx.slope(poly[i]!, poly[i + 1]!));
    kept.push(poly);
    contexts.push({
      share: ctx.share(cx, cy),
      rail: ctx.distTo(ctx.lineSets.rails, cx, cy),
      water: ctx.distTo(ctx.lineSets.water, cx, cy),
      arterial: ctx.distTo(ctx.lineSets.arterials, cx, cy),
      slope,
      area: polyArea(poly),
      inCore: rc > 0 && Math.hypot(cx, cy) < rc,
    });
  }
  const rd = ctx.stream('districts');
  const districts = assignDistricts(contexts, input.tier, input.style, palette, input.port, rd);
  // The market square: the core block holding the square's centroid.
  const squareAt = core ? polyCentroid(core.square) : null;
  const rp = ctx.stream('parcels');
  const rb = ctx.stream('buildings');
  kept.forEach((poly, bi) => {
    let district = districts[bi]!;
    let ground = districtGround(district, rd);
    const square = squareAt && pointInPoly(squareAt[0], squareAt[1], poly);
    if (square) {
      district = District.Civic;
      ground = Ground.Square;
    }
    const block: Block = {
      polygon: poly,
      district,
      ground,
      area: polyArea(poly),
      height: 0,
      slope: contexts[bi]!.slope,
    };
    ctx.blocks.push(block);
    const share = contexts[bi]!.share;
    const rule = DISTRICT_RULES[district]!;
    if (district === District.Civic || district === District.Utilities) {
      ctx.parcels.push({ polygon: poly, block: bi, frontage: longestEdge(poly) });
      return;
    }
    if (district === District.Microdistrict) {
      const pi = ctx.parcels.length;
      ctx.parcels.push({ polygon: poly, block: bi, frontage: longestEdge(poly) });
      for (const b of microdistrictSlabs(poly, palette, rb.fork(`m${bi}`)))
        ctx.addBuilding(b, pi, bi);
      return;
    }
    const target = rule.parcelArea * (STYLE_PARCEL[input.style] ?? 1);
    for (const p of subdivideBlock(poly, target, rule.frontage, rp)) {
      const pi = ctx.parcels.length;
      ctx.parcels.push({ polygon: p.polygon, block: bi, frontage: p.frontage });
      const b = parcelBuilding(p.polygon, p.frontage, district, input.style, palette, share, rb);
      if (b) ctx.addBuilding(b, pi, bi);
    }
  });
  addTownLandmarks(ctx, squareAt);
  finishBlocks(ctx);
}

function longestEdge(p: Poly): [number, number, number, number] {
  const n = p.length / 2;
  let best = -1;
  let e: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = Math.hypot(p[j * 2]! - p[i * 2]!, p[j * 2 + 1]! - p[i * 2 + 1]!);
    if (l > best) {
      best = l;
      e = [p[i * 2]!, p[i * 2 + 1]!, p[j * 2]!, p[j * 2 + 1]!];
    }
  }
  return e;
}

/** Mean building height per block, for the far prisms. */
function finishBlocks(ctx: Context): void {
  const sum = new Float64Array(ctx.blocks.length);
  const area = new Float64Array(ctx.blocks.length);
  for (const b of ctx.buildings) {
    if (b.block < 0) continue;
    const a = 4 * b.halfLength * b.halfWidth;
    sum[b.block]! += (b.height + b.roofHeight * 0.5) * a;
    area[b.block]! += a;
  }
  ctx.blocks.forEach((bl, i) => (bl.height = area[i]! > 0 ? sum[i]! / area[i]! : 0));
}

/** Replaces the building on the parcel nearest (x, y) in `districts` with a landmark building. */
function landmarkOnParcel(
  ctx: Context,
  x: number,
  y: number,
  districts: District[],
  kind: LandmarkKind,
  size: [number, number, number],
  r: Rng,
  taken: Set<number>,
): number {
  let best = -1;
  let bestD = Infinity;
  ctx.parcels.forEach((p, i) => {
    if (taken.has(i)) return;
    const bl = ctx.blocks[p.block]!;
    if (!districts.includes(bl.district) || bl.ground === Ground.Square) return;
    const [cx, cy] = polyCentroid(p.polygon);
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestD && polyArea(p.polygon) > size[0] * size[1] * 1.2) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0) return -1;
  taken.add(best);
  const p = ctx.parcels[best]!;
  const [ax, ay, bx, by] = p.frontage;
  const angle = Math.atan2(by - ay, bx - ax);
  const [cx, cy] = polyCentroid(p.polygon);
  let hl = size[0] / 2;
  let hw = size[1] / 2;
  for (let k = 0; k < 6 && !boxInside(p.polygon, cx, cy, angle, hl, hw); k++) {
    hl *= 0.85;
    hw *= 0.85;
  }
  if (!boxInside(p.polygon, cx, cy, angle, hl, hw)) return -1;
  // The parcel's own building gives way.
  // (Marked, not spliced: indices that landmarks and targets hold stay valid until compaction.)
  ctx.buildings.forEach((b, i) => b.parcel === best && ctx.removed.add(i));
  const li = ctx.addLandmark(
    { kind, x: cx, y: cy, size: Math.max(hl, hw), height: size[2], building: -1 },
    r,
  );
  const bi = ctx.addBuilding(
    {
      kind: BuildingKind.Landmark,
      x: cx,
      y: cy,
      angle,
      halfLength: hl,
      halfWidth: hw,
      height: size[2],
      floors: Math.max(1, Math.round(size[2] / 4)),
      roof: kind === LandmarkKind.TownHall ? Roof.Hip : Roof.Gable,
      roofHeight: hw * 0.9,
      wall: kind === LandmarkKind.TownHall ? 0xe4ddd0 : 0xd8d0c0,
      roofColor: kind === LandmarkKind.TownHall ? 0x6e7275 : 0x5e5e62,
      extras: 0,
    },
    best,
    p.block,
    li,
  );
  ctx.landmarks[li]!.building = bi;
  return li;
}

/** The highest dry point on a lattice within the shares given, off the streets and buildings. */
function highPoint(ctx: Context, lo: number, hi: number, step: number): [number, number] | null {
  const R = meanRadius(ctx);
  const built = new SpatialHash<number>(60);
  ctx.buildings.forEach((b, i) => built.add(b.x, b.y, i));
  let best: [number, number] | null = null;
  let bh = -Infinity;
  for (let y = -R; y <= R; y += step) {
    for (let x = -R; x <= R; x += step) {
      const s = ctx.share(x, y);
      if (s < lo || s > hi || ctx.water(x, y, 10)) continue;
      const h = ctx.ground.height(x, y);
      if (h <= bh) continue;
      if (ctx.streetClearance(x, y) < 12) continue;
      const b = ctx.buildings;
      if (
        built.near(
          x,
          y,
          60,
          (i) =>
            Math.hypot(b[i]!.x - x, b[i]!.y - y) < Math.max(b[i]!.halfLength, b[i]!.halfWidth) + 10,
        )
      )
        continue;
      bh = h;
      best = [x, y];
    }
  }
  return best;
}

function addTownLandmarks(ctx: Context, square: [number, number] | null): void {
  const { input } = ctx;
  const city = input.tier === Tier.City;
  const r = ctx.stream('landmarks');
  const taken = new Set<number>();
  const at = square ?? [0, 0];
  const central = [District.OldCore, District.InnerGrid, District.Terraced, District.Detached];
  const worship = city ? LandmarkKind.Cathedral : LandmarkKind.Church;
  landmarkOnParcel(
    ctx,
    at[0],
    at[1],
    central,
    worship,
    city ? [60, 26, 26] : [36, 16, 18],
    r,
    taken,
  );
  landmarkOnParcel(
    ctx,
    at[0],
    at[1],
    central,
    LandmarkKind.TownHall,
    city ? [36, 24, 16] : [24, 16, 12],
    r,
    taken,
  );
  if (square && city) {
    ctx.addLandmark(
      {
        kind: LandmarkKind.Monument,
        x: square[0],
        y: square[1],
        size: 4,
        height: 14,
        building: -1,
      },
      r,
    );
  } else if (square && (input.style === Style.Mediterranean || input.style === Style.Arid)) {
    ctx.addLandmark(
      { kind: LandmarkKind.Market, x: square[0], y: square[1], size: 6, height: 5, building: -1 },
      r,
    );
  }
  // A TV tower on a city's high ground, a water tower on a town's.
  if (city && (input.style === Style.Western || input.style === Style.Eastern)) {
    const p = highPoint(ctx, 0.2, 0.85, 200);
    if (p)
      ctx.addLandmark(
        {
          kind: LandmarkKind.TvTower,
          x: p[0],
          y: p[1],
          size: 8,
          height: input.style === Style.Eastern ? 220 : 180,
          building: -1,
        },
        r,
      );
  } else if (!city) {
    const p = highPoint(ctx, 0.1, 0.8, 120);
    if (p)
      ctx.addLandmark(
        { kind: LandmarkKind.WaterTower, x: p[0], y: p[1], size: 5, height: 30, building: -1 },
        r,
      );
  }
  // A stadium in a city's largest civic block.
  if (city) {
    let best = -1;
    ctx.blocks.forEach((b, i) => {
      if (b.district !== District.Civic || b.ground === Ground.Square || b.area < 14_000) return;
      if (best < 0 || b.area > ctx.blocks[best]!.area) best = i;
    });
    if (best >= 0) {
      const b = ctx.blocks[best]!;
      const box = minAreaBox(b.polygon);
      const angle = Math.atan2(box.uy, box.ux);
      let hl = Math.min(80, box.hu - 10);
      const hw = Math.min(55, box.hv - 10);
      if (hl > 30 && hw > 20 && boxInside(b.polygon, box.cx, box.cy, angle, hl, hw)) {
        b.ground = Ground.Sports;
        const pi = ctx.parcels.findIndex((p) => p.block === best);
        const li = ctx.addLandmark(
          { kind: LandmarkKind.Stadium, x: box.cx, y: box.cy, size: hl, height: 18, building: -1 },
          r,
        );
        hl = Math.max(hl, hw);
        ctx.landmarks[li]!.building = ctx.addBuilding(
          {
            kind: BuildingKind.Landmark,
            x: box.cx,
            y: box.cy,
            angle,
            halfLength: Math.min(hl, box.hu - 10),
            halfWidth: hw,
            height: 18,
            floors: 4,
            roof: Roof.Flat,
            roofHeight: 0,
            wall: 0xc8c2b6,
            roofColor: 0x6f8a4e,
            extras: 0,
          },
          pi,
          best,
          li,
        );
      }
    }
  }
  // Industry: stacks, power stations, cranes; and the candidate targets.
  const name = input.name;
  let factories = 0;
  let yard = false;
  let port = false;
  let depot = false;
  const byBlock = new Map<number, { x: Building; i: number }[]>();
  ctx.buildings.forEach((x, i) => {
    let l = byBlock.get(x.block);
    if (!l) byBlock.set(x.block, (l = []));
    l.push({ x, i });
  });
  ctx.blocks.forEach((b, bi) => {
    const own = byBlock.get(bi) ?? [];
    if (b.district === District.Industrial) {
      own.sort((p, q) => q.x.halfLength * q.x.halfWidth - p.x.halfLength * p.x.halfWidth);
      const big = own[0];
      if (big && r.nextFloat() < 0.5) {
        const s = boxCorners(
          big.x.x,
          big.x.y,
          big.x.angle,
          big.x.halfLength - 3,
          big.x.halfWidth - 3,
        );
        ctx.addLandmark(
          {
            kind: LandmarkKind.Smokestack,
            x: s[0]!,
            y: s[1]!,
            size: 2.5,
            height: 45 + r.nextFloat() * 35,
            building: big.i,
          },
          r,
        );
      }
      if (big && factories < (city ? 6 : 2)) {
        factories++;
        ctx.targets.push({
          kind: TargetKind.Factory,
          x: big.x.x,
          y: big.x.y,
          footprint: boxCorners(big.x.x, big.x.y, big.x.angle, big.x.halfLength, big.x.halfWidth),
          name: landmarkName(LandmarkKind.Smokestack, name, input.flavor, input.style, r),
        });
      }
      if (city && !depot && ctx.distTo(ctx.lineSets.arterials, ...polyCentroid(b.polygon)) < 300) {
        depot = true;
        const [cx, cy] = polyCentroid(b.polygon);
        ctx.targets.push({
          kind: TargetKind.Depot,
          x: cx,
          y: cy,
          footprint: b.polygon,
          name: `${name} Depot`,
        });
      }
    } else if (b.district === District.RailYard && !yard) {
      yard = true;
      const [cx, cy] = polyCentroid(b.polygon);
      ctx.targets.push({
        kind: TargetKind.RailYard,
        x: cx,
        y: cy,
        footprint: b.polygon,
        name: `${name} Rail Yard`,
      });
    } else if (b.district === District.Port) {
      const [cx, cy] = polyCentroid(b.polygon);
      if (!port) {
        port = true;
        ctx.targets.push({
          kind: TargetKind.Port,
          x: cx,
          y: cy,
          footprint: b.polygon,
          name: `${name} Port`,
        });
      }
      for (const q of own.slice(0, 2)) {
        const c = boxCorners(q.x.x, q.x.y, q.x.angle, q.x.halfLength, q.x.halfWidth + 6);
        const cx2 = (c[0]! + c[2]!) / 2;
        const cy2 = (c[1]! + c[3]!) / 2;
        if (pointInPoly(cx2, cy2, b.polygon))
          ctx.addLandmark(
            { kind: LandmarkKind.Crane, x: cx2, y: cy2, size: 6, height: 35, building: -1 },
            r,
          );
      }
    } else if (b.district === District.Utilities) {
      const box = minAreaBox(b.polygon);
      const angle = Math.atan2(box.uy, box.ux);
      const pi = ctx.parcels.findIndex((p) => p.block === bi);
      const hall: B = {
        kind: BuildingKind.Shed,
        x: box.cx - box.ux * box.hu * 0.35,
        y: box.cy - box.uy * box.hu * 0.35,
        angle,
        halfLength: Math.min(45, box.hu * 0.3),
        halfWidth: Math.min(20, box.hv * 0.4),
        height: 24,
        floors: 1,
        roof: Roof.Flat,
        roofHeight: 0,
        wall: 0xa8a49c,
        roofColor: 0x7a7672,
        extras: 0,
      };
      let hallIndex = -1;
      if (boxInside(b.polygon, hall.x, hall.y, angle, hall.halfLength, hall.halfWidth))
        hallIndex = ctx.addBuilding(hall, pi, bi);
      const tr = Math.min(24, box.hv * 0.4);
      for (const k of [0.25, 0.65]) {
        const x = box.cx + box.ux * box.hu * k;
        const y = box.cy + box.uy * box.hu * k;
        if (tr > 10 && boxInside(b.polygon, x, y, angle, tr, tr)) {
          ctx.addLandmark(
            { kind: LandmarkKind.CoolingTower, x, y, size: tr, height: tr * 2.6, building: -1 },
            r,
          );
        }
      }
      if (hallIndex >= 0) {
        const h = ctx.buildings[hallIndex]!;
        ctx.addLandmark(
          {
            kind: LandmarkKind.Smokestack,
            x: h.x,
            y: h.y,
            size: 3.5,
            height: 110,
            building: hallIndex,
          },
          r,
        );
      }
      const [cx, cy] = polyCentroid(b.polygon);
      ctx.targets.push({
        kind: TargetKind.PowerStation,
        x: cx,
        y: cy,
        footprint: b.polygon,
        name: `${name} Power Station`,
      });
    }
  });
}

function planVillage(ctx: Context): void {
  const { input, palette } = ctx;
  const R = meanRadius(ctx);
  const rs = ctx.stream('streets');
  const streets: { points: number[]; kind: StreetKind }[] = [];
  // The main street: the arterial nearest the center, else a lane along the contour.
  let main: number[] | null = null;
  let bestD = 300;
  for (const a of input.arterials) {
    const d = polylineDist(0, 0, a.points).d;
    if (d < bestD) {
      bestD = d;
      main = a.points;
    }
  }
  const angle0 = (() => {
    const [gx, gy] = ctx.ground.gradient(0, 0);
    return Math.hypot(gx, gy) > 0.02 ? Math.atan2(gy, gx) + Math.PI / 2 : rs.nextFloat() * Math.PI;
  })();
  if (main) {
    for (const a of input.arterials) streets.push({ points: a.points, kind: StreetKind.Arterial });
  } else {
    const c = Math.cos(angle0);
    const s = Math.sin(angle0);
    main = [];
    for (let t = -R; t <= R + 1e-6; t += R / 8) main.push(t * c, t * s);
    streets.push({ points: main, kind: StreetKind.Lane });
  }
  // A green for clustered villages.
  const greenChance =
    input.style === Style.Mediterranean || input.style === Style.Arid
      ? 0.7
      : input.style === Style.Nordic
        ? 0.1
        : 0.35;
  let green: Poly | null = null;
  if (rs.nextFloat() < greenChance) {
    const g = 30 + rs.nextFloat() * 25;
    const n = polylineDist(0, 0, main);
    const ox = -Math.sin(n.angle) * (g + 15);
    const oy = Math.cos(n.angle) * (g + 15);
    const ring: number[] = [];
    green = [];
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * 2 * Math.PI;
      ring.push(ox + (g + 5) * Math.cos(a), oy + (g + 5) * Math.sin(a));
      if (k < 12) green.push(ox + g * Math.cos(a), oy + g * Math.sin(a));
    }
    if (!ctx.water(ox, oy, 20)) streets.push({ points: ring, kind: StreetKind.Lane });
    else green = null;
  }
  // Side lanes.
  const lanes = 1 + Math.floor(R / 250) + Math.floor(rs.nextFloat() * 2);
  const mainLen = polylineLength(main);
  for (let k = 0; k < lanes; k++) {
    const at = (0.15 + 0.7 * rs.nextFloat()) * mainLen;
    // The point and direction at `at` along the main street.
    let acc = 0;
    let px = 0;
    let py = 0;
    let dir = 0;
    for (let i = 0; i + 3 < main.length; i += 2) {
      const L = Math.hypot(main[i + 2]! - main[i]!, main[i + 3]! - main[i + 1]!);
      if (acc + L >= at) {
        const t = (at - acc) / L;
        px = main[i]! + (main[i + 2]! - main[i]!) * t;
        py = main[i + 1]! + (main[i + 3]! - main[i + 1]!) * t;
        dir = Math.atan2(main[i + 3]! - main[i + 1]!, main[i + 2]! - main[i]!);
        break;
      }
      acc += L;
    }
    if (ctx.share(px, py) > 1) continue;
    const side = rs.nextFloat() < 0.5 ? 1 : -1;
    const len = R * (0.4 + 0.5 * rs.nextFloat());
    const a = dir + side * (Math.PI / 2 + (rs.nextFloat() - 0.5) * 0.5);
    const pts: number[] = [px, py];
    for (let t = 20; t <= len; t += 20) {
      const x = px + t * Math.cos(a);
      const y = py + t * Math.sin(a);
      if (ctx.water(x, y, 6) || ctx.share(x, y) > 1.2) break;
      pts.push(x, y);
    }
    if (pts.length >= 6) streets.push({ points: simplify(pts, 1), kind: StreetKind.Lane });
  }
  ctx.addStreets(streets);
  // Strip parcels along the frontage of every street but paths.
  const [w, d] = [VILLAGE_PLOT[input.style]![0], VILLAGE_PLOT[input.style]![1]];
  const frontage = ctx.streets.filter((s) => s.kind <= StreetKind.Lane);
  const strips = stripParcels(
    frontage.map((s) => ({ points: s.points, halfWidth: STREET_HALF_WIDTH[s.kind]! })),
    w,
    d,
    (x, y) =>
      ctx.share(x, y) < 1.15 &&
      !ctx.water(x, y, 2) &&
      ctx.slope(x, y) < 0.35 &&
      !(green && pointInPoly(x, y, green)),
    Math.round(((4 * Math.PI * R * R) / (w * d)) * 0.35) + 20,
  );
  const rb = ctx.stream('buildings');
  const farmShare = input.style === Style.Mediterranean || input.style === Style.Arid ? 0.2 : 0.5;
  // One block per street: the box round its plots.
  const byStreet = new Map<number, number>();
  for (const s of strips) {
    let bi = byStreet.get(s.street);
    if (bi === undefined) {
      bi = ctx.blocks.length;
      byStreet.set(s.street, bi);
      ctx.blocks.push({
        polygon: [],
        district: District.Detached,
        ground: Ground.Garden,
        area: 0,
        height: 0,
        slope: 0,
      });
    }
    const pi = ctx.parcels.length;
    ctx.parcels.push({ polygon: s.polygon, block: bi, frontage: s.frontage });
    for (const b of plotBuildings(s, input.style, palette, rb.nextFloat() < farmShare, rb))
      ctx.addBuilding(b, pi, bi);
  }
  for (const [, bi] of byStreet) {
    const pts: number[] = [];
    ctx.parcels.forEach((p) => p.block === bi && pts.push(...p.polygon));
    const box = minAreaBox(pts);
    const poly = boxCorners(box.cx, box.cy, Math.atan2(box.uy, box.ux), box.hu, box.hv);
    const bl = ctx.blocks[bi]!;
    bl.polygon = poly;
    bl.area = polyArea(poly);
    bl.slope = ctx.slope(box.cx, box.cy);
  }
  if (green) {
    ctx.blocks.push({
      polygon: green,
      district: District.Civic,
      ground: Ground.Park,
      area: polyArea(green),
      height: 0,
      slope: 0,
    });
  }
  // A church by the green or the middle of the main street; a water tower in some.
  const r = ctx.stream('landmarks');
  const at = green ? polyCentroid(green) : [0, 0];
  if (input.style !== Style.Arid || r.nextFloat() < 0.5) {
    landmarkOnParcel(
      ctx,
      at[0]!,
      at[1]!,
      [District.Detached],
      LandmarkKind.Church,
      [24, 11, 12],
      r,
      new Set(),
    );
  }
  if (input.style === Style.Eastern && r.nextFloat() < 0.4) {
    const p = highPoint(ctx, 0.2, 1, 80);
    if (p)
      ctx.addLandmark(
        { kind: LandmarkKind.WaterTower, x: p[0], y: p[1], size: 4, height: 25, building: -1 },
        r,
      );
  }
  finishBlocks(ctx);
}

/** Farmsteads on the farmland round a village or town, at field corners. */
function addFarmsteads(ctx: Context): void {
  const { input, palette, frame } = ctx;
  const R = meanRadius(ctx);
  const r = ctx.stream('farmsteads');
  const n =
    input.tier === Tier.Town
      ? 3 + Math.floor(r.nextFloat() * 5)
      : 2 + Math.floor(r.nextFloat() * 4);
  const Rp = frame.radius;
  const toSea = (x: number, y: number): [number, number, number] => {
    const d = frame.toSphere(x, y);
    return [d[0] * Rp, d[1] * Rp, d[2] * Rp];
  };
  const placed: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = r.nextFloat() * 2 * Math.PI;
    const dist = R * (1.25 + r.nextFloat()) + 150;
    const x0 = dist * Math.cos(a);
    const y0 = dist * Math.sin(a);
    const corner = fieldCorner(x0, y0, 120, toSea, ctx.opts.fieldSeed!);
    if (!corner) continue;
    const { x, y } = corner;
    if (ctx.water(x, y, 40) || ctx.slope(x, y) > 0.2) continue;
    if (placed.some(([px, py]) => Math.hypot(px - x, py - y) < 300)) continue;
    if (ctx.streetClearance(x, y) < 35) continue;
    placed.push([x, y]);
    // The yard is its own block and parcel.
    const bi = ctx.blocks.length;
    const yard = boxCorners(x, y, corner.angle, 30, 34);
    ctx.blocks.push({
      polygon: yard,
      district: District.Detached,
      ground: Ground.Gravel,
      area: polyArea(yard),
      height: 0,
      slope: ctx.slope(x, y),
    });
    const pi = ctx.parcels.length;
    ctx.parcels.push({
      polygon: yard,
      block: bi,
      frontage: [yard[0]!, yard[1]!, yard[2]!, yard[3]!],
    });
    for (const b of farmstead(x, y, corner.angle, palette, input.style, r))
      ctx.addBuilding(b, pi, bi);
  }
}

/**
 * Drops the buildings marked removed and renumbers what refers to buildings: landmarks
 * and targets (decision 279).
 */
function compact(ctx: Context): void {
  if (ctx.removed.size === 0) return;
  const map = new Int32Array(ctx.buildings.length).fill(-1);
  const kept: Building[] = [];
  ctx.buildings.forEach((b, i) => {
    if (ctx.removed.has(i)) return;
    map[i] = kept.length;
    kept.push(b);
  });
  ctx.buildings.length = 0;
  ctx.buildings.push(...kept);
  for (const l of ctx.landmarks) if (l.building >= 0) l.building = map[l.building]!;
  for (const t of ctx.targets)
    if (t.buildings) t.buildings = t.buildings.map((b) => map[b]!).filter((b) => b >= 0);
  ctx.removed.clear();
}

/** What each site kind wants: preferred districts, its target kind, the size of a compound (m). */
const SITE_RULES: Record<
  SiteAnchor['kind'],
  { districts: District[]; target: TargetKind; size: [number, number]; ground: Ground }
> = {
  works: {
    districts: [District.Industrial],
    target: TargetKind.Factory,
    size: [260, 160],
    ground: Ground.Concrete,
  },
  power: {
    districts: [District.Utilities, District.Industrial],
    target: TargetKind.PowerStation,
    size: [320, 220],
    ground: Ground.Gravel,
  },
  refinery: {
    districts: [District.Industrial],
    target: TargetKind.Refinery,
    size: [420, 260],
    ground: Ground.Gravel,
  },
  'rail-yard': {
    districts: [District.RailYard, District.Industrial],
    target: TargetKind.RailYard,
    size: [600, 110],
    ground: Ground.Ballast,
  },
  depot: {
    districts: [District.Industrial],
    target: TargetKind.Depot,
    size: [220, 150],
    ground: Ground.Concrete,
  },
  'fuel-depot': {
    districts: [District.Industrial],
    target: TargetKind.FuelDepot,
    size: [200, 160],
    ground: Ground.Gravel,
  },
};

/**
 * Realizes the caller's sites (decision 279): each takes an unused block of its preferred
 * district (the nearest to rail for rail yards, to an arterial for depots, the largest
 * otherwise), else a compound of its own just outside the extent along a road. Refineries
 * and fuel depots refill their block with tanks, power stations gain cooling towers where
 * they lack them. Each becomes a candidate target carrying the site's id and its buildings,
 * in place of any target the plan had made of that block.
 */
function placeAnchors(ctx: Context): void {
  const anchors = ctx.input.anchors ?? [];
  if (anchors.length === 0) return;
  const r = ctx.stream('sites');
  const used = new Set<number>();
  for (const a of anchors) {
    const rule = SITE_RULES[a.kind];
    let best = -1;
    let score = Infinity;
    for (const d of rule.districts) {
      ctx.blocks.forEach((b, i) => {
        if (used.has(i) || b.district !== d || b.area < 4000) return;
        const [cx, cy] = polyCentroid(b.polygon);
        const s =
          a.kind === 'rail-yard'
            ? ctx.distTo(ctx.lineSets.rails, cx, cy)
            : a.kind === 'depot'
              ? ctx.distTo(ctx.lineSets.arterials, cx, cy)
              : -b.area;
        if (s < score) {
          score = s;
          best = i;
        }
      });
      if (best >= 0) break;
    }
    if (best < 0) best = siteCompound(ctx, rule.size, a.kind, rule.ground, r);
    if (best < 0) continue;
    used.add(best);
    const block = ctx.blocks[best]!;
    if (
      a.kind === 'refinery' ||
      a.kind === 'fuel-depot' ||
      !ctx.buildings.some((b, i) => b.block === best && !ctx.removed.has(i))
    )
      fillSite(ctx, best, a.kind, r);
    else if (
      a.kind === 'power' &&
      !ctx.landmarks.some(
        (l) => l.kind === LandmarkKind.CoolingTower && pointInPoly(l.x, l.y, block.polygon),
      )
    )
      addCoolingTowers(ctx, best, r);
    const [cx, cy] = polyCentroid(block.polygon);
    // The site replaces whatever target the plan made of its block.
    for (let t = ctx.targets.length - 1; t >= 0; t--) {
      const tg = ctx.targets[t]!;
      if (
        tg.anchor === undefined &&
        tg.kind !== TargetKind.Bridge &&
        pointInPoly(tg.x, tg.y, block.polygon)
      )
        ctx.targets.splice(t, 1);
    }
    const buildings: number[] = [];
    ctx.buildings.forEach((b, i) => b.block === best && !ctx.removed.has(i) && buildings.push(i));
    ctx.targets.push({
      kind: rule.target,
      x: cx,
      y: cy,
      footprint: block.polygon,
      name: a.name,
      anchor: a.id,
      buildings,
    });
  }
}

/** A compound block just outside the extent, along a road where one leaves; its index or −1. */
function siteCompound(
  ctx: Context,
  size: [number, number],
  kind: SiteAnchor['kind'],
  ground: Ground,
  r: Rng,
): number {
  const base = r.nextFloat() * 2 * Math.PI;
  for (let k = 0; k < 16; k++) {
    const theta = base + (k * 2 * Math.PI) / 16;
    const d = ctx.extent(theta) + size[1] / 2 + 80;
    const x = d * Math.cos(theta);
    const y = d * Math.sin(theta);
    // Turned to the nearest road, else across the bearing.
    const road = ctx.lineSets.arterials.nearest(x, y, 600);
    const angle = road.d < 600 ? road.angle : theta + Math.PI / 2;
    const poly = boxCorners(x, y, angle, size[0] / 2, size[1] / 2);
    let ok = ctx.slope(x, y) < 0.12;
    for (let i = 0; i < 4 && ok; i++) {
      const px = poly[i * 2]!;
      const py = poly[i * 2 + 1]!;
      ok = !ctx.water(px, py, 10) && ctx.streetClearance(px, py) > 6 && ctx.slope(px, py) < 0.2;
    }
    if (ok && ctx.water(x, y, 10)) ok = false;
    if (!ok) continue;
    const bi = ctx.blocks.length;
    ctx.blocks.push({
      polygon: poly,
      district:
        kind === 'rail-yard'
          ? District.RailYard
          : kind === 'power'
            ? District.Utilities
            : District.Industrial,
      ground,
      area: polyArea(poly),
      height: 0,
      slope: ctx.slope(x, y),
    });
    ctx.parcels.push({
      polygon: poly,
      block: bi,
      frontage: [poly[0]!, poly[1]!, poly[2]!, poly[3]!],
    });
    return bi;
  }
  return -1;
}

/** Fills a site's block with its kind's structures, the block's own buildings giving way. */
function fillSite(ctx: Context, bi: number, kind: SiteAnchor['kind'], r: Rng): void {
  const block = ctx.blocks[bi]!;
  ctx.buildings.forEach((b, i) => b.block === bi && ctx.removed.add(i));
  for (const l of ctx.landmarks)
    if (l.building >= 0 && ctx.removed.has(l.building)) l.building = -1;
  const box = minAreaBox(block.polygon);
  const angle = Math.atan2(box.uy, box.ux);
  // One parcel over the whole block, so the site's structures stand inside their parcel.
  const pi = ctx.parcels.length;
  ctx.parcels.push({ polygon: block.polygon, block: bi, frontage: longestEdge(block.polygon) });
  const at = (u: number, v: number): [number, number] => [
    box.cx + box.ux * u - box.uy * v,
    box.cy + box.uy * u + box.ux * v,
  ];
  const shed = (u: number, v: number, hl: number, hw: number, h: number, warehouse = false) => {
    const [x, y] = at(u, v);
    if (!boxInside(block.polygon, x, y, angle, hl, hw)) return -1;
    return ctx.addBuilding(
      {
        kind: warehouse ? BuildingKind.Warehouse : BuildingKind.Shed,
        x,
        y,
        angle,
        halfLength: hl,
        halfWidth: hw,
        height: h,
        floors: 1,
        roof: Roof.Flat,
        roofHeight: 0,
        wall: 0xa8a49c,
        roofColor: 0x7a7672,
        extras: 0,
      },
      pi,
      bi,
    );
  };
  if (kind === 'refinery' || kind === 'fuel-depot') {
    // Tanks in rows, a control shed, and for a refinery flare stacks.
    const tank = kind === 'refinery' ? 14 : 10;
    const step = tank * 2.8;
    for (let u = -box.hu + step; u <= box.hu - step; u += step) {
      for (let v = -box.hv + step; v <= box.hv - step * 0.8; v += step) {
        const [x, y] = at(u, v);
        if (!boxInside(block.polygon, x, y, angle, tank, tank) || ctx.water(x, y, 2)) continue;
        ctx.addLandmark(
          { kind: LandmarkKind.Tank, x, y, size: tank, height: tank * 1.1, building: -1 },
          r,
        );
      }
    }
    const control = shed(0, box.hv - 14, 14, 7, 6);
    if (kind === 'refinery') {
      const [x, y] = at(-box.hu * 0.6, box.hv * 0.6);
      if (pointInPoly(x, y, block.polygon))
        ctx.addLandmark(
          { kind: LandmarkKind.Smokestack, x, y, size: 2, height: 55, building: control },
          r,
        );
    }
    return;
  }
  if (kind === 'rail-yard') {
    shed(0, box.hv * 0.4, box.hu * 0.4, 12, 8);
    shed(-box.hu * 0.5, -box.hv * 0.3, box.hu * 0.2, 9, 7, true);
    return;
  }
  // Works, depots and power stations: halls in a row, a stack for works.
  const halls = kind === 'depot' ? 3 : 2;
  for (let k = 0; k < halls; k++) {
    const u = -box.hu + ((k + 0.5) * 2 * box.hu) / halls;
    const b = shed(
      u,
      0,
      (box.hu / halls) * 0.75,
      box.hv * 0.55,
      kind === 'depot' ? 9 : 12,
      kind === 'depot',
    );
    if (k === 0 && kind === 'works' && b >= 0) {
      const h = ctx.buildings[b]!;
      ctx.addLandmark(
        { kind: LandmarkKind.Smokestack, x: h.x, y: h.y, size: 2.5, height: 60, building: b },
        r,
      );
    }
  }
  if (kind === 'power') addCoolingTowers(ctx, bi, r);
}

function addCoolingTowers(ctx: Context, bi: number, r: Rng): void {
  const block = ctx.blocks[bi]!;
  const box = minAreaBox(block.polygon);
  const angle = Math.atan2(box.uy, box.ux);
  const tr = Math.min(24, box.hv * 0.4);
  for (const k of [0.3, 0.7]) {
    const x = box.cx + box.ux * box.hu * k;
    const y = box.cy + box.uy * box.hu * k;
    if (
      tr > 10 &&
      boxInside(block.polygon, x, y, angle, tr, tr) &&
      !ctx.buildings.some(
        (b, i) =>
          !ctx.removed.has(i) &&
          b.block === bi &&
          Math.hypot(b.x - x, b.y - y) < tr + Math.max(b.halfLength, b.halfWidth),
      )
    )
      ctx.addLandmark(
        { kind: LandmarkKind.CoolingTower, x, y, size: tr, height: tr * 2.6, building: -1 },
        r,
      );
  }
}

/** Footprint (m²) from which a structure is large enough for a pad. */
const PAD_AREA = 1500;
/** Ground relief under a footprint (m) from which it gets a pad rather than a plinth alone. */
const PAD_RELIEF = 3;

/**
 * Pads (decision 264): large sheds, warehouses, halls and landmarks whose footprint spans
 * more than PAD_RELIEF m of ground get a level platform at the mean of their corners.
 */
function largePads(ctx: Context): Pad[] {
  const out: Pad[] = [];
  ctx.buildings.forEach((b, i) => {
    if (4 * b.halfLength * b.halfWidth < PAD_AREA) return;
    const c = boxCorners(b.x, b.y, b.angle, b.halfLength, b.halfWidth);
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const h = ctx.ground.height(c[k * 2]!, c[k * 2 + 1]!);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
    }
    if (hi - lo < PAD_RELIEF) return;
    out.push({
      x: b.x,
      y: b.y,
      angle: b.angle,
      halfLength: b.halfLength + 6,
      halfWidth: b.halfWidth + 6,
      height: sum / 4,
      building: i,
    });
  });
  return out;
}

/** Bridges: where an arterial crosses a river inside the extent. */
function addBridges(ctx: Context): void {
  const { input } = ctx;
  let n = 0;
  for (const a of input.arterials) {
    for (const rv of input.rivers) {
      const p = a.points;
      const q = rv.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        for (let j = 0; j + 3 < q.length; j += 2) {
          const hit = segIntersect(
            p[i]!,
            p[i + 1]!,
            p[i + 2]!,
            p[i + 3]!,
            q[j]!,
            q[j + 1]!,
            q[j + 2]!,
            q[j + 3]!,
          );
          if (!hit) continue;
          const x = p[i]! + (p[i + 2]! - p[i]!) * hit[0];
          const y = p[i + 1]! + (p[i + 3]! - p[i + 1]!) * hit[0];
          if (ctx.share(x, y) > 1.1) continue;
          const angle = Math.atan2(p[i + 3]! - p[i + 1]!, p[i + 2]! - p[i]!);
          ctx.targets.push({
            kind: TargetKind.Bridge,
            x,
            y,
            footprint: boxCorners(x, y, angle, rv.halfWidth + 15, STREET_HALF_WIDTH[0]! + 2),
            name: `${input.name} Bridge${n ? ` ${n + 1}` : ''}`,
          });
          n++;
        }
      }
    }
  }
}
