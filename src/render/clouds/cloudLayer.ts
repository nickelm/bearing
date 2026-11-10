/**
 * Cloud layer (decision 55): a shell at CLOUD_ALTITUDE above sea level whose
 * coverage comes from a static field until live weather exists (milestone 6).
 *
 * - Coverage: 3D fractal noise for weather systems (base wavelength about
 *   300 km) and finer cells (about 33 km) that break up the edges,
 *   thresholded by the climate texture's cloudiness (from precipitation, decision
 *   42), so wet regions are cloudy and deserts clear.
 * - Motion: two independent fields turn rigidly about the polar axis, one
 *   eastward (westerlies, about 12 m/s at 45°) and one westward (trades and
 *   polar easterlies, about 7 m/s at 15°), blended by latitude band. Rigid
 *   motion has no shear, so clouds never stretch. Both evolve slowly in place.
 * - Climate: precipitation only shifts the odds of cloud, so wet regions and
 *   mountains still see the sun regularly.
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
  Fn,
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
/** Field speeds (m/s, eastward positive) at their reference latitudes: westerlies at 45°, trades at 15°. */
const WESTERLY: [number, number] = [12, Math.PI / 4];
const EASTERLY: [number, number] = [-7, Math.PI / 12];
/** Time for the cloud pattern to evolve by about one feature (s). */
const EVOLVE = 3 * 86_400;

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
    // Two independent fields, each turned rigidly about the polar axis (no shear, so
    // clouds never stretch): one eastward for the mid-latitude westerlies, one westward
    // for the trades and polar easterlies. They blend across the band edges.
    const lat = abs(asin(clamp(dir.y, -1, 1))).mul(180 / Math.PI);
    const westerlies = smoothstep(22, 32, lat).mul(float(1).sub(smoothstep(58, 68, lat)));
    const east = this.field(dir, WESTERLY, vec3(0, 0, 0));
    const west = this.field(dir, EASTERLY, vec3(41.7, 19.3, 73.1));
    const n = mix(west, east, westerlies);
    // Climate shifts the odds of cloud without saturating: the wettest regions are
    // usually cloudy but still clear regularly, deserts usually clear.
    const d = n.add(cloudiness.sub(0.4).mul(0.24)).add(this.coverageBias);
    return smoothstep(0.5, 0.74, d).mul(this.enabled) as F;
  }

  /**
   * One cloud field (about 0.5 ± 0.2) turned about the polar axis at the rate
   * that gives `wind` = [speed m/s, reference latitude], evolving slowly in place.
   */
  private field(dir: V3, wind: [number, number], offset: Node<'vec3'>): F {
    const rate = wind[0] / (this.radius * Math.cos(wind[1]));
    // Sample upstream: the cloud now at longitude λ was at λ − ω·t.
    const angle = this.time.mul(-rate).mul(this.windScale);
    const ca = cos(angle);
    const sa = sin(angle);
    const upstream = vec3(
      dir.x.mul(ca).add(dir.z.mul(sa)),
      dir.y,
      dir.z.mul(ca).sub(dir.x.mul(sa)),
    );
    // Slow evolution: the noise volume moves through the shell, about one feature per EVOLVE s.
    const evolve = vec3(0.31, 0.83, 0.47).mul(this.time.div(EVOLVE));
    const q = upstream
      .mul(this.radius / CLOUD_WAVELENGTH)
      .add(offset)
      .add(evolve);
    // Large weather systems, plus finer cells that break up the edges.
    const systems = mx_fractal_noise_float(q, 4, 2, 0.5).mul(0.5).add(0.5);
    const cells = mx_fractal_noise_float(q.mul(9).add(vec3(13.1, 7.7, 3.3)), 4, 2.1, 0.55);
    return systems.add(cells.mul(0.18)) as F;
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
