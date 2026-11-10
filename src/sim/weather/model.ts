/**
 * The weather model (decision 68): a fixed-tick sim process on the coarse
 * weather grid, ticking once per game hour, drawing from rng(seed, "weather")
 * and driven by the world's climate and the season (decision 15).
 *
 * State is a list of synoptic systems: mid-latitude lows, subtropical highs
 * and tropical lows. Each hour they spawn (from a per-hour fork of the stream,
 * `h<k>`), drift with the steering wind, deepen and fill over their lives, and
 * die. The fields are a pure function of the systems, the climate and the
 * clock, evaluated per grid sample:
 *
 * - **Pressure** is the climate background plus a Gaussian anomaly per system.
 * - **Wind** at four levels: the climate's prevailing surface wind, a jet that
 *   grows with height and in the winter hemisphere, and the circulation
 *   around each system (cyclonic around lows, turning inward near the ground).
 * - **Humidity** (a relative-humidity proxy) from the climate's wetness, lift
 *   in lows and along a spiral frontal band, sinking air in highs, upslope
 *   wind over terrain, afternoon convection over warm land and slowly
 *   evolving mesoscale noise. Cloud cover, cloud base, precipitation and
 *   visibility follow from it, plus fog on calm, humid nights.
 * - **Temperature** from the climate's annual mean, the seasonal cycle and a
 *   diurnal cycle damped by cloud.
 *
 * Because the state advances only on hourly ticks and each tick draws from
 * its own fork, the weather at a given game time is identical at any time
 * acceleration, and after a seek that replays from campaign start.
 */
import { localSolarTime, seasonPhase } from '../../core/calendar';
import type { CampaignCalendar, OrbitParams } from '../../core/calendar';
import { latLonToDirection } from '../../core/coords';
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import type { GameTime, Meters } from '../../core/units';
import { DEG, HOUR, KM } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { StateHasher } from '../stateHash';
import type { Simulation, TickProcess } from '../simulation';
import type { WeatherClimate } from './climate';
import { Channel, newFrameData, WeatherView, WIND_LEVELS } from './frame';
import type { WeatherFrame } from './frame';
import { WeatherGrid } from './grid';

export const SystemKind = { Low: 0, High: 1, Tropical: 2 } as const;
export type SystemKind = (typeof SystemKind)[keyof typeof SystemKind];

/** One synoptic system. Immutable: each hour's evolution makes new objects. */
export interface WeatherSystem {
  readonly id: number;
  readonly kind: SystemKind;
  /** Unit direction of the center. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Peak sea-level pressure anomaly (Pa): negative for lows. */
  readonly peak: number;
  readonly radius: Meters;
  /** Age and lifetime (s). */
  readonly age: number;
  readonly life: number;
  /** Persistent northward drift offset (m/s), so systems do not all move alike. */
  readonly drift: number;
}

export interface WeatherConfig {
  seed: WorldSeed;
  radius: Meters;
  orbit: OrbitParams;
  calendar: CampaignCalendar;
  climate: WeatherClimate;
}

/** Hours simulated before campaign start, so the first weather is mature. */
export const SPIN_UP_HOURS = 120;

interface KindSpec {
  /** Spawn attempts per hour (equilibrium count ≈ rate × mean life in hours). */
  rate: number;
  /** Latitude band (degrees): mean and spread, clamped to [min, max]. */
  lat: [number, number, number, number];
  peak: [number, number];
  radius: [number, number];
  life: [number, number];
}

const KINDS: Record<SystemKind, KindSpec> = {
  [SystemKind.Low]: {
    rate: 7 / 108,
    lat: [47, 9, 30, 68],
    peak: [-2800, -1200],
    radius: [280 * KM, 460 * KM],
    life: [3 * 24 * HOUR, 6 * 24 * HOUR],
  },
  [SystemKind.High]: {
    rate: 5 / 144,
    lat: [32, 6, 20, 48],
    peak: [800, 1800],
    radius: [420 * KM, 700 * KM],
    life: [4 * 24 * HOUR, 8 * 24 * HOUR],
  },
  [SystemKind.Tropical]: {
    rate: 1.5 / 120,
    lat: [13, 4, 7, 20],
    peak: [-3500, -1000],
    radius: [150 * KM, 260 * KM],
    life: [3 * 24 * HOUR, 7 * 24 * HOUR],
  },
};

