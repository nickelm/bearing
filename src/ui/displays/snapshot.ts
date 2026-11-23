/**
 * The aircraft snapshot (decision 199): the only thing formats and the strip
 * read. Plain, structured-clone-able data, built once per display update for
 * the flown or followed aircraft, from what that aircraft and its crew know
 * (rule 12). It is built from the HUD's frame (ui/displays/aircraftSnapshot.ts, R1.5).
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

/**
 * Heights around the aircraft for the moving map's elevation modes (decision 227): `n` × `n`
 * samples covering ±`halfExtent` m in the map's own frame (turned by `rotation`, the track in
 * track-up), row 0 at the top; water marked apart. `altitude` is the aircraft's (m).
 */
export interface SnapshotTerrain {
  n: number;
  halfExtent: number;
  /** How far ahead of the aircraft (m, up the map) the samples are centered: a depressed map's (decision 310). */
  ahead?: number;
  rotation: number;
  heights: number[];
  water: number[];
  altitude: number;
}

/** What hangs on the pylons (decision 289): the stores format reads it. */
export interface SnapshotStores {
  /** Every station of the loadout, left wing to right: where it is across (m, + right), what it carries. */
  stations: { station: string; z: number; store: string; label: string; loaded: boolean }[];
  /** The weapons aboard in loadout order: store id, label, how many are left, their master mode. */
  weapons: { id: string; label: string; count: number; mode: 'air-to-air' | 'air-to-ground' }[];
  /** Drop tanks still hanging and the fuel in them (kg). */
  tanks: number;
  tankFuel: number;
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
    /**
     * Joker, bingo and low fuel (kg; decision 307): on a mission from its route (fuel to get
     * home plus the reserve, and a fight's more for joker), in Free Flight shares of the load.
     */
    joker: number;
    bingo: number;
    low: number;
    /** All the fuel aboard, drop tanks included (kg), which the three are compared with; `mass` if absent. */
    total?: number;
  };
  engine: {
    /** Throttle lever 0..1, engine power 0..1, afterburner stage 0 (off) to 5. */
    lever: number;
    power: number;
    afterburner: number;
    /** False for an engine without an afterburner (decision 319); absent: one is fitted. */
    afterburnerFitted?: boolean;
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
  /** Terrain for the moving map's elevation modes, while one shows (decision 227). */
  terrain?: SnapshotTerrain | null;
  /** The stores on the pylons (decision 289); absent or null without a stores rack. */
  stores?: SnapshotStores | null;
  /** The mission's flight plan (decision 305); absent or null without one (Free Flight). */
  route?: SnapshotRoute | null;
  /** The fronts near the aircraft (decision 305), for the moving map's elevation modes. */
  fronts?: SnapshotFront[] | null;
  /** The other aircraft of its own flight by the intraflight datalink (decision 308). */
  flight?: SnapshotFlightMate[] | null;
}

/**
 * Another aircraft of the aircraft's own flight (decision 308): its place in the flight (1,
 * the lead, to 4), where it is off the nose (range m; azimuth and elevation rad, + right and
 * up), its altitude (m), true heading (rad), and its bearing and distance for the map.
 */
export interface SnapshotFlightMate {
  number: number;
  range: number;
  azimuth: number;
  elevation: number;
  altitude: number;
  heading: number;
  at: MapBearing;
}

/** A place relative to the aircraft: its true bearing (rad) and its distance over the ground (m). */
export type MapBearing = [bearing: number, distance: number];

/**
 * The flight plan as the navigation system holds it (decision 305): its waypoints in
 * order, where each is from the aircraft, and the legs between them as samples at most
 * ROUTE_STEP apart (legs[i] runs from waypoint i to i + 1).
 */
export interface SnapshotRoute {
  waypoints: { number: number; kind: string; label: string; at: MapBearing }[];
  /** The waypoint steered to, or −1 when every one is passed. */
  next: number;
  /** The pilot chose it by hand (decision 310); else the navigation system sequences. */
  manual?: boolean;
  legs: MapBearing[][];
}

/**
 * A front line near the aircraft (decision 305): samples along it, its teeth's side (+1 on
 * its left looking along the samples, −1 on its right: the attacker's side, as on the
 * strategic map) and the attacker's color (CSS).
 */
export interface SnapshotFront {
  points: MapBearing[];
  teeth: 1 | -1;
  color: string;
}
