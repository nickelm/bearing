/**
 * Weather presets: a chosen kind of weather in place of the model's, for Free
 * Flight's start screen, the debug panel and previews.
 *
 * A preset is a pure function of a live frame: `presetFrame` returns a frame
 * for the same hour on the same grid, so everything downstream (WeatherView,
 * the weather texture, WeatherState) treats it like any other frame, and the
 * two hourly frames around a game time stay consistent with each other.
 *
 * - `live` is the model's frame itself, unchanged.
 * - The others set cover, cloud base, visibility, precipitation, dust and
 *   storm from PRESET_TABLE, clamp the live temperature into the preset's range
 *   (the snow fraction follows from it as in the model), keep the live
 *   pressure, and keep the live wind's direction at every level while holding
 *   its speed between the preset's limits: storm, blizzard and duststorm blow
 *   at gale force or more near the ground, fog is nearly calm.
 * - So the sky is not uniform, the values vary with a smooth pattern of a few
 *   hundred kilometers that drifts slowly with the frame's hour: a fixed sum
 *   of waves over the sample's direction, no random numbers (rule 5). Clear
 *   and fog are uniform.
 */
import type { Meters } from '../../core/units';
import { CHANNEL_COUNT, Channel, dustVisibility, MM_PER_HOUR, WIND_LEVELS } from './frame';
import type { WeatherFrame, WeatherView } from './frame';
import type { WeatherGrid } from './grid';

export const WEATHER_PRESETS = [
  'live',
  'clear',
  'fair',
  'overcast',
  'drizzle',
  'rain',
  'storm',
  'snow',
  'blizzard',
  'fog',
  'duststorm',
] as const;
export type WeatherPreset = (typeof WEATHER_PRESETS)[number];

/** A preset's nominal values: what a sample shows where the variation is zero. */
export interface PresetSpec {
  /** One line for menus. */
  label: string;
  /** Cloud cover 0..1, and how far the variation moves it either way. */
  cover: number;
  coverSpread: number;
  /** Cloud base above ground (m). */
  cloudBase: Meters;
  /** Visibility near the ground (m). */
  visibility: Meters;
  /** Precipitation rate (m/s of water). */
  precipitation: number;
  /** Snow fraction the temperature range implies, 0 or 1. */
  snow: number;
  dust: number;
  storm: number;
  /** Range the live surface temperature is clamped into (°C). */
  temperature: readonly [number, number];
  /** Limits of the surface wind speed (m/s); higher levels scale with PRESET_WIND_GAIN. */
  windMin: number;
  windMax: number;
  /**
   * Strength of the spatial variation, 0..1: at 1, precipitation doubles and
   * halves across the pattern, and the other fields follow in proportion.
   */
  variation: number;
}

/** Beaufort 8, a gale (m/s): the least surface wind of the windy presets. */
export const GALE = 17.2;

/** Wind limits per level of WIND_LEVELS, as multiples of the surface limits. */
export const PRESET_WIND_GAIN: readonly number[] = [1, 1.4, 1.7, 2];

const FREE: readonly [number, number] = [-60, 60];
const NO_WIND = { windMin: 0, windMax: Infinity };

export const PRESET_TABLE: Record<Exclude<WeatherPreset, 'live'>, PresetSpec> = {
  clear: {
    label: 'Clear: no cloud, visibility 60 km',
    cover: 0,
    coverSpread: 0,
    cloudBase: 3000,
    visibility: 60_000,
    precipitation: 0,
    snow: 0,
    dust: 0,
    storm: 0,
    temperature: FREE,
    ...NO_WIND,
    variation: 0,
  },
  fair: {
    label: 'Fair: scattered cumulus, good visibility',
    cover: 0.35,
    coverSpread: 0.2,
    cloudBase: 1400,
    visibility: 35_000,
    precipitation: 0,
    snow: 0,
    dust: 0,
    storm: 0,
    temperature: FREE,
    ...NO_WIND,
    variation: 0.4,
  },
  overcast: {
    label: 'Overcast: a gray ceiling at 900 m, dry',
    cover: 0.95,
    coverSpread: 0.06,
    cloudBase: 900,
    visibility: 12_000,
    precipitation: 0,
    snow: 0,
    dust: 0,
    storm: 0,
    temperature: FREE,
    ...NO_WIND,
    variation: 0.4,
  },
  drizzle: {
    label: 'Drizzle: low stratus, 0.4 mm/h',
    cover: 1,
    coverSpread: 0,
    cloudBase: 350,
    visibility: 5000,
    precipitation: 0.4 * MM_PER_HOUR,
    snow: 0,
    dust: 0,
    storm: 0,
    temperature: [4, 60],
    ...NO_WIND,
    variation: 0.6,
  },
  rain: {
    label: 'Rain: steady, 4 mm/h, visibility 3 km',
    cover: 1,
    coverSpread: 0,
    cloudBase: 500,
    visibility: 3000,
    precipitation: 4 * MM_PER_HOUR,
    snow: 0,
    dust: 0,
    storm: 0,
    temperature: [5, 60],
    ...NO_WIND,
    variation: 0.7,
  },
  storm: {
    label: 'Thunderstorm: 30 mm/h cores, lightning, gale',
    cover: 1,
    coverSpread: 0,
    cloudBase: 600,
    visibility: 800,
    precipitation: 30 * MM_PER_HOUR,
    snow: 0,
    dust: 0,
    storm: 0.85,
    temperature: [14, 60],
    windMin: GALE + 0.8,
    windMax: Infinity,
    variation: 0.8,
  },
  snow: {
    label: 'Snow: steady snowfall, visibility 1.5 km',
    cover: 1,
    coverSpread: 0,
    cloudBase: 500,
    visibility: 1500,
    precipitation: 1.2 * MM_PER_HOUR,
    snow: 1,
    dust: 0,
    storm: 0,
    temperature: [-60, -3],
    ...NO_WIND,
    variation: 0.6,
  },
  blizzard: {
    label: 'Blizzard: heavy snow in a gale, visibility 300 m',
    cover: 1,
    coverSpread: 0,
    cloudBase: 250,
    visibility: 300,
    precipitation: 3 * MM_PER_HOUR,
    snow: 1,
    dust: 0,
    storm: 0,
    temperature: [-60, -8],
    windMin: 20,
    windMax: Infinity,
    variation: 0.5,
  },
  fog: {
    label: 'Fog: visibility 200 m under a clear sky, calm',
    cover: 0.1,
    coverSpread: 0,
    cloudBase: 2500,
    visibility: 200,
    precipitation: 0,
    snow: 0,
    dust: 0,
    storm: 0,
    temperature: [-10, 15],
    windMin: 0,
    windMax: 2,
    variation: 0,
  },
  duststorm: {
    label: 'Dust storm: blowing sand, visibility 250 m, hot',
    cover: 0.1,
    coverSpread: 0.1,
    cloudBase: 3000,
    visibility: 240,
    precipitation: 0,
    snow: 0,
    dust: 0.92,
    storm: 0,
    temperature: [30, 60],
    windMin: 20,
    windMax: Infinity,
    variation: 0.4,
  },
};

