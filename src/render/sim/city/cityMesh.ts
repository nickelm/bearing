/**
 * City geometry by detail level (proposal 0009 Phase 6, decision 267), as flat arrays
 * a mesh takes directly: flat-shaded, vertex-colored, merged per chunk.
 *
 * - **Prisms** (5–15 km): one extruded block per block at its mean building height
 *   scaled by how much of it is built, the polygon simplified to a few corners.
 * - **Boxes** (1–5 km): every building as walls and a roof (gable, hip, shed, flat):
 *   14–16 triangles, roofs a little oversized (0.6 m eaves).
 * - **Kit** (under 1 km): boxes plus chimneys, water tanks, church towers and a plinth
 *   band, within the building budget of `docs/visual-style.md` (12–200 triangles).
 *
 * Every building stands on a plinth down to the lowest drawn ground under it, plus a
 * margin by level (the coarser terrain meshes of far chunks can lie lower). Positions are
 * relative to the chunk's origin on the sea-level sphere, with the ground height in its
 * own attribute so the shader can exaggerate it as the terrain does.
 */
import { simplify } from '../../../worldgen/settlements/geom';
import { BUILDING_FIELDS } from '../../../worldgen/settlements/pack';
import type { PackedPlan } from '../../../worldgen/settlements/pack';
import { SettlementFrame } from '../../../worldgen/settlements/frame';
import { BuildingKind, Extra, LandmarkKind, Roof } from '../../../worldgen/settlements/types';

export const Lod = { None: 0, Prism: 1, Box: 2, Kit: 3 } as const;
export type Lod = (typeof Lod)[keyof typeof Lod];

/** Plinth depth below the lowest ground by level (m). */
const PLINTH = [0, 12, 4, 1.5];
const EAVE = 0.6;

/** Damage states (decision 269). */
export const Damage = { Intact: 0, Damaged: 1, Rubble: 2 } as const;

export interface CityGeometry {
  /** xyz relative to the origin, without the ground's height. */
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  /** The ground height (m) each vertex stands on. */
  ground: Float32Array;
  /** Along the wall (m), height above the floor (m), window flag, building hash. */
  wall: Float32Array;
  triangles: number;
}

const srgb = (c: number) => {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f((c >> 16) & 255), f((c >> 8) & 255), f(c & 255)] as const;
};

/** Windows on walls of homes, blocks, slabs and halls; none on sheds and barns. */
const WINDOWS = new Set<number>([
  BuildingKind.House,
  BuildingKind.Terrace,
  BuildingKind.Perimeter,
  BuildingKind.Slab,
  BuildingKind.Civic,
  BuildingKind.Farm,
  BuildingKind.Landmark,
]);

