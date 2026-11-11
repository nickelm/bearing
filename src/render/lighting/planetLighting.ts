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
import { dot, max, normalize, uniform, vec3 } from 'three/tsl';
import { PLANET_RADIUS } from '../../core/units';
import type { Vec3d } from '../../core/vec3d';
import { AtmosphereNodes } from '../atmosphere/atmosphere';
import { earthLikeAtmosphere } from '../atmosphere/model';

export type Vec3Node = Node<'vec3'>;

/** Light at one point, shared by the layers a material shades there (see `PlanetLighting.at`). */
export interface LightAt {
  /** Planet-centered position. */
  p: Vec3Node;
  /** Unit radial direction. */
  up: Vec3Node;
  /** Sunlight after the atmosphere and the clouds. */
  sunlight: Vec3Node;
  /** Sky irradiance on a surface facing straight up. */
  sky: Vec3Node;
}

export class PlanetLighting {
  /** Unit vector toward the sun, world frame. */
  readonly sunDirection = uniform(new Vector3(1, 0, 0));
  /** Camera eye, planet-centered world frame (float32). */
  readonly eye = uniform(new Vector3());
  /** Sunlight on a surface facing the sun, in display units (before exposure). */
  readonly sunIlluminance = uniform(1.4);
  /** Multiplies the atmosphere's sky light on surfaces (1 = physical single scattering). */
  readonly skyLight = uniform(1.6);
  /** Starlight and airglow on the night side, so terrain stays faintly visible. */
  readonly nightLight = uniform(0.012);
  /** The air: transmittance LUT, sky and scattering (decision 35). */
  readonly atmosphere: AtmosphereNodes;
  /**
   * Optional fraction of sunlight that reaches a planet-centered point past
   * the clouds (1 = clear). Set by the cloud layer before materials are built.
   */
  sunVisibility: ((p: Vec3Node) => Node<'float'>) | null = null;

  constructor(readonly radius = PLANET_RADIUS) {
    this.atmosphere = new AtmosphereNodes(earthLikeAtmosphere(radius), {
      sunDirection: this.sunDirection,
      sunIlluminance: this.sunIlluminance,
      eye: this.eye,
    });
  }

  update(eye: Readonly<Vec3d>, sun: Readonly<Vec3d>): void {
    this.eye.value.set(eye.x, eye.y, eye.z);
    this.sunDirection.value.set(sun.x, sun.y, sun.z).normalize();
  }

  /** Sunlight at a planet-centered point: illuminance × atmosphere transmittance × clouds. */
  sunlightAt(p: Vec3Node): Vec3Node {
    const t = this.atmosphere.sunTransmittance(p).mul(this.sunIlluminance);
    return (this.sunVisibility ? t.mul(this.sunVisibility(p)) : t) as Vec3Node;
  }

  /** Planet-centered position of a camera-relative world position. */
  planetPosition(relative: Vec3Node): Vec3Node {
    return relative.add(this.eye) as Vec3Node;
  }

  /**
   * Radiance of a diffuse surface: sunlight by N·L, filtered by the air
   * between the point and the sun (red at sunset, zero in the planet's
   * shadow); sky light from the atmosphere's irradiance LUT by the sun's
   * elevation at the point, weighted by how much sky the normal sees; and a
   * faint night floor. Aerial perspective is applied separately (`applyAerial`).
   * `normal` is a unit world-space normal; `relative` the camera-relative position.
   */
  shadeDiffuse(
    albedo: Vec3Node,
    normal: Vec3Node,
    relative: Vec3Node,
    at: LightAt = this.at(relative),
  ): Vec3Node {
    const direct = at.sunlight.mul(max(dot(normal, this.sunDirection), 0));
    const skyFacing = dot(normal, at.up).mul(0.5).add(0.5);
    const sky = at.sky.mul(skyFacing);
    const night = vec3(0.55, 0.65, 1.0).mul(this.nightLight);
    const light = direct.add(sky).add(night);
    return albedo.mul(light) as Vec3Node;
  }

  /**
   * The light arriving at a camera-relative position, independent of the
   * surface's normal and albedo. A material that shades several layers at one
   * point (land, water, roads) builds this once and passes it to each
   * `shadeDiffuse` call, so the sun's transmittance, the cloud shadow and the
   * sky light are evaluated once per fragment (decision 69).
   */
  at(relative: Vec3Node): LightAt {
    const p = this.planetPosition(relative);
    const up = normalize(p) as Vec3Node;
    const sky = this.atmosphere
      .skyIrradiance(dot(up, this.sunDirection))
      .mul(this.sunIlluminance.mul(this.skyLight)) as Vec3Node;
    return {
      p,
      up,
      sunlight: this.sunlightAt(p).toVar() as Vec3Node,
      sky: sky.toVar() as Vec3Node,
    };
  }

  /** Surface radiance seen through the air: L·T + in-scatter (per-vertex values from aerialPerspective). */
  applyAerial(radiance: Vec3Node, inscatter: Vec3Node, transmittance: Vec3Node): Vec3Node {
    return radiance.mul(transmittance).add(inscatter.mul(this.sunIlluminance)) as Vec3Node;
  }
}
