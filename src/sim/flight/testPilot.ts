/**
 * A scripted test pilot (Free Flight, decision 134): takes off from a runway,
 * climbs to circuit height, flies a left-hand rectangular circuit, and lands
 * on the same runway in the touchdown zone. In the air it flies through the
 * flight director (flightDirector.ts), as an AI pilot would; on the ground it
 * steers with the pedals and brakes. The headless flight test uses it as the
 * proof that the flight model, the ground model and the outcomes work
 * together; the app can show it as an autopilot demonstration (`?autopilot`).
 *
 * Circuit coordinates are in the landing end's frame: `t` meters past the
 * threshold along the landing direction, `c` meters to the right of it.
 */
import { DEG, KNOT } from '../../core/units';
import type { Vec3d } from '../../core/vec3d';
import { AB_GATE, MIL_DETENT } from './controlLaws';
import type { FlightControls } from './controlLaws';
import { FlightDirector, speedForAlpha, toward } from './flightDirector';
import type { FlightModel } from './flightModel';
import { AIM_POINT, GLIDE_PATH, pastThreshold, runwayFrame, runwayPoint, toRunway } from './runway';
import type { Runway, RunwayEnd, RunwayFrame } from './runway';

export type PilotPhase =
  'lineup' | 'takeoff' | 'rotate' | 'climb' | 'circuit' | 'final' | 'flare' | 'rollout' | 'stopped';

interface Waypoint {
  t: number;
  c: number;
  h: number;
  speed: number;
  gearDown: boolean;
  label: string;
}

/** The test pilot's approach angle of attack: a degree under the HUD's 13° target, for flare margin. */
const APPROACH_ALPHA = 12 * DEG;

/** The flight director's flight-path gain (1/s) during the flare. */
const FLARE_GAMMA_GAIN = 2.5;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface TestPilotOptions {
  /** Circuit height above the field (m). */
  height?: number;
  /** Offset of the downwind leg (m, left of the runway). */
  offset?: number;
  /** Rotation speed (CAS, m/s). */
  rotateSpeed?: number;
  /** Afterburner for the takeoff. */
  afterburner?: boolean;
}

export class TestPilot {
  phase: PilotPhase = 'lineup';
  readonly director = new FlightDirector();
  private readonly normalGammaGain = this.director.gammaGain;
  private readonly frame: RunwayFrame;
  private readonly waypoints: Waypoint[];
  private leg = 0;
  private phaseTime = 0;
  private readonly height: number;
  private readonly rotateSpeed: number;
  private readonly afterburner: boolean;

  constructor(
    readonly runway: Readonly<Runway>,
    readonly end: Readonly<RunwayEnd>,
    readonly radius: number,
    options: TestPilotOptions = {},
  ) {
    this.frame = runwayFrame(runway);
    this.height = options.height ?? 1000;
    this.rotateSpeed = options.rotateSpeed ?? 150 * KNOT;
    this.afterburner = options.afterburner ?? true;
    const h = this.height;
    const off = -(options.offset ?? 5000);
    const L = runway.length;
    // The glide path's height at the base leg's end, so the final starts on it.
    const baseT = -15_000;
    const hFinal = Math.min(h, (AIM_POINT - baseT) * Math.tan(GLIDE_PATH));
    this.waypoints = [
      { t: L + 4000, c: 0, h, speed: 300 * KNOT, gearDown: false, label: 'upwind' },
      { t: L + 4000, c: off, h, speed: 280 * KNOT, gearDown: false, label: 'crosswind' },
      { t: baseT + 3000, c: off, h, speed: 250 * KNOT, gearDown: false, label: 'downwind' },
      { t: baseT, c: off, h: hFinal, speed: 220 * KNOT, gearDown: true, label: 'base' },
      { t: baseT, c: 0, h: hFinal, speed: 200 * KNOT, gearDown: true, label: 'base turn' },
    ];
  }

  /** The current circuit leg's name, for logs. */
  get legLabel(): string {
    return this.phase === 'circuit' ? this.waypoints[this.leg]!.label : this.phase;
  }

  /** Runway coordinates of the aircraft in the landing end's frame. */
  coords(model: FlightModel): { t: number; c: number; h: number } {
    const r = toRunway(this.runway, this.frame, model.pos, this.radius);
    return {
      t: pastThreshold(this.end, r.along),
      c: r.across * this.end.sign,
      h: r.height - model.gearHeightNow(),
    };
  }

  private point(t: number, c: number, h: number): Vec3d {
    const along = this.end.threshold + t * this.end.sign;
    return runwayPoint(this.runway, this.frame, along, c * this.end.sign, h, this.radius);
  }

  private setPhase(p: PilotPhase): void {
    if (this.phase === 'flare') this.director.gammaGain = this.normalGammaGain;
    this.phase = p;
    this.phaseTime = 0;
  }

