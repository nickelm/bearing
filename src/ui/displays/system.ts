/**
 * The display system's controller for a flown aircraft (decision 199): reads
 * and changes the avionics state of the aircraft it is attached to (the state
 * lives with the flown aircraft in sim/flight, R1.5; its own until one attaches),
 * holds the display state, runs the master modes' triggers, and turns commands from clicks, hot
 * keys and (later) the crew into new states. Formats and the strip are pure
 * functions of the snapshot it is given; the view only draws.
 *
 * Hot keys (decision 193: keys for what a pilot needs without looking; the
 * bezel buttons work by mouse): 1–4 expand or collapse the left MFD, the right
 * MFD, the messages and the threat display; M steps the master mode by hand and
 * back to automatic; F is the dogfight override; K acknowledges the master
 * caution. The flight inputs' tables do not use these keys (a test checks).
 */
import { applyCommand, autoMode, initialAvionics } from '../../sim/avionics/avionics';
import type { PhaseInterface } from '../../sim/command/missions/plugin';
import type { AvionicsState, MasterMode, ModeInputs } from '../../sim/avionics/avionics';
import type { FormatId, SlotId } from '../../sim/avionics/profiles';
import { DisplaysView } from './draw/displaysView';
import { displayModel, lockCandidate, steerpointStep } from './formats';
import type { ControlsAction, DisplayCommand, DisplayModel, DisplayState } from './model';
import {
  applyPreset,
  applyUi,
  editsForNewPhase,
  initialDisplayState,
  preselectWeapon,
  recordEdit,
} from './presets';
import type { PresetEdits } from './presets';
import type { AircraftSnapshot } from './snapshot';
import { cautionIds, stripModel } from './strip';
import { DISPLAY_BINDINGS } from './bindings';
import type { DisplayHotAction } from './bindings';

const SLOT_KEYS: Partial<Record<DisplayHotAction, SlotId>> = {
  slotLeft: 'leftMfd',
  slotRight: 'rightMfd',
  slotMessages: 'messages',
  slotThreat: 'threat',
};

/** The master modes M steps through by hand, per aircraft kind; after the last, automatic. */
const MANUAL_MODES: Record<'jet' | 'helicopter', MasterMode[]> = {
  jet: ['navigation', 'approach', 'air-to-air', 'air-to-ground'],
  helicopter: ['navigation', 'hover', 'air-to-ground'],
};

export class DisplaySystem {
  /** Where the avionics state lives: the attached aircraft (R1.5), or the system itself. */
  private holder: { avionics: AvionicsState };
  display: DisplayState | null = null;
  /** Commands for the flight controls (gear, brakes, hover hold, the mouse). */
  onControls: ((a: ControlsAction) => void) | null = null;
  /** The mission phase's interface defaults (decision 304), or null. */
  private phase: PhaseInterface | null = null;
  /** A new phase whose formats have not come up yet: they wait for its master mode (decision 310). */
  private phaseFresh = false;
  /** Keys act only while flying. */
  enabled = false;
  /**
   * A spectator's displays (a followed aircraft the player does not fly): formats and slots
   * still change, but avionics and controls commands are ignored (decision 294).
   */
  readOnly = false;
  /** The displays' scale (0.75–1.5), from the options (decision 200). */
  uiScale = 1;
  /** The player's edits to the master modes' presets, kept per viewer (decision 200). */
  edits: PresetEdits = loadEdits();
  readonly view: DisplaysView;
  private last: AircraftSnapshot | null = null;
  private readonly keyAction = new Map<string, DisplayHotAction>();
  private readonly detach: () => void;

