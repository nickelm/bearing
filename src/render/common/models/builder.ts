/**
 * The procedural model builder (visual-style Part I, Procedural Model Builders;
 * decision 106): a spec (spec.ts) → a non-indexed, flat-shaded triangle list with a
 * linear vertex color, baked per-vertex ambient occlusion and emissive anchors.
 * Pure TypeScript and deterministic: the same spec gives the same bytes. three.js
 * wraps the result in threeModel.ts.
 *
 * - **Faces.** Every primitive emits triangles together with a point inside its
 *   solid; a triangle whose normal faces that point is flipped, so every face points
 *   outward whatever order a primitive lists its corners in. Degenerate triangles
 *   (a loft collapsing to its nose tip) are dropped.
 * - **Color.** A group's color, or for `camo` groups the spec's scheme: a smooth
 *   value-noise pattern over face centers, feature size `scheme.patch`, symmetric
 *   across the centerline so both wings match, picks one of the scheme's colors per face, and down-facing faces take its underside color.
 *   Faces stay single-colored (no gradients within a face, Part I).
 * - **Ambient occlusion.** Per vertex: eight rays in a cone about the face normal,
 *   up to a quarter of the model's radius; each ray that hits another face darkens
 *   the vertex. Models standing on the ground (`ground`, default for buildings)
 *   also darken toward y = 0.
 */
import { EMISSIVE_COLORS, hexToLinear, MODEL_COLORS, SCHEMES } from './palettes';
import type { CamoScheme } from './palettes';
import { MODEL_BUDGETS } from './spec';
import type { AnimChannel, ModelClass, ModelSpec, PartSpec, Station, Vec3 } from './spec';

export interface Emissive {
  kind: string;
  position: Vec3;
  /** Linear rgb. */
  color: Vec3;
}

export interface BuiltModel {
  id: string;
  name: string;
  class: ModelClass;
  triangles: number;
  /** Three vertices per triangle, xyz. */
  position: Float32Array;
  /** Face normal at each vertex. */
  normal: Float32Array;
  /** Linear rgb at each vertex (constant over a face). */
  color: Float32Array;
  /** Ambient occlusion 0..1 at each vertex. */
  ao: Float32Array;
  /**
   * Smoothed normal at each vertex for ink outlines (decision 107): the sum of the
   * distinct face normals meeting at its position, normalized, so the inflated outline
   * hull stays closed across the model's hard edges.
   */
  outlineNormal: Float32Array;
  /** Color group index per triangle, into `groupNames`. */
  group: Uint16Array;
  groupNames: string[];
  emissives: Emissive[];
  bounds: { min: Vec3; max: Vec3 };
}

type V = Vec3;
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V) => Math.sqrt(dot(a, a));
const norm = (a: V): V => scale(a, 1 / (len(a) || 1));
const DEG = Math.PI / 180;

interface Tri {
  a: V;
  b: V;
  c: V;
  group: string;
}

/** Collects outward-facing triangles. */
class Sink {
  readonly tris: Tri[] = [];
  tri(a: V, b: V, c: V, group: string, inside: V): void {
    const n = cross(sub(b, a), sub(c, a));
    const area = len(n);
    if (area < 1e-9) return;
    const centroid = scale(add(add(a, b), c), 1 / 3);
    if (dot(n, sub(centroid, inside)) < 0) this.tris.push({ a, b: c, c: b, group });
    else this.tris.push({ a, b, c, group });
  }
  quad(a: V, b: V, c: V, d: V, group: string, inside: V): void {
    this.tri(a, b, c, group, inside);
    this.tri(a, c, d, group, inside);
  }
  /** A convex polygon as a fan. */
  fan(pts: V[], group: string, inside: V): void {
    for (let i = 1; i + 1 < pts.length; i++) this.tri(pts[0]!, pts[i]!, pts[i + 1]!, group, inside);
  }
}

/** Turn about the y axis through `c` by `deg`. */
function yawAbout(c: V, deg: number): (p: V) => V {
  if (!deg) return (p) => p;
  const a = deg * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return (p) => {
    const x = p[0] - c[0];
    const z = p[2] - c[2];
    return [c[0] + x * ca + z * sa, p[1], c[2] - x * sa + z * ca];
  };
}

