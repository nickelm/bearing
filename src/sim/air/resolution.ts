/**
 * Aggregate resolution of missions (roadmap R2.2): what happens to flights no
 * one watches, at their phase events (AirOps' phase hook).
 *
 * - **Interception** at fence-in (or on target, if a route has no fence-in): a
 *   flight its plug-in marks as a `target` meets the nearest enemy CAP on
 *   station within INTERCEPT_RANGE of its way in (the last INTERCEPT_LOOKBACK
 *   of its route) or of its target, with
 *   INTERCEPT_CHANCE (HELICOPTER_INTERCEPT of it for a helicopter, low in the terrain),
 *   and each CAP flight at most CAP_ENGAGEMENTS times. The
 *   package's escorts and defense suppression fight with it. Each side's force
 *   is its aircraft times their air values (calibration.ts), the strike flight
 *   counting STRIKE_SELF_DEFENSE of its own; each aircraft is lost with a chance
 *   of KILL_RATE times the enemy's share of the forces, the strike flight's
 *   halved behind escorts and raised without them. A flight that lost half its
 *   aircraft turns home; an unescorted strike flight that was engaged jettisons
 *   and turns home with ABORT_UNESCORTED.
 * - **Point defenses** on target: an abstract air-defense value per target
 *   (AIR_DEFENSE by kind, until R3.5's sites), times AD_RATE, the type's
 *   vulnerability (1 − survival), its exposure (time over the target against
 *   ten minutes, 0.5–2), and SEAD_FACTOR when the package suppresses defenses.
 * - **Outcome** at egress, or when a flight turns home or is lost: the type's
 *   aggregate resolver (its plug-in's) gives the outcome, its success criteria
 *   judge it, and its consequences are applied here (damage to sites and road
 *   edges, stocks, attacks on troops for R2.3).
 *
 * Every draw comes from rng(seed, "resolution") forked by mission, so the war
 * resolves alike at any time acceleration. The constants are priors until
 * R2.10's calibration (rule 18).
 */
import type { Side } from '../../campaign/cast';
import { arcDistance } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { rng } from '../../core/rng';
import { HOUR } from '../../core/units';
import type { Rng, WorldSeed } from '../../core/rng';
import type { CampaignInput } from '../command/campaignInput';
import type { DamageState } from '../ground/damage';
import type { Simulation, Stateful } from '../simulation';
import type { StateHasher } from '../stateHash';
import type { AirOps, PhaseHook } from './airOps';
import { aircraftType } from './aircraft';
import { combatValues } from './calibration';
import { missionPhase, phaseTime } from './mission';
import type { Mission, MissionPhase, MissionType } from './mission';
import type { AggregateResolver, Engagement, MissionOutcome, WorldEffect } from './outcome';
import { launched, plannedOnStation } from './resolvers';
import { routeState } from './route';

export const INTERCEPT_RANGE = 100e3;
export const INTERCEPT_CHANCE = 0.7;
/** The interception chance's factor for a helicopter, low in the terrain (R2.9). */
export const HELICOPTER_INTERCEPT = 0.4;
/** How much of the way in a CAP can catch a flight (s), sampled INTERCEPT_SAMPLES times. */
export const INTERCEPT_LOOKBACK = 30 * 60;
export const INTERCEPT_SAMPLES = 10;
export const CAP_ENGAGEMENTS = 2;
export const KILL_RATE = 0.3;
export const STRIKE_SELF_DEFENSE = 0.5;
export const ESCORT_SCREEN = 0.5;
export const UNESCORTED = 1.3;
export const ABORT_UNESCORTED = 0.5;
export const AD_RATE = 0.1;
export const SEAD_FACTOR = 0.5;
/** Air defense at a target, by kind, until R3.5's sites and belts. */
export const AIR_DEFENSE: Record<string, number> = {
  airbase: 0.6,
  factory: 0.5,
  'power-plant': 0.5,
  refinery: 0.5,
  'supply-depot': 0.45,
  'fuel-depot': 0.45,
  'rail-yard': 0.4,
  bridge: 0.35,
  road: 0.15,
  front: 0.4,
};

/** The most air defense at a pickup, close to an enemy battalion (R2.9). */
export const SURVIVOR_DEFENSE = 0.6;

