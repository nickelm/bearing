/**
 * Carrier groups in the cast (design, "Naval Forces"; decision 56). Casting
 * assigns them to sides and theaters; the sim moves them (sim/naval/) and
 * their air wings fly the ATO's missions from the group's position.
 *
 * - **Where.** Only theaters at sea get carriers. The Alliance sends one to
 *   each sea-lane, chokepoint and island-campaign theater, at most
 *   MAX_CARRIERS.alliance; the Pact one to each island campaign (its armada)
 *   and chokepoint, at most MAX_CARRIERS.pact. Theaters are taken in cast
 *   order.
 * - **Station.** A group starts the war on station: it patrols a stretch of
 *   a sea lane (graph.lanes) back and forth. Lanes are least-cost routes
 *   over the coarse ocean grid, so the track stays at sea.
 *   - Sea lane: 30% of the way from the front's end, covering the convoys
 *     where the enemy can reach them.
 *   - Chokepoint: CHOKEPOINT_STANDOFF from the chokepoint along its lane,
 *     the Alliance toward the lane's rear base, the Pact toward the other end.
 *   - Island campaign: on the shortest lane between a Pact and an Alliance
 *     island group, 30% of the way from the group's own end for the
 *     Alliance and 40% for the Pact, which moves against the islands.
 * - **Track.** PATROL_LENGTH of lane centered on the station (shorter on a
 *   short lane), kept PORT_MARGIN clear of the lane's ports.
 *
 * Names come from fixed lists, shuffled by a fork of the casting stream, so
 * nothing else in casting changes.
 */
import type { Rng } from '../core/rng';
import { nearestStation, polylineStations, subPolyline } from '../core/greatCircle';
import type { StrategicGraph } from '../worldgen/strategic/graph';
import type { CarrierGroupCast, NodeOwner, Side, Theater } from './cast';

export const MAX_CARRIERS: Record<Side, number> = { alliance: 3, pact: 2 };
/** Length of lane a group patrols (m). */
export const PATROL_LENGTH = 160e3;
/** Distance from a chokepoint to a group's station (m). */
export const CHOKEPOINT_STANDOFF = 150e3;
/** A track keeps at least this far from either end of its lane (m), or a fifth of a short lane. */
export const PORT_MARGIN = 60e3;

const ALLIANCE_NAMES = ['Resolute', 'Steadfast', 'Vigilant', 'Dauntless', 'Sovereign', 'Tenacity'];
const PACT_NAMES = ['Kolchin', 'Severov', 'Lazarin', 'Orlovsky', 'Grebnev', 'Dmitrenko'];

function shuffled<T>(list: readonly T[], r: Rng): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function wholeSide(o: NodeOwner | undefined): Side | null {
  return o?.kind === 'whole' ? o.side : null;
}

interface Station {
  theater: Theater;
  lane: number;
  /** Arc length of the station along the lane, from its point 0 (m). */
  at: number;
}

/** Station of `side`'s group in theater t, or null if it has no lane to patrol. */
function stationFor(
  graph: StrategicGraph,
  theaters: readonly Theater[],
  owners: readonly NodeOwner[],
  t: Theater,
  side: Side,
): Station | null {
  const R = graph.radius;
  if (t.kind === 'sea-lane' && t.lane !== undefined) {
    const lane = graph.lanes[t.lane]!;
    const frontNode = t.nodes[1];
    const fromFront = 0.3 * lane.length;
    return {
      theater: t,
      lane: lane.id,
      at: lane.a === frontNode ? fromFront : lane.length - fromFront,
    };
  }
  if (t.kind === 'chokepoint' && t.lane !== undefined && t.chokepoint !== undefined) {
    const lane = graph.lanes[t.lane]!;
    const s = polylineStations(lane.points, R);
    const at = nearestStation(lane.points, s, graph.chokepoints[t.chokepoint]!.point);
    // The lane's rear base: the sea-lane theater on this lane names it first.
    const laneTheater = theaters.find((x) => x.kind === 'sea-lane' && x.lane === t.lane);
    const rear = laneTheater?.nodes[0] ?? lane.a;
    const towardEnd = (rear === lane.b) === (side === 'alliance');
    return { theater: t, lane: lane.id, at: at + (towardEnd ? 1 : -1) * CHOKEPOINT_STANDOFF };
  }
  if (t.kind === 'island-campaign') {
    const inTheater = new Set(t.nodes);
    let best = -1;
    for (const lane of graph.lanes) {
      if (!inTheater.has(lane.a) || !inTheater.has(lane.b)) continue;
      const sa = wholeSide(owners[lane.a]);
      const sb = wholeSide(owners[lane.b]);
      if (!sa || !sb || sa === sb) continue;
      if (best < 0 || lane.length < graph.lanes[best]!.length) best = lane.id;
    }
    if (best < 0) return null;
    const lane = graph.lanes[best]!;
    const share = side === 'alliance' ? 0.3 : 0.4;
    const ownAtA = wholeSide(owners[lane.a]) === side;
    return {
      theater: t,
      lane: lane.id,
      at: ownAtA ? share * lane.length : (1 - share) * lane.length,
    };
  }
  return null;
}

/** The cast's carrier groups (see the module comment). */
export function castCarrierGroups(
  graph: StrategicGraph,
  theaters: readonly Theater[],
  owners: readonly NodeOwner[],
  r: Rng,
): CarrierGroupCast[] {
  const R = graph.radius;
  const out: CarrierGroupCast[] = [];
  const names: Record<Side, string[]> = {
    alliance: shuffled(ALLIANCE_NAMES, r.fork('alliance')),
    pact: shuffled(PACT_NAMES, r.fork('pact')),
  };
  const kinds: Record<Side, readonly string[]> = {
    alliance: ['sea-lane', 'chokepoint', 'island-campaign'],
    pact: ['island-campaign', 'chokepoint'],
  };
  for (const side of ['alliance', 'pact'] as const) {
    let n = 0;
    for (const t of theaters) {
      if (n >= MAX_CARRIERS[side] || !kinds[side].includes(t.kind)) continue;
      const st = stationFor(graph, theaters, owners, t, side);
      if (!st) continue;
      const lane = graph.lanes[st.lane]!;
      const stations = polylineStations(lane.points, R);
      const length = stations[stations.length - 1]!;
      const margin = Math.min(PORT_MARGIN, 0.2 * length);
      const half = Math.min(PATROL_LENGTH, length - 2 * margin) / 2;
      const center = Math.min(Math.max(st.at, margin + half), length - margin - half);
      const track = subPolyline(lane.points, stations, center - half, center + half);
      const hull = side === 'alliance' ? `CVN-${73 + n} ` : 'Admiral ';
      out.push({
        id: out.length,
        side,
        name: hull + names[side][n % names[side].length]!,
        theater: t.id,
        lane: lane.id,
        track,
      });
      n++;
    }
  }
  return out;
}
