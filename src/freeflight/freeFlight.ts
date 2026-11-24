/**
 * Free Flight (decision 134): the mode's glue on the main thread. It takes the
 * world the app generates for a seed, lists its airbases on the start screen,
 * spawns the F-21 Kestrel, runs the flight model at fixed 120 Hz steps from the
 * frame clock, feeds the chase camera, the animated model and the HUD, watches
 * the outcomes and runs the session (pause, restart, summary, refuel at another
 * base). No war simulation runs in this mode.
 *
 * The weather is the mode's own (flightWeather.ts): the world's weather model
 * on the main thread, shown as the preset chosen on the start screen. The
 * flown aircraft feels its wind and gusts (sim/flight/wind.ts), the scene
 * draws it, and a flight starts at the chosen time of day on the night of the
 * first full moon (clock.ts).
 */
import type { PerspectiveCamera } from 'three/webgpu';
import type { CampaignCalendar, OrbitParams } from '../core/calendar';
import { DEG, KNOT, NAUTICAL_MILE } from '../core/units';
import { approachSpeed } from '../sim/flight/energy';
import { Quatd } from '../core/quat';
import { Vec3d } from '../core/vec3d';
import type { GlobeScene } from '../render/sim/globeScene';
import { standardMounts, storeModel, storeMounts } from '../render/sim/aircraft/storeMounts';
import { Tracers } from '../render/sim/aircraft/tracers';
import { AircraftView } from '../render/sim/aircraft/aircraftView';
import type { AircraftPose } from '../render/sim/aircraft/aircraftView';
import { modelSpec } from '../render/common/models/library';
import type { StrategicScene } from '../render/strategic/strategicScene';
import { FlightDirector } from '../sim/flight/flightDirector';
import { aimDirection, flyMouseAim } from '../ui/flight/mouseAim';
import { MIL_DETENT } from '../sim/flight/controlLaws';
import type { FlightControls } from '../sim/flight/controlLaws';
import type { Side } from '../campaign/cast';
import { followAirframe, rigFromBundle } from '../render/sim/camera/chaseCamera';
import { AIRCRAFT_BUNDLES } from '../sim/air/bundles';
import type { Airframe } from '../sim/flight/airframe';
import { FLIGHT_STEP, FlightModel } from '../sim/flight/flightModel';
import { assistsFor } from '../sim/flight/rotor/assists';
import { HeloLaws } from '../sim/flight/rotor/heloLaws';
import { neutralRotorControls, RotorcraftModel } from '../sim/flight/rotor/rotorcraftModel';
import type { RotorControls } from '../sim/flight/rotor/rotorcraftModel';
import { FlownAircraft } from '../sim/flight/flownAircraft';
import { rotorDownwash } from '../sim/flight/rotor/downwash';
import type { Downwash } from '../sim/flight/rotor/downwash';
import { parseRotorcraftSpec } from '../sim/flight/rotor/rotorSpec';
import type { RotorcraftSpec } from '../sim/flight/rotor/rotorSpec';
import { fromRunway, runwayFrame } from '../sim/flight/runway';
import { HeloInput, HELO_BINDINGS, HELO_LABELS } from '../ui/flight/heloInput';
import type { HeloAction } from '../ui/flight/heloInput';
import type { ModelSpec } from '../render/common/models/spec';
import { parseFlightSpec } from '../sim/flight/flightSpec';
import { FlightMonitor } from '../sim/flight/outcomes';
import type { FlightEvent } from '../sim/flight/outcomes';
import { runwayEnds } from '../sim/flight/runway';
import type { Runway } from '../sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../sim/flight/spawn';
import { TestPilot } from '../sim/flight/testPilot';
import { airVelocity } from '../sim/flight/wind';
import type { WeatherView } from '../sim/weather/frame';
import type { WeatherConfig } from '../sim/weather/model';
import type { WeatherPreset } from '../sim/weather/presets';
import type { StrategicWorld } from '../worldgen/campaignWorld';
import {
  HelpOverlay,
  PauseMenu,
  SummaryCard,
  sinkText,
  touchdownLines,
  KESTREL_HELP,
} from '../ui/flight/flightCards';
import type { SoundSettings } from '../ui/flight/flightCards';
import { FlightInput, STICK_DEADZONE, STICK_FULL } from '../ui/flight/flightInput';
import type { ControlCursor } from '../ui/flight/controlCursor';
import type { ControlMode, FlightAction } from '../ui/flight/flightInput';
import { MouseCapture } from '../ui/flight/mouseCapture';
import { clearPresetEdits, DisplaySystem } from '../ui/displays/system';
import type { ControlsAction } from '../ui/displays/model';
import { AVIONICS_PROFILES } from '../sim/avionics/profiles';
import { relativePicture, snapshotFromHud, storesSnapshot } from '../ui/displays/aircraftSnapshot';
import { StoresRack } from '../sim/flight/storesRack';
import { standardStations, STORES } from '../sim/air/stores';
import type { SnapshotSensors, SnapshotTerrain } from '../ui/displays/snapshot';
import { ACM_CONE, acmAcquire, SensorModel } from '../sim/sensors/sensors';
import { threatCalls } from '../ui/displays/calls';
import type { ThreatTone } from '../ui/displays/calls';
import { lineOfSight } from '../sim/sensors/lineOfSight';
import { groundMap } from '../sim/sensors/groundMap';
import type { GroundMapImage } from '../sim/sensors/groundMap';
import { groundRadarRange } from '../sim/avionics/avionics';
import type { DatalinkFeed, SensorEnv, SensorTarget } from '../sim/sensors/sensors';
import { buildTraffic, trafficState, trafficTargets } from './traffic';
import { MovingMap } from '../render/strategic/movingMap';
import { AttitudeHold, holdAllowed } from '../sim/flight/holds';
import { mapAhead, mapPictureScale, mapRange } from '../ui/displays/formats';
import {
  DEFAULT_OPTIONS,
  FreeFlightMenu,
  invertKey,
  invertNote,
  isJet,
  JET_BUNDLES,
} from '../ui/flight/freeFlightMenu';
import type {
  AircraftChoice,
  BaseEntry,
  JetChoice,
  JetControl,
  FreeFlightOptions,
  SpawnKind,
} from '../ui/flight/freeFlightMenu';
import { Hud, matrixProjector } from '../ui/flight/hud';
import type { HudFrame } from '../ui/flight/hud';
import { flightStartTime } from './clock';
import { writeFreeFlightParams } from './url';
import type { FreeFlightUrl } from './url';
import { FlightWeather } from './flightWeather';
import {
  buildHudFrame,
  ccipHud,
  gunHud,
  landingAid,
  seekerHud,
  sightPoint,
} from '../ui/flight/hudFrame';
import { Explosions } from '../render/sim/aircraft/explosions';
import { airframePose, wingtipOf } from '../render/sim/effects/aircraftPose';
import { gunEffects } from '../render/sim/effects/weapons';
import { Wrecks } from '../render/sim/aircraft/wrecks';
import { gunSelected, rocketCounts } from '../sim/flight/storesRack';
import { flyingOf, MissileViews } from '../render/sim/aircraft/missileViews';
import { buildHeloHudFrame } from '../ui/flight/heloHud';
import { flownGround } from './ground';
import type { AirfieldGround, FlownTerrain } from './ground';

export { parseFreeFlightUrl } from './url';
export type { FreeFlightUrl } from './url';

export interface FreeFlightDeps {
  canvas: HTMLCanvasElement;
  globe: GlobeScene;
  strategic: StrategicScene;
  radius: number;
  orbit: OrbitParams;
  calendar: () => CampaignCalendar;
  /** Shows the simulation view (flying) or the strategic map (start screen). */
  setView(view: 'simulation' | 'strategic'): void;
  /** Generates or loads the world for a seed. */
  loadSeed(seed: string): void;
  /** Leaves Free Flight for the full app. */
  exit(): void;
  /** The world generation's progress, for the start screen. */
  status(): string;
  /** The weather's sound, for the pause menu's volume and mute (none: no sound controls). */
  sound?: SoundSettings;
  /** Sounds a threat warning tone (decision 223); none: silent. */
  tone?(kind: ThreatTone): void;
  /** Another weather was chosen on the start screen or in the pause menu. */
  weatherChanged?(preset: WeatherPreset): void;
}

type State = 'menu' | 'flying' | 'paused' | 'summary';

/** Most physics steps per frame: a stalled tab catches up at most a quarter second. */
const MAX_STEPS = 30;
/** The helicopters' model specs (track H1, Proposal 0004). */
const HELICOPTERS: Record<Exclude<AircraftChoice, JetChoice>, string> = {
  scout: 'alliance-scout-helo',
  utility: 'alliance-utility-helo',
};
/** The help card's note for helicopters. */
const HELO_HELP = [
  'Tab or a click on the view captures the mouse; Tab frees it again, Escape frees it and pauses.',
  'Takeoff: hold W until clear of the ground, let go to hold the altitude. Move the mouse forward to tilt the nose down and fly forward; back to slow down. Slow and let go: the hover holds (Assisted).',
  'In the hover the mouse turns the nose; above about 40 kt it banks into a coordinated turn. A/D slide sideways in the hover.',
  'Landing: slow to a hover over the spot, then hold S: the descent eases near the ground (VS under the radar altitude turns amber if it is too fast). Keep S held on the ground to lower the collective.',
  'Camera: drag with the right mouse button to look around; the view stays where you leave it. Drag down to look further ahead. V, Backspace or the middle button recenters it; the wheel zooms.',
];
/** What the HUD says when the jet's mouse mode starts (decisions 195, 198). */
const MOUSE_MODE_MESSAGE: Record<ControlMode, string> = {
  'mouse-aim':
    'Mouse aim: the jet flies toward the ring; stick keys override. N for direct, Tab frees the mouse',
  direct: 'Direct: the mouse is the stick, its offset from the center. N for mouse aim',
};
const CONTROL_MODE: Record<JetControl, ControlMode> = { aim: 'mouse-aim', direct: 'direct' };
/** Whether the map's read-back runs from the bottom row (settled by the lavapipe preview). */
const MAP_FLIP_Y = false;
/** Where a helicopter starts on the ground: beside the runway's middle (m across, to the right). */
const HELO_SPOT_ACROSS = 75;

