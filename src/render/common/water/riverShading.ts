/**
 * River coverage per fragment from vector data (decision 46): the distance
 * to the nearest bank among a mesh's list of segments (riverTables.ts).
 *
 * Coverage is the fraction of the pixel over water, from the signed distance
 * to the bank in pixels. A river narrower than `minPixels` is drawn that wide,
 * with its coverage scaled toward its true pixel fraction by `legibility`
 * (0 = physically faint, 1 = full strength). Thin rivers then stay continuous
 * and readable from altitude rather than breaking into dashes. The true pixel
 * fraction comes alongside, for reflections: a widened river's color is a
 * legibility aid, but only its real water reflects the sun (decision 120). Distances are
 * taken on the unit sphere (float32 unit vectors resolve about 6 cm at
 * R = 1,000 km).
 *
 * Natural banks (decision 167): the coverage comes from the nearest river
 * (the least distance to a bank among the listed segments), and where that
 * river is drawn near its true width its banks are moved by noise fixed to the
 * planet: the channel wanders sideways about ten widths along, its width
 * swells and narrows, and both edges are ragged at a few widths and finer.
 * The noise's wavelengths follow the river's width by octaves, blended, so the
 * pattern does not swim where the width changes; its lattice hash is periodic
 * only over 289 cells, so it does not tile. Distant and widened rivers keep
 * their smooth lines, which would otherwise shimmer.
 */
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  cross,
  dot,
  exp2,
  floor,
  fract,
  If,
  log2,
  float,
  Fn,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  select,
  sign,
  smoothstep,
  storage,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { RiverTables } from './riverTables';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** How rivers are drawn; shared across materials, so GUI settings survive world changes. */
export class RiverStyle {
  /** Narrowest drawn river, in pixels. */
  readonly minPixels = uniform(2);
  /** How strongly sub-pixel rivers are drawn: 0 = their true pixel fraction, 1 = full. */
  readonly legibility = uniform(0.8);
  /** White water along the banks of fast reaches (0 = none; decision 146). */
  readonly whiteWater = uniform(1);
  /** Darker wet bank along rivers drawn at their true width (0 = none; Part I, decision 146). */
  readonly bank = uniform(1);
  /** Natural banks: wander, swelling and ragged edges (0 = smooth lines; decision 167). */
  readonly natural = uniform(1);
}

/**
 * Bank noise (decision 167): amplitudes as shares of the half-width, wavelengths
 * in half-widths. The blended value noise has a standard deviation of about
 * 0.22 and peaks near ±0.55, so typical displacements are about a quarter of
 * these factors: the course swings about one half-width (at most `wanderMax`
 * times the noise), the width varies by about 13%, the edges by a few percent.
 */
export const NATURAL_BANKS = {
  /** Sideways wander: swing (share of the half-width, at most `wanderMax` m), wavelength. */
  wander: 4,
  wanderMax: 40,
  wanderWavelength: 20,
  /** Swelling and narrowing of the width. */
  swell: 0.6,
  swellWavelength: 12,
  /** Ragged edges, two octaves. */
  rough: 0.35,
  roughWavelength: 3,
  fine: 0.18,
  fineWavelength: 1,
};

/** Ashima's permutation polynomial: exact in float32 for integers below 289. */
function permute(x: F): F {
  return x.mul(34).add(1).mul(x).mod(289) as F;
}

/** A lattice point's hash in [0, 1), periodic over 289 cells per axis. */
function latticeHash(c: V3): F {
  const m = c.sub(floor(c.div(289)).mul(289));
  return permute(permute(permute(m.x).add(m.y)).add(m.z)).div(289) as F;
}

/**
 * Value noise in [-1, 1] at planet-centered `p` (m) on a lattice of `cell` m.
 * float32 positions resolve about 6 cm at 1,000 km, plenty for cells of meters up.
 */
