/**
 * Roads, airfield pavement and settlement lights in the terrain fragment
 * shader (decision 65).
 *
 * - **Roads** use the river machinery (decision 54): exact distance to
 *   segment lists per tile (RiverTables). A segment with a negative width is
 *   concrete (runways, taxiways, aprons); others are asphalt. Roads narrower
 *   than `minPixels` are drawn that wide at `legibility` strength.
 * - **Lights** are disks of warm light per settlement and airbase, with a
 *   smooth falloff, in tiered lists (LightTables). A rural glow from the
 *   graph's habitability map, broken into village-sized speckles, fills the
 *   land between towns. The terrain adds both on the night side only.
 * - **Built-up patches** ride on the same records (decision 71): each town
 *   and industrial site is a patch of roofs and walls (or concrete) in the
 *   terrain by day, in place of instanced buildings.
 */
import { Color, StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  float,
  floor,
  Fn,
  fract,
  If,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  select,
  sin,
  storage,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { tileForDirection, tileKey, tileKeyString } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import type { RiverRange, RiverTables } from '../../common/water/riverTables';
import { localFrame } from './infraScene';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** How roads are drawn; shared across materials, so GUI settings survive world changes. */
export class RoadStyle {
  readonly minPixels = uniform(1.4);
  readonly legibility = uniform(0.65);
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
  coverage(planetPosition: V3, start: F, count: F, footprint: F, gate?: Node<'bool'>): V2 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const fp = max(footprint, 0.05);
      const cover = float(0).toVar();
      const concrete = float(0).toVar();
      const first = int(start);
      // No segments where the gate fails (e.g. at sea), or with roads hidden.
      const run = this.style.enabled.greaterThan(0);
      const end = select(gate ? gate.and(run) : run, int(count), int(0));
      Loop({ start: int(0), end, type: 'int' }, ({ i }) => {
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

/**
 * Light lists in three tiers, so coarse meshes loop over few lights:
 * per face (levels 0–1) only lights of at least TIER_RADIUS[0], per level-2
 * tile (levels 2–3) those of at least TIER_RADIUS[1], per level-4 tile
 * (levels 4 and finer) every light. Villages below a tier show there through
 * the rural glow instead.
 */
export const LIGHT_LEVELS = [0, 2, 4] as const;
export const LIGHT_LEVEL = 2;
const TIER_RADIUS = [5000, 2000, 0];

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
      const r = lights[i * 8 + 3]!;
      const reach = (r + 2000) / radius;
      const { east, north } = localFrame(p);
      LIGHT_LEVELS.forEach((level, tier) => {
        if (r < TIER_RADIUS[tier]!) return;
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
      });
    }
    const all: number[] = [];
    for (const [key, ids] of byTile) {
      this.ranges.set(key, { start: all.length, count: ids.length });
      all.push(...ids);
    }
    this.lists = Uint32Array.from(all.length ? all : [0]);
  }

  rangeFor(t: TileKey): RiverRange {
    const level = [...LIGHT_LEVELS].reverse().find((l) => t.level >= l) ?? 0;
    const s = t.level - level;
    return (
      this.ranges.get(tileKeyString(tileKey(t.face, level, t.x >> s, t.y >> s))) ?? {
        start: 0,
        count: 0,
      }
    );
  }
}

/**
 * Speckle 0..1 for rural lights: value noise on a CELL m lattice of planet
 * positions, so the countryside glows in village-sized dots, not evenly.
 */
export function ruralSpeckle(planetPosition: V3, cell = 2500): F {
  return Fn(() => {
    const q = planetPosition.div(cell);
    const i = floor(q);
    const f = fract(q);
    const w = f.mul(f).mul(float(3).sub(f.mul(2)));
    const hash = (o: [number, number, number]) =>
      fract(sin(dot(i.add(vec3(...o)), vec3(127.1, 311.7, 74.7))).mul(43758.5453));
    const x00 = mix(hash([0, 0, 0]), hash([1, 0, 0]), w.x);
    const x10 = mix(hash([0, 1, 0]), hash([1, 1, 0]), w.x);
    const x01 = mix(hash([0, 0, 1]), hash([1, 0, 1]), w.x);
    const x11 = mix(hash([0, 1, 1]), hash([1, 1, 1]), w.x);
    return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
  })() as F;
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
   * One pass over the light list at a planet-centered position:
   * (town cover, industry cover, emission).
   *
   * - **Built-up patches** (decision 71): a disk of each record's built-up
   *   radius, its edge broken by `edgeNoise` (0..1, a few km across) and
   *   softened over a quarter radius. A patch is at least `minPixels` wide,
   *   its cover thinned by the area ratio, so towns stay visible as dots from
   *   altitude without growing.
   * - **Emission** (relative units, before color): Σ intensity × (1 − (d / r)²)²,
   *   each disk at least 1.5 pixels wide so towns stay visible from orbit.
   */
  sample(planetPosition: V3, start: F, count: F, footprint: F, edgeNoise: F): V3 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const town = float(0).toVar();
      const industry = float(0).toVar();
      const total = float(0).toVar();
      const first = int(start);
      const minRadius = max(footprint, 1).mul(1.5);
      const minBuilt = max(footprint, 1).mul(1.2);
      const wobble = edgeNoise.sub(0.5).mul(0.5).add(1);
      Loop({ start: int(0), end: int(count), type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.lights.element(id.mul(2));
        const b = this.lights.element(id.mul(2).add(1));
        const d = length(p.sub(a.xyz)).mul(this.radius);
        // Night light.
        const r = max(a.w, minRadius);
        const scale = min(a.w.div(r), 1);
        const x = clamp(float(1).sub(d.mul(d).div(r.mul(r))), 0, 1);
        total.addAssign(b.x.mul(x.mul(x)).mul(scale.mul(scale).mul(0.7).add(0.3)));
        // Built-up patch.
        const built = b.y.mul(wobble);
        const shown = max(built, minBuilt);
        const thin = min(built.div(shown), 1);
        const edge = max(shown.mul(0.25), footprint);
        const c = clamp(shown.sub(d).div(edge), 0, 1)
          .mul(thin.mul(thin))
          .mul(select(b.y.greaterThan(0), float(1), float(0)));
        If(b.z.lessThan(0.5), () => town.assign(max(town, c))).Else(() =>
          industry.assign(max(industry, c)),
        );
      });
      return vec3(town, industry, total);
    })() as V3;
  }
}

