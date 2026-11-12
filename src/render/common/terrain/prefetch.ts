/**
 * Terrain prefetch within the bounded radius (decision 119). Pure TypeScript,
 * float64, so it can be tested without three.js.
 *
 * - **The bubble.** The level-7 data tiles (about 48 m samples) within the
 *   promotion bubble around the camera's nadir: the tiles line of sight,
 *   trees, buildings and the ground under the eye read (decisions 49, 64).
 *   They load at the lowest priority and are never evicted while inside it.
 *   Wherever the camera is, this covers the ground-combat region tiles of
 *   decision 64 that lie in the bubble.
 * - **Look-ahead.** Where a moving camera will be in a few seconds: the
 *   renderer selects tiles for that eye and asks for the data they lack, below
 *   what the current view needs.
 */
import { KM } from '../../../core/units';
import { neighborTile, tileForDirection, tileKeyString } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import { tileAngularDistance, tileQuad } from './quadtree';
import type { LodView } from './quadtree';

/**
 * Radius of the promotion bubble around the followed aircraft or the
 * simulation view's camera (CLAUDE.md, decision 49: about 15–25 km).
 */
export const PROMOTION_BUBBLE = 20 * KM;

/** Finest baked tile level: data tiles there carry about 48 m samples (decision 64). */
export const BUBBLE_LEVEL = 7;

/** How far ahead (s) the look-ahead places a moving camera. */
export const LOOK_AHEAD_SECONDS = 3;

/**
 * Request priorities, compared with the terrain's screen-space errors (pixels,
 * above the 2 px threshold for anything the view needs) and the 1 that trees
 * and buildings use: the view first, then the layers on it, then the
 * look-ahead, then the bubble.
 */
export function lookAheadPriority(sse: number): number {
  return 0.6 + 0.3 * (sse / (sse + 1));
}

export function bubblePriority(distance: number, bubble: number): number {
  return 0.5 - 0.25 * Math.min(1, distance / Math.max(1, bubble));
}

export interface NearTile {
  tile: TileKey;
  /** Ground distance (m) from the center to the tile's nearest point; 0 inside it. */
  distance: number;
}

/**
 * Tiles at `level` with any point within `distance` (m, along the ground) of
 * the unit direction `center`, nearest first (ties by key). A flood fill from
 * the tile under the center, across face seams, with the exact tile distance.
 */
export function tilesWithin(
  center: Readonly<Vec3d>,
  distance: number,
  radius: number,
  level: number,
): NearTile[] {
  const start = tileForDirection(center, level);
  const seen = new Set<string>([tileKeyString(start)]);
  const out: NearTile[] = [];
  const queue: TileKey[] = [start];
  while (queue.length > 0) {
    const t = queue.pop()!;
    const d = tileAngularDistance(tileQuad(t), center) * radius;
    if (d > distance) continue;
    out.push({ tile: t, distance: d });
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const n = neighborTile(t, dx, dy);
        const k = tileKeyString(n);
        if (!seen.has(k)) {
          seen.add(k);
          queue.push(n);
        }
      }
    }
  }
  const key = (n: NearTile) => tileKeyString(n.tile);
  return out.sort((a, b) => a.distance - b.distance || (key(a) < key(b) ? -1 : 1));
}

/**
 * The camera's velocity from its eye positions, smoothed over about a third of
 * a second. A jump (to another station, a new world) resets it to rest.
 */
export class MotionEstimate {
  readonly velocity = new Vec3d();
  private readonly last = new Vec3d();
  private hasLast = false;

  constructor(
    /** Smoothing time constant (s). */
    readonly tau = 0.3,
    /** A move faster than this (m/s) is a jump, not motion. */
    readonly maxSpeed = 50 * KM,
  ) {}

  update(eye: Readonly<Vec3d>, dt: number): Readonly<Vec3d> {
    if (!this.hasLast) {
      this.last.copy(eye);
      this.hasLast = true;
      return this.velocity;
    }
    if (dt <= 0) return this.velocity;
    const v = eye
      .clone()
      .sub(this.last)
      .scale(1 / dt);
    this.last.copy(eye);
    if (v.length() > this.maxSpeed) {
      this.velocity.set(0, 0, 0);
      return this.velocity;
    }
    const a = 1 - Math.exp(-dt / this.tau);
    this.velocity.scale(1 - a).addScaled(v, a);
    return this.velocity;
  }

  reset(): void {
    this.hasLast = false;
    this.velocity.set(0, 0, 0);
  }
}

/**
 * The view from where a camera moving at `velocity` will be after `seconds`,
 * looking the same way, never below `minAltitude` above the sphere.
 */
export function aheadView(
  view: LodView,
  velocity: Readonly<Vec3d>,
  seconds: number,
  minAltitude = 2,
): LodView {
  const eye = view.eye.clone().addScaled(velocity, seconds);
  const r = eye.length();
  if (r < view.radius + minAltitude) eye.scale((view.radius + minAltitude) / Math.max(1, r));
  return { ...view, eye };
}
