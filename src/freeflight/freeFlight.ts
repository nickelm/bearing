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
import { DEG } from '../core/units';
import { Quatd } from '../core/quat';
import { Vec3d } from '../core/vec3d';
import type { GlobeScene } from '../render/sim/globeScene';
import { AircraftView } from '../render/sim/aircraft/aircraftView';
import type { AircraftPose } from '../render/sim/aircraft/aircraftView';
import { airfieldPads, globalMapSampler } from '../render/sim/infra/airfieldGrading';
import type { InfraScene } from '../render/sim/infra/infraScene';
import { modelSpec } from '../render/common/models/library';
import type { StrategicScene } from '../render/strategic/strategicScene';
import { FlightDirector, along } from '../sim/flight/flightDirector';
import type { FlightControls } from '../sim/flight/controlLaws';
import { FAST_JET_RIG, followAirframe, helicopterRig } from '../render/sim/camera/chaseCamera';
import type { Airframe } from '../sim/flight/airframe';
import { FLIGHT_STEP, FlightModel } from '../sim/flight/flightModel';
import { assistsFor } from '../sim/flight/rotor/assists';
import { HeloLaws } from '../sim/flight/rotor/heloLaws';
import { neutralRotorControls, RotorcraftModel } from '../sim/flight/rotor/rotorcraftModel';
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
import type { TerrainEdits } from '../worldgen/edits';
import {
  HelpOverlay,
  PauseMenu,
  SummaryCard,
  sinkText,
  touchdownLines,
} from '../ui/flight/flightCards';
import type { SoundSettings } from '../ui/flight/flightCards';
import { FlightInput } from '../ui/flight/flightInput';
import type { FlightAction } from '../ui/flight/flightInput';
import { DEFAULT_OPTIONS, FreeFlightMenu } from '../ui/flight/freeFlightMenu';
import type {
  AircraftChoice,
  BaseEntry,
  FreeFlightOptions,
  SpawnKind,
} from '../ui/flight/freeFlightMenu';
import { Hud, matrixProjector } from '../ui/flight/hud';
import { flightStartTime } from './clock';
import { writeFreeFlightParams } from './url';
import type { FreeFlightUrl } from './url';
import { FlightWeather } from './flightWeather';
import { buildHudFrame, landingAid } from './hudFrame';
import { buildHeloHudFrame } from './heloHud';
import { AirfieldGround, runwaysOf } from './ground';

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
  /** Another weather was chosen on the start screen or in the pause menu. */
  weatherChanged?(preset: WeatherPreset): void;
}

type State = 'menu' | 'flying' | 'paused' | 'summary';