  /** Sets the controls for the next step of `dt` s. */
  fly(model: FlightModel, ctl: FlightControls, dt: number): void {
    const tel = model.telemetry;
    const pos = this.coords(model);
    this.phaseTime += dt;
    const steer = () => {
      const headingErr = wrap(tel.heading - this.end.heading);
      ctl.yaw = clamp(-0.06 * pos.c - 2.5 * headingErr, -1, 1);
    };
    switch (this.phase) {
      case 'lineup': {
        ctl.parkingBrake = true;
        ctl.throttle = 0;
        ctl.gearDown = true;
        if (this.phaseTime > 2) {
          ctl.parkingBrake = false;
          this.setPhase('takeoff');
        }
        break;
      }
      case 'takeoff': {
        ctl.throttle = this.afterburner ? 1 : MIL_DETENT;
        ctl.pitch = 0;
        ctl.roll = 0;
        steer();
        if (tel.cas >= this.rotateSpeed) this.setPhase('rotate');
        break;
      }
      case 'rotate': {
        const pitchDeg = tel.pitch / DEG;
        ctl.pitch = clamp(0.3 * (10 - pitchDeg) - 2 * model.omega.y, -1, 1);
        ctl.roll = clamp(-2 * tel.bank, -1, 1);
        if (model.onGround) steer();
        else ctl.yaw = 0;
        if (pos.h > 15) {
          ctl.gearDown = false;
          this.director.reset();
          this.setPhase('climb');
        }
        break;
      }
      case 'climb': {
        ctl.gearDown = false;
        // Out of the afterburner once climbing away.
        const speed = 300 * KNOT;
        const gamma = clamp(((this.height - pos.h) * 0.05) / Math.max(tel.tas, 60), -0.1, 12 * DEG);
        this.director.fly(
          model,
          { course: this.end.heading, gamma, speed, maxBank: 30 * DEG },
          ctl,
          dt,
        );
        if (tel.cas > 250 * KNOT && ctl.throttle > AB_GATE) ctl.throttle = MIL_DETENT;
        if (pos.h > this.height - 150) this.setPhase('circuit');
        break;
      }
      case 'circuit': {
        const wp = this.waypoints[this.leg]!;
        const target = this.point(wp.t, wp.c, wp.h);
        const dir = toward(model, target);
        const vsDes = clamp((wp.h - pos.h) * 0.08, -12, 15);
        const gamma = Math.asin(clamp(vsDes / Math.max(tel.tas, 60), -0.3, 0.3));
        this.director.fly(
          model,
          { course: dir.course, gamma, speed: wp.speed, maxBank: 45 * DEG },
          ctl,
          dt,
        );
        if (wp.gearDown && tel.cas < model.spec.gear.maxSpeed - 10) ctl.gearDown = true;
        const dx = Math.hypot(pos.t - wp.t, pos.c - wp.c);
        const last = this.leg === this.waypoints.length - 1;
        if (last ? Math.abs(pos.c) < 2500 : dx < 2200) {
          if (last) this.setPhase('final');
          else this.leg++;
        }
        break;
      }
      case 'final': {
        ctl.gearDown = true;
        const v = Math.max(tel.tas, 50);
        const carrot = this.point(pos.t + Math.max(1500, 25 * v), 0, 0);
        const dir = toward(model, carrot);
        const hGs = (AIM_POINT - pos.t) * Math.tan(GLIDE_PATH);
        const vsDes = clamp(-v * Math.tan(GLIDE_PATH) + 0.12 * (hGs - pos.h), -12, 3);
        const gamma = Math.asin(vsDes / v);
        const speed = speedForAlpha(model, APPROACH_ALPHA);
        this.director.fly(model, { course: dir.course, gamma, speed, maxBank: 25 * DEG }, ctl, dt);
        if (pos.h < 10) this.setPhase('flare');
        break;
      }
      case 'flare': {
        // A firmer hand on the flight path for the flare's few seconds.
        this.director.gammaGain = FLARE_GAMMA_GAIN;
        const v = Math.max(tel.tas, 50);
        const carrot = this.point(pos.t + 1500, 0, 0);
        const dir = toward(model, carrot);
        const vsDes = -(0.25 * Math.max(pos.h, 0) + 0.6);
        let gamma = Math.asin(vsDes / v);
        // Never above 12.5° of pitch: the tail strikes at about 13.5°.
        if (tel.pitch > 12.5 * DEG) gamma = Math.min(gamma, tel.gamma - 0.5 * DEG);
        const speed = pos.h > 4 ? speedForAlpha(model, APPROACH_ALPHA) : null;
        this.director.fly(model, { course: dir.course, gamma, speed, maxBank: 10 * DEG }, ctl, dt);
        if (pos.h <= 4) ctl.throttle = 0;
        if (model.onGround) this.setPhase('rollout');
        break;
      }
      case 'rollout': {
        ctl.throttle = 0;
        ctl.roll = 0;
        ctl.speedbrake = true;
        const noseDown = model.wheels[0]!.load > 0;
        ctl.pitch = noseDown ? 0 : -0.25;
        steer();
        const brake = noseDown && this.phaseTime > 1.5 ? 0.6 : 0;
        ctl.brakeLeft = brake;
        ctl.brakeRight = brake;
        if (tel.groundSpeed < 0.3 && this.phaseTime > 3) {
          ctl.parkingBrake = true;
          this.setPhase('stopped');
        }
        break;
      }
      case 'stopped': {
        ctl.throttle = 0;
        ctl.parkingBrake = true;
        break;
      }
    }
  }
}
