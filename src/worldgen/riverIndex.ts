/**
 * River segments for detail-tile synthesis: polylines smoothed and indexed
 * by tile, so a tile can carve exactly the channels that can reach it.
 *
 * Global rivers run through global-grid cell centers, which zigzag at about
 * 1.5 km. Two Chaikin passes round them off before they are carved into
 * 50 m tiles. Smoothing is applied per polyline, keeping the endpoints, so
 * tributaries still meet their main river exactly.
 *
 * Segments are indexed by the level-INDEX_LEVEL tiles their endpoints fall
 * in. A query for any tile at or below that level takes its ancestor at
 * INDEX_LEVEL plus that ancestor's eight neighbors, then keeps the segments
 * within the tile's bounding cap plus a margin. The result depends only on
 * the tile key, so every tile sees the same segments however tiles are
 * generated.
 */
import {
  neighborTile,
  tileForDirection,
  tileKey,
  tileKeyString,
  tileSampleDirection,
  TILE_TEXELS,
} from '../core/tiles';
import type { TileKey } from '../core/tiles';
import { Vec3d } from '../core/vec3d';
import type { Channels } from './channels/channels';
import type { Rivers } from './rivers';

export const RIVER_INDEX_LEVEL = 4;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface RiverSegments {
  count: number;
  /**
   * Per segment (FIELDS values): a.xyz, b.xyz (unit directions), widthA, widthB (m),
   * the water surface at a and b (m), and the surface stepped into pools and falls
   * at a and b (m). Both surfaces never rise downstream (decision 146).
   */
  data: Float64Array;
  /** Values per segment: 12 here; other users of the layout (roads) keep the first 8. */
  fields?: number;
}

const FIELDS = 12;

/** Surface of a river without a height source: no channel is carved. */
export const NO_SURFACE = 1e9;

/**
 * Water surface profiles (decision 146). Each river's surface comes from the
 * global grid's heights at the cells it drains through (the lake level in a
 * lake, sea level at the mouth), `drop` m below them, and never rises
 * downstream: a reach that the interpolated terrain lifts above an upstream
 * point is cut through instead of flowing uphill. Tributaries meet their main
 * river at its surface. On steep reaches (bed gradient `gradient`, measured
 * over ±`probe` m, rivers at least `minWidth` m wide) the surface steps down
 * the `strata` m rock layers in pools and drops, each drop over about `run` m.
 */
export const PROFILE_TUNING = {
  drop: 0.5,
  gradient: [0.012, 0.03] as [number, number],
  probe: 400,
  run: 140,
  minWidth: 15,
  strata: 75,
};

/**
 * Planform smoothing (decision 165): D8 drainage runs along the grid's axes
 * and diagonals, so a polyline through cell centers is a staircase, and two
 * Chaikin passes alone leave about half its length on grid headings (seed
 * 1983: 51% within 2.5° of a multiple of 45°, against 11% for headings spread
 * evenly). A Gaussian over arc length, `sigma` point spacings wide (the
 * median spacing of the network's points), turns the steps into the line they
 * approximate before Chaikin rounds it. The displacement tapers to zero over
 * two sigmas at both ends, so confluences and mouths stay exactly in place.
 */
export const PLANFORM_TUNING = {
  sigma: 1,
};

/** A polyline of unit vectors with attributes, smoothed in plan by a Gaussian of `sigmaM` m. */
export function smoothPlanform(pts: number[][], sigmaM: number, radius: number): number[][] {
  const n = pts.length;
  if (n < 3 || !(sigmaM > 0)) return pts;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    s[i] =
      s[i - 1]! + Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * radius;
  }
  const L = s[n - 1]!;
  const reach = 3 * sigmaM;
  const k = -1 / (2 * sigmaM * sigmaM);
  const out = pts.map((q) => [...q]);
  let lo = 0;
  for (let i = 1; i + 1 < n; i++) {
    const taper = Math.min(1, Math.min(s[i]!, L - s[i]!) / (2 * sigmaM));
    if (taper <= 0) continue;
    while (s[lo]! < s[i]! - reach) lo++;
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;
    for (let j = lo; j < n && s[j]! <= s[i]! + reach; j++) {
      const dj = s[j]! - s[i]!;
      const wj = Math.exp(k * dj * dj);
      x += wj * pts[j]![0]!;
      y += wj * pts[j]![1]!;
      z += wj * pts[j]![2]!;
      w += wj;
    }
    const p = pts[i]!;
    const q = out[i]!;
    q[0] = p[0]! + taper * (x / w - p[0]!);
    q[1] = p[1]! + taper * (y / w - p[1]!);
    q[2] = p[2]! + taper * (z / w - p[2]!);
    const l = Math.hypot(q[0], q[1]!, q[2]!);
    q[0] /= l;
    q[1]! /= l;
    q[2]! /= l;
  }
  return out;
}