/** Side quads between consecutive rings (same point count), plus flat end caps. */
function ringStack(s: Sink, rings: V[][], group: string, inside: V, caps = true): void {
  for (let i = 0; i + 1 < rings.length; i++) {
    const r0 = rings[i]!;
    const r1 = rings[i + 1]!;
    const n = r0.length;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      s.quad(r0[k]!, r0[k1]!, r1[k1]!, r1[k]!, group, inside);
    }
  }
  if (caps) {
    s.fan(rings[0]!, group, inside);
    s.fan(rings[rings.length - 1]!, group, inside);
  }
}

function stationRing(st: Station, sides: number): V[] {
  const y = st.y ?? 0;
  const sq = st.square ?? 0;
  const out: V[] = [];
  for (let k = 0; k < sides; k++) {
    const a = ((k + 0.5) / sides) * Math.PI * 2;
    let c = Math.cos(a);
    let sn = Math.sin(a);
    const m = Math.max(Math.abs(c), Math.abs(sn));
    c = c * (1 - sq) + (c / m) * sq;
    sn = sn * (1 - sq) + (sn / m) * sq;
    out.push([st.x, y + st.h * sn, st.w * c]);
  }
  return out;
}

function loft(s: Sink, p: Extract<PartSpec, { type: 'loft' }>): void {
  const st = p.stations;
  const rings = st.map((x) => stationRing(x, p.sides));
  for (let i = 0; i + 1 < st.length; i++) {
    const mid: V = [(st[i]!.x + st[i + 1]!.x) / 2, ((st[i]!.y ?? 0) + (st[i + 1]!.y ?? 0)) / 2, 0];
    ringStack(s, [rings[i]!, rings[i + 1]!], p.group, mid, false);
  }
  const axis = (i: number): V => [st[i]!.x, st[i]!.y ?? 0, 0];
  const n = st.length;
  if (st[0]!.w > 0 && st[0]!.h > 0) s.fan(rings[0]!, p.group, axis(1));
  if (st[n - 1]!.w > 0 && st[n - 1]!.h > 0) s.fan(rings[n - 1]!, p.group, axis(n - 2));
}

function wing(s: Sink, p: Extract<PartSpec, { type: 'wing' }>): void {
  const d = (p.dihedral ?? 0) * DEG;
  const spanDir: V = p.vertical ? [0, Math.cos(d), Math.sin(d)] : [0, Math.sin(d), Math.cos(d)];
  const thick = norm(cross(spanDir, [1, 0, 0]));
  const t = p.thickness ?? 0.06;
  const section = (le: V, chord: number): V[] => [
    le,
    add(add(le, [-0.4 * chord, 0, 0]), scale(thick, (t * chord) / 2)),
    add(le, [-chord, 0, 0]),
    add(add(le, [-0.4 * chord, 0, 0]), scale(thick, (-t * chord) / 2)),
  ];
  const root = p.root;
  const tipLe = add(add(root, scale(spanDir, p.span)), [-p.span * Math.tan(p.sweep * DEG), 0, 0]);
  const r = section(root, p.rootChord);
  const q = section(tipLe, p.tipChord);
  const chordMid = (a: V[]) => scale(add(a[0]!, a[2]!), 0.5);
  const inside = scale(add(chordMid(r), chordMid(q)), 0.5);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    s.quad(r[k]!, r[k1]!, q[k1]!, q[k]!, p.group, inside);
  }
  s.fan(r, p.group, inside);
  s.fan(q, p.group, inside);
}

function box(s: Sink, p: Extract<PartSpec, { type: 'box' }>): void {
  const [cx, cy, cz] = p.center;
  const [sx, sy, sz] = p.size;
  const b = Math.min(p.bevel ?? 0, sx / 2, sy / 2, sz / 2);
  const turn = yawAbout(p.center, p.yaw ?? 0);
  const rect = (y: number, hx: number, hz: number): V[] =>
    [
      [cx - hx, y, cz - hz],
      [cx + hx, y, cz - hz],
      [cx + hx, y, cz + hz],
      [cx - hx, y, cz + hz],
    ].map((v) => turn(v as V));
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const rings =
    b > 0
      ? [rect(y0, sx / 2, sz / 2), rect(y1 - b, sx / 2, sz / 2), rect(y1, sx / 2 - b, sz / 2 - b)]
      : [rect(y0, sx / 2, sz / 2), rect(y1, sx / 2, sz / 2)];
  ringStack(s, rings, p.group, p.center);
}

