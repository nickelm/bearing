/**
 * Following a campaign flight (roadmap R2.4): the mode's glue on the main thread.
 *
 * *Follow* (from mission search, the map's selection panel or a subscription's
 * offer) cuts into the simulation view behind one aircraft of the mission, and the
 * chase camera settles in from a little further back (owner decision 12; the eased
 * dissolve through cloud is R6.6). The flight's aircraft are drawn from their
 * bundles' models (followFlight.ts for stand-ins), posed by their analytic route
 * (sim/air/analyticPose.ts) in formation; the HUD and the aircraft's own displays
 * show what that pose knows, read-only. Escape, M or the button returns to the map
 * above the flight. Nobody flies it from here: taking over is R2.5.
 *
 * The followed mission is looked up by id each frame, since the worker replaces
 * the mission list when it changes (an abort's new route, a loss). When the
 * mission ends or its last aircraft is lost, the view returns to the map.
 */
import type { PerspectiveCamera } from 'three/webgpu';
import { DEG, KNOT } from '../core/units';
import type { Meters } from '../core/units';
import { Quatd } from '../core/quat';
import { Vec3d } from '../core/vec3d';
import type { ModelSpec } from '../render/common/models/spec';
import { AircraftView } from '../render/sim/aircraft/aircraftView';
import type { AircraftPose } from '../render/sim/aircraft/aircraftView';
import { FAST_JET_RIG, rigFromBundle } from '../render/sim/camera/chaseCamera';
import type { ChaseRig } from '../render/sim/camera/chaseCamera';
import type { GlobeScene } from '../render/sim/globeScene';
import { MovingMap } from '../render/strategic/movingMap';
import type { StrategicScene } from '../render/strategic/strategicScene';
import { mapRange } from '../ui/displays/formats';
import type { AnalyticPose } from '../sim/air/analyticPose';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../sim/air/bundles';
import type { AircraftBundle } from '../sim/air/bundles';
import { missionPhase } from '../sim/air/mission';
import type { Mission } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { initialAvionics } from '../sim/avionics/avionics';
import { snapshotFromHud } from '../ui/displays/aircraftSnapshot';
import { DisplaySystem } from '../ui/displays/system';
import { Hud, matrixProjector } from '../ui/flight/hud';
import { PHASE_LABELS } from '../ui/missionSearch/model';
import {
  drawnAltitude,
  easeLift,
  flightPoses,
  followHudFrame,
  followedLook,
  gearDown,
  liftedPose,
} from './followFlight';
import type { FollowedLook } from './followFlight';
import { drawnType, spinningRotors } from './campaignTraffic';

export interface FollowDeps {
  canvas: HTMLCanvasElement;
  globe: GlobeScene;
  /** The map, which draws the moving map's picture (decision 201). */
  strategic: StrategicScene;
  radius: Meters;
  /** The live missions (replaced by the worker when the set changes). */
  missions: () => readonly Mission[];
  /** Switches the app's view (the simulation view to follow, the map on return). */
  setView: (v: 'simulation' | 'strategic') => void;
  /** Called after the view returned to the map: focus the map on the mission (if it still flies). */
  returned: (missionId: number, why: string | null) => void;
}

/** How long the chase camera takes to settle in from its start further back (s; owner decision 12). */
export const SETTLE_TIME = 2.5;
/** The zoom the settle starts from (the rig's distances times this). */
export const SETTLE_ZOOM = 2.6;

/** A drawn aircraft of the followed flight. */
interface Drawn {
  view: AircraftView;
  /** The drawn lift above the route's altitude (m), eased. */
  lift: number;
}

export class Follow {
  /** The mission followed, or null. */
  missionId: number | null = null;
  /** Which aircraft of the flight the camera follows (0: the lead). */
  slot = 0;
  readonly hud = new Hud();
  readonly displays = new DisplaySystem();
  private readonly bar: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private look: FollowedLook | null = null;
  private bundle: AircraftBundle | null = null;
  private spec: ModelSpec | null = null;
  private gearHeight = 2;
  private drawn: Drawn[] = [];
  private poses: AnalyticPose[] = [];
  private lastTime = NaN;
  private settle = 0;
  private displaysAt = -Infinity;
  private mapAt = -Infinity;
  private movingMap: MovingMap | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly detach: () => void;

