/**
 * The weather at the camera, as uniforms every effect shares: precipitation
 * particles, fog and dust, wet ground, lightning, and the animation clock.
 * GlobeScene owns one instance, creates it before any material, and fills it
 * once per frame from its weather view.
 *
 * `update` samples the view's report and wind where the camera is and writes:
 *
 * - `rain` and `snow`: the precipitation rate, split by the snow fraction,
 *   each on the logarithmic intensity scale of `precipitationIntensity`.
 *   These are the rates under the cloud; whether the camera is above the
 *   cloud that rains is for the effect that draws the rain to decide.
 * - `fog`: the extinction of the air near the ground, from the visibility
 *   (Koschmieder: 3.912 / visibility), zero from 20 km of visibility up, and
 *   without the share of dust, which has its own field. It is the extinction
 *   that is interpolated between the weather samples and the two hourly
 *   frames, not the visibility (`fogAt`): the weather texture does the same,
 *   so its `fog` at the camera's position is this value, a fog bank thins
 *   evenly toward its edge, and fog forms evenly through the hour. No fall-off
 *   with height is applied here: the shader that marches the fog does that.
 * - `dust` and `storm` as the weather gives them.
 * - `wind`: the wind at the camera's altitude, turned from east and north
 *   components into the world frame (rule 3).
 * - `wetness`: how wet the ground is. It follows the rain within about half
 *   a minute and dries over minutes of real time. The first update takes it
 *   straight from the weather, so a scene that starts in rain starts wet.
 * - `clock`: real seconds, wrapped every hour, for swirl, particles, twinkle.
 *
 * The lightning fields (`flash`, `flashPosition`) are declared here and
 * written by the lightning scheduler.
 *
 * The functions the update is made of are exported and pure, so tests cover
 * them without a GPU.
 */
import { Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { GameTime, Meters, Seconds } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import { Channel, dustVisibility, MM_PER_HOUR } from '../../../sim/weather/frame';
import type { WeatherReport, WeatherView, Wind } from '../../../sim/weather/frame';

/** Precipitation rate of full intensity (m/s of water): 30 mm/h, a skyfall. */
export const SKYFALL_RATE = 30 * MM_PER_HOUR;
/** Rate at which the intensity scale turns from linear to logarithmic (m/s of water). */
const INTENSITY_KNEE = 0.35 * MM_PER_HOUR;

/**
 * Intensity 0..1 from a precipitation rate in m/s of water, on a logarithmic
 * scale: 0 for none, 0.2 for drizzle (0.5 mm/h), 0.56 for steady rain
 * (4 mm/h), 1 for a skyfall (30 mm/h or more).
 */
export function precipitationIntensity(rate: number): number {
  if (!(rate > 0)) return 0;
  return Math.min(
    1,
    Math.log(1 + rate / INTENSITY_KNEE) / Math.log(1 + SKYFALL_RATE / INTENSITY_KNEE),
  );
}

/** Koschmieder's constant: extinction × visibility at a contrast threshold of 2%. */
export const KOSCHMIEDER = 3.912;
/** Visibility from which the air counts as clear and draws no fog (m). */
export const FOG_CLEAR_VISIBILITY: Meters = 20_000;
/** Visibility above which the fog fades toward FOG_CLEAR_VISIBILITY, so it never switches off in a step (m). */
const FOG_FADE_VISIBILITY: Meters = 12_000;

/** Extinction of dust alone (1/m) for a dust load 0..1. */
export function dustExtinction(dust: number): number {
  return dust > 0 ? KOSCHMIEDER / dustVisibility(dust) : 0;
}

/**
 * Fog extinction near the ground (1/m) from the visibility: 3.912 / visibility
 * up to 12 km, fading to zero at 20 km. The visibility already counts dust;
 * its share is taken out, because dust is drawn as its own layer.
 */
export function fogExtinction(visibility: Meters, dust = 0): number {
  if (!(visibility < FOG_CLEAR_VISIBILITY)) return 0;
  const t = Math.max(
    0,
    (visibility - FOG_FADE_VISIBILITY) / (FOG_CLEAR_VISIBILITY - FOG_FADE_VISIBILITY),
  );
  const fade = 1 - t * t * (3 - 2 * t);
  return Math.max(0, (KOSCHMIEDER / Math.max(visibility, 10)) * fade - dustExtinction(dust));
}

/**
 * Fog extinction (1/m) of every sample of a weather frame's data (channel
 * planes over `count` samples), written into `out`: `fogExtinction` of the
 * sample's visibility and dust.
 */
export function frameFog(
  data: Float32Array,
  count: number,
  out: Float32Array = new Float32Array(count),
): Float32Array {
  const visibility = Channel.Visibility * count;
  const dust = Channel.Dust * count;
  for (let s = 0; s < count; s++) {
    out[s] = fogExtinction(data[visibility + s]!, data[dust + s]!);
  }
  return out;
}

const fogIndex = new Int32Array(4);
const fogWeight = new Float64Array(4);

/**
 * Fog extinction (1/m) of a view at a direction from the planet center and a
 * game time: `fogExtinction` at the four weather samples around the direction
 * in each hourly frame, blended in space and time. Extinction adds up along a
 * ray and mixes linearly; a visibility does neither (halfway between 200 m of
 * fog and 40 km of clear air the visibility is not 20 km), so this is not
 * `fogExtinction` of the view's interpolated visibility. The weather texture's
 * `fog` is built the same way. NaN-free: 0 for a view without frames.
 */
export function fogAt(view: WeatherView, dir: Readonly<Vec3d>, t: GameTime): number {
  const [a, b] = view.frames;
  if (!a) return 0;
  const count = view.grid.count;
  view.grid.bilinear(dir, fogIndex, fogWeight);
  const visibility = Channel.Visibility * count;
  const dust = Channel.Dust * count;
  const at = (data: Float32Array) => {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const s = fogIndex[k]!;
      sum += fogWeight[k]! * fogExtinction(data[visibility + s]!, data[dust + s]!);
    }
    return sum;
  };
  const fa = at(a.data);
  const f = b ? view.blend(t) : 0;
  return f === 0 ? fa : fa + (at(b!.data) - fa) * f;
}

/**
 * A wind given as east and north components at a direction from the planet
 * center (any length), as a vector in the world frame (+Y through the north
 * pole). At the poles east is taken as +X.
 */
export function windToWorld<T extends { x: number; y: number; z: number }>(
  dir: Readonly<Vec3d>,
  east: number,
  north: number,
  out: T,
): T {
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / l;
  const dy = dir.y / l;
  const dz = dir.z / l;
  // East = ŷ × d, north = d × east, as on the weather grid.
  let ex = dz;
  let ez = -dx;
  const el = Math.hypot(ex, ez);
  if (el < 1e-9) {
    ex = 1;
    ez = 0;
  } else {
    ex /= el;
    ez /= el;
  }
  out.x = east * ex + north * dy * ez;
  out.y = north * (dz * ex - dx * ez);
  out.z = east * ez - north * dy * ex;
  return out;
}

/** Time constants of the ground's wetness (real s): getting wet in rain, and drying. */
export const WETNESS_RISE: Seconds = 10;
export const WETNESS_DRY: Seconds = 180;

/** The wetness steady rain of an intensity leads to: drizzle dampens, rain soaks. */
export function wetnessTarget(rain: number): number {
  return Math.min(1, 2.5 * Math.max(0, rain));
}

/** The ground's wetness after dt real seconds of rain at an intensity 0..1. */
export function stepWetness(wetness: number, rain: number, dt: Seconds): number {
  const target = wetnessTarget(rain);
  const tau = target > wetness ? WETNESS_RISE : WETNESS_DRY;
  return target + (wetness - target) * Math.exp(-Math.max(0, dt) / tau);
}

