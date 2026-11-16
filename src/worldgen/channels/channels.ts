/**
 * The channel stage (decision 173): meander migration with cutoffs for the
 * large lowland rivers, run once per world in the worker after river
 * extraction (finishWorld) and stored with the world, since it costs seconds.
 * `RiverIndex` takes the migrated lines in place of its own planform and adds
 * the oxbows as standing water.
 */
import { directionToCubeFace } from '../../core/coords';
import type { CubeFaceUv } from '../../core/coords';
import { Vec3d } from '../../core/vec3d';
import { riverPlanforms } from '../riverIndex';
import type { Rivers } from '../rivers';
import { MIGRATION_TUNING, migrate } from './migration';
import type { MigrationTuning } from './migration';

/** Migrated rivers and their oxbows, in flat typed arrays (transferable, storable). */
export interface Channels {
  /** Polyline ids (into `Rivers`) that migrated. */
  rivers: Int32Array;
  /** Point range of migrated river m: [offsets[m], offsets[m + 1]). */
  offsets: Uint32Array;
  /** Per point: x, y, z (unit direction), width (m), the cell's water surface (m). */
  points: Float64Array;
  /** Polyline id each oxbow was cut from. */
  oxbowRiver: Int32Array;
  /** Point range of oxbow o: [oxbowOffsets[o], oxbowOffsets[o + 1]). */
  oxbowOffsets: Uint32Array;
  /** Per oxbow point: x, y, z, width (m). */
  oxbowPoints: Float64Array;
  /** Stage time (ms). */
  ms: number;
}

export const FLOODPLAIN_TUNING = {
  /** Ground counts as floodplain up to this many meters above the river's surface... */
  rise: 3,
  /** ...plus this share of the width. */
  riseWidths: 0.02,
  /** Step and reach of the search sideways (m). */
  step: 150,
  reach: 12_000,
  /** Points sampled along the river, one per this many meters. */
  every: 600,
};

/** Bilinear sampler of a global cube-grid map (n² cells per face) at a unit direction. */
export function cubeMapSampler(map: Float32Array, n: number): (d: Readonly<Vec3d>) => number {
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  return (d) => {
    directionToCubeFace(d, uv);
    const fi = Math.min(n - 1, Math.max(0, uv.u * n - 0.5));
    const fj = Math.min(n - 1, Math.max(0, uv.v * n - 0.5));
    const i0 = Math.min(n - 2, Math.floor(fi));
    const j0 = Math.min(n - 2, Math.floor(fj));
    const tx = fi - i0;
    const ty = fj - j0;
    const o = (uv.face * n + j0) * n + i0;
    return (
      (map[o]! * (1 - tx) + map[o + 1]! * tx) * (1 - ty) +
      (map[o + n]! * (1 - tx) + map[o + n + 1]! * tx) * ty
    );
  };
}

/**
 * The floodplain's half-width (m) along a polyline ([x, y, z, width, surface]),
 * as a function of arc length: at points every `every` m, the mean of the
 * distances to either side where the ground first rises `rise` m (plus a share
 * of the width) above the river's surface, smoothed over five samples.
 */
