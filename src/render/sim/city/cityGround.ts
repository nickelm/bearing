/**
 * The urban ground from settlement plans (proposal 0009 Phase 5, decision 266): the
 * terrain shader reads each planned town's per-chunk feature fields (`chunkField`)
 * near the camera, in place of the interim street grid (decision 259).
 *
 * Buffers, written in place with update ranges:
 * - `recordPlan`: per light record, 0, or 1 + the plan slot drawing its ground;
 * - `plans`: per plan slot, (first chunk index i, j, chunks across, table base);
 * - `chunks`: per plan slot, CHUNKS_PER_PLAN entries: the field slot of each chunk or −1;
 * - `fields`: FIELD_SLOTS fields of FIELD_TEXELS² u32 texels.
 *
 * A planned town whose chunk has no field yet draws neutral built ground, not the
 * interim grid, so the grid's streets never show under the plan's buildings.
 */
import { Color, StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  cross,
  dot,
  float,
  floor,
  Fn,
  If,
  int,
  max,
  mix,
  normalize,
  select,
  storage,
  uint,
  vec3,
  vec4,
} from 'three/tsl';
import { CHUNK, FIELD_TEXELS, NO_BLOCK } from '../../../worldgen/settlements/pack';
import { Ground, StreetKind } from '../../../worldgen/settlements/types';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;
type I = Node<'int'>;

export const PLAN_SLOTS = 16;
/** Chunks a plan's table holds: a 24 × 24 km square at most. */
export const CHUNKS_PER_PLAN = 24 * 24;
export const FIELD_SLOTS = 128;
const TEXELS = FIELD_TEXELS * FIELD_TEXELS;
/** Chunk indices are stored biased, so negative ones fit a u32. */
const BIAS = 1 << 15;

const lin = (h: number) => {
  const c = new Color().setHex(h);
  return vec3(c.r, c.g, c.b);
};

/** Ground colors by `Ground`, then street surfaces (decision 259's palette, plus sports and cemetery). */
const GROUND_HEX: Record<number, number> = {
  [Ground.Courtyard]: 0xa89f8e,
  [Ground.Garden]: 0x7e9456,
  [Ground.Park]: 0x6f8a4e,
  [Ground.Square]: 0xc9bca4,
  [Ground.Parking]: 0x8c877e,
  [Ground.Concrete]: 0x9a968e,
  [Ground.Gravel]: 0x8a8172,
  [Ground.Ballast]: 0x6e665c,
  [Ground.Sports]: 0x7fa860,
  [Ground.Cemetery]: 0x7e8c6a,
};

export class CityGround {
  /**
   * One u32 buffer (the terrain's fragment stage is at WebGPU's default of 8 storage
   * buffers): per light record its plan slot + 1; per plan slot (i0 + BIAS, j0 + BIAS,
   * chunks across, table base); per plan slot CHUNKS_PER_PLAN field slots + 1 (0: none);
   * then the fields.
   */
  readonly attr: StorageBufferAttribute;
  private readonly data;
  private readonly words: Uint32Array;
  private readonly plansAt: number;
  private readonly chunksAt: number;
  private readonly fieldsAt: number;

  constructor(
    private readonly lightCount: number,
    private readonly radius: number,
  ) {
    this.plansAt = Math.max(1, lightCount);
    this.chunksAt = this.plansAt + PLAN_SLOTS * 4;
    this.fieldsAt = this.chunksAt + PLAN_SLOTS * CHUNKS_PER_PLAN;
    this.words = new Uint32Array(this.fieldsAt + FIELD_SLOTS * TEXELS);
    this.attr = new StorageBufferAttribute(this.words, 1);
    this.data = storage(this.attr, 'uint', this.words.length).toReadOnly();
  }

  private touch(start: number, count: number): void {
    this.attr.addUpdateRange(start, count);
    this.attr.needsUpdate = true;
  }

  /** Light record `record` draws plan slot `slot`'s ground (−1: none). */
  setRecord(record: number, slot: number): void {
    if (record < 0 || record >= this.lightCount) return;
    this.words[record] = slot + 1;
    this.touch(record, 1);
  }

  /** Plan slot `slot` covers chunks from (i0, j0), `across` per row; its table is cleared. */
  setPlan(slot: number, i0: number, j0: number, across: number): void {
    const at = this.plansAt + slot * 4;
    this.words.set([i0 + BIAS, j0 + BIAS, across, slot * CHUNKS_PER_PLAN], at);
    this.touch(at, 4);
    const c = this.chunksAt + slot * CHUNKS_PER_PLAN;
    this.words.fill(0, c, c + CHUNKS_PER_PLAN);
    this.touch(c, CHUNKS_PER_PLAN);
  }

  /** Chunk `index` of plan slot `slot` reads field slot `field` (−1: none). */
  setChunk(slot: number, index: number, field: number): void {
    if (index < 0 || index >= CHUNKS_PER_PLAN) return;
    const at = this.chunksAt + slot * CHUNKS_PER_PLAN + index;
    this.words[at] = field + 1;
    this.touch(at, 1);
  }

  writeField(field: number, data: Uint32Array): void {
    const at = this.fieldsAt + field * TEXELS;
    this.words.set(data, at);
    this.touch(at, TEXELS);
  }

