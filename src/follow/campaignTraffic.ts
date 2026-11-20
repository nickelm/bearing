/**
 * The campaign's aircraft in the simulation view (roadmap R2.4): every live flight
 * within TRAFFIC_RANGE of the camera, posed from its analytic route in formation
 * (followFlight.ts) and lifted over the drawn ground as the followed flight is.
 *
 * Level of detail: aircraft within NEAR_RANGE get full views (AircraftView: ink,
 * shadow, gear), at most MAX_NEAR of them, nearest first; the rest are instanced by
 * model (TrafficLayer). The followed flight is drawn by Follow and left out here.
 * Both sides' aircraft show: the view is the world, not a side's picture.
 */
import { DEG } from '../core/units';
import type { Meters } from '../core/units';
import { Quatd } from '../core/quat';
import { Vec3d } from '../core/vec3d';
import { buildModel } from '../render/common/models/builder';
import { modelSpec } from '../render/common/models/library';
import type { ModelSpec } from '../render/common/models/spec';
import { AircraftView } from '../render/sim/aircraft/aircraftView';
import type { RotorPose } from '../render/sim/aircraft/aircraftView';
import { TrafficLayer } from '../render/sim/aircraft/trafficLayer';
import type { TrafficAircraft } from '../render/sim/aircraft/trafficLayer';
import type { GlobeScene } from '../render/sim/globeScene';
import type { AnalyticPose } from '../sim/air/analyticPose';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../sim/air/bundles';
import { missionPhase } from '../sim/air/mission';
import { missionPlugin } from '../sim/command/missions/registry';
import type { Mission } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { drawnAltitude, flightPoses, followedLook, gearDown, liftedPose } from './followFlight';
import type { AirfieldShift } from './followFlight';

/** Flights whose lead is within this distance of the camera are drawn (m). */
export const TRAFFIC_RANGE: Meters = 25_000;
/** Aircraft within this distance get full views, and keep them out to NEAR_KEEP (m). */
export const NEAR_RANGE: Meters = 1_500;
export const NEAR_KEEP: Meters = 2_000;
export const MAX_NEAR = 6;

/** A type's drawn model, its scheme and the height of its reference point over its wheels. */
export interface DrawnType {
  spec: ModelSpec;
  scheme: string | null;
  gearHeight: number;
  /** Wingspan of the drawn model (m): formations space by it. */
  span: number;
}

const types = new Map<string, DrawnType>();

/** The drawn model of an air-war type (cached): its own or its stand-in (followFlight.ts). */
export function drawnType(typeId: string): DrawnType {
  let d = types.get(typeId);
  if (d) return d;
  const look = followedLook(bundleOfType(typeId), AIRCRAFT_BUNDLES);
  const base = modelSpec(look.drawn);
  const spec: ModelSpec = look.scheme ? { ...base, scheme: look.scheme } : base;
  const built = buildModel(spec, { noAo: true });
  let minY = Infinity;
  let maxZ = 0;
  for (let i = 0; i < built.position.length; i += 3) {
    minY = Math.min(minY, built.position[i + 1]!);
    maxZ = Math.max(maxZ, Math.abs(built.position[i + 2]!));
  }
  d = {
    spec,
    scheme: look.scheme,
    gearHeight: Number.isFinite(minY) ? Math.max(0.5, -minY) : 2,
    span: Math.max(4, 2 * maxZ),
  };
  types.set(typeId, d);
  return d;
}

/** Rotors and propellers turning at governed speed: their discs show (helicopters, the C-150). */
export function spinningRotors(
  spec: ModelSpec,
  nowMs = performance.now(),
): RotorPose[] | undefined {
  if (!spec.rotors?.length) return undefined;
  return spec.rotors.map((r, i) => ({
    // Main rotors about 5 turns a second, the others (tail rotors, propellers) 20.
    azimuth: (nowMs / 1000) * 2 * Math.PI * (i === 0 && Math.abs(r.axis?.[1] ?? 1) > 0.7 ? 5 : 20),
    speed: 1,
    tiltForward: 0,
    tiltRight: 0,
  }));
}

interface Near {
  view: AircraftView;
  seen: boolean;
}

/** One aircraft of a nearby flight, posed for the frame. */
interface Placed {
  key: string;
  type: DrawnType;
  pose: AnalyticPose;
  ground: number;
  distance: number;
}

export class CampaignTraffic {
  /** The followed mission, drawn by Follow. */
  exclude: number | null = null;
  /** The airbases' coarse and sited places (decision 253). */
  fields: readonly AirfieldShift[] = [];
  enabled = true;
  readonly layer: TrafficLayer;
  private readonly near = new Map<string, Near>();
  private placed: Placed[] = [];

  constructor(
    private readonly globe: GlobeScene,
    private readonly radius: Meters,
    private readonly missions: () => readonly Mission[],
  ) {
    this.layer = new TrafficLayer(globe.lighting);
    globe.vehicles.add(this.layer.group);
  }