/** What resolution needs of a mission type: its plug-in's parts, joined by the world. */
export interface ResolvedType {
  engagement: Engagement;
  resolver: AggregateResolver | null;
  judge: ((m: Mission, o: MissionOutcome) => { success: boolean; effects: WorldEffect[] }) | null;
}

export interface ResolutionStats {
  intercepts: number;
  resolved: number;
  successes: number;
  /** Targets and road edges hit, and airlift landings delivered. */
  hits: number;
  deliveries: number;
}

function emptyStats(): ResolutionStats {
  return { intercepts: 0, resolved: 0, successes: 0, hits: 0, deliveries: 0 };
}

function binomial(r: Rng, n: number, p: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (r.nextFloat() < p) k++;
  return k;
}

export class MissionResolution implements PhaseHook, Stateful {
  readonly stats: Record<Side, ResolutionStats> = { alliance: emptyStats(), pact: emptyStats() };
  private readonly root: Rng;

  constructor(
    private readonly air: AirOps,
    private readonly damage: DamageState | null,
    private readonly input: CampaignInput,
    seed: WorldSeed,
    private readonly typeOf: (type: MissionType) => ResolvedType,
  ) {
    this.root = rng(seed, 'resolution');
  }

  phase(m: Mission, phase: MissionPhase, sim: Simulation): void {
    const kind = this.typeOf(m.type).engagement;
    if (kind === 'target' && !m.engaged && (phase === 'fence-in' || phase === 'on-target')) {
      this.intercept(m, sim);
    }
    if (phase === 'on-target' && kind === 'target' && !m.aborted && this.air.missions.has(m.id)) {
      this.defenses(m, sim);
    }
    if (phase === 'egress' && !m.resolved) this.finish(m, sim);
  }

  // ---- Interception ----

  private intercept(m: Mission, sim: Simulation): void {
    m.engaged = true;
    const R = this.input.radius;
    const t = sim.time;
    const pos = routeState(m.route, t, R).point;
    // The way in: the last INTERCEPT_LOOKBACK of the route up to here, and the target.
    const path: Dir[] = [m.target.point];
    for (let k = 0; k <= INTERCEPT_SAMPLES; k++) {
      const s = routeState(m.route, t - (INTERCEPT_LOOKBACK * k) / INTERCEPT_SAMPLES, R);
      if (s.airborne || k === 0) path.push(s.point);
    }
    let cap: Mission | null = null;
    let best = Infinity;
    for (const c of this.air.missions.values()) {
      if (c.side === m.side || this.typeOf(c.type).engagement !== 'cap') continue;
      // A flight the player flies fights at full fidelity (R2.6), not here.
      if ((c.engagements ?? 0) >= CAP_ENGAGEMENTS || c.aborted || c.flown) continue;
      if (missionPhase(c, t) !== 'on-target') continue;
      let d = Infinity;
      for (const p of path) d = Math.min(d, arcDistance(c.target.point, p, R));
      if (d <= INTERCEPT_RANGE && (d < best || (d === best && cap && c.id < cap.id))) {
        best = d;
        cap = c;
      }
    }
    if (!cap) return;
    const r = this.root.fork(`intercept:${m.id}`);
    // A helicopter low in the terrain is harder to find than a jet (R2.9).
    const chance =
      INTERCEPT_CHANCE * (aircraftType(m.aircraftType).helicopter ? HELICOPTER_INTERCEPT : 1);
    if (r.nextFloat() >= chance) return;
    cap.engagements = (cap.engagements ?? 0) + 1;
    this.stats[cap.side].intercepts++;
    const escorts = [...this.air.missions.values()]
      .filter(
        (e) =>
          e.id !== m.id &&
          e.side === m.side &&
          e.package === m.package &&
          !e.aborted &&
          !e.flown &&
          routeState(e.route, t, R).airborne &&
          ['escort', 'suppression'].includes(this.typeOf(e.type).engagement),
      )
      .sort((a, b) => a.id - b.id);
    const air = (x: Mission) => x.aircraft * combatValues(x.aircraftType).air;
    const fa = escorts.reduce((s, e) => s + air(e), 0) + STRIKE_SELF_DEFENSE * air(m);
    const fd = air(cap);
    const share = fa + fd > 0 ? fd / (fa + fd) : 0;
    const pEscort = KILL_RATE * share;
    const pTarget = pEscort * (escorts.length > 0 ? ESCORT_SCREEN : UNESCORTED);
    const pCap = KILL_RATE * (1 - share);
    const capLosses = binomial(r, cap.aircraft, pCap);
    const escortLosses = escorts.map((e) => binomial(r, e.aircraft, pEscort));
    const targetLosses = binomial(r, m.aircraft, pTarget);
    cap.kills = (cap.kills ?? 0) + targetLosses + escortLosses.reduce((a, b) => a + b, 0);
    const shooter = escorts[0] ?? m;
    shooter.kills = (shooter.kills ?? 0) + capLosses;
    // Everyone in the fight drops their tanks first (decision 294).
    for (const x of [cap, ...escorts, m]) this.air.dropTanks(x);
    this.lose(cap, capLosses, pos, 'air-to-air', sim);
    escorts.forEach((e, i) => this.lose(e, escortLosses[i]!, pos, 'air-to-air', sim));
    this.lose(m, targetLosses, pos, 'air-to-air', sim);
    // Who turns home.
    if (this.alive(cap) && (cap.losses ?? 0) * 2 >= launched(cap)) this.abort(cap, 'losses', sim);
    if (!this.alive(m)) return;
    if ((m.losses ?? 0) * 2 >= launched(m)) this.abort(m, 'losses', sim);
    else if (escorts.length === 0 && r.nextFloat() < ABORT_UNESCORTED) {
      this.abort(m, 'intercepted', sim);
    }
    if (m.aborted)
      for (const e of escorts) if (this.alive(e)) this.abort(e, 'package turned home', sim);
  }

