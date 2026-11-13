/**
 * View rays and distances from the depth buffer, for the full-screen passes
 * of the simulation view's pipeline (simPipeline.ts).
 *
 * The camera sits at the origin (rule 4), so a pixel's world-space ray needs
 * only the camera's axes. The usual route, multiplying by the inverse
 * projection, is avoided: with a near plane of a meter and a far plane of
 * hundreds of kilometers that matrix has entries twelve orders of magnitude
 * apart, and a float32 product of it loses the distance. Instead:
 *
 * - **Ray.** `forward + (2u − 1) · right + (1 − 2v) · up`, with `right` and
 *   `up` already scaled by the tangents of the half field of view. It has
 *   length 1 along the view axis, so its length is the ratio of the distance
 *   along the ray to the depth along the axis.
 * - **Depth.** The buffer is reversed (decision 112): `d = (n·f/z − n) / (f − n)`,
 *   1 at the near plane and 0 at the far plane. Solved for the view depth,
 *   `z = n·f / (d · (f − n) + n)`. Both terms of the sum are positive, so
 *   nothing cancels, and a float32 depth near zero keeps its relative
 *   precision (about 1e-7): the error in `z` stays near a tenth of a meter at
 *   1,000 km. The sky is where the depth is still the cleared 0.
 */
import { Vector3 } from 'three/webgpu';
import type { Node, PerspectiveCamera } from 'three/webgpu';
import { float, length, select, uniform } from 'three/tsl';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** `sceneDistance` where the pixel shows the sky (m). */
export const SKY_DISTANCE = 1e9;

/** View depth (m along the view axis) of a reversed depth-buffer value; the CPU reference. */
export function viewDepthFromReversedDepth(depth: number, near: number, far: number): number {
  return (near * far) / (depth * (far - near) + near);
}

/** Reversed depth-buffer value of a view depth: the inverse of `viewDepthFromReversedDepth`. */
export function reversedDepthFromViewDepth(z: number, near: number, far: number): number {
  return ((near * far) / z - near) / (far - near);
}

/** The camera axes a ray is built from (world frame, camera at the origin). */
export interface ViewRayAxes {
  /** The forward axis, shifted by the projection's center offset. */
  forward: Vector3;
  /** The right and up axes times the tangent of the half field of view. */
  right: Vector3;
  up: Vector3;
}

/** Reads the axes from a camera whose world matrix and projection are current. */
export function viewRayAxes(camera: PerspectiveCamera, out: ViewRayAxes): ViewRayAxes {
  const m = camera.matrixWorld.elements;
  const p = camera.projectionMatrix.elements;
  // View-space direction of NDC (x, y): ((x + p8) / p0, (y + p9) / p5, −1).
  const tx = 1 / p[0]!;
  const ty = 1 / p[5]!;
  out.right.set(m[0]! * tx, m[1]! * tx, m[2]! * tx);
  out.up.set(m[4]! * ty, m[5]! * ty, m[6]! * ty);
  out.forward
    .set(-m[8]!, -m[9]!, -m[10]!)
    .addScaledVector(out.right, p[8]!)
    .addScaledVector(out.up, p[9]!);
  return out;
}

/** The ray through screen uv (0..1, v down), with length 1 along the view axis; the CPU reference. */
export function viewRay(axes: ViewRayAxes, u: number, v: number, out = new Vector3()): Vector3 {
  return out
    .copy(axes.forward)
    .addScaledVector(axes.right, 2 * u - 1)
    .addScaledVector(axes.up, 1 - 2 * v);
}

export class ViewRays {
  private readonly forward = uniform(new Vector3(0, 0, -1));
  private readonly right = uniform(new Vector3(1, 0, 0));
  private readonly up = uniform(new Vector3(0, 1, 0));
  private readonly axes: ViewRayAxes = {
    forward: this.forward.value,
    right: this.right.value,
    up: this.up.value,
  };
  /** near · far, far − near and near (m). */
  private readonly nearFar = uniform(1);
  private readonly range = uniform(1);
  private readonly near = uniform(1);

  /** Reads the camera's axes and planes. Its world matrix and projection must be current. */
  update(camera: PerspectiveCamera): void {
    viewRayAxes(camera, this.axes);
    this.nearFar.value = camera.near * camera.far;
    this.range.value = camera.far - camera.near;
    this.near.value = camera.near;
  }

  /** World-space ray through screen uv (0..1, v down), with length 1 along the view axis. */
  ray(uv: V2): V3 {
    return this.forward
      .add(this.right.mul(uv.x.mul(2).sub(1)))
      .add(this.up.mul(float(1).sub(uv.y.mul(2)))) as V3;
  }

  /** View depth (m) of a reversed depth-buffer value. */
  viewDepth(depth: F): F {
    return this.nearFar.div(depth.mul(this.range).add(this.near)) as F;
  }

  /** Distance along `ray` (from `ray()`) to the surface at `depth`; `SKY_DISTANCE` for the sky. */
  distance(depth: F, ray: V3): F {
    return select(
      depth.greaterThan(0),
      this.viewDepth(depth).mul(length(ray)),
      float(SKY_DISTANCE),
    ) as F;
  }
}
