/**
 * IndexedDB persistence of generated worlds (decisions 12, 29).
 *
 * A record holds everything needed to show a world again without
 * regenerating it: the tectonic world, the eroded global height and uplift
 * (re-uploaded to the GPU for tile synthesis), the CPU results
 * (drainage, rivers, biomes, display maps), and the strategic graph and cast. Tiles are not stored: they
 * synthesize faster than they load.
 *
 * Records are keyed by a hash of the planet parameters, both grid
 * resolutions and GENERATOR_VERSION, so any change to generation code that
 * alters output must bump the version.
 */
import { hashString64 } from '../core/rng';
import type { StrategicWorld } from './campaignWorld';
import type { FinishResult } from './finishWorld';
import type { PlanetParams } from './params';
import type { World } from './pipeline';

/** Bump whenever generation output changes, so cached worlds are regenerated. */
export const GENERATOR_VERSION = 11;

const DB_NAME = 'bearing-worlds';
const STORE = 'worlds';

export interface StoredWorld {
  key: string;
  version: number;
  savedAt: number;
  tectonic: World;
  /** Graph and campaign from the coarse pass. Absent in offline tool caches (tools/previewWorld.ts). */
  strategic?: StrategicWorld;
  global: {
    n: number;
    height: Float32Array;
    uplift: Float32Array;
    finish: FinishResult;
  };
}

/** Cache key for a world: parameters (sorted), resolutions and generator version. */
export function worldKey(params: PlanetParams, tectonicN: number, globalN: number): string {
  const p = params as unknown as Record<string, unknown>;
  const sorted = Object.keys(p)
    .sort()
    .map((k) => [k, typeof p[k] === 'bigint' ? String(p[k]) : p[k]]);
  const text = JSON.stringify({ v: GENERATOR_VERSION, p: sorted, t: tectonicN, g: globalN });
  return `${String(params.seed)}-${hashString64(text).toString(16).padStart(16, '0')}`;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class WorldStore {
  private db: Promise<IDBDatabase> | null = null;

  /** `factory` defaults to the global indexedDB; tests pass fake-indexeddb. */
  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const r = this.factory.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }

  async load(key: string): Promise<StoredWorld | null> {
    const db = await this.open();
    const rec = (await request(db.transaction(STORE).objectStore(STORE).get(key))) as
      StoredWorld | undefined;
    return rec && rec.version === GENERATOR_VERSION ? rec : null;
  }

  async save(world: StoredWorld): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(world);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async keys(): Promise<string[]> {
    const db = await this.open();
    return (await request(db.transaction(STORE).objectStore(STORE).getAllKeys())) as string[];
  }

  async delete(key: string): Promise<void> {
    const db = await this.open();
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
  }

  async clear(): Promise<void> {
    const db = await this.open();
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
  }
}
