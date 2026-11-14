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
 *   the camera a finer noise cuts the rims of its cells away, which leaves
 *   billows. The noise turns about the polar axis with the coverage and
 *   drifts slowly, so clouds move with the wind and change shape.
 * - The march: the ray is cut to the shell between the lowest cloud base and
 *   the highest top in view (from the weather on the CPU). Steps grow with
 *   the distance (2.6% of it at medium quality, never under 45 m) and are
 *   never shorter than what the rest of the ray needs to be covered by the
 *   steps left, so the march reaches the end of the shell: the horizon
 *   included. Outside a column's own base and top the ray skips to where it
 *   enters them; clear of coverage and far under the noise's threshold it
 *   skips a bounded way. Into cloud it goes back over the entering step with
 *   half steps and keeps those while in cloud, lengthening them as the ray
 *   grows opaque; a step counts for an optical depth of 2 at most. So a
 *   cloud's surface is drawn by several samples, and a ray through solid
 *   cloud is opaque (1% left) after about 8 shaded steps. Where steps are
 *   long the shape noise gives way to its smooth channel and then to the
 *   layer's mean density.
 * - Light: the key light is the sun, or the moon once the sun is well down.
 *   Its color after the atmosphere is read at the two ends of the marched
 *   segment and interpolated (two reads per pixel, not one per step), so
 *   sunsets color the clouds and high tops stay lit after low cloud has gone
 *   gray. Its shadowing inside the cloud is two to four samples of the shape
 *   noise toward the light at fixed distances, with a soft density so none of
 *   them casts an edge, and one more read of the cloud's column a few
 *   kilometers on: a deck there shades evenly, heaps by the free path between
 *   them. The optical depth toward the light counts four times the march's
 *   own (`CLOUD_LIGHT.shadow`): the march draws cloud thinner than it is, to
 *   stay smooth, and a shaded side should still be dark. A phase function
 *   with a forward lobe (the silver lining, capped) and a backward one lights
 *   the directly lit term; two more terms that reach deeper stand for
 *   multiple scattering; thin edges darken when seen from the light's side,
 *   and the creases between billows by the detail noise. Where steps are
 *   long these terms reach deeper with less gain, mean brightness unchanged,
 *   so far cloud does not sparkle. Sky light comes from above and thins
 *   toward the base, which stays cool and gray; ground light comes from
 *   below. Lightning lights the cloud from inside (WeatherState.flash).
 * - Distance: every sample's light is faded into the sky's radiance in that
 *   direction by the air in front of it, so far cloud sinks into the haze at
 *   the horizon.
 * - Cirrus: one sheet at 10.5 km, three reads of a stretched noise field
 *   where the ray crosses it (fibers along the parallels, bent by a coarser
 *   reading, in patches), lit by the key light's color there: it catches the
 *   low sun above the horizon.
 *
 * Air near the ground (fog, haze, dust, rain shafts), one march of 10 to 20
 * steps from the camera, spaced quadratically, over the reach the air's
 * extinction at the camera allows. The weather is read at six points of the
 * ray and interpolated between them:
 * - Fog: the weather's fog extinction, full below a level 100 m over the mean
 *   ground of where it lies and thinning above it with a scale height that
 *   grows as the fog thins (120 m for dense fog, 600 m for haze), so fog
 *   pools in lowlands and hills stand out of it. The exponential profile is
 *   integrated analytically over each step. Banks: two layers of noise moving
 *   with the wind at different speeds lift and lower the fog's top and thin
 *   it between banks; close to the camera a third, of wisps tens of meters
 *   across, drifts on its own path even in still air. Haze (a visibility over
 *   8 km) has no such structure and reads no noise.
 * - Dust: an ochre layer up to 3 km deep where the weather's dust field is
 *   high, with a billowing top and a wall where the field begins, which takes
 *   the blue out of the light inside it, and a dull disk where the sun stands
 *   behind it.
 * - Rain and snow: under precipitating cloud (the bake's coverage, one read),
 *   veils from the base to the ground that lean with the wind; the weather's
 *   low visibility in rain is the rain's and ends where the cloud ends.
 * - Light: the key light through the air's own depth toward it, cut by the
 *   cloud shadow and the terrain shadow under open sky (crepuscular rays); a
 *   sharp forward lobe (the glow around a low sun in thin haze) and a wide
 *   one for the light the layer has scattered on; the sky's light, gray and
 *   dim under deep cloud as on the ground.
 * - A cloud on the ray stands in the air as a sheet at its distance: the
 *   air's light from in front of it veils it, the rest shows through it.
 *
 * Sampling. Each march samples its steps at one of nine offsets, laid out in
 * a 3 × 3 tile over the low-resolution pixels, so that the pipeline's 3 × 3
 * filter averages one of each: nine times the samples, and the same ones in
 * every frame, so nothing flickers or crawls. (Interleaved gradient noise,
 * which the pipeline offers, left moiré against the march's regular steps.)
 * The steps are planned so that they change evenly from a ray that meets the
 * ground near the horizon to the one just above it.
 *
 * Cost. Texture reads per low-resolution pixel at medium quality (40 cloud
 * steps at most, 3 light samples, 14 air steps, a third of the resolution):
 * - Clear air: none, and the pipeline leaves the stage out (`idle`).
 * - Per pixel with cloud in view: 13 (the key light's color at two points,
 *   the sky ahead and its irradiance, the cirrus).
 * - Per cloud step: 1 for the column; 1 more for the shape noise inside the
 *   column's layer; where there is density 1 for the detail (near the
 *   surface), 3 toward the light and 1 for the column beyond: 7 in all.
 *   Fair-weather cumulus from below: about 12 steps, 5 of them shaded, 60
 *   reads. An overcast or a storm from below or above: 8 to 10 shaded steps,
 *   70 to 90 reads.
 * - Air: 18 for the weather; per step up to 3 for fog (none in haze), 2 for
 *   rain, 1 for dust, and under open sky 2 for the cloud shadow and 1 for the
 *   terrain's: dense fog at dawn about 100, haze under an overcast 20, rain
 *   60.
 * `quality` sets the steps, the light samples and the pipeline's volumetric
 * scale: low (28 steps, 2 light samples, 10 air steps, 1/4), medium (40, 3,
 * 14, 1/3), high (48, 4, 20, 1/2).
 */
import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  Break,
  clamp,
  dot,
  exp,
  float,
  Fn,
  floor,
  If,
  length,
  Loop,
  max,
  min,
  mix,
  mod,
  normalize,
  screenCoordinate,
  select,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DEG } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import { AtmosphereNodes } from '../atmosphere/atmosphere';
import { MOON_TINT, SKY_MARCH_STEPS_COARSE } from '../atmosphere/skyView';
import { overcastSky } from '../lighting/planetLighting';
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