/** Two Chaikin corner-cutting passes on a polyline of unit vectors with attributes. */
export function chaikin(pts: number[][], passes: number): number[][] {
  let p = pts;
  for (let pass = 0; pass < passes; pass++) {
    if (p.length < 3) return p;
    const out: number[][] = [p[0]!];
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i]!;
      const b = p[i + 1]!;
      out.push(a.map((x, k) => 0.75 * x + 0.25 * b[k]!));
      out.push(a.map((x, k) => 0.25 * x + 0.75 * b[k]!));
    }
    out.push(p[p.length - 1]!);
    // Renormalize the direction part.
    for (const q of out) {
      const l = Math.hypot(q[0]!, q[1]!, q[2]!);
      q[0]! /= l;
      q[1]! /= l;
      q[2]! /= l;
    }
    p = out;
  }
  return p;
}

/**
 * Meanders (decision 126): lowland rivers wind across their floodplains. A
 * polyline whose bed falls less than `maxGradient` (m/m, physical) and whose
 * width reaches `minWidth` m is displaced sideways by a meander train of
 * wavelength `wavelength` × width (varying ±`wavelengthJitter` per bend) and
 * amplitude `amplitude` × wavelength, with a third harmonic that skews and
 * fattens the bends. The displacement tapers to zero over a wavelength at both
 * ends, so confluences and mouths stay where they are.
 */
export const MEANDER_TUNING = {
  maxGradient: 0.0012,
  fullGradient: 0.0004,
  minWidth: 25,
  wavelength: 11,
  wavelengthJitter: 0.3,
  amplitude: 0.32,
  /** Point spacing along a meandering river, in wavelengths. */
  spacing: 1 / 14,
};

export interface MeanderOptions {
  /** Physical height per global cell (the rivers' `cells` index it). */
  height: Float32Array;
  radius: number;
  /** Lake depth per global cell (m): a river in a lake runs at the lake's level. */
  lakeDepth?: Float32Array;
  profile?: Partial<typeof PROFILE_TUNING>;
  tuning?: Partial<typeof MEANDER_TUNING>;
  planform?: Partial<typeof PLANFORM_TUNING>;
  wander?: Partial<typeof WANDER_TUNING>;
  /** Migrated rivers and their oxbows from the channel stage (decision 173); none migrates without. */
  channels?: Channels | null;
}

/** Deterministic hash of two integers to [0, 1). */
function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** A polyline (unit vectors + width) with meanders added (see MEANDER_TUNING). */
export function meander(
  pts: number[][],
  id: number,
  radius: number,
  t: typeof MEANDER_TUNING,
  strength: number,
): number[][] {
  if (pts.length < 2 || strength <= 0) return pts;
  // Arclength (m) at each point.
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dot = Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!);
    s.push(s[i - 1]! + Math.acos(dot) * radius);
  }
  const L = s[s.length - 1]!;
  const meanWidth = pts.reduce((acc, p) => acc + p[3]!, 0) / pts.length;
  const lambda0 = t.wavelength * Math.max(meanWidth, t.minWidth);
  if (L < 1.5 * lambda0) return pts;
  // Resample evenly.
  const step = lambda0 * t.spacing;
  const count = Math.max(2, Math.ceil(L / step));
  const out: number[][] = [];
  let seg = 0;
  let phase = hash2(id, 7) * 2 * Math.PI;
  let bend = 0;
  let bendLambda = lambda0 * (1 + t.wavelengthJitter * (2 * hash2(id, bend) - 1));
  let prevS = 0;
  const p = new Vec3d();
  const q = new Vec3d();
  const tangent = new Vec3d();
  const side = new Vec3d();
  for (let k = 0; k <= count; k++) {
    const sk = (k / count) * L;
    while (seg < pts.length - 2 && s[seg + 1]! < sk) seg++;
    const a = pts[seg]!;
    const b = pts[seg + 1]!;
    const f = Math.min(1, Math.max(0, (sk - s[seg]!) / Math.max(s[seg + 1]! - s[seg]!, 1e-9)));
    p.set(
      a[0]! + (b[0]! - a[0]!) * f,
      a[1]! + (b[1]! - a[1]!) * f,
      a[2]! + (b[2]! - a[2]!) * f,
    ).normalize();
    const attrs = a.slice(3).map((x, c) => x + (b[3 + c]! - x) * f);
    // Phase advances by 2π per bend wavelength; each half bend draws a new length.
    const before = Math.floor(phase / Math.PI);
    phase += ((sk - prevS) / bendLambda) * 2 * Math.PI;
    prevS = sk;
    if (Math.floor(phase / Math.PI) !== before) {
      bend++;
      bendLambda = lambda0 * (1 + t.wavelengthJitter * (2 * hash2(id, bend) - 1));
    }
    const taper =
      Math.min(1, sk / lambda0, (L - sk) / lambda0) ** 2 *
      (3 - 2 * Math.min(1, sk / lambda0, (L - sk) / lambda0));
    const amp = strength * taper * t.amplitude * bendLambda;
    const y = amp * (Math.sin(phase) - 0.18 * Math.sin(3 * phase + 0.6));
    q.set(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
    tangent.copy(q).addScaled(p, -q.dot(p)).normalize();
    side.copy(p).cross(tangent);
    const d = p
      .clone()
      .addScaled(side, y / radius)
      .normalize();
    out.push([d.x, d.y, d.z, ...attrs]);
  }
  return out;
}

