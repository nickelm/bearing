/**
 * Avionics profiles (Proposal 0006, decision 199): which display slots an
 * aircraft uses, which formats each slot may show, the systems behind them,
 * its faction skin and its crew. A format exists only where the aircraft
 * carries its system. The slot ids are the UI's five fixed slots; their places
 * on the screen are the UI's (`ui/displays/layout.ts`).
 *
 * Profiles are data: the `avionics` block of each aircraft bundle
 * (src/data/models/aircraft/, rule 17, decisions 224 and 232; R1.7).
 * `TYPE_PROFILES` keys them by air-war type id, `AVIONICS_PROFILES` by the
 * model spec of each bundle with its own geometry (the aircraft Free Flight
 * flies among them); both hold the same objects.
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
import { AIRCRAFT_BUNDLES } from '../air/bundles';

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

/** Profiles by air-war type id (sim/air/aircraft.ts), from the bundles. */
export const TYPE_PROFILES: Readonly<Record<string, AvionicsProfile>> = Object.fromEntries(
  Object.values(AIRCRAFT_BUNDLES)
    .filter((b) => b.airWar && b.avionics)
    .map((b) => [b.airWar!.id, b.avionics!]),
);

/** Profiles by model spec, for each bundle with its own geometry: the aircraft that can be drawn and flown. */
export const AVIONICS_PROFILES: Readonly<Record<string, AvionicsProfile>> = Object.fromEntries(
  Object.values(AIRCRAFT_BUNDLES)
    .filter((b) => b.geometry === b.id && b.avionics)
    .map((b) => [b.id, b.avionics!]),
);

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
