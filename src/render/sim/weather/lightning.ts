/**
 * Lightning in the simulation view: plays the strikes lightningStrikes.ts
 * schedules around the camera. Each frame it
 *
 * - finds the strikes under way (the storm field is read at each strike's
 *   place, in the cells within `STRIKE_RANGE` of the camera),
 * - writes the brightest one to `WeatherState.flash` and `flashPosition`, which
 *   the clouds glow from, and to `PlanetLighting.flashLight` and
 *   `flashPosition`, which light the ground and everything on it,
 * - draws the bolt of the brightest cloud-to-ground strike, and
 * - calls `onThunder` once for every strike that began since the last frame.
 *
 * **Time.** At the speed of real time the flash is a function of game time
 * alone: the same frame shows the same lightning at any frame rate and after
 * a seek. When game time runs faster than `ACCELERATION_LIMIT` times real
 * time the strikes of a minute would fall into a second and the sky would
 * strobe, so the view changes to showing a choice of them in real time: at
 * most one new strike every `ACCELERATED_GAP` real seconds, the strongest as
 * seen from the camera of those that began in the frame's interval (at most
 * the last two slots of it), each flickering over its real fraction of a
 * second. Only the strikes shown thunder. How fast the clock runs is an
 * average over about `RATE_WINDOW` real seconds, not one frame's step: a
 * clock that advances in steps of its own (Free Flight's moves by whole
 * flight-model steps, the campaign's follows the worker's snapshots) gives
 * frames with no step and frames with several, and those are not
 * acceleration. A single long step is a jump of the clock: it shows nothing
 * of what was skipped, and neither does a step backward; a second long step
 * right after it is taken for the clock's new speed.
 *
 * **The bolt** is one instanced mesh in the pipeline's overlay scene: a quad
 * per segment of the channel (lightningStrikes.ts `buildBolt`), turned to
 * face the camera, at least a couple of pixels wide at any distance, with a
 * white-hot core and a halo wide enough for the bloom to take. It is drawn
 * additively (`overlayAdditive`), so it lights the image and covers nothing.
 * It runs from just inside the cloud base to the ground under it and hides
 * behind terrain (the scene's depth) and behind the planet's curve (a strike
 * beyond the horizon shows only what stands above it); the air between dims
 * it by the weather's visibility, less than it dims the ground
 * (`BOLT_PENETRATION`). The overlay is drawn over the clouds, so a camera
 * above the cloud base would see the channel through the deck: there the bolt
 * fades by the cloud cover over the strike (`boltShowing`), and what shows of
 * the strike from above is the cloud's glow. Branches glow with the first
 * stroke only: later strokes follow the main channel.
 *
 * **Warming up.** The bolt's material and the pipeline's variant with the
 * overlay in it are compiled when they are first drawn, which stalls a frame
 * or several: the first bolt of a storm would be over before it showed. So
 * the mesh is drawn once without light in the first frame, and again when a
 * strike to the ground is a few seconds off (the schedule is known ahead), at
 * most every `WARM_GAP` real seconds (`warm`).
 *
 * Positions follow rule 4: the bolt's segments are stored relative to its
 * ground point, in world axes, and the ground point is given to the shader
 * relative to the camera, subtracted in float64.
 */
