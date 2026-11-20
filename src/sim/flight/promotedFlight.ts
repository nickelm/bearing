/**
 * A campaign flight at full fidelity (roadmap R2.5): its aircraft as
 * `FlownAircraft` (promotion.ts), each flown by an AI pilot (aiPilot.ts) or by the
 * player, stepped together at the flight step on a clock of its own that game
 * time drives.
 *
 * - **Pilots.** The lead keeps station on its route's reference (`lead`: the
 *   analytic route as the view draws it, on the sited field and over the drawn
 *   ground); every other aircraft keeps its formation slot beside the flown lead,
 *   in the formation its plug-in names for the phase (`formation`). The lead is
 *   the lowest surviving slot, so a wingman takes the lead when the lead is lost.
 * - **The player** takes one aircraft (`takeOver`): its AI pilot leaves, and the
 *   aircraft's own input source flies it (`FlownAircraft.pilot`: mouse aim's hook,
 *   or none, the controls as the player's input left them). The others go on: the wingmen keep
 *   formation on the player when the player leads. `handBack` returns the aircraft
 *   to its AI pilot with the flight's orders, a reference the caller gives (the
 *   route the worker rebuilt from where the flight is, R2.5's demotion).
 * - **Clock.** `advanceTo(t)` takes the steps from the flight's time to game
 *   time t (at most `maxSteps`, the rest dropped: the flight slows, never
 *   skips), the lead first so the wingmen's slots read its new state. Game time,
 *   not real time, drives it, so a pause holds it and the flight cap (8×, R2.5)
 *   only takes more steps per frame.
 *
 * Headless: the main thread runs it beside the view, and tests run it alone.
 */
import type { GameTime, Meters } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { AnalyticPose } from '../air/analyticPose';
import { slotPose } from '../air/formation';
import type { FormationState } from '../air/formation';
import type { MissionPhase } from '../air/mission';
import type { GroundQuery } from './airframe';
import {
  FORMATION_GAINS,
  PoseTracker,
  poseOfAirframe,
  ROUTE_GAINS,
  sampledReference,
} from './aiPilot';
import type { Reference, ReferencePoint } from './aiPilot';
import type { FlightModel } from './flightModel';
import type { FlightSpec } from './flightSpec';
import { demoteFlight, promoteFlight } from './promotion';
import type { DemotedFlight, PromotedAircraft, PromotedMission } from './promotion';
import { FLIGHT_STEP } from './rigidBody';

export interface PromotedFlightOptions {
  /** The lead's reference: where its route, drawn, puts it at a game time. */
  lead: Reference;
  /** The flight's formation at a game time (its plug-in's per phase, formation.ts). */
  formation: (t: GameTime) => FormationState;
  /** The mission's phase at a game time. */
  phase: (t: GameTime) => MissionPhase;
  /** The drawn model's wingspan (m): slots are in spans. */
  span: Meters;
}

/** Steps per `advanceTo` at most: 8× at 60 frames a second, with room (R2.5's flight cap). */
export const MAX_FLIGHT_STEPS = 40;

export class PromotedFlight {
  readonly aircraft: PromotedAircraft[];
  /** Each aircraft's AI pilot, by index in `aircraft`; the player's has none while flown. */
  readonly pilots: PoseTracker[];
  /** The slot the player flies, or null. */
  playerSlot: number | null = null;
  /** The flight's own game time: promotion's time plus the steps taken. */
  time: GameTime;
  /** Steps the last `advanceTo` took. */
  steps = 0;
  /** The lead's reference, sampled (the analytic pose costs hundreds of route lookups). */
  private leadReference: Reference;

  constructor(
    readonly mission: Readonly<PromotedMission>,
    t: GameTime,
    readonly radius: Meters,
    readonly spec: FlightSpec,
    poses: readonly Readonly<AnalyticPose>[],
    readonly options: PromotedFlightOptions,
  ) {
    this.time = t;
    this.leadReference = sampledReference(options.lead);
    this.aircraft = promoteFlight(mission, t, radius, spec, poses);
    this.pilots = this.aircraft.map(() => new PoseTracker(() => null, ROUTE_GAINS));
    this.assignPilots();
  }

  /** The surviving aircraft, in slot order. */
  get alive(): PromotedAircraft[] {
    return this.aircraft.filter((a) => !a.flown.crashed && a.damage < 1);
  }

