/**
 * Tree kit previews without a GPU (docs/proposals/0003): the tree specs on the CPU
 * rasterizer of the model previews (tools/modelRaster.ts).
 *
 *   tools/out/trees-lineup.png   every tree-* spec in a row on a ground plate
 *   tools/out/trees-stand-*.png  a forest corner seen from a hovering helicopter
 *                                (oblique, 30 m up) and from above: a closed fir and
 *                                pine stand, a lower broadleaf stand beside it, a fringe
 *                                of shrubs and birches, a hedgerow, a row of poplars
 *                                along a track, a lone oak and a dead tree in the field
 *
 * Instances vary as Part I asks: scale 0.8–1.3, yaw, a small tilt and a value shift,
 * plus a shade per stand. SHELL=1 draws the understory shell under the closed stands
 * (the proposal's gap filler); SEED picks another layout.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/trees.preview.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { buildModel } from '../src/render/common/models/builder';
import type { BuiltModel } from '../src/render/common/models/builder';
import { hexToLinear } from '../src/render/common/models/palettes';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { rng } from '../src/core/rng';
import { draw, view } from './modelRaster';
import { encodePng } from './png';

const SEED = Number(process.env.SEED ?? 1);
const SHELL = process.env.SHELL === '1';

type V = [number, number, number];

/** A growing triangle soup in BuiltModel's layout. */
class Scene {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  ao: number[] = [];

  /** Adds `m` turned by `yaw`, tilted by `tilt` about x, scaled by `s`, at `at`, colors × `tint`. */
  add(m: BuiltModel, at: V, yaw: number, s: number, tint: V, tilt = 0): void {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const rot = (x: number, y: number, z: number): V => {
      const y1 = y * ct - z * st;
      const z1 = y * st + z * ct;
      return [x * cy + z1 * sy, y1, -x * sy + z1 * cy];
    };
    for (let i = 0; i < m.position.length; i += 3) {
      const p = rot(m.position[i]!, m.position[i + 1]!, m.position[i + 2]!);
      this.pos.push(at[0] + p[0] * s, at[1] + p[1] * s, at[2] + p[2] * s);
      this.nrm.push(...rot(m.normal[i]!, m.normal[i + 1]!, m.normal[i + 2]!));
      this.col.push(m.color[i]! * tint[0], m.color[i + 1]! * tint[1], m.color[i + 2]! * tint[2]);
    }
    for (const a of m.ao) this.ao.push(a);
  }

  /** A flat-shaded triangle of one linear color. */
  tri(a: V, b: V, c: V, color: V, ao = 1): void {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: V = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    if (n[1] < 0) {
      [b, c] = [c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    const l = Math.hypot(...n) || 1;
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.nrm.push(n[0] / l, n[1] / l, n[2] / l);
      this.col.push(...color);
      this.ao.push(ao);
    }
  }

  built(): BuiltModel {
    const position = Float32Array.from(this.pos);
    const min: V = [Infinity, Infinity, Infinity];
    const max: V = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.length; i++) {
      min[i % 3] = Math.min(min[i % 3]!, position[i]!);
      max[i % 3] = Math.max(max[i % 3]!, position[i]!);
    }
    const triangles = position.length / 9;
    return {
      id: 'scene',
      name: 'scene',
      class: 'tree',
      triangles,
      position,
      normal: Float32Array.from(this.nrm),
      color: Float32Array.from(this.col),
      ao: Float32Array.from(this.ao),
      outlineNormal: Float32Array.from(this.nrm),
      group: new Uint16Array(triangles),
      groupNames: [],
      emissives: [],
      bounds: { min, max },
    };
  }
}

const lin = (hex: string): V => hexToLinear(hex) as V;
const GRASS = ['#7A8C4A', '#6B7C40', '#8A9A55'].map(lin);
const FLOOR = lin('#2A3524');
const TRACK = lin('#8C7F6A');

/** Gentle ground: a few long waves, meters. */
const groundY = (x: number, z: number) =>
  0.9 * Math.sin(x * 0.035 + 0.4) + 0.7 * Math.sin(z * 0.05 - 0.3) + 0.3 * Math.sin((x + z) * 0.09);

