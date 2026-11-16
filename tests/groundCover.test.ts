import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/render/common/models/builder';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { Biome, TileCover } from '../src/worldgen/biomes';
import { CANOPY_THRESHOLD } from '../src/worldgen/canopy';
import {
  COVER_HEIGHT,
  COVER_KINDS,
  COVER_SLOTS,
  coverInCell,
  coverMix,
  isObstacle,
  OBSTACLE_HEIGHT,
  ROCK_KINDS,
} from '../src/worldgen/groundCover';
import type { CoverItem, CoverSite } from '../src/worldgen/groundCover';

const MEADOW: CoverSite = {
  cover: Biome.TemperateGrassland,
  moisture: 0.5,
  meanT: 10,
  steep: 0.05,
  forest: 0.1,
  aridity: 0,
  farmland: 0,
};

/** Items over an n × n block of cells. */
function block(site: CoverSite, n = 40, seed = 1234): CoverItem[] {
  const out: CoverItem[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) coverInCell(1000 + x, 2000 + y, 2, seed, site, out);
  return out;
}

const count = (items: CoverItem[], pred: (i: CoverItem) => boolean) => items.filter(pred).length;

describe('ground cover', () => {
  it('lists heights that match the kit models', () => {
    for (const kind of COVER_KINDS) {
      const spec = MODEL_SPECS[kind];
      expect(spec, kind).toBeDefined();
      const top = buildModel(spec!, { noAo: true }).bounds.max[1];
      expect(COVER_HEIGHT[kind], kind).toBeCloseTo(top, 2);
    }
  });

  it('is deterministic per cell and seed', () => {
    expect(block(MEADOW, 10)).toEqual(block(MEADOW, 10));
    expect(block(MEADOW, 10, 1)).not.toEqual(block(MEADOW, 10, 2));
  });

  it('keeps every mix under one per slot', () => {
    const sites: CoverSite[] = [];
    for (const cover of [
      ...Object.values(Biome),
      TileCover.Marsh,
      TileCover.Gravel,
      TileCover.Beach,
    ])
      for (const steep of [0, 0.5, 1])
        for (const moisture of [0.05, 0.4, 0.9])
          for (const farmland of [0, 1])
            sites.push({
              ...MEADOW,
              cover,
              steep,
              moisture,
              farmland,
              aridity: moisture < 0.1 ? 0.8 : 0,
            });
    for (const s of sites) {
      const sum = Object.values(coverMix(s)).reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(1);
    }
  });

  it('grows tufts and flowers in a meadow, none under closed forest', () => {
    const meadow = block(MEADOW);
    const cells = 40 * 40;
    expect(count(meadow, (i) => i.kind === 'cover-tuft') / cells).toBeGreaterThan(1.5);
    expect(count(meadow, (i) => i.kind.startsWith('cover-flowers'))).toBeGreaterThan(0);
    expect(block({ ...MEADOW, forest: CANOPY_THRESHOLD + 0.01 })).toHaveLength(0);
  });

  it('puts reeds in marsh, stones on scree and few tufts in fields', () => {
    expect(
      count(block({ ...MEADOW, cover: TileCover.Marsh }), (i) => i.kind === 'cover-reeds'),
    ).toBeGreaterThan(500);
    const scree = block({ ...MEADOW, steep: 0.55 });
    expect(count(scree, (i) => ROCK_KINDS.has(i.kind))).toBeGreaterThan(0.9 * scree.length);
    // Nothing stays put on faces steeper than about 35° (decision 187).
    expect(block({ ...MEADOW, steep: 0.9 })).toHaveLength(0);
    const field = block({ ...MEADOW, farmland: 1 });
    expect(field.length).toBeLessThan(0.15 * block(MEADOW).length);
  });

  it('keeps items inside their cell and within their scale', () => {
    for (const i of block(MEADOW, 20)) {
      expect(i.u).toBeGreaterThanOrEqual(0);
      expect(i.u).toBeLessThanOrEqual(1);
      expect(i.v).toBeGreaterThanOrEqual(0);
      expect(i.v).toBeLessThanOrEqual(1);
      expect(i.height).toBeCloseTo(COVER_HEIGHT[i.kind] * i.scale, 9);
    }
    expect(COVER_SLOTS).toBeGreaterThan(0);
  });

  it('counts only tall rocks as landing obstacles', () => {
    const rocks = block({ ...MEADOW, talus: 1 }, 60);
    const tall = rocks.filter(isObstacle);
    expect(tall.length).toBeGreaterThan(0);
    for (const i of tall) {
      expect(ROCK_KINDS.has(i.kind)).toBe(true);
      expect(i.height).toBeGreaterThanOrEqual(OBSTACLE_HEIGHT);
    }
    expect(block(MEADOW).filter((i) => i.kind === 'cover-tuft' && isObstacle(i))).toHaveLength(0);
  });

  it('piles talus below a cliff, reeds on a bank and tufts along field verges (decision 185)', () => {
    const rocks = (items: CoverItem[]) => count(items, (i) => ROCK_KINDS.has(i.kind));
    const below = block({ ...MEADOW, talus: 1 });
    expect(rocks(below)).toBeGreaterThan(0.6 * below.length);
    expect(count(below, (i) => i.kind === 'cover-boulder-large')).toBeGreaterThan(0);
    expect(rocks(block(MEADOW))).toBeLessThan(0.05 * block(MEADOW).length);
    expect(count(block({ ...MEADOW, bank: 1 }), (i) => i.kind === 'cover-reeds')).toBeGreaterThan(
      300,
    );
    expect(count(block({ ...MEADOW, bank: 1, meanT: -5 }), (i) => i.kind === 'cover-reeds')).toBe(
      0,
    );
    const field = block({ ...MEADOW, farmland: 1 }).length;
    const verge = block({ ...MEADOW, farmland: 1, verge: 1 }).length;
    expect(verge).toBeGreaterThan(5 * field);
    for (const extra of [{ talus: 1 }, { bank: 1 }, { farmland: 1, verge: 1 }]) {
      const sum = Object.values(coverMix({ ...MEADOW, ...extra })).reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(1);
    }
  });
});