/** Frames a new source is drawn for whatever the weather, so that its shader is compiled. */
const WARM_FRAMES = 3;
/** Shortest step of the cloud march (m). */
const MIN_STEP = 45;
/** Extinction of cloud at full density (1/m). */
export const CLOUD_EXTINCTION = 0.007;
/** A step in cloud over a step in clear air at the same distance. */
const FINE_STEP = 0.5;
/**
 * A step in cloud is never shorter than this share of what the plan needs of a step in the
 * open (see the march): a ray that finds cloud is soon opaque and needs no steps beyond it,
 * and one that passes through thin cloud pays with longer steps further out.
 */
const FINE_PLAN = 0.12;
/** Fine steps the march goes back by from a long step's sample that found cloud. */
const ENTRY_BACK = 4;
/** The most optical depth one step counts for. */
const STEP_DEPTH = 2;
/** The longest way a sample clear of all coverage lets the march skip (m): coverage has edges of kilometers. */
const COVER_SKIP = 2500;
/** The longest way a sample far under the shape noise's threshold lets it skip (m): a heap is about a kilometer. */
const NOISE_SKIP = 300;
/** How far a closed deck's base stands above the weather's cloud base where it is highest (m). */
const DECK_RAGGED = 320;
/** Height over which a deck's ragged base fades in (m). */
const BASE_FADE = 160;
/** How far the light that comes through a deck varies with its noise, 0..1: the mottling of its underside. */
const DECK_MOTTLE = 0.7;
/**
 * Transmittance under which a march stops, and up to which what it lets through fades to
 * nothing: a march that stopped would otherwise leave up to 1% of what is behind it, and 1%
 * of the sun's disk is a bright dot in fog or cloud that should hide it.
 */
const OPAQUE = 0.01;
const OPAQUE_FADE = 0.05;
/**
 * Angle below the horizon (rad) over which a ray that ends on the ground stops planning its
 * steps as the ray above the horizon does.
 */
const GRAZING = 0.06;
/** Step lengths (m) over which the shape noise gives way to its smooth channel, and that to the mean density. */
const SMOOTH_STEPS: [number, number] = [700, 2500];
const MEAN_STEPS: [number, number] = [1500, 4000];
/** Step lengths (m) over which the detail noise fades out. */
const DETAIL_STEPS: [number, number] = [200, 700];
/** How far toward the light the samples of a step reach (m), by their number. */
const LIGHT_REACH: Record<2 | 3 | 4, number> = { 2: 1000, 3: 1200, 4: 1300 };
/**
 * The density the light samples see: it rises from nothing at LIGHT_EDGE[0] of the cloud's
 * noise range before the cloud's edge to full LIGHT_EDGE[1] of the range further in.
 */
const LIGHT_EDGE: [number, number] = [0.15, 0.9];
/** Step lengths (m) over which the cloud's light changes from its sharp form to its deep one. */
const LIGHT_STEPS: [number, number] = [60, 250];
/** The free path of light between the heaps of a cumulus field (m). */
const HEAP_FREE_PATH = 5000;
/** The stretch beyond the light samples that one more reading of the cloud's column stands for (m). */
const FAR_LIGHT = 5000;

/**
 * The cloud's light: numbers the look was tuned with. Read when a shader is
 * built (a change of `quality` rebuilds it), so previews can try values
 * (tools/clouds.preview.ts, TUNING).
 */
export const CLOUD_LIGHT = {
  /** The phase function's lobes: forward and backward asymmetry, and the backward lobe's share. */
  phaseForward: 0.62,
  phaseBack: -0.28,
  phaseBackShare: 0.4,
  /** The most the phase function gives (an isotropic one gives 1): the silver lining's strength. */
  phaseMost: 3,
  /**
   * The optical depth toward the light over the one the march sees: the march draws cloud
   * thinner than it is, to stay smooth, but a cloud's shaded side should be dark.
   */
  shadow: 4,
  /** Gain of the directly lit term. */
  direct: 1.0,
  /**
   * Light scattered more than once, as two further terms that reach deeper into the cloud:
   * their gains, and their attenuation relative to the direct term's.
   */
  multiple: 1.5,
  multipleAttenuation: 0.5,
  deep: 0.12,
  deepAttenuation: 0.03,
  /** How far thin edges darken when seen from the light's side, 0..1. */
  powder: 0.45,
  /** Sky light on cloud, as a multiple of the sky's irradiance on level ground. */
  sky: 6,
  /** How fast sky light thins with the optical depth of cloud above. */
  skyAttenuation: 0.2,
  /** Light the ground sends back up, as a share of what reaches it. */
  ground: 0.08,
  /** The sky's light at a cloud's base over that at its top. */
  skyBase: 0.15,
  /** How far the detail noise erodes a cloud's edge, 0..1. */
  erosion: 0.6,
  /** How far the creases between billows darken, 0..1. */
  crease: 0.6,
};
/** A lightning flash inside cloud: radiance at the discharge, and the distance at which it has halved (m). */
const FLASH_LIGHT: [number, number, number] = [4, 4.6, 6];
const FLASH_RADIUS = 2600;

/** Altitude of the cirrus sheet above sea level (m). */
export const CIRRUS_ALTITUDE = 10_500;
/** Vertical optical depth of the densest cirrus. */
const CIRRUS_DEPTH = 0.35;
/**
 * Length and width of one tile of the cirrus fibers' noise (m). The length divides the
 * equator (2π · 1,000 km) into 256 tiles, and every reading of the noise uses a multiple of
 * it that divides 256, so the field has no seam at the antimeridian.
 */
const CIRRUS_LONG = (2 * Math.PI * 1_000_000) / 256;
const CIRRUS_SHORT = 5_000;
/** Sky light on cirrus, as a multiple of the sky's irradiance on level ground. */
const CIRRUS_SKY = 2.5;

/** Height above the mean ground up to which fog has its full density (m). */
export const FOG_FLOOR = 100;
/** Fog scale height = FOG_SCALE / extinction, held between these (m): dense fog is shallow, haze deep. */
const FOG_SCALE = 0.5;
const FOG_HEIGHT: [number, number] = [120, 600];
/** Fog extinction (1/m) from which its banks and wisps are drawn: a visibility of 8 km. Haze is even. */
const FOG_STRUCTURE = 5e-4;
/** Edge of one tile of the fog banks' noise (m), and of its second layer. */
const FOG_TILE = 2600;
const FOG_TILE_FINE = 900;
/** Edge of one tile of the wisps near the camera (m), and the step lengths (m) over which they fade out. */
const FOG_TILE_NEAR = 170;
const FOG_NEAR_STEPS: [number, number] = [60, 160];
/** Height of a full dust storm over the fog floor (m). */
const DUST_DEPTH = 2000;
/** Extinction of rain shafts at 4 mm/h (1/m). */
const RAIN_EXTINCTION = 4.5e-4;
/** Optical depth along the air march at which it may stop looking further. */
const AIR_REACH = 9;
/** The most optical depth one step of the air march counts for. */
const AIR_STEP_DEPTH = 1.2;
/** Shortest reach of the air march (m). */
const AIR_MIN_REACH = 1500;
/** Scattering colors of fog, dust, rain and snow. */
const FOG_ALBEDO: [number, number, number] = [0.93, 0.95, 0.98];
const DUST_ALBEDO: [number, number, number] = [0.9, 0.66, 0.38];
const RAIN_ALBEDO: [number, number, number] = [0.66, 0.7, 0.76];
const SNOW_ALBEDO: [number, number, number] = [0.9, 0.92, 0.95];
/** How much of each color dust takes from the light per unit of its optical depth. */
const DUST_FILTER: [number, number, number] = [0.03, 0.14, 0.34];
/** Edge of one tile of the dust's billows (m), and of the rain veils' streaks. */
const DUST_TILE = 9000;
const RAIN_TILE = 2400;
/**
 * Where along the air march's span the weather is read, as shares of its steps (the distance
 * goes with the square): often enough that a long ray does not skip a weather sample's 65 km.
 */