/** A growable float buffer (amortized doubling, no per-push allocation). */
class Floats {
  data = new Float32Array(4096);
  length = 0;
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) this.grow();
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  push1(a: number): void {
    if (this.length + 1 > this.data.length) this.grow();
    this.data[this.length++] = a;
  }
  private grow(): void {
    const d = new Float32Array(this.data.length * 2);
    d.set(this.data);
    this.data = d;
  }
  finish(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

export class GeometryWriter {
  private readonly pos = new Floats();
  private readonly nrm = new Floats();
  private readonly col = new Floats();
  private readonly gnd = new Floats();
  private readonly wal = new Floats();
  /** The frame linearized at the chunk: its point, the local x and y axes and the up (world). */
  private readonly x0: number;
  private readonly y0: number;
  private readonly w0: [number, number, number];
  private readonly wx: [number, number, number];
  private readonly wy: [number, number, number];
  private readonly up: [number, number, number];
  private readonly radius: number;

  constructor(
    frame: SettlementFrame,
    private readonly origin: readonly [number, number, number],
  ) {
    // The chunk's local coordinates: the origin's own (x, y) in the plan's frame.
    const R = frame.radius;
    this.radius = R;
    const [x0, y0] = frame.toPlane(origin[0], origin[1], origin[2]);
    this.x0 = x0;
    this.y0 = y0;
    const at = (x: number, y: number) => {
      const d = frame.toSphere(x, y);
      return [d[0] * R, d[1] * R, d[2] * R] as [number, number, number];
    };
    this.w0 = at(x0, y0);
    const a = at(x0 + 50, y0);
    const b = at(x0 - 50, y0);
    const c = at(x0, y0 + 50);
    const d = at(x0, y0 - 50);
    this.wx = [(a[0] - b[0]) / 100, (a[1] - b[1]) / 100, (a[2] - b[2]) / 100];
    this.wy = [(c[0] - d[0]) / 100, (c[1] - d[1]) / 100, (c[2] - d[2]) / 100];
    const l = Math.hypot(...this.w0);
    this.up = [this.w0[0] / l, this.w0[1] / l, this.w0[2] / l];
  }

  /**
   * World offset (m) from the origin of local (x, y) at `rise` m above the sea-level
   * sphere: the frame linearized at the chunk, the sphere's drop added (exact to
   * centimeters within a few kilometers).
   */
  private at(x: number, y: number, rise: number): [number, number, number] {
    const dx = x - this.x0;
    const dy = y - this.y0;
    const z = rise - (dx * dx + dy * dy) / (2 * this.radius);
    return [
      this.w0[0] - this.origin[0] + this.wx[0] * dx + this.wy[0] * dy + this.up[0] * z,
      this.w0[1] - this.origin[1] + this.wx[1] * dx + this.wy[1] * dy + this.up[1] * z,
      this.w0[2] - this.origin[2] + this.wx[2] * dx + this.wy[2] * dy + this.up[2] * z,
    ];
  }

  /** A flat triangle from local (x, y, rise) corners. */
  tri(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    color: readonly [number, number, number],
    ground: number,
    wall: [number, number, number, number][] | null = null,
  ): void {
    const pa = this.at(a[0], a[1], a[2]);
    const pb = this.at(b[0], b[1], b[2]);
    const pc = this.at(c[0], c[1], c[2]);
    const ux = pb[0] - pa[0];
    const uy = pb[1] - pa[1];
    const uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0];
    const vy = pc[1] - pa[1];
    const vz = pc[2] - pa[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? pa : k === 1 ? pb : pc;
      this.pos.push3(p[0], p[1], p[2]);
      this.nrm.push3(nx, ny, nz);
      this.col.push3(color[0], color[1], color[2]);
      this.gnd.push1(ground);
      const w = wall?.[k];
      if (w) {
        this.wal.push3(w[0], w[1], w[2]);
        this.wal.push1(w[3]);
      } else {
        this.wal.push3(0, 0, 0);
        this.wal.push1(0);
      }
    }
  }

  quad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    color: readonly [number, number, number],
    ground: number,
    wall: [number, number, number, number][] | null = null,
  ): void {
    this.tri(a, b, c, color, ground, wall ? [wall[0]!, wall[1]!, wall[2]!] : null);
    this.tri(a, c, d, color, ground, wall ? [wall[0]!, wall[2]!, wall[3]!] : null);
  }

  /** A box (walls and a flat top) from footprint corners, rises lo..hi. */
  box(
    corners: number[],
    lo: number,
    hi: number,
    wallColor: readonly [number, number, number],
    topColor: readonly [number, number, number],
    ground: number,
    windows = 0,
    hash = 0,
    top = true,
  ): void {
    const n = corners.length / 2;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = corners[i * 2]!;
      const ay = corners[i * 2 + 1]!;
      const bx = corners[j * 2]!;
      const by = corners[j * 2 + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      // Wall attributes: along the wall, height above the floor (rise 0), windows, hash.
      const w: [number, number, number, number][] = [
        [along, lo, windows, hash],
        [along + len, lo, windows, hash],
        [along + len, hi, windows, hash],
        [along, hi, windows, hash],
      ];
      this.quad([ax, ay, lo], [bx, by, lo], [bx, by, hi], [ax, ay, hi], wallColor, ground, w);
      along += len;
    }
    if (top)
      for (let i = 1; i + 1 < n; i++) {
        this.tri(
          [corners[0]!, corners[1]!, hi],
          [corners[i * 2]!, corners[i * 2 + 1]!, hi],
          [corners[i * 2 + 2]!, corners[i * 2 + 3]!, hi],
          topColor,
          ground,
        );
      }
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  finish(): CityGeometry {
    return {
      position: this.pos.finish(),
      normal: this.nrm.finish(),
      color: this.col.finish(),
      ground: this.gnd.finish(),
      wall: this.wal.finish(),
      triangles: this.pos.length / 9,
    };
  }
}