import {
  BufferAttribute,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  attribute,
  cross,
  dot,
  exp,
  float,
  Fn,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { WorldSeed } from '../../../core/rng';
import type { GameTime, Meters, Seconds } from '../../../core/units';
import { KM } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import { Channel } from '../../../sim/weather/frame';
import type { WeatherView } from '../../../sim/weather/frame';
import type { PlanetLighting } from '../lighting/planetLighting';
import { overlayAdditive } from '../post/simPipeline';
import {
  BOLT_MAX_SEGMENTS,
  BOLT_SEGMENT_FLOATS,
  buildBolt,
  cellsNear,
  STRIKE_RANGE,
  STRIKE_SLOT,
  strikeIntensity,
  strikesAt,
  strikesBetween,
  strikeSeed,
} from './lightningStrikes';
import type { Strike } from './lightningStrikes';
import { KOSCHMIEDER } from './weatherState';
import type { WeatherState } from './weatherState';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Game seconds per real second above which strikes are shown in real time, a few of them. */
export const ACCELERATION_LIMIT = 1.5;
/** Least real time between two strikes shown while game time is accelerated (s). */
export const ACCELERATED_GAP: Seconds = 0.9;
/** Game time a frame may span and still thunder for every strike in it (s). */
export const CATCH_UP: Seconds = 2;
/** Real time over which the game clock's speed is averaged (s). */
export const RATE_WINDOW: Seconds = 0.3;
/** Weight of the assumption that the clock runs at the speed of real time, before it has been watched (real s). */
const RATE_PRIOR: Seconds = 0.1;
/** A step this many times the clock's average step (and longer than CATCH_UP) is a jump. */
const JUMP_FACTOR = 4;
/** Distance at which a strike's light on the ground has fallen to half (m). */
export const FLASH_REACH: Meters = 8 * KM;
/** Light of the strongest flash on a surface under it, in display units (daylight is 1.4). */
export const FLASH_ILLUMINANCE = 0.6;
/** The light's color: blue-white. */
export const FLASH_TINT: readonly [number, number, number] = [0.78, 0.86, 1];
/** Radiance of a bolt's core in display units: far above every bloom threshold. */
const BOLT_RADIANCE = 60;
/** Half-width of the main channel's core (m), and the least it is drawn (pixels). */
const BOLT_HALF_WIDTH: Meters = 1.6;
const BOLT_MIN_PIXELS = 0.9;
/** Half-width of a segment's quad in core half-widths: room for the halo. */
const BOLT_HALO = 6;
/**
 * Share of the air's extinction that dims a bolt. A channel is some ten thousand times as
 * bright as the display's range holds, so it shows through rain at more than twice the
 * distance at which a hangar is lost in it.
 */
const BOLT_PENETRATION = 0.35;
/** How far the channel's top is inside the cloud, above its base (m). */
const BOLT_INTO_CLOUD: Meters = 150;
/** Least real time between two frames that draw the bolt's mesh without light, to have its shaders compiled (s). */
const WARM_GAP: Seconds = 2;
/** The camera moves this far before the cells around it are listed again (m). */
const CELL_REFRESH: Meters = 2 * KM;

/** What the audio needs to know of a strike. */
export interface ThunderEvent {
  /** From the camera to the discharge (m). */
  distance: Meters;
  /** Strength 0..1. */
  energy: number;
  /** Game time of the strike. */
  time: GameTime;
  /** True for a strike to the ground (a sharp crack when near), false for a flash in the cloud. */
  ground: boolean;
}

/** What `Lightning.update` reads each frame. */
export interface LightningFrame {
  /** The weather, or null for clear air. */
  view: WeatherView | null;
  /** The camera, planet-centered (m). */
  eye: Readonly<Vec3d>;
  gameTime: GameTime;
  /** Real seconds since the last frame. */
  dt: Seconds;
  /** Angle of one pixel (rad): vertical field of view over the viewport's height. */
  pixelAngle: number;
}

/**
 * A strike to the ground at a direction from the planet center, for previews
 * and tests: one stroke of full strength that glows for half a second.
 */
export function strikeAtPlace(direction: Readonly<Vec3d>, seed = 1): Strike {
  return {
    cell: -1,
    slot: 0,
    time: 0,
    direction: new Vec3d().copy(direction).normalize(),
    ground: true,
    energy: 1,
    storm: 1,
    height: 0,
    strokes: [{ offset: 0, peak: 1, decay: 0.12 }],
    duration: 0.5,
    seed,
  };
}

/** How strongly a strike of an intensity shows at a distance, for choosing among several. */
function prominence(strike: Strike, intensity: number, distance: Meters): number {
  return (intensity * strike.energy) / (1 + (distance / (15 * KM)) ** 2);
}

export class Lightning {
  /** The bolt; add it to the pipeline's overlay scene. Empty without a scene distance. */
  readonly group = new Group();
  /** Off: no flashes, no bolt, no thunder. */
  enabled = true;
  /** Called once per strike that begins, in order of time (the audio delays the sound itself). */
  onThunder: ((event: ThunderEvent) => void) | null = null;
  /**
   * Displayed height of the ground above sea level under a direction (m), or
   * null where it is not known; without it bolts end at sea level.
   */
  groundAt: ((direction: Readonly<Vec3d>) => number | null) | null = null;
  /**
   * A strike shown at a fixed age (s) in place of the schedule, for previews
   * and tests; null plays the schedule.
   */
  forced: { strike: Strike; age: Seconds } | null = null;
  /** The strike whose flash is shown, and its brightness 0..1 (as of the last update). */
  current: Strike | null = null;
  intensity = 0;

  private seedValue = strikeSeed(0);
  private readonly cellCenter = new Vec3d();
  private cells: number[] | null = null;
  private lastTime = NaN;
  /** Real seconds this object has been updated for. */
  private realClock = 0;
  /** The strike shown while game time is accelerated, and when it began on the real clock. */
  private shown: { strike: Strike; start: Seconds } | null = null;
  private lastShown = -Infinity;
  /** Game and real seconds of the last frames, the older the less (`RATE_WINDOW`): their ratio is the clock's speed. */
  private gameSpan = RATE_PRIOR;
  private realSpan = RATE_PRIOR;
  /** The last frame's step was a jump of the clock. */
  private jumped = false;

  private readonly mesh: Mesh | null = null;
  private readonly geometry: InstancedBufferGeometry | null = null;
  private readonly start = new Float32Array(BOLT_MAX_SEGMENTS * 3);
  private readonly end = new Float32Array(BOLT_MAX_SEGMENTS * 3);
  private readonly params = new Float32Array(BOLT_MAX_SEGMENTS * 3);
  /** The strike the mesh holds, its ground point (planet-centered) and its height. */
  private boltOf: Strike | null = null;
  private readonly boltGround = new Vec3d();
  private boltHeight = 0;
  /** Cloud cover over the strike the mesh holds, 0..1. */
  private boltCover = 0;
  /** Share of the bolt's light that reaches the camera past the cloud, 0..1 (as of the last update). */
  boltShowing = 1;
  /** The bolt's ground point relative to the camera (m). */
  private readonly anchor = uniform(new Vector3());
  private readonly boltIntensity = uniform(0);
  private readonly branchGain = uniform(1);
  private readonly pixelAngle = uniform(0.001);
  /** Extinction of the air between the camera and the bolt (1/m). */
  private readonly extinction = uniform(0);
  /** |eye|² − R², for the test against the planet's curve (float64 on the CPU). */
  private readonly horizon = uniform(1);
  private readonly scratch = new Vec3d();
  private readonly position = new Vec3d();
  /** The next frame draws the bolt's mesh without light (`warm`). */
  private warming = true;
  private lastWarm = -Infinity;
  /** The time slot for which the strikes ahead were last looked up. */
  private warmSlot = NaN;

  /**
   * `sceneDistance` is the pipeline's (post/simPipeline.ts); without it there
   * is no bolt, and the flashes and the thunder still happen.
   */
  constructor(
    private readonly radius: Meters,
    private readonly weather: WeatherState,
    private readonly lighting: PlanetLighting,
    sceneDistance: F | null,
  ) {
    lighting.flashReach.value = FLASH_REACH;
    if (!sceneDistance) return;
    const quad = new InstancedBufferGeometry();
    // x: −1..1 across the segment, y: 0 at its start and 1 at its end.
    quad.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3),
    );
    quad.setIndex([0, 1, 2, 2, 1, 3]);
    quad.setAttribute('bStart', new InstancedBufferAttribute(this.start, 3));
    quad.setAttribute('bEnd', new InstancedBufferAttribute(this.end, 3));
    quad.setAttribute('bParams', new InstancedBufferAttribute(this.params, 3));
    quad.instanceCount = 0;
    this.geometry = quad;
    this.mesh = new Mesh(quad, this.material(sceneDistance));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  /** The world seed the strikes are drawn from. */
  set seed(seed: WorldSeed) {
    this.seedValue = strikeSeed(seed);
  }

  private material(sceneDistance: F): MeshBasicNodeMaterial {
    const m = overlayAdditive(new MeshBasicNodeMaterial({ side: DoubleSide }));
    m.name = 'lightning bolt';
    const a = attribute('bStart', 'vec3').add(this.anchor);
    const b = attribute('bEnd', 'vec3').add(this.anchor);
    const params = attribute('bParams', 'vec3'); // brightness, relative width, 1 on a branch
    const brightness = varying(
      params.x.mul(mix(float(1), this.branchGain, params.z)),
      'vBoltBrightness',
    );
    m.positionNode = Fn(() => {
      // The camera is at the origin, so a camera-relative position is also the view ray.
      const p = mix(a, b, positionGeometry.y).toVar();
      const distance = length(p).toVar();
      const side = normalize(cross(normalize(b.sub(a)), p.div(distance)));
      const half = max(float(BOLT_HALF_WIDTH), this.pixelAngle.mul(distance).mul(BOLT_MIN_PIXELS))
        .mul(params.y)
        .mul(BOLT_HALO);
      return p.add(side.mul(half).mul(positionGeometry.x));
    })();
    m.colorNode = Fn(() => {
      // Distance from the channel's axis in core half-widths: a hot core in a wide, faint halo.
      const r = abs(positionGeometry.x).mul(BOLT_HALO);
      const profile = exp(r.mul(r).mul(-0.9)).add(exp(r.mul(-1.1)).mul(0.1));
      const edge = smoothstep(1, 0.7, abs(positionGeometry.x));
      const relative = positionWorld as V3;
      const distance = length(relative).toVar();
      // Behind the terrain: the scene's depth, with a margin that grows with distance.
      const clear = smoothstep(
        float(0),
        max(float(2), distance.mul(0.01)),
        sceneDistance.sub(distance),
      );
      // Behind the planet's curve: the view ray meets the sea-level sphere before the bolt.
      const rd = relative.div(distance);
      const along = dot(this.lighting.eye, rd);
      const disc = along.mul(along).sub(this.horizon);
      const hit = along.negate().sub(sqrt(max(disc, 0)));
      const above = select(
        disc.greaterThan(0).and(hit.greaterThan(0)).and(hit.lessThan(distance)),
        float(0),
        float(1),
      );
      const air = exp(distance.mul(this.extinction).negate());
      const light = profile.mul(edge).mul(brightness).mul(this.boltIntensity).mul(air);
      return vec4(
        vec3(...FLASH_TINT)
          .mul(BOLT_RADIANCE)
          .mul(light),
        clear.mul(above),
      );
    })();
    return m;
  }

  /** Plays the lightning of one frame. */
  update(frame: LightningFrame): void {
    const { view, eye, gameTime } = frame;
    const dt = frame.dt > 0 ? frame.dt : 0;
    this.realClock += dt;
    const last = this.lastTime;
    this.lastTime = gameTime;
    this.pixelAngle.value = frame.pixelAngle;

    let strike: Strike | null = null;
    let age = 0;
    let bolt: Strike | null = null;
    let boltAge = 0;
    if (this.forced) {
      strike = this.forced.strike;
      age = this.forced.age;
      if (strike.ground) {
        bolt = strike;
        boltAge = age;
      }
    } else if (this.enabled && view?.ready) {
      const cells = this.cellsAround(eye);
      const seed = this.seedValue;
      // Once per time slot: is a strike to the ground coming up? Then its shaders are due.
      const slot = Math.floor(gameTime / STRIKE_SLOT);
      if (slot !== this.warmSlot) {
        this.warmSlot = slot;
        if (
          this.mesh &&
          this.realClock - this.lastWarm >= WARM_GAP &&
          strikesBetween(seed, cells, view, gameTime, gameTime + 2 * STRIKE_SLOT).some(
            (s) => s.ground,
          )
        ) {
          this.warming = true;
        }
      }
      const step = gameTime - last;
      const jump = this.watchClock(step, dt);
      if (this.gameRate > ACCELERATION_LIMIT) {
        // Accelerated: a choice of the strikes, each shown in real time. A jump of the clock
        // shows nothing new.
        if (!jump && step > 0 && this.realClock - this.lastShown >= ACCELERATED_GAP) {
          const from = Math.max(last, gameTime - 2 * STRIKE_SLOT);
          let best: Strike | null = null;
          let bestScore = 0;
          for (const s of strikesBetween(seed, cells, view, from, gameTime)) {
            const score = prominence(s, 1, this.place(s, view).distanceTo(eye));
            if (score > bestScore) {
              best = s;
              bestScore = score;
            }
          }
          if (best) {
            this.shown = { strike: best, start: this.realClock };
            this.lastShown = this.realClock;
            this.thunder(best, view, eye);
          }
        }
        if (this.shown) {
          strike = this.shown.strike;
          age = this.realClock - this.shown.start;
          if (age > strike.duration) this.shown = strike = null;
          else if (strike.ground) {
            bolt = strike;
            boltAge = age;
          }
        }
      } else {
        this.shown = null;
        // At the speed of real time: the strikes under way now, the brightest first.
        let best = 0;
        let bestBolt = 0;
        for (const s of strikesAt(seed, cells, view, gameTime)) {
          const a = gameTime - s.time;
          const score = prominence(s, strikeIntensity(s, a), this.place(s, view).distanceTo(eye));
          if (score > best) {
            best = score;
            strike = s;
            age = a;
          }
          if (s.ground && score > bestBolt) {
            bestBolt = score;
            bolt = s;
            boltAge = a;
          }
        }
        if (!jump && step > 0 && step <= CATCH_UP) {
          for (const s of strikesBetween(seed, cells, view, last, gameTime)) {
            this.thunder(s, view, eye);
          }
        }
      }
    }

    const intensity = strike ? strikeIntensity(strike, age) * (0.5 + 0.5 * strike.energy) : 0;
    this.current = intensity > 0 ? strike : null;
    this.intensity = intensity;
    const state = this.weather;
    const light = this.lighting;
    state.flash.value = intensity;
    if (strike && intensity > 0) {
      // The clouds glow from the discharge; the ground is lit from the channel below it.
      const p = this.place(strike, view);
      state.flashPosition.value.set(p.x, p.y, p.z);
      const lit = strike.ground
        ? this.scratch.copy(p).scale(1 - (0.5 * this.height(p)) / p.length())
        : p;
      light.flashPosition.value.set(lit.x, lit.y, lit.z);
      const gain = FLASH_ILLUMINANCE * intensity;
      light.flashLight.value.set(FLASH_TINT[0] * gain, FLASH_TINT[1] * gain, FLASH_TINT[2] * gain);
    } else {
      light.flashLight.value.set(0, 0, 0);
    }
    this.drawBolt(bolt, boltAge, view, eye);
  }

  /** Game seconds per real second, averaged over the last frames (1 until the clock has been watched). */
  get gameRate(): number {
    return this.realSpan > 0 ? this.gameSpan / this.realSpan : 1;
  }

  /**
   * Takes a frame's step of the game clock into the clock's average speed.
   * Returns true if the step is a jump (a seek, a step backward, the first
   * frame), which shows no new strike and thunders for none.
   */
  private watchClock(step: Seconds, dt: Seconds): boolean {
    if (!(step >= 0)) {
      this.jumped = false;
      return true;
    }
    if (!(dt > 0)) return false;
    const long = step > CATCH_UP && step > JUMP_FACTOR * Math.max(1, this.gameRate) * dt;
    if (long && !this.jumped) {
      this.jumped = true;
      return true;
    }
    if (long) {
      // A second long step in a row: this is how fast the clock runs now.
      this.gameSpan = step;
      this.realSpan = dt;
    } else {
      const keep = Math.exp(-dt / RATE_WINDOW);
      this.gameSpan = this.gameSpan * keep + step;
      this.realSpan = this.realSpan * keep + dt;
    }
    this.jumped = false;
    return false;
  }

  /** The cells within range of the camera, listed again once it has moved a while. */
  private cellsAround(eye: Readonly<Vec3d>): number[] {
    const d = this.scratch.copy(eye).normalize();
    if (!this.cells || d.distanceTo(this.cellCenter) * this.radius > CELL_REFRESH) {
      this.cellCenter.copy(d);
      this.cells = cellsNear(d, STRIKE_RANGE + CELL_REFRESH, this.radius);
    }
    return this.cells;
  }

  /** Height of the ground above sea level under a direction (m). */
  private groundHeight(direction: Readonly<Vec3d>): Meters {
    return Math.max(0, this.groundAt?.(direction) ?? 0);
  }

  /** Height above the ground of the discharge whose planet-centered place `place` returned (m). */
  private height(p: Readonly<Vec3d>): Meters {
    return p.length() - this.radius - this.placedGround;
  }

  private placedGround = 0;

  /**
   * Where a strike's discharge is, planet-centered (m): the channel's top
   * inside the cloud base for a strike to the ground, the flash's center in
   * the cloud otherwise. The result is reused between calls.
   */
  private place(strike: Strike, view: WeatherView | null): Vec3d {
    const ground = this.groundHeight(strike.direction);
    this.placedGround = ground;
    const base = view?.ready ? view.sample(Channel.CloudBase, strike.direction, strike.time) : NaN;
    // A storm's base, wherever the weather's lowest layer is: between 300 m and 4 km.
    const cloudBase = Math.min(4000, Math.max(300, Number.isFinite(base) ? base : 1200));
    const above = cloudBase + (strike.ground ? BOLT_INTO_CLOUD : strike.height);
    return this.position.copy(strike.direction).scale(this.radius + ground + above);
  }

  private thunder(strike: Strike, view: WeatherView, eye: Readonly<Vec3d>): void {
    if (!this.onThunder) return;
    const p = this.place(strike, view);
    // A strike to the ground is heard from the nearest part of its channel.
    const distance = strike.ground
      ? Math.min(
          p.distanceTo(eye),
          this.scratch
            .copy(strike.direction)
            .scale(this.radius + this.placedGround)
            .distanceTo(eye),
        )
      : p.distanceTo(eye);
    this.onThunder({ distance, energy: strike.energy, time: strike.time, ground: strike.ground });
  }

  /** Shows the bolt of a strike at an age, or hides it. */
  private drawBolt(
    strike: Strike | null,
    age: Seconds,
    view: WeatherView | null,
    eye: Readonly<Vec3d>,
  ): void {
    const mesh = this.mesh;
    if (!mesh || !this.geometry) return;
    const intensity = strike ? strikeIntensity(strike, age) : 0;
    const shown = strike !== null && intensity > 0.004;
    const warm = this.warming && !shown && this.enabled;
    if (shown || warm) this.warming = false;
    // The pipeline draws its overlay pass only while something in it is visible.
    this.group.visible = mesh.visible = shown || warm;
    if (warm) {
      // The mesh as it is, without light: nothing shows, and the shaders get compiled.
      this.lastWarm = this.realClock;
      this.boltIntensity.value = 0;
      if (this.geometry.instanceCount === 0) {
        // No bolt yet: one segment, well away from the camera.
        this.end[1] = 1;
        (this.geometry.getAttribute('bEnd') as InstancedBufferAttribute).needsUpdate = true;
        this.geometry.instanceCount = 1;
        this.anchor.value.set(0, 0, 10_000);
      }
      return;
    }
    if (!strike || !shown) return;
    if (strike !== this.boltOf && !this.sameStrike(strike, this.boltOf)) {
      this.buildMesh(strike, view);
    }
    this.boltOf = strike;
    const g = this.boltGround;
    this.anchor.value.set(g.x - eye.x, g.y - eye.y, g.z - eye.z);
    // Seen from above the cloud base, the deck hides the channel under it.
    const over = eye.length() - g.length() - this.boltHeight;
    const t = Math.min(1, Math.max(0, (over + 100) / 500));
    const above = t * t * (3 - 2 * t);
    this.boltShowing = 1 - above * Math.min(1, this.boltCover / 0.8);
    this.boltIntensity.value = intensity * (0.6 + 0.4 * strike.energy) * this.boltShowing;
    const second = strike.strokes[1];
    this.branchGain.value = second && age >= second.offset ? 0.12 : 1;
    const visibility = this.weather.local?.visibility ?? Infinity;
    this.extinction.value = visibility > 0 ? (BOLT_PENETRATION * KOSCHMIEDER) / visibility : 0;
    this.horizon.value = eye.lengthSq() - this.radius * this.radius;
  }

  private sameStrike(a: Strike, b: Strike | null): boolean {
    return (
      b !== null &&
      a.cell === b.cell &&
      a.slot === b.slot &&
      a.seed === b.seed &&
      // A forced strike has no cell of its own: its place tells it from another.
      a.direction.distanceTo(b.direction) < 1e-9
    );
  }

  /** Fills the mesh with a strike's bolt, turned from its own frame into world axes. */
  private buildMesh(strike: Strike, view: WeatherView | null): void {
    const top = this.place(strike, view);
    const ground = this.placedGround;
    const height = top.length() - this.radius - ground;
    this.boltGround.copy(strike.direction).scale(this.radius + ground);
    this.boltHeight = height;
    const cover = view?.ready ? view.sample(Channel.Cover, strike.direction, strike.time) : 0;
    this.boltCover = Number.isFinite(cover) ? Math.min(1, Math.max(0, cover)) : 0;
    const bolt = buildBolt(strike.seed, height);
    const up = strike.direction;
    const east = new Vec3d(0, 1, 0).cross(up);
    if (east.length() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = up.clone().cross(east);
    const s = bolt.segments;
    const put = (out: Float32Array, i: number, x: number, y: number, z: number) => {
      out[i * 3] = east.x * x + up.x * y + north.x * z;
      out[i * 3 + 1] = east.y * x + up.y * y + north.y * z;
      out[i * 3 + 2] = east.z * x + up.z * y + north.z * z;
    };
    for (let i = 0; i < bolt.count; i++) {
      const o = i * BOLT_SEGMENT_FLOATS;
      put(this.start, i, s[o]!, s[o + 1]!, s[o + 2]!);
      put(this.end, i, s[o + 3]!, s[o + 4]!, s[o + 5]!);
      // The top fades into the cloud it comes out of, so it has no cut end.
      const y = (s[o + 1]! + s[o + 4]!) / (2 * height);
      const fade = Math.min(1, Math.max(0, (1 - y) / 0.16));
      this.params[i * 3] = s[o + 6]! * fade * fade;
      this.params[i * 3 + 1] = s[o + 7]!;
      this.params[i * 3 + 2] = i < bolt.mainCount ? 0 : 1;
    }
    const g = this.geometry!;
    for (const name of ['bStart', 'bEnd', 'bParams']) {
      (g.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true;
    }
    g.instanceCount = bolt.count;
  }

  /** The bolt in the mesh: its ground point (planet-centered), height and segment count. */
  get bolt(): { ground: Readonly<Vec3d>; height: Meters; segments: number } | null {
    return this.boltOf
      ? { ground: this.boltGround, height: this.boltHeight, segments: this.geometry!.instanceCount }
      : null;
  }

  /**
   * Draws the bolt's mesh once in the next frame, without light, so that the
   * renderer compiles its material and the pipeline its variant with the
   * overlay before the first bolt needs them. Done by itself in the first
   * frame and ahead of strikes to the ground; call it after changing the
   * pipeline's settings (its quality, bloom, grading), which make new variants.
   */
  warm(): void {
    this.warming = true;
  }

  /** Forgets the clock, so the next update plays no thunder for the time before it. */
  reset(): void {
    this.lastTime = NaN;
    this.shown = null;
    this.lastShown = -Infinity;
    this.gameSpan = this.realSpan = RATE_PRIOR;
    this.jumped = false;
  }

  dispose(): void {
    this.geometry?.dispose();
    (this.mesh?.material as MeshBasicNodeMaterial | undefined)?.dispose();
  }
}
