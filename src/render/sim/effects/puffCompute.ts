/**
 * The puffs on the GPU (Proposal 0011, decision 321): six vec4 storage buffers of
 * `POOL_CAPACITY` slots and two compute kernels.
 *
 * | Buffer | x, y, z | w |
 * |---|---|---|
 * | `pos` | position relative to the anchor (m) | age (s) |
 * | `vel` | velocity (m/s) | radius (m) |
 * | `color` | albedo, linear RGB | glow |
 * | `params` | life (s), look, base radius (m), seed | |
 * | `extra` | floor (m), coverage 0..1, squash, 0 | |
 * | `tint` | tint, linear RGB | 0 |
 *
 * - **Update** (every slot below the pool's high-water mark): the shift of the floating
 *   origin, then `puffModel.ts`'s step, mirrored line for line.
 * - **Spawn** (the frame's staged records, after the update): writes each new puff into
 *   its slot with its curves at its birth age, so it draws in the frame it is born.
 *
 * The material reads the same buffers as instanced attributes (`toAttribute`).
 */
import { Vector3 } from 'three/webgpu';
import type { Node, StorageBufferNode, WebGPURenderer, ComputeNode } from 'three/webgpu';
import {
  clamp,
  dot,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  instancedArray,
  length,
  max,
  min,
  mix,
  sin,
  smoothstep,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { CURVE_ROWS, CURVE_SAMPLES, curveTable } from './curves';
import { LOOKS, lookMotion } from './presets';
import { FAN, GROUND_WIND, MOTION_ROWS, SHEAR_HEIGHT, SINK } from './puffModel';
import { PuffPool, SPAWN_CAPACITY, SPAWN_FLOATS } from './pool';

type F = Node<'float'>;
type V4 = Node<'vec4'>;
type U = Node<'uint'>;

export class PuffBuffers {
  readonly pos: StorageBufferNode<'vec4'>;
  readonly vel: StorageBufferNode<'vec4'>;
  readonly color: StorageBufferNode<'vec4'>;
  readonly params: StorageBufferNode<'vec4'>;
  readonly extra: StorageBufferNode<'vec4'>;
  readonly tint: StorageBufferNode<'vec4'>;
  /** The looks' curve table, then their motion rows (one buffer: a stage binds at most eight). */
  readonly tables: StorageBufferNode<'vec4'>;
  readonly staging: StorageBufferNode<'vec4'>;
  readonly u = {
    dt: uniform(0),
    time: uniform(0),
    wind: uniform(new Vector3()),
    anchor: uniform(new Vector3()),
    shift: uniform(new Vector3()),
    /** 1 kills every puff this update (a cut). */
    kill: uniform(0),
    spawnCount: uniform(0, 'uint'),
    highWater: uniform(0, 'uint'),
  };
  private readonly updateKernel: ComputeNode;
  private readonly spawnKernel: ComputeNode;
  private readonly motionBase: number;
  /** Compute dispatches issued, for the stats. */
  dispatches = 0;

  constructor(readonly pool: PuffPool) {
    const cap = pool.capacity;
    const v4 = () => instancedArray(cap, 'vec4');
    this.pos = v4();
    this.vel = v4();
    this.color = v4();
    this.params = v4();
    this.extra = v4();
    this.tint = v4();
    const curves = curveTable(LOOKS);
    const motion = lookMotion(LOOKS);
    const both = new Float32Array(curves.length + motion.length);
    both.set(curves);
    both.set(motion, curves.length);
    this.motionBase = curves.length / 4;
    this.tables = instancedArray(both, 'vec4').toReadOnly();
    this.staging = instancedArray(pool.staging, 'vec4').toReadOnly();
    this.updateKernel = this.buildUpdate().compute(cap, [64]);
    this.updateKernel.name = 'puffs: update';
    this.spawnKernel = this.buildSpawn().compute(SPAWN_CAPACITY, [64]);
    this.spawnKernel.name = 'puffs: spawn';
  }

  /** A row of the curve table at share `t` of the life, between samples. */
  private table(look: U, t: F, row: number): V4 {
    const x = clamp(t, 0, 1).mul(CURVE_SAMPLES - 1);
    const i0 = min(floor(x), float(CURVE_SAMPLES - 2));
    const f = x.sub(i0);
    const base = look.mul(uint(CURVE_SAMPLES * CURVE_ROWS)).add(uint(i0).mul(uint(CURVE_ROWS)));
    const a = this.tables.element(base.add(uint(row))) as unknown as V4;
    const b = this.tables.element(base.add(uint(row + CURVE_ROWS))) as unknown as V4;
    return mix(a, b, f) as V4;
  }

  private buildUpdate() {
    const u = this.u;
    return Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(u.highWater), () => {
        const P = this.pos.element(i);
        const Vb = this.vel.element(i);
        const prm = this.params.element(i) as unknown as V4;
        const ext = this.extra.element(i);
        const a = vec4(P).toVar();
        a.xyz.addAssign(u.shift);
        const life = prm.x;
        If(a.w.greaterThanEqual(life).or(u.kill.greaterThan(0.5)), () => {
          a.w.assign(max(a.w, life));
          Vb.w.assign(0);
          ext.y.assign(0);
          P.assign(a);
        }).Else(() => {
          const dt = u.dt;
          a.w.addAssign(dt);
          const t = min(a.w.div(life), 1);
          const look = uint(prm.y);
          const m = look.mul(uint(MOTION_ROWS)).add(uint(this.motionBase));
          const mo = this.tables.element(m) as unknown as V4;
          const mo2 = this.tables.element(m.add(uint(1))) as unknown as V4;
          const row0 = this.table(look, t, 0);
          const row1 = this.table(look, t, 1);
          const w = a.xyz.add(u.anchor);
          const dist = length(w);
          const up = w.div(dist);
          const height = dist.sub(ext.x);
          const shear = float(GROUND_WIND).add(
            float(1 - GROUND_WIND).mul(smoothstep(0, SHEAR_HEIGHT, height)),
          );
          const seed = prm.w;
          const n = vec3(
            sin(seed.mul(12.9898).add(u.time.mul(0.9)).add(a.y.mul(0.013))),
            sin(seed.mul(7.233).add(u.time.mul(0.7)).add(a.z.mul(0.011))),
            sin(seed.mul(3.137).add(u.time.mul(1.1)).add(a.x.mul(0.017))),
          );
          const fan = vec3(
            sin(seed.mul(1.713).add(0.5)),
            sin(seed.mul(2.917).add(1.3)),
            sin(seed.mul(4.331).add(2.1)),
          );
          const k = min(mo.y.mul(dt), 1);
          const target = u.wind
            .mul(mo.w.mul(shear))
            .add(up.mul(mo.x.mul(row1.z)))
            .add(fan.mul(mo.z.mul(FAN)));
          const v = vec3(Vb.xyz).toVar();
          v.addAssign(
            target
              .sub(v)
              .mul(k)
              .add(n.mul(mo.z.mul(dt))),
          );
          a.xyz.addAssign(v.mul(dt));
          const radius = prm.z.mul(row1.x);
          // Never more than halfway into the ground it was born over.
          const h2 = height.add(dot(v, up).mul(dt));
          const least = radius.mul(SINK);
          If(h2.lessThan(least), () => {
            a.xyz.addAssign(up.mul(least.sub(h2)));
            v.subAssign(up.mul(min(dot(v, up), 0)));
          });
          P.assign(a);
          Vb.assign(vec4(v, radius));
          const tint = (this.tint.element(i) as unknown as V4).xyz;
          this.color.element(i).assign(vec4(row0.xyz.mul(tint), row0.w));
          ext.y.assign(row1.y);
          ext.z.assign(mo2.x);
        });
      });
    })();
  }

  private buildSpawn() {
    const u = this.u;
    return Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(u.spawnCount), () => {
        const r = i.mul(uint(SPAWN_FLOATS / 4));
        const s0 = this.staging.element(r) as unknown as V4;
        const s1 = this.staging.element(r.add(uint(1))) as unknown as V4;
        const s2 = this.staging.element(r.add(uint(2))) as unknown as V4;
        const s3 = this.staging.element(r.add(uint(3))) as unknown as V4;
        const slot = uint(s0.w);
        const look = uint(s2.x);
        const t = min(s3.w.div(s1.w), 1);
        const row0 = this.table(look, t, 0);
        const row1 = this.table(look, t, 1);
        const mo2 = this.tables.element(
          look.mul(uint(MOTION_ROWS)).add(uint(this.motionBase + 1)),
        ) as unknown as V4;
        this.pos.element(slot).assign(vec4(s0.xyz, s3.w));
        this.vel.element(slot).assign(vec4(s1.xyz, s2.y.mul(row1.x)));
        this.params.element(slot).assign(vec4(s1.w, s2.x, s2.y, s2.z));
        this.extra.element(slot).assign(vec4(s2.w, row1.y, mo2.x, 0));
        this.tint.element(slot).assign(vec4(s3.xyz, 0));
        this.color.element(slot).assign(vec4(row0.xyz.mul(s3.xyz), row0.w));
      });
    })();
  }

  /**
   * Runs the frame's update, then its spawns. `dt` and `time` are the effect clock's, the
   * vectors as float32 holds them.
   */
  run(
    renderer: WebGPURenderer,
    o: {
      dt: number;
      time: number;
      wind: readonly [number, number, number];
      anchor: readonly [number, number, number];
      shift: readonly [number, number, number];
      kill: boolean;
    },
  ): void {
    const u = this.u;
    const pool = this.pool;
    u.dt.value = o.dt;
    u.time.value = o.time;
    u.wind.value.set(...o.wind);
    u.anchor.value.set(...o.anchor);
    u.shift.value.set(...o.shift);
    u.kill.value = o.kill ? 1 : 0;
    // A cut kills the whole pool: its slots above the high-water mark may still be alive on
    // the GPU.
    u.highWater.value = o.kill ? pool.capacity : pool.highWater;
    this.dispatches = 0;
    if (u.highWater.value > 0) {
      void renderer.compute(this.updateKernel);
      this.dispatches++;
    }
    if (pool.pending > 0) {
      u.spawnCount.value = pool.pending;
      const attr = this.staging.value as unknown as {
        needsUpdate: boolean;
        clearUpdateRanges(): void;
        addUpdateRange(start: number, count: number): void;
      };
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, pool.pending * SPAWN_FLOATS);
      attr.needsUpdate = true;
      void renderer.compute(this.spawnKernel);
      this.dispatches++;
    }
    pool.flush();
  }

  /** Reads every buffer back (tests and tools). */
  async read(renderer: WebGPURenderer): Promise<Record<string, Float32Array>> {
    const out: Record<string, Float32Array> = {};
    for (const k of ['pos', 'vel', 'color', 'params', 'extra'] as const) {
      out[k] = new Float32Array(await renderer.getArrayBufferAsync(this[k].value));
    }
    return out;
  }

  dispose(): void {
    this.updateKernel.dispose();
    this.spawnKernel.dispose();
  }
}
