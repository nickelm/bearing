/**
 * The flown aircraft in the simulation view (Free Flight, decision 134;
 * visual-style Part I, The Controlled Aircraft): the model built from its spec
 * with hinge-animated parts (stabilators, flaperons, rudder, speedbrakes, gear)
 * driven by the flight model, the afterburner flame, an ink outline (decision
 * 107) and a shadow on the ground, all placed camera-relative (rule 4).
 *
 * Rotors (decisions 149, 157; Part I, Helicopters): each spec rotor's hub and blades turn
 * by the pose's azimuth about the rotor's axis, and a main rotor's blades and disc
 * tilt with the flapping state about the hub. Blades fade into the translucent disc
 * as rotor speed rises (blades alone below 0.3 of governed speed, disc alone above
 * 0.7). The disc has no ink outline and casts a faint shadow.
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
  Euler,
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
import type { Node, UniformNode } from 'three/webgpu';
import type { Quatd } from '../../../core/quat';
import { Vec3d } from '../../../core/vec3d';
import { buildAnimatedModel } from '../../common/models/builder';
import type { AnimatedPiece, BuiltModel, BuiltRotor } from '../../common/models/builder';
import type { ModelSpec } from '../../common/models/spec';
import { INK_LINEAR, modelGeometry } from '../../common/models/threeModel';
import type { PlanetLighting, Vec3Node } from '../lighting/planetLighting';

type V3 = ReturnType<typeof vec3>;
type FloatUniform = UniformNode<'float', number>;

/** One rotor's state, from the flight model. */
export interface RotorPose {
  /**
   * Rotor angle (rad), growing in the rotor's direction of rotation: the view turns
   * the rotor by `direction × azimuth` right-handed about its axis. At 0 the first
   * blade points aft (spec.ts).
   */
  azimuth: number;
  /** Rotor speed as a fraction of governed speed, 0..1.1. */
  speed: number;
  /** Disc tilt (rad): + leading edge down toward the nose (forward cyclic). */
  tiltForward: number;
  /** Disc tilt (rad): + right side down. */
  tiltRight: number;
}

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
  /**
   * Rotors in spec order (helicopters). Absent: blades stand still at azimuth 0 and
   * no disc shows. Tilt applies to rotors whose axis is within 45° of the model's up
   * (main rotors); tail rotors ignore it.
   */
  rotors?: readonly RotorPose[];
}

/** Rotor speed (fraction of governed) where blades start to fade, and where only the disc is left. */
export const BLADES_FADE = [0.3, 0.7] as const;

/** Blade and disc opacity at a rotor speed: blades alone when slow, the disc alone when fast. */
export function rotorBlend(speed: number): { blades: number; disc: number } {
  const t = Math.min(1, Math.max(0, (speed - BLADES_FADE[0]) / (BLADES_FADE[1] - BLADES_FADE[0])));
  const d = t * t * (3 - 2 * t);
  return { blades: 1 - d, disc: d };
}

/** The disc's shadow strength relative to the body's at the disc's own opacity. */
const DISC_SHADOW = 0.45;

/** Model frame → body axes: −90° about x. */
const MODEL_TO_BODY = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

interface PieceMesh {
  piece: AnimatedPiece;
  pivot: Group;
}

interface RotorMesh {
  rotor: BuiltRotor;
  /** Tilts about the hub (main rotors); holds the spin pivot and the disc. */
  tilt: Group;
  spin: Group;
  tilts: boolean;
  blades: Mesh;
  bladeInk: Mesh;
  /** The blades' blended materials while they fade (solid blades use the body's). */
  fade: MeshBasicNodeMaterial;
  inkFade: MeshBasicNodeMaterial;
  disc: Mesh;
  bladeOpacity: FloatUniform;
  discOpacity: FloatUniform;
  bladeShadow: Mesh;
  discShadow: Mesh;
  /** Opacity of the blade and disc shadows (the disc's also scales by its band alpha). */
  bladeShadowOpacity: FloatUniform;
  discShadowOpacity: FloatUniform;
}

