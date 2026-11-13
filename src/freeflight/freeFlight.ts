/**
 * Free Flight (decision 134): the mode's glue on the main thread. It takes the
 * world the app generates for a seed, lists its airbases on the start screen,
 * spawns the F-21 Kestrel, runs the flight model at fixed 120 Hz steps from the
 * frame clock, feeds the chase camera, the animated model and the HUD, watches
 * the outcomes and runs the session (pause, restart, summary, refuel at another
 * base). No war simulation runs in this mode.
 */
import type { PerspectiveCamera } from 'three/webgpu';
import { withLocalTime } from '../core/calendar';
import type { CampaignCalendar, OrbitParams } from '../core/calendar';
import { DEG, HOUR } from '../core/units';
import { Quatd } from '../core/quat';
import { Vec3d } from '../core/vec3d';
import type { GlobeScene } from '../render/sim/globeScene';
import { AircraftView } from '../render/sim/aircraft/aircraftView';
import type { AircraftPose } from '../render/sim/aircraft/aircraftView';
import type { SurfaceGrading } from '../render/common/terrain/grading';
import { airfieldPads, globalMapSampler } from '../render/sim/infra/airfieldGrading';
import type { InfraScene } from '../render/sim/infra/infraScene';
import { modelSpec } from '../render/common/models/library';
import type { StrategicScene } from '../render/strategic/strategicScene';
import { FlightDirector, along } from '../sim/flight/flightDirector';
import type { FlightControls } from '../sim/flight/controlLaws';
import { FLIGHT_STEP, FlightModel } from '../sim/flight/flightModel';
import { parseFlightSpec } from '../sim/flight/flightSpec';
import { FlightMonitor } from '../sim/flight/outcomes';
import type { FlightEvent } from '../sim/flight/outcomes';
import { runwayEnds } from '../sim/flight/runway';
import type { Runway } from '../sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../sim/flight/spawn';
import { TestPilot } from '../sim/flight/testPilot';
import type { StrategicWorld } from '../worldgen/campaignWorld';
import {
  HelpOverlay,
  PauseMenu,
  SummaryCard,
  sinkText,
  touchdownLines,
} from '../ui/flight/flightCards';
import { FlightInput } from '../ui/flight/flightInput';
import type { FlightAction } from '../ui/flight/flightInput';
import { DEFAULT_OPTIONS, FreeFlightMenu } from '../ui/flight/freeFlightMenu';
import type { BaseEntry, FreeFlightOptions, SpawnKind } from '../ui/flight/freeFlightMenu';
import { Hud, matrixProjector } from '../ui/flight/hud';
import { buildHudFrame, landingAid } from './hudFrame';
import { AirfieldGround, runwaysOf } from './ground';

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
}

/** Options from the URL: `?mode=freeflight&seed=…&base=…&tod=…&spawn=runway|air&fuel=unlimited|limited&autopilot`. */
export interface FreeFlightUrl {
  seed: string;
  base: number | null;
  options: Partial<FreeFlightOptions>;
  autopilot: boolean;
}

export function parseFreeFlightUrl(q: URLSearchParams, seed: string): FreeFlightUrl {
  const options: Partial<FreeFlightOptions> = {};
  const tod = Number(q.get('tod'));
  if (q.has('tod') && Number.isFinite(tod)) options.timeOfDay = Math.min(24, Math.max(0, tod));
  const spawn = q.get('spawn');
  if (spawn === 'air' || spawn === 'runway') options.spawn = spawn;
  const fuel = q.get('fuel');
  if (fuel === 'limited') options.unlimitedFuel = false;
  if (fuel === 'unlimited') options.unlimitedFuel = true;
  const base = q.has('base') ? Number(q.get('base')) : NaN;
  return {
    seed,
    base: Number.isInteger(base) ? base : null,
    options,
    autopilot: q.has('autopilot'),
  };
}

type State = 'menu' | 'flying' | 'paused' | 'summary';

