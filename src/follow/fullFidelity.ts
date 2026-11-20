/**
 * A followed flight at full fidelity (roadmap R2.5): the main thread's side of
 * `PromotedFlight`, without three.js or the DOM.
 *
 * - **When.** A followed flight is promoted when its type has fixed-wing flight
 *   data (`flightSpecOfType`: today the F-21 alone) and it is inside its jump-in
 *   window (climb-out to approach), while the clock runs no faster than the flight
 *   cap (8×), since faster the flight model could not keep up (`fullFidelityWanted`).
 *   It is demoted at the approach, when the clock runs faster, and when the follow
 *   ends; a flight the player flies stays promoted until the handback.
 * - **References.** The lead keeps station on its route as the view draws it: on
 *   the sited field near its base and lifted over the drawn ground
 *   (`drawnReference`). The followed mission is looked up live, so a new route (an
 *   abort's way home, the worker's rebuilt route after a handback) becomes the
 *   lead's reference once it arrives (`routeKey` changes); until a handback's route
 *   arrives the lead flies on along its velocity.
 * - **Losses.** Aircraft the campaign loses while the flight is followed leave the
 *   promoted flight from the highest slots (`remove`), so the drawn flight is the
 *   campaign's.
 *
 * Spectating at full fidelity is presentation: the worker carries on the flight on
 * its analytic route, which the AI tracks within a few hundred meters. Only a
 * take-over holds the mission in the worker (decision 257).
 */
import type { GameTime, Meters } from '../core/units';
import { Vec3d } from '../core/vec3d';
import type { AnalyticPose } from '../sim/air/analyticPose';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../sim/air/bundles';
import { formationAt } from '../sim/air/formation';
import type { Formation } from '../sim/air/formation';
import { jumpInOpen, missionPhase } from '../sim/air/mission';
import { isPending } from '../sim/command/missions/plugin';
import type { PhaseBehavior } from '../sim/command/missions/plugin';
import { missionPlugin } from '../sim/command/missions/registry';
import type { Mission, MissionPhase } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { FLOWN_MAX_RATE } from '../sim/clock';
import type { Reference } from '../sim/flight/aiPilot';
import type { GroundQuery } from '../sim/flight/airframe';
import type { FlightModel } from '../sim/flight/flightModel';
import { parseFlightSpec } from '../sim/flight/flightSpec';
import type { FlightSpec } from '../sim/flight/flightSpec';
import { PromotedFlight } from '../sim/flight/promotedFlight';
import type { PromotedAircraft } from '../sim/flight/promotion';
import { drawnReference } from './followFlight';
import { airVelocity } from '../sim/flight/wind';
import type { WeatherView } from '../sim/weather/frame';

/** The fixed-wing flight data of a type's bundle (its drawn geometry's), or null: it flies analytically. */
export function flightSpecOfType(
  typeId: string,
  flightData: (bundleId: string) => unknown,
): FlightSpec | null {
  const b = bundleOfType(typeId);
  const id = b.hasFlight ? b.id : b.geometry;
  const drawn = id ? AIRCRAFT_BUNDLES[id] : undefined;
  if (!drawn?.hasFlight || drawn.hasRotors) return null;
  const raw = flightData(drawn.id);
  if (!raw) return null;
  try {
    return parseFlightSpec(raw, drawn.id);
  } catch {
    return null;
  }
}

/**
 * The AI pilots' behavior for mission m's phase at t (its plug-in's, rule 16), or null
 * where the plug-in has none (a pending part, a phase it leaves out).
 */
export function phaseBehavior(m: Readonly<Mission>, t: GameTime): PhaseBehavior | null {
  const b = missionPlugin(m.type).behavior;
  const phase = missionPhase(m as Mission, t);
  if (isPending(b) || phase === 'planned') return null;
  return b.phases[phase] ?? null;
}

/** Whether a followed flight should fly at full fidelity at t, not flown by the player. */
export function fullFidelityWanted(
  m: Readonly<Mission>,
  t: GameTime,
  rate: number,
  poses: readonly Readonly<AnalyticPose>[],
): boolean {
  return (
    jumpInOpen(m as Mission, t) &&
    phaseBehavior(m, t) !== null &&
    rate <= FLOWN_MAX_RATE &&
    poses.length > 0 &&
    poses.every((p) => p.airborne)
  );
}

/** A key that changes when the mission's route or its hold does (the worker's list is new each update). */
export function routeKey(m: Readonly<Mission>): string {
  const r = m.route;
  const end = m.timeline[m.timeline.length - 1]?.time ?? 0;
  return `${r.segments.length}:${end}:${r.fuel}:${m.flown ? m.flown.since : ''}`;
}

