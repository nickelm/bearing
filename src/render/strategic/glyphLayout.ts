/**
 * Where the map's geographic glyphs go (visual-style Part II, Geographic Glyphs;
 * decision 97). Pure TypeScript, so it is unit-tested in Node; glyphLayer.ts draws
 * the result.
 *
 * - **Mountains.** Faceted pyramids in chains along each range's ridge line, at
 *   `ridgeSpacing` (about half a glyph's width, so they overlap into a chain),
 *   zigzagging a little across it; then the higher parts of the range fill with
 *   smaller glyphs at `fillSpacing` where the ground is also steep. Peaks get their own glyph sized by
 *   prominence, and clear chain glyphs out of their way. A glyph is snow-capped
 *   where the annual mean temperature at its point is below freezing.
 * - **Hills.** Rounded mounds over hills features.
 * - **Forest tokens.** Clumps of 3–7 trees, 2–5 km across, sparse over forest
 *   features, in the Region band only (Part II).
 * - **Dunes.** Crescents over sand (hot desert) cells of desert features, horns
 *   downwind when the wind is known.
 *
 * Each glyph belongs to the Theater or the Region band; sizes and spacings are set
 * per band so glyphs keep a roughly constant size in pixels within the band
 * (Part II principle 3). Placement is a deterministic dart throw: candidate cells
 * in hashed order, kept if no glyph of the same set lies within the spacing.
 */
import type { CubeGrid } from '../../core/cubeGrid';
import { FeatureKind, featurePolyline } from '../../worldgen/strategic/graph';
import type { FeatureList, Point } from '../../worldgen/strategic/graph';

export type GlyphKind = 'mountain' | 'mound' | 'forest' | 'dune' | SettlementGlyph;
/** Settlement glyphs by class (decision 104; infra/cityGlyphs.ts places them). */
export type SettlementGlyph = 'village' | 'town' | 'city' | 'capital';
export const SETTLEMENT_GLYPHS: readonly SettlementGlyph[] = ['village', 'town', 'city', 'capital'];
export const GLYPH_KINDS: readonly GlyphKind[] = [
  'mountain',
  'mound',
  'forest',
  'dune',
  ...SETTLEMENT_GLYPHS,
];
export type GlyphBand = 'theater' | 'region';
export const GLYPH_BANDS: readonly GlyphBand[] = ['theater', 'region'];

/** Instances of one glyph kind in one band. */
export interface GlyphSet {
  kind: GlyphKind;
  band: GlyphBand;
  count: number;
  /** Unit direction xyz and raw terrain height (m): four floats per glyph. */
  position: Float32Array;
  /** Base width (m), heading (rad, from east toward north), snow 0/1, variant: four floats. */
  shape: Float32Array;
}

export interface GlyphInput {
  features: FeatureList;
  /** The grid the features were extracted on (their raster layers). */
  grid: CubeGrid;
  radius: number;
  reliefScale: number;
  /** Raw terrain height (m) at a unit direction. */
  heightAt(x: number, y: number, z: number): number;
  /** True where a glyph at this direction carries snow. */
  snowAt(x: number, y: number, z: number): boolean;
  /** True on sand (hot desert) at this feature-grid cell. */
  sandAt(cell: number): boolean;
  /** Prevailing wind heading (rad, from east toward north) at a cell, if known. */
  windAt?(cell: number): number | null;
}

/** Region fill threshold (decision 97); the Theater fill needs taller ground. */
const FILL_MIN_TALL_REGION = 0.3;

/** Per-band spacing (m) and base width (m) of each glyph kind. */
export const GLYPH_TUNING = {
  theater: {
    ridgeSpacing: 22e3,
    // 20% smaller than decision 97's, with a sparse fill on the taller ground only
    // (decision 102), so ranges read as chains and massifs rather than one mass.
    mountainWidth: [24e3, 40e3],
    fillSpacing: 50e3,
    fillMinTall: 0.45,
    peakWidth: [35e3, 48e3],
    peakMinImportance: 0.55,
    hillSpacing: 40e3,
    hillWidth: 22e3,
    duneSpacing: 45e3,
    duneWidth: 18e3,
  },
  region: {
    ridgeSpacing: 6.5e3,
    mountainWidth: [10e3, 17e3],
    fillMinTall: FILL_MIN_TALL_REGION,
    fillSpacing: 9e3,
    peakWidth: [15e3, 22e3],
    peakMinImportance: 0,
    hillSpacing: 12e3,
    hillWidth: 7e3,
    duneSpacing: 13e3,
    duneWidth: 5.5e3,
    forestSpacing: 13e3,
    forestKeep: 0.6,
    forestWidth: [2.5e3, 5e3],
  },
} as const;
/**
 * Mounds and dunes keep this share of the darts that pass the spacing test, and move
 * by up to `SCATTER_NUDGE` of the spacing (decision 102): a maximal dart throw packs
 * into visible rows, as forest tokens already avoid with `forestKeep`.
 */
