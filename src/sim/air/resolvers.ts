/**
 * The demo types' aggregate resolvers (roadmap R2.2): each plug-in's outcome
 * of a mission that reached the end of its time on target or station, or
 * turned home early. Losses and kills come from the engagements resolution.ts
 * ran on the way; these resolvers add the effect on the target.
 *
 * - **Strike:** each surviving aircraft hits with a chance of its strike value
 *   times the target kind's P_HIT, and each hit does DAMAGE_PER_HIT of the
 *   kind's damage; hits combine as independent chances. A flight that turned
 *   home before its target does nothing.
 * - **CAS:** the surviving aircraft's strike value times the share of the
 *   planned time on call they held: an amount of attack for the ground war.
 * - **Airlift:** the share of the flight's aircraft that landed and unloaded.
 * - **CAP:** the time it held its station.
 * - **CSAR** (R2.9): a rescue that was on the ground at the survivor for PICKUP_TIME
 *   picks up its survivors still down (its own and any down near them), unless the
 *   enemy drives it off: a chance of 1 − exp(−λ · PICKUP_EXPOSURE), λ the capture
 *   hazard there, at most PICKUP_RISK, halved with an escort over the pickup.
 *
 * The constants are priors until R2.10's calibration fits them (rule 18).
 */
import type { TargetKind as SiteKind } from '../../worldgen/strategic/infrastructure';
import { combatValues } from './calibration';
import { MINUTE, HOUR } from '../../core/units';
import type { Mission } from './mission';
import type { AggregateResolver, MissionOutcome, ResolveContext } from './outcome';

/** Chance per aircraft (times its strike value) of hitting a target, by kind. */
export const P_HIT: Record<SiteKind | 'road' | 'airbase', number> = {
  bridge: 0.5,
  'rail-yard': 0.6,
  'supply-depot': 0.7,
  'fuel-depot': 0.7,
  factory: 0.6,
  'power-plant': 0.6,
  refinery: 0.6,
  road: 0.6,
  airbase: 0.6,
};

/** Damage one hit does, by kind (hits combine as independent chances). */
export const DAMAGE_PER_HIT: Record<SiteKind | 'road' | 'airbase', number> = {
  bridge: 0.35,
  'rail-yard': 0.2,
  'supply-depot': 0.2,
  'fuel-depot': 0.2,
  factory: 0.12,
  'power-plant': 0.12,
  refinery: 0.12,
  road: 0.3,
  airbase: 0.1,
};

/** Aircraft that took off on the mission. */
export function launched(m: Mission): number {
  return m.aircraft + (m.losses ?? 0);
}

/** Planned time on station or over the target (s). */
export function plannedOnStation(m: Mission): number {
  const i = m.timeline.findIndex((e) => e.phase === 'on-target');
  if (i < 0 || i + 1 >= m.timeline.length) return 0;
  return m.timeline[i + 1]!.time - m.timeline[i]!.time;
}

function base(m: Mission, ctx: ResolveContext): MissionOutcome {
  return {
    completed: !m.aborted,
    aborted: !!m.aborted,
    onStation: ctx.onStation,
    effect: 0,
    delivered: 0,
    losses: m.losses ?? 0,
    kills: m.kills ?? 0,
  };
}

/** The kind of a strike's target, for P_HIT and DAMAGE_PER_HIT. */
export function strikeKind(m: Mission, ctx: ResolveContext): SiteKind | 'road' | 'airbase' | null {
  const t = m.target;
  if (t.kind === 'road') return 'road';
  if (t.kind === 'airbase') return 'airbase';
  if (t.kind === 'site') return ctx.input.targets[t.id]?.kind ?? null;
  return null;
}

export const strikeResolver: AggregateResolver = {
  resolve(m, ctx) {
    const o = base(m, ctx);
    const kind = strikeKind(m, ctx);
    if (!kind || m.aborted || ctx.onStation <= 0) return o;
    const p = combatValues(m.aircraftType).strike * P_HIT[kind];
    let left = 1;
    for (let i = 0; i < m.aircraft; i++) {
      if (ctx.rng.nextFloat() < p) left *= 1 - DAMAGE_PER_HIT[kind];
    }
    o.effect = 1 - left;
    return o;
  },
};

export const casResolver: AggregateResolver = {
  resolve(m, ctx) {
    const o = base(m, ctx);
    const planned = plannedOnStation(m);
    if (planned <= 0) return o;
    const share = Math.min(1, ctx.onStation / planned);
    o.effect = m.aircraft * combatValues(m.aircraftType).strike * share;
    return o;
  },
};

export const airliftResolver: AggregateResolver = {
  resolve(m, ctx) {
    const o = base(m, ctx);
    // Delivered once the flight has been on the ground at its destination.
    if (ctx.onStation > 0) o.delivered = m.aircraft / Math.max(1, launched(m));
    return o;
  },
};

export const capResolver: AggregateResolver = {
  resolve(m, ctx) {
    return base(m, ctx);
  },
};

/** Time on the ground at the survivor a pickup takes (s). */
export const PICKUP_TIME = 1 * MINUTE;
/** The exposure of a pickup to the enemy's fire, as time of the capture hazard (s). */
export const PICKUP_EXPOSURE = HOUR;
/** The most chance the enemy drives a rescue off, and the factor with an escort. */
export const PICKUP_RISK = 0.8;
export const PICKUP_ESCORTED = 0.5;

export const csarResolver: AggregateResolver = {
  resolve(m, ctx) {
    const o = base(m, ctx);
    if (m.aborted || ctx.onStation < PICKUP_TIME || m.aircraft <= 0) return o;
    const ids = new Set(m.survivors ?? []);
    if (m.target.kind === 'survivor')
      for (const s of ctx.air.rescueGroup(m.target.id)) ids.add(s.id);
    const down = [...ids]
      .filter((id) => ctx.air.survivors[id]?.state === 'down')
      .sort((a, b) => a - b);
    if (down.length === 0) return o;
    const escorted = [...ctx.air.missions.values()].some(
      (e) =>
        e.id !== m.id &&
        e.side === m.side &&
        e.package === m.package &&
        e.type === 'csar-escort' &&
        !e.aborted,
    );
    const lambda = ctx.air.survivorThreat?.(m.side, m.target.point) ?? 0;
    const risk =
      Math.min(PICKUP_RISK, 1 - Math.exp(-lambda * PICKUP_EXPOSURE)) *
      (escorted ? PICKUP_ESCORTED : 1);
    if (ctx.rng.nextFloat() < risk) return o;
    o.rescued = down;
    o.effect = down.length / Math.max(1, ids.size);
    return o;
  },
};
