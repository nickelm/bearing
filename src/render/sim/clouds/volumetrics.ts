/**
 * Everything in the air between the camera and the scene (decision 141):
 * raymarched clouds, a cirrus sheet, fog and haze, dust, and rain shafts, as
 * the post-processing pipeline's volumetric source (post/simPipeline.ts). One
 * evaluation per low-resolution pixel returns the light scattered toward the
 * camera and the transmittance of what lies behind.
 *
 * Clouds
 * - Where: the cloud layer's bake gives, per sample, the coverage, the cloud
 *   base and the development (cloudLayer.ts, cloudForm.ts): one texture read.
 *   A point is in cloud where the tiling shape noise (noiseVolume.ts) exceeds
 *   a threshold set by the local coverage and the height in the layer; near
 *   the camera a finer noise erodes the edges. The noise turns about the
 *   polar axis with the coverage and drifts slowly, so clouds move with the
 *   wind and change shape.
 * - The march: the ray is cut to the shell between the lowest cloud base and
 *   the highest top in view (from the weather on the CPU). Steps grow with
 *   the distance (2% of it at high quality, never under 45 m) and are never
 *   shorter than what the rest of the ray needs to be covered by the steps
 *   left with geometric growth, so the march always reaches the end of the
 *   shell: the horizon included. Outside a column's own base and top the ray
 *   skips to where it enters them (exactly, for a locally level layer); where
 *   the noise is far under its threshold it takes longer steps. Where steps
 *   are long the shape noise gives way to its smooth channel and then to the
 *   layer's mean density, so far cloud is smooth instead of noisy. The march
 *   ends early once less than 1% of the light behind gets through.
 * - Light: the key light is the sun, or the moon once the sun is well down.
 *   Its color after the atmosphere is read at the two ends of the marched
 *   segment and interpolated (two reads per pixel, not one per step), so
 *   sunsets color the clouds and high tops stay lit after low cloud has gone
 *   gray. Its shadowing inside the cloud is two to four samples of the shape
 *   noise toward the light, reusing the step's baked column, plus the rest of
 *   the column analytically. The phase function has a forward lobe (silver
 *   lining) and a backward lobe; a second, slowly attenuated term stands for
 *   multiple scattering, and a powder term darkens thin edges seen from the
 *   light's side. Sky light comes from above and thins with the depth below
 *   the top; ground light comes from below. Lightning lights the cloud from
 *   inside (WeatherState.flash).
 * - Distance: the cloud's light is faded into the sky's own radiance in that
 *   direction by the air between the camera and the cloud's mean distance,
 *   so far cloud sinks into the haze at the horizon.
 * - Cirrus: one sheet at 10.5 km, two reads of a stretched noise field where
 *   the ray crosses it, lit by the key light's color there: it catches the
 *   low sun above the horizon.
 *
 * Air near the ground (fog, haze, dust, rain shafts), one march of 10 to 20
 * steps from the camera, spaced quadratically, over the reach the air's
 * extinction at the camera allows:
 * - Fog: the weather's fog extinction (the weather texture), full below a
 *   level 100 m over the mean ground around the camera and thinning above it
 *   with a scale height that grows as the fog thins (120 m for dense fog,
 *   1.5 km for haze), so fog pools in valleys and hills stand out of it. The
 *   exponential profile is integrated analytically over each step. Banks:
 *   two layers of noise moving with the wind at different speeds.
 * - Dust: an ochre layer up to 2 km deep where the weather's dust field is
 *   high, with a billowing wall where the field begins, and a dull disk
 *   where the sun stands behind it.
 * - Rain and snow: under precipitating cloud, veils from the base to the
 *   ground that lean with the wind.
 * - Light: the key light through the air's own depth toward it, the cloud
 *   shadow and the terrain shadow (crepuscular rays), a forward lobe (the
 *   glow around a low sun), and the sky's light.
 *
 * Cost. Texture reads per low-resolution pixel, at medium quality:
 * - Clear air: none (two uniform branches).
 * - Cloud: 1 per step for the column (40 steps at most), 1 more where the
 *   column has cloud at that height, and 1 + 3 (detail, light) where there
 *   is density: about 60 to 110 through fair-weather cumulus, 40 to 60
 *   through an overcast (early exit). Plus 9 per pixel (light color, sky,
 *   cirrus).
 * - Fog, dust or rain in view: 14 steps of 2 (weather) + 2 (noise) + 2 to 3
 *   (shadows), about 90.
 * `quality` sets the steps, the light samples and the pipeline's volumetric
 * scale: low (28 steps, 2 light samples, 10 air steps, 1/4), medium (40, 3,
 * 14, 1/3), high (48, 4, 20, 1/2).
 */
import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  Break,
  clamp,
  dot,
  exp,
  float,
  Fn,
  If,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  select,
  smoothstep,
  sqrt,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { DEG } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import { AtmosphereNodes } from '../atmosphere/atmosphere';
import { MOON_TINT, SKY_MARCH_STEPS_COARSE } from '../atmosphere/skyView';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { SimPipeline, VolumetricContext, VolumetricSource } from '../post/simPipeline';
import type { WeatherState } from '../weather/weatherState';
import { dustExtinction } from '../weather/weatherState';
import { coverageAt, densityFrom, meanDensity } from './cloudForm';
import type { CloudColumn } from './cloudForm';
import type { CloudLayer } from './cloudLayer';
import type { WeatherTexture } from './weatherTexture';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

export type VolumetricQuality = 'low' | 'medium' | 'high';

/** What a quality level sets. */
export interface QualityLevel {
  /** The pipeline's volumetric scale. */
  scale: number;
  /** Most steps of the cloud march. */
  cloudSteps: number;
  /** Samples toward the light per step in cloud. */
  lightSamples: 2 | 3 | 4;
  /** Steps of the march through fog, dust and rain. */
  airSteps: number;
  /** A step's length over its distance from the camera. */
  stepGrowth: number;
}

