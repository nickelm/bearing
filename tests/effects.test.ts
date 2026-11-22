/**
 * The stylized effects' CPU side (Proposal 0011, decisions 320–326): life curves, the puff
 * model's forces, the pool's slots and governor, emitters' counts, spacing and distance
 * detail, explosion recipes, ribbons' conditions and the effect event queue.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import {
  curveTable,
  readTable,
  sampleCurve,
  CURVE_SAMPLES,
} from '../src/render/sim/effects/curves';
import { Emitter, lodFactor, LOD_NEAR, seededRandom } from '../src/render/sim/effects/emitters';
import type { WorldSpawn } from '../src/render/sim/effects/emitters';
import { POOL_CAPACITY, PuffPool, SPAWN_CAPACITY } from '../src/render/sim/effects/pool';
import { stepPuff, type PuffState, SINK } from '../src/render/sim/effects/puffModel';
import { bayer4, radiusBump } from '../src/render/sim/effects/puffMaterial';
import {
  BLAST_PRESETS,
  EMITTERS,
  explosionRecipe,
  LOOK_IDS,
  LOOK_INDEX,
  LOOKS,
  lookMotion,
  PRESET_IDS,
  trailPreset,
} from '../src/render/sim/effects/presets';
import { contrailAltitude, contrailForms, vortexForms } from '../src/render/sim/effects/ribbons';
import { EffectQueue } from '../src/sim/effects/events';
import type { EffectEvent } from '../src/sim/effects/events';

const R = 1_000_000;
const curves = curveTable(LOOKS);
const motion = lookMotion(LOOKS);

function puff(look: string, o: Partial<PuffState> = {}): PuffState {
  const i = LOOK_INDEX[look as keyof typeof LOOK_INDEX];
  return {
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    age: 0,
    life: LOOKS[i]!.life[1],
    look: i,
    size: 3,
    seed: 1.5,
    floor: R,
    tint: [1, 1, 1],
    radius: 0,
    color: [0, 0, 0],
    glow: 0,
    coverage: 1,
    ...o,
  };
}

/** Steps a puff `seconds` at 60 Hz, 300 m over the ground at the pole, in a wind. */
function run(s: PuffState, seconds: number, wind: [number, number, number] = [0, 0, 0]): PuffState {
  const anchor: [number, number, number] = [0, R + 300, 0];
  for (let t = 0; t < seconds; t += 1 / 60) {
    stepPuff(s, { dt: 1 / 60, time: t, wind, anchor, shift: [0, 0, 0] }, curves, motion);
  }
  return s;
}

describe('life curves', () => {
  it('reads keys piecewise linearly and clamps at the ends', () => {
    const c = [
      [0, 1],
      [0.5, 3],
      [1, 0],
    ] as const;
    expect(sampleCurve(c, -1)).toBe(1);
    expect(sampleCurve(c, 0.25)).toBeCloseTo(2);
    expect(sampleCurve(c, 0.75)).toBeCloseTo(1.5);
    expect(sampleCurve(c, 2)).toBe(0);
  });

  it('puts every look in the table and reads it back between samples', () => {
    expect(curves.length).toBe(LOOKS.length * CURVE_SAMPLES * 2 * 4);
    for (const [i, l] of LOOKS.entries()) {
      for (const t of [0, 0.33, 0.8, 1]) {
        expect(readTable(curves, i, t, 1)[0]).toBeCloseTo(sampleCurve(l.radius, t), 1);
      }
    }
  });

  it('swells smoke fast and shrinks it away at the end', () => {
    const l = LOOKS[LOOK_INDEX['motor-smoke']]!;
    expect(sampleCurve(l.radius, 0.02)).toBeGreaterThan(0.9);
    expect(sampleCurve(l.radius, 0.6)).toBeGreaterThan(sampleCurve(l.radius, 0.05));
    expect(sampleCurve(l.radius, 1)).toBeLessThan(0.5);
  });

  it('cools fire from yellow through orange and red to dark gray', () => {
    const f = LOOKS[LOOK_INDEX.fireball]!;
    const at = (t: number) => readTable(curves, LOOK_INDEX.fireball, t, 0);
    expect(at(0)[1]).toBeGreaterThan(at(0.4)[1]); // green falls: yellow to red
    expect(at(0)[3]).toBeGreaterThan(1); // it glows
    expect(at(1)[3]).toBe(0); // and ends as smoke
    expect(Math.max(...at(1).slice(0, 3))).toBeLessThan(0.15);
    expect(f.glow.length).toBeGreaterThan(1);
  });
});

