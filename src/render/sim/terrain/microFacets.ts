/**
 * Micro-facets: stepped relief finer than the terrain mesh, near a low camera
 * (docs/visual-style.md Part I, Terrain: ground detail near the ground;
 * decisions 168, 169).
 *
 * A bump map that keeps the facet rule. Each octave is a height field that is
 * linear inside every triangle of a square lattice split along its diagonal,
 * with a hashed value at each lattice point, laid on the plane across the world
 * axis nearest to the terrain facet's normal. Its gradient is constant inside a
 * triangle, so the ground falls into small flat triangles about a cell across,
 * each with one tilted normal and one shade: a virtual mesh finer than the real
 * one, not a texture.
 *
 * - **Where.** The lattice lies on the wrapped coordinates (decision 38): a
 *   whole number of cells spans the wave period, and each octave's integer
 *   matrix maps that period onto itself, so the pattern stays nailed to the
 *   ground, continues across meshes and keeps float32 precision. The plane is
 *   picked per terrain facet (the facet's normal is constant over it), so the
 *   projection changes only along facet edges, which are shading edges anyway,
 *   and stretches cells by at most √3 on the steepest faces. The matrices turn
 *   the octaves against each other so their lattices do not line up into a grid.
 * - **No slivers.** The first version cut a 3D lattice of tetrahedra with the
 *   ground (decision 171); a plane cuts a tetrahedron into arbitrarily thin
 *   slivers, which aliased into moiré where an octave faded (decision 178).
 *   Every cell of the 2D lattice is a whole triangle of the octave's size.
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
  abs,
  dot,
  float,
  floor,
  If,
  ivec3,
  max,
  mix,
  normalize,
  select,
  smoothstep,
  step,
  uint,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { cellHashNode, hashBitsNode } from '../../common/canopyNode';
import { WAVE_PERIOD } from '../water/waterShading';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
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
  /** Integer rows (2 × 2): any integer matrix keeps the field periodic with the wave period. */
  matrix: readonly [readonly [number, number], readonly [number, number]];
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
      [1, 0],
      [0, 1],
    ],
    size: 4,
    slope: [0.12, 0.12, 0.5],
    shade: [0.05, 0.05, 0.1, 0.03],
  },
  {
    // Turned 45°: cells 4096/2400/√2 = 1.21 m.
    cells: 2400,
    matrix: [
      [1, 1],
      [-1, 1],
    ],
    size: 1.2,
    slope: [0.35, 0.25, 0.3],
    shade: [0.07, 0.05, 0.06, 0],
  },
  {
    // Turned and sheared (det 3): cells of 0.34–0.54 m.
    cells: 5400,
    matrix: [
      [2, 1],
      [-1, 1],
    ],
    size: 0.45,
    slope: [0.14, 0.6, 0.08],
    shade: [0.04, 0.1, 0.03, 0],
  },
];

/** Octaves fade in between these many pixels per cell: finer cells would speckle. */
const VISIBLE_PIXELS = [4, 9] as const;

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
 * One octave at `uv`, the wrapped position on the facet's plane (`a`, `b` the
 * world axes it spans; `plane` names it for the hash): the gradient of the
 * piecewise-linear field in space (per unit of `slope`) and its value at the
 * triangle's centroid (in [-0.5, 0.5]), both constant over the triangle.
 */
function octave(uv: V2, a: V3, b: V3, plane: F, o: Octave, seed: U): { grad: V3; value: F } {
  const period = o.cells;
  const p = uv.mul(o.cells / WAVE_PERIOD);
  const [r0, r1] = o.matrix;
  const q = vec2(dot(p, vec2(r0[0], r0[1])), dot(p, vec2(r1[0], r1[1])));
  const i0 = floor(q).toVar();
  const f = q.sub(i0).toVar();
  const at = (c: V2): F => {
    // Wrap the lattice so the field repeats with the wave period.
    const w = c.sub(floor(c.div(period)).mul(period));
    return hashBitsNode(cellHashNode(ivec3(vec3(w, plane)), seed), 3);
  };
  const h00 = at(i0 as V2);
  const h11 = at(i0.add(vec2(1, 1)) as V2);
  // Below the diagonal: (0,0), (1,0), (1,1); above it: (0,0), (1,1), (0,1).
  const below = step(f.y, f.x);
  const hc = at(i0.add(vec2(below, float(1).sub(below))) as V2);
  const gx = mix(h11.sub(hc), hc.sub(h00), below);
  const gy = mix(hc.sub(h00), h11.sub(hc), below);
  // Back to space: the matrix's transpose, scaled by the lattice's cells per meter over the
  // cells' size, so `slope` holds; then onto the plane's axes.
  const scale = (o.cells / WAVE_PERIOD) * o.size;
  const g2 = vec2(r0[0], r0[1]).mul(gx).add(vec2(r1[0], r1[1]).mul(gy)).mul(scale);
  const grad = a.mul(g2.x).add(b.mul(g2.y));
  const value = h00.add(h11).add(hc).div(3).sub(0.5);
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
        // The plane across the world axis nearest the facet's normal (constant per facet).
        const an = abs(i.normal);
        const isX = an.x.greaterThan(max(an.y, an.z));
        const isY = an.y.greaterThan(an.z);
        const uv = select(isX, i.wrapped.yz, select(isY, i.wrapped.xz, i.wrapped.xy)) as V2;
        const axisA = select(isX, vec3(0, 1, 0), vec3(1, 0, 0)) as V3;
        const axisB = select(isX.or(isY), vec3(0, 0, 1), vec3(0, 1, 0)) as V3;
        const plane = select(isX, float(0), select(isY, float(1), float(2))) as F;
        const g = vec3(0).toVar();
        const s = float(0).toVar();
        const seen = float(0).toVar();
        MICRO_OCTAVES.forEach((o, k) => {
          const vis = smoothstep(
            VISIBLE_PIXELS[0],
            VISIBLE_PIXELS[1],
            float(o.size).div(max(i.footprint, 1e-4)),
          ).mul(near);
          const { grad, value } = octave(
            uv,
            axisA,
            axisB,
            plane,
            o,
            seed.bitXor(uint(0x9e37 * (k + 1))) as U,
          );
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
