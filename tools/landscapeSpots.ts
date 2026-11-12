/**
 * Landscape spots: places in a generated world that should show a particular
 * kind of landscape, found by scanning the global grid, with an observer pose
 * (spot, facing, eye height, pitch) that looks at it. Used by
 * `tools/render.preview.ts` (SPOTS=…) to judge terrain from the observer camera.
 *
 * Archetypes and their Earth references:
 *   canyon     arid upland with deep relief (Grand Canyon)
 *   buttes     arid lowland or plateau with little relief (Monument Valley)
 *   peaks      the highest ground (Everest, the Himalaya)
 *   glacial    cold mountains with deep valleys (northern Sweden, the Alps)
 *   lake       the deepest lake in cold mountains (Lake Como)
 *   skerries   a cold, low coast (the Stockholm archipelago)
 *   delta      the mouth of the largest river in a dry climate (the Nile delta)
 *   jungle     the largest river in tropical rainforest (the Amazon)
 *   falls      a river dropping steeply across a step (Niagara)
 */
import { directionToCubeFace } from '../src/core/coords';
import { Vec3d } from '../src/core/vec3d';
import { Biome } from '../src/worldgen/biomes';
import type { GlobalWorld } from '../src/worldgen/globalPipeline';
import { cellCenterDirection } from '../src/worldgen/rivers';

export const SPOT_KINDS = [
  'canyon',
  'buttes',
  'peaks',
  'glacial',
  'lake',
  'skerries',
  'delta',
  'jungle',
  'falls',
] as const;
export type SpotKind = (typeof SPOT_KINDS)[number];

export interface LandscapeSpot {
  kind: SpotKind;
  /** Unit direction the observer stands over. */
  point: Vec3d;
  /** Compass heading (rad, clockwise from north). */
  facing: number;
  /** Eye height above the ground (m). */
  height: number;
  /** Pitch (rad, negative looks down). */
  pitch: number;
  /** Why it was chosen, for the log. */
  note: string;
}

const ARID: ReadonlySet<number> = new Set([Biome.HotDesert, Biome.ColdDesert, Biome.Shrubland]);
const COLD: ReadonlySet<number> = new Set([
  Biome.Taiga,
  Biome.Tundra,
  Biome.Alpine,
  Biome.IceSheet,
]);

