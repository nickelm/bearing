/**
 * Survivors (roadmap R2.9): aircrew down after an ejection, from an aggregate loss
 * (AirOps.lose, EJECT_CHANCE) or from full fidelity (X twice, decision 301), until
 * they are rescued, captured or die.
 *
 * - **Record.** Where the survivor came down (the loss's point plus a parachute's
 *   drift, DRIFT_MIN–DRIFT_MAX from it in a seeded direction), on land or in the water,
 *   an injury (none, light, serious; INJURY_CHANCES), and a survival timer: the game
 *   time by which the survivor dies unrescued (SURVIVAL by injury and surface: days
 *   on land unhurt, hours in the water hurt). Its state is `down`, then `aboard` a
 *   rescue flight, `rescued` once home (the pilot is back on the squadron's roster),
 *   or `captured` or `died`.
 * - **Capture risk** grows near the enemy's forces: a hazard per hour of
 *   CAPTURE_NEAR · exp(−d / CAPTURE_SCALE) from the nearest enemy battalion's anchor
 *   (the ground war's picture), plus CAPTURE_HOSTILE in the enemy's territory (the
 *   nearest held place or airbase is the enemy's), times INJURY_CAPTURE (a hurt
 *   survivor cannot evade). None in the water. `SurvivorWatch` checks every survivor
 *   down each CHECK_PERIOD: the chance of capture over the period is 1 − exp(−λ·Δt),
 *   and past its timer it dies.
 * - **Draws** come from rng(seed, "survivors") forked by survivor (its injury and
 *   drift) and by survivor and tick (its checks), so a survivor's fate is the same at
 *   any time acceleration and does not move any other stream (rule 5).
 *
 * The CSAR plug-in (sim/command/missions/csar.ts) tasks rescues; AirOps keeps the
 * records (its saved state) and returns rescued pilots to their squadrons. The
 * constants are priors until R2.10's calibration and R3.8's search parties.
 */
import type { Side } from '../../campaign/cast';
import { arcDistance, destination } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import { HOUR, MINUTE } from '../../core/units';
import type { GameTime, Meters } from '../../core/units';
import type { CampaignInput } from '../command/campaignInput';
import type { Simulation, TickProcess } from '../simulation';
import type { AirOps } from './airOps';

export type Injury = 'none' | 'light' | 'serious';
export type SurvivorState = 'down' | 'aboard' | 'rescued' | 'captured' | 'died';

/** Aircrew down after an ejection (R2.2, R2.9). */
export interface Survivor {
  id: number;
  side: Side;
  pilot: string;
  squadron: number;
  /** The mission the survivor was lost from, and the theater it served (−1: none). */
  mission: number;
  theater: number;
  /** Where the survivor is on the ground (or in the water). */
  point: Dir;
  /** When the survivor came down. */
  time: GameTime;
  injury: Injury;
  /** In the water (a dinghy), not on land. */
  water: boolean;
  /** Game time by which the survivor dies unrescued. */
  until: GameTime;
  state: SurvivorState;
  /** The rescue flight carrying the survivor home (`aboard`), or that brought it home. */
  carrier?: number;
  /** When its state last changed. */
  changed: GameTime;
  /** Rescue flights launched for it so far: a new rescue after a failed one is a new need. */
  attempts: number;
}

/** A survivor's chances of each injury: none, light, serious. */
export const INJURY_CHANCES: readonly [number, number, number] = [0.55, 0.33, 0.12];
/** Hours a survivor lasts unrescued, by injury, on land and in the water. */
export const SURVIVAL: Record<'land' | 'water', Record<Injury, number>> = {
  land: { none: 72 * HOUR, light: 36 * HOUR, serious: 10 * HOUR },
  water: { none: 18 * HOUR, light: 10 * HOUR, serious: 4 * HOUR },
};
/** A parachute comes down this far from where the aircraft was lost (m). */
export const DRIFT_MIN: Meters = 150;
export const DRIFT_MAX: Meters = 1500;
/** The capture hazard (per hour) at an enemy battalion's anchor, and its fall with distance (m). */
export const CAPTURE_NEAR = 0.6 / HOUR;
export const CAPTURE_SCALE: Meters = 6e3;
/** The capture hazard (per hour) anywhere in the enemy's territory. */
export const CAPTURE_HOSTILE = 0.03 / HOUR;
/** The hazard's factor by injury: a hurt survivor cannot evade. */
export const INJURY_CAPTURE: Record<Injury, number> = { none: 1, light: 1.4, serious: 2.5 };
/** How often the survivors are checked (s). */
export const CHECK_PERIOD = 10 * MINUTE;
/** Places and airbases farther than this tell nothing about whose ground a point is (m). */
export const TERRITORY_RANGE: Meters = 250e3;
/** Survivors this close together are one rescue (m). */
export const GROUP_RANGE: Meters = 10e3;

/** What the watch reads of the ground war: each battalion's side and anchor. */
export interface BattalionSource {
  battalions(): Iterable<{ side: Side; point: Readonly<Dir> }>;
}

/** The survivor stream's root for a world seed. */
export function survivorStream(seed: WorldSeed): Rng {
  return rng(seed, 'survivors');
}