/**
 * Wander (decision 167): every river winds a little, not only the lowland
 * rivers that meander. Long runs of D8 steps straight along one axis survive
 * the planform smoothing (decision 165), and a natural channel is never
 * straight for kilometers. Each polyline is displaced sideways by two octaves
 * of smooth noise along its arc length, wavelengths `wavelengths` point
 * spacings (about a global cell each), amplitudes `amplitudes` spacings, and
 * by a third, finer octave at `fineWidths` channel widths with `fineAmplitude`
 * widths of swing. Gradient noise, so headings never linger on the axis they
 * should leave. Polylines with few points are subdivided first, so short
 * tributaries between confluences bend too. Steep rivers keep `steepShare` of it, so mountain streams
 * stay on their valley floors: full wander below a bed gradient of
 * `flatGradient`, the steep share above `steepGradient`. The displacement
 * tapers to zero over the longest wavelength at both ends (half the polyline
 * if it is shorter), so confluences and mouths stay where they are, and is
 * clamped to `maxShift` spacings.
 */
export const WANDER_TUNING = {
  wavelengths: [5.5, 2.3] as [number, number],
  amplitudes: [0.3, 0.14] as [number, number],
  fineWidths: 14,
  fineAmplitude: 1.2,
  maxShift: 0.35,
  flatGradient: 0.004,
  steepGradient: 0.03,
  steepShare: 0.5,
};

/**
 * Smooth 1D gradient noise, about [-1, 1], on an integer lattice keyed by (id,
 * salt). Gradient noise, not value noise: value noise with eased interpolation
 * is flat at every lattice point, where a river's heading would linger on the
 * grid's axis it was meant to leave.
 */
function noise1(x: number, id: number, salt: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const g0 = 2 * hash2(id * 7919 + salt, i) - 1;
  const g1 = 2 * hash2(id * 7919 + salt, i + 1) - 1;
  return 2 * (g0 * f + (g1 * (f - 1) - g0 * f) * u);
}

/**
 * A polyline (unit vectors + attributes, attribute 0 the width in m) wandering
 * sideways (WANDER_TUNING). `spacing` is the network's point spacing (m) and
 * `gradient` the polyline's bed gradient. Points are moved, not added; the
 * fine octave is skipped where the points are too sparse to carry it.
 */