/**
 * Albedo of a built-up patch (decision 71): blocks of roofs and walls in the
 * settlement palette of docs/visual-style.md on a BLOCK m lattice, fading to
 * their mean where blocks shrink below a few pixels; industry in concrete.
 * `industry` is the share of industrial cover.
 */
const BLOCK = 70;
export function builtAlbedo(planetPosition: V3, footprint: F, industry: F): V3 {
  return Fn(() => {
    const lin = (h: number) => {
      const c = new Color().setHex(h);
      return vec3(c.r, c.g, c.b);
    };
    const roofRed = lin(0x8e5a48);
    const roofGray = lin(0x5e5e62);
    const wallA = lin(0xc9bfaf);
    const wallB = lin(0xb5a898);
    const concrete = lin(0x9a968e);
    const h = fract(
      sin(dot(floor(planetPosition.div(BLOCK)), vec3(127.1, 311.7, 74.7))).mul(43758.5453),
    );
    const block = select(
      h.lessThan(0.3),
      roofRed,
      select(h.lessThan(0.55), roofGray, select(h.lessThan(0.8), wallA, wallB)),
    );
    const mean = roofRed.mul(0.3).add(roofGray.mul(0.25)).add(wallA.mul(0.25)).add(wallB.mul(0.2));
    const resolved = clamp(
      float(BLOCK / 3)
        .div(max(footprint, 1e-3))
        .sub(1),
      0,
      1,
    );
    const townColor = mix(mean, block, resolved);
    return mix(townColor, concrete, industry);
  })() as V3;
}

/** Selects a factor of 0 on the day side to 1 at night, from the sun's elevation at `up`. */
export function nightFactor(up: V3, sunDirection: V3): F {
  return clamp(dot(up, sunDirection).mul(-1).add(0.03).div(0.15), 0, 1) as F;
}
