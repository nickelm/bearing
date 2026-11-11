/**
 * Rivers on the strategic map (visual-style Part II, Coasts and water; decision 84).
 *
 * - **Data.** The world's smoothed river segments (decision 46) in two segment tables
 *   (common/water/riverTables.ts): major rivers, at least `MAJOR_MIN_WIDTH` wide,
 *   merged into chords of about 25 km on level-1 tiles, for the coarse tiles of
 *   levels 1–3; and regional rivers, at least `REGIONAL_MIN_WIDTH` wide, in chords of
 *   about 3 km on level-4 tiles, for levels 4–6.
 * - **Narrow rivers** are lines in Part II's river blue, `riverLinePx` wide: 1 px at
 *   25 m, a pixel wider per two doublings of width (discharge, since width is
 *   4·√Q), at most 3.5 px. Minor rivers stay visible at a pixel at any zoom.
 * - **Wide rivers**, whose true width passes about 4 px, take the water treatment of
 *   lakes: the shelf-water fill and the dark outline at their banks (decision 82).
 * - Distances are exact to the segment polylines on the unit sphere, as in the
 *   terrain's rivers, and the loop runs only on dry land.
 *
 * `riverLinePx` is the CPU reference for tests.
 */
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  dot,
  float,
  Fn,
  If,
  int,
  length,
  log2,
  Loop,
  max,
  mix,
  normalize,
  select,
  storage,
  vec2,
} from 'three/tsl';
import type { RiverTables } from '../common/water/riverTables';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Narrowest river in the major-river table (m): discharge above about 225 m³/s. */
export const MAJOR_MIN_WIDTH = 60;
/** Narrowest river in the regional table (m). */
export const REGIONAL_MIN_WIDTH = 15;
/** Line width on screen: 1 px at this width (m), growing by a pixel per factor of 4. */
const LINE_BASE_WIDTH = 25;
const LINE_MAX_PX = 3.5;

/** Screen width (px) of a narrow river `width` meters wide. */
export function riverLinePx(width: number): number {
  return Math.min(
    LINE_MAX_PX,
    Math.max(1, 1 + 0.5 * Math.log2(Math.max(width, 1e-6) / LINE_BASE_WIDTH)),
  );
}

export interface MapRiverSample {
  /** Signed distance (px) from the drawn river's bank; negative inside. */
  edgePx: F;
  /** True width of the nearest river on screen (px). */
  widthPx: F;
}

/** One segment table's buffers, bound for a map material. */
export class MapRiverShading {
  private readonly segments;
  private readonly lists;

  constructor(
    tables: RiverTables | null,
    private readonly radius: number,
  ) {
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
   * The nearest drawn river among `count` segments from `start`, at a planet-centered
   * position; `footprint` is meters per pixel. The loop runs only where `gate` holds.
   */
  sample(planet: V3, start: F, count: F, footprint: F, gate: Node<'bool'>): MapRiverSample {
    const result = Fn(() => {
      const edge = float(1e6).toVar();
      const width = float(0).toVar();
      const p = normalize(planet);
      const fp = max(footprint, 0.05);
      const first = int(start);
      const end = select(gate, int(count), int(0));
      Loop({ start: int(0), end, type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.segments.element(id.mul(2));
        const b = this.segments.element(id.mul(2).add(1));
        const ab = b.xyz.sub(a.xyz);
        const t = clamp(dot(p.sub(a.xyz), ab).div(max(dot(ab, ab), 1e-20)), 0, 1);
        const d = length(p.sub(a.xyz.add(ab.mul(t)))).mul(this.radius);
        const half = mix(a.w, b.w, t);
        // Line width from the true width (riverLinePx), or the true width once wider.
        const linePx = clamp(
          log2(max(half.mul(2), 1e-6).div(LINE_BASE_WIDTH))
            .mul(0.5)
            .add(1),
          1,
          LINE_MAX_PX,
        );
        const drawn = max(half, linePx.mul(fp).mul(0.5));
        const e = d.sub(drawn).div(fp);
        If(e.lessThan(edge), () => {
          edge.assign(e);
          width.assign(half.mul(2).div(fp));
        });
      });
      return vec2(edge, width);
    })();
    return { edgePx: result.x as F, widthPx: result.y as F };
  }
}

/** Coverage 0..1 of the drawn river at a sample. */
export function riverCoverage(s: MapRiverSample): F {
  return clamp(float(0.5).sub(s.edgePx), 0, 1) as F;
}

/** 0 for a line river, 1 for a wide river drawn as water. */
export function riverWideness(s: MapRiverSample): F {
  return clamp(s.widthPx.sub(3).div(2), 0, 1) as F;
}

/** Shorter of two samples' bank distances, with that river's width. */
export function nearerRiver(a: MapRiverSample, b: MapRiverSample): MapRiverSample {
  const useA = a.edgePx.lessThan(b.edgePx);
  return {
    edgePx: select(useA, a.edgePx, b.edgePx) as F,
    widthPx: select(useA, a.widthPx, b.widthPx) as F,
  };
}
