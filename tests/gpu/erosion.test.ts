import { describe, expect, it } from 'vitest';
import { neighborCell } from '../../src/core/faceAdjacency';
import { NEIGHBOR_OFFSETS } from '../../src/core/cubeGrid';
import { runDetailStage } from '../../src/worldgen/gpu/detailStage';
import { runErosion } from '../../src/worldgen/gpu/erosion';
import { GlobalGrid } from '../../src/worldgen/gpu/globalGrid';
import { upsampleMap } from '../../src/worldgen/gpu/upsample';
import { DEFAULT_PLANET_PARAMS as P } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { expectNoGpuErrors, testGpu } from './device';

const gpu = await testGpu();

describe.skipIf(!gpu)('erosion (GPU)', () => {
  const T = 48;
  const N = 96;
  const world = generateWorld(P, { resolution: T });

  const run = async (tuning = {}) => {
    const g = new GlobalGrid(gpu!, N);
    await expectNoGpuErrors(gpu!, async () => {
      runDetailStage(
        g,
        { n: T, height: world.maps.height, uplift: world.maps.uplift },
        P.seed,
        P.reliefScale,
      );
      upsampleMap(g, T, world.maps.precipitation, 'precipitation');
    });
    const before = await g.readF32('height');
    await expectNoGpuErrors(gpu!, () =>
      runErosion(g, {
        reliefScale: P.reliefScale,
        radius: P.radius,
        erosionStrength: 1,
        tuning: { iterations: 200, ...tuning },
      }),
    );
    const out = {
      before,
      after: await g.readF32('height'),
      flow: await g.readF32('flow'),
      rcv: await g.readU32('receiver'),
      rain: await g.readF32('precipitation'),
    };
    g.dispose();
    return out;
  };

  it('is deterministic, finite, and keeps land as land and sea as sea', async () => {
    const a = await run();
    const b = await run();
    expect(Buffer.from(a.after.buffer).equals(Buffer.from(b.after.buffer))).toBe(true);
    let changed = 0;
    for (let c = 0; c < a.after.length; c++) {
      expect(Number.isFinite(a.after[c]!)).toBe(true);
      expect(a.after[c]! > 0).toBe(a.before[c]! > 0);
      if (a.after[c] !== a.before[c]) changed++;
    }
    expect(changed).toBeGreaterThan(a.after.length * 0.1);
  });

  it('routes every land cell downhill on the filled surface toward a neighbor', async () => {
    const { rcv, before } = await run({ iterations: 50 });
    for (let c = 0; c < rcv.length; c++) {
      const r = rcv[c]! & 0x0fffffff;
      const k = rcv[c]! >>> 28;
      if (before[c]! <= 0) {
        expect(r).toBe(c);
        continue;
      }
      if (r === c) continue; // the last pits of a not yet fully drained basin
      const [di, dj] = NEIGHBOR_OFFSETS[k]!;
      expect(neighborCell(N, c, di, dj)).toBe(r);
    }
  });

  it('accumulates drainage that grows downstream', async () => {
    const { rcv, flow, before } = await run({ iterations: 400 });
    let ok = 0;
    let total = 0;
    for (let c = 0; c < rcv.length; c++) {
      if (before[c]! <= 0) continue;
      const r = rcv[c]! & 0x0fffffff;
      if (r === c || before[r]! <= 0) continue;
      total++;
      if (flow[r]! >= flow[c]! * 0.999) ok++;
    }
    // Jacobi drainage lags the receivers a little; nearly all links must already agree.
    expect(ok / total).toBeGreaterThan(0.97);
  });

  it('thermal erosion relaxes slopes steeper than the talus angle', async () => {
    const n = 32;
    const g = new GlobalGrid(gpu!, n);
    const h = new Float32Array(g.cellCount).fill(100 * P.reliefScale);
    const spike = (2 * n + n / 2) * n + n / 2; // face 2, middle
    h[spike] = 50000 * P.reliefScale;
    g.upload('height', h);
    g.upload('precipitation', new Float32Array(g.cellCount));
    const talus = 0.6;
    await expectNoGpuErrors(gpu!, () =>
      runErosion(g, {
        reliefScale: P.reliefScale,
        radius: P.radius,
        erosionStrength: 1,
        tuning: { iterations: 400, kdt: 0, rebound: 0, diffusion: 0, talus },
      }),
    );
    const out = await g.readF32('height');
    const cell = ((Math.PI / 2) * P.radius) / n;
    let maxSlope = 0;
    let sum = 0;
    for (let c = 0; c < out.length; c++) {
      sum += out[c]!;
      for (let k = 0; k < 4; k++) {
        const [di, dj] = NEIGHBOR_OFFSETS[k]!;
        const nb = neighborCell(n, c, di, dj);
        maxSlope = Math.max(maxSlope, Math.abs(out[c]! - out[nb]!) / P.reliefScale / cell);
      }
    }
    expect(maxSlope).toBeLessThan(talus * 1.05);
    // Material is conserved (float32 rounding aside).
    const before = h.reduce((s, x) => s + x, 0);
    expect(Math.abs(sum - before) / before).toBeLessThan(1e-4);
    g.dispose();
  });
});