/** Corners of an oriented box (counterclockwise) in local coordinates. */
function corners(x: number, y: number, a: number, hl: number, hw: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    x - hl * c + hw * s,
    y - hl * s - hw * c,
    x + hl * c + hw * s,
    y + hl * s - hw * c,
    x + hl * c - hw * s,
    y + hl * s + hw * c,
    x - hl * c - hw * s,
    y - hl * s + hw * c,
  ];
}

const dim = (c: readonly [number, number, number], k: number) =>
  [c[0] * k, c[1] * k, c[2] * k] as const;

/** Heights (m) of the drawn ground: lowest and highest under a footprint, or null if unknown. */
export type GroundAt = (x: number, y: number) => number | null;

function footprintGround(g: GroundAt, cs: number[], x: number, y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < cs.length; i += 2) {
    const h = g(cs[i]!, cs[i + 1]!);
    if (h === null) return null;
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  const hc = g(x, y);
  if (hc === null) return null;
  return [Math.min(lo, hc), Math.max(hi, hc)];
}

/** Adds one building at `lod` (Box or Kit). Returns false if its ground is not loaded. */
export function writeBuilding(
  w: GeometryWriter,
  plan: PackedPlan,
  i: number,
  lod: Lod,
  ground: GroundAt,
  damage = 0,
): boolean {
  const b = plan.buildings;
  const o = i * BUILDING_FIELDS;
  const x = b[o]!;
  const y = b[o + 1]!;
  const angle = b[o + 2]!;
  const hl = b[o + 3]!;
  const hw = b[o + 4]!;
  let height = b[o + 5]!;
  let rise = b[o + 6]!;
  const roof = b[o + 7]!;
  const kind = b[o + 11]!;
  const extras = b[o + 10]!;
  const cs = corners(x, y, angle, hl, hw);
  const g = footprintGround(ground, cs, x, y);
  if (!g) return false;
  const [lo, hi] = g;
  const floor = hi - lo;
  const base = -floor - PLINTH[lod]!;
  let wall = srgb(b[o + 8]!);
  let roofColor = srgb(b[o + 9]!);
  const hash = ((i * 2654435761) >>> 0) / 4294967296;
  if (damage === Damage.Rubble) {
    // A low mound of rubble: a frustum-ish box, dark and dusty.
    const rc = srgb(0x6e655a);
    w.box(
      corners(x, y, angle, hl * 0.95, hw * 0.95),
      base,
      Math.min(2.5, height * 0.25),
      rc,
      dim(rc, 1.1),
      hi,
    );
    return true;
  }
  if (damage === Damage.Damaged) {
    wall = dim(wall, 0.35);
    roofColor = dim(roofColor, 0.25);
    height *= 0.85;
    rise *= 0.3;
  }
  const windows = WINDOWS.has(kind) ? 1 : 0;
  // Plinth band (below the floor) in a darker shade, then the walls.
  if (floor > 0.3 || lod === Lod.Kit)
    w.box(cs, base, 0, dim(wall, 0.72), dim(wall, 0.72), hi, 0, hash, false);
  const flatTop = roof === Roof.Flat || rise <= 0.05;
  w.box(cs, 0, height, wall, roofColor, hi, windows, hash, flatTop);
  if (!flatTop) {
    // Pitched roofs over eaves: ridge along the length axis.
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const L = hl + EAVE;
    const W = hw + EAVE;
    const P = (u: number, v: number, z: number): [number, number, number] => [
      x + u * c - v * s,
      y + u * s + v * c,
      z,
    ];
    const top = height + rise;
    const eave = height - EAVE * (rise / Math.max(hw, 0.1));
    if (roof === Roof.Gable) {
      w.quad(P(-L, -W, eave), P(L, -W, eave), P(L, 0, top), P(-L, 0, top), roofColor, hi);
      w.quad(P(L, W, eave), P(-L, W, eave), P(-L, 0, top), P(L, 0, top), roofColor, hi);
      w.tri(P(-hl, -hw, height), P(-hl, 0, top), P(-hl, hw, height), wall, hi);
      w.tri(P(hl, hw, height), P(hl, 0, top), P(hl, -hw, height), wall, hi);
    } else if (roof === Roof.Hip) {
      const r = Math.max(0, L - W);
      w.quad(P(-L, -W, eave), P(L, -W, eave), P(r, 0, top), P(-r, 0, top), roofColor, hi);
      w.quad(P(L, W, eave), P(-L, W, eave), P(-r, 0, top), P(r, 0, top), roofColor, hi);
      w.tri(P(L, -W, eave), P(L, W, eave), P(r, 0, top), dim(roofColor, 0.92), hi);
      w.tri(P(-L, W, eave), P(-L, -W, eave), P(-r, 0, top), dim(roofColor, 0.92), hi);
    } else {
      // Shed: one slope from the front (low) to the back (high).
      w.quad(P(-L, -W, height), P(L, -W, height), P(L, W, top), P(-L, W, top), roofColor, hi);
      w.tri(P(-hl, -hw, height), P(-hl, hw, top), P(-hl, hw, height), wall, hi);
      w.tri(P(hl, hw, height), P(hl, hw, top), P(hl, -hw, height), wall, hi);
      w.quad(P(-hl, hw, height), P(hl, hw, height), P(hl, hw, top), P(-hl, hw, top), wall, hi);
    }
  }
  if (lod === Lod.Kit) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    if (extras & Extra.Chimney && !flatTop) {
      // Chunky chimney (slightly oversized) near one gable end.
      const cx = x + hl * 0.55 * c - hw * 0.25 * s;
      const cy = y + hl * 0.55 * s + hw * 0.25 * c;
      const chim = srgb(0x8a5a48);
      w.box(
        corners(cx, cy, angle, 0.55, 0.55),
        height,
        height + rise + 1.4,
        chim,
        dim(chim, 0.6),
        hi,
      );
    }
    if (extras & Extra.WaterTank && flatTop) {
      const tank = srgb(0x7a6a58);
      w.box(
        corners(x - hl * 0.4 * c, y - hl * 0.4 * s, angle + 0.6, 1.4, 1.4),
        height,
        height + 3.2,
        tank,
        dim(tank, 0.8),
        hi,
      );
    }
  }
  return true;
}