export function floodplainOf(
  line: readonly number[][],
  height: (d: Readonly<Vec3d>) => number,
  radius: number,
  t = FLOODPLAIN_TUNING,
): (u: number) => number {
  const n = line.length;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    s[i] =
      s[i - 1]! + Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * radius;
  }
  const L = s[n - 1]!;
  const count = Math.max(2, Math.ceil(L / t.every) + 1);
  const us: number[] = [];
  const half: number[] = [];
  const p = new Vec3d();
  const tan = new Vec3d();
  const side = new Vec3d();
  const q = new Vec3d();
  let j = 0;
  for (let k = 0; k < count; k++) {
    const u = (k / (count - 1)) * L;
    while (j < n - 2 && s[j + 1]! < u) j++;
    const a = line[j]!;
    const b = line[j + 1]!;
    const f = s[j + 1]! > s[j]! ? (u - s[j]!) / (s[j + 1]! - s[j]!) : 0;
    p.set(a[0]! + (b[0]! - a[0]!) * f, a[1]! + (b[1]! - a[1]!) * f, a[2]! + (b[2]! - a[2]!) * f);
    p.normalize();
    tan.set(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
    tan.addScaled(p, -tan.dot(p)).normalize();
    side.copy(p).cross(tan);
    const width = a[3]! + (b[3]! - a[3]!) * f;
    const top = a[4]! + (b[4]! - a[4]!) * f + t.rise + t.riseWidths * width;
    let sum = 0;
    for (const sign of [1, -1]) {
      let d = t.step;
      for (; d < t.reach; d += t.step) {
        q.copy(p)
          .addScaled(side, (sign * d) / radius)
          .normalize();
        if (height(q) > top) break;
      }
      sum += d;
    }
    us.push(u);
    half.push(sum / 2);
  }
  const sm = half.map((_, k) => {
    let acc = 0;
    let c = 0;
    for (let o = -2; o <= 2; o++) {
      const v = half[k + o];
      if (v !== undefined) {
        acc += v;
        c++;
      }
    }
    return acc / c;
  });
  return (u) => {
    const x = Math.min(count - 1, Math.max(0, (u / Math.max(L, 1e-9)) * (count - 1)));
    const i = Math.min(count - 2, Math.floor(x));
    return sm[i]! + (sm[i + 1]! - sm[i]!) * (x - i);
  };
}

export interface ChannelOptions {
  /** Physical height per global cell (n² per face). */
  height: Float32Array;
  lakeDepth?: Float32Array;
  radius: number;
  tuning?: Partial<MigrationTuning>;
}

/** Migrates the large lowland rivers of `rivers` (MIGRATION_TUNING's criteria). */
export function computeChannels(rivers: Rivers, opts: ChannelOptions): Channels {
  const t0 = performance.now();
  const t = { ...MIGRATION_TUNING, ...opts.tuning };
  const n = Math.round(Math.sqrt(opts.height.length / 6));
  const height = cubeMapSampler(opts.height, n);
  const { lines, gradients } = riverPlanforms(rivers, {
    height: opts.height,
    radius: opts.radius,
    lakeDepth: opts.lakeDepth,
  });
  const ids: number[] = [];
  const offsets: number[] = [0];
  const points: number[] = [];
  const oxRiver: number[] = [];
  const oxOffsets: number[] = [0];
  const oxPoints: number[] = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    if (line.length < 3 || gradients[k]! >= t.maxGradient) continue;
    let w = 0;
    for (const p of line) w += p[3]!;
    w /= line.length;
    if (w < t.minWidth) continue;
    const fp = floodplainOf(line, height, opts.radius);
    // The median floodplain must hold `minFloodplainWidths` widths.
    let L = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      L += Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * opts.radius;
    }
    const mid: number[] = [];
    for (let i = 0; i <= 20; i++) mid.push(fp((i / 20) * L));
    mid.sort((x, y) => x - y);
    if (2 * mid[10]! < t.minFloodplainWidths * w) continue;
    const r = migrate(line, opts.radius, fp, t);
    ids.push(k);
    for (const p of r.line) points.push(p[0]!, p[1]!, p[2]!, p[3]!, p[4]!);
    offsets.push(points.length / 5);
    for (const o of r.oxbows) {
      oxRiver.push(k);
      for (const p of o) oxPoints.push(p[0]!, p[1]!, p[2]!, p[3]!);
      oxOffsets.push(oxPoints.length / 4);
    }
  }
  return {
    rivers: Int32Array.from(ids),
    offsets: Uint32Array.from(offsets),
    points: Float64Array.from(points),
    oxbowRiver: Int32Array.from(oxRiver),
    oxbowOffsets: Uint32Array.from(oxOffsets),
    oxbowPoints: Float64Array.from(oxPoints),
    ms: performance.now() - t0,
  };
}
