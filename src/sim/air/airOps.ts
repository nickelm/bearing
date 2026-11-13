/**
 * Air operations state in the sim (C2): the order of battle, the carrier
 * groups' tracks and every live mission (planned or flying). The command
 * layer (sim/command/) plans missions and hands them to `launch`; from then
 * on the mission runs on scheduled events:
 *
 * - **Phase events** (AIR_PHASE_EVENT) at each phase start of its timeline.
 *   Positions between them are analytic (route.ts), so the events only mark
 *   state changes: later milestones hang subscriptions, auto-slowdown and
 *   mission resolution on them.
 * - **Completion** frees the flight into turnaround: AIR_READY_EVENT returns
 *   its aircraft to the squadron after the type's turnaround time.
 *
 * Aircraft are conserved: each squadron's strength is its available aircraft
 * plus those on live missions plus those in turnaround (tested).
 */
import type { Side } from '../../campaign/cast';
import type { WorldSeed } from '../../core/rng';
import type { Dir } from '../../core/greatCircle';
import type { GameTime } from '../../core/units';
import type { Simulation } from '../simulation';
import type { StateHasher } from '../stateHash';
import type { CampaignInput } from '../command/campaignInput';
import { carrierState, carrierTrack } from '../naval/carrierGroup';
import type { CarrierTrack } from '../naval/carrierGroup';
import { aircraftType } from './aircraft';
import type { BaseRef, Mission, MissionPhase } from './mission';
import { buildOrderOfBattle, baseIndex } from './orbat';
import type { AirBaseRecord, OrderOfBattle, Squadron } from './orbat';
import { routeState } from './route';

export const AIR_PHASE_EVENT = 'air:phase';
export const AIR_READY_EVENT = 'air:ready';

interface PhaseEvent {
  mission: number;
  phase: MissionPhase;
}

interface ReadyEvent {
  squadron: number;
  aircraft: number;
}

/** Munition loads a mission type draws per aircraft. */
const ARMED = new Set([
  'interdiction',
  'deep-strike',
  'stealth-strike',
  'sead',
  'cas',
  'helo-cas',
  'anti-shipping',
  'strategic-bombing',
]);

export class AirOps {
  readonly orbat: OrderOfBattle;
  readonly carriers: CarrierTrack[];
  readonly radius: number;
  /** Live missions by id (planned or flying), in launch order. */
  readonly missions = new Map<number, Mission>();
  /** Bumped whenever a mission is added or removed (snapshots resend the list). */
  revision = 0;
  /** Missions launched and completed per side, and aircraft in turnaround per squadron. */
  readonly launched: Record<Side, number> = { alliance: 0, pact: 0 };
  readonly completed: Record<Side, number> = { alliance: 0, pact: 0 };
  readonly turnaround: number[];
  private nextMission = 0;
  private nextPackage = 0;

  constructor(
    readonly input: CampaignInput,
    seed: WorldSeed,
  ) {
    this.radius = input.radius;
    this.orbat = buildOrderOfBattle(input, seed);
    this.carriers = input.carriers.map((c) => carrierTrack(c, input.radius));
    this.turnaround = this.orbat.squadrons.map(() => 0);
  }

  /** Registers the event handlers with the simulation. */
  register(sim: Simulation): void {
    sim.on(AIR_PHASE_EVENT, (e, s) => this.onPhase(e.data as PhaseEvent, s));
    sim.on(AIR_READY_EVENT, (e) => this.onReady(e.data as ReadyEvent));
  }

  get squadrons(): readonly Squadron[] {
    return this.orbat.squadrons;
  }

  base(ref: BaseRef): AirBaseRecord {
    return this.orbat.bases[baseIndex(ref, this.input.airbases.length)]!;
  }

  /** Where a base is at game time t: an airbase's site, or a carrier group's position. */
  basePoint(ref: BaseRef, t: GameTime): Dir {
    if (ref.kind === 'airbase') return [...this.input.airbases[ref.id]!.point];
    return carrierState(this.carriers[ref.id]!, t).point;
  }

  newMissionId(): number {
    return this.nextMission++;
  }

  newPackageId(): number {
    return this.nextPackage++;
  }

  /** Fuel and munitions a flight would draw from its base. */
  draw(m: Pick<Mission, 'aircraftType' | 'aircraft' | 'type'>): {
    fuel: number;
    munitions: number;
  } {
    const t = aircraftType(m.aircraftType);
    return {
      fuel: m.aircraft * t.fuel * this.input.rangeFactor,
      munitions: ARMED.has(m.type) ? m.aircraft : 0,
    };
  }

  /** Commits a planned mission: reserves its aircraft and stocks and schedules its phases. */
  launch(m: Mission, sim: Simulation): void {
    const sq = this.orbat.squadrons[m.squadron]!;
    if (sq.available < m.aircraft) {
      throw new Error(
        `Squadron ${sq.name} has ${sq.available} aircraft, mission needs ${m.aircraft}`,
      );
    }
    sq.available -= m.aircraft;
    const base = this.base(m.base);
    const d = this.draw(m);
    base.stocks.fuel -= d.fuel;
    base.stocks.munitions -= d.munitions;
    this.missions.set(m.id, m);
    this.launched[m.side]++;
    this.revision++;
    for (const e of m.timeline) {
      sim.schedule(Math.max(e.time, sim.time), AIR_PHASE_EVENT, { mission: m.id, phase: e.phase });
    }
  }

  private onPhase(e: PhaseEvent, sim: Simulation): void {
    if (e.phase !== 'complete') return;
    const m = this.missions.get(e.mission);
    if (!m) return;
    this.missions.delete(e.mission);
    this.completed[m.side]++;
    this.revision++;
    this.turnaround[m.squadron]! += m.aircraft;
    const t = aircraftType(m.aircraftType);
    sim.schedule(sim.time + t.turnaround, AIR_READY_EVENT, {
      squadron: m.squadron,
      aircraft: m.aircraft,
    });
  }

  private onReady(e: ReadyEvent): void {
    this.orbat.squadrons[e.squadron]!.available += e.aircraft;
    this.turnaround[e.squadron]! -= e.aircraft;
  }

  /** Live missions in id order. */
  liveMissions(): Mission[] {
    return [...this.missions.values()];
  }

  /** Aircraft of `side` in the air at game time t (all live missions, planned ones included when they will be). */
  airborneAt(side: Side, t: GameTime): number {
    let n = 0;
    for (const m of this.missions.values()) {
      if (m.side === side && routeState(m.route, t, this.radius).airborne) n += m.aircraft;
    }
    return n;
  }

  hash(h: StateHasher): void {
    h.number(this.nextMission).number(this.nextPackage).number(this.revision);
    for (const s of this.orbat.squadrons) h.number(s.available).number(s.aircraft);
    for (const n of this.turnaround) h.number(n);
    for (const b of this.orbat.bases) h.number(b.stocks.fuel).number(b.stocks.munitions);
    for (const m of this.missions.values()) {
      h.number(m.id).string(m.type).number(m.squadron).number(m.aircraft).number(m.seed);
      for (const e of m.timeline) h.number(e.time);
    }
  }
}
