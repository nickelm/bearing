/**
 * Emitters (Proposal 0011, decision 322): the sources that shed puffs, each an emitter preset
 * at a place, fixed or moving.
 *
 * - **How many.** A stream sheds puffs at its rate in time, and along a moving source's path
 *   at its spacing, whichever gives more; the fractions carry over between frames, so a
 *   stream's count does not depend on the frame rate.
 * - **Where.** A puff due part way through the frame is born at the matching point between
 *   the source's last place and this one, already that much older: a missile at 1,000 m/s
 *   leaves an even chain of balls, not clumps a frame apart.
 * - **Distance.** Beyond `LOD_NEAR` a stream's spacing and puff size both grow with the square
 *   root of the distance and its rate falls by it, so a far column keeps its shape with
 *   fewer, larger puffs. Beyond its preset's range an emitter sheds nothing.
 * - **Prewarm.** A long-lived column that comes into range (or is made) fills its whole
 *   length at once: puffs of every age, placed where the air would have carried them.
 * - **Budget.** Every rate is scaled by the pool's pressure (`PuffPool.rateScale`).
 */
import { Vec3d } from '../../../core/vec3d';
import type { PuffSpawn } from './pool';
import { FAN, fan } from './puffModel';
import { LOOK_INDEX, LOOKS } from './presets';
import type { EmitterPreset, Stream } from './presets';

/** Distance (m) from the camera within which emitters shed at full detail. */
export const LOD_NEAR = 3000;
/** The farthest a stream's spacing and size grow. */
const LOD_MAX = 4;

/** mulberry32: the effects' own seeded random numbers, so screenshots repeat. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How a stream's spacing and size grow, and its rate falls, at a distance (m). */
export function lodFactor(distance: number): number {
  return Math.min(LOD_MAX, Math.max(1, Math.sqrt(distance / LOD_NEAR)));
}

/** What an emitter needs to know of its source each frame. */
export interface EmitterSource {
  /** Where it is (world, m). */
  pos: Readonly<Vec3d>;
  /** How it moves (world, m/s). */
  vel?: Readonly<Vec3d>;
  /** Which way it points (unit, world); its motion's direction if unset. */
  dir?: Readonly<Vec3d>;
  /** Multiplies the looks' colors (downwash dust takes the ground's color). */
  tint?: readonly [number, number, number];
  /** Scales sizes, speeds and spacing (a rotor's radius, a fire's size). */
  scale?: number;
  /** Scales rates (a wash's strength, a fire's intensity), 0..1 or more. */
  strength?: number;
  /** Look to use in place of each stream's first look (downwash: dust, snow or spray). */
  look?: (typeof LOOKS)[number]['id'];
  /** Distance from the planet's center of the ground below (m). */
  floor: number;
}

/** A due puff, before the system makes it relative to the anchor. */
export interface WorldSpawn extends Omit<PuffSpawn, 'pos'> {
  pos: Vec3d;
}

export class Emitter {
  /** Effect time it was made, and how long it runs on its own (Infinity: while kept). */
  readonly born: number;
  readonly until: number;
  /** Last time its owner touched it (for `stale`). */
  touched: number;
  source: EmitterSource;
  /** Whether it was in range last frame (prewarm when it comes back). */
  inRange = false;
  private prev: Vec3d | null = null;
  private readonly carry: number[];
  private readonly rand: () => number;

  constructor(
    readonly key: string,
    readonly preset: EmitterPreset,
    source: EmitterSource,
    now: number,
    seed: number,
  ) {
    this.source = source;
    this.born = now;
    this.touched = now;
    this.rand = seededRandom(seed);
    const d = preset.duration;
    this.until = d ? now + d[0] + (d[1] - d[0]) * this.rand() : Infinity;
    this.carry = preset.streams.map(() => this.rand());
  }

  /** Moves the source (each frame for a moving one). */
  set(source: EmitterSource, now: number): void {
    this.source = source;
    this.touched = now;
  }

  /** The look a stream sheds. */
  private lookOf(s: Stream, index: number): number {
    return LOOK_INDEX[index === 0 && this.source.look ? this.source.look : s.look];
  }

