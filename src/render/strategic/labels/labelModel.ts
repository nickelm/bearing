/**
 * Which labels the map has and in which zoom bands they show (visual-style Part II,
 * Camera and Zoom, Labels; decision 98). Pure TypeScript.
 *
 * The band content table (`BAND_TABLE`) gives, per label class, the bands it shows
 * in and the least importance it needs there:
 *
 * | Class | Globe | Theater | Region |
 * |---|---|---|---|
 * | ocean, continent | all | all oceans | – |
 * | sea | ≥ 0.6 | all | all |
 * | archipelago, island | ≥ 0.65 | ≥ 0.45 | all |
 * | bay, strait, lake | – | ≥ 0.45 | all |
 * | range | – | all | all |
 * | desert, forest, plateau, plain | – | ≥ 0.55 | all |
 * | hills, wetland | – | – | all |
 * | river | – | ≥ 0.5 | all |
 * | peak (with its height) | – | ≥ 0.58 | all |
 * | capital (each side's, decision 104) | – | all | all |
 * | city | – | all | all |
 * | town | – | – | all |
 * | village | – | – | ≥ 10,000 people |
 * | theater | all | – | – |
 * | corridor (in the attacker's color) | – | all | all |
 * | road (route numbers, pass and coast road names; decision 104) | – | – | all |
 */
import type { Cast } from '../../../campaign/cast';
import {
  FeatureKind,
  featureAnchor,
  featurePolyline,
  labelText,
  polylinePoint,
  RoadClass,
  RouteKind,
  roadPolyline,
  settlementKind,
} from '../../../worldgen/strategic/graph';
import type { Point, StrategicGraph } from '../../../worldgen/strategic/graph';
import type { Infrastructure } from '../../../worldgen/strategic/infrastructure';
import { routeLabel } from '../../../worldgen/strategic/routes';
import { smoothPolyline } from '../infra/infraModel';
import type { ZoomBand } from '../zoomBands';
import type { MilitaryOverlays } from '../overlays/militaryModel';
import type { LabelStyleId } from './labelStyles';

export type LabelPlacement = 'point' | 'line' | 'area';

export interface MapLabel {
  id: number;
  text: string;
  style: LabelStyleId;
  /** 0..1: labels place in order of importance. */
  importance: number;
  placement: LabelPlacement;
  anchor: Point;
  /** Raw terrain height (m) under the anchor, for the exaggerated relief. */
  height: number;
  /** Polyline (unit directions, xyz) for line labels and the axis of area labels. */
  path: Float64Array | null;
  /** Gap (px) between a point label's anchor and its text, for a marker. */
  gap: number;
  bands: readonly ZoomBand[];
  /** Military overlay layer the label belongs to, hidden with it (decision 101). */
  layer?: string;
}

type Row = Partial<Record<ZoomBand, number>>;
/** Least importance per band; a band missing from a row does not show the class. */
export const BAND_TABLE: Record<string, Row> = {
  ocean: { globe: 0, theater: 0 },
  continent: { globe: 0 },
  sea: { globe: 0.6, theater: 0, region: 0 },
  archipelago: { globe: 0.65, theater: 0.45, region: 0 },
  island: { globe: 0.65, theater: 0.45, region: 0 },
  bay: { theater: 0.45, region: 0 },
  strait: { theater: 0.45, region: 0 },
  lake: { theater: 0.45, region: 0 },
  range: { theater: 0, region: 0 },
  desert: { theater: 0.55, region: 0 },
  forest: { theater: 0.55, region: 0 },
  plateau: { theater: 0.55, region: 0 },
  plain: { theater: 0.55, region: 0 },
  hills: { region: 0 },
  wetland: { region: 0 },
  river: { theater: 0.5, region: 0 },
  peak: { theater: 0.58, region: 0 },
  capital: { theater: 0, region: 0 },
  city: { theater: 0, region: 0 },
  town: { region: 0 },
  village: { region: 0 },
  theater: { globe: 0 },
  corridor: { theater: 0, region: 0 },
  road: { region: 0 },
};
/** Gap (px) between a front or lane theater's name and the line it is anchored on. */
export const THEATER_LINE_GAP = 12;
/** Villages need at least this population for a label. */
export const VILLAGE_LABEL_MIN = 10_000;

const BANDS: readonly ZoomBand[] = ['globe', 'theater', 'region'];

export function bandsFor(cls: string, importance: number): ZoomBand[] {
  const row = BAND_TABLE[cls] ?? {};
  return BANDS.filter((b) => row[b] !== undefined && importance >= row[b]!);
}

