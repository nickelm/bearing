/**
 * The bridge kit (decision 192): structures assembled from kit specs along a
 * deck line, and the records the alignment gives them.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { assembleBridge, placeBridge } from '../src/render/sim/infra/bridgeKit';
import type { BridgeLine } from '../src/render/sim/infra/bridgeKit';
import { bridgeRecords } from '../src/render/sim/infra/bridgeRecords';
import { STRUCTURE } from '../src/worldgen/networks/alignment';
import { packAlignments } from '../src/worldgen/networks/alignments';
import { CLASS_KEYS, CROSSING_FIELDS, NETWORK } from '../src/worldgen/networks/link';
import type { AlignedLink } from '../src/worldgen/networks/link';
import { gnomonic } from '../src/worldgen/networks/pieces';

const R = PLANET_RADIUS;
const c = latLonToDirection(30 * DEG, -10 * DEG);
const frame = gnomonic(c, R);
const line = (len: number, style: BridgeLine['style'], rail = false): BridgeLine => ({
  points: [frame.toSphere(-len / 2, 0), frame.toSphere(len / 2, 0)],
  deck: [110, 112],
  ground: [104, 105],
  width: 9,
  style,
  rail,
});
const count = (l: BridgeLine, model: string) =>
  placeBridge(l, R).filter((p) => p.model === model).length;

describe('the bridge kit', () => {
  it('rests a beam bridge on wall piers at most 35 m apart, between two abutments', () => {
    const l = line(100, 'beam');
    expect(count(l, 'bridge-pier')).toBe(2);
    expect(count(l, 'bridge-abutment')).toBe(2);
    expect(count(l, 'bridge-deck')).toBe(5);
    expect(count(l, 'bridge-parapet')).toBe(10);
    expect(count(line(30, 'beam'), 'bridge-pier')).toBe(0);
  });

  it('gives a truss bridge panels on both sides and braces, and a railway no parapets', () => {
    const l = line(120, 'truss', true);
    expect(count(l, 'bridge-truss')).toBe(24);
    expect(count(l, 'bridge-brace')).toBe(12);
    expect(count(l, 'bridge-parapet')).toBe(0);
    expect(count(l, 'bridge-pier')).toBe(1);
  });

  it('carries a viaduct on columns', () => {
    expect(count(line(190, 'viaduct'), 'bridge-column')).toBe(4);
    expect(count({ ...line(190, 'viaduct'), width: 30 }, 'bridge-column')).toBe(8);
  });

  it('merges into a geometry whose deck is at the deck elevation, within the budget', () => {
    const g = assembleBridge(line(100, 'beam'), R);
    expect(g.triangles).toBeGreaterThan(100);
    expect(g.triangles).toBeLessThanOrEqual(1500);
    // The highest point is a parapet's top, 0.9 m over the deck at its high end.
    let top = -Infinity;
    let bottom = Infinity;
    const p = new Vec3d();
    for (let i = 0; i < g.position.length; i += 3) {
      p.set(
        g.origin.x + g.position[i]!,
        g.origin.y + g.position[i + 1]!,
        g.origin.z + g.position[i + 2]!,
      );
      const h = p.length() - R;
      top = Math.max(top, h);
      bottom = Math.min(bottom, h);
    }
    expect(top).toBeGreaterThan(112.5);
    expect(top).toBeLessThan(113.2);
    // Piers reach 4 m below the lowest ground (104 m) into the bed.
    expect(bottom).toBeCloseTo(100, 1);
    for (let i = 0; i < g.normal.length; i += 3)
      expect(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!)).toBeCloseTo(1, 4);
  });
});

describe('records', () => {
  it('finds a crossing’s bridge and the viaducts in the alignment record', () => {
    // One link of 12 points 50 m apart: corridor, bridge (3 points), corridor, viaduct (3), corridor.
    const st = [0, 0, 3, 3, 3, 0, 0, 1, 1, 1, 0, 0].map((x) => x as number);
    const pts = st.map((_, i) => frame.toSphere(i * 50, 0));
    const link: AlignedLink = {
      id: 0,
      network: NETWORK.Road,
      line: 3,
      points: Float64Array.from(pts.flatMap((q) => [q.x, q.y, q.z])),
      design: Float32Array.from(st.map((_, i) => 100 + i)),
      ground: Float32Array.from(st.map((s) => (s === STRUCTURE.Corridor ? 100 : 80))),
      structure: Uint8Array.from(st),
      cls: new Uint8Array(st.length).fill(CLASS_KEYS.indexOf('secondary')),
      fellBack: 0,
      forced: 0,
      unrouted: 0,
      violations: 0,
      expansions: 0,
      length: 550,
      crossings: Float64Array.from([150, pts[3]!.x, pts[3]!.y, pts[3]!.z, 7, 40, 70, 106, 1]),
    };
    expect(link.crossings.length).toBe(CROSSING_FIELDS);
    const al = packAlignments([link], R, { ms: 0, tiles: 0 });
    const recs = bridgeRecords(al);
    expect(recs.length).toBe(2);
    const [bridge, viaduct] = recs;
    expect(bridge!.crossing).toBe(0);
    expect(bridge!.line.points.length).toBe(5); // the run and a neighbor each side
    expect(bridge!.line.style).toBe('beam');
    expect(bridge!.length).toBeCloseTo(200, 0);
    expect(viaduct!.crossing).toBe(-1);
    expect(viaduct!.line.style).toBe('viaduct');
    expect(viaduct!.line.points.length).toBe(5);
    expect(bridge!.line.width).toBe(9);
  });
});
