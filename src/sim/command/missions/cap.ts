/**
 * Combat air patrol (demo type; roadmap R2.1). Standing stations, each kept
 * covered by flights that relieve each other:
 *
 * - stations along each front, one per CAP_SPACING of its length (CAP_STATIONS
 *   at least, MAX_CAP_STATIONS at most), CAP_SETBACK into own ground, each
 *   scored by the pressure on the front segment nearest it, so the stations
 *   by the corridors are manned first (R2.2: two stations left long fronts open);
 * - over the side's AEW orbit behind each front, when it flies AEW (a
 *   high-value asset, design step 1);
 * - over each own carrier group, flown by its own air wing;
 * - over the first island or forward field of each theater at sea.
 */
import { capBriefing } from '../../../campaign/missionBriefings';
import { polylineStations } from '../../../core/greatCircle';
import { HOUR } from '../../../core/units';
import { DEFAULT_JUMP_IN } from '../../air/mission';
import { capResolver } from '../../air/resolvers';
import { carrierState } from '../../naval/carrierGroup';
import { phases, plannedStation, station, the } from './common';
import type { MissionPlugin, Need, PlanContext } from './plugin';

export const CAP_STATIONS = 2;
export const MAX_CAP_STATIONS = 4;
export const CAP_SPACING = 250e3;
export const CAP_SETBACK = 40e3;
/** The AEW orbit's place behind the front (support's SUPPORT_SETBACK), and its CAP's. */
export const AEW_SETBACK = 150e3;
export const HVA_CAP_SETBACK = 110e3;

function needs(ctx: PlanContext): Need[] {
  const out: Need[] = [];
  for (const f of ctx.input.fronts) {
    const w = ctx.theaterWeight(f.theater);
    const name = ctx.theaterName(f.theater);
    const segments = ctx.segments.filter((x) => x.theater === f.theater);
    const length = polylineStations(f.points, ctx.input.radius).at(-1)!;
    const n = Math.min(MAX_CAP_STATIONS, Math.max(CAP_STATIONS, Math.round(length / CAP_SPACING)));
    for (let j = 0; j < n; j++) {
      const frac = (j + 0.5) / n;
      const p = ctx.frontPoint(f.theater, frac, CAP_SETBACK);
      if (!p) continue;
      const seg = segments.find((x) => frac >= x.from && frac < x.to);
      const label = `CAP station ${j + 1}, ${name}`;
      out.push({
        key: `cap:front:${f.theater}:${j}`,
        type: 'cap',
        label: `CAP over ${the(name)}`,
        theater: f.theater,
        score: 0.9 * w * (0.7 + 0.3 * (seg?.pressure ?? 0)),
        target: station(label, p.point),
        places: { theater: the(name), target: label, front: the(name), town: ctx.town(p.point) },
        orbitHeading: p.heading,
        standing: true,
      });
    }
    if (ctx.hasRole('aew')) {
      const p = ctx.frontPoint(f.theater, 0.5, HVA_CAP_SETBACK);
      if (p) {
        const label = `AEW barrier, ${name}`;
        out.push({
          key: `cap:aew:${f.theater}`,
          type: 'cap',
          label: `CAP for the AEW orbit behind ${the(name)}`,
          theater: f.theater,
          score: 0.7 * w,
          target: station(label, p.point),
          places: { theater: the(name), target: label, front: the(name), town: ctx.town(p.point) },
          orbitHeading: p.heading,
          standing: true,
        });
      }
    }
  }
  for (const c of ctx.air.carriers) {
    if (c.cast.side !== ctx.side) continue;
    const point = carrierState(c, ctx.now + HOUR).point;
    const theater = ctx.theaterName(c.cast.theater);
    out.push({
      key: `cap:carrier:${c.cast.id}`,
      type: 'cap',
      label: `CAP over ${c.cast.name}`,
      theater: c.cast.theater,
      score: 0.95,
      target: station(`CAP over ${c.cast.name}`, point),
      places: { theater: the(theater), target: c.cast.name },
      base: { kind: 'carrier', id: c.cast.id },
      standing: true,
    });
  }
  for (const th of ctx.input.theaters) {
    if (th.kind !== 'island-campaign' && th.kind !== 'chokepoint' && th.kind !== 'sea-lane') {
      continue;
    }
    const field = ctx.input.airbases.find(
      (a) =>
        a.side === ctx.side && a.theater === th.id && (a.kind === 'island' || a.kind === 'forward'),
    );
    if (!field) continue;
    out.push({
      key: `cap:field:${field.id}`,
      type: 'cap',
      label: `CAP over ${field.name}`,
      theater: th.id,
      score: 0.8 * th.weight,
      target: station(`CAP over ${field.name}`, [...field.point]),
      places: { theater: the(th.name), target: field.name },
      standing: true,
    });
  }
  return out;
}

export const CAP: MissionPlugin = {
  type: 'cap',
  status: 'demo',
  category: 'counter-air',
  engagement: 'cap',
  planner: needs,
  package: () => [{ role: 'lead', type: 'cap', offset: 0 }],
  resolver: capResolver,
  behavior: { pending: 'R2.5' },
  jumpIn: DEFAULT_JUMP_IN,
  success: {
    text: 'The station was held for at least 80% of its planned time, with no more aircraft lost than shot down.',
    success: (m, o) => o.onStation >= 0.8 * plannedStation(m) && o.losses <= o.kills,
    consequences: (m, o) => [{ kind: 'station-held', key: m.needKey, seconds: o.onStation }],
  },
  briefing: capBriefing,
  interface: phases({
    'fence-in': {
      masterMode: 'air-to-air',
      formats: { leftMfd: ['moving-map'], rightMfd: ['radar-aa'] },
      hud: ['aa-reticle'],
    },
    'on-target': {
      masterMode: 'air-to-air',
      formats: { leftMfd: ['moving-map'], rightMfd: ['radar-aa'] },
      hud: ['station', 'aa-reticle'],
    },
  }),
  minimums: { daylight: 'any', target: { ceiling: 0, visibility: 0 } },
};
