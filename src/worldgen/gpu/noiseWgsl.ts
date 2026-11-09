/**
 * WGSL port of core/noise.ts: Perlin's improved noise, fBm and ridged
 * multifractal, with the same octave offsets, so GPU and CPU agree to float32
 * rounding (the self-tests check this).
 *
 * The including kernel declares the permutation storage as
 *   @group(0) @binding(k) var<storage, read> perm: array<u32>;
 * holding one or more 512-entry tables back to back (see packPermutations).
 * Every function takes `base`, the table's offset in that array, so one
 * kernel can draw from several independent streams.
 *
 * Perlin noise repeats with period 256 on each axis, so callers may reduce
 * large coordinates modulo 256 (on the CPU, in float64) without changing the
 * result. Detail tiles rely on this to keep float32 precision at high
 * frequencies.
 */
import type { Noise3 } from '../../core/noise';

export const PERMUTATION_SIZE = 512;

/** Packs permutation tables back to back. Table k starts at k · 512. */
export function packPermutations(noises: readonly Noise3[]): Uint32Array {
  const out = new Uint32Array(noises.length * PERMUTATION_SIZE);
  noises.forEach((n, k) => out.set(n.permutation, k * PERMUTATION_SIZE));
  return out;
}

export const NOISE_WGSL = /* wgsl */ `
fn nFade(t: vec3f) -> vec3f { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

fn nGrad(hash: u32, x: f32, y: f32, z: f32) -> f32 {
  let h = hash & 15u;
  let u = select(y, x, h < 8u);
  let v = select(select(z, x, h == 12u || h == 14u), y, h < 4u);
  return select(-u, u, (h & 1u) == 0u) + select(-v, v, (h & 2u) == 0u);
}

fn noise3(q: vec3f, base: u32) -> f32 {
  let fl = floor(q);
  let X = u32(i32(fl.x) & 255);
  let Y = u32(i32(fl.y) & 255);
  let Z = u32(i32(fl.z) & 255);
  let p = q - fl;
  let f = nFade(p);
  let A = perm[base + X] + Y;
  let AA = perm[base + A] + Z;
  let AB = perm[base + A + 1u] + Z;
  let B = perm[base + X + 1u] + Y;
  let BA = perm[base + B] + Z;
  let BB = perm[base + B + 1u] + Z;
  let x = p.x;
  let y = p.y;
  let z = p.z;
  return mix(
    mix(
      mix(nGrad(perm[base + AA], x, y, z), nGrad(perm[base + BA], x - 1.0, y, z), f.x),
      mix(nGrad(perm[base + AB], x, y - 1.0, z), nGrad(perm[base + BB], x - 1.0, y - 1.0, z), f.x),
      f.y),
    mix(
      mix(nGrad(perm[base + AA + 1u], x, y, z - 1.0), nGrad(perm[base + BA + 1u], x - 1.0, y, z - 1.0), f.x),
      mix(nGrad(perm[base + AB + 1u], x, y - 1.0, z - 1.0), nGrad(perm[base + BB + 1u], x - 1.0, y - 1.0, z - 1.0), f.x),
      f.y),
    f.z);
}

const OCTAVE_OFFSET: vec3f = vec3f(17.31, 9.17, 3.71);

fn fbm3(q: vec3f, base: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var f = 1.0;
  for (var o = 0; o < octaves; o++) {
    sum += amp * noise3(q * f + f32(o) * OCTAVE_OFFSET, base);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

fn ridged3(q: vec3f, base: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var f = 1.0;
  var weight = 1.0;
  for (var o = 0; o < octaves; o++) {
    var s = 1.0 - abs(noise3(q * f + f32(o) * OCTAVE_OFFSET, base));
    s *= s * weight;
    weight = clamp(s * 2.0, 0.0, 1.0);
    sum += amp * s;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}
`;
