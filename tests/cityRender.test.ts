import { describe, expect, it } from 'vitest';
import { buildingColliders, ColliderIndex } from '../src/worldgen/settlements/colliders';
import { exportSettlement } from '../src/worldgen/settlements/exports';
import { SettlementFrame } from '../src/worldgen/settlements/frame';
import {
  BUILDING_FIELDS,
  CHUNK,
  chunkField,
  FieldIndex,
  NO_BLOCK,
  packPlan,
} from '../src/worldgen/settlements/pack';
import { planSettlement } from '../src/worldgen/settlements/plan';
import { Style, Tier } from '../src/worldgen/settlements/types';
import type { SettlementInput } from '../src/worldgen/settlements/types';
import {
  Damage,
  GeometryWriter,
  Lod,
  patchRange,
  writeBuilding,
  writePrisms,
} from '../src/render/sim/city/cityMesh';

const RADIUS = 1e6;
const input: SettlementInput = {
  key: 's9',
  name: 'Testgrad',
  center: [0, 0, 1],
  population: 60_000,
  tier: Tier.Town,
  style: Style.Eastern,
  flavor: 1,
  outline: Array.from({ length: 32 }, () => 2400),
  arterials: [{ points: [-4000, 30, 4000, -30], roadClass: 0 }],
  rails: [{ points: [-4000, 600, 4000, 650] }],
  rivers: [],
  coasts: [],
  port: false,
  ground: { height: () => 50, water: () => false },
};
const plan = packPlan(planSettlement(input, 11, { radius: RADIUS }));
const flat = () => 50;

describe('city rendering data (proposal 0009 Phase 6)', () => {
  it('packs a plan and rasterizes a chunk field with streets and blocks', () => {
    expect(plan.buildings.length / BUILDING_FIELDS).toBeGreaterThan(200);
    const field = chunkField(new FieldIndex(plan), 0, 0);
    let named = 0;
    let blocks = 0;
    let onStreet = 0;
    const T = 128;
    for (let k = 0; k < T * T; k++) {
      const t = field[k]!;
      const seg = t & 0xffff;
      if (((t >> 16) & 255) !== NO_BLOCK) blocks++;
      if (seg === 0xffff) continue;
      named++;
      // The exact distance to the named segment, as the shader takes it.
      const o = T * T + seg * 3;
      const q = (v: number) => v / 32 - 512;
      const ax = q(field[o]! & 0xffff);
      const ay = q(field[o]! >>> 16);
      const bx = q(field[o + 1]! & 0xffff);
      const by = q(field[o + 1]! >>> 16);
      const hw = (field[o + 2]! & 255) / 16;
      const x = ((k % T) + 0.5) * (1000 / T);
      const y = (Math.floor(k / T) + 0.5) * (1000 / T);
      const ex = bx - ax;
      const ey = by - ay;
      const h = Math.max(
        0,
        Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)),
      );
      if (Math.hypot(x - ax - ex * h, y - ay - ey * h) < hw) onStreet++;
    }
    expect(named).toBeGreaterThan(5000);
    expect(onStreet).toBeGreaterThan(500);
    expect(blocks).toBeGreaterThan(2000);
  });

  it('builds boxes and kits within the building budget, and prisms at about 10 triangles a block', () => {
    const frame = new SettlementFrame(plan.center, RADIUS);
    const n = plan.buildings.length / BUILDING_FIELDS;
    for (const lod of [Lod.Box, Lod.Kit]) {
      const w = new GeometryWriter(frame, [0, 0, RADIUS]);
      for (let i = 0; i < n; i++) expect(writeBuilding(w, plan, i, lod, flat)).toBe(true);
      const per = w.triangles / n;
      if (lod === Lod.Box) expect(per).toBeLessThanOrEqual(30);
      expect(per).toBeGreaterThanOrEqual(12);
      expect(per).toBeLessThanOrEqual(200);
    }
    const blocks = Array.from({ length: plan.blockOffsets.length - 1 }, (_, i) => i);
    const coverage = new Float32Array(blocks.length).fill(0.5);
    const w = new GeometryWriter(frame, [0, 0, RADIUS]);
    writePrisms(w, plan, blocks, coverage, flat);
    expect(w.triangles / blocks.length).toBeLessThan(16);
  });

  it('swaps a building to rubble in place in under 2 ms', () => {
    const frame = new SettlementFrame(plan.center, RADIUS);
    const inChunk: number[] = [];
    const b = plan.buildings;
    for (let i = 0; i < b.length / BUILDING_FIELDS; i++) {
      if (
        Math.floor(b[i * BUILDING_FIELDS]! / CHUNK) === 0 &&
        Math.floor(b[i * BUILDING_FIELDS + 1]! / CHUNK) === 0
      )
        inChunk.push(i);
    }
    expect(inChunk.length).toBeGreaterThan(20);
    const build = (rubble: number) => {
      const w = new GeometryWriter(frame, [0, 0, RADIUS]);
      for (const i of inChunk)
        writeBuilding(w, plan, i, Lod.Box, flat, i === rubble ? Damage.Rubble : Damage.Intact);
      return w.finish();
    };
    // The renderer patches the building's own triangles in place.
    const ranges: [number, number][] = [];
    const w0 = new GeometryWriter(frame, [0, 0, RADIUS]);
    for (const i of inChunk) {
      const s = w0.triangles;
      writeBuilding(w0, plan, i, Lod.Box, flat);
      ranges.push([s, w0.triangles - s]);
    }
    const built = w0.finish();
    const t0 = performance.now();
    const rounds = 50;
    for (let k = 0; k < rounds; k++) {
      const j = k % inChunk.length;
      const w = new GeometryWriter(frame, [0, 0, RADIUS]);
      writeBuilding(w, plan, inChunk[j]!, Lod.Box, flat, k % 2 ? Damage.Rubble : Damage.Damaged);
      expect(patchRange(built, ranges[j]![0], ranges[j]![1], w.finish())).toBe(true);
    }
    const ms = (performance.now() - t0) / rounds;
    const t1 = performance.now();
    build(inChunk[0]!);
    const whole = performance.now() - t1;
    console.log(
      `rubble swap ${ms.toFixed(3)} ms in place; whole chunk of ${inChunk.length} rebuilt in ${whole.toFixed(2)} ms`,
    );
    expect(ms).toBeLessThan(2);
  });

  it('finds buildings on a line of sight and flat roofs to land on', () => {
    const idx = new ColliderIndex(buildingColliders(plan));
    const c = idx.boxes.find((x) => x.wall > 12)!;
    const hit = idx.segmentHit([c.x - 200, c.y, 55], [c.x + 200, c.y, 55], flat);
    expect(hit).not.toBeNull();
    const over = idx.segmentHit(
      [c.x - 200, c.y, 50 + c.top + 50],
      [c.x + 200, c.y, 50 + c.top + 50],
      flat,
    );
    expect(over?.building === c.building).toBe(false);
    expect(idx.landingHeight(c.x, c.y)).toBeCloseTo(c.wall, 3);
  });

  it('exports districts, landmarks and targets in planet directions', () => {
    const e = exportSettlement(plan, RADIUS);
    expect(e.districts.length).toBeGreaterThan(2);
    expect(e.targets.some((t) => t.kind === 'rail yard')).toBe(true);
    for (const t of e.targets) expect(Math.hypot(...t.direction)).toBeCloseTo(1, 9);
  });
});
