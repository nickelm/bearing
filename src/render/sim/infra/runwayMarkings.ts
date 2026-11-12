/**
 * Runway and taxiway markings in the pavement shader (V3; visual-style Part I,
 * _Bases_). Paint is drawn in the terrain fragment shader over the concrete,
 * from the airbase's light record (decision 71's per-tile light lists), so no
 * mesh or per-tile uniform is added.
 *
 * Layout (ICAO-like, slightly bolder than life so it reads from a few hundred
 * meters). Each runway end has its own reading frame: `u` from the threshold
 * into the runway, `v` to the right of a pilot landing there.
 *
 * - White, per end: threshold bars (five each side of the centerline), the
 *   two-digit designation in seven-segment figures, and the aiming-point
 *   blocks; side stripes along both edges and centerline dashes between the
 *   designations.
 * - Yellow: the taxiway centerline and its links to the runway ends and the
 *   apron.
 *
 * The layout is data (`RUNWAY_BOXES`, `DIGIT_SEGMENTS`) read by both the
 * shader and the CPU twin `markingAt`, which the tests check.
 */
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  cross,
  dot,
  float,
  floor,
  Fn,
  fract,
  If,
  max,
  min,
  mod,
  normalize,
  round,
  select,
  sin,
  cos,
  vec3,
} from 'three/tsl';
import {
  APRON_LINK_ALONG,
  APRON_OFFSET,
  APRON_WIDTH,
  RUNWAY_WIDTH,
  TAXIWAY_OFFSET,
} from './infraScene';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Box [u0, u1, v0, v1] in an end's reading frame (m). */
export type MarkBox = readonly [number, number, number, number];

const HALF_WIDTH = RUNWAY_WIDTH / 2;

/** White boxes painted at every runway end (threshold bars, aiming points). */
export const RUNWAY_BOXES: readonly MarkBox[] = [
  // Threshold bars: 1.8 m wide on 3.6 m centers, 30 m long, a gap at the centerline.
  ...[0, 1, 2, 3, 4].flatMap((k): MarkBox[] => {
    const c = 3.9 + 3.6 * k;
    return [
      [6, 36, c - 0.9, c + 0.9],
      [6, 36, -c - 0.9, -c + 0.9],
    ];
  }),
  // Aiming-point blocks.
  [300, 350, 5, 14],
  [300, 350, -14, -5],
];

/** Designation figures: bottom edge at DIGIT_U, height and width (m), centers at ±DIGIT_V. */
export const DIGIT_U = 48;
export const DIGIT_HEIGHT = 18;
export const DIGIT_WIDTH = 8;
export const DIGIT_STROKE = 2;
export const DIGIT_V = 6;

/**
 * Seven segments (a–g) as boxes [y0, y1, x0, x1] in a figure's frame: y up
 * from its bottom edge, x right from its center.
 */
const H = DIGIT_HEIGHT;
const W = DIGIT_WIDTH / 2;
const S = DIGIT_STROKE;
export const DIGIT_SEGMENTS: readonly MarkBox[] = [
  [H - S, H, -W, W], // a: top
  [H / 2, H, W - S, W], // b: top right
  [0, H / 2, W - S, W], // c: bottom right
  [0, S, -W, W], // d: bottom
  [0, H / 2, -W, -W + S], // e: bottom left
  [H / 2, H, -W, -W + S], // f: top left
  [H / 2 - S / 2, H / 2 + S / 2, -W, W], // g: middle
];

/** Segment masks (bit k = segment k of a–g) for the figures 0–9. */
export const DIGIT_MASKS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f] as const;

/** Side stripes: inner and outer offset from the centerline (m). */
export const SIDE_STRIPE: readonly [number, number] = [HALF_WIDTH - 1.9, HALF_WIDTH - 1];
/** Centerline dashes: half-width, dash and period (m), and the clear zone at each end. */
export const CENTERLINE = { half: 0.6, dash: 30, period: 50, clear: DIGIT_U + DIGIT_HEIGHT + 12 };
/** Yellow taxi line half-width (m). */
export const TAXI_LINE_HALF = 0.6;
/** Taxiway ends along the runway (m in from each runway end). */
export const TAXIWAY_INSET = 150;

/**
 * The runway's designations (1–36) at its two ends from its heading (rad
 * clockwise from north): the end at −L/2 is landed on heading `heading`.
 */
