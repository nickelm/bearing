/**
 * Stage: terrain provinces (proposal 0007, decision 204).
 *
 * Tectonic history the plates alone do not keep: each boundary run (a
 * connected stretch of one boundary type) is young or old, old continental
 * plates carry fossil sutures, and a few hotspots leave chains along their
 * plate's motion. From these, every cell gets a terrain province: the
 * landform layer's coarsest unit, which sets the uplift profile, the rock and
 * which landforms the tiles carve.
 *
 * The first nine provinces come from tectonics here, before uplift. Karst
 * platform and soft sediment are carved out of sedimentary basins by the
 * lithology stage, and glaciated lowland is written there after climate
 * (`lithology.ts`). Everything draws from `rng(seed, "provinces")`, so plates,
 * crust and boundaries are unchanged.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { KM } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { BoundaryType } from './boundaries';
import type { Boundaries } from './boundaries';
import { distanceFromSources } from './fields';
import type { DistanceField } from './fields';
import type { Plate } from './plates';
import { plateVelocity } from './plates';
import { CHARACTER_EFFECTS, effectAt } from './characters';
import type { Character } from './characters';

/** Continents and their characters (decision 209). */
export interface CharacterMap {
  label: Int32Array;
  character: readonly Character[];
}

const MAX_RIFT_FACTOR = Math.max(...CHARACTER_EFFECTS.map((e) => e.riftExtension));

/** A continental cell at or next to `c`, for a boundary cell on the ocean side. */
function continentCellNear(grid: CubeGrid, c: number, map: CharacterMap | undefined): number {
  if (!map || map.label[c]! >= 0) return c;
  for (let k = 0; k < 8; k++) {
    const nb = grid.neighbors8[c * 8 + k]!;
    if (nb >= 0 && map.label[nb]! >= 0) return nb;
  }
  return c;
}

export const Province = {
  /** Ocean floor away from arcs and hotspots. */
  None: 0,
  /** Active continental collision: the highest, sharpest ranges. */
  YoungCollision: 1,
  /** High, flat land behind a collision zone. */
  HighPlateau: 2,
  /** Worn-down ranges of an ancient collision or a fossil suture. */
  OldMountains: 3,
  /** Ancient continental core: low, scoured, lake-strewn. */
  Shield: 4,
  /** Continental extension: parallel fault-block ranges and flat basins. */
  BasinAndRange: 5,
  /** Active rifting: grabens, escarpments, volcanoes. */
  Rift: 6,
  /** Subduction: chains of stratovolcanoes. */
  VolcanicArc: 7,
  /** Mantle plume: shield volcanoes and island chains. */
  Hotspot: 8,
  /** Subsidence: plains, and in dry climates plateaus with mesas and canyons. */
  SedimentaryBasin: 9,
  /** Limestone: sinkholes, gorges, tower karst in the wet tropics. */
  KarstPlatform: 10,
  /** Loess or weak deposits: gullies and badlands. */
  SoftSediment: 11,
  /** Ground the ice sheets left: moraines, drumlins, lakes, fjords. */
  GlaciatedLowland: 12,
} as const;
export type Province = (typeof Province)[keyof typeof Province];
export const PROVINCE_COUNT = 13;

export const PROVINCE_NAMES: readonly string[] = [
  'none',
  'young collision range',
  'high plateau',
  'old mountains',
  'shield',
  'basin and range',
  'rift',
  'volcanic arc',
  'hotspot',
  'sedimentary basin',
  'karst platform',
  'soft sediment',
  'glaciated lowland',
];

/** One volcano of a hotspot chain: the plume itself (age 0) or an older edifice carried away from it. */
export interface HotspotSite {
  /** Unit direction of the edifice's center. */
  dir: [number, number, number];
  /** 0 at the plume, rising along the chain. */
  age: number;
  /** Relative size, 0..1; older edifices have subsided. */
  strength: number;
  /** Radius of the shield (m). */
  radius: number;
}

export interface ProvinceMap {
  /** `Province` per cell. */
  province: Uint8Array;
  /** Per cell: 0 for no boundary nearby, 1 young, 2 old (the age of the nearest convergent or rift run). */
  boundaryAge: Uint8Array;
  hotspots: HotspotSite[];
}

