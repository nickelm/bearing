import { describe, expect, it } from 'vitest';
import { linearGroups } from '../../src/worldgen/gpu/gpuContext';
import { GPU_SELF_TESTS, runSelfTest } from '../../src/worldgen/gpu/selfTests';
import { testGpu } from './device';

const gpu = await testGpu();

describe('linear dispatch', () => {
  it('splits large dispatches into 2D groups', () => {
    expect(linearGroups(10)).toEqual([1, 1]);
    const [x, y] = linearGroups(6 * 2048 * 2048);
    expect(x * y * 64).toBeGreaterThanOrEqual(6 * 2048 * 2048);
    expect(x).toBeLessThanOrEqual(65535);
  });
});

describe.skipIf(!gpu)('GPU self-tests (Dawn)', () => {
  for (const t of GPU_SELF_TESTS) {
    it(t.name, async () => {
      expect(await runSelfTest(gpu!, t)).toBeNull();
    });
  }
});
