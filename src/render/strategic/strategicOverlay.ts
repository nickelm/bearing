/**
 * Strategic graph debug overlay (design, "Reading the World"): nodes, sea
 * lanes, chokepoints, barrier lines, the start line, corridors, territory and
 * the cast's regions, drawn as lines over the globe.
 *
 * - **Geometry.** One LineSegments mesh, vertices at unit directions × R
 *   relative to the planet center. The group sits at planet center − eye
 *   (float64 subtraction first, decision on camera-relative rendering) and is
 *   scaled to R + lift, so lines clear the exaggerated terrain.
 * - **Colors.** Sea lanes cyan (theater lanes bright); barrier lines orange
 *   to dark red by strength; the start line red; corridors yellow arrows;
 *   straits magenta and chokepoint islands orange (theater chokepoints
 *   yellow); node rings blue for the Alliance, red for the Pact, purple for a
 *   split front landmass, gray for neutral; regions as circles (industry
 *   orange, bases white, ports blue, ground combat red).
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
} from 'three/webgpu';
import type { Cast, Region } from '../../campaign/cast';
import type { Point, StrategicGraph } from '../../worldgen/strategic/graph';
import { polylinePoint } from '../../worldgen/strategic/graph';
import { Vec3d } from '../../core/vec3d';

type Rgb = [number, number, number];

const LANE: Rgb = [0.15, 0.45, 0.55];
const LANE_ACTIVE: Rgb = [0.35, 0.95, 1];
const START: Rgb = [1, 0.12, 0.1];
const CORRIDOR: Rgb = [1, 0.95, 0.2];
const STRAIT: Rgb = [1, 0.3, 1];
const ISLAND: Rgb = [1, 0.6, 0.15];
const ACTIVE_CHOKE: Rgb = [1, 1, 0.3];
const ALLIANCE: Rgb = [0.3, 0.55, 1];
const PACT: Rgb = [1, 0.25, 0.2];
const SPLIT: Rgb = [0.75, 0.4, 1];
const NEUTRAL: Rgb = [0.6, 0.6, 0.6];
const REGION: Record<Region['kind'], Rgb> = {
  industry: [1, 0.6, 0.1],
  base: [0.95, 0.95, 0.95],
  port: [0.3, 0.6, 1],
  ground: [1, 0.3, 0.3],
};

function barrierColor(s: number): Rgb {
  return [1 - 0.4 * s, 0.75 * (1 - s), 0.1];
}

class LineBuilder {
  readonly positions: number[] = [];
  readonly colors: number[] = [];

  constructor(private readonly radius: number) {}

  private vertex(p: Readonly<Point>, c: Readonly<Rgb>): void {
    this.positions.push(p[0] * this.radius, p[1] * this.radius, p[2] * this.radius);
    this.colors.push(c[0], c[1], c[2]);
  }

  /** Great-circle segment, split so chords stay close to the sphere. */
  segment(a: Readonly<Point>, b: Readonly<Point>, c: Readonly<Rgb>): void {
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const angle = Math.acos(dot);
    const steps = Math.max(1, Math.ceil(angle / 0.01));
    const s = Math.sin(angle);
    let prev: Point = [a[0], a[1], a[2]];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      let p: Point;
      if (s < 1e-9) p = [b[0], b[1], b[2]];
      else {
        const wa = Math.sin((1 - t) * angle) / s;
        const wb = Math.sin(t * angle) / s;
        p = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
      }
      this.vertex(prev, c);
      this.vertex(p, c);
      prev = p;
    }
  }

  polyline(points: Float64Array, color: (i: number) => Readonly<Rgb>): void {
    const n = points.length / 3;
    for (let i = 1; i < n; i++)
      this.segment(polylinePoint(points, i - 1), polylinePoint(points, i), color(i));
  }

  /** Circle of surface radius `r` (m) around `center`; `dashed` skips every other segment. */
  circle(center: Readonly<Point>, r: number, c: Readonly<Rgb>, dashed = false): void {
    const ang = r / this.radius;
    const n = new Vec3d(...center);
    const ref = Math.abs(n.y) < 0.9 ? new Vec3d(0, 1, 0) : new Vec3d(1, 0, 0);
    const e1 = ref.clone().cross(n).normalize();
    const e2 = n.clone().cross(e1);
    const k = 32;
    const at = (i: number): Point => {
      const t = (i / k) * 2 * Math.PI;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      return [
        n.x * cs + (e1.x * Math.cos(t) + e2.x * Math.sin(t)) * sn,
        n.y * cs + (e1.y * Math.cos(t) + e2.y * Math.sin(t)) * sn,
        n.z * cs + (e1.z * Math.cos(t) + e2.z * Math.sin(t)) * sn,
      ];
    };
    for (let i = 0; i < k; i++) {
      if (dashed && i % 2 === 1) continue;
      this.vertex(at(i), c);
      this.vertex(at(i + 1), c);
    }
  }
}

