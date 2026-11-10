import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { readWorld } from '../src/campaign';
import { castCampaign, RANGE_FACTOR_MAX, RANGE_FACTOR_MIN } from '../src/campaign/casting';
import { compass } from '../src/campaign/briefing';
import { detectTheaters, strikeClusters } from '../src/campaign/theaters';
import { generateCampaignWorld, MAX_RETRIES, retrySeed } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { buildStrategicGraph } from '../src/worldgen/strategic/builder';
import { boxWorld, graphFingerprint, RADIUS } from './helpers/syntheticWorld';

const RES = 64;
const grid = new CubeGrid(RES);

function castFingerprint(x: unknown): string {
  return JSON.stringify(x, (_k, v: unknown) =>
    ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v,
  );
}

describe('campaign on a synthetic continent with a rear base', () => {
  // A front-sized continent with a ridge, and a rear-base landmass about 1,500 km to its east.
  const input = boxWorld(
    96,
    [
      { lat: [-20, 20], lon: [-80, 20] },
      { lat: [-12, 12], lon: [105, 140] },
    ],
    (_lat, lon) => 2000 * (RADIUS / 6_371_000) * Math.exp(-(((lon + 30) / 1.5) ** 2)),
  );
  const graph = buildStrategicGraph(input);
  const { detection, cast, validity } = readWorld(graph, 1983);

  it('detects a continental front and the strategic theater', () => {
    const kinds = detection.selected.map((t) => t.kind);
    expect(kinds).toContain('continental-front');
    expect(kinds).toContain('strategic');
    expect(kinds).not.toContain('island-campaign');
    for (const t of detection.selected) expect(t.fit).toBeGreaterThan(0);
  });

  it('splits the front landmass between the sides and gives both enough airbase room', () => {
    const front = cast.theaters.find((t) => t.kind === 'continental-front')!;
    const node = graph.fronts[front.front!]!.node;
    const owner = cast.owners[node]!;
    expect(owner.kind).toBe('split');
    expect(cast.airbases.alliance).toBeGreaterThanOrEqual(15);
    expect(cast.airbases.pact).toBeGreaterThanOrEqual(15);
    expect(validity.valid).toBe(true);
    expect(front.attacker).toBe('pact');
  });

  it('links any sea lane to the front it supplies', () => {
    for (const t of cast.theaters.filter((x) => x.kind === 'sea-lane')) {
      const link = cast.links.find((l) => l.from === t.id && l.kind === 'supplies');
      expect(link).toBeDefined();
      expect(cast.theaters[link!.to]!.kind).toBe('continental-front');
      // The rear base is the Alliance's.
      expect(cast.owners[t.nodes[0]!]).toEqual({ kind: 'whole', side: 'alliance' });
    }
  });

  it('chooses a range factor in range and places regions for both sides', () => {
    expect(cast.rangeFactor).toBeGreaterThanOrEqual(RANGE_FACTOR_MIN);
    expect(cast.rangeFactor).toBeLessThanOrEqual(RANGE_FACTOR_MAX);
    expect(cast.rangeTargets.length).toBeGreaterThan(0);
    for (const side of ['alliance', 'pact'] as const) {
      expect(cast.regions.some((r) => r.kind === 'industry' && r.side === side)).toBe(true);
      expect(cast.regions.some((r) => r.kind === 'base' && r.side === side)).toBe(true);
    }
    expect(cast.regions.some((r) => r.kind === 'ground')).toBe(true);
  });

  it('writes a briefing that names every theater', () => {
    expect(cast.briefing.length).toBeGreaterThan(200);
    for (const t of cast.theaters) expect(cast.briefing).toContain(t.name.toUpperCase());
  });

  it('is deterministic and leaves the graph unchanged', () => {
    const before = graphFingerprint(graph);
    const again = castCampaign(graph, detectTheaters(graph), 1983);
    expect(castFingerprint(again)).toBe(castFingerprint(cast));
    expect(graphFingerprint(graph)).toBe(before);
    // Another casting seed may rename things, but detection and territory come from the graph.
    const other = castCampaign(graph, detectTheaters(graph), 'another seed');
    expect(other.theaters.map((t) => t.key)).toEqual(cast.theaters.map((t) => t.key));
    expect(other.owners).toEqual(cast.owners);
    expect(graphFingerprint(graph)).toBe(before);
  });
});

describe('island campaign', () => {
  // Five islands of about 30,000 km², 300–400 km apart: no landmass for a front.
  const boxes = [0, 1, 2, 3, 4].map((i) => ({
    lat: [-5 + (i % 2) * 12, 5 + (i % 2) * 12] as [number, number],
    lon: [i * 22 - 5, i * 22 + 5] as [number, number],
  }));
  const graph = buildStrategicGraph(boxWorld(96, boxes));

  it('clusters the islands and splits them between the sides', () => {
    expect(strikeClusters(graph).some((c) => c.length === 5)).toBe(true);
    const { detection, cast } = readWorld(graph, 5);
    const t = cast.theaters.find((x) => x.kind === 'island-campaign');
    expect(t).toBeDefined();
    expect(detection.selected.some((x) => x.kind === 'continental-front')).toBe(false);
    const sides = t!.nodes.map((id) => cast.owners[id]);
    expect(sides.some((o) => o?.kind === 'whole' && o.side === 'pact')).toBe(true);
    expect(sides.some((o) => o?.kind === 'whole' && o.side === 'alliance')).toBe(true);
  });
});

describe('compass', () => {
  it('names directions on the sphere', () => {
    expect(compass([0, 0, 1], [0, 0.1, 0.995])).toBe('north');
    expect(compass([0, 0, 1], [0.1, 0, 0.995])).toBe('east');
    expect(compass([0, 0, 1], [-0.1, -0.1, 0.99])).toBe('southwest');
  });
});

describe('validity check and retries', () => {
  it('derives distinct, repeatable retry seeds', () => {
    expect(retrySeed(1983, 1)).toBe(retrySeed(1983, 1));
    expect(retrySeed(1983, 1)).not.toBe(retrySeed(1983, 2));
    expect(retrySeed(1983, 1)).not.toBe(retrySeed(1984, 1));
    expect(retrySeed('1983', 3)).toBe(retrySeed(1983, 3));
  });

  it('maps each seed to exactly one world, retries included', () => {
    // Nearly all ocean: no world passes, so every retry runs and the first world is kept.
    const params = { ...DEFAULT_PLANET_PARAMS, seed: 11, oceanFraction: 0.995 };
    const small = new CubeGrid(24);
    const a = generateCampaignWorld(params, { grid: small });
    const b = generateCampaignWorld(params, { grid: small });
    expect(a.campaign.validity.valid).toBe(false);
    expect(a.rejected.length).toBe(MAX_RETRIES + 1);
    expect(a.seed).toBe(b.seed);
    expect(a.seed).toBe(11);
  });

  it('keeps the first valid world of the retry sequence', () => {
    const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid });
    expect(w.campaign.validity.valid).toBe(true);
    expect(w.rejected.length).toBe(w.retries);
    expect(w.seed).toBe(w.retries === 0 ? 7 : retrySeed(7, w.retries));
    const again = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid });
    expect(castFingerprint(again.campaign.cast)).toBe(castFingerprint(w.campaign.cast));
  });
});
