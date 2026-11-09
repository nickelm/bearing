/**
 * The milestone-1 globe: one vertex lattice per cube face, matched to the
 * worldgen CubeGrid. Lattice vertex (i, j) sits on the shared corner of up
 * to four grid cells (three at a cube corner).
 *
 * Seam-free by construction: each vertex's height, normal and color are
 * averaged from its corner cells, taken in sorted cell order. Duplicated
 * vertices on face edges therefore get bit-identical values on both faces.
 *
 * The ocean is drawn flat at sea level and colored by depth or biome.
 * Heights are exaggerated for visibility, since relief scaled to the planet
 * (decision 14) is about 0.1% of the radius. This is a CPU mesh; GPU tiles
 * and LOD replace it in milestone 2.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import type { CubeGrid } from '../core/cubeGrid';
import type { WorldSeed } from '../core/rng';
import type { World } from '../worldgen/pipeline';
import { buildCornerCells, buildCubeSphereArrays } from './cubeSphereGeometry';
import {
  BIOME_COLORS,
  BOUNDARY_COLORS,
  HEIGHT_RAMP,
  MOISTURE_RAMP,
  TEMPERATURE_RAMP,
  UPLIFT_RAMP,
  faceColors,
  plateColor,
  ramp,
  srgbToLinear,
} from './palette';
import type { Rgb } from './palette';

export const VIEW_MODES = [
  'biome',
  'height',
  'plates',
  'boundaries',
  'crust',
  'uplift',
  'temperature',
  'moisture',
  'faces',
] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

const LAND_GRAY: Rgb = [0.55, 0.55, 0.52];
const OCEAN_GRAY: Rgb = [0.18, 0.22, 0.28];
const CONTINENTAL: Rgb = [0.72, 0.6, 0.42];
const OCEANIC: Rgb = [0.15, 0.3, 0.5];

export class GlobeMesh {
  readonly group = new Group();
  private grid!: CubeGrid;
  private world: World | null = null;
  private mode: ViewMode = 'biome';
  private exaggeration = 10;
  private faceSeed: WorldSeed = 0;

  private geometry!: BufferGeometry;
  private dirs!: Float32Array; // unit direction per vertex
  private vertexFace!: Uint8Array;
  /** Up to 4 corner cells per vertex, sorted ascending, −1 padded. */
  private corners!: Int32Array;
  private cellNormals!: Float32Array;

  private readonly solidMaterial = new MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly wireMaterial = new MeshBasicNodeMaterial({
    color: 0x000000,
    wireframe: true,
    transparent: true,
    opacity: 0.25,
  });
  private readonly solid: Mesh;
  private readonly wire: Mesh;

  constructor(
    grid: CubeGrid,
    private readonly radius: number,
  ) {
    this.solid = new Mesh(undefined, this.solidMaterial);
    this.wire = new Mesh(undefined, this.wireMaterial);
    this.solid.frustumCulled = false;
    this.wire.frustumCulled = false;
    this.wire.visible = false;
    this.group.add(this.solid, this.wire);
    this.setGrid(grid);
  }

  get resolution(): number {
    return this.grid.n;
  }

  set wireframe(on: boolean) {
    this.wire.visible = on;
  }

  get wireframe(): boolean {
    return this.wire.visible;
  }

  /** Highest displayed point above the reference sphere (m), including exaggeration. */
  get maxDisplayedHeight(): number {
    return this.world ? Math.max(0, this.world.info.maxHeight) * this.exaggeration : 0;
  }

  /** Rebuilds the lattice for a grid of another resolution. Clears the world if it does not match. */
  setGrid(grid: CubeGrid): void {
    if (this.grid === grid) return;
    this.grid = grid;
    if (this.world && this.world.info.resolution !== grid.n) this.world = null;
    const n = grid.n;
    const lattice = buildCubeSphereArrays(n, 1);
    this.dirs = lattice.normals;
    this.vertexFace = lattice.faces;
    const vertexCount = this.dirs.length / 3;
    this.corners = buildCornerCells(grid);

    const old = this.geometry;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
    g.setIndex(new BufferAttribute(lattice.indices, 1));
    this.geometry = g;
    this.solid.geometry = g;
    this.wire.geometry = g;
    old?.dispose();
    this.cellNormals = new Float32Array(grid.cellCount * 3);
    this.rebuildShape();
    this.rebuildColors();
  }

  /** Shows a generated world. Its resolution must match the current grid. */
  setWorld(world: World | null): void {
    if (world && world.info.resolution !== this.grid.n) {
      throw new Error(`World resolution ${world.info.resolution} != grid ${this.grid.n}`);
    }
    this.world = world;
    this.rebuildShape();
    this.rebuildColors();
  }

  setViewMode(mode: ViewMode): void {
    this.mode = mode;
    this.rebuildColors();
  }

  setExaggeration(x: number): void {
    this.exaggeration = x;
    this.rebuildShape();
  }

  /** Seed for the 'faces' debug colors. */
  setFaceSeed(seed: WorldSeed): void {
    this.faceSeed = seed;
    if (this.mode === 'faces' || !this.world) this.rebuildColors();
  }

  dispose(): void {
    this.geometry.dispose();
    this.solidMaterial.dispose();
    this.wireMaterial.dispose();
  }

  /** Displayed height per cell: land exaggerated, ocean flat at sea level. */
  private cellDisplayHeight(c: number): number {
    if (!this.world) return 0;
    return Math.max(0, this.world.maps.height[c]) * this.exaggeration;
  }

  private rebuildShape(): void {
    const grid = this.grid;
    const R = this.radius;
    const centers = grid.centers;
    const cn = this.cellNormals;

    // Cell normals from the displaced cell-center surface (central differences).
    for (let c = 0; c < grid.cellCount; c++) {
      const cx = centers[c * 3];
      const cy = centers[c * 3 + 1];
      const cz = centers[c * 3 + 2];
      if (!this.world || this.cellDisplayHeight(c) <= 0) {
        // Flat ocean and the bare sphere: radial normal. Land next to the coast still slopes.
        let flat = true;
        if (this.world) {
          for (let k = 0; k < 4; k++) {
            if (this.cellDisplayHeight(grid.neighbors4[c * 4 + k]) > 0) flat = false;
          }
        }
        if (flat) {
          cn[c * 3] = cx;
          cn[c * 3 + 1] = cy;
          cn[c * 3 + 2] = cz;
          continue;
        }
      }
      const pu = grid.neighbors4[c * 4];
      const mu = grid.neighbors4[c * 4 + 1];
      const pv = grid.neighbors4[c * 4 + 2];
      const mv = grid.neighbors4[c * 4 + 3];
      const ru = R + this.cellDisplayHeight(pu);
      const rmu = R + this.cellDisplayHeight(mu);
      const rv = R + this.cellDisplayHeight(pv);
      const rmv = R + this.cellDisplayHeight(mv);
      const ax = centers[pu * 3] * ru - centers[mu * 3] * rmu;
      const ay = centers[pu * 3 + 1] * ru - centers[mu * 3 + 1] * rmu;
      const az = centers[pu * 3 + 2] * ru - centers[mu * 3 + 2] * rmu;
      const bx = centers[pv * 3] * rv - centers[mv * 3] * rmv;
      const by = centers[pv * 3 + 1] * rv - centers[mv * 3 + 1] * rmv;
      const bz = centers[pv * 3 + 2] * rv - centers[mv * 3 + 2] * rmv;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      // Guard against inverted frames: the normal must point outward.
      if (nx * cx + ny * cy + nz * cz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      cn[c * 3] = nx;
      cn[c * 3 + 1] = ny;
      cn[c * 3 + 2] = nz;
    }

    const pos = this.geometry.getAttribute('position') as BufferAttribute;
    const nor = this.geometry.getAttribute('normal') as BufferAttribute;
    const P = pos.array as Float32Array;
    const N = nor.array as Float32Array;
    const dirs = this.dirs;
    const corners = this.corners;
    const vertexCount = dirs.length / 3;
    for (let v = 0; v < vertexCount; v++) {
      let h = 0;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      let k = 0;
      for (; k < 4; k++) {
        const c = corners[v * 4 + k];
        if (c < 0) break;
        h += this.cellDisplayHeight(c);
        nx += cn[c * 3];
        ny += cn[c * 3 + 1];
        nz += cn[c * 3 + 2];
      }
      const r = R + h / k;
      P[v * 3] = dirs[v * 3] * r;
      P[v * 3 + 1] = dirs[v * 3 + 1] * r;
      P[v * 3 + 2] = dirs[v * 3 + 2] * r;
      const len = Math.hypot(nx, ny, nz) || 1;
      N[v * 3] = nx / len;
      N[v * 3 + 1] = ny / len;
      N[v * 3 + 2] = nz / len;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  private cellColor(c: number, faces: Rgb[]): Rgb {
    const w = this.world;
    if (!w || this.mode === 'faces') return faces[this.grid.faceOf(c)]!;
    const m = w.maps;
    const land = m.height[c] > 0;
    switch (this.mode) {
      case 'biome':
        return BIOME_COLORS[m.biome[c]]!;
      case 'height': {
        const ref = m.height[c] / this.reliefScale();
        return ramp(HEIGHT_RAMP, ref);
      }
      case 'plates': {
        const p = plateColor(m.plate[c]);
        return land ? p : [p[0] * 0.55, p[1] * 0.55, p[2] * 0.65];
      }
      case 'boundaries': {
        const t = m.boundary[c];
        if (t !== 0) return BOUNDARY_COLORS[t]!;
        return land ? LAND_GRAY : OCEAN_GRAY;
      }
      case 'crust':
        return m.continentalness[c] > 0 ? CONTINENTAL : OCEANIC;
      case 'uplift':
        return ramp(UPLIFT_RAMP, m.uplift[c]);
      case 'temperature':
        return ramp(TEMPERATURE_RAMP, m.temperature[c]);
      case 'moisture':
        return land ? ramp(MOISTURE_RAMP, m.moisture[c]) : OCEAN_GRAY;
    }
  }

  /** reliefScale recovered from the world (height / reference), for reference-elevation ramps. */
  private reliefScale(): number {
    const w = this.world;
    if (!w || w.info.maxHeight <= 0) return 1;
    return w.info.reliefScale;
  }

  private rebuildColors(): void {
    const grid = this.grid;
    const faces = faceColors(this.faceSeed);
    const cellLinear = new Float32Array(grid.cellCount * 3);
    for (let c = 0; c < grid.cellCount; c++) {
      const rgb = this.cellColor(c, faces);
      cellLinear[c * 3] = srgbToLinear(rgb[0]);
      cellLinear[c * 3 + 1] = srgbToLinear(rgb[1]);
      cellLinear[c * 3 + 2] = srgbToLinear(rgb[2]);
    }
    const col = this.geometry.getAttribute('color') as BufferAttribute;
    const C = col.array as Float32Array;
    const corners = this.corners;
    const vertexCount = this.dirs.length / 3;
    const facesMode = this.mode === 'faces' || !this.world;
    for (let v = 0; v < vertexCount; v++) {
      if (facesMode) {
        // Hard face colors make the cube topology visible; don't blend across seams.
        const rgb = faces[this.vertexFace[v]]!;
        C[v * 3] = srgbToLinear(rgb[0]);
        C[v * 3 + 1] = srgbToLinear(rgb[1]);
        C[v * 3 + 2] = srgbToLinear(rgb[2]);
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let k = 0;
      for (; k < 4; k++) {
        const c = corners[v * 4 + k];
        if (c < 0) break;
        r += cellLinear[c * 3];
        g += cellLinear[c * 3 + 1];
        b += cellLinear[c * 3 + 2];
      }
      C[v * 3] = r / k;
      C[v * 3 + 1] = g / k;
      C[v * 3 + 2] = b / k;
    }
    col.needsUpdate = true;
  }
}