/** The animation clock wraps here (s), so its float32 keeps millisecond steps. */
export const CLOCK_WRAP: Seconds = 3600;

export class WeatherState {
  /** Rain intensity at the camera, 0..1: 0 none, ~0.2 drizzle (0.5 mm/h), ~0.55 rain (4 mm/h), 1 skyfall (≥ 30 mm/h); log scale. */
  readonly rain = uniform(0);
  /** Snowfall intensity at the camera, 0..1 on the same scale (water equivalent). */
  readonly snow = uniform(0);
  /** Dust or sand in the air at the camera, 0..1 (1 = sandstorm, visibility 200 m). */
  readonly dust = uniform(0);
  /** Thunderstorm intensity at the camera, 0..1. */
  readonly storm = uniform(0);
  /** Fog extinction at the camera near the ground (1/m): 3.912 / visibility, without dust (`fogAt`). */
  readonly fog = uniform(0);
  /** Wind at the camera (air velocity, world frame, m/s). */
  readonly wind = uniform(new Vector3());
  /** Ground wetness 0..1: rises in rain, dries slowly (real seconds). */
  readonly wetness = uniform(0);
  /** Lightning: flash intensity now, 0..1 (lights clouds from inside, brightens sky light briefly). */
  readonly flash = uniform(0);
  /** Planet-centered position of the active discharge (m). */
  readonly flashPosition = uniform(new Vector3());
  /** Animation clock (real seconds while not paused, wrapped at 3600 s): swirl, particles, twinkle. */
  readonly clock = uniform(0);
  /** CPU mirrors for code that needs numbers: report at the camera, or null in clear air. */
  local: WeatherReport | null = null;
  /** False until an update has taken the wetness straight from the weather. */
  private settled = false;
  private readonly scratch: Wind = { east: 0, north: 0 };

  /**
   * Fills the camera values from a view (null = clear) and advances clock and
   * wetness by dt real seconds. `cameraDir` is the camera's direction from the
   * planet center (any length), `altitude` its height above sea level (m).
   */
  update(
    view: WeatherView | null,
    cameraDir: Readonly<Vec3d>,
    altitude: Meters,
    gameTime: GameTime,
    dt: Seconds,
  ): void {
    // A missing or negative dt (a first frame, a clock set back) is no time at all.
    const step = dt > 0 ? dt : 0;
    this.clock.value = (this.clock.value + step) % CLOCK_WRAP;
    if (!view || !view.ready) {
      this.local = null;
      this.rain.value = 0;
      this.snow.value = 0;
      this.dust.value = 0;
      this.storm.value = 0;
      this.fog.value = 0;
      this.wind.value.set(0, 0, 0);
      this.wetness.value = this.settled ? stepWetness(this.wetness.value, 0, step) : 0;
      return;
    }
    const report = view.report(cameraDir, gameTime);
    this.local = report;
    this.rain.value = precipitationIntensity(report.precipitation * (1 - report.snow));
    this.snow.value = precipitationIntensity(report.precipitation * report.snow);
    this.dust.value = Math.min(1, Math.max(0, report.dust));
    this.storm.value = Math.min(1, Math.max(0, report.storm));
    this.fog.value = fogAt(view, cameraDir, gameTime);
    const wind = view.wind(cameraDir, altitude, gameTime, this.scratch);
    windToWorld(cameraDir, wind.east, wind.north, this.wind.value);
    this.wetness.value = this.settled
      ? stepWetness(this.wetness.value, this.rain.value, step)
      : wetnessTarget(this.rain.value);
    this.settled = true;
  }

  /**
   * Makes the next update take the wetness straight from the weather again:
   * call it when the camera or the clock jumps (a new flight, a preview view).
   */
  reset(): void {
    this.settled = false;
  }
}
