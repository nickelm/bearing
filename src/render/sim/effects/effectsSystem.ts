/**
 * Stylized smoke, fire and explosions (Proposal 0011, decisions 320–327): one system for
 * every source, from missile trails to chimneys.
 *
 * - **Puffs** live in a pool of `POOL_CAPACITY` on the GPU (`puffCompute.ts`), stepped by a
 *   compute pass each frame and drawn in one call as sphere impostors (`puffMaterial.ts`).
 * - **Emitters** (`emitters.ts`) shed them: fixed sources (chimneys, columns) and moving
 *   ones (missiles, burning aircraft, a helicopter's wash), by key. A moving source's owner
 *   calls `track` each frame; one not tracked for `STALE` seconds stops.
 * - **Explosions** are bursts of puffs (flash, fireball, smoke), debris, a scorch and a
 *   shockwave ring (`debris.ts`) and a flash light (`flashLights.ts`), by `explosionRecipe`.
 * - **Events** (`sim/effects/events.ts`) come in through `handle`; long-lived columns come in
 *   whole through `setColumns`, from the game layer's damage states, so a burning depot
 *   smokes again when the camera comes back.
 * - **Ribbons** (`ribbons.ts`) draw contrails and wingtip vortices.
 *
 * Effects are cosmetic: nothing here reaches the simulation. Puffs are stored relative to a
 * floating anchor near the camera, and everything is placed camera-relative (rule 4).
 */
import { BufferAttribute, Group, InstancedBufferGeometry, Mesh, Vector3 } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { Vec3d } from '../../../core/vec3d';
import type {
  EffectEvent,
  EffectSink,
  FireColumn,
  AircraftSmoke,
} from '../../../sim/effects/events';
import type { ExplosionKind } from '../../../sim/effects/events';
import type { PlanetLighting } from '../lighting/planetLighting';
import { Debris } from './debris';
import { Emitter, seededRandom } from './emitters';
import type { EmitterSource, WorldSpawn } from './emitters';
import { FlashLights } from './flashLights';
import { PuffPool, POOL_CAPACITY } from './pool';
import { PuffBuffers } from './puffCompute';
import { puffMaterial } from './puffMaterial';
import {
  BLAST_PRESETS,
  EMITTERS,
  explosionRecipe,
  LOOK_INDEX,
  LOOKS,
  trailPreset,
} from './presets';
import type { Burst, PresetId } from './presets';
import { contrailForms, Ribbons, vortexForms } from './ribbons';

/** Seconds after its last `track` that a moving source stops. */
export const STALE = 0.5;
/** The anchor moves when the camera is this far (m) from it. */
const ANCHOR_STEP = 2000;
/** Seconds a blast's own fire (a wreck's, a fuel store's) burns when nothing else says. */
const BLAST_FIRE = 600;
/** Puffs are drawn out to this distance (m). */
export const DRAW_RANGE = 60_000;

/** What `EffectsSystem.update` needs each frame. */
export interface EffectsFrame {
  eye: Readonly<Vec3d>;
  /** Effect seconds since the last frame: real time while the game runs, 0 while paused. */
  dt: number;
  /** The wind aloft (world, m/s). */
  wind: Readonly<Vec3d>;
  /** Radians per pixel of the view (its vertical field over its height in pixels). */
  pixelAngle?: number;
}

export interface EffectsStats {
  /** Puffs alive. */
  live: number;
  /** Puffs born this frame. */
  spawned: number;
  /** One past the highest pool slot in use: the draw's instance count. */
  drawn: number;
  emitters: number;
  columns: number;
  debris: number;
  marks: number;
  lights: number;
  ribbons: number;
  /** Compute dispatches this frame. */
  dispatches: number;
  /** Live puffs dropped because the pool was full, since the start. */
  overwritten: number;
  /** The governor's scale of every emitter's rate. */
  rateScale: number;
}

const v3 = (a: readonly [number, number, number]) => new Vec3d(a[0], a[1], a[2]);

/** An aircraft as the effects see it each frame (`EffectsSystem.aircraft`). */
export interface AircraftPose {
  /** Its center (world, m) and velocity (m/s). */
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  /** Unit body axes: forward and the right wing (world). */
  forward: Readonly<Vec3d>;
  right: Readonly<Vec3d>;
  /** Load factor (g). */
  load: number;
  /** Wingspan and length (m). */
  span: number;
  length: number;
  /** The right wingtip from the center: forward (m, negative aft) and out (m); see `wingtipOf`. */
  tip?: readonly [number, number];
  /** Damage 0..1 (decision 301): smoke from 0.05, on fire from 0.5; none when it is shot down. */
  damage?: number;
  /** Engines side by side at the tail (1 or 2). */
  engines?: number;
}

