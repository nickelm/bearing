import { describe, expect, it } from 'vitest';
import { cubeFaceUvToDirection, directionToCubeFace, latLonToDirection } from '../src/core/coords';
import type { CubeFace, CubeFaceUv } from '../src/core/coords';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { coastDistanceField } from '../src/render/strategic/coastDistance';

const N = 64;
const R = 1000 * KM;
const CELL = ((Math.PI / 2) * R) / N;

/** Heights from a land test on cell-center directions. */
function heights(land: (d: Vec3d) => boolean): Float32Array {
  const h = new Float32Array(6 * N * N);
  const d = new Vec3d();
  for (let f = 0; f < 6; f++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        cubeFaceUvToDirection(f as CubeFace, (i + 0.5) / N, (j + 0.5) / N, d);
        h[(f * N + j) * N + i] = land(d) ? 100 : -100;
      }
  return h;
}

const at = (field: Float32Array, d: Vec3d) => {
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  directionToCubeFace(d, uv);
  const i = Math.min(N - 1, Math.floor(uv.u * N));
  const j = Math.min(N - 1, Math.floor(uv.v * N));
  return field[(uv.face * N + j) * N + i]!;
};

describe('coast distance field', () => {
  // Land north of 30° N.
  const field = coastDistanceField(
    heights((d) => d.y > Math.sin(30 * DEG)),
    N,
    R,
    {
      max: 1e9,
    },
  );

  it('is zero on land and grows with the great-circle distance to the coast at sea', () => {
    expect(at(field, latLonToDirection(60 * DEG, 10 * DEG))).toBe(0);
    for (const lat of [25, 15, 0, -20]) {
      const expected = (30 - lat) * DEG * R;
      const got = at(field, latLonToDirection(lat * DEG, 10 * DEG));
      // Within two cells plus the warp's 10%: distances are in mean cell sizes.
      expect(Math.abs(got - expected)).toBeLessThan(2 * CELL + 0.12 * expected);
    }
  });

  it('agrees across face seams', () => {
    // Points straddling the +Z / +X seam at the same latitude (lon 45°).
    for (const lat of [0, 10, 20]) {
      const a = at(field, latLonToDirection(lat * DEG, 44.5 * DEG));
      const b = at(field, latLonToDirection(lat * DEG, 45.5 * DEG));
      expect(Math.abs(a - b)).toBeLessThan(2 * CELL);
    }
  });

  it('caps distances far out to sea', () => {
    const capped = coastDistanceField(
      heights((d) => d.y > Math.sin(30 * DEG)),
      N,
      R,
      {
        max: 50 * KM,
      },
    );
    expect(at(capped, latLonToDirection(-40 * DEG, 0))).toBe(50 * KM);
  });
});
