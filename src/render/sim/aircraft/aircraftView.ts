/**
 * The flown aircraft in the simulation view (Free Flight, decision 134;
 * visual-style Part I, The Controlled Aircraft): the model built from its spec
 * with hinge-animated parts (stabilators, flaperons, rudder, speedbrakes, gear)
 * driven by the flight model, the afterburner flame, an ink outline (decision
 * 107) and a shadow on the ground, all placed camera-relative (rule 4).
 *
 * Orientation: the flight model's quaternion turns body axes (x forward, y
 * right, z down) into the world; the model frame is x forward, y up, z right,
 * so the mesh turns by q ⊗ (−90° about x) about the CG.
 */
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import {
  attribute,
  float,
  normalWorld,
  positionLocal,
  positionWorld,
  uniform,
  vec3,
} from 'three/tsl';
import type { Quatd } from '../../../core/quat';
import { Vec3d } from '../../../core/vec3d';
import { buildAnimatedModel } from '../../common/models/builder';
import type { AnimatedPiece, BuiltModel } from '../../common/models/builder';
import type { ModelSpec } from '../../common/models/spec';
import { INK_LINEAR, modelGeometry } from '../../common/models/threeModel';
import type { PlanetLighting, Vec3Node } from '../lighting/planetLighting';

type V3 = ReturnType<typeof vec3>;

/** What the view reads from the flight model each frame. */
export interface AircraftPose {
  /** CG position (world, m) and body-to-world rotation. */
  pos: Readonly<Vec3d>;
  q: Readonly<Quatd>;
  /** Deflections −1..1 from the control laws. */
  elevator: number;
  aileron: number;
  rudder: number;
  /** Gear 0 (up)..1 (down), speedbrake 0..1, afterburner 0..1, flaps 0..1. */
  gear: number;
  speedbrake: number;
  afterburner: number;
  flaps: number;
  /** Ground height under the aircraft (m above sea level), for the shadow. */
  groundHeight: number;
}

/** Model frame → body axes: −90° about x. */
const MODEL_TO_BODY = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

interface PieceMesh {
  piece: AnimatedPiece;
  pivot: Group;
}

export class AircraftView {
  readonly group = new Group();
  /** Ink outline width (px) and radians per pixel at the viewport (set by the app). */
  inkWidth = 1.6;
  radPerPixel = 0.001;
  /** Sun direction (world unit vector), for the shadow. */
  readonly sun = new Vec3d(0, 1, 0);
  private readonly model = new Group();
  private readonly pieces: PieceMesh[] = [];
  private readonly flame: Mesh;
  private readonly flameMaterial: MeshBasicNodeMaterial;
  private readonly inkOffset = uniform(0);
  private readonly shadow: Mesh;
  private readonly shadowSource: { position: Float32Array };
  private readonly material: MeshBasicNodeMaterial;
  private readonly inkMaterial: MeshBasicNodeMaterial;
  private readonly geometries: BufferGeometry[] = [];
  private readonly tmpQ = new Quaternion();

  constructor(spec: ModelSpec, cg: readonly [number, number, number], lighting: PlanetLighting) {
    this.material = this.buildMaterial(lighting);
    this.inkMaterial = this.buildInk();
    const built = buildAnimatedModel(spec);
    const addMesh = (m: BuiltModel, parent: Group, offset: readonly number[]) => {
      const g = modelGeometry(m);
      this.geometries.push(g);
      const mesh = new Mesh(g, this.material);
      const ink = new Mesh(g, this.inkMaterial);
      for (const x of [mesh, ink]) {
        x.position.set(offset[0]!, offset[1]!, offset[2]!);
        x.frustumCulled = false;
        parent.add(x);
      }
    };
    // The model's origin sits −cg from the CG.
    this.model.position.set(-cg[0], -cg[1], -cg[2]);
    addMesh(built.body, this.model, [0, 0, 0]);
    for (const piece of built.pieces) {
      const pivot = new Group();
      pivot.position.set(...piece.origin);
      this.model.add(pivot);
      addMesh(piece.model, pivot, [-piece.origin[0], -piece.origin[1], -piece.origin[2]]);
      this.pieces.push({ piece, pivot });
    }
    this.group.add(this.model);

    // Afterburner flame: an additive cone behind the nozzle.
    const ab = built.body.emissives.find((e) => e.kind === 'afterburner');
    const at = ab?.position ?? [-7.6, 0.1, 0];
    const cone = new ConeGeometry(0.42, 1, 8, 1, true);
    cone.translate(0, -0.5, 0);
    cone.rotateZ(-Math.PI / 2);
    this.geometries.push(cone);
    this.flameMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    // Core #FFB347, hotter toward the nozzle (Part I, Light and Emissives).
    const along = positionLocal.x.negate().clamp(0, 1);
    this.flameMaterial.colorNode = vec3(1.0, 0.45, 0.07).mul(float(2.2).sub(along.mul(1.6)));
    this.flameMaterial.opacityNode = float(1).sub(along).mul(0.9);
    this.flame = new Mesh(cone, this.flameMaterial);
    this.flame.position.set(at[0], at[1], at[2]);
    this.flame.frustumCulled = false;
    this.model.add(this.flame);

    // Shadow: the body's triangles flattened onto the ground along the sun, on the CPU.
    const all = [built.body, ...built.pieces.map((p) => p.model)];
    const count = all.reduce((n, m) => n + m.position.length, 0);
    const shadowGeo = new BufferGeometry();
    shadowGeo.setAttribute('position', new BufferAttribute(new Float32Array(count), 3));
    this.geometries.push(shadowGeo);
    // Overlapping triangles darken twice; a strict depth test streaks (coplanar
    // depths differ by rounding), so a stencil pass is the later fix (TODO).
    const sm = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    sm.colorNode = vec3(0, 0, 0);
    // The shadow is the sun's: it fades under cloud and inside a mountain's shadow.
    const onGround = positionWorld.add(lighting.eye) as Vec3Node;
    const cloud = lighting.sunVisibility?.(onGround) ?? float(1);
    const terrain = lighting.terrainShadow?.(onGround) ?? float(1);
    sm.opacityNode = float(0.32).mul(cloud).mul(terrain);
    sm.polygonOffset = true;
    sm.polygonOffsetFactor = -2;
    sm.polygonOffsetUnits = -2;
    this.shadow = new Mesh(shadowGeo, sm);
    this.shadow.frustumCulled = false;
    this.shadowSource = { position: new Float32Array(count) };
    let o = 0;
    for (const m of all) {
      this.shadowSource.position.set(m.position, o);
      o += m.position.length;
    }
    this.pieceRanges = all.map((m) => m.position.length);
  }

