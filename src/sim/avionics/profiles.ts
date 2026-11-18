/**
 * Avionics profiles (Proposal 0006, decision 199): which display slots an
 * aircraft uses, which formats each slot may show, the systems behind them,
 * its faction skin and its crew. A format exists only where the aircraft
 * carries its system. The slot ids are the UI's five fixed slots; their places
 * on the screen are the UI's (`ui/displays/layout.ts`).
 *
 * Every type of the air war's table has a profile, keyed by its type id
 * (`typeProfiles.ts`, decision 224); `AVIONICS_PROFILES` keys them by model
 * spec for the aircraft Free Flight flies, whose helicopters are not in the
 * table yet. Profiles stay in code rather than in the model specs: most types
 * have no model yet, and the specs describe how an aircraft looks.
 */
export type SlotId = 'leftMfd' | 'rightMfd' | 'threat' | 'messages' | 'strip';

export type FormatId =
  | 'moving-map'
  | 'stores'
  | 'engines'
  | 'radar-aa'
  | 'radar-ag'
  | 'targeting-pod'
  | 'threat'
  | 'comms'
  | 'messages'
  | 'mission'
  | 'crew'
  | 'hook-camera'
  | 'gunner-sight'
  | 'airdrop';

export type SystemId =
  | 'radar-aa'
  | 'radar-ag'
  | 'rwr'
  | 'datalink'
  | 'targeting-pod'
  | 'terrain-following'
  | 'stores-management'
  | 'hook'
  | 'sight'
  | 'airdrop';

import type { RadarSpec } from '../sensors/sensors';
import { TYPE_PROFILES } from './typeProfiles';

export interface AvionicsProfile {
  /** The air-to-air radar, where the aircraft carries one (decision 218). */
  radar?: RadarSpec;
  skin: 'alliance' | 'pact';
  /** Scope formats in a round, analog-styled bezel (older types). */
  roundScopes: boolean;
  systems: readonly SystemId[];
  /** The formats each used slot may show, first the default; a slot left out stays empty. */
  slots: Partial<Record<Exclude<SlotId, 'strip'>, readonly FormatId[]>>;
  /** Torque and rotor gauges at the strip's end (helicopters). */
  rotorGauges: boolean;
  crew: readonly string[];
  /** The radar's picture in the HUD as well (the Su-27 analogue alone; decision 224). */
  hudRadar?: boolean;
}

/** The format each system makes possible. */
export const FORMAT_SYSTEM: Partial<Record<FormatId, SystemId>> = {
  'radar-aa': 'radar-aa',
  'radar-ag': 'radar-ag',
  'targeting-pod': 'targeting-pod',
  threat: 'rwr',
  stores: 'stores-management',
  'hook-camera': 'hook',
  'gunner-sight': 'sight',
  airdrop: 'airdrop',
};

const SCOUT: AvionicsProfile = {
  skin: 'alliance',
  roundScopes: false,
  systems: ['rwr'],
  slots: {
    leftMfd: ['moving-map', 'engines'],
    threat: ['threat'],
    messages: ['messages'],
  },
  rotorGauges: true,
  crew: [],
};

const UTILITY: AvionicsProfile = {
  skin: 'alliance',
  roundScopes: false,
  systems: ['rwr', 'hook'],
  slots: {
    leftMfd: ['moving-map', 'engines'],
    rightMfd: ['hook-camera', 'engines'],
    threat: ['threat'],
    messages: ['messages'],
  },
  rotorGauges: true,
  crew: ['crew-chief'],
};

/** The profiles of the aircraft Free Flight flies, by model spec. */
export const AVIONICS_PROFILES: Readonly<Record<string, AvionicsProfile>> = {
  'alliance-fighter': TYPE_PROFILES.f21!,
  'alliance-scout-helo': SCOUT,
  'alliance-utility-helo': UTILITY,
};

/** Checks a profile: every listed format's system is carried, and no slot is listed empty. */
export function profileProblems(p: AvionicsProfile): string[] {
  const out: string[] = [];
  for (const [slot, formats] of Object.entries(p.slots)) {
    if (!formats || formats.length === 0) out.push(`${slot}: listed without formats`);
    for (const f of formats ?? []) {
      const sys = FORMAT_SYSTEM[f];
      if (sys && !p.systems.includes(sys)) out.push(`${slot}: ${f} needs ${sys}`);
    }
  }
  return out;
}
