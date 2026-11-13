/**
 * Lightning as a function of the world seed, game time and place: which
 * strikes happen, what each looks like over its fraction of a second, and the
 * shape of a cloud-to-ground bolt. Everything here is pure and CPU-only;
 * lightning.ts turns it into uniforms, a mesh and thunder.
 *
 * **Schedule.** The planet's surface is divided into cells of about 8 km
 * (`STRIKE_CELLS` per edge of a cube face) and game time into slots of
 * `STRIKE_SLOT` seconds. Each (cell, slot) pair holds at most one strike: a
 * hash of the seed, the cell and the slot decides whether there is one, by
 * comparing a uniform draw with the cell's flash rate times the slot length,
 * and where in the cell and when in the slot it starts. The rate follows the
 * weather's storm intensity at the strike's place at the start of the slot
 * (`flashRate`): nothing below an intensity of 0.08, and at 1 as many flashes
 * per cell as give one every 2.5 s within 40 km of a camera; at 0.3 that is
 * about one a minute. Nothing depends on what was asked before, so the
 * strikes of an interval are the same at any frame rate, after a seek, and on
 * every machine. The draw is tested against the highest possible rate before
 * the weather is read, so a frame reads the weather for about one cell in fifty.
 *
 * **A strike** is cloud-to-ground (`CLOUD_TO_GROUND_SHARE` of them) or a
 * flash inside the cloud. It has one to four return strokes within about
 * 0.3 s, each a sudden peak that decays in tens of milliseconds
 * (`strikeIntensity`), so it flickers. Flashes in the cloud glow longer and
 * softer.
 *
 * **A bolt** (`buildBolt`) is a channel from a point under the cloud base to
 * the ground point, bent by midpoint displacement in three dimensions, with
 * branches that leave it at a downward angle and die out above the ground.
 * Its shape comes from the strike's seed alone.
 */
import type { CubeFace } from '../../../core/coords';
import { cubeFaceUvToDirection, directionToCubeFace } from '../../../core/coords';
import { normalizeSeed } from '../../../core/rng';
import type { WorldSeed } from '../../../core/rng';
import type { GameTime, Meters, Seconds } from '../../../core/units';
import { KM } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import { Channel } from '../../../sim/weather/frame';
import type { WeatherView } from '../../../sim/weather/frame';

/** Strike cells per edge of a cube face: about 8.2 km on a planet of 1,000 km radius. */
export const STRIKE_CELLS = 192;
/** Length of a time slot (game s): each cell has at most one strike in each. */
export const STRIKE_SLOT: Seconds = 4;
/** Cells within this distance of the camera are watched (m). */
export const STRIKE_RANGE: Meters = 48 * KM;
/** Storm intensity below which there is no lightning. */
export const STORM_THRESHOLD = 0.08;
/**
 * Flashes per cell and second at storm intensity 1: one every 2.5 s among the
 * 75 cells within 40 km of a camera.
 */
export const PEAK_FLASH_RATE = 1 / (2.5 * 75);
/** Share of strikes that reach the ground; the others stay inside the cloud. */
export const CLOUD_TO_GROUND_SHARE = 0.4;
/** The longest a strike lasts, from its first stroke to the end of its last one's glow (s). */
export const STRIKE_MAX_DURATION: Seconds = 0.6;

/** Flashes per cell and second at a storm intensity 0..1. */
export function flashRate(storm: number): number {
  if (!(storm > STORM_THRESHOLD)) return 0;
  const x = Math.min(1, (storm - STORM_THRESHOLD) / (1 - STORM_THRESHOLD));
  return PEAK_FLASH_RATE * Math.pow(x, 2.2);
}

/** One return stroke of a strike. */
export interface Stroke {
  /** Start after the strike's start (s). */
  offset: Seconds;
  /** Peak brightness 0..1. */
  peak: number;
  /** Time in which the brightness falls to 1/e (s). */
  decay: Seconds;
}

/** One lightning discharge. */
export interface Strike {
  /** Cell and slot it belongs to; together they identify it. */
  cell: number;
  slot: number;
  /** Game time of the first stroke. */
  time: GameTime;
  /** Unit direction from the planet center to the point on the ground under it. */
  direction: Vec3d;
  /** True for a cloud-to-ground strike, false for a flash inside the cloud. */
  ground: boolean;
  /** Strength 0..1: brightness of the flash and loudness of the thunder. */
  energy: number;
  /** Storm intensity where it struck. */
  storm: number;
  /** Height of a cloud flash's center above the cloud base (m); 0 for ground strikes. */
  height: Meters;
  strokes: Stroke[];
  /** Time from the first stroke until the glow has gone (s). */
  duration: Seconds;
  /** Seed of its shape (an unsigned 32-bit integer). */
  seed: number;
}