export function wander(
  pts: number[][],
  id: number,
  radius: number,
  spacing: number,
  gradient: number,
  t: typeof WANDER_TUNING = WANDER_TUNING,
): number[][] {
  if (pts.length < 2 || !(spacing > 0)) return pts;
  // Short polylines get points to bend at: at least eight pieces.
  if (pts.length < 9) pts = subdivide(pts, Math.ceil(8 / (pts.length - 1)));
  const n = pts.length;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    s[i] =
      s[i - 1]! + Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * radius;
  }
  const L = s[n - 1]!;
  const longest = t.wavelengths[0] * spacing;
  if (L < 0.5 * spacing) return pts;
  const taperLength = Math.min(longest, 0.5 * L);
  const flat =
    t.steepShare + (1 - t.steepShare) * (1 - smoothstep(t.flatGradient, t.steepGradient, gradient));
  // The points' own spacing, for the fine octave's Nyquist limit.
  const step = L / (n - 1);
  const out = pts.map((q) => [...q]);
  const p = new Vec3d();
  const tangent = new Vec3d();
  const side = new Vec3d();
  for (let i = 1; i + 1 < n; i++) {
    const e = Math.min(s[i]!, L - s[i]!) / taperLength;
    const taper = e >= 1 ? 1 : e * e * (3 - 2 * e);
    if (taper <= 0) continue;
    let y = 0;
    for (let o = 0; o < 2; o++) {
      const lambda = t.wavelengths[o] * spacing;
      y += t.amplitudes[o] * spacing * noise1(s[i]! / lambda, id, o);
    }
    const w = pts[i]![3]!;
    const fineLambda = t.fineWidths * w;
    if (fineLambda > 6 * step) y += t.fineAmplitude * w * noise1(s[i]! / fineLambda, id, 2);
    const cap = t.maxShift * spacing;
    y = Math.max(-cap, Math.min(cap, y)) * flat * taper;
    const a = pts[i - 1]!;
    const b = pts[i + 1]!;
    p.set(pts[i]![0]!, pts[i]![1]!, pts[i]![2]!);
    tangent.set(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
    tangent.addScaled(p, -tangent.dot(p));
    if (tangent.length() < 1e-15) continue;
    tangent.normalize();
    side.copy(p).cross(tangent);
    p.addScaled(side, y / radius).normalize();
    out[i]![0] = p.x;
    out[i]![1] = p.y;
    out[i]![2] = p.z;
  }
  return out;
}

/** Each segment of a polyline split into `k` (directions renormalized, attributes linear). */
function subdivide(pts: number[][], k: number): number[][] {
  if (k <= 1) return pts;
  const out: number[][] = [pts[0]!];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    for (let j = 1; j <= k; j++) {
      const f = j / k;
      const q = a.map((x, c) => x + (b[c]! - x) * f);
      const l = Math.hypot(q[0]!, q[1]!, q[2]!);
      q[0]! /= l;
      q[1]! /= l;
      q[2]! /= l;
      out.push(j === k ? b : q);
    }
  }
  return out;
}

/**
 * Deltas (decision 126): the mouths of rivers at least `minWidth` m wide build
 * a fan of radius `radiusWidths` × width (at most `maxRadius` m) into the sea.
 */
export const DELTA_TUNING = {
  minWidth: 140,
  radiusWidths: 45,
  maxRadius: 26_000,
};

/** Per delta: mouth.xyz, seaward direction.xyz (tangent, unit), width (m), fan radius (m). */
export const DELTA_FIELDS = 8;

/** Arc length (m) along a polyline of unit directions. */
function arcLengths(line: number[][], radius: number): number[] {
  const s = [0];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dot = Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!);
    s.push(s[i - 1]! + Math.acos(dot) * radius);
  }
  return s;
}

/** Linear interpolation of attribute `c` at arc length `x` (clamped to the ends). */
function attrAt(line: number[][], s: number[], c: number, x: number): number {
  if (x <= 0) return line[0]![c]!;
  const L = s[s.length - 1]!;
  if (x >= L) return line[line.length - 1]![c]!;
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (s[m]! <= x) lo = m;
    else hi = m;
  }
  const f = (x - s[lo]!) / Math.max(s[hi]! - s[lo]!, 1e-9);
  return line[lo]![c]! + (line[hi]![c]! - line[lo]![c]!) * f;
}

/** A point between two polyline points: directions renormalized, attributes linear. */
function lerpPoint(a: number[], b: number[], f: number): number[] {
  const q = a.map((x, c) => x + (b[c]! - x) * f);
  const l = Math.hypot(q[0]!, q[1]!, q[2]!);
  q[0]! /= l;
  q[1]! /= l;
  q[2]! /= l;
  return q;
}

/**
 * Water surfaces for smoothed polylines [x, y, z, width, surface] (decision
 * 146; PROFILE_TUNING): returns them as [x, y, z, width, surface, stepped],
 * with points added at the top and foot of each drop. Polylines are visited
 * upstream first, so a main river starts no higher than the tributaries that
 * join it, and each tributary then ends at the main river's surface.
 */