/** Which preset a long-lived fire of a kind shows. */
function columnPreset(c: FireColumn): PresetId {
  return c.kind === 'fuel' || c.kind === 'ship' ? 'fuel-fire' : 'burning-target';
}

export class EffectsSystem implements EffectSink {
  readonly group = new Group();
  readonly pool: PuffPool;
  readonly buffers: PuffBuffers;
  readonly lights: FlashLights;
  readonly debris: Debris;
  readonly ribbons: Ribbons;
  readonly stats: EffectsStats = {
    live: 0,
    spawned: 0,
    drawn: 0,
    emitters: 0,
    columns: 0,
    debris: 0,
    marks: 0,
    lights: 0,
    ribbons: 0,
    dispatches: 0,
    overwritten: 0,
    rateScale: 1,
  };
  enabled = true;
  /**
   * The air for contrails and vortices: the surface temperature (°C) under the camera and a
   * humidity 0..1 (the weather's cloud cover); the scene sets it from the weather.
   */
  readonly air = { temperature: 15, humidity: 0.4 };
  /** Ground height (m above the radius) along a unit direction, or null if unknown. */
  groundAt: (dir: Readonly<Vec3d>) => number | null = () => 0;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly mesh: Mesh;
  private readonly anchor = new Vec3d();
  private anchored = false;
  private readonly anchorRel = uniform(new Vector3());
  private readonly range = uniform(DRAW_RANGE);
  private readonly minAngle = uniform(0.0012);
  private clock = 0;
  private kill = false;
  private readonly emitters = new Map<string, Emitter>();
  /** Long-lived columns by key; a blast's own fire burns out at `until`. */
  private readonly columns = new Map<string, FireColumn & { until?: number }>();
  private readonly smoke = new Map<string, AircraftSmoke>();
  private readonly pending: { at: Vec3d; floor: number; burst: Burst; when: number }[] = [];
  private readonly rand = seededRandom(0x5eed);
  private readonly due: WorldSpawn[] = [];
  private seed = 1;

  constructor(
    lighting: PlanetLighting,
    readonly radius: number,
    lights?: FlashLights,
  ) {
    this.pool = new PuffPool(POOL_CAPACITY);
    this.buffers = new PuffBuffers(this.pool);
    this.lights = lights ?? new FlashLights();
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
    this.geometry.setAttribute('position', new BufferAttribute(quad, 3));
    this.geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.geometry.instanceCount = 0;
    const lightsAt = this.lights;
    this.mesh = new Mesh(
      this.geometry,
      puffMaterial(this.buffers, lighting, {
        anchorRel: this.anchorRel,
        range: this.range,
        minAngle: this.minAngle,
        // The ground takes the flashes through the lighting's hook; without one, the puffs
        // take them here.
        localLight: lighting.localLight ? null : (rel) => lightsAt.at(rel),
      }),
    );
    this.mesh.name = 'puffs';
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.debris = new Debris(this.group, lighting);
    this.ribbons = new Ribbons(this.group, lighting);
  }

  /** The distance from the planet's center of the ground under a world point. */
  floorAt(p: Readonly<Vec3d>): number {
    const d = p.clone().normalize();
    return this.radius + (this.groundAt(d) ?? 0);
  }

  // ---- Events ----

  handle(e: EffectEvent): void {
    switch (e.type) {
      case 'explosion':
        this.explode(v3(e.at), e.explosive, e.kind);
        break;
      case 'hit':
        this.explode(
          v3(e.at),
          e.target === 'aircraft' ? 4 : 2,
          e.target === 'aircraft' ? 'air' : e.target === 'ship' ? 'water' : 'ground',
        );
        break;
      case 'launch':
        if (e.fromGround || e.motor === 'sam') this.launchColumn(v3(e.at));
        break;
      case 'fire-started':
        this.columns.set(e.key, { key: e.key, at: e.at, kind: e.kind, intensity: e.intensity });
        break;
      case 'fire-extinguished':
        this.columns.delete(e.key);
        this.emitters.delete(`column:${e.key}`);
        break;
      case 'aircraft-smoke':
        if (e.state === 'none') this.smoke.delete(e.key);
        else this.smoke.set(e.key, e.state);
        break;
    }
  }

