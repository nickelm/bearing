/**
 * The Free Flight start screen (decision 134): the seed, the world's airbases
 * (name, faction, region, runway), the options and the Fly button, in a
 * column over the strategic map. Clicking a base on the map selects it too
 * (the app calls `select`). The menu only reports choices; the app acts.
 */
import { openBindings } from '../input/bindingsScreen';
import { registerNavRoot } from '../input/menuNav';
import { padStatusLine } from '../input/prompt';
import './flight.css';
import { FOOT } from '../../core/units';
import { presetDescription, presetName, WEATHER_PRESETS } from '../../sim/weather/presets';
import type { WeatherPreset } from '../../sim/weather/presets';

export type SpawnKind = 'runway' | 'air';

/** The jets to fly: the F-21 Kestrel and A-15, and the Pact's Vo-31 and Vo-35 (roadmap R2.7). */
export type JetChoice = 'kestrel' | 'a15' | 'vo31' | 'vo35';

/** The aircraft to fly: a jet, or one of the H1 helicopters (Proposal 0004). */
export type AircraftChoice = JetChoice | 'scout' | 'utility';

/** Each jet's bundle. */
export const JET_BUNDLES: Readonly<Record<JetChoice, string>> = {
  kestrel: 'alliance-fighter',
  a15: 'a15',
  vo31: 'pact-fighter',
  vo35: 'pact-strike',
};

/** Whether `a` is a jet (else a helicopter). */
export function isJet(a: AircraftChoice): a is JetChoice {
  return a in JET_BUNDLES;
}

export const AIRCRAFT_CHOICES: { id: AircraftChoice; label: string; note: string }[] = [
  { id: 'kestrel', label: 'F-21 Kestrel', note: 'Fighter (F-16 analogue)' },
  { id: 'a15', label: 'A-15 Buzzard', note: 'Attack aircraft (A-10 analogue)' },
  { id: 'vo31', label: 'Vo-31 Strizh', note: 'Pact fighter (MiG-29 analogue)' },
  { id: 'vo35', label: 'Vo-35 Molot', note: 'Pact attack aircraft (Su-25 analogue)' },
  { id: 'scout', label: 'MH-14 Wren', note: 'Light scout helicopter (Little Bird analogue)' },
  { id: 'utility', label: 'UH-68 Heron', note: 'Utility helicopter (Black Hawk analogue)' },
];

export interface FreeFlightOptions {
  /** Local solar time at the base (hours). */
  timeOfDay: number;
  unlimitedFuel: boolean;
  spawn: SpawnKind;
  aircraft: AircraftChoice;
  /** The weather to fly in (sim/weather/presets.ts); `live` is the world's own at that hour. */
  weather: WeatherPreset;
  /** The aircraft feels the weather's wind and gusts (sim/flight/wind.ts). */
  wind: boolean;
  /** How the captured mouse flies the jet: toward the aim ring, or the stick directly (decision 198). */
  control: JetControl;
  /**
   * The mouse's up and down inverted, per way of flying (decisions 196, 198): the
   * jet's mouse aim, the jet's direct stick, and the helicopters.
   */
  invertAim: boolean;
  invertStick: boolean;
  invertHelo: boolean;
  /** The ground's micro-facets near a low camera: costly on some GPUs, off by default (decision 197). */
  microFacets: boolean;
  /** The displays' and the strip's size, 0.75–1.5 (Proposal 0006, decision 200). */
  uiScale: number;
  /** The frame-rate gauge at the screen's top center while flying (decision 217). */
  showFps: boolean;
  /**
   * A few aircraft and two ground radars near the base, for the sensors and their
   * displays to find (decision 218). Off by default.
   */
  traffic: boolean;
  /**
   * The jet's loadout, one of the F-21's air-war loadouts by id (`?loadout=strike`), or
   * null for the flight data's standard load of four missiles (decision 300).
   */
  loadout: string | null;
}

/** The jet's mouse modes: `aim`, the flight director flies to the ring; `direct`, the cursor is the stick. */
export type JetControl = 'aim' | 'direct';