/** Faceted ground plate over [x0, x1] × [z0, z1], cells of `cell` m. */
function ground(
  sc: Scene,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  cell: number,
  color: (x: number, z: number) => V,
): void {
  const r = rng(SEED, 'tools/trees/ground');
  for (let z = z0; z < z1; z += cell) {
    for (let x = x0; x < x1; x += cell) {
      const p = (px: number, pz: number): V => [px, groundY(px, pz), pz];
      const a = p(x, z);
      const b = p(x + cell, z);
      const c = p(x + cell, z + cell);
      const d = p(x, z + cell);
      const s1 = 0.94 + 0.12 * r.nextFloat();
      const s2 = 0.94 + 0.12 * r.nextFloat();
      const c1 = color(x + cell * 0.66, z + cell * 0.33).map((v) => v * s1) as V;
      const c2 = color(x + cell * 0.33, z + cell * 0.66).map((v) => v * s2) as V;
      sc.tri(a, b, c, c1);
      sc.tri(a, c, d, c2);
    }
  }
}

const models = Object.fromEntries(
  Object.keys(MODEL_SPECS)
    .filter((id) => id.startsWith('tree-'))
    .map((id) => [id, buildModel(MODEL_SPECS[id]!)]),
) as Record<string, BuiltModel>;

function write(
  name: string,
  w: number,
  h: number,
  m: BuiltModel,
  yaw: number,
  pitch: number,
  frame: { center: V; size: number },
  sun: V,
): void {
  const img = new Uint8Array(w * h * 3);
  draw(img, w, 0, 0, m, view(yaw, pitch), false, {
    w,
    h,
    ink: 0,
    center: frame.center,
    size: frame.size,
    sun,
  });
  const out = join(import.meta.dirname, 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), encodePng(w, h, img));
}

it('tree kit lineup', () => {
  const sc = new Scene();
  const ids = [
    'tree-fir',
    'tree-pine',
    'tree-birch',
    'tree-oak',
    'tree-broadleaf',
    'tree-poplar',
    'tree-acacia',
    'tree-dead',
    'tree-shrub',
  ];
  const gap = 15;
  const x0 = -((ids.length - 1) * gap) / 2;
  ground(
    sc,
    x0 - 12,
    -x0 + 12,
    -14,
    14,
    6,
    (x, z) => GRASS[Math.abs(Math.floor(x * 0.13 + z * 0.07)) % 3]!,
  );
  ids.forEach((id, i) => {
    const x = x0 + i * gap;
    sc.add(models[id]!, [x, groundY(x, 0), 0], 0.5, 1, [1, 1, 1]);
  });
  const m = sc.built();
  write(
    'trees-lineup.png',
    1800,
    640,
    m,
    Math.PI / 2 - 0.12,
    0.16,
    { center: [0, 8, 0], size: 44 },
    [0.5, 0.7, 0.6],
  );
  console.info(ids.map((id) => `${id}: ${models[id]!.triangles} tris`).join(', '));
});

