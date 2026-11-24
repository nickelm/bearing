/**
 * The mission search panel over the strategic view (roadmap R1.4): filters, the
 * rows of `missionRows`, and the player's subscriptions. It draws the display
 * model and turns clicks into callbacks; what changes the campaign (a
 * subscription) goes out as a campaign input through `onInput`. Toggled with M.
 */
import { inputLayer } from '../input/layer';
import { registerNavRoot } from '../input/menuNav';
import { installGamepadUi } from '../input/prompt';
import type { Side } from '../../campaign/cast';
import { SIDE_LABELS } from '../../campaign/cast';
import { HOUR, MINUTE } from '../../core/units';
import type { GameTime } from '../../core/units';
import { aircraftType } from '../../sim/air/aircraft';
import { MISSION_LABELS, MISSION_PHASES } from '../../sim/air/mission';
import type { Mission, MissionPhase, MissionType } from '../../sim/air/mission';
import type { Subscription } from '../../sim/air/subscriptions';
import type { CampaignInputEvent } from '../../sim/eventLog';
import {
  filterChoices,
  missionRows,
  NO_FILTERS,
  PHASE_LABELS,
  queryOf,
  THREAT_LEVELS,
} from './model';
import type { MissionFilters, MissionRow, PhaseFilter, ThreatLevel } from './model';

/** Real ms between redraws: phases and minutes change slowly on screen. */
const REFRESH_MS = 500;
/** Rows shown at most. */
const MAX_ROWS = 40;

const WITHIN: readonly [string, number][] = [
  ['any time', Infinity],
  ['within 15 min', 15 * MINUTE],
  ['within 30 min', 30 * MINUTE],
  ['within 1 h', HOUR],
  ['within 3 h', 3 * HOUR],
];