  /** Aircraft drawn last frame: full views and instanced. */
  get stats(): { near: number; instanced: number } {
    let near = 0;
    for (const n of this.near.values()) if (n.seen) near++;
    return { near, instanced: this.layer.stats.aircraft };
  }

  private groundAt(d: Readonly<Vec3d>): number | null {
    const g = this.globe;
    if (!g.terrainReady) return null;
    return g.useTiles ? g.terrain.displaySurfaceAt(d, false) : g.terrain.displayHeightAt(d);
  }

  /** Game time of the frame about to be drawn. */
  time = 0;

  /** Poses the flights near `eye` at `time`. */
  private pose(eye: Readonly<Vec3d>): void {
    const t = this.time;
    this.placed = [];
    if (!this.enabled) return;
    const e = eye.clone().normalize();
    const reach = TRAFFIC_RANGE / this.radius;
    const dir = new Vec3d();
    for (const m of this.missions()) {
      if (m.id === this.exclude || m.aircraft <= 0) continue;
      const phase = missionPhase(m, t);
      if (phase === 'planned' || phase === 'complete') continue;
      const s = routeState(m.route, t, this.radius);
      dir.set(s.point[0], s.point[1], s.point[2]);
      if (Math.acos(Math.max(-1, Math.min(1, dir.dot(e)))) > reach) continue;
      const type = drawnType(m.aircraftType);
      flightPoses(
        m,
        t,
        this.radius,
        this.fields,
        missionPlugin(m.type).formations,
        type.span,
      ).forEach((p, k) => {
        const d = new Vec3d(p.pos[0], p.pos[1], p.pos[2]).normalize();
        const ground = this.groundAt(d);
        const lifted = liftedPose(p, drawnAltitude(p, ground, type.gearHeight));
        const distance = Math.hypot(
          lifted.pos[0] - eye.x,
          lifted.pos[1] - eye.y,
          lifted.pos[2] - eye.z,
        );
        this.placed.push({
          key: `${m.id}:${k}`,
          type,
          pose: lifted,
          ground: Math.max(0, ground ?? 0),
          distance,
        });
      });
    }
    this.placed.sort((a, b) => a.distance - b.distance);
  }

  /** Places the views and instances camera-relative for the frame about to be drawn (rule 4). */
  place(eye: Readonly<Vec3d>): void {
    this.pose(eye);
    const g = this.globe;
    const rpp = (g.camera.fov * DEG) / Math.max(1, window.innerHeight);
    for (const n of this.near.values()) n.seen = false;
    const far: TrafficAircraft[] = [];
    let near = 0;
    for (const a of this.placed) {
      const kept = this.near.get(a.key);
      const close = a.distance < (kept ? NEAR_KEEP : NEAR_RANGE) && near < MAX_NEAR;
      const gear = gearDown(a.pose, Math.max(0, a.pose.altitude - a.ground));
      if (!close) {
        far.push({
          spec: a.type.spec,
          scheme: a.type.scheme,
          gearDown: gear,
          pos: a.pose.pos,
          forward: a.pose.forward,
          up: a.pose.up,
        });
        continue;
      }
      near++;
      let n = kept;
      if (!n) {
        const v = new AircraftView(a.type.spec, [0, 0, 0], g.lighting);
        v.planetRadius = this.radius;
        g.vehicles.add(v.group, v.shadowMesh);
        n = { view: v, seen: true };
        this.near.set(a.key, n);
      }
      n.seen = true;
      const p = a.pose;
      const fwd = new Vec3d(p.forward[0], p.forward[1], p.forward[2]);
      const up = new Vec3d(p.up[0], p.up[1], p.up[2]);
      const right = fwd.clone().cross(up).normalize();
      n.view.sun.copy(g.sun);
      n.view.radPerPixel = rpp;
      n.view.update(
        {
          pos: new Vec3d(p.pos[0], p.pos[1], p.pos[2]),
          q: Quatd.fromAxes(fwd, right, up.clone().scale(-1)),
          elevator: 0,
          aileron: 0,
          rudder: 0,
          gear: gear ? 1 : 0,
          speedbrake: 0,
          afterburner: 0,
          flaps: gear ? 1 : 0,
          groundHeight: a.ground,
          rotors: spinningRotors(a.type.spec),
        },
        eye,
      );
    }
    // Views of aircraft that left the near range go; the instances take them.
    for (const [key, n] of this.near) {
      if (n.seen) continue;
      g.vehicles.remove(n.view.group, n.view.shadowMesh);
      n.view.dispose();
      this.near.delete(key);
    }
    this.layer.update(far, eye);
  }

  /** Removes every view and instance (the world changes). */
  clear(): void {
    for (const n of this.near.values()) {
      this.globe.vehicles.remove(n.view.group, n.view.shadowMesh);
      n.view.dispose();
    }
    this.near.clear();
    this.placed = [];
    this.layer.update([], new Vec3d());
  }
}
