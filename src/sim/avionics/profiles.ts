/**
 * Avionics profiles (Proposal 0006, decision 199): which display slots an
 * aircraft uses, which formats each slot may show, the systems behind them,
 * its faction skin and its crew. A format exists only where the aircraft
 * carries its system. The slot ids are the UI's five fixed slots; their places
 * on the screen are the UI's (`ui/displays/layout.ts`).
 *
 * The profiles live here, keyed by model spec, until the sensor model (P3)
 * gives the systems figures; then they move into the model specs beside the
 * flight blocks.
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
  | 'hook-camera';

export type SystemId =
  | 'radar-aa'
  | 'radar-ag'
  | 'rwr'
  | 'datalink'
  | 'targeting-pod'
  | 'terrain-following'
  | 'stores-management'
  | 'hook';

import type { RadarSpec } from '../sensors/sensors';

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
}

/** The format each system makes possible. */
export const FORMAT_SYSTEM: Partial<Record<FormatId, SystemId>> = {
  'radar-aa': 'radar-aa',
  'radar-ag': 'radar-ag',
  'targeting-pod': 'targeting-pod',
  threat: 'rwr',
  stores: 'stores-management',
  'hook-camera': 'hook',
};

const KESTREL: AvionicsProfile = {
  // An F-16C's pulse-Doppler set: about 70 km against a fighter, ±60°.
  radar: {
    kind: 'pulse-doppler',
    range: 70_000,
    azimuth: Math.PI / 3,
    elevation: Math.PI / 3,
    notch: 40,
  },
  skin: 'alliance',
  roundScopes: false,
  // The F-16C analogue: the full complement; Free Flight has no weapons or sensor model yet.
  systems: ['radar-aa', 'radar-ag', 'rwr', 'datalink', 'targeting-pod', 'stores-management'],
  slots: {
    leftMfd: ['moving-map', 'engines', 'stores'],
    rightMfd: ['radar-aa', 'radar-ag', 'targeting-pod', 'engines'],
    threat: ['threat'],
    messages: ['messages'],
  },
  rotorGauges: false,
  crew: [],
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

export const AVIONICS_PROFILES: Readonly<Record<string, AvionicsProfile>> = {
  'alliance-fighter': KESTREL,
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