export class MissionSearchPanel {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly filtersEl: HTMLDivElement;
  private readonly listEl: HTMLOListElement;
  private readonly subsEl: HTMLDivElement;
  private filters: MissionFilters = { ...NO_FILTERS };
  private side: Side | 'both' = 'both';
  private theaterNames: readonly string[] = [];
  private subscriptions: Subscription[] = [];
  private nextSubscription = 1;
  private last = 0;
  private choicesKey = '';
  private readonly selects = new Map<string, HTMLSelectElement>();
  private triggerPhase: MissionPhase = 'on-target';
  private shown = false;
  private isActive = true;
  /** A row was chosen: focus the map on the mission and select it. */
  onFocus: ((missionId: number) => void) | null = null;
  /** Follow was chosen on a row: cut to the simulation view behind the flight (R2.4). */
  onFollow: ((missionId: number) => void) | null = null;
  /** A campaign input (subscribe, unsubscribe) for the sim. */
  onInput: ((input: CampaignInputEvent) => void) | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'mission-search';
    this.el.hidden = true;
    this.title = document.createElement('h2');
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close (M)';
    close.addEventListener('click', () => (this.visible = false));
    this.filtersEl = document.createElement('div');
    this.filtersEl.className = 'filters';
    this.listEl = document.createElement('ol');
    this.listEl.className = 'rows';
    this.subsEl = document.createElement('div');
    this.subsEl.className = 'subscriptions';
    this.el.append(close, this.title, this.filtersEl, this.listEl, this.subsEl);
    parent.appendChild(this.el);
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      // Only over the map: in flight M steps the master mode (ui/displays/bindings.ts).
      if (!this.isActive) return;
      if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey) this.visible = !this.visible;
    });
    // A gamepad (Proposal 0014): Select opens and closes it over the map; the D-pad walks it.
    installGamepadUi();
    inputLayer().onGlobal((a, down) => {
      if (down && a === 'missionSearch' && this.isActive) this.visible = !this.visible;
    });
    registerNavRoot(this.el, { priority: 25, back: () => (this.visible = false) });
  }

  get visible(): boolean {
    return this.shown;
  }

  set visible(v: boolean) {
    this.shown = v;
    this.apply();
  }

  /** Whether the map is on screen: the panel shows and takes M only then. */
  set active(a: boolean) {
    if (a === this.isActive) return;
    this.isActive = a;
    this.apply();
  }

  private apply(): void {
    const on = this.shown && this.isActive;
    this.el.hidden = !on;
    document.body.classList.toggle('search-open', on);
    this.last = 0;
  }

  /** The viewing side and the theaters' names; the filters reset when the side changes. */
  setCampaign(side: Side | 'both', theaterNames: readonly string[]): void {
    if (side !== this.side) this.filters = { ...NO_FILTERS };
    this.side = side;
    this.theaterNames = theaterNames;
    this.choicesKey = '';
    this.last = 0;
  }

  update(missions: readonly Mission[], t: GameTime, nowMs: number): void {
    if (this.el.hidden || nowMs - this.last < REFRESH_MS) return;
    this.last = nowMs;
    this.title.textContent = `Missions: ${this.side === 'both' ? 'both sides' : SIDE_LABELS[this.side]}`;
    this.drawFilters(missions);
    this.drawRows(missionRows(missions, this.side, t, this.filters, this.theaterNames));
    this.drawSubscriptions();
  }

  private drawFilters(missions: readonly Mission[]): void {
    const c = filterChoices(missions, this.side);
    const key = JSON.stringify(c);
    if (key === this.choicesKey) return;
    this.choicesKey = key;
    this.filtersEl.replaceChildren();
    const add = <T extends string | number>(
      name: string,
      options: readonly [string, T][],
      current: T | undefined,
      set: (v: T | undefined) => void,
      labelOf?: (v: T) => string,
    ) => {
      // A filter set on a choice no live mission has any more (an aircraft type gone from
      // the orders) stays listed and selected, so it shows and can be set back to all.
      if (current !== undefined && !options.some(([, v]) => v === current))
        options = [
          ...options,
          [`${labelOf ? labelOf(current) : String(current)} (none now)`, current],
        ];
      const s = document.createElement('select');
      s.title = name;
      const all = document.createElement('option');
      all.value = '';
      all.textContent = `${name}: all`;
      s.appendChild(all);
      options.forEach(([label, v], i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = label;
        if (v === current) o.selected = true;
        s.appendChild(o);
      });
      s.addEventListener('change', () => {
        set(s.value === '' ? undefined : options[Number(s.value)]![1]);
        this.last = 0;
      });
      this.selects.set(name, s);
      this.filtersEl.appendChild(s);
    };
    const f = this.filters;
    add<MissionType>(
      'Type',
      c.types.map((x) => [MISSION_LABELS[x], x]),
      f.types[0],
      (v) => (f.types = v ? [v] : []),
      (v) => MISSION_LABELS[v],
    );
    add<string>(
      'Aircraft',
      c.aircraft.map((x) => [aircraftType(x).name, x]),
      f.aircraft[0],
      (v) => (f.aircraft = v ? [v] : []),
      (v) => aircraftType(v).name,
    );
    add<number>(
      'Theater',
      c.theaters.map((x) => [this.theaterNames[x] ?? 'strategic', x]),
      f.theaters[0],
      (v) => (f.theaters = v !== undefined ? [v] : []),
      (v) => this.theaterNames[v] ?? 'strategic',
    );
    add<PhaseFilter>(
      'Phase',
      (['planned', ...MISSION_PHASES.filter((p) => p !== 'complete')] as PhaseFilter[]).map((p) => [
        PHASE_LABELS[p],
        p,
      ]),
      f.phases[0],
      (v) => (f.phases = v ? [v] : []),
    );
    add<ThreatLevel>(
      'Threat',
      THREAT_LEVELS.map((x) => [x, x]),
      f.threats[0],
      (v) => (f.threats = v ? [v] : []),
    );
    add<number>(
      'Action',
      WITHIN.slice(1),
      Number.isFinite(f.within) ? f.within : undefined,
      (v) => {
        f.within = v ?? Infinity;
      },
    );
  }

  private drawRows(rows: MissionRow[]): void {
    this.listEl.replaceChildren();
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No mission matches.';
      this.listEl.appendChild(li);
      return;
    }
    for (const r of rows.slice(0, MAX_ROWS)) {
      const li = document.createElement('li');
      li.className = `threat-${r.threat}${r.timeToAction === 0 ? ' in-action' : ''}`;
      li.tabIndex = 0;
      const head = document.createElement('div');
      head.className = 'head';
      // The title in its own span: the threat mark before it stays at the left.
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = `${r.callsign} · ${r.typeLabel}`;
      head.appendChild(title);
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = r.action;
      head.appendChild(when);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${r.aircraft} · ${r.theater} · ${r.phaseLabel}${r.jumpable ? ' · jump-in open' : ''}`;
      li.append(head, sub);
      if (r.followable) {
        // On pointerdown: the rows are redrawn a few times a second, and a click needs the
        // same element under the press and the release.
        const follow = document.createElement('button');
        follow.className = 'follow';
        follow.textContent = 'Follow';
        follow.title = 'Follow this flight in the simulation view';
        follow.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.onFollow?.(r.id);
        });
        follow.addEventListener('click', (e) => e.stopPropagation());
        follow.addEventListener('keydown', (e) => {
          if (e.code !== 'Enter' && e.code !== 'Space') return;
          e.stopPropagation();
          e.preventDefault();
          this.onFollow?.(r.id);
        });
        head.insertBefore(follow, when);
      }
      const choose = () => this.onFocus?.(r.id);
      li.addEventListener('click', choose);
      li.addEventListener('keydown', (e) => {
        if (e.code === 'Enter') choose();
      });
      this.listEl.appendChild(li);
    }
    if (rows.length > MAX_ROWS) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = `${rows.length - MAX_ROWS} more: narrow the filters.`;
      this.listEl.appendChild(li);
    }
  }

  private drawSubscriptions(): void {
    this.subsEl.replaceChildren();
    const row = document.createElement('div');
    row.className = 'subscribe';
    const phase = document.createElement('select');
    phase.title = 'Phase that slows the clock';
    for (const p of MISSION_PHASES.filter((x) => x !== 'complete')) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = `slow at ${PHASE_LABELS[p]}`;
      if (p === this.triggerPhase) o.selected = true;
      phase.appendChild(o);
    }
    phase.addEventListener('change', () => (this.triggerPhase = phase.value as MissionPhase));
    const button = document.createElement('button');
    button.textContent = 'Subscribe to these filters';
    button.addEventListener('click', () => this.subscribe());
    row.append(phase, button);
    this.subsEl.appendChild(row);
    for (const s of this.subscriptions) {
      const div = document.createElement('div');
      div.className = 'subscription';
      div.textContent = `${s.label} (slows at ${PHASE_LABELS[s.phase]})`;
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = 'Remove the subscription';
      remove.addEventListener('click', () => {
        this.subscriptions = this.subscriptions.filter((x) => x.id !== s.id);
        this.onInput?.({ kind: 'unsubscribe', id: s.id });
        this.last = 0;
      });
      div.appendChild(remove);
      this.subsEl.appendChild(div);
    }
  }

  private subscribe(): void {
    const query = queryOf(this.filters, this.side);
    const parts = [
      ...(query.types ?? []).map((x) => MISSION_LABELS[x]),
      ...(query.aircraft ?? []).map((x) => aircraftType(x).name),
      ...(query.theaters ?? []).map((x) => this.theaterNames[x] ?? 'strategic'),
    ];
    const s: Subscription = {
      id: this.nextSubscription++,
      query,
      phase: this.triggerPhase,
      label: parts.length > 0 ? parts.join(', ') : 'Every mission',
    };
    this.subscriptions.push(s);
    this.onInput?.({ kind: 'subscribe', subscription: s });
    this.last = 0;
  }
}
