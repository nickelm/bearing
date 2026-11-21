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
 * above the flight.
 *
 * Full fidelity (R2.5): a flight whose type has fixed-wing flight data is promoted
 * inside its jump-in window (fullFidelity.ts): its aircraft are flown by AI pilots
 * through the flight model over the drawn ground (Free Flight's `AirfieldGround`),
 * drawn from their airframes with their control surfaces, afterburner and speedbrake,
 * and the HUD and displays are built from the followed airframe. At the approach (or
 * when the clock runs faster than the flight cap) the flight is demoted again, and the
 * drawn aircraft ease back onto their routes.
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
import { FAST_JET_RIG, followAirframe, rigFromBundle } from '../render/sim/camera/chaseCamera';
import { modelSpec } from '../render/common/models/library';
import type { ChaseRig } from '../render/sim/camera/chaseCamera';
import type { GlobeScene } from '../render/sim/globeScene';
import { MovingMap } from '../render/strategic/movingMap';
import type { HeldFlight } from '../render/strategic/overlays/airModel';
import type { StrategicScene } from '../render/strategic/strategicScene';
import { mapRange } from '../ui/displays/formats';
import type { AnalyticPose } from '../sim/air/analyticPose';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../sim/air/bundles';
import type { AircraftBundle } from '../sim/air/bundles';
import { jumpInOpen, missionPhase } from '../sim/air/mission';
import { carrierState } from '../sim/naval/carrierGroup';
import type { CarrierTrack } from '../sim/naval/carrierGroup';
import { missionPlugin } from '../sim/command/missions/registry';
import type { Mission } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { initialAvionics } from '../sim/avionics/avionics';
import { snapshotFromHud, storesSnapshot } from '../ui/displays/aircraftSnapshot';
import type { SnapshotStores } from '../ui/displays/snapshot';
import { flightFuel } from '../sim/flight/promotion';
import { storesEffect } from '../sim/flight/storesRack';
import { DisplaySystem } from '../ui/displays/system';
import { Hud, matrixProjector } from '../ui/flight/hud';
import type { HudFrame } from '../ui/flight/hud';
import { buildHudFrame, gunHud, landingAid } from '../ui/flight/hudFrame';
import type { ControlCursor } from '../ui/flight/controlCursor';
import { FlightInput, STICK_DEADZONE, STICK_FULL } from '../ui/flight/flightInput';
import type { FlightAction } from '../ui/flight/flightInput';
import { MouseCapture } from '../ui/flight/mouseCapture';
import { aimDirection, flyMouseAim } from '../ui/flight/mouseAim';
import { FlightDirector } from '../sim/flight/flightDirector';
import type { CampaignInputEvent } from '../sim/eventLog';
import type { WeatherView } from '../sim/weather/frame';
import { flightRateCap } from '../sim/clock';
import type { FlightModel } from '../sim/flight/flightModel';
import type { FlightSpec } from '../sim/flight/flightSpec';
import type { Runway } from '../sim/flight/runway';
import { flownGround } from '../freeflight/ground';
import type { AirfieldGround, FlownTerrain } from '../freeflight/ground';
import { FullFidelity, flightSpecOfType, fullFidelityWanted } from './fullFidelity';
import { PHASE_LABELS } from '../ui/missionSearch/model';
import {
  drawnAltitude,
  drawnLeadPose,
  easeLift,
  flightPoses,
  followHudFrame,
  followedLook,
  gearDown,
  liftedPose,
} from './followFlight';
import type { AirfieldShift, FollowedLook } from './followFlight';
import { carrierFields, drawnGround } from './followFlight';
import { ReleasedStores } from '../render/sim/aircraft/releasedStores';
import { Tracers } from '../render/sim/aircraft/tracers';
import { STORES } from '../sim/air/stores';
import type { StationLoad } from '../sim/air/stores';
import { drawnType, flightStores, loadedOf, spinningRotors } from './campaignTraffic';

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
  /** The campaign clock's rate (game seconds per real second). */
  rate: () => number;
  /** The campaign's weather (the worker's frames), for the wind at full fidelity. */
  weather?: () => WeatherView | null;
  /** Posts a player input to the campaign (logged in the worker; R1.4). */
  post: (input: CampaignInputEvent) => void;
}

/** How long the worker has to hold a taken-over flight before the take-over counts as refused (ms). */
export const HOLD_WAIT = 3000;
/** How long after the flown aircraft crashes the controls go back to the AI (ms). */
export const CRASH_HANDBACK = 3000;

/** Time constant (s) of the drawn aircraft's ease back onto their routes after a demotion. */
export const DEMOTION_BLEND = 1.5;

/** How long the chase camera takes to settle in from its start further back (s; owner decision 12). */
export const SETTLE_TIME = 2.5;
/** The zoom the settle starts from (the rig's distances times this). */
export const SETTLE_ZOOM = 2.6;

/**
 * What the followed view shows besides the aircraft (decision 253): the HUD alone (the
 * default for spectating), the HUD with the aircraft's displays (the flown view), or
 * nothing but the scene. V steps through them; the choice holds from one follow to the next.
 */
