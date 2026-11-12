/**
 * Airfields graded into the terrain (V3): one flat pad per airbase covering
 * the runway with its overruns, the parallel taxiway, the apron and the
 * buildings beside them, at the field's elevation, blending back to the
 * terrain over a margin (render/common/terrain/grading.ts).
 *
 * The field elevation is the mean of the global eroded height (the smooth
 * surface the tiles add their detail to) over the pad, so it is known as soon
 * as the world is, for every tile level alike, without waiting for tile data.
 */
import { directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import type { Vec3d } from '../../../core/vec3d';
import { SurfaceGrading } from '../../common/terrain/grading';
import type { GradePad } from '../../common/terrain/grading';
import { APRON_OFFSET, APRON_WIDTH, offsetPoint, RUNWAY_WIDTH } from './infraScene';
import type { InfraScene } from './infraScene';

/** Runway overrun graded beyond each end (m). */
export const AIRFIELD_OVERRUN = 200;
/** Graded ground beyond the apron, for hangars, shelters and the radar dome (m). */
export const AIRFIELD_BEYOND_APRON = 200;
/** Blend from the graded field back to the terrain (m). */
export const AIRFIELD_MARGIN = 400;
/** Lowest field elevation (m above the sea). */
export const AIRFIELD_MIN_ELEVATION = 3;

/**
 * Bilinear sampler of a global cube-grid map (n × n cells per face, cell
 * index (face · n + j) · n + i) at a unit direction, clamped at face edges.
 */
export function globalMapSampler(map: Float32Array, n: number): (d: Readonly<Vec3d>) => number {
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  return (d) => {
    directionToCubeFace(d, uv);
    const fi = Math.min(n - 1, Math.max(0, uv.u * n - 0.5));
    const fj = Math.min(n - 1, Math.max(0, uv.v * n - 0.5));
    const i0 = Math.min(n - 2, Math.floor(fi));
    const j0 = Math.min(n - 2, Math.floor(fj));
    const tx = fi - i0;
    const ty = fj - j0;
    const o = (uv.face * n + j0) * n + i0;
    const a = map[o]!;
    const b = map[o + 1]!;
    const c = map[o + n]!;
    const e = map[o + n + 1]!;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  };
}

/** One graded pad per airbase in `infra`, at the mean global height over the pad. */
export function airfieldPads(
  infra: InfraScene,
  heightAt: (d: Readonly<Vec3d>) => number,
): GradePad[] {
  const R = infra.radius;
  const pads: GradePad[] = [];
  for (const site of infra.sites) {
    if (site.kind !== 'airbase') continue;
    const L = site.runwayLength;
    const along0 = -L / 2 - AIRFIELD_OVERRUN;
    const along1 = L / 2 + AIRFIELD_OVERRUN;
    const across0 = -RUNWAY_WIDTH / 2 - 80;
    const across1 = APRON_OFFSET + APRON_WIDTH / 2 + AIRFIELD_BEYOND_APRON;
    let sum = 0;
    let count = 0;
    for (let a = 0; a <= 8; a++) {
      for (let c = 0; c <= 2; c++) {
        const along = along0 + ((along1 - along0) * a) / 8;
        const across = across0 + ((across1 - across0) * c) / 2;
        sum += heightAt(offsetPoint(site.point, site.heading, along, across, R));
        count++;
      }
    }
    pads.push({
      center: site.point,
      heading: site.heading,
      along0,
      along1,
      across0,
      across1,
      elevation: Math.max(AIRFIELD_MIN_ELEVATION, sum / count),
      margin: AIRFIELD_MARGIN,
    });
  }
  return pads;
}

/** The grading of every airfield in `infra` over the global height map `height` (n per face). */
export function airfieldGrading(
  infra: InfraScene,
  height: Float32Array,
  n: number,
): SurfaceGrading {
  return new SurfaceGrading(airfieldPads(infra, globalMapSampler(height, n)), infra.radius);
}