/** One line per preset for menus. */
export const PRESET_LABELS: Record<WeatherPreset, string> = {
  live: "Live: the world's own weather",
  ...(Object.fromEntries(
    Object.entries(PRESET_TABLE).map(([name, spec]) => [name, spec.label]),
  ) as Record<Exclude<WeatherPreset, 'live'>, string>),
};

/**
 * The preset's spatial variation at a unit direction and frame hour, −1..1:
 * three waves of 580 to 1,080 km (on a 1,000 km planet) whose phases drift
 * with the hour, so the pattern moves a few meters per second.
 */
export function presetVariation(x: number, y: number, z: number, hour: number): number {
  const v =
    Math.sin(7 * x + 3 * y - 5 * z + 0.21 * hour) +
    Math.sin(-4 * x + 8 * y + 6 * z - 0.13 * hour + 1.7) +
    Math.sin(3 * x - 4 * y + 3 * z + 0.17 * hour + 4.1);
  return Math.max(-1, Math.min(1, v / 2.2));
}

/**
 * The frame a preset shows in place of a live frame: same hour, same grid.
 * `live` returns the frame itself; the others a new frame.
 */
export function presetFrame(
  preset: WeatherPreset,
  live: WeatherFrame,
  grid: WeatherGrid,
): WeatherFrame {
  if (preset === 'live') return live;
  const spec = PRESET_TABLE[preset];
  const n = grid.count;
  if (live.data.length !== CHANNEL_COUNT * n) {
    throw new RangeError('Weather frame does not match the weather grid');
  }
  const data = new Float32Array(live.data.length);
  const src = live.data;
  for (let p = 0; p < n; p++) {
    const v =
      spec.variation > 0 || spec.coverSpread > 0
        ? presetVariation(
            grid.directions[p * 3]!,
            grid.directions[p * 3 + 1]!,
            grid.directions[p * 3 + 2]!,
            live.hour,
          )
        : 0;
    // Heavier weather where v is positive: more rain, a lower base, less visibility.
    const m = spec.variation * v;
    const heavier = 2 ** m;
    const dust = clamp(spec.dust * (1 + 0.25 * m), 0, 1);
    const temperature = clamp(
      src[Channel.Temperature * n + p]!,
      spec.temperature[0],
      spec.temperature[1],
    );
    data[Channel.Cover * n + p] = clamp(spec.cover + spec.coverSpread * v, 0, 1);
    data[Channel.CloudBase * n + p] = spec.cloudBase * (1 - 0.25 * m);
    data[Channel.Visibility * n + p] = Math.min(
      spec.visibility / heavier ** 0.8,
      dustVisibility(dust),
    );
    data[Channel.Precipitation * n + p] = spec.precipitation * heavier;
    data[Channel.Snow * n + p] = 1 - smoothstep(-1.5, 1.5, temperature);
    data[Channel.Temperature * n + p] = temperature;
    data[Channel.Pressure * n + p] = src[Channel.Pressure * n + p]!;
    data[Channel.Dust * n + p] = dust;
    data[Channel.Storm * n + p] = clamp(spec.storm * (1 + 0.3 * m), 0, 1);
    // Winds keep their direction; the speed is held between the preset's limits.
    let unitEast = 1;
    let unitNorth = 0;
    for (let k = 0; k < WIND_LEVELS.length; k++) {
      const ce = (Channel.WindEast0 + 2 * k) * n + p;
      const cn = ce + n;
      const speed = Math.hypot(src[ce]!, src[cn]!);
      const target = clamp(
        speed,
        spec.windMin * PRESET_WIND_GAIN[k]!,
        spec.windMax * PRESET_WIND_GAIN[k]!,
      );
      // Still air has no direction: it takes the level below's (east at the surface).
      if (speed > 1e-3) {
        unitEast = src[ce]! / speed;
        unitNorth = src[cn]! / speed;
      }
      const east = unitEast * target;
      const north = unitNorth * target;
      data[ce] = east;
      data[cn] = north;
    }
  }
  return { hour: live.hour, data };
}

/** Fills `target` with the preset's version of every frame `source` holds. */
export function applyPreset(preset: WeatherPreset, source: WeatherView, target: WeatherView): void {
  target.clear();
  for (const frame of source.frames) {
    if (frame) target.add(presetFrame(preset, frame, source.grid));
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
