/**
 * Rain, snow and blowing dust near the camera: instanced quads in the
 * pipeline's overlay scene (post/simPipeline.ts), one mesh per kind, with no
 * work per particle on the CPU and no buffer per particle on the GPU.
 *
 * **Where the particles are.** Each kind fills three nested cubes of air that
 * stand for depth layers (`LAYER_SIDES`: 16, 32 and 64 m). A particle's place
 * in its cube comes from a hash of its instance index, so it needs no
 * attribute. The cube is a period of an endless lattice that is fixed in the
 * world, not to the camera: the CPU keeps the lattice's offset from the eye
 * (`drift`: the wind's and the camera's motion, taken in float64 before
 * anything is wrapped) and how far the particles have fallen (`fall`, which
 * each particle takes times its own speed factor), and the vertex shader
 * picks, for every particle, the copy of it that lies in the cube ahead of
 * the camera (`wrapParticle`). So particles pass by as the camera moves,
 * near ones faster than far ones, and turning the camera only brings other
 * particles into view. The cube is centered half its side ahead, which holds
 * the whole view out to `side · cos(half the diagonal field of view)`; about
 * one particle in seven is on screen. Speed factors are multiples of 1/8, so
 * `fall` can wrap at eight periods without a jump.
 *
 * **What a particle looks like.** A quad along the particle's velocity
 * relative to the camera over an exposure time, padded to the particle's own
 * size at both ends: a drop at rest is a short vertical streak, the same drop
 * seen from an aircraft at 250 m/s a long, nearly horizontal one, and a flake
 * in still air a soft disc. Rain leans with the wind because the wind is part
 * of the velocity. A particle is never drawn thinner than about a pixel; one
 * that would be is drawn fainter instead. Its opacity falls off elliptically
 * from the middle of the quad (no texture), fades toward the far side of its
 * layer and close to the lens, falls with the murk of fog and dust between,
 * and it hides behind whatever the scene's depth holds nearer: the aircraft
 * in the chase view, buildings, the ground.
 *
 * **How much.** `particleCount` gives the instances per kind from the
 * intensity 0..1 (weatherState.ts) and the `density` quality factor, up to
 * `PARTICLE_CAPS`; a kind at zero is not drawn and costs nothing. Rain grows
 * from sparse, short, slow, fine drops (drizzle) to dense, long, fast, heavy
 * streaks (skyfall); snow falls at 1 to 2 m/s in flakes of varied size that
 * sway, and a gale drives it flat; dust is ochre motes carried at the wind's
 * speed. Rain and snow fall from cloud: both fade out as the camera climbs
 * through the cloud base (`belowCloud`), and dust thins with height.
 *
 * **Light.** One color per kind and frame, computed on the CPU from the
 * lighting's numbers at the camera (`particleLight`): the sky's irradiance,
 * sunlight past the atmosphere and the cloud cover, moonlight and starlight
 * by night, and the lightning flash. Sunlit particles brighten toward the
 * sun. No texture is read per particle; the only read per fragment is the
 * scene's depth.
 */
