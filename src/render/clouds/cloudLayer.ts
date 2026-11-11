/**
 * Cloud layer (decisions 55, 59, 68): a shell at CLOUD_ALTITUDE above sea
 * level whose coverage comes from the sim's live weather.
 *
 * - Coverage: the weather texture gives the cloud cover fraction per weather
 *   sample (about 65 km), interpolated in space and between game hours. A
 *   detail field (about 150 km systems and 17 km cells) decides where inside
 *   that area the cloud sits: a fragment is cloudy where the detail value is
 *   below the cover fraction, so the mean coverage matches the weather.
 * - Motion: the weather systems move the cover; the detail field turns
 *   rigidly about the polar axis in two latitude bands (decision 59) and
 *   evolves slowly, so cloud edges drift without stretching.
 * - Precipitating cloud is darker.
 * - The shell is a cube-sphere mesh, drawn transparent and camera-relative
 *   (rule 4: the mesh sits at planet center − eye). Fragments compute coverage
 *   from their direction, so the mesh resolution does not limit the clouds.
 * - Lighting: sunlight filtered by the atmosphere (sunsets tint the clouds),
 *   brighter where the sun is high, plus sky light. Seen from below, thick cloud
 *   is darker. Aerial perspective per vertex, as on terrain.
 * - Shadows: `shadow(p)` is the sun visibility at a planet-centered point. It
 *   samples coverage where the ray toward the sun crosses the shell, and
 *   PlanetLighting applies it to every lit surface (terrain, water, trees).
 * - Baking (decision 69): shadows read the coverage from a texture baked by
 *   a compute pass (`bake`, coverageBake.ts), one texel instead of four
 *   fractal noises per fragment. The shell itself evaluates the field only
 *   while the camera is below DETAIL_ALTITUDE, where baked texels (about
 *   2 km) would look soft; above, it reads the bake as well.
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
  If,
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
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { WebGPURenderer } from 'three/webgpu';
import type { Vec3d } from '../../core/vec3d';
import { CoverageBake } from './coverageBake';
import type { WeatherTexture } from './weatherTexture';
import { buildCubeSphereArrays } from '../cubeSphereGeometry';
import type { PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Height of the cloud shell above sea level (m). */
export const CLOUD_ALTITUDE = 5000;
/** Base wavelength of the cloud detail noise (m); the weather grid supplies larger scales. */
const CLOUD_WAVELENGTH = 150_000;
/** Field speeds (m/s, eastward positive) at their reference latitudes: westerlies at 45°, trades at 15°. */
const WESTERLY: [number, number] = [12, Math.PI / 4];
const EASTERLY: [number, number] = [-7, Math.PI / 12];
/** Time for the cloud pattern to evolve by about one feature (s). */
const EVOLVE = 3 * 86_400;
/** Below this camera altitude (m) the shell evaluates the cloud field per fragment. */
const DETAIL_ALTITUDE = 40_000;

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
  /** 1 while the camera is low enough for the shell to evaluate the field itself. */
  private readonly detailed = uniform(1);
  private readonly mesh: Mesh;
  /** Coverage baked into a texture for shadows and distant views (decision 69). */
  readonly baked: CoverageBake;

  constructor(
    private readonly radius: number,
    private readonly lighting: PlanetLighting,
    private readonly weather: WeatherTexture,
  ) {
    this.baked = new CoverageBake({
      coverage: (d) => this.coverage(d),
      precipitation: (d) => this.weather.sample(d).precip,
    });
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
    const cover = this.weather.sample(dir).cover.add(this.coverageBias);
    // Detail: two independent fields, each turned rigidly about the polar axis (no
    // shear, so clouds never stretch): one eastward for the mid-latitude westerlies,
    // one westward for the trades and polar easterlies, blended across band edges.
    const lat = abs(asin(clamp(dir.y, -1, 1))).mul(180 / Math.PI);
    const westerlies = smoothstep(22, 32, lat).mul(float(1).sub(smoothstep(58, 68, lat)));
    const east = this.field(dir, WESTERLY, vec3(0, 0, 0));
    const west = this.field(dir, EASTERLY, vec3(41.7, 19.3, 73.1));
    // The detail value spread over roughly 0..1: cloudy where it is below the cover.
    const q = clamp(mix(west, east, westerlies).sub(0.5).mul(2.2).add(0.5), 0.02, 0.98);
    // Cover stretched by the blend half-width, so 0 is fully clear and 1 fully overcast.
    const stretched = cover.mul(1.2).sub(0.1);
    return smoothstep(q.sub(0.1), q.add(0.1), stretched).mul(this.enabled) as F;
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
    const cover = this.baked.sample(crossing).x;
    return float(1).sub(cover.mul(this.shadowStrength).mul(underneath)) as F;
  }

  /**
   * Re-bakes the coverage texture when the field has moved (call once per
   * frame, after setting `time`). Returns whether it baked.
   */
  bake(renderer: WebGPURenderer, nowMs: number): boolean {
    const key = [
      this.weather.version,
      this.enabled.value,
      this.coverageBias.value,
      this.windScale.value,
    ].join('|');
    return this.baked.update(renderer, this.time.value, key, nowMs);
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
    // The field itself near the camera, the bake from altitude (a uniform branch).
    const field = Fn(() => {
      const out = this.baked.sample(p).toVar();
      If(this.detailed.greaterThan(0.5), () => {
        out.assign(vec2(this.coverage(p), this.weather.sample(p).precip));
      });
      return out;
    })();
    const cover = field.x.mul(this.enabled);
    const sunUp = dot(up, L.sunDirection);
    // Lit from above: brighter as the sun climbs; undersides of thick cloud are darker.
    const sunlight = L.sunlightAt(p).mul(clamp(sunUp.add(0.25), 0, 1).mul(0.7).add(0.15));
    const sky = L.atmosphere.skyIrradiance(sunUp).mul(L.sunIlluminance.mul(L.skyLight));
    const night = vec3(0.55, 0.65, 1.0).mul(L.nightLight);
    const shade = mix(float(1), float(0.4).add(cover.oneMinus().mul(0.6)), this.below);
    // Rain and snow clouds are thicker and darker.
    const wet = float(1).sub(field.y.mul(0.4));
    const albedo = vec3(0.9, 0.91, 0.93).mul(shade).mul(wet);
    const radiance = albedo.mul(sunlight.add(sky).add(night)) as V3;
    m.colorNode = L.applyAerial(radiance, apInscatter as V3, apTransmittance as V3);
    m.opacityNode = cover.mul(0.95);
    return m;
  }

  /** Places the shell camera-relative and notes whether the camera is below it. */
  update(eye: Readonly<Vec3d>): void {
    this.mesh.position.set(-eye.x, -eye.y, -eye.z);
    this.below.value = eye.length() < this.radius + CLOUD_ALTITUDE ? 1 : 0;
    this.detailed.value = eye.length() < this.radius + DETAIL_ALTITUDE ? 1 : 0;
    this.group.visible = this.enabled.value > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
