/**
 * Combat values per aircraft type for the aggregate resolvers (roadmap R2.2):
 *
 * - `air`: worth in air-to-air combat per aircraft, 0..1.5;
 * - `strike`: weight of ordnance put on a target per aircraft, 0..1;
 * - `survival`: how well the aircraft survives ground fire, 0..1 (1: immune).
 *
 * Rule 18 asks for these to be fitted from full-fidelity engagements; that
 * runner is R2.10. Until it writes a type's bundle `calibration` block, the
 * value is a **prior** computed here from the type's role and its air-to-air
 * radar (range and kind), so better sensors are worth more in the air on
 * either side. The prior is a formula over bundle data, not a table per type,
 * and `calibrationSource` says which a type uses.
 */
import { AIRCRAFT_BUNDLES } from './bundles';
import type { AircraftRole, AircraftType } from './aircraft';
import { aircraftType } from './aircraft';

export interface CombatValues {
  air: number;
  strike: number;
  survival: number;
}

const ROLE: Record<AircraftRole, CombatValues> = {
  'air-superiority': { air: 1, strike: 0.1, survival: 0.35 },
  multirole: { air: 0.8, strike: 0.6, survival: 0.35 },
  'deep-strike': { air: 0.35, strike: 0.8, survival: 0.4 },
  'carrier-attack': { air: 0.2, strike: 0.8, survival: 0.35 },
  'stealth-strike': { air: 0.1, strike: 0.7, survival: 0.9 },
  cas: { air: 0.2, strike: 0.6, survival: 0.55 },
  'attack-helicopter': { air: 0.1, strike: 0.5, survival: 0.3 },
  sead: { air: 0.4, strike: 0.3, survival: 0.45 },
  bomber: { air: 0.05, strike: 1, survival: 0.2 },
  'maritime-bomber': { air: 0.05, strike: 0.9, survival: 0.2 },
  aew: { air: 0.02, strike: 0, survival: 0.1 },
  tanker: { air: 0.02, strike: 0, survival: 0.1 },
  airlift: { air: 0.02, strike: 0, survival: 0.15 },
  'heavy-helicopter': { air: 0.02, strike: 0, survival: 0.15 },
  'utility-helicopter': { air: 0.05, strike: 0.1, survival: 0.2 },
  recon: { air: 0.2, strike: 0, survival: 0.45 },
};

/** Radar range at which the prior's sensor factor is 1 (m). */
export const REFERENCE_RADAR = 100e3;

const cache = new Map<string, CombatValues>();

function bundleOf(t: AircraftType) {
  return Object.values(AIRCRAFT_BUNDLES).find((b) => b.airWar?.id === t.id) ?? null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The prior: the role's values, the air value scaled by the radar. */
export function priorValues(t: AircraftType): CombatValues {
  const base = ROLE[t.role];
  const radar = bundleOf(t)?.avionics?.radar;
  let sensor = 0.6;
  if (radar) {
    const range = Math.min(1.4, Math.max(0.5, radar.range / REFERENCE_RADAR));
    sensor = range * (radar.kind === 'pulse-doppler' ? 1 : 0.85);
  }
  return { air: base.air * sensor, strike: base.strike, survival: base.survival };
}

/** A type's combat values: its fitted calibration, else the prior. */
export function combatValues(typeId: string): CombatValues {
  let v = cache.get(typeId);
  if (v) return v;
  const t = aircraftType(typeId);
  const prior = priorValues(t);
  const cal = bundleOf(t)?.calibration;
  v = cal
    ? {
        air: num(cal.air, prior.air),
        strike: num(cal.strike, prior.strike),
        survival: num(cal.survival, prior.survival),
      }
    : prior;
  cache.set(typeId, v);
  return v;
}

export function calibrationSource(typeId: string): 'fitted' | 'prior' {
  return bundleOf(aircraftType(typeId))?.calibration ? 'fitted' : 'prior';
}
