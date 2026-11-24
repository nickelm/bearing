/**
 * A followed helicopter flight at full fidelity (roadmap R2.9): the rotary side of
 * `FullFidelity` (fullFidelity.ts), without three.js or the DOM.
 *
 * - **When.** A followed flight whose drawn type has rotorcraft flight data (the
 *   UH-68 today; `rotorSpecOfType`) is promoted inside its jump-in window, which for
 *   helicopters spans the ground phases (decision 149), in the phases its plug-in's
 *   behavior covers, while the clock runs at the flight cap (8×) or slower
 *   (`heloFidelityWanted`). On the ground or in the air alike: a helicopter's mission
 *   ends on the ground.
 * - **Pilots.** Each aircraft is a `RotorcraftModel` flown by an AI helicopter pilot
 *   (`HeloPilot`, decision 355) through the rotary director and the Assisted laws
 *   (rule 12). Its reference is its own slot's pose as the view draws it (the route
 *   on the sited field, lifted over the drawn ground), so the lead tracks the route
 *   and the wingmen their formation slots beside it.
 * - **The landing zone.** Where the plug-in's behavior says `land` (a rescue's
 *   fence-in and pickup), the lead is given a landing task at a zone clear of trees,
 *   slopes and water near the mission's target (`chooseLandingZone` over the drawn
 *   terrain, into the wind), to wait on the ground until the route's egress and at
 *   least PICKUP_WAIT after its touchdown. The zone is chosen once the terrain's data
 *   is there; with none (a survivor in the water) the lead hovers over the target on
 *   its route, as for a hoist.
 * - **Wind.** The campaign's weather in the surface layer's profile (decision 356).
 * - **Clock and losses** as for the jets: game time drives it, at most
 *   MAX_FLIGHT_STEPS per frame; a flight that falls RESYNC_LAG behind starts again from
 *   its route; aircraft the campaign loses leave from the highest slots.
 *
 * Spectating at full fidelity is presentation: the worker resolves the rescue in
 * aggregate (decision 352). Taking over a helicopter is R4.3's.
 */
import type { Dir } from '../core/greatCircle';
import type { GameTime, Meters } from '../core/units';
import { Vec3d } from '../core/vec3d';
import type { AnalyticPose } from '../sim/air/analyticPose';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../sim/air/bundles';
import { jumpInOpen, phaseTime } from '../sim/air/mission';
import type { Mission } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { FLOWN_MAX_RATE } from '../sim/clock';
import type { Reference } from '../sim/flight/aiPilot';
import type { GroundQuery } from '../sim/flight/airframe';
import { MAX_FLIGHT_STEPS } from '../sim/flight/promotedFlight';
import { FLIGHT_STEP } from '../sim/flight/rigidBody';
import { HeloPilot } from '../sim/flight/rotor/heloPilot';
import { chooseLandingZone } from '../sim/flight/rotor/landingZone';
import type { LandingSampler, LandingZone } from '../sim/flight/rotor/landingZone';
import { neutralRotorControls, RotorcraftModel } from '../sim/flight/rotor/rotorcraftModel';
import type { RotorControls } from '../sim/flight/rotor/rotorcraftModel';
import { parseRotorcraftSpec } from '../sim/flight/rotor/rotorSpec';
import type { RotorcraftSpec } from '../sim/flight/rotor/rotorSpec';
import { airVelocity } from '../sim/flight/wind';
import type { WeatherView } from '../sim/weather/frame';
import { phaseBehavior, RESYNC_LAG } from './fullFidelity';
import { drawnReference } from './followFlight';

/** Least time on the ground at the survivor after the touchdown (s): the pickup. */
export const PICKUP_WAIT = 60;

/** The rotorcraft flight data of a type's bundle (its drawn geometry's), or null. */
export function rotorSpecOfType(
  typeId: string,
  flightData: (bundleId: string) => unknown,
): RotorcraftSpec | null {
  const b = bundleOfType(typeId);
  const id = b.hasFlight ? b.id : b.geometry;
  const drawn = id ? AIRCRAFT_BUNDLES[id] : undefined;
  if (!drawn?.hasFlight || !drawn.hasRotors) return null;
  const raw = flightData(drawn.id);
  if (!raw) return null;
  try {
    return parseRotorcraftSpec(raw, drawn.id);
  } catch {
    return null;
  }
}

