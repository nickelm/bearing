/**
 * What the Free Flight HUD shows each frame for a helicopter (Proposal 0004,
 * Hover Symbology; track H1): the HudFrame the Canvas HUD draws, filled from
 * the rotorcraft model, its control layer and the pilot's command. The jet's
 * fields take their helicopter meanings (the collective in the throttle's
 * place, torque in the engine's), and the hover block carries the
 * ground-plane velocity vector, the acceleration cue, radar altitude, torque,
 * rotor speed and the modes. No DOM and no three.js.
 */
import { Vec3d } from '../core/vec3d';
import type { GroundQuery } from '../sim/flight/contact';
import type { HeloCommand, HeloLaws } from '../sim/flight/rotor/heloLaws';
import type { RotorControls, RotorcraftModel } from '../sim/flight/rotor/rotorcraftModel';
import type { HudFrame, HudLandingAid } from '../ui/flight/hud';
import { hoverSymbols } from './hudFrame';

/** The model's ground acceleration, from velocity samples a frame apart (world, m/s²). */
const lastVel = new WeakMap<RotorcraftModel, { v: Vec3d; t: number; a: Vec3d }>();

function acceleration(m: RotorcraftModel): Vec3d {
  let s = lastVel.get(m);
  if (!s) {
    s = { v: m.vel.clone(), t: m.time, a: new Vec3d() };
    lastVel.set(m, s);
    return s.a;
  }
  const dt = m.time - s.t;
  if (dt > 1e-3) {
    const a = m.vel
      .clone()
      .sub(s.v)
      .scale(1 / dt);
    // A little smoothing, so the cue does not jitter with the frame rate.
    s.a.scale(0.7).addScaled(a, 0.3);
    s.v.copy(m.vel);
    s.t = m.time;
  }
  return s.a;
}

export function buildHeloHudFrame(
  m: RotorcraftModel,
  laws: HeloLaws,
  c: Readonly<RotorControls>,
  cmd: Readonly<HeloCommand>,
  opts: {
    aid: HudLandingAid | null;
    ground: GroundQuery;
    eye: Readonly<Vec3d>;
    locked: boolean;
    timing: { frameMs: number; physicsMs: number; steps: number } | null;
  },
): HudFrame {
  const tel = m.telemetry;
  const bx = m.bodyAxis(0);
  const up = m.pos.clone().normalize();
  const acc = acceleration(m);
  const modes: string[] = ['ASSISTED'];
  if (laws.hoverHold) modes.push('HOVER HOLD');
  else if (laws.altitudeTarget !== null) modes.push('ALT HOLD');
  if (!opts.locked) modes.push('CLICK TO FLY');
  const hazards: string[] = [];
  if (tel.rotorSpeed < 0.95) hazards.push('LOW RPM');
  if (tel.torque > 1) hazards.push('TORQUE');
  const hover = hoverSymbols({
    pos: m.pos,
    forward: bx,
    eye: opts.eye,
    radius: m.radius,
    groundHeight: opts.ground.height(up),
    gearHeight: m.gearHeightNow(),
    velocity: m.vel,
    accel: acc,
    torque: tel.torque,
    rotorRpm: tel.rotorSpeed,
    lz: null,
    modes,
    hazards,
  });
  return {
    cas: tel.cas,
    mach: 0,
    altitude: tel.altitude,
    radarAltitude: tel.radarAltitude,
    verticalSpeed: tel.verticalSpeed,
    heading: tel.heading,
    pitch: tel.pitch,
    bank: tel.bank,
    alpha: tel.alpha,
    beta: tel.beta,
    load: tel.load,
    throttle: c.collective,
    power: tel.torque,
    afterburner: 0,
    fuel: m.fuel,
    unlimitedFuel: m.unlimitedFuel,
    gear: 1,
    gearDown: true,
    speedbrake: 0,
    brakes: c.brake > 0,
    parkingBrake: c.parkingBrake,
    onGround: m.onGround,
    velocity: [m.vel.x, m.vel.y, m.vel.z],
    boresight: [bx.x, bx.y, bx.z],
    warnings: [],
    aid: opts.aid,
    mode: modes.join(' · ').toLowerCase(),
    aim: null,
    hover,
    debug: opts.timing
      ? {
          cl: c.collective,
          cd: tel.mu,
          thrust: tel.thrust,
          qbar: tel.qbar,
          aero: [tel.aero.x, tel.aero.y, tel.aero.z],
          gear: [tel.gearForce.x, tel.gearForce.y, tel.gearForce.z],
          gravity: [tel.gravity.x, tel.gravity.y, tel.gravity.z],
          blend: cmd.collective,
          ...opts.timing,
        }
      : null,
  };
}