export const VOLUMETRIC_QUALITY: Record<VolumetricQuality, QualityLevel> = {
  low: { scale: 1 / 4, cloudSteps: 28, lightSamples: 2, airSteps: 10, stepGrowth: 0.035 },
  medium: { scale: 1 / 3, cloudSteps: 40, lightSamples: 3, airSteps: 14, stepGrowth: 0.026 },
  high: { scale: 1 / 2, cloudSteps: 48, lightSamples: 4, airSteps: 20, stepGrowth: 0.02 },
};

/** Shortest step of the cloud march (m). */
const MIN_STEP = 45;
/** Extinction of cloud at full density (1/m). */
export const CLOUD_EXTINCTION = 0.012;
/** Transmittance under which a march stops. */
const OPAQUE = 0.01;
/** Step lengths (m) over which the shape noise gives way to its smooth channel, and that to the mean density. */
const SMOOTH_STEPS: [number, number] = [700, 2500];
const MEAN_STEPS: [number, number] = [4000, 12_000];
/** Step lengths (m) over which the detail noise fades out. */
const DETAIL_STEPS: [number, number] = [200, 700];
/** How far the detail noise erodes a cloud's edge, 0..1. */
const EROSION = 0.38;
/** Distances of the light samples from the step (m), and the lengths of cloud each stands for. */
const LIGHT_SAMPLES: Record<2 | 3 | 4, { at: number[]; span: number[]; reach: number }> = {
  2: { at: [100, 480], span: [240, 660], reach: 900 },
  3: { at: [70, 240, 700], span: [155, 315, 690], reach: 1160 },
  4: { at: [55, 160, 400, 900], span: [110, 170, 370, 650], reach: 1300 },
};
/** Longest path counted for the rest of the column toward the light (m). */
const COLUMN_REACH = 5000;
/** The phase function's lobes: forward and backward asymmetry, and the backward lobe's share. */
const PHASE_FORWARD = 0.62;
const PHASE_BACK = -0.28;
const PHASE_BACK_SHARE = 0.4;
/** Gain of the directly lit term and of the multiple-scattering term, and the latter's attenuation. */
const DIRECT_GAIN = 1.15;
const MULTIPLE_GAIN = 0.6;
const MULTIPLE_ATTENUATION = 0.18;
/** How far thin edges darken when seen from the light's side, 0..1. */
const POWDER = 0.45;
/** Sky light on cloud, as a multiple of the sky's irradiance on level ground. */
const SKY_AMBIENT = 2.0;
/** How fast sky light thins with the optical depth of cloud above. */
const SKY_ATTENUATION = 0.2;
/** Light the ground sends back up, as a share of what reaches it. */
const GROUND_BOUNCE = 0.1;
/** A lightning flash inside cloud: radiance at the discharge, and the distance at which it has halved (m). */
const FLASH_LIGHT: [number, number, number] = [7, 8, 10];
const FLASH_RADIUS = 2600;

/** Altitude of the cirrus sheet above sea level (m). */
export const CIRRUS_ALTITUDE = 10_500;
/** Vertical optical depth of the densest cirrus. */
const CIRRUS_DEPTH = 0.55;
/** Length and width of the cirrus streaks' noise tile (m). */
const CIRRUS_LONG = 160_000;
const CIRRUS_SHORT = 42_000;

/** Height above the mean ground up to which fog has its full density (m). */
export const FOG_FLOOR = 100;
/** Fog scale height = FOG_SCALE / extinction, held between these (m): dense fog is shallow, haze deep. */
const FOG_SCALE = 0.5;
const FOG_HEIGHT: [number, number] = [120, 1500];
/** Edge of one tile of the fog banks' noise (m), and of its second layer. */
const FOG_TILE = 2600;
const FOG_TILE_FINE = 900;
/** Height of a full dust storm over the fog floor (m). */
const DUST_DEPTH = 2000;
/** Extinction of rain shafts at 4 mm/h (1/m). */
const RAIN_EXTINCTION = 4.5e-4;
/** Optical depth along the air march at which it may stop looking further. */
const AIR_REACH = 9;
/** Shortest reach of the air march (m). */
const AIR_MIN_REACH = 1500;
/** Scattering colors of fog, dust and rain. */
const FOG_ALBEDO: [number, number, number] = [0.93, 0.95, 0.98];
const DUST_ALBEDO: [number, number, number] = [0.86, 0.6, 0.33];
const RAIN_ALBEDO: [number, number, number] = [0.66, 0.7, 0.76];
/** Sun elevations (rad) between which the sun hands the key light to the moon. */
const KEY_SUN: [number, number] = [-6.5 * DEG, -5 * DEG];
const KEY_MOON: [number, number] = [-6.5 * DEG, -8 * DEG];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface VolumetricsOptions {
  lighting: PlanetLighting;
  clouds: CloudLayer;
  weather: WeatherTexture;
  state: WeatherState;
}

/** What the last `update` found (for statistics, previews and tests). */
export interface VolumetricStats {
  /** Whether the cloud march and the air march run this frame. */
  clouds: boolean;
  air: boolean;
  /** The cloud shell's bounds above sea level (m). */
  bottom: number;
  top: number;
  /** The top of the air march's layer above sea level (m). */
  airTop: number;
}

export class Volumetrics {
  /** The source for `SimPipeline.volumetrics`; a new object whenever the quality changes. */
  source: VolumetricSource;
  /** Amount of cirrus, 0..1. */
  readonly cirrus = uniform(0.55);
  /** Draw fog, dust and rain shafts. */
  airEnabled = true;
  /** Draw the clouds (the cloud layer's own `enabled` hides them and their shadows together). */
  cloudsEnabled = true;
  readonly stats: VolumetricStats = { clouds: false, air: false, bottom: 0, top: 0, airTop: 0 };