export type InvertKey = 'invertAim' | 'invertStick' | 'invertHelo';

/** Which inversion setting applies to `aircraft` flown with `control`. */
export function invertKey(aircraft: AircraftChoice, control: JetControl): InvertKey {
  if (!isJet(aircraft)) return 'invertHelo';
  return control === 'aim' ? 'invertAim' : 'invertStick';
}

/** What the mouse's forward motion does under setting `key` when `inverted`. */
export function invertNote(key: InvertKey, inverted: boolean): string {
  switch (key) {
    case 'invertAim':
      return inverted
        ? 'Mouse forward: the aim ring goes down (dive)'
        : 'Mouse forward: the aim ring goes up (climb)';
    case 'invertStick':
      return inverted
        ? 'Mouse forward: stick back, nose up'
        : 'Mouse forward: stick forward, nose down, as a real stick';
    default:
      return inverted ? 'Mouse forward: nose up' : 'Mouse forward: nose down, as a cyclic';
  }
}

/** The jet's mouse modes for the menus. */
export const JET_CONTROLS: { id: JetControl; label: string }[] = [
  { id: 'aim', label: 'Mouse aim (fly toward the ring)' },
  { id: 'direct', label: 'Direct (the mouse is the stick)' },
];

/**
 * The menus' mouse row (decision 198): the jet's mouse mode, and the inversion of
 * the mode chosen (or of the helicopters). `changed` runs after either changes.
 */
export function mouseRow(
  options: FreeFlightOptions,
  changed: () => void,
): {
  el: HTMLSpanElement;
  sync(): void;
} {
  const el = document.createElement('span');
  el.innerHTML = `<label class="ff-control-row">Mouse <select class="ff-control"></select></label>
    <label title="I switches it in flight"><input type="checkbox" class="ff-invert"> Invert up and down</label>
    <span class="ff-invert-note ff-note"></span>`;
  const select = el.querySelector('.ff-control') as HTMLSelectElement;
  for (const c of JET_CONTROLS) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.label;
    select.append(o);
  }
  select.addEventListener('keydown', (e) => e.stopPropagation());
  const row = el.querySelector('.ff-control-row') as HTMLLabelElement;
  const box = el.querySelector('.ff-invert') as HTMLInputElement;
  const note = el.querySelector('.ff-invert-note') as HTMLSpanElement;
  const sync = () => {
    row.hidden = !isJet(options.aircraft);
    select.value = options.control;
    const k = invertKey(options.aircraft, options.control);
    box.checked = options[k];
    note.textContent = invertNote(k, options[k]);
  };
  select.addEventListener('change', () => {
    options.control = select.value as JetControl;
    sync();
    changed();
  });
  box.addEventListener('change', () => {
    options[invertKey(options.aircraft, options.control)] = box.checked;
    sync();
    changed();
  });
  sync();
  return { el, sync };
}

export const DEFAULT_OPTIONS: FreeFlightOptions = {
  timeOfDay: 17,
  unlimitedFuel: true,
  spawn: 'runway',
  aircraft: 'kestrel',
  weather: 'fair',
  wind: true,
  control: 'aim',
  invertAim: false,
  invertStick: false,
  invertHelo: false,
  microFacets: false,
  uiScale: 1,
  showFps: true,
  traffic: false,
  loadout: null,
};

/** The weather option of a card: the list of presets by name, and what the chosen one is like. */
export interface WeatherChoice {
  readonly select: HTMLSelectElement;
  /** A line of secondary text for the chosen preset; the card places it. */
  readonly note: HTMLSpanElement;
  /** Shows another preset as chosen (without calling `onChange`). */
  show(preset: WeatherPreset): void;
}