  // ---- Point defenses ----

  private defenses(m: Mission, sim: Simulation): void {
    const a = this.airDefense(m);
    if (a <= 0) return;
    const R = this.input.radius;
    const t = sim.time;
    const suppressed = [...this.air.missions.values()].some(
      (e) =>
        e.side === m.side &&
        e.package === m.package &&
        e.id !== m.id &&
        !e.aborted &&
        !e.flown &&
        this.typeOf(e.type).engagement === 'suppression' &&
        routeState(e.route, t, R).airborne,
    );
    const exposure = Math.min(2, Math.max(0.5, plannedOnStation(m) / 600));
    const p =
      a *
      AD_RATE *
      (1 - combatValues(m.aircraftType).survival) *
      (suppressed ? SEAD_FACTOR : 1) *
      exposure;
    const r = this.root.fork(`defense:${m.id}`);
    this.lose(m, binomial(r, m.aircraft, p), m.target.point, 'air defense', sim);
    if (this.alive(m) && (m.losses ?? 0) * 2 >= launched(m)) this.abort(m, 'losses', sim);
  }

  /** The abstract air defense at a mission's target: none at its own side's places. */
  airDefense(m: Mission): number {
    const t = m.target;
    if (t.kind === 'front') return AIR_DEFENSE.front!;
    // Ground fire at a pickup grows near the enemy as the survivor's capture risk does (R2.9).
    if (t.kind === 'survivor')
      return Math.min(SURVIVOR_DEFENSE, (this.air.survivorThreat?.(m.side, t.point) ?? 0) * HOUR);
    if (t.kind === 'road') return AIR_DEFENSE.road!;
    if (t.kind === 'airbase') {
      return this.input.airbases[t.id]?.side === m.side ? 0 : AIR_DEFENSE.airbase!;
    }
    if (t.kind === 'site') {
      const x = this.input.targets[t.id];
      return !x || x.side === m.side ? 0 : (AIR_DEFENSE[x.kind] ?? 0);
    }
    return 0;
  }

  // ---- Losses, aborts and outcomes ----

  private alive(m: Mission): boolean {
    return this.air.missions.has(m.id);
  }

  /**
   * An aircraft of flight m destroyed at full fidelity (decision 301): lost as in the
   * aggregate, with its crew's chances, and a kill for the flight that shot it down.
   */
  fullFidelityLoss(
    m: Mission,
    at: Readonly<Dir>,
    cause: string,
    by: number | null,
    sim: Simulation,
  ): void {
    const shooter = by === null ? undefined : this.air.missions.get(by);
    if (shooter) shooter.kills = (shooter.kills ?? 0) + 1;
    this.lose(m, 1, at, cause, sim);
  }