import {
  BufferAttribute,
  DataUtils,
  DoubleSide,
  Group,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  clamp,
  cross,
  dot,
  exp,
  float,
  Fn,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  min,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  uint,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import type { Meters, Seconds } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import {
  IRRADIANCE_MU_MIN,
  IRRADIANCE_SIZE,
  LUMA,
  planetShadow,
  sampleTransmittanceLut,
} from '../atmosphere/model';
import { MOON_TINT } from '../atmosphere/skyView';
import type { PlanetLighting } from '../lighting/planetLighting';
import { dustExtinction } from './weatherState';
import type { WeatherState } from './weatherState';

type F = Node<'float'>;

export type ParticleKind = 'rain' | 'snow' | 'dust';
export const PARTICLE_KINDS: readonly ParticleKind[] = ['rain', 'snow', 'dust'];

/** Sides of the three layers' cubes (m). Each is a divisor of the last. */
export const LAYER_SIDES: readonly [Meters, Meters, Meters] = [16, 32, 64];
/** The lattice's period (m): the largest side, so one offset serves every layer. */
export const WRAP_PERIOD: Meters = LAYER_SIDES[2];
/** A particle's speed factor is a multiple of 1 / SPEED_STEPS. */
export const SPEED_STEPS = 8;
/** The speed factors: SPEED_MIN / SPEED_STEPS … (SPEED_MIN + SPEED_RANGE − 1) / SPEED_STEPS. */
const SPEED_MIN = 6;
const SPEED_RANGE = 5;
/** The fall offset wraps here (m): a period for every speed factor. */
export const FALL_PERIOD: Meters = WRAP_PERIOD * SPEED_STEPS;
/** Instances per kind at full intensity and `density` 1. */
export const PARTICLE_CAPS: Readonly<Record<ParticleKind, number>> = {
  rain: 60_000,
  snow: 48_000,
  dust: 36_000,
};
/** The highest `density` (quality factor) the caps are scaled by. */
export const MAX_DENSITY = 2;
/** A camera that moves faster than this between two frames has jumped (m/s). */
const JUMP_SPEED = 1500;
/** Time constant of the camera velocity's smoothing (s). */
const VELOCITY_SMOOTHING: Seconds = 0.08;
/** The longest a streak's half-length gets (m), however fast the camera flies. */
const MAX_HALF_STREAK: Meters = 1.6;
/** Particles fade in between these distances from the lens (m). */
const NEAR_FADE: readonly [Meters, Meters] = [0.5, 2];
/** The least width a particle is drawn with (pixels). */
const MIN_PIXELS = 1.25;
/** How much of the thinning of a particle narrower than MIN_PIXELS shows as lower opacity (1 = all). */
const THIN_FADE = 0.4;

/**
 * Instances drawn for a kind at an intensity 0..1 and a quality factor:
 * 0 at zero, and the cap times `density` at full intensity.
 */
export function particleCount(kind: ParticleKind, level: number, density = 1): number {
  if (!(level > 0) || !(density > 0)) return 0;
  const x = Math.min(1, level);
  // Snow and dust are full well below the top of their scales: a blizzard is 3 mm/h of water.
  const share =
    kind === 'rain'
      ? Math.pow(x, 1.1)
      : kind === 'snow'
        ? Math.pow(Math.min(1, x / 0.6), 1.3)
        : Math.pow(x, 1.5);
  const cap = PARTICLE_CAPS[kind] * Math.min(MAX_DENSITY, density);
  return Math.max(Math.min(cap, 400), Math.round(cap * share));
}

/**
 * How much of the precipitation under a cloud reaches a camera `height`
 * meters above the ground: all of it below the base, none from 300 m inside
 * the cloud up. `cloudBase` is the base above the ground (m).
 */
export function belowCloud(height: Meters, cloudBase: Meters): number {
  if (!Number.isFinite(cloudBase)) return 1;
  const t = Math.min(1, Math.max(0, (height - (cloudBase - 50)) / 350));
  return 1 - t * t * (3 - 2 * t);
}

/** How much of the dust near the ground is left `height` meters above it. */
export function dustAtHeight(height: Meters): number {
  const t = Math.min(1, Math.max(0, (height - 300) / 1200));
  return 1 - t * t * (3 - 2 * t);
}

/** Wraps a value into [0, period). */
export function wrap(value: number, period: number): number {
  return value - Math.floor(value / period) * period;
}

/**
 * One coordinate of a particle relative to the eye (m): the copy of the
 * particle whose lattice coordinate is `h · side + drift + speed · fall` that
 * lies in the cube of `side` centered at `center`. The vertex shader does the
 * same per axis. `h` is the particle's hash 0..1, `speed` its speed factor (a
 * multiple of 1 / SPEED_STEPS), `drift` the lattice's offset from the eye and
 * `fall` the distance fallen along this axis.
 */
export function wrapParticle(
  h: number,
  side: Meters,
  drift: Meters,
  fall: Meters,
  speed: number,
  center: Meters,
): Meters {
  const q = h * side + drift + speed * fall;
  const f = (q - center) / side + 0.5;
  return center + (f - Math.floor(f) - 0.5) * side;
}

/**
 * How far a layer's particles are drawn, as a fraction of its cube's side,
 * for a vertical field of view (rad) and an aspect ratio: the cosine of half
 * the diagonal field of view, so that the view out to that distance fits in
 * the cube centered half a side ahead.
 */
export function layerReach(fovY: number, aspect: number): number {
  const t = Math.tan(fovY / 2);
  const diagonal = Math.atan(t * Math.hypot(1, aspect));
  return Math.min(1, Math.max(0.35, Math.cos(diagonal)));
}

/** What a kind looks like at an intensity (the numbers behind the uniforms). */
export interface ParticleLook {
  /** Terminal fall speed of a particle with speed factor 1 (m/s). */
  fallSpeed: number;
  /** Exposure time over which a particle's motion is drawn as a streak (s). */
  exposure: Seconds;
  /** Diameter of the smallest and the largest particle (m). */
  sizeMin: Meters;
  sizeMax: Meters;
  /** Opacity of a particle's middle. */
  opacity: number;
  /** How far a particle sways sideways (m). */
  sway: Meters;
  /** Share of the wind a particle with speed factor 0 would move at (dust is carried, rain is not slowed). */
  carried: number;
}

/** The look of a kind at an intensity 0..1 in a wind (m/s). */
export function particleLook(kind: ParticleKind, level: number, windSpeed = 0): ParticleLook {
  const x = Math.min(1, Math.max(0, level));
  const s = (a: number, b: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  if (kind === 'rain') {
    // Drizzle drifts down at 2 m/s in fine drops; a skyfall's drops are heavy and fast.
    return {
      fallSpeed: 2 + 7.5 * s(0.1, 0.9),
      exposure: 0.025 + 0.022 * x,
      sizeMin: 0.0025 + 0.005 * x,
      sizeMax: 0.005 + 0.013 * x,
      opacity: 0.42 + 0.4 * x,
      sway: 0,
      carried: 1,
    };
  }
  if (kind === 'snow') {
    return {
      fallSpeed: 1.5,
      exposure: 1 / 100,
      sizeMin: 0.014,
      sizeMax: 0.03 + 0.03 * x,
      opacity: 0.7 + 0.2 * x,
      // Gusts toss the flakes about.
      sway: 0.25 + 0.03 * windSpeed,
      carried: 1,
    };
  }
  return {
    fallSpeed: 0,
    exposure: 1 / 35,
    sizeMin: 0.012,
    sizeMax: 0.035,
    opacity: 0.2 + 0.25 * x,
    sway: 0.35,
    carried: 0.72,
  };
}

/**
 * Color of a kind's particles (linear), as a multiple of the light on them. Drops gather the
 * brightest of the sky around them and flakes are white, so both stand out a little brighter
 * than the average sky; dust is ochre.
 */
export const PARTICLE_TINT: Readonly<Record<ParticleKind, readonly [number, number, number]>> = {
  rain: [1.25, 1.31, 1.4],
  snow: [1.3, 1.32, 1.36],
  dust: [0.78, 0.56, 0.3],
};

/** The light on particles at the camera, in display units. */
export interface ParticleLight {
  /** From all around: sky, night sky, moon, lightning. */
  ambient: [number, number, number];
  /** From the sun, past the air and the clouds. */
  sun: [number, number, number];
}

let irradianceTable: { source: unknown; version: number; data: Float32Array } | null = null;

/** The sky's irradiance per unit of sun illuminance for a sun-elevation cosine, read from the lighting's LUT on the CPU. */
function skyIrradiance(lighting: PlanetLighting, muS: number): [number, number, number] {
  const a = lighting.atmosphere;
  if (!irradianceTable || irradianceTable.source !== a || irradianceTable.version !== a.version) {
    const half = a.irradiance.image.data as Uint16Array;
    const data = new Float32Array(half.length);
    for (let i = 0; i < half.length; i++) data[i] = DataUtils.fromHalfFloat(half[i]!);
    irradianceTable = { source: a, version: a.version, data };
  }
  const t = irradianceTable.data;
  const x =
    Math.min(1, Math.max(0, (muS - IRRADIANCE_MU_MIN) / (1 - IRRADIANCE_MU_MIN))) *
      IRRADIANCE_SIZE -
    0.5;
  const i = Math.min(IRRADIANCE_SIZE - 2, Math.max(0, Math.floor(x)));
  const f = Math.min(1, Math.max(0, x - i));
  return [0, 1, 2].map((c) => t[i * 4 + c]! * (1 - f) + t[(i + 1) * 4 + c]! * f) as [
    number,
    number,
    number,
  ];
}

/**
 * The light on particles at the camera from the lighting's state this frame:
 * what `PlanetLighting.at` gives a surface there, without a texture read.
 * `cloudCover` (0..1) stands for the cloud's shadow on the sun.
 */
export function particleLight(lighting: PlanetLighting, cloudCover = 0): ParticleLight {
  const a = lighting.atmosphere;
  const eye = lighting.eye.value;
  const r = Math.max(a.params.groundRadius + 1, eye.length());
  const sunE = lighting.sunIlluminance.value;
  const muS = Math.sin(lighting.sunElevation);
  const sky = skyIrradiance(lighting, muS);
  const transmittance = (mu: number) => {
    const shadow = planetShadow(a.params, r, mu);
    if (shadow <= 0) return [0, 0, 0];
    const t = sampleTransmittanceLut(a.params, a.tables.transmittance, r, mu);
    return [t[0] * shadow, t[1] * shadow, t[2] * shadow];
  };
  const ts = transmittance(muS);
  const cover = Math.min(1, Math.max(0, cloudCover));
  const open = 1 - 0.94 * cover;
  const moonE = lighting.moonIlluminance.value;
  const moonDir = lighting.moonDirection.value;
  const muM = r > 0 ? moonDir.dot(eye) / eye.length() : 1;
  const tm = moonE > 0 ? transmittance(muM) : [0, 0, 0];
  const moonSky = moonE > 0 ? skyIrradiance(lighting, muM) : [0, 0, 0];
  const night = lighting.nightLight.value;
  const starlight = [0.55, 0.65, 1];
  // The flash, as surfaces get it (PlanetLighting.flashAt).
  const flash = lighting.flashLight.value;
  const reach = lighting.flashReach.value ** 2;
  const fall = reach / (reach + lighting.flashPosition.value.distanceToSquared(eye));
  // A drop or a flake shows the sky around it: as bright as the sky drawn, which is the
  // irradiance over π in display units (atmosphere.ts `inScatter`), not as a surface under it.
  const skyGain = a.inScatter.value;
  const ambient: [number, number, number] = [0, 0, 0];
  const sun: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    ambient[c] =
      sky[c]! * sunE * skyGain +
      starlight[c]! * night +
      MOON_TINT[c]! * moonE * (0.5 * tm[c]! + moonSky[c]! * skyGain);
    sun[c] = sunE * ts[c]! * open;
    // What a cloud deck lets through of the sun comes down as diffuse light from all of it.
    ambient[c] += sunE * ts[c]! * Math.max(0, muS) * CLOUD_TRANSMISSION * cover;
  }
  // Under cloud the light from above is the cloud's gray, not the sky's blue.
  const gray = LUMA[0] * ambient[0] + LUMA[1] * ambient[1] + LUMA[2] * ambient[2];
  const overcast = 0.9 * cover;
  for (let c = 0; c < 3; c++) {
    ambient[c] =
      ambient[c]! +
      (gray - ambient[c]!) * overcast +
      FLASH_ON_PARTICLES * flash.getComponent(c) * fall;
  }
  return { ambient, sun };
}

/**
 * Share of a lightning flash's light on surfaces that particles show. In full they would
 * turn a downpour into a white wall for the length of the flash.
 */
const FLASH_ON_PARTICLES = 0.25;
/** Share of the sunlight on an overcast's top that leaves its base as diffuse light. */
const CLOUD_TRANSMISSION = 0.25;

/** What `Precipitation.update` reads each frame. */
export interface PrecipitationFrame {
  /** The camera, planet-centered (m), and its unit view direction. */
  eye: Readonly<Vec3d>;
  forward: Readonly<Vec3d>;
  /** Real seconds since the last frame. */
  dt: Seconds;
  /** Vertical field of view (rad), aspect ratio and the viewport's height (pixels). */
  fovY: number;
  aspect: number;
  viewportHeight: number;
  /** Height of the camera above the ground (m). */
  aboveGround: Meters;
  /** The camera's near plane (m); particles nearer than it are still drawn. Default 0. */
  near?: Meters;
}

/** One kind's mesh and the uniforms its shader reads. */
interface Field {
  kind: ParticleKind;
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  /** Offset of the lattice from the eye (m, wrapped at WRAP_PERIOD), in float64. */
  drift: Vec3d;
  /** Distance fallen by a particle of speed factor 1 (m, wrapped at FALL_PERIOD). */
  fall: Vec3d;
  uDrift: UniformNode<'vec3', Vector3>;
  uFall: UniformNode<'vec3', Vector3>;
  /** Velocity relative to the camera of a particle with speed factor 0, and what a factor of 1 adds (m/s). */
  uShared: UniformNode<'vec3', Vector3>;
  uVaried: UniformNode<'vec3', Vector3>;
  /** Exposure (s), least and greatest diameter (m). */
  uLook: UniformNode<'vec3', Vector3>;
  uOpacity: UniformNode<'float', number>;
  uSway: UniformNode<'float', number>;
  uAmbient: UniformNode<'vec3', Vector3>;
  uSun: UniformNode<'vec3', Vector3>;
}

export class Precipitation {
  /** The particle meshes; add it to the pipeline's overlay scene. */
  readonly group = new Group();
  /** Off: nothing is drawn. */
  enabled = true;
  /** Quality: scales the instance counts (0.5 low, 1 default, up to MAX_DENSITY). */
  density = 1;
  /** Intensity 0..1 of each kind where the camera is, after the fade with height (as of the last update). */
  readonly levels: Record<ParticleKind, number> = { rain: 0, snow: 0, dust: 0 };
  /** Instances drawn per kind in the last frame. */
  readonly counts: Record<ParticleKind, number> = { rain: 0, snow: 0, dust: 0 };
  /** The camera's velocity as estimated from its motion (m/s, world frame). */
  readonly cameraVelocity = new Vec3d();
  /** A camera velocity to use in place of the estimate (previews, tests); null to estimate. */
  velocityOverride: Vec3d | null = null;

  private readonly fields: Field[];
  private readonly lastEye = new Vec3d();
  private hasLast = false;
  /** Phase of the sway (rad, wrapped at 2π). */
  private readonly swayPhase = uniform(0);
  private readonly forward = uniform(new Vector3(0, 0, -1));
  /** Two horizontal unit vectors and up, at the camera. */
  private readonly east = uniform(new Vector3(1, 0, 0));
  private readonly north = uniform(new Vector3(0, 0, 1));
  private readonly sunDirection: PlanetLighting['sunDirection'];
  private readonly reach = uniform(0.76);
  private readonly pixelAngle = uniform(0.001);
  /** A little more than the camera's near plane (m). */
  private readonly near = uniform(0);
  /** Extinction of fog and dust between the camera and a particle (1/m). */
  private readonly murk = uniform(0);
  private readonly moved = new Vec3d();
  private readonly shared = new Vec3d();
  private readonly varied = new Vec3d();
  private readonly wind = new Vec3d();
  private readonly up = new Vec3d();

  constructor(
    private readonly weather: WeatherState,
    private readonly lighting: PlanetLighting,
    private readonly sceneDistance: F,
  ) {
    this.sunDirection = lighting.sunDirection;
    this.fields = PARTICLE_KINDS.map((kind) => this.createField(kind));
    this.group.visible = false;
  }

  private createField(kind: ParticleKind): Field {
    const geometry = new InstancedBufferGeometry();
    // x across the particle, y along its streak, both −1..1.
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    geometry.instanceCount = 0;
    const field: Field = {
      kind,
      geometry,
      mesh: null as unknown as Mesh,
      drift: new Vec3d(),
      fall: new Vec3d(),
      uDrift: uniform(new Vector3()),
      uFall: uniform(new Vector3()),
      uShared: uniform(new Vector3()),
      uVaried: uniform(new Vector3()),
      uLook: uniform(new Vector3(0.02, 0.01, 0.02)),
      uOpacity: uniform(0),
      uSway: uniform(0),
      uAmbient: uniform(new Vector3()),
      uSun: uniform(new Vector3()),
    };
    field.mesh = new Mesh(geometry, this.material(field));
    field.mesh.name = kind;
    field.mesh.frustumCulled = false;
    field.mesh.visible = false;
    this.group.add(field.mesh);
    return field;
  }

  private material(field: Field): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    m.name = `precipitation ${field.kind}`;
    const tint = PARTICLE_TINT[field.kind];
    const vColor = varyingProperty('vec3', 'vParticleColor');
    const vOpacity = varyingProperty('float', 'vParticleOpacity');
    const vDistance = varyingProperty('float', 'vParticleDistance');

    m.positionNode = Fn(() => {
      const index = instanceIndex.mul(uint(8));
      const rand = (k: number): F => hash(index.add(uint(k))) as F;
      // A quarter of the particles in each of the two near layers, half in the far one.
      const pick = instanceIndex.bitAnd(uint(3));
      const side = select(
        pick.equal(uint(0)),
        float(LAYER_SIDES[0]),
        select(pick.equal(uint(1)), float(LAYER_SIDES[1]), float(LAYER_SIDES[2])),
      ).toVar();
      const h = vec3(rand(0), rand(1), rand(2));
      const speed = rand(3).mul(SPEED_RANGE).floor().add(SPEED_MIN).div(SPEED_STEPS).toVar();
      // The copy of the particle in the cube ahead (`wrapParticle`).
      const center = this.forward.mul(side.mul(0.5));
      const q = h.mul(side).add(field.uDrift).add(field.uFall.mul(speed));
      const p = center.add(fract(q.sub(center).div(side).add(0.5)).sub(0.5).mul(side)).toVar();
      if (field.kind !== 'rain') {
        // Sway: two slow sideways swings and a small rise and fall, each particle on its own phase.
        const phase = vec3(rand(4), rand(5), rand(6)).mul(2 * Math.PI);
        const turns = vec3(1, 2, 3);
        const swing = sin(turns.mul(this.swayPhase).add(phase)).mul(field.uSway);
        const up = cross(this.north, this.east);
        p.addAssign(
          this.east
            .mul(swing.x)
            .add(this.north.mul(swing.y))
            .add(up.mul(swing.z.mul(0.4))),
        );
      }
      const distance = length(p).toVar();
      const view = p.div(max(distance, 1e-3)).toVar();

      const exposure = field.uLook.x;
      const size = field.uLook.y.add(field.uLook.z.sub(field.uLook.y).mul(pow(rand(7), 2))).toVar();
      // Half of the path over the exposure, held to a streak of sensible length.
      const velocity = field.uShared.add(field.uVaried.mul(speed));
      const path = velocity.mul(exposure.mul(0.5)).toVar();
      const pathLength = length(path).toVar();
      const half = path.mul(min(1, float(MAX_HALF_STREAK).div(max(pathLength, 1e-5)))).toVar();
      // Across the view: the streak's direction on screen (any direction for a particle seen end on).
      const across = half.sub(view.mul(dot(half, view))).toVar();
      const fallback = cross(view, cross(this.north, this.east).add(vec3(0.013, 0.021, 0.034)));
      const d1 = normalize(across.add(fallback.mul(1e-4))).toVar();
      const d2 = cross(view, d1);
      // Never thinner than a pixel or so: fainter instead.
      const least = this.pixelAngle.mul(distance).mul(MIN_PIXELS * 0.5);
      const radius = max(size.mul(0.5), least).toVar();
      const thin = pow(size.mul(0.5).div(radius), THIN_FADE);
      // A streak longer than the particle's own smear at rest spreads the same light further.
      const rest = length(field.uVaried.mul(speed).mul(exposure.mul(0.5))).add(radius);
      const stretch = pow(rest.div(max(length(across).add(radius), rest)), 0.5);

      const far = side.mul(this.reach);
      const fade = smoothstep(far, far.mul(0.72), distance)
        .mul(smoothstep(NEAR_FADE[0], NEAR_FADE[1], distance))
        .mul(exp(distance.mul(this.murk).negate()));
      // The far layers stand back: distinct streaks near the eye, a fine veil behind them.
      const layer = select(
        pick.equal(uint(0)),
        float(1),
        select(pick.equal(uint(1)), float(0.8), float(0.55)),
      );
      const opacity = field.uOpacity.mul(thin).mul(stretch).mul(fade).mul(layer).toVar();
      vOpacity.assign(opacity);
      // Sunlit particles are brightest toward the sun.
      const toSun = max(dot(view, this.sunDirection), 0);
      const forwardScatter = pow(toSun, 6).mul(1.6).add(0.25);
      vColor.assign(vec3(...tint).mul(field.uAmbient.add(field.uSun.mul(forwardScatter))));

      const corner = p
        .add(half.add(d1.mul(radius)).mul(positionGeometry.y))
        .add(d2.mul(radius).mul(positionGeometry.x));
      vDistance.assign(length(corner));
      // The overlay has no depth buffer, so a vertex's depth only decides whether the near
      // plane clips it. A vertex in front of that plane is moved out along its view ray to
      // just behind it, which leaves it where it is on screen: a camera with a far near
      // plane (the free camera high up) still sees the rain next to it.
      const depth = dot(corner, this.forward);
      const out = corner.mul(max(1, this.near.div(max(depth, 1e-3))));
      // An invisible particle is not rasterized: its quad collapses behind the camera.
      return select(
        opacity.greaterThan(0.004).and(depth.greaterThan(0.05)),
        out,
        this.forward.mul(-10),
      );
    })();

    m.colorNode = Fn(() => {
      const u = positionGeometry.xy;
      const shape = clamp(float(1).sub(dot(u, u)), 0, 1);
      // Behind something nearer in the scene: hidden, over a soft margin.
      const clear = smoothstep(float(0), float(0.35), this.sceneDistance.sub(vDistance));
      return vec4(vColor, vOpacity.mul(shape).mul(clear));
    })();
    return m;
  }

  /** Moves the air and the camera by one frame and sets what is drawn. */
  update(frame: PrecipitationFrame): void {
    const { eye } = frame;
    const dt = frame.dt > 0 ? frame.dt : 0;
    const state = this.weather;
    const local = state.local;

    // The camera's motion since the last frame; a jump moves nothing.
    const moved = this.moved.set(0, 0, 0);
    if (this.hasLast && dt > 0) {
      moved.subVectors(eye, this.lastEye);
      if (moved.length() > JUMP_SPEED * dt) {
        moved.set(0, 0, 0);
      } else {
        const a = 1 - Math.exp(-dt / VELOCITY_SMOOTHING);
        this.cameraVelocity.scale(1 - a).addScaled(moved, a / dt);
      }
    }
    this.lastEye.copy(eye);
    this.hasLast = true;
    const velocity = this.velocityOverride ?? this.cameraVelocity;

    const up = this.up.copy(eye).normalize();
    const east = new Vec3d(0, 1, 0).cross(up);
    if (east.length() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = up.clone().cross(east);
    this.east.value.set(east.x, east.y, east.z);
    this.north.value.set(north.x, north.y, north.z);
    this.forward.value.set(frame.forward.x, frame.forward.y, frame.forward.z);
    this.reach.value = layerReach(frame.fovY, frame.aspect);
    this.pixelAngle.value = frame.fovY / Math.max(1, frame.viewportHeight);
    this.near.value = 1.02 * (frame.near ?? 0);
    this.swayPhase.value = (this.swayPhase.value + dt * 0.9) % (2 * Math.PI);
    this.murk.value = state.fog.value + dustExtinction(state.dust.value);

    const w = state.wind.value;
    const wind = this.wind.set(w.x, w.y, w.z);
    const windSpeed = wind.length();
    const falling = local ? belowCloud(frame.aboveGround, local.cloudBase) : 0;
    this.levels.rain = state.rain.value * falling;
    this.levels.snow = state.snow.value * falling;
    this.levels.dust = state.dust.value * dustAtHeight(frame.aboveGround);
    const light = particleLight(this.lighting, local?.cloudCover ?? 0);

    for (const field of this.fields) {
      const level = this.enabled ? this.levels[field.kind] : 0;
      const count = particleCount(field.kind, level, this.density);
      this.counts[field.kind] = count;
      field.mesh.visible = count > 0;
      // The air moves on while a kind is not drawn, so it does not resume where it stopped.
      const look = particleLook(field.kind, level, windSpeed);
      const carried = look.carried;
      // What every particle shares: the wind (or the part of it that carries dust).
      const shared = this.shared.copy(wind).scale(carried);
      field.drift.addScaled(shared, dt).sub(moved);
      for (const axis of ['x', 'y', 'z'] as const) {
        field.drift[axis] = wrap(field.drift[axis], WRAP_PERIOD);
      }
      // What each takes times its own speed factor: the fall, and for dust the rest of the wind.
      const varied = this.varied
        .copy(up)
        .scale(-look.fallSpeed)
        .addScaled(wind, 1 - carried);
      field.fall.addScaled(varied, dt);
      for (const axis of ['x', 'y', 'z'] as const) {
        field.fall[axis] = wrap(field.fall[axis], FALL_PERIOD);
      }
      if (count === 0) continue;
      field.geometry.instanceCount = count;
      field.uDrift.value.set(field.drift.x, field.drift.y, field.drift.z);
      field.uFall.value.set(field.fall.x, field.fall.y, field.fall.z);
      field.uShared.value.set(shared.x - velocity.x, shared.y - velocity.y, shared.z - velocity.z);
      field.uVaried.value.set(varied.x, varied.y, varied.z);
      field.uLook.value.set(look.exposure, look.sizeMin, look.sizeMax);
      // A kind fades in from nothing, so that it does not start with a pop.
      field.uOpacity.value = look.opacity * Math.min(1, level / 0.06);
      field.uSway.value = look.sway;
      field.uAmbient.value.set(...light.ambient);
      field.uSun.value.set(...light.sun);
    }
    // The pipeline draws its overlay pass only while something in it is visible.
    this.group.visible = this.fields.some((f) => f.mesh.visible);
  }

  /** Forgets the camera's last place, so a new view starts without a streak from the old one. */
  reset(): void {
    this.hasLast = false;
    this.cameraVelocity.set(0, 0, 0);
  }

  dispose(): void {
    for (const f of this.fields) {
      f.geometry.dispose();
      (f.mesh.material as MeshBasicNodeMaterial).dispose();
    }
  }
}
