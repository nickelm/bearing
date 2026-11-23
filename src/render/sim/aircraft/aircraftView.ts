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
 * The shadow (decision 170): the posed triangles flattened along the sun onto a
 * plane fitted to the drawn ground where the shadow falls, on the CPU, as one
 * mesh in one draw. It darkens the ground once wherever any triangle covers it:
 * each fragment writes the depth of its pixel's ray against the plane, computed
 * from the screen position, so every triangle at a pixel writes the same bits
 * and a strict depth test lets only the first through. It multiplies the ground
 * by a deep blue-gray (Part I: shadows deep and blue, never black), fading under
 * cloud, in a mountain's shadow and toward a low sun.
 *
 * Orientation: the flight model's quaternion turns body axes (x forward, y
 * right, z down) into the world; the model frame is x forward, y up, z right,
 * so the mesh turns by q ⊗ (−90° about x) about the CG.
 */
import {
  AddEquation,
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  Euler,
  Group,
  LessDepth,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  Quaternion,
  Vector3,
  ZeroFactor,
} from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraProjectionMatrixInverse,
  cameraViewMatrix,
  dot,
  float,
  getViewPosition,
  mix,
  normalWorld,
  positionLocal,
  positionWorld,
  screenUV,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { UniformNode } from 'three/webgpu';
import type { Quatd } from '../../../core/quat';
import { Vec3d } from '../../../core/vec3d';
import { buildAnimatedModel } from '../../common/models/builder';
import type { AnimatedPiece, BuiltModel, BuiltRotor } from '../../common/models/builder';
import type { ModelSpec } from '../../common/models/spec';
import type { StoreMount } from './storeMounts';
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
   * The drawn ground's height (m) at a unit direction. With it the shadow lies on a
   * plane fitted to the ground where it falls (five samples a frame); without it, on
   * the level plane at `groundHeight`.
   */
  ground?: (dir: Readonly<Vec3d>) => number;
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

/**
 * What the shadow multiplies the ground by at full strength: about 68% darker, a
 * little less in blue, so it reads deep and blue (Part I, Lighting). A sunlit
 * ground loses 70–80% of its light in a real shadow; this stays a little lighter.
 */
export const SHADOW_TINT: readonly [number, number, number] = [0.3, 0.33, 0.42];

/** Sun height (sine of its elevation) over which the shadow fades in. */
const SHADOW_SUN = [0.05, 0.2] as const;

/** The shadow plane sits this far above the ground (m), plus a share of its distance from the eye. */
const SHADOW_LIFT = [0.06, 0.002] as const;

/** 0 below `a`, 1 above `b`, smooth between. */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

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
}

/**
 * A source of shadow triangles: a mesh's model-frame positions, where they start in
 * the shadow's buffers (vertex index), and its strength: 1 for the body, the
 * blades' opacity, or the disc's band alpha times its opacity.
 */
