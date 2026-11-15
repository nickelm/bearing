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
 */
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  dot,
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
  smoothstep,
  storage,
  uniform,
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
}

export class RiverShading {
  readonly minPixels;
  readonly legibility;
  readonly whiteWater;
  readonly bank;
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
  X
   * - w: the dark, wet bank just outside the water.
   *
   * White water and the bank show only where a river is drawn near its true width:
   * a river widened for legibility would glitter or thicken with them.
   */
  coverage(planetPosition: V3, start: F, count: F, footprint: F, gate?: Node<'bool'>): V4 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const fp = max(footprint, 0.05);
      const cover = float(0).toVar();
      const physical = float(0).toVar();
      const white = float(0).toVar();
      const bank = float(0).toVar();
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
        const d = length(p.sub(ua.add(ab.mul(t)))).mul(this.radius);
        const halfWidth = mix(a.w, b.w, t);
        // At least minPixels wide, with coverage scaled toward the true fraction.
        const drawn = max(halfWidth, fp.mul(this.minPixels).mul(0.5));
        const fraction = min(halfWidth.div(drawn), 1);
        const strength = mix(fraction, float(1), this.legibility);
        const shape = clamp(float(0.5).sub(d.sub(drawn).div(fp)), 0, 1);
        cover.assign(max(cover, shape.mul(strength)));
        physical.assign(max(physical, shape.mul(fraction)));
        // Drawn at its true width, and wide enough on screen for an edge to read.
        const resolved = smoothstep(0.7, 1, fraction).mul(
          smoothstep(3, 8, halfWidth.mul(2).div(fp)),
        );
        // Fast water from a bed gradient of about 0.8% (riffles) to 3% (white throughout);
        // on seed 1983 a quarter of the rivers 20–50 m wide and 2% of those over 150 m.
        const rapid = smoothstep(0.008, 0.03, la.sub(1));
        // Within a band at the banks a sixth of the width wide (at least 4 m and a pixel).
        const edgeWidth = max(max(halfWidth.mul(0.33), 4), fp);
        const edge = float(1).sub(smoothstep(0, 1, drawn.sub(d).div(edgeWidth)));
        // The weight of white water; the terrain shader breaks it into churning foam.
        const foam = max(edge, rapid.mul(0.5)).mul(rapid).mul(resolved).mul(shape);
        white.assign(max(white, foam.mul(this.whiteWater)));
        // The bank: a band outside the water, an eighth of the width (1.5–10 m, at least a pixel).
        const bankWidth = max(clamp(halfWidth.mul(0.25), 1.5, 10), fp);
        const outer = clamp(float(0.5).sub(d.sub(drawn.add(bankWidth)).div(fp)), 0, 1);
        bank.assign(max(bank, outer.sub(shape).max(0).mul(resolved).mul(this.bank)));
      });
      // No bank under another channel's water.
      return vec4(cover, physical, white, bank.mul(float(1).sub(cover)));
    })() as V4;
  }
}