/** How far the flight's clock may fall behind game time before it starts again from the route (s). */
export const RESYNC_LAG = 5;

export interface FullFidelityContext {
  radius: Meters;
  /** The followed mission now, or undefined once it has gone. */
  mission: () => Mission | undefined;
  /** The lead's drawn pose (the route on the sited field, unlifted) of mission m at t. */
  leadPose: (m: Readonly<Mission>, t: GameTime) => AnalyticPose;
  /** The flight model's ground, whose height is the drawn surface. */
  ground: GroundQuery;
  formations: Partial<Record<MissionPhase, Formation>>;
  gearHeight: Meters;
  clearance: Meters;
  span: Meters;
  /** The campaign's weather, for the air the aircraft fly in (null: still air). */
  weather?: () => WeatherView | null;
}

export class FullFidelity {
  readonly flight: PromotedFlight;
  /** The route's key the lead's reference was built from. */
  private key: string;
  /** A handback's route has not arrived yet: the lead flies on along its velocity. */
  private awaiting = false;

  constructor(
    private readonly ctx: FullFidelityContext,
    readonly spec: FlightSpec,
    m: Readonly<Mission>,
    t: GameTime,
    /** The flight's drawn poses at t, in slot order (where the view draws them now). */
    poses: readonly Readonly<AnalyticPose>[],
  ) {
    const c = ctx;
    this.key = routeKey(m);
    this.flight = new PromotedFlight(m, t, c.radius, spec, poses, {
      lead: this.liveReference(),
      formation: (u) => formationAt(c.mission()?.timeline ?? m.timeline, c.formations, u),
      phase: (u) => routeState((c.mission() ?? m).route, u, c.radius).phase,
      span: c.span,
    });
    // The air they fly in: the campaign's wind and gusts, as Free Flight's (decision 280).
    for (const a of this.flight.aircraft) this.giveWind(a);
  }

  /** The aircraft's air before each step: the weather's wind at its place and time. */
  private giveWind(a: PromotedAircraft): void {
    const c = this.ctx;
    const f = this.flight;
    a.flown.wind = (af) =>
      airVelocity(
        c.weather?.() ?? null,
        af.pos,
        c.radius,
        f.time,
        Math.max(0, af.telemetry.radarAltitude),
        af.wind,
      );
  }

  /** The lead's reference on the followed mission's route as it is at each call. */
  private liveReference(): Reference {
    const c = this.ctx;
    return drawnReference(
      (t) => {
        const m = c.mission();
        return m ? c.leadPose(m, t) : null;
      },
      (d) => c.ground.height(d),
      c.gearHeight,
      c.clearance,
    );
  }

  /**
   * Steps the flight to game time t (call once a frame): the campaign's losses taken
   * off, a new route given to the lead. Returns false when the flight's clock fell too
   * far behind (a seek, a stalled tab) and should start again from the route.
   */
  advance(m: Readonly<Mission>, t: GameTime): boolean {
    const f = this.flight;
    if (f.playerSlot === null) {
      const extra = f.alive.length - m.aircraft;
      if (extra > 0) f.remove(extra);
      if (Math.abs(t - f.time) > RESYNC_LAG) return false;
    }
    const key = routeKey(m);
    if (key !== this.key && !(this.awaiting && m.flown)) {
      this.key = key;
      this.awaiting = false;
      f.setLead(this.liveReference());
    }
    f.advanceTo(t, this.ctx.ground);
    return true;
  }

  /**
   * The player leaves the aircraft (R2.5): its AI pilot takes it, the lead flying on
   * along its velocity until the worker's rebuilt route arrives.
   */
  handBack(): void {
    const f = this.flight;
    const lead = f.alive[0];
    if (!lead) {
      f.handBack();
      return;
    }
    const m = lead.flown.airframe as unknown as FlightModel;
    const t0 = f.time;
    const p0 = m.pos.clone();
    const v0 = m.vel.clone();
    this.awaiting = true;
    f.handBack((t) => ({ pos: p0.clone().addScaled(v0, t - t0), vel: v0 }));
  }

  /** The aircraft the view follows for slot `slot`: that one if it flies, else the lead. */
  followed(slot: number): PromotedAircraft | undefined {
    const f = this.flight;
    const a = f.bySlot(slot);
    return a && !a.flown.crashed ? a : f.alive[0];
  }

  /** Where each slot's aircraft is (m, world), for the view's blend back to the route on demotion. */
  positions(): Map<number, Vec3d> {
    return new Map(this.flight.aircraft.map((a) => [a.slot, a.flown.airframe.pos.clone()]));
  }
}
