/** Per-face shading's grid coordinates and face keys (decision 124), run as compute kernels on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec2, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { childTiles, tileKey } from '../../src/core/tiles';
import type { TileKey } from '../../src/core/tiles';
import { PLANET_RADIUS } from '../../src/core/units';
import { TILE_SEGMENTS, vertexSpacing } from '../../src/render/common/terrain/quadtree';
import { buildTileIndex, TILE_VERTEX_COUNT } from '../../src/render/common/terrain/tileMesh';
import { facePoint, tileGridCoordinate } from '../../src/render/sim/terrain/faceShading';
import { rng } from '../../src/core/rng';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();
const S = TILE_SEGMENTS;
const V = S + 1;
const R = PLANET_RADIUS;

const tileNode = (t: TileKey) => vec4(t.face, t.level, t.x, t.y) as unknown as Node<'vec4'>;

describe.skipIf(!gpu)('per-face shading (TSL on Dawn)', () => {
  it("gives every vertex its grid coordinate, skirts their edge vertex's", async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const out = instancedArray(TILE_VERTEX_COUNT, 'vec4');
    const kernel = Fn(() => {
      out.element(instanceIndex).assign(vec4(tileGridCoordinate(instanceIndex), 0));
    })().compute(TILE_VERTEX_COUNT);
    await head.renderer.computeAsync(kernel);
    const g = new Float32Array(await head.renderer.getArrayBufferAsync(out.value));
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    for (let v = 0; v < V * V; v++) {
      expect([g[v * 4], g[v * 4 + 1], g[v * 4 + 2]]).toEqual([v % V, Math.floor(v / V), 0]);
    }
    // Skirt triangles are (a, sa, b), (b, sa, sb): skirt vertex sa copies grid vertex a.
    const index = buildTileIndex();
    for (let t = 2 * S * S; t < index.length / 3; t += 2) {
      const a = index[3 * t]!;
      const sa = index[3 * t + 1]!;
      expect(sa).toBeGreaterThanOrEqual(V * V);
      expect([g[sa * 4], g[sa * 4 + 1], g[sa * 4 + 2]]).toEqual([g[a * 4], g[a * 4 + 1], 1]);
    }
  });

  it("starts a split with the parent's faces and ends with the child's", async () => {
    const parent = tileKey(2, 6, 20, 33);
    const child = childTiles(parent)[3]!; // (+1, +1) quadrant
    const corner = [(child.x & 1) * (S / 2), (child.y & 1) * (S / 2)];
    // Points away from the edges and diagonals of both grids.
    const random = rng(7, 'face-test');
    const clear = (x: number, y: number) => {
      const fx = x - Math.floor(x);
      const fy = y - Math.floor(y);
      return Math.min(fx, 1 - fx, fy, 1 - fy, Math.abs(fx - fy)) > 0.03;
    };
    const points: [number, number][] = [];
    while (points.length < 256) {
      const u = random.nextFloat() * S;
      const v = random.nextFloat() * S;
      if (clear(u, v) && clear(corner[0]! + u / 2, corner[1]! + v / 2)) points.push([u, v]);
    }
    const input = instancedArray(Float32Array.from(points.flat()), 'vec2');
    const n = points.length;
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const outs = [0, 1, 2].map(() => instancedArray(n, 'vec4'));
    const kernel = Fn(() => {
      const uv = input.element(instanceIndex) as unknown as Node<'vec2'>;
      const parentUv = vec2(corner[0]!, corner[1]!).add(uv.mul(0.5)) as Node<'vec2'>;
      const morph = (m: number) => vec4(m).x as Node<'float'>;
      const cases = [
        facePoint(uv, tileNode(child), morph(0), R),
        facePoint(parentUv, tileNode(parent), morph(1), R),
        facePoint(uv, tileNode(child), morph(1), R),
      ];
      cases.forEach((c, k) =>
        outs[k]!.element(instanceIndex).assign(vec4(c.center, c.jitter, c.spacing)),
      );
    })().compute(n);
    await head.renderer.computeAsync(kernel);
    const [atZero, ofParent, atOne] = await Promise.all(
      outs.map(async (o) => new Float32Array(await head.renderer.getArrayBufferAsync(o.value))),
    );
    head.dispose();
    expect(gpu!.errors).toEqual([]);

    const centroid = (x: number, y: number) => {
      const qx = Math.floor(x);
      const qy = Math.floor(y);
      return x - qx >= y - qy ? [qx + 2 / 3, qy + 1 / 3] : [qx + 1 / 3, qy + 2 / 3];
    };
    const jitters = new Set<number>();
    points.forEach(([u, v], i) => {
      const z = atZero!.subarray(i * 4, i * 4 + 4);
      const p = ofParent!.subarray(i * 4, i * 4 + 4);
      const o = atOne!.subarray(i * 4, i * 4 + 4);
      // At morph 0 the child evaluates the parent's face: its centroid, hash and facet size.
      expect(corner[0]! + z[0]! / 2).toBeCloseTo(p[0]!, 4);
      expect(corner[1]! + z[1]! / 2).toBeCloseTo(p[1]!, 4);
      expect(z[2]).toBe(p[2]);
      expect(z[3]).toBeCloseTo(p[3]!, 6);
      expect(p[3]).toBeCloseTo(vertexSpacing(parent.level, R), 1);
      // At morph 1, its own face.
      const [cx, cy] = centroid(u, v);
      expect(o[0]).toBeCloseTo(cx!, 4);
      expect(o[1]).toBeCloseTo(cy!, 4);
      expect(o[3]).toBeCloseTo(vertexSpacing(child.level, R), 1);
      expect(o[2]).toBeGreaterThanOrEqual(0);
      expect(o[2]).toBeLessThan(1);
      jitters.add(o[2]!);
    });
    // Distinct faces get distinct values: nearly as many as the faces the points fell in.
    const faces = new Set(points.map(([u, v]) => centroid(u, v).join()));
    expect(jitters.size).toBeGreaterThan(faces.size * 0.95);
  });
});
