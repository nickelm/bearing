/**
 * What the puffs look like and what makes them (Proposal 0011, decision 320).
 *
 * - A **look** is one kind of puff: its life, its curves (radius, color, glow, coverage,
 *   rise) and how the air moves it (rise speed, drag toward the wind, turbulence, how much
 *   wind it takes). The compute pass reads the looks' curves from one table and their
 *   motion from a second (`lookMotion`).
 * - An **emitter preset** is a source: which looks it sheds, how often in time or how
 *   densely along its path, at what size and speed. The proposal's fifteen sources are
 *   here; the ones that are a single blast (an air burst, a bomb impact, a ship hit, the
 *   rolling fireball of a fuel fire) are explosion recipes (`explosionRecipe`).
 * - A **motor** decides a missile's trail: a weapon's specification names its motor kind,
 *   and `trailPreset` turns it into a preset.
 *
 * Colors are linear RGB albedos (the puffs are lit as surfaces); glow is an emissive gain
 * over the color, drawn in addition to the light. Sizes are base radii in meters, scaled
 * by the radius curve.
 */
import type { ColorCurve, Curve, LookCurves } from './curves';
import type { ExplosionKind, MotorKind } from '../../../sim/effects/events';

export interface Look extends LookCurves {
  id: LookId;
  /** Shortest and longest life (s). */
  life: readonly [number, number];
  /** Rise speed (m/s) the puff relaxes to, times the rise curve; negative falls. */
  riseSpeed: number;
  /** Rate (1/s) at which its velocity relaxes to the wind and its rise. */
  drag: number;
  /** Turbulent acceleration (m/s²). */
  turbulence: number;
  /** Share of the wind it takes (0..1). */
  wind: number;
  /** Squash of the sphere along the local up, 1 round, less flatter. */
  squash: number;
}

export const LOOK_IDS = [
  'motor-smoke',
  'motor-core',
  'thin-smoke',
  'launch-column',
  'gray-smoke',
  'black-smoke',
  'fire',
  'fireball',
  'flash',
  'burst-smoke',
  'dirt',
  'column-black',
  'column-gray',
  'chimney',
  'steam',
  'spray',
  'dust',
  'snow-dust',
  'flare-core',
  'flare-smoke',
  'mist',
  'debris-smoke',
] as const;
export type LookId = (typeof LOOK_IDS)[number];

/** Swells fast, grows slowly, shrinks away at the end. */
const SWELL: Curve = [
  [0, 0.35],
  [0.04, 1],
  [0.6, 1.6],
  [0.9, 1.7],
  [1, 0.2],
];
/** A trail: swells at once, then widens slowly for its long life. */
const TRAIL: Curve = [
  [0, 0.4],
  [0.01, 1],
  [0.1, 1.6],
  [0.5, 2.2],
  [0.9, 2.5],
  [1, 0.2],
];
/** Swells, grows a lot (columns widen as they rise). */
const BILLOW: Curve = [
  [0, 0.4],
  [0.05, 1],
  [0.7, 2.8],
  [0.92, 3.1],
  [1, 0.3],
];
const FIRE_SIZE: Curve = [
  [0, 0.5],
  [0.15, 1.1],
  [0.6, 0.9],
  [1, 0.1],
];
const FULL: Curve = [
  [0, 1],
  [0.7, 1],
  [1, 0],
];
const EARLY_FADE: Curve = [
  [0, 1],
  [0.3, 0.9],
  [1, 0],
];
const STEADY: Curve = [
  [0, 1],
  [1, 1],
];
const SLOWING: Curve = [
  [0, 1],
  [0.5, 0.7],
  [1, 0.4],
];
const NONE: Curve = [[0, 0]];
/**
 * Embers: a negative glow is the fire's light on a column's underside (decision 330),
 * strongest at the base and gone a third of the way up.
 */
const EMBERS: Curve = [
  [0, -0.35],
  [0.12, -0.15],
  [0.3, 0],
];
const gray = (t: number, v: number): readonly [number, number, number, number] => [t, v, v, v];

const look = (
  id: LookId,
  o: Omit<Look, 'id' | 'glow' | 'coverage' | 'rise' | 'squash'> &
    Partial<Pick<Look, 'glow' | 'coverage' | 'rise' | 'squash'>>,
): Look => ({
  id,
  glow: NONE,
  coverage: FULL,
  rise: STEADY,
  squash: 0.9,
  ...o,
});