/** A `<select>` of the weather presets by name with a note; `onChange` gets the choice. */
export function weatherSelect(
  value: WeatherPreset,
  onChange: (preset: WeatherPreset) => void,
): WeatherChoice {
  const select = document.createElement('select');
  select.className = 'ff-weather';
  for (const preset of WEATHER_PRESETS) {
    const option = document.createElement('option');
    option.value = preset;
    option.textContent = presetName(preset);
    option.title = presetDescription(preset);
    select.append(option);
  }
  const note = document.createElement('span');
  note.className = 'ff-note ff-weather-note';
  const show = (preset: WeatherPreset) => {
    select.value = preset;
    note.textContent = presetDescription(preset);
  };
  show(value);
  select.addEventListener(
    'change',
    () => (note.textContent = presetDescription(select.value as WeatherPreset)),
  );
  select.addEventListener('change', () => onChange(select.value as WeatherPreset));
  // Keys in the list choose a preset; they do not move the map. Escape still closes the card.
  select.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation();
  });
  return { select, note, show };
}

export interface BaseEntry {
  id: number;
  name: string;
  side: 'alliance' | 'pact';
  kind: string;
  region: string;
  /** Runway length (m) and designators ("08/26"). */
  runwayLength: number;
  designators: string;
}

export interface FreeFlightMenuEvents {
  /** A new seed was entered. */
  seed(seed: string): void;
  /** A base was picked in the list (the app focuses the map on it). */
  select(id: number): void;
  fly(id: number, options: FreeFlightOptions): void;
  /** Another weather was chosen (the app prepares it ahead of the flight). */
  weather?(preset: WeatherPreset): void;
  /** Leave Free Flight for the normal app. */
  exit(): void;
}

const SIDE_LABEL = { alliance: 'Alliance', pact: 'Pact' } as const;