  /** 1 while cloud can be in view, and while fog, dust or rain can. */
  private readonly cloudOn = uniform(0);
  private readonly airOn = uniform(0);
  /** 1 while a storm is in view: towers, and lightning inside them. */
  private readonly stormOn = uniform(0);
  /** 1 while it can rain or snow in view. */
  private readonly rainOn = uniform(0);
  /** 1 while dust is in view. */
  private readonly dustOn = uniform(0);
  /** 1 while the key light is the sun above the horizon: the air march reads the shadows. */
  private readonly shafts = uniform(0);
  /** Opacity of everything, 0..1: fades out toward the shell above the simulation view. */
  private readonly fade = uniform(1);
  /** The cloud shell's lowest base and highest top above sea level (m). */
  private readonly bottom = uniform(0);
  private readonly top = uniform(0);
  /** Unit vector toward the key light and its light before the atmosphere. */
  private readonly keyDirection = uniform(new Vector3(0, 1, 0));
  private readonly keyLight = uniform(new Vector3());
  /** The level under which fog is full (m above sea level), and the top of the air march's layer. */
  private readonly fogLevel = uniform(0);
  private readonly airTop = uniform(0);
  /** Extinction of the air at the camera (1/m): sets the air march's reach. */
  private readonly airNear = uniform(0);
  /** Offsets of the fog banks' two noise layers, in tiles: the wind's path. */
  private readonly fogShift = uniform(new Vector3());
  private readonly fogShiftFine = uniform(new Vector3());
  /** How far rain veils lean per meter of height: the wind over the fall speed, world frame. */
  private readonly lean = uniform(new Vector3());

  private level: VolumetricQuality = 'medium';
  private pipeline: SimPipeline | null = null;
  /** The wind's path so far (m), for the fog banks. */
  private readonly path = new Vector3();
  private readonly pathFine = new Vector3();
  private readonly up = new Vec3d();

  constructor(private readonly o: VolumetricsOptions) {
    this.source = this.createSource();
  }

  /** Steps, light samples and resolution (see `VOLUMETRIC_QUALITY`). Changing it rebuilds the shader. */
  get quality(): VolumetricQuality {
    return this.level;
  }

  set quality(level: VolumetricQuality) {
    if (level === this.level) return;
    this.level = level;
    this.source = this.createSource();
    if (this.pipeline) this.attach(this.pipeline);
  }

  /** Makes this the pipeline's volumetric source, at the quality's resolution. */
  attach(pipeline: SimPipeline): void {
    this.pipeline = pipeline;
    pipeline.volumetrics = this.source;
    pipeline.volumetricScale = VOLUMETRIC_QUALITY[this.level].scale;
  }

  private createSource(): VolumetricSource {
    const level = VOLUMETRIC_QUALITY[this.level];
    return { build: (ctx) => this.build(ctx, level) };
  }

  /**
   * Per frame, after the cloud layer's and the lighting's updates: decides
   * which marches run, bounds them, picks the key light and moves the fog
   * with the wind. `eye` is the camera, planet-centered; `dt` real seconds.
   */
  update(eye: Readonly<Vec3d>, dt: number): void {
    const { clouds, lighting, state, weather } = this.o;
    const distance = eye.length();
    const altitude = distance - lighting.radius;
    const fade = clouds.volumetricFade;
    this.fade.value = fade;
    const view = clouds.extent;

    const cloudOn = this.cloudsEnabled && clouds.possible && fade > 0;
    this.cloudOn.value = cloudOn ? 1 : 0;
    this.bottom.value = clouds.bottom;
    this.top.value = Math.max(clouds.top, clouds.bottom + 100);
    this.stormOn.value = view.storm > 0.02 ? 1 : 0;

    // The air near the ground: fog, dust, and rain under cloud.
    const raining = cloudOn && view.precip > 0.02;
    const airOn =
      this.airEnabled && fade > 0 && (view.fog > 2e-6 || view.dust > 0.03 || raining);
    this.airOn.value = airOn ? 1 : 0;
    this.rainOn.value = raining ? 1 : 0;
    this.dustOn.value = view.dust > 0.03 ? 1 : 0;
    const up = this.up.copy(eye).normalize();
    const level = weather.groundAt(up) + FOG_FLOOR;
    this.fogLevel.value = level;
    const fog = Math.max(state.fog.value, 0.25 * view.fog);
    const fogHeight = Math.min(FOG_HEIGHT[1], Math.max(FOG_HEIGHT[0], FOG_SCALE / Math.max(fog, 1e-9)));
    let airTop = level;
    if (view.fog > 2e-6) airTop = Math.max(airTop, level + 4 * fogHeight);
    if (view.dust > 0.03) airTop = Math.max(airTop, level + DUST_DEPTH * 1.4);
    if (raining) airTop = Math.max(airTop, clouds.extent.baseMax + 300);
    this.airTop.value = airTop;
    // What the camera stands in: fog by its height, dust, and rain's share.
    const above = Math.max(0, altitude - level);
    const near =
      state.fog.value * Math.exp(-above / fogHeight) +
      (above < DUST_DEPTH ? dustExtinction(state.dust.value) : 0) +
      RAIN_EXTINCTION * Math.max(state.rain.value, state.snow.value);
    this.airNear.value = near;

    // The key light: the sun, or the moon once the sun is well under the horizon.
    const el = lighting.sunElevation;
    const sunKey = el > KEY_SUN[0] || lighting.moonIlluminance.value <= 0;
    if (sunKey) {
      this.keyDirection.value.copy(lighting.sunDirection.value);
      const e = lighting.sunIlluminance.value * smooth(KEY_SUN[0], KEY_SUN[1], el);
      this.keyLight.value.set(e, e, e);
    } else {
      this.keyDirection.value.copy(lighting.moonDirection.value);
      const e = lighting.moonIlluminance.value * smooth(KEY_MOON[0], KEY_MOON[1], el);
      this.keyLight.value.set(MOON_TINT[0] * e, MOON_TINT[1] * e, MOON_TINT[2] * e);
    }
    this.shafts.value = sunKey && el > -3 * DEG ? 1 : 0;

    // Fog banks drift with the wind; the finer layer lags and slides across it, so banks curl.
    const wind = state.wind.value;
    const step = Math.max(0, dt);
    this.path.addScaledVector(wind, step);
    this.pathFine.x += (0.55 * wind.x + 0.8 * up.z - 0.5 * up.y) * step;
    this.pathFine.y += (0.55 * wind.y + 0.8 * up.x + 0.6 * up.z) * step;
    this.pathFine.z += (0.55 * wind.z - 0.8 * up.x + 0.5 * up.y) * step;
    const wrap = (v: number) => v - Math.floor(v);
    this.fogShift.value.set(
      wrap(-this.path.x / FOG_TILE),
      wrap(-this.path.y / FOG_TILE),
      wrap(-this.path.z / FOG_TILE),
    );
    this.fogShiftFine.value.set(
      wrap(-this.pathFine.x / FOG_TILE_FINE),
      wrap(-this.pathFine.y / FOG_TILE_FINE),
      wrap(-this.pathFine.z / FOG_TILE_FINE),
    );
    // Rain falls at about 7 m/s and snow at 1.5: the veils lean by the wind over that.
    const fall = state.snow.value > state.rain.value ? 1.5 : 7;
    const speed = Math.hypot(wind.x, wind.y, wind.z);
    const k = speed > 0 ? Math.min(3, speed / fall) / speed : 0;
    this.lean.value.set(wind.x * k, wind.y * k, wind.z * k);

    const s = this.stats;
    s.clouds = cloudOn;
    s.air = airOn;
    s.bottom = this.bottom.value;
    s.top = this.top.value;
    s.airTop = airTop;
  }