  private readonly pieceRanges: number[];

  /** The shadow, in camera-relative coordinates: add it to a group at the origin. */
  get shadowMesh(): Mesh {
    return this.shadow;
  }

  private buildMaterial(lighting: PlanetLighting): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const albedo = attribute('color', 'vec3').mul(attribute('ao', 'float')) as V3;
    m.colorNode = lighting.shadeDiffuse(albedo, normalWorld as V3, positionWorld as V3);
    return m;
  }

  /** Inverted-hull ink (decision 107): back faces pushed out along the outline normals. */
  private buildInk(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: BackSide });
    const on = attribute('outlineNormal', 'vec3');
    m.positionNode = positionLocal.add(on.mul(this.inkOffset));
    m.colorNode = vec3(...INK_LINEAR);
    return m;
  }

  /** Poses the model and places it camera-relative to `eye`. */
  update(pose: Readonly<AircraftPose>, eye: Readonly<Vec3d>): void {
    // Camera-relative placement: float64 subtraction before the float32 write (rule 4).
    this.group.position.set(pose.pos.x - eye.x, pose.pos.y - eye.y, pose.pos.z - eye.z);
    this.tmpQ.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w).multiply(MODEL_TO_BODY);
    this.group.quaternion.copy(this.tmpQ);
    const axis = new Vector3();
    for (const { piece, pivot } of this.pieces) {
      const s = piece.side;
      let v = 0;
      switch (piece.channel) {
        case 'stabilator':
          // Trailing edge up for nose up; differential with roll.
          v = -pose.elevator + 0.5 * s * pose.aileron;
          break;
        case 'flaperon':
          v = s * pose.aileron + 0.6 * pose.flaps;
          break;
        case 'rudder':
          v = -pose.rudder;
          break;
        case 'speedbrake':
          v = pose.speedbrake;
          break;
        case 'gear':
          v = 1 - pose.gear;
          break;
      }
      v = Math.max(-1, Math.min(1, v));
      // A mirrored piece turns the mirror way about its mirrored axis.
      const angle = piece.angle * v * (s > 0 ? 1 : -1);
      axis.set(...piece.axis);
      pivot.quaternion.setFromAxisAngle(axis, angle);
    }
    // Afterburner.
    const ab = pose.afterburner;
    this.flame.visible = ab > 0.02;
    this.flame.scale.set(1.5 + 3 * ab, 0.8 + 0.3 * ab, 0.8 + 0.3 * ab);
    // Ink width at the aircraft's distance.
    const dist = Math.hypot(this.group.position.x, this.group.position.y, this.group.position.z);
    this.inkOffset.value = dist * this.radPerPixel * this.inkWidth;
    this.updateShadow(pose, eye);
  }

  /** Flattens the posed model onto the ground plane along the sun. */
  private updateShadow(pose: Readonly<AircraftPose>, eye: Readonly<Vec3d>): void {
    const up = pose.pos.clone().normalize();
    const sunUp = this.sun.dot(up);
    const R = this.planetRadius + pose.groundHeight;
    const agl = pose.pos.length() - R;
    this.shadow.visible = sunUp > 0.05 && agl < 400;
    if (!this.shadow.visible) return;
    this.group.updateMatrixWorld(true);
    const out = this.shadow.geometry.getAttribute('position') as BufferAttribute;
    const arr = out.array as Float32Array;
    const src = this.shadowSource.position;
    // Ground plane through the point under the aircraft, camera-relative.
    const G = up.clone().scale(R).sub(eye);
    const L = this.sun;
    const meshes: Mesh[] = [];
    this.model.traverse((o) => {
      if (o instanceof Mesh && o.material === this.material) meshes.push(o);
    });
    let off = 0;
    const v = new Vector3();
    meshes.forEach((mesh, k) => {
      const n = this.pieceRanges[k] ?? 0;
      const mw = mesh.matrixWorld;
      for (let i = 0; i < n; i += 3) {
        v.set(src[off + i]!, src[off + i + 1]!, src[off + i + 2]!).applyMatrix4(mw);
        // p' = p − L ((p − G)·n) / (L·n)
        const d = ((v.x - G.x) * up.x + (v.y - G.y) * up.y + (v.z - G.z) * up.z) / sunUp;
        arr[off + i] = v.x - L.x * d;
        arr[off + i + 1] = v.y - L.y * d;
        arr[off + i + 2] = v.z - L.z * d;
      }
      off += n;
    });
    out.needsUpdate = true;
  }

  /** Planet radius (m), set by the app. */
  planetRadius = 1_000_000;

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
    this.inkMaterial.dispose();
    this.flameMaterial.dispose();
  }
}