/** Samplers on a global world's maps (nearest cell). */
export class WorldSampler {
  readonly n: number;
  private readonly uv = { face: 0, u: 0, v: 0 } as ReturnType<typeof directionToCubeFace>;
  constructor(
    readonly g: GlobalWorld,
    readonly radius: number,
    /** Height at a direction (e.g. from synthesized tiles); the global grid when absent. */
    private readonly heightFn?: (d: Readonly<Vec3d>) => number,
  ) {
    this.n = g.n;
  }
  cell(d: Readonly<Vec3d>): number {
    const p = directionToCubeFace(d, this.uv);
    const n = this.n;
    const i = Math.min(n - 1, Math.max(0, Math.floor(p.u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(p.v * n)));
    return (p.face * n + j) * n + i;
  }
  height(d: Readonly<Vec3d>): number {
    return this.heightFn ? this.heightFn(d) : this.g.height[this.cell(d)]!;
  }
  /** The point `dist` m from `p` toward compass heading `heading`. */
  offset(p: Readonly<Vec3d>, heading: number, dist: number, out = new Vec3d()): Vec3d {
    const east = new Vec3d(0, 1, 0).cross(p).normalize();
    const north = p.clone().cross(east);
    const a = dist / this.radius;
    return out
      .copy(p)
      .scale(Math.cos(a))
      .addScaled(east, Math.sin(a) * Math.sin(heading))
      .addScaled(north, Math.sin(a) * Math.cos(heading))
      .normalize();
  }
  /** Max − min height on rings at the given distances (8 directions each), and the center. */
  relief(p: Readonly<Vec3d>, dists: number[]): number {
    let lo = this.height(p);
    let hi = lo;
    const q = new Vec3d();
    for (const r of dists) {
      for (let k = 0; k < 8; k++) {
        const h = this.height(this.offset(p, (k * Math.PI) / 4, r, q));
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    return hi - lo;
  }
  /** Heading (of 24) along which the ground ahead (from `near` to `far` m) rises or falls most. */
  mostRelief(p: Readonly<Vec3d>, near: number, far: number, sign = 1): number {
    let best = 0;
    let bestScore = -Infinity;
    const h0 = this.height(p);
    const q = new Vec3d();
    for (let k = 0; k < 24; k++) {
      const hd = (k * 2 * Math.PI) / 24;
      let score = 0;
      for (let s = 0; s < 6; s++) {
        const r = near + ((far - near) * s) / 5;
        score += sign * (this.height(this.offset(p, hd, r, q)) - h0);
      }
      if (score > bestScore) {
        bestScore = score;
        best = hd;
      }
    }
    return best;
  }
  /**
   * A standpoint from which `target` (at its ground height plus `lift` m) is in
   * view: on rings `dists` m out, the spot where the sight line from an eye
   * `eye` m above the ground clears the terrain by the widest margin, with the
   * target as high in the view as possible. Returns the spot and the pitch
   * that centers the target a little below the middle of the view.
   */
  vista(
    target: Readonly<Vec3d>,
    dists: number[],
    eye: number,
    lift = 0,
    prefer?: number,
    /** 'down' favors standpoints that look down on the target (a rim), 'up' the reverse. */
    look: 'up' | 'down' = 'up',
  ): { point: Vec3d; facing: number; pitch: number } | null {
    const ht = Math.max(0, this.height(target)) + lift;
    let best: { point: Vec3d; facing: number; pitch: number } | null = null;
    let bestScore = -Infinity;
    const q = new Vec3d();
    for (const r of dists) {
      for (let k = 0; k < 32; k++) {
        const p = this.offset(target, (k * 2 * Math.PI) / 32, r);
        const hp = Math.max(0, this.height(p));
        if (this.height(p) <= 0 && lift >= 0) continue; // stand on land
        const he = hp + eye;
        // Clearance of the sight line over the ground between.
        let clear = Infinity;
        for (let s = 1; s < 34; s++) {
          const f = s / 40;
          q.copy(p)
            .scale(1 - f)
            .addScaled(target, f)
            .normalize();
          const line = he + (ht - he) * f;
          clear = Math.min(clear, line - Math.max(0, this.height(q)));
        }
        if (clear < 20) continue;
        const angle = Math.atan2(ht - he, r);
        const facing = this.headingTo(p, target);
        const lit = prefer === undefined ? 0 : 0.08 * Math.cos(facing - prefer);
        const score = (look === 'up' ? angle : -angle) + (0.3 * Math.min(clear, 500)) / r + lit;
        if (score > bestScore) {
          bestScore = score;
          best = { point: p, facing: this.headingTo(p, target), pitch: angle - 0.04 };
        }
      }
    }
    return best;
  }

  /**
   * The point within `radiusM` of `center` (on a `stepM` grid) that maximizes
   * `score`, or `center` when none scores above −Infinity.
   */
  search(
    center: Readonly<Vec3d>,
    radiusM: number,
    stepM: number,
    score: (p: Vec3d) => number,
  ): Vec3d {
    let best = center.clone();
    let bestScore = -Infinity;
    for (let y = -radiusM; y <= radiusM; y += stepM) {
      for (let x = -radiusM; x <= radiusM; x += stepM) {
        if (x * x + y * y > radiusM * radiusM) continue;
        const r = Math.hypot(x, y);
        const p = r > 0 ? this.offset(center, Math.atan2(x, y), r) : center.clone();
        const sc = score(p);
        if (sc > bestScore) {
          bestScore = sc;
          best = p;
        }
      }
    }
    return best;
  }

  /** Heading toward `target`. */
  headingTo(p: Readonly<Vec3d>, target: Readonly<Vec3d>): number {
    const east = new Vec3d(0, 1, 0).cross(p).normalize();
    const north = p.clone().cross(east);
    return Math.atan2(target.dot(east), target.dot(north));
  }
}

/** Finds one spot per archetype (null where the world has none). */
export async function findSpots(
  g: GlobalWorld,
  radius: number,
  /** Compass azimuth of the sun at a point at the view's time: views prefer it behind and to the side. */
  sunAzimuth?: (p: Readonly<Vec3d>) => number,
  /** Heights around a spot (within `radiusM`) for framing, e.g. from synthesized tiles. */
  prepare?: (center: Readonly<Vec3d>, radiusM: number) => Promise<(d: Readonly<Vec3d>) => number>,
): Promise<Map<SpotKind, LandscapeSpot | null>> {
  const scan = new WorldSampler(g, radius);
  const s = scan;
  const n = g.n;
  const biome = g.finish.biome;
  const height = g.height;
  const lake = g.finish.drainage.lakeDepth;
  const discharge = g.finish.drainage.discharge;
  const receiver = g.finish.drainage.receiver;
  const d = new Vec3d();
  const best = new Map<SpotKind, { score: number; cell: number }>();
  const offer = (k: SpotKind, score: number, cell: number) => {
    const b = best.get(k);
    if (!b || score > b.score) best.set(k, { score, cell });
  };
  const stride = 3;
  for (let face = 0; face < 6; face++) {
    for (let j = 1; j < n - 1; j += stride) {
      for (let i = 1; i < n - 1; i += stride) {
        const c = (face * n + j) * n + i;
        const h = height[c]!;
        const b = biome[c]!;
        cellCenterDirection(n, c, d);
        if (Math.abs(d.y) > 0.92) continue; // not at the poles
        if (h <= 0) continue;
        if (ARID.has(b)) {
          const rel = s.relief(d, [4000, 8000]);
          // A canyon cut into high ground, its floor well above the sea.
          if (h - rel > 150) offer('canyon', rel + 0.2 * h, c);
          if (rel < 250) offer('buttes', h - 4 * rel, c);
        }
        // A lake among mountains (lake cells carry a water biome).
        // Low enough to be warm, like Lake Como: under about 450 m physical, which is
        // about 2.9 km Earth-like at the planet scale (decision 122).
        if (lake[c]! > 0 && h + lake[c]! < 450)
          offer('lake', Math.min(lake[c]!, 400) + 0.5 * s.relief(d, [5000, 10000]), c);
        if (COLD.has(b) || b === Biome.TemperateForest) {
          const rel = s.relief(d, [5000, 10000]);
          // Northern-Sweden-like: tundra or taiga below the ice, with deep valleys, inland,
          // with lakes in the valleys nearby.
          if ((b === Biome.Tundra || b === Biome.Taiga) && h < 1800 && rel > 400) {
            let inland = true;
            let lakes = 0;
            for (let k = 0; k < 8; k++) {
              const q = s.offset(d, (k * Math.PI) / 4, 12000);
              if (s.height(q) <= 0) inland = false;
              if (lake[s.cell(s.offset(d, (k * Math.PI) / 4, 5000))]! > 0) lakes++;
            }
            if (inland) offer('glacial', rel + 400 * lakes, c);
          }
        }
        if (h > 3000) offer('peaks', h + 2 * s.relief(d, [6000, 12000]), c);
        if (b === Biome.TropicalRainforest && lake[c]! <= 0)
          offer('jungle', discharge[c]! / (1 + 0.01 * s.relief(d, [3000])), c);
        // A river cell whose receiver is sea: a mouth.
        const r = receiver[c]!;
        if (r >= 0 && height[r]! <= 0 && discharge[c]! > 50) {
          const arid = ARID.has(b) || b === Biome.Savanna || b === Biome.TemperateGrassland;
          offer('delta', discharge[c]! * (arid ? 3 : 1), c);
        }
        // Coast in the cold with low relief: at least one sea neighbor within 3 km.
        if (COLD.has(b) || b === Biome.TemperateForest) {
          let sea = 0;
          for (let k = 0; k < 8; k++)
            if (s.height(s.offset(d, (k * Math.PI) / 4, 4000)) <= -20) sea++;
          if (sea >= 2 && sea <= 5) {
            const cold = COLD.has(b) ? 1 : 0.6;
            offer('skerries', cold * (300 - s.relief(d, [3000, 6000])), c);
          }
        }
        // Falls: a steep reach of a sizable river that crosses a stratum boundary
        // (tileSynth steps its surface there, decision 126).
        if (discharge[c]! > 60 && r >= 0 && height[r]! > 0) {
          const grad = (h - height[r]!) / (((Math.PI / 2) * radius) / n);
          const T = 75;
          if (grad > 0.015 && grad < 0.08 && Math.floor(h / T) !== Math.floor(height[r]! / T)) {
            offer('falls', Math.sqrt(discharge[c]!) * (ARID.has(b) ? 2 : 1), c);
          }
        }
      }
    }
  }

  const out = new Map<SpotKind, LandscapeSpot | null>();
  const DEG = Math.PI / 180;
  // Preferred facing: the sun behind the viewer and off to one side.
  const lit = (q: Readonly<Vec3d>) => (sunAzimuth ? sunAzimuth(q) + 150 * DEG : undefined);
  for (const kind of SPOT_KINDS) {
    const b = best.get(kind);
    if (!b) {
      out.set(kind, null);
      continue;
    }
    const p = cellCenterDirection(n, b.cell, new Vec3d());
    let spot: LandscapeSpot;
    const s = prepare ? new WorldSampler(g, radius, await prepare(p, 30_000)) : scan;
    const note = `cell ${b.cell}, score ${b.score.toFixed(0)}, height ${height[b.cell]!.toFixed(0)} m, biome ${biome[b.cell]}`;
    switch (kind) {
      case 'glacial': {
        // Looking along the deepest valley nearby from its side.
        const low = s.offset(p, s.mostRelief(p, 2000, 8000, -1), 5000);
        const v = s.vista(low, [6000, 9000, 12000], 120, 0, lit(low));
        spot = v
          ? { kind, point: v.point, facing: v.facing, height: 120, pitch: v.pitch, note }
          : { kind, point: p, facing: 0, height: 120, pitch: 0, note };
        break;
      }
      case 'canyon': {
        // From the rim, across the deepest ground nearby.
        const low = s.offset(p, s.mostRelief(p, 2000, 6000, -1), 4000);
        const v = s.vista(low, [3000, 5000, 8000], 60, 0, lit(low), 'down');
        spot = v
          ? { kind, point: v.point, facing: v.facing, height: 80, pitch: v.pitch, note }
          : { kind, point: p, facing: 0, height: 80, pitch: -0.1, note };
        break;
      }
      case 'peaks': {
        // From across a valley, 8–18 km out, with the summit in clear view; higher if need be.
        let found: LandscapeSpot | null = null;
        for (const eye of [150, 600, 1500]) {
          const v = s.vista(p, [8000, 11000, 14000, 18000], eye, -600, lit(p));
          if (v) {
            found = {
              kind,
              point: v.point,
              facing: v.facing,
              height: eye,
              pitch: Math.max(v.pitch, -0.12),
              note,
            };
            break;
          }
        }
        spot = found ?? { kind, point: p, facing: 0, height: 500, pitch: 0, note };
        break;
      }
      case 'buttes': {
        // On the desert floor near the tallest buttes, looking at them.
        const q = new Vec3d();
        // Buttes exist only in the tiles: look for tile ground well above the global grid.
        const excess = (c: Readonly<Vec3d>) => s.height(c) - scan.height(c);
        const floor = s.search(p, 25000, 1500, (c) => {
          // A flat desert floor in low global relief: buttes, not hills.
          if (excess(c) > 30 || scan.relief(c, [2000, 4000]) > 150 || s.relief(c, [300]) > 25)
            return -Infinity;
          let hi = -Infinity;
          for (const r of [1500, 2500, 4000])
            for (let k = 0; k < 8; k++)
              hi = Math.max(hi, excess(s.offset(c, (k * Math.PI) / 4, r, q)));
          return hi;
        });
        const facing = s.mostRelief(floor, 1200, 5000, 1);
        spot = { kind, point: floor, facing, height: 25, pitch: 3 * DEG, note };
        break;
      }
      case 'lake': {
        // From a slope above the shore, along the lake.
        const v = s.vista(p, [5000, 8000, 11000], 300, 0, lit(p));
        spot = v
          ? { kind, point: v.point, facing: v.facing, height: 300, pitch: v.pitch, note }
          : { kind, point: p, facing: 0, height: 300, pitch: -0.1, note };
        break;
      }
      case 'skerries': {
        // March toward the sea to the tile shoreline, then look out over it.
        const sea = s.mostRelief(p, 2000, 8000, -1);
        let at = p.clone();
        for (let m = 0; m < 80 && s.height(at) > 4; m++) at = s.offset(at, sea, 250);
        spot = {
          kind,
          point: s.offset(at, sea + Math.PI, 400),
          facing: sea,
          height: 90,
          pitch: -6 * DEG,
          note,
        };
        break;
      }
      case 'delta': {
        const r = receiver[b.cell]!;
        const sea = s.headingTo(p, cellCenterDirection(n, r, new Vec3d()));
        spot = {
          kind,
          point: s.offset(p, sea + Math.PI, 15000),
          facing: sea,
          height: 1500,
          pitch: -12 * DEG,
          note,
        };
        break;
      }
      case 'jungle': {
        const r = receiver[b.cell]!;
        const down = s.headingTo(p, cellCenterDirection(n, r, new Vec3d()));
        spot = {
          kind,
          point: s.offset(p, down + Math.PI / 2, 2500),
          facing: down - Math.PI / 4,
          height: 300,
          pitch: -8 * DEG,
          note,
        };
        break;
      }
      case 'falls': {
        // At the stratum crossing between the cell and its receiver, 700 m downstream.
        const r = receiver[b.cell]!;
        const pr = cellCenterDirection(n, r, new Vec3d());
        const h0 = height[b.cell]!;
        const h1 = height[r]!;
        const level = Math.floor(h0 / 75) * 75;
        const f = Math.min(1, Math.max(0, (h0 - level) / Math.max(h0 - h1, 1e-3)));
        const fall = p
          .clone()
          .scale(1 - f)
          .addScaled(pr, f)
          .normalize();
        const down = s.headingTo(fall, pr);
        spot = {
          kind,
          point: s.offset(fall, down, 700),
          facing: down + Math.PI,
          height: 40,
          pitch: 2 * DEG,
          note,
        };
        break;
      }
    }
    out.set(kind, spot);
  }
  return out;
}
