/**
 * The selected flight or carrier group on the map (decision 133): a small panel
 * that says what it is, what it is doing and why. Mission search (C2) builds on
 * it. It reads only what the viewing side may know: its own missions, and (in the
 * developer view of both sides) the other side's too.
 */
import type { Cast } from '../campaign/cast';
import { SIDE_LABELS } from '../campaign/cast';
import { KNOT, MINUTE } from '../core/units';
import type { GameTime } from '../core/units';
import { aircraftType } from '../sim/air/aircraft';
import { MISSION_LABELS, MISSION_PHASES, missionPhase } from '../sim/air/mission';
import type { Mission, MissionPhase } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { carrierState, carrierTrack } from '../sim/naval/carrierGroup';
import type { CarrierTrack } from '../sim/naval/carrierGroup';
import type { Infrastructure } from '../worldgen/strategic/infrastructure';

const PHASE_LABELS: Record<MissionPhase | 'planned', string> = {
  planned: 'planned',
  departure: 'departing',
  'climb-out': 'climbing out',
  ingress: 'ingress',
  'fence-in': 'fence-in',
  'on-target': 'on target',
  egress: 'egress',
  approach: 'approach',
  recovery: 'recovering',
  complete: 'complete',
};

/** Refresh interval (real ms): times and phases change slowly on screen. */
const REFRESH_MS = 250;

function minutes(dt: number): string {
  const m = Math.max(0, Math.round(dt / MINUTE));
  return m >= 90 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function compass(rad: number): string {
  return `${String(Math.round((rad * 180) / Math.PI) % 360).padStart(3, '0')}°`;
}

export class AirPanel {
  private readonly el: HTMLDivElement;
  private key: string | null = null;
  private last = 0;
  private cast: Cast | null = null;
  private infra: Infrastructure | null = null;
  private carriers: CarrierTrack[] = [];
  private radius = 1;
  /** Called when the panel's close button clears the selection. */
  onClose: (() => void) | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'air-panel';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  setCampaign(cast: Cast | null, infra: Infrastructure | null, radius: number): void {
    this.cast = cast;
    this.infra = infra;
    this.radius = radius;
    this.carriers = (cast?.carriers ?? []).map((c) => carrierTrack(c, radius));
  }

  select(key: string | null): void {
    this.key = key;
    this.last = 0;
    if (!key) this.el.hidden = true;
  }

  /** Redraws the panel for the display time (throttled). */
  update(missions: readonly Mission[], t: GameTime, nowMs: number): void {
    if (!this.key || nowMs - this.last < REFRESH_MS) return;
    this.last = nowMs;
    const [kind, idText] = this.key.split(':');
    const id = Number(idText);
    const rows =
      kind === 'mission'
        ? this.missionRows(missions.find((m) => m.id === id) ?? null, t)
        : this.carrierRows(id, missions, t);
    this.el.replaceChildren();
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Clear the selection (Esc)';
    close.onclick = () => this.onClose?.();
    this.el.appendChild(close);
    for (const [i, text] of rows.entries()) {
      const p = document.createElement(i === 0 ? 'h2' : 'p');
      p.textContent = text;
      this.el.appendChild(p);
    }
    this.el.hidden = false;
  }

  private baseName(m: Mission): string {
    if (m.base.kind === 'carrier') return this.cast?.carriers[m.base.id]?.name ?? 'carrier';
    return this.infra?.airbases[m.base.id]?.name ?? 'airbase';
  }

  private missionRows(m: Mission | null, t: GameTime): string[] {
    if (!m) return ['Mission complete', 'The flight has landed and left the board.'];
    const type = aircraftType(m.aircraftType);
    const phase = missionPhase(m, t);
    const s = routeState(m.route, t, this.radius);
    const next = m.timeline.find((e) => e.time > t);
    const onTarget = m.timeline.find((e) => e.phase === 'on-target')?.time ?? NaN;
    const timing =
      phase === 'planned'
        ? `Takes off in ${minutes(m.timeline[0]!.time - t)}`
        : onTarget > t
          ? `On target in ${minutes(onTarget - t)}`
          : next
            ? `${PHASE_LABELS[next.phase]} in ${minutes(next.time - t)}`
            : '';
    const flying = s.airborne
      ? `, ${Math.round(s.altitude / 10) * 10} m, ${Math.round(s.speed / KNOT)} kn, heading ${compass(s.heading)}`
      : '';
    const step = MISSION_PHASES.indexOf(phase as MissionPhase) + 1;
    return [
      `${m.callsign}: ${m.aircraft} × ${type.name}`,
      `${MISSION_LABELS[m.type]} for the ${SIDE_LABELS[m.side]}. ${m.need}.`,
      `Phase: ${PHASE_LABELS[phase]}${step > 0 ? ` (${step} of ${MISSION_PHASES.length - 1})` : ''}${flying}. ${timing}.`,
      `${m.unit}, from ${this.baseName(m)}. Target: ${m.target.name}.`,
      `Priority ${m.score.toFixed(2)}, package ${m.package}.`,
    ];
  }

  private carrierRows(id: number, missions: readonly Mission[], t: GameTime): string[] {
    const c = this.carriers[id];
    if (!c) return ['Carrier group', 'Not in this campaign.'];
    const s = carrierState(c, t);
    const theater = this.cast?.theaters[c.cast.theater]?.name ?? 'its theater';
    const wing = missions.filter((m) => m.base.kind === 'carrier' && m.base.id === id);
    const airborne = wing.filter((m) => routeState(m.route, t, this.radius).airborne);
    return [
      `${c.cast.name}: ${SIDE_LABELS[c.cast.side]} carrier group`,
      `On station for ${theater}, ${Math.round(s.speed / KNOT)} kn, heading ${compass(s.heading)}.`,
      `Air wing: ${wing.length} mission${wing.length === 1 ? '' : 's'} planned or flying, ${airborne.length} airborne.`,
    ];
  }
}
