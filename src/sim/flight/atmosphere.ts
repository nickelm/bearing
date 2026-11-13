/**
 * The 1976 U.S. Standard Atmosphere up to 32 km, by geopotential altitude
 * (Free Flight, decision 134): temperature, pressure, density and the speed of
 * sound. Bearing's atmosphere stays Earth-real while its landforms scale (design,
 * Scale and Range), so aircraft perform as they would on Earth.
 *
 * Above 32 km the second stratospheric layer is extended; aircraft never get
 * there, and the values stay finite.
 */
import type { Meters } from '../../core/units';

/** Sea-level standard values. */
export const SEA_LEVEL_TEMPERATURE = 288.15; // K
export const SEA_LEVEL_PRESSURE = 101_325; // Pa
export const SEA_LEVEL_DENSITY = 1.225; // kg/m³
/** Specific gas constant of dry air (J/(kg·K)) and its ratio of specific heats. */
export const GAS_CONSTANT = 287.052_87;
export const GAMMA = 1.4;
/** Standard gravity (m/s²), which defines geopotential altitude. */
export const G0 = 9.806_65;

/** Layer bases (m), base temperatures (K), lapse rates (K/m) and base pressures (Pa). */
const LAYERS = [
  { h: 0, t: 288.15, lapse: -0.0065, p: 101_325 },
  { h: 11_000, t: 216.65, lapse: 0, p: 22_632.06 },
  { h: 20_000, t: 216.65, lapse: 0.001, p: 5_474.889 },
] as const;

export interface AirState {
  /** Temperature (K). */
  temperature: number;
  /** Static pressure (Pa). */
  pressure: number;
  /** Density (kg/m³). */
  density: number;
  /** Speed of sound (m/s). */
  speedOfSound: number;
}

/** The standard atmosphere at altitude `h` above sea level (m); below sea level extrapolates. */
export function standardAtmosphere(h: Meters, out?: AirState): AirState {
  let layer: (typeof LAYERS)[number] = LAYERS[0];
  for (const l of LAYERS) if (h >= l.h) layer = l;
  const dh = h - layer.h;
  let t: number;
  let p: number;
  if (layer.lapse === 0) {
    t = layer.t;
    p = layer.p * Math.exp((-G0 * dh) / (GAS_CONSTANT * t));
  } else {
    t = layer.t + layer.lapse * dh;
    p = layer.p * Math.pow(t / layer.t, -G0 / (GAS_CONSTANT * layer.lapse));
  }
  const o = out ?? { temperature: 0, pressure: 0, density: 0, speedOfSound: 0 };
  o.temperature = t;
  o.pressure = p;
  o.density = p / (GAS_CONSTANT * t);
  o.speedOfSound = Math.sqrt(GAMMA * GAS_CONSTANT * t);
  return o;
}

/** Sea-level speed of sound (m/s). */
export const SEA_LEVEL_SPEED_OF_SOUND = Math.sqrt(GAMMA * GAS_CONSTANT * SEA_LEVEL_TEMPERATURE);

/**
 * Calibrated airspeed (m/s) from true airspeed `tas` (m/s) in air `air`:
 * the speed at sea level that gives the same impact pressure (subsonic
 * compressible formula; above Mach 1 the Rayleigh pitot formula).
 */
export function calibratedAirspeed(tas: number, air: Readonly<AirState>): number {
  const mach = tas / air.speedOfSound;
  let qc: number;
  if (mach <= 1) {
    qc = air.pressure * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  } else {
    const m2 = mach * mach;
    qc = air.pressure * ((166.921_58 * Math.pow(mach, 7)) / Math.pow(7 * m2 - 1, 2.5) - 1);
  }
  const p0 = SEA_LEVEL_PRESSURE;
  const a0 = SEA_LEVEL_SPEED_OF_SOUND;
  const sub = a0 * Math.sqrt(5 * (Math.pow(qc / p0 + 1, 2 / 7) - 1));
  if (sub <= a0) return sub;
  // Supersonic CAS: solve the Rayleigh formula at sea level by fixed-point iteration.
  let v = sub;
  for (let i = 0; i < 20; i++) {
    const m = v / a0;
    v = a0 * 0.881_284_9 * Math.sqrt((qc / p0 + 1) * Math.pow(1 - 1 / (7 * m * m), 2.5));
  }
  return v;
}