/** Mixes the bits of a 32-bit integer (the finalizer of MurmurHash3). */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A hash of four integers as an unsigned 32-bit integer. */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = mix32((a | 0) ^ 0x9e3779b9);
  h = mix32(h ^ Math.imul(b | 0, 0x85ebca77));
  h = mix32(h ^ Math.imul(c | 0, 0xc2b2ae3d));
  return mix32(h ^ Math.imul(d | 0, 0x27d4eb2f));
}

/** A world seed folded to 32 bits, for the strike hash. */
export function strikeSeed(seed: WorldSeed): number {
  const s = normalizeSeed(seed);
  return mix32(Number(s & 0xffffffffn) ^ mix32(Number(s >> 32n)));
}

/** A repeatable sequence of uniform numbers in [0, 1) from a 32-bit seed (for a strike's details). */
export function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    return mix32(state) / 4294967296;
  };
}

const UNIT = 1 / 4294967296;
const faceUv = { face: 0 as CubeFace, u: 0, v: 0 };

/** The strike cell a direction from the planet center falls in. */
export function strikeCell(direction: Readonly<Vec3d>): number {
  const n = STRIKE_CELLS;
  directionToCubeFace(direction, faceUv);
  const ix = Math.min(n - 1, Math.max(0, Math.floor(faceUv.u * n)));
  const iy = Math.min(n - 1, Math.max(0, Math.floor(faceUv.v * n)));
  return (faceUv.face * n + iy) * n + ix;
}

/** Unit direction of a point in a cell; (u, v) = (0.5, 0.5) is its center. */
export function cellDirection(cell: number, u: number, v: number, out = new Vec3d()): Vec3d {
  const n = STRIKE_CELLS;
  const ix = cell % n;
  const iy = Math.floor(cell / n) % n;
  const face = Math.floor(cell / (n * n)) as CubeFace;
  return cubeFaceUvToDirection(face, (ix + u) / n, (iy + v) / n, out);
}

/**
 * The cells that have a point within `range` (m, along the ground) of a
 * direction on a planet of `radius`, in ascending order.
 */
export function cellsNear(direction: Readonly<Vec3d>, range: Meters, radius: Meters): number[] {
  const up = new Vec3d().copy(direction).normalize();
  const east = new Vec3d(0, 1, 0).cross(up);
  if (east.length() < 1e-6) east.set(1, 0, 0);
  east.normalize();
  const north = up.clone().cross(east);
  // A third of a cell's width: no cell slips between the samples.
  const step = ((Math.PI / 2) * radius) / STRIKE_CELLS / 3;
  const n = Math.ceil(range / step);
  const found = new Set<number>();
  const d = new Vec3d();
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      if ((i * i + j * j) * step * step > range * range) continue;
      const a = Math.hypot(i, j) * (step / radius);
      // A point at the angle a from `up` along the tangent (i, j).
      const s = a > 0 ? Math.sin(a) / Math.hypot(i, j) : 0;
      d.copy(up)
        .scale(Math.cos(a))
        .addScaled(east, i * s)
        .addScaled(north, j * s);
      found.add(strikeCell(d));
    }
  }
  return [...found].sort((p, q) => p - q);
}

const strikePoint = new Vec3d();

/**
 * The strike of a cell in a time slot, or null if there is none: a pure
 * function of the seed (`strikeSeed`), the cell, the slot and the weather at
 * the strike's place at the start of the slot.
 */
export function strikeAt(
  seed: number,
  cell: number,
  slot: number,
  view: WeatherView,
): Strike | null {
  const h = hash4(seed, cell, slot, 0);
  const draw = h * UNIT;
  // Most pairs fail against the highest rate there is, before the weather is read.
  if (draw >= PEAK_FLASH_RATE * STRIKE_SLOT) return null;
  const next = sequence(hash4(seed, cell, slot, 1));
  const direction = cellDirection(cell, next(), next(), strikePoint);
  const start = slot * STRIKE_SLOT;
  const storm = view.sample(Channel.Storm, direction, start);
  if (!(draw < flashRate(storm) * STRIKE_SLOT)) return null;

  const time = start + next() * STRIKE_SLOT;
  const ground = next() < CLOUD_TO_GROUND_SHARE;
  // Most strikes are moderate, a few are very bright.
  const energy = 0.35 + 0.65 * Math.pow(next(), 1.6) * (0.6 + 0.4 * storm);
  const count = 1 + Math.floor(next() * next() * 4);
  const strokes: Stroke[] = [];
  let offset = 0;
  let end = 0;
  for (let k = 0; k < count; k++) {
    if (k > 0) offset += 0.04 + 0.07 * next();
    // The first stroke is the brightest of a ground strike; a cloud flash pulses evenly.
    const peak = k === 0 ? 1 : ground ? 0.35 + 0.5 * next() : 0.55 + 0.45 * next();
    const decay = ground ? 0.018 + 0.03 * next() : 0.05 + 0.07 * next();
    strokes.push({ offset, peak, decay });
    end = Math.max(end, offset + 5 * decay);
  }
  return {
    cell,
    slot,
    time,
    direction: direction.clone(),
    ground,
    energy,
    storm,
    height: ground ? 0 : 1000 + 4000 * next(),
    strokes,
    duration: Math.min(STRIKE_MAX_DURATION, end),
    seed: hash4(seed, cell, slot, 2),
  };
}