/** The landmark structures that stand on their own (towers, stacks, cranes). */
export function writeLandmark(
  w: GeometryWriter,
  plan: PackedPlan,
  li: number,
  lod: Lod,
  ground: GroundAt,
): boolean {
  const l = plan.landmarks[li]!;
  const h0 = ground(l.x, l.y);
  if (h0 === null) return false;
  const ring = (r: number, sides: number, a0 = 0) => {
    const p: number[] = [];
    for (let k = 0; k < sides; k++)
      p.push(
        l.x + r * Math.cos(a0 + (k / sides) * 2 * Math.PI),
        l.y + r * Math.sin(a0 + (k / sides) * 2 * Math.PI),
      );
    return p;
  };
  const sides = lod === Lod.Kit ? 8 : 6;
  const concrete = srgb(0xb8b2a6);
  switch (l.kind) {
    case LandmarkKind.TvTower: {
      w.box(ring(l.size * 0.5, sides), -PLINTH[lod]!, l.height * 0.82, concrete, concrete, h0);
      w.box(
        ring(l.size * 1.4, sides),
        l.height * 0.7,
        l.height * 0.78,
        srgb(0x9a9a9e),
        srgb(0x8a8a8e),
        h0,
      );
      w.box(ring(l.size * 0.25, 4), l.height * 0.82, l.height, srgb(0xc04a3a), srgb(0xc04a3a), h0);
      return true;
    }
    case LandmarkKind.WaterTower: {
      w.box(ring(l.size * 0.35, sides), -PLINTH[lod]!, l.height * 0.7, concrete, concrete, h0);
      w.box(ring(l.size, sides), l.height * 0.7, l.height, srgb(0x9aa0a4), srgb(0x8a9094), h0);
      return true;
    }
    case LandmarkKind.Smokestack: {
      const brick = srgb(0x9a5a48);
      w.box(ring(l.size, sides), -PLINTH[lod]!, l.height * 0.85, brick, brick, h0);
      w.box(
        ring(l.size * 0.85, sides),
        l.height * 0.85,
        l.height,
        srgb(0xd8d2c8),
        srgb(0x2a2a2a),
        h0,
      );
      return true;
    }
    case LandmarkKind.CoolingTower: {
      // Waisted: wide base, narrow waist at two thirds, flared lip.
      const r = l.size;
      const rows = [
        [0, 1],
        [0.65, 0.68],
        [1, 0.78],
      ];
      const ws = srgb(0xcac6bc);
      for (let k = 0; k + 1 < rows.length; k++) {
        const [z0, s0] = rows[k]!;
        const [z1, s1] = rows[k + 1]!;
        const a = ring(r * s0!, 12);
        const b = ring(r * s1!, 12);
        for (let i = 0; i < 12; i++) {
          const j = (i + 1) % 12;
          w.quad(
            [a[i * 2]!, a[i * 2 + 1]!, z0! * l.height - (k === 0 ? PLINTH[lod]! : 0)],
            [a[j * 2]!, a[j * 2 + 1]!, z0! * l.height - (k === 0 ? PLINTH[lod]! : 0)],
            [b[j * 2]!, b[j * 2 + 1]!, z1! * l.height],
            [b[i * 2]!, b[i * 2 + 1]!, z1! * l.height],
            ws,
            h0,
          );
        }
      }
      return true;
    }
    case LandmarkKind.Crane: {
      const steel = srgb(0xc8a040);
      w.box(ring(1.5, 4, Math.PI / 4), -PLINTH[lod]!, l.height, steel, steel, h0);
      w.box(corners(l.x + 8, l.y, 0, 14, 0.9), l.height - 2, l.height, steel, steel, h0);
      return true;
    }
    case LandmarkKind.Monument: {
      const stone = srgb(0xd8d0c0);
      w.box(ring(l.size * 1.6, 4, Math.PI / 4), -PLINTH[lod]!, 1.5, stone, stone, h0);
      w.box(ring(l.size * 0.5, 4, Math.PI / 4), 1.5, l.height, stone, stone, h0);
      return true;
    }
    case LandmarkKind.Tank: {
      // A squat storage tank: pale walls, a darker roof (decision 279).
      const steel = srgb(0xc8c4ba);
      w.box(
        ring(l.size, lod === Lod.Kit ? 12 : 8),
        -PLINTH[lod]!,
        l.height,
        steel,
        dim(steel, 0.8),
        h0,
      );
      return true;
    }
    case LandmarkKind.Market: {
      const canvas = srgb(0xc8a070);
      w.box(ring(l.size, 4, Math.PI / 4), 3, l.height, canvas, srgb(0xb05a40), h0, 0, 0, true);
      return true;
    }
    case LandmarkKind.Church:
    case LandmarkKind.Cathedral:
    case LandmarkKind.TownHall: {
      // The tower beside the landmark's building.
      if (l.building < 0) return true;
      const o = l.building * BUILDING_FIELDS;
      const b = plan.buildings;
      const a = b[o + 2]!;
      const tx = b[o]! + Math.cos(a) * (b[o + 3]! - 3);
      const ty = b[o + 1]! + Math.sin(a) * (b[o + 3]! - 3);
      const th =
        l.kind === LandmarkKind.Cathedral
          ? l.height * 2.4
          : l.kind === LandmarkKind.Church
            ? l.height * 2
            : l.height * 1.6;
      const ts = l.kind === LandmarkKind.Cathedral ? 5 : 3.5;
      const hb = ground(tx, ty);
      if (hb === null) return false;
      const stone = srgb(0xd0c6b2);
      w.box(corners(tx, ty, a, ts, ts), -PLINTH[lod]!, th, stone, stone, hb, 1, 0.5);
      w.box(
        corners(tx, ty, a, ts * 0.55, ts * 0.55),
        th,
        th + ts * 2.2,
        srgb(0x5e6a62),
        srgb(0x5e6a62),
        hb,
      );
      return true;
    }
    default:
      return true;
  }
}