export class StrategicOverlay {
  readonly group = new Group();
  enabled = true;
  private mesh: LineSegments | null = null;
  private readonly material = new LineBasicNodeMaterial({ vertexColors: true });
  private readonly scratch = new Vec3d();

  constructor(private readonly radius: number) {
    this.material.depthWrite = false;
    this.group.visible = false;
  }

  setWorld(graph: StrategicGraph | null, cast: Cast | null): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (!graph) return;
    const b = new LineBuilder(this.radius);
    const activeLanes = new Set(
      cast?.theaters.filter((t) => t.kind === 'sea-lane').map((t) => t.lane!) ?? [],
    );
    const activeChokes = new Set(
      cast?.theaters.filter((t) => t.kind === 'chokepoint').map((t) => t.chokepoint!) ?? [],
    );
    for (const lane of graph.lanes) {
      const c = activeLanes.has(lane.id) ? LANE_ACTIVE : LANE;
      b.polyline(lane.points, () => c);
    }
    for (const f of graph.fronts) {
      for (const id of f.lines) {
        const line = graph.barrierLines[id]!;
        b.polyline(line.points, (i) => (id === f.start ? START : barrierColor(line.strength[i]!)));
      }
      for (const k of f.corridors) {
        if (k.line !== f.start) continue;
        b.segment(k.from, k.to, CORRIDOR);
        b.circle(k.to, 15e3, CORRIDOR);
      }
    }
    for (const k of graph.chokepoints) {
      const c = activeChokes.has(k.id) ? ACTIVE_CHOKE : k.kind === 'strait' ? STRAIT : ISLAND;
      b.circle(k.point, 35e3, c);
      b.circle(k.point, 25e3, c);
    }
    graph.nodes.forEach((n, i) => {
      const owner = cast?.owners[i];
      const c =
        !owner || owner.kind === 'neutral'
          ? NEUTRAL
          : owner.kind === 'split'
            ? SPLIT
            : owner.side === 'alliance'
              ? ALLIANCE
              : PACT;
      b.circle(n.centroid, n.kind === 'landmass' ? 60e3 : 40e3, c);
      b.circle(n.centroid, 10e3, c);
    });
    if (cast) {
      for (const r of cast.regions)
        b.circle(r.point, r.radius, REGION[r.kind], r.kind === 'ground');
      // Side centroids of each front: a ring in the side's color.
      for (const t of cast.theaters) {
        if (t.kind !== 'continental-front') continue;
        const f = graph.fronts[t.front!]!;
        const line = graph.barrierLines[f.start]!;
        b.circle(line.sides[f.forwardSide].centroid, 80e3, PACT);
        b.circle(line.sides[f.forwardSide === 1 ? 0 : 1].centroid, 80e3, ALLIANCE);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(b.positions, 3));
    geo.setAttribute('color', new Float32BufferAttribute(b.colors, 3));
    this.mesh = new LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  /** Places the overlay camera-relative, `lift` meters above sea level. */
  update(eye: Readonly<Vec3d>, lift: number): void {
    this.group.visible = this.enabled && this.mesh !== null;
    if (!this.group.visible) return;
    this.scratch.set(-eye.x, -eye.y, -eye.z);
    this.group.position.set(this.scratch.x, this.scratch.y, this.scratch.z);
    this.group.scale.setScalar((this.radius + lift) / this.radius);
  }

  dispose(): void {
    this.setWorld(null, null);
    this.material.dispose();
  }
}