export function bankNoise(p: V3, cell: F, salt: number): F {
  const q = p.div(cell).add(vec3(salt * 17.13, salt * 31.7, salt * 7.31));
  const i = floor(q);
  const f = fract(q);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const at = (dx: number, dy: number, dz: number) => latticeHash(i.add(vec3(dx, dy, dz)) as V3);
  const x00 = mix(at(0, 0, 0), at(1, 0, 0), u.x);
  const x10 = mix(at(0, 1, 0), at(1, 1, 0), u.x);
  const x01 = mix(at(0, 0, 1), at(1, 0, 1), u.x);
  const x11 = mix(at(0, 1, 1), at(1, 1, 1), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z)
    .mul(2)
    .sub(1) as F;
}

/**
 * Noise at wavelength `lambda` (m, any value): the two power-of-two octaves
 * around it, blended by where it falls between them, so a river whose width
 * changes keeps its pattern in place instead of stretching it.
 */
export function bandNoise(p: V3, lambda: F, salt: number): F {
  const b = log2(max(lambda, 1));
  const lo = exp2(floor(b));
  const f = fract(b);
  return mix(bankNoise(p, lo, salt), bankNoise(p, lo.mul(2), salt + 1), f) as F;
}

export class RiverShading {
  readonly minPixels;
  readonly legibility;
  readonly whiteWater;
  readonly bank;
  readonly natural;
  private readonly segments;
  private readonly lists;

  constructor(
    tables: RiverTables | null,
    private readonly radius: number,
    style = new RiverStyle(),
  ) {
    this.minPixels = style.minPixels;
    this.legibility = style.legibility;
    this.whiteWater = style.whiteWater;
    this.bank = style.bank;
    this.natural = style.natural;
    const segs = tables?.segments ?? new Float32Array(8);
    const lists = tables?.lists ?? new Uint32Array(1);
    this.segments = storage(
      new StorageBufferAttribute(segs, 4),
      'vec4',
      segs.length / 4,
    ).toReadOnly();
    this.lists = storage(new StorageBufferAttribute(lists, 1), 'uint', lists.length).toReadOnly();
  }

