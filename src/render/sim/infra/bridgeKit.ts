/**
 * The bridge kit's assembly (decision 192; visual-style Part I, Bridge kit): a
 * bridge or viaduct of the alignment tier, as a deck line with its elevations,
 * becomes kit parts (model specs `bridge-*`) placed along it, merged into one
 * flat-shaded geometry per structure.
 *
 * - **Deck** segments of at most `DECK_STEP` m follow the deck line and its
 *   grade, with parapets at both edges (railways have none).
 * - **Supports**: a beam bridge rests on wall piers at most `BEAM_SPAN` m apart;
 *   a viaduct on column piers every `VIADUCT_SPAN` m (two side by side on wide
 *   decks); a truss bridge spans up to `TRUSS_SPAN` m between wall piers, with
 *   through-truss panels of about 10 m along both sides and braces across the
 *   top. Piers reach from below the lowest ground under the structure (rivers'
 *   beds are carved deeper than the 96 m ground the record holds) to the girder.
 * - **Abutments** close both ends, from the deck down into the ground.
 *
 * Every structure is unique in length, height and grade, so it is merged per
 * structure rather than instanced; a few dozen are within the drawing range.
 * Positions are float32 offsets (m) from the structure's origin (its first deck
 * point on the sphere), in the planet frame. Pure: no three.js.
 */
import { Vec3d } from '../../../core/vec3d';
import { buildModel } from '../../common/models/builder';
import type { BuiltModel } from '../../common/models/builder';
import { modelSpec } from '../../common/models/library';

const kit = new Map<string, BuiltModel>();
/** A kit part's built model (cached). */
function libraryModel(id: string): BuiltModel {
  let m = kit.get(id);
  if (!m) kit.set(id, (m = buildModel(modelSpec(id))));
  return m;
}

export const DECK_STEP = 20;
export const BEAM_SPAN = 35;
export const VIADUCT_SPAN = 40;
export const TRUSS_SPAN = 90;
/** Deck depth to the girder's underside (bridge-deck.json). */
export const DECK_DEPTH = 1.3;

export type BridgeStyle = 'beam' | 'truss' | 'viaduct';

export interface BridgeLine {
  /** Unit directions along the deck centerline, at least two. */
  points: readonly Vec3d[];
  /** Deck elevation (m) at each point. */
  deck: readonly number[];
  /** Ground elevation (m) at each point. */
  ground: readonly number[];
  /** Deck width between parapets (m). */
  width: number;
  style: BridgeStyle;
  rail: boolean;
}

export interface BridgeGeometry {
  /** The structure's origin: its first deck point on the sphere (m, planet frame). */
  origin: Vec3d;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  ao: Float32Array;
  triangles: number;
  /** Bounding radius about the origin (m). */
  radius: number;
}

interface Placement {
  model: string;
  /** Model frame in the planet frame: forward, up, right (unit), and per-axis scale. */
  at: Vec3d;
  f: Vec3d;
  u: Vec3d;
  r: Vec3d;
  scale: [number, number, number];
}

