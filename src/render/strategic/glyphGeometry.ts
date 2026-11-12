/**
 * Glyph models for the strategic map, built in code (rule 11; decision 97). Each is
 * a list of triangles in glyph units: x and y across the ground, with the base
 * about one unit wide, and z up. Faces are not shared, so shading is flat.
 *
 * Per-vertex `part`: for a mountain, 1 on the snow cap; for a forest token, the
 * tree's index (0–6), so the shader can drop trees past the instance's count.
 *
 * Pure TypeScript for tests.
 */

export interface GlyphModel {
  /** xyz per vertex, three vertices per triangle. */
  position: Float32Array;
  part: Float32Array;
}

class ModelBuilder {
  readonly pos: number[] = [];
  readonly part: number[] = [];
  tri(a: readonly number[], b: readonly number[], c: readonly number[], part = 0): void {
    this.pos.push(...a, ...b, ...c);
    this.part.push(part, part, part);
  }
  build(): GlyphModel {
    return { position: Float32Array.from(this.pos), part: Float32Array.from(this.part) };
  }
}

const lerp3 = (a: readonly number[], b: readonly number[], t: number) => [
  a[0]! + (b[0]! - a[0]!) * t,
  a[1]! + (b[1]! - a[1]!) * t,
  a[2]! + (b[2]! - a[2]!) * t,
];

/**
 * A faceted mountain: an irregular five-sided pyramid with its apex a little off
 * center, each face split at `capAt` of its height so the top can take snow.
 */
export function mountainModel(capAt = 0.62): GlyphModel {
  const m = new ModelBuilder();
  const apex = [0.06, 0.04, 0.62];
  const radii = [0.5, 0.42, 0.5, 0.46, 0.44];
  const ring = radii.map((r, i) => {
    const a = (i / radii.length) * Math.PI * 2 + 0.3;
    return [r * Math.cos(a), r * Math.sin(a), 0];
  });
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const a2 = lerp3(a, apex, capAt);
    const b2 = lerp3(b, apex, capAt);
    m.tri(a, b, b2);
    m.tri(a, b2, a2);
    m.tri(a2, b2, apex, 1);
  }
  return m.build();
}

/** A rounded mound for hills: a low, faceted dome. */
export function moundModel(): GlyphModel {
  const m = new ModelBuilder();
  const n = 7;
  const outer: number[][] = [];
  const inner: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    outer.push([0.5 * Math.cos(a), 0.5 * Math.sin(a), 0]);
    inner.push([0.28 * Math.cos(a + 0.2), 0.28 * Math.sin(a + 0.2), 0.17]);
  }
  const top = [0.02, 0, 0.24];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m.tri(outer[i]!, outer[j]!, inner[j]!);
    m.tri(outer[i]!, inner[j]!, inner[i]!);
    m.tri(inner[i]!, inner[j]!, top);
  }
  return m.build();
}

/** Tree positions in a forest token (x, y, scale), largest first. */
const TREES: readonly [number, number, number][] = [
  [0, 0.02, 1],
  [-0.24, -0.12, 0.85],
  [0.25, -0.1, 0.9],
  [0.05, 0.27, 0.8],
  [-0.2, 0.22, 0.75],
  [0.28, 0.2, 0.7],
  [-0.02, -0.3, 0.75],
];

/** A clump of seven stylized conifers; `part` is each tree's index. */
export function forestModel(): GlyphModel {
  const m = new ModelBuilder();
  const sides = 5;
  TREES.forEach(([x, y, s], t) => {
    const r = 0.16 * s;
    const h = 0.42 * s;
    const top = [x, y, h];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2 + t;
      const a1 = ((i + 1) / sides) * Math.PI * 2 + t;
      m.tri(
        [x + r * Math.cos(a0), y + r * Math.sin(a0), 0.05 * s],
        [x + r * Math.cos(a1), y + r * Math.sin(a1), 0.05 * s],
        top,
        t,
      );
    }
  });
  return m.build();
}

/**
 * A barchan dune: a crescent whose convex back faces +x's opposite (upwind) and whose
 * horns point along +x (downwind), with a gentle windward slope up to the crest and a
 * steep slip face behind it.
 */
export function duneModel(): GlyphModel {
  const m = new ModelBuilder();
  const n = 7;
  const back: number[][] = [];
  const crest: number[][] = [];
  const slip: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * 0.85 + (i / (n - 1)) * Math.PI * 1.7; // −153° … 153°, horns at ±x
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const mid = 1 - Math.abs(i - (n - 1) / 2) / ((n - 1) / 2); // 1 at the middle, 0 at horns
    back.push([-0.5 * ca, 0.5 * sa, 0]);
    crest.push([-0.32 * ca + 0.04, 0.34 * sa, 0.12 * mid + 0.01]);
    slip.push([-0.22 * ca + 0.12, 0.26 * sa, 0]);
  }
  for (let i = 0; i < n - 1; i++) {
    m.tri(back[i]!, back[i + 1]!, crest[i + 1]!);
    m.tri(back[i]!, crest[i + 1]!, crest[i]!);
    m.tri(crest[i]!, crest[i + 1]!, slip[i + 1]!, 1);
    m.tri(crest[i]!, slip[i + 1]!, slip[i]!, 1);
  }
  return m.build();
}

// ---- Settlement glyphs (decision 104) ----

/**
 * A building: a box of half sizes (hw, hd) and wall height h at (cx, cy), turned by
 * `rot` (rad), with a gable roof `roof` high along its length, or flat when 0. Walls
 * are part 0; roofs (and flat tops) part 1, the accent color.
 */
