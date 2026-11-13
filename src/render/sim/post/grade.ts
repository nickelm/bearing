/**
 * Time-of-day color grading for the simulation view (visual-style Part I,
 * _Post-Processing_: "a lookup table per time-of-day band, blended as the sun
 * moves"). The table here is five small parameter sets instead of five 3D
 * textures: the bands are blended on the CPU from the sun's elevation at the
 * camera, so the shader applies one set of uniforms and pays for no branch
 * and no texture.
 *
 * Per band:
 *
 * - `gain`: a tint on the linear scene color before tone mapping. Very bright
 *   pixels (the sun, emissive lights) keep their own color.
 * - `saturation`: around the pixel's luminance, before tone mapping.
 * - `gamma` and `lift`: on the tone-mapped, sRGB-encoded color, `c^gamma`,
 *   then `c + lift · (1 − c)`, so `lift` colors the shadows and leaves white
 *   alone. A lift of 0.012 raises black by three 8-bit steps.
 * - `bloom`: the bloom threshold. The exposure is constant through the day, so
 *   what counts as "very bright" is not: by night a runway light at a
 *   luminance of 1 is the brightest thing in view, by day a sunlit cloud is
 *   brighter than that and must not bloom.
 *
 * The bands follow the guide: midday pale and slightly hazy, golden hour warm,
 * dusk violet, dawn cooler and pinker than dusk, night dark blue. The values
 * are subtle on purpose: the sky model and the sunlight already carry the
 * time of day, and the grade only leans the image toward the palette.
 */
import { DEG } from '../../../core/units';

export type GradeBandName = 'night' | 'dawn' | 'dusk' | 'golden' | 'day';

export interface GradeBand {
  /** Linear RGB tint before tone mapping. */
  gain: [number, number, number];
  /** 1 leaves the saturation alone. */
  saturation: number;
  /** Added to the encoded color in proportion to its distance from white. */
  lift: [number, number, number];
  /** Exponent on the encoded color: above 1 deepens the midtones. */
  gamma: number;
  /** Exposed luminance at which a pixel starts to bloom (bloom.ts). */
  bloom: number;
}

export const GRADE_BANDS: Record<GradeBandName, GradeBand> = {
  // Dark blue, less color, as the eye sees by night.
  night: {
    gain: [0.84, 0.93, 1.12],
    saturation: 0.82,
    lift: [0, 0.003, 0.012],
    gamma: 1.05,
    bloom: 0.3,
  },
  // Cool and pink, clearer than dusk.
  dawn: {
    gain: [1.02, 0.97, 1.03],
    saturation: 0.98,
    lift: [0.006, 0.005, 0.012],
    gamma: 1,
    bloom: 0.5,
  },
  // Violet air under an orange horizon (`#F6B07A` to `#7C6A8A`).
  dusk: {
    gain: [1.02, 0.94, 1.05],
    saturation: 1.05,
    lift: [0.008, 0.002, 0.016],
    gamma: 1,
    bloom: 0.5,
  },
  // Warm light (`#FF9A4D`), cool shadows, a little more contrast.
  golden: {
    gain: [1.07, 1.0, 0.9],
    saturation: 1.08,
    lift: [0.002, 0.004, 0.012],
    gamma: 1.04,
    bloom: 1.2,
  },
  // Pale and slightly hazy.
  day: { gain: [1, 1, 1], saturation: 0.94, lift: [0.012, 0.013, 0.014], gamma: 0.98, bloom: 2.4 },
};

/** Sun elevations (rad) between which one band hands over to the next. */
const NIGHT_TO_TWILIGHT: [number, number] = [-11 * DEG, -5 * DEG];
const TWILIGHT_TO_GOLDEN: [number, number] = [-3.5 * DEG, 2.5 * DEG];
const GOLDEN_TO_DAY: [number, number] = [5 * DEG, 16 * DEG];

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Weight of each band, summing to 1. `elevation` is the sun's elevation at
 * the camera (rad); `morning` runs from −1 (the sun is setting) to 1 (rising)
 * and divides twilight between dusk and dawn.
 */
export function gradeWeights(elevation: number, morning: number): Record<GradeBandName, number> {
  const a = smoothstep(NIGHT_TO_TWILIGHT[0], NIGHT_TO_TWILIGHT[1], elevation);
  const b = smoothstep(TWILIGHT_TO_GOLDEN[0], TWILIGHT_TO_GOLDEN[1], elevation);
  const c = smoothstep(GOLDEN_TO_DAY[0], GOLDEN_TO_DAY[1], elevation);
  const twilight = a - b;
  const dawn = 0.5 + 0.5 * Math.min(1, Math.max(-1, morning));
  return {
    night: 1 - a,
    dawn: twilight * dawn,
    dusk: twilight * (1 - dawn),
    golden: b - c,
    day: c,
  };
}

const BAND_NAMES = Object.keys(GRADE_BANDS) as GradeBandName[];

/** The grade at a sun elevation: the bands' parameters blended by `gradeWeights`. */
export function gradeAt(elevation: number, morning: number, out?: GradeBand): GradeBand {
  const w = gradeWeights(elevation, morning);
  const g = out ?? { gain: [0, 0, 0], saturation: 0, lift: [0, 0, 0], gamma: 0, bloom: 0 };
  g.gain[0] = g.gain[1] = g.gain[2] = 0;
  g.lift[0] = g.lift[1] = g.lift[2] = 0;
  g.saturation = 0;
  g.gamma = 0;
  g.bloom = 0;
  for (const name of BAND_NAMES) {
    const band = GRADE_BANDS[name];
    const k = w[name];
    for (let i = 0; i < 3; i++) {
      g.gain[i]! += k * band.gain[i]!;
      g.lift[i]! += k * band.lift[i]!;
    }
    g.saturation += k * band.saturation;
    g.gamma += k * band.gamma;
    g.bloom += k * band.bloom;
  }
  return g;
}