const WHITE_TO_LIGHT_GRAY: ColorCurve = [gray(0, 0.85), gray(0.5, 0.75), gray(1, 0.62)];
/** Yellow-white to orange to red to dark gray: a fire that cools into smoke. */
const FIRE_COLOR: ColorCurve = [
  [0, 1, 0.85, 0.45],
  [0.25, 1, 0.5, 0.12],
  [0.55, 0.85, 0.2, 0.05],
  [0.8, 0.12, 0.1, 0.09],
  [1, 0.08, 0.075, 0.07],
];
const FIRE_GLOW: Curve = [
  [0, 2.6],
  [0.3, 1.8],
  [0.6, 0.8],
  [0.8, 0],
];

export const LOOKS: readonly Look[] = [
  look('motor-smoke', {
    life: [30, 45],
    color: WHITE_TO_LIGHT_GRAY,
    radius: TRAIL,
    riseSpeed: 0.4,
    drag: 0.6,
    turbulence: 0.25,
    wind: 1,
  }),
  look('motor-core', {
    life: [0.06, 0.1],
    color: [[0, 1, 0.75, 0.4]],
    glow: [[0, 5]],
    radius: STEADY,
    riseSpeed: 0,
    drag: 0,
    turbulence: 0,
    wind: 0,
    squash: 1,
  }),
  look('thin-smoke', {
    life: [5, 10],
    color: [gray(0, 0.8), gray(1, 0.7)],
    radius: SWELL,
    coverage: EARLY_FADE,
    riseSpeed: 0.2,
    drag: 0.8,
    turbulence: 0.2,
    wind: 1,
  }),
  look('launch-column', {
    life: [50, 65],
    color: [gray(0, 0.9), gray(0.6, 0.82), gray(1, 0.7)],
    radius: TRAIL,
    riseSpeed: 1.2,
    drag: 0.5,
    turbulence: 0.35,
    wind: 0.8,
  }),
  look('gray-smoke', {
    life: [8, 12],
    color: [gray(0, 0.32), gray(0.5, 0.18), gray(1, 0.12)],
    radius: SWELL,
    riseSpeed: 0.6,
    drag: 0.7,
    turbulence: 0.3,
    wind: 1,
  }),
  look('black-smoke', {
    life: [15, 25],
    color: [gray(0, 0.06), gray(1, 0.05)],
    radius: SWELL,
    riseSpeed: 1,
    drag: 0.6,
    turbulence: 0.35,
    wind: 1,
  }),
  look('fire', {
    life: [0.45, 0.8],
    color: FIRE_COLOR,
    glow: FIRE_GLOW,
    radius: FIRE_SIZE,
    riseSpeed: 3,
    drag: 2,
    turbulence: 1,
    wind: 0.6,
    squash: 1,
  }),
  look('fireball', {
    life: [1.4, 2.6],
    color: FIRE_COLOR,
    glow: [
      [0, 3.5],
      [0.2, 2.5],
      [0.5, 1],
      [0.75, 0],
    ],
    radius: [
      [0, 0.3],
      [0.08, 1],
      [0.5, 1.25],
      [0.85, 1.1],
      [1, 0.2],
    ],
    riseSpeed: 4,
    drag: 3,
    turbulence: 1.5,
    wind: 0.5,
    squash: 1,
  }),
  look('flash', {
    life: [0.14, 0.22],
    color: [[0, 1, 0.95, 0.8]],
    glow: [
      [0, 12],
      [1, 5],
    ],
    radius: [
      [0, 0.5],
      [0.3, 1],
      [1, 0.6],
    ],
    riseSpeed: 0,
    drag: 0,
    turbulence: 0,
    wind: 0,
    squash: 1,
  }),
  look('burst-smoke', {
    life: [10, 18],
    color: [gray(0, 0.2), gray(0.4, 0.15), gray(1, 0.13)],
    radius: SWELL,
    riseSpeed: 0.3,
    drag: 1.2,
    turbulence: 0.3,
    wind: 1,
  }),
  look('dirt', {
    life: [16, 28],
    color: [
      [0, 0.3, 0.22, 0.14],
      [0.5, 0.26, 0.21, 0.16],
      [1, 0.24, 0.22, 0.2],
    ],
    radius: SWELL,
    riseSpeed: 0.6,
    rise: SLOWING,
    drag: 0.7,
    turbulence: 0.5,
    wind: 1,
  }),
  look('column-black', {
    life: [45, 60],
    color: [gray(0, 0.05), gray(0.6, 0.06), gray(1, 0.09)],
    glow: EMBERS,
    radius: BILLOW,
    riseSpeed: 9,
    rise: SLOWING,
    drag: 0.5,
    turbulence: 2.5,
    wind: 1,
  }),
  look('column-gray', {
    life: [40, 55],
    color: [gray(0, 0.16), gray(0.6, 0.22), gray(1, 0.26)],
    glow: EMBERS,
    radius: BILLOW,
    riseSpeed: 7,
    rise: SLOWING,
    drag: 0.5,
    turbulence: 2.2,
    wind: 1,
  }),
  look('chimney', {
    life: [20, 28],
    color: [gray(0, 0.45), gray(1, 0.5)],
    radius: BILLOW,
    riseSpeed: 1.8,
    rise: SLOWING,
    drag: 0.7,
    turbulence: 0.6,
    wind: 1,
  }),
  look('steam', {
    life: [24, 32],
    color: [gray(0, 0.92), gray(1, 0.88)],
    radius: BILLOW,
    coverage: EARLY_FADE,
    riseSpeed: 3,
    rise: SLOWING,
    drag: 0.5,
    turbulence: 0.3,
    wind: 1,
  }),
  look('spray', {
    life: [2.5, 4.5],
    color: [gray(0, 0.92), gray(1, 0.85)],
    radius: SWELL,
    coverage: EARLY_FADE,
    riseSpeed: -7,
    drag: 0.4,
    turbulence: 0.4,
    wind: 0.6,
  }),
  look('dust', {
    life: [2.2, 4],
    color: [gray(0, 1), gray(1, 1)],
    radius: SWELL,
    coverage: EARLY_FADE,
    riseSpeed: 0.6,
    drag: 0.9,
    turbulence: 0.6,
    wind: 0.8,
    squash: 0.75,
  }),
  look('snow-dust', {
    life: [2.2, 4],
    color: [gray(0, 0.95), gray(1, 0.95)],
    radius: SWELL,
    coverage: EARLY_FADE,
    riseSpeed: 0.4,
    drag: 0.9,
    turbulence: 0.6,
    wind: 0.8,
    squash: 0.75,
  }),
  look('flare-core', {
    life: [0.05, 0.08],
    color: [[0, 1, 0.95, 0.85]],
    glow: [[0, 14]],
    radius: STEADY,
    riseSpeed: 0,
    drag: 0,
    turbulence: 0,
    wind: 0,
    squash: 1,
  }),
  look('flare-smoke', {
    life: [3.5, 5],
    color: [gray(0, 0.9), gray(1, 0.8)],
    radius: SWELL,
    coverage: EARLY_FADE,
    riseSpeed: 0.3,
    drag: 0.8,
    turbulence: 0.25,
    wind: 1,
  }),
  look('mist', {
    life: [5, 8],
    color: [gray(0, 0.9), gray(1, 0.92)],
    radius: BILLOW,
    coverage: EARLY_FADE,
    riseSpeed: 0.8,
    drag: 0.8,
    turbulence: 0.5,
    wind: 0.7,
  }),
  look('debris-smoke', {
    life: [2, 3.5],
    color: [gray(0, 0.25), gray(1, 0.18)],
    radius: SWELL,
    riseSpeed: 0.2,
    drag: 0.8,
    turbulence: 0.2,
    wind: 1,
  }),
];

