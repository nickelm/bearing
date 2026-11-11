/**
 * Day, night and seasons on the strategic map (visual-style Part II, Day, Night, and
 * Weather; decision 87). Stylized, not physical: the relief light stays the
 * cartographic hillshade, and the sun only decides where it is day.
 *
 * - **Terminator.** μ = n · sun at each point. Day fades into night across the
 *   civil-twilight band, μ from −sin 6° to +sin 6°.
 * - **Night.** A multiply by Part II's night tint (`#1B2A4A`), scaled to its
 *   brightest channel and dimmed to `NIGHT_BRIGHTNESS` in sRGB, so the night side
 *   turns deep blue and darker while relief, coasts and labels stay readable.
 * - **Twilight.** A warm tint (`#E3A06A`, scaled the same way) peaking at the
 *   terminator over about ±4°.
 * - **Seasons.** Snow on land below about 0 °C, sea ice where the sea-level air
 *   temperature falls below about −3 °C, and lake ice below about −1.5 °C, from the
 *   climate texture and the season (common/seasons.ts), as in the simulation view.
 *
 * `daylight` is the CPU reference for tests.
 */
import type { Node } from 'three/webgpu';
import { exp, float, mix, smoothstep, vec3 } from 'three/tsl';
import { DEG } from '../../core/units';
import { srgbToLinear } from '../common/palette';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Half-width of the day–night blend in μ (civil twilight, 6°). */
export const TWILIGHT_MU = Math.sin(6 * DEG);
/** Width (in μ) of the warm twilight tint. */
export const TWILIGHT_GLOW_MU = Math.sin(4 * DEG);
/** Night tint brightness in sRGB (its brightest channel). */
export const NIGHT_BRIGHTNESS = 0.62;
/** Warm tint strength at the terminator. */
export const TWILIGHT_STRENGTH = 0.5;
/** Part II colors (sRGB hex). */
export const NIGHT_TINT = 0x1b2a4a;
export const TWILIGHT_TINT = 0xe3a06a;
export const SNOW = 0xf1f3f2;
/** Sea ice: the snow fill, a little bluer (Part II names no sea-ice color). */
export const SEA_ICE = 0xe4ecf0;

/** Linear multiplier of an sRGB hex color scaled to its brightest channel times `k`. */
export function tintMultiplier(hex: number, k = 1): [number, number, number] {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  const m = Math.max(...c);
  return [
    srgbToLinear((c[0]! / m) * k),
    srgbToLinear((c[1]! / m) * k),
    srgbToLinear((c[2]! / m) * k),
  ];
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Day share (0 night, 1 day) and twilight-tint share at μ = n · sun. */
export function daylight(mu: number): { day: number; twilight: number } {
  return {
    day: smooth(-TWILIGHT_MU, TWILIGHT_MU, mu),
    twilight: Math.exp(-((mu / TWILIGHT_GLOW_MU) ** 2)),
  };
}

const NIGHT = tintMultiplier(NIGHT_TINT, NIGHT_BRIGHTNESS);
const WARM = tintMultiplier(TWILIGHT_TINT);

/**
 * A map color under the sun: the night multiply on the night side and the warm tint
 * at the terminator. `nightStrength` and `twilightStrength` (0..1) scale them; 0 turns
 * day and night off.
 */
export function daylightNode(color: V3, mu: F, nightStrength: F, twilightStrength: F): V3 {
  const day = smoothstep(-TWILIGHT_MU, TWILIGHT_MU, mu);
  const night = mix(vec3(1, 1, 1), vec3(NIGHT[0], NIGHT[1], NIGHT[2]), nightStrength);
  const lit = color.mul(mix(night, vec3(1, 1, 1), day));
  const glow = exp(mu.div(TWILIGHT_GLOW_MU).pow(2).negate())
    .mul(TWILIGHT_STRENGTH)
    .mul(twilightStrength);
  return lit.mul(mix(vec3(1, 1, 1), vec3(WARM[0], WARM[1], WARM[2]), glow)) as V3;
}

/** Snow cover on land from the surface temperature (°C), moisture 0..1 and steepness 0..1. */
export function snowNode(temperature: F, moisture: F, steep: F): F {
  const cold = smoothstep(0, -5, temperature);
  const wet = smoothstep(0.03, 0.2, moisture);
  return cold.mul(wet).mul(float(1).sub(steep.mul(0.6))) as F;
}

/** Sea ice from the sea-level air temperature (°C). */
export function seaIceNode(temperature: F): F {
  return smoothstep(-3, -8, temperature) as F;
}

/** Lake ice from the lake-surface temperature (°C). */
export function lakeIceNode(temperature: F): F {
  return smoothstep(-1.5, -4, temperature) as F;
}
