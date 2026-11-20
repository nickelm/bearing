/**
 * The settlement worker's work (decision 266), shared by the worker and the in-process
 * fallback (Node previews have no Web Workers): plans from inputs, fields from plans.
 */
import type { WorldSeed } from '../core/rng';
import { Vec3d } from '../core/vec3d';
import { globalMapSampler } from '../worldgen/edits/airfields';
import { SettlementFrame } from '../worldgen/settlements/frame';
import { chunkField, FieldIndex, packedBuffers, packPlan } from '../worldgen/settlements/pack';
import { planSettlement } from '../worldgen/settlements/plan';
import type { SettlementGround } from '../worldgen/settlements/types';
import type { FromCityWorker, ToCityWorker } from './cityProtocol';

/** Field indices kept per plan (the plans near the camera). */
const KEEP = 24;

export class CityCore {
  private height: ((d: Readonly<Vec3d>) => number) | null = null;
  private lake: ((d: Readonly<Vec3d>) => number) | null = null;
  private radius = 1e6;
  private seed: WorldSeed = 0;
  private fieldSeed = 0;
  private readonly indices = new Map<string, FieldIndex>();

  /** Handles one message; returns the reply and its transfer list. */
  handle(msg: ToCityWorker): { reply: FromCityWorker | null; transfer: ArrayBuffer[] } {
    try {
      if (msg.type === 'init') {
        this.height = globalMapSampler(msg.height, msg.n);
        this.lake = globalMapSampler(msg.lake, msg.n);
        this.radius = msg.radius;
        this.seed = msg.seed;
        this.fieldSeed = msg.fieldSeed;
        this.indices.clear();
        return { reply: null, transfer: [] };
      }
      if (msg.type === 'plan') {
        const t0 = performance.now();
        const input = { ...msg.input, ground: this.ground(msg.input.center) };
        const plan = packPlan(
          planSettlement(input, this.seed, { radius: this.radius, fieldSeed: this.fieldSeed }),
        );
        this.indices.delete(plan.key);
        this.indices.set(plan.key, new FieldIndex(plan));
        while (this.indices.size > KEEP) this.indices.delete(this.indices.keys().next().value!);
        const ms = performance.now() - t0;
        // The worker keeps its index on its own copy; the reply transfers a copy.
        const copy = { ...plan, ...cloneArrays(plan) };
        return {
          reply: { type: 'plan', id: msg.id, plan: copy, ms },
          transfer: packedBuffers(copy),
        };
      }
      const index = this.indices.get(msg.key);
      if (!index)
        return {
          reply: { type: 'error', id: msg.id, message: `no plan ${msg.key}` },
          transfer: [],
        };
      const data = chunkField(index, msg.ci, msg.cj);
      return {
        reply: { type: 'field', id: msg.id, key: msg.key, ci: msg.ci, cj: msg.cj, data },
        transfer: [data.buffer as ArrayBuffer],
      };
    } catch (e) {
      return {
        reply: { type: 'error', id: 'id' in msg ? msg.id : -1, message: String(e) },
        transfer: [],
      };
    }
  }

  private ground(center: [number, number, number]): SettlementGround {
    const frame = new SettlementFrame(center, this.radius);
    const d = new Vec3d();
    const tmp: [number, number, number] = [0, 0, 0];
    const at = (x: number, y: number) => {
      frame.toSphere(x, y, tmp);
      return d.set(tmp[0], tmp[1], tmp[2]);
    };
    const height = this.height!;
    const lake = this.lake!;
    return {
      height: (x, y) => height(at(x, y)),
      water: (x, y) => {
        const p = at(x, y);
        return height(p) <= 0 || lake(p) > 0.5;
      },
    };
  }
}

function cloneArrays<T extends object>(p: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p))
    if (ArrayBuffer.isView(v)) out[k] = (v as Float32Array).slice();
  return out as Partial<T>;
}