/** Tangential wind per Pa of anomaly at the radius of maximum wind (m/s per Pa). */
const WIND_PER_PA = 0.0095;
/** Per wind level: circulation strength and inflow angle (rad) for lows (outflow for highs). */
const LEVEL_CIRCULATION = [0.75, 1, 0.8, 0.55];
const LEVEL_INFLOW = [25 * DEG, 12 * DEG, 0, 0];
/** Per wind level: weight of the climate's surface wind and of the jet. */
const LEVEL_SURFACE = [1, 1.1, 0.5, 0.2];
const LEVEL_JET = [0, 0.25, 0.65, 1];
/** Wavelength of the mesoscale humidity noise (m), and the time over which it evolves by about one feature (s). */
const NOISE_WAVELENGTH = 400 * KM;
const NOISE_EVOLVE = 36 * HOUR;
const MM_PER_HOUR = 0.001 / HOUR;

const gauss = (x: number, mu: number, sigma: number) => Math.exp(-(((x - mu) / sigma) ** 2));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Seasonal factor: +1 at the peak of summer in this hemisphere, −1 in winter. */
function seasonal(phase: number, lat: number): number {
  return Math.sin(2 * Math.PI * (phase - 0.08)) * (lat >= 0 ? 1 : -1);
}

/** Eastward jet speed (m/s) at the 250 hPa level. */
function jet(latDeg: number, season: number): number {
  const a = Math.abs(latDeg);
  return (26 * gauss(a, 35, 11) + 8 * gauss(a, 60, 12)) * (1 + 0.35 * Math.max(0, -season));
}

/** Life envelope: grows over the first quarter, fills over the last 40%. */
function envelope(s: WeatherSystem): number {
  const a = s.age / s.life;
  return smoothstep(0, 0.25, a) * (1 - smoothstep(0.6, 1, a));
}

export class WeatherModel implements TickProcess {
  readonly name = 'weather';
  readonly period = HOUR;
  readonly grid: WeatherGrid;
  private readonly stream: Rng;
  private readonly noise: Noise3;
  private nextId = 0;
  /** Systems at `latestHour`, and at the hour before (null before the first tick). */
  private latest: WeatherSystem[];
  private previous: WeatherSystem[] | null = null;
  private latestHour = 0;
  private readonly cache = new Map<number, Float32Array>();
  private readonly viewState: WeatherView;

  constructor(private readonly config: WeatherConfig) {
    this.grid = new WeatherGrid(config.climate.n);
    if (config.climate.temperature.length !== this.grid.count) {
      throw new RangeError('Weather climate does not match the weather grid');
    }
    this.stream = rng(config.seed, 'weather');
    this.noise = new Noise3(this.stream.fork('noise'));
    this.viewState = new WeatherView(this.grid);
    let systems: WeatherSystem[] = [];
    for (let k = -SPIN_UP_HOURS; k < 0; k++) systems = this.evolve(systems, k);
    this.latest = systems;
  }

  /** The latest whole hour whose systems are known (fields exist for it and the hour before). */
  get hour(): number {
    return this.latestHour;
  }

  get systems(): readonly WeatherSystem[] {
    return this.latest;
  }

  /** The tick at game time k · HOUR: advances the systems to hour k + 1. */
  step(_t: GameTime, k: number, _sim: Simulation): void {
    if (k !== this.latestHour) {
      throw new Error(`Weather tick ${k} out of order (expected ${this.latestHour})`);
    }
    this.previous = this.latest;
    this.latest = this.evolve(this.latest, k);
    this.latestHour = k + 1;
    for (const h of this.cache.keys()) if (h < k) this.cache.delete(h);
  }

  /** Hours whose fields exist: the latest, and the one before once the first tick has run. */
  availableHours(): number[] {
    return this.previous ? [this.latestHour - 1, this.latestHour] : [this.latestHour];
  }

  /** Fields at a whole hour: the latest hour or the one before. Cached; do not modify. */
  frameData(hour: number): Float32Array {
    let data = this.cache.get(hour);
    if (data) return data;
    const systems =
      hour === this.latestHour ? this.latest : hour === this.latestHour - 1 ? this.previous : null;
    if (!systems) throw new RangeError(`No weather state for hour ${hour}`);
    data = this.computeFields(systems, hour * HOUR);
    this.cache.set(hour, data);
    return data;
  }

  /** A copy of a frame, safe to transfer. */
  frame(hour: number): WeatherFrame {
    return { hour, data: this.frameData(hour).slice() };
  }

