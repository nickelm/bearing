/**
 * Campaign aircraft near the camera that nobody follows (roadmap R2.4): one
 * instanced mesh per drawn model, scheme and gear state, lit like the flown
 * aircraft's view (AircraftView) but static, without ink, shadow or moving parts.
 * The followed flight and the aircraft nearest the camera keep their full views
 * (follow/campaignTraffic.ts); this is the level of detail for everything else in
 * the 0–20 km envelope.
 *
 * Instances are placed camera-relative (rule 4): the float64 position less the eye
 * is written into each instance matrix.
 */
import {
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { BufferGeometry } from 'three/webgpu';
import { attribute, normalWorld, positionWorld } from 'three/tsl';
import type { Vec3d } from '../../../core/vec3d';
import { buildModel } from '../../common/models/builder';
import { modelGeometry } from '../../common/models/threeModel';
import type { ModelSpec } from '../../common/models/spec';
import type { PlanetLighting } from '../lighting/planetLighting';

type V3 = Parameters<PlanetLighting['shadeDiffuse']>[0];

/** One aircraft to draw: its model and its pose (world, float64; unit axes). */
export interface TrafficAircraft {
  spec: ModelSpec;
  scheme: string | null;
  gearDown: boolean;
  pos: readonly [number, number, number];
  forward: readonly [number, number, number];
  up: readonly [number, number, number];
}

interface Batch {
  mesh: InstancedMesh;
  geometry: BufferGeometry;
  capacity: number;
  used: number;
}

/** Model frame (+x nose, +y up, +z right) → body axes (x nose, y right, z down): −90° about x. */
const MODEL_TO_BODY = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

/** A spec without its gear: the parts the gear channel moves are left out in flight. */
function withoutGear(spec: ModelSpec): ModelSpec {
  return { ...spec, parts: spec.parts.filter((p) => p.anim?.channel !== 'gear') };
}

export class TrafficLayer {
  readonly group = new Group();
  private readonly material: MeshBasicNodeMaterial;
  private readonly batches = new Map<string, Batch>();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly basis = new Matrix4();
  private readonly v = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  /** Aircraft drawn last frame and draw calls. */
  readonly stats = { aircraft: 0, draws: 0 };

  constructor(lighting: PlanetLighting) {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const albedo = attribute('color', 'vec3').mul(attribute('ao', 'float')) as V3;
    m.colorNode = lighting.shadeDiffuse(albedo, normalWorld as V3, positionWorld as V3);
    this.material = m;
  }

  /** Draws `list` for the frame about to be rendered from `eye`. */
  update(list: readonly TrafficAircraft[], eye: Readonly<Vec3d>): void {
    for (const b of this.batches.values()) b.used = 0;
    for (const a of list) {
      const b = this.batch(a, list);
      const f = a.forward;
      const u = a.up;
      // Body axes in the world: x nose, y right (nose × up), z down.
      const r: [number, number, number] = [
        f[1] * u[2] - f[2] * u[1],
        f[2] * u[0] - f[0] * u[2],
        f[0] * u[1] - f[1] * u[0],
      ];
      this.basis.set(f[0], r[0], -u[0], 0, f[1], r[1], -u[1], 0, f[2], r[2], -u[2], 0, 0, 0, 0, 1);
      this.q.setFromRotationMatrix(this.basis).multiply(MODEL_TO_BODY);
      this.v.set(a.pos[0] - eye.x, a.pos[1] - eye.y, a.pos[2] - eye.z);
      this.m.compose(this.v, this.q, this.one);
      b.mesh.setMatrixAt(b.used++, this.m);
    }
    let aircraft = 0;
    let draws = 0;
    for (const b of this.batches.values()) {
      b.mesh.count = b.used;
      b.mesh.visible = b.used > 0;
      if (b.used > 0) {
        b.mesh.instanceMatrix.needsUpdate = true;
        aircraft += b.used;
        draws++;
      }
    }
    this.stats.aircraft = aircraft;
    this.stats.draws = draws;
  }

  /** The batch of `a`'s model, grown to hold every aircraft of the list that shares it. */
  private batch(a: TrafficAircraft, list: readonly TrafficAircraft[]): Batch {
    const key = `${a.spec.id}:${a.scheme ?? ''}:${a.gearDown ? 'down' : 'up'}`;
    let b = this.batches.get(key);
    if (b && b.used < b.capacity) return b;
    const need = list.filter(
      (x) => x.spec.id === a.spec.id && x.scheme === a.scheme && x.gearDown === a.gearDown,
    ).length;
    const capacity = Math.max(8, 1 << Math.ceil(Math.log2(Math.max(need, (b?.capacity ?? 4) * 2))));
    const geometry =
      b?.geometry ??
      modelGeometry(
        buildModel(a.gearDown ? a.spec : withoutGear(a.spec), { scheme: a.scheme ?? undefined }),
      );
    const mesh = new InstancedMesh(geometry, this.material, capacity);
    // Instances spread over kilometers around the camera; the batch is never culled whole.
    mesh.frustumCulled = false;
    if (b) {
      for (let i = 0; i < b.used; i++) {
        b.mesh.getMatrixAt(i, this.m);
        mesh.setMatrixAt(i, this.m);
      }
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    const used = b?.used ?? 0;
    b = { mesh, geometry, capacity, used };
    this.batches.set(key, b);
    this.group.add(mesh);
    return b;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      b.mesh.dispose();
      b.geometry.dispose();
    }
    this.batches.clear();
    this.material.dispose();
  }
}