  /** Forgets the wind's path (a new flight, a preview view): fog banks start from the same place. */
  reset(): void {
    this.path.set(0, 0, 0);
    this.pathFine.set(0, 0, 0);
  }

  // ---- The shader ----

  private build(ctx: VolumetricContext, level: QualityLevel): V4 {
    const L = this.o.lighting;
    const radius = L.radius;
    return Fn(() => {
      const result = vec4(0, 0, 0, 1).toVar();
      If(this.cloudOn.add(this.airOn).greaterThan(0.5), () => {
        const ro = L.eye as unknown as V3;
        const rd = ctx.rayDirection;
        const r0 = length(ro).toVar();
        const h0 = r0.sub(radius).toVar();
        const up0 = ro.div(r0).toVar();
        // b = ro·rd: the ray's parameter of closest approach to the planet's center is −b.
        const b = dot(ro, rd).toVar();
        /** Distances along the ray to the sphere at an altitude: disc < 0 misses it. */
        const sphere = (altitude: F) => {
          const c = h0.sub(altitude).mul(r0.add(radius).add(altitude));
          const disc = b.mul(b).sub(c).toVar();
          const root = sqrt(max(disc, 0)).toVar();
          return { disc, near: b.negate().sub(root) as F, far: b.negate().add(root) as F };
        };
        // The ray ends at the scene, or at sea level where nothing was drawn.
        const ground = sphere(float(0) as F);
        const end = select(
          ground.disc.greaterThan(0).and(ground.near.greaterThan(0)),
          min(ctx.sceneDistance, ground.near),
          ctx.sceneDistance,
        ).toVar() as F;

        const key = this.keyDirection as unknown as V3;
        const cosKey = dot(rd, key).toVar() as F;
        const keyAt = (p: V3): V3 =>
          L.atmosphere.lightTransmittance(p, key).mul(this.keyLight) as V3;
        // The sky's light on level ground at the camera, and the night's own.
        const skyLight = L.atmosphere
          .skyIrradiance(dot(up0, L.sunDirection) as F)
          .mul(L.sunIlluminance)
          .add(L.moonSkyAt(up0 as V3).div(L.skyLight))
          .add(vec3(0.55, 0.65, 1.0).mul(L.nightLight).mul(0.4))
          .toVar() as V3;
        const skyAhead = L.atmosphere.skyRadiance(rd, SKY_MARCH_STEPS_COARSE).toVar() as V3;
        /** Light of something `distance` away, faded into the sky's by the air in front of it. */
        const throughAir = (light: V3, opacity: F, distance: F): V3 => {
          const far = ro.add(rd.mul(distance));
          const middle = max(h0.add(length(far).sub(radius)).mul(0.5), 0);
          const air = exp(L.atmosphere.medium(middle as F).extinction.mul(distance).negate());
          const t = mix(vec3(1), air, L.atmosphere.enabled).toVar();
          const haze = skyAhead
            .mul(t.oneMinus())
            .mul(L.atmosphere.aerialGain(t as V3))
            .mul(opacity);
          return light.mul(t).add(haze) as V3;
        };

        // rgb: light scattered toward the camera; a: transmittance. Distances for the order.
        const cloud = vec4(0, 0, 0, 1).toVar();
        const cloudDistance = float(1e9).toVar();
        const air = vec4(0, 0, 0, 1).toVar();
        const airDistance = float(0).toVar();

        If(this.cloudOn.greaterThan(0.5), () => {
          this.marchClouds({
            ctx,
            level,
            ro,
            rd,
            r0: r0 as F,
            h0: h0 as F,
            end,
            sphere,
            cosKey,
            keyAt,
            skyLight,
            throughAir,
            out: cloud,
            outDistance: cloudDistance,
          });
        });
        If(this.airOn.greaterThan(0.5), () => {
          this.marchAir({
            ctx,
            level,
            ro,
            rd,
            h0: h0 as F,
            up0: up0 as V3,
            end,
            sphere,
            cosKey,
            keyAt,
            skyLight,
            throughAir,
            out: air,
            outDistance: airDistance,
          });
        });

        // The nearer of the two in front.
        const airFirst = airDistance.lessThan(cloudDistance);
        const front = select(airFirst, air, cloud).toVar();
        const back = select(airFirst, cloud, air).toVar();
        const combined = vec4(front.rgb.add(back.rgb.mul(front.a)), front.a.mul(back.a));
        result.assign(mix(vec4(0, 0, 0, 1), combined, this.fade));
      });
      return result;
    })() as V4;
  }

  /** The dual-lobe phase function, scaled so that an isotropic one is 1. */
  private static phase(cos: F, forward: number, back: number, backShare: number): F {
    return mix(
      AtmosphereNodes.hgPhase(cos, forward),
      AtmosphereNodes.hgPhase(cos, back),
      backShare,
    ).mul(4 * Math.PI) as F;
  }

