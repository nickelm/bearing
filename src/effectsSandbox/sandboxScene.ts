/**
 * The effects sandbox's scene (Proposal 0011, decision 327): a patch of the planet with the
 * real sky and light, a few props to cut into (chimneys, a cooling tower, a fuel depot, a
 * SAM site, hangars, a parked aircraft's stand-in), the effects system, and scripted actors
 * that exercise every preset: missiles by motor, a SAM launch, damaged and burning aircraft,
 * a contrail pass, a hard turn with vortices, flares, a hovering helicopter's wash.
 *
 * No DOM: the sandbox page (`effects.html`, `main.ts`) drives it with buttons, and
 * `tools/effects.preview.ts` renders it headless for screenshots and timings.
 */
import {
  AgXToneMapping,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three/webgpu';
import type { Node, WebGPURenderer } from 'three/webgpu';
import {
  attribute,
  floor,
  Fn,
  fract,
  mix,
  normalWorld,
  positionWorld,
  sin,
  dot,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DEG, PLANET_RADIUS } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { placeCameraRelative } from '../render/common/cameraRelative';
import { EffectsSystem } from '../render/sim/effects/effectsSystem';
import { FlashLights } from '../render/sim/effects/flashLights';
import { BLAST_PRESETS, EMITTERS } from '../render/sim/effects/presets';
import type { PresetId } from '../render/sim/effects/presets';
import { contrailForms, vortexForms } from '../render/sim/effects/ribbons';
import { seededRandom } from '../render/sim/effects/emitters';
import { PlanetLighting } from '../render/sim/lighting/planetLighting';
import { SimPipeline } from '../render/sim/post/simPipeline';
import type { ExplosionKind, MotorKind } from '../sim/effects/events';

type V3 = Node<'vec3'>;

/** Explosion sizes the sandbox offers, as explosive mass (kg). */
export const EXPLOSION_SIZES = {
  rocket: 1.5,
  'missile warhead': 9.4,
  '230 kg bomb': 87,
  '900 kg bomb': 429,
  'fuel depot': 2000,
} as const;
export type ExplosionSize = keyof typeof EXPLOSION_SIZES;

/** Places on the patch, in meters east and north of its center. */
export const SITES = {
  range: [0, 0],
  works: [700, 500],
  depot: [-600, 900],
  sam: [1600, 2600],
  hangars: [-300, -400],
  falls: [-1400, 200],
  helipad: [250, -250],
} as const;

/** Camera stations: where it stands (east, north, height above ground) and what it looks at. */
export const VIEWS: Record<
  string,
  { eye: [number, number, number]; at: [number, number, number]; fov?: number }
> = {
  overview: { eye: [-2200, -2600, 420], at: [200, 300, 60] },
  range: { eye: [-130, -210, 28], at: [0, 30, 18] },
  works: { eye: [300, -300, 90], at: [700, 500, 70] },
  depot: { eye: [-1500, -900, 180], at: [-600, 900, 150] },
  sam: { eye: [1300, 1900, 25], at: [1600, 2700, 140] },
  'sam-20km': { eye: [-12_000, -15_800, 400], at: [1600, 2600, 700], fov: 20 },
  sky: { eye: [0, -3000, 300], at: [0, 2000, 4000] },
  contrails: { eye: [4000, -4500, 300], at: [-2000, -4500, 10_000], fov: 60 },
  vortex: { eye: [-420, -250, 1480], at: [0, 600, 1500] },
  helipad: { eye: [180, -330, 12], at: [250, -250, 4] },
};

interface Actor {
  /** Steps it by dt at sandbox time t; false when it is done. */
  step(dt: number, t: number): boolean;
}

export interface SandboxOptions {
  /** Draw through the game's post-processing pipeline (bloom, grade). */
  post?: boolean;
}

export class EffectsSandbox {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 16 / 9, 1, 400_000);
  readonly lighting = new PlanetLighting();
  readonly flashes = new FlashLights();
  readonly effects: EffectsSystem;
  readonly pipeline: SimPipeline | null;
  readonly center: Vec3d;
  readonly eye = new Vec3d();
  /** Wind (world, m/s). */
  readonly wind = new Vec3d();
  /** Surface temperature (°C) and humidity 0..1, for contrails and vortices. */
  temperature = 15;
  humidity = 0.5;
  private readonly up: Vec3d;
  private readonly east: Vec3d;
  private readonly north: Vec3d;
  private readonly world = new Group();
  private readonly sun = new Vec3d(0, 1, 0);
  private actors: Actor[] = [];
  private time = 0;
  private key = 0;
  private readonly rand = seededRandom(7);
  readonly radius = PLANET_RADIUS;

  constructor(
    private readonly renderer: WebGPURenderer,
    o: SandboxOptions = {},
  ) {
    renderer.toneMapping = AgXToneMapping;
    // The flashes light the ground too: hooked before any material is built.
    this.lighting.localLight = (rel) => this.flashes.at(rel);
    const lat = 45 * DEG;
    const lon = 10 * DEG;
    this.up = new Vec3d(
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
      Math.cos(lat) * Math.cos(lon),
    );
    this.east = new Vec3d(0, 1, 0).cross(this.up).normalize();
    this.north = this.up.clone().cross(this.east).normalize();
    this.center = this.up.clone().scale(this.radius);
    this.scene.backgroundNode = this.lighting.atmosphere.skyNode();
    this.buildGround();
    this.buildProps();
    this.scene.add(this.world);
    this.effects = new EffectsSystem(this.lighting, this.radius, this.flashes);
    this.effects.groundAt = () => 0;
    this.scene.add(this.effects.group);
    this.pipeline = o.post === false ? null : new SimPipeline(renderer);
    this.setSun(35, 220);
    this.setWind(5, 270);
    this.setView('overview');
  }

  /** A world point east, north and up (m) of the patch's center, on the curved ground. */
  local(e: number, n: number, h = 0): Vec3d {
    const d = this.up
      .clone()
      .scale(this.radius)
      .addScaled(this.east, e)
      .addScaled(this.north, n)
      .normalize();
    return d.scale(this.radius + h);
  }

  /** The sun at an elevation and a compass azimuth (degrees). */
  setSun(elevation: number, azimuth: number): void {
    const el = elevation * DEG;
    const az = azimuth * DEG;
    this.sun
      .set(0, 0, 0)
      .addScaled(this.up, Math.sin(el))
      .addScaled(this.north, Math.cos(el) * Math.cos(az))
      .addScaled(this.east, Math.cos(el) * Math.sin(az))
      .normalize();
  }

  /** The wind at a speed (m/s) from a compass direction (degrees). */
  setWind(speed: number, from: number): void {
    const a = from * DEG;
    this.wind
      .set(0, 0, 0)
      .addScaled(this.north, -Math.cos(a) * speed)
      .addScaled(this.east, -Math.sin(a) * speed);
  }

  setView(name: string): void {
    const v = VIEWS[name] ?? VIEWS.overview!;
    this.lookFrom(
      this.local(v.eye[0], v.eye[1], v.eye[2]),
      this.local(v.at[0], v.at[1], v.at[2]),
      v.fov ?? 50,
    );
  }

  /** Puts the camera at `eye` looking at `at` (world). */
  lookFrom(eye: Readonly<Vec3d>, at: Readonly<Vec3d>, fov = 50): void {
    this.eye.copy(eye);
    const f = at.clone().sub(eye).normalize();
    const up = eye.clone().normalize();
    const top = up.clone().addScaled(f, -f.dot(up)).normalize();
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(top.x, top.y, top.z);
    this.camera.lookAt(f.x, f.y, f.z);
    this.camera.updateMatrixWorld();
  }

  /** Orbits the camera around a site: yaw and pitch (degrees) and distance (m). */
  orbit(target: Readonly<Vec3d>, yaw: number, pitch: number, distance: number): void {
    const y = yaw * DEG;
    const p = pitch * DEG;
    const up = target.clone().normalize();
    const back = new Vec3d()
      .addScaled(this.north, -Math.cos(y) * Math.cos(p))
      .addScaled(this.east, -Math.sin(y) * Math.cos(p))
      .addScaled(up, Math.sin(p));
    this.lookFrom(target.clone().addScaled(back, distance), target, 50);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  /** The site's world point at its height. */
  site(name: keyof typeof SITES, h = 0): Vec3d {
    const s = SITES[name];
    return this.local(s[0], s[1], h);
  }

  // ---- Presets ----

  /** Every preset the sandbox can fire, with its label. */
  static presets(): { id: PresetId; label: string }[] {
    const ids = new Set<PresetId>([
      ...(Object.keys(EMITTERS) as PresetId[]),
      ...(Object.keys(BLAST_PRESETS) as PresetId[]),
    ]);
    return [...ids].map((id) => ({
      id,
      label: EMITTERS[id]?.label ?? BLAST_PRESETS[id]?.label ?? id,
    }));
  }

  /** Fires a preset where it belongs in the sandbox. */
  spawn(id: PresetId): void {
    const r = this.rand;
    switch (id) {
      case 'solid-motor':
      case 'reduced-smoke-motor':
        this.missile(id === 'solid-motor' ? 'solid' : 'reduced-smoke');
        return;
      case 'sam-launch':
        this.sam();
        return;
      case 'aircraft-damaged':
      case 'aircraft-fire':
        this.aircraft(id === 'aircraft-fire' ? 'burning' : 'damaged');
        return;
      case 'flare':
        this.flares();
        return;
      case 'rotor-downwash':
        this.hover();
        return;
      case 'chimney':
        for (let i = 0; i < 4; i++)
          this.effects.spawnPreset(
            'chimney',
            this.site('works', 42).addScaled(this.east, i * 30),
            `chimney:${i}`,
          );
        return;
      case 'cooling-tower':
        this.effects.spawnPreset(
          'cooling-tower',
          this.site('works', 80).addScaled(this.north, 160),
          'cooling',
        );
        return;
      case 'waterfall-mist':
        this.effects.spawnPreset('waterfall-mist', this.site('falls', 2), 'falls');
        return;
      case 'burning-target':
        this.effects.spawnPreset(
          'burning-target',
          this.site('hangars').addScaled(this.east, r() * 200),
          `target:${this.key++}`,
        );
        return;
      case 'fuel-fire':
        this.effects.spawnPreset(
          'fuel-fire',
          this.site('depot').addScaled(this.east, (r() - 0.5) * 120),
          `fuel:${this.key++}`,
        );
        return;
      case 'air-burst':
        this.effects.explode(
          this.site('range', 200 + 300 * r()).addScaled(this.east, (r() - 0.5) * 300),
          10,
          'air',
        );
        return;
      case 'bomb-impact':
        this.effects.explode(
          this.site('range')
            .addScaled(this.east, (r() - 0.5) * 300)
            .addScaled(this.north, (r() - 0.5) * 200),
          87,
          'ground',
        );
        return;
      case 'ship-hit':
        this.effects.explode(this.site('falls', 0).addScaled(this.north, -300), 40, 'water');
        return;
    }
  }

  /** An explosion of a size and kind on the range. */
  explosion(size: ExplosionSize, kind: ExplosionKind = 'ground'): void {
    const r = this.rand;
    const at = this.site('range', kind === 'air' ? 150 + 200 * r() : 0)
      .addScaled(this.east, (r() - 0.5) * 300)
      .addScaled(this.north, (r() - 0.5) * 200);
    this.effects.explode(at, EXPLOSION_SIZES[size], kind);
  }

  /** A missile across the range, its trail by its motor. */
  missile(motor: MotorKind, from?: Vec3d, toward?: Vec3d): void {
    const r = this.rand;
    const start = from ?? this.local(-2500 + 400 * r(), -800 + 1600 * r(), 600 + 600 * r());
    const aim = toward ?? this.local(2500, 800 * (r() - 0.5), 800 + 600 * r());
    const dir = aim.clone().sub(start).normalize();
    const pos = start.clone();
    const vel = dir.clone().scale(250);
    const key = `m${this.key++}`;
    const burn = motor === 'solid' ? 5 : 4;
    const thrust = motor === 'solid' ? 190 : 160;
    let age = 0;
    const effects = this.effects;
    this.actors.push({
      step: (dt) => {
        age += dt;
        const burning = age < burn;
        const up = pos.clone().normalize();
        if (burning) vel.addScaled(vel.clone().normalize(), thrust * dt);
        vel.addScaled(up, -9.81 * dt).scale(1 - 0.02 * dt);
        pos.addScaled(vel, dt);
        effects.trackMissile(key, motor, burning, pos, vel);
        if (age > 9 || pos.length() < this.radius + 5) {
          effects.explode(pos, 9.4, 'air');
          return false;
        }
        return true;
      },
    });
  }

  /** A SAM from its launcher: the white column, then the thick trail climbing away. */
  sam(): void {
    const launcher = this.site('sam', 4);
    const r = this.rand;
    const target = this.local(-3000 + 6000 * r(), 4000 + 3000 * r(), 6000 + 2000 * r());
    const up = launcher.clone().normalize();
    const dir = up
      .clone()
      .scale(0.85)
      .addScaled(target.clone().sub(launcher).normalize(), 0.5)
      .normalize();
    this.effects.handle({
      type: 'launch',
      time: this.time,
      weapon: 'sam',
      motor: 'sam',
      at: [launcher.x, launcher.y, launcher.z],
      dir: [dir.x, dir.y, dir.z],
      fromGround: true,
    });
    const pos = launcher.clone();
    const vel = dir.clone().scale(20);
    const key = `sam${this.key++}`;
    let age = 0;
    const effects = this.effects;
    this.actors.push({
      step: (dt) => {
        age += dt;
        const burning = age < 12;
        // Turns toward its target, gently.
        const want = target.clone().sub(pos).normalize();
        const d = vel.clone().normalize();
        d.addScaled(want, Math.min(1, 0.6 * dt)).normalize();
        const speed = vel.length() + (burning ? (age < 3 ? 120 : 30) * dt : -5 * dt);
        vel.copy(d).scale(speed);
        pos.addScaled(vel, dt);
        effects.trackMissile(key, 'sam', burning, pos, vel);
        if (age > 18 || pos.distanceTo(target) < 60) {
          effects.explode(pos, 60, 'air');
          return false;
        }
        return true;
      },
    });
  }

  /** An aircraft circling the range, damaged or on fire. */
  aircraft(state: 'damaged' | 'burning', seconds = 40): void {
    const key = `ac${this.key++}`;
    const radius = 1300;
    const height = 500 + 400 * this.rand();
    const speed = 160;
    const phase = this.rand() * 6.28;
    let age = 0;
    const effects = this.effects;
    const c = this.site('range');
    this.actors.push({
      step: (dt) => {
        age += dt;
        const a = phase + (age * speed) / radius;
        const pos = this.local(Math.cos(a) * radius, Math.sin(a) * radius, height);
        const vel = this.east
          .clone()
          .scale(-Math.sin(a) * speed)
          .addScaled(this.north, Math.cos(a) * speed);
        effects.trackAircraft(key, pos, vel, state);
        void c;
        return age < seconds;
      },
    });
  }

  /** Flares dropped from a pass over the range. */
  flares(): void {
    const start = this.local(-600, -200, 900);
    for (let i = 0; i < 6; i++) {
      const key = `flare${this.key++}`;
      const pos = start.clone().addScaled(this.east, i * 60);
      const vel = this.east
        .clone()
        .scale(80)
        .addScaled(this.north, (i % 2 ? 1 : -1) * 25);
      let age = -i * 0.25;
      const effects = this.effects;
      this.actors.push({
        step: (dt) => {
          age += dt;
          if (age < 0) return true;
          const up = pos.clone().normalize();
          vel.scale(1 - 0.8 * dt).addScaled(up, -6 * dt);
          pos.addScaled(vel, dt);
          effects.track(key, 'flare', { pos, vel });
          return age < 6;
        },
      });
    }
  }

  /** A helicopter hovering over the helipad, its wash raising dust for `seconds`. */
  hover(seconds = 30, look: 'dust' | 'snow-dust' | 'spray' = 'dust'): void {
    let age = 0;
    const effects = this.effects;
    const ground = this.site('helipad', 0);
    const tint: [number, number, number] = look === 'dust' ? [0.62, 0.5, 0.36] : [1, 1, 1];
    this.actors.push({
      step: (dt) => {
        age += dt;
        effects.track('wash', 'rotor-downwash', { pos: ground, scale: 7, strength: 1, tint, look });
        return age < seconds;
      },
    });
  }

  /** An aircraft at 10 km leaving contrails (if the air is cold enough). */
  contrail(seconds = 60): void {
    let age = 0;
    const effects = this.effects;
    const alt = 10_000;
    const key = `ct${this.key++}`;
    this.actors.push({
      step: (dt, t) => {
        age += dt;
        const n = -8000 + age * 230;
        for (const side of [-1, 1]) {
          const p = this.local(-2000 + side * 3, n, alt);
          effects.ribbons.trail(
            `${key}:${side}`,
            'contrail',
            p,
            contrailForms(alt, this.temperature),
            effects.time,
            this.humidity,
          );
        }
        void t;
        return age < seconds;
      },
    });
  }

  /** An aircraft in a hard turn at `g` over the range: vortices from its wingtips. */
  hardTurn(g = 6, seconds = 12): void {
    let age = 0;
    const effects = this.effects;
    const speed = 200;
    const radius = (speed * speed) / (9.81 * Math.sqrt(g * g - 1));
    const key = `vt${this.key++}`;
    const c = this.local(0, 600, 1500);
    this.actors.push({
      step: () => {
        age += 1 / 60;
        const a = (age * speed) / radius;
        const center = c.clone();
        const radial = this.east.clone().scale(Math.cos(a)).addScaled(this.north, Math.sin(a));
        const p = center.clone().addScaled(radial, radius);
        // The wings bank into the turn: the tips lie along the lift's tilt.
        const bank = Math.acos(1 / g);
        const up = c.clone().normalize();
        const span = radial.clone().scale(Math.cos(bank)).addScaled(up, Math.sin(bank));
        for (const side of [-1, 1]) {
          effects.ribbons.trail(
            `${key}:${side}`,
            'vortex',
            p.clone().addScaled(span, side * 5),
            vortexForms(g, this.humidity),
            effects.time,
          );
        }
        return age < seconds;
      },
    });
  }

  /**
   * The proposal's stress scene: 50 missiles in flight, 20 explosions and 30 burning
   * columns (the budget check).
   */
  stress(): void {
    const r = this.rand;
    for (let i = 0; i < 50; i++) {
      const motor: MotorKind = i % 5 === 0 ? 'reduced-smoke' : 'solid';
      this.missile(
        motor,
        this.local(-3000 + 600 * r(), -2500 + 5000 * r(), 400 + 2500 * r()),
        this.local(3000, -2500 + 5000 * r(), 400 + 2500 * r()),
      );
    }
    const sizes: ExplosionSize[] = ['rocket', 'missile warhead', '230 kg bomb', '900 kg bomb'];
    for (let i = 0; i < 20; i++) this.explosion(sizes[i % 4]!, i % 3 === 0 ? 'air' : 'ground');
    for (let i = 0; i < 30; i++) {
      const at = this.local(-3000 + 6000 * r(), -1500 + 4500 * r(), 0);
      this.effects.spawnPreset(i % 3 === 0 ? 'fuel-fire' : 'burning-target', at, `stress:${i}`);
    }
  }

  /** Everything off: actors, emitters, columns, puffs. */
  reset(): void {
    this.actors = [];
    this.effects.setColumns([]);
    this.effects.clear();
  }

  /** Advances by `dt` (s) and draws (or only steps, with `draw` false). */
  frame(dt: number, draw = true): void {
    this.time += dt;
    this.actors = this.actors.filter((a) => a.step(dt, this.time));
    this.lighting.update(this.eye, this.sun);
    this.lighting.atmosphere.sky.setCelestial(
      this.lighting.sunElevation,
      this.lighting.night,
      0.5,
      0,
      7.3,
    );
    this.lighting.atmosphere.bakeSky(this.renderer);
    placeCameraRelative(this.world, this.center, this.eye);
    const height = (this.renderer.domElement as { height?: number }).height ?? 540;
    const pixelAngle = (this.camera.fov * DEG) / Math.max(1, height);
    this.effects.update(this.renderer, { eye: this.eye, dt, wind: this.wind, pixelAngle });
    if (!draw) return;
    if (this.pipeline) {
      this.pipeline.sunElevation.value = this.lighting.sunElevation;
      this.pipeline.render(this.scene, this.camera);
    } else this.renderer.render(this.scene, this.camera);
  }

  // ---- The patch ----

  private toLocal(p: Readonly<Vec3d>): [number, number, number] {
    return [p.x - this.center.x, p.y - this.center.y, p.z - this.center.z];
  }

  /** Ground: a curved patch 60 km across in fields of a few hundred meters, lit as the terrain is. */
  private buildGround(): void {
    const n = 160;
    const half = 30_000;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const loc = new Float32Array((n + 1) * (n + 1) * 2);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        // Denser near the middle: the cells grow outward.
        const s = (k: number) => {
          const u = (k / n) * 2 - 1;
          return Math.sign(u) * Math.abs(u) ** 2 * half;
        };
        const e = s(i);
        const nn = s(j);
        const p = this.local(e, nn, 0);
        pos.set(this.toLocal(p), (j * (n + 1) + i) * 3);
        loc.set([e, nn], (j * (n + 1) + i) * 2);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
      }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('local', new BufferAttribute(loc, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new MeshBasicNodeMaterial();
    const L = this.lighting;
    const local = attribute('local', 'vec2');
    const cell = floor(local.div(320));
    const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
    const field = mix(
      mix(vec3(0.16, 0.2, 0.07), vec3(0.24, 0.23, 0.1), h),
      vec3(0.3, 0.26, 0.17),
      h.greaterThan(0.82).select(1, 0),
    );
    m.colorNode = Fn(() => {
      const ap = L.atmosphere.aerialPerspective(positionWorld as V3, 6);
      return vec4(
        L.applyAerial(
          L.shadeDiffuse(field as V3, normalWorld as V3, positionWorld as V3),
          ap.inscatter,
          ap.transmittance,
        ),
        1,
      );
    })();
    const ground = new Mesh(g, m);
    ground.frustumCulled = false;
    this.world.add(ground);
  }

  private buildProps(): void {
    const L = this.lighting;
    const lit = (r: number, g: number, b: number) => {
      const m = new MeshBasicNodeMaterial();
      m.colorNode = Fn(() => {
        const ap = L.atmosphere.aerialPerspective(positionWorld as V3, 4);
        return vec4(
          L.applyAerial(
            L.shadeDiffuse(vec3(r, g, b), normalWorld as V3, positionWorld as V3),
            ap.inscatter,
            ap.transmittance,
          ),
          1,
        );
      })();
      return m;
    };
    const brick = lit(0.32, 0.16, 0.1);
    const concrete = lit(0.42, 0.41, 0.38);
    const steel = lit(0.5, 0.5, 0.48);
    const olive = lit(0.18, 0.2, 0.12);
    const place = (
      geo: BufferGeometry,
      mat: MeshBasicNodeMaterial,
      e: number,
      n: number,
      h: number,
    ) => {
      const mesh = new Mesh(geo, mat);
      const p = this.local(e, n, h);
      mesh.position.set(...this.toLocal(p));
      const up = p.clone().normalize();
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(up.x, up.y, up.z));
      mesh.frustumCulled = false;
      this.world.add(mesh);
    };
    const w = SITES.works;
    // A row of four stacks and a cooling tower.
    for (let i = 0; i < 4; i++)
      place(new CylinderGeometry(2.2, 3, 42, 10), brick, w[0] + i * 30, w[1], 21);
    place(new CylinderGeometry(26, 34, 80, 20, 1, true), concrete, w[0], w[1] + 160, 40);
    place(new BoxGeometry(90, 18, 40), concrete, w[0] + 45, w[1] - 40, 9);
    // The fuel depot's tanks.
    const d = SITES.depot;
    for (let i = 0; i < 6; i++)
      place(
        new CylinderGeometry(14, 14, 14, 18),
        steel,
        d[0] + (i % 3) * 40 - 40,
        d[1] + Math.floor(i / 3) * 40,
        7,
      );
    // The SAM site: launcher and radar.
    const s = SITES.sam;
    place(new BoxGeometry(4, 3, 9), olive, s[0], s[1], 1.5);
    place(new BoxGeometry(3, 6, 3), olive, s[0] + 30, s[1] + 10, 3);
    // Hangars and a parked aircraft's stand-in on the range's edge.
    const hg = SITES.hangars;
    for (let i = 0; i < 3; i++)
      place(new BoxGeometry(40, 12, 30), concrete, hg[0] + i * 55, hg[1], 6);
    place(new BoxGeometry(2, 2, 16), olive, 40, -60, 1.5);
    place(new BoxGeometry(11, 0.4, 3), olive, 40, -61, 1.7);
    // A low wall on the range for puffs to cut into.
    place(new BoxGeometry(120, 6, 2), concrete, 0, 60, 3);
    // The helipad's stand-in helicopter, hovering.
    const hp = SITES.helipad;
    place(new BoxGeometry(2.4, 2.4, 12), olive, hp[0], hp[1], 12);
  }

  dispose(): void {
    this.effects.dispose();
    this.pipeline?.dispose();
  }
}
