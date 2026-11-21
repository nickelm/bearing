/**
 * Surface art per terrain vertex (Proposal 0010, *Surface*; decision 298): the world's
 * baked curvature (bilinear on the global grid, so neighboring tiles agree) and the rock
 * under the vertex (the global cell it lies in), as a strata strength and a rock tone
 * for the terrain shader.
 *
 * - **Strata strength** 0..1: how strongly bare rock shows horizontal bands. Layered
 *   sedimentary rock bands fully (its cliffs are already terraced by the tile kernel);
 *   unlayered sediments and lava flows faintly; foliated schist barely; granite and
 *   till not at all.
 * - **Rock tone**: bare rock's albedo against the shader's base rock color, so granite
 *   reads pale gray, limestone near white and basalt near black (visual-style Part I,
 *   *Rock by lithology*; decision 204).
 */
import type { Vec3d } from '../../../core/vec3d';
import { directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import { globalMapSampler } from '../../../worldgen/edits/airfields';
import { isLayered, Rock, rockOf } from '../../../worldgen/lithology';
import type { SurfaceArtSampler } from './tileMesh';

/** Strata strength by rock (indexed by `Rock`), unlayered; layered rock bands fully. */
export const ROCK_STRATA: readonly number[] = [0, 0, 0.2, 0.5, 0.6, 0.45, 0.35, 0.5, 0.3, 0];
/** Bare rock's tone against the shader's base rock color, by rock. */
export const ROCK_TONE: readonly number[] = [1, 2, 1.1, 1.6, 1, 3.2, 0.45, 0.4, 1.8, 1.3];

/** Strata strength and tone of a lithology byte. */
export function rockArt(lithology: number): [number, number] {
  const rock = rockOf(lithology);
  if (rock === Rock.None) return [0, 1];
  return [isLayered(lithology) ? 1 : (ROCK_STRATA[rock] ?? 0), ROCK_TONE[rock] ?? 1];
}

/** A sampler of the global curvature and lithology maps (n per face). */
export function surfaceArtSampler(maps: {
  n: number;
  curvature: Float32Array;
  lithology: Uint8Array;
}): SurfaceArtSampler {
  const curvature = globalMapSampler(maps.curvature, maps.n);
  const n = maps.n;
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  return (d: Readonly<Vec3d>, out: Float32Array, o: number) => {
    out[o] = curvature(d);
    directionToCubeFace(d, uv);
    const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
    const [strata, tone] = rockArt(maps.lithology[(uv.face * n + j) * n + i]!);
    out[o + 1] = strata;
    out[o + 2] = tone;
  };
}