function frustum(s: Sink, p: Extract<PartSpec, { type: 'frustum' }>): void {
  const [cx, cy, cz] = p.center;
  const turn = yawAbout(p.center, p.yaw ?? 0);
  const rect = (y: number, hx: number, hz: number): V[] =>
    [
      [cx - hx, y, cz - hz],
      [cx + hx, y, cz - hz],
      [cx + hx, y, cz + hz],
      [cx - hx, y, cz + hz],
    ].map((v) => turn(v as V));
  const inside: V = [cx, cy + p.height * 0.3, cz];
  const bottom = rect(cy, p.base[0] / 2, p.base[1] / 2);
  if (p.top[0] <= 0 || p.top[1] <= 0) {
    const apex: V = [cx, cy + p.height, cz];
    for (let k = 0; k < 4; k++) s.tri(bottom[k]!, bottom[(k + 1) % 4]!, apex, p.group, inside);
    s.fan(bottom, p.group, inside);
  } else {
    ringStack(s, [bottom, rect(cy + p.height, p.top[0] / 2, p.top[1] / 2)], p.group, inside);
  }
}

function cylinder(s: Sink, p: Extract<PartSpec, { type: 'cylinder' }>): void {
  const axis = sub(p.to, p.from);
  const a = norm(axis);
  const ref: V = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(a, ref));
  const v = cross(a, u);
  const ring = (c: V, r: number): V[] =>
    Array.from({ length: p.sides }, (_, k) => {
      const t = ((k + 0.5) / p.sides) * Math.PI * 2;
      return add(c, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t))));
    });
  const inside = scale(add(p.from, p.to), 0.5);
  ringStack(
    s,
    [ring(p.from, p.radius), ring(p.to, p.radius2 ?? p.radius)],
    p.group,
    inside,
    p.caps !== false,
  );
}

const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: V[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((x) => norm(x as V));
  const f = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  return f.map((x) => x.map((i) => v[i]!) as [V, V, V]);
})();

function blob(s: Sink, p: Extract<PartSpec, { type: 'blob' }>): void {
  let tris = ICO;
  for (let d = 0; d < Math.min(2, p.detail ?? 0); d++) {
    tris = tris.flatMap(([a, b, c]) => {
      const ab = norm(add(a, b));
      const bc = norm(add(b, c));
      const ca = norm(add(c, a));
      return [
        [a, ab, ca],
        [ab, b, bc],
        [ca, bc, c],
        [ab, bc, ca],
      ] as [V, V, V][];
    });
  }
  const [rx, ry, rz] = p.radius;
  const place = (q: V): V => {
    const y = p.half ? Math.max(0, q[1]) : q[1];
    return [p.center[0] + q[0] * rx, p.center[1] + y * ry, p.center[2] + q[2] * rz];
  };
  const inside: V = p.half ? add(p.center, [0, ry * 0.3, 0]) : p.center;
  for (const [a, b, c] of tris) {
    if (p.half && a[1] + b[1] + c[1] < 0) continue;
    s.tri(place(a), place(b), place(c), p.group, inside);
  }
}

function arch(s: Sink, p: Extract<PartSpec, { type: 'arch' }>, door: string): void {
  const [cx, cy, cz] = p.center;
  const turn = yawAbout(p.center, p.yaw ?? 0);
  const profile = (x: number): V[] =>
    Array.from({ length: p.sides + 1 }, (_, k) => {
      const th = (k / p.sides) * Math.PI;
      return turn([x, cy + p.height * Math.sin(th), cz - (p.width / 2) * Math.cos(th)]);
    });
  const back = profile(cx - p.length / 2);
  const front = profile(cx + p.length / 2);
  for (let k = 0; k < p.sides; k++) {
    const inside = turn([cx, cy, cz]);
    s.quad(back[k]!, back[k + 1]!, front[k + 1]!, front[k]!, p.group, inside);
  }
  const center = turn([cx, cy + p.height * 0.3, cz]);
  s.fan(back, p.group, center);
  s.fan(front, door, center);
}