/** A source of shadow triangles: a mesh's model-frame positions and where they go in the shadow. */
interface ShadowSource {
  mesh: Mesh;
  position: Float32Array;
  out: BufferAttribute;
  offset: number;
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
  private readonly rotors: RotorMesh[] = [];
  private readonly flame: Mesh;
  private readonly flameMaterial: MeshBasicNodeMaterial;
  private readonly inkOffset = uniform(0);
  private readonly shadow: Mesh;
  /** Triangles flattened into the shadow each frame, in order. */
  private readonly shadowSources: ShadowSource[] = [];
  private readonly material: MeshBasicNodeMaterial;
  private readonly inkMaterial: MeshBasicNodeMaterial;
  private readonly materials: MeshBasicNodeMaterial[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly tmpQ = new Quaternion();
  private readonly tmpAxis = new Vector3();
  private readonly tmpEuler = new Euler();

  constructor(spec: ModelSpec, cg: readonly [number, number, number], lighting: PlanetLighting) {
    this.material = this.buildMaterial(lighting);
    this.inkMaterial = this.buildInk();
    const built = buildAnimatedModel(spec);
    const addMesh = (
      m: BuiltModel,
      parent: Group,
      offset: readonly number[],
      material = this.material,
      inkMaterial = this.inkMaterial,
    ) => {
      const g = modelGeometry(m);
      this.geometries.push(g);
      const mesh = new Mesh(g, material);
      const ink = new Mesh(g, inkMaterial);
      for (const x of [mesh, ink]) {
        x.position.set(offset[0]!, offset[1]!, offset[2]!);
        x.frustumCulled = false;
        parent.add(x);
      }
      return { mesh, ink };
    };
    // The model's origin sits −cg from the CG.
    this.model.position.set(-cg[0], -cg[1], -cg[2]);
    const shadowed: { mesh: Mesh; model: BuiltModel }[] = [];
    shadowed.push({ mesh: addMesh(built.body, this.model, [0, 0, 0]).mesh, model: built.body });
    for (const piece of built.pieces) {
      const pivot = new Group();
      pivot.position.set(...piece.origin);
      this.model.add(pivot);
      const o = piece.origin;
      const { mesh } = addMesh(piece.model, pivot, [-o[0], -o[1], -o[2]]);
      shadowed.push({ mesh, model: piece.model });
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

    // Rotors: hub and blades on a spin pivot, inside a tilt pivot at the hub that also
    // holds the disc. The hubs join the body's shadow.
    const rotorParts = built.rotors.map((rotor) => {
      const h = rotor.hub;
      const back = [-h[0], -h[1], -h[2]];
      const tilt = new Group();
      tilt.position.set(...h);
      this.model.add(tilt);
      const spin = new Group();
      tilt.add(spin);
      const hub = addMesh(rotor.hubModel, spin, back).mesh;
      shadowed.push({ mesh: hub, model: rotor.hubModel });
      const bladeOpacity = uniform(1);
      const blades = addMesh(
        rotor.blades,
        spin,
        back,
        this.buildMaterial(lighting, bladeOpacity),
        this.buildInk(bladeOpacity),
      );
      const discOpacity = uniform(0);
      const discGeo = discGeometry(rotor.disc);
      this.geometries.push(discGeo);
      const disc = new Mesh(discGeo, this.buildDiscMaterial(lighting, discOpacity));
      disc.position.set(back[0]!, back[1]!, back[2]!);
      disc.frustumCulled = false;
      disc.visible = false;
      tilt.add(disc);
      return { rotor, tilt, spin, blades, disc, bladeOpacity, discOpacity };
    });

    // Shadow: the posed triangles flattened onto the ground along the sun, on the CPU.
    const count = shadowed.reduce((n, s) => n + s.model.position.length, 0);
    const shadowGeo = new BufferGeometry();
    const shadowPos = new BufferAttribute(new Float32Array(count), 3);
    shadowGeo.setAttribute('position', shadowPos);
    this.geometries.push(shadowGeo);
    // Overlapping triangles darken twice; a strict depth test streaks (coplanar
    // depths differ by rounding), so a stencil pass is the later fix (TODO).
    this.shadow = new Mesh(shadowGeo, this.buildShadowMaterial(lighting, float(1)));
    this.shadow.frustumCulled = false;
    let off = 0;
    for (const s of shadowed) {
      this.shadowSources.push({
        mesh: s.mesh,
        position: s.model.position,
        out: shadowPos,
        offset: off,
      });
      off += s.model.position.length;
    }
    // Blades and discs shadow on their own, at their own opacity, as children of the
    // shadow (which sits at the camera-relative origin).
    for (const r of rotorParts) {
      const shadowOf = (source: Mesh, position: Float32Array, opacity: FloatUniform) => {
        const g = new BufferGeometry();
        const out = new BufferAttribute(new Float32Array(position.length), 3);
        g.setAttribute('position', out);
        this.geometries.push(g);
        if (source === r.disc) g.setAttribute('alpha', new BufferAttribute(r.rotor.disc.alpha, 1));
        const op = source === r.disc ? attribute('alpha', 'float').mul(opacity) : opacity;
        const m = new Mesh(g, this.buildShadowMaterial(lighting, op));
        m.frustumCulled = false;
        this.shadow.add(m);
        this.shadowSources.push({ mesh: source, position, out, offset: 0 });
        return m;
      };
      const bladeShadowOpacity = uniform(1);
      const discShadowOpacity = uniform(0);
      this.rotors.push({
        rotor: r.rotor,
        tilt: r.tilt,
        spin: r.spin,
        tilts: Math.abs(r.rotor.axis[1]) > Math.SQRT1_2,
        blades: r.blades.mesh,
        bladeInk: r.blades.ink,
        fade: r.blades.mesh.material as MeshBasicNodeMaterial,
        inkFade: r.blades.ink.material as MeshBasicNodeMaterial,
        disc: r.disc,
        bladeOpacity: r.bladeOpacity,
        discOpacity: r.discOpacity,
        bladeShadow: shadowOf(r.blades.mesh, r.rotor.blades.position, bladeShadowOpacity),
        discShadow: shadowOf(r.disc, r.rotor.disc.position, discShadowOpacity),
        bladeShadowOpacity,
        discShadowOpacity,
      });
    }
  }

  /** The shadow, in camera-relative coordinates: add it to a group at the origin. */
  get shadowMesh(): Mesh {
    return this.shadow;
  }

  private buildMaterial(lighting: PlanetLighting, opacity?: FloatUniform): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const albedo = attribute('color', 'vec3').mul(attribute('ao', 'float')) as V3;
    m.colorNode = lighting.shadeDiffuse(albedo, normalWorld as V3, positionWorld as V3);
    if (opacity) {
      // Fading blades: blended, but still writing depth.
      m.transparent = true;
      m.depthWrite = true;
      m.opacityNode = opacity;
    }
    this.materials.push(m);
    return m;
  }

  /** Inverted-hull ink (decision 107): back faces pushed out along the outline normals. */
  private buildInk(opacity?: FloatUniform): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: BackSide });
    const on = attribute('outlineNormal', 'vec3');
    m.positionNode = positionLocal.add(on.mul(this.inkOffset));
    m.colorNode = vec3(...INK_LINEAR);
    if (opacity) {
      m.transparent = true;
      m.depthWrite = true;
      m.opacityNode = opacity;
    }
    this.materials.push(m);
    return m;
  }

  /** The rotor disc: lit like the model, one alpha per face from its bands, no ink. */
  private buildDiscMaterial(
    lighting: PlanetLighting,
    opacity: FloatUniform,
  ): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    m.colorNode = lighting.shadeDiffuse(
      attribute('color', 'vec3') as unknown as V3,
      normalWorld as V3,
      positionWorld as V3,
    );
    m.opacityNode = attribute('alpha', 'float').mul(opacity);
    this.materials.push(m);
    return m;
  }

  /** Shadow: black at 32% times `opacity`, fading under cloud and in a mountain's shadow. */
  private buildShadowMaterial(
    lighting: PlanetLighting,
    opacity: Node<'float'>,
  ): MeshBasicNodeMaterial {
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
    sm.opacityNode = float(0.32).mul(opacity).mul(cloud).mul(terrain);
    sm.polygonOffset = true;
    sm.polygonOffsetFactor = -2;
    sm.polygonOffsetUnits = -2;
    this.materials.push(sm);
    return sm;
  }

  /** Poses the model and places it camera-relative to `eye`. */
  update(pose: Readonly<AircraftPose>, eye: Readonly<Vec3d>): void {
    // Camera-relative placement: float64 subtraction before the float32 write (rule 4).
    this.group.position.set(pose.pos.x - eye.x, pose.pos.y - eye.y, pose.pos.z - eye.z);
    this.tmpQ.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w).multiply(MODEL_TO_BODY);
    this.group.quaternion.copy(this.tmpQ);
    const axis = this.tmpAxis;
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
    this.poseRotors(pose.rotors);
    // Afterburner.
    const ab = pose.afterburner;
    this.flame.visible = ab > 0.02;
    this.flame.scale.set(1.5 + 3 * ab, 0.8 + 0.3 * ab, 0.8 + 0.3 * ab);
    // Ink width at the aircraft's distance.
    const dist = Math.hypot(this.group.position.x, this.group.position.y, this.group.position.z);
    this.inkOffset.value = dist * this.radPerPixel * this.inkWidth;
    this.updateShadow(pose, eye);
  }

  /** Spins and tilts the rotors and crossfades their blades into discs. */
  private poseRotors(poses: readonly RotorPose[] | undefined): void {
    this.rotors.forEach((r, i) => {
      const p = poses?.[i];
      this.tmpAxis.set(...r.rotor.axis);
      r.spin.quaternion.setFromAxisAngle(this.tmpAxis, r.rotor.direction * (p?.azimuth ?? 0));
      // Leading edge down turns −tiltForward about +z; right side down turns +tiltRight about +x.
      if (r.tilts && p)
        r.tilt.quaternion.setFromEuler(this.tmpEuler.set(p.tiltRight, 0, -p.tiltForward));
      else r.tilt.quaternion.identity();
      const { blades, disc } = rotorBlend(p?.speed ?? 0);
      // Solid blades draw with the body's opaque materials; fading ones blend.
      const solid = blades > 0.999;
      r.blades.material = solid ? this.material : r.fade;
      r.bladeInk.material = solid ? this.inkMaterial : r.inkFade;
      r.bladeOpacity.value = blades;
      r.discOpacity.value = disc;
      r.blades.visible = r.bladeInk.visible = blades > 0.004;
      r.disc.visible = disc > 0.004;
      r.bladeShadowOpacity.value = blades;
      r.discShadowOpacity.value = disc * DISC_SHADOW;
      r.bladeShadow.visible = r.blades.visible;
      r.discShadow.visible = r.disc.visible;
    });
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
    // Ground plane through the point under the aircraft, camera-relative.
    const G = up.clone().scale(R).sub(eye);
    const L = this.sun;
    const v = new Vector3();
    const touched = new Set<BufferAttribute>();
    for (const s of this.shadowSources) {
      if (!s.mesh.visible) continue;
      const arr = s.out.array as Float32Array;
      const src = s.position;
      const mw = s.mesh.matrixWorld;
      for (let i = 0; i < src.length; i += 3) {
        v.set(src[i]!, src[i + 1]!, src[i + 2]!).applyMatrix4(mw);
        // p' = p − L ((p − G)·n) / (L·n)
        const d = ((v.x - G.x) * up.x + (v.y - G.y) * up.y + (v.z - G.z) * up.z) / sunUp;
        arr[s.offset + i] = v.x - L.x * d;
        arr[s.offset + i + 1] = v.y - L.y * d;
        arr[s.offset + i + 2] = v.z - L.z * d;
      }
      touched.add(s.out);
    }
    for (const a of touched) a.needsUpdate = true;
  }

  /** Planet radius (m), set by the app. */
  planetRadius = 1_000_000;

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.flameMaterial.dispose();
  }
}

/** A rotor disc as three.js geometry: position, normal, color and per-vertex alpha. */
function discGeometry(d: BuiltRotor['disc']): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(d.position, 3));
  g.setAttribute('normal', new BufferAttribute(d.normal, 3));
  g.setAttribute('color', new BufferAttribute(d.color, 3));
  g.setAttribute('alpha', new BufferAttribute(d.alpha, 1));
  g.computeBoundingSphere();
  return g;
}