function hourText(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export class FreeFlightMenu {
  readonly el: HTMLDivElement;
  readonly options: FreeFlightOptions;
  private selected: number | null = null;
  private bases: BaseEntry[] = [];
  private ready = false;
  private readonly seedInput: HTMLInputElement;
  private readonly status: HTMLDivElement;
  private readonly tbody: HTMLTableSectionElement;
  private readonly flyButton: HTMLButtonElement;
  private readonly chosen: HTMLDivElement;
  private readonly todLabel: HTMLSpanElement;
  private readonly weatherList: WeatherChoice;
  /** Shows `options` in the controls. */
  private readonly sync: () => void;

  constructor(
    private readonly events: FreeFlightMenuEvents,
    options: Partial<FreeFlightOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const el = (this.el = document.createElement('div'));
    el.className = 'ff-panel ff-menu';
    el.innerHTML = `
      <h1>Free Flight</h1>
      <div class="ff-note">Pick an aircraft and an airbase, take off, land anywhere. No war, no traffic, no weapons.</div>
      <div class="ff-row">
        <label>Seed <input type="text" class="ff-seed" size="14" spellcheck="false"></label>
        <button class="ff-load">Load</button>
        <button class="ff-exit" title="Back to the full app">Exit</button>
      </div>
      <div class="ff-status ff-note"></div>
      <h2>Airbases <span class="ff-note">(or click one on the map)</span></h2>
      <div class="ff-bases"><table>
        <thead><tr><th>Airbase</th><th>Side</th><th>Region</th><th>Runway</th><th>Length</th></tr></thead>
        <tbody></tbody>
      </table></div>
      <h2>Options</h2>
      <div class="ff-row">
        <label>Aircraft <select class="ff-aircraft"></select></label> <span class="ff-aircraft-note ff-note"></span>
      </div>
      <div class="ff-row ff-mouse-row"></div>
      <div class="ff-row">
        <label>Time of day <input type="range" class="ff-tod" min="0" max="24" step="0.25"> <span class="ff-tod-label"></span></label>
      </div>
      <div class="ff-row">
        <label class="ff-weather-row">Weather </label>
        <label title="The aircraft feels the weather's wind and gusts"><input type="checkbox" class="ff-wind"> Wind and turbulence</label>
      </div>
      <div class="ff-row ff-weather-about"></div>
      <div class="ff-row">
        <label><input type="checkbox" class="ff-fuel"> Unlimited fuel</label>
        <label title="Aircraft circling near the base and two ground radars, for the radar and the threat display"><input type="checkbox" class="ff-traffic"> Traffic and radars</label>
      </div>
      <div class="ff-row">
        <label title="Fine faceted relief on the ground near a low camera; costly on some graphics cards"><input type="checkbox" class="ff-micro"> Ground micro-facets (graphics)</label>
      </div>
      <div class="ff-row">
        Start:
        <label><input type="radio" name="ff-spawn" value="runway"> <span class="ff-spawn-ground">On the runway</span></label>
        <label><input type="radio" name="ff-spawn" value="air"> <span class="ff-spawn-air">In the air (3,000 m, 300 kt)</span></label>
      </div>
      <div class="ff-row">
        <button class="ff-primary ff-fly" disabled>Fly</button>
        <div class="ff-chosen ff-note"></div>
      </div>
      <div class="ff-row ff-pad-row"><button class="ff-controls">Controls and gamepad…</button></div>`;
    const q = <T extends Element>(s: string) => el.querySelector(s) as T;
    this.seedInput = q<HTMLInputElement>('.ff-seed');
    this.status = q<HTMLDivElement>('.ff-status');
    this.tbody = q<HTMLTableSectionElement>('tbody');
    this.flyButton = q<HTMLButtonElement>('.ff-fly');
    this.chosen = q<HTMLDivElement>('.ff-chosen');
    this.todLabel = q<HTMLSpanElement>('.ff-tod-label');
    const tod = q<HTMLInputElement>('.ff-tod');
    tod.addEventListener('input', () => {
      this.options.timeOfDay = Number(tod.value);
      this.todLabel.textContent = hourText(this.options.timeOfDay);
    });
    this.weatherList = weatherSelect(this.options.weather, (preset) => {
      this.options.weather = preset;
      this.events.weather?.(preset);
    });
    q<HTMLLabelElement>('.ff-weather-row').append(this.weatherList.select);
    q<HTMLDivElement>('.ff-weather-about').append(this.weatherList.note);
    const wind = q<HTMLInputElement>('.ff-wind');
    wind.addEventListener('change', () => (this.options.wind = wind.checked));
    const fuel = q<HTMLInputElement>('.ff-fuel');
    fuel.addEventListener('change', () => (this.options.unlimitedFuel = fuel.checked));
    const traffic = q<HTMLInputElement>('.ff-traffic');
    traffic.addEventListener('change', () => (this.options.traffic = traffic.checked));
    const micro = q<HTMLInputElement>('.ff-micro');
    micro.addEventListener('change', () => (this.options.microFacets = micro.checked));
    const aircraft = q<HTMLSelectElement>('.ff-aircraft');
    const aircraftNote = q<HTMLSpanElement>('.ff-aircraft-note');
    for (const a of AIRCRAFT_CHOICES) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.label;
      aircraft.append(o);
    }
    const mouse = mouseRow(this.options, () => {});
    q<HTMLDivElement>('.ff-mouse-row').append(mouse.el);
    const showInvert = () => mouse.sync();
    const spawnGround = q<HTMLSpanElement>('.ff-spawn-ground');
    const spawnAir = q<HTMLSpanElement>('.ff-spawn-air');
    const showAircraft = () => {
      const a =
        AIRCRAFT_CHOICES.find((c) => c.id === this.options.aircraft) ?? AIRCRAFT_CHOICES[0]!;
      aircraft.value = a.id;
      aircraftNote.textContent = a.note;
      const helo = !isJet(a.id);
      spawnGround.textContent = helo ? 'On the ground beside the runway' : 'On the runway';
      spawnAir.textContent = helo ? 'In the air (150 m, hovering)' : 'In the air (3,000 m, 300 kt)';
      showInvert();
    };
    aircraft.addEventListener('change', () => {
      this.options.aircraft = aircraft.value as AircraftChoice;
      showAircraft();
    });
    aircraft.addEventListener('keydown', (e) => e.stopPropagation());
    const spawns = [...el.querySelectorAll<HTMLInputElement>('input[name="ff-spawn"]')];
    for (const r of spawns) {
      r.addEventListener('change', () => {
        if (r.checked) this.options.spawn = r.value as SpawnKind;
      });
    }
    this.sync = () => {
      tod.value = String(this.options.timeOfDay);
      this.todLabel.textContent = hourText(this.options.timeOfDay);
      this.weatherList.show(this.options.weather);
      wind.checked = this.options.wind;
      fuel.checked = this.options.unlimitedFuel;
      traffic.checked = this.options.traffic;
      micro.checked = this.options.microFacets;
      for (const r of spawns) r.checked = r.value === this.options.spawn;
      showAircraft();
    };
    this.sync();
    const load = () => {
      const s = this.seedInput.value.trim();
      if (s) this.events.seed(s);
    };
    q<HTMLButtonElement>('.ff-load').addEventListener('click', load);
    this.seedInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') load();
    });
    q<HTMLButtonElement>('.ff-exit').addEventListener('click', () => this.events.exit());
    this.flyButton.addEventListener('click', () => {
      if (this.selected !== null && this.ready) this.events.fly(this.selected, { ...this.options });
    });
    // A gamepad (Proposal 0014): its status, the bindings screen, the menu by D-pad.
    q<HTMLDivElement>('.ff-pad-row').append(padStatusLine());
    q<HTMLButtonElement>('.ff-controls').addEventListener('click', () => openBindings());
    registerNavRoot(el, { priority: 10 });
    document.body.appendChild(el);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
  }

  get selection(): number | null {
    return this.selected;
  }

  /** Shows another weather as chosen (it was changed elsewhere). */
  setWeather(preset: WeatherPreset): void {
    this.options.weather = preset;
    this.weatherList.show(preset);
  }

  /**
   * Takes the options as they were changed elsewhere (the pause menu), so the start screen
   * shows what the last flight flew with and "Fly" does not bring older choices back.
   */
  setOptions(options: Readonly<FreeFlightOptions>): void {
    Object.assign(this.options, options);
    this.sync();
  }

  setSeed(seed: string): void {
    this.seedInput.value = seed;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Whether the terrain is ready to fly over. */
  setReady(ready: boolean): void {
    this.ready = ready;
    this.refreshFly();
  }

  setBases(bases: BaseEntry[]): void {
    this.bases = bases;
    this.tbody.replaceChildren(
      ...bases.map((b) => {
        const tr = document.createElement('tr');
        tr.dataset.id = String(b.id);
        // Reachable by the gamepad's D-pad and the Tab key (Proposal 0014).
        tr.tabIndex = 0;
        const ft = Math.round(b.runwayLength / FOOT / 100) * 100;
        tr.innerHTML = `<td></td><td class="${b.side}">${SIDE_LABEL[b.side]}</td><td></td><td>${b.designators}</td><td>${b.runwayLength.toLocaleString('en-US')} m</td>`;
        tr.title = `${b.name} (id ${b.id}): ${b.kind} base, runway ${b.designators}, ${b.runwayLength.toLocaleString('en-US')} m (${ft.toLocaleString('en-US')} ft)`;
        tr.cells[0]!.textContent = b.name;
        tr.cells[2]!.textContent = b.region;
        tr.addEventListener('click', () => {
          this.select(b.id);
          this.events.select(b.id);
        });
        tr.addEventListener('dblclick', () => {
          if (this.ready) this.events.fly(b.id, { ...this.options });
        });
        return tr;
      }),
    );
    if (this.selected !== null && !bases.some((b) => b.id === this.selected)) this.selected = null;
    this.select(this.selected);
  }

  /** Marks base `id` as chosen (null clears). */
  select(id: number | null): void {
    this.selected = id;
    for (const tr of this.tbody.rows) tr.classList.toggle('selected', tr.dataset.id === String(id));
    const row = [...this.tbody.rows].find((r) => r.dataset.id === String(id));
    row?.scrollIntoView({ block: 'nearest' });
    const b = this.bases.find((x) => x.id === id);
    this.chosen.textContent = b ? `${b.name}, runway ${b.designators}` : 'No airbase chosen';
    this.refreshFly();
  }

  private refreshFly(): void {
    this.flyButton.disabled = this.selected === null || !this.ready;
    this.flyButton.title = this.ready ? '' : 'Waiting for the terrain';
  }
}
