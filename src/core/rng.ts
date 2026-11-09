/**
 * Deterministic random numbers.
 *
 * Every random draw in core, worldgen and sim comes from a named stream:
 *
 *     const r = rng(worldSeed, 'plates');
 *     r.nextFloat();
 *
 * A stream's state is derived from (world seed, stream name) alone. Streams
 * never share state, so adding, removing or reordering one generation stage
 * cannot change the output of another. Sub-streams come from `fork(name)`,
 * which derives from the *path* ("plates/retry-3"), not from the parent's
 * current position.
 *
 * Seeding uses SplitMix64, and streams use xoshiro128** (Blackman & Vigna).
 * Seeding is BigInt-based and runs once per stream; the stream itself uses
 * only 32-bit integer math and is fast.
 *
 * `Math.random()` is banned by lint in core, worldgen and sim.
 */

const MASK64 = (1n << 64n) - 1n;

/** A world seed as entered by a user or stored in a save: an integer, a bigint or any string. */
export type WorldSeed = number | bigint | string;

/** SplitMix64. Used only to expand seeds into stream state. */
export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK64;
  }

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  }
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const utf8 = new TextEncoder();

function fnv1a64Bytes(h: bigint, bytes: Uint8Array): bigint {
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * FNV64_PRIME) & MASK64;
  }
  return h;
}

/** FNV-1a 64-bit hash of a string's UTF-8 bytes. */
export function hashString64(s: string): bigint {
  return fnv1a64Bytes(FNV64_OFFSET, utf8.encode(s));
}

/**
 * Normalizes any seed representation to an unsigned 64-bit bigint.
 * Integers and digit-only strings map to their numeric value, so 12345 and
 * "12345" are the same world. Any other string is hashed.
 */
export function normalizeSeed(seed: WorldSeed): bigint {
  if (typeof seed === 'bigint') return BigInt.asUintN(64, seed);
  if (typeof seed === 'number') {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError(`World seed must be a safe integer, got ${seed}`);
    }
    return BigInt.asUintN(64, BigInt(seed));
  }
  const trimmed = seed.trim();
  if (/^\d+$/.test(trimmed)) return BigInt.asUintN(64, BigInt(trimmed));
  return hashString64(trimmed);
}

/** Mixes a normalized seed and a stream path into a 64-bit key. */
function streamKey(seed: bigint, path: string): bigint {
  const seedBytes = new Uint8Array(8);
  new DataView(seedBytes.buffer).setBigUint64(0, seed, true);
  // The 0xff separator cannot occur in UTF-8, so (seed, path) pairs never collide by concatenation.
  let h = fnv1a64Bytes(FNV64_OFFSET, seedBytes);
  h = fnv1a64Bytes(h, new Uint8Array([0xff]));
  return fnv1a64Bytes(h, utf8.encode(path));
}

function rotl32(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** xoshiro128**: 128-bit state, 32-bit output. Exported for known-answer tests. */
export class Xoshiro128ss {
  readonly s: Uint32Array;

  constructor(s0: number, s1: number, s2: number, s3: number) {
    this.s = new Uint32Array([s0, s1, s2, s3]);
    if ((s0 | s1 | s2 | s3) === 0) this.s[0] = 1; // The all-zero state is a fixed point.
  }

  /** Next value as an unsigned 32-bit integer. */
  next(): number {
    const s = this.s;
    const result = Math.imul(rotl32(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl32(s[3], 11);
    return result;
  }
}

const TWO_POW_32 = 4294967296;
const TWO_POW_53 = 9007199254740992;

/** A named, independent random stream. Create with `rng(seed, name)`. */
export class Rng {
  private readonly gen: Xoshiro128ss;

  /** @internal Use `rng()`. */
  constructor(
    /** Normalized world seed. */
    readonly seed: bigint,
    /** Full stream path, e.g. "plates" or "plates/retry-3". */
    readonly path: string,
  ) {
    const sm = new SplitMix64(streamKey(seed, path));
    const a = sm.next();
    const b = sm.next();
    this.gen = new Xoshiro128ss(
      Number(a & 0xffffffffn),
      Number(a >> 32n),
      Number(b & 0xffffffffn),
      Number(b >> 32n),
    );
  }

  /** Uniform unsigned 32-bit integer. */
  nextUint32(): number {
    return this.gen.next();
  }

  /** Uniform float in [0, 1) with 53 bits of precision. */
  nextFloat(): number {
    const hi = this.gen.next() >>> 5; // 27 bits
    const lo = this.gen.next() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / TWO_POW_53;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /** Uniform integer in [0, n), without modulo bias. Requires 1 <= n <= 2^32. */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
      throw new RangeError(`int(n) requires an integer 1 <= n <= 2^32, got ${n}`);
    }
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    for (;;) {
      const x = this.gen.next();
      if (x < limit) return x % n;
    }
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.nextFloat() < p;
  }

  /** Uniformly chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from an empty array');
    return items[this.int(items.length)];
  }

  /**
   * An independent sub-stream named `${path}/${name}`. The result depends only
   * on the seed and the path, never on how much of this stream was consumed.
   */
  fork(name: string): Rng {
    return new Rng(this.seed, `${this.path}/${name}`);
  }
}

/** Creates the named stream `name` for `worldSeed`. Same inputs, same sequence, always. */
export function rng(worldSeed: WorldSeed, name: string): Rng {
  return new Rng(normalizeSeed(worldSeed), name);
}