it('forest corner', () => {
  const sc = new Scene();
  const r = rng(SEED, 'tools/trees/stand');
  // Stands: closed conifer (west), lower broadleaf (middle); open field to the south (+z).
  const conifer = (x: number, z: number) => x < -12 && z < 18 + 6 * Math.sin(x * 0.08);
  const broad = (x: number, z: number) => x >= -12 && x < 50 && z < 6 + 5 * Math.sin(x * 0.11 + 1);
  const inStand = (x: number, z: number) => conifer(x, z) || broad(x, z);
  ground(sc, -110, 100, -90, 70, 8, (x, z) =>
    inStand(x, z)
      ? FLOOR
      : Math.abs(z - 44) < 2.5
        ? TRACK
        : GRASS[(Math.floor(x / 37) + Math.floor(z / 29) + 9) % 3]!,
  );
  let count = 0;
  const tree = (
    id: string,
    x: number,
    z: number,
    standTint: number,
    scaleLo = 0.8,
    scaleHi = 1.3,
  ) => {
    const s = r.range(scaleLo, scaleHi);
    const v = standTint * r.range(0.86, 1.14);
    const hue = r.range(0.97, 1.03);
    sc.add(
      models[id]!,
      [x, groundY(x, z) - 0.3, z],
      r.range(0, 2 * Math.PI),
      s,
      [v, v * hue, v],
      r.range(-0.06, 0.06),
    );
    count++;
  };
  // Closed stands on a jittered lattice; spacing follows the crown size.
  const lattice = (
    spacing: number,
    test: (x: number, z: number) => boolean,
    pick: (x: number, z: number) => void,
  ) => {
    for (let z = -90; z < 70; z += spacing)
      for (let x = -110; x < 100; x += spacing) {
        const px = x + r.range(-0.35, 0.35) * spacing;
        const pz = z + r.range(-0.35, 0.35) * spacing;
        if (test(px, pz)) pick(px, pz);
      }
  };
  lattice(7, conifer, (x, z) => tree(r.nextFloat() < 0.72 ? 'tree-fir' : 'tree-pine', x, z, 0.95));
  lattice(7.5, broad, (x, z) => {
    const u = r.nextFloat();
    tree(u < 0.45 ? 'tree-broadleaf' : u < 0.8 ? 'tree-oak' : 'tree-birch', x, z, 1.04, 0.8, 1.15);
  });
  // The understory shell: a dark sheet at about 60% of the crowns' height, which the
  // canopy shell of the proposal provides between instanced crowns.
  if (SHELL) {
    const cell = 6;
    for (let z = -90; z < 70; z += cell)
      for (let x = -110; x < 100; x += cell) {
        const cx = x + cell / 2;
        const cz = z + cell / 2;
        if (!inStand(cx, cz)) continue;
        const h = conifer(cx, cz) ? 7 : 6.5;
        // Shadowed foliage, not floor: the stand's darkest canopy shade, darker still.
        const shade = lin(conifer(cx, cz) ? '#24382A' : '#2F4A2A').map((c) => c * 0.8) as V;
        const p = (px: number, pz: number): V => [px, groundY(px, pz) + h, pz];
        sc.tri(p(x, z), p(x + cell, z), p(x + cell, z + cell), shade);
        sc.tri(p(x, z), p(x + cell, z + cell), p(x, z + cell), shade.map((c) => c * 0.94) as V);
      }
  }
  // The fringe: shrubs and birches scattered out to 14 m beyond the edge.
  for (let i = 0; i < 260; i++) {
    const x = r.range(-110, 100);
    const z = r.range(-90, 70);
    const keep = r.nextFloat();
    if (inStand(x, z)) continue;
    const near = [4, 8, 14].findIndex(
      (d) => inStand(x, z - d) || inStand(x + d, z) || inStand(x - d, z),
    );
    if (near < 0 || keep > [0.9, 0.5, 0.2][near]!) continue;
    tree(r.nextFloat() < 0.65 ? 'tree-shrub' : 'tree-birch', x, z, 1, 0.7, 1.1);
  }
  // A hedgerow north–south across the field, poplars along the track, a lone oak, a dead tree.
  for (let z = 10; z < 40; z += 2.6) tree('tree-shrub', 62 + r.range(-0.8, 0.8), z, 0.92, 0.8, 1.2);
  for (let x = -100; x < 95; x += 11) tree('tree-poplar', x + r.range(-1, 1), 40, 1, 0.95, 1.1);
  tree('tree-oak', 25, 26, 1.0, 1.55, 1.6);
  tree('tree-dead', -40, 32, 1, 1, 1);
  const m = sc.built();
  const sun: V = [0.55, 0.55, 0.65];
  write(
    'trees-stand-oblique.png',
    1600,
    900,
    m,
    Math.PI / 2 - 0.4,
    0.24,
    { center: [-5, 8, 0], size: 105 },
    sun,
  );
  write(
    'trees-stand-top.png',
    1200,
    900,
    m,
    Math.PI / 2 - 0.0001,
    Math.PI / 2 - 0.0001,
    { center: [-5, 0, -10], size: 175 },
    sun,
  );
  console.info(`forest corner: ${count} trees, ${m.triangles} triangles`);
});
