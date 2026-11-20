/**
 * Data for a game layer (proposal 0009, decision 268): per settlement, its districts,
 * blocks, landmarks and candidate targets, in planet directions as well as the local
 * frame, through plain types. The generator does not know who reads them: Bearing's
 * planner may, through its own adapter.
 */
import { SettlementFrame } from './frame';
import { polyCentroid } from './geom';
import type { PackedPlan } from './pack';
import { DISTRICT_NAMES, LANDMARK_NAMES, TARGET_NAMES } from './types';

export interface ExportedFeature {
  kind: string;
  name: string;
  /** Unit direction of its center. */
  direction: [number, number, number];
  /** Footprint as unit directions, xyz interleaved. */
  footprint: number[];
}

export interface SettlementExport {
  key: string;
  name: string;
  districts: { district: string; blocks: number; area: number }[];
  landmarks: ExportedFeature[];
  targets: ExportedFeature[];
}

export function exportSettlement(plan: PackedPlan, radius: number): SettlementExport {
  const frame = new SettlementFrame(plan.center, radius);
  const dir = (x: number, y: number) => frame.toSphere(x, y);
  const fp = (poly: ArrayLike<number>) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < poly.length; i += 2) out.push(...dir(poly[i]!, poly[i + 1]!));
    return out;
  };
  const byDistrict = new Map<number, { blocks: number; area: number }>();
  const info = plan.blockInfo;
  for (let b = 0; b < info.length / 4; b++) {
    const d = info[b * 4]!;
    const e = byDistrict.get(d) ?? { blocks: 0, area: 0 };
    e.blocks++;
    e.area += info[b * 4 + 3]!;
    byDistrict.set(d, e);
  }
  return {
    key: plan.key,
    name: plan.name,
    districts: [...byDistrict].map(([d, e]) => ({
      district: DISTRICT_NAMES[d] ?? String(d),
      ...e,
    })),
    landmarks: plan.landmarks.map((l) => ({
      kind: LANDMARK_NAMES[l.kind]!,
      name: l.name,
      direction: dir(l.x, l.y),
      footprint: fp([
        l.x - l.size,
        l.y - l.size,
        l.x + l.size,
        l.y - l.size,
        l.x + l.size,
        l.y + l.size,
        l.x - l.size,
        l.y + l.size,
      ]),
    })),
    targets: plan.targets.map((t) => {
      const [cx, cy] = t.footprint.length >= 6 ? polyCentroid(t.footprint) : [t.x, t.y];
      return {
        kind: TARGET_NAMES[t.kind]!,
        name: t.name,
        direction: dir(cx, cy),
        footprint: fp(t.footprint),
      };
    }),
  };
}