/** Whether a followed helicopter flight should fly at full fidelity at t. */
export function heloFidelityWanted(m: Readonly<Mission>, t: GameTime, rate: number): boolean {
  return jumpInOpen(m as Mission, t) && phaseBehavior(m, t) !== null && rate <= FLOWN_MAX_RATE;
}

export interface HeloFidelityContext {
  radius: Meters;
  /** The followed mission now, or undefined once it has gone. */
  mission: () => Mission | undefined;
  /** Slot k's drawn pose of mission m at t (the route on the sited field, unlifted), or null. */
  pose: (m: Readonly<Mission>, t: GameTime, slot: number) => AnalyticPose | null;
  /** The flight model's ground (the drawn surface with the airfields' grading). */
  ground: GroundQuery;
  /** Forest and water near the landing zone; null while the terrain's data is not there. */
  site: (d: Readonly<Dir>) => { forest: number; water: boolean } | null;
  gearHeight: Meters;
  clearance: Meters;
  /** The campaign's weather, for the air they fly in (null: still air). */
  weather?: () => WeatherView | null;
}

/** One helicopter of the promoted flight. */
export interface PromotedHelicopter {
  slot: number;
  model: RotorcraftModel;
  controls: RotorControls;
  pilot: HeloPilot;
}

export class HeloFidelity {
  readonly aircraft: PromotedHelicopter[];
  /** The flight's own game time. */
  time: GameTime;
  /** The landing zone at the target, once chosen (null: none yet, or none to be had). */
  lz: LandingZone | null = null;
  private lzTried = false;

  constructor(
    private readonly ctx: HeloFidelityContext,
    readonly spec: RotorcraftSpec,
    m: Readonly<Mission>,
    t: GameTime,
    poses: readonly Readonly<AnalyticPose>[],
  ) {
    this.time = t;
    const R = ctx.radius;
    const s = routeState(m.route, t, R);
    const share = m.route.fuel > 0 ? Math.max(0, Math.min(1, s.fuel / m.route.fuel)) : 1;
    this.aircraft = poses.slice(0, Math.max(1, m.aircraft)).map((p, slot) => {
      const model = new RotorcraftModel(spec, R);
      const reference = this.reference(slot);
      const at = reference(t);
      const dir = new Vec3d(p.pos[0], p.pos[1], p.pos[2]).normalize();
      const ground = R + ctx.ground.height(dir);
      const pos =
        p.airborne && at ? at.pos.clone() : dir.clone().scale(ground + model.gearHeight - 0.03);
      const vel = p.airborne ? new Vec3d(p.velocity[0], p.velocity[1], p.velocity[2]) : new Vec3d();
      model.place(pos, vel, p.heading, p.airborne ? 0 : 0);
      model.updateAttitude(ctx.ground);
      model.unlimitedFuel = false;
      model.fuel = spec.mass.fuel * share;
      const pilot = new HeloPilot(reference);
      pilot.director.laws.reset(model, !p.airborne);
      return { slot, model, controls: neutralRotorControls(), pilot };
    });
    for (const a of this.aircraft) this.giveWind(a);
  }

  /** Slot k's reference: its drawn pose lifted over the drawn ground. */
  private reference(slot: number): Reference {
    const c = this.ctx;
    return drawnReference(
      (u) => {
        const m = c.mission();
        return m ? c.pose(m, u, slot) : null;
      },
      (d) => c.ground.height(d),
      c.gearHeight,
      c.clearance,
    );
  }

  /** The air before each step: the weather's wind in the surface layer's profile. */
  private giveWind(a: PromotedHelicopter): void {
    const c = this.ctx;
    a.model.wind.set(0, 0, 0);
    const view = c.weather?.() ?? null;
    if (!view) return;
    airVelocity(
      view,
      a.model.pos,
      c.radius,
      this.time,
      Math.max(0, a.model.telemetry.radarAltitude),
      a.model.wind,
      1,
      'surface',
    );
  }

  /** The surviving helicopters, in slot order. */
  get alive(): PromotedHelicopter[] {
    return this.aircraft.filter((a) => !a.model.crashed);
  }