/** A new survivor's record: its drift, injury, surface and timer, from its own fork. */
export function newSurvivor(
  root: Rng,
  base: Pick<Survivor, 'id' | 'side' | 'pilot' | 'squadron' | 'mission' | 'theater' | 'time'>,
  lostAt: Readonly<Dir>,
  radius: Meters,
  water: (d: Readonly<Dir>) => boolean,
): Survivor {
  const r = root.fork(`s${base.id}`);
  const drift = DRIFT_MIN + r.nextFloat() * (DRIFT_MAX - DRIFT_MIN);
  const point = destination(lostAt, r.nextFloat() * 2 * Math.PI, drift, radius);
  const u = r.nextFloat();
  const injury: Injury =
    u < INJURY_CHANCES[0]
      ? 'none'
      : u < INJURY_CHANCES[0] + INJURY_CHANCES[1]
        ? 'light'
        : 'serious';
  const wet = water(point);
  return {
    ...base,
    point,
    injury,
    water: wet,
    until: base.time + SURVIVAL[wet ? 'water' : 'land'][injury],
    state: 'down',
    changed: base.time,
    attempts: 0,
  };
}

/**
 * Whose ground a point is: the side holding the nearest named place or airbase within
 * TERRITORY_RANGE, or null (open sea, far from anything held).
 */
export function territoryAt(input: CampaignInput, p: Readonly<Dir>): Side | null {
  const R = input.radius;
  let best = TERRITORY_RANGE;
  let side: Side | null = null;
  for (const x of input.places ?? []) {
    if (!x.side) continue;
    const d = arcDistance(x.point, p, R);
    if (d < best) {
      best = d;
      side = x.side;
    }
  }
  for (const a of input.airbases) {
    const d = arcDistance(a.point, p, R);
    if (d < best) {
      best = d;
      side = a.side;
    }
  }
  return side;
}

/**
 * The capture hazard (per second) of a survivor of `side` at `p`: from the nearest
 * enemy battalion and the enemy's territory, by injury; none in the water.
 */
export function captureHazard(
  input: CampaignInput,
  ground: BattalionSource | null,
  side: Side,
  p: Readonly<Dir>,
  injury: Injury,
  water: boolean,
): number {
  if (water) return 0;
  const R = input.radius;
  let near = Infinity;
  if (ground) {
    for (const b of ground.battalions()) {
      if (b.side === side) continue;
      const d = arcDistance(b.point, p, R);
      if (d < near) near = d;
    }
  }
  const hostile = territoryAt(input, p);
  const lambda =
    (Number.isFinite(near) ? CAPTURE_NEAR * Math.exp(-near / CAPTURE_SCALE) : 0) +
    (hostile !== null && hostile !== side ? CAPTURE_HOSTILE : 0);
  return lambda * INJURY_CAPTURE[injury];
}

/** The survivors of `side` down within GROUP_RANGE of `of` (itself included), by id. */
export function groupOf(
  survivors: readonly Survivor[],
  of: Readonly<Survivor>,
  radius: Meters,
): Survivor[] {
  return survivors
    .filter(
      (s) =>
        s.state === 'down' &&
        s.side === of.side &&
        arcDistance(s.point, of.point, radius) <= GROUP_RANGE,
    )
    .sort((a, b) => a.id - b.id);
}

/** Survivors by state and side, for the war tool and tests. */
export function survivorCounts(
  survivors: readonly Survivor[],
): Record<Side, Record<SurvivorState, number>> {
  const zero = (): Record<SurvivorState, number> => ({
    down: 0,
    aboard: 0,
    rescued: 0,
    captured: 0,
    died: 0,
  });
  const out: Record<Side, Record<SurvivorState, number>> = { alliance: zero(), pact: zero() };
  for (const s of survivors) out[s.side][s.state]++;
  return out;
}

/**
 * Checks the survivors down every CHECK_PERIOD: past its timer a survivor dies, and
 * each may be captured with the chance its hazard gives over the period. A rescue
 * flight whose survivors are all gone before it lands turns home.
 */
export class SurvivorWatch implements TickProcess {
  readonly name = 'survivors';
  readonly period = CHECK_PERIOD;
  private readonly root: Rng;

  constructor(
    private readonly air: AirOps,
    private readonly input: CampaignInput,
    seed: WorldSeed,
    private readonly ground: BattalionSource | null,
  ) {
    this.root = survivorStream(seed).fork('checks');
  }

  /** The capture hazard (per second) of survivor s where it is now. */
  hazard(s: Readonly<Survivor>): number {
    return captureHazard(this.input, this.ground, s.side, s.point, s.injury, s.water);
  }

  /** The capture hazard (per second) at a point for a survivor of `side` unhurt on land. */
  hazardAt(side: Side, p: Readonly<Dir>): number {
    return captureHazard(this.input, this.ground, side, p, 'none', false);
  }

  step(t: GameTime, k: number, sim: Simulation): void {
    for (const s of this.air.survivors) {
      if (s.state !== 'down' || s.time >= t) continue;
      if (t >= s.until) {
        this.air.survivorLost(s, 'died', sim);
        continue;
      }
      const lambda = this.hazard(s);
      if (!(lambda > 0)) continue;
      const dt = Math.min(CHECK_PERIOD, t - s.time);
      const r = this.root.fork(`s${s.id}`).fork(`k${k}`);
      if (r.nextFloat() < 1 - Math.exp(-lambda * dt)) this.air.survivorLost(s, 'captured', sim);
    }
  }
}