const CLASS: Record<FeatureKind, string> = {
  [FeatureKind.Continent]: 'continent',
  [FeatureKind.Island]: 'island',
  [FeatureKind.Archipelago]: 'archipelago',
  [FeatureKind.Ocean]: 'ocean',
  [FeatureKind.Sea]: 'sea',
  [FeatureKind.Bay]: 'bay',
  [FeatureKind.Strait]: 'strait',
  [FeatureKind.Lake]: 'lake',
  [FeatureKind.Range]: 'range',
  [FeatureKind.Peak]: 'peak',
  [FeatureKind.Hills]: 'hills',
  [FeatureKind.Plain]: 'plain',
  [FeatureKind.Plateau]: 'plateau',
  [FeatureKind.Desert]: 'desert',
  [FeatureKind.Forest]: 'forest',
  [FeatureKind.Wetland]: 'wetland',
  [FeatureKind.River]: 'river',
};

const STYLE: Record<FeatureKind, LabelStyleId> = {
  [FeatureKind.Continent]: 'continent',
  [FeatureKind.Island]: 'island',
  [FeatureKind.Archipelago]: 'island',
  [FeatureKind.Ocean]: 'ocean',
  [FeatureKind.Sea]: 'sea',
  [FeatureKind.Bay]: 'water',
  [FeatureKind.Strait]: 'water',
  [FeatureKind.Lake]: 'water',
  [FeatureKind.Range]: 'landform',
  [FeatureKind.Peak]: 'peak',
  [FeatureKind.Hills]: 'landformSmall',
  [FeatureKind.Plain]: 'landformSmall',
  [FeatureKind.Plateau]: 'landform',
  [FeatureKind.Desert]: 'landform',
  [FeatureKind.Forest]: 'landform',
  [FeatureKind.Wetland]: 'landformSmall',
  [FeatureKind.River]: 'river',
};

/** "Mount Seir 1,036 m": peaks carry their height (physical meters). */
export function peakText(name: string, height: number): string {
  return `${labelText(name)} ${Math.round(height).toLocaleString('en-US')} m`;
}

function placementOf(kind: FeatureKind): LabelPlacement {
  if (kind === FeatureKind.River || kind === FeatureKind.Range) return 'line';
  if (kind === FeatureKind.Peak || kind === FeatureKind.Strait) return 'point';
  return 'area';
}

/**
 * Every label of a world. `heightAt` gives the raw terrain height (m) under a unit
 * direction (0 at sea).
 */
export function buildLabels(
  graph: StrategicGraph,
  cast: Cast | null,
  heightAt: (p: Readonly<Point>) => number,
  military: MilitaryOverlays | null = null,
  infra: Infrastructure | null = null,
): MapLabel[] {
  const out: MapLabel[] = [];
  const f = graph.features;
  for (let i = 0; i < f.count; i++) {
    const kind = f.kind[i] as FeatureKind;
    const bands = bandsFor(CLASS[kind], f.importance[i]!);
    if (bands.length === 0 || !f.names[i]) continue;
    const anchor = featureAnchor(f, i);
    const path = featurePolyline(f, i);
    out.push({
      id: out.length,
      text:
        kind === FeatureKind.Peak ? peakText(f.names[i]!, f.height[i]!) : labelText(f.names[i]!),
      style: STYLE[kind],
      importance: f.importance[i]!,
      placement: placementOf(kind),
      anchor,
      height: kind === FeatureKind.Peak ? f.height[i]! : Math.max(0, heightAt(anchor)),
      path: path.length >= 6 ? Float64Array.from(path) : null,
      gap: kind === FeatureKind.Peak ? 5 : 0,
      bands,
    });
  }
  const s = graph.settlements;
  const capitals = new Set(infra ? [infra.capitals.alliance, infra.capitals.pact] : []);
  for (let i = 0; i < s.cells.length; i++) {
    const pop = s.population[i]!;
    const cls = capitals.has(i) ? 'capital' : settlementKind(pop);
    if (cls === 'village' && pop < VILLAGE_LABEL_MIN) continue;
    // Importance from population: 0.3 for a 10,000-person village to 0.95 for a million;
    // capitals above every other settlement.
    const importance =
      cls === 'capital' ? 0.99 : Math.min(0.95, 0.3 + 0.13 * Math.log2(Math.max(1, pop / 10_000)));
    const bands = bandsFor(cls, importance);
    if (bands.length === 0) continue;
    const anchor: Point = [s.points[i * 3]!, s.points[i * 3 + 1]!, s.points[i * 3 + 2]!];
    out.push({
      id: out.length,
      text: s.names[i]!,
      style: cls,
      importance,
      placement: 'point',
      anchor,
      height: Math.max(0, heightAt(anchor)),
      path: null,
      // Beside the settlement glyph (and a capital's star).
      gap: SETTLEMENT_GAP[cls],
      bands,
    });
  }
  // Route numbers and the names of pass and coast roads, along the road.
  const rt = graph.routes;
  for (let i = 0; i < rt.count; i++) {
    const text = routeLabel(rt, i);
    if (!text) continue;
    const path = routePath(graph, i);
    if (path.length < 6) continue;
    const mid = polylinePoint(path, Math.floor(path.length / 6));
    const named = rt.kind[i] !== RouteKind.Numbered;
    out.push({
      id: out.length,
      text,
      style: 'road',
      importance: named ? 0.62 : rt.roadClass[i] === RoadClass.Motorway ? 0.55 : 0.45,
      placement: 'line',
      anchor: mid,
      height: Math.max(0, heightAt(mid)),
      path,
      gap: 0,
      bands: bandsFor('road', 1),
      layer: 'roads',
    });
  }
  for (const t of cast?.theaters ?? []) {
    const anchor = theaterAnchor(graph, t);
    if (!anchor) continue;
    out.push({
      id: out.length,
      text: t.name,
      style: 'theater',
      importance: 0.97,
      placement: 'point',
      anchor,
      height: Math.max(0, heightAt(anchor)),
      path: null,
      // Beside the front or lane it names, not over it (decision 101).
      gap: t.kind === 'continental-front' || t.kind === 'sea-lane' ? THEATER_LINE_GAP : 0,
      bands: bandsFor('theater', 1),
    });
  }
  // Invasion corridors: named arrows, the name along the arrow in the attacker's color.
  for (const line of military?.lines ?? []) {
    if (line.layer !== 'corridors' || !line.name || !line.side) continue;
    const mid = polylinePoint(line.points, Math.floor(line.points.length / 6));
    out.push({
      id: out.length,
      text: labelText(line.name),
      style: line.side === 'alliance' ? 'corridorAlliance' : 'corridorPact',
      importance: 0.9,
      placement: 'line',
      anchor: mid,
      height: Math.max(0, heightAt(mid)),
      path: Float64Array.from(line.points),
      gap: 0,
      bands: bandsFor('corridor', 1),
      layer: 'corridors',
    });
  }
  return out;
}