export class FreeFlight {
  state: State = 'menu';
  /** Game time (s): the sun follows it. Runs at 1× while flying. */
  gameTime = 0;
  readonly menu: FreeFlightMenu;
  readonly input: FlightInput;
  readonly hud = new Hud();
  readonly help = new HelpOverlay();
  readonly pause: PauseMenu;
  readonly summary: SummaryCard;
  private readonly options: FreeFlightOptions;
  private bases: BaseEntry[] = [];
  private graph: StrategicWorld['graph'] | null = null;
  /** Airbase positions (unit directions) from the coarse pass, known before the terrain is. */
  private basePoints = new Map<number, Vec3d>();
  private runways: Runway[] = [];
  private ground: AirfieldGround | null = null;
  private model: FlightModel | null = null;
  private monitor: FlightMonitor | null = null;
  private view: AircraftView | null = null;
  private readonly director = new FlightDirector();
  /** The flown helicopter, its control layer, assists, input and controls (null: the Kestrel flies). */
  private helo: RotorcraftModel | null = null;
  /** The helicopter's downwash at the ground, reused each frame. */
  private readonly wash: Downwash = { center: new Vec3d(), speed: 0, radius: 1 };
  private heloSpec: { model: ModelSpec; flight: RotorcraftSpec } | null = null;
  private readonly laws = new HeloLaws();
  private readonly assists = assistsFor('assisted');
  readonly heloInput: HeloInput;
  /** The displays and the status strip (Proposal 0006, decision 199). */
  readonly displays: DisplaySystem;
  private displayModel = JET_BUNDLES.kestrel;
  private displayName = 'F-21 Kestrel';
  private sortieAt = 0;
  private fuelCapacity = 0;
  /** The gun's tracers (decision 295), made with the first frame. */
  private tracers: Tracers | null = null;
  /** Missiles in flight and their smoke (decision 297), and the trigger last frame. */
  private missileViews: MissileViews | null = null;
  private explosions: Explosions | null = null;
  /** Traffic shot down this sortie, damage done to the rest, and the falling wrecks (decision 301). */
  private readonly downed = new Set<string>();
  private readonly airDamage = new Map<string, number>();
  private readonly wrecks = new Wrecks();
  private wreckTime = 0;
  /** When the eject key was first pressed (s): a second press within 2 s ejects. */
  private ejectArmed = -Infinity;
  private triggerWas = false;
  /** The Kestrel's stores: its flight data's standard load (decision 289); null in a helicopter. */
  private rack: StoresRack | null = null;
  /** The gear doors' failure has been announced this sortie. */
  private gearDamageTold = false;
  private displaysAt = -Infinity;
  private movingMap: MovingMap | null = null;
  /**
   * Mouse aim has the stick once the mouse has been captured this sortie; before that the
   * keys fly, so a keyboard takeoff is never taken over at liftoff (decision 206).
   */
  private aimEngaged = false;
  /** Direct control's hold while the player's hand is off the stick (decision 306). */
  private readonly hold = new AttitudeHold();
  /** Whether the page shows a sortie (the body's `ff-flying` class). */
  private sortieShown = false;
  private mapAt = -Infinity;
  /** The traffic near the base and its views, while the option is on (decision 218). */
  private traffic: ReturnType<typeof buildTraffic> | null = null;
  private readonly trafficViews = new Map<string, AircraftView>();
  /** The flown aircraft's sensors and their picture, relative to it, for the displays. */
  private readonly sensors = new SensorModel();
  private sensorSnap: SnapshotSensors | null = null;
  /** The moving map's last height samples and when they were taken (ms; decision 227). */
  private terrainSnap: SnapshotTerrain | null = null;
  private terrainAt = -Infinity;
  /** The ground map's last picture and when it was painted (game time; decision 226). */
  private groundMapImg: GroundMapImage | null = null;
  private groundMapAt = -Infinity;
  /** The emitters the threat warning heard last, for its calls (decision 223). */
  private threatsHeard = new Map<string, 'search' | 'track' | 'launch'>();
  /** The mouse's pointer lock, shared by both inputs and toggled by Tab (decision 193). */
  readonly capture: MouseCapture;
  /** When the browser last took the mouse back and paused (ms), so its Escape does not resume. */
  private lostAt = -Infinity;
  private readonly heloControls = neutralRotorControls();
  /** The views built so far, one per aircraft. */
  private readonly views = new Map<string, AircraftView>();
  private pilot: TestPilot | null = null;
  private baseId: number | null = null;
  private pendingBase: number | null;
  private readonly autopilot: boolean;
  private debug = false;
  private frameMs = 0;
  private physicsMs = 0;
  private steps = 0;
  /** The flown aircraft (R1.5): the airframe, its controls and the stepping, for either kind. */
  private flown: FlownAircraft<FlightControls> | FlownAircraft<RotorControls> | null = null;
  private crashAt = 0;
  /** The jet flown (R2.7): its bundle, model spec and flight data, the Kestrel's at first. */
  private jet: string = JET_BUNDLES.kestrel;
  private spec = modelSpec(this.jet);
  private flightSpec = parseFlightSpec(this.spec.flight, this.jet);
  /** The side the player flies for: the jet's or the helicopter's. */
  private side: Side = 'alliance';
  /** Where the jet's wingtip vortices shed (decision 319). */
  private wingtip = wingtipOf(this.spec, this.flightSpec.cg);
  private readonly pose: AircraftPose;
  /** The mode's weather: the world's model, shown as the chosen preset. */
  private readonly weather: FlightWeather;
  /**
   * How far the chosen weather moved the air temperature at the base (°C): the app adds it to
   * the land's, so snow lies where it snows (flightWeather.ts).
   */
  temperatureShift = 0;
  private readonly unload = (e: BeforeUnloadEvent) => {
    if (this.state === 'flying') e.preventDefault();
  };