export const SCATTER_KEEP = 0.6;
export const SCATTER_NUDGE = 0.2;

/** Range cells below this tallness (0..1, reference 600–3,000 m: 1,320 m) get no fill glyphs. */
export const FILL_MIN_TALL = 0.3;
/** Fill glyphs also need this reference slope (rise over run), so high flat ground stays bare. */
export const FILL_MIN_SLOPE = 0.05;

/** A stable hash of an integer and a salt to [0, 1). */
export function hash01(i: number, salt: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Spatial hash of points for minimum-distance tests (chord distance ≈ arc at these scales). */
class PointBins {
  private readonly bins = new Map<string, Point[]>();
  constructor(
    private readonly cell: number,
    private readonly radius: number,
  ) {}
  private key(p: Readonly<Point>, dx = 0, dy = 0, dz = 0): string {
    const k = this.radius / this.cell;
    return `${Math.floor(p[0] * k) + dx},${Math.floor(p[1] * k) + dy},${Math.floor(p[2] * k) + dz}`;
  }
  near(p: Readonly<Point>, d: number): boolean {
    const d2 = (d / this.radius) ** 2;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const q of this.bins.get(this.key(p, dx, dy, dz)) ?? []) {
            const ex = q[0] - p[0];
            const ey = q[1] - p[1];
            const ez = q[2] - p[2];
            if (ex * ex + ey * ey + ez * ez < d2) return true;
          }
        }
    return false;
  }
  add(p: Point): void {
    const k = this.key(p);
    let list = this.bins.get(k);
    if (!list) this.bins.set(k, (list = []));
    list.push(p);
  }
}

class SetBuilder {
  readonly position: number[] = [];
  readonly shape: number[] = [];
  readonly points: Point[] = [];
  constructor(
    readonly kind: GlyphKind,
    readonly band: GlyphBand,
  ) {}
  push(p: Point, height: number, width: number, heading: number, snow: boolean, variant: number) {
    this.position.push(p[0], p[1], p[2], height);
    this.shape.push(width, heading, snow ? 1 : 0, variant);
    this.points.push(p);
  }
  build(): GlyphSet {
    return {
      kind: this.kind,
      band: this.band,
      count: this.points.length,
      position: Float32Array.from(this.position),
      shape: Float32Array.from(this.shape),
    };
  }
}

function norm(p: Point): Point {
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
}

/** Points every `spacing` (m) along a polyline of unit directions, with the local direction. */
export function resample(
  line: Float64Array,
  spacing: number,
  radius: number,
): { p: Point; along: Point }[] {
  const n = line.length / 3;
  const out: { p: Point; along: Point }[] = [];
  if (n < 2) return out;
  const pt = (i: number): Point => [line[i * 3]!, line[i * 3 + 1]!, line[i * 3 + 2]!];
  let carry = spacing / 2;
  for (let i = 1; i < n; i++) {
    const a = pt(i - 1);
    const b = pt(i);
    const seg = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * radius;
    const dir = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    while (carry <= seg) {
      const t = seg > 0 ? carry / seg : 0;
      out.push({
        p: norm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]),
        along: dir,
      });
      carry += spacing;
    }
    carry -= seg;
  }
  return out;
}

/** Heading (rad, from local east toward north) of a tangent direction at p. */
export function headingOf(p: Readonly<Point>, d: Readonly<Point>): number {
  let ex = p[2];
  let ez = -p[0];
  const l = Math.hypot(ex, ez) || 1;
  ex /= l;
  ez /= l;
  // north = p × east
  const nx = p[1] * ez;
  const ny = p[2] * ex - p[0] * ez;
  const nz = -p[1] * ex;
  return Math.atan2(d[0] * nx + d[1] * ny + d[2] * nz, d[0] * ex + d[2] * ez);
}

