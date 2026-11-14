/**
 * Cloud layer (decisions 55, 59, 68, 141): where the clouds are and what kind,
 * from the sim's live weather. It owns the coverage, its bake, the motion of
 * the clouds' fine structure, the shadow the clouds cast, and the shell that
 * stands in for them far above the simulation view.
 *
 * - Coverage: the weather texture gives the cloud cover fraction per weather
 *   sample (about 65 km), interpolated in space and between game hours. A
 *   detail field (about 150 km systems and 17 km cells) decides where inside
 *   that area the cloud sits: a point is cloudy where the detail value is
 *   below the cover fraction, so the mean coverage matches the weather.
 * - Motion: the weather systems move the cover; the detail field turns
 *   rigidly about the polar axis in two latitude bands (decision 59) and
 *   evolves slowly, so cloud edges drift without stretching. The 3D noise
 *   that shapes single clouds (noiseVolume.ts) turns with the band the camera
 *   is in (`upstream`), so heaps stay in their patch of coverage.
 * - Form: the bake also stores the cloud base and the development, the kind
 *   and depth of cloud (cloudForm.ts), from the weather's cloud base, cover,
 *   precipitation and storm field; the cores of the detail's cloud systems
 *   stand deeper than their edges. Storm towers stand where a cell pattern of
 *   about 45 km is strong inside a storm.
 * - Baking (decision 69): the field is evaluated into a half-float texture by
 *   a compute pass (`bake`, coverageBake.ts). The volumetric clouds, the
 *   shadow and the strategic map all read that texture, one texel per sample.
 * - Shadows: `shadow(p)` is the sun visibility at a planet-centered point. It
 *   follows the sun's ray to the level where the cloud above is widest and
 *   thresholds the shape noise there by the local coverage as the march does
 *   (one baked texel, one read of the noise), with a wider edge for a
 *   penumbra, so a cumulus and its shadow lie in the same place; the shadow
 *   deepens with the layer's thickness, and a closed deck's is all but
 *   complete. `overcast(p)` is how closed and deep the cloud above is, from
 *   the same texel: PlanetLighting grays and dims the sky light by it.
 *   Neither costs a read while no cloud is near (`cloudy`, from the weather
 *   around the camera on the CPU).
 * - The shell: a cube-sphere mesh, drawn transparent and camera-relative
 *   (rule 4), with the bake as flat cloud, as opaque as the volumetric clouds
 *   are on average. Those replace it inside the simulation view; it fades in
 *   above them between 30 and 50 km (`shell`), for the debug camera on its
 *   way to orbit, and stands in for them where the frame is drawn without
 *   the post-processing pipeline.
 */
import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  BufferAttribute,
  BufferGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import type { WeatherField } from '../../common/weatherField';
