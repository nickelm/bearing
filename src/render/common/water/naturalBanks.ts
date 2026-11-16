/**
 * Natural banks on the CPU (decision 167, 176): the same bank noise the river
 * shader draws (`riverShading.ts`), for what must keep out of the drawn water:
 * the trees along and near rivers. The functions mirror the TSL line for line
 * (value noise on a mod-289 lattice hash, octave bands blended by width), in
 * float64 where the shader works in float32, which moves a bank by millimeters.
 *
 * The shader evaluates the noise at the fragment's planet-centered position,
 * terrain height included; callers pass the same: the unit direction times the
 * radius plus the ground's height.
 */
import type { Vec3d } from '../../../core/vec3d';

/**
 * Bank noise: amplitudes as shares of the half-width, wavelengths in
 * half-widths (see riverShading.ts, which reads these).
 */
export const NATURAL_BANKS = {
  /** Sideways wander: swing (share of the half-width, at most `wanderMax` m), wavelength. */
  wander: 4,
  wanderMax: 40,
  wanderWavelength: 20,
  /** Swelling and narrowing of the width. */
  swell: 0.6,
  swellWavelength: 12,
  /** Ragged edges, two octaves. */
  rough: 0.35,
  roughWavelength: 3,
  fine: 0.18,
  fineWavelength: 1,
};

function permute(x: number): number {
  return ((x * 34 + 1) * x) % 289;
}

function latticeHash(x: number, y: number, z: number): number {
  const m = (v: number) => v - Math.floor(v / 289) * 289;
  return permute(permute(permute(m(x)) + m(y)) + m(z)) / 289;
}

/** Value noise in [-1, 1] at planet-centered (x, y, z) m on a lattice of `cell` m. */
export function bankNoise(x: number, y: number, z: number, cell: number, salt: number): number {
  const qx = x / cell + salt * 17.13;
  const qy = y / cell + salt * 31.7;
  const qz = z / cell + salt * 7.31;
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const iz = Math.floor(qz);
  const fx = qx - ix;
  const fy = qy - iy;
  const fz = qz - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const at = (dx: number, dy: number, dz: number) => latticeHash(ix + dx, iy + dy, iz + dz);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const x00 = mix(at(0, 0, 0), at(1, 0, 0), ux);
  const x10 = mix(at(0, 1, 0), at(1, 1, 0), ux);
  const x01 = mix(at(0, 0, 1), at(1, 0, 1), ux);
  const x11 = mix(at(0, 1, 1), at(1, 1, 1), ux);
  return mix(mix(x00, x10, uy), mix(x01, x11, uy), uz) * 2 - 1;
}

/** Noise at wavelength `lambda` (m): the two power-of-two octaves around it, blended. */
export function bandNoise(x: number, y: number, z: number, lambda: number, salt: number): number {
  const b = Math.log2(Math.max(lambda, 1));
  const lo = 2 ** Math.floor(b);
  const f = b - Math.floor(b);
  return bankNoise(x, y, z, lo, salt) * (1 - f) + bankNoise(x, y, z, lo * 2, salt + 1) * f;
}

/**
 * The drawn bank's displacement at planet-centered (x, y, z) for a river of
 * half-width `half` (m): the centerline's sideways offset (m, toward the side
 * whose signed distance is positive), the width's factor, and the ragged edge
 * (m, added to the distance from the moved centerline) at full strength, as the
 * shader draws it near the camera.
 */
export function naturalBank(
  x: number,
  y: number,
  z: number,
  half: number,
): { offset: number; swell: number; rough: number } {
  const N = NATURAL_BANKS;
  const wander =
    bandNoise(x, y, z, half * N.wanderWavelength, 0) * 0.75 +
    bandNoise(x, y, z, half * (N.wanderWavelength / 2.3), 12) * 0.35;
  return {
    offset: Math.min(half * N.wander, N.wanderMax) * wander,
    swell: 1 + N.swell * bandNoise(x, y, z, half * N.swellWavelength, 3),
    rough:
      half *
      (bandNoise(x, y, z, half * N.roughWavelength, 6) * N.rough +
        bandNoise(x, y, z, half * N.fineWavelength, 9) * N.fine),
  };
}

/** A river segment for `waterDistance`: unit directions of its ends and its width (m). */
export interface WaterStretch {
  a: Vec3d;
  b: Vec3d;
  width: number;
}

/**
 * Signed distance (m) from unit direction `p` at ground height `h` to the
 * nearest drawn river water among `stretches`: negative inside. The lesser of
 * the natural banks and the smooth ones, since a distant river is drawn smooth
 * (with `smooth` false, the natural banks alone, as the shader draws them close up).
 * The nearest river is chosen as the shader does, by the distance to its bank.
 */
export function waterDistance(
  stretches: readonly WaterStretch[],
  p: Readonly<Vec3d>,
  h: number,
  radius: number,
  smooth = true,
): number {
  let best = Infinity;
  let signed = 0;
  let half = 0;
  for (const s of stretches) {
    const abx = s.b.x - s.a.x;
    const aby = s.b.y - s.a.y;
    const abz = s.b.z - s.a.z;
    const px = p.x - s.a.x;
    const py = p.y - s.a.y;
    const pz = p.z - s.a.z;
    const l2 = abx * abx + aby * aby + abz * abz;
    const t = l2 > 1e-30 ? Math.min(1, Math.max(0, (px * abx + py * aby + pz * abz) / l2)) : 0;
    const ox = px - t * abx;
    const oy = py - t * aby;
    const oz = pz - t * abz;
    const d = Math.sqrt(ox * ox + oy * oy + oz * oz) * radius;
    const hw = s.width / 2;
    if (d - hw >= best) continue;
    best = d - hw;
    // The side: the offset against the segment's sideways direction ua × ab.
    const cx = s.a.y * abz - s.a.z * aby;
    const cy = s.a.z * abx - s.a.x * abz;
    const cz = s.a.x * aby - s.a.y * abx;
    signed = ox * cx + oy * cy + oz * cz >= 0 ? d : -d;
    half = hw;
  }
  if (best === Infinity) return Infinity;
  // Farther from the smooth bank than the noise can move it (its bands stay within
  // about ±0.6): no need to evaluate it.
  const N = NATURAL_BANKS;
  const reach =
    0.6 * (Math.min(half * N.wander, N.wanderMax) * 1.1 + half * (N.swell + N.rough + N.fine));
  if (smooth && best > reach + 1) return best;
  const r = radius + h;
  const bank = naturalBank(p.x * r, p.y * r, p.z * r, half);
  const natural = Math.abs(signed - bank.offset) - bank.rough - half * bank.swell;
  return smooth ? Math.min(best, natural) : natural;
}
