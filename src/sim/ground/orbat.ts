/**
 * The ground order of battle (roadmap R2.3): divisions, their brigades
 * (Alliance) or regiments (Pact), and their battalions, on every continental
 * front, deployed along its start line. Built from the campaign input and
 * rng(seed, "ground") forks, so it is the same world at any time acceleration.
 *
 * - **Divisions** per side: one per DIVISION_FRONTAGE of front (the Pact's
 *   frontage is narrower: more divisions, design "mass"), at least two.
 * - **A division** has three brigades or regiments of manoeuvre battalions
 *   (Alliance: two armored and two mechanized per brigade; Pact: a tank
 *   regiment of three tank battalions and two motor-rifle regiments of three
 *   mechanized battalions), and divisional artillery, air defense and
 *   logistics battalions.
 * - **Deployment.** Brigades go to front segments by largest remainder over a
 *   weight per segment: the attacker masses on its main axes at the corridors
 *   (ATTACKER_SPREAD + ATTACKER_MASS · pressure²),
 *   the defender spreads (0.6 + 0.4 · pressure); a division's support
 *   battalions follow its first brigade.
 * - **Battalions** carry a kind, a strength (1 at full), their supply and a
 *   seed from which R2.8 promotes vehicles.
 */
import type { Side } from '../../campaign/cast';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import type { FrontSegment } from '../command/front';
import type { CampaignInput } from '../command/campaignInput';

export type BattalionKind = 'tank' | 'mechanized' | 'artillery' | 'air-defense' | 'logistics';

/** Combat value of a battalion at full strength, in battalion equivalents. */
export const BATTALION_VALUE: Record<BattalionKind, number> = {
  tank: 1.2,
  mechanized: 1,
  artillery: 0.9,
  'air-defense': 0.2,
  logistics: 0.05,
};

/** Front length per division (m). */
export const DIVISION_FRONTAGE: Record<Side, number> = { alliance: 60e3, pact: 45e3 };
export const MIN_DIVISIONS = 2;
/** The attacker's deployment weight per segment: a screen everywhere, mass where the pressure is. */
export const ATTACKER_SPREAD = 0.15;
export const ATTACKER_MASS = 1.5;

export interface Battalion {
  id: number;
  side: Side;
  theater: number;
  division: number;
  /** Brigade or regiment (index into GroundOrbat.brigades). */
  brigade: number;
  kind: BattalionKind;
  /** 1 at full strength; losses lower it. */
  strength: number;
  /** Front segment (index within its front's segments). */
  segment: number;
  /** Seed for promotion (R2.8): its vehicles expand from it. */
  seed: number;
}

export interface Brigade {
  id: number;
  side: Side;
  theater: number;
  division: number;
  name: string;
  /** Its main kind, for the map symbol. */
  kind: 'tank' | 'mechanized';
  segment: number;
  battalions: number[];
}

export interface Division {
  id: number;
  side: Side;
  theater: number;
  name: string;
  brigades: number[];
}

export interface GroundOrbat {
  divisions: Division[];
  brigades: Brigade[];
  battalions: Battalion[];
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** Splits `n` items over weights by largest remainder (ties by index). */
export function apportion(weights: readonly number[], n: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? n : 0));
  const exact = weights.map((w) => (n * w) / sum);
  const out = exact.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ r: e - Math.floor(e), i }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    out[i]!++;
  }
  return out;
}

export function buildGroundOrbat(
  input: CampaignInput,
  segmentsOf: (theater: number) => readonly FrontSegment[],
  frontLength: (theater: number) => number,
  seed: WorldSeed,
): GroundOrbat {
  const root = rng(seed, 'ground');
  const o: GroundOrbat = { divisions: [], brigades: [], battalions: [] };
  const number: Record<Side, number> = { alliance: 1, pact: 11 };
  for (const f of input.fronts) {
    const segments = segmentsOf(f.theater);
    for (const side of ['alliance', 'pact'] as const) {
      const attacker = f.attacker === side;
      const divisions = Math.max(
        MIN_DIVISIONS,
        Math.round(frontLength(f.theater) / DIVISION_FRONTAGE[side]),
      );
      const weights = segments.map(
        (s) =>
          (s.to - s.from) *
          (attacker ? ATTACKER_SPREAD + ATTACKER_MASS * s.pressure ** 2 : 0.6 + 0.4 * s.pressure),
      );
      const brigadesPer = apportion(weights, divisions * 3);
      const slots: number[] = [];
      brigadesPer.forEach((n, i) => {
        for (let k = 0; k < n; k++) slots.push(i);
      });
      for (let d = 0; d < divisions; d++) {
        const div: Division = {
          id: o.divisions.length,
          side,
          theater: f.theater,
          name:
            side === 'alliance'
              ? `${ordinal(number.alliance++)} ${d % 3 === 0 ? 'Armored' : 'Mechanized'} Division`
              : `${ordinal(number.pact++)} ${d % 4 === 0 ? 'Tank' : 'Guards Motor Rifle'} Division`,
          brigades: [],
        };
        o.divisions.push(div);
        const add = (kind: Battalion['kind'], brigade: number, segment: number) => {
          const id = o.battalions.length;
          o.battalions.push({
            id,
            side,
            theater: f.theater,
            division: div.id,
            brigade,
            kind,
            strength: 1,
            segment,
            seed: root.fork(`battalion-${id}`).nextUint32(),
          });
          return id;
        };
        for (let b = 0; b < 3; b++) {
          const segment = slots[d * 3 + b] ?? 0;
          const tank = b === 0;
          const brigade: Brigade = {
            id: o.brigades.length,
            side,
            theater: f.theater,
            division: div.id,
            name:
              side === 'alliance'
                ? `${ordinal(o.brigades.length + 1)} ${tank ? 'Armored' : 'Mechanized'} Brigade`
                : `${ordinal(o.brigades.length + 101)} ${tank ? 'Tank' : 'Motor Rifle'} Regiment`,
            kind: tank ? 'tank' : 'mechanized',
            segment,
            battalions: [],
          };
          o.brigades.push(brigade);
          div.brigades.push(brigade.id);
          const kinds: Battalion['kind'][] =
            side === 'alliance'
              ? tank
                ? ['tank', 'tank', 'mechanized', 'mechanized']
                : ['mechanized', 'mechanized', 'tank', 'mechanized']
              : tank
                ? ['tank', 'tank', 'tank']
                : ['mechanized', 'mechanized', 'mechanized'];
          for (const k of kinds) brigade.battalions.push(add(k, brigade.id, segment));
        }
        const first = o.brigades[div.brigades[0]!]!;
        for (const k of ['artillery', 'artillery', 'air-defense', 'logistics'] as const) {
          first.battalions.push(add(k, first.id, first.segment));
        }
      }
    }
  }
  return o;
}
