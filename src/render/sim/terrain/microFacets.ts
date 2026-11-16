/**
 * Micro-facets: stepped relief finer than the terrain mesh, near a low camera
 * (docs/visual-style.md Part I, Terrain: ground detail near the ground;
 * decisions 168, 169).
 *
 * A bump map that keeps the facet rule. Each octave is a scalar field that is
 * linear inside every tetrahedron of a cubic lattice split six ways (the Kuhn
 * triangulation), with a hashed value at each lattice point. Its gradient is
 * constant inside a tetrahedron, so where the ground cuts through the lattice
 * it falls into small flat cells, triangles and quads about a cell across,
 * each with one tilted normal and one shade. The result reads as a virtual
 * mesh finer than the real one, not as a texture.
 *
 * - **Where.** The lattice lies on the wrapped coordinates (decision 38): a
 *   whole number of cells spans the wave period, and each octave's integer
 *   matrix maps that period onto itself, so the pattern stays nailed to the
 *   ground, continues across meshes and keeps float32 precision. It is 3D, so
 *   it needs no projection and has no seams or stretch on slopes or cube faces.
 *   The matrices turn the octaves against each other so their lattice planes
 *   do not line up into a grid.
 * - **By land cover.** Grass and soil take soft lumps at 1 m, dry ground sharp
 *   grit at 0.5 m, rock chiseled planes at 4 m; snow keeps its normal (its
 *   sparkle is its own detail, decision 139) and takes only faint shade steps.
 * - **Fade.** An octave fades where its cells shrink under a few pixels, and
 *   every octave fades out toward `range`, so nothing shimmers.
 * - **Cost.** A uniform (`active`, from the camera's height above the ground)
 *   and a per-fragment distance test skip the evaluation; above `range` the
 *   terrain pays one uniform branch.
 *
 * Build it before nothing; call `evaluate` with derivatives taken outside any
 * branch (decision 69): it takes none itself.
 */
import type { Node } from 'three/webgpu';
import {
  dot,
  float,
  floor,
  If,
  ivec3,
  max,
  mix,
  normalize,
  smoothstep,
  step,
  uint,
  uniform,
  vec3,
} from 'three/tsl';
import { cellHashNode, hashBitsNode } from '../../common/canopyNode';
import { WAVE_PERIOD } from '../water/waterShading';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type U = Node<'uint'>;

/** The distance (m) beyond which no micro-facets are drawn; the camera must be under it. */
export const MICRO_RANGE = 600;

/**
 * One octave: its lattice, as cells per wave period and an integer matrix that
 * turns and shears it (rows); its cells' size across (m), for the fade; and,
 * per land cover, slope and shade.
 */
interface Octave {
  /** Lattice cells per WAVE_PERIOD along each axis before the matrix (an integer). */
  cells: number;
  /** Integer rows: any integer matrix keeps the field periodic with the wave period. */
  matrix: readonly [readonly number[], readonly number[], readonly number[]];
  /** The cells' size across (m). */
  size: number;
  /** Largest slope (m/m) per axis the octave adds, for grass, dry ground, rock. */
  slope: readonly [number, number, number];
  /** Albedo step (± fraction) per cell, for grass, dry ground, rock, snow. */
  shade: readonly [number, number, number, number];
}

// The octaves are turned against each other and their sizes do not nest, so their
// lattice planes never line up into a grid.
export const MICRO_OCTAVES: readonly Octave[] = [
  {
    cells: 1024,
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    size: 4,
    slope: [0.12, 0.12, 0.5],
    shade: [0.05, 0.05, 0.1, 0.03],
  },
  {
    cells: 2400,
    matrix: [
      [1, 0, 1],
      [1, 1, 0],
      [0, 1, 1],
    ],
    size: 1.2,
    slope: [0.35, 0.25, 0.3],
    shade: [0.07, 0.05, 0.06, 0],
  },
  {
    cells: 5400,
    matrix: [
      [1, -1, 0],
      [0, 1, -1],
      [1, 1, 1],
    ],
    size: 0.5,
    slope: [0.14, 0.6, 0.08],
    shade: [0.04, 0.1, 0.03, 0],
  },
];