  constructor(private readonly deps: FollowDeps) {
    this.bar = document.createElement('div');
    this.bar.className = 'follow-bar';
    this.bar.hidden = true;
    this.title = document.createElement('span');
    this.title.className = 'follow-title';
    const next = document.createElement('button');
    next.textContent = 'Next aircraft (N)';
    next.addEventListener('click', () => this.nextAircraft());
    const back = document.createElement('button');
    back.textContent = 'Map (Esc)';
    back.addEventListener('click', () => this.stop(null));
    this.bar.append(this.title, next, back);
    document.body.appendChild(this.bar);
    this.hud.show(false);
    this.displays.enabled = false;
    this.displays.visible = false;

    const canvas = deps.canvas;
    const key = (e: KeyboardEvent) => {
      if (this.missionId === null || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, select, textarea')) return;
      if (e.code === 'Escape' || e.code === 'KeyM') {
        e.preventDefault();
        this.stop(null);
      } else if (e.code === 'KeyN') this.nextAircraft();
      else if (e.code === 'KeyC') deps.globe.chase.recenter();
    };
    // Free look: drag with any button; the wheel moves the camera closer or farther.
    const down = (e: PointerEvent) => {
      if (this.missionId === null) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      deps.globe.chase.lookHeld = true;
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging || this.missionId === null) return;
      const rpp = (deps.globe.camera.fov * DEG) / Math.max(1, window.innerHeight);
      deps.globe.chase.look(e.clientX - this.lastX, e.clientY - this.lastY, rpp);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    const up = () => {
      this.dragging = false;
      deps.globe.chase.lookHeld = false;
    };
    const wheel = (e: WheelEvent) => {
      if (this.missionId === null) return;
      e.preventDefault();
      deps.globe.chase.zoomBy(Math.sign(e.deltaY));
    };
    window.addEventListener('keydown', key);
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    this.detach = () => {
      window.removeEventListener('keydown', key);
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }

  get active(): boolean {
    return this.missionId !== null;
  }

  /** Whether mission `m` can be followed at game time t: its flight has left the ground or is about to. */
  static followable(m: Readonly<Mission> | undefined, t: number): boolean {
    if (!m || m.aircraft <= 0) return false;
    const phase = missionPhase(m, t);
    return phase !== 'planned' && phase !== 'complete';
  }

  /** Cuts into the simulation view behind aircraft `slot` of mission `id`; false if it cannot. */
  start(id: number, t: number, slot = 0): boolean {
    const m = this.deps.missions().find((x) => x.id === id);
    if (!Follow.followable(m, t)) return false;
    this.clear();
    const b = bundleOfType(m!.aircraftType);
    const look = followedLook(b, AIRCRAFT_BUNDLES);
    const drawn = drawnType(m!.aircraftType);
    const spec = drawn.spec;
    this.gearHeight = drawn.gearHeight;
    this.missionId = id;
    this.slot = Math.min(slot, Math.max(0, m!.aircraft - 1));
    this.look = look;
    this.bundle = b;
    this.spec = spec;
    this.lastTime = NaN;
    const g = this.deps.globe;
    g.chase.rig = this.rig(look, spec);
    g.chase.stickyLook = true;
    g.cameraMode = 'chase';
    g.chase.resetView();
    this.settle = 0;
    g.chase.zoom = SETTLE_ZOOM;
    this.pose(m!, t);
    g.chase.reset();
    g.resetAtmosphere();
    this.deps.setView('simulation');
    this.hud.clearMessages();
    this.hud.show(true);
    this.displays.reset(!this.poses[0]!.airborne);
    this.displays.attach({ avionics: initialAvionics(!this.poses[0]!.airborne) });
    this.displays.visible = b.avionics !== null;
    this.displaysAt = -Infinity;
    this.bar.hidden = false;
    this.updateTitle(m!, t);
    return true;
  }

  /** Returns to the map; `why` says why if the mission ended rather than the player leaving. */
  stop(why: string | null): void {
    const id = this.missionId;
    if (id === null) return;
    this.clear();
    const g = this.deps.globe;
    g.chase.zoom = 1;
    g.cameraMode = 'observer';
    this.deps.setView('strategic');
    this.deps.returned(id, why);
  }

  /** Follows the next aircraft of the flight. */
  nextAircraft(): void {
    const m = this.mission();
    if (!m) return;
    this.slot = (this.slot + 1) % Math.max(1, m.aircraft);
  }

  /** Advances the follow by `dt` real seconds at game time t; call before the scene renders. */
  frame(dt: number, t: number): void {
    if (this.missionId === null) return;
    const m = this.mission();
    if (!m || missionPhase(m, t) === 'complete') {
      this.stop(m ? `${m.callsign} has landed` : 'The flight is gone');
      return;
    }
    if (m.aircraft <= 0) {
      this.stop(`${m.callsign} was lost`);
      return;
    }
    if (this.slot >= m.aircraft) this.slot = 0;
    // The settle: the camera eases in from further back over SETTLE_TIME.
    if (this.settle < 1) {
      this.settle = Math.min(1, this.settle + dt / SETTLE_TIME);
      const s = this.settle * this.settle * (3 - 2 * this.settle);
      this.deps.globe.chase.zoom = SETTLE_ZOOM + (1 - SETTLE_ZOOM) * s;
    }
    this.pose(m, t, dt);
    if (Math.floor(t) !== Math.floor(this.lastTime)) this.updateTitle(m, t);
    this.lastTime = t;
  }

  /** Draws the read-only HUD and the displays for the frame just rendered. */
  drawHud(camera: PerspectiveCamera, t: number): void {
    const m = this.mission();
    const p = this.poses[this.slot];
    if (!m || !p) return;
    const project = matrixProjector(
      camera.matrixWorldInverse.elements,
      camera.projectionMatrix.elements,
      window.innerWidth,
      window.innerHeight,
    );
    const agl = this.heightAboveGround(p);
    const down = gearDown(p, agl);
    const frame = followHudFrame({
      pose: p,
      fuel: Math.max(0, routeState(m.route, t, this.deps.radius).fuel),
      radarAltitude: agl,
      gear: down ? 1 : 0,
      gearDown: down,
      afterburner: 0,
    });
    this.updateDisplays(m, p, frame, agl, t);
    this.hud.draw(frame, project);
  }

  /** The chase rig: the type's (or its stand-in's), a helicopter's scaled by the drawn rotor. */
  private rig(look: FollowedLook, spec: ModelSpec): ChaseRig {
    if (!look.rig) return FAST_JET_RIG;
    if (look.rig.kind === 'helicopter') {
      const r = spec.rotors?.[0]?.radius ?? 7;
      return rigFromBundle(look.rig, r);
    }
    return rigFromBundle(look.rig);
  }

  private mission(): Mission | undefined {
    return this.missionId === null
      ? undefined
      : this.deps.missions().find((x) => x.id === this.missionId);
  }

  private ground(p: Readonly<AnalyticPose>): number | null {
    const g = this.deps.globe;
    if (!g.terrainReady) return null;
    const d = new Vec3d(p.pos[0], p.pos[1], p.pos[2]).normalize();
    return g.useTiles ? g.terrain.displaySurfaceAt(d) : g.terrain.displayHeightAt(d);
  }

  private heightAboveGround(p: Readonly<AnalyticPose>): number {
    return Math.max(0, p.altitude - Math.max(0, this.ground(p) ?? 0));
  }

  /** The flight's poses at t, lifted over the drawn ground, the views built, and the camera's target. */
  private pose(m: Mission, t: number, dt = 0): void {
    const raw = flightPoses(m, t, this.deps.radius);
    const g = this.deps.globe;
    while (this.drawn.length < raw.length) {
      const v = new AircraftView(this.spec!, [0, 0, 0], g.lighting);
      v.planetRadius = this.deps.radius;
      g.vehicles.add(v.group, v.shadowMesh);
      this.drawn.push({ view: v, lift: 0 });
    }
    this.poses = raw.map((p, k) => {
      const d = this.drawn[k]!;
      const target = drawnAltitude(p, this.ground(p), this.gearHeight) - Math.max(0, p.altitude);
      d.lift = dt > 0 && Number.isFinite(d.lift) ? easeLift(d.lift, target, dt) : target;
      return liftedPose(p, Math.max(0, p.altitude) + d.lift);
    });
    for (let k = 0; k < this.drawn.length; k++) {
      const visible = k < this.poses.length;
      this.drawn[k]!.view.group.visible = visible;
      this.drawn[k]!.view.shadowMesh.visible = visible;
    }
    const p = this.poses[this.slot] ?? this.poses[0]!;
    const c = g.chase.target;
    c.pos.set(p.pos[0], p.pos[1], p.pos[2]);
    c.forward.set(p.forward[0], p.forward[1], p.forward[2]);
    c.up.set(p.up[0], p.up[1], p.up[2]);
    c.velocity.set(p.velocity[0], p.velocity[1], p.velocity[2]);
    c.onGround = !p.airborne;
  }

  /** Places the drawn aircraft camera-relative for the frame about to be drawn (rule 4; the app's `beforeDraw`). */
  place(eye: Readonly<Vec3d>): void {
    if (this.missionId === null) return;
    const g = this.deps.globe;
    const rpp = (g.camera.fov * DEG) / Math.max(1, window.innerHeight);
    const rotors = this.spec ? spinningRotors(this.spec) : undefined;
    this.poses.forEach((p, k) => {
      const v = this.drawn[k]!.view;
      const pos = new Vec3d(p.pos[0], p.pos[1], p.pos[2]);
      const fwd = new Vec3d(p.forward[0], p.forward[1], p.forward[2]);
      const upv = new Vec3d(p.up[0], p.up[1], p.up[2]);
      const right = fwd.clone().cross(upv).normalize();
      const down = upv.clone().scale(-1);
      const agl = this.heightAboveGround(p);
      const gear = gearDown(p, agl) ? 1 : 0;
      const pose: AircraftPose = {
        pos,
        q: Quatd.fromAxes(fwd, right, down),
        elevator: 0,
        aileron: 0,
        rudder: 0,
        gear,
        speedbrake: 0,
        afterburner: 0,
        flaps: gear,
        groundHeight: Math.max(0, this.ground(p) ?? 0),
        rotors,
      };
      v.sun.copy(g.sun);
      v.radPerPixel = rpp;
      v.update(pose, eye);
    });
  }

  /** The master mode's triggers every frame; the displays at 10 Hz (decision 199), read-only. */
  private updateDisplays(
    m: Mission,
    p: AnalyticPose,
    frame: ReturnType<typeof followHudFrame>,
    agl: number,
    t: number,
  ): void {
    const b = this.bundle;
    if (!b?.avionics) return;
    const helicopter = this.look?.rig?.kind === 'helicopter';
    const changed = this.displays.triggers({
      onGround: !p.airborne,
      gearDown: frame.gearDown,
      radarAltitude: agl,
      groundSpeed: p.speed,
      helicopter,
    });
    const now = performance.now();
    if (!changed && now - this.displaysAt < 100) return;
    this.displaysAt = now;
    const d = Math.hypot(...p.pos);
    const snap = snapshotFromHud(frame, {
      time: t - m.timeline[0]!.time,
      name: `${m.callsign} · ${b.name}`,
      profile: b.avionics,
      avionics: this.displays.avionics,
      capacity: b.airWar?.fuel ?? m.route.fuel,
      groundSpeed: p.speed,
      position: {
        lat: Math.asin(Math.max(-1, Math.min(1, p.pos[1] / d))),
        lon: Math.atan2(p.pos[0], p.pos[2]),
        radius: this.deps.radius,
      },
      track: p.heading,
      heading: p.heading,
      fixedGear: helicopter,
      control: 'AI',
      mouseFree: false,
      messages: [],
      sensors: null,
    });
    this.displays.update(snap);
    this.requestMap(snap.position);
  }

  /** The moving map's picture every half second while a display shows it (as Free Flight's). */
  private requestMap(at: { lat: number; lon: number }): void {
    const d = this.displays.display;
    const skin = this.bundle?.avionics?.skin ?? 'alliance';
    if (!d) return;
    const shows = (['leftMfd', 'rightMfd'] as const).some(
      (s) => d.slots[s].format === 'moving-map' && d.slots[s].state === 'expanded',
    );
    const now = performance.now();
    if (!shows || now - this.mapAt < 500) return;
    this.mapAt = now;
    const half = mapRange(skin, d.map.range);
    const strategic = this.deps.strategic;
    this.movingMap ??= new MovingMap(strategic, strategic.gpu, 512);
    const id = this.missionId;
    void this.movingMap
      .picture(at.lat, at.lon, half * Math.SQRT2)
      .then((pic) => {
        if (pic && this.missionId === id)
          this.displays.view.setMapPicture({ ...pic, flipY: false });
      })
      .catch(() => {
        /* a lost device or a resize: the next picture tries again */
      });
  }

  private updateTitle(m: Mission, t: number): void {
    const phase = missionPhase(m, t);
    const label = phase === 'planned' ? 'planned' : PHASE_LABELS[phase];
    const who = m.aircraft > 1 ? ` · aircraft ${this.slot + 1} of ${m.aircraft}` : '';
    const stand = this.look?.standIn ? ' (stand-in model)' : '';
    const speed = Math.round((this.poses[this.slot]?.speed ?? 0) / KNOT);
    this.title.textContent = `Following ${m.callsign} · ${this.bundle?.name ?? m.aircraftType}${stand}${who} · ${label} · ${speed} kt`;
  }

  /** Removes the drawn flight, the HUD and the displays. */
  private clear(): void {
    const g = this.deps.globe;
    for (const d of this.drawn) {
      g.vehicles.remove(d.view.group, d.view.shadowMesh);
      d.view.dispose();
    }
    this.drawn = [];
    this.poses = [];
    this.missionId = null;
    this.hud.show(false);
    this.displays.visible = false;
    this.bar.hidden = true;
  }

  dispose(): void {
    this.clear();
    this.detach();
    this.bar.remove();
  }
}
