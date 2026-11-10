/**
 * Theater detection (design, "Theaters"). A theater module has a precondition
 * on the strategic graph, a fit score in [0, 1] and a threshold. Detection
 * runs the registry in order; later modules see the theaters selected so far
 * (sea lanes need a front, chokepoints need an active lane, the island
 * campaign needs the absence of a front, and the strategic theater needs any
 * other theater).
 *
 * Reads the strategic graph only (decision 52). Deterministic and draws no
 * random numbers: ties break by key.
 */
import type { FrontGeometry, LandNode, StrategicGraph } from '../worldgen/strategic/graph';
import { FRONT_MIN_AREA, FRONT_MIN_SIDE, nodeDistance } from '../worldgen/strategic/graph';

export type TheaterKind =
  'continental-front' | 'sea-lane' | 'chokepoint' | 'island-campaign' | 'strategic';

export const THEATER_LABELS: Record<TheaterKind, string> = {
  'continental-front': 'Continental front',
  'sea-lane': 'Sea lane',
  chokepoint: 'Chokepoint',
  'island-campaign': 'Island campaign',
  strategic: 'Strategic',
};

/** A theater the graph supports, with its fit score. */
export interface TheaterCandidate {
  kind: TheaterKind;
  /** Stable id, e.g. "front:0", "lane:3", "choke:2", "islands:1", "strategic". */
  key: string;
  fit: number;
  /** Whether fit reaches the module's threshold. */
  selected: boolean;
  /** Land nodes involved. For a sea lane: [rear base, front node]. */
  nodes: number[];
  /** Index into graph.fronts (continental front). */
  front?: number;
  /** Sea lane id (sea lane, and the active lane a chokepoint sits on). */
  lane?: number;
  chokepoint?: number;
  /** Short explanation of the fit, for the seed browser. */
  note: string;
}

export interface TheaterModule {
  kind: TheaterKind;
  threshold: number;
  /** Candidates with fit scores; `selected` is filled in by `detectTheaters`. */
  detect(graph: StrategicGraph, selectedSoFar: readonly TheaterCandidate[]): TheaterCandidate[];
}

// ---- Tuning (design open question: fit thresholds; see the seed browser) ----

/** Sea-lane theater lengths (m). */
export const LANE_MIN = 800e3;
export const LANE_MAX = 3000e3;
/** Nodes within this coast-to-coast distance are in mutual strike range (m). */
export const ISLAND_STRIKE_RANGE = 600e3;
/** Airbase sites a side needs on its part of a front for a full fit. */
export const FRONT_SIDE_AIRBASES = 15;
/** Sea lanes per front and chokepoints per lane kept by detection. */
export const LANES_PER_FRONT = 2;
export const CHOKEPOINTS_PER_LANE = 2;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Airbase sites on each side of a barrier line: [side 0, side 1]. */
export function airbasesBySide(graph: StrategicGraph, line: number): [number, number] {
  const l = graph.barrierLines[line]!;
  let a = 0;
  let b = 0;
  for (const off of l.airbaseOffset) {
    if (off < 0) a++;
    else if (off > 0) b++;
  }
  return [a, b];
}

/** The defender's side of a front's start line (the side holding the strongest line). */
export function defenderSide(f: FrontGeometry): 0 | 1 {
  return f.forwardSide === 1 ? 0 : 1;
}

export const continentalFront: TheaterModule = {
  kind: 'continental-front',
  threshold: 0.35,
  detect(graph) {
    const out: TheaterCandidate[] = [];
    graph.fronts.forEach((f, i) => {
      if (f.start < 0) return;
      const node = graph.nodes[f.node]!;
      const line = graph.barrierLines[f.start]!;
      const minSide = Math.min(line.sides[0].fraction, line.sides[1].fraction);
      const size = smooth(FRONT_MIN_AREA, 6 * FRONT_MIN_AREA, node.area);
      const balance = clamp01((minSide - FRONT_MIN_SIDE) / (0.5 - FRONT_MIN_SIDE));
      const [a, b] = airbasesBySide(graph, f.start);
      const bases = clamp01(Math.min(a, b) / FRONT_SIDE_AIRBASES);
      const fit = size * (0.7 + 0.3 * balance) * bases;
      out.push({
        kind: 'continental-front',
        key: `front:${i}`,
        fit,
        selected: false,
        nodes: [f.node],
        front: i,
        note: `${(node.area / 1e12).toFixed(2)} M km², split ${Math.round(minSide * 100)}%, bases ${a}/${b}`,
      });
    });
    return out;
  },
};

/** Fit of a lane length: 1 between 1,200 and 2,400 km, falling to 0.4 at the limits. */
function laneLengthFit(length: number): number {
  if (length < LANE_MIN || length > LANE_MAX) return 0;
  if (length < 1200e3) return 0.4 + (0.6 * (length - LANE_MIN)) / (1200e3 - LANE_MIN);
  if (length > 2400e3) return 0.4 + (0.6 * (LANE_MAX - length)) / (LANE_MAX - 2400e3);
  return 1;
}

