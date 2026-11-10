import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { GENERATOR_VERSION, WorldStore, worldKey } from '../src/worldgen/worldStore';
import type { StoredWorld } from '../src/worldgen/worldStore';
import type { FinishResult } from '../src/worldgen/finishWorld';

describe('worldKey', () => {
  it('changes with any parameter or resolution, and not otherwise', () => {
    const p = DEFAULT_PLANET_PARAMS;
    const k = worldKey(p, 256, 1024);
    expect(worldKey({ ...p }, 256, 1024)).toBe(k);
    expect(worldKey({ ...p, moistureScale: 1.1 }, 256, 1024)).not.toBe(k);
    expect(worldKey({ ...p, seed: 'x' }, 256, 1024)).not.toBe(k);
    expect(worldKey(p, 128, 1024)).not.toBe(k);
    expect(worldKey(p, 256, 2048)).not.toBe(k);
    expect(k.startsWith(`${p.seed}-`)).toBe(true);
  });
});

describe('WorldStore', () => {
  it('round-trips a world with its typed arrays', async () => {
    const store = new WorldStore(indexedDB);
    const tectonic = generateWorld(DEFAULT_PLANET_PARAMS, { resolution: 8 });
    const n = 16;
    const cells = 6 * n * n;
    const finish = {
      drainage: {
        receiver: new Int32Array(cells).fill(-1),
        discharge: new Float32Array(cells),
        lakeDepth: new Float32Array(cells),
      },
      rivers: {
        count: 0,
        offsets: new Uint32Array(1),
        cells: new Int32Array(0),
        points: new Float64Array(0),
        discharge: new Float32Array(0),
        width: new Float32Array(0),
        downstream: new Int32Array(0),
      },
      biome: new Uint8Array(cells).fill(3),
      display: {
        height: new Float32Array(6 * 8 * 8),
        biome: new Uint8Array(6 * 8 * 8),
        discharge: new Float32Array(6 * 8 * 8),
        lakeDepth: new Float32Array(6 * 8 * 8),
      },
      timings: [],
    } satisfies FinishResult;
    const key = worldKey(DEFAULT_PLANET_PARAMS, 8, n);
    const rec: StoredWorld = {
      key,
      version: GENERATOR_VERSION,
      savedAt: 1,
      tectonic,
      global: {
        n,
        height: new Float32Array(cells).fill(7),
        uplift: new Float32Array(cells),
        finish,
      },
    };
    await store.save(rec);
    const back = await store.load(key);
    expect(back).not.toBeNull();
    expect(back!.global.height).toBeInstanceOf(Float32Array);
    expect(back!.global.height[5]).toBe(7);
    expect(back!.global.finish.biome[0]).toBe(3);
    expect(back!.tectonic.maps.height).toEqual(tectonic.maps.height);
    expect(await store.keys()).toContain(key);
    expect(await store.load('missing')).toBeNull();
    await store.clear();
    expect(await store.load(key)).toBeNull();
  });
});
