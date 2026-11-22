/**
 * The CPU side of the puff pool (Proposal 0011, decision 321): which slot a new puff takes,
 * when each slot's puff dies, how many live, and the staging records the spawn kernel copies
 * into the GPU's buffers each frame.
 *
 * Free slots are kept on a stack, refilled once a frame from the slots whose puffs have died,
 * lowest slot on top, so the pool stays packed at its low end and the draw's instance count
 * (the high-water mark) stays near the live count. A motor's short-lived core puffs never
 * push out a trail's long-lived ones. When no slot is free, the slot whose puff dies soonest
 * gives way. The governor (`rateScale`) tells emitters to shed fewer puffs before that.
 */

/** Puffs the pool holds (the proposal's budget). */
export const POOL_CAPACITY = 20_000;
/** Puffs that can be born in one frame. */
export const SPAWN_CAPACITY = 4096;
/** Share of the pool alive at which the governor starts to scale emitters' rates down. */
export const GOVERNOR_START = 0.6;
/** Floats per staging record: four vec4. */
export const SPAWN_FLOATS = 16;

/** A new puff, as the spawn kernel takes it. Positions are relative to the pool's anchor. */
export interface PuffSpawn {
  pos: readonly [number, number, number];
  vel: readonly [number, number, number];
  life: number;
  look: number;
  size: number;
  seed: number;
  /** Distance from the planet's center of the ground below (m). */
  floor: number;
  tint?: readonly [number, number, number];
  /** Age at birth (s): a puff born part way through the frame, or a prewarmed column's. */
  age?: number;
}

export class PuffPool {
  /** Staging records: (pos, slot), (vel, life), (look, size, seed, floor), (tint, age). */
  readonly staging = new Float32Array(SPAWN_CAPACITY * SPAWN_FLOATS);
  /** Records staged this frame. */
  pending = 0;
  /** One past the highest slot ever used: the draw's instance count. */
  highWater = 0;
  /** Puffs refused this frame for want of staging room. */
  refused = 0;
  /** Live puffs dropped because the pool was full. */
  overwritten = 0;
  private readonly death: Float64Array;
  /** Free slots, the lowest on top (at the end). */
  private readonly free: Int32Array;
  private freeCount = 0;
  private readonly isFree: Uint8Array;

  constructor(readonly capacity = POOL_CAPACITY) {
    this.death = new Float64Array(capacity).fill(-Infinity);
    this.free = new Int32Array(capacity);
    this.isFree = new Uint8Array(capacity);
    this.reclaim(0);
  }

  /** Puts every slot whose puff has died by `now` back on the free stack (once a frame). */
  reclaim(now: number): void {
    let n = 0;
    for (let i = this.capacity - 1; i >= 0; i--) {
      if (this.death[i]! <= now) {
        this.free[n++] = i;
        this.isFree[i] = 1;
      } else this.isFree[i] = 0;
    }
    this.freeCount = n;
    // The high-water mark falls back when the top of the pool has emptied.
    let hw = this.highWater;
    while (hw > 0 && this.death[hw - 1]! <= now) hw--;
    this.highWater = hw;
  }

  /** The slot a new puff takes: the lowest free one, else the one that dies soonest. */
  private take(now: number): number {
    while (this.freeCount > 0) {
      const slot = this.free[--this.freeCount]!;
      if (this.isFree[slot]) {
        this.isFree[slot] = 0;
        return slot;
      }
    }
    this.overwritten++;
    let best = 0;
    let soonest = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      const d = this.death[i]!;
      if (d < soonest) {
        soonest = d;
        best = i;
        if (d <= now) break;
      }
    }
    return best;
  }

  /** Stages a puff born at effect time `now`; false if this frame's staging is full. */
  spawn(p: PuffSpawn, now: number): boolean {
    if (this.pending >= SPAWN_CAPACITY) {
      this.refused++;
      return false;
    }
    const slot = this.take(now);
    const age = p.age ?? 0;
    this.death[slot] = now + p.life - age;
    if (slot + 1 > this.highWater) this.highWater = slot + 1;
    const o = this.pending * SPAWN_FLOATS;
    const s = this.staging;
    s[o] = p.pos[0];
    s[o + 1] = p.pos[1];
    s[o + 2] = p.pos[2];
    s[o + 3] = slot;
    s[o + 4] = p.vel[0];
    s[o + 5] = p.vel[1];
    s[o + 6] = p.vel[2];
    s[o + 7] = p.life;
    s[o + 8] = p.look;
    s[o + 9] = p.size;
    s[o + 10] = p.seed;
    s[o + 11] = p.floor;
    const tint = p.tint ?? [1, 1, 1];
    s[o + 12] = tint[0];
    s[o + 13] = tint[1];
    s[o + 14] = tint[2];
    s[o + 15] = age;
    this.pending++;
    return true;
  }

  /** Puffs alive at effect time `now`. */
  live(now: number): number {
    let n = 0;
    const d = this.death;
    for (let i = 0; i < this.highWater; i++) if (d[i]! > now) n++;
    return n;
  }

  /**
   * How full the pool is, 0..1, as the governor reads it: emitters shed puffs at
   * `rateScale(live)` of their rate.
   */
  rateScale(live: number): number {
    const f = live / this.capacity;
    if (f <= GOVERNOR_START) return 1;
    return Math.max(0.15, 1 - (0.85 * (f - GOVERNOR_START)) / (1 - GOVERNOR_START));
  }

  /** After the spawn kernel has taken the staged records. */
  flush(): void {
    this.pending = 0;
    this.refused = 0;
  }

  /** Every puff dies at once (a cut). */
  clear(): void {
    this.death.fill(-Infinity);
    this.pending = 0;
    this.reclaim(0);
  }

  /** Every slot that is live at `now`. For tests. */
  liveSlots(now: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.highWater; i++) if (this.death[i]! > now) out.push(i);
    return out;
  }
}
