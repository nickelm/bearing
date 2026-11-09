/**
 * Debug cube-sphere mesh: six subdivided cube faces projected onto the sphere,
 * colored by face so the topology is visible, with an optional wireframe overlay.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import { CUBE_FACE_COUNT } from '../core/coords';
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { buildCubeSphereArrays } from './cubeSphereGeometry';
import type { CubeSphereArrays } from './cubeSphereGeometry';

/** Six well-separated hues, rotated and shuffled by the seed. Returned as linear RGB. */
export function debugFaceColors(seed: WorldSeed): Color[] {
  const r = rng(seed, 'debug-face-colors');
  const offset = r.nextFloat();
  const hues = Array.from(
    { length: CUBE_FACE_COUNT },
    (_, i) => (offset + i / CUBE_FACE_COUNT) % 1,
  );
  for (let i = hues.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [hues[i], hues[j]] = [hues[j]!, hues[i]!];
  }
  return hues.map((h) => new Color().setHSL(h, r.range(0.55, 0.75), r.range(0.45, 0.6)));
}

export class CubeSphereMesh {
  readonly group = new Group();
  private geometry: BufferGeometry;
  private arrays: CubeSphereArrays;
  private readonly solidMaterial: MeshStandardNodeMaterial;
  private readonly wireMaterial: MeshBasicNodeMaterial;
  private readonly solid: Mesh;
  private readonly wire: Mesh;

  constructor(
    private readonly radius: number,
    subdivisions: number,
    seed: WorldSeed,
  ) {
    this.solidMaterial = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
      // Push the solid surface back slightly so the wireframe does not z-fight with it.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.wireMaterial = new MeshBasicNodeMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
    });
    this.arrays = buildCubeSphereArrays(subdivisions, radius);
    this.geometry = this.createGeometry(this.arrays);
    this.solid = new Mesh(this.geometry, this.solidMaterial);
    this.wire = new Mesh(this.geometry, this.wireMaterial);
    // The planet is always on screen and its bounding sphere is huge; skip culling.
    this.solid.frustumCulled = false;
    this.wire.frustumCulled = false;
    this.group.add(this.solid, this.wire);
    this.recolor(seed);
  }

  set wireframe(on: boolean) {
    this.wire.visible = on;
  }

  get wireframe(): boolean {
    return this.wire.visible;
  }

  /** Rebuilds the geometry at a new subdivision level. */
  setSubdivisions(subdivisions: number, seed: WorldSeed): void {
    const old = this.geometry;
    this.arrays = buildCubeSphereArrays(subdivisions, this.radius);
    this.geometry = this.createGeometry(this.arrays);
    this.solid.geometry = this.geometry;
    this.wire.geometry = this.geometry;
    old.dispose();
    this.recolor(seed);
  }

  /** Recolors the faces from the seed. This stands in for "regenerate" until worldgen exists. */
  recolor(seed: WorldSeed): void {
    const colors = debugFaceColors(seed);
    const attr = this.geometry.getAttribute('color') as BufferAttribute;
    const faces = this.arrays.faces;
    for (let i = 0; i < faces.length; i++) {
      const c = colors[faces[i]!]!;
      attr.setXYZ(i, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.solidMaterial.dispose();
    this.wireMaterial.dispose();
  }

  private createGeometry(a: CubeSphereArrays): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(a.positions, 3));
    g.setAttribute('normal', new BufferAttribute(a.normals, 3));
    g.setAttribute('uv', new BufferAttribute(a.uvs, 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(a.faces.length * 3), 3));
    g.setIndex(new BufferAttribute(a.indices, 1));
    return g;
  }
}