  /**
   * River coverage at a planet-centered position, from `count` segments starting
   * at `start` in the list buffer. `footprint` is meters per pixel (a variable
   * computed outside any branch); the loop runs only where `gate` holds.
   *
   * - x: water as drawn (widened and strengthened by the style);
   * - y: the true pixel fraction (legibility 0), for reflections (decision 120);
   * - z: white water on fast reaches (decision 147);
   * - w: the dark, wet bank just outside the water.
   *
   * White water, the bank and natural banks show only where a river is drawn near
   * its true width: a river widened for legibility would glitter or thicken with them.
   */
  coverage(planetPosition: V3, start: F, count: F, footprint: F, gate?: Node<'bool'>): V4 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const fp = max(footprint, 0.05);
      const minHalf = fp.mul(this.minPixels).mul(0.5);
      // The nearest river: least distance to its drawn bank.
      const best = float(1e9).toVar();
      const bestSigned = float(0).toVar();
      const bestHalf = float(0).toVar();
      const bestGradient = float(0).toVar();
      const first = int(start);
      const end = gate ? select(gate, int(count), int(0)) : int(count);
      Loop({ start: int(0), end, type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.segments.element(id.mul(2));
        const b = this.segments.element(id.mul(2).add(1));
        // Endpoints may carry 1 + the reach's gradient as their length.
        const la = length(a.xyz);
        const ua = a.xyz.div(la);
        const ub = b.xyz.div(length(b.xyz));
        const ab = ub.sub(ua);
        const t = clamp(dot(p.sub(ua), ab).div(max(dot(ab, ab), 1e-20)), 0, 1);
        const off = p.sub(ua.add(ab.mul(t)));
        const d = length(off).mul(this.radius);
        const halfWidth = mix(a.w, b.w, t);
        const toBank = d.sub(max(halfWidth, minHalf));
        If(toBank.lessThan(best), () => {
          best.assign(toBank);
          // Which side of the centerline: the offset from the nearest point against the
          // segment's sideways direction. Not p · (ua × ub): near a river that product is
          // about 1e-9, below float32's rounding of the cross product, and the side flipped
          // at random, which split rivers in two under the wander.
          bestSigned.assign(
            d.mul(
              sign(dot(off, cross(ua, ab)))
                .add(0.5)
                .sign(),
            ),
          );
          bestHalf.assign(halfWidth);
          bestGradient.assign(la.sub(1));
        });
      });
      const cover = float(0).toVar();
      const physical = float(0).toVar();
      const white = float(0).toVar();
      const bank = float(0).toVar();
      const N = NATURAL_BANKS;
      // Only near a river: within its drawn width, the widest wander and the bank band.
      If(best.lessThan(max(bestHalf.mul(1.6), N.wanderMax).add(fp.mul(2)).add(10)), () => {
        const halfWidth = bestHalf;
        const drawnBase = max(halfWidth, minHalf);
        const fraction = min(halfWidth.div(drawnBase), 1);
        const strength = mix(fraction, float(1), this.legibility);
        // Drawn at its true width, and wide enough on screen for an edge to read.
        const resolved = smoothstep(0.7, 1, fraction).mul(
          smoothstep(3, 8, halfWidth.mul(2).div(fp)),
        );
        // Natural banks where resolved; ragged detail only once it spans a few pixels.
        const nat = resolved.mul(this.natural).toVar();
        const offset = float(0).toVar();
        const swell = float(1).toVar();
        const rough = float(0).toVar();
        If(nat.greaterThan(0), () => {
          offset.assign(
            nat.mul(min(halfWidth.mul(N.wander), N.wanderMax)).mul(
              bandNoise(planetPosition, halfWidth.mul(N.wanderWavelength), 0)
                .mul(0.75)
                .add(
                  bandNoise(planetPosition, halfWidth.mul(N.wanderWavelength / 2.3), 12).mul(0.35),
                ),
            ),
          );
          swell.assign(
            nat
              .mul(N.swell)
              .mul(bandNoise(planetPosition, halfWidth.mul(N.swellWavelength), 3))
              .add(1),
          );
          const roughLambda = halfWidth.mul(N.roughWavelength);
          const fineLambda = halfWidth.mul(N.fineWavelength);
          rough.assign(
            nat.mul(halfWidth).mul(
              bandNoise(planetPosition, roughLambda, 6)
                .mul(N.rough)
                .mul(smoothstep(4, 10, roughLambda.div(fp)))
                .add(
                  bandNoise(planetPosition, fineLambda, 9)
                    .mul(N.fine)
                    .mul(smoothstep(4, 10, fineLambda.div(fp))),
                ),
            ),
          );
        });
        const drawn = max(halfWidth.mul(swell), minHalf);
        // Distance from the moved centerline, less the ragged edge.
        const d = abs(bestSigned.sub(offset)).sub(rough);
        const shape = clamp(float(0.5).sub(d.sub(drawn).div(fp)), 0, 1);
        cover.assign(shape.mul(strength));
        physical.assign(shape.mul(fraction));
        // Fast water from a bed gradient of about 0.8% (riffles) to 3% (white throughout);
        // on seed 1983 a quarter of the rivers 20–50 m wide and 2% of those over 150 m.
        const rapid = smoothstep(0.008, 0.03, bestGradient);
        // Within a band at the banks a sixth of the width wide (at least 4 m and a pixel).
        const edgeWidth = max(max(halfWidth.mul(0.33), 4), fp);
        const edge = float(1).sub(smoothstep(0, 1, drawn.sub(d).div(edgeWidth)));
        // The weight of white water; the terrain shader breaks it into churning foam.
        const foam = max(edge, rapid.mul(0.5)).mul(rapid).mul(resolved).mul(shape);
        white.assign(foam.mul(this.whiteWater));
        // The bank: a band outside the water, an eighth of the width (1.5–10 m, at least a
        // pixel), wider and narrower along the river where the banks are natural.
        const bankWidth = max(
          clamp(halfWidth.mul(0.25), 1.5, 10).mul(swell.sub(1).mul(2).add(1)),
          fp,
        );
        const outer = clamp(float(0.5).sub(d.sub(drawn.add(bankWidth)).div(fp)), 0, 1);
        bank.assign(outer.sub(shape).max(0).mul(resolved).mul(this.bank));
      });
      // No bank under the water.
      return vec4(cover, physical, white, bank.mul(float(1).sub(cover)));
    })() as V4;
  }
}