function house(s: Sink, p: Extract<PartSpec, { type: 'house' }>): void {
  const [cx, cy, cz] = p.center;
  const [sx, sy, sz] = p.size;
  const turn = yawAbout(p.center, p.yaw ?? 0);
  const inside = turn([cx, cy + sy * 0.5, cz]);
  const at = (x: number, y: number, z: number) => turn([cx + x, cy + y, cz + z]);
  const hx = sx / 2;
  const hz = sz / 2;
  const b = [at(-hx, 0, -hz), at(hx, 0, -hz), at(hx, 0, hz), at(-hx, 0, hz)];
  const t = [at(-hx, sy, -hz), at(hx, sy, -hz), at(hx, sy, hz), at(-hx, sy, hz)];
  for (let k = 0; k < 4; k++)
    s.quad(b[k]!, b[(k + 1) % 4]!, t[(k + 1) % 4]!, t[k]!, p.group, inside);
  if (p.roof <= 0) {
    s.fan(t, p.roofGroup, inside);
    return;
  }
  const r0 = at(-hx, sy + p.roof, 0);
  const r1 = at(hx, sy + p.roof, 0);
  s.quad(t[0]!, t[1]!, r1, r0, p.roofGroup, inside);
  s.quad(t[2]!, t[3]!, r0, r1, p.roofGroup, inside);
  s.tri(t[3]!, t[0]!, r0, p.group, inside);
  s.tri(t[1]!, t[2]!, r1, p.group, inside);
}

function mast(s: Sink, p: Extract<PartSpec, { type: 'mast' }>): void {
  const [cx, cy, cz] = p.center;
  const corner = (k: number, y: number, w: number): V => {
    const sx = k === 0 || k === 3 ? -1 : 1;
    const sz = k < 2 ? -1 : 1;
    return [cx + (sx * w) / 2, cy + y, cz + (sz * w) / 2];
  };
  const r = Math.max(0.08, p.base * 0.04);
  const strut = (a: V, b: V) =>
    cylinder(s, {
      type: 'cylinder',
      group: p.group,
      from: a,
      to: b,
      radius: r,
      sides: 3,
      caps: false,
    });
  const wAt = (y: number) => p.base + ((p.top - p.base) * y) / p.height;
  for (let k = 0; k < 4; k++) strut(corner(k, 0, p.base), corner(k, p.height, p.top));
  const levels = 2;
  for (let l = 0; l < levels; l++) {
    const y0 = (l / levels) * p.height;
    const y1 = ((l + 1) / levels) * p.height;
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      strut(corner(k, y0, wAt(y0)), corner(k1, y1, wAt(y1)));
      strut(corner(k1, y0, wAt(y0)), corner(k, y1, wAt(y1)));
    }
  }
}

function emitPart(s: Sink, p: PartSpec, groups: Record<string, string>): void {
  switch (p.type) {
    case 'loft':
      return loft(s, p);
    case 'wing':
      return wing(s, p);
    case 'box':
      return box(s, p);
    case 'frustum':
      return frustum(s, p);
    case 'cylinder':
      return cylinder(s, p);
    case 'blob':
      return blob(s, p);
    case 'arch':
      return arch(s, p, 'door' in groups ? 'door' : 'opening');
    case 'house':
      return house(s, p);
    case 'mast':
      return mast(s, p);
  }
}

// ---- Color ----

/** A hash of three integers and a seed to [0, 1). */
function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 2 ** 32;
}

/** Smooth value noise in [0, 1). */
function valueNoise(p: V, seed: number): number {
  const i = p.map(Math.floor) as V;
  const f = p.map((x, k) => {
    const t = x - i[k]!;
    return t * t * (3 - 2 * t);
  });
  let out = 0;
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
        out += w * hash(i[0] + dx, i[1] + dy, i[2] + dz, seed);
      }
  return out;
}

function stringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}

function camoColor(scheme: CamoScheme, center: V, normal: V, seed: number): string {
  if (scheme.underside && normal[1] < -0.3) return scheme.underside;
  const n = scheme.colors.length;
  if (n === 1) return scheme.colors[0]!;
  // Symmetric across the centerline, so mirrored halves (both wings) match.
  const mirrored: V = [center[0], center[1], Math.abs(center[2])];
  const v = valueNoise(scale(mirrored, 1 / scheme.patch), seed);
  // Spread the noise's middle-heavy distribution over the colors.
  const u = Math.min(0.999, Math.max(0, (v - 0.2) / 0.6));
  return scheme.colors[Math.floor(u * n)]!;
}

/** A group's color as hex: its entry in the spec (hex or model color name), or the group's own name. */
function groupHex(groups: Record<string, string>, group: string): string | 'camo' {
  const c = groups[group] ?? group;
  if (c === 'camo') return c;
  return c.startsWith('#') ? c : (MODEL_COLORS[c] ?? '#FF00FF');
}

// ---- Ambient occlusion ----

const AO_RAYS = 8;
const AO_STRENGTH = 0.55;

function rayHits(o: V, d: V, tri: Tri, maxT: number): boolean {
  // Möller–Trumbore.
  const e1 = sub(tri.b, tri.a);
  const e2 = sub(tri.c, tri.a);
  const pv = cross(d, e2);
  const det = dot(e1, pv);
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const tv = sub(o, tri.a);
  const u = dot(tv, pv) * inv;
  if (u < 0 || u > 1) return false;
  const qv = cross(tv, e1);
  const v = dot(d, qv) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = dot(e2, qv) * inv;
  return t > 0 && t < maxT;
}

function bakeAo(tris: Tri[], normals: V[], range: number, ground: boolean): Float32Array {
  const out = new Float32Array(tris.length * 3);
  const centers = tris.map((t) => scale(add(add(t.a, t.b), t.c), 1 / 3));
  const radii = tris.map((t, i) =>
    Math.max(len(sub(t.a, centers[i]!)), len(sub(t.b, centers[i]!)), len(sub(t.c, centers[i]!))),
  );
  const eps = range * 1e-3;
  for (let i = 0; i < tris.length; i++) {
    const n = normals[i]!;
    const ref: V = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(n, ref));
    const v = cross(n, u);
    const dirs: V[] = [];
    for (let k = 0; k < AO_RAYS; k++) {
      const a = (k / AO_RAYS) * Math.PI * 2;
      dirs.push(
        norm(add(scale(n, 0.7), add(scale(u, 0.7 * Math.cos(a)), scale(v, 0.7 * Math.sin(a))))),
      );
    }
    const t = tris[i]!;
    const verts = [t.a, t.b, t.c];
    // Candidate occluders within reach of the triangle.
    const c = centers[i]!;
    const reach = range + radii[i]!;
    const near: Tri[] = [];
    for (let j = 0; j < tris.length; j++) {
      if (j === i) continue;
      if (len(sub(centers[j]!, c)) - radii[j]! < reach) near.push(tris[j]!);
    }
    for (let k = 0; k < 3; k++) {
      // Start a little inside the face toward its center, off the surface.
      const o = add(add(verts[k]!, scale(sub(c, verts[k]!), 0.05)), scale(n, eps));
      let hits = 0;
      for (const d of dirs) {
        for (const q of near) {
          if (rayHits(o, d, q, range)) {
            hits++;
            break;
          }
        }
      }
      let ao = 1 - (AO_STRENGTH * hits) / AO_RAYS;
      if (ground) {
        const y = Math.max(0, verts[k]![1]);
        const g = Math.min(1, y / 2.5);
        ao *= 0.7 + 0.3 * g * g * (3 - 2 * g);
      }
      out[i * 3 + k] = ao;
    }
  }
  return out;
}

// ---- Build ----

export interface BuildOptions {
  /** Camouflage scheme override (palettes.ts SCHEMES). */
  scheme?: string;
  /** Skip ambient occlusion (all 1): faster, for previews of very large models. */
  noAo?: boolean;
}