  /** The helicopter the view follows for `slot`: that one if it flies, else the lead. */
  followed(slot: number): PromotedHelicopter | undefined {
    const a = this.aircraft.find((x) => x.slot === slot);
    return a && !a.model.crashed ? a : this.alive[0];
  }

  /** Where each slot's helicopter is (world m), for the view's blend back to the route. */
  positions(): Map<number, Vec3d> {
    return new Map(this.aircraft.map((a) => [a.slot, a.model.pos.clone()]));
  }

  /** The landing zone as a world point on the ground, or null. */
  lzPoint(): Vec3d | null {
    const z = this.lz;
    if (!z) return null;
    return new Vec3d(z.point[0], z.point[1], z.point[2]).scale(this.ctx.radius + z.height);
  }

  /**
   * Steps the flight to game time t (once a frame): the campaign's losses taken off,
   * the lead's landing task given or kept. Returns false when the flight's clock fell
   * too far behind and should start again from its route.
   */
  advance(m: Readonly<Mission>, t: GameTime): boolean {
    const extra = this.alive.length - m.aircraft;
    if (extra > 0) {
      for (let i = this.aircraft.length - 1, n = extra; i >= 1 && n > 0; i--, n--)
        this.aircraft.splice(i, 1);
    }
    if (Math.abs(t - this.time) > RESYNC_LAG) return false;
    this.task(m);
    let steps = 0;
    while (this.time + FLIGHT_STEP <= t + 1e-9 && steps < MAX_FLIGHT_STEPS) {
      for (const a of this.aircraft) {
        if (a.model.crashed) continue;
        this.giveWind(a);
        a.pilot.step(a.model, this.time, a.controls, FLIGHT_STEP);
        a.model.step(a.controls, this.ctx.ground);
      }
      this.time += FLIGHT_STEP;
      steps++;
    }
    if (steps >= MAX_FLIGHT_STEPS && this.time < t) this.time = t;
    return true;
  }

  /** Gives the lead its landing task where the plug-in's behavior lands, and keeps the pickup's wait. */
  private task(m: Readonly<Mission>): void {
    const lead = this.alive[0];
    if (!lead) return;
    const b = phaseBehavior(m, this.time);
    const p = lead.pilot;
    if (b?.lead === 'land') {
      if (!this.lzTried) this.chooseZone(m, lead);
      const lz = this.lzPoint();
      if (lz && !p.landing && p.state === 'track' && !p.touchdown) {
        const egress = phaseTime(m as Mission, 'egress');
        p.land({
          point: lz,
          heading: this.lz!.heading,
          waitUntil: Number.isFinite(egress) ? egress : this.time + 5 * 60,
        });
      }
    }
    // The pickup takes its time however late the helicopter landed.
    const task = p.landing;
    if (task && p.touchdown && (task.waitUntil ?? 0) < p.touchdown.time + PICKUP_WAIT)
      task.waitUntil = p.touchdown.time + PICKUP_WAIT;
  }

  /** Chooses the landing zone near the target once the terrain's data is there. */
  private chooseZone(m: Readonly<Mission>, lead: PromotedHelicopter): void {
    const c = this.ctx;
    let missing = false;
    const v = new Vec3d();
    const at = (d: Readonly<Dir>) => {
      const g = c.site(d);
      if (!g) missing = true;
      return g;
    };
    const sampler: LandingSampler = {
      height: (d) => c.ground.height(v.set(d[0], d[1], d[2])),
      forest: (d) => at(d)?.forest ?? 1,
      water: (d) => at(d)?.water ?? true,
    };
    const view = c.weather?.() ?? null;
    const target = m.target.point;
    const tv = new Vec3d(target[0], target[1], target[2]);
    let wind: { east: number; north: number } | undefined;
    if (view?.ready) {
      const w = view.wind(tv.clone().scale(c.radius), 10, this.time, { east: 0, north: 0 });
      wind = { east: w.east, north: w.north };
    }
    const from = lead.model.pos.clone().normalize();
    const z = chooseLandingZone(target, sampler, {
      radius: c.radius,
      rotorRadius: this.spec.main.radius,
      slopeLimit: this.spec.limits.slope,
      wind,
      from: [from.x, from.y, from.z],
    });
    if (missing) return;
    this.lzTried = true;
    this.lz = z;
  }
}