export function riverProfiles(
  lines: number[][][],
  downstream: Int32Array,
  radius: number,
  t: typeof PROFILE_TUNING,
): number[][][] {
  const n = lines.length;
  const donors: number[][] = Array.from({ length: n }, () => []);
  for (let k = 0; k < n; k++) {
    const d = downstream[k]!;
    if (d >= 0 && d < n) donors[d]!.push(k);
  }
  const out: number[][][] = new Array(n);
  const pending = donors.map((d) => d.length);
  const queue: number[] = [];
  for (let k = 0; k < n; k++) if (pending[k] === 0) queue.push(k);
  const done = new Uint8Array(n);
  const visit = (k: number) => {
    done[k] = 1;
    const line = lines[k]!.map((q) => q.slice(0, 5));
    if (line.length === 0) {
      out[k] = [];
      return;
    }
    // Smooth surface: no higher than any donor's end, never rising downstream.
    for (const j of donors[k]!) {
      const e = out[j]?.[out[j]!.length - 1];
      if (e) line[0]![4] = Math.min(line[0]![4]!, e[4]!);
    }
    for (let i = 1; i < line.length; i++) line[i]![4] = Math.min(line[i]![4]!, line[i - 1]![4]!);
    // Falls: the bed gradient over ±probe, and the weight of the steps at each point.
    const s = arcLengths(line, radius);
    const T = t.strata;
    const fall = line.map((q, i) => {
      const g =
        (attrAt(line, s, 4, s[i]! - t.probe) - attrAt(line, s, 4, s[i]! + t.probe)) / (2 * t.probe);
      const w =
        smoothstep(t.gradient[0], t.gradient[1], g) *
        (q[3]! >= t.minWidth ? 1 : 0) *
        (q[4]! > T ? 1 : 0);
      return [w, Math.min(0.5, Math.max(0.005, (t.run * g) / T))];
    });
    // Points at the top and the foot of each drop, so a drop is a ramp over its run.
    const pts: number[][] = [];
    const meta: number[][] = [];
    for (let i = 0; i < line.length; i++) {
      pts.push(line[i]!);
      meta.push(fall[i]!);
      if (i + 1 === line.length) break;
      const a = line[i]!;
      const b = line[i + 1]!;
      const sa = a[4]!;
      const sb = b[4]!;
      if (Math.max(fall[i]![0]!, fall[i + 1]![0]!) <= 0 || sa - sb <= 1e-6) continue;
      const eps = Math.max(fall[i]![1]!, fall[i + 1]![1]!);
      const cuts: number[] = [];
      for (let L = Math.floor(sa / T) * T; L > sb && cuts.length < 64; L -= T) {
        for (const level of [L, L - eps * T]) {
          if (level < sa && level > sb) cuts.push((sa - level) / (sa - sb));
        }
      }
      cuts.sort((x, y) => x - y);
      for (const f of cuts) {
        pts.push(lerpPoint(a, b, f));
        meta.push([
          fall[i]![0]! + (fall[i + 1]![0]! - fall[i]![0]!) * f,
          fall[i]![1]! + (fall[i + 1]![1]! - fall[i]![1]!) * f,
        ]);
      }
    }
    // Stepped surface: pools at each stratum, drops over its top eps.
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i]!;
      const surf = q[4]!;
      const [w, eps] = meta[i]!;
      let stepped = surf;
      if (w! > 0) {
        const x = surf / T;
        const k0 = Math.floor(x);
        stepped = surf + w! * ((k0 + smoothstep(1 - eps!, 1, x - k0)) * T - surf);
      }
      q.push(stepped);
    }
    for (const j of donors[k]!) {
      const e = out[j]?.[out[j]!.length - 1];
      if (e) pts[0]![5] = Math.min(pts[0]![5]!, e[5]!);
    }
    for (let i = 1; i < pts.length; i++) pts[i]![5] = Math.min(pts[i]![5]!, pts[i - 1]![5]!);
    // Each tributary ends exactly on the main river's surface.
    for (const j of donors[k]!) {
      const e = out[j]?.[out[j]!.length - 1];
      if (e) {
        e[4] = pts[0]![4]!;
        e[5] = pts[0]![5]!;
      }
    }
    out[k] = pts;
  };
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head]!;
    visit(k);
    const d = downstream[k]!;
    if (d >= 0 && d < n && --pending[d]! === 0) queue.push(d);
  }
  // Cycles cannot occur in a drainage tree; visit anything left over anyway.
  for (let k = 0; k < n; k++) if (!done[k]) visit(k);
  return out;
}

/** Oxbow lakes (decision 173): their level below the river's surface at the cut (m), and their width as a share of the river's. */
export const OXBOW_TUNING = { drop: 0.3, widthShare: 0.8 };

/** The planform stage's result: smoothed, wandering and meandering polylines (see `riverPlanforms`). */
export interface RiverPlanforms {
  /** Per polyline, its points: [x, y, z, width, water surface of the cell]. */
  lines: number[][][];
  /** Per polyline, its bed gradient from the global grid (m/m; 0 without heights). */
  gradients: Float64Array;
  /** The network's point spacing (m): the median distance between consecutive points. */
  spacing: number;
}

