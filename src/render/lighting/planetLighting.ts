/**
 * Planet lighting (decision 34): the uniforms every lit planet material shares
 * (sun direction, camera eye) and the TSL shading function that turns an
 * albedo and a normal into radiance. Materials compute their own lighting
 * instead of using three's scene lights, because sunlight and sky light depend
 * on where the point sits relative to the terminator and, from milestone 3's
 * atmosphere on, on the air between it and the sun.
 *
 * Positions: meshes are drawn camera-relative (rule 4), so a fragment's
 * `positionWorld` is relative to the camera. The planet-centered position is
 * `positionWorld + eye`, in float32. Its error is about 0.1 m at R = 1,000 km,
 * which is plenty for lighting.
 */
import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { dot, float, max, normalize, smoothstep, uniform, vec3 } from 'three/tsl';
import type { Vec3d } from '../../core/vec3d';

export type Vec3Node = Node<'vec3'>;

export class PlanetLighting {
  /** Unit vector toward the sun, world frame. */
  readonly sunDirection = uniform(new Vector3(1, 0, 0));
  /** Camera eye, planet-centered world frame (float32). */
  readonly eye = uniform(new Vector3());
  /** Sunlight on a surface facing the sun, in display units (before exposure). */
  readonly sunIlluminance = uniform(2.2);
  /** Daylight sky light on an upward surface (replaced by the atmosphere's sky irradiance). */
  readonly skyAmbient = uniform(0.45);
  /** Starlight and airglow on the night side, so terrain stays faintly visible. */
  readonly nightLight = uniform(0.012);

  update(eye: Readonly<Vec3d>, sun: Readonly<Vec3d>): void {
    this.eye.value.set(eye.x, eye.y, eye.z);
    this.sunDirection.value.set(sun.x, sun.y, sun.z).normalize();
  }

  /** Planet-centered position of a camera-relative world position. */
  planetPosition(relative: Vec3Node): Vec3Node {
    return relative.add(this.eye) as Vec3Node;
  }

  /**
   * Radiance of a diffuse surface: sunlight by N·L, sky light fading through
   * twilight by the sun's elevation at the point, and a faint night floor.
   * `normal` is a unit world-space normal; `relative` the camera-relative position.
   */
  shadeDiffuse(albedo: Vec3Node, normal: Vec3Node, relative: Vec3Node): Vec3Node {
    const up = normalize(this.planetPosition(relative));
    const sunElevation = dot(up, this.sunDirection);
    const direct = max(dot(normal, this.sunDirection), 0).mul(this.sunIlluminance);
    // Sky light: full by day, gone about 6° below the horizon (civil twilight).
    const daylight = smoothstep(float(-0.1), float(0.25), sunElevation);
    const skyFacing = dot(normal, up).mul(0.5).add(0.5);
    const sky = this.skyAmbient.mul(daylight).mul(skyFacing);
    const night = vec3(0.55, 0.65, 1.0).mul(this.nightLight);
    const light = vec3(direct.add(sky)).add(night);
    return albedo.mul(light) as Vec3Node;
  }
}