  /** Interpolated weather for the sim's own queries (flight operations, milestone 7). */
  view(): WeatherView {
    const v = this.viewState;
    const [a, b] = v.frames;
    const h = this.latestHour;
    if (this.previous && (a?.hour !== h - 1 || b?.hour !== h)) {
      v.clear();
      v.add({ hour: h - 1, data: this.frameData(h - 1) });
      v.add({ hour: h, data: this.frameData(h) });
    } else if (!this.previous && a?.hour !== h) {
      v.clear();
      v.add({ hour: h, data: this.frameData(h) });
    }
    return v;
  }

  hash(h: StateHasher): void {
    h.number(this.latestHour).number(this.nextId).number(this.latest.length);
    for (const s of this.latest) {
      h.number(s.id).number(s.kind).number(s.x).number(s.y).number(s.z);
      h.number(s.peak).number(s.radius).number(s.age).number(s.life).number(s.drift);
    }
  }

  // ---- Evolution ----

  /** Systems at hour k + 1 from those at hour k. */
  private evolve(systems: readonly WeatherSystem[], k: number): WeatherSystem[] {
    const r = this.stream.fork(`h${k}`);
    const t = k * HOUR;
    const phase = seasonPhase(t, this.config.orbit, this.config.calendar);
    const out: WeatherSystem[] = [];
    const c = this.config.climate;
    const d = new Vec3d();
    for (const s of systems) {
      const lat = Math.asin(clamp(s.y, -1, 1));
      const latDeg = lat / DEG;
      const hemi = lat >= 0 ? 1 : -1;
      d.set(s.x, s.y, s.z);
      const cell = this.grid.nearest(d);
      const u500 =
        c.windEast[cell]! * LEVEL_SURFACE[2]! + jet(latDeg, seasonal(phase, lat)) * LEVEL_JET[2]!;
      let ve: number;
      let vn: number;
      let aging = HOUR;
      if (s.kind === SystemKind.Low) {
        ve = 0.7 * u500;
        vn = hemi * 0.6 + s.drift;
        if (Math.abs(latDeg) > 72) aging *= 2;
      } else if (s.kind === SystemKind.High) {
        ve = 0.35 * u500;
        vn = 0.5 * s.drift;
      } else {
        ve = Math.abs(latDeg) < 22 ? -5.5 : 0.7 * u500;
        vn = hemi * 0.8 + s.drift;
        // Tropical lows weaken fast over land.
        if (c.land[cell]! > 0.5) aging *= 3;
      }
      const age = s.age + aging;
      if (age >= s.life || Math.abs(latDeg) > 82) continue;
      // Move along the surface: east = ŷ × d, north = d × east.
      let ex = s.z;
      let ez = -s.x;
      const el = Math.hypot(ex, ez) || 1;
      ex /= el;
      ez /= el;
      const nx = s.y * ez;
      const ny = s.z * ex - s.x * ez;
      const nz = -s.y * ex;
      const k2 = HOUR / this.config.radius;
      d.set(
        s.x + (ex * ve + nx * vn) * k2,
        s.y + ny * vn * k2,
        s.z + (ez * ve + nz * vn) * k2,
      ).normalize();
      out.push({ ...s, x: d.x, y: d.y, z: d.z, age });
    }
    for (const kind of [SystemKind.Low, SystemKind.High, SystemKind.Tropical]) {
      const spec = KINDS[kind];
      if (r.nextFloat() >= spec.rate) continue;
      for (let attempt = 0; attempt < 4; attempt++) {
        const hemi = r.chance(0.5) ? 1 : -1;
        const latDeg = clamp(spec.lat[0] + spec.lat[1] * gaussian(r), spec.lat[2], spec.lat[3]);
        const lon = r.range(-Math.PI, Math.PI);
        latLonToDirection(hemi * latDeg * DEG, lon, d);
        const cell = this.grid.nearest(d);
        // Lows favor wet regions and the sea; tropical lows need warm sea in the warm season.
        let accept = 0.4 + 0.6 * c.wetness[cell]!;
        if (kind === SystemKind.High) accept = 0.6 + 0.4 * (1 - c.wetness[cell]!);
        if (kind === SystemKind.Tropical) {
          const season = seasonal(phase, hemi);
          accept = (1 - c.land[cell]!) * (0.25 + 0.75 * Math.max(0, season + 0.3));
        }
        const roll = r.nextFloat();
        const peak = r.range(spec.peak[0], spec.peak[1]);
        const radius = r.range(spec.radius[0], spec.radius[1]);
        const life = r.range(spec.life[0], spec.life[1]);
        const drift = r.range(-0.5, 0.5);
        if (roll >= accept) continue;
        out.push({
          id: this.nextId++,
          kind,
          x: d.x,
          y: d.y,
          z: d.z,
          peak,
          radius,
          age: 0,
          life,
          drift,
        });
        break;
      }
    }
    return out;
  }