/** Tuning, in surface meters on the planet (regional extents, decision 205). */
export const PROVINCE_TUNING = {
  /** Chance a convergent or rift run is young, at no strength and at saturation. */
  youngChance: [0.3, 0.85] as [number, number],
  /** Strength at which a run counts as saturated. */
  strengthSaturation: 1.2,
  /** Chance a young collision run has a high plateau behind it. */
  plateauChance: 0.4,
  /** Chance a cordillera run has back-arc extension (basin and range) behind it. */
  backArcChance: 0.25,
  /** Province half-widths around their boundaries. */
  collisionWidth: 110 * KM,
  arcWidth: 65 * KM,
  riftWidth: 55 * KM,
  /** High plateaus lie this far behind young collisions (from, to). */
  plateauBand: [120 * KM, 300 * KM] as [number, number],
  /** Extension reaches this far from a rift, and this band behind a cordillera. */
  riftExtension: 140 * KM,
  backArcBand: [130 * KM, 240 * KM] as [number, number],
  /** Shields lie at least this far from any active boundary. */
  shieldDistance: 250 * KM,
  /** Chance an old continental plate carries a fossil suture. */
  sutureChance: 0.65,
  sutureLength: [250 * KM, 600 * KM] as [number, number],
  sutureWidth: 55 * KM,
  /** Hotspots per world (inclusive). */
  hotspotCount: [3, 8] as [number, number],
  /** Edifices per chain (inclusive) and their spacing along the plate's motion. */
  chainLength: [2, 5] as [number, number],
  chainSpacing: 70 * KM,
  hotspotRadius: 35 * KM,
};

const CONVERGENT_OR_RIFT: ReadonlySet<number> = new Set([
  BoundaryType.Collision,
  BoundaryType.Cordillera,
  BoundaryType.IslandArc,
  BoundaryType.Rift,
]);

interface Run {
  type: number;
  young: boolean;
  plateau: boolean;
  backArc: boolean;
}

/** Labels connected runs of one boundary type over 8-neighbors; ids in order of first cell. */
function labelRuns(
  grid: CubeGrid,
  type: Uint8Array,
): { run: Int32Array; count: number; firstCell: number[] } {
  const n = grid.cellCount;
  const run = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const firstCell: number[] = [];
  for (let s = 0; s < n; s++) {
    const t = type[s]!;
    if (!CONVERGENT_OR_RIFT.has(t) || run[s]! >= 0) continue;
    const id = firstCell.length;
    firstCell.push(s);
    run[s] = id;
    let sp = 0;
    stack[sp++] = s;
    while (sp > 0) {
      const c = stack[--sp]!;
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb < 0 || run[nb]! >= 0 || type[nb] !== t) continue;
        run[nb] = id;
        stack[sp++] = nb;
      }
    }
  }
  return { run, count: firstCell.length, firstCell };
}

function randomDirection(r: Rng, out: Vec3d): Vec3d {
  for (;;) {
    const x = r.range(-1, 1);
    const y = r.range(-1, 1);
    const z = r.range(-1, 1);
    const l2 = x * x + y * y + z * z;
    if (l2 > 1e-4 && l2 <= 1) return out.set(x, y, z).scale(1 / Math.sqrt(l2));
  }
}

/** Rotates unit `x` by `angle` toward unit tangent `t` (great circle). */
function along(x: Readonly<Vec3d>, t: Readonly<Vec3d>, angle: number, out: Vec3d): Vec3d {
  return out.copy(x).scale(Math.cos(angle)).addScaled(t, Math.sin(angle));
}