/** Gap (px) between a settlement's anchor and its label, clearing its glyph. */
const SETTLEMENT_GAP: Record<string, number> = { capital: 12, city: 9, town: 6, village: 4 };

/** A route's polylines joined end to end into one smoothed path. */
function routePath(graph: StrategicGraph, i: number): Float64Array {
  const rt = graph.routes;
  const r = graph.roads;
  const pts: number[] = [];
  let lastCell = -1;
  for (let o = rt.offsets[i]!; o < rt.offsets[i + 1]!; o++) {
    const k = rt.roads[o]!;
    const first = r.cells[r.offsets[k]!]!;
    const line = roadPolyline(r, k);
    const n = line.length / 3;
    // Orient each polyline to continue from the previous one.
    const forward = lastCell < 0 ? !isEndOf(graph, rt, i, o, first) : first === lastCell;
    for (let p = 0; p < n; p++) {
      const q = forward ? p : n - 1 - p;
      if (pts.length > 0 && p === 0) continue;
      pts.push(line[q * 3]!, line[q * 3 + 1]!, line[q * 3 + 2]!);
    }
    lastCell = forward ? r.cells[r.offsets[k + 1]! - 1]! : first;
  }
  return smoothPolyline(Float64Array.from(pts));
}

/** True if `cell` (an end of the route's polyline at `o`) joins the next polyline. */
function isEndOf(
  graph: StrategicGraph,
  rt: StrategicGraph['routes'],
  i: number,
  o: number,
  cell: number,
): boolean {
  if (o + 1 >= rt.offsets[i + 1]!) return false;
  const r = graph.roads;
  const next = rt.roads[o + 1]!;
  return cell === r.cells[r.offsets[next]!] || cell === r.cells[r.offsets[next + 1]! - 1];
}

function theaterAnchor(graph: StrategicGraph, t: Cast['theaters'][number]): Point | null {
  if (t.kind === 'continental-front' && t.front !== undefined) {
    const line = graph.barrierLines[graph.fronts[t.front]!.start];
    if (line) return polylinePoint(line.points, Math.floor(line.points.length / 6));
  }
  if (t.kind === 'sea-lane' && t.lane !== undefined) {
    const lane = graph.lanes[t.lane]!;
    return polylinePoint(lane.points, Math.floor(lane.points.length / 6));
  }
  if (t.kind === 'chokepoint' && t.chokepoint !== undefined)
    return graph.chokepoints[t.chokepoint]!.point;
  if (t.kind === 'island-campaign' && t.nodes.length > 0) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const id of t.nodes) {
      const c = graph.nodes[id]!.centroid;
      x += c[0];
      y += c[1];
      z += c[2];
    }
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }
  return null;
}