  /** The aircraft in `slot`, or undefined. */
  bySlot(slot: number): PromotedAircraft | undefined {
    return this.aircraft.find((a) => a.slot === slot);
  }

  /** The player takes the aircraft in `slot`; false if it is not there or not flying. */
  takeOver(slot: number): boolean {
    const a = this.bySlot(slot);
    if (!a || a.flown.crashed) return false;
    this.playerSlot = slot;
    this.assignPilots();
    return true;
  }

  /**
   * The player leaves the aircraft: its AI pilot takes it with the flight's orders,
   * `lead` (the rebuilt route's reference) if given, and the director starts afresh.
   */
  handBack(lead?: Reference): void {
    if (this.playerSlot === null) return;
    this.playerSlot = null;
    if (lead) {
      this.options.lead = lead;
      this.leadReference = sampledReference(lead);
    }
    for (const p of this.pilots) p.reset();
    this.assignPilots();
  }

  /** Takes `n` aircraft off the flight (the campaign lost them): the highest slots the player does not fly. */
  remove(n: number): number {
    let removed = 0;
    for (let i = this.aircraft.length - 1; i >= 0 && removed < n; i--) {
      if (this.aircraft[i]!.slot === this.playerSlot) continue;
      this.aircraft.splice(i, 1);
      this.pilots.splice(i, 1);
      removed++;
    }
    this.assignPilots();
    return removed;
  }

  /** Steps the flight from its time to game time t (lead first); returns the steps taken. */
  advanceTo(t: GameTime, ground: GroundQuery, maxSteps = MAX_FLIGHT_STEPS): number {
    let steps = 0;
    while (this.time + FLIGHT_STEP <= t + 1e-9 && steps < maxSteps) {
      this.stepOnce(ground);
      steps++;
    }
    // Beyond the cap the flight's clock jumps to now: it slows, it never runs behind.
    if (steps >= maxSteps && this.time < t) this.time = t;
    this.steps = steps;
    if (steps > 0) this.assignPilots();
    return steps;
  }

  /** Folds the flight back into its analytic state (demotion). */
  demote(): DemotedFlight | null {
    return demoteFlight(this.mission, this.time, this.radius, this.aircraft, this.spec.mass.fuel);
  }

  private stepOnce(ground: GroundQuery): void {
    const t = this.time;
    for (let i = 0; i < this.aircraft.length; i++) {
      const a = this.aircraft[i]!;
      if (a.flown.crashed) continue;
      const m = a.flown.airframe as unknown as FlightModel;
      if (a.slot === this.playerSlot) {
        // The player's input source: mouse aim's hook, or the controls as the input left them.
        a.flown.step(ground);
        continue;
      }
      const pilot = this.pilots[i]!;
      a.flown.step(ground, (_af, ctl, dt) => void pilot.fly(m, t, ctl, dt));
    }
    this.time = t + FLIGHT_STEP;
  }

  /** Points each AI pilot at its reference: the lead at its route, the others at their slots. */
  private assignPilots(): void {
    const alive = this.alive;
    const lead = alive[0];
    alive.forEach((a, rank) => {
      const i = this.aircraft.indexOf(a);
      const p = this.pilots[i]!;
      if (rank === 0) {
        p.reference = this.leadReference;
        p.gains = ROUTE_GAINS;
      } else {
        p.reference = this.slotReference(lead!, rank);
        p.gains = FORMATION_GAINS;
      }
    });
  }

  /**
   * Slot `rank` beside the flown lead at a game time: the lead's state now,
   * carried ahead along its velocity for a time after it (the tracker's feed-forward).
   */
  private slotReference(lead: PromotedAircraft, rank: number): Reference {
    const o = this.options;
    return (t): ReferencePoint => {
      const m = lead.flown.airframe as unknown as FlightModel;
      const pose = poseOfAirframe(m, o.phase(this.time));
      const dt = t - this.time;
      if (dt !== 0) {
        for (let k = 0; k < 3; k++) pose.pos[k] = pose.pos[k]! + pose.velocity[k]! * dt;
      }
      const s = slotPose(pose, rank, o.formation(t), o.span);
      return { pos: new Vec3d(...s.pos), vel: new Vec3d(...s.velocity) };
    };
  }
}