export const LOOK_INDEX: Readonly<Record<LookId, number>> = Object.fromEntries(
  LOOKS.map((l, i) => [l.id, i]),
) as Record<LookId, number>;

/** Looks that glow (fire, flash, motor cores): no shadow side, a constant bright color. */
export function lookGlows(id: LookId): boolean {
  const l = LOOKS[LOOK_INDEX[id]]!;
  return l.glow.some((k) => k[1] > 0);
}

/** vec4 rows per look in the motion table: (riseSpeed, drag, turbulence, wind), (squash, 0, 0, 0). */
export function lookMotion(looks: readonly Look[] = LOOKS): Float32Array {
  const out = new Float32Array(looks.length * 8);
  looks.forEach((l, i) => {
    out.set([l.riseSpeed, l.drag, l.turbulence, l.wind, l.squash, 0, 0, 0], i * 8);
  });
  return out;
}

/** One stream of puffs from a source. */
export interface Stream {
  look: LookId;
  /** Puffs per second (a source that is still, or any source with no spacing). */
  rate: number;
  /** Meters between puffs along a moving source's path (0: by rate only). */
  spacing: number;
  /** Base radius (m), least and greatest. */
  size: readonly [number, number];
  /** Speed (m/s) out along the source's direction (negative: back along it). */
  speed: number;
  /** Speed (m/s) up. */
  up: number;
  /** Random speed (m/s) in any direction. */
  spread: number;
  /** Random offset (m) of where it is born. */
  jitter: number;
  /** Share of the source's velocity it keeps. */
  inherit: number;
  /** Radial speed (m/s) out across the ground (downwash). */
  radial?: number;
  /** Chance (0..1) that a due puff is shed: flicker. */
  chance?: number;
}