/** Resamples the line every `DECK_STEP` m or less (deck, ground lerped; directions nlerped). */
function resample(line: BridgeLine, R: number) {
  const pts: Vec3d[] = [];
  const deck: number[] = [];
  const ground: number[] = [];
  for (let i = 0; i + 1 < line.points.length; i++) {
    const a = line.points[i]!;
    const b = line.points[i + 1]!;
    const n = Math.max(1, Math.ceil((a.distanceTo(b) * R) / DECK_STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push(
        a
          .clone()
          .scale(1 - t)
          .addScaled(b, t)
          .normalize(),
      );
      deck.push(line.deck[i]! + (line.deck[i + 1]! - line.deck[i]!) * t);
      ground.push(line.ground[i]! + (line.ground[i + 1]! - line.ground[i]!) * t);
    }
  }
  pts.push(line.points[line.points.length - 1]!.clone());
  deck.push(line.deck[line.deck.length - 1]!);
  ground.push(line.ground[line.ground.length - 1]!);
  return { pts, deck, ground };
}

/** The kit parts of a structure, in the planet frame (m from the planet's center). */
export function placeBridge(line: BridgeLine, R: number): Placement[] {
  const { pts, deck, ground } = resample(line, R);
  const n = pts.length;
  const world = (i: number) => pts[i]!.clone().scale(R + deck[i]!);
  const out: Placement[] = [];
  const W = line.width;
  // Arc length along the deck at each sample.
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1]! + world(i).distanceTo(world(i - 1)));
  const L = s[n - 1]!;
  const frameAt = (i0: number, i1: number) => {
    const a = world(i0);
    const b = world(i1);
    const u = pts[i0]!.clone().add(pts[i1]!).normalize();
    const f = b.clone().sub(a).normalize();
    // Horizontal forward, for piers and abutments.
    const fh = f.clone().addScaled(u, -f.dot(u)).normalize();
    return { a, b, u, f, fh };
  };
  // Deck and parapets.
  for (let i = 0; i + 1 < n; i++) {
    const { a, b, u, f } = frameAt(i, i + 1);
    const r = f.clone().cross(u).normalize();
    const up = r.clone().cross(f).normalize();
    const mid = a.clone().add(b).scale(0.5);
    const len = a.distanceTo(b);
    out.push({ model: 'bridge-deck', at: mid, f, u: up, r, scale: [len, 1, W] });
    if (!line.rail)
      for (const side of [-1, 1])
        out.push({
          model: 'bridge-parapet',
          at: mid.clone().addScaled(r, side * (W / 2 - 0.15)),
          f,
          u: up,
          r,
          scale: [len, 1, 1],
        });
  }
  // Supports at fractions of the length.
  const spacing =
    line.style === 'truss' ? TRUSS_SPAN : line.style === 'viaduct' ? VIADUCT_SPAN : BEAM_SPAN;
  const bays = Math.max(1, Math.ceil(L / spacing));
  const floor = Math.min(...ground) - 4;
  const sampleAt = (target: number) => {
    let i = 0;
    while (i + 1 < n - 1 && s[i + 1]! < target) i++;
    const t = Math.min(1, Math.max(0, (target - s[i]!) / Math.max(1e-6, s[i + 1]! - s[i]!)));
    return { i, t };
  };
  for (let k = 1; k < bays; k++) {
    const { i, t } = sampleAt((k / bays) * L);
    const { u, fh } = frameAt(i, i + 1);
    const dir = pts[i]!.clone()
      .scale(1 - t)
      .addScaled(pts[i + 1]!, t)
      .normalize();
    const top = deck[i]! + (deck[i + 1]! - deck[i]!) * t - DECK_DEPTH;
    const g = ground[i]! + (ground[i + 1]! - ground[i]!) * t;
    // Into the ground under the pier, and below the lowest ground of a river's bed.
    const bottom = Math.min(g - 3, line.style === 'viaduct' ? g - 3 : floor);
    const h = top - bottom;
    if (h <= 0.5) continue;
    const base = dir.clone().scale(R + bottom);
    const r = fh.clone().cross(u).normalize();
    if (line.style === 'viaduct') {
      const cols = W > 10 ? [-W / 4, W / 4] : [0];
      for (const c of cols)
        out.push({
          model: 'bridge-column',
          at: base.clone().addScaled(r, c),
          f: fh,
          u,
          r,
          scale: [1, h, 1],
        });
    } else {
      out.push({ model: 'bridge-pier', at: base, f: fh, u, r, scale: [1, h, W * 0.8] });
    }
  }
  // Abutments at both ends, reaching back from the ends into the bank.
  for (const end of [0, n - 1]) {
    const { u, fh } = frameAt(end === 0 ? 0 : n - 2, end === 0 ? 1 : n - 1);
    const out1 = end === 0 ? -1 : 1;
    const bottom = ground[end]! - 2;
    const h = deck[end]! - bottom;
    if (h <= 0.3) continue;
    const r = fh.clone().cross(u).normalize();
    out.push({
      model: 'bridge-abutment',
      at: pts[end]!.clone()
        .scale(R + bottom)
        .addScaled(fh, out1 * 2),
      f: fh,
      u,
      r,
      scale: [4, h, W + 1],
    });
  }
  // Through-truss panels and their top braces.
  if (line.style === 'truss') {
    const panels = Math.max(1, Math.round(L / 10));
    for (let k = 0; k < panels; k++) {
      const s0 = (k / panels) * L;
      const s1 = ((k + 1) / panels) * L;
      const p0 = sampleAt(s0);
      const p1 = sampleAt(s1);
      const at0 = pts[p0.i]!.clone()
        .scale(1 - p0.t)
        .addScaled(pts[p0.i + 1]!, p0.t)
        .normalize();
      const at1 = pts[p1.i]!.clone()
        .scale(1 - p1.t)
        .addScaled(pts[p1.i + 1]!, p1.t)
        .normalize();
      const z0 = deck[p0.i]! + (deck[p0.i + 1]! - deck[p0.i]!) * p0.t;
      const z1 = deck[p1.i]! + (deck[p1.i + 1]! - deck[p1.i]!) * p1.t;
      const a = at0.clone().scale(R + z0);
      const b = at1.clone().scale(R + z1);
      const u = at0.clone().add(at1).normalize();
      const f = b.clone().sub(a).normalize();
      const r = f.clone().cross(u).normalize();
      const up = r.clone().cross(f).normalize();
      const mid = a.clone().add(b).scale(0.5);
      const len = a.distanceTo(b) / 10;
      for (const side of [-1, 1])
        out.push({
          model: 'bridge-truss',
          at: mid.clone().addScaled(r, side * (W / 2 + 0.3)),
          f,
          u: up,
          r,
          scale: [len, 1, 1],
        });
      out.push({
        model: 'bridge-brace',
        at: mid.clone().addScaled(up, 7),
        f,
        u: up,
        r,
        scale: [1, 1, W + 0.6],
      });
    }
  }
  return out;
}

