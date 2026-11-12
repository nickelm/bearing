/**
 * The map's settlements and infrastructure (decision 104): roads, railways, symbols,
 * the urban fill's coverage texels, settlement glyphs and their labels.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection, projectToCubeFace } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { DEG } from '../src/core/units';
import {
  capitalModel,
  cityModel,
  townModel,
  villageModel,
} from '../src/render/strategic/glyphGeometry';
import { layoutCityGlyphs } from '../src/render/strategic/infra/cityGlyphs';
import { buildInfraOverlays, smoothPolyline } from '../src/render/strategic/infra/infraModel';
import { urbanTexels } from '../src/render/strategic/infra/urbanTexture';
import { buildLabels } from '../src/render/strategic/labels/labelModel';
import { MARK_SHAPES } from '../src/render/strategic/overlays/militaryModel';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RoadClass, URBAN_VERTICES } from '../src/worldgen/strategic/graph';

describe('map infrastructure on a generated world', () => {
  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(128) },
  );
  const o = buildInfraOverlays(w.graph, w.infrastructure);

  it('draws every road in the Region band and motorways from the Theater band', () => {
    const roads = o.lines.filter((l) => l.layer === 'roads');
    const region = roads.filter((l) => l.bands.includes('region'));
    const theater = roads.filter((l) => l.bands.includes('theater'));
    expect(region.length).toBe(w.graph.roads.count + w.infrastructure.spurs.count);
    const motorways = Array.from(w.graph.roads.roadClass).filter((c) => c === RoadClass.Motorway);
    expect(theater.length).toBe(motorways.length);
    // Casings darker than the ink, from Part II's palette.
    for (const l of roads) expect(l.style.casingColor).toBeDefined();
  });

  it('draws railways with ticks, and symbols for every site', () => {
    const rails = o.lines.filter((l) => l.layer === 'railways');
    expect(rails.length).toBe(2 * w.graph.railways.lines.count);
    expect(rails.some((l) => l.style.dash > 0 && !l.style.roundEnds)).toBe(true);
    const shapes = new Set(o.marks.map((m) => m.shape));
    for (const s of ['airbase', 'port', 'factory', 'star', 'bridge'] as const)
      expect(shapes.has(s), s).toBe(true);
    for (const m of o.marks) expect(MARK_SHAPES).toContain(m.shape);
    const airbases = o.marks.filter((m) => m.shape === 'airbase');
    expect(airbases.length).toBe(2 * w.infrastructure.airbases.length);
    expect(o.marks.filter((m) => m.shape === 'star').length).toBe(2);
    // Bridges and runways lie along a tangent of the ground; other symbols stand upright.
    for (const m of o.marks) {
      const len = Math.hypot(...m.axis);
      if (m.shape === 'bridge' || m.shape === 'airbase') {
        expect(len).toBeCloseTo(1, 5);
        const d = m.axis[0] * m.point[0] + m.axis[1] * m.point[1] + m.axis[2] * m.point[2];
        expect(Math.abs(d)).toBeLessThan(1e-6);
      } else expect(len).toBe(0);
    }
  });

  it('labels capitals and routes', () => {
    const labels = buildLabels(w.graph, w.campaign.cast, () => 0, null, w.infrastructure);
    const capitals = labels.filter((l) => l.style === 'capital');
    expect(capitals.length).toBe(2);
    const roads = labels.filter((l) => l.layer === 'roads');
    expect(roads.length).toBeGreaterThan(0);
    for (const l of roads) {
      expect(l.placement).toBe('line');
      expect(l.bands).toEqual(['region']);
    }
  });

  it('marks capitals with their own glyph at both bands, villages only near the ground', () => {
    const caps = [w.infrastructure.capitals.alliance, w.infrastructure.capitals.pact];
    const sets = layoutCityGlyphs(w.graph.settlements, caps, () => 0);
    const count = (kind: string, band: string) =>
      sets.find((x) => x.kind === kind && x.band === band)?.count ?? 0;
    expect(count('capital', 'theater')).toBe(2);
    expect(count('capital', 'region')).toBe(2);
    expect(count('village', 'theater')).toBe(0);
    expect(count('village', 'region')).toBeGreaterThan(0);
    const total = sets.filter((x) => x.band === 'region').reduce((s, x) => s + x.count, 0);
    expect(total).toBe(w.graph.settlements.cells.length);
  });
});

describe('map infrastructure helpers', () => {
  it('smooths polylines on the sphere and keeps their ends', () => {
    const pts = [0, 10, 20, 30].flatMap((lon, i) => {
      const d = latLonToDirection((i % 2) * DEG, lon * DEG);
      return [d.x, d.y, d.z];
    });
    const s = smoothPolyline(Float64Array.from(pts));
    expect(s.length / 3).toBeGreaterThan(4);
    expect(Array.from(s.subarray(0, 3))).toEqual(pts.slice(0, 3));
    expect(Array.from(s.subarray(s.length - 3))).toEqual(pts.slice(-3));
    for (let i = 0; i < s.length / 3; i++)
      expect(Math.hypot(s[i * 3]!, s[i * 3 + 1]!, s[i * 3 + 2]!)).toBeCloseTo(1, 12);
  });

  it('rasterizes urban polygons into coverage texels', () => {
    const n = 256;
    const c = latLonToDirection(0, 0); // +Z face center
    const r = 0.02; // rad
    const points = new Float64Array(URBAN_VERTICES * 3);
    for (let k = 0; k < URBAN_VERTICES; k++) {
      const a = (k / URBAN_VERTICES) * 2 * Math.PI;
      const d = c.clone();
      d.x += r * Math.cos(a);
      d.y += r * Math.sin(a);
      d.normalize();
      points.set([d.x, d.y, d.z], k * 3);
    }
    const tex = urbanTexels({ points, area: new Float32Array([0]) }, n);
    const uv = projectToCubeFace(c, 4);
    const at = (u: number, v: number) =>
      tex[4 * n * n + Math.floor(v * n) * n + Math.floor(u * n)]!;
    expect(at(uv.u, uv.v)).toBe(255);
    expect(at(uv.u + 0.2, uv.v)).toBe(0);
    let covered = 0;
    for (let i = 4 * n * n; i < 5 * n * n; i++) covered += tex[i]! / 255;
    // Disk of radius r on the face: (r / (π/2) · n)² · π texels, near the face center.
    const expected = Math.PI * ((r / (Math.PI / 2)) * n) ** 2;
    expect(covered).toBeGreaterThan(0.9 * expected);
    expect(covered).toBeLessThan(1.1 * expected);
  });

  it('builds closed settlement models standing on the ground', () => {
    for (const make of [villageModel, townModel, cityModel, capitalModel]) {
      const m = make();
      expect(m.position.length % 9).toBe(0);
      expect(m.part.length).toBe(m.position.length / 3);
      for (let i = 2; i < m.position.length; i += 3)
        expect(m.position[i]!).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < m.position.length; i += 3)
        expect(Math.hypot(m.position[i]!, m.position[i + 1]!)).toBeLessThan(0.7);
      expect(Array.from(m.part)).toContain(1);
    }
  });
});