interface ShadowSource {
  mesh: Mesh;
  position: Float32Array;
  start: number;
  kind: 'body' | 'blades' | 'disc';
  rotor: number;
  /** Per-vertex band alpha (discs). */
  alpha: Float32Array | null;
  /** Its triangles are collapsed to a point (hidden source). */
  collapsed: boolean;
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
  /** Triangles flattened into the shadow each frame, in draw order: body, blades, discs. */
  private readonly shadowSources: ShadowSource[] = [];
  private readonly shadowPos: BufferAttribute;
  private readonly shadowShade: BufferAttribute;
  /** Half the width of the ground the shadow's plane is fitted over (m). */
  private readonly shadowSpan: number;
  /** The shadow plane (camera-relative point, world normal) and the sun's fade, for the shader. */
  private readonly planePoint = uniform(new Vector3());
  private readonly planeNormal = uniform(new Vector3(0, 1, 0));
  private readonly shadowStrength = uniform(1);
  private readonly material: MeshBasicNodeMaterial;
  private readonly inkMaterial: MeshBasicNodeMaterial;
  private readonly materials: MeshBasicNodeMaterial[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly tmpQ = new Quaternion();
  private readonly tmpAxis = new Vector3();
  private readonly tmpEuler = new Euler();
  /** The stores' meshes and ink by station (decision 288). */
  private readonly storeMeshes = new Map<string, Mesh[]>();

  constructor(
    spec: ModelSpec,
    cg: readonly [number, number, number],
    lighting: PlanetLighting,
    /** Stores that may hang on its stations, all shown until `setStores` (decision 288). */
    stores: readonly StoreMount[] = [],
  ) {
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
    // Stores on their stations: built once each, shown while loaded; they shadow as the body.
    for (const s of stores) {
      const m = buildAnimatedModel(s.spec).body;
      const { mesh, ink } = addMesh(m, this.model, s.at);
      shadowed.push({ mesh, model: m });
      this.storeMeshes.set(s.station, [mesh, ink]);
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

    for (const r of rotorParts)
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
      });

    // Shadow: one mesh of every shadowing triangle, flattened on the CPU each frame. Body,
    // pieces and hubs first, then blades, then discs: the first triangle at a pixel wins.
    const sources: Omit<ShadowSource, 'start' | 'collapsed'>[] = [
      ...shadowed.map((x) => ({
        mesh: x.mesh,
        position: x.model.position,
        kind: 'body' as const,
        rotor: -1,
        alpha: null,
      })),
      ...rotorParts.map((r, i) => ({
        mesh: r.blades.mesh,
        position: r.rotor.blades.position,
        kind: 'blades' as const,
        rotor: i,
        alpha: null,
      })),
      ...rotorParts.map((r, i) => ({
        mesh: r.disc,
        position: r.rotor.disc.position,
        kind: 'disc' as const,
        rotor: i,
        alpha: r.rotor.disc.alpha,
      })),
    ];
    let vertices = 0;
    let reach = 0;
    for (const src of sources) {
      this.shadowSources.push({ ...src, start: vertices, collapsed: true });
      vertices += src.position.length / 3;
      const p = src.position;
      for (let i = 0; i < p.length; i += 3) reach = Math.max(reach, Math.hypot(p[i]!, p[i + 2]!));
    }
    this.shadowSpan = Math.min(12, Math.max(3, reach));
    const shadowGeo = new BufferGeometry();
    this.shadowPos = new BufferAttribute(new Float32Array(vertices * 3), 3);
    this.shadowShade = new BufferAttribute(new Float32Array(vertices), 1);
    shadowGeo.setAttribute('position', this.shadowPos);
    shadowGeo.setAttribute('shade', this.shadowShade);
    this.geometries.push(shadowGeo);
    this.shadow = new Mesh(shadowGeo, this.buildShadowMaterial(lighting));
    this.shadow.frustumCulled = false;
    // First among the transparent draws, right after the opaque terrain and aircraft:
    // drawn after the disc or the flame it would darken them too, and fading blades,
    // which write depth, would block it (decision 170's review). Its sort key would
    // otherwise come from a bounding sphere frozen at its first frame.
    this.shadow.renderOrder = -1;
  }
  /**
   * Moves the model so `cg` (model coordinates, m) sits at the pose's position: a view drawn
   * from an analytic pose has none, one drawn from a flight model its spec's (R2.5).
   */
  setCg(cg: readonly [number, number, number]): void {
    this.model.position.set(-cg[0], -cg[1], -cg[2]);
  }

  /**
   * Shows the stores on `loaded` stations and hides the rest: a store fired, released or
   * jettisoned leaves its station empty (decision 288). Stations without a mount are ignored.
   */
  setStores(loaded: Iterable<string>): void {
    const on = new Set(loaded);
    for (const [station, meshes] of this.storeMeshes)
      for (const x of meshes) x.visible = on.has(station);
  }