/** Brightness 0..1 of a strike at `age` seconds after its start: its strokes' peaks and their decay. */
export function strikeIntensity(strike: Strike, age: Seconds): number {
  if (!(age >= 0) || age > strike.duration) return 0;
  // Each stroke adds its light to what is left of the ones before, so every stroke is a jump.
  let light = 0;
  for (const s of strike.strokes) {
    const t = age - s.offset;
    if (t < 0) break;
    light += s.peak * Math.exp(-t / s.decay);
  }
  // The glow ends at the strike's end, not in a step.
  const tail = Math.min(1, (strike.duration - age) / 0.03);
  return Math.min(1, light) * tail;
}

/**
 * The strikes of the given cells that start in the game-time interval
 * (from, to], in order of time. Read the weather the view holds: both times
 * should lie within its two frames.
 */
export function strikesBetween(
  seed: number,
  cells: readonly number[],
  view: WeatherView,
  from: GameTime,
  to: GameTime,
): Strike[] {
  const out: Strike[] = [];
  if (!(to > from) || !view.ready) return out;
  const first = Math.floor(from / STRIKE_SLOT);
  const last = Math.floor(to / STRIKE_SLOT);
  for (let slot = first; slot <= last; slot++) {
    for (const cell of cells) {
      const s = strikeAt(seed, cell, slot, view);
      if (s && s.time > from && s.time <= to) out.push(s);
    }
  }
  return out.sort((a, b) => a.time - b.time || a.cell - b.cell);
}

/** The strikes of the given cells that are under way at a game time. */
export function strikesAt(
  seed: number,
  cells: readonly number[],
  view: WeatherView,
  time: GameTime,
): Strike[] {
  return strikesBetween(seed, cells, view, time - STRIKE_MAX_DURATION, time).filter(
    (s) => time - s.time <= s.duration,
  );
}

// ---- Bolt geometry ----

/** Segments a bolt may have at most (the mesh's capacity). */
export const BOLT_MAX_SEGMENTS = 320;
/** Floats per segment in `Bolt.segments`: start xyz, end xyz, brightness, width. */
export const BOLT_SEGMENT_FLOATS = 8;
/** Halvings of the main channel: 2^6 = 64 segments. */
const MAIN_DEPTH = 6;
/** Sideways displacement of a midpoint, as a fraction of its segment's length. */
const JAGGEDNESS = 0.22;

/** A bolt's channel and branches as line segments. */
export interface Bolt {
  /**
   * `count` segments of BOLT_SEGMENT_FLOATS floats in a frame with the ground
   * point at the origin and +Y up (m): start, end, brightness 0..1 (1 on the
   * main channel), relative width (1 on the main channel).
   */
  segments: Float32Array;
  count: number;
  /** Segments of the main channel, the first `mainCount` of them, from the top down. */
  mainCount: number;
  /** The channel's top (m). */
  top: [number, number, number];
}

type P3 = [number, number, number];

/** A polyline from a to b, bent by midpoint displacement: 2^depth segments. */
function jagged(a: P3, b: P3, depth: number, next: () => number): P3[] {
  let points: P3[] = [a, b];
  for (let level = 0; level < depth; level++) {
    const refined: P3[] = [points[0]!];
    for (let i = 0; i + 1 < points.length; i++) {
      const p = points[i]!;
      const q = points[i + 1]!;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const dz = q[2] - p[2];
      const length = Math.hypot(dx, dy, dz);
      // A random direction, made perpendicular to the segment.
      let rx = next() * 2 - 1;
      let ry = next() * 2 - 1;
      let rz = next() * 2 - 1;
      const along = length > 0 ? (rx * dx + ry * dy + rz * dz) / (length * length) : 0;
      rx -= along * dx;
      ry -= along * dy;
      rz -= along * dz;
      const r = Math.hypot(rx, ry, rz) || 1;
      const amount = (JAGGEDNESS * length * (0.4 + 0.6 * next())) / r;
      refined.push([
        (p[0] + q[0]) / 2 + rx * amount,
        (p[1] + q[1]) / 2 + ry * amount,
        (p[2] + q[2]) / 2 + rz * amount,
      ]);
      refined.push(q);
    }
    points = refined;
  }
  return points;
}

