/**
 * Seeded 3D gradient noise (Perlin's improved noise) and fractal sums.
 *
 * Sample with planet directions (optionally scaled by a frequency), not
 * face UVs. The result is then continuous across cube-face seams.
 */
import type { Rng } from './rng';

export class Noise3 {
  private readonly perm = new Uint8Array(512);

  /** The permutation is shuffled from `r`. Pass a dedicated stream, e.g. rng(seed, "plates").fork("noise"). */
  constructor(r: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = r.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** The 512-entry permutation table (two copies of a 256 shuffle), e.g. for upload to the GPU. */
  get permutation(): Readonly<Uint8Array> {
    return this.perm;
  }

  /** Gradient noise in roughly [−1, 1]; 0 at integer lattice points. */
  noise(x: number, y: number, z: number): number {
    const p = this.perm;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    x -= fx;
    y -= fy;
    z -= fz;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = p[X] + Y;
    const AA = p[A] + Z;
    const AB = p[A + 1] + Z;
    const B = p[X + 1] + Y;
    const BA = p[B] + Z;
    const BB = p[B + 1] + Z;
    return lerp(
      w,
      lerp(
        v,
        lerp(u, grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z)),
        lerp(u, grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z)),
      ),
      lerp(
        v,
        lerp(u, grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1)),
        lerp(u, grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1)),
      ),
    );
  }

  /** Fractal Brownian motion, normalized to roughly [−1, 1]. */
  fbm(x: number, y: number, z: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      // Offset each octave so lattice zeros do not line up.
      sum += amp * this.noise(x * f + o * 17.31, y * f + o * 9.17, z * f + o * 3.71);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in roughly [0, 1]: sharp crests where the base noise crosses zero. */
  ridged(x: number, y: number, z: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let s = 1 - Math.abs(this.noise(x * f + o * 17.31, y * f + o * 9.17, z * f + o * 3.71));
      s *= s * weight;
      weight = Math.min(1, Math.max(0, s * 2));
      sum += amp * s;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