/**
 * The planform of every polyline (decisions 126, 165, 167): smoothed in plan,
 * corner-cut, wandering, and meandering where lowland, each point with its width
 * and its cell's water surface. Shared by `RiverIndex` and the channel stage
 * (decision 173), which migrates some of them.
 */
export function riverPlanforms(rivers: Rivers, meanders?: MeanderOptions): RiverPlanforms {
  const mt = { ...MEANDER_TUNING, ...meanders?.tuning };
  const pt = { ...PROFILE_TUNING, ...meanders?.profile };
  const height = meanders?.height;
  const lakeDepth = meanders?.lakeDepth;
  // The water surface at a global cell: its lake's level in a lake, sea level at the mouth.
  const cellSurface = (c: number): number => {
    if (!height) return NO_SURFACE;
    const h = height[c]!;
    const lake = lakeDepth ? lakeDepth[c]! : 0;
    return (lake > 0 ? h + lake : Math.max(h, 0)) - pt.drop;
  };
  // Smoothed polylines: [x, y, z, width, surface].
  const lines: number[][][] = [];
  const gradients = new Float64Array(rivers.count);
  // Planform smoothing (decision 165) needs the network's point spacing: the
  // median distance between consecutive points, about a global cell.
  let sigmaM = 0;
  let spacing = 0;
  if (meanders) {
    const gaps: number[] = [];
    for (let k = 0; k < rivers.count; k++) {
      for (let p = rivers.offsets[k]! + 1; p < rivers.offsets[k + 1]!; p++) {
        const q = p - 1;
        const dot =
          rivers.points[p * 3]! * rivers.points[q * 3]! +
          rivers.points[p * 3 + 1]! * rivers.points[q * 3 + 1]! +
          rivers.points[p * 3 + 2]! * rivers.points[q * 3 + 2]!;
        gaps.push(Math.acos(Math.min(1, dot)) * meanders.radius);
      }
    }
    gaps.sort((x, y) => x - y);
    spacing = gaps.length ? gaps[gaps.length >> 1]! : 0;
    sigmaM = spacing * { ...PLANFORM_TUNING, ...meanders.planform }.sigma;
  }
  for (let k = 0; k < rivers.count; k++) {
    const pts: number[][] = [];
    for (let p = rivers.offsets[k]!; p < rivers.offsets[k + 1]!; p++) {
      pts.push([
        rivers.points[p * 3]!,
        rivers.points[p * 3 + 1]!,
        rivers.points[p * 3 + 2]!,
        rivers.width[p]!,
        cellSurface(rivers.cells[p]!),
      ]);
    }
    let sm = chaikin(sigmaM > 0 ? smoothPlanform(pts, sigmaM, meanders!.radius) : pts, 2);
    let gradient = 0;
    if (meanders && pts.length >= 2) {
      // Bed gradient over the polyline, from the global grid.
      const first = rivers.offsets[k]!;
      const last = rivers.offsets[k + 1]! - 1;
      const drop = meanders.height[rivers.cells[first]!]! - meanders.height[rivers.cells[last]!]!;
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        len +=
          Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * meanders.radius;
      }
      gradient = Math.max(0, drop) / Math.max(len, 1);
      // Every river wanders a little (decision 167); lowland rivers then meander.
      sm = wander(sm, k, meanders.radius, spacing, gradient, {
        ...WANDER_TUNING,
        ...meanders.wander,
      });
      const strength =
        (1 - smoothstep(mt.fullGradient, mt.maxGradient, gradient)) *
        smoothstep(mt.minWidth, 2 * mt.minWidth, Math.max(...pts.map((p) => p[3]!)));
      if (strength > 0) sm = meander(sm, k, meanders.radius, mt, strength);
    }
    gradients[k] = gradient;
    lines.push(sm);
  }
  return { lines, gradients, spacing };
}

export class RiverIndex {
  readonly segments: RiverSegments;
  /**
   * Segment range of polyline k (the rivers' order): [lines[k], lines[k + 1]).
   * Each polyline runs downstream; `rivers.downstream` says which it joins.
   */
  readonly lines: Uint32Array;
  /**
   * Oxbow lakes (decision 173), after the network's segments: oxbow o is the segment
   * range [oxbows[o], oxbows[o + 1]), level water that belongs to no polyline.
   */
  readonly oxbows: Uint32Array;
  /** River mouths that build deltas, DELTA_FIELDS per record. */
  readonly deltas: Float64Array;
  private readonly byTile = new Map<string, number[]>();