export function buildModel(spec: ModelSpec, options: BuildOptions = {}): BuiltModel {
  const sink = new Sink();
  for (const p of spec.parts) {
    const start = sink.tris.length;
    emitPart(sink, p, spec.groups);
    if (p.mirror) {
      const n = sink.tris.length;
      for (let i = start; i < n; i++) {
        const t = sink.tris[i]!;
        const m = (v: V): V => [v[0], v[1], -v[2]];
        // Reflection reverses orientation: swap two corners.
        sink.tris.push({ a: m(t.a), b: m(t.c), c: m(t.b), group: t.group });
      }
    }
  }
  const tris = sink.tris;
  const count = tris.length;
  const position = new Float32Array(count * 9);
  const normal = new Float32Array(count * 9);
  const color = new Float32Array(count * 9);
  const groupIndex = new Uint16Array(count);
  const groupNames: string[] = [];
  const schemeId = options.scheme ?? spec.scheme;
  const scheme = schemeId ? SCHEMES[schemeId] : undefined;
  const seed = stringSeed(spec.id);
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  const normals: V[] = [];
  tris.forEach((t, i) => {
    const n = norm(cross(sub(t.b, t.a), sub(t.c, t.a)));
    normals.push(n);
    const center = scale(add(add(t.a, t.b), t.c), 1 / 3);
    const hex = groupHex(spec.groups, t.group);
    const rgb = hexToLinear(
      hex === 'camo' && scheme
        ? camoColor(scheme, center, n, seed)
        : hex === 'camo'
          ? '#FF00FF'
          : hex,
    );
    let g = groupNames.indexOf(t.group);
    if (g < 0) g = groupNames.push(t.group) - 1;
    groupIndex[i] = g;
    [t.a, t.b, t.c].forEach((v, k) => {
      position.set(v, i * 9 + k * 3);
      normal.set(n, i * 9 + k * 3);
      color.set(rgb, i * 9 + k * 3);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, v[a]!);
        max[a] = Math.max(max[a]!, v[a]!);
      }
    });
  });
  const size = count ? len(sub(max, min)) : 1;
  const ground = spec.ground ?? spec.class === 'building';
  const ao = options.noAo
    ? new Float32Array(count * 3).fill(1)
    : bakeAo(tris, normals, size / 4, ground);
  const emissives: Emissive[] = [];
  for (const e of spec.emissives ?? []) {
    const c = hexToLinear(EMISSIVE_COLORS[e.kind]!);
    emissives.push({ kind: e.kind, position: [...e.at], color: c });
    if (e.mirror)
      emissives.push({ kind: e.kind, position: [e.at[0], e.at[1], -e.at[2]], color: c });
  }
  return {
    id: spec.id,
    name: spec.name,
    class: spec.class,
    triangles: count,
    position,
    normal,
    color,
    ao,
    outlineNormal: outlineNormals(position, normal),
    group: groupIndex,
    groupNames,
    emissives,
    bounds: { min, max },
  };
}

/** True if a built model's triangle count is within its class's budget (Part I). */
export function withinBudget(m: BuiltModel): boolean {
  const [lo, hi] = MODEL_BUDGETS[m.class];
  return m.triangles >= lo && m.triangles <= hi;
}

/**
 * Outline normals (decision 107): vertices at the same position (to 0.1 mm) share the
 * normalized sum of the distinct face normals that meet there; where they cancel (the
 * two sides of a thin sheet), the face normal is kept.
 */
