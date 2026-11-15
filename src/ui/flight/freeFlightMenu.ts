/**
 * The Free Flight start screen (decision 134): the seed, the world's airbases
 * (name, faction, region, runway), the options and the Fly button, in a
 * column over the strategic map. Clicking a base on the map selects it too
 * (the app calls `select`). The menu only reports choices; the app acts.
 */
import './flight.css';
import { FOOT } from '../../core/units';
import { presetDescription, presetName, WEATHER_PRESETS } from '../../sim/weather/presets';
import type { WeatherPreset } from '../../sim/weather/presets';

export type SpawnKind = 'runway' | 'air';

/** The aircraft to fly: the F-21 Kestrel, or one of the H1 helicopters (Proposal 0004). */
export type AircraftChoice = 'kestrel' | 'scout' | 'utility';

export const AIRCRAFT_CHOICES: { id: AircraftChoice; label: string; note: string }[] = [
  { id: 'kestrel', label: 'F-21 Kestrel', note: 'Fighter (F-16 analogue)' },
  { id: 'scout', label: 'MH-14 Wren', note: 'Light scout helicopter (Little Bird analogue)' },
  { id: 'utility', label: 'UH-68 Buzzard', note: 'Utility helicopter (Black Hawk analogue)' },
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
}

export const DEFAULT_OPTIONS: FreeFlightOptions = {
  timeOfDay: 17,
  unlimitedFuel: true,
  spawn: 'runway',
  aircraft: 'kestrel',
  weather: 'fair',
  wind: true,
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
      </div>
      <div class="ff-row">
        Start:
        <label><input type="radio" name="ff-spawn" value="runway"> <span class="ff-spawn-ground">On the runway</span></label>
        <label><input type="radio" name="ff-spawn" value="air"> <span class="ff-spawn-air">In the air (3,000 m, 300 kt)</span></label>
      </div>
      <div class="ff-row">
        <button class="ff-primary ff-fly" disabled>Fly</button>
        <div class="ff-chosen ff-note"></div>
      </div>`;
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
    const aircraft = q<HTMLSelectElement>('.ff-aircraft');
    const aircraftNote = q<HTMLSpanElement>('.ff-aircraft-note');
    for (const a of AIRCRAFT_CHOICES) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.label;
      aircraft.append(o);
    }
    const spawnGround = q<HTMLSpanElement>('.ff-spawn-ground');
    const spawnAir = q<HTMLSpanElement>('.ff-spawn-air');
    const showAircraft = () => {
      const a =
        AIRCRAFT_CHOICES.find((c) => c.id === this.options.aircraft) ?? AIRCRAFT_CHOICES[0]!;
      aircraft.value = a.id;
      aircraftNote.textContent = a.note;
      const helo = a.id !== 'kestrel';
      spawnGround.textContent = helo ? 'On the ground beside the runway' : 'On the runway';
      spawnAir.textContent = helo ? 'In the air (150 m, hovering)' : 'In the air (3,000 m, 300 kt)';
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
