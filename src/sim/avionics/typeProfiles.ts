/**
 * Avionics profiles for every type of the air war's table (decision 224), after the
 * proposal's complements (Proposal 0006, "Avionics profiles"): air superiority
 * fighters carry the air-to-air radar; the multirole fighter the full complement;
 * the early fighter its radar in a round scope and no moving map; strike aircraft
 * with a crew the air-to-ground radar, the terrain-following scope and a pod, the
 * crewmate owning the right display; attack aircraft no radar; attack helicopters a
 * gunner sight; transports a moving map and a hook camera or the airdrop format.
 *
 * Radar figures are the detection range against a 5 m² fighter, the scan limits and
 * the Doppler notch, from approximate public figures for each type's reference.
 * Pact fighters lean on ground control's datalink, the Alliance on AWACS.
 */
import type { RadarSpec } from '../sensors/sensors';
import type { AvionicsProfile, FormatId, SystemId } from './profiles';

const DEG = Math.PI / 180;

/** A pulse-Doppler set of `km` against a fighter, ±`az`°, with a notch of `notch` m/s. */
const pd = (km: number, az = 60, notch = 40): RadarSpec => ({
  kind: 'pulse-doppler',
  range: km * 1000,
  azimuth: az * DEG,
  elevation: az * DEG,
  notch,
});
/** A pulse set without look-down. */
const pulse = (km: number, az = 60): RadarSpec => ({
  kind: 'pulse',
  range: km * 1000,
  azimuth: az * DEG,
  elevation: az * DEG,
  notch: 0,
});

const SMALL = { threat: ['threat'] as FormatId[], messages: ['messages'] as FormatId[] };

function profile(
  skin: 'alliance' | 'pact',
  systems: SystemId[],
  left: FormatId[] | null,
  right: FormatId[] | null,
  more: Partial<AvionicsProfile> = {},
): AvionicsProfile {
  return {
    skin,
    roundScopes: false,
    systems,
    slots: {
      ...(left ? { leftMfd: left } : {}),
      ...(right ? { rightMfd: right } : {}),
      ...(systems.includes('rwr') ? { threat: SMALL.threat } : {}),
      messages: SMALL.messages,
    },
    rotorGauges: false,
    crew: [],
    ...more,
  };
}

const A = 'alliance' as const;
const P = 'pact' as const;
const fighter = (
  skin: 'alliance' | 'pact',
  radar: RadarSpec,
  more: Partial<AvionicsProfile> = {},
) =>
  profile(
    skin,
    ['radar-aa', 'rwr', 'datalink', 'stores-management'],
    ['moving-map', 'stores', 'engines'],
    ['radar-aa', 'engines'],
    { radar, ...more },
  );
const strike = (skin: 'alliance' | 'pact', systems: SystemId[], crew: string[]) =>
  profile(
    skin,
    ['radar-ag', 'terrain-following', 'rwr', 'stores-management', ...systems],
    ['moving-map', 'stores', 'engines'],
    [
      'radar-ag',
      ...(systems.includes('targeting-pod') ? (['targeting-pod'] as FormatId[]) : []),
      'engines',
    ],
    { crew },
  );
const heavy = (skin: 'alliance' | 'pact', systems: SystemId[], crew: string[], right: FormatId[]) =>
  profile(skin, ['rwr', ...systems], ['moving-map', 'engines'], right, { crew });