/** Most physics steps per frame: a stalled tab catches up at most a quarter second. */
const MAX_STEPS = 30;
const AIRCRAFT = 'alliance-fighter';
/** The helicopters' model specs (track H1, Proposal 0004). */
const HELICOPTERS: Record<Exclude<AircraftChoice, 'kestrel'>, string> = {
  scout: 'alliance-scout-helo',
  utility: 'alliance-utility-helo',
};
/** The help card's note for helicopters. */
const HELO_HELP = [
  'Click the view to capture the mouse; Escape gives it back and pauses.',
  'Takeoff: hold W until clear of the ground, let go to hold the altitude. Move the mouse forward to tilt the nose down and fly forward; back to slow down. Slow and let go: the hover holds (Assisted).',
  'In the hover the mouse turns the nose; above about 40 kt it banks into a coordinated turn. A/D slide sideways in the hover.',
  'Landing: slow to a hover over the spot, then hold S: the descent eases near the ground (VS under the radar altitude turns amber if it is too fast). Keep S held on the ground to lower the collective.',
  'Camera: drag with the right mouse button to look around; the view stays where you leave it. Drag down to look further ahead. V or the middle button recenters it; the wheel zooms.',
];
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
  private readonly heloControls = neutralRotorControls();
  /** The views built so far, one per aircraft. */
  private readonly views = new Map<string, AircraftView>();
  private pilot: TestPilot | null = null;
  private baseId: number | null = null;
  private pendingBase: number | null;
  private readonly autopilot: boolean;
  private acc = 0;
  private debug = false;
  private frameMs = 0;
  private physicsMs = 0;
  private steps = 0;
  private flightTime = 0;
  private distance = 0;
  private crashAt = 0;
  private readonly spec = modelSpec(AIRCRAFT);
  private readonly flightSpec = parseFlightSpec(this.spec.flight, AIRCRAFT);
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
        optionsChanged: (o) => {
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
    this.input = new FlightInput(deps.canvas);
    this.input.onAction = (a) => this.action(a);
    this.heloInput = new HeloInput(deps.canvas);
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
      if (this.view && (this.model || this.helo) && this.state !== 'menu')
        this.view.update(this.pose, eye);
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
      this.menu.setBases([]);
      return;
    }
    const g = s.graph;
    for (const b of s.infrastructure.airbases)
      this.basePoints.set(b.id, new Vec3d(...b.point).normalize());
    this.bases = s.infrastructure.airbases.map((b) => {
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
  setTerrain(t: {
    infra: InfraScene;
    edits: TerrainEdits;
    height: Float32Array;
    n: number;
    airbases: StrategicWorld['infrastructure'];
  }): void {
    const sampler = globalMapSampler(t.height, t.n);
    const pads = airfieldPads(t.infra, sampler);
    this.runways = runwaysOf(t.airbases, pads);
    const terrain = this.deps.globe.terrain;
    this.ground = new AirfieldGround(
      this.runways,
      t.edits,
      (d) => t.edits.apply(d, sampler(d)),
      this.deps.radius,
      (d) => terrain.displaySurfaceAt(d),
    );
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
    if (this.options.aircraft !== 'kestrel') {
      this.startHelo(r, spawn, this.options.aircraft);
      return;
    }
    this.helo = null;
    this.heloInput.enabled = false;
    this.heloInput.release();
    this.help.refresh();
    const R = this.deps.radius;
    const m = new FlightModel(this.flightSpec, R);
    m.unlimitedFuel = this.options.unlimitedFuel;
    const end = runwayEnds(r)[0];
    if (spawn === 'air') spawnInAir(m, r, end);
    else spawnOnRunway(m, r, end);
    this.model = m;
    this.monitor = new FlightMonitor(this.runways, R);
    this.monitor.reset(spawn === 'air');
    // An air start holds about the throttle for 300 kt (trim is near 0.15 of the lever).
    this.input.reset(spawn === 'runway', spawn === 'air' ? 0.2 : 0);
    this.input.mode = 'keyboard';
    this.director.reset();
    this.pilot = this.autopilot && spawn === 'runway' ? new TestPilot(r, end, R) : null;
    // The sun and the moon: the chosen local time at the base, on Free Flight's day (clock.ts).
    this.gameTime = this.startTime(r);
    // The weather at that hour, complete before the first frame, and what it does to the ground.
    this.weather.preset = this.options.weather;
    this.weather.finish(this.gameTime);
    this.temperatureShift = this.weather.temperatureShift(r.center, this.gameTime);
    this.acc = 0;
    this.flightTime = 0;
    this.distance = 0;
    this.crashAt = 0;
    // Scene: the aircraft, its shadow, the chase camera.
    const g = this.deps.globe;
    this.showView(AIRCRAFT, () => new AircraftView(this.spec, this.flightSpec.cg, g.lighting));
    g.chase.rig = FAST_JET_RIG;
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
          ]
        : [`Air start over ${r.name}`, 'H for help'],
      7,
    );
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
  private startHelo(r: Runway, spawn: SpawnKind, choice: Exclude<AircraftChoice, 'kestrel'>): void {
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
    this.acc = 0;
    this.flightTime = 0;
    this.distance = 0;
    this.crashAt = 0;
    const g = this.deps.globe;
    this.showView(id, () => new AircraftView(spec.model, spec.flight.cg, g.lighting));
    this.pose.q = m.q;
    g.cameraMode = 'chase';
    g.chase.rig = helicopterRig(spec.flight.main.radius);
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
        'Click the view to capture the mouse. W climbs, S descends, the mouse flies',
        'A/D slide, Q/E pedals, H hover hold, F1 help, Esc pause',
      ],
      9,
    );
    this.state = 'flying';
    this.heloInput.enabled = true;
  }

  private heloAction(a: HeloAction): void {
    if (!this.helo) return;
    switch (a) {
      case 'pause':
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
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= FLIGHT_STEP && steps < MAX_STEPS) {
        this.acc -= FLIGHT_STEP;
        steps++;
        if (this.state === 'flying')
          this.laws.update(m, inp.command, this.assists, FLIGHT_STEP, this.heloControls);
        inp.consumed();
        const p0 = m.pos.clone();
        this.setWind(m);
        m.step(this.heloControls, this.ground!);
        this.distance += p0.distanceTo(m.pos);
        if (!m.crashed) this.flightTime += FLIGHT_STEP;
        this.gameTime += FLIGHT_STEP;
        for (const e of this.monitor!.update(m, FLIGHT_STEP)) this.event(e);
      }
      if (steps >= MAX_STEPS) this.acc = 0;
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

  private toMenu(): void {
    this.state = 'menu';
    this.weather.hide();
    this.input.enabled = false;
    this.heloInput.enabled = false;
    this.heloInput.release();
    this.summary.visible = false;
    this.pause.visible = false;
    this.help.visible = false;
    this.hud.show(false);
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
    if (this.helo) {
      this.heloInput.enabled = !p;
      if (p) this.heloInput.release();
    } else {
      this.input.enabled = !p;
    }
  }

  private action(a: FlightAction): void {
    // Both inputs hear Escape (a disabled one passes it on to close a menu): the jet's
    // actions count only while no helicopter is the flown aircraft, or Escape toggles twice.
    if (this.helo) return;
    const c = this.input.controls;
    switch (a) {
      case 'pause':
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
      case 'mouseStick':
        this.input.mode = this.input.mode === 'mouse-stick' ? 'keyboard' : 'mouse-stick';
        this.hud.message(
          this.input.mode === 'mouse-stick' ? 'Mouse as stick' : 'Keyboard stick',
          2,
        );
        break;
      case 'mouseAim':
        this.input.mode = this.input.mode === 'mouse-aim' ? 'keyboard' : 'mouse-aim';
        this.director.reset();
        this.hud.message(
          this.input.mode === 'mouse-aim'
            ? 'Mouse aim: the flight director flies to the cursor'
            : 'Keyboard stick',
          2.5,
        );
        break;
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
    // Mouse aim flies only in the air; on the wheels the keys steer and rotate.
    this.input.directOnGround = m.onGround;
    this.input.update(this.state === 'flying' ? dt : 0);
    chase.lookHeld = this.input.lookHeld;
    if (this.input.lookHeld) {
      const cam = this.deps.globe.camera;
      const rpp = (cam.fov * DEG) / Math.max(1, window.innerHeight);
      chase.look(this.input.lookDelta.x, this.input.lookDelta.y, rpp);
      this.input.lookDelta.x = this.input.lookDelta.y = 0;
    }
    const t0 = performance.now();
    let steps = 0;
    if (this.state === 'flying' || this.state === 'summary') {
      this.acc += Math.min(dt, 0.25);
      const ctl = this.input.controls;
      while (this.acc >= FLIGHT_STEP && steps < MAX_STEPS) {
        this.acc -= FLIGHT_STEP;
        steps++;
        if (this.pilot) this.pilot.fly(m, ctl, FLIGHT_STEP);
        else if (this.input.mode === 'mouse-aim' && this.state === 'flying' && !m.onGround)
          this.mouseAim(m, ctl);
        const p0 = m.pos.clone();
        this.setWind(m);
        m.step(ctl, this.ground);
        this.distance += p0.distanceTo(m.pos);
        if (!m.crashed) this.flightTime += FLIGHT_STEP;
        this.gameTime += FLIGHT_STEP;
        for (const e of this.monitor.update(m, FLIGHT_STEP)) this.event(e);
      }
      if (steps >= MAX_STEPS) this.acc = 0;
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

  private mouseAim(m: FlightModel, ctl: FlightControls): void {
    const ch = this.deps.globe.chase;
    const cam = this.deps.globe.camera;
    const tanY = Math.tan(ch.fov / 2);
    const right = ch.forward.clone().cross(ch.up).normalize();
    const dir = ch.forward
      .clone()
      .addScaled(right, this.input.cursor.x * tanY * cam.aspect)
      .addScaled(ch.up, this.input.cursor.y * tanY)
      .normalize();
    const a = along(m, dir);
    this.director.fly(
      m,
      {
        course: a.course,
        gamma: a.gamma,
        speed: null,
        maxBank: 80 * DEG,
        maxTurnRate: 20 * DEG,
        maxLoadDelta: 4,
      },
      ctl,
      FLIGHT_STEP,
    );
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
      flightTime: this.flightTime,
      distance: this.distance,
    });
    this.state = 'summary';
    this.input.enabled = false;
    this.heloInput.enabled = false;
    this.heloInput.release();
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
      this.hud.draw(frame, project);
      return;
    }
    const m = this.model;
    if (!m) return;
    const frame = buildHudFrame(m, this.input.controls, {
      aid: landingAid(m, this.runways, this.deps.globe.chase.eye),
      mode: this.pilot
        ? 'autopilot'
        : { keyboard: 'direct', 'mouse-stick': 'mouse stick', 'mouse-aim': 'mouse aim' }[
            this.input.mode
          ],
      aim: this.input.mode === 'mouse-aim' ? { ...this.input.cursor } : null,
      timing: this.debug
        ? { frameMs: this.frameMs, physicsMs: this.physicsMs, steps: this.steps }
        : null,
    });
    this.hud.draw(frame, project);
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
    let t = 0;
    while (t < seconds && !(stop?.(this.pilot?.phase ?? null) ?? false)) {
      if (this.pilot) this.pilot.fly(m, this.input.controls, FLIGHT_STEP);
      const p0 = m.pos.clone();
      this.setWind(m);
      m.step(this.input.controls, this.ground);
      this.distance += p0.distanceTo(m.pos);
      if (!m.crashed) this.flightTime += FLIGHT_STEP;
      this.gameTime += FLIGHT_STEP;
      t += FLIGHT_STEP;
      for (const e of this.monitor.update(m, FLIGHT_STEP)) this.event(e);
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
