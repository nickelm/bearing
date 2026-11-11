/**
 * River coverage per fragment from vector data (decision 46): the distance
 * to the nearest bank among a mesh's list of segments (riverTables.ts).
 *
 * Coverage is the fraction of the pixel over water, from the signed distance
 * to the bank in pixels. A river narrower than `minPixels` is drawn that wide,
 * with its coverage scaled toward its true pixel fraction by `legibility`
 * (0 = physically faint, 1 = full strength). Thin rivers then stay continuous
 * and readable from altitude rather than breaking into dashes. Distances are
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
  storage,
  uniform,
} from 'three/tsl';
import type { RiverTables } from './riverTables';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** How rivers are drawn; shared across materials, so GUI settings survive world changes. */
export class RiverStyle {
  /** Narrowest drawn river, in pixels. */
  readonly minPixels = uniform(2);
  /** How strongly sub-pixel rivers are drawn: 0 = their true pixel fraction, 1 = full. */
  readonly legibility = uniform(0.8);
}

export class RiverShading {
  readonly minPixels;
  readonly legibility;
  private readonly segments;
  private readonly lists;

  constructor(
    tables: RiverTables | null,
    private readonly radius: number,
    style = new RiverStyle(),
  ) {
    this.minPixels = style.minPixels;
    this.legibility = style.legibility;
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
   * Water coverage 0..1 at a planet-centered position, from `count` segments
   * starting at `start` in the list buffer. `footprint` is meters per pixel
   * (a variable computed outside any branch). The loop runs only where
   * `gate` holds (default: everywhere).
   */
  coverage(planetPosition: V3, start: F, count: F, footprint: F, gate?: Node<'bool'>): F {
    return Fn(() => {
      const p = normalize(planetPosition);
      const fp = max(footprint, 0.05);
      const cover = float(0).toVar();
      const first = int(start);
      const end = gate ? select(gate, int(count), int(0)) : int(count);
      Loop({ start: int(0), end, type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.segments.element(id.mul(2));
        const b = this.segments.element(id.mul(2).add(1));
        const ab = b.xyz.sub(a.xyz);
        const t = clamp(dot(p.sub(a.xyz), ab).div(max(dot(ab, ab), 1e-20)), 0, 1);
        const d = length(p.sub(a.xyz.add(ab.mul(t)))).mul(this.radius);
        const halfWidth = mix(a.w, b.w, t);
        // At least minPixels wide, with coverage scaled toward the true fraction.
        const drawn = max(halfWidth, fp.mul(this.minPixels).mul(0.5));
        const strength = mix(min(halfWidth.div(drawn), 1), float(1), this.legibility);
        const c = clamp(float(0.5).sub(d.sub(drawn).div(fp)), 0, 1).mul(strength);
        cover.assign(max(cover, c));
      });
      return cover;
    })() as F;
  }
}