  /** With `meanders`, lowland rivers wind across their floodplains (decision 126). */
  constructor(rivers: Rivers, meanders?: MeanderOptions) {
    const pt = { ...PROFILE_TUNING, ...meanders?.profile };
    const height = meanders?.height;
    const { lines } = riverPlanforms(rivers, meanders);
    // Migrated rivers (decision 173) replace their planform with the channel stage's.
    const ch = meanders?.channels;
    if (ch) {
      for (let m = 0; m < ch.rivers.length; m++) {
        const line: number[][] = [];
        for (let p = ch.offsets[m]!; p < ch.offsets[m + 1]!; p++)
          line.push(Array.from(ch.points.subarray(p * 5, p * 5 + 5)));
        if (line.length >= 2) lines[ch.rivers[m]!] = line;
      }
    }
    const radius = meanders?.radius ?? 1;
    const profiled = height
      ? riverProfiles(lines, rivers.downstream, radius, pt)
      : lines.map((l) => l.map((q) => [...q, NO_SURFACE]));
    const segs: number[] = [];
    const lineStarts: number[] = [];
    for (const sm of profiled) {
      lineStarts.push(segs.length / FIELDS);
      for (let i = 0; i + 1 < sm.length; i++) {
        const a = sm[i]!;
        const b = sm[i + 1]!;
        segs.push(
          a[0]!,
          a[1]!,
          a[2]!,
          b[0]!,
          b[1]!,
          b[2]!,
          a[3]!,
          b[3]!,
          a[4]!,
          b[4]!,
          a[5]!,
          b[5]!,
        );
      }
    }
    lineStarts.push(segs.length / FIELDS);
    this.lines = Uint32Array.from(lineStarts);
    // Oxbow lakes (decision 173): standing water after the network's segments, at the
    // river's surface where the loop was cut off, a little lower, and level.
    const oxStarts: number[] = [];
    if (ch && ch.oxbowRiver.length > 0) {
      for (let o = 0; o < ch.oxbowRiver.length; o++) {
        const river = profiled[ch.oxbowRiver[o]!];
        const a0 = ch.oxbowOffsets[o]!;
        const a1 = ch.oxbowOffsets[o + 1]!;
        if (!river || a1 - a0 < 2) continue;
        // The surface at the river's points nearest the oxbow's two ends.
        let level = NO_SURFACE;
        for (const e of [a0, a1 - 1]) {
          let best = Infinity;
          let surf = NO_SURFACE;
          for (const q of river) {
            const d =
              (q[0]! - ch.oxbowPoints[e * 4]!) ** 2 +
              (q[1]! - ch.oxbowPoints[e * 4 + 1]!) ** 2 +
              (q[2]! - ch.oxbowPoints[e * 4 + 2]!) ** 2;
            if (d < best) {
              best = d;
              surf = q[4]!;
            }
          }
          level = Math.min(level, surf);
        }
        if (level < NO_SURFACE * 0.5) level -= OXBOW_TUNING.drop;
        oxStarts.push(segs.length / FIELDS);
        for (let p = a0; p + 1 < a1; p++) {
          const o4 = p * 4;
          const w0 = ch.oxbowPoints[o4 + 3]! * OXBOW_TUNING.widthShare;
          const w1 = ch.oxbowPoints[o4 + 7]! * OXBOW_TUNING.widthShare;
          segs.push(
            ch.oxbowPoints[o4]!,
            ch.oxbowPoints[o4 + 1]!,
            ch.oxbowPoints[o4 + 2]!,
            ch.oxbowPoints[o4 + 4]!,
            ch.oxbowPoints[o4 + 5]!,
            ch.oxbowPoints[o4 + 6]!,
            w0,
            w1,
            level,
            level,
            level,
            level,
          );
        }
      }
    }
    oxStarts.push(segs.length / FIELDS);
    this.oxbows = Uint32Array.from(oxStarts);
    this.segments = { count: segs.length / FIELDS, data: Float64Array.from(segs), fields: FIELDS };
    // Deltas at mouths of wide rivers: the last land point and the sea point after it.
    const deltas: number[] = [];
    for (let k = 0; k < rivers.count; k++) {
      if (rivers.downstream[k] !== -1) continue;
      const end = rivers.offsets[k + 1]! - 1;
      if (end - rivers.offsets[k]! < 1) continue;
      const w = rivers.width[end - 1]!;
      if (w < DELTA_TUNING.minWidth) continue;
      const m = new Vec3d(
        rivers.points[(end - 1) * 3]!,
        rivers.points[(end - 1) * 3 + 1]!,
        rivers.points[(end - 1) * 3 + 2]!,
      );
      // Seaward: from a few points upstream to the sea point, in the tangent plane.
      const up = Math.max(rivers.offsets[k]!, end - 4);
      const dir = new Vec3d(
        rivers.points[end * 3]! - rivers.points[up * 3]!,
        rivers.points[end * 3 + 1]! - rivers.points[up * 3 + 1]!,
        rivers.points[end * 3 + 2]! - rivers.points[up * 3 + 2]!,
      );
      dir.addScaled(m, -dir.dot(m)).normalize();
      const r = Math.min(DELTA_TUNING.maxRadius, DELTA_TUNING.radiusWidths * w);
      deltas.push(m.x, m.y, m.z, dir.x, dir.y, dir.z, w, r);
    }
    this.deltas = Float64Array.from(deltas);
    const d = new Vec3d();
    for (let s = 0; s < this.segments.count; s++) {
      const keys = new Set<string>();
      for (const e of [0, 3]) {
        d.set(segs[s * FIELDS + e]!, segs[s * FIELDS + e + 1]!, segs[s * FIELDS + e + 2]!);
        keys.add(tileKeyString(tileForDirection(d, RIVER_INDEX_LEVEL)));
      }
      for (const key of keys) {
        let list = this.byTile.get(key);
        if (!list) this.byTile.set(key, (list = []));
        list.push(s);
      }
    }
  }

