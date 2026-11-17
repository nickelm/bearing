/**
 * The sensor model (Proposal 0002, Sensors and Information; P3; decision 218): what
 * one aircraft knows of the others. Displays and the AI read its picture, never
 * ground truth (rule 12). Headless and deterministic: scans run on game time, and
 * the chance of a marginal detection is a hash of the target and the scan, not a
 * random draw (rule 5). Terrain enters only through the line-of-sight function the
 * host supplies (the execution layer may query terrain; rule 9 covers planning).
 *
 * - **Radar.** Detection range scales with the target's radar cross-section as the
 *   radar equation's fourth root, R = R₅ (σ / 5 m²)^¼, and with aspect for
 *   pulse-Doppler sets (a receding target is seen at 70%). The target must lie in
 *   the scan's azimuth and elevation limits and in line of sight. A pulse radar
 *   without look-down loses targets below the horizon in ground clutter; a
 *   pulse-Doppler set loses a target beaming it (closing speed under the notch).
 *   Range-while-search scans every 2 s and keeps contacts 6 s; track-while-scan
 *   every second, keeping them 4 s; single-target track follows only the locked
 *   contact, every 0.1 s, and drops it when it leaves the radar.
 * - **RWR.** An emitting radar is heard out to 1.5 times its own detection range
 *   for a 5 m² target, when its scan covers the aircraft and the line is clear:
 *   by bearing and kind, searching, tracking (locked on this aircraft) or launching.
 * - **Visual.** Out to 1,500 m per meter of the target's size by day (a quarter by
 *   night), never beyond the weather's visibility, in line of sight, all round.
 * - **Datalink.** Tracks from AWACS or ground control: positions as reported a
 *   delay ago, with an error, and the side they belong to.
 *
 * Contacts are keyed by the target's id: a simplification of correlation that the
 * campaign can revisit (the picture never carries more than a sensor saw).
 */
import type { Side } from '../../campaign/cast';
import { Vec3d } from '../../core/vec3d';

export type RadarKind = 'pulse' | 'pulse-doppler';
export type RadarMode = 'rws' | 'tws' | 'stt';

export interface RadarSpec {
  kind: RadarKind;
  /** Detection range against a 5 m² target (m). */
  range: number;
  /** Scan limits either side of the nose (rad); 2π all round for a ground radar. */
  azimuth: number;
  elevation: number;
  /** Pulse-Doppler only: closing speeds under this are lost in the notch (m/s). */
  notch: number;
}

export interface Emitter {
  radar: RadarSpec;
  /** What the threat display calls it ("29", "SA6"). */
  kind: string;
  /** Ground radars scan all round; airborne ones about their nose. */
  ground: boolean;
  state: 'search' | 'track' | 'launch';
  /** The aircraft it tracks, if any. */
  tracking: string | null;
}

/** Something the sensors may see: an aircraft or a site, as the world has it. */
export interface SensorTarget {
  id: string;
  side: Side;
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  /** Radar cross-section (m²) and visual size (m). */
  rcs: number;
  size: number;
  airborne: boolean;
  emitter: Emitter | null;
}

export interface OwnShip {
  id: string;
  side: Side;
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  /** Body axes (world, unit): the nose and the canopy's up. */
  forward: Readonly<Vec3d>;
  up: Readonly<Vec3d>;
  radar: RadarSpec | null;
  radarOn: boolean;
  radarMode: RadarMode;
  /** The contact single-target track follows. */
  lock: string | null;
  rwr: boolean;
  datalink: boolean;
}

export interface SensorEnv {
  /** Game time (s). */
  time: number;
  /** Visibility (m) and daylight (0 night … 1 day). */
  visibility: number;
  daylight: number;
  /** Whether nothing (terrain, the horizon) blocks the line between two points. */
  lineOfSight(a: Readonly<Vec3d>, b: Readonly<Vec3d>): boolean;
}

export type ContactSource = 'radar' | 'datalink' | 'visual';

export interface Contact {
  id: string;
  source: ContactSource;
  pos: [number, number, number];
  vel: [number, number, number];
  /** Game time of the last detection. */
  seen: number;
  /** The side, where the source knows it (datalink); null for an unknown radar or visual contact. */
  side: Side | null;
}

export interface Threat {
  id: string;
  kind: string;
  /** True bearing from the aircraft (rad, clockwise from north). */
  bearing: number;
  state: 'search' | 'track' | 'launch';
  ground: boolean;
}

