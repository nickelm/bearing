/**
 * Roads, airfield pavement and settlement lights in the terrain fragment
 * shader (decision 65).
 *
 * - **Roads** use the river machinery (decision 54): exact distance to
 *   segment lists per tile (RiverTables). A segment with a negative width is
 *   concrete (runways, taxiways, aprons); others are asphalt. Roads narrower
 *   than `minPixels` are drawn that wide at `legibility` strength.
 * - **Lights** are disks of warm light per settlement and airbase, with a
 *   smooth falloff, listed per level-LIGHT_LEVEL tile (meshes at levels
 *   0–1 use per-face lists). The terrain adds them on the night side only.
 */
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  float,
  Fn,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  select,
  storage,
  uniform,
  vec2,
} from 'three/tsl';
import { tileForDirection, tileKey, tileKeyString } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import type { RiverRange, RiverTables } from '../water/riverTables';
import { localFrame } from './infraScene';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** How roads are drawn; shared across materials, so GUI settings survive world changes. */
export class RoadStyle {
  readonly minPixels = uniform(1.2);
  readonly legibility = uniform(0.45);
  /** 0 hides roads and pavement. */
  readonly enabled = uniform(1);
  /** Night light strength; 0 turns lights off. */
  readonly lights = uniform(1);
}

export class RoadShading {
  private readonly segments;
  private readonly lists;

  constructor(
    tables: RiverTables | null,
    private readonly radius: number,
    readonly style = new RoadStyle(),
  ) {
    const segs = tables?.segments ?? new Float32Array(8);
    const lists = tables?.lists ?? new Uint32Array(1);
    this.segments = storage(
      new StorageBufferAttribute(segs, 4),
      'vec4',
      segs.length / 4,
    ).toReadOnly();
    this.lists = storage(new StorageBufferAttribute(lists, 1), 'uint', lists.length).toReadOnly();
  }

  /**
   * (coverage, concrete) at a planet-centered position: coverage 0..1 by any
   * paved segment, and how much of that is concrete.
   */
  coverage(planetPosition: V3, start: F, count: F, footprint: F): V2 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const fp = max(footprint, 0.05);
      const cover = float(0).toVar();
      const concrete = float(0).toVar();
      const first = int(start);
      Loop({ start: int(0), end: int(count), type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.segments.element(id.mul(2));
        const b = this.segments.element(id.mul(2).add(1));
        const ab = b.xyz.sub(a.xyz);
        const t = clamp(dot(p.sub(a.xyz), ab).div(max(dot(ab, ab), 1e-20)), 0, 1);
        const d = length(p.sub(a.xyz.add(ab.mul(t)))).mul(this.radius);
        const signed = mix(a.w, b.w, t);
        const halfWidth = abs(signed);
        const drawn = max(halfWidth, fp.mul(this.style.minPixels).mul(0.5));
        const strength = mix(min(halfWidth.div(drawn), 1), float(1), this.style.legibility);
        const c = clamp(float(0.5).sub(d.sub(drawn).div(fp)), 0, 1).mul(strength);
        cover.assign(max(cover, c));
        concrete.assign(max(concrete, select(signed.lessThan(0), c, float(0))));
      });
      return vec2(cover, concrete).mul(this.style.enabled);
    })() as V2;
  }
}

/** Light lists: per level-LIGHT_LEVEL tile, and per face for the coarsest meshes. */
export const LIGHT_LEVEL = 2;

export class LightTables {
  /** Two vec4 per light: (direction, radius), (intensity, 0, 0, 0). */
  readonly lights: Float32Array;
  readonly lists: Uint32Array;
  private readonly ranges = new Map<string, RiverRange>();

  constructor(lights: Float32Array, radius: number) {
    this.lights = lights.length ? lights : new Float32Array(8);
    const count = lights.length / 8;
    const byTile = new Map<string, number[]>();
    const p = new Vec3d();
    const q = new Vec3d();
    for (let i = 0; i < count; i++) {
      p.set(lights[i * 8]!, lights[i * 8 + 1]!, lights[i * 8 + 2]!);
      const reach = (lights[i * 8 + 3]! + 2000) / radius;
      const { east, north } = localFrame(p);
      for (const level of [0, LIGHT_LEVEL]) {
        const keys = new Set<string>();
        for (let k = -1; k < 8; k++) {
          q.copy(p);
          if (k >= 0) {
            const a = (k / 8) * 2 * Math.PI;
            q.addScaled(east, reach * Math.cos(a))
              .addScaled(north, reach * Math.sin(a))
              .normalize();
          }
          keys.add(tileKeyString(tileForDirection(q, level)));
        }
        for (const key of keys) {
          let l = byTile.get(key);
          if (!l) byTile.set(key, (l = []));
          l.push(i);
        }
      }
    }
    const all: number[] = [];
    for (const [key, ids] of byTile) {
      this.ranges.set(key, { start: all.length, count: ids.length });
      all.push(...ids);
    }
    this.lists = Uint32Array.from(all.length ? all : [0]);
  }

  rangeFor(t: TileKey): RiverRange {
    const level = t.level >= LIGHT_LEVEL ? LIGHT_LEVEL : 0;
    const s = t.level - level;
    return (
      this.ranges.get(tileKeyString(tileKey(t.face, level, t.x >> s, t.y >> s))) ?? {
        start: 0,
        count: 0,
      }
    );
  }
}

export class LightShading {
  private readonly lights;
  private readonly lists;

  constructor(
    tables: LightTables | null,
    private readonly radius: number,
  ) {
    const l = tables?.lights ?? new Float32Array(8);
    const lists = tables?.lists ?? new Uint32Array(1);
    this.lights = storage(new StorageBufferAttribute(l, 4), 'vec4', l.length / 4).toReadOnly();
    this.lists = storage(new StorageBufferAttribute(lists, 1), 'uint', lists.length).toReadOnly();
  }

  /**
   * Light emitted at a planet-centered position (relative units, before
   * color): Σ intensity × (1 − (d / r)²)², each disk at least `minPixels`
   * pixels wide so towns stay visible from orbit.
   */
  emission(planetPosition: V3, start: F, count: F, footprint: F): F {
    return Fn(() => {
      const p = normalize(planetPosition);
      const total = float(0).toVar();
      const first = int(start);
      const minRadius = max(footprint, 1).mul(1.5);
      Loop({ start: int(0), end: int(count), type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.lights.element(id.mul(2));
        const b = this.lights.element(id.mul(2).add(1));
        const r = max(a.w, minRadius);
        // Spread over a wider disk, keep the light's total output.
        const scale = min(a.w.div(r), 1);
        const d = length(p.sub(a.xyz)).mul(this.radius);
        const x = clamp(float(1).sub(d.mul(d).div(r.mul(r))), 0, 1);
        total.addAssign(b.x.mul(x.mul(x)).mul(scale.mul(scale).mul(0.7).add(0.3)));
      });
      return total;
    })() as F;
  }
}

/** Selects a factor of 0 on the day side to 1 at night, from the sun's elevation at `up`. */
export function nightFactor(up: V3, sunDirection: V3): F {
  return clamp(dot(up, sunDirection).mul(-1).add(0.03).div(0.15), 0, 1) as F;
}
