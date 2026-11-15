/**
 * Deciduous foliage through the year (decision 153), shared by the kit trees
 * and the canopy shell so a forest turns as one: green, then yellow, orange or
 * red as the surface temperature falls through 12–7 °C, then brown through
 * 5–1 °C, then leafless. Leafless kit trees swap to a bare model on the CPU
 * (`LEAFLESS_T`); the shell takes the gray-brown of bare twigs, with the
 * ground's snow showing through.
 */
import { Color } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { clamp, mix, smoothstep, uniform } from 'three/tsl';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Below this surface temperature (°C) a deciduous tree is leafless, give or take LEAFLESS_JITTER. */
export const LEAFLESS_T = 0;
export const LEAFLESS_JITTER = 1.5;

const linear = (hex: number) => new Color().setHex(hex);

/** Fall colors, muted as Part I asks: yellow, orange, red; then brown; bare twigs. */
export const FALL = {
  yellow: uniform(linear(0xc29a2c)),
  orange: uniform(linear(0xb8622a)),
  red: uniform(linear(0x983a26)),
  brown: uniform(linear(0x6b4a2e)),
  twigs: uniform(linear(0x6e655c)),
};

/**
 * A deciduous crown's albedo at surface temperature `t` (°C): `green` while
 * warm, then a fall color picked by `hue` (0 yellow, 0.5 orange, 1 red), then
 * brown. The leafless state is the caller's (a bare model, or twigs on the shell).
 */
export function foliage(green: V3, t: F, hue: F): V3 {
  const h = clamp(hue, 0, 1);
  const fall = mix(
    mix(FALL.yellow, FALL.orange, clamp(h.mul(2), 0, 1)),
    FALL.red,
    clamp(h.mul(2).sub(1), 0, 1),
  );
  const turning = smoothstep(12, 7, t);
  const browning = smoothstep(5, 1, t);
  return mix(mix(green, fall, turning), FALL.brown, browning) as V3;
}

/** How leafless a deciduous stand is at `t` (°C), 0..1, across the trees' jittered thresholds. */
export function leafless(t: F): F {
  return smoothstep(LEAFLESS_T + LEAFLESS_JITTER, LEAFLESS_T - LEAFLESS_JITTER, t) as F;
}