  /** Deltas whose fan may reach tile `k` (with its border), by record index. */
  deltasForTile(k: TileKey, radius: number): number[] {
    const c = tileSampleDirection(k, TILE_TEXELS / 2, TILE_TEXELS / 2);
    const corner = tileSampleDirection(k, -2, -2);
    const capAngle = Math.acos(Math.min(1, c.dot(corner)));
    const out: number[] = [];
    const n = this.deltas.length / DELTA_FIELDS;
    for (let i = 0; i < n; i++) {
      const o = i * DELTA_FIELDS;
      const dot = c.x * this.deltas[o]! + c.y * this.deltas[o + 1]! + c.z * this.deltas[o + 2]!;
      const reach = (1.6 * this.deltas[o + 7]!) / radius;
      if (Math.acos(Math.min(1, dot)) <= capAngle + reach) out.push(i);
    }
    return out;
  }

  /**
   * Segments that may affect `k` (level ≥ RIVER_INDEX_LEVEL): within the
   * tile's bounding cap plus `marginM` meters on a planet of radius `radius`.
   * Sorted by segment id.
   */
  forTile(k: TileKey, marginM: number, radius: number): number[] {
    if (k.level < RIVER_INDEX_LEVEL) return [];
    const shift = k.level - RIVER_INDEX_LEVEL;
    const anc = tileKey(k.face, RIVER_INDEX_LEVEL, k.x >> shift, k.y >> shift);
    const cand = new Set<number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = dx === 0 && dy === 0 ? anc : neighborTile(anc, dx, dy);
        for (const s of this.byTile.get(tileKeyString(t)) ?? []) cand.add(s);
      }
    }
    // Bounding cap of the tile (with its border samples).
    const c = tileSampleDirection(k, TILE_TEXELS / 2, TILE_TEXELS / 2);
    let capCos = 1;
    const corner = new Vec3d();
    for (const [sx, sy] of [
      [-2, -2],
      [TILE_TEXELS + 2, -2],
      [-2, TILE_TEXELS + 2],
      [TILE_TEXELS + 2, TILE_TEXELS + 2],
    ] as const) {
      tileSampleDirection(k, sx, sy, corner);
      capCos = Math.min(capCos, c.dot(corner));
    }
    const capAngle = Math.acos(Math.min(1, capCos)) + marginM / radius;
    const seg = this.segments.data;
    const out: number[] = [];
    const a = new Vec3d();
    const b = new Vec3d();
    for (const s of cand) {
      a.set(seg[s * FIELDS]!, seg[s * FIELDS + 1]!, seg[s * FIELDS + 2]!);
      b.set(seg[s * FIELDS + 3]!, seg[s * FIELDS + 4]!, seg[s * FIELDS + 5]!);
      // Segments are ~1 km long: the nearer endpoint is within a segment length of any point on it.
      const len = Math.acos(Math.min(1, a.dot(b)));
      const near = Math.min(Math.acos(Math.min(1, c.dot(a))), Math.acos(Math.min(1, c.dot(b))));
      if (near <= capAngle + len) out.push(s);
    }
    return out.sort((x, y) => x - y);
  }
}

export const RIVER_SEGMENT_FIELDS = FIELDS;
