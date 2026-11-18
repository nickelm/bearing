/**
 * The air-to-ground radar's ground map (decision 226): what a mapping radar paints of the
 * ground ahead, as a B-scope raster (azimuth across, ground range up). Headless and
 * deterministic; the ground enters through the host's height and water queries (the
 * execution layer may read terrain, rule 9; heights through the one height function,
 * rule 13).
 *
 * Each column is a ray from the aircraft along the ground at one azimuth off the nose.
 * Along it, a cell is in radar shadow when something nearer stands higher in the radar's
 * view (its depression angle is not the steepest yet); a lit cell returns by the grazing
 * angle between the beam and the local slope, against level ground's at that range (the
 * receiver's gain rises with range), so level ground paints an even gray, slopes facing
 * the aircraft bright and slopes facing away dark. Water reflects the beam away and paints nearly black, so
 * coasts, lakes and rivers stand out, as on a real ground map. Hard man-made surfaces
 * (the host's `cultural` share) return strongly. A fixed speckle per patch of ground
 * gives the picture its grain without flickering between sweeps.
 */
import { Vec3d } from '../../core/vec3d';

export interface MapGround {
  /** Height of the drawn ground (m above sea level) at a unit direction. */
  height(dir: Readonly<Vec3d>): number;
  /** Open water at a unit direction. */
  water(dir: Readonly<Vec3d>): boolean;
  /** Share of hard man-made surface (runways, towns) at a unit direction, 0..1. */
  cultural?(dir: Readonly<Vec3d>): number;
}

export interface GroundMapImage {
  /** Ground range from the aircraft to the top row (m) and the half-width in azimuth (rad). */
  range: number;
  azimuth: number;
  cols: number;
  rows: number;
  /** Returns 0..255, row 0 nearest the aircraft, `cols` per row. */
  values: number[];
}

export const GROUND_MAP_COLS = 72;
export const GROUND_MAP_ROWS = 60;
/** The patch of ground one speckle value covers (m). */
const SPECKLE_CELL = 150;

function speckle(p: Readonly<Vec3d>, radius: number): number {
  const q = radius / SPECKLE_CELL;
  let h = 0x811c9dc5;
  for (const v of [Math.round(p.x * q), Math.round(p.y * q), Math.round(p.z * q)])
    h = Math.imul(h ^ (v | 0), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * Paints the ground ahead of an aircraft at `pos` heading along `forward` (projected onto
 * the local horizontal), out to `range` (m) and ±`azimuth` (rad), on a planet of `radius`.
 */
export function groundMap(
  pos: Readonly<Vec3d>,
  forward: Readonly<Vec3d>,
  range: number,
  azimuth: number,
  radius: number,
  ground: MapGround,
  cols = GROUND_MAP_COLS,
  rows = GROUND_MAP_ROWS,
): GroundMapImage {
  const up = pos.clone().normalize();
  const fwd = forward.clone().addScaled(up, -forward.dot(up));
  // Straight down: north stands in for the nose.
  if (fwd.length() < 1e-6) fwd.copy(up.clone().cross(new Vec3d(0, 1, 0).cross(up)));
  fwd.normalize();
  const right = fwd.clone().cross(up).normalize();
  const values = new Array<number>(cols * rows).fill(0);
  const dir = new Vec3d();
  const horiz = new Vec3d();
  const p = new Vec3d();
  const step = range / rows;
  for (let i = 0; i < cols; i++) {
    const az = -azimuth + ((i + 0.5) / cols) * 2 * azimuth;
    horiz.copy(fwd).scale(Math.cos(az)).addScaled(right, Math.sin(az));
    // The steepest view up from the radar so far along the ray (sine of the angle).
    let steepest = -Infinity;
    let lastH = Math.max(0, ground.height(up));
    for (let j = 0; j < rows; j++) {
      const g = (j + 0.5) * step;
      const a = g / radius;
      dir.copy(up).scale(Math.cos(a)).addScaled(horiz, Math.sin(a));
      const wet = ground.water(dir);
      const h = wet ? 0 : Math.max(0, ground.height(dir));
      p.copy(dir)
        .scale(radius + h)
        .sub(pos);
      const dist = p.length();
      const view = p.dot(up) / dist;
      const slope = (h - lastH) / step;
      lastH = h;
      if (view <= steepest) continue; // radar shadow
      steepest = view;
      let v: number;
      if (wet) v = 0.04;
      else {
        // The grazing angle between the beam and the ground's local slope along the ray,
        // against level ground's at that range: the receiver's gain rises with range
        // (sensitivity time control), so level ground paints one gray near and far.
        const depression = -Math.asin(view);
        const graze = Math.sin(Math.max(0, depression + Math.atan(slope)));
        const level = Math.max(0.02, Math.sin(Math.max(0, depression)));
        v = Math.max(0.06, Math.min(1, 0.4 * (graze / level)));
        const hard = ground.cultural?.(dir) ?? 0;
        v = v + (1 - v) * hard * 0.9;
      }
      v *= 0.7 + 0.6 * speckle(dir, radius);
      values[j * cols + i] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return { range, azimuth, cols, rows, values };
}
