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
  atan,
  clamp,
  cos,
  cross,
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
  mod,
  normalize,
  select,
  sin,
  smoothstep,
  step,
  storage,
  uint,
  uniform,
  ivec3,
  vec3,
  vec4,
} from 'three/tsl';
import { cellHashNode, hashBitsNode } from '../../common/canopyNode';
import type { CityGround } from '../city/cityGround';
import {
  CORE_SHARE,
  INNER_SHARE,
  MAJOR_EVERY,
  MAJOR_HALF,
  MINOR_HALF,
  SIDEWALK,
  URBAN_HASH_Z,
} from './urbanPattern';
import { tileForDirection, tileKey, tileKeyString } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import type { RiverRange, RiverTables } from '../../common/water/riverTables';
import { URBAN_VERTICES } from '../../../worldgen/strategic/graph';
import { localFrame } from './infraScene';
import { runwayMarks } from './runwayMarkings';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

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
   * (coverage, concrete, shoulder, ballast) at a planet-centered position: coverage 0..1 by
   * any paved segment, how much of that is concrete, and the dark shoulder outside
   * wide concrete (runways and aprons, decision 221): a band SHOULDER_WIDTH m wide,
   * at least SHOULDER_PIXELS wide on screen, so a field reads from the air.
   */
  coverage(planetPosition: V3, start: F, count: F, footprint: F, gate?: Node<'bool'>): V4 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const fp = max(footprint, 0.05);
      const cover = float(0).toVar();
      const concrete = float(0).toVar();
      const shoulder = float(0).toVar();
      const ballast = float(0).toVar();
      const band = max(float(SHOULDER_WIDTH), fp.mul(SHOULDER_PIXELS));
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
        // Railways are the only concrete narrower than RAIL_MAX_HALF: their ballast (decision 259).
        ballast.assign(
          max(
            ballast,
            select(signed.lessThan(0).and(halfWidth.lessThan(RAIL_MAX_HALF)), c, float(0)),
          ),
        );
        // Outside the drawn edge, over a band, on concrete at least SHOULDER_MIN_HALF wide.
        const outside = d.sub(drawn);
        const s = clamp(float(0.5).add(outside.div(fp)), 0, 1)
          .mul(clamp(float(0.5).sub(outside.sub(band).div(fp)), 0, 1))
          .mul(select(signed.lessThan(-SHOULDER_MIN_HALF), float(1), float(0)));
        shoulder.assign(max(shoulder, s));
      });
      return vec4(cover, concrete, shoulder.mul(float(1).sub(cover)), ballast).mul(
        this.style.enabled,
      );
    })() as V4;
  }

  /**
   * 1 where a planet-centered position lies within `margin` m of any paved
   * segment's edge, else 0: the lane cut through a forest's canopy shell along
   * roads, runways and taxiways (decision 148). Independent of the style, so
   * hiding the road paint does not close the lanes.
   */
  clearance(planetPosition: V3, start: F, count: F, margin: F, gate?: Node<'bool'>): F {
    return Fn(() => {
      const p = normalize(planetPosition);
      const clear = float(0).toVar();
      const first = int(start);
      const end = gate ? select(gate, int(count), int(0)) : int(count);
      Loop({ start: int(0), end, type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.segments.element(id.mul(2));
        const b = this.segments.element(id.mul(2).add(1));
        const ab = b.xyz.sub(a.xyz);
        const t = clamp(dot(p.sub(a.xyz), ab).div(max(dot(ab, ab), 1e-20)), 0, 1);
        const d = length(p.sub(a.xyz.add(ab.mul(t)))).mul(this.radius);
        const halfWidth = abs(mix(a.w, b.w, t));
        clear.assign(max(clear, select(d.lessThan(halfWidth.add(margin)), float(1), float(0))));
      });
      return clear;
    })() as F;
  }
}

/**
 * Light lists in three tiers, so coarse meshes loop over few lights:
 * per face (levels 0–1) only lights of at least TIER_RADIUS[0], per level-2
 * tile (levels 2–3) those of at least TIER_RADIUS[1], per level-4 tile
 * (levels 4 and finer) every light. Villages below a tier show there through
 * the rural glow instead.
 */
/** Dark shoulders along runways and aprons (decision 221): width (m), least width on screen (px). */
export const SHOULDER_WIDTH = 12;
export const SHOULDER_PIXELS = 2;
/**
 * Concrete half-widths (m) above this get shoulders: runways (22.5) and aprons (70),
 * not taxiways (11.5).
 */
export const SHOULDER_MIN_HALF = 15;
/** Concrete segments narrower than this (m) are railway beds, drawn as ballast (decision 259). */
export const RAIL_MAX_HALF = 6;