  private marchClouds(a: {
    ctx: VolumetricContext;
    level: QualityLevel;
    ro: V3;
    rd: V3;
    r0: F;
    h0: F;
    end: F;
    sphere: (altitude: F) => { disc: F; near: F; far: F };
    cosKey: F;
    keyAt: (p: V3) => V3;
    skyLight: V3;
    throughAir: (light: V3, opacity: F, distance: F) => V3;
    out: Node<'vec4'>;
    outDistance: F;
  }): void {
    const { clouds, lighting: L, state } = this.o;
    const radius = L.radius;
    const { ro, rd, h0, level } = a;
    const steps = level.cloudSteps;
    const light = LIGHT_SAMPLES[level.lightSamples];
    // Growth per step that lets the steps left always cover the rest of the longest ray.
    const growth = 800 ** (1 / steps);
    const key = this.keyDirection as unknown as V3;

    // The shell between the lowest base and the highest top.
    const top = a.sphere(this.top as unknown as F);
    const bottom = a.sphere(this.bottom as unknown as F);
    const start = select(h0.lessThan(this.bottom), bottom.far, max(top.near, 0)).toVar();
    const stop = min(top.far, a.end).toVar();

    const transmittance = float(1).toVar();
    const scattered = vec3(0).toVar();
    // Opacity-weighted distance, for the air in front of the cloud.
    const weight = float(0).toVar();
    const weighted = float(0).toVar();

    If(top.disc.greaterThan(0).and(stop.greaterThan(start)), () => {
      // The key light's color at both ends of the segment (at most 80 km apart).
      const span = min(stop.sub(start), 80_000).toVar();
      const keyNear = a.keyAt(ro.add(rd.mul(start)) as V3).toVar();
      const keyFar = a.keyAt(ro.add(rd.mul(start.add(span))) as V3).toVar();
      const phase = Volumetrics.phase(a.cosKey, PHASE_FORWARD, PHASE_BACK, PHASE_BACK_SHARE)
        .mul(DIRECT_GAIN)
        .toVar();
      // Thin edges darken when the light is behind the viewer.
      const powder = clamp(a.cosKey.negate().mul(0.5).add(0.5), 0, 1).mul(POWDER).toVar();
      const upstreamOrigin = clouds.upstream(ro).toVar();
      const upstreamRay = clouds.upstream(rd).toVar();
      const upstreamKey = clouds.upstream(key).toVar();

      const t = start.toVar();
      Loop(steps, ({ i }) => {
        If(t.greaterThanEqual(stop).or(transmittance.lessThan(OPAQUE)), () => {
          Break();
        });
        // The step: a share of the distance, and never less than the rest of the ray needs.
        const left = float(steps).sub(float(i));
        const needed = stop.sub(t).mul(growth - 1).div(exp(left.mul(Math.log(growth))).sub(1));
        const step = max(clamp(t.mul(level.stepGrowth), MIN_STEP, 20_000), needed).toVar();
        const ts = t.add(step.mul(a.ctx.jitter)).toVar();
        const p = ro.add(rd.mul(ts)).toVar();
        const r = length(p).toVar();
        const up = p.div(r).toVar();
        const h = r.sub(radius).toVar();
        const mu = dot(up, rd).toVar();
        const column = clouds.column(p as V3);
        const base = column.base.toVar();
        const thickness = column.thickness.toVar();
        const cover = column.cover.toVar();
        const held: CloudColumn = {
          ...column,
          base: base as F,
          thickness: thickness as F,
          cover: cover as F,
          fill: column.fill.toVar() as F,
          deck: column.deck.toVar() as F,
          tower: column.tower.toVar() as F,
        };
        const above = h.sub(base).toVar();
        const advance = step.toVar();

        If(cover.lessThan(0.004), () => {
          // Clear of cloud: coverage has soft edges kilometers wide.
          advance.assign(max(step.mul(4), 600));
        })
          .ElseIf(above.lessThan(0), () => {
            // Under this column's base: to where the ray reaches it (on a sphere, exactly).
            const to = r.mul(sqrt(mu.mul(mu).add(above.negate().mul(2).div(r))).sub(mu));
            advance.assign(clamp(to.add(1), step, max(step.mul(12), 4000)));
          })
          .ElseIf(above.greaterThan(thickness), () => {
            // Over its top: down to it if the ray dips that far, otherwise on.
            const over = above.sub(thickness);
            const disc = mu.mul(mu).sub(over.mul(2).div(r));
            const to = select(
              mu.lessThan(0).and(disc.greaterThan(0)),
              r.mul(mu.negate().sub(sqrt(max(disc, 0)))).add(1),
              float(1e9),
            );
            advance.assign(clamp(to, step, max(step.mul(8), 1200)));
          })
          .Else(() => {
            const c = coverageAt(held, h as F).toVar();
            If(c.lessThan(0.01), () => {
              advance.assign(step.mul(2));
            }).Else(() => {
              // Long steps cannot resolve the noise: its smooth channel, then the mean.
              const smoothed = smoothstep(SMOOTH_STEPS[0], SMOOTH_STEPS[1], step).toVar();
              const mean = smoothstep(MEAN_STEPS[0], MEAN_STEPS[1], step).toVar();
              const upstream = upstreamOrigin.add(upstreamRay.mul(ts)).toVar();
              const density = meanDensity(c as F).toVar();
              const noise = float(0.5).toVar();
              If(mean.lessThan(1), () => {
                const n = clouds.noise.sampleShape(clouds.shapeCoordinate(upstream as V3));
                noise.assign(mix(n.x, n.y, smoothed));
                density.assign(mix(densityFrom(c as F, noise as F), density, mean));
              });
              If(density.lessThanEqual(0.0015), () => {
                // The further the noise is under its threshold, the further the next cloud.
                const gap = clamp(c.oneMinus().sub(noise).div(0.25), 0, 1);
                advance.assign(step.mul(gap.mul(2).add(1)));
              }).Else(() => {
                const y = clamp(above.div(thickness), 0, 1).toVar();
                const detail = float(1)
                  .sub(smoothstep(DETAIL_STEPS[0], DETAIL_STEPS[1], step))
                  .toVar();
                If(detail.greaterThan(0), () => {
                  const e = clouds.noise.sampleDetail(clouds.detailCoordinate(upstream as V3));
                  // Wisps under the cloud, billows on top.
                  const cells = mix(e.y, e.x, clamp(y.mul(4), 0, 1));
                  const cut = cells.mul(EROSION).mul(detail);
                  density.assign(clamp(density.sub(cut).div(cut.oneMinus()), 0, 1));
                });
                // Denser toward the top of a heap; rain cloud is denser throughout.
                const body = mix(y.mul(0.9).add(0.55), float(1), held.deck).mul(
                  held.precip.mul(0.5).add(1),
                );
                const extinction = density.mul(body).mul(CLOUD_EXTINCTION).toVar();

                // Toward the light: a few samples of the shape noise in this column, then the
                // rest of the column by its mean.
                const muKey = dot(up, key).toVar();
                const depth = float(0).toVar();
                If(mean.lessThan(1), () => {
                  for (let j = 0; j < light.at.length; j++) {
                    const d = light.at[j]!;
                    const hq = h.add(muKey.mul(d));
                    const cq = coverageAt(held, hq as F);
                    const nq = clouds.noise.sampleShape(
                      clouds.shapeCoordinate(upstream.add(upstreamKey.mul(d)) as V3),
                    );
                    const dq = densityFrom(cq, mix(nq.x, nq.y, smoothed) as F);
                    depth.addAssign(dq.mul(light.span[j]!));
                  }
                  depth.assign(mix(depth, density.mul(light.reach), mean));
                }).Else(() => {
                  depth.assign(density.mul(light.reach));
                });
                const hEnd = h.add(muKey.mul(light.reach));
                const rest = select(
                  muKey.greaterThan(0),
                  base.add(thickness).sub(hEnd),
                  hEnd.sub(base),
                );
                const path = min(max(rest, 0).div(max(abs(muKey), 0.15)), COLUMN_REACH);
                depth.addAssign(path.mul(cover).mul(held.fill).mul(0.3));
                const tau = depth.mul(CLOUD_EXTINCTION).toVar();

                const keyColor = mix(keyNear, keyFar, clamp(ts.sub(start).div(span), 0, 1));
                const lit = exp(tau.negate())
                  .mul(phase)
                  .mul(
                    float(1).sub(
                      powder.mul(exp(tau.mul(-2).sub(density.mul(3)))),
                    ),
                  )
                  .add(exp(tau.mul(-MULTIPLE_ATTENUATION)).mul(MULTIPLE_GAIN));
                // Sky light from above through the cloud over the sample; ground light from below.
                const over = max(base.add(thickness).sub(h), 0).mul(cover).mul(held.fill);
                const under = max(above, 0).mul(cover).mul(held.fill);
                const fromSky = exp(over.mul(-0.5 * CLOUD_EXTINCTION * SKY_ATTENUATION)).mul(
                  y.mul(0.7).add(0.3),
                );
                const fromGround = exp(under.mul(-0.5 * CLOUD_EXTINCTION * SKY_ATTENUATION));
                const groundLight = keyColor
                  .mul(max(muKey, 0))
                  .add(a.skyLight)
                  .mul(GROUND_BOUNCE);
                const source = keyColor
                  .mul(lit)
                  .add(a.skyLight.mul(fromSky).mul(SKY_AMBIENT))
                  .add(groundLight.mul(fromGround))
                  .toVar();
                If(this.stormOn.greaterThan(0.5), () => {
                  // Lightning inside the cloud.
                  const away = p.sub(state.flashPosition);
                  const reach = FLASH_RADIUS * FLASH_RADIUS;
                  source.addAssign(
                    vec3(...FLASH_LIGHT).mul(
                      state.flash.mul(float(reach).div(dot(away, away).add(reach))),
                    ),
                  );
                });
                // Rain cloud absorbs: darker, bluer bases.
                const albedo = mix(vec3(1), vec3(0.62, 0.68, 0.78), clamp(held.precip, 0, 1));
                const through = exp(extinction.mul(step).negate()).toVar();
                const share = transmittance.mul(through.oneMinus()).toVar();
                scattered.addAssign(source.mul(albedo).mul(share));
                weight.addAssign(share);
                weighted.addAssign(share.mul(ts));
                transmittance.mulAssign(through);
              });
            });
          });
        t.addAssign(advance);
      });
    });

    const opacity = transmittance.oneMinus().toVar();
    const distance = weighted.div(max(weight, 1e-6)).toVar();
    const light3 = select(
      weight.greaterThan(1e-5),
      a.throughAir(scattered as V3, opacity as F, distance as F),
      vec3(0),
    ).toVar();
    a.outDistance.assign(select(weight.greaterThan(1e-5), distance, float(1e9)));
    a.out.assign(vec4(light3, transmittance));

    // Cirrus: one sheet, where the ray crosses its altitude.
    const sheet = a.sphere(float(CIRRUS_ALTITUDE) as F);
    const below = h0.lessThan(CIRRUS_ALTITUDE);
    const crossing = select(below, sheet.far, sheet.near).toVar();
    const crosses = sheet.disc
      .greaterThan(0)
      .and(crossing.greaterThan(0))
      .and(crossing.lessThan(a.end));
    If(crosses.and(this.cirrus.greaterThan(0)), () => {
      const p = ro.add(rd.mul(crossing)).toVar();
      const up = normalize(p).toVar();
      const upstream = clouds.upstream(p as V3).toVar();
      // Streaks along one axis, in patches a few hundred kilometers wide.
      const streak = vec3(
        upstream.x.div(CIRRUS_LONG),
        upstream.y.div(CIRRUS_SHORT),
        upstream.z.div(CIRRUS_SHORT),
      ).add(clouds.shapeDrift);
      const fine = clouds.noise.sampleShape(streak as V3).z;
      const patches = clouds.noise.sampleShape(upstream.div(380_000).add(vec3(0.37, 0.11, 0.71)) as V3).z;
      // More cirrus where the weather has more cloud; none under a cloudless sky.
      const cover = this.o.weather.sample(p as V3).cover;
      const amount = this.cirrus.mul(smoothstep(0.02, 0.45, cover).mul(0.75).add(0.25));
      const field = fine.mul(0.55).add(patches.mul(0.75)).sub(float(1.02).sub(amount.mul(0.5)));
      const density = smoothstep(0, 0.22, field);
      // The sheet thins to nothing as the camera passes through it.
      const near = smoothstep(0, 500, abs(h0.sub(CIRRUS_ALTITUDE)));
      const slant = float(1).div(max(abs(dot(up, rd)), 0.1));
      const depth = density.mul(CIRRUS_DEPTH).mul(slant).mul(near);
      const through = exp(depth.negate()).toVar();
      // Ice scatters forward: bright toward the sun, and lit from below once the sun is under it.
      const lit = a
        .keyAt(p as V3)
        .mul(Volumetrics.phase(a.cosKey, 0.7, -0.15, 0.55).mul(0.75))
        .add(a.skyLight.mul(SKY_AMBIENT));
      const sheetLight = a
        .throughAir(lit.mul(through.oneMinus()) as V3, through.oneMinus() as F, crossing as F)
        .toVar();
      const cloudNow = a.out.toVar();
      If(crossing.lessThan(a.outDistance), () => {
        // In front of the cloud.
        a.out.assign(vec4(sheetLight.add(cloudNow.rgb.mul(through)), cloudNow.a.mul(through)));
        a.outDistance.assign(
          select(cloudNow.a.greaterThan(0.99), crossing, a.outDistance),
        );
      }).Else(() => {
        a.out.assign(
          vec4(cloudNow.rgb.add(sheetLight.mul(cloudNow.a)), cloudNow.a.mul(through)),
        );
      });
    });
  }

