/**
 * The map's military overlays on screen (visual-style Part II, Military Overlays;
 * decision 101): lines and marks from militaryModel.ts, sized in screen pixels and
 * fixed to the ground.
 *
 * - **Lines.** One instanced quad per polyline segment. The vertex shader drapes the
 *   segment's ends on the displayed relief (raw height × exaggeration) and widens it
 *   across the view direction by its width in pixels at its distance (the
 *   camera-relative group sits at −eye, rule 4). The fragment shader measures each
 *   pixel's distance to the segment in pixels: round joins and ends, or flat ends where
 *   a line stops at an arrowhead, antialiased.
 * - **Dashes and teeth.** Both are laid out along the line's ground distance, so they
 *   stay put while the camera moves. Their period in meters is the period in pixels at
 *   the screen center's map scale, rounded to a power of two: they keep roughly their
 *   pixel size and change only when the zoom passes a factor of two. Teeth are
 *   isosceles triangles on one side of the line, in the attacker's color.
 * - **Marks.** Arrowheads and chokepoint diamonds lie flat on the map at a point,
 *   sized in pixels, as signed-distance shapes on instanced quads.
 * - **Casing.** Every line and mark first draws a pale casing (`CASING_COLOR`) around
 *   its whole shape, teeth included, in a pass of its own, so casings never cover a
 *   neighbor's ink at joints.
 * - **Visibility.** Shapes fade beyond the horizon and with their zoom bands; there
 *   is no depth test, so relief and glyphs never hide the front. One mesh per layer
 *   and pass, so layers toggle by visibility.
 * - **Reuse** (decision 104). The class takes its own layer names, so the map's roads,
 *   railways and site symbols (infra/) draw with it too: lines may have a colored
 *   casing, marks include map symbols that face the screen, and an optional
 *   day/night input darkens ink and casing with the map's night tint.
 */
import {
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  cross,
  dot,
  exp2,
  sign,
  float,
  fract,
  length,
  log2,
  max,
  min,
  mix,
  normalize,
  round,
  select,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec4,
} from 'three/tsl';
import type { Vec3d } from '../../../core/vec3d';
import { placePlanetCentered } from '../../common/cameraRelative';
import { srgbToLinear } from '../../common/palette';
import { polylinePoint } from '../../../worldgen/strategic/graph';
import type { Point } from '../../../worldgen/strategic/graph';
import type { ZoomBand } from '../zoomBands';
import { daylightNode } from '../mapDaylight';
import { CASING_COLOR, MARK_SHAPES, OVERLAY_LAYERS } from './militaryModel';
import type { MilitaryOverlays, OverlayLayer } from './militaryModel';

/** Lift above the draped relief (m), so lines clear the coarse heights they are draped on. */
const LIFT = 300;
/** Large distance (px) for "no such shape". */
const FAR = 1e4;

