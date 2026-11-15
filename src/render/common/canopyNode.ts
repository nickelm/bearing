/**
 * The canopy height field in TSL (decision 148): the twin of
 * `worldgen/canopy.ts`, with the same integer hash in 32-bit unsigned
 * arithmetic, so a shader picks the same stands as the CPU. `tests/gpu/canopy`
 * checks the two against each other.
 *
 * Positions are points on the sea-level sphere (the unit direction times the
 * planet radius, m), which float32 holds to about 0.1 m on a planet of
 * 1,000 km: stands and lumps do not shift with height or exaggeration.
 */
import type { Node } from 'three/webgpu';
import { Fn, float, floor, ivec3, select, smoothstep, uint, vec3, vec4 } from 'three/tsl';
import {
  LUMP,
  LUMP_CELL,
  SEED_LUMP,
  SEED_SHADE,
  SEED_SITE,
  SEED_STAND,
  STAND_CELL,
  STAND_HEIGHTS,
  STAND_SHADE,
  YOUNG_HEIGHT,
  YOUNG_SHARE,
} from '../../worldgen/canopy';

type F = Node<'float'>;
type U = Node<'uint'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;
type I3 = Node<'ivec3'>;

const imul = (a: U, k: number) => a.mul(uint(k >>> 0)) as U;

/**
 * `cellHash` of worldgen/canopy.ts: an unsigned 32-bit hash of a lattice cell
 * and a seed. Inlined: call it inside a `Fn`. (Pass an ivec3: `.toInt()` on a
 * vector converts it to a scalar.)
 */
export function cellHashNode(c: I3, seed: U): U {
  const v = ivec3(c).toVar();
  const h = imul(uint(v.x), 0x8da6b343)
    .bitXor(imul(uint(v.y), 0xd8163841))
    .bitXor(imul(uint(v.z), 0xcb1ab31f))
    .bitXor(seed)
    .toVar();
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  h.assign(imul(h as unknown as U, 0x7feb352d));
  h.assign(h.bitXor(h.shiftRight(uint(15))));
  h.assign(imul(h as unknown as U, 0x846ca68b));
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  return h as unknown as U;
}

/** `hashBits`: ten bits of a hash from bit `shift`, as [0, 1]. */
export function hashBitsNode(h: U, shift: number): F {
  return float(h.shiftRight(uint(shift)).bitAnd(uint(1023))).div(1023) as F;
}

const seeded = (seed: U, k: number) => seed.bitXor(uint(k)) as U;

/**
 * The stand at sea-level point `p` given the conifer and tropical shares:
 * vec4(mature height m, conifer 0/1, shade, stand hash's low 24 bits / 2²⁴).
 */
export const standNode = Fn(([p, conifer, tropical, seed]: [V3, F, F, U]) => {
  const q = p.div(STAND_CELL);
  const i = ivec3(floor(q)).toVar();
  const f = q.sub(floor(q)).toVar();
  const best = float(1e9).toVar();
  const cell = ivec3(i).toVar();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = i.add(ivec3(dx, dy, dz));
        const h = cellHashNode(c as I3, seeded(seed, SEED_SITE));
        const r = vec3(
          float(dx).add(hashBitsNode(h, 0).mul(0.8)).add(0.1),
          float(dy).add(hashBitsNode(h, 10).mul(0.8)).add(0.1),
          float(dz).add(hashBitsNode(h, 20).mul(0.8)).add(0.1),
        ).sub(f);
        const d = r.dot(r);
        cell.assign(select(d.lessThan(best), c, cell));
        best.assign(select(d.lessThan(best), d, best));
      }
    }
  }
  const h = cellHashNode(cell as unknown as I3, seeded(seed, SEED_STAND)).toVar();
  const isConifer = select(hashBitsNode(h, 0).lessThan(conifer), float(1), float(0));
  const age = hashBitsNode(h, 10);
  const mature = select(
    isConifer.greaterThan(0.5),
    age.mul(STAND_HEIGHTS.conifer[1]).add(STAND_HEIGHTS.conifer[0]),
    age.mul(STAND_HEIGHTS.broadleaf[1]).add(STAND_HEIGHTS.broadleaf[0]),
  );
  const tall = age.mul(STAND_HEIGHTS.tropical[1]).add(STAND_HEIGHTS.tropical[0]);
  const height = mature.add(tall.sub(mature).mul(tropical));
  const young = select(hashBitsNode(h, 20).lessThan(YOUNG_SHARE), float(YOUNG_HEIGHT), float(1));
  const shadeHash = cellHashNode(cell as unknown as I3, seeded(seed, SEED_SHADE));
  const shade = hashBitsNode(shadeHash, 0).mul(STAND_SHADE[1]).add(STAND_SHADE[0]);
  return vec4(height.mul(young), isConifer, shade, float(h.bitAnd(uint(0xffffff))).div(2 ** 24));
}) as unknown as (p: V3, conifer: F, tropical: F, seed: U) => V4;

/** `canopyLump`: value noise in [-1, 1] on a lattice of LUMP_CELL m. */
export const lumpNode = Fn(([p, seed]: [V3, U]) => {
  const q = p.div(LUMP_CELL);
  const i = ivec3(floor(q)).toVar();
  const t = q.sub(floor(q));
  const u = t.mul(t).mul(t.mul(-2).add(3)).toVar();
  const s = seeded(seed, SEED_LUMP);
  const at = (dx: number, dy: number, dz: number) =>
    hashBitsNode(cellHashNode(i.add(ivec3(dx, dy, dz)) as I3, s), 0);
  const lerp = (a: F, b: F, k: F) => a.add(b.sub(a).mul(k)) as F;
  const x0 = lerp(
    lerp(at(0, 0, 0), at(1, 0, 0), u.x as F),
    lerp(at(0, 1, 0), at(1, 1, 0), u.x as F),
    u.y as F,
  );
  const x1 = lerp(
    lerp(at(0, 0, 1), at(1, 0, 1), u.x as F),
    lerp(at(0, 1, 1), at(1, 1, 1), u.x as F),
    u.y as F,
  );
  return lerp(x0, x1, u.z as F)
    .mul(2)
    .sub(1);
}) as unknown as (p: V3, seed: U) => F;

/** The stand's canopy top with lumps (m), as `standTop`. */
export function standTopNode(stand: V4, p: V3, seed: U): F {
  return stand.x.mul(lumpNode(p, seed).mul(LUMP).add(1)) as F;
}

/** Conifer and tropical shares at an annual mean temperature (°C), as `coniferShare`, `tropicalShare`. */
export function sharesNode(meanT: F): { conifer: F; tropical: F } {
  return {
    conifer: smoothstep(9, 3, meanT) as F,
    tropical: smoothstep(18, 24, meanT) as F,
  };
}