  private marchAir(a: {
    ctx: VolumetricContext;
    level: QualityLevel;
    ro: V3;
    rd: V3;
    h0: F;
    up0: V3;
    end: F;
    sphere: (altitude: F) => { disc: F; near: F; far: F };
    cosKey: F;
    keyAt: (p: V3) => V3;
    skyLight: V3;
    throughAir: (light: V3, opacity: F, distance: F) => V3;
    out: Node<'vec4'>;
    outDistance: F;
  }): void {
    const { clouds, lighting: L, state, weather } = this.o;
    const radius = L.radius;
    const { ro, rd, h0 } = a;
    const steps = a.level.airSteps;
    const key = this.keyDirection as unknown as V3;

    // The layer under `airTop`.
    const lid = a.sphere(this.airTop as unknown as F);
    const inside = h0.lessThan(this.airTop);
    const start = select(inside, float(0), max(lid.near, 0)).toVar();
    const exit = min(lid.far, a.end).toVar();
    // Inside thick air there is no use looking far.
    const reach = select(
      inside,
      max(float(AIR_REACH).div(max(this.airNear, 1e-7)), AIR_MIN_REACH),
      float(1e9),
    );
    const span = min(exit.sub(start), reach).toVar();

    const transmittance = float(1).toVar();
    const scattered = vec3(0).toVar();
    const weight = float(0).toVar();
    const weighted = float(0).toVar();

    If(lid.disc.greaterThan(0).and(span.greaterThan(0)), () => {
      const keyNear = a.keyAt(ro.add(rd.mul(start)) as V3).toVar();
      const keyFar = a.keyAt(ro.add(rd.mul(start.add(min(span, 60_000)))) as V3).toVar();
      // A strong forward lobe: the glow around a low sun in haze.
      const phase = Volumetrics.phase(a.cosKey, 0.76, -0.1, 0.5).toVar();
      const phaseDust = Volumetrics.phase(a.cosKey, 0.55, -0.1, 0.5).toVar();

      Loop(steps, ({ i }) => {
        If(transmittance.lessThan(OPAQUE), () => {
          Break();
        });
        // Quadratic spacing: short steps near the camera.
        const u0 = float(i).div(steps);
        const u1 = float(i).add(1).div(steps);
        const ta = start.add(span.mul(u0).mul(u0)).toVar();
        const dt = span.mul(u1.mul(u1).sub(u0.mul(u0))).toVar();
        const ts = ta.add(dt.mul(a.ctx.jitter)).toVar();
        const p = ro.add(rd.mul(ts)).toVar();
        const r = length(p).toVar();
        const up = p.div(r).toVar();
        const h = r.sub(radius).toVar();
        const mu = dot(up, rd).toVar();
        const w = weather.sample(p as V3);
        const fog = w.fog.toVar();
        const dust = w.dust.toVar();
        const coverW = w.cover.toVar();
        const baseW = w.base.toVar();

        // Banks: two layers of wisps that move apart. Far steps see their mean.
        const far = smoothstep(600, 4000, dt).toVar();
        const banks = float(0.5).toVar();
        const billow = float(0.5).toVar();
        If(far.lessThan(1), () => {
          const n1 = clouds.noise.sampleShape(p.div(FOG_TILE).add(this.fogShift) as V3);
          const n2 = clouds.noise.sampleShape(p.div(FOG_TILE_FINE).add(this.fogShiftFine) as V3);
          banks.assign(mix(n1.z.mul(0.62).add(n2.z.mul(0.38)), float(0.5), far));
          billow.assign(mix(n1.w.mul(0.6).add(n2.x.mul(0.4)), float(0.5), far));
        });

        // Fog: full under the level, exponential above, integrated over the step's heights.
        const z = h.sub(this.fogLevel).toVar();
        const scale = clamp(float(FOG_SCALE).div(max(fog, 1e-9)), FOG_HEIGHT[0], FOG_HEIGHT[1]).toVar();
        // The banks' noise lifts and lowers the fog's top, and thins it between banks.
        const lift = banks.sub(0.5).mul(scale).mul(1.6);
        const za = z.sub(lift).sub(mu.mul(ts.sub(ta))).toVar();
        const zb = za.add(mu.mul(dt)).toVar();
        const lo = max(min(za, zb), 0);
        const hi = max(max(za, zb), 0);
        const rise = hi.sub(lo);
        const profile = select(
          rise.greaterThan(scale.mul(0.02)),
          exp(lo.div(scale).negate())
            .sub(exp(hi.div(scale).negate()))
            .mul(scale)
            .div(max(rise, 1e-3)),
          exp(lo.div(scale).negate()),
        );
        // The part of the step under the level is full.
        const total = max(abs(zb.sub(za)), 1e-3);
        const under = clamp(min(za, zb).negate().div(total), 0, 1);
        const column = mix(profile, float(1), under);
        const thin = smoothstep(0.2, 0.75, banks).mul(0.9).add(0.35);
        const fogExtinction = fog.mul(column).mul(thin).toVar();

        // Rain and snow fill the air under their cloud.
        const rainExtinction = float(0).toVar();
        const precip = float(0).toVar();
        If(this.rainOn.greaterThan(0.5), () => {
          precip.assign(clamp(w.precip, 0, 1));
          const underBase = smoothstep(baseW.add(150), baseW.sub(150), h);
          // What lowers the visibility in rain is the rain: its share of the fog reaches the base.
          fogExtinction.assign(
            mix(fogExtinction, fog.mul(thin), underBase.mul(smoothstep(0, 0.1, precip))),
          );
          // Veils: streaks that hang from the base and lean with the wind.
          const leaned = p.sub((this.lean as unknown as V3).mul(h)).toVar();
          const veil = clouds.noise.sampleShape(
            leaned.sub(up.mul(h.mul(0.85))).div(5200).add(this.fogShift) as V3,
          ).z;
          rainExtinction.assign(
            precip
              .mul(RAIN_EXTINCTION)
              .mul(smoothstep(0.38, 0.7, veil).mul(1.5).add(0.25))
              .mul(underBase)
              .mul(smoothstep(0.3, 0.7, coverW)),
          );
        });

        // Dust: a wall where the field begins, a billowing top.
        const dustExtinctionNode = float(0).toVar();
        If(this.dustOn.greaterThan(0.5), () => {
          const wall = smoothstep(0.1, 0.3, dust.add(billow.sub(0.5).mul(0.3)));
          const dustTop = this.fogLevel.add(
            dust.mul(DUST_DEPTH).mul(billow.mul(0.7).add(0.65)),
          );
          const body = smoothstep(dustTop, dustTop.sub(600), h);
          dustExtinctionNode.assign(
            dust
              .mul(dust)
              .mul(dustExtinction(1))
              .mul(wall)
              .mul(body)
              .mul(billow.mul(0.8).add(0.6)),
          );
        });

        const extinction = fogExtinction.add(rainExtinction).add(dustExtinctionNode).toVar();
        If(extinction.greaterThan(1e-8), () => {
          const muKey = dot(up, key).toVar();
          // The air's own depth toward the light: fog above, dust above.
          const slant = float(1).div(max(muKey, 0.1));
          const fogAbove = fogExtinction.mul(scale);
          const dustAbove = dustExtinctionNode.mul(
            max(this.fogLevel.add(dust.mul(DUST_DEPTH)).sub(h), 0).mul(0.5),
          );
          const rainAbove = rainExtinction.mul(max(baseW.sub(h), 0));
          const tau = fogAbove.add(dustAbove).add(rainAbove).mul(slant).toVar();
          // Shadows of clouds and mountains: crepuscular rays.
          const visible = float(1).toVar();
          If(this.shafts.greaterThan(0.5), () => {
            let v: F = float(1) as F;
            if (L.sunVisibility) v = v.mul(L.sunVisibility(p as V3)) as F;
            if (L.terrainShadow) v = v.mul(L.terrainShadow(p as V3)) as F;
            visible.assign(v);
          });
          const keyColor = mix(keyNear, keyFar, clamp(ts.sub(start).div(60_000), 0, 1));
          const share = dustExtinctionNode.div(extinction).toVar();
          const direct = exp(tau.negate()).mul(mix(phase, phaseDust, share));
          const diffuse = exp(tau.mul(-0.12)).mul(0.5);
          // Under cloud the sky's light is the cloud base's.
          const sky = a.skyLight.mul(SKY_AMBIENT).mul(float(1).sub(coverW.mul(0.45)));
          const albedo = vec3(...FOG_ALBEDO)
            .mul(fogExtinction)
            .add(vec3(...RAIN_ALBEDO).mul(rainExtinction))
            .add(vec3(...DUST_ALBEDO).mul(dustExtinctionNode))
            .div(extinction);
          const source = keyColor
            .mul(visible.mul(direct).add(diffuse.mul(visible.mul(0.6).add(0.4))))
            .add(sky)
            .toVar();
          If(this.stormOn.greaterThan(0.5), () => {
            const away = p.sub(state.flashPosition);
            const reachSq = 4 * FLASH_RADIUS * FLASH_RADIUS;
            source.addAssign(
              vec3(...FLASH_LIGHT).mul(
                state.flash.mul(0.25).mul(float(reachSq).div(dot(away, away).add(reachSq))),
              ),
            );
          });
          const through = exp(extinction.mul(dt).negate()).toVar();
          const part = transmittance.mul(through.oneMinus()).toVar();
          scattered.addAssign(source.mul(albedo).mul(part));
          weight.addAssign(part);
          weighted.addAssign(part.mul(ts));
          transmittance.mulAssign(through);
        });
      });

      // The sun behind dust: a dull disk where the real one has gone.
      If(this.dustOn.greaterThan(0.5).and(this.shafts.greaterThan(0.5)), () => {
        const disk = smoothstep(0.99985, 0.99996, a.cosKey);
        const dustHere = state.dust.mul(state.dust).mul(dustExtinction(1));
        const depth = dustHere
          .mul(max(this.fogLevel.add(state.dust.mul(DUST_DEPTH)).sub(h0), 0))
          .mul(0.5)
          .div(max(dot(a.up0, key), 0.1));
        const dimmed = exp(vec3(0.1, 0.2, 0.42).mul(min(depth, 14)).negate());
        scattered.addAssign(
          keyNear.mul(dimmed).mul(disk).mul(transmittance.oneMinus()).mul(5),
        );
      });
    });

    const opacity = transmittance.oneMinus().toVar();
    const distance = weighted.div(max(weight, 1e-6)).toVar();
    a.out.assign(
      vec4(
        select(
          weight.greaterThan(1e-6),
          a.throughAir(scattered as V3, opacity as F, distance as F),
          vec3(0),
        ),
        transmittance,
      ),
    );
    a.outDistance.assign(distance);
  }
}