describe('the puff model', () => {
  it('rises at its look rise speed in still air', () => {
    const s = run(puff('column-black'), 4);
    const rise = s.pos[1];
    expect(rise).toBeGreaterThan(10);
    expect(rise).toBeLessThan(40);
  });

  it('drifts with the wind and slows to it from a fast throw', () => {
    const s = run(puff('dirt', { vel: [0, 0, 60] }), 8, [6, 0, 0]);
    expect(s.vel[0]).toBeGreaterThan(3);
    expect(Math.abs(s.vel[2])).toBeLessThan(6);
    expect(s.pos[0]).toBeGreaterThan(10);
  });

  it('falls when its rise speed is negative (spray) and never sinks below half its radius', () => {
    // Thrown up, it climbs, stops and comes down.
    const up = run(puff('spray', { pos: [0, -295, 0], vel: [0, 20, 0], life: 9 }), 4);
    expect(up.pos[1] + 300).toBeGreaterThan(15);
    expect(up.vel[1]).toBeLessThan(0);
    // Thrown down, it stops at the ground.
    const down = run(puff('spray', { pos: [0, -295, 0], vel: [0, -20, 0], life: 9 }), 2);
    expect(down.pos[1] + 300).toBeGreaterThanOrEqual(down.radius * SINK - 1e-6);
    expect(down.pos[1] + 300).toBeLessThan(1);
  });

  it('dies at the end of its life: radius and coverage zero', () => {
    const s = run(puff('flash'), 0.5);
    expect(s.radius).toBe(0);
    expect(s.coverage).toBe(0);
  });

  it('moves with the floating origin', () => {
    const s = puff('chimney', { pos: [10, 20, 30] });
    stepPuff(
      s,
      { dt: 0, time: 0, wind: [0, 0, 0], anchor: [0, R, 0], shift: [-5, 1, 2] },
      curves,
      motion,
    );
    expect(s.pos).toEqual([5, 21, 32]);
  });
});

describe('the pool', () => {
  it('takes the lowest free slot and reclaims dead ones', () => {
    const p = new PuffPool(8);
    const one = (life: number) =>
      p.spawn({ pos: [0, 0, 0], vel: [0, 0, 0], life, look: 0, size: 1, seed: 0, floor: 0 }, 0);
    for (const l of [1, 10, 1, 10]) one(l);
    expect(p.highWater).toBe(4);
    expect(p.live(0.5)).toBe(4);
    p.reclaim(2);
    expect(p.live(2)).toBe(2);
    one(5);
    expect(p.liveSlots(2)).toEqual([0, 1, 3]);
  });

  it('gives the slot that dies soonest when full, and counts it', () => {
    const p = new PuffPool(3);
    for (const life of [9, 2, 7])
      p.spawn({ pos: [0, 0, 0], vel: [0, 0, 0], life, look: 0, size: 1, seed: 0, floor: 0 }, 0);
    p.reclaim(1);
    p.spawn({ pos: [0, 0, 0], vel: [0, 0, 0], life: 5, look: 0, size: 1, seed: 0, floor: 0 }, 1);
    expect(p.overwritten).toBe(1);
    expect(p.staging[3 * 16 + 3]).toBe(1);
  });

  it('refuses more than a frame of staging and scales rates as it fills', () => {
    const p = new PuffPool(POOL_CAPACITY);
    let ok = 0;
    for (let i = 0; i < SPAWN_CAPACITY + 10; i++)
      if (
        p.spawn({ pos: [0, 0, 0], vel: [0, 0, 0], life: 9, look: 0, size: 1, seed: 0, floor: 0 }, 0)
      )
        ok++;
    expect(ok).toBe(SPAWN_CAPACITY);
    expect(p.refused).toBe(10);
    expect(p.rateScale(0.5 * POOL_CAPACITY)).toBe(1);
    expect(p.rateScale(0.8 * POOL_CAPACITY)).toBeLessThan(1);
    expect(p.rateScale(POOL_CAPACITY)).toBeGreaterThan(0.1);
  });
});