export function runwayNumbers(heading: number): [number, number] {
  const deg = (((heading * 180) / Math.PI) % 360) + 360;
  let a = Math.round((deg % 360) / 10) % 36;
  if (a === 0) a = 36;
  const b = a > 18 ? a - 18 : a + 18;
  return [a, b];
}

const inBox = (u: number, v: number, b: MarkBox) =>
  u >= b[0] && u <= b[1] && v >= b[2] && v <= b[3];

/**
 * The paint at (along, across) on a runway of length L and heading h, in the
 * runway frame (across to the right of the heading): CPU twin of the shader.
 */
export function markingAt(
  along: number,
  across: number,
  length: number,
  heading: number,
): 'white' | 'yellow' | null {
  const half = length / 2;
  // Yellow: the taxiway centerline, its links to the runway ends and to the apron.
  const tEnd = half - TAXIWAY_INSET;
  if (Math.abs(across - TAXIWAY_OFFSET) <= TAXI_LINE_HALF && Math.abs(along) <= tEnd)
    return 'yellow';
  if (
    Math.abs(Math.abs(along) - tEnd) <= TAXI_LINE_HALF &&
    across >= HALF_WIDTH + 6 &&
    across <= TAXIWAY_OFFSET
  )
    return 'yellow';
  const apronEdge = APRON_OFFSET - APRON_WIDTH / 2;
  if (
    Math.abs(Math.abs(along) - APRON_LINK_ALONG) <= TAXI_LINE_HALF &&
    across >= TAXIWAY_OFFSET &&
    across <= apronEdge + 20
  )
    return 'yellow';
  if (Math.abs(along) > half || Math.abs(across) > HALF_WIDTH) return null;
  const a = Math.abs(across);
  if (a >= SIDE_STRIPE[0] && a <= SIDE_STRIPE[1]) return 'white';
  const end = along < 0 ? 0 : 1;
  const u = half - Math.abs(along);
  const v = end === 0 ? across : -across;
  for (const b of RUNWAY_BOXES) if (inBox(u, v, b)) return 'white';
  const n = runwayNumbers(heading)[end];
  const figures = [Math.floor(n / 10), n % 10];
  for (let k = 0; k < 2; k++) {
    const mask = DIGIT_MASKS[figures[k]!]!;
    const y = u - DIGIT_U;
    const x = v - (k === 0 ? -DIGIT_V : DIGIT_V);
    for (let s = 0; s < 7; s++)
      if (mask & (1 << s) && inBox(y, x, DIGIT_SEGMENTS[s]!)) return 'white';
  }
  if (u > CENTERLINE.clear && a <= CENTERLINE.half) {
    const t = (((along + half) % CENTERLINE.period) + CENTERLINE.period) % CENTERLINE.period;
    if (t < CENTERLINE.dash) return 'white';
  }
  return null;
}

/** Antialiased cover of [lo, hi] at x by a pixel `fp` m wide; thin marks fade to their share. */
function band(x: F, lo: number | F, hi: number | F, fp: F): F {
  const l = typeof lo === 'number' ? float(lo) : lo;
  const h = typeof hi === 'number' ? float(hi) : hi;
  const inside = min(x.sub(l), h.sub(x));
  return clamp(inside.div(fp).add(0.5), 0, 1).mul(min(h.sub(l).div(fp), 1)) as F;
}

const boxCover = (u: F, v: F, b: MarkBox, fp: F): F =>
  band(u, b[0], b[1], fp).mul(band(v, b[2], b[3], fp)) as F;

/** Bit k of a figure's segment mask, as 0 or 1 (float arithmetic; no integer ops). */
function maskBit(digit: F, k: number): F {
  let m: F = float(DIGIT_MASKS[0]);
  for (let d = 1; d < 10; d++) m = select(digit.equal(d), float(DIGIT_MASKS[d]), m) as F;
  return mod(floor(m.div(2 ** k)), 2) as F;
}

/** Cover of a two-digit designation `n` at (u, v) in an end's reading frame. */
function designation(u: F, v: F, n: F, fp: F): F {
  const tens = floor(n.div(10));
  const ones = n.sub(tens.mul(10));
  let c: F = float(0);
  const y = u.sub(DIGIT_U) as F;
  for (const [k, digit] of [tens, ones].entries()) {
    const x = v.sub(k === 0 ? -DIGIT_V : DIGIT_V) as F;
    for (let s = 0; s < 7; s++) {
      c = max(c, boxCover(y, x, DIGIT_SEGMENTS[s]!, fp).mul(maskBit(digit as F, s))) as F;
    }
  }
  return c;
}