/** Octaves fade in between these many pixels per cell: finer cells would speckle. */
const VISIBLE_PIXELS = [3, 7] as const;

/** Glints light between these cosines of the angle between a cell's normal and the half vector (4° to 2°). */
const GLINT_COS = [0.9976, 0.9994] as const;

/** What `evaluate` needs at a fragment. */
export interface MicroInputs {
  /** Fragment position modulo the wave period (decision 38). */
  wrapped: V3;
  /** The facet's unit normal. */
  normal: V3;
  /** The pixel's extent on the surface (m), taken outside any branch. */
  footprint: F;
  /** Distance from the camera (m). */
  distance: F;
  /** Where micro-facets apply at all, 0..1: bare dry land (no water, pavement, towns or canopy). */
  mask: F;
  /** Rock cover 0..1. */
  rock: F;
  /** Dry ground (aridity) 0..1. */
  dry: F;
  /** Snow cover 0..1. */
  snow: F;
}

/** What `evaluate` returns. */
export interface MicroResult {
  /** The shading normal with the micro-facets' tilt. */
  normal: V3;
  /** The albedo multiplier of the fragment's cell. */
  shade: F;
  /** How much of the detail shows, 0..1 (fades with pixels and distance), for glints. */
  visible: F;
}

/**
 * One octave at `wrapped`: the gradient of the piecewise-linear field (per
 * cell, components in [-1, 1]) and its value at the tetrahedron's centroid
 * (in [-0.5, 0.5]), both constant over the tetrahedron.
 */
function octave(wrapped: V3, o: Octave, seed: U): { grad: V3; value: F } {
  const period = o.cells;
  const p = wrapped.mul(o.cells / WAVE_PERIOD);
  const [r0, r1, r2] = o.matrix;
  const row = (r: readonly number[]) => dot(p, vec3(r[0]!, r[1]!, r[2]!));
  const q = vec3(row(r0), row(r1), row(r2));
  const i0 = floor(q).toVar();
  const f = q.sub(i0).toVar();
  // The tetrahedron: the path from the cell's corner (0,0,0) to (1,1,1) that adds the
  // axes in descending order of the fractional coordinates.
  const xy = step(f.y, f.x);
  const xz = step(f.z, f.x);
  const yz = step(f.z, f.y);
  const e1 = vec3(xy.mul(xz), float(1).sub(xy).mul(yz), float(1).sub(xz).mul(float(1).sub(yz)));
  const e3 = vec3(float(1).sub(xy).mul(float(1).sub(xz)), xy.mul(float(1).sub(yz)), xz.mul(yz));
  const e2 = vec3(1).sub(e1).sub(e3);
  const at = (c: V3): F => {
    // Wrap the lattice so the field repeats with the wave period.
    const w = c.sub(floor(c.div(period)).mul(period));
    return hashBitsNode(cellHashNode(ivec3(w), seed), 3);
  };
  const h0 = at(i0 as V3);
  const v1 = i0.add(e1);
  const h1 = at(v1 as V3);
  const h2 = at(v1.add(e2) as V3);
  const h3 = at(i0.add(1) as V3);
  const g = e1
    .mul(h1.sub(h0))
    .add(e2.mul(h2.sub(h1)))
    .add(e3.mul(h3.sub(h2)));
  // Back to space: the field's gradient is the matrix's transpose times the lattice's,
  // scaled by the lattice's cells per meter over the cells' size, so `slope` holds.
  const scale = (o.cells / WAVE_PERIOD) * o.size;
  const grad = vec3(r0[0]!, r0[1]!, r0[2]!)
    .mul(g.x)
    .add(vec3(r1[0]!, r1[1]!, r1[2]!).mul(g.y))
    .add(vec3(r2[0]!, r2[1]!, r2[2]!).mul(g.z))
    .mul(scale);
  const value = h0.add(h1).add(h2).add(h3).mul(0.25).sub(0.5);
  return { grad: grad as V3, value: value as F };
}