  /**
   * The long-lived columns, whole: what the game layer's damage states say burns. Columns
   * not in the list stop; new ones start already tall.
   */
  setColumns(list: readonly FireColumn[]): void {
    const keep = new Set(list.map((c) => c.key));
    for (const k of [...this.columns.keys()]) {
      if (!keep.has(k)) {
        this.columns.delete(k);
        this.emitters.delete(`column:${k}`);
      }
    }
    for (const c of list) this.columns.set(c.key, c);
  }

  /** A missile's trail by its motor, each frame while it flies. */
  trackMissile(
    key: string,
    motor: Parameters<typeof trailPreset>[0],
    burning: boolean,
    pos: Readonly<Vec3d>,
    vel: Readonly<Vec3d>,
  ): void {
    const preset = trailPreset(motor);
    if (!preset || !burning) return;
    this.track(`missile:${key}`, preset, { pos, vel, dir: vel.clone().normalize().scale(-1) });
  }

  /** An aircraft's smoke by the state its `aircraft-smoke` events set, each frame. */
  trackAircraft(
    key: string,
    pos: Readonly<Vec3d>,
    vel: Readonly<Vec3d>,
    state?: AircraftSmoke,
  ): void {
    const s = state ?? this.smoke.get(key) ?? 'none';
    if (s === 'none') return;
    this.track(`aircraft:${key}`, s === 'burning' ? 'aircraft-fire' : 'aircraft-damaged', {
      pos,
      vel,
      dir: vel.clone().normalize().scale(-1),
    });
  }

  /**
   * An aircraft's contrails (above the contrail altitude), wingtip vortices (above the load
   * factor for the air's humidity) and damage smoke, each frame it is drawn (decision 329).
   */
  aircraft(key: string, a: AircraftPose): void {
    const now = this.clock;
    const altitude = a.pos.length() - this.radius;
    const humidity = this.air.humidity;
    const contrail = contrailForms(altitude, this.air.temperature);
    const engines = a.engines ?? 2;
    const tail = a.pos.clone().addScaled(a.forward, -0.5 * a.length);
    for (let i = 0; i < engines; i++) {
      const side = engines === 1 ? 0 : i === 0 ? -1 : 1;
      const p = tail.clone().addScaled(a.right, side * 1.2);
      this.ribbons.trail(`${key}:c${i}`, 'contrail', p, contrail, now, humidity);
    }
    const vortex = vortexForms(a.load, humidity) && a.vel.length() > 60;
    const [ahead, out] = a.tip ?? [0, a.span / 2];
    for (const side of [-1, 1]) {
      const p = a.pos
        .clone()
        .addScaled(a.forward, ahead)
        .addScaled(a.right, side * out);
      this.ribbons.trail(`${key}:v${side}`, 'vortex', p, vortex, now);
    }
    const d = a.damage ?? 0;
    if (d >= 0.05 && d < 1) this.trackAircraft(key, a.pos, a.vel, d >= 0.5 ? 'burning' : 'damaged');
  }

  /** A moving source's emitter, made or moved; it stops `STALE` seconds after the last call. */
  track(
    key: string,
    preset: PresetId,
    source: Omit<EmitterSource, 'floor'> & { floor?: number },
  ): Emitter | null {
    const p = EMITTERS[preset];
    if (!p) return null;
    const full: EmitterSource = { ...source, floor: source.floor ?? this.floorAt(source.pos) };
    let e = this.emitters.get(key);
    if (!e || e.preset !== p) {
      e = new Emitter(key, p, full, this.clock, this.seed++);
      this.emitters.set(key, e);
    } else e.set(full, this.clock);
    return e;
  }

  /**
   * A fixed source that runs until removed (a stack, a cooling tower, a burning landmark):
   * made, or moved if it exists. It sheds only while the camera is within its range, and
   * fills itself again when the camera comes back.
   */
  fixed(key: string, preset: PresetId, source: EmitterSource): Emitter | null {
    const p = EMITTERS[preset];
    if (!p) return null;
    let e = this.emitters.get(key);
    if (!e || e.preset !== p) {
      e = new Emitter(key, p, source, this.clock - 600, this.seed++);
      this.emitters.set(key, e);
    } else e.set(source, this.clock);
    e.touched = Infinity;
    return e;
  }

  /** Stops an emitter now. */
  remove(key: string): void {
    this.emitters.delete(key);
  }