/**
 * Block prisms (5–15 km) for blocks whose center lies in a chunk: the polygon simplified
 * to 8 m, at the mean building height times how much of the block is built.
 */
export function writePrisms(
  w: GeometryWriter,
  plan: PackedPlan,
  blocks: number[],
  coverage: Float32Array,
  ground: GroundAt,
): boolean {
  const { blockPoints: bp, blockOffsets: bo, blockInfo: bi } = plan;
  for (const b of blocks) {
    const h = bi[b * 4 + 2]!;
    if (h <= 0) continue;
    const poly = simplify(Array.from(bp.subarray(bo[b]!, bo[b + 1]!)), 8);
    if (poly.length < 6) continue;
    // Heights follow the ground at each corner, so a prism on a slope steps with it
    // instead of standing as a flat table over its low side.
    const gs: number[] = [];
    for (let i = 0; i < poly.length; i += 2) {
      const g = ground(poly[i]!, poly[i + 1]!);
      if (g === null) return false;
      gs.push(g);
    }
    const built = Math.min(1, 2 * coverage[b]!);
    const top = h * built;
    if (top < 1) continue;
    const c = srgb(bi[b * 4]! === 5 || bi[b * 4]! === 6 || bi[b * 4]! === 7 ? 0x8e8a82 : 0x9a6a58);
    const wall = dim(c, 0.9);
    const ref = gs[0]!;
    const n = poly.length / 2;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = poly[i * 2]!;
      const ay = poly[i * 2 + 1]!;
      const bx = poly[j * 2]!;
      const by = poly[j * 2 + 1]!;
      const ga = gs[i]! - ref;
      const gb = gs[j]! - ref;
      const len = Math.hypot(bx - ax, by - ay);
      // Windows: far away their mean glow at night (the wall shader).
      const hash = b / 997;
      w.quad(
        [ax, ay, ga - PLINTH[Lod.Prism]!],
        [bx, by, gb - PLINTH[Lod.Prism]!],
        [bx, by, gb + top],
        [ax, ay, ga + top],
        wall,
        ref,
        [
          [along, -PLINTH[Lod.Prism]!, 1, hash],
          [along + len, -PLINTH[Lod.Prism]!, 1, hash],
          [along + len, top, 1, hash],
          [along, top, 1, hash],
        ],
      );
      along += len;
    }
    for (let i = 1; i + 1 < n; i++) {
      w.tri(
        [poly[0]!, poly[1]!, gs[0]! - ref + top],
        [poly[i * 2]!, poly[i * 2 + 1]!, gs[i]! - ref + top],
        [poly[i * 2 + 2]!, poly[i * 2 + 3]!, gs[i + 1]! - ref + top],
        c,
        ref,
      );
    }
  }
  return true;
}

/**
 * Writes `g` over the triangles [start, start + count) of a built geometry, filling any
 * left over with degenerate triangles (decision 269): a damage state changes one
 * building's vertices in place. False if `g` has more triangles than the range.
 */
export function patchRange(
  target: CityGeometry,
  start: number,
  count: number,
  g: CityGeometry,
): boolean {
  if (g.triangles > count) return false;
  const v0 = start * 3;
  const nv = count * 3;
  const gv = g.triangles * 3;
  const put = (dst: Float32Array, src: Float32Array, k: number) => {
    dst.set(src.subarray(0, gv * k), v0 * k);
    dst.fill(0, (v0 + gv) * k, (v0 + nv) * k);
  };
  put(target.position, g.position, 3);
  put(target.normal, g.normal, 3);
  put(target.color, g.color, 3);
  put(target.ground, g.ground, 1);
  put(target.wall, g.wall, 4);
  return true;
}