  /**
   * The puffs due over a frame of `dt` ending at effect time `now`, seen from `eye`, with
   * the pool's rate scale. Pushes them to `out`.
   */
  emit(
    dt: number,
    now: number,
    eye: Readonly<Vec3d>,
    rateScale: number,
    wind: Readonly<Vec3d>,
    out: WorldSpawn[],
  ): void {
    const src = this.source;
    const distance = src.pos.distanceTo(eye);
    const inRange = distance <= this.preset.range;
    const came = inRange && !this.inRange;
    this.inRange = inRange;
    if (!inRange || now >= this.until) {
      this.prev = null;
      return;
    }
    if (came && this.preset.prewarm) this.prewarm(distance, now, rateScale, wind, out);
    const prev = this.prev ?? src.pos;
    const path = prev.distanceTo(src.pos);
    this.prev = src.pos.clone();
    const f = lodFactor(distance);
    const scale = src.scale ?? 1;
    const strength = src.strength ?? 1;
    this.preset.streams.forEach((s, si) => {
      const rate = (s.rate * strength * rateScale) / f;
      const byTime = rate * dt;
      const byPath = s.spacing > 0 ? (path * rateScale) / (s.spacing * scale * f) : 0;
      this.carry[si]! += Math.max(byTime, byPath);
      let n = Math.floor(this.carry[si]!);
      this.carry[si]! -= n;
      n = Math.min(n, 512);
      for (let j = 0; j < n; j++) {
        if (s.chance !== undefined && this.rand() > s.chance) continue;
        // Evenly through the frame, the latest at the source now.
        const k = n === 1 ? 1 : (j + 1) / n;
        const pos = prev.clone().addScaled(src.pos.clone().sub(prev), k);
        out.push(this.puff(s, si, pos, (1 - k) * dt, f, scale));
      }
    });
  }

  /** One puff of stream `s` at `pos`, `age` old. */
  private puff(
    s: Stream,
    si: number,
    pos: Vec3d,
    age: number,
    f: number,
    scale: number,
  ): WorldSpawn {
    const src = this.source;
    const r = this.rand;
    const up = pos.clone().normalize();
    const dir = src.dir ?? (src.vel && src.vel.length() > 0.1 ? src.vel.clone().normalize() : up);
    const v = new Vec3d(r() - 0.5, r() - 0.5, r() - 0.5);
    const len = v.length() || 1;
    const spread = v.scale((s.spread * scale) / len);
    const vel = dir
      .clone()
      .scale(s.speed * scale)
      .addScaled(up, s.up * scale)
      .add(spread);
    if (src.vel) vel.addScaled(src.vel, s.inherit);
    if (s.radial) {
      // Out across the ground in any direction (a rotor's wall jet).
      const t = new Vec3d(0, 1, 0).cross(up);
      if (t.length() < 1e-6) t.set(1, 0, 0);
      t.normalize();
      const b = up.clone().cross(t);
      const a = r() * 2 * Math.PI;
      const sp = s.radial * Math.sqrt(scale) * (0.6 + 0.6 * r());
      vel.addScaled(t, Math.cos(a) * sp).addScaled(b, Math.sin(a) * sp);
      pos.addScaled(t, Math.cos(a) * scale * 0.6).addScaled(b, Math.sin(a) * scale * 0.6);
    }
    if (s.jitter > 0) {
      const j = new Vec3d(r() - 0.5, r() - 0.5, r() - 0.5).scale(2 * s.jitter * scale);
      pos.add(j);
    }
    // At the ground a puff starts on it, not in it.
    const size = (s.size[0] + (s.size[1] - s.size[0]) * r()) * scale * (si === 0 ? f : 1);
    const look = this.lookOf(s, si);
    const L = LOOKS[look]!;
    const life = L.life[0] + (L.life[1] - L.life[0]) * r();
    pos.addScaled(up, Math.max(0, src.floor + size * 0.3 - pos.length()));
    return {
      pos,
      vel: [vel.x, vel.y, vel.z],
      life,
      look,
      size,
      seed: r() * 64,
      floor: src.floor,
      tint: src.tint,
      age,
    };
  }

  /** Fills a column to its full length (see the module comment). */
  private prewarm(
    distance: number,
    now: number,
    rateScale: number,
    wind: Readonly<Vec3d>,
    out: WorldSpawn[],
  ): void {
    const src = this.source;
    const f = lodFactor(distance);
    const scale = src.scale ?? 1;
    const strength = src.strength ?? 1;
    const up = src.pos.clone().normalize();
    // How long it has been burning, as far as anyone can see.
    const burnt = Math.max(0, now - this.born);
    this.preset.streams.forEach((s, si) => {
      const look = LOOKS[this.lookOf(s, si)]!;
      const span = Math.min(look.life[1], Math.max(burnt, look.life[1]));
      const rate = (s.rate * strength * rateScale) / f;
      const n = Math.min(600, Math.floor(rate * span));
      for (let j = 0; j < n; j++) {
        const age = (j + this.rand()) / rate;
        const p = this.puff(s, si, src.pos.clone(), 0, f, scale);
        const life = Math.max(p.life, age + 0.5);
        // Carried as `puffModel` would: rising at its speed, drifting with the wind.
        const rise =
          look.riseSpeed * age * 0.75 + s.up * scale * Math.min(age, 1 / Math.max(look.drag, 0.1));
        const drift = Math.min(1, look.wind) * age * 0.8;
        const d = fan(p.seed);
        const spread = look.turbulence * FAN * age * 0.8;
        p.pos.addScaled(up, rise).addScaled(wind, drift);
        p.pos.x += d[0] * spread;
        p.pos.y += d[1] * spread;
        p.pos.z += d[2] * spread;
        out.push({ ...p, life, age });
      }
    });
  }
}