import {
  abs,
  asin,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  If,
  length,
  max,
  min,
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
import { placePlanetCentered } from '../../common/cameraRelative';
import { DEG } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import {
  BASE_SCALE,
  cloudColumn,
  DETAIL_SWING,
  coverageAt,
  development,
  developmentOf,
  meanDensity,
  thicknessOf,
  thicknessUpTo,
} from './cloudForm';
import type { CloudColumn } from './cloudForm';
import { CoverageBake } from './coverageBake';
import { cloudNoise } from './noiseVolume';
import type { NoiseVolumes } from './noiseVolume';
import type { WeatherExtent, WeatherTexture } from './weatherTexture';
import { buildCubeSphereArrays } from '../../common/cubeSphereGeometry';
import type { PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Height of the cloud shell above sea level (m) before any weather arrives. */
export const CLOUD_ALTITUDE = 5000;
/** Base wavelength of the cloud detail noise (m); the weather grid supplies larger scales. */
const CLOUD_WAVELENGTH = 150_000;
/** Wavelength of the cell pattern that places storm towers inside a storm (m). */
const TOWER_WAVELENGTH = 45_000;
/** Field speeds (m/s, eastward positive) at their reference latitudes: westerlies at 45°, trades at 15°. */
const WESTERLY: [number, number] = [12, Math.PI / 4];
const EASTERLY: [number, number] = [-7, Math.PI / 12];
/** Time for the cloud pattern to evolve by about one feature (s). */
const EVOLVE = 3 * 86_400;
/** Below this camera altitude (m) the shell evaluates the cloud field per fragment. */
const DETAIL_ALTITUDE = 40_000;
/** Edge length of one tile of the shape noise and of the detail noise (m). */
export const SHAPE_TILE = 10_000;
export const DETAIL_TILE = 2_400;
/** Velocity of the shape noise through the clouds (m/s): heaps change over about half an hour. */
const SHAPE_DRIFT = [0.9, 0.5, 0.6] as const;
/** Velocity of the detail noise (m/s): edges boil, upward and downwind. */
const DETAIL_DRIFT = [2.2, 3.1, 1.4] as const;
/**
 * Angle around the camera whose weather can be in view (rad): the horizon from
 * 20 km up (200 km) and cloud tops 12 km high beyond it (155 km), on a planet
 * of 1,000 km.
 */
export const VIEW_ANGLE = 0.38;
/** The highest a cloud top stands above sea level (m): what can show beyond the horizon. */
const TOP_MOST = 12_000;

/**
 * Angle around the camera whose weather can be in view from an altitude (m, rad): the
 * horizon, cloud tops beyond it and one weather sample's margin; VIEW_ANGLE at most. From
 * near the ground it is half of that from 20 km, so a quarter of the area is searched for
 * cloud, and the marches rest sooner and between tighter bounds.
 */
export function viewAngle(altitude: number, radius: number): number {
  const h = Math.max(altitude, 0);
  const horizon = Math.sqrt(h * (2 * radius + h));
  const beyond = Math.sqrt(TOP_MOST * (2 * radius + TOP_MOST));
  return Math.min(VIEW_ANGLE, (horizon + beyond) / radius + 0.02);
}
/** Camera altitudes (m) between which the shell takes over from the volumetric clouds. */
export const SHELL_FROM = 30_000;
export const SHELL_FULL = 50_000;
/**
 * Extinction of the cloud as its shadow counts it (1/m, at full density): of
 * heaps, whose shadows keep some light and a soft edge, and of a closed deck.
 */
const HEAP_SHADOW = 0.0017;
const DECK_SHADOW = 0.0036;
/** The share of a cloud's noise range over which its shadow deepens (the cloud's own is EDGE). */
const SHADOW_EDGE = 0.75;
/** Distances from the camera (m) over which the shadow loses the noise's fine and coarse structure. */
const SHADOW_SMOOTH: [number, number] = [20_000, 60_000];
const SHADOW_MEAN: [number, number] = [60_000, 150_000];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Share of the westerlies' field in the cloud detail at a latitude (rad), 0..1. */
function westerlyShare(latitude: number): number {
  const lat = Math.abs(latitude) / DEG;
  return smooth(22, 32, lat) * (1 - smooth(58, 68, lat));
}

export class CloudLayer implements WeatherField {
  readonly group = new Group();
  /** 1 draws clouds and their shadows. */
  readonly enabled = uniform(1);
  /** Shifts coverage: positive is cloudier. */
  readonly coverageBias = uniform(0);
  /** Game time (s): the field moves with it. */
  readonly time = uniform(0);
  /** Multiplies the prevailing winds that carry the clouds. */
  readonly windScale = uniform(1);
  /** How much sunlight the thickest cloud blocks. */
  readonly shadowStrength = uniform(0.94);
  /** 1 while cloud can be near the camera: the shadow reads nothing otherwise. Set by `update`. */
  readonly cloudy = uniform(0);
  /**
   * The level (m above sea level) at which the shadow first looks for cloud:
   * where the cloud around the camera is widest. Set by `update`.
   */
  readonly shadowAltitude = uniform(CLOUD_ALTITUDE);
  /** Opacity of the shell, 0..1: 0 while the volumetric clouds draw the sky. Set by `update`. */
  readonly shell = uniform(1);
  /**
   * Whether volumetric clouds are being drawn this frame (set by the scene):
   * the shell then shows only above them, from SHELL_FROM up.
   */
  volumetric = false;
  /** Draw the shell at all: off leaves the sky without cloud where the volumetric clouds are not drawn. */
  shellEnabled = true;
  /** The shape noise's turn about the polar axis, as (cosine, sine). Set by `update`. */
  readonly turn = uniform(new Vector2(1, 0));
  /** Offsets of the shape and the detail noise, in tiles. Set by `update`. */
  readonly shapeDrift = uniform(new Vector3());
  readonly detailDrift = uniform(new Vector3());
  /** The most the weather holds within view of the camera, as of `update`. */
  readonly extent: WeatherExtent = newExtent();
  /** Whether any cloud can be in view, and the lowest base and highest top it can have (m above sea level). */
  possible = false;
  bottom = 0;
  top = 0;
  /** 1 while the camera is below the cloud shell (undersides darken). */
  private readonly below = uniform(0);
  /** 1 while the camera is low enough for the shell to evaluate the field itself. */
  private readonly detailed = uniform(1);
  private readonly mesh: Mesh;
  /** Coverage, precipitation, cloud base and development baked into a texture (decisions 69, 141). */
  readonly baked: CoverageBake;
  private volumes: NoiseVolumes | null = null;
  /** The shadow's nodes per position node, so `shadow` and `overcast` share one evaluation. */
  private readonly lights = new WeakMap<object, Node<'vec2'>>();
  private readonly local: WeatherExtent = newExtent();
  private readonly up = new Vec3d();
  /** The shape noise's turn (rad) and the game time it was advanced to. */
  private angle = 0;
  private angleTime = 0;

  constructor(
    private readonly radius: number,
    private readonly lighting: PlanetLighting,
    private readonly weather: WeatherTexture,
    /** Interior texels per face edge of the bake (default BAKE_RESOLUTION; tests bake smaller). */
    bakeResolution?: number,
  ) {
    this.baked = new CoverageBake({ texel: (d) => this.texel(d) }, bakeResolution);
    const arrays = buildCubeSphereArrays(48, radius + CLOUD_ALTITUDE);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(arrays.positions, 3));
    g.setIndex(new BufferAttribute(arrays.indices, 1));
    this.mesh = new Mesh(g, this.material());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.group.add(this.mesh);
  }

  /** The noise volumes that shape single clouds, generated on first use. */
  get noise(): NoiseVolumes {
    return (this.volumes ??= cloudNoise());
  }

  /** Cloud coverage 0..1 at a direction from the planet center (any length). */
  coverage(direction: V3): F {
    const dir = normalize(direction) as V3;
    return this.coverageOf(this.weather.sample(dir).cover, this.detail(dir));
  }

  /**
   * The detail field at a unit direction, spread over roughly 0..1: a point is
   * cloudy where it is below the cover fraction.
   */
  private detail(dir: V3): F {
    // Two independent fields, each turned rigidly about the polar axis (no shear, so
    // clouds never stretch): one eastward for the mid-latitude westerlies, one westward
    // for the trades and polar easterlies, blended across band edges.
    const east = this.field(dir, WESTERLY, vec3(0, 0, 0));
    const west = this.field(dir, EASTERLY, vec3(41.7, 19.3, 73.1));
    return clamp(mix(west, east, this.westerlies(dir)).sub(0.5).mul(2.2).add(0.5), 0.02, 0.98) as F;
  }

  /** Coverage where the weather's cover fraction is `fraction` and the detail field `q`. */
  private coverageOf(fraction: F, q: F): F {
    const cover = fraction.add(this.coverageBias);
    // Cover stretched by the blend half-width, so 0 is fully clear and 1 fully overcast.
    const stretched = cover.mul(1.2).sub(0.1);
    return smoothstep(q.sub(0.1), q.add(0.1), stretched).mul(this.enabled) as F;
  }

  /** Share of the westerlies' field at a unit direction, 0..1. */
  private westerlies(dir: V3): F {
    const lat = abs(asin(clamp(dir.y, -1, 1))).mul(180 / Math.PI);
    return smoothstep(22, 32, lat).mul(float(1).sub(smoothstep(58, 68, lat))) as F;
  }

  /** A unit direction turned back about the polar axis to where its cloud was at time 0. */
  private upstreamOf(dir: V3, wind: [number, number]): V3 {
    const rate = wind[0] / (this.radius * Math.cos(wind[1]));
    // Sample upstream: the cloud now at longitude λ was at λ − ω·t.
    const angle = this.time.mul(-rate).mul(this.windScale);
    const ca = cos(angle);
    const sa = sin(angle);
    return vec3(dir.x.mul(ca).add(dir.z.mul(sa)), dir.y, dir.z.mul(ca).sub(dir.x.mul(sa))) as V3;
  }

  /**
   * One cloud field (about 0.5 ± 0.2) turned about the polar axis at the rate
   * that gives `wind` = [speed m/s, reference latitude], evolving slowly in place.
   */
  private field(dir: V3, wind: [number, number], offset: Node<'vec3'>): F {
    // Slow evolution: the noise volume moves through the shell, about one feature per EVOLVE s.
    const evolve = vec3(0.31, 0.83, 0.47).mul(this.time.div(EVOLVE));
    const q = this.upstreamOf(dir, wind)
      .mul(this.radius / CLOUD_WAVELENGTH)
      .add(offset)
      .add(evolve);
    // Large weather systems, plus finer cells that break up the edges.
    const systems = mx_fractal_noise_float(q, 4, 2, 0.5).mul(0.5).add(0.5);
    const cells = mx_fractal_noise_float(q.mul(9).add(vec3(13.1, 7.7, 3.3)), 4, 2.1, 0.55);
    return systems.add(cells.mul(0.18)) as F;
  }

  /** The storm cells' pattern at a unit direction, about −0.6..0.6: towers stand where it is high. */
  private towerCells(dir: V3): F {
    const at = (wind: [number, number], offset: [number, number, number]) =>
      mx_fractal_noise_float(
        this.upstreamOf(dir, wind)
          .mul(this.radius / TOWER_WAVELENGTH)
          .add(vec3(...offset)),
        2,
        2,
        0.5,
      );
    return mix(
      at(EASTERLY, [5.3, 91.7, 23.9]),
      at(WESTERLY, [67.1, 3.9, 48.2]),
      this.westerlies(dir),
    ) as F;
  }

  /** What the bake stores at a direction: coverage, precipitation, cloud base, development. */
  private texel(direction: V3): Node<'vec4'> {
    return Fn(() => {
      const dir = normalize(direction).toVar() as V3;
      const w = this.weather.sample(dir);
      const storm = w.storm.toVar();
      const tower = float(0).toVar();
      // The cell pattern is evaluated only inside storms.
      If(storm.greaterThan(0.02), () => {
        tower.assign(clamp(storm.mul(1.25), 0, 1).mul(smoothstep(0.02, 0.3, this.towerCells(dir))));
      });
      const q = this.detail(dir).toVar();
      // Deeper cloud in the cores of the detail's systems than at their edges.
      const local = w.cover.add(this.coverageBias).add(
        float(0.5)
          .sub(q)
          .mul(2 * DETAIL_SWING),
      );
      return vec4(
        this.coverageOf(w.cover, q as F),
        // Capped as the 8-bit bake capped it: the map's hatching reads this channel.
        clamp(w.precip, 0, 1),
        w.base.div(BASE_SCALE),
        development(local as F, w.precip, tower as F),
      );
    })() as Node<'vec4'>;
  }

  /** The cloud column the bake holds at a direction (any length): one texture read. */
  column(direction: V3): CloudColumn {
    const b = this.baked.sampleAll(direction).toVar();
    return cloudColumn(b.x as F, b.y as F, b.z.mul(BASE_SCALE) as F, b.w as F);
  }

  /**
   * A planet-centered position (or a direction) turned about the polar axis
   * to where the shape noise has it: clouds drift with the band's wind.
   */
  upstream(p: V3): V3 {
    const c = this.turn.x;
    const s = this.turn.y;
    return vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.z.mul(c).sub(p.x.mul(s))) as V3;
  }

  /** Position in tiles of the shape noise for an `upstream` position (m). */
  shapeCoordinate(upstream: V3): V3 {
    return upstream.div(SHAPE_TILE).add(this.shapeDrift) as V3;
  }

  /** Position in tiles of the detail noise for an `upstream` position (m). */
  detailCoordinate(upstream: V3): V3 {
    return upstream.div(DETAIL_TILE).add(this.detailDrift) as V3;
  }

  /**
   * (sun visibility, overcast) at planet-centered `p`, evaluated once per
   * position node: see the file comment.
   */
  private light(p: V3): Node<'vec2'> {
    const cached = this.lights.get(p);
    if (cached) return cached;
    const L = this.lighting;
    const result = Fn(() => {
      const out = vec2(1, 0).toVar();
      If(this.cloudy.greaterThan(0.5), () => {
        const sun = L.sunDirection;
        const r = length(p).toVar();
        const up = p.div(r).toVar();
        const height = r.sub(this.radius).toVar();
        const slant = float(1)
          .div(max(dot(up, sun), 0.08))
          .toVar();
        // The cloud above: where the sun's ray crosses the level of the widest cloud nearby.
        const first = p.add(sun.mul(max(this.shadowAltitude.sub(height), 0).mul(slant)));
        const column = this.column(first as V3);
        // Then along the ray to that cloud's own widest level.
        const level = column.base.add(min(column.thickness.mul(0.3), 1500)).toVar();
        const q = p.add(sun.mul(max(level.sub(height), 0).mul(slant))).toVar();
        const c = coverageAt(column, level as F, false).toVar();
        const n = this.noise.sampleShape(this.shapeCoordinate(this.upstream(q as V3))).toVar();
        // Far from the camera the march draws smoother cloud, and so does the shadow.
        const distance = length(q.sub(L.eye)).toVar();
        const noise = mix(n.x, n.y, smoothstep(SHADOW_SMOOTH[0], SHADOW_SMOOTH[1], distance));
        // A penumbra: the shadow's edge is wider than the cloud's own.
        const heaps = mix(
          smoothstep(c.oneMinus().sub(0.05), c.oneMinus().add(c.mul(SHADOW_EDGE)), noise),
          meanDensity(c as F),
          smoothstep(SHADOW_MEAN[0], SHADOW_MEAN[1], distance),
        );
        // A closed deck has cloud in every column: its depth varies, it does not open.
        const deck = c.mul(noise.mul(0.45).add(0.55)).mul(DECK_SHADOW / HEAP_SHADOW);
        const density = mix(heaps, deck, column.deck);
        const depth = density.mul(column.thickness).mul(HEAP_SHADOW).mul(min(slant, 2.5));
        const under = smoothstep(level.add(150), level.sub(150), height).toVar();
        const shade = float(1).sub(exp(depth.negate())).mul(this.shadowStrength).mul(under);
        // How closed and how deep: 0.4 under a deck of 1 km, 1 under a storm tower.
        const overcast = column.cover
          .mul(column.fill)
          .mul(clamp(column.thickness.div(9000).add(0.28), 0, 1))
          .mul(under);
        out.assign(vec2(shade.oneMinus(), overcast));
      });
      return out;
    })() as Node<'vec2'>;
    const shared = result.toVar() as Node<'vec2'>;
    this.lights.set(p, shared);
    return shared;
  }

  /** Fraction of sunlight reaching planet-centered point `p` past the clouds. */
  shadow(p: V3): F {
    return this.light(p).x as F;
  }

  /**
   * How closed and deep the cloud over planet-centered point `p` is, 0..1: 0
   * under a clear sky or between heaps, about 0.4 under an overcast deck,
   * 1 under a storm tower. Shares its texture reads with `shadow(p)` for the
   * same position node.
   */
  overcast(p: V3): F {
    return this.light(p).y as F;
  }

  /** Baked (coverage, precipitation) at a direction: the strategic map's clouds (decision 89). */
  sampleCoverage(direction: V3): Node<'vec2'> {
    return this.baked.sample(direction);
  }

  /**
   * Re-bakes the coverage texture when the field has moved (call once per
   * frame, after setting `time`). Returns whether it baked.
   */
  bake(renderer: WebGPURenderer, nowMs: number): boolean {
    const key = [
      this.weather.version,
      this.weather.fieldVersion,
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
      // Coverage, precipitation, and the share of a covered area its cloud fills.
      const column = this.column(p);
      const out = vec3(column.cover, column.precip, column.fill).toVar();
      If(this.detailed.greaterThan(0.5), () => {
        out.assign(vec3(this.coverage(p), this.weather.sample(p).precip, out.z));
      });
      return out;
    })();
    // Heaps cover a part of their patch: the shell is as opaque as the volumetric clouds it
    // stands in for are on average.
    const cover = field.x.mul(field.z).mul(this.enabled);
    const sunUp = dot(up, L.sunDirection);
    // Lit from above: brighter as the sun climbs; undersides of thick cloud are darker.
    const sunlight = L.sunlightAt(p).mul(clamp(sunUp.add(0.25), 0, 1).mul(0.7).add(0.15));
    const sky = L.atmosphere.skyIrradiance(sunUp).mul(L.sunIlluminance.mul(L.skyLight));
    const night = L.nightLightAt(p, up);
    const shade = mix(float(1), float(0.4).add(cover.oneMinus().mul(0.6)), this.below);
    // Rain and snow clouds are thicker and darker.
    const wet = float(1).sub(field.y.mul(0.4));
    const albedo = vec3(0.9, 0.91, 0.93).mul(shade).mul(wet);
    const radiance = albedo.mul(sunlight.add(sky).add(night)) as V3;
    m.colorNode = L.applyAerial(radiance, apInscatter as V3, apTransmittance as V3);
    m.opacityNode = cover.mul(0.95).mul(this.shell);
    return m;
  }

  /**
   * Per frame, with the camera's planet-centered position: places the shell,
   * advances the noise with the game clock (`time`), and takes stock of the
   * weather in view (whether cloud is possible, and between which heights).
   */
  update(eye: Readonly<Vec3d>): void {
    const distance = eye.length();
    const altitude = distance - this.radius;
    const up = this.up.copy(eye).normalize();
    const on = this.enabled.value > 0;

    // The weather in view, and right around the camera.
    const view = this.weather.extent(up, viewAngle(altitude, this.radius), this.extent);
    const bias = this.coverageBias.value;
    // Coverage is zero where the stretched cover stays under the detail field's lowest value.
    this.possible = on && (view.cover + bias) * 1.2 - 0.1 > 0.02 - 0.1;
    const deepest = Math.max(
      developmentOf(view.cover + bias + DETAIL_SWING, view.precip),
      view.storm > 0.02 ? 1 : 0,
    );
    this.bottom = view.baseMin;
    this.top = view.baseMax + thicknessUpTo(deepest);
    this.cloudy.value = this.possible ? 1 : 0;
    const near = this.weather.extent(up, 0, this.local);
    const widest =
      0.5 * (near.baseMin + near.baseMax) +
      Math.min(1500, 0.3 * thicknessOf(developmentOf(near.cover + bias, near.precip)));
    this.shadowAltitude.value = widest;

    // The noise turns with the band the camera is in; a jump of the clock sets it outright.
    const t = this.time.value;
    const share = westerlyShare(Math.asin(Math.min(1, Math.max(-1, up.y))));
    const rate =
      this.windScale.value *
      ((1 - share) * (EASTERLY[0] / (this.radius * Math.cos(EASTERLY[1]))) +
        share * (WESTERLY[0] / (this.radius * Math.cos(WESTERLY[1]))));
    const dt = t - this.angleTime;
    this.angle = dt < 0 || dt > 3600 ? -rate * t : this.angle - rate * dt;
    this.angle %= 2 * Math.PI;
    this.angleTime = t;
    this.turn.value.set(Math.cos(this.angle), Math.sin(this.angle));
    const wrap = (v: number) => v - Math.floor(v);
    this.shapeDrift.value.set(
      wrap((t * SHAPE_DRIFT[0]) / SHAPE_TILE),
      wrap((t * SHAPE_DRIFT[1]) / SHAPE_TILE),
      wrap((t * SHAPE_DRIFT[2]) / SHAPE_TILE),
    );
    this.detailDrift.value.set(
      wrap((t * DETAIL_DRIFT[0]) / DETAIL_TILE),
      wrap((t * DETAIL_DRIFT[1]) / DETAIL_TILE),
      wrap((t * DETAIL_DRIFT[2]) / DETAIL_TILE),
    );

    // The shell stands at the level of the widest cloud, and shows where the volumetric clouds do not.
    const shellAltitude = this.possible ? Math.max(1500, widest) : CLOUD_ALTITUDE;
    this.mesh.scale.setScalar((this.radius + shellAltitude) / (this.radius + CLOUD_ALTITUDE));
    placePlanetCentered(this.mesh, eye);
    this.shell.value = this.volumetric ? smooth(SHELL_FROM, SHELL_FULL, altitude) : 1;
    this.below.value = altitude < shellAltitude ? 1 : 0;
    // Under the volumetric clouds the shell only shows while it fades in: from the bake.
    this.detailed.value = altitude < DETAIL_ALTITUDE && !this.volumetric ? 1 : 0;
    this.group.visible = on && this.shellEnabled && this.shell.value > 0;
  }

  /** Opacity of the volumetric clouds, 0..1: they fade out as the shell fades in. */
  get volumetricFade(): number {
    return 1 - this.shell.value;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
    // The noise volumes are shared between cloud layers (`cloudNoise`) and stay.
    this.baked.dispose();
  }
}

function newExtent(): WeatherExtent {
  return { cover: 0, precip: 0, baseMin: 0, baseMax: 0, fog: 0, dust: 0, storm: 0, ground: 0 };
}
