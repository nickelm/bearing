/**
 * The aircraft snapshot (decision 199): the only thing formats and the strip
 * read. Plain, structured-clone-able data, built once per display update for
 * the flown or followed aircraft, from what that aircraft and its crew know
 * (rule 12). Free Flight builds it from the HUD's frame (freeflight/snapshot.ts).
 */
import type { AvionicsState } from '../../sim/avionics/avionics';
import type { AvionicsProfile } from '../../sim/avionics/profiles';
import type { GroundMapImage } from '../../sim/sensors/groundMap';

export interface SnapshotMessage {
  /** Seconds since the flight began. */
  at: number;
  text: string[];
  warn: boolean;
}

/** A contact as the displays draw it: relative to the aircraft (decision 218). */
export interface SnapshotContact {
  id: string;
  source: 'radar' | 'datalink' | 'visual';
  /** Slant range (m); azimuth and elevation off the nose (rad, + right and up). */
  range: number;
  azimuth: number;
  elevation: number;
  altitude: number;
  /** Its heading (true, rad) and speed (m/s); closing speed (m/s, + closing). */
  heading: number;
  speed: number;
  closing: number;
  side: 'alliance' | 'pact' | null;
  locked: boolean;
}

export interface SnapshotThreat {
  id: string;
  kind: string;
  /** Bearing off the nose (rad, + right). */
  azimuth: number;
  state: 'search' | 'track' | 'launch';
  ground: boolean;
}

export interface SnapshotSensors {
  /** The air-to-air radar, if carried: power, mode, display range (nm), scan limits (rad). */
  radar: {
    on: boolean;
    mode: 'rws' | 'tws' | 'stt' | 'acm';
    /** The display range (m): a step in the skin's units, 10 nm in air combat mode (decision 223). */
    range: number;
    lock: string | null;
    azimuth: number;
    elevation: number;
  } | null;
  contacts: SnapshotContact[];
  threats: SnapshotThreat[];
  /** The air-to-ground radar's latest ground map, and its age (s); null without one (decision 226). */
  groundMap?: (GroundMapImage & { age: number }) | null;
}

export interface AircraftSnapshot {
  /** Seconds since the flight began. */
  time: number;
  kind: 'jet' | 'helicopter';
  name: string;
  profile: AvionicsProfile;
  avionics: AvionicsState;
  onGround: boolean;
  /** Where the aircraft is (its navigation system knows it): latitude and longitude (rad). */
  position: { lat: number; lon: number; radius: number };
  /** Where the aircraft is going: a label, the true bearing (rad) and the distance (m); null if nowhere. */
  destination: { label: string; bearing: number; distance: number } | null;
  /** Track over the ground and heading (rad from north, clockwise). */
  track: number;
  heading: number;
  /** Calibrated airspeed, ground speed (m/s), radar altitude (m). */
  cas: number;
  groundSpeed: number;
  radarAltitude: number;
  fuel: {
    /** kg; capacity is the internal load. */
    mass: number;
    capacity: number;
    unlimited: boolean;
    /** Joker and bingo (kg): Free Flight's defaults until missions set them. */
    joker: number;
    bingo: number;
  };
  engine: {
    /** Throttle lever 0..1, engine power 0..1, afterburner stage 0 (off) to 5. */
    lever: number;
    power: number;
    afterburner: number;
  };
  /** `fixed`: gear that does not retract (skids, a helicopter's wheels). */
  /** `damaged`: the doors failed in an overspeed, the gear stuck down (decision 207). */
  gear: { position: number; down: boolean; fixed: boolean; overspeed: boolean; damaged?: boolean };
  speedbrake: number;
  /** The speedbrake's deflection (rad), shown on its strip item (decision 207). */
  speedbrakeAngle?: number;
  brakes: boolean;
  parkingBrake: boolean;
  /** Helicopters: torque and rotor speed (fractions of their 100%), power margin (−1..1). */
  rotor: { torque: number; rpm: number; margin: number } | null;
  /** Control-layer modes that are on: hover hold, altitude hold. */
  holds: string[];
  /** How the mouse flies: 'mouse aim', 'direct', 'fly-by-mouse', 'autopilot'. */
  control: string;
  /** The mouse is free (cursor mode) while flying. */
  mouseFree: boolean;
  messages: SnapshotMessage[];
  /** The sensor picture (decision 218); null where nothing is sensed (no traffic). */
  sensors: SnapshotSensors | null;
}
