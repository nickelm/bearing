/**
 * The puffs' compute pass on Dawn against its TypeScript reference (decision 321): puffs
 * spawned into the pool and stepped for a second and a half on the GPU land where
 * `stepPuff` puts them, with the same radius, color and coverage, and dead puffs collapse.
 */
import { describe, expect, it } from 'vitest';
import { curveTable } from '../../src/render/sim/effects/curves';
import { PuffPool } from '../../src/render/sim/effects/pool';
import { PuffBuffers } from '../../src/render/sim/effects/puffCompute';
import { stepPuff, type PuffState } from '../../src/render/sim/effects/puffModel';
import { LOOK_INDEX, LOOKS, lookMotion } from '../../src/render/sim/effects/presets';
import type { LookId } from '../../src/render/sim/effects/presets';
import { readTable } from '../../src/render/sim/effects/curves';
import { testGpu, expectNoGpuErrors } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('puffs on the GPU', () => {
  it('steps puffs as the reference does', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const pool = new PuffPool(256);
    const buffers = new PuffBuffers(pool);
    const R = 1_000_000;
    // The anchor 300 m above the ground at the pole; puffs around it.
    const anchor: [number, number, number] = [0, R + 300, 0];
    const curves = curveTable(LOOKS);
    const motion = lookMotion(LOOKS);
    const looks: LookId[] = ['motor-smoke', 'fireball', 'column-black', 'dust', 'spray', 'flash'];
    const ref: PuffState[] = [];
    looks.forEach((id, i) => {
      const look = LOOK_INDEX[id];
      const life = LOOKS[look]!.life[0];
      const pos: [number, number, number] = [i * 20, i === 3 ? -299 : 0, -i * 10];
      const vel: [number, number, number] = [3 * i, 5, -2];
      pool.spawn({ pos, vel, life, look, size: 2 + i, seed: i * 0.37, floor: R }, 0);
      const r1 = readTable(curves, look, 0, 1);
      ref.push({
        pos: [...pos],
        vel: [...vel],
        age: 0,
        life,
        look,
        size: 2 + i,
        seed: i * 0.37,
        floor: R,
        tint: [1, 1, 1],
        radius: (2 + i) * r1[0],
        color: [0, 0, 0],
        glow: 0,
        coverage: r1[1],
      });
    });
    const dt = 1 / 30;
    const wind: [number, number, number] = [6, 0, 2];
    await expectNoGpuErrors(gpu!, async () => {
      // Frame 0 spawns; frames 1..45 step.
      buffers.run(head.renderer, { dt, time: 0, wind, anchor, shift: [0, 0, 0], kill: false });
      for (let f = 1; f <= 45; f++) {
        const time = f * dt;
        const shift: [number, number, number] = f === 20 ? [5, -2, 1] : [0, 0, 0];
        buffers.run(head.renderer, { dt, time, wind, anchor, shift, kill: false });
        for (const s of ref) stepPuff(s, { dt, time, wind, anchor, shift }, curves, motion);
      }
    });
    const out = await buffers.read(head.renderer);
    ref.forEach((s, i) => {
      const p = [out.pos![i * 4]!, out.pos![i * 4 + 1]!, out.pos![i * 4 + 2]!];
      const label = looks[i]!;
      for (let c = 0; c < 3; c++) expect(p[c]!, `${label} pos`).toBeCloseTo(s.pos[c]!, 1);
      expect(out.vel![i * 4 + 3]!, `${label} radius`).toBeCloseTo(s.radius, 2);
      expect(out.extra![i * 4 + 1]!, `${label} coverage`).toBeCloseTo(s.coverage, 3);
      if (s.age < s.life) {
        for (let c = 0; c < 3; c++)
          expect(out.color![i * 4 + c]!, `${label} color`).toBeCloseTo(s.color[c]!, 3);
      }
    });
    // The flash (0.14 s) is dead: radius and coverage 0.
    expect(out.vel![5 * 4 + 3]).toBe(0);
    expect(out.extra![5 * 4 + 1]).toBe(0);
    // The dust born at the ground did not sink below half its radius.
    const dust = ref[3]!;
    const h =
      Math.hypot(dust.pos[0] + anchor[0], dust.pos[1] + anchor[1], dust.pos[2] + anchor[2]) - R;
    expect(h).toBeGreaterThanOrEqual(-1e-6);
    buffers.dispose();
    head.dispose();
  });

  it('kills every puff on a cut', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const pool = new PuffPool(64);
    const buffers = new PuffBuffers(pool);
    for (let i = 0; i < 10; i++)
      pool.spawn(
        { pos: [i, 0, 0], vel: [0, 0, 0], life: 30, look: 0, size: 2, seed: i, floor: 0 },
        0,
      );
    const o = {
      dt: 0.016,
      time: 0,
      wind: [0, 0, 0],
      anchor: [0, 1e6, 0],
      shift: [0, 0, 0],
    } as const;
    buffers.run(head.renderer, { ...o, kill: false });
    buffers.run(head.renderer, { ...o, kill: true });
    const out = await buffers.read(head.renderer);
    for (let i = 0; i < 10; i++) expect(out.vel![i * 4 + 3]).toBe(0);
    buffers.dispose();
    head.dispose();
  });
});