function linear(hex: number): [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

function bandMask(bands: readonly ZoomBand[]): [number, number, number] {
  return [
    bands.includes('globe') ? 1 : 0,
    bands.includes('theater') ? 1 : 0,
    bands.includes('region') ? 1 : 0,
  ];
}

/** Per-instance data of one layer's segments (four floats per attribute). */
const SEGMENT_ATTRS = [
  'iA',
  'iB',
  'iDist',
  'iColor',
  'iDash',
  'iTeeth',
  'iTeethColor',
  'iBand',
  'iCasing',
];
const MARK_ATTRS = ['iP', 'iAxis', 'iSize', 'iColor', 'iBand', 'iCasing'];

type F = Node<'float'>;

/** Signed distance (units) to a box centered at (cx, cy) with half sizes (hx, hy). */
function sdBox(x: F, y: F, cx: number, cy: number, hx: number, hy: number): F {
  const qx = abs(x.sub(cx)).sub(hx);
  const qy = abs(y.sub(cy)).sub(hy);
  return length(vec2(max(qx, 0), max(qy, 0))).add(min(max(qx, qy), 0)) as F;
}

function sdCircle(x: F, y: F, cx: number, cy: number, r: number): F {
  return length(vec2(x.sub(cx), y.sub(cy))).sub(r) as F;
}

/** A ring of radius r and thickness t. */
function sdRing(x: F, y: F, r: number, t: number): F {
  return abs(length(vec2(x, y)).sub(r)).sub(t / 2) as F;
}

/** A hollow box: the outline of thickness t of a box with half sizes (hx, hy). */
function sdFrame(x: F, y: F, hx: number, hy: number, t: number): F {
  return abs(sdBox(x, y, 0, 0, hx - t / 2, hy - t / 2)).sub(t / 2) as F;
}

/** Five-pointed star of outer radius 1 and inner ratio rf, a point up (Inigo Quilez's sdStar5). */
function sdStar(x: F, y: F, rf: number): F {
  const k1 = [0.809016994375, -0.587785252292] as const;
  const k2 = [-k1[0], k1[1]] as const;
  let px: F = abs(x);
  let py: F = y;
  const t1 = max(px.mul(k1[0]).add(py.mul(k1[1])), 0).mul(2);
  px = px.sub(t1.mul(k1[0]));
  py = py.sub(t1.mul(k1[1]));
  const t2 = max(px.mul(k2[0]).add(py.mul(k2[1])), 0).mul(2);
  px = abs(px.sub(t2.mul(k2[0])));
  py = py.sub(t2.mul(k2[1])).sub(1);
  const bax = rf * -k1[1];
  const bay = rf * k1[0] - 1;
  const h = clamp(
    px
      .mul(bax)
      .add(py.mul(bay))
      .div(bax * bax + bay * bay),
    0,
    1,
  );
  return length(vec2(px.sub(h.mul(bax)), py.sub(h.mul(bay)))).mul(
    sign(py.mul(bax).sub(px.mul(bay))),
  ) as F;
}

/**
 * Map symbols in unit coordinates (x right, y up, the symbol within −1..1), by shape
 * code (MARK_SHAPES index ≥ 2): signed distance in units.
 */
function symbolDistance(code: F, x: F, y: F): F {
  const shapes: Record<string, () => F> = {
    // A ring with the runway through it, along the runway heading.
    airbase: () => min(sdRing(x, y, 0.72, 0.2), sdBox(x, y, 0, 0, 0.15, 1)),
    // A pier: a quay with three jetties.
    port: () =>
      min(
        sdBox(x, y, 0, -0.6, 0.9, 0.16),
        min(
          sdBox(x, y, -0.62, 0.02, 0.13, 0.55),
          min(sdBox(x, y, 0, 0.12, 0.13, 0.65), sdBox(x, y, 0.62, 0.02, 0.13, 0.55)),
        ),
      ),
    // A works with a chimney and a lower shed.
    factory: () =>
      min(
        sdBox(x, y, 0, -0.35, 0.9, 0.45),
        min(sdBox(x, y, 0.55, 0.35, 0.16, 0.5), sdBox(x, y, -0.35, 0.18, 0.4, 0.15)),
      ),
    // Two storage tanks and a flare stack.
    refinery: () =>
      min(
        min(sdCircle(x, y, -0.5, -0.3, 0.42), sdCircle(x, y, 0.5, -0.3, 0.42)),
        sdBox(x, y, 0, 0.4, 0.11, 0.55),
      ),
    'power-plant': () => min(sdRing(x, y, 0.75, 0.22), sdCircle(x, y, 0, 0, 0.3)),
    'supply-depot': () => min(sdFrame(x, y, 0.82, 0.82, 0.24), sdBox(x, y, 0, 0, 0.3, 0.3)),
    'fuel-depot': () => min(sdCircle(x, y, 0, -0.12, 0.62), sdBox(x, y, 0, 0.6, 0.2, 0.16)),
    // A yard: an outline with two tracks through it.
    'rail-yard': () =>
      min(
        sdFrame(x, y, 0.95, 0.62, 0.18),
        min(sdBox(x, y, 0, 0.2, 0.95, 0.07), sdBox(x, y, 0, -0.2, 0.95, 0.07)),
      ),
    // Two bars along the road, either side of it.
    bridge: () => min(sdBox(x, y, -0.6, 0, 0.18, 0.8), sdBox(x, y, 0.6, 0, 0.18, 0.8)),
    star: () => sdStar(x, y, 0.45),
    // A small aircraft seen from above, nose along the axis: fuselage, wings, tailplane.
    aircraft: () =>
      min(
        sdBox(x, y, 0, 0, 0.14, 0.95),
        min(sdBox(x, y, 0, 0.12, 0.95, 0.14), sdBox(x, y, 0, -0.75, 0.42, 0.11)),
      ),
    // A carrier from above: a long flight deck with the island on its right.
    carrier: () => min(sdBox(x, y, -0.06, 0, 0.32, 0.95), sdBox(x, y, 0.38, 0.12, 0.12, 0.26)),
  };
  let d: F = float(FAR);
  MARK_SHAPES.forEach((name, k) => {
    const f = shapes[name];
    if (f) d = select(code.equal(k), f(), d) as F;
  });
  return d;
}

/** Packs per-attribute vec4 arrays into one interleaved array of `capacity` instances. */
function packInstances(
  names: readonly string[],
  data: Float32Array[],
  capacity: number,
): Float32Array {
  const count = data[0]!.length / 4;
  const stride = names.length * 4;
  const packed = new Float32Array(Math.max(capacity, count) * stride);
  for (let i = 0; i < count; i++)
    for (let a = 0; a < names.length; a++)
      packed.set(data[a]!.subarray(i * 4, i * 4 + 4), i * stride + a * 4);
  return packed;
}

/**
 * Sets vec4 instance attributes from one interleaved buffer: a pipeline may read at
 * most eight vertex buffers, and the segments have nine attributes with the quad.
 * Room for `capacity` instances, so `updateOverlays` can rewrite it in place.
 */
function setInstanceAttributes(
  g: InstancedBufferGeometry,
  names: readonly string[],
  data: Float32Array[],
  capacity: number,
): InstancedInterleavedBuffer {
  const stride = names.length * 4;
  const buffer = new InstancedInterleavedBuffer(packInstances(names, data, capacity), stride, 1);
  names.forEach((name, a) =>
    g.setAttribute(name, new InterleavedBufferAttribute(buffer, 4, a * 4)),
  );
  return buffer;
}

export interface MilitaryUniforms {
  exaggeration: Node<'float'>;
  /** The map's sun and night and twilight strengths: ink and casing take the night tint. */
  daylight?: {
    sunDirection: Node<'vec3'>;
    nightStrength: Node<'float'>;
    twilightStrength: Node<'float'>;
  };
}

export interface LayerOptions<L extends string> {
  /** The layer names, in draw order. */
  layers: readonly L[];
  /** Render order of the first layer's casing (default 20, above the glyphs). */
  renderOrder?: number;
}

export class MilitaryLayer<L extends string = OverlayLayer> {
  readonly group = new Group();
  /** Eye (planet-centered, m), radians per CSS pixel, map scale at the screen center (m per CSS px). */
  readonly eye = uniform(new Vector3());
  readonly pixelAngle = uniform(0.001);
  readonly mapScale = uniform(1000);
  /** Eased fade of the globe, theater and region bands. */
  readonly bandFade = uniform(new Vector3(1, 0, 0));
  /** The camera's screen up (world frame): upright symbols stand on it. */
  readonly screenUp = uniform(new Vector3(0, 1, 0));
  /** Layers on screen (GUI toggles). */
  readonly visible: Record<L, boolean>;
  private readonly meshes = new Map<L, Mesh[]>();
  private readonly materials: MeshBasicNodeMaterial[];
  private readonly layers: readonly L[];
  private readonly baseOrder: number;

  constructor(
    private readonly radius: number,
    private readonly u: MilitaryUniforms,
    options: LayerOptions<L> = { layers: OVERLAY_LAYERS as unknown as readonly L[] },
  ) {
    this.layers = options.layers;
    this.baseOrder = options.renderOrder ?? 20;
    this.visible = Object.fromEntries(this.layers.map((l) => [l, true])) as Record<L, boolean>;
    this.materials = [
      this.segmentMaterial(true),
      this.segmentMaterial(false),
      this.markMaterial(true),
      this.markMaterial(false),
    ];
  }

  /** Displayed planet-centered position of an instance attribute (unit direction, raw height). */
  private ground(a: Node<'vec4'>) {
    return normalize(a.xyz).mul(
      float(this.radius).add(max(a.w, 0).mul(this.u.exaggeration)).add(LIFT),
    );
  }

  /** A color under the map's sun at unit direction `dir` (a varying), or the color itself. */
  private lit(color: Node<'vec3'>, dir: Node<'vec3'>): Node<'vec3'> {
    const d = this.u.daylight;
    if (!d) return color;
    const mu = varying(dot(dir, d.sunDirection)) as F;
    return daylightNode(color, mu, d.nightStrength as F, d.twilightStrength as F);
  }

  private segmentMaterial(casingPass: boolean): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const corner = attribute('position', 'vec3'); // x: 0 at A, 1 at B; y: −1 right, +1 left
    const iA = attribute('iA', 'vec4');
    const iB = attribute('iB', 'vec4');
    const iDist = attribute('iDist', 'vec4'); // dist A, dist B (m), round start, round end
    const iColor = attribute('iColor', 'vec4'); // rgb, width (px)
    const iDash = attribute('iDash', 'vec4'); // period (px, 0 solid), duty, casing (px), casing opacity
    const iTeeth = attribute('iTeeth', 'vec4'); // side (±1, 0 none), base, height, period (px)
    const iTeethColor = attribute('iTeethColor', 'vec4');
    const iBand = attribute('iBand', 'vec4');
    const iCasing = attribute('iCasing', 'vec4'); // casing rgb
    const a = this.ground(iA);
    const b = this.ground(iB);
    const mid = a.add(b).mul(0.5);
    const toEye = this.eye.sub(mid);
    const mpp = length(toEye).mul(this.pixelAngle); // m per px at the segment
    const view = normalize(toEye);
    const seg = b.sub(a);
    const t = normalize(seg);
    const across = normalize(cross(view, t)); // the line's left, seen from above
    const width = iColor.w;
    const half = width.mul(0.5).add(max(iDash.z, 0)).add(abs(iTeeth.x).mul(iTeeth.z)).add(1.5);
    const lengthPx = length(seg).div(mpp);
    const end = corner.x.mul(2).sub(1); // −1 at A, +1 at B
    m.positionNode = mix(a, b, corner.x)
      .add(t.mul(end.mul(half).mul(mpp)))
      .add(across.mul(corner.y.mul(half).mul(mpp)));
    // Varyings packed four to a slot: WebGPU allows 16 inter-stage slots, and three
    // gives each varying its own.
    const geom = varying(
      vec4(
        corner.x.mul(lengthPx).add(end.mul(half)),
        corner.y.mul(half),
        mix(iDist.x, iDist.y, corner.x).add(end.mul(half).mul(mpp)),
        mpp,
      ),
    ) as Node<'vec4'>;
    const facingV = dot(normalize(mid), view);
    const shape = varying(vec4(lengthPx, width.mul(0.5), iDist.z, iDist.w)) as Node<'vec4'>;
    const visibleV = smoothstep(0, 0.04, facingV).mul(dot(iBand.xyz, this.bandFade));
    const color = varying(vec4(iColor.xyz, visibleV)) as Node<'vec4'>;
    const u = geom.x;
    const v = geom.y;
    const dist = geom.z;
    const mppV = geom.w;
    const lenV = shape.x;
    const w2 = shape.y;
    const roundStart = shape.z;
    const roundEnd = shape.w;
    const dash = varying(iDash) as Node<'vec4'>;
    const teeth = varying(iTeeth) as Node<'vec4'>;

    // Distance to the segment (px): rounded ends, or flat ends cut at the end point.
    const along = clamp(u, 0, lenV);
    const dx = u.sub(along);
    const roundD = length(vec2(dx, v)).sub(w2);
    const flatD = max(abs(v).sub(w2), abs(dx));
    const isRound = select(u.lessThan(0), roundStart, roundEnd);
    const lineD = mix(flatD, roundD, isRound).toVar();
    // Dashes along the ground distance (period a power of two in meters).
    const dashPeriod = exp2(round(log2(max(dash.x.mul(this.mapScale), 1))));
    const f = fract(dist.div(dashPeriod));
    const inDash = max(f.negate(), f.sub(dash.y));
    const outDash = min(f.sub(dash.y), float(1).sub(f));
    const dashD = select(f.lessThan(dash.y), inDash, outDash).mul(dashPeriod).div(mppV);
    const dashed = select(dash.x.greaterThan(0), max(lineD, dashD), lineD);
    // Teeth on one side, within the segment's own stretch so bends do not double them.
    const toothPeriod = exp2(round(log2(max(teeth.w.mul(this.mapScale), 1))));
    const tx = fract(dist.div(toothPeriod)).sub(0.5).mul(toothPeriod).div(mppV);
    const ty = v.mul(teeth.x).sub(w2);
    const hb = teeth.y.mul(0.5);
    const h = teeth.z;
    const slant = abs(tx)
      .mul(h)
      .add(ty.mul(hb))
      .sub(hb.mul(h))
      .div(length(vec2(h, hb)).max(1e-3));
    const inside = u.greaterThanEqual(0).and(u.lessThanEqual(lenV));
    const toothD = select(
      abs(teeth.x).greaterThan(0).and(inside),
      max(ty.negate(), slant),
      float(FAR),
    );
    const d = min(dashed, toothD);
    const visible = color.w;
    const midDir = normalize(mid);
    if (casingPass) {
      m.colorNode = this.lit((varying(iCasing) as Node<'vec4'>).xyz, midDir);
      m.opacityNode = clamp(dash.z.add(0.5).sub(d), 0, 1)
        .mul(dash.w)
        .mul(visible)
        .mul(select(dash.z.greaterThan(0), float(1), float(0)));
    } else {
      const toothShare = clamp(dashed.sub(toothD).add(0.5), 0, 1);
      m.colorNode = this.lit(
        mix(color.xyz, (varying(iTeethColor) as Node<'vec4'>).xyz, toothShare),
        midDir,
      );
      m.opacityNode = clamp(float(0.5).sub(d), 0, 1).mul(visible);
    }
    return m;
  }

  private markMaterial(casingPass: boolean): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const corner = attribute('position', 'vec3'); // −1..1
    const iP = attribute('iP', 'vec4');
    const iAxis = attribute('iAxis', 'vec4'); // axis xyz (0: upright), shape (MARK_SHAPES index)
    const iSize = attribute('iSize', 'vec4'); // length, width, outline, casing (px)
    const iColor = attribute('iColor', 'vec4'); // rgb, casing opacity
    const iBand = attribute('iBand', 'vec4');
    const iCasing = attribute('iCasing', 'vec4'); // casing rgb
    const c = this.ground(iP);
    const toEye = this.eye.sub(c);
    const mpp = length(toEye).mul(this.pixelAngle);
    const dir = normalize(iP.xyz);
    // Oriented marks lie flat on the ground along their axis; upright symbols face the
    // screen (billboards), so the map's tilt does not squash them (decision 105).
    const oriented = length(iAxis.xyz).greaterThan(0.5);
    const axis = select(oriented, normalize(iAxis.xyz), normalize(this.screenUp));
    const left = select(
      oriented,
      normalize(cross(dir, axis)),
      normalize(cross(normalize(toEye), this.screenUp)),
    );
    const half = max(iSize.x, iSize.y).add(iSize.w).add(1.5);
    m.positionNode = c.add(axis.mul(corner.x).add(left.mul(corner.y)).mul(half).mul(mpp));
    const visibleV = smoothstep(0, 0.04, dot(dir, normalize(toEye))).mul(
      dot(iBand.xyz, this.bandFade),
    );
    const local = varying(
      vec4(corner.x.mul(half), corner.y.mul(half), iAxis.w, visibleV),
    ) as Node<'vec4'>;
    const x = local.x;
    const y = local.y;
    const shape = local.z;
    const size = varying(iSize) as Node<'vec4'>;
    // Arrowhead: base across the point, tip `length` ahead.
    const len = size.x;
    const hw = size.y.mul(0.5);
    const slant = x
      .mul(hw)
      .add(abs(y).mul(len))
      .sub(hw.mul(len))
      .div(length(vec2(len, hw)).max(1e-3));
    const arrow = max(x.negate(), slant);
    // Diamond centered on the point, hollow with an outline when one is set.
    const hl = len.mul(0.5);
    const solid = abs(x)
      .mul(hw)
      .add(abs(y).mul(hl))
      .sub(hl.mul(hw))
      .div(length(vec2(hl, hw)).max(1e-3));
    const ring = abs(solid.add(size.z.mul(0.5))).sub(size.z.mul(0.5));
    const diamond = select(size.z.greaterThan(0), ring, solid);
    // Map symbols: unit coordinates with x to the right and y up (along the axis).
    const half2 = len.mul(0.5);
    const symbol = symbolDistance(shape, y.negate().div(half2), x.div(half2)).mul(half2);
    const isSymbol = shape.greaterThan(1.5);
    const d = select(isSymbol, symbol, select(shape.lessThan(0.5), arrow, diamond));
    const outer = select(isSymbol, symbol, select(shape.lessThan(0.5), arrow, solid));
    const visible = local.w;
    if (casingPass) {
      m.colorNode = this.lit((varying(iCasing) as Node<'vec4'>).xyz, dir);
      // The casing surrounds the whole mark, inside of a hollow one included.
      m.opacityNode = clamp(size.w.add(0.5).sub(outer), 0, 1)
        .mul((varying(iColor) as Node<'vec4'>).w)
        .mul(visible);
    } else {
      m.colorNode = this.lit((varying(iColor) as Node<'vec4'>).xyz, dir);
      m.opacityNode = clamp(float(0.5).sub(d), 0, 1).mul(visible);
    }
    return m;
  }

  /** Replaces the overlays (null removes them). `heightAt` gives raw terrain height (m). */
  setOverlays(o: MilitaryOverlays<L> | null, heightAt: (p: Readonly<Point>) => number): void {
    for (const list of this.meshes.values()) {
      for (const mesh of list) {
        this.group.remove(mesh);
        if (mesh.userData.ownsGeometry) mesh.geometry.dispose();
      }
    }
    this.meshes.clear();
    if (!o) return;
    this.layers.forEach((layer, i) => {
      const list: Mesh[] = [];
      const segs = this.segmentData(o, layer, heightAt);
      if (segs)
        list.push(...this.pair(this.geometry('segment', segs, segs[0]!.length / 4), 0, 4 * i));
      const marks = this.markData(o, layer, heightAt);
      if (marks)
        list.push(...this.pair(this.geometry('mark', marks, marks[0]!.length / 4), 2, 4 * i + 2));
      if (list.length) {
        this.meshes.set(layer, list);
        this.group.add(...list);
      }
    });
  }

  /**
   * Replaces the overlays of moving things (flights, carriers) every frame: each
   * layer's instance buffers are rewritten in place while they have room, and grow
   * to the next power of two when they do not.
   */
  updateOverlays(o: MilitaryOverlays<L>, heightAt: (p: Readonly<Point>) => number): void {
    this.layers.forEach((layer, i) => {
      const list = this.meshes.get(layer) ?? [];
      const kinds = [
        { kind: 'segment' as const, data: this.segmentData(o, layer, heightAt), material: 0 },
        { kind: 'mark' as const, data: this.markData(o, layer, heightAt), material: 2 },
      ];
      for (const { kind, data, material } of kinds) {
        const names = kind === 'segment' ? SEGMENT_ATTRS : MARK_ATTRS;
        const count = data ? data[0]!.length / 4 : 0;
        const k = list.findIndex((m) => m.userData.kind === kind);
        const mesh = k >= 0 ? list[k]! : null;
        const g = mesh?.geometry as InstancedBufferGeometry | undefined;
        const buffer = mesh?.userData.buffer as InstancedInterleavedBuffer | undefined;
        const capacity = (mesh?.userData.capacity as number | undefined) ?? 0;
        if (g && buffer && count <= capacity) {
          if (data) (buffer.array as Float32Array).set(packInstances(names, data, capacity));
          buffer.needsUpdate = true;
          g.instanceCount = count;
          continue;
        }
        if (count === 0) continue;
        if (mesh) {
          const pairMeshes = list.filter((m) => m.geometry === mesh.geometry);
          for (const m of pairMeshes) {
            this.group.remove(m);
            list.splice(list.indexOf(m), 1);
          }
          mesh.geometry.dispose();
        }
        let cap = 16;
        while (cap < count) cap *= 2;
        const fresh = this.pair(this.geometry(kind, data!, cap), material, 4 * i + material);
        list.push(...fresh);
        this.group.add(...fresh);
      }
      if (list.length) this.meshes.set(layer, list);
    });
  }

  /** Casing and ink meshes sharing one geometry; `order` from the layer's draw order. */
  private pair(g: InstancedBufferGeometry, material: number, order: number): Mesh[] {
    const casing = new Mesh(g, this.materials[material]!);
    const ink = new Mesh(g, this.materials[material + 1]!);
    casing.userData.ownsGeometry = true;
    for (const mesh of [casing, ink]) {
      mesh.userData.kind = g.userData.kind;
      mesh.userData.buffer = g.userData.buffer;
      mesh.userData.capacity = g.userData.capacity;
    }
    casing.renderOrder = this.baseOrder + order;
    ink.renderOrder = this.baseOrder + 1 + order;
    for (const mesh of [casing, ink]) mesh.frustumCulled = false;
    return [casing, ink];
  }

  /** An instanced quad geometry for segments or marks with room for `capacity` instances. */
  private geometry(
    kind: 'segment' | 'mark',
    data: Float32Array[],
    capacity: number,
  ): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    const quad =
      kind === 'segment'
        ? [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]
        : [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
    g.setAttribute('position', new BufferAttribute(new Float32Array(quad), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const buffer = setInstanceAttributes(
      g,
      kind === 'segment' ? SEGMENT_ATTRS : MARK_ATTRS,
      data,
      capacity,
    );
    buffer.setUsage(DynamicDrawUsage);
    g.instanceCount = data[0]!.length / 4;
    g.userData.kind = kind;
    g.userData.buffer = buffer;
    g.userData.capacity = Math.max(capacity, g.instanceCount);
    return g;
  }

  private segmentData(
    o: MilitaryOverlays<L>,
    layer: L,
    heightAt: (p: Readonly<Point>) => number,
  ): Float32Array[] | null {
    const lines = o.lines.filter((l) => l.layer === layer);
    let count = 0;
    for (const l of lines) count += Math.max(0, l.points.length / 3 - 1);
    if (count === 0) return null;
    const data = SEGMENT_ATTRS.map(() => new Float32Array(count * 4));
    const [A, B, D, C, S, T, TC, BN, CS] = data as [
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
    ];
    let k = 0;
    for (const l of lines) {
      const n = l.points.length / 3;
      const s = l.style;
      const color = linear(s.color);
      const teethColor = linear(s.teeth?.color ?? s.color);
      const band = bandMask(l.bands);
      const casing = linear(s.casingColor ?? CASING_COLOR);
      const h = Array.from({ length: n }, (_, i) => heightAt(polylinePoint(l.points, i)));
      let dist = 0;
      for (let i = 0; i + 1 < n; i++, k++) {
        const p = polylinePoint(l.points, i);
        const q = polylinePoint(l.points, i + 1);
        const step = Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])) * this.radius;
        A.set([p[0], p[1], p[2], h[i]!], k * 4);
        B.set([q[0], q[1], q[2], h[i + 1]!], k * 4);
        const first = i === 0;
        const last = i + 2 === n;
        D.set(
          [dist, dist + step, first && !s.roundEnds ? 0 : 1, last && !s.roundEnds ? 0 : 1],
          k * 4,
        );
        dist += step;
        C.set([...color, s.width], k * 4);
        S.set([s.dash, s.duty, s.casing, s.casingOpacity], k * 4);
        T.set(
          s.teeth ? [s.teeth.side, s.teeth.base, s.teeth.height, s.teeth.period] : [0, 0, 0, 1],
          k * 4,
        );
        TC.set([...teethColor, 0], k * 4);
        BN.set([...band, 0], k * 4);
        CS.set([...casing, 0], k * 4);
      }
    }
    return data;
  }

  private markData(
    o: MilitaryOverlays<L>,
    layer: L,
    heightAt: (p: Readonly<Point>) => number,
  ): Float32Array[] | null {
    const marks = o.marks.filter((m) => m.layer === layer);
    if (marks.length === 0) return null;
    const data = MARK_ATTRS.map(() => new Float32Array(marks.length * 4));
    const [P, X, S, C, BN, CS] = data as [
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
      Float32Array,
    ];
    marks.forEach((m, k) => {
      P.set([...m.point, heightAt(m.point)], k * 4);
      X.set([...m.axis, MARK_SHAPES.indexOf(m.shape)], k * 4);
      CS.set([...linear(m.casingColor ?? CASING_COLOR), 0], k * 4);
      S.set([m.length, m.width, m.outline, m.casing], k * 4);
      C.set([...linear(m.color), 0.8], k * 4);
      BN.set([...bandMask(m.bands), 0], k * 4);
    });
    return data;
  }

  /**
   * Places the overlays camera-relative and sets the per-frame uniforms: `pixelAngle`
   * in radians per CSS pixel, `mapScale` in meters per CSS pixel at the screen center,
   * `fade` each band's eased factor.
   */
  update(
    eye: Readonly<Vec3d>,
    pixelAngle: number,
    mapScale: number,
    fade: Record<ZoomBand, number>,
    up?: Readonly<Vec3d>,
  ): void {
    placePlanetCentered(this.group, eye);
    if (up) this.screenUp.value.set(up.x, up.y, up.z);
    this.eye.value.set(eye.x, eye.y, eye.z);
    this.pixelAngle.value = pixelAngle;
    this.mapScale.value = mapScale;
    this.bandFade.value.set(fade.globe, fade.theater, fade.region);
    for (const [layer, list] of this.meshes) for (const m of list) m.visible = this.visible[layer];
  }

  dispose(): void {
    this.setOverlays(null, () => 0);
    for (const m of this.materials) m.dispose();
  }
}