export const LIGHT_LEVELS = [0, 2, 4] as const;
export const LIGHT_LEVEL = 2;
const TIER_RADIUS = [5000, 2000, 0];

export class LightTables {
  /** Two vec4 per light: (direction, radius), (intensity, built-up radius, kind, extra). */
  readonly lights: Float32Array;
  readonly lists: Uint32Array;
  /** Towns' urban extent radii, URBAN_VERTICES each (InfraScene.outlines). */
  readonly outlines: Float32Array;
  /** The urban ground's pattern, one vec4 per light (InfraScene.townInfo; decision 259). */
  readonly info: Float32Array;
  private readonly ranges = new Map<string, RiverRange>();

  constructor(lights: Float32Array, radius: number, outlines?: Float32Array, info?: Float32Array) {
    this.lights = lights.length ? lights : new Float32Array(8);
    this.outlines = outlines?.length ? outlines : new Float32Array(1);
    this.info =
      info && info.length === (this.lights.length / 8) * 4
        ? info
        : new Float32Array((this.lights.length / 8) * 4);
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
  private readonly outlines;
  /** Where the pattern's vec4s start in the outlines buffer (decision 259; one buffer fewer). */
  private readonly infoBase: number;
  /** Beyond this distance (m) the urban ground gives way to its roofs (decision 259). */
  readonly groundRange = uniform(11_000);

  constructor(
    tables: LightTables | null,
    private readonly radius: number,
  ) {
    const l = tables?.lights ?? new Float32Array(8);
    const lists = tables?.lists ?? new Uint32Array(1);
    this.lights = storage(new StorageBufferAttribute(l, 4), 'vec4', l.length / 4).toReadOnly();
    this.lists = storage(new StorageBufferAttribute(lists, 1), 'uint', lists.length).toReadOnly();
    // The outlines and, after them, the pattern's four floats per light: one storage
    // buffer, since the terrain's fragment stage is at WebGPU's default of 8.
    const o = tables?.outlines ?? new Float32Array(1);
    const inf = tables?.info ?? new Float32Array(4);
    const both = new Float32Array(o.length + inf.length);
    both.set(o);
    both.set(inf, o.length);
    this.infoBase = o.length;
    this.outlines = storage(new StorageBufferAttribute(both, 1), 'float', both.length).toReadOnly();
  }

  /**
   * For the canopy shell (decision 278): the nearest town's built mask at a planet-centered
   * position: 1 built, 0 natural ground, −1 unplanned (or no town).
   */
  plannedBuilt(planetPosition: V3, start: F, count: F, city: CityGround): F {
    return Fn(() => {
      const p = normalize(planetPosition);
      const best = float(1e9).toVar();
      const bestId = int(-1).toVar();
      const first = int(start);
      Loop({ start: int(0), end: int(count), type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.lights.element(id.mul(2));
        const b = this.lights.element(id.mul(2).add(1));
        const share = length(p.sub(a.xyz)).mul(this.radius).div(max(b.y, 1));
        If(b.z.lessThan(0.5).and(b.y.greaterThan(0)).and(share.lessThan(best)), () => {
          best.assign(share);
          bestId.assign(id);
        });
      });
      const out = float(-1).toVar();
      If(bestId.greaterThanEqual(0), () => {
        out.assign(city.builtAt(p, this.lights.element(bestId.mul(2)).xyz, bestId));
      });
      return out;
    })() as F;
  }

  /**
   * The urban ground's albedo at a planet-centered position inside a built-up patch
   * (proposal 0009, Phase 1; decision 259): the nearest town's or industrial site's
   * street pattern (`urbanPattern.ts`) of asphalt streets, sidewalks, squares, parks,
   * parking lots, courtyards, gardens and yards, or concrete and gravel for industry.
   * Where a block shrinks below a few pixels, or beyond `groundRange`, it gives way to
   * the roofs of `builtAlbedo`, the far representation. Call it inside built-up cover only.
   */
  urbanGround(
    planetPosition: V3,
    start: F,
    count: F,
    footprint: F,
    distance: F,
    city?: CityGround | null,
  ): V4 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const best = float(1e9).toVar();
      const bestId = int(-1).toVar();
      const bestD = float(0).toVar();
      const bestR = float(1).toVar();
      const bestIndustry = float(0).toVar();
      const first = int(start);
      Loop({ start: int(0), end: int(count), type: 'int' }, ({ i }) => {
        const id = this.lists.element(first.add(i)).toInt();
        const a = this.lights.element(id.mul(2));
        const b = this.lights.element(id.mul(2).add(1));
        const d = length(p.sub(a.xyz)).mul(this.radius);
        const share = d.div(max(b.y, 1));
        If(b.z.lessThan(1.5).and(b.y.greaterThan(0)).and(share.lessThan(best)), () => {
          best.assign(share);
          bestId.assign(id);
          bestD.assign(d);
          bestR.assign(b.y);
          bestIndustry.assign(select(b.z.greaterThan(0.5), float(1), float(0)));
        });
      });
      const roofs = builtAlbedo(planetPosition, footprint, bestIndustry);
      const out = roofs.toVar();
      // How much of the built-up cover the urban ground keeps (0: the natural ground).
      const keep = float(1).toVar();
      // Planned towns (decision 266) draw their plan's ground near the camera.
      const planned = vec4(0).toVar();
      if (city) {
        If(bestId.greaterThanEqual(0), () => {
          planned.assign(city.ground(p, this.lights.element(bestId.mul(2)).xyz, bestId, footprint));
        });
      }
      const near = float(1).sub(smoothstep(this.groundRange.mul(0.8), this.groundRange, distance));
      If(planned.w.greaterThan(0.4), () => {
        out.assign(mix(roofs, planned.xyz, near));
      })
        .ElseIf(planned.w.greaterThan(0.1), () => {
          keep.assign(0);
        })
        .ElseIf(bestId.greaterThanEqual(0), () => {
          const at = int(this.infoBase).add(bestId.mul(4));
          const g = vec4(
            this.outlines.element(at),
            this.outlines.element(at.add(1)),
            this.outlines.element(at.add(2)),
            this.outlines.element(at.add(3)),
          );
          const S = g.y;
          If(S.greaterThan(0), () => {
            const c = this.lights.element(bestId.mul(2)).xyz;
            const east = normalize(cross(vec3(0, 1, 0), c));
            const north = cross(c, east);
            const dp = p.sub(c);
            const x = dot(dp, east).mul(this.radius);
            const y = dot(dp, north).mul(this.radius);
            const ca = cos(g.x);
            const sa = sin(g.x);
            const u = x.mul(ca).add(y.mul(sa));
            const v = x.mul(sa).negate().add(y.mul(ca));
            const fp = max(footprint, 0.05);
            const line = (w: F) => {
              const k = floor(w.div(S).add(0.5));
              const major = mod(k, MAJOR_EVERY).lessThan(0.5);
              return abs(w.sub(k.mul(S))).sub(select(major, float(MAJOR_HALF), float(MINOR_HALF)));
            };
            const edge = min(line(u as F), line(v as F));
            const bi = floor(u.div(S));
            const bj = floor(v.div(S));
            const seed = uint(g.z);
            const h = hashBitsNode(
              cellHashNode(ivec3(int(bi), int(bj), int(URBAN_HASH_Z)), seed),
              4,
            );
            // Distance share at the block's center, so a block takes one class throughout.
            const share = length(vec3(bi.add(0.5).mul(S), bj.add(0.5).mul(S), 0)).div(bestR);
            // Gardens and yards alternate by parcel, a third of a block across.
            const pi = floor(u.div(S.div(3)));
            const pj = floor(v.div(S.div(3)));
            const hp = hashBitsNode(
              cellHashNode(ivec3(int(pi), int(pj), int(URBAN_HASH_Z + 1)), seed),
              4,
            );
            const garden = mix(URBAN_COLORS.lawn, URBAN_COLORS.yard, step(0.55, hp));
            const courtyard = mix(
              URBAN_COLORS.courtyard,
              URBAN_COLORS.yard,
              step(0.75, hp).mul(0.6),
            );
            const industrial = select(h.lessThan(0.3), URBAN_COLORS.gravel, URBAN_COLORS.concrete);
            const residential = select(
              share.lessThan(CORE_SHARE).and(h.lessThan(0.3)),
              URBAN_COLORS.square,
              select(
                h.greaterThan(0.92),
                URBAN_COLORS.park,
                select(
                  h.greaterThan(0.85).and(share.greaterThan(CORE_SHARE)),
                  URBAN_COLORS.parking,
                  select(share.lessThan(INNER_SHARE), courtyard, garden),
                ),
              ),
            );
            const block = select(bestIndustry.greaterThan(0.5), industrial, residential);
            const walk = clamp(float(0.5).sub(edge.sub(SIDEWALK).div(fp)), 0, 1);
            const street = clamp(float(0.5).sub(edge.div(fp)), 0, 1);
            const ground = mix(
              mix(block, URBAN_COLORS.sidewalk, walk),
              URBAN_COLORS.asphalt,
              street,
            );
            // Blocks below about four pixels, or beyond the ground's range, show their roofs.
            const resolved = clamp(S.div(fp.mul(4)).sub(1), 0, 1).mul(
              float(1).sub(smoothstep(this.groundRange.mul(0.8), this.groundRange, distance)),
            );
            out.assign(mix(roofs, ground, resolved));
          });
        });
      return vec4(out, keep);
    })() as V4;
  }

  /**
   * A town's urban extent radius (m) toward unit direction `p` from its center
   * `c`: its outline `shape` (1-based) interpolated by bearing, counterclockwise
   * from east, as `townRadiusToward` on the CPU.
   */
  private outlineRadius(p: V3, c: V3, shape: F): F {
    const east = normalize(cross(vec3(0, 1, 0), c));
    const north = cross(c, east);
    const d = p.sub(c);
    const bearing = atan(dot(d, north), dot(d, east));
    const t = fract(bearing.div(2 * Math.PI).add(1)).mul(URBAN_VERTICES);
    const i0 = floor(t);
    const f = t.sub(i0);
    const base = shape.sub(1).mul(URBAN_VERTICES);
    const r0 = this.outlines.element(int(base.add(i0)));
    const r1 = this.outlines.element(int(base.add(mod(i0.add(1), URBAN_VERTICES))));
    return mix(r0, r1, f) as F;
  }

  /**
   * One pass over the light list at a planet-centered position:
   * (town cover, industry cover, emission, runway paint).
   *
   * - **Built-up patches** (decision 71): a disk of each record's built-up
   *   radius, or a town's urban extent polygon where it has one (decision
   *   103), its edge broken by `edgeNoise` (0..1, a few km across) and
   *   softened over a quarter radius. A patch is at least `minPixels` wide,
   *   its cover thinned by the area ratio, so towns stay visible as dots from
   *   altitude without growing.
   * - **Emission** (relative units, before color): Σ intensity × (1 − (d / r)²)²,
   *   each disk at least 1.5 pixels wide so towns stay visible from orbit.
   * - **Runway paint** (airbase records, V3): signed cover from `runwayMarks`,
   *   positive white, negative yellow.
   */
  sample(planetPosition: V3, start: F, count: F, footprint: F, edgeNoise: F): V4 {
    return Fn(() => {
      const p = normalize(planetPosition);
      const town = float(0).toVar();
      const industry = float(0).toVar();
      const total = float(0).toVar();
      const paint = float(0).toVar();
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
        // Built-up patch: the town's outline where it has one (less wobble: it is
        // already irregular), else the disk.
        const shaped = b.z.lessThan(0.5).and(b.w.greaterThan(0.5));
        const built = b.y.mul(wobble).toVar();
        If(shaped, () => {
          built.assign(this.outlineRadius(p, a.xyz, b.w).mul(edgeNoise.sub(0.5).mul(0.2).add(1)));
        });
        const shown = max(built, minBuilt);
        const thin = min(built.div(shown), 1);
        const edge = max(shown.mul(0.25), footprint);
        const c = clamp(shown.sub(d).div(edge), 0, 1)
          .mul(thin.mul(thin))
          .mul(select(b.y.greaterThan(0), float(1), float(0)));
        If(b.z.lessThan(0.5), () => {
          town.assign(max(town, c));
        })
          .ElseIf(b.z.lessThan(1.5), () => {
            industry.assign(max(industry, c));
          })
          .ElseIf(d.lessThan(b.w.mul(0.5).add(600)), () => {
            const m = runwayMarks(p, a.xyz, b.w, this.radius, max(footprint, 0.05));
            paint.assign(select(abs(m).greaterThan(abs(paint)), m, paint));
          });
      });
      return vec4(town, industry, total, paint);
    })() as V4;
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