/**
 * Signed paint cover at unit direction `p` of an airfield centered at unit
 * direction `center` with runway code `code` (encodeRunway): positive for
 * white, negative for yellow. `radius` is the planet's, `fp` the pixel
 * footprint (m).
 */
export function runwayMarks(p: V3, center: V3, code: F, radius: number, fp: F): F {
  return Fn(() => {
    const length = floor(code);
    const heading = code.sub(length).mul(4);
    const east = normalize(cross(vec3(0, 1, 0), center));
    const north = cross(center, east);
    const s = sin(heading);
    const k = cos(heading);
    const fwd = east.mul(s).add(north.mul(k));
    const right = east.mul(k).sub(north.mul(s));
    const d = p.sub(center);
    const along = dot(d, fwd).mul(radius).toVar();
    const across = dot(d, right).mul(radius).toVar();
    const half = length.mul(0.5);
    const white = float(0).toVar();
    const yellow = float(0).toVar();
    // Only near the runway, taxiway and apron links.
    If(
      abs(along)
        .lessThan(half.add(20))
        .and(across.greaterThan(-HALF_WIDTH - 5))
        .and(across.lessThan(APRON_OFFSET)),
      () => {
        // Taxi lines.
        const tEnd = half.sub(TAXIWAY_INSET);
        const aAlong = abs(along) as F;
        const taxi = band(
          across,
          TAXIWAY_OFFSET - TAXI_LINE_HALF,
          TAXIWAY_OFFSET + TAXI_LINE_HALF,
          fp,
        ).mul(band(aAlong, -1, tEnd, fp));
        const link = band(aAlong, tEnd.sub(TAXI_LINE_HALF), tEnd.add(TAXI_LINE_HALF), fp).mul(
          band(across, HALF_WIDTH + 6, TAXIWAY_OFFSET, fp),
        );
        const apron = band(
          aAlong,
          APRON_LINK_ALONG - TAXI_LINE_HALF,
          APRON_LINK_ALONG + TAXI_LINE_HALF,
          fp,
        ).mul(band(across, TAXIWAY_OFFSET, APRON_OFFSET - APRON_WIDTH / 2 + 20, fp));
        yellow.assign(max(taxi, max(link, apron)));
        If(abs(across).lessThan(HALF_WIDTH), () => {
          // Reading frame of the nearer end.
          const u = half.sub(aAlong) as F;
          const v = select(along.lessThan(0), across, across.negate()) as F;
          const a = abs(across) as F;
          let c: F = band(a, SIDE_STRIPE[0], SIDE_STRIPE[1], fp);
          for (const b of RUNWAY_BOXES) c = max(c, boxCover(u, v, b, fp)) as F;
          // Designation: heading in tens of degrees, 36 for north; +18 at the far end.
          const first = mod(round(heading.mul(18 / Math.PI)).add(35), 36).add(1);
          const n = select(
            along.lessThan(0),
            first,
            select(first.greaterThan(18), first.sub(18), first.add(18)),
          ) as F;
          c = max(c, designation(u, v, n, fp)) as F;
          // Centerline dashes, faded to their duty cycle where pixels outgrow them.
          const t = fract(along.add(half).div(CENTERLINE.period)).mul(CENTERLINE.period) as F;
          const dashes = band(t, 0, CENTERLINE.dash, fp);
          const resolved = clamp(float(CENTERLINE.period).div(fp).sub(1), 0, 1);
          const dash = dashes
            .mul(resolved)
            .add(float(CENTERLINE.dash / CENTERLINE.period).mul(float(1).sub(resolved)));
          c = max(
            c,
            band(a, -CENTERLINE.half, CENTERLINE.half, fp)
              .mul(dash)
              .mul(clamp(u.sub(CENTERLINE.clear).div(fp).add(0.5), 0, 1)),
          ) as F;
          // Nothing beyond the runway's ends.
          white.assign(c.mul(clamp(u.div(fp).add(0.5), 0, 1)));
        });
      },
    );
    return white.sub(yellow.mul(float(1).sub(white)));
  })() as F;
}