/** Merges the placed parts into one geometry about the structure's origin. */
export function assembleBridge(line: BridgeLine, R: number): BridgeGeometry {
  const parts = placeBridge(line, R);
  const origin = line.points[0]!.clone().scale(R);
  let tris = 0;
  for (const p of parts) tris += libraryModel(p.model).triangles;
  const position = new Float32Array(tris * 9);
  const normal = new Float32Array(tris * 9);
  const color = new Float32Array(tris * 9);
  const ao = new Float32Array(tris * 3);
  let v = 0;
  let radius = 0;
  for (const p of parts) {
    const m = libraryModel(p.model);
    const [sx, sy, sz] = p.scale;
    const ox = p.at.x - origin.x;
    const oy = p.at.y - origin.y;
    const oz = p.at.z - origin.z;
    for (let k = 0; k < m.triangles * 3; k++, v++) {
      const x = m.position[k * 3]! * sx;
      const y = m.position[k * 3 + 1]! * sy;
      const z = m.position[k * 3 + 2]! * sz;
      const px = ox + p.f.x * x + p.u.x * y + p.r.x * z;
      const py = oy + p.f.y * x + p.u.y * y + p.r.y * z;
      const pz = oz + p.f.z * x + p.u.z * y + p.r.z * z;
      position[v * 3] = px;
      position[v * 3 + 1] = py;
      position[v * 3 + 2] = pz;
      radius = Math.max(radius, Math.hypot(px, py, pz));
      // Normals under the axis scale: the inverse transpose.
      const nx = m.normal[k * 3]! / sx;
      const ny = m.normal[k * 3 + 1]! / sy;
      const nz = m.normal[k * 3 + 2]! / sz;
      const wx = p.f.x * nx + p.u.x * ny + p.r.x * nz;
      const wy = p.f.y * nx + p.u.y * ny + p.r.y * nz;
      const wz = p.f.z * nx + p.u.z * ny + p.r.z * nz;
      const nl = Math.hypot(wx, wy, wz) || 1;
      normal[v * 3] = wx / nl;
      normal[v * 3 + 1] = wy / nl;
      normal[v * 3 + 2] = wz / nl;
      color[v * 3] = m.color[k * 3]!;
      color[v * 3 + 1] = m.color[k * 3 + 1]!;
      color[v * 3 + 2] = m.color[k * 3 + 2]!;
      ao[v] = m.ao[k]!;
    }
  }
  return { origin, position, normal, color, ao, triangles: tris, radius };
}