export function outlineNormals(position: Float32Array, normal: Float32Array): Float32Array {
  const key = (i: number) =>
    `${Math.round(position[i]! * 1e4)},${Math.round(position[i + 1]! * 1e4)},${Math.round(position[i + 2]! * 1e4)}`;
  const sums = new Map<string, { n: number[][]; sum: [number, number, number] }>();
  for (let i = 0; i < position.length; i += 3) {
    const k = key(i);
    let e = sums.get(k);
    if (!e) sums.set(k, (e = { n: [], sum: [0, 0, 0] }));
    const nx = normal[i]!;
    const ny = normal[i + 1]!;
    const nz = normal[i + 2]!;
    // Coplanar triangles of one face count once.
    if (e.n.some((m) => m[0]! * nx + m[1]! * ny + m[2]! * nz > 0.9999)) continue;
    e.n.push([nx, ny, nz]);
    e.sum[0] += nx;
    e.sum[1] += ny;
    e.sum[2] += nz;
  }
  const out = new Float32Array(position.length);
  for (let i = 0; i < position.length; i += 3) {
    const sum = sums.get(key(i))!.sum;
    const l = Math.hypot(sum[0], sum[1], sum[2]);
    if (l < 0.2) out.set([normal[i]!, normal[i + 1]!, normal[i + 2]!], i);
    else out.set([sum[0] / l, sum[1] / l, sum[2] / l], i);
  }
  return out;
}

// ---- Animated parts (decision 134) ----

export interface AnimatedPiece {
  model: BuiltModel;
  channel: AnimChannel;
  /** Hinge point and unit axis (model frame). */
  origin: Vec3;
  axis: Vec3;
  /** Full deflection (rad). */
  angle: number;
  /** +1 for the part as specified, −1 for its mirror image across z = 0. */
  side: 1 | -1;
}

export interface AnimatedModel {
  /** Everything that does not move, with the spec's emissives. */
  body: BuiltModel;
  pieces: AnimatedPiece[];
}

/** The mirror image of a built model across z = 0 (orientation kept outward). */
function mirrorModel(m: BuiltModel): BuiltModel {
  const flip = (a: Float32Array) => {
    const o = new Float32Array(a.length);
    for (let t = 0; t < a.length; t += 9) {
      // Swap the second and third vertex, negating z.
      for (const [dst, src] of [
        [0, 0],
        [3, 6],
        [6, 3],
      ] as const) {
        o[t + dst] = a[t + src]!;
        o[t + dst + 1] = a[t + src + 1]!;
        o[t + dst + 2] = -a[t + src + 2]!;
      }
    }
    return o;
  };
  const swap = (a: Float32Array, k: number) => {
    const o = new Float32Array(a.length);
    for (let t = 0; t < a.length; t += 3 * k) {
      o.set(a.subarray(t, t + k), t);
      o.set(a.subarray(t + 2 * k, t + 3 * k), t + k);
      o.set(a.subarray(t + k, t + 2 * k), t + 2 * k);
    }
    return o;
  };
  return {
    ...m,
    position: flip(m.position),
    normal: flip(m.normal),
    outlineNormal: flip(m.outlineNormal),
    color: swap(m.color, 3),
    ao: swap(m.ao, 1),
    bounds: {
      min: [m.bounds.min[0], m.bounds.min[1], -m.bounds.max[2]],
      max: [m.bounds.max[0], m.bounds.max[1], -m.bounds.min[2]],
    },
  };
}

/**
 * Builds a spec as a static body plus one piece per animated part (and per mirror
 * image), each with its hinge, for the controlled aircraft. The pieces together
 * with the body hold the same triangles as `buildModel(spec)`.
 */
export function buildAnimatedModel(spec: ModelSpec, options: BuildOptions = {}): AnimatedModel {
  const body = buildModel({ ...spec, parts: spec.parts.filter((p) => !p.anim) }, options);
  const pieces: AnimatedPiece[] = [];
  for (const p of spec.parts) {
    if (!p.anim) continue;
    const m = buildModel({ ...spec, parts: [{ ...p, mirror: false }], emissives: [] }, options);
    const [a, b] = p.anim.hinge;
    const axis = norm(sub(b, a));
    const angle = (p.anim.angle * Math.PI) / 180;
    pieces.push({ model: m, channel: p.anim.channel, origin: [...a], axis, angle, side: 1 });
    if (p.mirror) {
      pieces.push({
        model: mirrorModel(m),
        channel: p.anim.channel,
        origin: [a[0], a[1], -a[2]],
        axis: [axis[0], axis[1], -axis[2]],
        angle,
        side: -1,
      });
    }
  }
  return { body, pieces };
}