export type FollowPanels = 'hud' | 'all' | 'clean';
export const FOLLOW_PANELS: readonly FollowPanels[] = ['hud', 'all', 'clean'];
const PANEL_LABELS: Record<FollowPanels, string> = {
  hud: 'HUD',
  all: 'HUD and displays',
  clean: 'clean',
};

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
  /** The airbases' coarse and sited places (decision 253). */
  fields: readonly AirfieldShift[] = [];
  /** The carrier groups' tracks: a carrier flight stands on its deck (decision 255). */
  carriers: readonly CarrierTrack[] = [];
  readonly hud = new Hud();
  readonly displays = new DisplaySystem();
  /** What shows besides the scene (V). */
  panels: FollowPanels = 'hud';
  private readonly bar: HTMLDivElement;
  private readonly panelsButton: HTMLButtonElement;
  private readonly takeButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  /** The mouse's pointer lock (rule 14) and Free Flight's input bindings for a taken-over jet. */
  readonly capture: MouseCapture;
  readonly input: FlightInput;
  private readonly director = new FlightDirector();
  /** Mouse aim has the stick once the mouse has been captured this session (decision 206). */
  private aimEngaged = false;
  /** When the player took over (ms), until the worker's hold shows in the mission. */
  private takenAt: number | null = null;
  /** When the flown aircraft crashed (ms), or null. */
  private crashedAt: number | null = null;
  private readonly title: HTMLSpanElement;
  /** The flight model's ground and the sited runways (R2.5), once the terrain is ready. */
  private airfield: AirfieldGround | null = null;
  private runways: Runway[] = [];
  /** The followed type's fixed-wing flight data, or null: it flies analytically. */
  private flightSpec: FlightSpec | null = null;
  /** The followed flight at full fidelity, or null. */
  private full: FullFidelity | null = null;
  /** After a demotion: each slot's offset from its route (m, world), easing out, and its age (s). */
  private blend: Map<number, Vec3d> | null = null;
  private blendAge = 0;
  private look: FollowedLook | null = null;
  private bundle: AircraftBundle | null = null;
  private spec: ModelSpec | null = null;
  private gearHeight = 2;
  private span = 10;
  private clearance = 90;
  private drawn: Drawn[] = [];
  /** Stores falling from the flight (decision 294), and what each aircraft hung last frame. */
  private released: ReleasedStores | null = null;
  private readonly hung = new Map<
    number,
    { loads: StationLoad[]; tankFuel: number; tanks: number }
  >();
  private fallTime = 0;
  /** The flight's gun tracers (decision 295). */
  private tracers: Tracers | null = null;
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
    this.nextButton = next;
    this.takeButton = document.createElement('button');
    this.takeButton.hidden = true;
    this.takeButton.addEventListener('click', () => this.toggleControl());
    this.panelsButton = document.createElement('button');
    this.panelsButton.addEventListener('click', () => this.nextPanels());
    const back = document.createElement('button');
    back.textContent = 'Map (Esc)';
    back.addEventListener('click', () => this.stop(null));
    this.bar.append(this.title, next, this.takeButton, this.panelsButton, back);
    document.body.appendChild(this.bar);
    this.hud.show(false);
    this.displays.enabled = false;
    this.displays.readOnly = true;
    this.displays.visible = false;

    const canvas = deps.canvas;
    // Taking over: the jet's bindings, mouse aim and the one pointer lock (rule 14).
    this.capture = new MouseCapture(canvas);
    this.capture.onChange = (on) => {
      if (!this.flying) return;
      if (on) this.aimEngaged = true;
      if (this.input.mode === 'direct') this.input.centerCursor();
    };
    this.capture.onLost = () => {
      if (this.flying)
        this.hud.message('Mouse free: Tab or a click on the view to fly, T hands back', 3);
    };
    this.capture.onRefused = () =>
      this.hud.message('The browser kept the mouse: click the view to capture it', 4);
    this.input = new FlightInput(canvas, this.capture);
    this.input.mode = 'mouse-aim';
    this.input.onAction = (a) => this.action(a);
    // The strip's and the formats' buttons for the controls, as the keys (decision 287's jettison).
    this.displays.onControls = (a) => {
      if (a === 'jettisonTanks') this.action('jettison');
      else if (a !== 'hoverHold') this.action(a);
    };
    const key = (e: KeyboardEvent) => {
      if (this.missionId === null || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, select, textarea')) return;
      if (e.code === 'KeyT') {
        e.preventDefault();
        this.toggleControl();
        return;
      }
      // While the player flies the jet's bindings have the keys (FlightInput, the displays).
      if (this.flying) return;
      if (e.code === 'Escape' || e.code === 'KeyM') {
        e.preventDefault();
        this.stop(null);
      } else if (e.code === 'KeyN') this.nextAircraft();
      else if (e.code === 'KeyC') deps.globe.chase.recenter();
      else if (e.code === 'KeyV') this.nextPanels();
    };
    // Free look: drag with any button; the wheel moves the camera closer or farther.
    const down = (e: PointerEvent) => {
      if (this.missionId === null || this.flying) return;
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
      if (this.missionId === null || this.flying) return;
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

  /** Whether the player flies one of the followed flight's aircraft. */
  get flying(): boolean {
    return this.full?.flight.playerSlot != null;
  }

  /**
   * The flight the player flies (or the worker still holds), where its lead is, for the
   * map and the moving map (decision 284); null otherwise.
   */
  heldFlight(): HeldFlight | null {
    const m = this.mission();
    const f = this.full;
    if (!m || !f || (!this.flying && !m.flown)) return null;
    const a = f.flight.alive[0];
    if (!a) return null;
    const p = a.flown.airframe.pos.clone().normalize();
    return {
      mission: m.id,
      point: [p.x, p.y, p.z],
      heading: airframeState(a.flown.airframe as unknown as FlightModel).track,
    };
  }

  /** Whether the player may take over the followed aircraft now: at full fidelity, in its window, not held. */
  canTakeOver(t: number): boolean {
    const m = this.mission();
    return (
      !!m &&
      this.full !== null &&
      !this.flying &&
      !m.flown &&
      jumpInOpen(m, t) &&
      this.takenAt === null
    );
  }

  /** T or the bar's button: takes over the followed aircraft, or hands it back. */
  toggleControl(): void {
    if (this.flying) this.handBack(null);
    else this.takeOver(this.lastTime);
  }

  /**
   * The player takes the followed aircraft (R2.5): its AI pilot leaves, the jet's input
   * flies it from the controls the AI left, and the worker holds the mission (`take-over`).
   */
  takeOver(t: number): boolean {
    const m = this.mission();
    const f = this.full;
    if (!m || !f || !this.canTakeOver(t)) return false;
    const a = f.followed(this.slot);
    if (!a) return false;
    const model = a.flown.airframe as unknown as FlightModel;
    const inp = this.input;
    inp.reset(false, a.flown.controls.throttle);
    Object.assign(inp.controls, a.flown.controls);
    inp.mode = 'mouse-aim';
    inp.centerCursor();
    this.director.reset();
    this.aimEngaged = false;
    if (!f.flight.takeOver(a.slot)) return false;
    // The input source: the jet's controls as the input holds them, mouse aim over them once
    // the mouse is captured (as Free Flight's; the pilot hook and the input share the controls).
    a.flown.pilot = (_af, ctl) => {
      Object.assign(ctl, inp.controls);
      if (inp.mode === 'mouse-aim' && this.aimEngaged && !model.onGround) {
        flyMouseAim(this.director, model, this.aimDirection(), ctl, inp);
        Object.assign(inp.controls, ctl);
      }
    };
    this.slot = a.slot;
    this.takenAt = performance.now();
    this.crashedAt = null;
    this.deps.post({ kind: 'take-over', mission: m.id, slot: a.slot });
    inp.enabled = true;
    this.capture.grab();
    // The flown view: the HUD with the aircraft's own displays, their bindings live.
    this.displays.attach(a.flown);
    this.displays.enabled = true;
    this.displays.readOnly = false;
    if (this.panels === 'hud') this.panels = 'all';
    this.applyPanels();
    this.hud.clearMessages();
    this.hud.message(
      [
        `You have control: ${m.callsign}, aircraft ${a.slot + 1}`,
        'Tab or a click: fly with the mouse (mouse aim); T hands back to the AI',
      ],
      6,
    );
    return true;
  }

  /**
   * The player leaves the aircraft (R2.5): the AI takes it again and the worker gets the
   * hand-back input, the flight's fix and the aircraft full fidelity lost, from which it
   * rebuilds the route (decision 257). `why` is said on the HUD, if given.
   */
  handBack(why: string | null): void {
    const m = this.mission();
    const f = this.full;
    if (!f || f.flight.playerSlot === null) return;
    const a = f.flight.bySlot(f.flight.playerSlot);
    // Posted after the take-over in any case: the worker applies them in order.
    if (m) {
      const h = f.flight.handback();
      this.deps.post({
        kind: 'hand-back',
        mission: m.id,
        fix: h.fix,
        lost: h.lost,
        stores: h.stores,
      });
    }
    if (a) a.flown.pilot = null;
    f.handBack();
    this.endControl();
    this.hud.message(why ?? `${m?.callsign ?? 'The flight'} is back with the AI`, 4);
  }

  /** The jet's input off, the mouse free, the displays read-only again. */
  private endControl(): void {
    this.input.enabled = false;
    this.capture.release();
    this.displays.enabled = false;
    this.displays.readOnly = true;
    this.takenAt = null;
    this.crashedAt = null;
    this.applyPanels();
  }

  /** Where mouse aim flies: the cursor's direction in the chase view with its look centered. */
  private aimDirection(): Vec3d {
    return aimDirection(this.deps.globe.chase, this.deps.globe.camera.aspect, this.input.cursor);
  }

  /** The jet's toggle actions while the player flies (Free Flight's bindings). */
  private action(a: FlightAction): void {
    if (!this.flying) return;
    const c = this.input.controls;
    switch (a) {
      case 'gear':
        c.gearDown = !c.gearDown;
        break;
      case 'speedbrake':
        c.speedbrake = !c.speedbrake;
        break;
      case 'parkingBrake':
        c.parkingBrake = !c.parkingBrake;
        break;
      case 'jettison':
        this.jettison();
        break;
      case 'mouseCapture': {
        const freeing = this.capture.captured;
        this.capture.toggle();
        if (freeing) this.hud.message('Mouse free: Tab or a click on the view to fly with it', 2.5);
        break;
      }
      case 'invertMouse':
        this.input.invertAim = !this.input.invertAim;
        this.hud.message(
          this.input.invertAim ? 'Mouse up and down inverted' : 'Mouse up and down normal',
          3,
        );
        break;
      case 'mouseAim':
        this.input.mode = this.input.mode === 'mouse-aim' ? 'direct' : 'mouse-aim';
        this.input.centerCursor();
        this.director.reset();
        this.capture.grab();
        this.hud.message(
          this.input.mode === 'mouse-aim'
            ? 'Mouse aim: fly toward the ring'
            : 'Direct: the mouse is the stick',
          3,
        );
        break;
      case 'recenterView':
        this.deps.globe.chase.recenter();
        break;
      case 'help':
        this.hud.message(
          [
            'Mouse aim or W/S/A/D, Q/E rudder, Shift/Ctrl throttle, G gear, B speedbrake, J tanks',
            'N mouse aim or direct, Tab frees the mouse, C or right drag looks, T hands back',
          ],
          8,
        );
        break;
      default:
        // Escape frees the mouse (the browser's); the pause and the debug panel are Free Flight's.
        break;
    }
  }

  /** The player's controls each frame: keys, mouse, look and zoom; the hold checked, a crash handed back. */
  private flyFrame(m: Mission, dt: number): void {
    const f = this.full!;
    const a = f.flight.bySlot(f.flight.playerSlot!);
    const model = a?.flown.airframe as unknown as FlightModel | undefined;
    const now = performance.now();
    // The worker holds the mission once its list shows it flown; a refusal hands back at once.
    if (this.takenAt !== null && m.flown) this.takenAt = null;
    else if (this.takenAt !== null && now - this.takenAt > HOLD_WAIT) {
      this.handBack(null);
      this.hud.clearMessages();
      this.hud.message('The campaign did not hand the flight over: the AI keeps it', 5, true);
      return;
    }
    if (model?.crashed) {
      if (this.crashedAt === null) {
        this.crashedAt = now;
        this.hud.message([`CRASH: ${model.crashed}`], 6, true);
      } else if (now - this.crashedAt > CRASH_HANDBACK) {
        this.handBack(`${m.callsign} lost an aircraft; the AI flies the rest`);
        return;
      }
    }
    if (!model) return;
    const inp = this.input;
    const chase = this.deps.globe.chase;
    inp.directOnGround = model.onGround || !this.aimEngaged;
    inp.aimRotates = model.onGround && this.aimEngaged;
    inp.update(dt);
    chase.lookHeld = inp.lookHeld;
    if (inp.lookHeld) {
      const rpp = (this.deps.globe.camera.fov * DEG) / Math.max(1, window.innerHeight);
      chase.look(inp.lookDelta.x, inp.lookDelta.y, rpp);
      inp.lookDelta.x = inp.lookDelta.y = 0;
    }
    if (inp.zoomSteps !== 0) {
      chase.zoomBy(inp.zoomSteps);
      inp.zoomSteps = 0;
    }
  }

  /** Whether the followed flight flies at full fidelity now. */
  get fullFidelity(): boolean {
    return this.full !== null;
  }

  /**
   * The ground a promoted flight flies over, once the global pass is done (R2.5): built
   * as Free Flight's, the drawn surface with the airfields' grading.
   */
  setTerrain(t: FlownTerrain | null): void {
    this.demote();
    if (!t) {
      this.airfield = null;
      this.runways = [];
      return;
    }
    const g = this.deps.globe;
    const r = flownGround(t, this.deps.radius, g.terrain, (d) => g.props.obstacleAt(d));
    this.airfield = r.ground;
    this.runways = r.runways;
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
    this.span = drawn.span;
    this.clearance = drawn.clearance;
    this.missionId = id;
    this.slot = Math.min(slot, Math.max(0, m!.aircraft - 1));
    this.look = look;
    this.bundle = b;
    this.spec = spec;
    this.flightSpec = flightSpecOfType(m!.aircraftType, (id) => modelSpec(id).flight);
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
    this.displays.reset(!this.poses[0]!.airborne);
    this.displays.attach({ avionics: initialAvionics(!this.poses[0]!.airborne) });
    this.displaysAt = -Infinity;
    document.body.classList.add('following');
    this.applyPanels();
    this.updateTitle(m!, t);
    return true;
  }

  /** Steps the panels: HUD, HUD and displays, clean. */
  nextPanels(): void {
    this.panels = FOLLOW_PANELS[(FOLLOW_PANELS.indexOf(this.panels) + 1) % FOLLOW_PANELS.length]!;
    this.applyPanels();
  }

  private applyPanels(): void {
    const on = this.missionId !== null;
    this.hud.show(on && this.panels !== 'clean');
    this.displays.visible = on && this.panels === 'all' && this.bundle?.avionics != null;
    // Clean: the bar goes too (Escape still returns); the FPS gauge follows the body's class.
    this.bar.hidden = !on || this.panels === 'clean';
    document.body.classList.toggle('follow-clean', on && this.panels === 'clean');
    this.panelsButton.textContent = `View (V): ${PANEL_LABELS[this.panels]}`;
    this.displaysAt = -Infinity;
  }

  /** Returns to the map; `why` says why if the mission ended rather than the player leaving. */
  stop(why: string | null): void {
    const id = this.missionId;
    if (id === null) return;
    // Leaving the view leaves the aircraft: the AI takes it with its orders.
    if (this.flying) this.handBack(null);
    this.clear();
    const g = this.deps.globe;
    g.chase.zoom = 1;
    g.chase.timeRate = 1;
    g.cameraMode = 'observer';
    this.deps.setView('strategic');
    this.deps.returned(id, why);
  }

  /** Follows the next aircraft of the flight. */
  nextAircraft(): void {
    const m = this.mission();
    if (!m) return;
    const slots = this.full
      ? this.full.flight.alive.map((a) => a.slot)
      : Array.from({ length: Math.max(1, m.aircraft) }, (_, k) => k);
    this.slot = slots.find((s) => s > this.slot) ?? slots[0] ?? 0;
  }

  /**
   * Promotes the followed flight inside its window, steps it, and demotes it at the
   * approach, when the clock runs faster than the flight cap, or when its clock fell
   * behind (a seek); the chase camera then follows the airframe.
   */
  private fidelity(m: Mission, t: number): void {
    const g = this.deps.globe;
    const want = fullFidelityWanted(m, t, this.deps.rate(), this.poses);
    // Flown, or held until the worker's rebuilt route arrives: it stays at full fidelity.
    const keep = this.flying || !!m.flown;
    if (this.full && ((!want && !keep) || !this.full.advance(m, t))) this.demote();
    else if (!this.full && want && this.flightSpec && this.airfield && g.terrainReady) {
      this.full = new FullFidelity(
        {
          radius: this.deps.radius,
          mission: () => this.mission(),
          leadPose: (mm, u) => drawnLeadPose(mm, u, this.deps.radius, this.fieldsAt(mm, u)),
          ground: this.airfield,
          formations: missionPlugin(m.type).formations,
          gearHeight: this.gearHeight,
          clearance: this.clearance,
          span: this.span,
          weather: this.deps.weather,
          enemyDistance: (pos, u) => this.enemyDistance(m.side, pos, u),
        },
        this.flightSpec,
        m,
        t,
        this.poses,
      );
      this.blend = null;
      for (const d of this.drawn) d.view.setCg(this.flightSpec.cg);
    }
    const a = this.full?.followed(this.slot);
    if (a) {
      this.slot = a.slot;
      followAirframe(g.chase.target, a.flown.airframe);
    }
  }

  /**
   * The flight cap while the player flies (R2.5): 8× in cruise, 1× near the target or
   * station, low, with the gear down, or with an enemy flight within reach; no cap when
   * the player does not fly.
   */
  rateCap(t: number): { rate: number; reason: string | null } {
    const m = this.mission();
    const f = this.full;
    if (!m || !f || f.flight.playerSlot === null) return { rate: Infinity, reason: null };
    const model = f.flight.bySlot(f.flight.playerSlot)?.flown.airframe as unknown as
      FlightModel | undefined;
    if (!model) return { rate: Infinity, reason: null };
    const R = this.deps.radius;
    const tp = m.target.point;
    const target = new Vec3d(tp[0], tp[1], tp[2]).scale(R);
    const enemy = this.enemyDistance(m.side, model.pos, t);
    return flightRateCap({
      airborne: !model.onGround,
      gearDown: model.gear > 0.01,
      heightAboveGround: model.telemetry.radarAltitude,
      targetDistance: model.pos.clone().normalize().scale(R).distanceTo(target),
      enemyDistance: enemy,
    });
  }

  /** How far the nearest airborne flight of the other side is from `pos` at t (m), on its route. */
  private enemyDistance(side: Mission['side'], pos: Readonly<Vec3d>, t: number): number {
    const R = this.deps.radius;
    let enemy = Infinity;
    for (const e of this.deps.missions()) {
      if (e.side === side || e.aircraft <= 0) continue;
      const s = routeState(e.route, t, R);
      if (!s.airborne) continue;
      const r = R + s.altitude;
      const d = Math.hypot(s.point[0] * r - pos.x, s.point[1] * r - pos.y, s.point[2] * r - pos.z);
      enemy = Math.min(enemy, d);
    }
    return enemy;
  }

  /**
   * The followed aircraft's stores for the displays (decision 289): its rack at full
   * fidelity, else its loadout less what it expended before.
   */
  private storesOf(m: Mission, t: number): SnapshotStores | null {
    const a = this.full?.followed(this.slot);
    if (a) {
      const fm = a.flown.airframe as unknown as FlightModel;
      return storesSnapshot(
        a.rack.stations,
        a.rack.loaded,
        fm.tankFuel,
        a.rack.gun?.rounds ?? null,
      );
    }
    const loads = flightStores(m).loads;
    if (!loads.length) return null;
    const on = new Set(loadedOf(m, this.slot, loads));
    const loaded = loads.filter((l) => on.has(l.station));
    // The route's fuel as the aircraft would hold it: the internal tanks fill first (decision 287).
    let tankFuel = 0;
    const spec = this.flightSpec;
    if (spec) {
      const tanks = storesEffect(loaded, spec.standardStores).tankCapacity;
      const capacity = spec.mass.fuel + storesEffect(loads, spec.standardStores).tankCapacity;
      const s = routeState(m.route, t, this.deps.radius);
      const fuel = flightFuel(s.fuel, m.route.fuel, capacity);
      tankFuel = Math.max(0, Math.min(tanks, fuel - spec.mass.fuel));
    }
    return storesSnapshot(loads, loaded, tankFuel);
  }

  /** The player drops their drop tanks (J, the stores format's button; decision 287). */
  private jettison(): void {
    const n = this.full?.flight.jettisonPlayerTanks() ?? 0;
    this.hud.message(n > 0 ? 'Tanks jettisoned' : 'No tanks to jettison', 2.5);
  }

  /** The bar's take-over button: shown while the player may take over or flies. */
  private updateTakeButton(t: number): void {
    const b = this.takeButton;
    const flying = this.flying;
    const can = flying || this.canTakeOver(t);
    b.hidden = !can;
    const label = flying ? 'Hand back (T)' : 'Take over (T)';
    if (b.textContent !== label) b.textContent = label;
    this.nextButton.disabled = flying;
  }

  /** Back to the analytic poses: the drawn aircraft ease from where they flew onto their routes. */
  private demote(): void {
    const f = this.full;
    if (!f) return;
    this.full = null;
    const at = f.positions();
    this.blend = new Map();
    this.blendAge = 0;
    this.poses.forEach((p, k) => {
      const q = at.get(k);
      if (q) this.blend!.set(k, q.sub(new Vec3d(p.pos[0], p.pos[1], p.pos[2])));
    });
    for (const d of this.drawn) d.view.setCg([0, 0, 0]);
    this.hung.clear();
    this.released?.clear();
    this.tracers?.place([], new Vec3d(), 1);
  }

  /** Advances the follow by `dt` real seconds at game time t; call before the scene renders. */
  frame(dt: number, t: number): void {
    if (this.missionId === null) return;
    const m = this.mission();
    // A flight the player flies (or the worker still holds) is not ended by its old route's end.
    const held = this.flying || !!m?.flown;
    if (!m || (missionPhase(m, t) === 'complete' && !held)) {
      this.stop(m ? `${m.callsign} has landed` : 'The flight is gone');
      return;
    }
    if (m.aircraft <= 0) {
      this.stop(`${m.callsign} was lost`);
      return;
    }
    if (this.slot >= m.aircraft && !this.full) this.slot = 0;
    // The settle: the camera eases in from further back over SETTLE_TIME.
    if (this.settle < 1) {
      this.settle = Math.min(1, this.settle + dt / SETTLE_TIME);
      const s = this.settle * this.settle * (3 - 2 * this.settle);
      this.deps.globe.chase.zoom = SETTLE_ZOOM + (1 - SETTLE_ZOOM) * s;
    }
    // The camera's acceleration lag reads the flight's own time, not the frame's (decision 259).
    const g = this.deps.globe;
    g.chase.timeRate =
      dt > 0 && Number.isFinite(this.lastTime) ? Math.max(0, t - this.lastTime) / dt : 1;
    this.pose(m, t, dt);
    if (this.flying) this.flyFrame(m, dt);
    this.fidelity(m, t);
    this.updateTakeButton(t);
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
    const a = this.full?.followed(this.slot);
    if (a && this.flying && a.slot === this.full!.flight.playerSlot) {
      this.drawFlownHud(m, a.flown.airframe as unknown as FlightModel, project, t);
      return;
    }
    if (a) {
      // At full fidelity the HUD and the displays read the followed airframe (as Free Flight's).
      const model = a.flown.airframe as unknown as FlightModel;
      const frame = buildHudFrame(model, a.flown.controls, {
        aid: landingAid(model, this.runways, this.deps.globe.chase.eye),
        mode: 'follow · AI',
        control: null,
        timing: null,
      });
      frame.panels = true;
      this.updateDisplays(m, airframeState(model), frame, t);
      if (this.panels !== 'clean') this.hud.draw(frame, project);
      return;
    }
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
    this.updateDisplays(
      m,
      {
        onGround: !p.airborne,
        radarAltitude: agl,
        groundSpeed: p.speed,
        pos: p.pos,
        track: p.heading,
        heading: p.heading,
      },
      frame,
      t,
    );
    if (this.panels !== 'clean') this.hud.draw(frame, project);
  }

  /** The player's HUD, as Free Flight's: mouse aim's ring or the direct stick, the landing aid. */
  private drawFlownHud(
    m: Mission,
    model: FlightModel,
    project: ReturnType<typeof matrixProjector>,
    t: number,
  ): void {
    const inp = this.input;
    const aim = inp.mode === 'mouse-aim';
    const captured = this.capture.captured;
    let control: ControlCursor | null = null;
    if (aim && this.aimEngaged) {
      const d = this.aimDirection();
      control = {
        kind: 'aim',
        x: 0,
        y: 0,
        dir: [d.x, d.y, d.z],
        active: captured,
        full: STICK_FULL,
        deadzone: STICK_DEADZONE,
      };
    } else if (captured) {
      control = {
        kind: 'stick',
        x: inp.cursor.x,
        y: inp.cursor.y,
        dir: null,
        active: true,
        full: STICK_FULL,
        deadzone: STICK_DEADZONE,
      };
    }
    const mode = aim ? 'mouse aim' : 'direct';
    const frame = buildHudFrame(model, inp.controls, {
      aid: landingAid(model, this.runways, this.deps.globe.chase.eye),
      mode: captured ? mode : `${mode} · TAB TO FLY`,
      control,
      timing: null,
    });
    frame.panels = true;
    // The gun: the trigger from the input, the pipper on the HUD (decision 295).
    const rack = this.full?.followed(this.slot)?.rack ?? null;
    if (rack?.gun) rack.gun.trigger = inp.trigger;
    frame.gun = gunHud(model, rack, this.displays.avionics, this.deps.globe.chase.eye);
    this.updateDisplays(m, airframeState(model), frame, t);
    if (this.panels !== 'clean') this.hud.draw(frame, project);
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
  /** The fields mission m's aircraft are drawn on at t: the sited airbases, and its carrier's deck. */
  private fieldsAt(m: Readonly<Mission>, t: number): readonly AirfieldShift[] {
    const carrier =
      m.base.kind === 'carrier' && this.carriers[m.base.id]
        ? carrierState(this.carriers[m.base.id]!, t)
        : null;
    return carrier ? [...this.fields, ...carrierFields(m, carrier)] : this.fields;
  }

  private pose(m: Mission, t: number, dt = 0): void {
    const raw = flightPoses(
      m,
      t,
      this.deps.radius,
      this.fieldsAt(m, t),
      missionPlugin(m.type).formations,
      this.span,
    );
    const g = this.deps.globe;
    while (this.drawn.length < raw.length) {
      const v = new AircraftView(this.spec!, [0, 0, 0], g.lighting, flightStores(m).mounts);
      v.planetRadius = this.deps.radius;
      g.vehicles.add(v.group, v.shadowMesh);
      this.drawn.push({ view: v, lift: 0 });
    }
    this.poses = raw.map((p, k) => {
      const d = this.drawn[k]!;
      const target =
        drawnAltitude(p, drawnGround(m, p, this.ground(p)), this.gearHeight, this.clearance) -
        Math.max(0, p.altitude);
      d.lift = dt > 0 && Number.isFinite(d.lift) ? easeLift(d.lift, target, dt) : target;
      return liftedPose(p, Math.max(0, p.altitude) + d.lift);
    });
    // After a demotion the drawn aircraft ease from where they flew onto their routes.
    if (this.blend) {
      this.blendAge += dt;
      const w = Math.exp(-this.blendAge / DEMOTION_BLEND);
      if (w < 0.01) this.blend = null;
      else
        this.poses.forEach((p, k) => {
          const o = this.blend!.get(k);
          if (!o) return;
          for (let i = 0; i < 3; i++) p.pos[i] = p.pos[i]! + [o.x, o.y, o.z][i]! * w;
        });
    }
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
    if (this.full) {
      this.placeAirframes(eye, rpp);
      return;
    }
    const rotors = this.spec ? spinningRotors(this.spec) : undefined;
    const m = this.mission();
    const loads = m ? flightStores(m).loads : [];
    this.poses.forEach((p, k) => {
      const v = this.drawn[k]!.view;
      // Stores expended at full fidelity before stay off (decision 275).
      if (m && loads.length) v.setStores(loadedOf(m, k, loads));
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

  /** Places the promoted flight's aircraft from their airframes: surfaces, gear, speedbrake, afterburner. */
  private placeAirframes(eye: Readonly<Vec3d>, rpp: number): void {
    const g = this.deps.globe;
    const ground = this.airfield!;
    const groundAt = (d: Readonly<Vec3d>) => ground.height(d);
    // Stores that left their pylons since the last frame fall away (decision 294).
    const flight = this.full!.flight;
    this.released ??= new ReleasedStores(g.vehicles, g.lighting, this.deps.radius);
    // The flight's tracers (decision 295).
    if (!this.tracers) {
      this.tracers = new Tracers();
      g.vehicles.add(this.tracers.mesh);
    }
    this.tracers.place(
      flight.aircraft.flatMap((a) => a.rack.gun?.live ?? []),
      eye,
      rpp,
      flight.aircraft[0]?.rack.gun?.spec.muzzleVelocity,
    );
    for (const a of flight.aircraft) {
      const m = a.flown.airframe as unknown as FlightModel;
      const now = a.rack.loaded;
      const before = this.hung.get(a.slot);
      if (before && !m.crashed)
        for (const l of before.loads)
          if (!now.some((x) => x.station === l.station)) {
            const s = STORES[l.store]!;
            const fuel = s.kind === 'tank' && before.tanks > 0 ? before.tankFuel / before.tanks : 0;
            this.released.release(l, m, this.flightSpec!.cg, s.mass - s.fuel + fuel);
          }
      this.hung.set(a.slot, {
        loads: [...now],
        tankFuel: m.tankFuel,
        tanks: now.filter((l) => STORES[l.store]?.kind === 'tank').length,
      });
    }
    this.released.update(Math.max(0, flight.time - this.fallTime), groundAt);
    this.fallTime = flight.time;
    this.released.place(eye, g.sun, rpp, groundAt);
    for (const d of this.drawn) {
      d.view.group.visible = false;
      d.view.shadowMesh.visible = false;
    }
    for (const a of this.full!.flight.aircraft) {
      const d = this.drawn[a.slot];
      const m = a.flown.airframe as unknown as FlightModel;
      if (!d || m.crashed) continue;
      d.view.group.visible = true;
      d.view.shadowMesh.visible = true;
      // What hangs on the rack: a store fired, released or dropped is gone (decision 288).
      d.view.setStores(a.rack.loaded.map((l) => l.station));
      const t = m.telemetry;
      const pose: AircraftPose = {
        pos: m.pos,
        q: m.q,
        elevator: t.laws.elevator,
        aileron: t.laws.aileron,
        rudder: t.laws.rudder,
        gear: m.gear,
        speedbrake: m.speedbrake,
        afterburner: m.afterburner,
        flaps: m.gear,
        groundHeight: ground.height(m.pos.clone().normalize()),
        // The drawn ground, so the shadow lies on its slope (decision 170).
        ground: (dir) => ground.height(dir),
      };
      d.view.sun.copy(g.sun);
      d.view.radPerPixel = rpp;
      d.view.update(pose, eye);
    }
  }

  /** The master mode's triggers every frame; the displays at 10 Hz (decision 199), read-only. */
  private updateDisplays(m: Mission, p: FollowedState, frame: HudFrame, t: number): void {
    const b = this.bundle;
    if (!b?.avionics) return;
    const helicopter = this.look?.rig?.kind === 'helicopter';
    const changed = this.displays.triggers({
      onGround: p.onGround,
      gearDown: frame.gearDown,
      radarAltitude: p.radarAltitude,
      groundSpeed: p.groundSpeed,
      helicopter,
    });
    const now = performance.now();
    if (this.panels !== 'all' || (!changed && now - this.displaysAt < 100)) return;
    this.displaysAt = now;
    const d = Math.hypot(...p.pos);
    const snap = snapshotFromHud(frame, {
      time: t - m.timeline[0]!.time,
      name: `${m.callsign} · ${b.name}`,
      profile: b.avionics,
      avionics: this.displays.avionics,
      capacity: this.full ? this.full.flight.capacity : (b.airWar?.fuel ?? m.route.fuel),
      groundSpeed: p.groundSpeed,
      position: {
        lat: Math.asin(Math.max(-1, Math.min(1, p.pos[1] / d))),
        lon: Math.atan2(p.pos[0], p.pos[2]),
        radius: this.deps.radius,
      },
      track: p.track,
      heading: p.heading,
      fixedGear: helicopter,
      control: this.flying ? (this.input.mode === 'mouse-aim' ? 'mouse aim' : 'direct') : 'AI',
      mouseFree: this.flying && !this.capture.captured,
      messages: [],
      sensors: null,
      stores: this.storesOf(m, t),
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
    // Why there is no take-over: only types with fixed-wing flight data fly at full fidelity.
    const full = this.full
      ? ' · full fidelity (T: take over)'
      : this.flightSpec
        ? ''
        : ' · no flight model yet (follow only)';
    const flown = this.full?.followed(this.slot)?.flown.airframe;
    const speed = Math.round(
      (flown ? flown.telemetry.groundSpeed : (this.poses[this.slot]?.speed ?? 0)) / KNOT,
    );
    this.title.textContent = `Following ${m.callsign} · ${this.bundle?.name ?? m.aircraftType}${stand}${who} · ${label}${full} · ${speed} kt`;
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
    this.full = null;
    this.hung.clear();
    this.released?.clear();
    this.tracers?.place([], new Vec3d(), 1);
    this.blend = null;
    this.missionId = null;
    this.hud.show(false);
    this.displays.visible = false;
    this.bar.hidden = true;
    document.body.classList.remove('following', 'follow-clean');
  }

  dispose(): void {
    this.clear();
    this.detach();
    this.input.dispose();
    this.capture.dispose();
    this.bar.remove();
  }
}

/** What the displays read of the followed aircraft, from its analytic pose or its airframe. */
interface FollowedState {
  onGround: boolean;
  radarAltitude: number;
  groundSpeed: number;
  pos: readonly [number, number, number];
  /** Track over the ground and heading (rad from north). */
  track: number;
  heading: number;
}

/** The displays' view of a flown airframe (as Free Flight's). */
function airframeState(m: FlightModel): FollowedState {
  const t = m.telemetry;
  const up = m.pos.clone().normalize();
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const vg = m.vel.clone().addScaled(up, -m.vel.dot(up));
  return {
    onGround: m.onGround,
    radarAltitude: t.radarAltitude,
    groundSpeed: t.groundSpeed,
    pos: [m.pos.x, m.pos.y, m.pos.z],
    track: vg.length() > 5 ? Math.atan2(vg.dot(east), vg.dot(north)) : t.heading,
    heading: t.heading,
  };
}