const AIR_WEATHER_AT = [0.03, 0.2, 0.4, 0.6, 0.8, 1];
/** How fast the light scattered on inside fog thins with the optical depth above. */
const AIR_DIFFUSE = 0.45;
/** Sky light on fog, dust and rain, as a multiple of the sky's irradiance on level ground. */
const AIR_SKY = 3.2;
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
  /**
   * For measuring: the source returns what it did instead of light. r: steps of the cloud
   * march, g: those that were shaded, b: steps of the air march that found fog, dust or
   * rain; a: 1.
   */
  count?: boolean;
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
  readonly cirrus = uniform(0.5);
  /**
   * How much of the noise shows in clouds, fog, dust and rain, 0..1. At 0 they are as smooth
   * as the weather's fields: decks are slabs, fog is even, heaps are gone (tests measure the
   * march against that).
   */
  readonly structure = uniform(1);
  /**
   * What the terrain's heights are drawn multiplied by (its exaggeration): fog and dust lie
   * on the mean ground as drawn. Set by the scene.
   */
  groundScale = 1;
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
  private readonly dustShift = uniform(new Vector3());
  private readonly fogShiftNear = uniform(new Vector3());
  private readonly groundGain = uniform(1);
  /** How far rain veils lean per meter of height: the wind over the fall speed, world frame. */
  private readonly lean = uniform(new Vector3());

  private level: VolumetricQuality = 'medium';
  /** Frames the current source has been updated for, up to WARM_FRAMES. */
  private warm = 0;
  private pipeline: SimPipeline | null = null;
  /** The wind's path so far (m), for the fog banks. */
  private readonly path = new Vector3();
  private readonly pathFine = new Vector3();
  private readonly pathNear = new Vector3();
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
    this.warm = 0;
    return { build: (ctx) => this.build(ctx, level), idle: false };
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
    const airOn = this.airEnabled && fade > 0 && (view.fog > 2e-6 || view.dust > 0.03 || raining);
    this.airOn.value = airOn ? 1 : 0;
    this.rainOn.value = raining ? 1 : 0;
    this.dustOn.value = view.dust > 0.03 ? 1 : 0;
    const up = this.up.copy(eye).normalize();
    this.groundGain.value = this.groundScale;
    const level = weather.groundAt(up) * this.groundScale + FOG_FLOOR;
    this.fogLevel.value = level;
    const fog = Math.max(state.fog.value, 0.25 * view.fog);
    const fogHeight = Math.min(
      FOG_HEIGHT[1],
      Math.max(FOG_HEIGHT[0], FOG_SCALE / Math.max(fog, 1e-9)),
    );
    // Fog and dust lie on the mean ground of where they are: the highest in view bounds them.
    const high = Math.max(level, view.ground * this.groundScale + FOG_FLOOR);
    let airTop = level;
    if (view.fog > 2e-6) airTop = Math.max(airTop, high + 4 * fogHeight);
    if (view.dust > 0.03) airTop = Math.max(airTop, high + DUST_DEPTH * 1.6);
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
    // The wisps near the camera drift even in still air: across the wind, and upward.
    this.pathNear.x += (0.8 * wind.x - 1.1 * up.z + 0.35 * up.x) * step;
    this.pathNear.y += (0.8 * wind.y + 0.9 * up.z + 0.35 * up.y) * step;
    this.pathNear.z += (0.8 * wind.z + 1.1 * up.x - 0.9 * up.y + 0.35 * up.z) * step;
    const wrap = (v: number) => v - Math.floor(v);
    this.fogShiftNear.value.set(
      wrap(-this.pathNear.x / FOG_TILE_NEAR),
      wrap(-this.pathNear.y / FOG_TILE_NEAR),
      wrap(-this.pathNear.z / FOG_TILE_NEAR),
    );
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
    // Dust rolls with the wind, a little slower than the air.
    this.dustShift.value.set(
      wrap((-0.7 * this.path.x) / DUST_TILE),
      wrap((-0.7 * this.path.y) / DUST_TILE),
      wrap((-0.7 * this.path.z) / DUST_TILE),
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
    // With neither march to run the pipeline skips its volumetric passes altogether, once a
    // new source has been drawn: its shader is then compiled while the view loads, not when
    // the first cloud comes over the horizon.
    this.warm = Math.min(this.warm + 1, WARM_FRAMES);
    this.source.idle = this.warm >= WARM_FRAMES && !(cloudOn || airOn);
  }

  /** Forgets the wind's path (a new flight, a preview view): fog banks start from the same place. */
  reset(): void {
    this.path.set(0, 0, 0);
    this.pathFine.set(0, 0, 0);
    this.pathNear.set(0, 0, 0);
  }

  // ---- The shader ----

  private build(ctx: VolumetricContext, level: QualityLevel): V4 {
    const L = this.o.lighting;
    const radius = L.radius;
    return Fn(() => {
      const result = vec4(0, 0, 0, 1).toVar();
      If(this.cloudOn.add(this.airOn).greaterThan(0.5), () => {
        // Where in its step each march samples: nine offsets in a 3 × 3 tile, so the pipeline's
        // 3 × 3 filter averages exactly one of each whatever the pixel, and nothing of the
        // pattern is left to see or to flicker (see the file comment).
        const cell = floor(screenCoordinate.xy).toVar();
        const offset = mod(mod(cell.x, 3).add(mod(cell.y, 3).mul(3)).mul(4), 9)
          .add(0.5)
          .div(9)
          .toVar() as F;
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

        // How close to the horizon a ray points, 0..1: 1 at and above it, 0 from GRAZING below
        // it. The marches plan the steps of a ray above the horizon as if nothing stood in its
        // way, and those of a ray near it likewise: the samples in front of a ridge are then
        // the ones in front of the sky beside it, and they change evenly across the horizon,
        // where the distance to the ground changes within a pixel. No silhouette shows in
        // cloud or fog in front of it.
        const sine = dot(rd, up0).toVar();
        const horizon = sqrt(max(h0.mul(r0.add(radius)), 0))
          .div(r0)
          .negate()
          .toVar();
        const grazing = float(1).sub(smoothstep(0, GRAZING, horizon.sub(sine))).toVar() as F;
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
        // The haze in front of clouds and fog takes the sky's color just above the horizon
        // where the ray points below it: the sky's own radiance there is the ground's side.
        const lifted = normalize(rd.add(up0.mul(max(horizon.add(0.012).sub(sine), 0)))) as V3;
        const skyAhead = L.atmosphere.skyRadiance(lifted, SKY_MARCH_STEPS_COARSE).toVar() as V3;
        /** Light of something `distance` away, faded into the sky's by the air in front of it. */
        const throughAir = (light: V3, opacity: F, distance: F): V3 => {
          const far = ro.add(rd.mul(distance));
          const middle = max(h0.add(length(far).sub(radius)).mul(0.5), 0);
          const air = exp(
            L.atmosphere
              .medium(middle as F)
              .extinction.mul(distance)
              .negate(),
          );
          const t = mix(vec3(1), air, L.atmosphere.enabled).toVar();
          const haze = skyAhead
            .mul(t.oneMinus())
            .mul(L.atmosphere.aerialGain(t as V3))
            .mul(opacity);
          return light.mul(t).add(haze) as V3;
        };

        // rgb: light scattered toward the camera; a: transmittance. The cloud's distance, and
        // of the air its light's share from in front of the cloud and its transmittance there.
        const counts = this.o.count ? vec3(0).toVar() : null;
        const cloud = vec4(0, 0, 0, 1).toVar();
        const cloudDistance = float(1e9).toVar();
        const air = vec4(0, 0, 0, 1).toVar();
        const airSplit = vec2(1, 1).toVar();

        If(this.cloudOn.greaterThan(0.5), () => {
          this.marchClouds({
            counts,
            grazing,
            offset,
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
            counts,
            grazing,
            offset,
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
            cloudDistance,
            outSplit: airSplit,
          });
        });

        // The cloud stands in the air as a sheet at its distance: the air in front of it
        // veils it, the air behind shows through it.
        const combined = vec4(
          air.rgb
            .mul(airSplit.x)
            .add(cloud.rgb.mul(airSplit.y))
            .add(air.rgb.mul(airSplit.x.oneMinus()).mul(cloud.a)),
          air.a.mul(cloud.a),
        ).toVar();
        // A march that stopped as opaque lets nothing through.
        combined.a.mulAssign(smoothstep(OPAQUE, OPAQUE_FADE, combined.a));
        result.assign(mix(vec4(0, 0, 0, 1), combined, this.fade));
        if (counts) result.assign(vec4(counts, 1));
      });
      return result;
    })() as V4;
  }

  /** The dual-lobe phase function, scaled so that an isotropic one is 1. */
  private static phase(cos: F, forward: number, back: number, backShare: number, most: number): F {
    // Capped at `most`: the forward lobe's peak would blow out what stands next to the sun.
    return min(
      mix(AtmosphereNodes.hgPhase(cos, forward), AtmosphereNodes.hgPhase(cos, back), backShare).mul(
        4 * Math.PI,
      ),
      most,
    ) as F;
  }

  private marchClouds(a: {
    counts: Node<'vec3'> | null;
    grazing: F;
    offset: F;
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
    const samples = level.lightSamples;
    const reach = LIGHT_REACH[level.lightSamples];
    const tune = CLOUD_LIGHT;
    const attenuation = tune.multipleAttenuation;
    // Gains of the directly lit and the multiple-scattering term where steps are long.
    const directFar = (1 + 0.25 * tune.shadow) / (1 + tune.shadow);
    const multipleFar = (1 + (attenuation / 4) * tune.shadow) / (1 + attenuation * tune.shadow);
    // Growth per step that lets the steps left always cover the rest of the longest ray.
    const growth = 800 ** (1 / steps);
    const key = this.keyDirection as unknown as V3;

    // The shell between the lowest base and the highest top.
    const top = a.sphere(this.top as unknown as F);
    const bottom = a.sphere(this.bottom as unknown as F);
    const start = select(h0.lessThan(this.bottom), bottom.far, max(top.near, 0)).toVar();
    const stop = min(top.far, a.end).toVar();
    // What the steps are planned for: the far side of the shell for a ray at or above the
    // horizon, whatever stands in its way, and the end of the ray for one well below it
    // (`grazing`).
    const plan = mix(stop, top.far, a.grazing).toVar();

    const transmittance = float(1).toVar();
    const scattered = vec3(0).toVar();
    // Opacity-weighted distance, for the air in front of the cloud.
    const weight = float(0).toVar();
    const weighted = float(0).toVar();

    If(top.disc.greaterThan(0).and(stop.greaterThan(start)), () => {
      // The key light's color at both ends of the segment (at most 80 km apart).
      const span = min(plan.sub(start), 80_000).toVar();
      const keyNear = a.keyAt(ro.add(rd.mul(start)) as V3).toVar();
      const keyFar = a.keyAt(ro.add(rd.mul(start.add(span))) as V3).toVar();
      const phase = Volumetrics.phase(
        a.cosKey,
        tune.phaseForward,
        tune.phaseBack,
        tune.phaseBackShare,
        tune.phaseMost,
      )
        .mul(tune.direct)
        .toVar();
      // Thin edges darken when the light is behind the viewer.
      const powder = clamp(a.cosKey.negate().mul(0.5).add(0.5), 0, 1).mul(tune.powder).toVar();
      const upstreamOrigin = clouds.upstream(ro).toVar();
      const upstreamRay = clouds.upstream(rd).toVar();
      const upstreamKey = clouds.upstream(key).toVar();

      const t = start.toVar();
      // From 1 up while the march is in cloud and takes fine steps; it falls back after two
      // empty samples in a row (after ENTRY_BACK on the way into a cloud).
      const inside = float(0).toVar();
      Loop(steps, ({ i }) => {
        If(t.greaterThanEqual(stop).or(transmittance.lessThan(OPAQUE)), () => {
          Break();
        });
        a.counts?.addAssign(vec3(1, 0, 0));
        // The step: a share of the distance, a fraction of that in cloud, and never less
        // than the rest of the ray needs.
        const left = float(steps).sub(float(i));
        const needed = plan
          .sub(t)
          .mul(growth - 1)
          .div(exp(left.mul(Math.log(growth))).sub(1));
        const coarse = clamp(t.mul(level.stepGrowth), MIN_STEP, 20_000).toVar();
        // In cloud the steps are fine whatever the plan needs (down to a share of it): the
        // ray is soon opaque there. They lengthen as it grows opaque: what lies deeper shows
        // less.
        const veiled = transmittance.oneMinus();
        const fine = max(
          max(coarse.mul(FINE_STEP), MIN_STEP).mul(veiled.mul(veiled).mul(2).add(1)),
          needed.mul(FINE_PLAN),
        ).toVar();
        // The last step ends where the ray does: what stands in cloud is veiled by its distance.
        const step = min(
          select(inside.greaterThan(0.5), fine, max(coarse, needed)),
          max(stop.sub(t), 1),
        ).toVar();
        const ts = t.add(step.mul(a.offset)).toVar();
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
        const hit = float(0).toVar();

        If(cover.lessThan(0.004), () => {
          // Clear of cloud: coverage has soft edges kilometers wide.
          advance.assign(max(step, min(step.mul(4), COVER_SKIP)));
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
              advance.assign(step.add(min(step, NOISE_SKIP)));
            }).Else(() => {
              // Long steps cannot resolve the noise: its smooth channel, then the mean.
              const smoothed = smoothstep(SMOOTH_STEPS[0], SMOOTH_STEPS[1], coarse).toVar();
              const mean = smoothstep(MEAN_STEPS[0], MEAN_STEPS[1], coarse).toVar();
              const upstream = upstreamOrigin.add(upstreamRay.mul(ts)).toVar();
              const density = meanDensity(c as F).toVar();
              const noise = float(0.5).toVar();
              If(mean.lessThan(1), () => {
                const n = clouds.noise.sampleShape(clouds.shapeCoordinate(upstream as V3));
                noise.assign(mix(float(0.5), mix(n.x, n.y, smoothed), this.structure));
                // A deck's base is ragged: it hangs lowest where the noise is high and stands
                // up to DECK_RAGGED higher between, so an overcast has relief from below.
                const ragged = held.deck
                  .mul(float(1).sub(n.y))
                  .mul(this.structure)
                  .mul(DECK_RAGGED);
                const based = smoothstep(0, BASE_FADE, above.sub(ragged));
                density.assign(mix(densityFrom(c as F, noise as F).mul(based), density, mean));
              });
              const y = clamp(above.div(thickness), 0, 1).toVar();
              // How far the sample lies in a crease between billows, 0..1.
              const crease = float(0).toVar();
              // The detail shapes a cloud's edge and shades its surface: deep inside a body it
              // is not read.
              If(
                density
                  .greaterThan(0.0015)
                  .and(density.lessThan(0.999).or(transmittance.greaterThan(0.3))),
                () => {
                  const detail = float(1)
                    .sub(smoothstep(DETAIL_STEPS[0], DETAIL_STEPS[1], coarse))
                    .toVar();
                  If(detail.greaterThan(0), () => {
                    const e = clouds.noise.sampleDetail(clouds.detailCoordinate(upstream as V3));
                    // Wisps under the cloud; above, the cells' rims are cut away and billows stay.
                    const rims = e.x.oneMinus();
                    const cut = mix(e.y, rims, clamp(y.mul(5), 0, 1))
                      .mul(tune.erosion)
                      .mul(detail)
                      .mul(this.structure);
                    crease.assign(smoothstep(0.35, 0.85, rims).mul(detail));
                    density.assign(clamp(density.sub(cut).div(cut.oneMinus()), 0, 1));
                  });
                },
              );
              If(density.lessThanEqual(0.0015), () => {
                // The further the noise is under its threshold, the further the next cloud.
                const gap = clamp(c.oneMinus().sub(noise).div(0.25), 0, 1);
                advance.assign(step.add(min(step.mul(2), NOISE_SKIP).mul(gap)));
              })
                .ElseIf(inside.lessThan(0.5).and(step.greaterThan(fine.mul(1.2))), () => {
                  // Into cloud with a long step: back from the sample and on with fine ones,
                  // which may miss ENTRY_BACK times on their way to it, so the cloud's
                  // surface is not drawn by one sample.
                  hit.assign(2);
                  advance.assign(max(ts.sub(t).sub(fine.mul(ENTRY_BACK)), 0));
                })
                .Else(() => {
                  hit.assign(1);
                  a.counts?.addAssign(vec3(0, 1, 0));
                  // Denser toward the top of a heap; rain cloud is denser throughout.
                  const body = mix(y.mul(0.9).add(0.55), float(1), held.deck).mul(
                    held.precip.mul(0.5).add(1),
                  );
                  // No step counts for more than STEP_DEPTH of optical depth: where steps are
                  // long the cloud is thinner, and a ray is opaque after a bounded number.
                  const sigma = min(float(CLOUD_EXTINCTION), float(STEP_DEPTH).div(step));
                  const extinction = density.mul(body).mul(sigma).toVar();

                  // Toward the light: a few samples of the shape noise in this column, then the
                  // rest of the column by its mean.
                  const muKey = dot(up, key).toVar();
                  const depth = float(0).toVar();
                  If(mean.lessThan(1), () => {
                    // The samples stand in the middle of intervals that grow with the distance,
                    // at the same distances for every pixel: offsets that differ between pixels
                    // leave a stipple the filter does not remove, and the soft density below
                    // keeps a single sample from casting a shadow with an edge.
                    for (let j = 0; j < samples; j++) {
                      const d = ((j + 0.5) / samples) ** 2 * reach;
                      const span = (((j + 1) / samples) ** 2 - (j / samples) ** 2) * reach;
                      const hq = h.add(muKey.mul(d));
                      const cq = coverageAt(held, hq as F);
                      const nq = clouds.noise.sampleShape(
                        clouds.shapeCoordinate(upstream.add(upstreamKey.mul(d)) as V3),
                      );
                      // A softer edge than the cloud's own: the shadows inside it have no steps.
                      const dq = clamp(
                        mix(float(0.5), mix(nq.x, nq.y, smoothed), this.structure)
                          .sub(cq.oneMinus())
                          .div(max(cq, 1e-3))
                          .add(LIGHT_EDGE[0])
                          .div(LIGHT_EDGE[1]),
                        0,
                        1,
                      );
                      depth.addAssign(dq.mul(span));
                    }
                    depth.assign(mix(depth, density.mul(reach), mean));
                  }).Else(() => {
                    depth.assign(density.mul(reach));
                  });
                  // Beyond the samples: the cloud a few kilometers on toward the light, from
                  // its column alone (one read). A deck fills its column evenly. Heaps stand
                  // apart: light passes between them, and what a field of them takes grows
                  // with the path over the free path between heaps, far less than their mean
                  // density would.
                  const beyond = clouds.column(p.add(key.mul(reach + FAR_LIGHT * 0.5)) as V3);
                  const cFar = coverageAt(beyond, h.add(muKey.mul(reach + FAR_LIGHT * 0.5)) as F);
                  const tau = depth
                    .mul(CLOUD_EXTINCTION * tune.shadow)
                    .add(
                      cFar.mul(
                        mix(
                          float(FAR_LIGHT / HEAP_FREE_PATH),
                          float(FAR_LIGHT * 0.5 * CLOUD_EXTINCTION * tune.shadow),
                          beyond.deck,
                        ),
                      ),
                    )
                    .toVar();

                  const keyColor = mix(keyNear, keyFar, clamp(ts.sub(start).div(span), 0, 1));
                  // Creases between billows lie in their neighbors' shade.
                  // Where steps are long the lit skin of a cloud is thinner than a step, and
                  // samples would catch it by chance (sparkle): the light then reaches four
                  // times deeper with a gain that leaves the cloud's mean brightness as it
                  // was (the mean of A·e^(−a·τ) over what the eye sees is A / (1 + a·shadow)).
                  const coarsely = smoothstep(LIGHT_STEPS[0], LIGHT_STEPS[1], step).toVar();
                  const lit = exp(tau.mul(mix(float(-1), float(-0.25), coarsely)))
                    .mul(phase)
                    .mul(mix(float(1), float(directFar), coarsely))
                    .mul(float(1).sub(powder.mul(exp(tau.mul(-2).sub(density.mul(3))))))
                    .add(
                      exp(tau.mul(mix(float(-attenuation), float(-attenuation / 4), coarsely)))
                        .mul(tune.multiple)
                        .mul(mix(float(1), float(multipleFar), coarsely)),
                    )
                    .add(exp(tau.mul(-tune.deepAttenuation)).mul(tune.deep))
                    .mul(float(1).sub(crease.mul(tune.crease)));
                  // Sky light from above through the cloud over the sample; ground light from below.
                  // A deck is thinner in places (where its noise is low): more light comes
                  // through there, and its underside is mottled.
                  const thinned = mix(
                    float(1),
                    noise.mul(2 * DECK_MOTTLE).add(1 - DECK_MOTTLE),
                    held.deck,
                  ).toVar();
                  const over = max(base.add(thickness).sub(h), 0)
                    .mul(cover)
                    .mul(held.fill)
                    .mul(thinned);
                  const under = max(above, 0).mul(cover).mul(held.fill);
                  const fromSky = exp(over.mul(-0.5 * CLOUD_EXTINCTION * tune.skyAttenuation)).mul(
                    y.mul(1 - tune.skyBase).add(tune.skyBase),
                  );
                  const fromGround = exp(under.mul(-0.5 * CLOUD_EXTINCTION * tune.skyAttenuation));
                  // The ground under the cloud is lit by what the whole column lets down.
                  const lets = exp(
                    thickness
                      .mul(cover)
                      .mul(held.fill)
                      .mul(thinned)
                      .mul(-0.5 * CLOUD_EXTINCTION * tune.skyAttenuation),
                  );
                  const groundLight = keyColor
                    .mul(max(muKey, 0))
                    .add(a.skyLight)
                    .mul(lets)
                    .mul(tune.ground);
                  const source = keyColor
                    .mul(lit)
                    .add(a.skyLight.mul(fromSky).mul(tune.sky))
                    .add(groundLight.mul(fromGround))
                    .toVar();
                  If(this.stormOn.greaterThan(0.5), () => {
                    // Lightning inside the cloud.
                    const away = p.sub(state.flashPosition);
                    const flashReach = FLASH_RADIUS * FLASH_RADIUS;
                    source.addAssign(
                      vec3(...FLASH_LIGHT).mul(
                        state.flash.mul(float(flashReach).div(dot(away, away).add(flashReach))),
                      ),
                    );
                  });
                  // Rain cloud absorbs: darker, bluer in its lowest two kilometers.
                  const albedo = mix(
                    vec3(1),
                    vec3(0.62, 0.68, 0.78),
                    clamp(held.precip, 0, 1).mul(smoothstep(2200, 600, above)),
                  );
                  const through = exp(extinction.mul(step).negate()).toVar();
                  const share = transmittance.mul(through.oneMinus()).toVar();
                  // Each sample sinks into the haze by its own distance.
                  scattered.addAssign(
                    a.throughAir(source.mul(albedo) as V3, float(1) as F, ts as F).mul(share),
                  );
                  weight.addAssign(share);
                  weighted.addAssign(share.mul(ts));
                  transmittance.mulAssign(through);
                });
            });
          });
        inside.assign(select(hit.greaterThan(0.5), hit, max(inside.sub(0.34), 0)));
        t.addAssign(advance);
      });
    });

    const distance = weighted.div(max(weight, 1e-6)).toVar();
    a.outDistance.assign(select(weight.greaterThan(1e-5), distance, float(1e9)));
    a.out.assign(vec4(scattered, transmittance));

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
      // Fibers along the parallels (the high winds blow east), in patches some hundred
      // kilometers wide: the wisps channel read at three scales, the middle one bending the
      // fine one so the fibers curl.
      const east = atan(upstream.x, upstream.z).mul(L.radius);
      const north = asin(clamp(up.y, -1, 1)).mul(L.radius);
      const drift = clouds.shapeDrift.x.mul(3);
      const bend = clouds.noise.sampleShape(
        vec3(east.div(CIRRUS_LONG * 4), north.div(CIRRUS_SHORT * 4), 0.61) as V3,
      ).z;
      const fibers = clouds.noise.sampleShape(
        vec3(
          east.div(CIRRUS_LONG).add(drift),
          north.div(CIRRUS_SHORT).add(bend.mul(0.45)),
          0.23,
        ) as V3,
      ).z;
      const patches = clouds.noise.sampleShape(
        vec3(east.div(CIRRUS_LONG * 8).add(0.37), north.div(CIRRUS_LONG * 5), 0.83) as V3,
      ).z;
      // More cirrus where the weather has more cloud; little under a cloudless sky.
      const cover = this.o.weather.sample(p as V3).cover;
      // None over the poles, where the parallels the fibers follow close to a point.
      const amount = this.cirrus
        .mul(smoothstep(0.02, 0.45, cover).mul(0.7).add(0.3))
        .mul(smoothstep(0.995, 0.97, abs(up.y)));
      const field = fibers
        .mul(0.75)
        .add(bend.mul(0.25))
        .add(patches.sub(0.5).mul(1.5))
        .sub(float(0.9).sub(amount.mul(0.5)));
      const density = smoothstep(0, 0.5, field).pow2();
      // The sheet thins to nothing as the camera passes through it.
      const near = smoothstep(0, 500, abs(h0.sub(CIRRUS_ALTITUDE)));
      const slant = float(1).div(max(abs(dot(up, rd)), 0.22));
      const depth = density.mul(CIRRUS_DEPTH).mul(slant).mul(near);
      const through = exp(depth.negate()).toVar();
      // Ice scatters forward: bright toward the sun, and lit from below once the sun is under it.
      const lit = a
        .keyAt(p as V3)
        .mul(Volumetrics.phase(a.cosKey, 0.7, -0.15, 0.55, 2.2).mul(0.6))
        .add(a.skyLight.mul(CIRRUS_SKY));
      const sheetLight = a
        .throughAir(lit.mul(through.oneMinus()) as V3, through.oneMinus() as F, crossing as F)
        .toVar();
      const cloudNow = a.out.toVar();
      If(crossing.lessThan(a.outDistance), () => {
        // In front of the cloud.
        a.out.assign(vec4(sheetLight.add(cloudNow.rgb.mul(through)), cloudNow.a.mul(through)));
        a.outDistance.assign(select(cloudNow.a.greaterThan(0.99), crossing, a.outDistance));
      }).Else(() => {
        a.out.assign(vec4(cloudNow.rgb.add(sheetLight.mul(cloudNow.a)), cloudNow.a.mul(through)));
      });
    });
  }

  private marchAir(a: {
    counts: Node<'vec3'> | null;
    grazing: F;
    offset: F;
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
    /** Distance to the cloud on this ray (m); 1e9 without. */
    cloudDistance: F;
    /** x: the share of the air's light that comes from in front of the cloud; y: the air's transmittance there. */
    outSplit: Node<'vec2'>;
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
    const length0 = min(exit.sub(start), reach).toVar();
    // The steps are spread over `span`: the way to the end of the ray, or for a ray at or
    // above the horizon the way it would have with nothing in it (`grazing`); the march ends
    // at `length0` all the same.
    const span = mix(length0, min(lid.far.sub(start), reach), a.grazing).toVar();

    const transmittance = float(1).toVar();
    const scattered = vec3(0).toVar();
    const weight = float(0).toVar();
    const weighted = float(0).toVar();
    const weightFront = float(0).toVar();
    const throughFront = float(1).toVar();

    If(lid.disc.greaterThan(0).and(span.greaterThan(0)), () => {
      const keyNear = a.keyAt(ro.add(rd.mul(start)) as V3).toVar();
      const keyFar = a.keyAt(ro.add(rd.mul(start.add(min(span, 60_000)))) as V3).toVar();
      // A sharp forward lobe (the glow around a low sun in thin haze), a wide one for the
      // light the fog has scattered many times, and dust's.
      const phase = Volumetrics.phase(a.cosKey, 0.76, -0.1, 0.5, 9).toVar();
      const phaseWide = Volumetrics.phase(a.cosKey, 0.6, 0, 0, 8).toVar();
      const phaseDust = Volumetrics.phase(a.cosKey, 0.55, -0.1, 0.5, 5).toVar();

      // The weather changes over tens of kilometers: it is read at four points of the ray
      // and interpolated between them, not at every step.
      const fields = AIR_WEATHER_AT.map((u) => {
        const at = ro.add(rd.mul(start.add(span.mul(u * u)))) as V3;
        const w = weather.sample(at);
        return {
          a: vec4(w.fog, w.dust, w.precip, w.base).toVar(),
          // The level under which fog is full there: 100 m over the mean ground.
          b: vec3(
            w.cover,
            w.snow,
            weather.sampleGround(at).mul(this.groundGain).add(FOG_FLOOR),
          ).toVar(),
        };
      });

      Loop(steps, ({ i }) => {
        If(transmittance.lessThan(OPAQUE), () => {
          Break();
        });
        // Quadratic spacing: short steps near the camera.
        const u0 = float(i).div(steps);
        const u1 = float(i).add(1).div(steps);
        const ta = start.add(span.mul(u0).mul(u0)).toVar();
        If(ta.sub(start).greaterThanEqual(length0), () => {
          Break();
        });
        const dt = min(span.mul(u1.mul(u1).sub(u0.mul(u0))), start.add(length0).sub(ta)).toVar();
        const ts = ta.add(dt.mul(a.offset)).toVar();
        const p = ro.add(rd.mul(ts)).toVar();
        const r = length(p).toVar();
        const up = p.div(r).toVar();
        const h = r.sub(radius).toVar();
        const mu = dot(up, rd).toVar();
        // Piecewise linear between the four readings, by the step's place on the ray.
        const u = u0.add(u1).mul(0.5).toVar();
        let wa: Node<'vec4'> = fields[0]!.a;
        let wb: Node<'vec3'> = fields[0]!.b;
        for (let k = 1; k < fields.length; k++) {
          const f = clamp(
            u.sub(AIR_WEATHER_AT[k - 1]!).div(AIR_WEATHER_AT[k]! - AIR_WEATHER_AT[k - 1]!),
            0,
            1,
          );
          wa = mix(wa, fields[k]!.a, f) as Node<'vec4'>;
          wb = mix(wb, fields[k]!.b, f) as Node<'vec3'>;
        }
        const wv = wa.toVar();
        const wc = wb.toVar();
        const fog = wv.x;
        const dust = wv.y;
        const baseW = wv.w;
        const coverW = wc.x;
        const level = wc.z;

        // Fog: full under the level, exponential above, integrated over the step's heights.
        const scale = clamp(
          float(FOG_SCALE).div(max(fog, 1e-9)),
          FOG_HEIGHT[0],
          FOG_HEIGHT[1],
        ).toVar();
        const z = h.sub(level).toVar();
        // Banks: two layers of wisps that move apart, read where the fog is. Far steps see
        // their mean.
        const near = float(1)
          .sub(smoothstep(500, 3500, dt))
          .toVar();
        const banks = float(0.5).toVar();
        const wisps = float(0.5).toVar();
        If(
          fog
            .greaterThan(FOG_STRUCTURE)
            .and(near.greaterThan(0))
            .and(z.lessThan(scale.mul(5))),
          () => {
            const n1 = clouds.noise.sampleShape(p.div(FOG_TILE).add(this.fogShift) as V3);
            const n2 = clouds.noise.sampleShape(p.div(FOG_TILE_FINE).add(this.fogShiftFine) as V3);
            banks.assign(
              mix(float(0.5), n1.z.mul(0.65).add(n2.z.mul(0.35)), near.mul(this.structure)),
            );
            wisps.assign(
              mix(float(0.5), n2.z.mul(0.6).add(n1.w.mul(0.4)), near.mul(this.structure)),
            );
          },
        );
        // Close to the camera, wisps a few tens of meters across drift through the fog on
        // their own path: what one sees move.
        const close = float(1)
          .sub(smoothstep(FOG_NEAR_STEPS[0], FOG_NEAR_STEPS[1], dt))
          .toVar();
        const curl = float(0.5).toVar();
        If(
          fog
            .greaterThan(FOG_STRUCTURE)
            .and(close.greaterThan(0))
            .and(z.lessThan(scale.mul(5))),
          () => {
            const n3 = clouds.noise.sampleDetail(p.div(FOG_TILE_NEAR).add(this.fogShiftNear) as V3);
            curl.assign(
              mix(float(0.5), n3.y.mul(0.7).add(n3.z.mul(0.3)), close.mul(this.structure)),
            );
          },
        );
        // The banks' noise lifts and lowers the fog's top, and thins the fog between banks.
        const lift = banks.sub(0.5).mul(scale).mul(4);
        const za = z
          .sub(lift)
          .sub(mu.mul(ts.sub(ta)))
          .toVar();
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
        const thin = smoothstep(0.25, 0.75, wisps)
          .mul(1.2)
          .add(0.4)
          .mul(smoothstep(0.3, 0.7, curl).mul(1.4).add(0.3));
        const fogExtinction = fog.mul(column).mul(thin).toVar();

        // Rain and snow fill the air under their cloud, in veils that hang from the base
        // and lean with the wind.
        const rainExtinction = float(0).toVar();
        If(this.rainOn.greaterThan(0.5), () => {
          const precip = clamp(wv.z, 0, 8);
          const falling = smoothstep(baseW.add(150), baseW.sub(150), h)
            .mul(smoothstep(0, 0.1, precip))
            .toVar();
          If(falling.greaterThan(0.001), () => {
            // It rains under the cloud that is there, not wherever the weather's coarse
            // field says: the baked coverage has the cloud's edges (one read).
            const overhead = clouds.column(p as V3).cover;
            // The same streak down a whole (leaning) column: the noise is read near the ground.
            const leaned = p.sub((this.lean as unknown as V3).mul(h)).sub(up.mul(h.mul(0.92)));
            const veil = clouds.noise.sampleShape(leaned.div(RAIN_TILE).add(this.fogShift) as V3).z;
            const streaks = mix(
              float(1),
              smoothstep(0.34, 0.68, veil).mul(1.7).add(0.25),
              float(1)
                .sub(smoothstep(1500, 8000, dt))
                .mul(this.structure),
            )
              .mul(overhead)
              .toVar();
            // What lowers the visibility in rain is the rain: the weather's fog reaches up
            // to the base there, in the rain's streaks, and ends where the cloud ends.
            fogExtinction.assign(mix(fogExtinction, fog.mul(streaks), falling));
            rainExtinction.assign(precip.mul(RAIN_EXTINCTION).mul(streaks).mul(falling));
          });
        });

        // Dust: a wall where the field begins, a billowing top.
        const dustExtinctionNode = float(0).toVar();
        const dustTop = float(0).toVar();
        If(this.dustOn.greaterThan(0.5).and(dust.greaterThan(0.02)), () => {
          const nd = clouds.noise.sampleShape(p.div(DUST_TILE).add(this.dustShift) as V3);
          const farDust = smoothstep(3000, 20_000, dt);
          // Great billows, and smaller ones on them.
          const even = mix(float(1), farDust, this.structure).toVar();
          const billow = mix(nd.x.mul(0.6).add(nd.w.mul(0.4)), float(0.5), even).toVar();
          const wall = smoothstep(0.08, 0.3, dust.add(billow.sub(0.5).mul(0.35)));
          dustTop.assign(level.add(dust.mul(DUST_DEPTH).mul(billow.mul(1.1).add(0.45))));
          const body = smoothstep(dustTop, dustTop.sub(700), h);
          dustExtinctionNode.assign(
            dust
              .mul(dust)
              .mul(dustExtinction(1))
              .mul(wall)
              .mul(body)
              .mul(mix(nd.w, float(0.5), even).mul(0.5).add(0.75)),
          );
        });

        const extinction = fogExtinction.add(rainExtinction).add(dustExtinctionNode).toVar();
        If(extinction.greaterThan(1e-8), () => {
          a.counts?.addAssign(vec3(0, 0, 1));
          const muKey = dot(up, key).toVar();
          // The air's own optical depth above the sample, and toward the light.
          const fogAbove = fogExtinction.mul(scale);
          // Dust thins upward, and its grains scatter light on with little loss.
          const dustAbove = dustExtinctionNode
            .mul(max(dustTop.sub(h), 0))
            .mul(0.12)
            .toVar();
          const rainAbove = rainExtinction.mul(max(baseW.sub(h), 0));
          const above = fogAbove.add(dustAbove).add(rainAbove).toVar();
          const tau = above.div(max(muKey, 0.1)).toVar();
          // Under cloud the sky's light is the cloud base's: gray, and dim under deep cloud
          // (as on the ground, planetLighting.ts), from the weather's cover and rain here.
          const overcast = smoothstep(0.55, 0.95, coverW)
            .mul(clamp(wv.z.mul(0.3), 0, 0.6).add(0.4))
            .toVar();
          // Shadows of clouds and mountains: crepuscular rays.
          const visible = float(1).toVar();
          // Under a closed deck there are no shafts to draw: the deck's own shade stands in.
          visible.assign(float(1).sub(smoothstep(0.55, 0.95, coverW).mul(0.94)));
          If(this.shafts.greaterThan(0.5).and(coverW.lessThan(0.9)), () => {
            let v: F = float(1) as F;
            if (L.sunVisibility) v = v.mul(L.sunVisibility(p as V3)) as F;
            if (L.terrainShadow) v = v.mul(L.terrainShadow(p as V3)) as F;
            visible.assign(v);
          });
          // Little of the sun comes through deep cloud, and none of its color.
          visible.mulAssign(float(1).sub(smoothstep(0.45, 0.8, overcast).mul(0.97)));
          const keyColor = mix(keyNear, keyFar, clamp(ts.sub(start).div(60_000), 0, 1));
          const share = dustExtinctionNode.div(extinction).toVar();
          // Singly scattered light, sharp around the sun, and the light the layer has
          // scattered on: it thins with the depth above, glows wide around the sun, and
          // is brighter on a bank's top than between banks.
          const direct = exp(tau.negate()).mul(mix(phase, phaseDust, share));
          const diffuse = exp(above.mul(-AIR_DIFFUSE))
            .mul(phaseWide.mul(0.8).add(0.2))
            .mul(banks.mul(0.9).add(0.55))
            .mul(curl.mul(0.9).add(0.55));
          const sky = overcastSky(a.skyLight.mul(AIR_SKY) as V3, overcast as F).mul(
            exp(above.mul(-0.12)),
          );
          // Dust takes the blue out of whatever light passes through it.
          const filtered = exp(
            vec3(...DUST_FILTER)
              .mul(min(dustAbove, 6))
              .negate(),
          );
          const albedo = vec3(...FOG_ALBEDO)
            .mul(fogExtinction)
            .add(mix(vec3(...RAIN_ALBEDO), vec3(...SNOW_ALBEDO), wc.y).mul(rainExtinction))
            .add(vec3(...DUST_ALBEDO).mul(dustExtinctionNode))
            .div(extinction);
          const source = keyColor
            .mul(
              visible
                .mul(direct)
                .add(diffuse.mul(visible.mul(0.92).add(coverW.oneMinus().mul(0.08)))),
            )
            .add(sky)
            .mul(filtered)
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
          // No step counts for more than AIR_STEP_DEPTH of optical depth: a far layer's
          // surface is then drawn by several samples, not by the one that happens to enter it.
          const through = exp(min(extinction.mul(dt), AIR_STEP_DEPTH).negate()).toVar();
          const part = transmittance.mul(through.oneMinus()).toVar();
          scattered.addAssign(source.mul(albedo).mul(part));
          weight.addAssign(part);
          weighted.addAssign(part.mul(ts));
          transmittance.mulAssign(through);
          // In front of the cloud or behind it, with a soft change around its distance.
          const ahead = float(1)
            .sub(smoothstep(a.cloudDistance.mul(0.7), a.cloudDistance.mul(1.3), ts))
            .toVar();
          weightFront.addAssign(part.mul(ahead));
          throughFront.mulAssign(mix(float(1), through, ahead));
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
        scattered.addAssign(keyNear.mul(dimmed).mul(disk).mul(transmittance.oneMinus()).mul(5));
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
    a.outSplit.assign(
      vec2(
        select(weight.greaterThan(1e-6), weightFront.div(max(weight, 1e-6)), float(1)),
        throughFront,
      ),
    );
  }
}