describe('emitters', () => {
  const at = new Vec3d(0, R, 0);
  const near = new Vec3d(0, R + 100, 300);

  it('sheds a fixed source at its rate regardless of the frame rate', () => {
    const count = (fps: number) => {
      const e = new Emitter('c', EMITTERS.chimney!, { pos: at, floor: R }, 0, 1);
      const out: WorldSpawn[] = [];
      for (let t = 0; t < 10; t += 1 / fps) e.emit(1 / fps, t, near, 1, new Vec3d(), out);
      return out.length;
    };
    // 0.6 a second for 10 s, plus the prewarm's column.
    const a = count(30);
    const b = count(144);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
  });

  it('lays a moving source along its path at its spacing, born part way through the frame', () => {
    const e = new Emitter('m', EMITTERS['solid-motor']!, { pos: at, floor: R }, 0, 2);
    const out: WorldSpawn[] = [];
    e.emit(1 / 60, 0, near, 1, new Vec3d(), out);
    out.length = 0;
    const p = at.clone();
    // 800 m/s for a quarter second: 200 m of trail.
    for (let i = 1; i <= 15; i++) {
      p.z += 800 / 60;
      e.set({ pos: p.clone(), vel: new Vec3d(0, 0, 800), floor: R }, i / 60);
      e.emit(1 / 60, i / 60, near, 1, new Vec3d(), out);
    }
    const smoke = out.filter((s) => s.look === LOOK_INDEX['motor-smoke']);
    // 6 m apart: about 33 over 200 m.
    expect(smoke.length).toBeGreaterThan(28);
    expect(smoke.length).toBeLessThan(38);
    // Evenly along the path: no frame's puffs all at one point.
    const zs = smoke.map((s) => s.pos.z).sort((a, b) => a - b);
    const gaps = zs.slice(1).map((z, i) => z - zs[i]!);
    expect(Math.max(...gaps)).toBeLessThan(14);
    expect(smoke.some((s) => (s.age ?? 0) > 0)).toBe(true);
  });

  it('sheds fewer, larger puffs far away and none beyond its range', () => {
    expect(lodFactor(LOD_NEAR / 2)).toBe(1);
    expect(lodFactor(LOD_NEAR * 4)).toBeCloseTo(2);
    const shed = (distance: number) => {
      const e = new Emitter('t', EMITTERS['burning-target']!, { pos: at, floor: R }, 0, 3);
      const out: WorldSpawn[] = [];
      const eye = new Vec3d(0, R + 100, distance);
      e.emit(1 / 30, 0, eye, 1, new Vec3d(), out);
      out.length = 0;
      for (let t = 1 / 30; t < 30; t += 1 / 30) e.emit(1 / 30, t, eye, 1, new Vec3d(), out);
      const smoke = out.filter((s) => s.look === LOOK_INDEX['column-gray']);
      return {
        n: smoke.length,
        size: smoke.reduce((a, s) => a + s.size, 0) / Math.max(1, smoke.length),
      };
    };
    const close = shed(1000);
    const far = shed(20_000);
    expect(far.n).toBeLessThan(close.n * 0.6);
    expect(far.size).toBeGreaterThan(close.size * 1.5);
    expect(shed(80_000).n).toBe(0);
  });

  it('fills a long-lived column at once when it comes into range', () => {
    const e = new Emitter('f', EMITTERS['fuel-fire']!, { pos: at, floor: R }, -600, 4);
    const out: WorldSpawn[] = [];
    e.emit(1 / 30, 0, near, 1, new Vec3d(), out);
    const smoke = out.filter((s) => s.look === LOOK_INDEX['column-black']);
    expect(smoke.length).toBeGreaterThan(20);
    const heights = smoke.map((s) => s.pos.length() - R);
    expect(Math.max(...heights)).toBeGreaterThan(150);
    expect(Math.max(...smoke.map((s) => s.age ?? 0))).toBeGreaterThan(30);
  });

  it('fills a column again when the camera leaves and comes back', () => {
    const e = new Emitter('t', EMITTERS['burning-target']!, { pos: at, floor: R }, -600, 5);
    const out: WorldSpawn[] = [];
    const far = new Vec3d(0, R + 100, 200_000);
    e.emit(1 / 30, 0, near, 1, new Vec3d(), out);
    const first = out.length;
    out.length = 0;
    for (let t = 1; t < 120; t += 1) e.emit(1, t, far, 1, new Vec3d(), out);
    expect(out.length).toBe(0);
    e.emit(1 / 30, 120, near, 1, new Vec3d(), out);
    expect(out.length).toBeGreaterThan(first * 0.7);
  });

  it('draws the same puffs from the same seed', () => {
    const a = seededRandom(9);
    const b = seededRandom(9);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('presets and explosions', () => {
  it('covers the proposal’s fifteen sources', () => {
    expect(PRESET_IDS.length).toBe(15);
    for (const id of PRESET_IDS) expect(EMITTERS[id] ?? BLAST_PRESETS[id], id).toBeTruthy();
    for (const e of Object.values(EMITTERS))
      for (const s of e!.streams) expect(LOOK_IDS).toContain(s.look);
  });

  it('turns a weapon’s motor into its trail', () => {
    expect(trailPreset('solid')).toBe('solid-motor');
    expect(trailPreset('reduced-smoke')).toBe('reduced-smoke-motor');
    expect(trailPreset('sam')).toBe('sam-launch');
    expect(trailPreset('none')).toBeNull();
  });

  it('builds the five layers, scaled by the cube root of the explosive', () => {
    const small = explosionRecipe('ground', 1.5);
    const big = explosionRecipe('ground', 429);
    const looks = (r: typeof big) => r.bursts.map((b) => b.look);
    expect(looks(big)).toEqual(expect.arrayContaining(['flash', 'fireball', 'dirt']));
    expect(big.debris.count).toBeGreaterThan(small.debris.count);
    expect(big.ring).toBeGreaterThan(0);
    expect(small.ring).toBe(0);
    expect(big.scorch).toBeGreaterThan(small.scorch * 4);
    expect(big.bursts[1]!.size[1]).toBeCloseTo(small.bursts[1]!.size[1] * Math.cbrt(429 / 1.5), 1);
    const air = explosionRecipe('air', 10);
    expect(air.scorch).toBe(0);
    expect(looks(air)).toContain('burst-smoke');
    expect(explosionRecipe('water', 40).bursts.map((b) => b.look)).toContain('spray');
    expect(explosionRecipe('fuel', 300).fire).toBe('fuel-fire');
  });
});

describe('ribbons', () => {
  it('forms contrails only above the contrail altitude', () => {
    const alt = contrailAltitude(15);
    expect(alt).toBeGreaterThan(8000);
    expect(alt).toBeLessThan(9000);
    expect(contrailForms(alt - 100, 15)).toBe(false);
    expect(contrailForms(alt + 100, 15)).toBe(true);
    // Colder days bring it down.
    expect(contrailAltitude(-20)).toBeLessThan(alt);
  });

  it('forms vortices only above a load factor, lower in humid air', () => {
    expect(vortexForms(2, 1)).toBe(false);
    expect(vortexForms(4, 1)).toBe(true);
    expect(vortexForms(4, 0)).toBe(false);
    expect(vortexForms(6.5, 0)).toBe(true);
  });
});

describe('the impostor', () => {
  it('bumps the radius by a little, smoothly', () => {
    let lo = 1;
    let hi = -1;
    for (let i = 0; i < 200; i++) {
      const a = i * 0.7;
      const n: [number, number, number] = [Math.cos(a), Math.sin(a * 1.3), Math.sin(a)];
      const b = radiusBump(n, 3.3);
      lo = Math.min(lo, b);
      hi = Math.max(hi, b);
    }
    expect(hi).toBeLessThan(0.12);
    expect(lo).toBeGreaterThan(-0.12);
    expect(hi - lo).toBeGreaterThan(0.05);
  });

  it('dithers by a 4 × 4 ordered pattern with sixteen distinct thresholds', () => {
    const t = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) t.add(bayer4(x, y));
    expect(t.size).toBe(16);
    expect(Math.min(...t)).toBeCloseTo(1 / 32);
  });
});

describe('effect events', () => {
  it('queues events, drains them oldest first and drops the oldest when full', () => {
    const q = new EffectQueue(2);
    const e = (time: number): EffectEvent => ({
      type: 'explosion',
      time,
      at: [0, R, 0],
      explosive: 1,
      kind: 'ground',
    });
    q.handle(e(1));
    q.handle(e(2));
    q.handle(e(3));
    const got: number[] = [];
    expect(q.drain({ handle: (x) => got.push(x.time) })).toBe(2);
    expect(got).toEqual([2, 3]);
    expect(q.length).toBe(0);
  });

  it('are plain data that survive a structured clone', () => {
    const e: EffectEvent = {
      type: 'fire-started',
      time: 5,
      key: 'site:12',
      at: [1, 2, 3],
      kind: 'fuel',
      intensity: 0.8,
    };
    expect(structuredClone(e)).toEqual(e);
  });
});