/**
 * The shape of a cloud-to-ground bolt from a seed: a main channel from a top
 * `height` meters above the ground point (leaning up to a fifth of that to
 * the side) down to the origin, and branches. Every point lies within
 * `height` of the vertical through the ground point and between the ground
 * and the top.
 */
export function buildBolt(seed: number, height: Meters): Bolt {
  const next = sequence(seed);
  const lean = 0.2 * height * next();
  const bearing = 2 * Math.PI * next();
  const top: P3 = [lean * Math.cos(bearing), height, lean * Math.sin(bearing)];
  const main = jagged(top, [0, 0, 0], MAIN_DEPTH, next);
  // The displacement may carry a midpoint past either end; a channel stays between them.
  for (const p of main) p[1] = Math.min(height, Math.max(0, p[1]));
  main[main.length - 1] = [0, 0, 0];

  const segments = new Float32Array(BOLT_MAX_SEGMENTS * BOLT_SEGMENT_FLOATS);
  let count = 0;
  const push = (p: P3, q: P3, brightness: number, width: number) => {
    if (count >= BOLT_MAX_SEGMENTS) return;
    segments.set([p[0], p[1], p[2], q[0], q[1], q[2], brightness, width], count * 8);
    count++;
  };
  for (let i = 0; i + 1 < main.length; i++) push(main[i]!, main[i + 1]!, 1, 1);
  const mainCount = count;

  /** A branch from a point, continuing `direction` turned aside, `length` long. */
  const branch = (from: P3, direction: P3, length: number, brightness: number, depth: number) => {
    // Turn 20° to 50° away from the channel, about a random axis, and keep going down.
    const angle = (20 + 30 * next()) * (Math.PI / 180);
    const spin = 2 * Math.PI * next();
    const dl = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const d: P3 = [direction[0] / dl, direction[1] / dl, direction[2] / dl];
    // Two unit vectors perpendicular to d.
    let ux = d[1];
    let uy = -d[0];
    let uz = 0;
    if (Math.hypot(ux, uy) < 1e-3) {
      ux = 0;
      uy = d[2];
      uz = -d[1];
    }
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = d[1] * uz - d[2] * uy;
    const vy = d[2] * ux - d[0] * uz;
    const vz = d[0] * uy - d[1] * ux;
    const c = Math.cos(spin) * Math.sin(angle);
    const s = Math.sin(spin) * Math.sin(angle);
    const out: P3 = [
      d[0] * Math.cos(angle) + ux * c + vx * s,
      d[1] * Math.cos(angle) + uy * c + vy * s,
      d[2] * Math.cos(angle) + uz * c + vz * s,
    ];
    // Branches lead down: one that would climb is mirrored.
    if (out[1] > -0.35) out[1] = -0.35 - 0.5 * Math.abs(out[1]);
    // It dies out above the ground.
    const reach = Math.min(length, (0.9 * from[1]) / -out[1]);
    if (reach < 0.02 * height) return;
    const end: P3 = [from[0] + out[0] * reach, from[1] + out[1] * reach, from[2] + out[2] * reach];
    const points = jagged(from, end, depth, next);
    for (const p of points) p[1] = Math.min(height, Math.max(0.02 * height, p[1]));
    points[0] = from;
    const n = points.length - 1;
    for (let i = 0; i < n; i++) {
      // Fainter and thinner toward the tip.
      const fade = 1 - (i + 0.5) / n;
      push(points[i]!, points[i + 1]!, brightness * (0.35 + 0.65 * fade), 0.45 + 0.3 * fade);
    }
    if (depth > 2 && next() < 0.6) {
      const k = 1 + Math.floor(next() * (n - 2));
      const p = points[k]!;
      const q = points[k + 1]!;
      branch(p, [q[0] - p[0], q[1] - p[1], q[2] - p[2]], reach * 0.5, brightness * 0.6, depth - 1);
    }
  };

  const branches = 3 + Math.floor(next() * 5);
  for (let b = 0; b < branches; b++) {
    // From the upper four fifths of the channel.
    const k = 2 + Math.floor(next() * (mainCount * 0.8 - 2));
    const p = main[k]!;
    const q = main[k + 1]!;
    const length = (0.12 + 0.3 * next()) * height;
    branch(p, [q[0] - p[0], q[1] - p[1], q[2] - p[2]], length, 0.5, 4);
  }
  return { segments, count, mainCount, top };
}
