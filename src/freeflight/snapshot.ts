/**
 * Free Flight's aircraft snapshot for the displays and the strip (decision
 * 199), built from the HUD's frame, which already carries every state they
 * read, so the flight model is read in one place. Joker and bingo are Free
 * Flight's defaults (35% and 20% of the internal fuel) until missions set them.
 */
import type { AvionicsState } from '../sim/avionics/avionics';
import type { AvionicsProfile } from '../sim/avionics/profiles';
import type { HudFrame } from '../ui/flight/hud';
import type { AircraftSnapshot, SnapshotMessage } from '../ui/displays/snapshot';

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
    },
    speedbrake: f.speedbrake,
    brakes: f.brakes,
    parkingBrake: f.parkingBrake,
    rotor: hv ? { torque: hv.torque, rpm: hv.rotorRpm, margin: Math.max(0, 1 - hv.torque) } : null,
    holds,
    control: x.control,
    mouseFree: x.mouseFree,
    messages: x.messages,
  };
}
