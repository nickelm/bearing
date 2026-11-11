/**
 * The weather grid (decision 68): a cube-sphere lattice of n × n samples per
 * face plus a one-sample border, so a face holds (n + 2)² samples and the
 * border samples lie just across the seam on the neighboring face.
 *
 * Weather fields are evaluated at every sample's own direction, border
 * included, so bilinear interpolation inside one face's lattice is continuous
 * across face seams. The GPU samples the same layout as an (n + 2)² × 6 array
 * texture (render/sim/clouds/weatherTexture.ts).
 *
 * Sample (f, i, j), with i, j in 0..n + 1, sits at face coordinates
 * u = (i − 0.5) / n, v = (j − 0.5) / n (equi-angular, rule 3), and its index is
 * (f · m + j) · m + i with m = n + 2: face-major, row j, column i.
 */
import { CUBE_FACES, directionToFace, projectToCubeFace } from '../../core/coords';
import type { CubeFace, CubeFaceUv } from '../../core/coords';
import { Vec3d } from '../../core/vec3d';

/** Samples per face edge, without the border: about 65 km on a 1,000 km planet. */
export const WEATHER_RESOLUTION = 24;

export class WeatherGrid {
  /** Samples per face edge, border included (n + 2). */
  readonly m: number;
  readonly count: number;
  /** Unit direction per sample, xyz interleaved. */
  readonly directions: Float64Array;
  /** Latitude and longitude per sample (rad). */
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  /** East and north unit vectors per sample, xyz interleaved. */
  readonly east: Float64Array;
  readonly north: Float64Array;
  private readonly uv: CubeFaceUv = { face: 0, u: 0, v: 0 };

  constructor(readonly n: number = WEATHER_RESOLUTION) {
    const m = (this.m = n + 2);
    this.count = 6 * m * m;
    this.directions = new Float64Array(this.count * 3);
    this.east = new Float64Array(this.count * 3);
    this.north = new Float64Array(this.count * 3);
    this.lat = new Float64Array(this.count);
    this.lon = new Float64Array(this.count);
    const d = new Vec3d();
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          const s = (f * m + j) * m + i;
          faceDirection(f as CubeFace, (i - 0.5) / n, (j - 0.5) / n, d);
          this.directions.set([d.x, d.y, d.z], s * 3);
          this.lat[s] = Math.asin(Math.max(-1, Math.min(1, d.y)));
          this.lon[s] = Math.atan2(d.x, d.z);
          // East = ŷ × d, north = d × east (rule 3: +Y is the north pole).
          let ex = d.z;
          let ez = -d.x;
          const el = Math.hypot(ex, ez);
          if (el < 1e-9) {
            ex = 1;
            ez = 0;
          } else {
            ex /= el;
            ez /= el;
          }
          this.east.set([ex, 0, ez], s * 3);
          this.north.set([d.y * ez, d.z * ex - d.x * ez, -d.y * ex], s * 3);
        }
      }
    }
  }

  index(face: number, i: number, j: number): number {
    return (face * this.m + j) * this.m + i;
  }

  direction(s: number, out = new Vec3d()): Vec3d {
    return out.set(
      this.directions[s * 3]!,
      this.directions[s * 3 + 1]!,
      this.directions[s * 3 + 2]!,
    );
  }

  /** The sample nearest to a direction (any length). */
  nearest(d: Readonly<Vec3d>): number {
    const face = directionToFace(d);
    const uv = projectToCubeFace(d, face, this.uv);
    const i = clampInt(Math.floor(uv.u * this.n) + 1, 1, this.n);
    const j = clampInt(Math.floor(uv.v * this.n) + 1, 1, this.n);
    return this.index(face, i, j);
  }

  /**
   * Bilinear weights for a direction: the four samples and their weights,
   * written into `out` (indices) and `w`. Continuous across face seams.
   */
  bilinear(d: Readonly<Vec3d>, out: Int32Array, w: Float64Array): void {
    const face = directionToFace(d);
    const uv = projectToCubeFace(d, face, this.uv);
    const x = uv.u * this.n + 0.5;
    const y = uv.v * this.n + 0.5;
    const i0 = clampInt(Math.floor(x), 0, this.m - 2);
    const j0 = clampInt(Math.floor(y), 0, this.m - 2);
    const fx = Math.min(1, Math.max(0, x - i0));
    const fy = Math.min(1, Math.max(0, y - j0));
    const s = this.index(face, i0, j0);
    out[0] = s;
    out[1] = s + 1;
    out[2] = s + this.m;
    out[3] = s + this.m + 1;
    w[0] = (1 - fx) * (1 - fy);
    w[1] = fx * (1 - fy);
    w[2] = (1 - fx) * fy;
    w[3] = fx * fy;
  }
}

/** Direction of face coordinates (u, v), which may lie outside [0, 1] (border samples). */
export function faceDirection(face: CubeFace, u: number, v: number, out: Vec3d): Vec3d {
  const f = CUBE_FACES[face];
  const su = Math.tan((Math.PI / 4) * (2 * u - 1));
  const sv = Math.tan((Math.PI / 4) * (2 * v - 1));
  return out
    .set(
      f.normal.x + su * f.uAxis.x + sv * f.vAxis.x,
      f.normal.y + su * f.uAxis.y + sv * f.vAxis.y,
      f.normal.z + su * f.uAxis.z + sv * f.vAxis.z,
    )
    .normalize();
}

function clampInt(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
