/**
 * Rain, snow and blowing dust near the camera: instanced quads in the
 * pipeline's overlay scene (post/simPipeline.ts), one mesh per kind, with no
 * work per particle on the CPU and no buffer per particle on the GPU.
 *
 * **Where the particles are.** The particles of a kind are the points of an
 * endless lattice that is fixed in the world, not to the camera: a particle's
 * place in the lattice's period comes from a hash of its instance index, so
 * it needs no attribute, and the CPU keeps the lattice's offset from the eye
 * (`drift`: the wind's and the camera's motion, taken in float64 before
 * anything is wrapped) and how far the particles have fallen (`fall`, which
 * each particle takes times its own speed factor). Which copy of a particle
 * is drawn is the camera's choice: every instance has an anchor in the view,
 * a point fixed to the camera somewhere in the pyramid the screen spans
 * (`particleAnchor`), and the vertex shader draws the copy nearest to it
 * (`wrapParticle`, in a cube of the lattice's period around the anchor) and
 * fades it toward that cube's faces (`anchorWindow`), where the next copy
 * takes over. So a particle stays where it is in the world while it shows,
 * passes by as the camera moves, near ones faster than far ones, and turning
 * the camera only brings other particles into view; and nearly every
 * instance is on screen, where a single cube of air around the camera would
 * have six in seven outside the view. Three layers (`LAYER_RANGES`: anchors
 * out to 12, 24 and 48 m, with periods of 4, 8 and 16 m) put distinct
 * particles near the eye and a fine veil behind them. Speed factors are
 * multiples of 1/8, so `fall` can wrap at eight periods without a jump.
 *
 * **What a particle looks like.** A quad along the particle's velocity
 * relative to the camera over an exposure time (a slow shutter, about 1/30 s
 * for rain), padded to the particle's own size at both ends: a drop of
 * drizzle is a dash of a few centimeters, a skyfall's a streak of 30 cm, the
 * same drop seen from an aircraft at 250 m/s a longer one along the line of
 * flight, and a flake in still air a soft disc. A streak is held short in
 * three ways: in meters (`MAX_HALF_STREAK`), on screen
 * (`MAX_HALF_STREAK_ANGLE`: a drop that passes the lens is a dash like the
 * others, not a line across the view) and in the particle's own radii (a
 * flake in a gale stays a flake). Rain leans with the wind because the wind
 * is part of the velocity; it takes half of it (`ParticleLook.carried`), so
 * that it still falls more than it flies in a gale. A particle is never
 * drawn thinner than about a pixel; one that would be is drawn fainter
 * instead. Its opacity falls off elliptically from the middle of the quad (no
 * texture), fades close to the lens (and a layer thins out by itself past
 * its range, where its anchors end), falls with the murk of fog and dust
 * between, swells and thins in bands
 * that drift with the wind (gusts), and it hides behind whatever the scene's
 * depth holds nearer: the aircraft in the chase view, buildings, the ground.
 *
 * **How much.** `particleCount` gives the instances per kind from the
 * intensity 0..1 (weatherState.ts) and the `density` quality factor, up to
 * `PARTICLE_CAPS`; a kind at zero is not drawn and costs nothing. Rain grows
 * from sparse, short, slow, fine drops (drizzle) to dense, long, fast, heavy
 * streaks (skyfall); snow falls at 1 to 2 m/s in flakes of varied size that
 * sway, and a gale drives it flat, finer and longer; dust is ochre grains
 * carried at the wind's speed, thickest in the lowest meters. Rain and snow
 * fall from cloud: both fade out as the camera climbs through the cloud base
 * (`belowCloud`), and dust thins with height.
 *
 * **Warming up.** A material is compiled when it is first drawn, and so is the
 * pipeline's variant with the overlay in it, which stalls a frame or several.
 * So every kind is drawn once with a single empty particle in the first frame
 * and again whenever cloud closes in over the camera (`warm`), when the
 * pipeline's shaders for the weather to come exist: the first drop of a
 * shower then costs nothing. Such a frame shows nothing.
 *
 * **Light.** One color per kind and frame, computed on the CPU from the
 * lighting's numbers at the camera (`particleLight`): the sky's irradiance,
 * gray and dimmed under cloud as surfaces have it, sunlight past the
 * atmosphere and the cloud cover, moonlight and starlight by night, and the
 * lightning flash. Sunlit particles brighten toward the sun, and each
 * particle is a little darker or brighter than the rest (`PARTICLE_SHADES`),
 * so that some stand out against any background. No texture is read per
 * particle; the only read per fragment is the scene's depth.
 */