const linear = (h: number) => {
  const c = new Color().setHex(h);
  return vec3(c.r, c.g, c.b);
};

/**
 * The urban ground's palette (proposal 0009; decision 259), warm and muted beside the
 * settlement palette of docs/visual-style.md: asphalt as the roads, pale sidewalks and
 * squares, grass for parks and lawns, packed earth for yards, concrete and gravel for industry.
 */
export const URBAN_HEX = {
  asphalt: 0x7a7062,
  sidewalk: 0xb8b0a2,
  square: 0xc9bca4,
  park: 0x6f8a4e,
  parking: 0x8c877e,
  lawn: 0x7e9456,
  yard: 0xa69a80,
  courtyard: 0xa89f8e,
  concrete: 0x9a968e,
  gravel: 0x8a8172,
  ballast: 0x6e665c,
} as const;
const URBAN_COLORS = Object.fromEntries(
  Object.entries(URBAN_HEX).map(([k, h]) => [k, linear(h)]),
) as unknown as Record<keyof typeof URBAN_HEX, V3>;
/** Rail ballast (linear), for the railways' beds in the road shader. */
export const BALLAST = URBAN_COLORS.ballast;

/** Selects a factor of 0 on the day side to 1 at night, from the sun's elevation at `up`. */
export function nightFactor(up: V3, sunDirection: V3): F {
  return clamp(dot(up, sunDirection).mul(-1).add(0.03).div(0.15), 0, 1) as F;
}