  /** The stations that have a store drawn on them, shown or not. */
  get storeStations(): string[] {
    return [...this.storeMeshes.keys()];
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

  /**
   * Shadow: multiplies the ground by SHADOW_TINT at full strength (per-vertex shade
   * times the sun's fade, cloud and terrain shadow), writing its pixel's depth on the
   * shadow plane so that overlapping triangles darken once.
   */
  private buildShadowMaterial(lighting: PlanetLighting): MeshBasicNodeMaterial {
    const sm = new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide });
    // Both faces in one draw (a transparent double-sided material draws twice otherwise).
    sm.forceSinglePass = true;
    // Multiply: result = source × destination; the destination's alpha stays.
    sm.blending = CustomBlending;
    sm.blendEquation = sm.blendEquationAlpha = AddEquation;
    sm.blendSrc = DstColorFactor;
    sm.blendDst = ZeroFactor;
    sm.blendSrcAlpha = ZeroFactor;
    sm.blendDstAlpha = OneFactor;
    // The shadow is the sun's: it fades under cloud and inside a mountain's shadow.
    const onGround = positionWorld.add(lighting.eye) as Vec3Node;
    const cloud = lighting.sunVisibility?.(onGround) ?? float(1);
    const terrain = lighting.terrainShadow?.(onGround) ?? float(1);
    const s = attribute('shade', 'float')
      .mul(this.shadowStrength)
      .mul(cloud)
      .mul(terrain)
      .clamp(0, 1);
    sm.colorNode = mix(vec3(1, 1, 1), vec3(...SHADOW_TINT), s);
    sm.opacityNode = float(1);
    // One layer: the depth of this pixel's ray where it meets the shadow plane, from the
    // screen position and uniforms only, so every triangle at a pixel writes the same
    // bits; with a strict test the first triangle shadows the pixel and the rest fail
    // (interpolated depths differ by rounding and streaked).
    sm.depthWrite = true;
    sm.depthFunc = LessDepth;
    const ray = getViewPosition(screenUV, float(0.5), cameraProjectionMatrixInverse);
    const g = cameraViewMatrix.mul(vec4(this.planePoint, 1)).xyz;
    const n = cameraViewMatrix.mul(vec4(this.planeNormal, 0)).xyz;
    const hit = ray.mul(dot(g, n).div(dot(ray, n)));
    const clip = cameraProjectionMatrix.mul(vec4(hit, 1));
    sm.depthNode = clip.z.div(clip.w);
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
      // Gear fully up is behind its doors (decision 312): a strut's hinge end would stick
      // out of a fuselage narrower than the track, so retracted pieces are not drawn.
      if (piece.channel === 'gear') pivot.visible = pose.gear > 0.02;
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
    });
  }

  /** Flattens the posed model along the sun onto the ground where its shadow falls. */
  private updateShadow(pose: Readonly<AircraftPose>, eye: Readonly<Vec3d>): void {
    const up = pose.pos.clone().normalize();
    const sunUp = this.sun.dot(up);
    const R0 = this.planetRadius + pose.groundHeight;
    const agl = pose.pos.length() - R0;
    const fade = smoothstep(SHADOW_SUN[0], SHADOW_SUN[1], sunUp);
    this.shadow.visible = fade > 0 && agl < 400;
    if (!this.shadow.visible) return;
    const n = new Vec3d();
    const G = this.shadowPlane(pose, up, agl, sunUp, n);
    const L = this.sun;
    const Ln = L.dot(n);
    this.shadow.visible = Ln > 0.05;
    if (!this.shadow.visible) return;
    this.group.updateMatrixWorld(true);
    // Camera-relative, lifted off the ground against z-fighting.
    G.sub(eye);
    G.addScaled(n, SHADOW_LIFT[0] + SHADOW_LIFT[1] * G.length());
    this.planePoint.value.set(G.x, G.y, G.z);
    this.planeNormal.value.set(n.x, n.y, n.z);
    this.shadowStrength.value = fade;
    const v = new Vector3();
    const arr = this.shadowPos.array as Float32Array;
    const shade = this.shadowShade.array as Float32Array;
    for (const s of this.shadowSources) {
      const r = s.rotor >= 0 ? this.rotors[s.rotor]! : null;
      const k = !r
        ? 1
        : s.kind === 'blades'
          ? r.bladeOpacity.value
          : r.discOpacity.value * DISC_SHADOW;
      const n3 = s.position.length;
      if (!s.mesh.visible || k < 0.004) {
        // A hidden source would still write depth and block what follows: collapse it.
        if (!s.collapsed) {
          arr.fill(0, s.start * 3, s.start * 3 + n3);
          shade.fill(0, s.start, s.start + n3 / 3);
          s.collapsed = true;
        }
        continue;
      }
      s.collapsed = false;
      const src = s.position;
      const mw = s.mesh.matrixWorld;
      const o = s.start * 3;
      for (let i = 0; i < n3; i += 3) {
        v.set(src[i]!, src[i + 1]!, src[i + 2]!).applyMatrix4(mw);
        // p' = p − L ((p − G)·n) / (L·n)
        const d = ((v.x - G.x) * n.x + (v.y - G.y) * n.y + (v.z - G.z) * n.z) / Ln;
        arr[o + i] = v.x - L.x * d;
        arr[o + i + 1] = v.y - L.y * d;
        arr[o + i + 2] = v.z - L.z * d;
      }
      if (s.kind === 'body') shade.fill(1, s.start, s.start + n3 / 3);
      else if (s.alpha) for (let j = 0; j < n3 / 3; j++) shade[s.start + j] = s.alpha[j]! * k;
      else shade.fill(k, s.start, s.start + n3 / 3);
    }
    this.shadowPos.needsUpdate = true;
    this.shadowShade.needsUpdate = true;
  }

  /**
   * The plane the shadow lies on (world point, returned; unit normal in `n`): fitted
   * to the drawn ground where the CG's ray along the sun meets it. First around where
   * the ray meets the level ground under the aircraft; if the ray meets that fit more
   * than the span away (a knoll, a ridge, a valley), once more around that point. The
   * slope comes from four samples `shadowSpan` around the middle one, and the plane
   * rises to the highest of the five, so that on ground that bends up (a gully, the
   * foot of a slope) the shadow's edges do not sink under it. Level at the ground
   * under the aircraft without `pose.ground`, and on cliffs over 70°.
   */
  private shadowPlane(
    pose: Readonly<AircraftPose>,
    up: Readonly<Vec3d>,
    agl: number,
    sunUp: number,
    n: Vec3d,
  ): Vec3d {
    const R = this.planetRadius;
    const L = this.sun;
    n.copy(up);
    const level = up.clone().scale(R + pose.groundHeight);
    if (!pose.ground || sunUp <= 0.01) return level;
    const far = 2000;
    // Where the shadow falls on the level ground (at most 2 km off).
    let c = pose.pos.clone().addScaled(L, -Math.min(far, Math.max(0, agl) / sunUp));
    let fit = this.fitGround(pose.ground, c);
    if (fit) {
      const Ln = L.dot(fit.n);
      if (Ln > 0.05) {
        const t = pose.pos.clone().sub(fit.p).dot(fit.n) / Ln;
        const c1 = pose.pos.clone().addScaled(L, -Math.min(far, Math.max(0, t)));
        if (c1.distanceTo(c) > this.shadowSpan) {
          c = c1;
          fit = this.fitGround(pose.ground, c) ?? fit;
        }
      }
    }
    if (!fit) return level;
    n.copy(fit.n);
    return fit.p;
  }

  /**
   * The plane of the drawn ground around the point over `at`: normal from four samples
   * `shadowSpan` around it, through the highest of the five; null on cliffs over 70°.
   */
  private fitGround(
    ground: (d: Readonly<Vec3d>) => number,
    at: Readonly<Vec3d>,
  ): { p: Vec3d; n: Vec3d } | null {
    const R = this.planetRadius;
    const dir = at.clone().normalize();
    const e1 = Math.abs(dir.y) < 0.9 ? new Vec3d(0, 1, 0) : new Vec3d(1, 0, 0);
    e1.addScaled(dir, -e1.dot(dir)).normalize();
    const e2 = dir.clone().cross(e1);
    const span = this.shadowSpan;
    const sample = (e: Vec3d | null, s: number): Vec3d => {
      const d = dir.clone().scale(R);
      if (e) d.addScaled(e, s);
      d.normalize();
      return d.scale(R + ground(d));
    };
    const mid = sample(null, 0);
    const pts = [sample(e1, span), sample(e1, -span), sample(e2, span), sample(e2, -span)];
    const n = pts[0]!.clone().sub(pts[1]!).cross(pts[2]!.clone().sub(pts[3]!)).normalize();
    if (!(n.dot(dir) > 0.34)) return null;
    let rise = 0;
    for (const q of pts) rise = Math.max(rise, q.clone().sub(mid).dot(n));
    return { p: mid.addScaled(n, rise), n };
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
