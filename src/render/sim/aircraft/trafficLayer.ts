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
  BackSide,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { attribute, normalWorld, positionLocal, positionWorld, vec3 } from 'three/tsl';
import type { Vec3d } from '../../../core/vec3d';
import { buildModel } from '../../common/models/builder';
import { INK_LINEAR, modelGeometry } from '../../common/models/threeModel';
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
  /** Drawn size over the model's (default 1): promoted vehicles' exaggeration (decision 336). */
  scale?: number;
}

interface Batch {
  mesh: InstancedMesh;
  geometry: BufferGeometry;
  capacity: number;
  used: number;
  /** The ink hull (decision 107) and its per-instance push (model units), when the layer draws ink. */
  ink: InstancedMesh | null;
  inkOff: InstancedBufferAttribute | null;
  /** A dark contact shadow under the model's footprint, when the layer draws them. */
  shadow: InstancedMesh | null;
  shadowGeometry: BufferGeometry | null;
}

/** What a layer draws besides the lit models (decision 340): ink outlines and contact shadows. */
export interface TrafficLayerOptions {
  ink?: boolean;
  contactShadows?: boolean;
}

/** The contact shadow's color (Part I: deep blue-gray, never black) and opacity. */
const SHADOW_LINEAR: [number, number, number] = [0.03, 0.04, 0.06];
const SHADOW_OPACITY = 0.6;

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
  private readonly scaled = new Vector3(1, 1, 1);
  /** Aircraft drawn last frame and draw calls. */
  readonly stats = { aircraft: 0, draws: 0 };

  private readonly inkMaterial: MeshBasicNodeMaterial | null;
  private readonly shadowMaterial: MeshBasicNodeMaterial | null;
  /** Ink width (px) and radians per pixel at the viewport (set by the owner each frame). */
  inkWidth = 1.6;
  radPerPixel = 0.0015;

  constructor(lighting: PlanetLighting, options: TrafficLayerOptions = {}) {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const albedo = attribute('color', 'vec3').mul(attribute('ao', 'float')) as V3;
    m.colorNode = lighting.shadeDiffuse(albedo, normalWorld as V3, positionWorld as V3);
    this.material = m;
    if (options.ink) {
      // Inverted hull: back faces pushed out along the outline normals by a per-instance
      // amount, so the line keeps its width in pixels at every distance and scale.
      const ink = new MeshBasicNodeMaterial({ side: BackSide });
      ink.positionNode = positionLocal.add(
        attribute('outlineNormal', 'vec3').mul(attribute('inkOff', 'float')),
      );
      ink.colorNode = vec3(...INK_LINEAR);
      this.inkMaterial = ink;
    } else this.inkMaterial = null;
    if (options.contactShadows) {
      const sh = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      sh.colorNode = vec3(...SHADOW_LINEAR);
      sh.opacity = SHADOW_OPACITY;
      sh.polygonOffset = true;
      sh.polygonOffsetFactor = -2;
      sh.polygonOffsetUnits = -2;
      this.shadowMaterial = sh;
    } else this.shadowMaterial = null;
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
      const k = a.scale ?? 1;
      this.m.compose(this.v, this.q, k === 1 ? this.one : this.scaled.set(k, k, k));
      const i = b.used++;
      b.mesh.setMatrixAt(i, this.m);
      b.ink?.setMatrixAt(i, this.m);
      b.shadow?.setMatrixAt(i, this.m);
      if (b.inkOff) b.inkOff.setX(i, (this.v.length() * this.radPerPixel * this.inkWidth) / k);
    }
    let aircraft = 0;
    let draws = 0;
    for (const b of this.batches.values()) {
      for (const x of [b.mesh, b.ink, b.shadow]) {
        if (!x) continue;
        x.count = b.used;
        x.visible = b.used > 0;
        if (b.used > 0) x.instanceMatrix.needsUpdate = true;
      }
      if (b.inkOff && b.used > 0) b.inkOff.needsUpdate = true;
      if (b.used > 0) {
        aircraft += b.used;
        draws += 1 + (b.ink ? 1 : 0) + (b.shadow ? 1 : 0);
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
    let ink: InstancedMesh | null = null;
    let inkOff: InstancedBufferAttribute | null = null;
    if (this.inkMaterial) {
      inkOff = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      geometry.setAttribute('inkOff', inkOff);
      ink = new InstancedMesh(geometry, this.inkMaterial, capacity);
      ink.frustumCulled = false;
    }
    let shadow: InstancedMesh | null = null;
    const shadowGeometry = this.shadowMaterial ? (b?.shadowGeometry ?? footprint(geometry)) : null;
    if (shadowGeometry && this.shadowMaterial) {
      shadow = new InstancedMesh(shadowGeometry, this.shadowMaterial, capacity);
      shadow.frustumCulled = false;
      shadow.renderOrder = -1;
    }
    if (b) {
      for (let i = 0; i < b.used; i++) {
        b.mesh.getMatrixAt(i, this.m);
        mesh.setMatrixAt(i, this.m);
        ink?.setMatrixAt(i, this.m);
        shadow?.setMatrixAt(i, this.m);
        if (inkOff && b.inkOff) inkOff.setX(i, b.inkOff.getX(i));
      }
      for (const x of [b.mesh, b.ink, b.shadow]) {
        if (!x) continue;
        this.group.remove(x);
        x.dispose();
      }
    }
    const used = b?.used ?? 0;
    b = { mesh, geometry, capacity, used, ink, inkOff, shadow, shadowGeometry };
    if (shadow) this.group.add(shadow);
    if (ink) this.group.add(ink);
    this.batches.set(key, b);
    this.group.add(mesh);
    return b;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      b.mesh.dispose();
      b.ink?.dispose();
      b.shadow?.dispose();
      b.geometry.dispose();
      b.shadowGeometry?.dispose();
    }
    this.batches.clear();
    this.material.dispose();
    this.inkMaterial?.dispose();
    this.shadowMaterial?.dispose();
  }
}

/**
 * A model's contact shadow (decision 340): a flat octagon on its ground plane (y = 0.05 in
 * the model frame) over its footprint, a tenth larger, with cut corners so it reads as a
 * soft blot rather than a box.
 */
function footprint(g: BufferGeometry): BufferGeometry {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const hx = ((bb.max.x - bb.min.x) / 2) * 1.1;
  const hz = ((bb.max.z - bb.min.z) / 2) * 1.15;
  const c = 0.3;
  const ring: [number, number][] = [
    [hx, hz * (1 - c)],
    [hx * (1 - c), hz],
    [-hx * (1 - c), hz],
    [-hx, hz * (1 - c)],
    [-hx, -hz * (1 - c)],
    [-hx * (1 - c), -hz],
    [hx * (1 - c), -hz],
    [hx, -hz * (1 - c)],
  ];
  const pos: number[] = [];
  const y = 0.05;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    // Counterclockwise seen from above (+y).
    pos.push(cx, y, cz, cx + b[0], y, cz + b[1], cx + a[0], y, cz + a[1]);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return out;
}