  constructor(parent?: HTMLElement) {
    this.holder = { avionics: initialAvionics(true) };
    this.view = new DisplaysView(parent);
    this.view.onCommand = (c) => this.command(c);
    for (const [a, codes] of Object.entries(DISPLAY_BINDINGS) as [DisplayHotAction, string[]][])
      for (const c of codes) this.keyAction.set(c, a);
    const kd = (e: KeyboardEvent) => {
      const a = this.keyAction.get(e.code);
      if (!a || !this.enabled || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      this.hot(a);
    };
    window.addEventListener('keydown', kd);
    this.detach = () => window.removeEventListener('keydown', kd);
  }

  /** The attached aircraft's avionics state; avionics commands change it. */
  get avionics(): AvionicsState {
    return this.holder.avionics;
  }

  set avionics(a: AvionicsState) {
    this.holder.avionics = a;
  }

  /** Reads and writes the avionics state of `aircraft` from now on (a flown aircraft, R1.5). */
  attach(aircraft: { avionics: AvionicsState }): void {
    this.holder = aircraft;
  }

  /** Starts a sortie: fresh avionics and display state. */
  reset(onGround: boolean): void {
    this.avionics = initialAvionics(onGround);
    this.display = null;
    this.last = null;
  }

  /** Advances the master mode's triggers; returns whether the mode changed. */
  triggers(i: ModeInputs): boolean {
    const before = this.avionics.masterMode;
    this.avionics = autoMode(this.avionics, { ...i, cruise: i.cruise ?? this.phase?.masterMode });
    return before !== this.avionics.masterMode;
  }

  /**
   * The mission phase's interface defaults (decision 304), or null outside a mission: its
   * master mode is the triggers' cruise mode, its formats come before the mode's preset,
   * and its cues pre-select a weapon. A new phase applies its formats at once.
   */
  setPhase(p: PhaseInterface | null): void {
    if (p === this.phase) return;
    this.phase = p;
    this.phaseFresh = p !== null;
    if (this.display && this.last)
      this.display = applyPreset(
        this.display,
        { ...this.last, avionics: this.avionics },
        this.edits,
        this.prefer(),
      );
    this.applyNewPhase();
  }

  /**
   * A new phase's formats, once its master mode is up (the triggers switch it a moment
   * after the phase begins): they win over the player's earlier edits of that mode once,
   * so the stores format comes up at the fence-in even if the map was once chosen there.
   */
  private applyNewPhase(): void {
    const p = this.phase;
    if (!this.phaseFresh || !p || !this.display || !this.last) return;
    if (p.masterMode !== this.avionics.masterMode) return;
    const s = { ...this.last, avionics: this.avionics };
    const edits = editsForNewPhase(this.edits, p.masterMode, p.formats);
    this.display = applyPreset(this.display, s, edits, p.formats);
    this.phaseFresh = false;
  }

  /** The phase's formats, while the master mode is the one it asks for. */
  private prefer(): Partial<Record<SlotId, FormatId[]>> {
    const p = this.phase;
    return p && p.masterMode === this.avionics.masterMode ? p.formats : {};
  }

  /** Builds the models from `snap` (whose `avionics` is replaced by this system's) and draws them. */
  update(snap: AircraftSnapshot, width?: number, height?: number): void {
    this.avionics = preselectWeapon(this.avionics, snap.stores ?? null, this.phase?.hud ?? []);
    const s = { ...snap, avionics: this.avionics };
    if (!this.display)
      this.display = applyPreset(initialDisplayState(s, this.edits), s, this.edits, this.prefer());
    if (this.display.uiScale !== this.uiScale)
      this.display = { ...this.display, uiScale: this.uiScale };
    else if (this.last && this.last.avionics.masterMode !== s.avionics.masterMode)
      this.display = applyPreset(this.display, s, this.edits, this.prefer());
    this.last = s;
    this.applyNewPhase();
    const models: Partial<Record<SlotId, DisplayModel | null>> = {};
    for (const id of ['leftMfd', 'rightMfd', 'messages', 'threat'] as const)
      models[id] = displayModel(s, this.display, id);
    this.view.draw(models, this.display, stripModel(s), s.profile.skin, width, height);
  }

  /** Applies a command from a click, a key or (later) the crew. */
  /**
   * Applies a command; false when it is refused: a spectator's displays take no avionics
   * or controls commands (decision 294), and the view flashes the control (decision 311).
   */
  command(c: DisplayCommand): boolean {
    if (this.readOnly && (c.to === 'controls' || c.to === 'avionics')) return false;
    if (c.to === 'controls') {
      this.onControls?.(c.action);
      return true;
    }
    if (c.to === 'avionics') {
      const before = this.avionics.masterMode;
      const shown = this.display?.slots;
      this.avionics = applyCommand(this.avionics, c.command);
      if (this.last && this.display && before !== this.avionics.masterMode) {
        this.last = { ...this.last, avionics: this.avionics };
        let d = applyPreset(this.display, this.last, this.edits, this.prefer());
        // A weapon chosen on the stores format brings its master mode, but the format it
        // was chosen on stays where it is (owner, decision 298).
        if (c.command.type === 'select-weapon' && shown) {
          const slots = { ...d.slots };
          for (const id of ['leftMfd', 'rightMfd'] as const)
            if (shown[id].format === 'stores' && shown[id].state === 'expanded')
              slots[id] = { ...shown[id] };
          d = { ...d, slots };
        }
        this.display = d;
      }
      this.redraw();
      return true;
    }
    if (this.display && this.last) {
      this.display = applyUi(this.display, this.last, c.command);
      // A format chosen or a slot opened or closed edits the mode's preset (decision 200).
      if (c.command.type === 'select-format' || c.command.type === 'toggle-slot') {
        this.edits = recordEdit(
          this.edits,
          this.avionics.masterMode,
          c.command.slot,
          this.display.slots[c.command.slot],
        );
        saveEdits(this.edits);
      }
    }
    this.redraw();
    return true;
  }

  private redraw(): void {
    if (this.last) this.update(this.last);
  }

  /** A hot key's action. */
  hot(a: DisplayHotAction): void {
    const slot = SLOT_KEYS[a];
    if (slot) {
      this.command({ to: 'ui', command: { type: 'toggle-slot', slot } });
      return;
    }
    if (a === 'dogfight') {
      this.command({ to: 'avionics', command: { type: 'dogfight' } });
      return;
    }
    if (a === 'radarLock' || a === 'radarBreak') {
      if (!this.last) return;
      const id =
        a === 'radarLock' ? lockCandidate({ ...this.last, avionics: this.avionics }) : null;
      if (a === 'radarLock' && !id) return;
      this.command({ to: 'avionics', command: { type: 'radar-lock', id } });
      return;
    }
    if (a === 'steerpointNext' || a === 'steerpointPrevious') {
      const r = this.last?.route;
      if (!r || r.waypoints.length === 0) return;
      const index = steerpointStep(r, a === 'steerpointNext' ? 1 : -1);
      this.command({ to: 'avionics', command: { type: 'steerpoint', index } });
      return;
    }
    if (a === 'masterCaution') {
      if (!this.last) return;
      const ids = cautionIds(stripModel({ ...this.last, avionics: this.avionics }));
      this.command({ to: 'avionics', command: { type: 'acknowledge', ids } });
      return;
    }
    // M: the next mode by hand, and after the last back to the triggers.
    const list = MANUAL_MODES[this.last?.kind ?? 'jet'];
    if (!this.avionics.manual) {
      this.command({ to: 'avionics', command: { type: 'master-mode', mode: list[0]! } });
      return;
    }
    const i = list.indexOf(this.avionics.masterMode);
    if (i < 0 || i === list.length - 1)
      this.command({ to: 'avionics', command: { type: 'auto-mode' } });
    else this.command({ to: 'avionics', command: { type: 'master-mode', mode: list[i + 1]! } });
  }

  set visible(v: boolean) {
    this.view.visible = v;
  }

  dispose(): void {
    this.detach();
    this.view.dispose();
  }
}

const EDITS_KEY = 'bearing.displays.presets';

/** The saved preset edits; none where storage is blocked or empty (a private window). */
function loadEdits(): PresetEdits {
  try {
    const raw = globalThis.localStorage?.getItem(EDITS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as PresetEdits) : {};
  } catch {
    return {};
  }
}

function saveEdits(e: PresetEdits): void {
  try {
    globalThis.localStorage?.setItem(EDITS_KEY, JSON.stringify(e));
  } catch {
    /* storage blocked: the edits last for this visit */
  }
}

/** Forgets the saved preset edits (the pause menu's reset). */
export function clearPresetEdits(system: DisplaySystem): void {
  system.edits = {};
  saveEdits({});
}
