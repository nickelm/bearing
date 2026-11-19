/**
 * Free Flight's aircraft snapshot for the displays and the strip (decision
 * 199), built from the HUD's frame, which already carries every state they
 * read, so the flight model is read in one place. Joker and bingo are Free
 * Flight's defaults (35% and 20% of the internal fuel) until missions set them.
 */
import type { AvionicsState } from '../../sim/avionics/avionics';
import type { AvionicsProfile } from '../../sim/avionics/profiles';
import type { HudFrame } from '../flight/hud';
import type { AircraftSnapshot, SnapshotMessage, SnapshotSensors } from './snapshot';
import { Vec3d } from '../../core/vec3d';
import { radarDisplayRange } from '../../sim/avionics/avionics';
import type { RadarSpec, SensorPicture } from '../../sim/sensors/sensors';

/**
 * The sensor picture relative to the aircraft at `pos` with nose `forward` and canopy
 * `up` (decision 218): ranges, angles off the nose, altitudes above sea level on a
 * planet of `radius`, headings, speeds and closing speeds; the threats' bearings off
 * the nose.
 */
export function relativePicture(
  pic: SensorPicture,
  own: {
    pos: Readonly<Vec3d>;
    vel: Readonly<Vec3d>;
    forward: Readonly<Vec3d>;
    up: Readonly<Vec3d>;
  },
  radius: number,
  radar: RadarSpec | null,
  avionics: AvionicsState,
  skin: 'alliance' | 'pact' = 'alliance',
): SnapshotSensors {
  const right = own.forward.clone().cross(own.up).normalize();
  const fwdH = own.forward.clone();
  const contacts = pic.contacts.map((c) => {
    const p = new Vec3d(c.pos[0], c.pos[1], c.pos[2]);
    const v = new Vec3d(c.vel[0], c.vel[1], c.vel[2]);
    const d = p.clone().sub(own.pos);
    const range = d.length();
    const x = d.dot(fwdH);
    const y = d.dot(right);
    const z = d.dot(own.up);
    const up = p.clone().normalize();
    const east = new Vec3d(0, 1, 0).cross(up).normalize();
    const north = up.clone().cross(east);
    const los = d.clone().scale(1 / Math.max(1, range));
    return {
      id: c.id,
      source: c.source,
      range,
      azimuth: Math.atan2(y, x),
      elevation: Math.atan2(z, Math.hypot(x, y)),
      altitude: p.length() - radius,
      heading: Math.atan2(v.dot(east), v.dot(north)),
      speed: v.length(),
      closing: -v.clone().sub(own.vel).dot(los),
      side: c.side,
      locked: c.id === avionics.radar.lock,
    };
  });
  // Threats' true bearings turned to bearings off the nose.
  const up = own.pos.clone().normalize();
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const nose = Math.atan2(own.forward.dot(east), own.forward.dot(north));
  const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  return {
    radar: radar
      ? {
          on: avionics.radar.on,
          mode: avionics.radar.mode,
          range: radarDisplayRange(skin, avionics.radar.range, avionics.radar.mode),
          lock: avionics.radar.lock,
          azimuth: radar.azimuth,
          elevation: radar.elevation,
        }
      : null,
    contacts,
    threats: pic.threats.map((t) => ({
      id: t.id,
      kind: t.kind,
      azimuth: wrap(t.bearing - nose),
      state: t.state,
      ground: t.ground,
    })),
  };
}

export const JOKER_SHARE = 0.35;
export const BINGO_SHARE = 0.2;

export interface SnapshotExtras {
  time: number;
  name: string;
  profile: AvionicsProfile;
  avionics: AvionicsState;
  /** The internal fuel load (kg). */
  capacity: number;
  groundSpeed: number;
  position: { lat: number; lon: number; radius: number };
  track: number;
  heading: number;
  /** The gear does not retract (the helicopters'). */
  fixedGear: boolean;
  control: string;
  mouseFree: boolean;
  messages: SnapshotMessage[];
  sensors: SnapshotSensors | null;
}

/** The afterburner's stage (0 off, 1–5) from the lever, as the HUD shows it. */
export function afterburnerStage(f: Pick<HudFrame, 'afterburner' | 'throttle'>): number {
  if (f.afterburner <= 0.02 && f.throttle <= 0.81) return 0;
  return Math.max(1, Math.min(5, Math.ceil(((f.throttle - 0.82) / 0.18) * 5) || 1));
}

export function snapshotFromHud(f: HudFrame, x: SnapshotExtras): AircraftSnapshot {
  const hv = f.hover ?? null;
  const holds: string[] = [];
  for (const m of hv?.modes ?? []) {
    const t = m.toLowerCase();
    if (t === 'hover hold' || t === 'alt hold') holds.push(t);
  }
  return {
    time: x.time,
    kind: hv ? 'helicopter' : 'jet',
    name: x.name,
    profile: x.profile,
    avionics: x.avionics,
    onGround: f.onGround,
    position: x.position,
    destination: f.aid
      ? { label: `RWY ${f.aid.designator}`, bearing: f.aid.bearing, distance: f.aid.distance }
      : null,
    track: x.track,
    heading: x.heading,
    cas: f.cas,
    groundSpeed: x.groundSpeed,
    radarAltitude: f.radarAltitude,
    fuel: {
      mass: f.fuel,
      capacity: x.capacity,
      unlimited: f.unlimitedFuel,
      joker: JOKER_SHARE * x.capacity,
      bingo: BINGO_SHARE * x.capacity,
    },
    engine: {
      lever: hv ? Math.min(1, hv.torque) : f.throttle,
      power: hv ? Math.min(1.2, hv.torque) : f.power,
      afterburner: hv ? 0 : afterburnerStage(f),
    },
    gear: {
      position: f.gear,
      down: f.gearDown,
      fixed: x.fixedGear,
      overspeed: f.warnings.includes('gear-speed'),
      damaged: f.gearDamaged === true,
    },
    speedbrake: f.speedbrake,
    speedbrakeAngle: f.speedbrakeAngle,
    brakes: f.brakes,
    parkingBrake: f.parkingBrake,
    rotor: hv ? { torque: hv.torque, rpm: hv.rotorRpm, margin: Math.max(0, 1 - hv.torque) } : null,
    holds,
    control: x.control,
    mouseFree: x.mouseFree,
    messages: x.messages,
    sensors: x.sensors,
  };
}
