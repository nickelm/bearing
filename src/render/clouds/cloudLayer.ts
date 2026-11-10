/**
 * Cloud layer (decision 55): a shell at CLOUD_ALTITUDE above sea level whose
 * coverage comes from a static field until live weather exists (milestone 6).
 *
 * - Coverage: 3D fractal noise for weather systems (base wavelength about
 *   300 km) and finer cells (about 33 km) that break up the edges,
 *   thresholded by the climate texture's cloudiness (from precipitation, decision
 *   42), so wet regions are cloudy and deserts clear.
 * - Motion: the field is advected around the polar axis by zonal winds that
 *   depend on latitude (easterly trades, westerlies at mid-latitudes, polar
 *   easterlies, about 6–12 m/s). Two copies half a two-day cycle apart are
 *   cross-faded, and each re-seeds when its cycle ends. Clouds then travel
 *   and evolve, and shear between bands never accumulates.
 * - The shell is a cube-sphere mesh, drawn transparent and camera-relative
 *   (rule 4: the mesh sits at planet center − eye). Fragments compute coverage
 *   from their direction, so the mesh resolution does not limit the clouds.
 * - Lighting: sunlight filtered by the atmosphere (sunsets tint the clouds),
 *   brighter where the sun is high, plus sky light. Seen from below, thick cloud
 *   is darker. Aerial perspective per vertex, as on terrain.
 * - Shadows: `shadow(p)` is the sun visibility at a planet-centered point. It
 *   samples coverage where the ray toward the sun crosses the shell, and
 *   PlanetLighting applies it to every lit surface (terrain, water, trees).
 */
import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  BufferAttribute,
  BufferGeometry,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  asin,
  clamp,
  cos,
  dot,
  float,
  floor,
  Fn,
  fract,
  length,
  max,
  mix,
  modelWorldMatrix,
  mx_fractal_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import type { Vec3d } from '../../core/vec3d';
