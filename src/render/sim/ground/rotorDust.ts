/**
 * What a rotor's downwash raises from the ground (G5; decisions 168, 169, 182):
 * soft, wispy sprites of dust, grit, snow or spray that roll out from under
 * the rotor, drawn in the pipeline's overlay (post/simPipeline.ts) like the
 * weather's particles (weather/precipitation.ts), whose light they share.
 *
 * - **Which.** Once per frame `washSurface` reads the ground where the wash
 *   meets it: spray over the sea, lakes and rivers; snow powder where snow
 *   lies; ochre dust (in the ground's own color) on deserts, beaches and dry
 *   grass and scrub; gray grit on rock, gravel, tundra, alpine ground and
 *   pavement; nothing on green ground, where the flattened grass is the cue
 *   (decision 176). Wet ground raises less dust and grit.
 * - **Where.** No state per sprite. Each instance's direction, speed, size,
 *   life and phase come from a hash of its index, and its place is a function
 *   of its age: out from the wash's center along the ground, fast and then
 *   slowing as the wall jet spreads to about three rotor radii, rising as it
 *   goes into a low billow, and carried off with the wind. A sprite reborn at
 *   the end of its life starts again under the rotor, so the cloud follows the
 *   helicopter.
 * - **How it looks.** A quad facing the camera, stretched along its motion,
 *   swelling and thinning with age; its opacity falls off from the middle and
 *   its edge is eaten by value noise, so it reads wispy, not as a disc. It
 *   fades against the scene's depth over a meter and a half, so it never cuts
 *   a hard line into the ground, and it fades near the lens.
 * - **How much.** Up to `DUST_CAP` instances times the particles' quality
 *   factor, scaled by the wash's strength and the surface; none, and no draw,
 *   without a wash.
 */
import {
  BufferAttribute,
  DoubleSide,
  Group,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  cos,
  cross,
  dot,
  float,
  floor,
  Fn,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  uint,
  uniform,
  varyingProperty,
  vec2,
  vec4,
} from 'three/tsl';
import { Vec3d } from '../../../core/vec3d';
import { directionToCubeFace } from '../../../core/coords';
import { tileForDirection, TILE_TEXELS } from '../../../core/tiles';
import { Biome, TileCover } from '../../../worldgen/biomes';
import { earthElevation, LAPSE_RATE } from '../../../worldgen/climate';
import { NO_LAKE } from '../../../worldgen/gpu/tileSynth';
import { srgbToLinear } from '../../common/palette';
import type { ClimateTexture } from '../../common/climateTexture';
import { WARMEST_PHASE } from '../../common/seasons';
import {
  colorFor,
  lakeSampler,
  mapSample,
  materialAt,
  surfaceSampler,
} from '../../common/terrain/tileMesh';
import { riverStretches, treeDataTile } from '../forest/forestLayer';
import type { InfraScene } from '../infra/infraScene';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { LandShading } from '../terrain/landShading';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import { particleLight } from '../weather/precipitation';
import type { GroundDownwash } from './groundCoverLayer';

type F = Node<'float'>;

/** What the wash raises. */
export type WashKind = 'none' | 'dust' | 'grit' | 'snow' | 'spray';

/** The ground under the wash, as `washSurface` reads it. */
export interface WashSite {
  /** Over the sea, a lake or a river. */
  water: boolean;
  /** The tile material's cover (a `Biome` or a `TileCover`). */
  cover: number;
  /** Moisture 0..1 (the climate's). */
  moisture: number;
  /** The surface temperature today (°C). */
  temperature: number;
  /** Ground wetness from rain 0..1. */
  wetness: number;
  /** On pavement (runways, aprons, roads). */
  paved: boolean;
  /** Steep, bare rock. */
  rock: boolean;
}

/** The kind of sprite and how much of it (0..1) the ground gives. */
export interface WashSurface {
  kind: WashKind;
  amount: number;
}