export const seaLane: TheaterModule = {
  kind: 'sea-lane',
  threshold: 0.4,
  detect(graph, selected) {
    const out: TheaterCandidate[] = [];
    for (const ft of selected.filter((t) => t.kind === 'continental-front')) {
      const f = graph.fronts[ft.front!]!;
      const start = graph.barrierLines[f.start]!;
      const defender = defenderSide(f);
      const perFront: TheaterCandidate[] = [];
      for (const lane of graph.lanes) {
        if (lane.a !== f.node && lane.b !== f.node) continue;
        const rear = lane.a === f.node ? lane.b : lane.a;
        const port = lane.a === f.node ? lane.portA : lane.portB;
        // The lane must land on the defender's side: it supplies the defense.
        const off = start.portOffset[port]!;
        if (defender === 0 ? off > 0 : off < 0) continue;
        const base: LandNode = graph.nodes[rear]!;
        const quality = smooth(5, 30, base.airbases.cells.length);
        const fit = laneLengthFit(lane.length) * quality * (1 - 0.5 * lane.ice);
        perFront.push({
          kind: 'sea-lane',
          key: `lane:${lane.id}`,
          fit,
          selected: false,
          nodes: [rear, f.node],
          lane: lane.id,
          front: ft.front,
          note: `${Math.round(lane.length / 1e3)} km, rear base ${base.airbases.cells.length} sites`,
        });
      }
      perFront.sort((x, y) => y.fit - x.fit || x.key.localeCompare(y.key));
      out.push(...perFront.slice(0, LANES_PER_FRONT));
    }
    return out;
  },
};

export const chokepoint: TheaterModule = {
  kind: 'chokepoint',
  threshold: 0.4,
  detect(graph, selected) {
    const out: TheaterCandidate[] = [];
    const seen = new Set<number>();
    for (const lt of selected.filter((t) => t.kind === 'sea-lane')) {
      const perLane: TheaterCandidate[] = [];
      for (const c of graph.chokepoints) {
        if (!c.lanes.includes(lt.lane!) || seen.has(c.id)) continue;
        const fit =
          c.kind === 'strait'
            ? 1 - 0.5 * clamp01(c.width / 150e3)
            : smooth(0, 4, c.airfields) * (1 - 0.5 * clamp01(c.width / 300e3));
        perLane.push({
          kind: 'chokepoint',
          key: `choke:${c.id}`,
          fit,
          selected: false,
          nodes: c.node >= 0 ? [c.node] : [],
          lane: lt.lane,
          chokepoint: c.id,
          note:
            c.kind === 'strait'
              ? `strait ${Math.round(c.width / 1e3)} km`
              : `island, ${c.airfields} airfield sites, ${Math.round(c.width / 1e3)} km off the lane`,
        });
      }
      perLane.sort((x, y) => y.fit - x.fit || x.key.localeCompare(y.key));
      for (const c of perLane.slice(0, CHOKEPOINTS_PER_LANE)) {
        seen.add(c.chokepoint!);
        out.push(c);
      }
    }
    return out;
  },
};

/** Clusters of nodes within mutual strike range (single linkage over nodeDistance). */
export function strikeClusters(graph: StrategicGraph, range = ISLAND_STRIKE_RANGE): number[][] {
  const n = graph.nodes.length;
  const comp = new Int32Array(n).fill(-1);
  const out: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s]! >= 0) continue;
    const list = [s];
    comp[s] = out.length;
    for (let k = 0; k < list.length; k++) {
      for (let j = 0; j < n; j++) {
        if (comp[j]! < 0 && nodeDistance(graph, list[k]!, j) <= range) {
          comp[j] = out.length;
          list.push(j);
        }
      }
    }
    out.push(list.sort((a, b) => a - b));
  }
  return out;
}

export const islandCampaign: TheaterModule = {
  kind: 'island-campaign',
  threshold: 0.35,
  detect(graph, selected) {
    // Only where no landmass is large enough for a front.
    if (selected.some((t) => t.kind === 'continental-front')) return [];
    return strikeClusters(graph)
      .filter((c) => c.length >= 2)
      .map((nodes, i) => {
        const bases = nodes.reduce((s, id) => s + graph.nodes[id]!.airbases.cells.length, 0);
        const fit = smooth(1, 5, nodes.length) * smooth(10, 40, bases);
        return {
          kind: 'island-campaign' as const,
          key: `islands:${i}`,
          fit,
          selected: false,
          nodes,
          note: `${nodes.length} nodes, ${bases} airbase sites`,
        };
      });
  },
};

export const strategicTheater: TheaterModule = {
  kind: 'strategic',
  threshold: 0,
  detect(_graph, selected) {
    // Always, once both sides have territory: any other theater gives them some.
    if (selected.length === 0) return [];
    return [
      {
        kind: 'strategic',
        key: 'strategic',
        fit: 1,
        selected: false,
        nodes: [],
        note: 'industry and logistics of both sides',
      },
    ];
  },
};

/** Detection order matters: each module sees the theaters selected before it. */
export const THEATER_REGISTRY: readonly TheaterModule[] = [
  continentalFront,
  islandCampaign,
  seaLane,
  chokepoint,
  strategicTheater,
];

export interface Detection {
  /** Every candidate, selected or not, in registry order then by fit. */
  candidates: TheaterCandidate[];
  /** Candidates above their thresholds. */
  selected: TheaterCandidate[];
}

export function detectTheaters(
  graph: StrategicGraph,
  registry: readonly TheaterModule[] = THEATER_REGISTRY,
): Detection {
  const candidates: TheaterCandidate[] = [];
  const selected: TheaterCandidate[] = [];
  for (const m of registry) {
    const found = m
      .detect(graph, selected)
      .sort((a, b) => b.fit - a.fit || a.key.localeCompare(b.key));
    for (const c of found) {
      c.selected = c.fit >= m.threshold && c.fit > 0;
      candidates.push(c);
      if (c.selected) selected.push(c);
    }
  }
  return { candidates, selected };
}