  /** A preset fired once at `at` (the sandbox's buttons; a fixed source runs until removed). */
  spawnPreset(id: PresetId, at: Readonly<Vec3d>, key = `preset:${this.seed}`): void {
    const blast = BLAST_PRESETS[id];
    if (blast) {
      // A fuel fire's explosion leaves its own column.
      this.explode(at, blast.explosive, blast.kind, key);
      return;
    }
    if (id === 'burning-target') {
      this.columns.set(key, { key, at: [at.x, at.y, at.z], kind: 'target', intensity: 1 });
      return;
    }
    const p = EMITTERS[id];
    if (!p) return;
    const e = new Emitter(
      key,
      p,
      { pos: at.clone(), floor: this.floorAt(at) },
      this.clock,
      this.seed++,
    );
    // A fixed source the sandbox places runs until its preset's duration, or ten minutes.
    e.touched = Infinity;
    this.emitters.set(key, e);
  }

  // ---- Explosions ----

  /** An explosion of `explosive` kg at `at` (world): the recipe's five layers. */
  explode(at: Readonly<Vec3d>, explosive: number, kind: ExplosionKind, fireKey?: string): void {
    const r = explosionRecipe(kind, explosive);
    const floor = kind === 'air' ? this.floorAt(at) : Math.min(at.length(), this.floorAt(at));
    for (const b of r.bursts) {
      if (b.delay > 0)
        this.pending.push({ at: at.clone(), floor, burst: b, when: this.clock + b.delay });
      else this.burst(b, at, floor);
    }
    if (r.debris.count > 0)
      this.debris.throw(
        at,
        floor,
        r.debris.count,
        r.debris.speed,
        r.debris.size,
        r.debris.smoking,
        this.rand,
      );
    if (kind !== 'air' && kind !== 'water') this.debris.mark(at, r.scorch, r.ring, this.clock);
    this.lights.add(at, r.light.intensity, r.light.reach, this.clock);
    if (r.fire) {
      const key = fireKey ?? `blast:${this.seed++}`;
      this.columns.set(key, {
        key,
        at: [at.x, at.y, at.z],
        kind: 'fuel',
        intensity: 1,
        until: fireKey ? undefined : this.clock + BLAST_FIRE,
      });
    }
  }

  /** The white column a SAM leaves at its launcher. */
  private launchColumn(at: Readonly<Vec3d>): void {
    const floor = this.floorAt(at);
    this.burst(
      {
        look: 'launch-column',
        count: 30,
        size: [9, 15],
        speed: [3, 12],
        up: 2,
        delay: 0,
        upward: 0.2,
      },
      at,
      floor,
    );
  }

  /** One burst of puffs. */
  private burst(b: Burst, at: Readonly<Vec3d>, floor: number): void {
    const up = at.clone().normalize();
    const look = LOOK_INDEX[b.look];
    const L = LOOKS[look]!;
    const r = this.rand;
    for (let i = 0; i < b.count; i++) {
      const v = new Vec3d(r() - 0.5, r() - 0.5, r() - 0.5);
      const len = v.length() || 1;
      v.scale(1 / len);
      // Toward the upper hemisphere by `upward`.
      const vu = v.dot(up);
      if (vu < 0) v.addScaled(up, -vu * 2 * b.upward);
      v.addScaled(up, b.upward).normalize();
      const speed = b.speed[0] + (b.speed[1] - b.speed[0]) * r();
      const vel = v.clone().scale(speed).addScaled(up, b.up);
      const size = b.size[0] + (b.size[1] - b.size[0]) * r();
      const pos = at.clone().addScaled(v, size * 0.4);
      pos.addScaled(up, Math.max(0, floor + size * 0.2 - pos.length()));
      this.due.push({
        pos,
        vel: [vel.x, vel.y, vel.z],
        life: L.life[0] + (L.life[1] - L.life[0]) * r(),
        look,
        size,
        seed: r() * 64,
        floor,
      });
    }
  }

  // ---- Frame ----