  /** A target site or road edge hit at full fidelity (decision 301). */
  fullFidelityHit(target: 'site' | 'road', id: number, amount: number, by: number | null): void {
    if (!this.damage || !(amount > 0)) return;
    if (target === 'site') this.damage.hit(id, amount);
    else this.damage.hitRoad(id, amount);
    const m = by === null ? undefined : this.air.missions.get(by);
    if (m) this.stats[m.side].hits++;
  }

  private lose(m: Mission, n: number, at: Readonly<Dir>, cause: string, sim: Simulation): void {
    if (n <= 0 || !this.alive(m)) return;
    this.air.lose(m, n, at, cause, sim);
    if (!this.alive(m) && !m.resolved) this.finish(m, sim);
  }

  private abort(m: Mission, reason: string, sim: Simulation): void {
    if (m.aborted) return;
    this.air.abort(m, reason, sim);
    if (!m.resolved) this.finish(m, sim);
  }

  /** Resolves a mission's outcome and applies its consequences, once. */
  private finish(m: Mission, sim: Simulation): void {
    m.resolved = true;
    const type = this.typeOf(m.type);
    if (!type.resolver) return;
    const start = phaseTime(m, 'on-target');
    const i = m.timeline.findIndex((e) => e.phase === 'on-target');
    const end = i >= 0 && i + 1 < m.timeline.length ? m.timeline[i + 1]!.time : start;
    const onStation =
      Number.isFinite(start) && sim.time > start ? Math.min(sim.time, end) - start : 0;
    const outcome = type.resolver.resolve(m, {
      air: this.air,
      input: this.input,
      now: sim.time,
      rng: this.root.fork(`resolve:${m.id}`),
      onStation,
    });
    const judged = type.judge?.(m, outcome) ?? { success: false, effects: [] };
    const s = this.stats[m.side];
    s.resolved++;
    if (judged.success) s.successes++;
    for (const e of judged.effects) this.apply(m, e, sim);
    sim.log.decision(sim.time, {
      kind: 'mission-resolved',
      mission: m.id,
      side: m.side,
      type: m.type,
      success: judged.success,
      effect: outcome.effect,
      kills: outcome.kills,
      losses: outcome.losses,
    });
    this.air.revision++;
  }

  private apply(m: Mission, e: WorldEffect, sim: Simulation): void {
    const s = this.stats[m.side];
    switch (e.kind) {
      case 'damage':
        if (this.damage && e.amount > 0) {
          this.damage.hit(e.target, e.amount);
          s.hits++;
        }
        break;
      case 'road':
        if (this.damage && e.amount > 0) {
          this.damage.hitRoad(e.edge, e.amount);
          s.hits++;
        }
        break;
      case 'stocks': {
        const st = this.air.base(e.base).stocks;
        st.fuel = Math.max(0, st.fuel + e.fuel);
        st.munitions = Math.max(0, st.munitions + e.munitions);
        if (e.fuel > 0 || e.munitions > 0) s.deliveries++;
        break;
      }
      case 'ground-attack':
        this.damage?.attacks.push({
          time: sim.time,
          side: m.side,
          theater: e.theater,
          point: [e.point[0], e.point[1], e.point[2]],
          amount: e.amount,
        });
        break;
      case 'station-held':
        break;
      case 'rescue':
        this.air.pickUp(m, e.survivors, sim);
        break;
    }
  }

  save(): Record<Side, ResolutionStats> {
    return structuredClone(this.stats);
  }

  load(state: unknown): void {
    const s = state as Record<Side, ResolutionStats>;
    this.stats.alliance = { ...s.alliance };
    this.stats.pact = { ...s.pact };
  }

  hash(h: StateHasher): void {
    for (const side of ['alliance', 'pact'] as const) {
      const s = this.stats[side];
      h.number(s.intercepts)
        .number(s.resolved)
        .number(s.successes)
        .number(s.hits)
        .number(s.deliveries);
    }
  }
}