/** Profiles by aircraft type id (sim/air/aircraft.ts). */
export const TYPE_PROFILES: Readonly<Record<string, AvionicsProfile>> = {
  // Alliance.
  f25: fighter(A, pd(100)), // F-15C
  f21: profile(
    A,
    ['radar-aa', 'radar-ag', 'rwr', 'datalink', 'targeting-pod', 'stores-management'],
    ['moving-map', 'engines', 'stores'],
    ['radar-aa', 'radar-ag', 'targeting-pod', 'engines'],
    { radar: pd(70) }, // F-16C: the full complement
  ),
  f28: fighter(A, pd(150, 65), { crew: ['rio'] }), // F-14A
  f30: profile(
    A,
    ['radar-aa', 'radar-ag', 'rwr', 'datalink', 'targeting-pod', 'stores-management'],
    ['moving-map', 'stores', 'engines'],
    ['radar-aa', 'radar-ag', 'targeting-pod', 'engines'],
    { radar: pd(80) }, // F/A-18C
  ),
  f124: strike(A, ['targeting-pod'], ['wso']), // F-111F with Pave Tack
  a14: strike(A, ['targeting-pod'], ['bn']), // A-6E with TRAM
  f130: profile(
    A,
    ['rwr', 'targeting-pod', 'stores-management'],
    ['moving-map', 'stores', 'engines'],
    ['targeting-pod', 'engines'],
  ), // F-117A: no radar
  a15: profile(A, ['rwr', 'stores-management'], ['moving-map', 'stores', 'engines'], ['engines']), // A-10A
  f34g: profile(
    A,
    ['radar-aa', 'rwr', 'stores-management'],
    ['moving-map', 'stores', 'engines'],
    ['radar-aa', 'engines'],
    { radar: pulse(55), crew: ['ewo'] }, // F-4G: the threat display is its weapon
  ),
  rf34: profile(
    A,
    ['radar-ag', 'terrain-following', 'rwr'],
    ['moving-map', 'engines'],
    ['radar-ag'],
    {
      crew: ['wso'],
    },
  ), // RF-4C
  b40: heavy(
    A,
    ['radar-ag', 'terrain-following', 'stores-management'],
    ['nav', 'radar-nav', 'ewo', 'gunner'],
    ['radar-ag', 'stores'],
  ), // B-52G
  e5: heavy(A, ['datalink'], ['mission-crew'], ['engines']), // E-3A
  kc40: heavy(A, [], ['boom'], ['engines']), // KC-135A
  c150: heavy(A, ['airdrop'], ['nav', 'loadmaster'], ['airdrop', 'engines']), // C-130H
  ah70: profile(
    A,
    ['rwr', 'sight', 'stores-management'],
    ['moving-map', 'stores', 'engines'],
    ['gunner-sight'],
    {
      rotorGauges: true,
      crew: ['cpg'],
    },
  ), // AH-64A
  ch60: profile(A, ['rwr', 'hook'], ['moving-map', 'engines'], ['hook-camera', 'engines'], {
    rotorGauges: true,
    crew: ['crew-chief'],
  }), // CH-47D
  // Pact.
  vo33: fighter(P, pd(100, 60, 50), { hudRadar: true }), // Su-27: its radar in the HUD too
  vo31: fighter(P, pd(70, 60, 60)), // MiG-29
  vo31k: fighter(P, pd(70, 60, 60)), // MiG-29K
  ar23: profile(P, ['radar-aa', 'rwr', 'datalink', 'stores-management'], null, ['radar-aa'], {
    radar: pd(55, 50, 90), // MiG-23ML: weak look-down
    roundScopes: true,
  }),
  vo37: strike(P, ['targeting-pod'], ['wso']), // Su-24M with Kaira
  vo37p: strike(P, ['targeting-pod'], ['wso']), // Su-24M, anti-radiation
  vo35: profile(P, ['rwr', 'stores-management'], ['moving-map', 'stores', 'engines'], ['engines']), // Su-25
  ra90: heavy(
    P,
    ['radar-ag', 'stores-management'],
    ['nav', 'radar-nav', 'gunner'],
    ['radar-ag', 'stores'],
  ), // Tu-95MS
  ra84: heavy(
    P,
    ['radar-ag', 'stores-management'],
    ['nav', 'wso', 'gunner'],
    ['radar-ag', 'stores'],
  ), // Tu-22M3
  ra60: heavy(P, ['datalink'], ['mission-crew'], ['engines']), // A-50
  ra78: heavy(P, [], ['nav'], ['engines']), // Il-78
  ra44: heavy(P, ['airdrop'], ['nav', 'loadmaster'], ['airdrop', 'engines']), // An-12
  ar45r: profile(P, ['radar-ag', 'rwr'], ['moving-map', 'engines'], ['radar-ag']), // MiG-25RB
  ve28: profile(
    P,
    ['rwr', 'sight', 'stores-management'],
    ['moving-map', 'stores', 'engines'],
    ['gunner-sight'],
    {
      rotorGauges: true,
      crew: ['operator'],
    },
  ), // Mi-24V
  ve36: profile(P, ['rwr', 'hook'], ['moving-map', 'engines'], ['hook-camera', 'engines'], {
    rotorGauges: true,
    crew: ['crew-chief'],
  }), // Mi-26
};