  update(renderer: WebGPURenderer, f: EffectsFrame): void {
    const dt = Math.max(0, Math.min(f.dt, 0.1));
    this.clock += dt;
    const now = this.clock;
    // The floating anchor: moved (and every puff shifted) when the camera has gone far.
    const shift: [number, number, number] = [0, 0, 0];
    if (!this.anchored) {
      this.anchor.copy(f.eye);
      this.anchored = true;
    } else if (this.anchor.distanceTo(f.eye) > ANCHOR_STEP) {
      shift[0] = this.anchor.x - f.eye.x;
      shift[1] = this.anchor.y - f.eye.y;
      shift[2] = this.anchor.z - f.eye.z;
      this.anchor.copy(f.eye);
    }
    this.pool.reclaim(now);
    const live = this.pool.live(now);
    const rateScale = this.pool.rateScale(live);
    if (this.enabled && dt > 0) {
      // Columns from the damage states.
      for (const c of this.columns.values()) {
        const key = `column:${c.key}`;
        if (c.until !== undefined && now > c.until) {
          this.columns.delete(c.key);
          this.emitters.delete(key);
          continue;
        }
        if (!this.emitters.has(key)) {
          const at = v3(c.at);
          const preset = EMITTERS[columnPreset(c)]!;
          const e = new Emitter(
            key,
            preset,
            {
              pos: at,
              floor: this.floorAt(at),
              strength: 0.4 + 0.6 * c.intensity,
              scale: 0.7 + 0.5 * c.intensity,
            },
            now - 600,
            this.seed++,
          );
          e.touched = Infinity;
          this.emitters.set(key, e);
        }
      }
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const p = this.pending[i]!;
        if (now >= p.when) {
          this.burst(p.burst, p.at, p.floor);
          this.pending.splice(i, 1);
        }
      }
      for (const [k, e] of this.emitters) {
        if (now - e.touched > STALE || now >= e.until) {
          this.emitters.delete(k);
          continue;
        }
        e.emit(dt, now, f.eye, rateScale, f.wind, this.due);
      }
      this.debris.update(dt, now, f.eye, (pos, size) =>
        this.due.push({
          pos: pos.clone(),
          vel: [0, 0, 0],
          life: 2.5,
          look: LOOK_INDEX['debris-smoke'],
          size,
          seed: this.rand() * 64,
          floor: this.floorAt(pos),
        }),
      );
    } else this.debris.update(0, now, f.eye, () => {});
    let spawned = 0;
    for (const s of this.due) {
      const ok = this.pool.spawn(
        {
          ...s,
          pos: [s.pos.x - this.anchor.x, s.pos.y - this.anchor.y, s.pos.z - this.anchor.z],
        },
        now,
      );
      if (ok) spawned++;
    }
    this.due.length = 0;
    if (dt > 0 || spawned > 0 || this.kill || shift.some((v) => v !== 0)) {
      this.buffers.run(renderer, {
        dt,
        time: now,
        wind: [f.wind.x, f.wind.y, f.wind.z],
        anchor: [this.anchor.x, this.anchor.y, this.anchor.z],
        shift,
        kill: this.kill,
      });
    } else this.buffers.dispatches = 0;
    this.kill = false;
    this.anchorRel.value.set(
      this.anchor.x - f.eye.x,
      this.anchor.y - f.eye.y,
      this.anchor.z - f.eye.z,
    );
    this.lights.update(f.eye, now);
    const pixel = f.pixelAngle ?? 0.0012;
    this.minAngle.value = pixel * 0.9;
    this.ribbons.update(now, f.eye, pixel);
    this.geometry.instanceCount = this.pool.highWater;
    this.mesh.visible = this.enabled && this.pool.highWater > 0;
    const s = this.stats;
    s.live = this.pool.live(now);
    s.spawned = spawned;
    s.drawn = this.pool.highWater;
    s.emitters = this.emitters.size;
    s.columns = this.columns.size;
    s.debris = this.debris.chunks.length;
    s.marks = this.debris.marks.length;
    s.lights = this.lights.count;
    s.ribbons = this.ribbons.points;
    s.dispatches = this.buffers.dispatches;
    s.overwritten = this.pool.overwritten;
    s.rateScale = rateScale;
  }

  /** Emitters running now (stats are refreshed only by `update`). */
  get emitterCount(): number {
    return this.emitters.size;
  }

  /** The effect clock (s). */
  get time(): number {
    return this.clock;
  }

  /** After a cut: every puff, emitter, chunk and mark goes; the columns stay (they are state). */
  clear(): void {
    this.pool.clear();
    this.kill = true;
    this.emitters.clear();
    this.pending.length = 0;
    this.debris.clear();
    this.lights.clear();
    this.ribbons.clear();
  }

  dispose(): void {
    this.buffers.dispose();
    this.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
    this.debris.dispose();
    this.ribbons.dispose();
  }
}
