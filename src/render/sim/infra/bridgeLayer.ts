/**
 * Bridges and viaducts near the camera (decision 192): the alignment tier's
 * structures (`bridgeRecords`), assembled from the bridge kit (`bridgeKit.ts`)
 * when they come within `range`, one merged mesh each, lit like the buildings.
 * Hidden above `maxAltitude` and while the terrain is exaggerated (structures
 * keep their true heights).
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  Fn,
  modelWorldMatrix,
  normalize,
  positionWorld,
  varyingProperty,
  vec4,
} from 'three/tsl';
import { placeCameraRelative } from '../../common/cameraRelative';
import { Vec3d } from '../../../core/vec3d';
import type { Alignments, NetworkBridges } from '../../../worldgen/networks/alignments';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import { assembleBridge } from './bridgeKit';
import { bridgeRecords } from './bridgeRecords';
import type { BridgeRecord } from './bridgeRecords';

type V3 = Node<'vec3'>;

interface Built {
  mesh: Mesh;
  origin: Vec3d;
  lastUsed: number;
}

export class BridgeLayer {
  readonly group = new Group();
  enabled = true;
  /** Structures within this distance of the camera are drawn (m). */
  range = 12_000;
  maxAltitude = 15_000;
  /** Structures built per frame at most. */
  buildPerFrame = 4;
  readonly stats = { records: 0, drawn: 0, triangles: 0 };
  private records: BridgeRecord[] = [];
  private radius = 1;
  private readonly built = new Map<number, Built>();
  private readonly material: MeshBasicNodeMaterial;
  private frame = 0;
  private near: number[] = [];

  constructor(
    private readonly terrain: TerrainRenderer,
    lighting: PlanetLighting,
  ) {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const apIn = varyingProperty('vec3', 'vBridgeInscatter');
    const apTr = varyingProperty('vec3', 'vBridgeTransmittance');
    const local = attribute('position', 'vec3');
    m.positionNode = Fn(() => {
      const ap = lighting.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(local, 1)).xyz as V3,
        6,
      );
      apIn.assign(ap.inscatter);
      apTr.assign(ap.transmittance);
      return local;
    })();
    const normal = normalize(attribute('normal', 'vec3')) as V3;
    const albedo = attribute('color', 'vec3').mul(attribute('ao', 'float')) as V3;
    m.colorNode = lighting.applyAerial(
      lighting.shadeDiffuse(albedo, normal, positionWorld as V3),
      apIn as V3,
      apTr as V3,
    );
    this.material = m;
  }

  /** The world's structures; null clears them. */
  setAlignments(al: Alignments | null, nb: NetworkBridges | null = null): void {
    this.clear();
    this.records = al ? bridgeRecords(al, nb) : [];
    this.radius = al?.radius ?? 1;
    this.stats.records = this.records.length;
  }

  update(eye: Readonly<Vec3d>, heightAboveGround: number): void {
    this.frame++;
    const show =
      this.enabled &&
      this.records.length > 0 &&
      heightAboveGround < this.maxAltitude &&
      this.terrain.exaggerationUniform.value === 1;
    this.group.visible = show;
    if (!show) return;
    const R = this.radius;
    const radial = eye.clone().normalize();
    // Which structures are near: refreshed every 30 frames (the camera moves little meanwhile).
    if (this.frame % 30 === 1 || this.near.length === 0) {
      const cos = Math.cos((this.range + 2000) / R);
      this.near = [];
      this.records.forEach((r, i) => {
        if (r.center.dot(radial) >= Math.cos(Math.acos(cos) + r.length / 2 / R)) this.near.push(i);
      });
    }
    let built = 0;
    let drawn = 0;
    let tris = 0;
    for (const i of this.near) {
      let b = this.built.get(i);
      if (!b) {
        if (built >= this.buildPerFrame) continue;
        built++;
        b = this.build(this.records[i]!);
        this.built.set(i, b);
      }
      b.lastUsed = this.frame;
      placeCameraRelative(b.mesh, b.origin, eye);
      b.mesh.visible = true;
      drawn++;
      tris += (b.mesh.geometry.getAttribute('position').count / 3) | 0;
    }
    for (const [i, b] of this.built) {
      if (b.lastUsed === this.frame) continue;
      b.mesh.visible = false;
      if (this.frame - b.lastUsed > 300) {
        this.group.remove(b.mesh);
        b.mesh.geometry.dispose();
        this.built.delete(i);
      }
    }
    this.stats.drawn = drawn;
    this.stats.triangles = tris;
  }

  private build(r: BridgeRecord): Built {
    const g = assembleBridge(r.line, this.radius);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(g.position, 3));
    geo.setAttribute('normal', new BufferAttribute(g.normal, 3));
    geo.setAttribute('color', new BufferAttribute(g.color, 3));
    geo.setAttribute('ao', new BufferAttribute(g.ao, 1));
    const mesh = new Mesh(geo, this.material);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return { mesh, origin: g.origin, lastUsed: this.frame };
  }

  clear(): void {
    for (const b of this.built.values()) {
      this.group.remove(b.mesh);
      b.mesh.geometry.dispose();
    }
    this.built.clear();
    this.near = [];
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
