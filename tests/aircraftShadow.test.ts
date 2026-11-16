/**
 * The flown aircraft's shadow (decision 170): one mesh flattened along the sun onto
 * a plane fitted to the ground where it falls, its shade per vertex (body 1, blades
 * at their opacity, the disc at its band alpha), hidden sources collapsed so they
 * write no depth.
 */
import { describe, expect, it } from 'vitest';
import type { BufferAttribute } from 'three/webgpu';
import { Quatd } from '../src/core/quat';
import { Vec3d } from '../src/core/vec3d';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { AircraftView } from '../src/render/sim/aircraft/aircraftView';
import type { AircraftPose } from '../src/render/sim/aircraft/aircraftView';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';

const R = 1_000_000;
/** Ground rising 0.3 m per m toward +X (east at the point (0, 0, R)), 100 m at x = 0. */
const slope = (d: Readonly<Vec3d>) => 100 + 0.3 * R * (d.x / d.z);

function setup(rotorSpeed: number, ground?: (d: Readonly<Vec3d>) => number) {
  const spec = MODEL_SPECS['alliance-scout-helo']!;
  const view = new AircraftView(spec, [-0.05, 1.15, 0], new PlanetLighting(R));
  view.planetRadius = R;
  view.sun.set(0.25, 0.15, 1).normalize();
  const pos = new Vec3d(0, 0, R + 100 + 8);
  const pose: AircraftPose = {
    pos,
    q: new Quatd(),
    elevator: 0,
    aileron: 0,
    rudder: 0,
    gear: 1,
    speedbrake: 0,
    afterburner: 0,
    flaps: 0,
    groundHeight: ground ? ground(pos.clone().normalize()) : 100,
    ground,
    rotors: [
      { azimuth: 0.3, speed: rotorSpeed, tiltForward: 0, tiltRight: 0 },
      { azimuth: 0.1, speed: rotorSpeed, tiltForward: 0, tiltRight: 0 },
    ],
  };
  const eye = new Vec3d(-20, 0, R + 120);
  view.update(pose, eye);
  const g = view.shadowMesh.geometry;
  const pts = (g.getAttribute('position') as BufferAttribute).array as Float32Array;
  const shade = (g.getAttribute('shade') as BufferAttribute).array as Float32Array;
  return { view, pts, shade, eye, pose };
}

/** The live (non-collapsed) shadow vertices, camera-relative. */
function live(pts: Float32Array, shade: Float32Array): Vec3d[] {
  const out: Vec3d[] = [];
  for (let i = 0; i < shade.length; i++)
    if (shade[i]! > 0) out.push(new Vec3d(pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!));
  return out;
}

describe('aircraft shadow', () => {
  it('lies on a plane along the ground slope where the shadow falls', () => {
    const { view, pts, shade, eye } = setup(1, slope);
    expect(view.shadowMesh.visible).toBe(true);
    const p = live(pts, shade);
    expect(p.length).toBeGreaterThan(300);
    // The plane through three far-apart points; every point on it within a millimeter.
    const a = p[0]!;
    let b = p[1]!;
    for (const q of p) if (q.distanceTo(a) > b.distanceTo(a)) b = q;
    let c = p[2]!;
    const ab = b.clone().sub(a);
    for (const q of p)
      if (q.clone().sub(a).cross(ab).length() > c.clone().sub(a).cross(ab).length()) c = q;
    const n = ab.cross(c.clone().sub(a)).normalize();
    if (n.z < 0) n.scale(-1);
    for (const q of p) expect(Math.abs(q.clone().sub(a).dot(n))).toBeLessThan(2e-3);
    // Along the slope: (−0.3, 0, 1) normalized.
    const want = new Vec3d(-0.3, 0, 1).normalize();
    expect(n.dot(want)).toBeGreaterThan(Math.cos(0.5 * (Math.PI / 180)));
    // A few centimeters above the drawn ground at its middle.
    const mid = p.reduce((s, q) => s.add(q), new Vec3d()).scale(1 / p.length).add(eye);
    const above = mid.length() - (R + slope(mid.clone().normalize()));
    expect(above).toBeGreaterThan(0.02);
    expect(above).toBeLessThan(0.3);
  });

  it('lies level at the ground height without a ground query', () => {
    const { pts, shade, eye } = setup(1);
    for (const q of live(pts, shade)) {
      const h = q.clone().add(eye).length() - R;
      expect(h).toBeGreaterThan(100.02);
      expect(h).toBeLessThan(100.3);
    }
  });

  it('shades the body fully, the disc by its bands and collapses hidden sources', () => {
    // Full rotor speed: the disc alone, the blades hidden.
    const fast = setup(1, slope);
    const body = fast.shade.filter((x) => x === 1).length;
    expect(body).toBeGreaterThan(100);
    const disc = fast.shade.filter((x) => x > 0 && x < 1);
    expect(disc.length).toBeGreaterThan(20);
    expect(Math.max(...disc)).toBeLessThanOrEqual(0.45 + 1e-6);
    // Stopped: the blades at full shade join the body's, the disc is hidden.
    const slow = setup(0, slope);
    expect(slow.shade.filter((x) => x === 1).length).toBeGreaterThan(body);
    expect(slow.shade.filter((x) => x > 0 && x < 1).length).toBe(0);
    // Hidden sources' triangles collapse to one point, so they draw nothing.
    for (const t of [fast, slow])
      for (let i = 0; i < t.shade.length; i++)
        if (t.shade[i] === 0) expect([t.pts[3 * i], t.pts[3 * i + 1], t.pts[3 * i + 2]]).toEqual([0, 0, 0]);
  });

  it('shows below 400 m with the sun up, and not below a low sun', () => {
    const t = setup(1, slope);
    expect(t.view.shadowMesh.visible).toBe(true);
    t.view.sun.set(1, 0, 0.03).normalize();
    t.view.update(t.pose, t.eye);
    expect(t.view.shadowMesh.visible).toBe(false);
  });
});