/** What the wash raises from a site (see the module comment). */
export function washSurface(s: WashSite): WashSurface {
  if (s.water) return { kind: 'spray', amount: 1 };
  if (s.temperature < -1.5 && s.moisture > 0.03 && !s.paved) return { kind: 'snow', amount: 1 };
  const dry = 1 - Math.min(1, Math.max(0, s.wetness / 0.6));
  if (s.paved || s.rock) return { kind: 'grit', amount: 0.35 * dry };
  switch (s.cover) {
    case Biome.HotDesert:
    case Biome.ColdDesert:
    case TileCover.Beach:
      return { kind: 'dust', amount: dry };
    case TileCover.Gravel:
    case Biome.Alpine:
    case Biome.Tundra:
      return { kind: 'grit', amount: 0.5 * dry };
    case TileCover.Marsh:
      return { kind: 'spray', amount: 0.35 };
    case Biome.Savanna:
    case Biome.Shrubland:
    case Biome.TemperateGrassland: {
      // Dry grass and scrub lift dust from the bare ground between them.
      const arid = 1 - Math.min(1, Math.max(0, (s.moisture - 0.2) / 0.2));
      return arid > 0 ? { kind: 'dust', amount: 0.7 * arid * dry } : { kind: 'none', amount: 0 };
    }
    default:
      return { kind: 'none', amount: 0 };
  }
}

/** Sprites at full strength and quality factor 1. */
export const DUST_CAP = 240;
/**
 * Dust is raised only by a slow helicopter (the owner's request, decision 191): in full
 * below 30 kt over the ground, none above 50 kt.
 */
const DUST_SLOW = 15.4;
const DUST_FAST = 25.7;
/** A sprite never spans more than this share of its distance from the lens (overdraw). */
const MAX_ANGULAR_SIZE = 0.3;
/** The wash moves this far (m) before the ground under it is read again. */
const SURFACE_STEP = 3;
/** The wash's outwash speed (m/s) at which it raises all it can. */
const FULL_WASH = 10;
/** A sprite's life (s), shortest and longest. */
const LIFE: readonly [number, number] = [2.2, 4];
/** How far out a sprite travels, in rotor radii (from the start of its run). */
const RUN = 2.8;

/** Each kind's tint (linear, times the light), opacity and least and greatest size in rotor radii. */
const LOOK: Readonly<
  Record<
    Exclude<WashKind, 'none'>,
    { tint: [number, number, number]; opacity: number; size: [number, number] }
  >
> = {
  dust: { tint: [0.6, 0.48, 0.33], opacity: 0.32, size: [0.3, 1.0] },
  grit: { tint: [0.42, 0.4, 0.37], opacity: 0.34, size: [0.22, 0.7] },
  snow: { tint: [0.92, 0.94, 0.97], opacity: 0.36, size: [0.3, 1.1] },
  spray: { tint: [0.82, 0.87, 0.92], opacity: 0.38, size: [0.25, 0.8] },
};

/** What `RotorDust.update` needs each frame. */
export interface RotorDustFrame {
  eye: Readonly<Vec3d>;
  forward: Readonly<Vec3d>;
  up: Readonly<Vec3d>;
  /** Real seconds since the last frame (0 while paused). */
  dt: number;
  /** The downwash, or null. */
  wash: GroundDownwash | null;
  /** The wind at the ground there (world, m/s). */
  wind: Readonly<Vec3d>;
  /** The particles' quality factor (Precipitation.density). */
  density: number;
}

