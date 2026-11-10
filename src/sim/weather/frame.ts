/**
 * Weather frames (decision 68): the weather fields at one whole game hour, on
 * the weather grid, as one Float32Array of channel planes (channel-major), so
 * a frame transfers to the main thread as a single buffer.
 *
 * `WeatherView` holds the frames of two consecutive hours and interpolates
 * between them in time and bilinearly in space. The sim's execution layer and
 * the main thread (renderer, debug UI) read weather through the same class.
 */
import type { GameTime, Meters } from '../../core/units';
import { HOUR } from '../../core/units';
import type { Vec3d } from '../../core/vec3d';
import type { WeatherGrid } from './grid';

/** Altitudes of the wind levels (m): surface (10 m), about 850, 500 and 250 hPa. */
export const WIND_LEVELS: readonly Meters[] = [10, 1500, 5500, 10_000];

export const Channel = {
  /** Cloud cover fraction 0..1. */
  Cover: 0,
  /** Height of the lowest cloud base above ground (m). */
  CloudBase: 1,
  /** Horizontal visibility near the ground (m). */
  Visibility: 2,
  /** Precipitation rate (m/s of water). */
  Precipitation: 3,
  /** Fraction of precipitation falling as snow, 0..1. */
  Snow: 4,
  /** Air temperature near the ground (°C). */
  Temperature: 5,
  /** Sea-level pressure (Pa). */
  Pressure: 6,
  /** Wind east and north components (m/s) at WIND_LEVELS[k]: channels 7 + 2k and 8 + 2k. */
  WindEast0: 7,
} as const;
export const CHANNEL_COUNT = 7 + 2 * WIND_LEVELS.length;

/** A ceiling exists where cover is broken or overcast (at least 5/8). */
export const CEILING_COVER = 5 / 8;

/** Weather at one place and time, for flight operations. */
export interface WeatherReport {
  cloudCover: number;
  /** Lowest cloud base above ground (m). */
  cloudBase: Meters;
  /** Base of a broken or overcast layer above ground (m), Infinity if none. */
  ceiling: Meters;
  visibility: Meters;
  /** Precipitation rate (m/s of water). */
  precipitation: number;
  /** Snow fraction of the precipitation, 0..1. */
  snow: number;
  /** Near-surface air temperature (°C). */
  temperature: number;
  /** Sea-level pressure (Pa). */
  pressure: number;
}

export interface Wind {
  /** Eastward component (m/s). */
  east: number;
  /** Northward component (m/s). */
  north: number;
}

/** One frame: the fields at game time `hour · HOUR`. */
export interface WeatherFrame {
  hour: number;
  data: Float32Array;
}

export function newFrameData(grid: WeatherGrid): Float32Array {
  return new Float32Array(CHANNEL_COUNT * grid.count);
}

/** Two consecutive frames and interpolation between them. */
export class WeatherView {
  private a: WeatherFrame | null = null;
  private b: WeatherFrame | null = null;
  private readonly idx = new Int32Array(4);
  private readonly w = new Float64Array(4);

  constructor(readonly grid: WeatherGrid) {}

  /** The earlier and later frame (either may be missing). */
  get frames(): [WeatherFrame | null, WeatherFrame | null] {
    return [this.a, this.b];
  }

  clear(): void {
    this.a = this.b = null;
  }

  /** Adds a frame; keeps the two latest consecutive hours. */
  add(frame: WeatherFrame): void {
    if (this.b && frame.hour === this.b.hour + 1) {
      this.a = this.b;
      this.b = frame;
    } else if (this.a && frame.hour === this.a.hour + 1 && !this.b) {
      this.b = frame;
    } else if (!this.b || frame.hour !== this.b.hour) {
      this.a = frame;
      this.b = null;
    }
  }

  /** Time blend between the frames at game time t: 0 at the earlier hour, 1 at the later. */
  blend(t: GameTime): number {
    if (!this.a || !this.b) return 0;
    return Math.min(1, Math.max(0, t / HOUR - this.a.hour));
  }

  get ready(): boolean {
    return this.a !== null;
  }

  /** A channel at a direction and time, interpolated in space and time. */
  sample(channel: number, d: Readonly<Vec3d>, t: GameTime): number {
    if (!this.a) return NaN;
    this.grid.bilinear(d, this.idx, this.w);
    const base = channel * this.grid.count;
    const at = (data: Float32Array) =>
      data[base + this.idx[0]!]! * this.w[0]! +
      data[base + this.idx[1]!]! * this.w[1]! +
      data[base + this.idx[2]!]! * this.w[2]! +
      data[base + this.idx[3]!]! * this.w[3]!;
    const va = at(this.a.data);
    if (!this.b) return va;
    const f = this.blend(t);
    return f === 0 ? va : va + (at(this.b.data) - va) * f;
  }

  /** Weather for flight operations at a direction and time. */
  report(d: Readonly<Vec3d>, t: GameTime): WeatherReport {
    const cover = this.sample(Channel.Cover, d, t);
    const base = this.sample(Channel.CloudBase, d, t);
    return {
      cloudCover: cover,
      cloudBase: base,
      ceiling: cover >= CEILING_COVER ? base : Infinity,
      visibility: this.sample(Channel.Visibility, d, t),
      precipitation: this.sample(Channel.Precipitation, d, t),
      snow: this.sample(Channel.Snow, d, t),
      temperature: this.sample(Channel.Temperature, d, t),
      pressure: this.sample(Channel.Pressure, d, t),
    };
  }

  /** Wind at an altitude above sea level, interpolated between the levels (clamped). */
  wind(d: Readonly<Vec3d>, altitude: Meters, t: GameTime, out: Wind = { east: 0, north: 0 }): Wind {
    const L = WIND_LEVELS;
    let k = 0;
    while (k < L.length - 2 && altitude > L[k + 1]!) k++;
    const f = Math.min(1, Math.max(0, (altitude - L[k]!) / (L[k + 1]! - L[k]!)));
    const c0 = Channel.WindEast0 + 2 * k;
    const e0 = this.sample(c0, d, t);
    const n0 = this.sample(c0 + 1, d, t);
    const e1 = this.sample(c0 + 2, d, t);
    const n1 = this.sample(c0 + 3, d, t);
    out.east = e0 + (e1 - e0) * f;
    out.north = n0 + (n1 - n0) * f;
    return out;
  }
}
