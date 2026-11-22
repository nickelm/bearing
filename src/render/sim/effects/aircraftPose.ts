/**
 * An airframe's pose as the effects need it (decision 329): its body axes, load factor and
 * size, for `EffectsSystem.aircraft`.
 */
import { Vec3d } from '../../../core/vec3d';
import type { AircraftPose } from './effectsSystem';

/** What `airframePose` reads of an airframe (the flight model's own fields). */
export interface PosedAirframe {
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  telemetry: { load: number };
  bodyAxis(axis: 0 | 1 | 2, out?: Vec3d): Vec3d;
}

/** The effects' pose of an airframe of wingspan `span` (m); a fighter's length is assumed. */
export function airframePose(
  a: PosedAirframe,
  span: number,
  damage = 0,
  length = 16,
): AircraftPose {
  return {
    pos: a.pos,
    vel: a.vel,
    forward: a.bodyAxis(0, new Vec3d()),
    right: a.bodyAxis(1, new Vec3d()),
    load: Number.isFinite(a.telemetry.load) ? a.telemetry.load : 1,
    span,
    length,
    damage,
  };
}