export class MicroFacets {
  /** Strength 0..1 (0 = off): scales the tilt and the shade steps. */
  readonly strength = uniform(1);
  /** 1 while the camera is low enough for any fragment to be within `range`. */
  readonly active = uniform(0);
  /** Distance (m) over which the detail fades out. */
  readonly range = uniform(MICRO_RANGE);
  /** Glint strength on wet ground and smooth rock (0 = off). */
  readonly glint = uniform(1);
  /** The world's hash seed. */
  readonly seed = uniform(0, 'uint');

  /** Sets `active` from the camera's height above the ground (m). */
  setCamera(aboveGround: number): void {
    this.active.value = aboveGround < this.range.value && this.strength.value > 0 ? 1 : 0;
  }

  /** The micro-facets at a fragment (see the module comment). */
  evaluate(i: MicroInputs): MicroResult {
    const normal = vec3(i.normal).toVar();
    const shade = float(1).toVar();
    const visible = float(0).toVar();
    If(
      this.active.greaterThan(0).and(i.mask.greaterThan(0)).and(i.distance.lessThan(this.range)),
      () => {
        const near = smoothstep(this.range, this.range.mul(0.6), i.distance)
          .mul(i.mask)
          .mul(this.strength);
        const grass = float(1).sub(i.rock).mul(float(1).sub(i.dry));
        const dry = float(1).sub(i.rock).mul(i.dry);
        const bare = float(1).sub(i.snow);
        const seed = this.seed as unknown as U;
        const g = vec3(0).toVar();
        const s = float(0).toVar();
        const seen = float(0).toVar();
        MICRO_OCTAVES.forEach((o, k) => {
          const vis = smoothstep(
            VISIBLE_PIXELS[0],
            VISIBLE_PIXELS[1],
            float(o.size).div(max(i.footprint, 1e-4)),
          ).mul(near);
          const { grad, value } = octave(i.wrapped, o, seed.bitXor(uint(0x9e37 * (k + 1))) as U);
          const slope = grass
            .mul(o.slope[0])
            .add(dry.mul(o.slope[1]))
            .add(i.rock.mul(o.slope[2]))
            .mul(bare);
          const amp = mix(
            grass.mul(o.shade[0]).add(dry.mul(o.shade[1])).add(i.rock.mul(o.shade[2])),
            float(o.shade[3]),
            i.snow,
          );
          g.addAssign(grad.mul(slope.mul(vis)));
          s.addAssign(value.mul(2).mul(amp).mul(vis));
          seen.assign(max(seen, vis.mul(step(1e-3, slope))));
        });
        // Tilt the facet by the field's gradient across it.
        const across = g.sub(i.normal.mul(dot(i.normal, g)));
        normal.assign(normalize(i.normal.sub(across)));
        shade.assign(s.add(1));
        visible.assign(seen);
      },
    );
    return {
      normal: normal as unknown as V3,
      shade: shade as unknown as F,
      visible: visible as unknown as F,
    };
  }

  /**
   * Glints of single cells (a multiplier of the sunlight): a cell whose tilt
   * turns it to mirror the sun toward the camera flashes as one small flat
   * flash. Cells that mirror only because the facet under them does are left
   * to the wet sheen. `wet` is the ground's wetness on bare ground, `polish`
   * how smooth the rock is, both 0..1.
   */
  glints(r: MicroResult, facet: V3, view: V3, sun: V3, wet: F, polish: F): F {
    const half = normalize(view.add(sun));
    const cell = smoothstep(GLINT_COS[0], GLINT_COS[1], dot(r.normal, half));
    const plain = smoothstep(GLINT_COS[0], GLINT_COS[1], dot(facet, half));
    const facing = smoothstep(0, 0.1, dot(facet, sun));
    return max(cell.sub(plain), 0)
      .mul(r.visible)
      .mul(facing)
      .mul(wet.mul(1.5).add(polish.mul(0.25)))
      .mul(this.glint) as F;
  }
}
