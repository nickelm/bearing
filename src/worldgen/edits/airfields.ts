/**
 * Airfields graded into the terrain (V3, decision 108, rule 13), and the
 * assembly of the one height function's edits (R1.6). Lives in worldgen so the
 * sim worker builds the same `TerrainEdits` the renderer does: one flat pad per
 * airbase covering the runway with its overruns, the parallel taxiway, the apron
 * and the buildings beside them, at the field's elevation, blending back to the
 * terrain over a margin; then the aligned corridors; river channels kept last.
 *
 * The field elevation is the mean of the global eroded height over the pad, so
 * it is known as soon as the world is, for every tile level alike.
 */
import { directionToCubeFace } from '../../core/coords';
import type { CubeFaceUv } from '../../core/coords';
import { Vec3d } from '../../core/vec3d';
import type { ChannelSource } from './channels';
import type { CorridorEdit } from './corridor';
import type { PadEdit } from './pad';
import type { PadFootprint } from './siting';
import { TerrainEdits } from './terrainEdits';

/** Airfield layout (m): runway, parallel taxiway and apron, across from the runway's centerline. */
export const RUNWAY_WIDTH = 45;
export const TAXIWAY_WIDTH = 23;
export const TAXIWAY_OFFSET = 190;
export const APRON_WIDTH = 140;
export const APRON_LENGTH = 600;
export const APRON_OFFSET = 420;
/** Links from the taxiway to the apron, this far either side of the apron's middle (m). */
export const APRON_LINK_ALONG = 200;

/** Runway overrun graded beyond each end (m). */
export const AIRFIELD_OVERRUN = 200;
/** Graded ground beyond the apron, for hangars, shelters and the radar dome (m). */
export const AIRFIELD_BEYOND_APRON = 200;
/** Blend from the graded field back to the terrain (m). */
export const AIRFIELD_MARGIN = 400;
/** Lowest field elevation (m above the sea). */
export const AIRFIELD_MIN_ELEVATION = 3;

/** The graded pad around each runway (siting.ts samples the same footprint, decision 220). */
export const AIRFIELD_FOOTPRINT: PadFootprint = {
  overrun: AIRFIELD_OVERRUN,
  across0: -RUNWAY_WIDTH / 2 - 80,
  across1: APRON_OFFSET + APRON_WIDTH / 2 + AIRFIELD_BEYOND_APRON,
  margin: AIRFIELD_MARGIN,
};

/** An airfield as the pads need it: an Infrastructure airbase, or a scene's airbase site. */
export interface AirfieldSite {
  point: Readonly<Vec3d> | readonly [number, number, number];
  /** Runway heading, radians clockwise from north. */
  heading: number;
  runwayLength: number;
}

/** Local east and north unit vectors at a unit direction. */
export function localFrame(p: Readonly<Vec3d>): { east: Vec3d; north: Vec3d } {
  const east = new Vec3d(0, 1, 0).cross(p);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = p.clone().cross(east);
  return { east, north };
}

/** The unit direction `along` m forward on `heading` and `across` m to its right from p. */
export function offsetPoint(
  p: Readonly<Vec3d>,
  heading: number,
  along: number,
  across: number,
  radius: number,
): Vec3d {
  const { east, north } = localFrame(p);
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  // Right of heading: rotate (fx, fy) clockwise by 90°.
  const e = (fx * along + fy * across) / radius;
  const n = (fy * along - fx * across) / radius;
  return p.clone().addScaled(east, e).addScaled(north, n).normalize();
}

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

/**
 * The highest of the four cells a bilinear sample of a global cube-grid map
 * would blend (n per face): a conservative ground for floors over a coarse
 * grid, never below the surface the grid stands for (R1.6).
 */
export function globalMaxSampler(map: Float32Array, n: number): (d: Readonly<Vec3d>) => number {
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  return (d) => {
    directionToCubeFace(d, uv);
    const fi = Math.min(n - 1, Math.max(0, uv.u * n - 0.5));
    const fj = Math.min(n - 1, Math.max(0, uv.v * n - 0.5));
    const i0 = Math.min(n - 2, Math.floor(fi));
    const j0 = Math.min(n - 2, Math.floor(fj));
    const o = (uv.face * n + j0) * n + i0;
    return Math.max(map[o]!, map[o + 1]!, map[o + n]!, map[o + n + 1]!);
  };
}

/** True where a global cube-grid map (n per face) is above zero in the cell under a unit direction. */
export function globalMaskSampler(map: Float32Array, n: number): (d: Readonly<Vec3d>) => boolean {
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  return (d) => {
    directionToCubeFace(d, uv);
    const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
    return map[(uv.face * n + j) * n + i]! > 0;
  };
}

/** One graded pad per airfield, at the mean of `heightAt` over the pad. */
export function airfieldPads(
  fields: readonly AirfieldSite[],
  radius: number,
  heightAt: (d: Readonly<Vec3d>) => number,
): PadEdit[] {
  const pads: PadEdit[] = [];
  for (const f of fields) {
    const center =
      f.point instanceof Vec3d ? f.point : new Vec3d(...(f.point as [number, number, number]));
    const L = f.runwayLength;
    const along0 = -L / 2 - AIRFIELD_FOOTPRINT.overrun;
    const along1 = L / 2 + AIRFIELD_FOOTPRINT.overrun;
    const { across0, across1 } = AIRFIELD_FOOTPRINT;
    let sum = 0;
    let count = 0;
    for (let a = 0; a <= 8; a++) {
      for (let c = 0; c <= 2; c++) {
        const along = along0 + ((along1 - along0) * a) / 8;
        const across = across0 + ((across1 - across0) * c) / 2;
        sum += heightAt(offsetPoint(center, f.heading, along, across, radius));
        count++;
      }
    }
    pads.push({
      center,
      heading: f.heading,
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

/**
 * The world's terrain edits (rule 13): the pads of `fields` over the global
 * height map `height` (n per face), the aligned `corridors`, and the river
 * channels of `channels` kept last. The renderer and the sim worker both build
 * them here, from the same sited airfields.
 */
export function terrainEditsFor(o: {
  radius: number;
  fields: readonly AirfieldSite[];
  height: Float32Array;
  n: number;
  channels?: ChannelSource | null;
  corridors?: readonly CorridorEdit[];
}): TerrainEdits {
  return new TerrainEdits({
    radius: o.radius,
    pads: airfieldPads(o.fields, o.radius, globalMapSampler(o.height, o.n)),
    corridors: o.corridors ?? [],
    channels: o.channels ?? null,
  });
}