function building(
  m: ModelBuilder,
  cx: number,
  cy: number,
  hw: number,
  hd: number,
  h: number,
  roof: number,
  rot = 0,
): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const at = (x: number, y: number, z: number) => [cx + x * c - y * s, cy + x * s + y * c, z];
  const b = [at(-hw, -hd, 0), at(hw, -hd, 0), at(hw, hd, 0), at(-hw, hd, 0)];
  const t = [at(-hw, -hd, h), at(hw, -hd, h), at(hw, hd, h), at(-hw, hd, h)];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    m.tri(b[i]!, b[j]!, t[j]!);
    m.tri(b[i]!, t[j]!, t[i]!);
  }
  if (roof <= 0) {
    m.tri(t[0]!, t[1]!, t[2]!, 1);
    m.tri(t[0]!, t[2]!, t[3]!, 1);
    return;
  }
  const r0 = at(-hw, 0, h + roof);
  const r1 = at(hw, 0, h + roof);
  m.tri(t[0]!, t[1]!, r1, 1);
  m.tri(t[0]!, r1, r0, 1);
  m.tri(t[2]!, t[3]!, r0, 1);
  m.tri(t[2]!, r0, r1, 1);
  m.tri(t[3]!, t[0]!, r0);
  m.tri(t[1]!, t[2]!, r1);
}

/** A tower with a pyramid roof (a church or a landmark). */
function tower(
  m: ModelBuilder,
  cx: number,
  cy: number,
  hw: number,
  h: number,
  spire: number,
): void {
  building(m, cx, cy, hw, hw, h, 0);
  const apex = [cx, cy, h + spire];
  const t = [
    [cx - hw, cy - hw, h],
    [cx + hw, cy - hw, h],
    [cx + hw, cy + hw, h],
    [cx - hw, cy + hw, h],
  ];
  for (let i = 0; i < 4; i++) m.tri(t[i]!, t[(i + 1) % 4]!, apex, 1);
}

/** A faceted dome on an octagonal drum (a capital's seat of government). */
function dome(m: ModelBuilder, cx: number, cy: number, r: number, h: number): void {
  const n = 8;
  const ring = (rr: number, z: number, off = 0) =>
    Array.from({ length: n }, (_, i) => {
      const a = ((i + off) / n) * Math.PI * 2;
      return [cx + rr * Math.cos(a), cy + rr * Math.sin(a), z];
    });
  const base = ring(r, 0);
  const top = ring(r, h);
  const mid = ring(r * 0.72, h + r * 0.55, 0.5);
  const apex = [cx, cy, h + r * 0.95];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m.tri(base[i]!, base[j]!, top[j]!);
    m.tri(base[i]!, top[j]!, top[i]!);
    m.tri(top[i]!, top[j]!, mid[i]!, 1);
    m.tri(top[j]!, mid[j]!, mid[i]!, 1);
    m.tri(mid[i]!, mid[j]!, apex, 1);
  }
}

/** A village: three houses with gable roofs. */
export function villageModel(): GlyphModel {
  const m = new ModelBuilder();
  building(m, -0.2, -0.12, 0.17, 0.11, 0.16, 0.12, 0.3);
  building(m, 0.2, -0.04, 0.15, 0.1, 0.15, 0.11, -0.4);
  building(m, -0.02, 0.24, 0.14, 0.1, 0.14, 0.1, 1.2);
  return m.build();
}

/** A town: houses round a square, a hall with a flat roof and a church tower. */
export function townModel(): GlyphModel {
  const m = new ModelBuilder();
  const houses: [number, number, number][] = [
    [-0.32, -0.22, 0.2],
    [0.3, -0.26, -0.3],
    [0.36, 0.14, 1.4],
    [-0.36, 0.18, 1.7],
    [-0.08, -0.36, 0.05],
    [0.08, 0.36, -0.1],
  ];
  for (const [x, y, rot] of houses) building(m, x, y, 0.12, 0.08, 0.13, 0.09, rot);
  building(m, 0.02, 0, 0.14, 0.11, 0.2, 0);
  tower(m, -0.14, 0.06, 0.05, 0.3, 0.16);
  return m.build();
}

/** City blocks: (x, y, half width, half depth, height, roof). */
const CITY_BLOCKS: readonly [number, number, number, number, number, number][] = [
  [-0.32, -0.3, 0.13, 0.11, 0.18, 0],
  [-0.02, -0.34, 0.12, 0.1, 0.24, 0],
  [0.3, -0.3, 0.12, 0.12, 0.15, 0.08],
  [-0.36, 0.02, 0.1, 0.13, 0.26, 0],
  [0.34, 0.02, 0.11, 0.12, 0.2, 0],
  [-0.3, 0.32, 0.12, 0.1, 0.14, 0.08],
  [0.02, 0.34, 0.13, 0.1, 0.18, 0],
  [0.32, 0.32, 0.1, 0.1, 0.16, 0.07],
];

/** A city: blocks of mixed heights round two towers. */
export function cityModel(): GlyphModel {
  const m = new ModelBuilder();
  for (const [x, y, hw, hd, h, r] of CITY_BLOCKS) building(m, x, y, hw, hd, h, r);
  building(m, -0.08, 0.02, 0.08, 0.08, 0.55, 0);
  building(m, 0.12, -0.06, 0.07, 0.07, 0.42, 0);
  return m.build();
}

/** A capital: the city's blocks round a domed seat of government and a tower. */
export function capitalModel(): GlyphModel {
  const m = new ModelBuilder();
  for (const [x, y, hw, hd, h, r] of CITY_BLOCKS) building(m, x, y, hw, hd, h, r);
  dome(m, 0, 0, 0.13, 0.2);
  building(m, 0.17, 0.14, 0.06, 0.06, 0.5, 0);
  return m.build();
}