export class RotorDust {
  /** The sprites; add it to the pipeline's overlay scene. */
  readonly group = new Group();
  enabled = true;
  /** What was raised last frame, and how many sprites were drawn. */
  readonly stats = { kind: 'none' as WashKind, count: 0 };
  private readonly geometry = new InstancedBufferGeometry();
  private readonly mesh: Mesh;
  private infra: InfraScene | null = null;
  private warmed = false;
  private readonly u = {
    time: uniform(0),
    center: uniform(new Vector3()),
    east: uniform(new Vector3(1, 0, 0)),
    north: uniform(new Vector3(0, 0, 1)),
    zenith: uniform(new Vector3(0, 1, 0)),
    right: uniform(new Vector3(1, 0, 0)),
    upward: uniform(new Vector3(0, 1, 0)),
    wind: uniform(new Vector3()),
    radius: uniform(4),
    strength: uniform(0),
    tint: uniform(new Vector3(1, 1, 1)),
    opacity: uniform(0),
    sizes: uniform(new Vector3(0.3, 1, 0)),
    ambient: uniform(new Vector3()),
    sun: uniform(new Vector3()),
  };
  private readonly scratch = new Vec3d();
  /** The ground under the wash as last read, and where. */
  private surface: (WashSurface & { color: [number, number, number] | null }) | null = null;
  private readonly surfaceCenter = new Vec3d();
  private readonly climateSample = new Float32Array(4);