  /**
   * The planned ground at unit direction `p` for light record `record` centered on
   * `c`: vec4(albedo, 1) where a field covers it; (neutral, 0.5) where the chunk's field
   * is not built (far from the camera); (0, 0.25) off the plan's blocks and streets or
   * outside its chunks, where the natural ground shows; (0, 0) for unplanned towns.
   */
  ground(p: V3, c: V3, record: I, footprint: F): V4 {
    return Fn(() => {
      const out = vec4(0).toVar();
      const slot = int(this.data.element(record)).sub(1).toVar();
      If(slot.greaterThanEqual(0), () => {
        const neutral = mix(lin(GROUND_HEX[Ground.Courtyard]!), lin(0x8e8a80), 0.5);
        out.assign(vec4(neutral, 0.5));
        const pa = int(this.plansAt).add(slot.mul(4));
        const plan = {
          x: int(this.data.element(pa)).sub(BIAS),
          y: int(this.data.element(pa.add(1))).sub(BIAS),
          z: int(this.data.element(pa.add(2))),
          w: int(this.data.element(pa.add(3))),
        };
        const east = normalize(cross(vec3(0, 1, 0), c));
        const north = cross(c, east);
        const k = float(this.radius).div(dot(p, c));
        const x = dot(p, east).mul(k);
        const y = dot(p, north).mul(k);
        const ci = floor(x.div(CHUNK));
        const cj = floor(y.div(CHUNK));
        const li = int(ci).sub(plan.x);
        const lj = int(cj).sub(plan.y);
        const across = plan.z;
        // Outside the plan's chunks: the natural ground.
        out.assign(vec4(0, 0, 0, 0.25));
        If(
          li
            .greaterThanEqual(0)
            .and(lj.greaterThanEqual(0))
            .and(li.lessThan(across))
            .and(lj.mul(across).add(li).lessThan(CHUNKS_PER_PLAN)),
          () => {
            const field = int(
              this.data.element(int(this.chunksAt).add(plan.w).add(lj.mul(across)).add(li)),
            )
              .sub(1)
              .toVar();
            out.assign(vec4(neutral, 0.5));
            If(field.greaterThanEqual(0), () => {
              const step = CHUNK / FIELD_TEXELS;
              const tx = clamp(x.sub(ci.mul(CHUNK)).div(step).sub(0.5), 0, FIELD_TEXELS - 1.001);
              const ty = clamp(y.sub(cj.mul(CHUNK)).div(step).sub(0.5), 0, FIELD_TEXELS - 1.001);
              const i0 = int(floor(tx));
              const j0 = int(floor(ty));
              const fx = tx.sub(floor(tx));
              const fy = ty.sub(floor(ty));
              const base = int(this.fieldsAt).add(field.mul(FIELD_TEXELS * FIELD_TEXELS));
              const texel = (i: I, j: I) => this.data.element(base.add(j.mul(FIELD_TEXELS)).add(i));
              const i1 = select(i0.lessThan(FIELD_TEXELS - 1), i0.add(1), i0) as I;
              const j1 = select(j0.lessThan(FIELD_TEXELS - 1), j0.add(1), j0) as I;
              const t00 = texel(i0, j0);
              const t10 = texel(i1, j0);
              const t01 = texel(i0, j1);
              const t11 = texel(i1, j1);
              const dist = (t: Node<'uint'>) =>
                float(t.bitAnd(uint(255)))
                  .sub(128)
                  .div(4);
              const d = mix(mix(dist(t00), dist(t10), fx), mix(dist(t01), dist(t11), fx), fy);
              // The nearest texel's ground and street class.
              const near = select(
                fy.lessThan(0.5),
                select(fx.lessThan(0.5), t00, t10),
                select(fx.lessThan(0.5), t01, t11),
              );
              const ground = near.shiftRight(uint(8)).bitAnd(uint(255)).toVar();
              const kind = near.shiftRight(uint(16)).bitAnd(uint(255)).toVar();
              const block = vec3(0).toVar();
              // Gardens alternate lawn and yard in 22 m squares (a parcel or so), gently.
              const checker = abs(floor(x.div(22)).add(floor(y.div(22)))).mod(2);
              If(ground.equal(uint(NO_BLOCK)), () => {
                // Off the blocks: sidewalks beside the streets, verges beyond.
                block.assign(select(d.lessThan(4), lin(0xb8b0a2), lin(0x8a9a60)));
              }).Else(() => {
                const g = int(ground);
                let color: V3 = lin(GROUND_HEX[Ground.Courtyard]!);
                for (const [k2, hex] of Object.entries(GROUND_HEX)) {
                  color = select(g.equal(int(Number(k2))), lin(hex), color) as V3;
                }
                const garden = mix(
                  lin(GROUND_HEX[Ground.Garden]!),
                  lin(0xa69a80),
                  checker.mul(0.3),
                );
                block.assign(select(g.equal(int(Ground.Garden)), garden, color));
              });
              const pathColor = select(
                kind.equal(uint(StreetKind.Stairs)),
                lin(0xb0a898),
                lin(0xa89880),
              );
              const street = select(
                kind.greaterThanEqual(uint(StreetKind.Path)),
                pathColor,
                lin(0x7a7062),
              );
              const fp = max(footprint, 0.05);
              const cover = clamp(float(0.5).sub(d.div(fp)), 0, 1);
              // Off the blocks and away from the streets: the natural ground (verges, fields).
              const verge = ground.equal(uint(NO_BLOCK)).and(d.greaterThan(4));
              out.assign(select(verge, vec4(0, 0, 0, 0.25), vec4(mix(block, street, cover), 1)));
            });
          },
        );
      });
      return out;
    })() as V4;
  }
}