/** Most physics steps per frame: a stalled tab catches up at most a quarter second. */
const MAX_STEPS = 30;
const AIRCRAFT = 'alliance-fighter';

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
        exit: () => this.deps.exit(),
      },
      this.options,
    );
    this.menu.setSeed(url.seed);
    this.pause = new PauseMenu(this.options, {
      resume: () => this.setPaused(false),
      restart: (spawn) => this.start(this.baseId!, spawn),
      changeBase: () => this.toMenu(),
      exit: () => this.deps.exit(),
      optionsChanged: (o) => {
        if (this.model) this.model.unlimitedFuel = o.unlimitedFuel;
        this.writeUrl();
      },
    });
    this.summary = new SummaryCard({
      restart: () => this.start(this.baseId!, this.options.spawn),
      continueFrom: (id) => this.start(id, 'runway'),
      changeBase: () => this.toMenu(),
    });
    this.input = new FlightInput(deps.canvas);
    this.input.onAction = (a) => this.action(a);
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
      if (this.view && this.model && this.state !== 'menu') this.view.update(this.pose, eye);
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
    grading: SurfaceGrading;
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
      t.grading,
      (d) => t.grading.apply(d, sampler(d)),
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
    url.searchParams.set('mode', 'freeflight');
    if (base !== null) url.searchParams.set('base', String(base));
    url.searchParams.set('tod', String(this.options.timeOfDay));
    url.searchParams.set('spawn', this.options.spawn);
    url.searchParams.set('fuel', this.options.unlimitedFuel ? 'unlimited' : 'limited');
    history.replaceState(null, '', url);
  }

  /** Spawns at base `id` on the runway or in the air, and flies. */
  start(id: number, spawn: SpawnKind): void {
    const r = this.runway(id);
    if (!r || !this.ground) return;
    this.baseId = id;
    this.writeUrl(id);
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
    // The sun: the chosen local time at the base, on the campaign calendar's start day.
    const lon = Math.atan2(r.center.x, r.center.z);
    this.gameTime = withLocalTime(
      this.deps.orbit.solarDay,
      lon,
      this.options.timeOfDay * HOUR,
      this.deps.orbit,
      this.deps.calendar(),
    );
    this.acc = 0;
    this.flightTime = 0;
    this.distance = 0;
    this.crashAt = 0;
    // Scene: the aircraft, its shadow, the chase camera.
    const g = this.deps.globe;
    if (!this.view) {
      this.view = new AircraftView(this.spec, this.flightSpec.cg, g.lighting);
      this.view.planetRadius = R;
      g.vehicles.add(this.view.group, this.view.shadowMesh);
    }
    this.view.group.visible = true;
    this.view.shadowMesh.visible = true;
    this.pose.q = m.q;
    g.cameraMode = 'chase';
    g.chase.reset();
    this.syncPose();
    this.updateChase();
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

  private toMenu(): void {
    this.state = 'menu';
    this.input.enabled = false;
    this.summary.visible = false;
    this.pause.visible = false;
    this.help.visible = false;
    this.hud.show(false);
    if (this.view) {
      this.view.group.visible = false;
      this.view.shadowMesh.visible = false;
    }
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
    this.input.enabled = !p;
  }

  private action(a: FlightAction): void {
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
    const m = this.model!;
    const p = this.pose;
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
    const m = this.model!;
    const t = this.deps.globe.chase.target;
    t.pos.copy(m.pos);
    m.bodyAxis(0, t.forward);
    m.bodyAxis(2, t.up).scale(-1);
    t.velocity.copy(m.vel);
    t.onGround = m.onGround;
  }

  /** Advances the mode by `dt` real seconds; call before the scene renders. */
  frame(dt: number, frameMs: number): void {
    this.frameMs = frameMs;
    if (this.state === 'menu') {
      this.menu.setStatus(this.deps.status());
      return;
    }
    const m = this.model;
    if (!m || !this.ground || !this.monitor) return;
    const chase = this.deps.globe.chase;
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
        else if (this.input.mode === 'mouse-aim' && this.state === 'flying') this.mouseAim(m, ctl);
        const p0 = m.pos.clone();
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
      { course: a.course, gamma: a.gamma, speed: null, maxBank: 80 * DEG, maxTurnRate: 20 * DEG },
      ctl,
      FLIGHT_STEP,
    );
  }

  private event(e: FlightEvent): void {
    const m = this.model!;
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
        if (e.landing && !m.crashed) this.showSummary(null);
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
    const m = this.model!;
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
  }

  /** Draws the HUD after the scene has rendered (the camera's matrices are current). */
  drawHud(camera: PerspectiveCamera): void {
    const m = this.model;
    if (!m || this.state === 'menu') return;
    const project = matrixProjector(
      camera.matrixWorldInverse.elements,
      camera.projectionMatrix.elements,
      window.innerWidth,
      window.innerHeight,
    );
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
  get flight(): { model: FlightModel | null; state: State; pilot: string | null } {
    return { model: this.model, state: this.state, pilot: this.pilot?.phase ?? null };
  }
}