/** Offsets p by `meters` along the unit tangent `side`. */
function offset(p: Readonly<Point>, side: Readonly<Point>, meters: number, radius: number): Point {
  const t = meters / radius;
  return norm([p[0] + side[0] * t, p[1] + side[1] * t, p[2] + side[2] * t]);
}

function cross(a: Readonly<Point>, b: Readonly<Point>): Point {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function layoutGlyphs(input: GlyphInput): GlyphSet[] {
  const { features: f, grid, radius, reliefScale } = input;
  const out: GlyphSet[] = [];
  const cellsOf = (layer: 'relief' | 'cover', kinds: FeatureKind[]) => {
    const m = new Map<number, number[]>();
    const L = f.layers[layer];
    for (let c = 0; c < L.length; c++) {
      const id = L[c]!;
      if (id < 0 || !kinds.includes(f.kind[id] as FeatureKind)) continue;
      let list = m.get(id);
      if (!list) m.set(id, (list = []));
      list.push(c);
    }
    return m;
  };
  const ranges = cellsOf('relief', [FeatureKind.Range]);
  const hills = cellsOf('relief', [FeatureKind.Hills]);
  const cover = cellsOf('cover', [FeatureKind.Forest, FeatureKind.Desert]);
  const jittered = (c: number, salt: number): Point => {
    const p: Point = [grid.centers[c * 3]!, grid.centers[c * 3 + 1]!, grid.centers[c * 3 + 2]!];
    const j = (0.6 * Math.PI) / 2 / grid.n;
    return norm([
      p[0] + (hash01(c, salt) - 0.5) * j,
      p[1] + (hash01(c, salt + 1) - 0.5) * j,
      p[2] + (hash01(c, salt + 2) - 0.5) * j,
    ]);
  };
  /** A point moved by up to SCATTER_NUDGE of `spacing` in a hashed direction. */
  const nudge = (p: Point, c: number, salt: number, spacing: number): Point => {
    const a = (SCATTER_NUDGE * spacing) / radius;
    return norm([
      p[0] + (hash01(c, salt) - 0.5) * 2 * a,
      p[1] + (hash01(c, salt + 1) - 0.5) * 2 * a,
      p[2] + (hash01(c, salt + 2) - 0.5) * 2 * a,
    ]);
  };
  /** Cells of a feature in hashed order, for the dart throw. */
  const shuffled = (cells: number[], salt: number) =>
    cells
      .map((c) => ({ c, k: hash01(c, salt) }))
      .sort((a, b) => a.k - b.k || a.c - b.c)
      .map((x) => x.c);
  const height = (p: Point) => Math.max(0, input.heightAt(p[0], p[1], p[2]));
  const cellHeight = (c: number) =>
    height([grid.centers[c * 3]!, grid.centers[c * 3 + 1]!, grid.centers[c * 3 + 2]!]);
  const run = (radius * Math.PI) / 2 / grid.n;
  /** Steepest reference slope to a 4-neighbor. */
  const slope = (c: number) => {
    const h = cellHeight(c);
    let s = 0;
    for (let k = 0; k < 4; k++)
      s = Math.max(s, Math.abs(cellHeight(grid.neighbors4[c * 4 + k]!) - h));
    return s / reliefScale / run;
  };
  const snow = (p: Point) => input.snowAt(p[0], p[1], p[2]);
  /** 0..1 from reference height: 600 m to 3,000 m. */
  const tall = (p: Point) => Math.min(1, Math.max(0, (height(p) / reliefScale - 600) / 2400));

  for (const band of GLYPH_BANDS) {
    const t = GLYPH_TUNING[band];
    const mountains = new SetBuilder('mountain', band);
    const bins = new PointBins(t.ridgeSpacing, radius);
    const width = (w: readonly [number, number], k: number) => w[0] + (w[1] - w[0]) * k;
    // Peaks first, so chains make room for them.
    for (let i = 0; i < f.count; i++) {
      if (f.kind[i] !== FeatureKind.Peak || f.importance[i]! < t.peakMinImportance) continue;
      const p: Point = [f.anchor[i * 3]!, f.anchor[i * 3 + 1]!, f.anchor[i * 3 + 2]!];
      const k = Math.min(1, Math.max(0, (f.measure[i]! / reliefScale - 500) / 2000));
      const w = width(t.peakWidth, k);
      mountains.push(p, f.height[i]!, w, hash01(i, 11) * Math.PI * 2, snow(p), 1);
      bins.add(p);
    }
    // Chains along ridge lines, zigzagging across them.
    for (const id of ranges.keys()) {
      const samples = resample(featurePolyline(f, id), t.ridgeSpacing, radius);
      samples.forEach(({ p, along }, j) => {
        const side = norm(cross(p, along));
        const q = offset(p, side, (j % 2 === 0 ? 0.22 : -0.22) * t.ridgeSpacing, radius);
        if (bins.near(q, 0.85 * t.ridgeSpacing)) return;
        mountains.push(
          q,
          height(q),
          width(t.mountainWidth, tall(q)),
          headingOf(q, along),
          snow(q),
          0,
        );
        bins.add(q);
      });
    }
    // Fill the rest of each range with smaller glyphs.
    const fill = new PointBins(t.fillSpacing, radius);
    for (const p of mountains.points) fill.add(p);
    for (const [id, cells] of ranges) {
      for (const c of shuffled(cells, id * 7 + (band === 'region' ? 1 : 2))) {
        const p = jittered(c, 21);
        if (tall(p) < t.fillMinTall || slope(c) < FILL_MIN_SLOPE || fill.near(p, t.fillSpacing))
          continue;
        // Nudged like mounds and dunes, so the fill does not read as a lattice.
        const q = nudge(p, c, 24, 1.75 * t.fillSpacing); // 35% of the spacing
        const k = tall(p);
        mountains.push(
          q,
          height(q),
          (0.55 + 0.35 * k) * width(t.mountainWidth, k),
          hash01(c, 23) * Math.PI * 2,
          snow(p),
          0,
        );
        fill.add(p);
      }
    }
    out.push(mountains.build());

    // Hills: rounded mounds.
    const mounds = new SetBuilder('mound', band);
    const moundBins = new PointBins(t.hillSpacing, radius);
    for (const [id, cells] of hills) {
      for (const c of shuffled(cells, id * 13 + 3)) {
        const p = jittered(c, 31);
        if (moundBins.near(p, t.hillSpacing)) continue;
        moundBins.add(p); // spacing counts dropped darts too, so mounds stay scattered
        if (hash01(c, 35) > SCATTER_KEEP) continue;
        const q = nudge(p, c, 36, t.hillSpacing);
        const w = t.hillWidth * (0.8 + 0.4 * hash01(c, 33));
        mounds.push(q, height(q), w, hash01(c, 34) * Math.PI * 2, false, 0);
      }
    }
    out.push(mounds.build());

    // Dunes on sand.
    const dunes = new SetBuilder('dune', band);
    const duneBins = new PointBins(t.duneSpacing, radius);
    for (const [id, cells] of cover) {
      if (f.kind[id] !== FeatureKind.Desert || f.measure[id]! < 0.2) continue;
      for (const c of shuffled(cells, id * 17 + 5)) {
        if (!input.sandAt(c)) continue;
        const p = jittered(c, 41);
        if (duneBins.near(p, t.duneSpacing)) continue;
        duneBins.add(p);
        if (hash01(c, 46) > SCATTER_KEEP) continue;
        const q = nudge(p, c, 47, t.duneSpacing);
        const wind = input.windAt?.(c) ?? null;
        const heading = (wind ?? hash01(c, 43) * Math.PI * 2) + (hash01(c, 44) - 0.5) * 0.5;
        dunes.push(q, height(q), t.duneWidth * (0.8 + 0.4 * hash01(c, 45)), heading, false, 0);
      }
    }
    out.push(dunes.build());

    // Forest tokens: Region band only.
    const forests = new SetBuilder('forest', band);
    if (band === 'region') {
      const r = GLYPH_TUNING.region;
      const fb = new PointBins(r.forestSpacing, radius);
      for (const [id, cells] of cover) {
        if (f.kind[id] !== FeatureKind.Forest) continue;
        for (const c of shuffled(cells, id * 19 + 7)) {
          const p = jittered(c, 51);
          if (fb.near(p, r.forestSpacing)) continue;
          fb.add(p); // spacing counts rejected darts too, so tokens stay sparse
          if (hash01(c, 52) > r.forestKeep) continue;
          const w = r.forestWidth[0] + (r.forestWidth[1] - r.forestWidth[0]) * hash01(c, 53);
          const trees = 3 + Math.floor(hash01(c, 54) * 5); // 3..7
          forests.push(p, height(p), w, hash01(c, 55) * Math.PI * 2, snow(p), trees);
        }
      }
    }
    out.push(forests.build());
  }
  return out;
}