import {
  BufferAttribute,
  DataUtils,
  DoubleSide,
  Group,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  abs,
  clamp,
  cross,
  dot,
  exp,
  float,
  Fn,
  fract,
  hash,
  If,
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
import { OVERCAST_GAIN, OVERCAST_TINT } from '../lighting/planetLighting';
import type { PlanetLighting } from '../lighting/planetLighting';
import { dustExtinction } from './weatherState';
import type { WeatherState } from './weatherState';

type F = Node<'float'>;

export type ParticleKind = 'rain' | 'snow' | 'dust';
export const PARTICLE_KINDS: readonly ParticleKind[] = ['rain', 'snow', 'dust'];

/** The lattice's period in each of the three layers (m). Each is a divisor of the next. */
export const LAYER_SIDES: readonly [Meters, Meters, Meters] = [4, 8, 16];
/** A layer's anchors lie out to this many periods ahead of the camera. */
export const LAYER_DEPTH = 3;
/** How far ahead each layer's anchors lie (m). */
export const LAYER_RANGES: readonly [Meters, Meters, Meters] = [
  LAYER_SIDES[0] * LAYER_DEPTH,
  LAYER_SIDES[1] * LAYER_DEPTH,
  LAYER_SIDES[2] * LAYER_DEPTH,
];
/** Opacity of each layer's particles: the far ones stand back. */
const LAYER_OPACITY: readonly [number, number, number] = [1, 0.8, 0.55];
/** The anchors spread this share of a period past the view's edges, so the fall does not thin there. */
export const ANCHOR_MARGIN = 0.25;
/** A particle is at full strength within this share of the way from its anchor to its cube's faces. */
export const WINDOW_FLAT = 0.8;
/** The offsets wrap here (m): a multiple of every layer's period, and the period of the gusts. */
export const WRAP_PERIOD: Meters = 64;
/** A particle's speed factor is a multiple of 1 / SPEED_STEPS. */
export const SPEED_STEPS = 8;
/** The speed factors: SPEED_MIN / SPEED_STEPS … (SPEED_MIN + SPEED_RANGE − 1) / SPEED_STEPS. */
const SPEED_MIN = 6;
const SPEED_RANGE = 5;
/** The fall offset wraps here (m): a period for every speed factor. */
export const FALL_PERIOD: Meters = WRAP_PERIOD * SPEED_STEPS;
/** Instances per kind at full intensity and `density` 1. */
export const PARTICLE_CAPS: Readonly<Record<ParticleKind, number>> = {
  rain: 16_000,
  snow: 12_000,
  dust: 9_000,
};
/** The highest `density` (quality factor) the caps are scaled by. */
export const MAX_DENSITY = 2;
/** A camera that moves faster than this between two frames has jumped (m/s). */
const JUMP_SPEED = 1500;
/** Cloud cover over the camera from which the particles' shaders are warmed up again. */
const WARM_COVER = 0.3;
/** In a frame that takes no time (a pause), a camera that has moved farther than this has jumped (m). */
const JUMP_DISTANCE: Meters = 50;
/** Time constant of the camera velocity's smoothing (s). */
const VELOCITY_SMOOTHING: Seconds = 0.08;
/** The longest a streak's half-length gets (m), however fast the camera flies. */
export const MAX_HALF_STREAK: Meters = 1;
/**
 * The longest a streak's half-length gets on screen (rad): a drop that passes
 * close to the lens is a short dash like the others, not a line across the view.
 */
export const MAX_HALF_STREAK_ANGLE = 0.06;
/** Period of the gusts' pattern in the air (m): a divisor of the lattice's. */
const GUST_PERIOD: Meters = WRAP_PERIOD;
/** Height above the ground over which blowing dust thins to `DUST_ALOFT` of its density (m). */
const DUST_LAYER: Meters = 10;
const DUST_ALOFT = 0.3;
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
  return Math.max(Math.min(cap, 200), Math.round(cap * share));
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
 * lies in the cube of `side` centered at `center` (the particle's anchor). The vertex shader does the
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
 * The anchor of a particle in the camera's frame (m: right, up, ahead) from
 * three uniform draws: uniformly spread through the pyramid the view spans
 * out to the layer's range, widened by `ANCHOR_MARGIN` of a period. `tanX`
 * and `tanY` are the tangents of half the horizontal and vertical fields of
 * view. The vertex shader does the same.
 */
export function particleAnchor(
  u: readonly [number, number, number],
  layer: number,
  tanX: number,
  tanY: number,
): [Meters, Meters, Meters] {
  const side = LAYER_SIDES[layer]!;
  const ahead = side * LAYER_DEPTH * Math.cbrt(u[0]);
  return [
    (2 * u[1] - 1) * (ahead * tanX + side * ANCHOR_MARGIN),
    (2 * u[2] - 1) * (ahead * tanY + side * ANCHOR_MARGIN),
    ahead,
  ];
}

/**
 * How strongly a particle shows at an offset from its anchor (m, per axis) in
 * a cube of `side`: 1 around the anchor, 0 on the cube's faces, where the
 * particle's next copy comes in on the far side.
 */
export function anchorWindow(offset: readonly [number, number, number], side: Meters): number {
  let w = 1;
  for (const d of offset) {
    const t = Math.min(
      1,
      Math.max(0, (Math.abs(d) / (side / 2) - WINDOW_FLAT) / (1 - WINDOW_FLAT)),
    );
    w *= 1 - t * t * (3 - 2 * t);
  }
  return w;
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
  /**
   * Share of the wind every particle moves with. Rain takes about half: the weather's wind is
   * the open air's, heavy drops near the ground lag behind it, and rain that leans further
   * than it falls reads as scratches, not as rain. Snow takes all of it. Dust takes most, and
   * the rest times its speed factor, so that grains overtake each other.
   */
  carried: number;
  /** Share of the wind a particle takes times its speed factor, on top of `carried`. */
  strewn: number;
  /** The longest a streak's half-length gets, in particle radii (a flake stays a flake in a gale). */
  stretch: number;
  /** How much gusts thin and thicken the particles, 0..1. */
  gust: number;
}

/** The look of a kind at an intensity 0..1 in a wind (m/s). */
export function particleLook(kind: ParticleKind, level: number, windSpeed = 0): ParticleLook {
  const x = Math.min(1, Math.max(0, level));
  const s = (a: number, b: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  // Gusts show from a fresh breeze up.
  const gusty = Math.min(1, Math.max(0, (windSpeed - 4) / 14));
  if (kind === 'rain') {
    // Drizzle drifts down at 2 m/s in fine drops; a skyfall's drops are heavy and fast. The
    // exposure is that of a slow shutter (1/30 s): a drop of drizzle is a dash of a few
    // centimeters, one of a skyfall a streak of 30 cm.
    return {
      fallSpeed: 2.2 + 7.3 * s(0.1, 0.9),
      exposure: 0.03 + 0.004 * x,
      sizeMin: 0.002 + 0.003 * x,
      sizeMax: 0.004 + 0.008 * x,
      opacity: 0.45 + 0.3 * x,
      sway: 0,
      carried: 0.5,
      strewn: 0,
      stretch: 1e4,
      gust: 0.55 * gusty * s(0.3, 0.8),
    };
  }
  if (kind === 'snow') {
    return {
      fallSpeed: 1.5,
      exposure: 1 / 60,
      sizeMin: 0.016,
      // A gale breaks the flakes up and drives them along: finer and longer.
      sizeMax: (0.045 + 0.03 * x) * (1 - 0.25 * gusty),
      opacity: 0.8 + 0.2 * x,
      // Gusts toss the flakes about.
      sway: 0.25 + 0.03 * Math.min(30, windSpeed),
      carried: 1,
      strewn: 0,
      stretch: 3 + 3 * gusty,
      gust: 0.6 * gusty,
    };
  }
  return {
    fallSpeed: 0,
    exposure: 1 / 50,
    sizeMin: 0.008,
    sizeMax: 0.03,
    opacity: 0.4 + 0.35 * x,
    sway: 0.3,
    carried: 0.72,
    strewn: 0.28,
    stretch: 14,
    gust: 0.75,
  };
}

/**
 * Color of a kind's particles (linear), as a multiple of the light on them. Drops gather the
 * brightest of the sky around them and flakes are white, so both stand out a little brighter
 * than the average sky; dust is ochre.
 */
export const PARTICLE_TINT: Readonly<Record<ParticleKind, readonly [number, number, number]>> = {
  rain: [1.3, 1.36, 1.45],
  snow: [1.4, 1.42, 1.46],
  dust: [0.78, 0.56, 0.3],
};

/**
 * The spread of the particles' brightness about their tint: least, range and the power of
 * the uniform draw (above 1: most are dim, a few glint).
 */
export const PARTICLE_SHADES: Readonly<Record<ParticleKind, readonly [number, number, number]>> = {
  rain: [0.8, 0.9, 1.4],
  snow: [0.55, 0.85, 1],
  dust: [0.45, 1, 1],
};

/**
 * How much a particle fades as its streak grows past its smear at rest (the power of the
 * ratio of the two lengths): a drop is a glint spread along its path, a flake stays white.
 */
const STREAK_FADE: Readonly<Record<ParticleKind, number>> = { rain: 1, snow: 0.15, dust: 0.5 };

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
 * `cloudCover` (0..1) stands for the cloud's shadow on the sun, and with
 * `depth` (0..1: how deep the cloud is, from the fall's and the storm's
 * intensity) for how gray and dim the sky's light is under it, as
 * `overcastSky` has it for surfaces: brighter than a clear sky's shade under
 * a thin deck, dark under a storm.
 */
export function particleLight(lighting: PlanetLighting, cloudCover = 0, depth = 0): ParticleLight {
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
  // Under cloud the light from above is the cloud base's: gray, and dimmer the deeper the cloud
  // (planetLighting.ts `overcastSky`, with the cover and the depth standing for its measure).
  const overcast = cover * (0.4 + 0.6 * Math.min(1, Math.max(0, depth)));
  const blend = Math.min(1, overcast / 0.3);
  // Under deep cloud the particles dim nearly as the ground and the fog around them do
  // (`PARTICLE_DIMMING`): a little less, since a drop shows the brightest of what is around
  // it, the horizon's glow under a storm's base included. Their tint and the spread of their
  // shades put them above the murk; much brighter, a downpour is white scratches on gray.
  const deep = OVERCAST_GAIN[0] + (OVERCAST_GAIN[1] - OVERCAST_GAIN[0]) * PARTICLE_DIMMING;
  const gain =
    OVERCAST_GAIN[0] + (deep - OVERCAST_GAIN[0]) * Math.min(1, Math.max(0, (overcast - 0.4) / 0.6));
  const day = sky.map((v) => v * sunE * skyGain);
  const gray = LUMA[0] * day[0]! + LUMA[1] * day[1]! + LUMA[2] * day[2]!;
  const ambient: [number, number, number] = [0, 0, 0];
  const sun: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    ambient[c] =
      day[c]! +
      (OVERCAST_TINT[c]! * gray * gain - day[c]!) * blend +
      starlight[c]! * night * NIGHT_GLINT +
      MOON_TINT[c]! * moonE * (0.5 * tm[c]! + moonSky[c]! * skyGain) * (1 - 0.8 * cover) +
      FLASH_ON_PARTICLES * flash.getComponent(c) * fall;
    sun[c] = sunE * ts[c]! * open;
  }
  return { ambient, sun };
}

/**
 * The night's light on particles over the night's light on the ground: a drop gathers the
 * lamps and the horizon's glow, so the fall is faintly seen in the dark.
 */
const NIGHT_GLINT = 2.5;
/**
 * Share of the dimming of the sky's light under a storm (`OVERCAST_GAIN`) that particles
 * take. The fog and the rain veils of clouds/volumetrics.ts take all of it; at 0.85 a
 * skyfall's streaks come out about twice as bright as the murk they fall through.
 */
const PARTICLE_DIMMING = 0.85;
/**
 * Share of a lightning flash's light on surfaces that particles show. In full they would
 * turn a downpour into a white wall for the length of the flash; with much less, the fall
 * stands dark against the fog the same flash lights up (clouds/volumetrics.ts), as scratches
 * on a bright frame.
 */
const FLASH_ON_PARTICLES = 0.6;

/** What `Precipitation.update` reads each frame. */
export interface PrecipitationFrame {
  /** The camera, planet-centered (m), and its unit view direction. */
  eye: Readonly<Vec3d>;
  forward: Readonly<Vec3d>;
  /** The camera's up (need not be exact: only its part across the view counts). Default: away from the planet. */
  up?: Readonly<Vec3d>;
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
  /** Sway (m), the streak's limit in radii, the gusts' strength. */
  uMotion: UniformNode<'vec3', Vector3>;
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
  /** The next frame draws every kind once, empty (`warm`). */
  private warming = true;
  private lastCover = 0;
  /** Phase of the sway (rad, wrapped at 2π). */
  private readonly swayPhase = uniform(0);
  private readonly forward = uniform(new Vector3(0, 0, -1));
  /** Two horizontal unit vectors and up, at the camera. */
  private readonly east = uniform(new Vector3(1, 0, 0));
  private readonly north = uniform(new Vector3(0, 0, 1));
  /** Away from the planet, at the camera (east × north). */
  private readonly zenith = uniform(new Vector3(0, 1, 0));
  private readonly sunDirection: PlanetLighting['sunDirection'];
  /** The camera's right and up, and the tangents of half its horizontal and vertical fields of view. */
  private readonly right = uniform(new Vector3(1, 0, 0));
  private readonly upward = uniform(new Vector3(0, 1, 0));
  private readonly tangents = uniform(new Vector2(0.74, 0.41));
  private readonly pixelAngle = uniform(0.001);
  /** A little more than the camera's near plane (m). */
  private readonly near = uniform(0);
  /** Extinction of fog and dust between the camera and a particle (1/m). */
  private readonly murk = uniform(0);
  /** Height of the camera above the ground (m). */
  private readonly aboveGround = uniform(0);
  private readonly moved = new Vec3d();
  private readonly shared = new Vec3d();
  private readonly varied = new Vec3d();
  private readonly wind = new Vec3d();
  private readonly up = new Vec3d();
  private readonly eastward = new Vec3d();
  private readonly northward = new Vec3d();
  private readonly ahead = new Vec3d();
  private readonly across = new Vec3d();
  private readonly above = new Vec3d();

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
      uMotion: uniform(new Vector3(0, 1e4, 0)),
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
      const index = instanceIndex.mul(uint(16));
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
      // The anchor, fixed to the camera (`particleAnchor`).
      const ahead = side
        .mul(LAYER_DEPTH)
        .mul(pow(rand(4), 1 / 3))
        .toVar();
      const spread = this.tangents.mul(ahead).add(side.mul(ANCHOR_MARGIN));
      const anchor = this.forward
        .mul(ahead)
        .add(this.right.mul(rand(5).mul(2).sub(1).mul(spread.x)))
        .add(this.upward.mul(rand(6).mul(2).sub(1).mul(spread.y)))
        .toVar();
      // The copy of the particle nearest to it (`wrapParticle`), fading toward the faces of
      // the cube around the anchor (`anchorWindow`).
      const q = h.mul(side).add(field.uDrift).add(field.uFall.mul(speed));
      const offset = fract(q.sub(anchor).div(side).add(0.5)).sub(0.5).toVar();
      const edge = smoothstep(WINDOW_FLAT * 0.5, 0.5, abs(offset)).oneMinus();
      const window = edge.x.mul(edge.y).mul(edge.z).toVar();
      const p = anchor.add(offset.mul(side)).toVar();
      // An invisible particle is not rasterized: its quad collapses behind the camera, and
      // the rest of its work is skipped.
      const result = this.forward.mul(-10).toVar();
      vOpacity.assign(0);
      vColor.assign(vec3(0));
      vDistance.assign(0);
      If(window.greaterThan(0.004), () => {
        if (field.kind !== 'rain') {
          // Sway: two slow sideways swings and a small rise and fall, each particle on its own phase.
          const phase = vec3(rand(9), rand(10), rand(11)).mul(2 * Math.PI);
          const turns = vec3(1, 2, 3);
          const swing = sin(turns.mul(this.swayPhase).add(phase)).mul(field.uMotion.x);
          p.addAssign(
            this.east
              .mul(swing.x)
              .add(this.north.mul(swing.y))
              .add(this.zenith.mul(swing.z.mul(0.4))),
          );
        }
        const distance = length(p).toVar();
        const view = p.div(max(distance, 1e-3)).toVar();

        const exposure = field.uLook.x;
        const size = field.uLook.y
          .add(field.uLook.z.sub(field.uLook.y).mul(pow(rand(7), 2)))
          .toVar();
        // Never thinner than a pixel or so: fainter instead.
        const least = this.pixelAngle.mul(distance).mul(MIN_PIXELS * 0.5);
        const radius = max(size.mul(0.5), least).toVar();
        const thin = pow(size.mul(0.5).div(radius), THIN_FADE);
        // Half of the path over the exposure, held to a streak of sensible length: in meters,
        // in the particle's own radii, and (below) on screen.
        const velocity = field.uShared.add(field.uVaried.mul(speed));
        const path = velocity.mul(exposure.mul(0.5)).toVar();
        const pathLength = max(length(path), 1e-5).toVar();
        const reachMax = min(float(MAX_HALF_STREAK), radius.mul(field.uMotion.y));
        const long = path.mul(min(1, reachMax.div(pathLength))).toVar();
        // Across the view: the streak's direction on screen (any direction for a particle seen end on).
        const acrossLong = long.sub(view.mul(dot(long, view)));
        const held = min(
          1,
          distance.mul(MAX_HALF_STREAK_ANGLE).div(max(length(acrossLong), 1e-5)),
        ).toVar();
        const half = long.mul(held).toVar();
        const across = acrossLong.mul(held).toVar();
        const fallback = cross(view, this.zenith.add(vec3(0.013, 0.021, 0.034)));
        const d1 = normalize(across.add(fallback.mul(1e-4))).toVar();
        const d2 = cross(view, d1);
        // A streak longer than the particle's own smear at rest spreads the same light further.
        const rest = length(field.uVaried.mul(speed).mul(exposure.mul(0.5))).add(radius);
        const stretch = pow(
          rest.div(max(length(across).add(radius), rest)),
          STREAK_FADE[field.kind],
        );
        // Gusts: the air carries bands of thicker and thinner fall, a pattern fixed in the air
        // (the lattice's frame) with the lattice's period, so it wraps without a seam.
        const air = p.sub(field.uDrift).mul((2 * Math.PI) / GUST_PERIOD);
        const band = sin(dot(air, vec3(1, 2, -1)).add(this.swayPhase))
          .mul(sin(dot(air, vec3(-2, 1, 2)).sub(this.swayPhase.mul(2))))
          .mul(0.5)
          .add(0.5);
        const gust = float(1).add(band.mul(1.5).sub(0.6).mul(field.uMotion.z));

        const fade = window
          .mul(smoothstep(NEAR_FADE[0], NEAR_FADE[1], distance))
          .mul(exp(distance.mul(this.murk).negate()));
        // The far layers stand back: distinct streaks near the eye, a fine veil behind them.
        const layer = select(
          pick.equal(uint(0)),
          float(LAYER_OPACITY[0]),
          select(pick.equal(uint(1)), float(LAYER_OPACITY[1]), float(LAYER_OPACITY[2])),
        );
        let opacity = field.uOpacity.mul(thin).mul(stretch).mul(fade).mul(layer).mul(gust) as F;
        if (field.kind === 'dust') {
          // Blowing dust is thickest in the lowest meters.
          const height = this.aboveGround.add(dot(p, this.zenith));
          opacity = opacity.mul(
            exp(max(height, 0).div(-DUST_LAYER))
              .mul(1 - DUST_ALOFT)
              .add(DUST_ALOFT),
          ) as F;
        }
        opacity = opacity.toVar();
        vOpacity.assign(opacity);
        // Sunlit particles are brightest toward the sun.
        const toSun = max(dot(view, this.sunDirection), 0);
        const forwardScatter = pow(toSun, 6).mul(1.6).add(0.25);
        // Each particle a little darker or brighter than the light around it: a drop shows the
        // ground or the sky behind it, so some stand out against any background, dark or bright.
        const [shadeMin, shadeRange, shadePower] = PARTICLE_SHADES[field.kind];
        const shade = pow(rand(8), shadePower).mul(shadeRange).add(shadeMin);
        vColor.assign(
          vec3(...tint)
            .mul(shade)
            .mul(field.uAmbient.add(field.uSun.mul(forwardScatter))),
        );

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
        If(opacity.greaterThan(0.004).and(depth.greaterThan(0.05)), () => {
          result.assign(out);
        });
      });
      return result;
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

    // The camera's motion since the last frame; a jump moves nothing. While no time passes (a
    // pause) the camera may still be moved about: the particles hang where they are in the
    // world, and the velocity, which is what the streaks show, stays as it was.
    const moved = this.moved.set(0, 0, 0);
    if (this.hasLast) {
      moved.subVectors(eye, this.lastEye);
      if (moved.length() > (dt > 0 ? JUMP_SPEED * dt : JUMP_DISTANCE)) {
        moved.set(0, 0, 0);
      } else if (dt > 0) {
        const a = 1 - Math.exp(-dt / VELOCITY_SMOOTHING);
        this.cameraVelocity.scale(1 - a).addScaled(moved, a / dt);
      }
    }
    this.lastEye.copy(eye);
    this.hasLast = true;
    const velocity = this.velocityOverride ?? this.cameraVelocity;

    const up = this.up.copy(eye).normalize();
    const east = this.eastward.set(0, 1, 0).cross(up);
    if (east.length() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = this.northward.copy(up).cross(east);
    this.east.value.set(east.x, east.y, east.z);
    this.north.value.set(north.x, north.y, north.z);
    this.zenith.value.set(up.x, up.y, up.z);
    this.forward.value.set(frame.forward.x, frame.forward.y, frame.forward.z);
    // The camera's frame: right and up across the view (any roll the camera has is the frame's `up`).
    const ahead = this.ahead.copy(frame.forward).normalize();
    const right = this.across.copy(ahead).cross(frame.up ?? up);
    if (right.length() < 1e-6) right.copy(east);
    right.normalize();
    const upward = this.above.copy(right).cross(ahead);
    this.right.value.set(right.x, right.y, right.z);
    this.upward.value.set(upward.x, upward.y, upward.z);
    const tanY = Math.tan(frame.fovY / 2);
    this.tangents.value.set(tanY * frame.aspect, tanY);
    this.pixelAngle.value = frame.fovY / Math.max(1, frame.viewportHeight);
    this.near.value = 1.02 * (frame.near ?? 0);
    this.aboveGround.value = frame.aboveGround;
    this.swayPhase.value = (this.swayPhase.value + dt * 0.9) % (2 * Math.PI);
    this.murk.value = state.fog.value + dustExtinction(state.dust.value);

    const w = state.wind.value;
    const wind = this.wind.set(w.x, w.y, w.z);
    const windSpeed = wind.length();
    const falling = local ? belowCloud(frame.aboveGround, local.cloudBase) : 0;
    this.levels.rain = state.rain.value * falling;
    this.levels.snow = state.snow.value * falling;
    this.levels.dust = state.dust.value * dustAtHeight(frame.aboveGround);
    // The light is worked out for the first kind that is drawn: in dry air, not at all.
    let light: ParticleLight | null = null;
    // Cloud closing in: what falls from it is not far off.
    const cover = local?.cloudCover ?? 0;
    if (cover >= WARM_COVER && this.lastCover < WARM_COVER) this.warming = true;
    this.lastCover = cover;
    const warm = this.warming && this.enabled;
    if (warm) this.warming = false;

    for (const field of this.fields) {
      const level = this.enabled ? this.levels[field.kind] : 0;
      const count = particleCount(field.kind, level, this.density);
      this.counts[field.kind] = count;
      field.mesh.visible = count > 0;
      // The air moves on while a kind is not drawn, so it does not resume where it stopped.
      const look = particleLook(field.kind, level, windSpeed);
      const carried = look.carried;
      // What every particle shares: its kind's share of the wind.
      const shared = this.shared.copy(wind).scale(carried);
      field.drift.addScaled(shared, dt).sub(moved);
      for (const axis of ['x', 'y', 'z'] as const) {
        field.drift[axis] = wrap(field.drift[axis], WRAP_PERIOD);
      }
      // What each takes times its own speed factor: the fall, and for dust a share of the wind.
      const varied = this.varied.copy(up).scale(-look.fallSpeed).addScaled(wind, look.strewn);
      field.fall.addScaled(varied, dt);
      for (const axis of ['x', 'y', 'z'] as const) {
        field.fall[axis] = wrap(field.fall[axis], FALL_PERIOD);
      }
      if (count === 0) {
        if (warm) {
          // One particle of no opacity: nothing shows, and the shaders get compiled.
          field.mesh.visible = true;
          field.geometry.instanceCount = 1;
          field.uOpacity.value = 0;
        }
        continue;
      }
      field.geometry.instanceCount = count;
      field.uDrift.value.set(field.drift.x, field.drift.y, field.drift.z);
      field.uFall.value.set(field.fall.x, field.fall.y, field.fall.z);
      field.uShared.value.set(shared.x - velocity.x, shared.y - velocity.y, shared.z - velocity.z);
      field.uVaried.value.set(varied.x, varied.y, varied.z);
      field.uLook.value.set(look.exposure, look.sizeMin, look.sizeMax);
      // A kind fades in from nothing, so that it does not start with a pop.
      field.uOpacity.value = look.opacity * Math.min(1, level / 0.06);
      field.uMotion.value.set(look.sway, look.stretch, look.gust);
      if (!light) {
        // How deep the cloud above is, as far as the camera can tell: by what falls from it.
        const depth = Math.max(state.storm.value, state.rain.value, state.snow.value);
        light = particleLight(this.lighting, local?.cloudCover ?? 0, depth);
      }
      field.uAmbient.value.set(...light.ambient);
      field.uSun.value.set(...light.sun);
    }
    // The pipeline draws its overlay pass only while something in it is visible.
    this.group.visible = this.fields.some((f) => f.mesh.visible);
  }

  /**
   * Draws every kind once in the next frame, with one empty particle each, so
   * that the renderer compiles their materials and the pipeline its variant
   * with the overlay before they are needed (a compile stalls the frame it
   * falls in). Done by itself in the first frame and when cloud closes in over
   * the camera; call it after changing the pipeline's settings (its quality,
   * bloom, grading), which make new variants.
   */
  warm(): void {
    this.warming = true;
  }

  /**
   * Offset of a kind's lattice from the eye (m, each axis wrapped at
   * `WRAP_PERIOD`): it moves with the kind's share of the wind and against
   * the camera, which is what fixes the particles in the world.
   */
  latticeOffset(kind: ParticleKind): Readonly<Vec3d> {
    return this.fields.find((f) => f.kind === kind)!.drift;
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
