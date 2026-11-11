/**
 * Naming (design pipeline step 8; decision 96): every named feature, every
 * settlement and every invasion corridor gets a name from `rng(seed, "names")`.
 *
 * - **Naming regions.** One flavor per land node for now (design open question).
 *   Landmass nodes, largest first, cycle through the land flavors in an order
 *   shuffled by `names/flavors`; archipelago nodes take the island flavor. Water
 *   and small islands in no node take the flavor of the node whose land is nearest
 *   (the feature's `region`).
 * - **Streams.** Features draw from `names/features` in id order, settlements from
 *   `names/settlements` in placement order, corridors from `names/corridors` in
 *   front order, so a change in one list leaves the others' names alone.
 * - **Generic terms.** See `featureName`.
 */
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { FeatureKind, STRAIT_MAX_WIDTH } from '../strategic/graph';
import type { StrategicGraph } from '../strategic/graph';
import { ISLAND_FLAVOR, LAND_FLAVORS } from './flavors';
import { Toponymy } from './toponymy';

export { FLAVORS } from './flavors';
export { Toponymy } from './toponymy';
export { labelText } from '../strategic/graph';

/** Flavor per land node (decision 96). */
export function assignFlavors(graph: StrategicGraph, seed: WorldSeed): Uint8Array {
  const r = rng(seed, 'names').fork('flavors');
  const order = [...LAND_FLAVORS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const out = new Uint8Array(graph.nodes.length);
  const land = graph.nodes
    .map((n, id) => ({ n, id }))
    .filter((x) => x.n.kind === 'landmass')
    .sort((a, b) => b.n.area - a.n.area || a.id - b.id);
  land.forEach((x, i) => (out[x.id] = order[i % order.length]!));
  graph.nodes.forEach((n, id) => {
    if (n.kind === 'archipelago') out[id] = ISLAND_FLAVOR;
  });
  return out;
}

/** A feature's full name from a fresh proper name (or land name). */
export function featureName(
  t: Toponymy,
  kind: FeatureKind,
  flavor: number,
  info: { size: number; measure: number; parent: number },
): string {
  const pick = (a: string, b: string) => (t.chance(0.5) ? a : b);
  switch (kind) {
    case FeatureKind.Continent:
      return t.land(flavor);
    case FeatureKind.Island:
      return info.size < 20_000e6 ? `${t.proper(flavor)} Island` : t.land(flavor);
    case FeatureKind.Archipelago:
      return `the ${t.proper(flavor)} Islands`;
    case FeatureKind.Ocean:
      return `the ${t.proper(flavor)} Ocean`;
    case FeatureKind.Sea:
      return `the ${t.proper(flavor)} Sea`;
    case FeatureKind.Bay:
      return info.size >= 15_000e6 ? `the Gulf of ${t.proper(flavor)}` : `${t.proper(flavor)} Bay`;
    case FeatureKind.Strait:
      return info.measure < STRAIT_MAX_WIDTH / 4
        ? `the ${t.proper(flavor)} Narrows`
        : `the ${t.proper(flavor)} Strait`;
    case FeatureKind.Lake:
      return `Lake ${t.proper(flavor)}`;
    case FeatureKind.Range:
      return `the ${t.proper(flavor)} ${pick('Range', 'Mountains')}`;
    case FeatureKind.Peak:
      return `Mount ${t.proper(flavor)}`;
    case FeatureKind.Hills:
      return `the ${t.proper(flavor)} Hills`;
    case FeatureKind.Plain:
      return `the ${t.proper(flavor)} Plain`;
    case FeatureKind.Plateau:
      return `the ${t.proper(flavor)} Plateau`;
    case FeatureKind.Desert:
      return info.measure >= 0.5
        ? `the ${t.proper(flavor)} Desert`
        : `the ${t.proper(flavor)} Waste`;
    case FeatureKind.Forest:
      return info.size < 60_000e6
        ? `the ${t.proper(flavor)} Woods`
        : `the ${t.proper(flavor)} Forest`;
    case FeatureKind.Wetland:
      return `the ${t.proper(flavor)} ${pick('Marshes', 'Fens')}`;
    case FeatureKind.River:
      return `the ${t.proper(flavor)} River`;
  }
}

/** Names features, settlements and corridors in place. */
export function nameWorld(graph: StrategicGraph, seed: WorldSeed): void {
  const flavors = assignFlavors(graph, seed);
  graph.nodes.forEach((n, id) => (n.flavor = flavors[id]!));
  const flavorOf = (region: number) => (region >= 0 ? flavors[region]! : LAND_FLAVORS[0]!);
  const base = rng(seed, 'names');

  // One generator keeps every name in the world unique; each list has its own stream.
  const f = graph.features;
  const tf = new Toponymy(base.fork('features'));
  for (let i = 0; i < f.count; i++) {
    f.names[i] = featureName(tf, f.kind[i] as FeatureKind, flavorOf(f.region[i]!), {
      size: f.size[i]!,
      measure: f.measure[i]!,
      parent: f.parent[i]!,
    });
  }

  const s = graph.settlements;
  const ts = new Toponymy(base.fork('settlements'));
  const taken = new Set(f.names);
  for (let i = 0; i < s.cells.length; i++) {
    let name = ts.town(flavorOf(s.node[i]!));
    while (taken.has(name)) name = ts.town(flavorOf(s.node[i]!));
    taken.add(name);
    s.names[i] = name;
  }

  const tc = new Toponymy(base.fork('corridors'));
  for (const front of graph.fronts) {
    const flavor = flavorOf(front.node);
    for (const c of front.corridors) {
      let name = `the ${tc.proper(flavor)} Gap`;
      while (taken.has(name)) name = `the ${tc.proper(flavor)} Gap`;
      taken.add(name);
      c.name = name;
    }
  }
}