  constructor(
    private readonly deps: FreeFlightDeps,
    url: FreeFlightUrl,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...url.options };
    this.pendingBase = url.base;
    this.autopilot = url.autopilot;
    this.weather = new FlightWeather(deps.globe.weather, this.options.weather);
    this.menu = new FreeFlightMenu(
      {
        seed: (s) => {
          this.pendingBase = null;
          this.deps.loadSeed(s);
        },
        select: (id) => this.focusBase(id),
        fly: (id, o) => {
          Object.assign(this.options, o);
          this.start(id, o.spawn);
        },
        exit: () => {
          this.deps.globe.groundCover.setDownwash(null);
          this.deps.exit();
        },
        weather: (preset) => this.setWeather(preset),
      },
      this.options,
    );
    this.menu.setSeed(url.seed);
    this.pause = new PauseMenu(
      this.options,
      {
        resume: () => this.setPaused(false),
        restart: (spawn) => this.start(this.baseId!, spawn),
        changeBase: () => this.toMenu(),
        exit: () => {
          this.deps.globe.groundCover.setDownwash(null);
          this.deps.exit();
        },
        resetDisplays: () => {
          clearPresetEdits(this.displays);
          this.hud.message("The displays' layouts are back to their presets", 3);
        },
        optionsChanged: (o) => {
          this.applyInvert();
          this.applyGraphics();
          const flown = this.helo ?? this.model;
          if (flown) flown.unlimitedFuel = o.unlimitedFuel;
          if (o.weather !== this.weather.preset) this.setWeather(o.weather);
          this.writeUrl();
        },
      },
      deps.sound ?? null,
    );
    this.summary = new SummaryCard({
      restart: () => this.start(this.baseId!, this.options.spawn),
      continueFrom: (id) => this.start(id, 'runway'),
      changeBase: () => this.toMenu(),
    });
    this.displays = new DisplaySystem();
    this.displays.onControls = (a) => this.displayControl(a);
    this.capture = new MouseCapture(deps.canvas);
    // Escape or a lost focus took the mouse: pause, as Escape does.
    this.capture.onLost = () => {
      if (this.state !== 'flying') return;
      this.lostAt = performance.now();
      this.setPaused(true);
    };
    this.capture.onRefused = () =>
      this.hud.message('The browser kept the mouse: click the view to capture it', 4);
    // In the jet a captured mouse flies in either mode (decisions 195, 198); in direct mode
    // the stick starts and ends at the center, where the keys take over.
    this.capture.onChange = (on) => {
      if (this.helo || !this.model || this.pilot) return;
      if (on) this.aimEngaged = true;
      if (this.input.mode === 'direct') this.input.centerCursor();
    };
    this.input = new FlightInput(deps.canvas, this.capture);
    this.input.onAction = (a) => this.action(a);
    this.heloInput = new HeloInput(deps.canvas, this.capture);
    this.heloInput.onAction = (a) => this.heloAction(a);
    this.pose = {
      pos: new Vec3d(),
      q: new Quatd(),
      elevator: 0,
      aileron: 0,
      rudder: 0,
      gear: 1,
      speedbrake: 0,
      afterburner: 0,
      flaps: 1,
      groundHeight: 0,
      // The drawn ground, so the shadow lies on its slope (decision 170).
      ground: (d) => this.ground?.height(d) ?? 0,
    };
    deps.strategic.onGroundPick = (dir) => {
      if (this.state !== 'menu') return;
      let best: number | null = null;
      let bestDot = Math.cos(40_000 / deps.radius);
      for (const [id, p] of this.basePoints) {
        const d = p.dot(dir);
        if (d > bestDot) {
          bestDot = d;
          best = id;
        }
      }
      if (best !== null) {
        this.menu.select(best);
        this.writeUrl(best);
      }
    };
    deps.globe.beforeDraw = (eye) => {
      if (this.view && (this.model || this.helo) && this.state !== 'menu') {
        // A missile fired leaves its rail (decisions 288, 297).
        if (this.rack && !this.helo) this.view.setStores(this.rack.loaded.map((l) => l.station));
        this.view.update(this.pose, eye);
        // Contrails and wingtip vortices (decision 329).
        if (this.model && !this.helo && !this.model.crashed)
          deps.globe.effects.aircraft(
            'flown',
            airframePose(this.model, this.flightSpec.wing.span, 0, 16, this.wingtip),
          );
      }
      this.poseTraffic(eye);
      // The gun's tracers (decision 295).
      if (!this.tracers) {
        this.tracers = new Tracers();
        deps.globe.vehicles.add(this.tracers.mesh);
      }
      const cam = deps.globe.camera;
      const rpp = (cam.fov * DEG) / Math.max(1, window.innerHeight);
      this.tracers.place(
        this.state !== 'menu' && !this.helo ? (this.rack?.gun?.live ?? []) : [],
        eye,
        rpp,
        this.rack?.gun?.spec.muzzleVelocity,
      );
      // Missiles in flight and their smoke (decision 297).
      this.missileViews ??= new MissileViews(
        deps.globe.vehicles,
        deps.globe.lighting,
        this.deps.radius,
        deps.globe.effects,
      );
      const ground = this.ground;
      // Bombs and rockets that reached the ground explode (decision 300).
      // The scene's effects system draws them (Proposal 0011, decision 326).
      this.explosions ??= new Explosions(
        deps.globe.vehicles,
        deps.globe.lighting,
        deps.globe.effects,
      );
      for (const x of this.rack?.impacts.splice(0) ?? []) this.explosions.impact(x);
      // The gun's smoke, flash and impacts on the ground (decision 339).
      if (this.rack && this.model && this.flightSpec)
        gunEffects(this.deps.globe.effects, 'player', this.rack, this.model, this.flightSpec.cg);
      const explosions = this.explosions;
      this.wrecks.update(
        Math.max(0, this.gameTime - this.wreckTime),
        this.deps.radius,
        (d) => (ground ? ground.height(d) : 0),
        (p) => explosions.wreck(p, this.gameTime),
      );
      this.wreckTime = this.gameTime;
      this.explosions.place(this.gameTime, eye);
      this.missileViews.place(
        this.state !== 'menu' && !this.helo && this.rack
          ? [...flyingOf(this.rack), ...this.wrecks.flying]
          : [],
        this.gameTime,
        eye,
        deps.globe.sun,
        rpp,
        (d) => (ground ? ground.height(d) : 0),
      );
    };
    window.addEventListener('beforeunload', this.unload);
    deps.setView('strategic');
    this.menu.visible = true;
  }

  /** The app's world for the current seed (null while a new one generates). */
  setStrategic(s: StrategicWorld | null): void {
    this.runways = [];
    this.ground = null;
    this.basePoints.clear();
    this.menu.setReady(false);
    if (!s) {
      this.bases = [];
      this.graph = null;
      this.menu.setBases([]);
      return;
    }
    this.graph = s.graph;
    this.listBases(s.infrastructure);
  }

  /**
   * The start screen's bases and their map points: from the coarse record at first, then
   * from the sited runways once the terrain is ready (decision 220).
   */
  private listBases(infra: StrategicWorld['infrastructure']): void {
    const g = this.graph;
    if (!g) return;
    this.basePoints.clear();
    for (const b of infra.airbases) this.basePoints.set(b.id, new Vec3d(...b.point).normalize());
    this.bases = infra.airbases.map((b) => {
      const node = b.node >= 0 ? g.nodes[b.node] : undefined;
      const region = node && node.feature >= 0 ? (g.features.names[node.feature] ?? '') : '';
      const ends = runwayEnds({
        id: b.id,
        name: b.name,
        side: b.side,
        center: new Vec3d(...b.point),
        heading: b.heading,
        length: b.runwayLength,
        width: 45,
        elevation: 0,
      });
      return {
        id: b.id,
        name: b.name,
        side: b.side,
        kind: b.kind,
        region: region.replace(/^the /, ''),
        runwayLength: b.runwayLength,
        designators: `${ends[0].designator}/${ends[1].designator}`,
      };
    });
    // Alliance first (the Kestrel's side), then by name.
    this.bases.sort((a, b) =>
      a.side !== b.side ? (a.side === 'alliance' ? -1 : 1) : a.name.localeCompare(b.name),
    );
    this.menu.setBases(this.bases);
    const want = this.pendingBase ?? this.menu.selection;
    if (want !== null && this.bases.some((b) => b.id === want)) this.menu.select(want);
    else this.menu.select(null);
  }

  /**
   * The terrain the aircraft flies over, once the global pass is done: the
   * airfields' graded pads (decision 108) give the runways their elevations.
   */
  setTerrain(t: FlownTerrain): void {
    const g = flownGround(t, this.deps.radius, this.deps.globe.terrain, (d) =>
      this.deps.globe.props.obstacleAt(d),
    );
    this.runways = g.runways;
    this.ground = g.ground;
    // The sited runways (decision 220): their points and designators on the start screen.
    this.listBases(t.airbases);
    this.menu.setReady(true);
    // A base in the URL starts the flight at once (fast iteration).
    if (this.pendingBase !== null && this.state === 'menu') {
      const id = this.pendingBase;
      this.pendingBase = null;
      if (this.runways.some((r) => r.id === id)) this.start(id, this.options.spawn);
    }
  }

  /**
   * The world's weather model (its climate, seed and calendar), or null while a new world
   * generates: Free Flight runs it itself, without the sim (decision 134).
   */
  setClimate(config: WeatherConfig | null): void {
    this.weather.setWorld(config);
    this.temperatureShift = 0;
  }

  /** The weather the scene shows and the aircraft flies in, or null before it exists. */
  get weatherView(): WeatherView | null {
    return this.weather.view;
  }

  /** The chosen weather preset. */
  get weatherPreset(): WeatherPreset {
    return this.weather.preset;
  }

  /**
   * Chooses another weather. In flight it applies at once: the sky, the ground's wetness and
   * snow and the wind change to it.
   */
  setWeather(preset: WeatherPreset): void {
    this.options.weather = preset;
    this.menu.setWeather(preset);
    if (preset === this.weather.preset) return;
    this.weather.preset = preset;
    const flown = this.helo ?? this.model;
    if (this.state !== 'menu' && flown) {
      this.weather.finish(this.gameTime);
      this.temperatureShift = this.weather.temperatureShift(flown.pos, this.gameTime);
      this.deps.globe.resetAtmosphere();
    }
    this.writeUrl(this.state === 'menu' ? this.menu.selection : this.baseId);
    this.deps.weatherChanged?.(preset);
  }

  private runway(id: number): Runway | undefined {
    return this.runways.find((r) => r.id === id);
  }

  private focusBase(id: number): void {
    this.writeUrl(id);
    const s = this.deps.strategic;
    const p = this.basePoints.get(id);
    if (!p) return;
    s.orbit.lat = Math.asin(Math.max(-1, Math.min(1, p.y)));
    s.orbit.lon = Math.atan2(p.x, p.z);
    s.orbit.targetAltitude = 350_000;
  }

  /** Writes the mode's state into the URL, so a reload returns to it. */
  private writeUrl(base: number | null = this.baseId): void {
    const url = new URL(location.href);
    writeFreeFlightParams(url.searchParams, this.options, base);
    history.replaceState(null, '', url);
  }

  /** Spawns at base `id` on the runway or in the air, and flies. */
  start(id: number, spawn: SpawnKind): void {
    const r = this.runway(id);
    if (!r || !this.ground) return;
    this.baseId = id;
    this.writeUrl(id);
    this.applyInvert();
    this.applyGraphics();
    const choice = this.options.aircraft;
    if (!isJet(choice)) {
      this.side = 'alliance';
      this.startHelo(r, spawn, choice);
      return;
    }
    if (JET_BUNDLES[choice] !== this.jet) {
      this.jet = JET_BUNDLES[choice];
      this.spec = modelSpec(this.jet);
      this.flightSpec = parseFlightSpec(this.spec.flight, this.jet);
      this.wingtip = wingtipOf(this.spec, this.flightSpec.cg);
    }
    const AIRCRAFT = this.jet;
    this.side = AIRCRAFT_BUNDLES[AIRCRAFT]!.airWar?.side ?? 'alliance';
    this.helo = null;
    this.heloInput.enabled = false;
    this.capture.release();
    const R = this.deps.radius;
    const m = new FlightModel(this.flightSpec, R);
    m.unlimitedFuel = this.options.unlimitedFuel;
    // The help card in this jet's figures: the Kestrel's as written, another's from its data.
    const fs = this.flightSpec;
    this.help.refresh(
      AIRCRAFT === JET_BUNDLES.kestrel
        ? KESTREL_HELP
        : {
            afterburner: fs.engine.thrust.afterburner !== null,
            rotateKt: Math.round((0.91 * approachSpeed(fs, m.mass)) / KNOT / 5) * 5,
            approachDeg: Math.round(fs.controls.approachAlpha / DEG),
            gearKt: Math.round(fs.gear.maxSpeed / KNOT / 10) * 10,
          },
    );
    const end = runwayEnds(r)[0];
    if (spawn === 'air') spawnInAir(m, r, end);
    else spawnOnRunway(m, r, end);
    this.model = m;
    // The standard load is the flight data's own: the rack adds no mass or drag (decision 287).
    const bundle = AIRCRAFT_BUNDLES[AIRCRAFT]!;
    const pylons = bundle.pylons ?? [];
    // A loadout from the URL hangs its stores and fills its tanks (decision 300).
    const chosen = this.options.loadout
      ? bundle.airWar?.loadouts.find((l) => l.id === this.options.loadout)
      : undefined;
    this.rack = new StoresRack(
      this.flightSpec,
      pylons,
      chosen?.stations ?? standardStations(pylons, this.flightSpec.standardStores ?? {}),
      { loadout: chosen?.id ?? 'standard', expended: {} },
      bundle.gun,
    );
    if (chosen) this.rack.load(m, this.rack.capacity);
    this.gearDamageTold = false;
    this.monitor = new FlightMonitor(this.runways, R);
    this.monitor.reset(spawn === 'air');
    // An air start holds about the throttle for 300 kt (trim is near 0.15 of the lever).
    this.input.maxLever = this.flightSpec.engine.thrust.afterburner ? 1 : MIL_DETENT;
    this.input.reset(spawn === 'runway', spawn === 'air' ? 0.2 : 0);
    this.input.mode = CONTROL_MODE[this.options.control];
    this.aimEngaged = false;
    this.director.reset();
    this.pilot = this.autopilot && spawn === 'runway' ? new TestPilot(r, end, R) : null;
    // The sun and the moon: the chosen local time at the base, on Free Flight's day (clock.ts).
    this.gameTime = this.startTime(r);
    // The weather at that hour, complete before the first frame, and what it does to the ground.
    this.weather.preset = this.options.weather;
    this.weather.finish(this.gameTime);
    this.temperatureShift = this.weather.temperatureShift(r.center, this.gameTime);
    // The input source: the scripted pilot, mouse aim in the air once engaged, else the keys.
    const flown = new FlownAircraft(m, this.input.controls, AIRCRAFT);
    this.hold.release();
    flown.pilot = (_a, ctl, dt) => {
      if (this.pilot) this.pilot.fly(m, ctl, dt);
      else if (
        this.input.mode === 'mouse-aim' &&
        this.aimEngaged &&
        this.state === 'flying' &&
        !m.onGround
      ) {
        this.hold.release();
        this.mouseAim(m, ctl);
      } else if (this.state === 'flying' && this.input.handsOff && holdAllowed(m)) {
        // Direct control, the hand off the stick: the hold flies (decision 306).
        if (!this.hold.engaged) this.hold.engage(m);
        this.hold.fly(this.director, m, ctl, dt);
      } else this.hold.release();
    };
    this.attach(flown);
    this.crashAt = 0;
    // Scene: the aircraft, its shadow, the chase camera.
    const g = this.deps.globe;
    // The Kestrel hangs its rack's stations: the flight data's standard load of four
    // short-range missiles (decision 288), or the loadout the URL names (decision 300).
    const stores = storeMounts(this.rack!.stations, storeModel);
    this.showView(
      this.options.loadout ? `${AIRCRAFT}:${this.options.loadout}` : AIRCRAFT,
      () => new AircraftView(this.spec, this.flightSpec.cg, g.lighting, stores),
    );
    g.chase.rig = rigFromBundle(AIRCRAFT_BUNDLES[AIRCRAFT]!.rig!);
    g.chase.stickyLook = true;
    this.pose.q = m.q;
    g.cameraMode = 'chase';
    g.chase.resetView();
    g.chase.reset();
    this.syncPose();
    this.updateChase();
    // A new place and time: wetness from this weather's rain, no thunder for the time skipped.
    g.resetAtmosphere();
    this.deps.setView('simulation');
    this.menu.visible = false;
    this.summary.visible = false;
    this.pause.visible = false;
    this.hud.show(true);
    this.hud.clearMessages();
    this.hud.message(
      spawn === 'runway'
        ? [
            `${r.name}, runway ${end.designator}`,
            'Parking brake set: P to release, Shift for throttle, H for help',
            'Tab or a click: fly with the mouse (mouse aim); the keys fly until then',
          ]
        : [`Air start over ${r.name}`, 'Tab or a click: fly with the mouse, H for help'],
      7,
    );
    this.displayName = AIRCRAFT_BUNDLES[AIRCRAFT]!.name;
    this.startDisplays(AIRCRAFT, spawn === 'runway');
    this.state = 'flying';
    this.input.enabled = true;
  }

  /** Shows the view of aircraft `id` (built on first use) and hides the others. */
  private showView(id: string, build: () => AircraftView): void {
    const g = this.deps.globe;
    let v = this.views.get(id);
    if (!v) {
      v = build();
      v.planetRadius = this.deps.radius;
      g.vehicles.add(v.group, v.shadowMesh);
      this.views.set(id, v);
    }
    for (const [k, w] of this.views) {
      w.group.visible = k === id;
      w.shadowMesh.visible = k === id;
    }
    this.view = v;
  }

  /**
   * Spawns a helicopter at runway `r`: on the ground beside the runway's middle, or hovering
   * 150 m above it, rotor turning (a hot start, decision 151).
   */
  private startHelo(r: Runway, spawn: SpawnKind, choice: Exclude<AircraftChoice, JetChoice>): void {
    const R = this.deps.radius;
    const id = HELICOPTERS[choice];
    if (this.heloSpec?.model.id !== id) {
      const model = modelSpec(id);
      this.heloSpec = { model, flight: parseRotorcraftSpec(model.flight, id) };
    }
    const spec = this.heloSpec!;
    const m = new RotorcraftModel(spec.flight, R);
    m.unlimitedFuel = this.options.unlimitedFuel;
    const end = runwayEnds(r)[0];
    const dir = fromRunway(runwayFrame(r), 0, HELO_SPOT_ACROSS, R);
    const h = this.ground!.height(dir);
    if (spawn === 'air')
      m.place(dir.clone().scale(R + h + 150), new Vec3d(), end.heading, spec.flight.main.shaftTilt);
    else m.place(dir.clone().scale(R + h + m.gearHeight - 0.03), new Vec3d(), end.heading, 0);
    m.updateAttitude(this.ground!);
    this.model = null;
    this.helo = m;
    this.laws.reset(m, spawn !== 'air');
    this.monitor = new FlightMonitor(this.runways, R);
    this.monitor.reset(spawn === 'air');
    this.input.enabled = false;
    this.input.reset(false);
    this.heloInput.reset(spec.flight.gear.kind === 'wheels' && spawn !== 'air');
    this.pilot = null;
    this.gameTime = this.startTime(r);
    this.weather.preset = this.options.weather;
    this.weather.finish(this.gameTime);
    this.temperatureShift = this.weather.temperatureShift(r.center, this.gameTime);
    // The helicopter's laws turn the player's command into controls before every step.
    const flown = new FlownAircraft(m, this.heloControls, id);
    flown.pilot = (_a, ctl, dt) => {
      if (this.state === 'flying')
        this.laws.update(m, this.heloInput.command, this.assists, dt, ctl);
      this.heloInput.consumed();
    };
    this.attach(flown);
    this.crashAt = 0;
    const g = this.deps.globe;
    this.showView(id, () => new AircraftView(spec.model, spec.flight.cg, g.lighting));
    this.pose.q = m.q;
    g.cameraMode = 'chase';
    g.chase.rig = rigFromBundle(AIRCRAFT_BUNDLES[id]!.rig!, spec.flight.main.radius);
    g.chase.stickyLook = false;
    // A new sortie looks ahead; the zoom the player chose carries over (decision 160).
    const zoom = g.chase.zoom;
    g.chase.resetView();
    g.chase.zoom = zoom;
    g.chase.reset();
    this.syncPose();
    this.updateChase();
    g.resetAtmosphere();
    this.deps.setView('simulation');
    this.menu.visible = false;
    this.summary.visible = false;
    this.pause.visible = false;
    this.help.visible = false;
    this.hud.show(true);
    this.hud.clearMessages();
    this.hud.message(
      [
        spawn === 'air'
          ? `${spec.model.name} hovering over ${r.name}`
          : `${spec.model.name} beside runway ${end.designator}, ${r.name}`,
        'Tab or a click captures the mouse. W climbs, S descends, the mouse flies',
        'A/D slide, Q/E pedals, H hover hold, F1 help, Esc pause',
      ],
      9,
    );
    this.displayName = spec.model.name;
    this.startDisplays(HELICOPTERS[choice], spawn !== 'air');
    this.state = 'flying';
    this.heloInput.enabled = true;
  }

  private heloAction(a: HeloAction): void {
    if (!this.helo) return;
    switch (a) {
      case 'pause':
        if (this.pausedByLoss()) break;
        if (this.help.visible) this.help.visible = false;
        else this.setPaused(this.state === 'flying');
        break;
      case 'help':
        this.help.visible = !this.help.visible;
        if (this.help.visible) this.help.showBindings(HELO_BINDINGS, HELO_LABELS, HELO_HELP);
        break;
      case 'debug':
        this.debug = !this.debug;
        break;
      case 'recenterView':
        this.deps.globe.chase.recenter();
        break;
      case 'mouseCapture':
        this.toggleCapture();
        break;
      case 'invertMouse':
        this.toggleInvert();
        break;
      default:
        break;
    }
  }

  /** One frame of a helicopter's flight: input, control layer, model, outcomes. */
  private heloFrame(dt: number): void {
    const m = this.helo!;
    const chase = this.deps.globe.chase;
    const inp = this.heloInput;
    inp.update();
    chase.lookHeld = inp.lookHeld;
    if (inp.lookHeld) {
      const cam = this.deps.globe.camera;
      const rpp = (cam.fov * DEG) / Math.max(1, window.innerHeight);
      chase.look(inp.lookDelta.x, inp.lookDelta.y, rpp);
      inp.lookDelta.x = inp.lookDelta.y = 0;
    }
    if (inp.zoomSteps !== 0) {
      chase.zoomBy(inp.zoomSteps);
      inp.zoomSteps = 0;
    }
    const t0 = performance.now();
    let steps = 0;
    if (this.state === 'flying' || this.state === 'summary') {
      steps = this.flown!.advance(dt, this.ground!, MAX_STEPS);
    }
    this.steps = steps;
    this.physicsMs = performance.now() - t0;
    if (
      m.crashed &&
      this.state === 'flying' &&
      performance.now() > this.crashAt &&
      this.crashAt > 0
    )
      this.showSummary(m.crashed);
    this.syncPose();
    this.updateChase();
    if (this.view) {
      this.view.sun.copy(this.deps.globe.sun);
      const cam = this.deps.globe.camera;
      this.view.radPerPixel = (cam.fov * DEG) / Math.max(1, window.innerHeight);
    }
  }

  /** Makes `flown` this sortie's aircraft: wind, game time and outcomes on every step. */
  private attach(flown: FlownAircraft<FlightControls> | FlownAircraft<RotorControls>): void {
    const f = flown as FlownAircraft<unknown>;
    f.wind = (a) => this.setWind(a);
    f.onStep = (a, dt) => {
      this.gameTime += dt;
      // The Kestrel's gun fires and its rounds fly at the flight step (decision 295).
      if (this.rack && a === (this.model as unknown))
        this.rack.stepWeapons(this.model!, f.avionics, dt, this.gameTime - dt, this.ground);
      for (const e of this.monitor!.update(a, dt)) this.event(e);
    };
    this.flown = flown;
  }

  private toMenu(): void {
    this.state = 'menu';
    this.weather.hide();
    this.input.enabled = false;
    this.heloInput.enabled = false;
    this.capture.release();
    this.summary.visible = false;
    this.pause.visible = false;
    this.help.visible = false;
    this.hud.show(false);
    this.displays.enabled = false;
    this.displays.visible = false;
    if (this.view) {
      this.view.group.visible = false;
      this.view.shadowMesh.visible = false;
    }
    // What the pause menu changed (wind, fuel, time of day) shows on the start screen too.
    this.menu.setOptions(this.options);
    this.menu.visible = true;
    if (this.baseId !== null) {
      this.menu.select(this.baseId);
      this.focusBase(this.baseId);
    }
    this.deps.setView('strategic');
  }

  private setPaused(p: boolean): void {
    if (this.state !== 'flying' && this.state !== 'paused') return;
    this.state = p ? 'paused' : 'flying';
    this.pause.visible = p;
    if (p) this.capture.release();
    if (this.helo) this.heloInput.enabled = !p;
    else this.input.enabled = !p;
  }

  /**
   * Whether the browser took the mouse back a moment ago and paused: some
   * browsers also deliver the Escape that freed it, which must not resume.
   */
  private pausedByLoss(): boolean {
    return this.state === 'paused' && performance.now() - this.lostAt < 300;
  }

  /** The graphics options: the ground's micro-facets on or off (decision 197). */
  private applyGraphics(): void {
    this.deps.globe.terrain.micro.strength.value = this.options.microFacets ? 1 : 0;
    this.displays.uiScale = this.options.uiScale;
    document.body.classList.toggle('ff-no-fps', !this.options.showFps);
  }

  /** Gives both inputs the mouse inversion the options hold (decision 196). */
  private applyInvert(): void {
    this.input.invertAim = this.options.invertAim;
    this.input.invertStick = this.options.invertStick;
    this.heloInput.invertPitch = this.options.invertHelo;
  }

  /** The inversion key (I): inverts the flown aircraft's mouse up and down, or reverts it. */
  private toggleInvert(): void {
    if (this.state !== 'flying') return;
    const k = invertKey(this.options.aircraft, this.options.control);
    this.options[k] = !this.options[k];
    this.applyInvert();
    this.writeUrl();
    this.hud.message(
      [
        this.options[k] ? 'Mouse up and down inverted' : 'Mouse up and down normal',
        invertNote(k, this.options[k]),
      ],
      3,
    );
  }

  /** The capture key (Tab): frees a captured mouse for the displays, or captures a free one. */
  private toggleCapture(): void {
    if (this.state !== 'flying') return;
    const freeing = this.capture.captured;
    this.capture.toggle();
    if (freeing) this.hud.message('Mouse free: Tab or a click on the view to fly with it', 2.5);
  }

  private action(a: FlightAction): void {
    // Both inputs hear Escape (a disabled one passes it on to close a menu): the jet's
    // actions count only while no helicopter is the flown aircraft, or Escape toggles twice.
    if (this.helo) return;
    const c = this.input.controls;
    switch (a) {
      case 'pause':
        if (this.pausedByLoss()) break;
        if (this.help.visible) this.help.visible = false;
        else this.setPaused(this.state === 'flying');
        break;
      case 'gear':
        c.gearDown = !c.gearDown;
        break;
      case 'speedbrake':
        c.speedbrake = !c.speedbrake;
        break;
      case 'parkingBrake':
        c.parkingBrake = !c.parkingBrake;
        break;
      case 'eject': {
        // X twice within 2 s (decision 301): the sortie ends as a crash the crew survives.
        const now = performance.now() / 1000;
        if (now - this.ejectArmed > 2) {
          this.ejectArmed = now;
          this.hud.message('Press X again to eject', 2);
        } else if (this.model && !this.model.crashed && this.state === 'flying') {
          this.ejectArmed = -Infinity;
          this.model.crash('ejected; the crew is safe');
        }
        break;
      }
      case 'mouseCapture':
        this.toggleCapture();
        break;
      case 'invertMouse':
        this.toggleInvert();
        break;
      case 'mouseAim':
        this.options.control = this.options.control === 'aim' ? 'direct' : 'aim';
        this.input.mode = CONTROL_MODE[this.options.control];
        this.input.centerCursor();
        this.director.reset();
        this.capture.grab();
        this.writeUrl();
        this.hud.message(MOUSE_MODE_MESSAGE[this.input.mode], 3);
        break;
      case 'recenterView':
        this.deps.globe.chase.recenter();
        break;
      case 'sight': {
        // The right click or Z (decision 338): in on the pipper or the boresight, and out.
        const chase = this.deps.globe.chase;
        chase.sightOn = !chase.sightOn;
        break;
      }
      case 'help':
        this.help.visible = !this.help.visible;
        break;
      case 'debug':
        this.debug = !this.debug;
        break;
      default:
        break;
    }
  }

  /** Copies the model's state into the view's pose. */
  private syncPose(): void {
    const p = this.pose;
    if (this.helo) {
      const h = this.helo;
      p.pos.copy(h.pos);
      p.q = h.q;
      p.elevator = p.aileron = p.rudder = 0;
      p.gear = 1;
      p.speedbrake = p.afterburner = p.flaps = 0;
      p.groundHeight = this.ground!.height(h.pos.clone().normalize());
      const speed = h.telemetry.rotorSpeed;
      p.rotors = [
        { azimuth: h.azimuth, speed, tiltForward: h.tiltForward, tiltRight: h.tiltRight },
        { azimuth: h.tailAzimuth, speed, tiltForward: 0, tiltRight: 0 },
      ];
      // The rotor's wash flattens the grass under it (decision 176).
      this.deps.globe.groundCover.setDownwash(rotorDownwash(h, this.wash));
      return;
    }
    p.rotors = undefined;
    this.deps.globe.groundCover.setDownwash(null);
    const m = this.model!;
    const t = m.telemetry;
    p.pos.copy(m.pos);
    p.q = m.q;
    p.elevator = t.laws.elevator;
    p.aileron = t.laws.aileron;
    p.rudder = t.laws.rudder;
    p.gear = m.gear;
    p.speedbrake = m.speedbrake;
    p.afterburner = m.afterburner;
    p.flaps = m.gear;
    p.groundHeight = this.ground!.height(m.pos.clone().normalize());
  }

  private updateChase(): void {
    followAirframe(this.deps.globe.chase.target, this.helo ?? this.model!);
  }

  /** Advances the mode by `dt` real seconds; call before the scene renders. */
  frame(dt: number, frameMs: number): void {
    this.frameMs = frameMs;
    // The frame-rate gauge moves to the top center while a sortie is on (decision 217).
    const sortie = this.state !== 'menu';
    if (sortie !== this.sortieShown && typeof document !== 'undefined') {
      this.sortieShown = sortie;
      document.body.classList.toggle('ff-flying', sortie);
    }
    if (this.state === 'menu') {
      this.menu.setStatus(this.deps.status());
      // Ahead of the flight: the weather at the hour it would start, a few milliseconds a frame.
      // The map shows none of it: it is for choosing a base.
      const base = this.menu.selection;
      const p = base !== null ? this.basePoints.get(base) : undefined;
      this.weather.prepare(
        flightStartTime(
          p ? Math.atan2(p.x, p.z) : 0,
          this.menu.options.timeOfDay,
          this.deps.orbit,
          this.deps.calendar(),
        ),
      );
      return;
    }
    if (this.helo) {
      if (!this.ground || !this.monitor) return;
      this.weather.update(this.gameTime);
      this.heloFrame(dt);
      return;
    }
    const m = this.model;
    if (!m || !this.ground || !this.monitor) return;
    this.weather.update(this.gameTime);
    const chase = this.deps.globe.chase;
    // Mouse aim flies only in the air, and only once the mouse has been captured this sortie
    // (decision 206); on the wheels, and until then, the keys steer and rotate.
    this.input.directOnGround = m.onGround || !this.aimEngaged;
    this.input.aimRotates = m.onGround && this.aimEngaged;
    this.input.update(this.state === 'flying' ? dt : 0);
    chase.lookHeld = this.input.lookHeld;
    if (this.input.lookHeld) {
      const cam = this.deps.globe.camera;
      const rpp = (cam.fov * DEG) / Math.max(1, window.innerHeight);
      chase.look(this.input.lookDelta.x, this.input.lookDelta.y, rpp);
      this.input.lookDelta.x = this.input.lookDelta.y = 0;
    }
    if (this.input.zoomSteps !== 0) {
      chase.zoomBy(this.input.zoomSteps);
      this.input.zoomSteps = 0;
    }
    const t0 = performance.now();
    let steps = 0;
    if (this.state === 'flying' || this.state === 'summary') {
      steps = this.flown!.advance(dt, this.ground, MAX_STEPS);
      // Gear doors failed in an overspeed (decision 207): said once; the strip keeps the caution.
      if (m.gearDamaged && !this.gearDamageTold) {
        this.gearDamageTold = true;
        this.hud.message(['GEAR DOORS DAMAGED', 'GEAR STAYS DOWN'], 5, true);
      }
    }
    this.steps = steps;
    this.physicsMs = performance.now() - t0;
    if (
      m.crashed &&
      this.state === 'flying' &&
      performance.now() > this.crashAt &&
      this.crashAt > 0
    ) {
      this.showSummary(m.crashed);
    }
    this.syncPose();
    this.updateChase();
    if (this.view) {
      this.view.sun.copy(this.deps.globe.sun);
      const cam = this.deps.globe.camera;
      this.view.radPerPixel = (cam.fov * DEG) / Math.max(1, window.innerHeight);
    }
  }

  /** The game time at which a flight from runway `r` starts with the chosen time of day. */
  private startTime(r: Runway): number {
    const lon = Math.atan2(r.center.x, r.center.z);
    return flightStartTime(lon, this.options.timeOfDay, this.deps.orbit, this.deps.calendar());
  }

  /** The air's velocity at the aircraft from the weather, before a step of the model. */
  private setWind(m: Airframe): void {
    if (!this.options.wind) {
      m.wind.set(0, 0, 0);
      return;
    }
    airVelocity(
      this.weather.view,
      m.pos,
      this.deps.radius,
      this.gameTime,
      Math.max(0, m.telemetry.radarAltitude),
      m.wind,
    );
  }

  /**
   * Where mouse aim flies: the cursor's direction in the chase view with its look
   * centered, so looking around does not steer the jet (decision 198).
   */
  private aimDirection(): Vec3d {
    return aimDirection(this.deps.globe.chase, this.deps.globe.camera.aspect, this.input.cursor);
  }

  /** Mouse aim (decision 219): the shared law, the jet's director toward the aim. */
  private mouseAim(m: FlightModel, ctl: FlightControls): void {
    flyMouseAim(this.director, m, this.aimDirection(), ctl, this.input);
  }

  private event(e: FlightEvent): void {
    const m: Airframe = this.helo ?? this.model!;
    switch (e.kind) {
      case 'liftoff':
        this.hud.message('AIRBORNE', 3);
        break;
      case 'touchdown': {
        const td = e.touchdown;
        const grade = { smooth: 'SMOOTH', good: 'GOOD', firm: 'FIRM', hard: 'HARD LANDING' }[
          td.grade
        ];
        this.hud.message([`TOUCHDOWN: ${grade}`, ...touchdownLines(td)], 8, td.grade === 'hard');
        break;
      }
      case 'stopped':
        // A helicopter lands and lifts off again where it is: no summary card.
        if (e.landing && !m.crashed && !this.helo) this.showSummary(null);
        break;
      case 'crash':
        this.hud.message([`CRASH: ${e.reason}`], 10, true);
        if (e.reason.includes('sink rate'))
          this.hud.message(
            `Sink rate ${sinkText(m.telemetry.verticalSpeed < 0 ? -m.telemetry.verticalSpeed : 0)}`,
            10,
            true,
          );
        this.crashAt = performance.now() + 2000;
        break;
    }
  }

  private showSummary(crash: string | null): void {
    const m: Airframe = this.helo ?? this.model!;
    const stopped = crash ? null : this.monitor!.runwayUnder(m);
    this.summary.show({
      crash,
      landing: this.monitor!.lastTouchdown,
      stoppedAt: stopped ? { id: stopped.id, name: stopped.name } : null,
      homeId: this.baseId!,
      flightTime: this.flown?.flightTime ?? 0,
      distance: this.flown?.distance ?? 0,
    });
    this.state = 'summary';
    this.input.enabled = false;
    this.heloInput.enabled = false;
    this.displays.enabled = false;
    this.capture.release();
  }

  /** Draws the HUD after the scene has rendered (the camera's matrices are current). */
  drawHud(camera: PerspectiveCamera): void {
    if (this.state === 'menu') return;
    const project = matrixProjector(
      camera.matrixWorldInverse.elements,
      camera.projectionMatrix.elements,
      window.innerWidth,
      window.innerHeight,
    );
    if (this.helo) {
      const eye = this.deps.globe.chase.eye;
      const frame = buildHeloHudFrame(
        this.helo,
        this.laws,
        this.heloControls,
        this.heloInput.command,
        {
          aid: landingAid(this.helo, this.runways, eye),
          ground: this.ground!,
          eye,
          locked: this.heloInput.locked,
          timing: this.debug
            ? { frameMs: this.frameMs, physicsMs: this.physicsMs, steps: this.steps }
            : null,
        },
      );
      frame.panels = true;
      this.updateDisplays(frame);
      frame.target = this.hudTarget(this.helo, eye);
      this.hud.draw(frame, project);
      return;
    }
    const m = this.model;
    if (!m) return;
    const aim = this.input.mode === 'mouse-aim';
    const mode = this.pilot ? 'autopilot' : aim ? 'mouse aim' : 'direct';
    const captured = this.capture.captured;
    // The control cursor (decision 198): mouse aim's ring always (a free mouse holds it), the
    // direct stick only while the mouse flies it.
    let control: ControlCursor | null = null;
    if (!this.pilot && aim && this.aimEngaged) {
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
    } else if (!this.pilot && captured) {
      const c = this.input.cursor;
      control = {
        kind: 'stick',
        x: c.x,
        y: c.y,
        dir: null,
        active: true,
        full: STICK_FULL,
        deadzone: STICK_DEADZONE,
      };
    }
    const frame = buildHudFrame(m, this.input.controls, {
      aid: landingAid(m, this.runways, this.deps.globe.chase.eye),
      // A free mouse holds the aim point; in direct mode the keys fly (decision 198).
      mode: !captured && !this.pilot ? `${mode} · TAB TO FLY` : mode,
      control,
      timing: this.debug
        ? { frameMs: this.frameMs, physicsMs: this.physicsMs, steps: this.steps }
        : null,
    });
    frame.panels = true;
    frame.holds = this.hold.label ? [this.hold.label] : [];
    this.updateDisplays(frame);
    frame.target = this.hudTarget(m, this.deps.globe.chase.eye);
    // The gun (decision 295): the trigger while flying, the pipper at the lock's range.
    const av = this.displays.avionics;
    const trigger = this.state === 'flying' && this.input.trigger;
    if (this.rack?.gun) this.rack.gun.trigger = trigger && gunSelected(av);
    frame.gun = gunHud(m, this.rack, av, this.deps.globe.chase.eye, this.lockRange(m) ?? undefined);
    // The IR missile (decision 297): the traffic as heat sources, the seeker slaved to a
    // radar lock, a launch on the trigger's press, the outcomes as messages.
    if (this.rack) {
      this.rack.sources = (this.traffic?.aircraft ?? [])
        .filter((a) => !this.downed.has(a.id))
        .map((a) => {
          const st = trafficState(a, this.gameTime, this.deps.radius);
          return { id: a.id, pos: st.pos, vel: st.vel, time: this.gameTime };
        });
      // Hits on the traffic (decision 301): at full damage it is shot down and falls burning.
      for (const h of this.rack.hits.splice(0)) {
        if (!h.air || this.downed.has(h.target)) continue;
        const total = (this.airDamage.get(h.target) ?? 0) + h.amount;
        this.airDamage.set(h.target, total);
        if (total < 1) continue;
        this.downed.add(h.target);
        const a = this.traffic?.aircraft.find((x) => x.id === h.target);
        if (!a) continue;
        const st = trafficState(a, h.time, this.deps.radius);
        this.wrecks.add(a.model, st.pos, st.vel, this.downed.size);
        this.hud.message('Splash', 4);
      }
      this.rack.updateSeeker(m, av, this.gameTime, this.lockDirection(m));
      // Bombs one per press, rockets while held (decision 300).
      const kind = av.weapon ? STORES[av.weapon]?.kind : undefined;
      this.rack.rocketTrigger = trigger && kind === 'rockets';
      if (trigger && !this.triggerWas && !gunSelected(av)) {
        if (kind === 'bomb') this.rack.dropBomb(m, av);
        const shot = this.rack.launch(m, av, this.gameTime, 'own');
        if (shot) this.hud.message(shot.target ? 'Missile away' : 'Missile away, no lock', 2.5);
      }
      for (const x of this.rack.finished.splice(0))
        this.hud.message(x.state === 'hit' ? 'Missile hit' : 'Missile missed', 3);
    }
    this.triggerWas = trigger;
    frame.seeker = seekerHud(m, this.rack, av, this.deps.globe.chase.eye, this.gameTime);
    const ground = this.ground;
    frame.ccip = ground
      ? ccipHud(m, this.rack, av, this.deps.globe.chase.eye, (d) => ground.height(d))
      : null;
    this.deps.globe.chase.sightPoint = sightPoint(frame, m, this.deps.globe.chase.eye);
    const radar = this.displays.avionics.radar;
    frame.acmCone = radar.on && radar.mode === 'acm' && !radar.lock ? ACM_CONE : null;
    this.hud.draw(frame, project);
  }

  /** Starts the displays for a sortie in the aircraft of model spec `model` (decision 199). */
  private startDisplays(model: string, onGround: boolean): void {
    // The avionics state lives with the flown aircraft (R1.5); the displays read it there.
    if (this.flown) this.displays.attach(this.flown);
    this.displays.reset(onGround);
    this.displays.enabled = true;
    this.displays.visible = true;
    this.displayModel = model;
    this.sortieAt = performance.now();
    this.fuelCapacity = (this.helo ?? this.model)?.fuel ?? 0;
    this.displaysAt = -Infinity;
    this.startTraffic();
  }

  /** The traffic and the sensors for a new sortie: traffic only with the option on (decision 218). */
  private startTraffic(): void {
    this.sensors.reset();
    this.sensorSnap = null;
    this.threatsHeard = new Map();
    this.groundMapImg = null;
    this.groundMapAt = -Infinity;
    this.terrainSnap = null;
    this.terrainAt = -Infinity;
    const base = this.baseId !== null ? this.basePoints.get(this.baseId) : undefined;
    // A new sortie: the traffic whole again (decision 301).
    this.downed.clear();
    this.airDamage.clear();
    this.wrecks.clear();
    this.traffic =
      this.options.traffic && base
        ? buildTraffic(base, `base-${this.baseId}`, this.deps.radius, this.side)
        : null;
    for (const a of this.traffic?.aircraft ?? []) {
      // Keyed by model as well: a Pact player's traffic flies the other side's types (R2.7).
      if (this.trafficViews.has(`${a.id}/${a.model}`)) continue;
      const spec = modelSpec(a.model);
      const b = AIRCRAFT_BUNDLES[a.model];
      const standard = (spec.flight as { standardStores?: Record<string, number> } | undefined)
        ?.standardStores;
      const stores = b ? standardMounts(b, standard) : [];
      const v = new AircraftView(spec, [0, 0, 0], this.deps.globe.lighting, stores);
      v.planetRadius = this.deps.radius;
      v.shadowMesh.visible = false;
      this.deps.globe.vehicles.add(v.group, v.shadowMesh);
      this.trafficViews.set(`${a.id}/${a.model}`, v);
    }
  }

  /** Places the traffic's views for the frame about to be drawn (camera-relative, rule 4). */
  private poseTraffic(eye: Readonly<Vec3d>): void {
    const on = this.traffic !== null && this.state !== 'menu';
    for (const [key, v] of this.trafficViews) {
      const a = on
        ? this.traffic!.aircraft.find((x) => `${x.id}/${x.model}` === key && !this.downed.has(x.id))
        : undefined;
      v.group.visible = a !== undefined;
      v.shadowMesh.visible = false;
      if (!a) continue;
      const st = trafficState(a, this.gameTime, this.deps.radius);
      const up = st.pos.clone().normalize();
      const fwd = st.vel.clone().normalize();
      const right0 = fwd.clone().cross(up).normalize();
      // Banked about the velocity: the lift leans into the turn.
      const down0 = up.clone().scale(-1);
      const c = Math.cos(st.bank);
      const sn = Math.sin(st.bank);
      const right = right0.clone().scale(c).addScaled(down0, sn);
      const down = down0.clone().scale(c).addScaled(right0, -sn);
      v.update(
        {
          pos: st.pos,
          q: Quatd.fromAxes(fwd, right, down),
          elevator: 0,
          aileron: 0,
          rudder: 0,
          gear: 0,
          speedbrake: 0,
          afterburner: 0,
          flaps: 0,
          groundHeight: 0,
        },
        eye,
      );
      // Its contrails and vortices: a banked turn pulls 1 / cos(bank) g (decision 329).
      this.deps.globe.effects.aircraft(`traffic:${a.id}`, {
        pos: st.pos,
        vel: st.vel,
        forward: fwd,
        right,
        load: 1 / Math.max(0.1, c),
        span: 10,
        length: 16,
      });
    }
  }

  /**
   * The sensors' update (decision 218): the traffic as targets, the weather's visibility,
   * daylight from the sun, the terrain's line of sight and a datalink feed from a notional
   * airborne early-warning aircraft; then the picture relative to the aircraft, and a lost
   * lock said once.
   */
  private updateSensors(m: Airframe, profile: (typeof AVIONICS_PROFILES)[string]): void {
    const ground = this.ground;
    if (!ground) return;
    const R = this.deps.radius;
    const own = { id: 'player', pos: m.pos };
    const targets: SensorTarget[] = this.traffic
      ? trafficTargets(this.traffic, this.gameTime, R, (d) => ground.sensedHeight(d), own).filter(
          (t) => !this.downed.has(t.id),
        )
      : [];
    const up = m.pos.clone().normalize();
    const sunUp = up.dot(this.deps.globe.sun);
    const report = this.weather.view?.report(up, this.gameTime);
    const env: SensorEnv = {
      time: this.gameTime,
      // Visibility near the ground; above the cloud base the air is clear. The base is
      // given above the ground (decision 221: it was compared with the altitude above the sea).
      visibility:
        report && m.pos.length() - R - ground.height(up) < report.cloudBase
          ? report.visibility
          : Math.max(30_000, report?.visibility ?? 30_000),
      daylight: Math.min(1, Math.max(0, (sunUp + 0.1) / 0.2)),
      // Line of sight over the height service (R1.6); the ground map keeps the tiles.
      lineOfSight: (a, b) => lineOfSight(a, b, R, { height: (d) => ground.sightHeight(d) }),
    };
    const av = this.displays.avionics;
    const sys = profile.systems;
    const feed: DatalinkFeed | null = sys.includes('datalink')
      ? {
          delay: 5,
          error: 400,
          targets: targets.filter((x) => x.airborne && x.pos.clone().sub(m.pos).length() < 250_000),
        }
      : null;
    const forward = m.bodyAxis(0);
    const upBody = m.bodyAxis(2).scale(-1);
    this.sensors.update(
      {
        id: own.id,
        side: this.side,
        pos: m.pos,
        vel: m.vel,
        forward,
        up: upBody,
        radar: sys.includes('radar-aa') ? (profile.radar ?? null) : null,
        radarOn: av.radar.on,
        radarMode: av.radar.mode,
        lock: av.radar.lock,
        rwr: sys.includes('rwr'),
        datalink: feed !== null,
      },
      targets,
      env,
      feed,
    );
    const pic = this.sensors.picture;
    // The lock holds while the radar still tracks the contact; else it breaks, said once.
    const lock = av.radar.lock;
    if (lock && !pic.contacts.some((c) => c.id === lock && c.source === 'radar')) {
      this.displays.command({ to: 'avionics', command: { type: 'radar-lock', id: null } });
      this.hud.message('Lock lost', 3, true);
    }
    this.sensorSnap = relativePicture(
      pic,
      { pos: m.pos, vel: m.vel, forward, up: upBody },
      R,
      sys.includes('radar-aa') ? (profile.radar ?? null) : null,
      this.displays.avionics,
      profile.skin,
    );
    this.sensorSnap.groundMap = this.paintGroundMap(m, forward, profile);
    // Air combat mode locks the first contact in its cone (decision 223).
    const radar = this.displays.avionics.radar;
    if (radar.on && radar.mode === 'acm' && !radar.lock) {
      const id = acmAcquire(pic, m.pos, forward, upBody, this.gameTime);
      if (id) this.displays.command({ to: 'avionics', command: { type: 'radar-lock', id } });
    }
    // The threat warning's calls: a line in the messages and a tone (decision 223).
    const called = threatCalls(this.threatsHeard, this.sensorSnap.threats);
    this.threatsHeard = called.heard;
    for (const c of called.calls) {
      this.hud.message(c.text, 4, c.warn);
      this.deps.tone?.(c.tone);
    }
  }

  /**
   * The air-to-ground radar's ground map (decision 226): painted every 2 s of game time
   * while a display shows it, from the drawn ground; the last picture with its age between.
   */
  private paintGroundMap(
    m: Airframe,
    forward: Readonly<Vec3d>,
    profile: (typeof AVIONICS_PROFILES)[string],
  ): SnapshotSensors['groundMap'] {
    const d = this.displays.display;
    const ground = this.ground;
    if (!d || !ground || !profile.systems.includes('radar-ag')) return null;
    const shows = (['leftMfd', 'rightMfd'] as const).some(
      (s) => d.slots[s].format === 'radar-ag' && d.slots[s].state === 'expanded',
    );
    if (!shows)
      return this.groundMapImg
        ? { ...this.groundMapImg, age: this.gameTime - this.groundMapAt }
        : null;
    const range = groundRadarRange(profile.skin, this.displays.avionics.groundRadar.range);
    const stale = this.gameTime - this.groundMapAt >= 2 || this.gameTime < this.groundMapAt;
    if (!this.groundMapImg || stale || this.groundMapImg.range !== range) {
      this.groundMapImg = groundMap(m.pos, forward, range, Math.PI / 3, this.deps.radius, {
        height: (dir) => ground.sensedHeight(dir),
        water: (dir) => ground.surface(dir) === 'water',
        cultural: (dir) => {
          const k = ground.surface(dir);
          return k === 'runway' ? 1 : k === 'field' ? 0.5 : 0;
        },
      });
      this.groundMapAt = this.gameTime;
    }
    return { ...this.groundMapImg, age: this.gameTime - this.groundMapAt };
  }

  /**
   * Heights around the aircraft for the moving map's elevation modes (decision 227): 80 × 80
   * samples of the drawn ground in the map's frame, taken again each second, on a new
   * range, or when a track-up map has turned 3°.
   */
  private sampleTerrain(m: Airframe, track: number): SnapshotTerrain | null {
    const d = this.displays.display;
    const ground = this.ground;
    if (!d || !ground || d.map.mode === 'chart') return null;
    const shows = (['leftMfd', 'rightMfd'] as const).some(
      (s) => d.slots[s].format === 'moving-map' && d.slots[s].state === 'expanded',
    );
    if (!shows) return null;
    const R = this.deps.radius;
    const altitude = m.pos.length() - R;
    const half = mapRange(AVIONICS_PROFILES[this.displayModel]?.skin ?? 'alliance', d.map.range);
    const rotation = d.map.northUp ? 0 : track;
    // A depressed map's screen center lies ahead of the aircraft (decision 310).
    const ahead = mapAhead(d.map, half);
    const t = this.terrainSnap;
    const now = performance.now();
    const turned = t
      ? Math.abs(Math.atan2(Math.sin(rotation - t.rotation), Math.cos(rotation - t.rotation)))
      : 0;
    if (
      t &&
      t.halfExtent === half &&
      (t.ahead ?? 0) === ahead &&
      turned < 3 * DEG &&
      now - this.terrainAt < 1000
    )
      return { ...t, altitude };
    const n = 80;
    const up = m.pos.clone().normalize();
    const east = new Vec3d(0, 1, 0).cross(up).normalize();
    const north = up.clone().cross(east);
    // The map's up and right on the ground.
    const fwd = north.clone().scale(Math.cos(rotation)).addScaled(east, Math.sin(rotation));
    const right = fwd.clone().cross(up);
    const heights = new Array<number>(n * n);
    const water = new Array<number>(n * n);
    const dir = new Vec3d();
    const horiz = new Vec3d();
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = (((i + 0.5) / n) * 2 - 1) * half;
        const y = (1 - ((j + 0.5) / n) * 2) * half + ahead;
        const g = Math.hypot(x, y);
        horiz.copy(fwd).scale(y).addScaled(right, x);
        if (g > 0) horiz.scale(1 / g);
        dir
          .copy(up)
          .scale(Math.cos(g / R))
          .addScaled(horiz, Math.sin(g / R));
        const wet = ground.surface(dir) === 'water';
        water[j * n + i] = wet ? 1 : 0;
        heights[j * n + i] = wet ? 0 : Math.round(ground.sensedHeight(dir));
      }
    this.terrainSnap = { n, halfExtent: half, ahead, rotation, heights, water, altitude };
    this.terrainAt = now;
    return this.terrainSnap;
  }

  /** The locked contact as the HUD's target box: relative to the camera, with its range. */
  /** The direction to the locked contact (world, unit), or null without a lock: the seeker slaves to it. */
  private lockDirection(m: Airframe): Vec3d | null {
    const lock = this.displays.avionics.radar.lock;
    const c = lock ? this.sensors.picture.contacts.find((x) => x.id === lock) : undefined;
    if (!c) return null;
    return new Vec3d(c.pos[0] - m.pos.x, c.pos[1] - m.pos.y, c.pos[2] - m.pos.z).normalize();
  }

  /** The locked contact's range (m), or null without a lock. */
  private lockRange(m: Airframe): number | null {
    const lock = this.displays.avionics.radar.lock;
    const c = lock ? this.sensors.picture.contacts.find((x) => x.id === lock) : undefined;
    return c ? Math.hypot(c.pos[0] - m.pos.x, c.pos[1] - m.pos.y, c.pos[2] - m.pos.z) : null;
  }

  private hudTarget(m: Airframe, eye: Readonly<Vec3d>): HudFrame['target'] {
    const lock = this.displays.avionics.radar.lock;
    const c = lock ? this.sensors.picture.contacts.find((x) => x.id === lock) : undefined;
    if (!c) return null;
    const range = Math.hypot(c.pos[0] - m.pos.x, c.pos[1] - m.pos.y, c.pos[2] - m.pos.z);
    return {
      point: [c.pos[0] - eye.x, c.pos[1] - eye.y, c.pos[2] - eye.z],
      label: `${(range / NAUTICAL_MILE).toFixed(1)}`,
    };
  }

  /** The master mode's triggers every frame; the displays and the strip at 10 Hz (decision 199). */
  private updateDisplays(f: HudFrame): void {
    const m: Airframe | null = this.helo ?? this.model;
    const profile = AVIONICS_PROFILES[this.displayModel];
    if (!m || !profile) return;
    // The skin's units on the HUD: the Pact's metric (R2.7).
    f.units = profile.skin === 'pact' ? 'metric' : 'imperial';
    const t = m.telemetry;
    const changed = this.displays.triggers({
      onGround: m.onGround,
      gearDown: !this.helo && this.input.controls.gearDown,
      radarAltitude: t.radarAltitude,
      groundSpeed: t.groundSpeed,
      helicopter: this.helo !== null,
    });
    const now = performance.now();
    if (!changed && now - this.displaysAt < 100) return;
    this.displaysAt = now;
    const control = this.pilot
      ? 'autopilot'
      : this.helo
        ? 'fly-by-mouse'
        : this.input.mode === 'mouse-aim'
          ? 'mouse aim'
          : 'direct';
    // Where the aircraft is, its track over the ground and its heading (rad from north).
    const up = m.pos.clone().normalize();
    const east = new Vec3d(0, 1, 0).cross(up).normalize();
    const north = up.clone().cross(east);
    const vg = m.vel.clone().addScaled(up, -m.vel.dot(up));
    const heading = t.heading;
    const track = vg.length() > 5 ? Math.atan2(vg.dot(east), vg.dot(north)) : heading;
    const position = {
      lat: Math.asin(Math.max(-1, Math.min(1, up.y))),
      lon: Math.atan2(up.x, up.z),
      radius: this.deps.radius,
    };
    this.requestMap(position);
    this.updateSensors(m, profile);
    const snap = snapshotFromHud(f, {
      position,
      track,
      heading,
      time: (now - this.sortieAt) / 1000,
      name: this.displayName,
      profile,
      avionics: this.displays.avionics,
      capacity: this.fuelCapacity,
      // Drop tanks count toward joker, bingo and low fuel (decision 307).
      fuelTotal: f.fuel + (this.helo ? 0 : (this.model?.tankFuel ?? 0)),
      groundSpeed: t.groundSpeed,
      fixedGear: this.helo !== null,
      control,
      mouseFree: this.state === 'flying' && !this.capture.captured && !this.pilot,
      sensors: this.sensorSnap,
      stores:
        this.rack && !this.helo
          ? storesSnapshot(
              this.rack.stations,
              this.rack.loaded,
              this.model?.tankFuel ?? 0,
              this.rack.gun?.rounds ?? null,
              rocketCounts(this.rack.loaded, this.rack.state.expended),
            )
          : null,
      messages: this.hud.log.map((l) => ({
        at: (l.at - this.sortieAt) / 1000,
        text: l.text,
        warn: l.warn,
      })),
    });
    snap.terrain = this.sampleTerrain(m, track);
    this.displays.update(snap);
  }

  /**
   * The moving map's picture (decision 201): every half second while a display shows the
   * map, the strategic scene drawn straight down over the aircraft, √2 wider than the
   * map's range so a turned picture still fills the screen.
   */
  private requestMap(at: { lat: number; lon: number }): void {
    const d = this.displays.display;
    if (!d || this.state !== 'flying') return;
    const shows = (['leftMfd', 'rightMfd'] as const).some(
      (s) => d.slots[s].format === 'moving-map' && d.slots[s].state === 'expanded',
    );
    const now = performance.now();
    if (!shows || now - this.mapAt < 500) return;
    this.mapAt = now;
    const half = mapRange(AVIONICS_PROFILES[this.displayModel]?.skin ?? 'alliance', d.map.range);
    this.movingMap ??= new MovingMap(this.deps.strategic, this.deps.strategic.gpu, 512);
    void this.movingMap
      .picture(at.lat, at.lon, half * mapPictureScale(d.map))
      .then((pic) => {
        if (pic) this.displays.view.setMapPicture({ ...pic, flipY: MAP_FLIP_Y });
      })
      .catch(() => {
        /* a lost device or a resize: the next picture tries again */
      });
  }

  /** A strip item's click: the flight control it stands for (decision 199). */
  private displayControl(a: ControlsAction): void {
    if (this.state !== 'flying') return;
    if (a === 'mouseCapture') {
      this.toggleCapture();
      return;
    }
    if (this.helo) {
      if (a === 'hoverHold') this.heloInput.command.toggleHover = true;
      else if (a === 'parkingBrake')
        this.heloInput.command.parkingBrake = !this.heloInput.command.parkingBrake;
      return;
    }
    if (a === 'gear' || a === 'speedbrake' || a === 'parkingBrake') this.action(a);
  }

  /** Whether the terrain and runways are ready to fly. */
  get ready(): boolean {
    return this.ground !== null;
  }

  /**
   * Steps the flight `seconds` of game time ahead without drawing, or until
   * `stop` returns true (tools and screenshots; the autopilot or the held
   * controls fly). Returns the game seconds advanced.
   */
  advance(seconds: number, stop?: (phase: string | null) => boolean): number {
    const m = this.model;
    if (!m || !this.ground || !this.monitor) return 0;
    const flown = this.flown as FlownAircraft<FlightControls> | null;
    if (!flown) return 0;
    // The scripted pilot or the held controls fly; mouse aim takes no part.
    const pilot = this.pilot;
    const scripted = pilot
      ? (_a: unknown, ctl: FlightControls, dt: number) => pilot.fly(m, ctl, dt)
      : null;
    let t = 0;
    while (t < seconds && !(stop?.(this.pilot?.phase ?? null) ?? false)) {
      flown.step(this.ground, scripted);
      t += FLIGHT_STEP;
    }
    this.syncPose();
    this.updateChase();
    return t;
  }

  /** For headless checks and screenshots: the flown aircraft's state. */
  get flight(): {
    model: FlightModel | null;
    helo: RotorcraftModel | null;
    state: State;
    pilot: string | null;
  } {
    return {
      model: this.model,
      helo: this.helo,
      state: this.state,
      pilot: this.pilot?.phase ?? null,
    };
  }
}
