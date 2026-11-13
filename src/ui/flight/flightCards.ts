/**
 * Free Flight's cards (decision 134): the pause menu (Esc), the sortie summary
 * after a full stop or a crash, and the help overlay (H) listing every binding
 * from the one table in flightInput.ts. Panels follow Part I's UI style.
 */
import './flight.css';
import { FOOT, KNOT } from '../../core/units';
import type { Touchdown } from '../../sim/flight/outcomes';
import { ACTION_LABELS, FLIGHT_BINDINGS } from './flightInput';
import type { FlightAction } from './flightInput';
import type { FreeFlightOptions, SpawnKind } from './freeFlightMenu';

function card(className = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `ff-panel ff-card ${className}`;
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (primary) b.className = 'ff-primary';
  b.addEventListener('click', onClick);
  return b;
}

export interface PauseEvents {
  resume(): void;
  restart(spawn: SpawnKind): void;
  changeBase(): void;
  exit(): void;
  optionsChanged(o: FreeFlightOptions): void;
}

export class PauseMenu {
  readonly el = card();

  constructor(
    private readonly options: FreeFlightOptions,
    events: PauseEvents,
  ) {
    const h = document.createElement('h1');
    h.textContent = 'Paused';
    const buttons = document.createElement('div');
    buttons.className = 'ff-buttons';
    buttons.append(
      button('Resume', () => events.resume(), true),
      button('Restart on the runway', () => events.restart('runway')),
      button('Air start (3,000 m, 300 kt)', () => events.restart('air')),
      button('Change airbase', () => events.changeBase()),
      button('Return to the start screen', () => events.exit()),
    );
    const opts = document.createElement('div');
    opts.innerHTML = `<h2>Options</h2>
      <label><input type="checkbox" class="ff-fuel"> Unlimited fuel</label><br>
      <label>Time of day <input type="range" class="ff-tod" min="0" max="24" step="0.25"> <span class="ff-tod-label"></span></label>
      <div class="ff-note">Time of day applies on the next restart.</div>`;
    const fuel = opts.querySelector('.ff-fuel') as HTMLInputElement;
    const tod = opts.querySelector('.ff-tod') as HTMLInputElement;
    const todLabel = opts.querySelector('.ff-tod-label') as HTMLSpanElement;
    const sync = () => {
      fuel.checked = this.options.unlimitedFuel;
      tod.value = String(this.options.timeOfDay);
      const hh = Math.floor(this.options.timeOfDay);
      const mm = Math.round((this.options.timeOfDay - hh) * 60);
      todLabel.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };
    this.sync = sync;
    fuel.addEventListener('change', () => {
      this.options.unlimitedFuel = fuel.checked;
      events.optionsChanged(this.options);
    });
    tod.addEventListener('input', () => {
      this.options.timeOfDay = Number(tod.value);
      sync();
      events.optionsChanged(this.options);
    });
    this.el.append(h, buttons, opts);
    sync();
  }

  private readonly sync: () => void;

  get visible(): boolean {
    return !this.el.hidden;
  }

  set visible(v: boolean) {
    if (v) this.sync();
    this.el.hidden = !v;
  }
}

export interface SummaryEvents {
  restart(): void;
  /** Refuel and take off again from the base the aircraft stopped at. */
  continueFrom(baseId: number): void;
  changeBase(): void;
}

const GRADE_TEXT = {
  smooth: 'Smooth',
  good: 'Good',
  firm: 'Firm',
  hard: 'Hard landing',
} as const;

/** "1.2 m/s (240 ft/min)". */
export function sinkText(ms: number): string {
  return `${ms.toFixed(1)} m/s (${Math.round((ms / FOOT) * 60).toLocaleString('en-US')} ft/min)`;
}

export function touchdownLines(td: Touchdown): string[] {
  const lines = [`Sink rate ${sinkText(td.sinkRate)}`, `Speed ${Math.round(td.speed / KNOT)} KIAS`];
  if (td.distance !== null) {
    lines.push(
      `${Math.round(td.distance)} m (${Math.round(td.distance / FOOT).toLocaleString('en-US')} ft) past the threshold of ${td.end?.designator ?? '?'}${td.inZone ? ', in the touchdown zone' : td.distance < 150 ? ', short of the zone' : ', long'}`,
    );
    if (td.offset !== null)
      lines.push(
        `${Math.abs(td.offset).toFixed(1)} m ${td.offset >= 0 ? 'right' : 'left'} of the centerline`,
      );
  } else {
    lines.push('Off the runway');
  }
  return lines;
}