export interface SensorPicture {
  time: number;
  contacts: Contact[];
  threats: Threat[];
}

/** A datalink's tracks: the targets it reports, its delay (s) and error (m). */
export interface DatalinkFeed {
  delay: number;
  error: number;
  targets: readonly SensorTarget[];
}

/** Scan period and how long a contact is kept without a detection, by mode (s). */
export const SCAN: Record<RadarMode, { period: number; coast: number }> = {
  rws: { period: 2, coast: 6 },
  tws: { period: 1, coast: 4 },
  stt: { period: 0.1, coast: 1 },
};

/** Range at which a radar of `spec` detects a target of `rcs` m², closing (`aspect` 1) or receding (0). */
export function detectionRange(spec: RadarSpec, rcs: number, aspect = 1): number {
  const base = spec.range * Math.pow(Math.max(rcs, 1e-4) / 5, 0.25);
  return spec.kind === 'pulse-doppler' ? base * (0.7 + 0.3 * aspect) : base;
}

/** A deterministic number in [0, 1) for a target and a scan (FNV-1a, then a mix). */
export function scanHash(id: string, scan: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ scan, 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const local = (p: Readonly<Vec3d>) => p.clone().normalize();

/** Azimuth and elevation of `to` from `from` in a frame of `fwd` and `up` (rad). */
function angles(
  from: Readonly<Vec3d>,
  to: Readonly<Vec3d>,
  fwd: Readonly<Vec3d>,
  up: Readonly<Vec3d>,
) {
  const d = to.clone().sub(from);
  const right = fwd.clone().cross(up).normalize();
  const x = d.dot(fwd);
  const y = d.dot(right);
  const z = d.dot(up);
  return { az: Math.atan2(y, x), el: Math.atan2(z, Math.hypot(x, y)), range: d.length() };
}

/** Whether `t` is in `radar`'s detection now, seen from `pos` with nose `fwd` and `up`. */
export function radarSees(
  radar: RadarSpec,
  pos: Readonly<Vec3d>,
  fwd: Readonly<Vec3d>,
  up: Readonly<Vec3d>,
  t: SensorTarget,
  env: SensorEnv,
  scan: number,
): boolean {
  // The air-to-air radar: ground targets wait for the air-to-ground radar (P3b).
  if (!t.airborne) return false;
  const a = angles(pos, t.pos, fwd, up);
  if (Math.abs(a.az) > radar.azimuth || Math.abs(a.el) > radar.elevation) return false;
  const los = t.pos.clone().sub(pos).normalize();
  const aspect = Math.max(0, -t.vel.dot(los) / Math.max(1, t.vel.length()));
  const R = detectionRange(radar, t.rcs, aspect);
  if (a.range > R) return false;
  // Below the horizon: clutter for a pulse set; the notch for pulse-Doppler.
  const depressed = los.dot(local(pos)) < 0 && t.airborne;
  if (radar.kind === 'pulse' && depressed) return false;
  if (radar.kind === 'pulse-doppler' && depressed) {
    const groundRelative = Math.abs(t.vel.dot(los));
    if (groundRelative < radar.notch) return false;
  }
  if (!env.lineOfSight(pos, t.pos)) return false;
  // Sure inside 85% of the range; a falling chance beyond.
  if (a.range < 0.85 * R) return true;
  return scanHash(t.id, scan) < (R - a.range) / (0.15 * R);
}

/** Whether an emitter at `t` illuminates `own`, and how the RWR hears it. */
export function rwrHears(own: OwnShip, t: SensorTarget, env: SensorEnv): Threat | null {
  const e = t.emitter;
  if (!e) return null;
  const d = own.pos.clone().sub(t.pos);
  if (d.length() > 1.5 * e.radar.range) return null;
  if (!e.ground) {
    // An airborne radar's scan about its velocity's direction.
    const fwd = t.vel.clone().normalize();
    const up = local(t.pos);
    const a = angles(t.pos, own.pos, fwd, up);
    if (Math.abs(a.az) > e.radar.azimuth || Math.abs(a.el) > e.radar.elevation) return null;
  }
  if (!env.lineOfSight(t.pos, own.pos)) return null;
  const up = local(own.pos);
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const to = t.pos.clone().sub(own.pos);
  const tracked = e.tracking === own.id;
  return {
    id: t.id,
    kind: e.kind,
    bearing: Math.atan2(to.dot(east), to.dot(north)),
    state: tracked ? e.state : 'search',
    ground: e.ground,
  };
}

/** Visual detection range of `t` (m). */
export function visualRange(t: SensorTarget, env: SensorEnv): number {
  const light = 0.25 + 0.75 * Math.max(0, Math.min(1, env.daylight));
  return Math.min(env.visibility, 1500 * t.size * light);
}

const arr = (v: Readonly<Vec3d>): [number, number, number] => [v.x, v.y, v.z];

/**
 * One aircraft's sensors over time: call `update` every step or frame with the world
 * as it is; `picture` is what the aircraft knows.
 */
export class SensorModel {
  readonly picture: SensorPicture = { time: 0, contacts: [], threats: [] };
  private readonly contacts = new Map<string, Contact>();
  private lastScan = -1;

  update(
    own: OwnShip,
    targets: readonly SensorTarget[],
    env: SensorEnv,
    feed: DatalinkFeed | null,
  ): void {
    const t = env.time;
    const radar = own.radarOn ? own.radar : null;
    const mode = own.radarMode === 'stt' && !own.lock ? 'tws' : own.radarMode;
    const scanTimes = SCAN[mode];
    const scan = Math.floor(t / scanTimes.period);
    const others = targets.filter((x) => x.id !== own.id);
    const coast = Math.max(scanTimes.coast, 3);
    if (radar && scan !== this.lastScan) {
      this.lastScan = scan;
      for (const x of others) {
        if (mode === 'stt' && x.id !== own.lock) continue;
        if (radarSees(radar, own.pos, own.forward, own.up, x, env, scan))
          this.see(x, 'radar', t, null);
      }
    }
    // Visual: all round, every update.
    for (const x of others) {
      const r = x.pos.clone().sub(own.pos).length();
      if (r <= visualRange(x, env) && env.lineOfSight(own.pos, x.pos))
        this.see(x, 'visual', t, null);
    }
    // Datalink: positions a delay ago, with an error, and the side.
    if (own.datalink && feed) {
      for (const x of feed.targets) {
        if (x.id === own.id) continue;
        const prior = this.contacts.get(x.id);
        // An own-sensor contact keeps its source while it coasts; the datalink adds the side.
        if (prior && prior.source !== 'datalink' && t - prior.seen <= coast) {
          prior.side = x.side;
          continue;
        }
        const seed = Math.floor(t / 4);
        const err = new Vec3d(
          scanHash(x.id, seed * 3) - 0.5,
          scanHash(x.id, seed * 3 + 1) - 0.5,
          scanHash(x.id, seed * 3 + 2) - 0.5,
        ).scale(2 * feed.error);
        const pos = x.pos.clone().addScaled(x.vel, -feed.delay).add(err);
        this.contacts.set(x.id, {
          id: x.id,
          source: 'datalink',
          pos: arr(pos),
          vel: arr(x.vel),
          seen: t - feed.delay,
          side: x.side,
        });
      }
    }
    // Contacts not seen for their coast time are dropped.
    for (const [id, c] of this.contacts)
      if (t - c.seen > coast + (c.source === 'datalink' ? 8 : 0)) this.contacts.delete(id);
    const threats: Threat[] = [];
    if (own.rwr)
      for (const x of others) {
        const h = rwrHears(own, x, env);
        if (h) threats.push(h);
      }
    this.picture.time = t;
    this.picture.contacts = [...this.contacts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    this.picture.threats = threats.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  private see(x: SensorTarget, source: ContactSource, t: number, side: Side | null): void {
    const prior = this.contacts.get(x.id);
    this.contacts.set(x.id, {
      id: x.id,
      // Radar outranks visual, which outranks datalink, for the same target this instant.
      source:
        prior && prior.seen === t && rank(prior.source) > rank(source) ? prior.source : source,
      pos: arr(x.pos),
      vel: arr(x.vel),
      seen: t,
      side: side ?? prior?.side ?? null,
    });
  }

  reset(): void {
    this.contacts.clear();
    this.lastScan = -1;
    this.picture.contacts = [];
    this.picture.threats = [];
  }
}

const rank = (s: ContactSource) => (s === 'radar' ? 2 : s === 'visual' ? 1 : 0);