export const PRESET_IDS = [
  'solid-motor',
  'reduced-smoke-motor',
  'sam-launch',
  'aircraft-damaged',
  'aircraft-fire',
  'air-burst',
  'bomb-impact',
  'fuel-fire',
  'burning-target',
  'ship-hit',
  'chimney',
  'cooling-tower',
  'rotor-downwash',
  'flare',
  'waterfall-mist',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** A continuous source. */
export interface EmitterPreset {
  id: PresetId;
  label: string;
  streams: readonly Stream[];
  /** How long it runs (s) on its own, or null while its owner keeps it. */
  duration: readonly [number, number] | null;
  /** Fills itself to its full length when it comes into view (long-lived columns). */
  prewarm: boolean;
  /** Farthest distance (m) at which it sheds puffs. */
  range: number;
}

const stream = (o: Partial<Stream> & Pick<Stream, 'look' | 'size'>): Stream => ({
  rate: 0,
  spacing: 0,
  speed: 0,
  up: 0,
  spread: 0,
  jitter: 0,
  inherit: 0,
  ...o,
});

/** Emitter presets by id; the explosion-only presets have none (`explosionRecipe`). */
export const EMITTERS: Readonly<Partial<Record<PresetId, EmitterPreset>>> = {
  'solid-motor': {
    id: 'solid-motor',
    label: 'Solid rocket motor',
    streams: [
      stream({
        look: 'motor-smoke',
        spacing: 6,
        rate: 30,
        size: [3.2, 4.2],
        spread: 0.8,
        jitter: 0.8,
      }),
      stream({ look: 'motor-core', rate: 30, size: [1.1, 1.3] }),
    ],
    duration: null,
    prewarm: false,
    range: 30_000,
  },
  'reduced-smoke-motor': {
    id: 'reduced-smoke-motor',
    label: 'Reduced-smoke motor',
    streams: [
      stream({ look: 'thin-smoke', spacing: 12, rate: 12, size: [1, 1.4], spread: 0.4 }),
      stream({ look: 'motor-core', rate: 30, size: [0.6, 0.7] }),
    ],
    duration: null,
    prewarm: false,
    range: 20_000,
  },
  'sam-launch': {
    id: 'sam-launch',
    label: 'SAM launch',
    streams: [
      stream({
        look: 'launch-column',
        spacing: 8,
        rate: 30,
        size: [5.5, 7],
        spread: 1,
        jitter: 1.5,
      }),
      stream({ look: 'motor-core', rate: 30, size: [1.8, 2.2] }),
    ],
    duration: null,
    prewarm: false,
    range: 40_000,
  },
  'aircraft-damaged': {
    id: 'aircraft-damaged',
    label: 'Aircraft damaged',
    streams: [
      stream({
        look: 'gray-smoke',
        spacing: 6,
        rate: 25,
        size: [1.2, 1.8],
        spread: 0.6,
        jitter: 0.5,
      }),
      stream({ look: 'fire', rate: 18, size: [0.7, 1.1], chance: 0.35, inherit: 0.9 }),
    ],
    duration: null,
    prewarm: false,
    range: 25_000,
  },
  'aircraft-fire': {
    id: 'aircraft-fire',
    label: 'Aircraft on fire',
    streams: [
      stream({
        look: 'black-smoke',
        spacing: 4.5,
        rate: 30,
        size: [2, 3],
        spread: 0.8,
        jitter: 0.8,
      }),
      stream({ look: 'fire', rate: 40, size: [1.5, 2.4], inherit: 0.85, jitter: 0.8 }),
    ],
    duration: null,
    prewarm: false,
    range: 30_000,
  },
  'fuel-fire': {
    id: 'fuel-fire',
    label: 'Fuel or ammunition fire',
    streams: [
      stream({ look: 'column-black', rate: 0.8, size: [6, 12], up: 4, spread: 3, jitter: 9 }),
      stream({ look: 'fire', rate: 10, size: [3, 5], up: 2, spread: 1, jitter: 7 }),
    ],
    duration: null,
    prewarm: true,
    range: 60_000,
  },
  'burning-target': {
    id: 'burning-target',
    label: 'Burning target',
    streams: [
      stream({ look: 'column-gray', rate: 0.7, size: [4.5, 8.5], up: 3, spread: 2.5, jitter: 5 }),
      stream({
        look: 'fire',
        rate: 5,
        size: [1.8, 3],
        up: 1.5,
        spread: 0.6,
        jitter: 4,
        chance: 0.7,
      }),
    ],
    duration: null,
    prewarm: true,
    range: 50_000,
  },
  chimney: {
    id: 'chimney',
    label: 'Chimney',
    streams: [
      stream({ look: 'chimney', rate: 0.6, size: [3, 4], up: 2, spread: 0.8, jitter: 0.8 }),
    ],
    duration: null,
    prewarm: true,
    range: 15_000,
  },
  'cooling-tower': {
    id: 'cooling-tower',
    label: 'Cooling tower',
    streams: [stream({ look: 'steam', rate: 0.3, size: [14, 19], up: 3, spread: 1.5, jitter: 8 })],
    duration: null,
    prewarm: true,
    range: 25_000,
  },
  'rotor-downwash': {
    id: 'rotor-downwash',
    label: 'Rotor downwash',
    streams: [
      stream({
        look: 'dust',
        rate: 40,
        size: [0.12, 0.22],
        up: 0.6,
        spread: 1,
        jitter: 0.3,
        radial: 12,
      }),
    ],
    duration: null,
    prewarm: false,
    range: 3_000,
  },
  flare: {
    id: 'flare',
    label: 'Flare',
    streams: [
      stream({ look: 'flare-smoke', spacing: 2.5, rate: 25, size: [0.45, 0.7], spread: 0.3 }),
      stream({ look: 'flare-core', rate: 60, size: [0.7, 0.8] }),
    ],
    duration: [5, 8],
    prewarm: false,
    range: 15_000,
  },
  'waterfall-mist': {
    id: 'waterfall-mist',
    label: 'Waterfall mist',
    streams: [stream({ look: 'mist', rate: 4, size: [4, 7], up: 1, spread: 1.5, jitter: 8 })],
    duration: null,
    prewarm: true,
    range: 10_000,
  },
};

/** Presets that are blasts (one explosion, maybe a fire after). */
export const BLAST_PRESETS: Readonly<
  Partial<Record<PresetId, { kind: ExplosionKind; explosive: number; label: string }>>
> = {
  'air-burst': { kind: 'air', explosive: 10, label: 'Air burst' },
  'bomb-impact': { kind: 'ground', explosive: 87, label: 'Bomb impact' },
  'ship-hit': { kind: 'water', explosive: 40, label: 'Ship hit' },
  'fuel-fire': { kind: 'fuel', explosive: 300, label: 'Fuel or ammunition fire' },
};

/** The trail of a missile by its motor (the weapon's specification names it). */
export function trailPreset(motor: MotorKind): PresetId | null {
  switch (motor) {
    case 'solid':
      return 'solid-motor';
    case 'reduced-smoke':
      return 'reduced-smoke-motor';
    case 'sam':
      return 'sam-launch';
    default:
      return null;
  }
}

/** One burst of puffs in an explosion. */
export interface Burst {
  look: LookId;
  count: number;
  /** Base radius (m), least and greatest. */
  size: readonly [number, number];
  /** Speed (m/s) out from the center, least and greatest. */
  speed: readonly [number, number];
  /** Speed (m/s) up added to all. */
  up: number;
  /** Seconds after the blast. */
  delay: number;
  /** Bias toward the upper hemisphere 0 (sphere) .. 1 (straight up). */
  upward: number;
}

/** What an explosion is made of (Proposal 0011, *Explosions*). */
export interface ExplosionRecipe {
  bursts: Burst[];
  /** Flat-shaded chunks thrown out, and how many of them trail smoke. */
  debris: { count: number; speed: readonly [number, number]; size: number; smoking: number };
  /** The shockwave ring's last radius (m), or 0. */
  ring: number;
  /** The scorch decal's radius (m), or 0. */
  scorch: number;
  /** The flash light's peak (relative) and reach (m). */
  light: { intensity: number; reach: number };
  /** A fire left burning (a fuel fire's column), or null. */
  fire: PresetId | null;
}

/**
 * How much bigger explosions are drawn than the cube-root scale alone gives (owner, decision
 * 319): twice, in size, spread, scorch, shockwave and light's reach.
 */
export const EXPLOSION_SIZE = 2;

/** The cube root of the explosive (kg): explosions scale with it (decision 300's sizing). */
export function blastScale(explosive: number): number {
  return Math.cbrt(Math.max(0.5, explosive));
}

/** The layers of an explosion of `explosive` kg of a kind (Proposal 0011, *Explosions*). */
export function explosionRecipe(kind: ExplosionKind, explosive: number): ExplosionRecipe {
  const k = blastScale(explosive);
  // Sizes, spreads and reaches at EXPLOSION_SIZE times the cube-root scale; counts on the
  // cube root alone, so the puff budget holds (decision 319).
  const E = EXPLOSION_SIZE;
  const g = E * k;
  // Debris flies ballistic: its reach grows with the speed squared, so √E reaches E.
  const b = Math.sqrt(E) * k;
  const n = (a: number, b: number, max: number) => Math.min(max, Math.round(a + b * k));
  const ground = kind === 'ground' || kind === 'fuel';
  const bursts: Burst[] = [
    {
      look: 'flash',
      count: 1,
      size: [3.2 * g, 3.2 * g],
      speed: [0, 0],
      up: 0,
      delay: 0,
      upward: 0,
    },
    {
      look: 'fireball',
      count: n(5, 3, 36),
      size: [1.3 * g, 2.1 * g],
      speed: [2.5 * g, 6 * g],
      up: ground ? 2 * g : 0,
      delay: 0,
      upward: ground ? 0.5 : 0,
    },
  ];
  if (kind === 'air') {
    bursts.push({
      look: 'burst-smoke',
      count: n(6, 3, 30),
      size: [1.5 * g, 2.2 * g],
      speed: [1.5 * g, 3.5 * g],
      up: 0,
      delay: 0.25,
      upward: 0,
    });
  } else if (kind === 'water') {
    bursts.push(
      {
        look: 'spray',
        count: n(10, 4, 40),
        size: [0.8 * g, 1.3 * g],
        speed: [2 * E, 3 * g],
        up: 9 * g,
        delay: 0,
        upward: 0.85,
      },
      {
        look: 'black-smoke',
        count: n(4, 2, 20),
        size: [1.2 * g, 1.8 * g],
        speed: [0.5 * E, 1.5 * g],
        up: E,
        delay: 0.6,
        upward: 0.6,
      },
    );
  } else {
    bursts.push(
      {
        look: 'dirt',
        count: n(8, 4, 44),
        size: [1.4 * g, 2.2 * g],
        speed: [2 * g, 5 * g],
        up: 4 * g,
        delay: 0.05,
        upward: 0.7,
      },
      {
        look: kind === 'fuel' ? 'column-black' : 'burst-smoke',
        count: n(4, 2, 24),
        size: [1.6 * g, 2.4 * g],
        speed: [0.5 * g, 1.5 * g],
        up: 2.5 * g,
        delay: 0.4,
        upward: 0.8,
      },
    );
  }
  if (kind === 'fuel') {
    // The rolling fireball: a second, larger and slower one, rising.
    bursts.push({
      look: 'fireball',
      count: n(8, 2, 30),
      size: [1.4 * g, 2 * g],
      speed: [0.8 * g, 2 * g],
      up: 3 * g,
      delay: 0.3,
      upward: 0.9,
    });
  }
  return {
    bursts,
    debris: ground
      ? { count: n(3, 1.6, 24), speed: [3 * b, 7 * b], size: 0.22 * k, smoking: n(0, 0.4, 6) }
      : { count: n(1, 1, 12), speed: [5 * b, 10 * b], size: 0.12 * k, smoking: 0 },
    ring: ground && explosive >= 40 ? 9 * g : 0,
    scorch: ground ? 1.5 * g : 0,
    light: { intensity: 0.5 * k, reach: 10 * g },
    fire: kind === 'fuel' ? 'fuel-fire' : null,
  };
}