export function assignProvinces(
  grid: CubeGrid,
  radius: number,
  plates: readonly Plate[],
  plate: Uint8Array,
  continentalness: Float32Array,
  boundaries: Boundaries,
  r: Rng,
  characters?: CharacterMap,
): ProvinceMap {
  const T = PROVINCE_TUNING;
  const n = grid.cellCount;
  const ages = r.fork('ages');
  const sutureRng = r.fork('sutures');
  const hotRng = r.fork('hotspots');
  const noise = new Noise3(r.fork('noise'));

  // Runs and their histories, drawn in run order with a fixed number of draws each.
  const { run, count, firstCell } = labelRuns(grid, boundaries.type);
  const strengthSum = new Float64Array(count);
  const cells = new Int32Array(count);
  for (let c = 0; c < n; c++) {
    const id = run[c]!;
    if (id < 0) continue;
    strengthSum[id] += boundaries.strength[c]!;
    cells[id]++;
  }
  const runs: Run[] = [];
  for (let id = 0; id < count; id++) {
    const s = Math.min(1, strengthSum[id]! / cells[id]! / T.strengthSaturation);
    // The character of the continent the run touches biases its history (decision 209).
    const fx = effectAt(characters, continentCellNear(grid, firstCell[id]!, characters));
    const pYoung = Math.max(
      fx.youngFloor,
      fx.youngFactor * (T.youngChance[0] + (T.youngChance[1] - T.youngChance[0]) * s),
    );
    const a = ages.nextFloat();
    const b = ages.nextFloat();
    const d = ages.nextFloat();
    runs.push({
      type: boundaries.type[firstCell[id]!]!,
      young: a < pYoung,
      plateau: b < (fx.plateauChance ?? T.plateauChance),
      backArc: d < (fx.backArcChance ?? T.backArcChance),
    });
  }

  const src = (pred: (run: Run) => boolean): Uint8Array => {
    const out = new Uint8Array(n);
    for (let c = 0; c < n; c++) {
      const id = run[c]!;
      if (id >= 0 && pred(runs[id]!)) out[c] = 1;
    }
    return out;
  };
  const field = (s: Uint8Array, reach: number) => distanceFromSources(grid, s, reach / radius);
  const youngColl = field(
    src((u) => u.type === BoundaryType.Collision && u.young),
    1.3 * T.collisionWidth,
  );
  const oldColl = field(
    src(
      (u) => (u.type === BoundaryType.Collision || u.type === BoundaryType.Cordillera) && !u.young,
    ),
    1.3 * T.collisionWidth,
  );
  const arc = field(
    src(
      (u) => (u.type === BoundaryType.Cordillera || u.type === BoundaryType.IslandArc) && u.young,
    ),
    1.2 * T.arcWidth,
  );
  const rift = field(
    src((u) => u.type === BoundaryType.Rift),
    T.riftExtension * MAX_RIFT_FACTOR,
  );
  const plateau = field(
    src((u) => u.type === BoundaryType.Collision && u.young && u.plateau),
    T.plateauBand[1],
  );
  const backArc = field(
    src((u) => u.type === BoundaryType.Cordillera && u.backArc),
    T.backArcBand[1],
  );
  const active = field(
    src(() => true),
    T.shieldDistance,
  );

  // Fossil sutures in continental plates: great-circle arcs through their interior.
  const sutureSrc = new Uint8Array(n);
  const x = new Vec3d();
  const t = new Vec3d();
  const p = new Vec3d();
  for (const pl of plates) {
    const roll = sutureRng.nextFloat();
    const pick = sutureRng.nextFloat();
    const lenT = sutureRng.nextFloat();
    randomDirection(sutureRng, t);
    if (!pl.continental || roll >= T.sutureChance) continue;
    const interior: number[] = [];
    for (let c = 0; c < n; c++)
      if (plate[c] === pl.id && continentalness[c]! > 0.25) interior.push(c);
    if (interior.length === 0) continue;
    grid.center(interior[Math.floor(pick * interior.length)]!, x);
    // Tangent at x: remove the radial part of the random direction.
    t.addScaled(x, -t.dot(x));
    if (t.length() < 1e-6) continue;
    t.normalize();
    const len = T.sutureLength[0] + (T.sutureLength[1] - T.sutureLength[0]) * lenT;
    // A wandering path both ways from the start: the heading turns a little every step.
    const step = 10 * KM;
    const steps = Math.max(2, Math.ceil(len / (2 * step)));
    for (const dir of [1, -1]) {
      p.copy(x);
      const h = new Vec3d().copy(t).scale(dir);
      for (let k = 0; k < steps; k++) {
        const c = grid.cellOfDirection(p);
        if (plate[c] === pl.id && continentalness[c]! > 0) sutureSrc[c] = 1;
        // Turn by up to about ±12° per step, from noise along the path.
        const turn = 0.21 * noise.noise(p.x * 9 + dir * 3.1, p.y * 9, p.z * 9 + pl.id);
        const side = new Vec3d().copy(p).cross(h);
        h.scale(Math.cos(turn)).addScaled(side, Math.sin(turn));
        const next = along(p, h, step / radius, new Vec3d()).normalize();
        // Keep the heading tangent at the new point.
        h.addScaled(next, -h.dot(next)).normalize();
        p.copy(next);
      }
    }
  }
  const suture = field(sutureSrc, T.sutureWidth * 1.4);

  // Hotspots and their chains along the plate's motion.
  const hotspots: HotspotSite[] = [];
  const nHot = T.hotspotCount[0] + hotRng.int(T.hotspotCount[1] - T.hotspotCount[0] + 1);
  const v = new Vec3d();
  for (let h = 0; h < nHot; h++) {
    randomDirection(hotRng, x);
    const strength = hotRng.range(0.6, 1);
    const chain = T.chainLength[0] + hotRng.int(T.chainLength[1] - T.chainLength[0] + 1);
    const pl = plates[plate[grid.cellOfDirection(x)]!];
    if (!pl) continue;
    plateVelocity(pl, x, v);
    v.addScaled(x, -v.dot(x));
    const moving = v.length() > 1e-9;
    if (moving) v.normalize();
    for (let k = 0; k < chain; k++) {
      if (k > 0 && !moving) break;
      along(x, v, (k * T.chainSpacing) / radius, p);
      hotspots.push({
        dir: [p.x, p.y, p.z],
        age: k,
        strength: strength * Math.pow(0.72, k),
        radius: T.hotspotRadius * (1 - 0.1 * k),
      });
    }
  }
  const hotSrc = new Uint8Array(n);
  for (const s of hotspots) hotSrc[grid.cellOfDirection(p.set(s.dir[0], s.dir[1], s.dir[2]))] = 1;
  const hot = field(hotSrc, T.hotspotRadius);

  const province = new Uint8Array(n);
  const boundaryAge = new Uint8Array(n);
  const R = radius;
  for (let c = 0; c < n; c++) {
    grid.center(c, x);
    // Ragged province edges: ±25% of each width.
    const wob = 1 + 0.25 * noise.fbm(x.x * 14, x.y * 14, x.z * 14, 3);
    const continental = continentalness[c]! > 0;
    const dist = (f: DistanceField) => f.angle[c]! * R;
    const fx = effectAt(characters, c);
    const nearRun = active.nearest[c]!;
    if (nearRun >= 0 && active.angle[c]! * R < 1.3 * T.collisionWidth) {
      const id = run[nearRun]!;
      if (id >= 0) boundaryAge[c] = runs[id]!.young ? 1 : 2;
    }
    let pv: Province = Province.None;
    if (dist(youngColl) < T.collisionWidth * wob) pv = Province.YoungCollision;
    else if (dist(arc) < T.arcWidth * wob) pv = Province.VolcanicArc;
    else if (continental && dist(rift) < T.riftWidth * wob) pv = Province.Rift;
    else if (dist(hot) < T.hotspotRadius) pv = Province.Hotspot;
    else if (continental) {
      const pd = dist(plateau);
      const bd = dist(backArc);
      if (pd >= T.plateauBand[0] * wob && pd < T.plateauBand[1] * wob) pv = Province.HighPlateau;
      else if (dist(oldColl) < T.collisionWidth * wob || dist(suture) < T.sutureWidth * wob)
        pv = Province.OldMountains;
      else if (
        dist(rift) < T.riftExtension * fx.riftExtension * wob ||
        (bd >= T.backArcBand[0] * wob && bd < T.backArcBand[1] * wob)
      )
        pv = Province.BasinAndRange;
      else if (
        dist(active) >= T.shieldDistance * fx.shieldDistance * wob &&
        noise.noise(x.x * 4, x.y * 4, x.z * 4) > -0.25
      )
        pv = Province.Shield;
      else pv = Province.SedimentaryBasin;
    }
    province[c] = pv;
  }
  return { province, boundaryAge, hotspots };
}
