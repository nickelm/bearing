/**
 * Padlock (Proposal 0014, decision 366): the chase camera's free look turned so the view
 * runs from behind the aircraft through it toward the locked target, keeping both in frame.
 *
 * The chase camera's eye sits along `back = −f·cos(yaw)·cos(pitch) − right·sin(yaw)·cos(pitch)
 * + up·sin(pitch)` from the aircraft (`ChaseCamera.update`), so the view looks along −back.
 * Setting −back to the target's direction gives the angles; the look-centered rest frame
 * (`restForward`, `restUp`) stands in for the camera's smoothed aircraft frame, a few degrees
 * off at most.
 */
import type { Vec3d } from '../../core/vec3d';

/** The free look's limit in pitch (the chase camera's). */
const MAX_PITCH = (80 * Math.PI) / 180;

/** Look angles (rad) that point the chase view at direction `d` (unit, world frame). */
export function padlockAngles(
  restForward: Readonly<Vec3d>,
  restUp: Readonly<Vec3d>,
  d: Readonly<Vec3d>,
): { yaw: number; pitch: number } {
  const f = restForward;
  const u = restUp;
  // right = f × u
  const rx = f.y * u.z - f.z * u.y;
  const ry = f.z * u.x - f.x * u.z;
  const rz = f.x * u.y - f.y * u.x;
  const df = d.x * f.x + d.y * f.y + d.z * f.z;
  const dr = d.x * rx + d.y * ry + d.z * rz;
  const du = d.x * u.x + d.y * u.y + d.z * u.z;
  const pitch = Math.max(
    -MAX_PITCH,
    Math.min(MAX_PITCH, -Math.asin(Math.max(-1, Math.min(1, du)))),
  );
  return { yaw: Math.atan2(dr, df), pitch };
}