  constructor(
    private readonly terrain: TerrainRenderer,
    private readonly climate: ClimateTexture,
    private readonly land: LandShading,
    private readonly lighting: PlanetLighting,
    sceneDistance: F,
  ) {
    // x across the sprite, y along its motion, both −1..1.
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3),
    );
    this.geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.geometry.instanceCount = 0;
    this.mesh = new Mesh(this.geometry, this.material(sceneDistance));
    this.mesh.name = 'rotor dust';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  /** Pavement and towns, for grit on runways and aprons. */
  setInfrastructure(scene: InfraScene | null): void {
    this.infra = scene;
  }

  private material(sceneDistance: F): MeshBasicNodeMaterial {
    const u = this.u;
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    m.name = 'rotor dust';
    const vColor = varyingProperty('vec3', 'vDustColor');
    const vOpacity = varyingProperty('float', 'vDustOpacity');
    const vDistance = varyingProperty('float', 'vDustDistance');
    const vSeed = varyingProperty('float', 'vDustSeed');
    m.positionNode = Fn(() => {
      const index = instanceIndex.mul(uint(8));
      const rand = (k: number): F => hash(index.add(uint(k))) as F;
      const life = mix(float(LIFE[0]), float(LIFE[1]), rand(0));
      const cycle = u.time.div(life).add(rand(1));
      const age = fract(cycle).toVar();
      // Each rebirth goes out in a new direction.
      const born = floor(cycle);
      const turn = fract(rand(2).add(born.mul(0.618034))).mul(2 * Math.PI);
      const out = u.east.mul(cos(turn)).add(u.north.mul(sin(turn)));
      const pace = mix(float(0.6), float(1.3), rand(3));
      const R = u.radius;
      // The wall jet: fast at first, slowing as it spreads.
      const run = float(1).sub(pow(float(1).sub(age), 2));
      const r = R.mul(float(0.5).add(run.mul(RUN).mul(pace)));
      // It rises as it rolls out, into a low billow.
      const lift = R.mul(mix(float(0.08), float(0.9), pow(age, 0.7))).mul(
        mix(float(0.5), float(1.2), rand(4)),
      );
      const carried = u.wind.mul(age.mul(life).mul(0.7));
      const p = u.center.add(out.mul(r)).add(u.zenith.mul(lift)).add(carried).toVar();
      // Never wider than a share of its distance: sprites by the lens would fill the screen
      // many times over (decision 191).
      const size = min(
        R.mul(mix(u.sizes.x, u.sizes.y, rand(5))).mul(age.mul(1.2).add(0.4)),
        length(p).mul(MAX_ANGULAR_SIZE),
      );
      // Along its motion on screen: out and up.
      const motion = out
        .mul(
          R.mul(RUN)
            .mul(pace)
            .mul(float(2).mul(float(1).sub(age))),
        )
        .add(u.zenith.mul(R.mul(0.5)))
        .add(u.wind);
      const view = normalize(p);
      const across = motion.sub(view.mul(dot(motion, view)));
      const along = normalize(across.add(u.upward.mul(1e-3)));
      const side = normalize(cross(along, view));
      const corner = p
        .add(along.mul(size.mul(1.5)).mul(positionGeometry.y))
        .add(side.mul(size).mul(positionGeometry.x));
      const distance = length(corner);
      // In, then out: born thick under the rotor, thinning as it spreads.
      const fade = smoothstep(0, 0.12, age).mul(pow(float(1).sub(age), 1.3));
      const opacity = u.opacity
        .mul(u.strength)
        .mul(fade)
        .mul(smoothstep(3, 10, distance));
      vOpacity.assign(opacity);
      vDistance.assign(distance);
      vSeed.assign(rand(6).add(born.mul(0.37)));
      // Toward the sun the dust glows; its shade varies a little per sprite.
      const toSun = max(dot(view, this.lighting.sunDirection), 0);
      const scatter = pow(toSun, 4).mul(1.2).add(0.35);
      const shade = mix(float(0.85), float(1.1), rand(7));
      vColor.assign(u.tint.mul(shade).mul(u.ambient.add(u.sun.mul(scatter))));
      return corner;
    })();
    m.colorNode = Fn(() => {
      const q = positionGeometry.xy;
      const d = dot(q, q);
      // Value noise over the sprite eats its edge: wisps, not a disc.
      const g = q.mul(2.2).add(vec2(vSeed.mul(17.3), vSeed.mul(29.1)));
      const cell = floor(g);
      const f = fract(g);
      const s = f.mul(f).mul(f.mul(-2).add(3));
      const h = (x: number, y: number) =>
        fract(sin(dot(cell.add(vec2(x, y)), vec2(127.1, 311.7))).mul(43758.5453));
      const n = mix(mix(h(0, 0), h(1, 0), s.x), mix(h(0, 1), h(1, 1), s.x), s.y);
      const shape = clamp(float(1).sub(d), 0, 1).mul(
        smoothstep(0.35, 0.8, n.add(float(0.35).sub(d.mul(0.45)))),
      );
      // Soft against the ground and whatever else is nearer.
      const clear = smoothstep(float(0), float(1.5), sceneDistance.sub(vDistance));
      return vec4(vColor, vOpacity.mul(shape).mul(clear));
    })();
    return m;
  }

  /** What the ground under the wash gives (see `washSurface`), or none if its data is not loaded. */
  private surfaceAt(
    center: Readonly<Vec3d>,
  ): WashSurface & { color: [number, number, number] | null } {
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    const none = { kind: 'none' as WashKind, amount: 0, color: null };
    if (!world || !opts) return none;
    const d = this.scratch.copy(center).normalize();
    const t = tileForDirection(d, 10);
    const key = treeDataTile(t);
    const data = this.terrain.dataTile(key);
    if (!data) {
      this.terrain.requestDataTile(key, 1);
      return none;
    }
    const uv = directionToCubeFace(d);
    const size = TILE_TEXELS * (1 << t.level);
    const sx = uv.u * size - t.x * TILE_TEXELS;
    const sy = uv.v * size - t.y * TILE_TEXELS;
    const h = surfaceSampler(t, t.level, data, opts)(sx, sy, d);
    const lake = lakeSampler(t, data)(sx, sy);
    const [fx, fy] = mapSample(t, data.key, sx, sy);
    const mat = materialAt(data, fx, fy);
    let water = h <= 0 || (lake > NO_LAKE / 2 && lake > h);
    if (!water && world.rivers) {
      const R = opts.radius;
      for (const o of riverStretches(world.rivers, t, R)) {
        const ab = o.b.clone().sub(o.a);
        const k = Math.min(
          1,
          Math.max(0, d.clone().sub(o.a).dot(ab) / Math.max(ab.dot(ab), 1e-30)),
        );
        if (o.a.clone().addScaled(ab, k).distanceTo(d) * R < o.width / 2) water = true;
      }
    }
    const c = this.climate.sampleAt(d, this.climateSample);
    const meanT = c[0]! - earthElevation(Math.max(0, h), c[3]!, opts.reliefScale) * LAPSE_RATE;
    const hemisphere = Math.max(-1, Math.min(1, d.y * 20));
    const seasonal =
      Math.cos((this.land.seasonPhase.value - WARMEST_PHASE) * 2 * Math.PI) * hemisphere;
    const temperature = meanT + c[1]! * seasonal + this.land.temperatureOffset.value;
    const s = washSurface({
      water,
      cover: mat & 0xff,
      moisture: c[2]!,
      temperature,
      wetness: this.land.wetness.value,
      paved: this.infra?.isClear(d, true) ?? false,
      rock: false,
    });
    const rgb = colorFor('biome', Math.max(1, h), mat, t.level, false, opts.reliefScale);
    return { ...s, color: [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])] };
  }

  update(f: RotorDustFrame): void {
    const u = this.u;
    u.time.value += f.dt;
    const wash = this.enabled ? f.wash : null;
    let count = 0;
    let kind: WashKind = 'none';
    const slow =
      wash?.groundSpeed === undefined
        ? 1
        : 1 - Math.min(1, Math.max(0, (wash.groundSpeed - DUST_SLOW) / (DUST_FAST - DUST_SLOW)));
    if (wash && wash.speed > 0.5 && slow > 0) {
      // The ground under the wash, read again only when the wash has moved (decision 191).
      if (!this.surface || this.surfaceCenter.distanceTo(wash.center) > SURFACE_STEP) {
        this.surface = this.surfaceAt(wash.center);
        this.surfaceCenter.copy(wash.center);
      }
      const s = this.surface;
      kind = s.kind;
      if (s.kind !== 'none' && s.amount > 0) {
        const strength = Math.min(1, wash.speed / FULL_WASH) * s.amount * slow;
        count = Math.round(DUST_CAP * Math.min(2, Math.max(0, f.density)) * Math.min(1, strength));
        const look = LOOK[s.kind];
        // Dust takes the ground's color, lighter: what it is made of.
        const tint =
          s.kind === 'dust' && s.color
            ? (s.color.map((v, i) => Math.min(1, v * 1.25 * 0.5 + look.tint[i]! * 0.5)) as [
                number,
                number,
                number,
              ])
            : look.tint;
        u.tint.value.set(...tint);
        u.opacity.value = look.opacity;
        u.sizes.value.set(look.size[0], look.size[1], 0);
        u.strength.value = strength;
        u.radius.value = wash.radius;
        u.center.value.set(
          wash.center.x - f.eye.x,
          wash.center.y - f.eye.y,
          wash.center.z - f.eye.z,
        );
        const up = this.scratch.copy(wash.center).normalize();
        const east = new Vec3d(0, 1, 0).cross(up);
        if (east.length() < 1e-6) east.set(1, 0, 0);
        east.normalize();
        const north = up.clone().cross(east);
        u.east.value.set(east.x, east.y, east.z);
        u.north.value.set(north.x, north.y, north.z);
        u.zenith.value.set(up.x, up.y, up.z);
        const w = f.wind;
        const vertical = w.x * up.x + w.y * up.y + w.z * up.z;
        u.wind.value.set(w.x - up.x * vertical, w.y - up.y * vertical, w.z - up.z * vertical);
        const light = particleLight(this.lighting);
        u.ambient.value.set(...light.ambient);
        u.sun.value.set(...light.sun);
      }
    }
    if (count === 0 && !this.warmed && this.enabled) {
      // One sprite of no opacity in the first frame: the material compiles before it is needed.
      this.warmed = true;
      this.geometry.instanceCount = 1;
      u.strength.value = 0;
      this.mesh.visible = this.group.visible = true;
      this.stats.kind = 'none';
      this.stats.count = 0;
      return;
    }
    this.geometry.instanceCount = count;
    this.mesh.visible = this.group.visible = count > 0;
    this.stats.kind = kind;
    this.stats.count = count;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