  // ---- Fields ----

  private computeFields(systems: readonly WeatherSystem[], t: GameTime): Float32Array {
    const g = this.grid;
    const c = this.config.climate;
    const R = this.config.radius;
    const count = g.count;
    const out = newFrameData(g);
    const phase = seasonPhase(t, this.config.orbit, this.config.calendar);
    const L = WIND_LEVELS.length;
    const windE = new Float64Array(L);
    const windN = new Float64Array(L);

    // Per-system constants.
    const sys = systems.map((s) => {
      const amp = s.peak * envelope(s);
      const lat = Math.asin(clamp(s.y, -1, 1));
      const hemi = lat >= 0 ? 1 : -1;
      let ex = s.z;
      let ez = -s.x;
      const el = Math.hypot(ex, ez) || 1;
      ex /= el;
      ez /= el;
      return {
        s,
        amp,
        hemi,
        // Cyclonic (counterclockwise seen from above in the north) around lows.
        spin: (amp < 0 ? 1 : -1) * hemi,
        vmax: WIND_PER_PA * Math.abs(amp),
        reach: Math.cos(Math.min(Math.PI, (3 * s.radius) / R)),
        east: [ex, 0, ez],
        north: [s.y * ez, s.z * ex - s.x * ez, -s.y * ex],
      };
    });
    const evolve = t / NOISE_EVOLVE;
    const freq = R / NOISE_WAVELENGTH;

    for (let p = 0; p < count; p++) {
      const dx = g.directions[p * 3]!;
      const dy = g.directions[p * 3 + 1]!;
      const dz = g.directions[p * 3 + 2]!;
      const Ex = g.east[p * 3]!;
      const Ey = g.east[p * 3 + 1]!;
      const Ez = g.east[p * 3 + 2]!;
      const Nx = g.north[p * 3]!;
      const Ny = g.north[p * 3 + 1]!;
      const Nz = g.north[p * 3 + 2]!;
      const lat = g.lat[p]!;
      const latDeg = lat / DEG;
      const season = seasonal(phase, lat);
      const land = c.land[p]!;

      // Background: climate surface wind and the jet.
      const jetE = jet(latDeg, season);
      for (let k = 0; k < L; k++) {
        windE[k] = c.windEast[p]! * LEVEL_SURFACE[k]! + jetE * LEVEL_JET[k]!;
        windN[k] = c.windNorth[p]! * LEVEL_SURFACE[k]!;
      }
      let pressure =
        101_325 + 900 * gauss(Math.abs(latDeg), 30, 10) - 700 * gauss(Math.abs(latDeg), 62, 12);
      let humidity = 0.47 + 0.2 * c.wetness[p]!;
      const surfaceFriction = 0.9 - 0.3 * land;

      for (const q of sys) {
        const s = q.s;
        const cosang = dx * s.x + dy * s.y + dz * s.z;
        if (cosang < q.reach) continue;
        const ang = Math.acos(clamp(cosang, -1, 1));
        const rr = (ang * R) / s.radius;
        const gaussR = Math.exp(-rr * rr);
        pressure += q.amp * gaussR;
        const strength = Math.abs(q.amp);
        if (q.amp < 0) {
          // Lift: a core of cloud, plus a frontal band spiralling out from the center.
          humidity += 0.55 * (strength / 2000) * Math.exp(-((rr / 0.9) ** 2));
          // Angle of this sample around the center, in the center's east/north frame.
          const tx = dx - s.x * cosang;
          const ty = dy - s.y * cosang;
          const tz = dz - s.z * cosang;
          const theta = Math.atan2(
            tx * q.north[0]! + ty * q.north[1]! + tz * q.north[2]!,
            tx * q.east[0]! + ty * q.east[1]! + tz * q.east[2]!,
          );
          const target = q.hemi * (-Math.PI / 4 - 1.6 * rr);
          let diff = theta - target;
          diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
          const band =
            Math.exp(-((diff / 0.42) ** 2)) *
            Math.exp(-(((rr - 1.1) / 0.8) ** 2)) *
            smoothstep(0.15, 0.4, rr);
          humidity += 0.38 * (strength / 2000) * band;
        } else {
          humidity -= 0.4 * (q.amp / 1500) * gaussR;
        }
        // Circulation: tangential wind peaking at the system's radius.
        if (ang < 1e-6) continue;
        const sinang = Math.sin(ang);
        // Unit vector away from the center, tangent at the sample.
        const rx = (dx * cosang - s.x) / sinang;
        const ry = (dy * cosang - s.y) / sinang;
        const rz = (dz * cosang - s.z) / sinang;
        const re = rx * Ex + ry * Ey + rz * Ez;
        const rn = rx * Nx + ry * Ny + rz * Nz;
        const vt = q.vmax * rr * Math.exp(0.5 * (1 - rr * rr));
        // Counterclockwise tangent seen from above: up × r = (−r_n, r_e).
        const te = -rn * q.spin;
        const tn = re * q.spin;
        // Lows draw air in near the ground, highs push it out.
        const radialSign = q.amp < 0 ? -1 : 1;
        for (let k = 0; k < L; k++) {
          const a = LEVEL_INFLOW[k]!;
          const v = vt * LEVEL_CIRCULATION[k]! * (k === 0 ? surfaceFriction : 1);
          windE[k]! += v * (Math.cos(a) * te + Math.sin(a) * radialSign * re);
          windN[k]! += v * (Math.cos(a) * tn + Math.sin(a) * radialSign * rn);
        }
      }

      // Orographic lift and lee drying from the low-level wind across the terrain.
      const upslope = windE[1]! * c.slopeEast[p]! + windN[1]! * c.slopeNorth[p]!;
      humidity += clamp(0.7 * upslope, -0.15, 0.15);

      // Afternoon convection over warm land.
      const local = localSolarTime(t, g.lon[p]!, this.config.orbit, this.config.calendar) / HOUR;
      const temperatureMean = c.temperature[p]! + c.temperatureRange[p]! * season;
      const afternoon = local > 10 && local < 19 ? Math.sin((Math.PI * (local - 10)) / 9) : 0;
      humidity += 0.3 * land * smoothstep(16, 28, temperatureMean) * afternoon;

      // Mesoscale structure, evolving slowly.
      humidity +=
        0.7 *
        this.noise.fbm(
          dx * freq + 0.37 * evolve,
          dy * freq + 0.11 * evolve,
          dz * freq + 0.59 * evolve,
          3,
        );

      const cover = smoothstep(0.38, 0.88, humidity);
      const spread = clamp(1.02 - humidity, 0, 0.8) / 0.8;
      const cloudBase = 150 + 3000 * spread ** 1.2;
      const precipMmH = 5 * smoothstep(0.82, 1.3, humidity);
      const diurnal = (1 + 5 * land) * (1 - 0.6 * cover);
      const temperature = temperatureMean + diurnal * Math.cos((2 * Math.PI * (local - 15)) / 24);
      const snow = 1 - smoothstep(-1.5, 1.5, temperature);

      // Visibility: humid haze, precipitation, and fog on calm humid nights.
      let visibility = 40_000 - 28_000 * clamp((humidity - 0.35) / 0.6, 0, 1);
      if (precipMmH > 0.05) {
        const rain = 14_000 / (1 + 0.9 * precipMmH);
        const snowVis = 3000 / (1 + precipMmH);
        visibility = Math.min(visibility, rain + (snowVis - rain) * snow);
      }
      const night = clamp(-1.5 * Math.cos((2 * Math.PI * (local - 14)) / 24), 0, 1);
      const calm = 1 - smoothstep(2, 7, Math.hypot(windE[0]!, windN[0]!));
      const fog = smoothstep(0.78, 0.95, humidity) * night * calm * (0.4 + 0.6 * land);
      visibility += (300 - visibility) * fog;

      out[Channel.Cover * count + p] = cover;
      out[Channel.CloudBase * count + p] = cloudBase;
      out[Channel.Visibility * count + p] = visibility;
      out[Channel.Precipitation * count + p] = precipMmH * MM_PER_HOUR;
      out[Channel.Snow * count + p] = snow;
      out[Channel.Temperature * count + p] = temperature;
      out[Channel.Pressure * count + p] = pressure;
      for (let k = 0; k < L; k++) {
        out[(Channel.WindEast0 + 2 * k) * count + p] = windE[k]!;
        out[(Channel.WindEast0 + 2 * k + 1) * count + p] = windN[k]!;
      }
    }
    return out;
  }
}

/** Standard normal deviate (Box–Muller, one value). */
function gaussian(r: Rng): number {
  const u = 1 - r.nextFloat();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r.nextFloat());
}