import type { ClimateTexture } from '../climateTexture';
import { buildCubeSphereArrays } from '../cubeSphereGeometry';
import type { PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Height of the cloud shell above sea level (m). */
export const CLOUD_ALTITUDE = 5000;
/** Base wavelength of the cloud noise (m). */
const CLOUD_WAVELENGTH = 300_000;
/** Clouds are advected for at most this long before their copy re-seeds (s). */
const ADVECTION_CYCLE = 2 * 86_400;

export class CloudLayer {
  readonly group = new Group();
  /** 1 draws clouds and their shadows. */
  readonly enabled = uniform(1);
  /** Shifts coverage: positive is cloudier. */
  readonly coverageBias = uniform(0);
  /** Game time (s): the field moves with it. */
  readonly time = uniform(0);
  /** Multiplies the prevailing winds that carry the clouds. */
  readonly windScale = uniform(1);
  /** How much sunlight a full cloud blocks. */
  readonly shadowStrength = uniform(0.75);
  /** 1 while the camera is below the cloud shell (undersides darken). */
  private readonly below = uniform(0);
  private readonly mesh: Mesh;

  constructor(
    private readonly radius: number,
    private readonly lighting: PlanetLighting,
    private readonly climate: ClimateTexture,
  ) {
    const arrays = buildCubeSphereArrays(48, radius + CLOUD_ALTITUDE);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(arrays.positions, 3));
    g.setIndex(new BufferAttribute(arrays.indices, 1));
    this.mesh = new Mesh(g, this.material());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.group.add(this.mesh);
  }

  /** Cloud coverage 0..1 at a direction from the planet center (any length). */
  coverage(direction: V3): F {
    const dir = normalize(direction) as V3;
    const cloudiness = this.climate.sample(dir).w;
    // Zonal wind (m/s, eastward positive) by latitude: easterly trades, westerlies,
    // polar easterlies. The field is advected around the polar axis.
    const lat = abs(asin(clamp(dir.y, -1, 1))).mul(180 / Math.PI);
    const wind = float(-6)
      .add(smoothstep(20, 35, lat).mul(18))
      .sub(smoothstep(55, 70, lat).mul(16))
      .mul(this.windScale);
    const omega = wind.div(this.radius); // rad/s about the polar axis
    // Two copies half a cycle apart, each advected for at most one cycle and then
    // re-seeded, cross-faded so shear between latitude bands never builds up.
    const cycle = this.time.div(ADVECTION_CYCLE);
    let density: F = float(0);
    for (const offset of [0, 0.5]) {
      const c = cycle.add(offset);
      const phase = fract(c);
      const weight = float(1).sub(abs(phase.mul(2).sub(1)));
      // Sample upstream: the cloud now at longitude λ was at λ − ω·age.
      const angle = omega.mul(phase.mul(ADVECTION_CYCLE)).negate();
      const ca = cos(angle);
      const sa = sin(angle);
      const upstream = vec3(
        dir.x.mul(ca).add(dir.z.mul(sa)),
        dir.y,
        dir.z.mul(ca).sub(dir.x.mul(sa)),
      );
      // A fresh field per cycle, so each copy evolves rather than repeating.
      const seed = floor(c)
        .mul(vec3(17.31, 5.13, 11.71))
        .add(offset * 101.3);
      const q = upstream.mul(this.radius / CLOUD_WAVELENGTH).add(fract(seed.mul(0.618)).mul(100));
      // Large weather systems, plus finer cells that break up the edges.
      const systems = mx_fractal_noise_float(q, 4, 2, 0.5).mul(0.5).add(0.5);
      const cells = mx_fractal_noise_float(q.mul(9).add(vec3(13.1, 7.7, 3.3)), 4, 2.1, 0.55);
      density = density.add(systems.add(cells.mul(0.18)).mul(weight)) as F;
    }
    // Cross-fading two fields lowers contrast mid-fade; restore it around the mean.
    const n = density.sub(0.5).mul(1.25).add(0.5);
    const d = n.add(cloudiness.sub(0.3).mul(0.9)).add(this.coverageBias);
    return smoothstep(0.42, 0.85, d).mul(this.enabled) as F;
  }

  /** Fraction of sunlight reaching planet-centered point `p` past the clouds. */
  shadow(p: V3): F {
    const up = normalize(p);
    const height = length(p).sub(this.radius);
    const sun = this.lighting.sunDirection;
    const toShell = max(float(CLOUD_ALTITUDE).sub(height), 0).div(max(dot(up, sun), 0.08));
    const crossing = p.add(sun.mul(toShell));
    const underneath = smoothstep(CLOUD_ALTITUDE + 200, CLOUD_ALTITUDE - 200, height);
    return float(1).sub(this.coverage(crossing).mul(this.shadowStrength).mul(underneath)) as F;
  }

  private material(): MeshBasicNodeMaterial {
    const L = this.lighting;
    const m = new MeshBasicNodeMaterial({ side: DoubleSide, transparent: true, depthWrite: false });
    const apInscatter = varyingProperty('vec3', 'vCloudInscatter');
    const apTransmittance = varyingProperty('vec3', 'vCloudTransmittance');
    m.positionNode = Fn(() => {
      const ap = L.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz as V3,
        6,
      );
      apInscatter.assign(ap.inscatter);
      apTransmittance.assign(ap.transmittance);
      return positionLocal;
    })();
    const p = L.planetPosition(positionWorld as V3);
    const up = normalize(p) as V3;
    const cover = this.coverage(p);
    const sunUp = dot(up, L.sunDirection);
    // Lit from above: brighter as the sun climbs; undersides of thick cloud are darker.
    const sunlight = L.sunlightAt(p).mul(clamp(sunUp.add(0.25), 0, 1).mul(0.7).add(0.15));
    const sky = L.atmosphere.skyIrradiance(sunUp).mul(L.sunIlluminance.mul(L.skyLight));
    const night = vec3(0.55, 0.65, 1.0).mul(L.nightLight);
    const shade = mix(float(1), float(0.4).add(cover.oneMinus().mul(0.6)), this.below);
    const albedo = vec3(0.9, 0.91, 0.93).mul(shade);
    const radiance = albedo.mul(sunlight.add(sky).add(night)) as V3;
    m.colorNode = L.applyAerial(radiance, apInscatter as V3, apTransmittance as V3);
    m.opacityNode = cover.mul(0.95);
    return m;
  }

  /** Places the shell camera-relative and notes whether the camera is below it. */
  update(eye: Readonly<Vec3d>): void {
    this.mesh.position.set(-eye.x, -eye.y, -eye.z);
    this.below.value = eye.length() < this.radius + CLOUD_ALTITUDE ? 1 : 0;
    this.group.visible = this.enabled.value > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
