/**
 * Camera-relative placement, shared by both views (CLAUDE.md rule 4).
 *
 *   - World positions are float64 (Vec3d), planet-centered, in meters.
 *   - The Three.js camera stays at the origin and only rotates.
 *   - Each frame, every object's GPU-side position is (worldPosition - cameraEye),
 *     computed in float64 *before* it is written into float32 Object3D fields.
 *
 * This keeps the numbers the GPU sees small near the camera, where precision
 * matters. Never put planet-scale coordinates into Object3D positions directly;
 * place objects through these helpers instead.
 */
import type { Object3D } from 'three/webgpu';
import type { Vec3d } from '../../core/vec3d';

/** Sets `object.position` to `world − eye`, subtracting in float64 before the float32 write. */
export function placeCameraRelative(
  object: Object3D,
  world: Readonly<Vec3d>,
  eye: Readonly<Vec3d>,
): void {
  object.position.set(world.x - eye.x, world.y - eye.y, world.z - eye.z);
}

/** Places an object whose local origin is the planet center (`0 − eye`). */
export function placePlanetCentered(object: Object3D, eye: Readonly<Vec3d>): void {
  object.position.set(-eye.x, -eye.y, -eye.z);
}