export class SummaryCard {
  readonly el = card();
  private baseId: number | null = null;

  constructor(private readonly events: SummaryEvents) {}

  get visible(): boolean {
    return !this.el.hidden;
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
  }

  /**
   * Shows the sortie's outcome: a full stop (with the landing, and the base it
   * stopped at) or a crash, plus the flight time and distance.
   */
  show(opts: {
    crash: string | null;
    landing: Touchdown | null;
    stoppedAt: { id: number; name: string } | null;
    homeId: number;
    flightTime: number;
    distance: number;
  }): void {
    this.el.replaceChildren();
    const h = document.createElement('h1');
    h.textContent = opts.crash ? 'Crashed' : 'Full stop';
    h.className = opts.crash ? 'ff-bad' : 'ff-good';
    const dl = document.createElement('dl');
    const row = (k: string, v: string, cls = '') => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      if (cls) dd.className = cls;
      dl.append(dt, dd);
    };
    if (opts.crash) row('Cause', opts.crash, 'ff-bad');
    if (opts.stoppedAt) row('Stopped at', opts.stoppedAt.name);
    if (opts.landing) {
      const td = opts.landing;
      row('Landing', GRADE_TEXT[td.grade], td.grade === 'hard' ? 'ff-bad' : 'ff-good');
      touchdownLines(td).forEach((l, i) => row(i === 0 ? 'Touchdown' : '', l));
    }
    const min = Math.floor(opts.flightTime / 60);
    const sec = Math.round(opts.flightTime % 60);
    row('Flight time', `${min} min ${sec} s`);
    row(
      'Distance flown',
      `${(opts.distance / 1000).toFixed(1)} km (${(opts.distance / 1852).toFixed(1)} nm)`,
    );
    const buttons = document.createElement('div');
    buttons.className = 'ff-buttons';
    this.baseId = opts.stoppedAt?.id ?? null;
    if (!opts.crash && this.baseId !== null && this.baseId !== opts.homeId) {
      const id = this.baseId;
      buttons.append(
        button(
          `Refuel and take off from ${opts.stoppedAt!.name}`,
          () => this.events.continueFrom(id),
          true,
        ),
      );
    }
    buttons.append(
      button(
        'Restart',
        () => this.events.restart(),
        opts.crash !== null || this.baseId === opts.homeId,
      ),
      button('Change airbase', () => this.events.changeBase()),
    );
    this.el.append(h, dl, buttons);
    this.visible = true;
  }
}

/** Key names for the help overlay. */
function keyName(code: string): string {
  const named: Record<string, string> = {
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    ControlLeft: 'Ctrl',
    ControlRight: 'Ctrl',
    Space: 'Space',
    Escape: 'Esc',
    Equal: '=',
    Minus: '−',
    NumpadAdd: 'Num +',
    NumpadSubtract: 'Num −',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  return code;
}

export class HelpOverlay {
  readonly el = card('ff-help');

  constructor() {
    this.refresh();
  }

  /** Rebuilds the table from the bindings (after a remap). */
  refresh(): void {
    const rows = (Object.keys(FLIGHT_BINDINGS) as FlightAction[]).map((a) => {
      const keys = [...new Set(FLIGHT_BINDINGS[a].map(keyName))].join(' / ');
      return `<tr><td>${keys}</td><td>${ACTION_LABELS[a]}</td></tr>`;
    });
    rows.push(
      '<tr><td>Mouse wheel</td><td>Throttle, stopping at idle, military and the afterburner gate</td></tr>',
    );
    rows.push('<tr><td>Right drag</td><td>Free look; the camera springs back on release</td></tr>');
    this.el.innerHTML = `<h1>Controls</h1><table>${rows.join('')}</table>
      <div class="ff-note">Ctrl+W closes the browser tab; the page asks first while you fly. The throttle also moves with = and −.</div>
      <div class="ff-note">Takeoff: release the parking brake (P), full throttle; at about 150 kt hold the stick back until about 9° of pitch and let go: with the gear down the stick commands pitch rate (5°/s) and the attitude holds. Gear up (G) once climbing; the stick then commands g. Landing: gear down below 300 kt, fly the approach at 13° angle of attack, 3° glide path, brake (Space) after the nosewheel is down.</div>`;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
  }
}
